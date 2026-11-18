import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, resolveConfig, userTaskText } from '../lib/config.js'

test('resolveConfig: 空配置得到默认值', () => {
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULTS })
  assert.deepEqual(resolveConfig({}), { ...DEFAULTS })
})

test('resolveConfig: 越界数值被夹住，而不是原样传给下游', () => {
  const config = resolveConfig({ maxCandidates: 99, minScore: -3, pluginsLimit: 100, familiesLimit: -1 })
  assert.equal(config.maxCandidates, 8)
  assert.equal(config.minScore, 0)
  assert.equal(config.pluginsLimit, 20)
  assert.equal(config.familiesLimit, 0)
})

test('resolveConfig: 类型不对时退回默认值', () => {
  const config = resolveConfig({ enabled: 'yes', maxCandidates: 'many', debug: 1 })
  assert.equal(config.enabled, DEFAULTS.enabled)
  assert.equal(config.maxCandidates, DEFAULTS.maxCandidates)
  assert.equal(config.debug, DEFAULTS.debug)
})

test('resolveConfig: 0 是合法值，不能被当成缺省', () => {
  const config = resolveConfig({ pluginsLimit: 0, familiesLimit: 0 })
  assert.equal(config.pluginsLimit, 0)
  assert.equal(config.familiesLimit, 0)
})

test('userTaskText: 只取 source.kind === user 的文本', () => {
  const messages = [
    { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我合并 PDF' }] },
    { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '上一轮的候选' }] },
    { source: { kind: 'skill-invocation', name: 'pdf' }, content: [{ type: 'text', text: '正文' }] },
  ]
  assert.equal(userTaskText(messages), '帮我合并 PDF')
})

test('userTaskText: 没有用户文本时返回 undefined', () => {
  assert.equal(userTaskText([]), undefined)
  assert.equal(userTaskText([{ source: { kind: 'plugin' }, content: [] }]), undefined)
  assert.equal(userTaskText(undefined), undefined)
})

test('userTaskText: 多段用户消息拼起来，忽略非文本块', () => {
  const messages = [
    { source: { kind: 'user' }, content: [{ type: 'text', text: '第一段' }, { type: 'image' }] },
    { source: { kind: 'user' }, content: [{ type: 'text', text: '第二段' }] },
  ]
  assert.equal(userTaskText(messages), '第一段\n第二段')
})
