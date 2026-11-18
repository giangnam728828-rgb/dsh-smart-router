import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_PINS, clearPins, createPanelHandler, peekPinned, setPinned, takePinned } from '../lib/panel.js'

/** 造一个最小的 req/res 对，够跑路由处理函数。 */
function call(handler, { method = 'GET', url = '/api/dsh-smart-router', body } = {}) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {}, async *[Symbol.asyncIterator]() { if (body !== undefined) yield body } }
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers) { this.statusCode = status; this.headers = headers },
      end(payload) { resolve({ status: this.statusCode, body: JSON.parse(payload) }) },
    }
    void handler(req, res)
  })
}

const handler = (overrides = {}) =>
  createPanelHandler({
    connection: { requestRejection: () => undefined },
    listSkills: async () => [
      { name: 'pdf-tools', description: '合并 PDF' },
      { name: 'personalized-pages', description: '做个页面' },
    ],
    ...overrides,
  })

test('GET 返回技能列表和当前钉住项', async () => {
  clearPins()
  const res = await call(handler(), { url: '/api/dsh-smart-router?sessionId=s1' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.skills.map((s) => s.name), ['pdf-tools', 'personalized-pages'])
  assert.deepEqual(res.body.pinned, { skills: [], families: [], plugins: [] })
})

test('GET 缺 sessionId 时报 400，而不是返回空列表假装成功', async () => {
  const res = await call(handler(), { url: '/api/dsh-smart-router' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'missing-session')
})

test('POST 钉住多个技能，可以多选', async () => {
  clearPins()
  const res = await call(handler(), {
    method: 'POST',
    body: JSON.stringify({ sessionId: 's2', skills: ['pdf-tools', 'personalized-pages'] }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.pinned.skills, ['pdf-tools', 'personalized-pages'])
  assert.deepEqual(peekPinned('s2').skills, ['pdf-tools', 'personalized-pages'])
})

test('钉住是一次性消费：取走后清空', () => {
  clearPins()
  setPinned('s3', { skills: ['pdf-tools'] })
  assert.deepEqual(takePinned('s3').skills, ['pdf-tools'])
  assert.deepEqual(takePinned('s3').skills, [], '第二次取不到，避免每轮重复加载')
})

test('重复的名字会去重，超过上限会截断', () => {
  clearPins()
  const names = Array.from({ length: MAX_PINS + 5 }, (_, i) => `skill-${i}`)
  const pinned = setPinned('s4', { skills: ['a', 'a', ...names] })
  assert.equal(pinned.skills.length, MAX_PINS)
  assert.equal(new Set(pinned.skills).size, MAX_PINS)
})

test('钉空等于清空', () => {
  clearPins()
  setPinned('s5', { skills: ['a'] })
  setPinned('s5', {})
  assert.deepEqual(peekPinned('s5'), { skills: [], families: [], plugins: [] })
})

test('拒绝跨站/未授权请求', async () => {
  const rejecting = createPanelHandler({
    connection: { requestRejection: () => 403 },
    listSkills: async () => [],
  })
  const res = await call(rejecting, { url: '/api/dsh-smart-router?sessionId=s1' })
  assert.equal(res.status, 403)
  assert.equal(res.body.error, 'access-denied')
})

test('坏 body 报 400，不抛异常', async () => {
  const res = await call(handler(), { method: 'POST', body: '{not json' })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'invalid-body')
})

test('认不出的会话不拒绝服务，只返回能拿到的部分', async () => {
  // 第一版在这里 404，导致整个面板报「没保存成功」。宁可少给数据，也别整块失败。
  const res = await call(handler({ sessionExists: () => false }), { url: '/api/dsh-smart-router?sessionId=ghost' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.ok(Array.isArray(res.body.skills))
})

test('客户端 id 与 agent.id 对不上时，钉住项记在 agent.id 上', async () => {
  clearPins()
  const res = await call(
    handler({
      resolveAgent: (id) => (id === 'client-abc' ? { id: 'agent-xyz' } : undefined),
    }),
    { method: 'POST', body: JSON.stringify({ sessionId: 'client-abc', skills: ['pdf-tools'] }) },
  )
  assert.equal(res.status, 200)
  assert.deepEqual(peekPinned('agent-xyz').skills, ['pdf-tools'], '必须落在下一轮能查到的键上')
  assert.deepEqual(peekPinned('client-abc').skills, [])
})

test('插件也能被点名', async () => {
  clearPins()
  const res = await call(handler(), {
    method: 'POST',
    body: JSON.stringify({ sessionId: 's9', plugins: ['dshmarket'], families: ['android'] }),
  })
  assert.deepEqual(res.body.pinned.plugins, ['dshmarket'])
  assert.deepEqual(res.body.pinned.families, ['android'])
})

test('响应里的每一块都是真数组/真对象，不是被序列化成 {} 的 Promise', async () => {
  // 回归：attempt() 是 async 的，少一个 await 就会把 Promise 塞进 JSON，
  // 客户端收到 {}，归一化后全变空数组 —— 表现是「技能有、插件和能力永远空」。
  clearPins()
  const res = await call(
    handler({
      listFamilies: () => [{ name: 'android', count: 12, sample: '触控' }],
      listPlugins: () => [{ name: 'dshmarket', description: '插件市场' }],
      readUsage: () => ({ total: 1234 }),
      readUsed: () => ({ skills: ['pdf-tools'], tools: [{ name: 'read', count: 2 }] }),
    }),
    { url: '/api/dsh-smart-router?sessionId=s1' },
  )
  assert.ok(Array.isArray(res.body.plugins), 'plugins 必须是数组')
  assert.ok(Array.isArray(res.body.families), 'families 必须是数组')
  assert.equal(res.body.plugins.length, 1)
  assert.equal(res.body.families.length, 1)
  assert.equal(res.body.usage.total, 1234)
  assert.deepEqual(res.body.used.skills, ['pdf-tools'])
})

test('插件条目也带 translated 标记（客户端靠它决定要不要补刷）', async () => {
  const route = createPanelHandler({
    connection: { requestRejection: () => undefined },
    resolveAgent: () => undefined,
    listSkills: async () => [],
    listFamilies: () => [],
    listPlugins: () => [
      { name: 'with-zh', description: 'English', descriptionZh: '中文' },
      { name: 'no-zh', description: 'English' },
    ],
    readUsage: () => ({}),
    readUsed: () => ({ skills: [], tools: [] }),
  })
  const { body } = await call(route, { url: '/api/dsh-smart-router?sessionId=s1' })
  assert.deepEqual(body.plugins.map((plugin) => plugin.translated), [true, false])
})

test('轻量轮询只回会变的那几块，不重复扫技能目录', async () => {
  let skillsCalls = 0
  let pluginsCalls = 0
  const route = createPanelHandler({
    connection: { requestRejection: () => undefined },
    resolveAgent: () => undefined,
    listSkills: async () => {
      skillsCalls += 1
      return [{ name: 'pdf-tools', description: 'x' }]
    },
    listFamilies: () => [],
    listPlugins: () => {
      pluginsCalls += 1
      return [{ name: 'p', description: 'x' }]
    },
    readUsage: () => ({ total: 42, at: 1000 }),
    readUsed: () => ({ skills: [{ name: 'pdf-tools', via: 'injected', at: 900 }], tools: [] }),
  })

  const full = await call(route, { url: '/api/dsh-smart-router?sessionId=s1' })
  assert.equal(skillsCalls, 1)
  assert.equal(pluginsCalls, 1)

  const light = await call(route, { url: '/api/dsh-smart-router?light=1&sessionId=s1' })
  assert.equal(light.body.ok, true)
  assert.equal(light.body.usage.total, 42)
  assert.deepEqual(light.body.used.skills.map((row) => row.via), ['injected'])
  assert.ok(typeof light.body.now === 'number')
  assert.equal('skills' in light.body, false, '轻量模式不该带技能清单')
  assert.equal(skillsCalls, 1, '轻量模式不能再扫一遍技能')
  assert.equal(pluginsCalls, 1, '轻量模式不能再扫一遍插件')
})
