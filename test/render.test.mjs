import { test } from 'node:test'
import assert from 'node:assert/strict'

import { matchReasons, renderStaticBlock, renderTurnBlock, taskLine } from '../lib/render.js'
import { tokenize } from '../lib/route.js'

test('taskLine: 取第一行非空内容并截断', () => {
  assert.equal(taskLine('\n\n  帮我改一下样式  \n第二行'), '帮我改一下样式')
  assert.equal(taskLine(''), '')
  assert.equal(taskLine('a'.repeat(300), 10).length, 10)
})

test('renderStaticBlock: 插件和工具族都写进去，带规矩', () => {
  const text = renderStaticBlock({
    plugins: [{ name: 'dshmarket', title: '插件市场', description: '浏览和安装插件' }],
    families: [{ name: 'android', count: 12, sample: '真实触控点击实体主屏' }],
  })
  assert.ok(text.includes('<skill_router>'))
  assert.ok(text.includes('插件市场'))
  assert.ok(text.includes('android（12 个）'))
  assert.ok(text.includes('不是命令'), '必须有「这是候选不是命令」这句')
  assert.ok(text.includes('不要为了用而用') || text.includes('不要为了「保险」'))
})

test('renderStaticBlock: 什么都没得写时返回空串，不产生噪音', () => {
  assert.equal(renderStaticBlock({ plugins: [], families: [] }), '')
})

test('renderTurnBlock: 候选带命中理由', () => {
  const text = renderTurnBlock({
    task: '帮我把两个 PDF 合并',
    candidates: [{ name: 'pdf-tools', description: '合并、拆分 PDF 文件', score: 0.8 }],
    reasons: { 'pdf-tools': ['合并', 'pdf'] },
    total: 5,
  })
  assert.ok(text.includes('pdf-tools'))
  assert.ok(text.includes('合并'))
  assert.ok(text.includes('skill 工具'))
  assert.ok(text.includes('total_indexed="5"'))
})

test('renderTurnBlock: 没候选就不输出', () => {
  assert.equal(renderTurnBlock({ task: '随便聊聊', candidates: [], total: 3 }), '')
})

test('matchReasons: 只给出真实重合的词', () => {
  const query = tokenize('帮我把两个 PDF 合并成一个文件')
  const reasons = matchReasons(query, { name: 'pdf-tools', description: '合并、拆分 PDF 文件' }, tokenize)
  assert.ok(reasons.includes('pdf'))
  assert.ok(reasons.includes('合并'))
  assert.ok(!reasons.includes('天气'))
  assert.ok(reasons.length <= 6)
})

test('注入块不会包含技能正文级别的结构标记', () => {
  const text = renderTurnBlock({
    task: 't',
    candidates: [{ name: 'a', description: 'd', score: 0.5 }],
    total: 1,
  })
  assert.ok(!text.includes('<skill_content'), '正文只能由模型自己 skill 加载，注入块不该带它')
})

test('renderTurnBlock: 只有工具族时也要输出（插件能力这一半）', () => {
  const text = renderTurnBlock({
    task: '把手机屏幕上的按钮点一下',
    candidates: [],
    families: [{ name: 'android', count: 42, sample: '真实触控点击实体主屏' }],
    total: 0,
  })
  assert.ok(text.includes('android（42 个工具）'))
  assert.ok(text.includes('你自己判断'))
  assert.ok(!text.includes('skill 工具'), '没有技能候选时不该让模型去调 skill')
})
