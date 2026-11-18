import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SKILL_ZH, describeSkill } from '../lib/zh.js'
import { clearUsage, noteToolCall, usageOf } from '../lib/usage.js'

test('已知技能给出中文说明，名字保持原样', () => {
  const result = describeSkill('personalized-pages', 'Plan an optional page...')
  assert.equal(result.translated, true)
  assert.ok(result.text.length > 0)
  assert.ok(!/Plan an optional/.test(result.text), '不该直接返回英文')
})

test('未知技能退回英文原文，不编造翻译', () => {
  const result = describeSkill('some-new-skill', 'Does a thing')
  assert.equal(result.translated, false)
  assert.equal(result.text, 'Does a thing')
})

test('中文表里的键都是小写 kebab-case（和 skill 工具的入参一致）', () => {
  for (const name of Object.keys(SKILL_ZH)) {
    assert.equal(name, name.toLowerCase())
    assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(name), `${name} 不是合法的技能名`)
  }
})

test('记录真实工具调用：技能单列，工具计数', () => {
  clearUsage()
  noteToolCall('s1', 'skill', { name: 'pdf-tools' })
  noteToolCall('s1', 'android_click', {})
  noteToolCall('s1', 'android_click', {})
  noteToolCall('s1', 'web_search', {})
  const usage = usageOf('s1')
  assert.deepEqual(usage.skills, ['pdf-tools'])
  assert.deepEqual(usage.tools, [
    { name: 'android_click', count: 2 },
    { name: 'web_search', count: 1 },
  ])
})

test('没有记录的会话返回空，不报错', () => {
  assert.deepEqual(usageOf('nobody'), { skills: [], tools: [] })
})

test('脏输入被忽略', () => {
  clearUsage()
  noteToolCall('', 'read', {})
  noteToolCall('s2', '', {})
  noteToolCall('s2', 'skill', {})
  assert.deepEqual(usageOf('s2'), { skills: [], tools: [] })
})

test('用户中文表优先于内置表，且缺条目时不影响其它技能', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-override-'))
  mkdirSync(join(dir, 'smart-router'), { recursive: true })
  writeFileSync(join(dir, 'smart-router', 'skills.zh.json'), JSON.stringify({ 'brand-new-skill': '这是用户自己写的中文' }), 'utf8')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const result = describeSkill('brand-new-skill', 'English description')
    assert.equal(result.translated, true)
    assert.equal(result.text, '这是用户自己写的中文')
    // 表里没有的，照旧退回英文，不编造
    const other = describeSkill('not-in-any-table', 'English description')
    assert.equal(other.translated, false)
    assert.equal(other.text, 'English description')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
