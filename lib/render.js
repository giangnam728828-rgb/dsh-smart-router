/**
 * lib/render.js — 组装要注入给模型的那一块文本。
 *
 * 这里有一条贯穿全局的原则：**只给候选和规矩，绝不给技能正文**。
 *
 * 上游（lau4tin1/dsh-skill-router）用余弦相似度过线之后，直接把技能正文
 * 塞进对话，等于替模型做了「必须用这个」的决定；它自己的实验数据也显示
 * 这样 inject 之后模型并不会真的照着做（C 组 1/4 注入、0/4 正确）。
 *
 * 我们反过来：正文永远由模型自己调 `skill` 去拿。注入的只有
 * 「可能相关的是哪几个 + 为什么相关 + 该不该用你自己判断」。
 *
 * 两块内容各自独立去重：
 *   - 静态块：插件能力目录 + 路由规矩（一个会话里基本不变，只在变化时重发）
 *   - 回合块：本轮技能候选（每轮可能不同，但同一组候选不重复发）
 */
import { truncate } from './route.js'

/** 注入块的外框名。用自有标签，避免和框架的 <system-reminder> 混在一起。 */
export const OPEN = '<skill_router>'
export const CLOSE = '</skill_router>'

const RULES = [
  '这一块是自动生成的候选清单，不是命令，也不代表任何一条必须被使用。',
  '判断权在你：只有这次任务确实落在某条描述里，才用 skill 工具加载它的正文；不匹配就不要加载。',
  '不要为了「保险」把候选全部加载；也不要为了用而用 —— 没有合适的就直接按自己的方式做。',
  '同一个技能在整个会话里加载一次就够了。',
]

/**
 * 任务的首行摘要。模型只需要认出「这是在说什么」，不需要全文。
 * @param {string} task
 * @param {number} [max]
 */
export function taskLine(task, max = 160) {
  const first = String(task ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
  return truncate(first, max)
}

/**
 * 一条技能候选。带上「命中了哪些词」，模型才能判断这个匹配是不是巧合。
 *
 * @param {{ name: string, description?: string, whenToUse?: string, score: number }} candidate
 * @param {readonly string[]} reasons
 */
export function candidateLine(candidate, reasons) {
  const description = truncate(candidate.description ?? candidate.whenToUse ?? '', 110)
  const why = reasons.length > 0 ? `（字面重合：${reasons.slice(0, 6).join('、')}）` : ''
  return description.length > 0 ? `- ${candidate.name} — ${description}${why}` : `- ${candidate.name}${why}`
}

/**
 * 静态块：插件能力目录 + 规矩。
 *
 * @param {{ plugins?: ReadonlyArray<{ name: string, title?: string, description?: string }>,
 *           families?: ReadonlyArray<{ name: string, count: number, sample: string }>,
 *           includePlugins?: boolean, includeToolFamilies?: boolean }} input
 * @returns {string} 没有可写的内容时返回空串
 */
export function renderStaticBlock(input) {
  const lines = []
  const plugins = input.plugins ?? []
  const families = input.families ?? []

  if (input.includePlugins !== false && plugins.length > 0) {
    lines.push('已装插件（能力的来源；这些不是技能，不要用 skill 工具去加载）：')
    for (const plugin of plugins) {
      const label = plugin.title !== undefined ? `${plugin.title}（${plugin.name}）` : plugin.name
      const purpose = truncate(plugin.description ?? '', 90)
      lines.push(purpose.length > 0 ? `- ${label} — ${purpose}` : `- ${label}`)
    }
  }

  if (input.includeToolFamilies !== false && families.length > 0) {
    lines.push('')
    lines.push('工具族（工具名是按族命名的基础设施，用到时直接调，不需要先加载技能）：')
    for (const family of families) {
      const sample = family.sample.length > 0 ? ` — 例如 ${family.sample}` : ''
      lines.push(`- ${family.name}（${family.count} 个）${sample}`)
    }
  }

  if (lines.length === 0) return ''
  return [OPEN, '<routing_rules>', ...RULES.map((rule, index) => `${index + 1}. ${rule}`), '</routing_rules>', '', ...lines, CLOSE].join('\n')
}

/**
 * 回合块：本轮技能候选。
 *
 * @param {{ task: string,
 *           candidates: ReadonlyArray<{ name: string, description?: string, whenToUse?: string, score: number }>,
 *           reasons?: Readonly<Record<string, readonly string[]>>,
 *           total: number }} input
 * @returns {string} 没有候选时返回空串
 */
export function renderTurnBlock(input) {
  const candidates = input.candidates ?? []
  if (candidates.length === 0) return ''

  const lines = [OPEN, `<turn_candidates total_indexed="${input.total}">`]
  const task = taskLine(input.task)
  if (task.length > 0) lines.push(`本轮任务：${task}`)
  lines.push('')
  lines.push('字面重合度最高的技能（只是候选；不匹配就忽略）：')
  for (const candidate of candidates) {
    lines.push(candidateLine(candidate, input.reasons?.[candidate.name] ?? []))
  }
  lines.push('')
  lines.push('要用的，调用 skill 工具并传上面那个精确名字；不用的不必解释。')
  lines.push('</turn_candidates>')
  lines.push(CLOSE)
  return lines.join('\n')
}

/**
 * 从任务里挑出和某个候选重合的词，用来解释「为什么它出现在这里」。
 * 只用二元组/单词做证据，不推测语义。
 *
 * @param {Map<string, number>} queryTokens
 * @param {{ name: string, description?: string, whenToUse?: string }} candidate
 * @param {(text: string) => Map<string, number>} tokenize
 * @param {number} [limit]
 */
export function matchReasons(queryTokens, candidate, tokenize, limit = 6) {
  const reasons = []
  const seen = new Set()
  for (const field of ['name', 'whenToUse', 'description']) {
    const value = candidate[field]
    if (typeof value !== 'string') continue
    for (const token of tokenize(value).keys()) {
      if (token.length < 2 || !queryTokens.has(token) || seen.has(token)) continue
      seen.add(token)
      reasons.push(token)
      if (reasons.length >= limit) return reasons
    }
  }
  return reasons
}
