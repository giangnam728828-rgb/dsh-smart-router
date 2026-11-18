/**
 * lib/usage.js — 这个会话到底用了什么，以及**用到了哪一步**。
 *
 * 面板上要回答的问题不是「有没有出现过这个技能」，而是：
 *   1. 我勾了它 —— 它还在排队吗？（via: 'queued'，在 panel.js 的钉住表里）
 *   2. 插件真的把它加载进这一轮了吗？（via: 'injected'）
 *   3. 模型自己调 skill 工具加载了它吗？（via: 'tool'）
 *   4. 勾了但它根本不存在 / 取不出来？（via: 'missing'）
 *
 * 只记**真实发生过**的事：不记录「被推荐过」。所以这里没有「候选」这一档。
 * 每一种都带时间戳 —— 面板上要能说清「多久以前」，而不是一个静态徽章。
 */

/** 每个会话最多记多少个不同的工具名。 */
const MAX_TOOLS = 60

/** 每个会话最多记多少个技能事件名。 */
const MAX_SKILLS = 80

/**
 * 最多记多少个会话。
 *
 * 宿主是一个长命进程，会话却可以一直开 —— 不设上限就是只涨不落。
 * 满了淘汰最久没被写过的那一个。
 */
export const MAX_SESSIONS = 256

/** 技能事件的来源。顺序即优先级：后者覆盖前者。 */
const VIA_RANK = { missing: 1, injected: 2, tool: 3 }

/** sessionId -> { skills: Map<名称, {via, at}>, tools: Map<名称, 次数> } */
const sessions = new Map()

function bucket(sessionId) {
  let entry = sessions.get(sessionId)
  if (entry === undefined) {
    entry = { skills: new Map(), tools: new Map() }
    sessions.set(sessionId, entry)
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
  }
  return entry
}

/**
 * 记一次技能事件。
 *
 * `via` 只在**更强**的证据到来时覆盖：先被插件注入、之后模型又自己加载一遍，
 * 记为 tool；反过来不降级 —— 否则「模型真的用了」会被后到的注入抹掉。
 *
 * @param {string} sessionId
 * @param {string} name
 * @param {'injected' | 'tool' | 'missing'} via
 */
function noteSkill(sessionId, name, via) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (typeof name !== 'string' || name === '') return
  const entry = bucket(sessionId)
  const previous = entry.skills.get(name)
  const rank = VIA_RANK[via] ?? 0
  if (previous !== undefined && (VIA_RANK[previous.via] ?? 0) >= rank) {
    previous.at = Date.now()
    return
  }
  if (previous === undefined && entry.skills.size >= MAX_SKILLS) {
    const oldest = entry.skills.keys().next().value
    if (oldest !== undefined) entry.skills.delete(oldest)
  }
  entry.skills.set(name, { via, at: Date.now() })
}

/** 插件把技能正文注入到了这一轮。 */
export function noteSkillInjection(sessionId, names) {
  for (const name of names ?? []) noteSkill(sessionId, name, 'injected')
}

/** 勾了但取不出来 —— 用户必须看得见，否则他永远不知道那次勾选没生效。 */
export function noteSkillMissing(sessionId, name) {
  noteSkill(sessionId, name, 'missing')
}

/**
 * 记一次工具调用。`skill` 工具单独归到技能里，因为它加载的是技能而不是能力。
 *
 * @param {string} sessionId
 * @param {string} toolName
 * @param {unknown} args - 工具入参；`skill` 取它的 name 字段
 */
export function noteToolCall(sessionId, toolName, args) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (typeof toolName !== 'string' || toolName === '') return

  if (toolName === 'skill') {
    const name = args !== null && typeof args === 'object' ? args.name : undefined
    if (typeof name === 'string' && name.length > 0) noteSkill(sessionId, name, 'tool')
    return
  }

  const entry = bucket(sessionId)
  if (entry.tools.size >= MAX_TOOLS && !entry.tools.has(toolName)) return
  entry.tools.set(toolName, { count: (entry.tools.get(toolName)?.count ?? 0) + 1, at: Date.now() })
}

/**
 * 读一个会话的用量。返回数组，方便直接塞进 HTTP 响应。
 *
 * @param {string} sessionId
 * @returns {{ skills: Array<{ name: string, via: string, at: number }>,
 *             tools: Array<{ name: string, count: number, at: number }> }}
 */
export function usageOf(sessionId) {
  const entry = sessions.get(sessionId)
  if (entry === undefined) return { skills: [], tools: [] }
  return {
    skills: [...entry.skills.entries()]
      .map(([name, value]) => ({ name, via: value.via, at: value.at }))
      .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name)),
    tools: [...entry.tools.entries()]
      .map(([name, value]) => ({ name, count: value.count, at: value.at }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  }
}

/** 清空（测试与停用时用）。 */
export function clearUsage() {
  sessions.clear()
}