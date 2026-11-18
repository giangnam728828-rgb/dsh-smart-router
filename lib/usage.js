/**
 * lib/usage.js — 这个会话到底用了什么。
 *
 * 面板上「这一轮用了哪些技能和工具」不能靠猜：技能是模型调 `skill` 时用的，
 * 工具是 `tools/execute` 实际派发的。这里只记录**真正发生过**的调用，
 * 不记录「被推荐过」的 —— 推荐和采用是两件事，混在一起这个面板就没用了。
 *
 * 内存里按会话存，条目有上限：一个跑很久的会话不该把内存吃满。
 */

/** 每个会话最多记多少个不同的工具名。 */
const MAX_TOOLS = 60

/**
 * 最多记多少个会话。
 *
 * 宿主是一个长命进程，会话却可以一直开 —— 不设上限就是只涨不落。
 * 满了淘汰最久没被写过的那一个。
 */
export const MAX_SESSIONS = 256

/** sessionId -> { skills: Set<string>, tools: Map<string, number> } */
const sessions = new Map()

function bucket(sessionId) {
  let entry = sessions.get(sessionId)
  if (entry === undefined) {
    entry = { skills: new Set(), tools: new Map() }
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
 * 记一次工具调用。`skill` 工具单独归到技能里，因为它加载的是技能而不是能力。
 *
 * @param {string} sessionId
 * @param {string} toolName
 * @param {unknown} args - 工具入参；`skill` 取它的 name 字段
 */
export function noteToolCall(sessionId, toolName, args) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (typeof toolName !== 'string' || toolName === '') return
  const entry = bucket(sessionId)

  if (toolName === 'skill') {
    const name = args !== null && typeof args === 'object' ? args.name : undefined
    if (typeof name === 'string' && name.length > 0) entry.skills.add(name)
    return
  }

  if (entry.tools.size >= MAX_TOOLS && !entry.tools.has(toolName)) return
  entry.tools.set(toolName, (entry.tools.get(toolName) ?? 0) + 1)
}

/**
 * 读一个会话的用量。返回数组，方便直接塞进 HTTP 响应。
 *
 * @param {string} sessionId
 * @returns {{ skills: string[], tools: Array<{ name: string, count: number }> }}
 */
export function usageOf(sessionId) {
  const entry = sessions.get(sessionId)
  if (entry === undefined) return { skills: [], tools: [] }
  return {
    skills: [...entry.skills].sort(),
    tools: [...entry.tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  }
}

/** 清空（测试与停用时用）。 */
export function clearUsage() {
  sessions.clear()
}
