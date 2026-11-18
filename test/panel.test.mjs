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
  assert.deepEqual(res.body.pinned, [])
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
  assert.deepEqual(res.body.pinned, ['pdf-tools', 'personalized-pages'])
  assert.deepEqual(peekPinned('s2'), ['pdf-tools', 'personalized-pages'])
})

test('钉住是一次性消费：取走后清空', () => {
  clearPins()
  setPinned('s3', ['pdf-tools'])
  assert.deepEqual(takePinned('s3'), ['pdf-tools'])
  assert.deepEqual(takePinned('s3'), [], '第二次取不到，避免每轮重复加载')
})

test('重复的名字会去重，超过上限会截断', () => {
  clearPins()
  const names = Array.from({ length: MAX_PINS + 5 }, (_, i) => `skill-${i}`)
  const pinned = setPinned('s4', ['a', 'a', ...names])
  assert.equal(pinned.length, MAX_PINS)
  assert.equal(new Set(pinned).size, MAX_PINS)
})

test('钉空等于清空', () => {
  clearPins()
  setPinned('s5', ['a'])
  setPinned('s5', [])
  assert.deepEqual(peekPinned('s5'), [])
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

test('不存在的会话返回 404', async () => {
  const res = await call(handler({ sessionExists: () => false }), { url: '/api/dsh-smart-router?sessionId=ghost' })
  assert.equal(res.status, 404)
})
