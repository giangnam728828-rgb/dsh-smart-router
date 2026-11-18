/**
 * lib/zh.js — 技能的简体中文说明。
 *
 * 为什么需要：技能描述是作者用英文写的（"Plan an optional page or small tool
 * when the user asks for a page, tab, panel..."）。名字保持不变——它是 `skill`
 * 工具的入参，翻了就对不上了；只翻说明。
 *
 * 策略：
 *   1. 已知技能查表（下面的 SKILL_ZH）。
 *   2. 查不到就退到英文原文，绝不编造一个听起来合理的翻译。
 *
 * 加新技能：往 SKILL_ZH 里补一条即可；不补也不会坏，只是继续显示英文。
 */

/** 内置技能的简体中文说明。键是技能名，值是给人看的一句话。 */
export const SKILL_ZH = Object.freeze({
  'agent-experience': '写工具定义、技能、工作流时，让模型更容易发现和用对。',
  'cordis-composition-reference': '读写 Cordis 组合补丁和预设时，查 YAML 写法与可用插件包。',
  'cordis-plugin-development': '设计、开发、安装、调试插件、面板、工具或 MCP 连接。',
  'editing-cordis-compositions': '创建或修改 Agent 预设，并检查它能不能挂载起来。',
  impeccable: '设计或重塑界面：布局、排版、配色、动效、无障碍与响应式。',
  'official-plugins': '想知道这个应用还能干什么、某个能力缺不缺时，查官方可选插件。',
  'personalized-pages': '用户要一个页面、面板、标签页或小工具时，先把方案定下来。',
  unslop: '把一眼看上去像 AI 生成的界面，改成有自己性格的设计。',
})

/**
 * 取一个技能的中文说明。
 *
 * @param {string} name - 技能名（保持原样，不翻译）
 * @param {string} [description] - 英文说明，作为兜底
 * @returns {{ text: string, translated: boolean }}
 */
export function describeSkill(name, description) {
  const zh = SKILL_ZH[name]
  if (typeof zh === 'string' && zh.length > 0) return { text: zh, translated: true }
  return { text: typeof description === 'string' ? description : '', translated: false }
}
