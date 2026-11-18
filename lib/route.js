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
/**
 * 拉丁词：按**字母数字段**切，而不是把连字符/点号一起吞掉。
 *
 * 这条曾经是错的：`personalized-pages` 被当成一个整词，于是「页面」-> page
 * 永远对不上任何一个技能名。名字是最强的信号，把它切坏了，召回就归零。
 * 完整标识符仍然保留一份（`cordis-plugin-development`），用于精确命中。
 */
const LATIN_WORD = /[a-z0-9]+/g
const LATIN_IDENTIFIER = /[a-z0-9][a-z0-9+#._-]*/g
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/**
 * 中文词 -> 英文词。
 *
 * 为什么需要它：技能和工具的描述基本都是英文写的（`personalized-pages —
 * Plan an optional page or small tool...`），而用户说的是中文。
 * 不做这层桥接，中文提问对英文描述的重合永远是 0 —— 这不是阈值问题，
 * 是两边根本不在同一个字符集里。上游用 1024 维向量跨语言对齐，
 * 我们用一张小词表，够用、可解释、可自己加。
 */
const ZH_EN = Object.freeze({
  页面: ['page'], 面板: ['panel'], 标签: ['tab'], 界面: ['interface', 'ui'],
  插件: ['plugin'], 技能: ['skill'], 工具: ['tool'], 功能: ['feature'],
  设计: ['design'], 前端: ['frontend'], 审查: ['review'], 评审: ['review'],
  调试: ['debug'], 部署: ['deploy'], 安装: ['install'], 配置: ['config', 'configure'],
  设置: ['setting'], 优化: ['optimize'], 性能: ['performance'], 安全: ['security'],
  权限: ['permission'], 测试: ['test'], 重构: ['refactor'], 分析: ['analyze', 'analysis'],
  数据: ['data'], 报告: ['report'], 文档: ['document', 'doc'], 表格: ['spreadsheet', 'table'],
  幻灯片: ['slide', 'presentation'], 演示: ['presentation'], 图片: ['image'], 视频: ['video'],
  音频: ['audio'], 截图: ['screenshot'], 屏幕: ['screen'], 手机: ['phone', 'android'],
  点击: ['click'], 滑动: ['swipe'], 输入: ['type', 'input'], 应用: ['app'],
  网页: ['web', 'page'], 网站: ['website'], 搜索: ['search'], 会话: ['session'],
  任务: ['task'], 定时: ['schedule'], 工作流: ['workflow'], 文件: ['file'],
  目录: ['directory'], 命令: ['command'], 终端: ['terminal'], 代码: ['code'],
  脚本: ['script'], 模型: ['model'], 提示词: ['prompt'], 体验: ['experience'],
  动画: ['animate', 'animation'], 图标: ['icon'], 颜色: ['color'], 字体: ['font'],
  排版: ['layout', 'typography'], 组件: ['component'], 样式: ['style'], 布局: ['layout'],
  // 落地页这一族：中文说「落地页 / 官网 / 首页 / 宣传页」，英文技能写的是 landing page。
  // 缺了这几个词，装多少 landing-page-design 都召不回来 —— 分词是二元组，
  // 「落地页」切出来是 落地 / 地页，所以两点都要给。
  落地: ['landing'], 地页: ['landing'], 官网: ['landing', 'website'],
  首页: ['landing', 'home'], 宣传: ['marketing', 'landing'], 传页: ['landing'],
  配色: ['color', 'palette'], 视觉: ['visual', 'design'], 审美: ['taste', 'design'],
  错误: ['error'], 日志: ['log'], 缓存: ['cache'], 索引: ['index'], 记忆: ['memory'],
  知识: ['knowledge'], 学习: ['learn'], 总结: ['summary'], 翻译: ['translate'],
})

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
    // 轻量词干：复数 -> 单数。pages/page、plugins/plugin、tools/tool。
    // 只加不减：原词保留，所以 analysis 这类词不会被误伤。
    if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) {
      const singular = word.slice(0, -1)
      tokens.set(singular, Math.max(tokens.get(singular) ?? 0, 1))
    }
  }

  // 带连字符/点的完整标识符（personalized-pages）单独留一份，
  // 用于「用户直接说出了名字」这种精确命中。
  for (const identifier of s.match(LATIN_IDENTIFIER) ?? []) {
    if (identifier.length >= 3 && /[._-]/.test(identifier)) {
      tokens.set(identifier, Math.max(tokens.get(identifier) ?? 0, 1))
    }
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
 * 一个候选的「可比较记号」：字段 -> 该字段里出现的记号及最高权重。
 * 名字最可信（"pdf" 对上 "pdf" 就是强信号），whenToUse 次之，description 最泛。
 */
const FIELDS = /** @type {const} */ ([
  ['name', 3],
  ['whenToUse', 2],
  // 关键词：面板上显示的中文说明也参与匹配。
  // 不做这一步，「面板写中文、匹配按英文算」就是两套口径，用户看到的词影响不了结果。
  ['keywords', 2],
  ['description', 1],
])

/** 把一个候选摊平成 记号 -> 权重。 */
function candidateTokens(candidate) {
  const tokens = new Map()
  for (const [field, weight] of FIELDS) {
    const value = candidate[field]
    if (typeof value !== 'string' || value.length === 0) continue
    for (const token of tokenize(value).keys()) {
      tokens.set(token, Math.max(tokens.get(token) ?? 0, weight))
    }
  }
  return tokens
}

/**
 * 语料统计：每个记号出现在多少个候选里。
 *
 * 这一步是治噪声的关键。「操作」「正常」这类词在几十个工具描述里到处都有，
 * 命中它们说明不了任何事；而「合并」「PDF」只在少数描述里出现，命中才是信号。
 * IDF 把前者压到接近零、把后者保住。
 *
 * @param {readonly object[]} candidates
 */
export function buildCorpusStats(candidates) {
  const df = new Map()
  for (const candidate of candidates) {
    for (const token of candidateTokens(candidate).keys()) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  const size = Math.max(1, candidates.length)
  return {
    size,
    /** 逆文档频率：越常见越小，最小 0。 */
    idf(token) {
      const n = df.get(token) ?? 0
      return Math.log(1 + size / (1 + n))
    },
  }
}

/**
 * 查询扩展：给中文词补上它的英文对应词，权重略低（0.8）。
 *
 * 只扩查询，不扩候选 —— 候选是别人写好的描述，我们没资格改它的含义。
 */
export function expandQuery(tokens) {
  const expanded = new Map(tokens)
  for (const [token, weight] of tokens) {
    const mapped = ZH_EN[token]
    if (mapped === undefined) continue
    for (const english of mapped) {
      expanded.set(english, Math.max(expanded.get(english) ?? 0, weight * 0.8))
    }
  }
  return expanded
}

/** 任务里出现、但语料里没有的词，权重按「最稀有」算。 */
function queryIdf(stats, token) {
  return stats === undefined ? 1 : stats.idf(token)
}

/**
 * 打分：任务与候选的加权重合，按「任务里有多少信息量被覆盖」归一。
 *
 * 分母是任务全部记号的 idf 之和（乘最大字段权重），不是命中数 ——
 * 于是一段又长又杂的指令天然拿不到高分：它要求覆盖的东西太多了。
 * 这正是我们要的：宁可少给，也别把不相干的东西塞进候选。
 *
 * @param {Map<string, number>} query - tokenize(task) 的结果
 * @param {{ name: string, description?: string, whenToUse?: string }} candidate
 * @param {{ idf: (token: string) => number } | undefined} [stats] - 省略则视为均匀权重
 * @returns {number} 0..1 之间的相对分，只用于排序和收窄
 */
export function scoreCandidate(query, candidate, stats) {
  if (query.size === 0) return 0

  let hit = 0
  let matched = 0
  for (const [token, fieldWeight] of candidateTokens(candidate)) {
    let q = query.get(token)
    if (q === undefined) {
      // 前缀兜底：screen 命中 screenshot、page 命中 pagination。
      // 只在查询词足够长时启用，避免三字母前缀到处误伤。
      for (const [queryToken, queryWeight] of query) {
        if (queryToken.length >= 4 && token.length > queryToken.length && token.startsWith(queryToken)) {
          q = Math.max(q ?? 0, queryWeight * 0.5)
        }
      }
    }
    if (q === undefined) continue
    hit += queryIdf(stats, token) * fieldWeight * Math.min(q, 1)
    matched += 1
  }
  if (matched === 0) return 0

  let total = 0
  for (const [token, weight] of query) total += queryIdf(stats, token) * weight * 3
  return total === 0 ? 0 : Math.min(1, hit / total)
}

/**
 * 从全部候选里挑出最值得给模型看的一批。
 *
 * 关键：**没有绝对阈值的判定**。这里只负责排序 + 截断，
 * 并且始终保留「一个都没有」这个合法结果（一个都不过线就不硬凑）。
 *
 * `minHits` 是防「靠一个烂大街的词混进来」的第二道闸：
 * 只命中一个记号，无论分数多少都不算数。
 *
 * @template {{ name: string, description?: string, whenToUse?: string }} T
 * @param {readonly T[]} candidates
 * @param {string} task
 * @param {{ limit?: number, minimum?: number, minHits?: number }} [options]
 * @returns {{ selected: Array<T & { score: number, hits: number }>, total: number, empty: boolean }}
 */
export function narrow(candidates, task, options = {}) {
  const limit = Math.max(1, options.limit ?? 4)
  const minimum = options.minimum ?? 0.02
  const minHits = Math.max(1, options.minHits ?? 1)
  const query = expandQuery(tokenize(task))
  const stats = buildCorpusStats(candidates)

  const scored = []
  for (const candidate of candidates) {
    const score = scoreCandidate(query, candidate, stats)
    if (score <= 0) continue
    let hits = 0
    for (const token of candidateTokens(candidate).keys()) if (query.has(token)) hits += 1
    scored.push({ ...candidate, score, hits })
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  const passing = scored.filter((candidate) => candidate.score >= minimum && candidate.hits >= minHits)
  if (passing.length === 0) return { selected: [], total: candidates.length, empty: true }
  return { selected: passing.slice(0, limit), total: candidates.length, empty: false }
}

/** 截断到 n 个字符，按码点切，不制造半个字。 */
export function truncate(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const chars = [...s]
  return chars.length <= n ? s : chars.slice(0, n - 1).join('') + '…'
}

/**
 * 以动词开头的「族名」不是族，是同名碰撞。
 *
 * `list_mcp_resources` / `list_agents` 凑成的「list 族」没有任何意义 ——
 * 它们除了都以一个通用动词开头之外毫无关系。这类前缀不参与归族，
 * 否则注入块里就会出现「list（4 个）」这种看起来像分类、实际是噪声的东西。
 */
const GENERIC_FAMILY = new Set([
  'list', 'read', 'create', 'get', 'set', 'run', 'write', 'view', 'update', 'delete',
  'search', 'find', 'show', 'make', 'open', 'close', 'start', 'stop', 'add', 'remove',
  'load', 'save', 'send', 'check', 'apply', 'edit', 'copy', 'move', 'wait', 'ask',
])

/**
 * 工具族摘要：把上百个工具压成十几行「哪一类能力、几个、干什么」。
 * 工具名按第一段前缀归族（android_click / mcp__dsha-vscreen__tap / schedule_create）。
 *
 * 只有**两个以上成员、且族名不是通用动词**的才成族；其余留在各自的工具上，
 * 由 `rankTools` 按本轮任务单独挑。
 *
 * @param {readonly { name: string, description?: string }[]} tools
 * @param {{ maxFamilies?: number, minMembers?: number }} [options]
 */
export function summarizeTools(tools, options = {}) {
  const maxFamilies = Math.max(1, options.maxFamilies ?? 10)
  const minMembers = Math.max(2, options.minMembers ?? 2)
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
    .filter(([name, entry]) => entry.count >= minMembers && !GENERIC_FAMILY.has(name))
    .map(([name, entry]) => ({ name, count: entry.count, sample: entry.sample }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, maxFamilies)
}

/**
 * 按本轮任务挑出最值得看的几个**具体工具**。
 *
 * 族摘要回答「这台机器有什么能力」，这里回答「这句话可能用到哪个工具」。
 * 后者比族更可执行：模型看到 `android_click — 真实触控点击实体主屏`
 * 就知道下一步该调什么，看到「android 族 12 个」还得再猜一次。
 *
 * @param {readonly { name: string, description?: string }[]} tools
 * @param {string} task
 * @param {{ limit?: number, minimum?: number }} [options]
 */
export function rankTools(tools, task, options = {}) {
  const items = tools
    .filter((tool) => typeof tool?.name === 'string' && tool.name.length > 0)
    .map((tool) => ({ name: tool.name, description: tool.description ?? '' }))
  return narrow(items, task, {
    limit: Math.max(1, options.limit ?? 3),
    minimum: options.minimum ?? 0.02,
    minHits: options.minHits ?? 1,
  }).selected
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
