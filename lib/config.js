/**
 * lib/config.js — 配置归一化与「哪些消息算用户任务」。
 *
 * 单独一个文件是为了能脱离 DSH 运行时直接测：这里没有任何框架依赖。
 */

/** 配置默认值。全部可以在 cordis 配置里覆盖。 */
export const DEFAULTS = Object.freeze({
  /** 总开关。关掉后本插件不注册任何监听。 */
  enabled: true,
  /** 每轮最多给几个技能候选。给太多等于没给。 */
  maxCandidates: 3,
  /** 候选下限分；只用于过滤显然不相干的，不是「够不够用」的判定线。 */
  minScore: 0.02,
  /** 是否在静态块里列出已装插件。 */
  includePlugins: true,
  /** 最多列几个插件。 */
  pluginsLimit: 8,
  /** 是否在静态块里列出工具族。 */
  includeToolFamilies: true,
  /** 最多列几个工具族。 */
  familiesLimit: 10,
  /** 是否输出诊断日志。 */
  debug: false,
})

/**
 * 归一化配置：只认自己认识的键，数值全部夹到合法区间。
 * 不依赖 schemastery —— 少一个依赖，就少一个装不上来的理由；
 * 代价是配置写错不会被漂亮地报出来，只会被夹到最近一个合法值。
 *
 * @param {Record<string, unknown> | undefined} raw
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const number = (value, fallback, min, max) => {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.min(max, Math.max(min, n))
  }
  const boolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  return {
    enabled: boolean(input.enabled, DEFAULTS.enabled),
    maxCandidates: Math.round(number(input.maxCandidates, DEFAULTS.maxCandidates, 1, 8)),
    minScore: number(input.minScore, DEFAULTS.minScore, 0, 1),
    includePlugins: boolean(input.includePlugins, DEFAULTS.includePlugins),
    pluginsLimit: Math.round(number(input.pluginsLimit, DEFAULTS.pluginsLimit, 0, 20)),
    includeToolFamilies: boolean(input.includeToolFamilies, DEFAULTS.includeToolFamilies),
    familiesLimit: Math.round(number(input.familiesLimit, DEFAULTS.familiesLimit, 0, 20)),
    debug: boolean(input.debug, DEFAULTS.debug),
  }
}

/**
 * 只取真实用户写的文本。
 *
 * 关键在 `source.kind === 'user'`：插件自己注入的消息（本插件、技能目录、
 * 技能调用）都会进同一个 messages 数组，如果不过滤，第二轮就会拿着
 * 自己上一轮写的提示当任务，越滚越偏。
 *
 * @param {readonly any[] | undefined} messages
 * @returns {string | undefined}
 */
export function userTaskText(messages) {
  const parts = []
  for (const message of messages ?? []) {
    if (message?.source?.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  const text = parts.join('\n').trim()
  return text.length > 0 ? text : undefined
}
