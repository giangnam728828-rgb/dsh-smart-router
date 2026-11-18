import { test } from 'node:test'
import assert from 'node:assert/strict'

import { digestOf, familyOf, narrow, rankTools, scoreCandidate, summarizeTools, tokenize, truncate } from '../lib/route.js'

test('tokenize: 中文按二元组切，不是一个字一个字符', () => {
  const tokens = tokenize('项目进度报告')
  assert.ok(tokens.has('项目'))
  assert.ok(tokens.has('进度'))
  assert.ok(tokens.has('报告'))
  assert.ok(!tokens.has('项'), '不应该退化成单字')
})

test('tokenize: 英文按词切并丢虚词', () => {
  const tokens = tokenize('merge the PDF files')
  assert.ok(tokens.has('merge'))
  assert.ok(tokens.has('pdf'))
  assert.ok(tokens.has('files'))
  assert.ok(!tokens.has('the'))
})

test('tokenize: 中英混排两边都取到', () => {
  const tokens = tokenize('把 build 产物 deploy 到服务器')
  assert.ok(tokens.has('build'))
  assert.ok(tokens.has('deploy'))
  assert.ok(tokens.has('服务'))
  assert.ok(tokens.has('产物'))
})

test('scoreCandidate: 上游漏掉的中文真实匹配，这里能命中', () => {
  // 上游注释里写的就是这一条：bge-m3 上只有 0.10~0.13，达不到 minScore。
  const task = tokenize('帮我写一份项目进度报告发给团队')
  const skill = {
    name: 'internal-comms',
    description: '写项目进度报告、周报、团队同步邮件',
  }
  assert.ok(scoreCandidate(task, skill) > 0.3, '字面高度重合时必须拿到明显分数')
})

test('scoreCandidate: 完全不相干的是 0', () => {
  const task = tokenize('把这张图片裁成正方形')
  const skill = { name: 'deploy-vercel', description: 'Deploy an application to Vercel' }
  assert.equal(scoreCandidate(task, skill), 0)
})

test('scoreCandidate: 空任务不产生分数', () => {
  assert.equal(scoreCandidate(tokenize(''), { name: 'x', description: 'y' }), 0)
})

test('narrow: 只排序和截断，不替模型做判定', () => {
  const skills = [
    { name: 'pdf-tools', description: '合并、拆分 PDF 文件' },
    { name: 'deploy-vercel', description: '把应用部署到 Vercel' },
    { name: 'spreadsheet', description: '生成和编辑表格' },
  ]
  const result = narrow(skills, '帮我把两个 PDF 合并成一个', { limit: 2 })
  assert.equal(result.total, 3)
  assert.equal(result.selected.length, 1, '只有真正重合的那条进来')
  assert.equal(result.selected[0].name, 'pdf-tools')
})

test('narrow: 一个都对不上时返回空，不硬凑', () => {
  const skills = [{ name: 'deploy-vercel', description: 'Deploy an application to Vercel' }]
  const result = narrow(skills, '今天天气怎么样', { limit: 3 })
  assert.equal(result.empty, true)
  assert.deepEqual(result.selected, [])
})

test('narrow: limit 生效且按分排序', () => {
  const skills = [
    { name: 'a', description: '生成海报' },
    { name: 'b', description: '生成海报并导出' },
    { name: 'c', description: '生成海报、导出、批量' },
  ]
  const result = narrow(skills, '生成海报', { limit: 2 })
  assert.equal(result.selected.length, 2)
  assert.ok(result.selected[0].score >= result.selected[1].score)
})

test('familyOf: MCP 工具按服务器归族，普通工具按前缀', () => {
  assert.equal(familyOf('mcp__dsha-android__android_click'), 'mcp:dsha-android')
  assert.equal(familyOf('android_click'), 'android')
  assert.equal(familyOf('schedule_create'), 'schedule')
  assert.equal(familyOf('bash'), 'bash')
  assert.equal(familyOf('mcp__lone'), 'mcp:lone')
})

test('summarizeTools: 归族、计数、按数量排序', () => {
  const tools = [
    { name: 'android_click', description: '真实触控点击实体主屏' },
    { name: 'android_swipe', description: '真实触控滑动实体主屏' },
    { name: 'schedule_create', description: '创建定时任务' },
    { name: 'schedule_list', description: '列出定时任务' },
    { name: 'schedule_view', description: '查看定时任务' },
    { name: 'mcp__x__a', description: 'x a' },
  ]
  const families = summarizeTools(tools, { maxFamilies: 2 })
  assert.equal(families.length, 2)
  assert.equal(families[0].name, 'schedule', '成员多的排前面')
  assert.equal(families[0].count, 3)
  assert.equal(families[1].name, 'android')
})

test('summarizeTools: 通用动词开头的不算族（list 族是噪声）', () => {
  const tools = [
    { name: 'list_agents', description: 'List subagents' },
    { name: 'list_mcp_resources', description: 'List MCP resources' },
    { name: 'list_mcp_resource_templates', description: 'List templates' },
    { name: 'read_mcp_resource', description: 'Read a resource' },
  ]
  assert.deepEqual(summarizeTools(tools), [], '它们除了动词相同毫无关系，不该被归成一族')
})

test('summarizeTools: 单成员不成族', () => {
  const tools = [{ name: 'schedule_create', description: '创建定时任务' }]
  assert.deepEqual(summarizeTools(tools), [])
})

test('rankTools: 按本轮任务挑出具体工具，而不是族', () => {
  const tools = [
    { name: 'android_click', description: '真实触控点击实体主屏' },
    { name: 'android_swipe', description: '真实触控滑动实体主屏' },
    { name: 'web_search', description: 'Search the web' },
  ]
  const ranked = rankTools(tools, '在手机屏幕上点击按钮', { limit: 2 })
  assert.ok(ranked.length >= 1)
  assert.equal(ranked[0].name, 'android_click')
  assert.ok(!ranked.some((tool) => tool.name === 'web_search'), '不相干的不该混进来')
})

test('truncate: 按码点切，不切出半个字', () => {
  assert.equal(truncate('一二三四五', 3), '一二…')
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(truncate('  多  空格  ', 10), '多 空格')
})

test('digestOf: 同样的文本同键，变一个字符就变键', () => {
  assert.equal(digestOf('abc'), digestOf('abc'))
  assert.notEqual(digestOf('abc'), digestOf('abd'))
})
