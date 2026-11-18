/**
 * lib/route.js — 纯逻辑层：分词、打分、收窄、渲染。没有 DSH 依赖，可单独测试。
 *
 * 这一层刻意**不做判定**。它只回答两个问题：
 *   1. 面对这段任务文本，哪些技能/工具「值得出现在候选里」？
 *   2. 该怎么把这些候选和规矩，用最少的字写给模型看？
 *
 * 上游（lau4tin1/dsh-skill-router）的教训是：把「判定」交给阈值
 * （minScore 0.05 / zThreshold 2.5），于是中文 0.10~0.13 的真实匹配
 * 全部被切掉；而阈值又是在 24 个技能的语料上标定的，换个语料就失效。
 *
 * 这里反过来：打分只用来**收窄**（把 200 个缩到 4 个），
 * 判定永远留给模型自己读完候选之后再决定。
 */

/** 中文按二元组切，英文按词切；两边的权重不同。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LATIN_WORD = /[a-z0-9][a-z0-9+#._-]*/g
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/** 英文虚词：不参与打分，否则 "the/and/use" 会把所有技能都拉到同一分。 */
const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from',
  'get', 'has', 'have', 'how', 'in', 'into', 'is', 'it', 'its', 'make', 'me', 'my',
  'of', 'on', 'or', 'our', 'should', 'so', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'to', 'use', 'using', 'want', 'was', 'we', 'what',
  'when', 'which', 'will', 'with', 'you', 'your', 'i', 'please', 'help',
])

/**
 * 把文本切成可比较的记号集合。
 * 中文用二元组（"项目进度" -> 项目/目进/进度），比单字精确、比整句宽松；
 * 单字额外给低权重，避免「的/了」这种噪声、也兜住「报告」这种两字词被切断的情况。
 *
 * @param {string} text
 * @returns {Map<string, number>} 记号 -> 权重
 */
export function tokenize(text) {
  const tokens = new Map()
  const s = String(text ?? '').toLowerCase()
  if (s.length === 0) return tokens

  for (const word of s.match(LATIN_WORD) ?? []) {
    if (word.length < 2 || STOP.has(word)) continue
    tokens.set(word, Math.max(tokens.get(word) ?? 0, 1))
  }

  for (const run of s.match(CJK_RUN) ?? []) {
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.slice(i, i + 2)
      tokens.set(bigram, Math.max(tokens.get(bigram) ?? 0, 1))
    }
    // 单字只在整段短到切不出二元组时才用得上，权重压到 0.25。
    if (run.length === 1) tokens.set(run, Math.max(tokens.get(run) ?? 0, 0.25))
  }

  return tokens
}

/**
 * 一个候选携带的文本，按字段给不同权重。
 * 名字最可信（"pdf" 对上 "pdf" 就是强信号），whenToUse 次之，description 最泛。
 */
const FIELDS = /** @type {const} */ ([
  ['name', 3],
  ['whenToUse', 2],
  ['description', 1],
])

/**
 * 打分：任务记号与候选字段的加权交集，再按任务长度归一。
 *
 * 归一化用「任务里有多少比例的词被命中」，而不是原始交集大小 ——
 * 否则一长段需求描述只要沾到一个词就赢过一段精准的短指令。
 *
 * @param {Map<string, number>} query - tokenize(task) 的结果
 * @param {{ name: string, description?: string, whenToUse?: string }} candidate
 * @returns {number} 0..1 之间的相对分，只用于排序和收窄
 */
export function scoreCandidate(query, candidate) {
  if (query.size === 0) return 0

  let hit = 0
  let total = 0
  for (const [field, weight] of FIELDS) {
    const value = candidate[field]
    if (typeof value !== 'string' || value.length === 0) continue
    const tokens = tokenize(value)
    for (const [token, tokenWeight] of tokens) {
      total += tokenWeight * weight
      const q = query.get(token)
      if (q !== undefined) hit += Math.min(q, tokenWeight) * weight
    }
  }
  if (total === 0) return 0

  // 分母取「候选自身的信息量」和「任务的信息量」的较小者：
  // 候选很长但任务很短时，用任务长度做分母才不会把分数稀释成噪声。
  const queryMass = [...query.values()].reduce((a, b) => a + b, 0)
  const denom = Math.min(total, queryMass * 3)
  return denom === 0 ? 0 : Math.min(1, hit / denom)
}

/**
 * 从全部候选里挑出最值得给模型看的一批。
 *
 * 关键：**没有绝对阈值的判定**。这里只负责排序 + 截断，
 * 并且始终保留「一个都没有」这个合法结果（全部 0 分就不硬凑）。
 *
 * @template {{ name: string, description?: string, whenToUse?: string }} T
 * @param {readonly T[]} candidates
 * @param {string} task
 * @param {{ limit?: number, minimum?: number }} [options]
 * @returns {{ selected: Array<T & { score: number }>, total: number, empty: boolean }}
 */
export function narrow(candidates, task, options = {}) {
  const limit = Math.max(1, options.limit ?? 4)
  const minimum = options.minimum ?? 0.02
  const query = tokenize(task)

  const scored = candidates
    .map((candidate) => ({ ...candidate, score: scoreCandidate(query, candidate) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  if (scored.length === 0 || scored[0].score < minimum) {
    return { selected: [], total: candidates.length, empty: true }
  }
  return { selected: scored.slice(0, limit), total: candidates.length, empty: false }
}

/** 截断到 n 个字符，按码点切，不制造半个字。 */
export function truncate(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const chars = [...s]
  return chars.length <= n ? s : chars.slice(0, n - 1).join('') + '…'
}

/**
 * 工具族摘要：把上百个工具压成十几行「哪一类能力、几个、干什么」。
 * 工具名按第一段前缀归族（android_click / mcp__dsha-vscreen__tap / schedule_create）。
 *
 * @param {readonly { name: string, description?: string }[]} tools
 * @param {{ maxFamilies?: number }} [options]
 */
export function summarizeTools(tools, options = {}) {
  const maxFamilies = Math.max(1, options.maxFamilies ?? 10)
  /** @type {Map<string, { count: number, sample: string }>} */
  const families = new Map()

  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || tool.name.length === 0) continue
    const family = familyOf(tool.name)
    const entry = families.get(family)
    if (entry === undefined) {
      families.set(family, { count: 1, sample: truncate(tool.description ?? '', 60) })
    } else {
      entry.count += 1
      // 保留最短的一句：越短越像「用途」，越长越像某个具体参数的说明。
      const sample = truncate(tool.description ?? '', 60)
      if (sample.length > 0 && (entry.sample.length === 0 || sample.length < entry.sample.length)) {
        entry.sample = sample
      }
    }
  }

  return [...families.entries()]
    .map(([name, entry]) => ({ name, count: entry.count, sample: entry.sample }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, maxFamilies)
}

/** 工具名 -> 族名。`mcp__server__tool` 归到 `mcp:server`，避免每个工具一族。 */
export function familyOf(name) {
  const s = String(name)
  if (s.startsWith('mcp__')) {
    const parts = s.split('__')
    return parts.length >= 2 ? `mcp:${parts[1]}` : 'mcp'
  }
  const cut = s.indexOf('_')
  return cut > 0 ? s.slice(0, cut) : s
}

/** 渲染结果的一行摘要，用作去重键：内容没变就不再往会话里塞一遍。 */
export function digestOf(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
