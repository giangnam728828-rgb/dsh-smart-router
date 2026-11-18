/**
 * test/conflicts.test.mjs — 与宿主、与自己、与其它插件共处时的边界。
 *
 * 这一组测的不是「功能对不对」，而是「会不会把宿主搞坏」：
 * 路由重复注册、旧实例拆掉新实例的路由、内存只涨不落、上游 decision 形状不合预期。
 */
import './_env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/plugin.js'
import { claimRoute, clearPins, peekPinned, setPinned, MAX_PIN_SESSIONS, ROUTE, ROUTE_OWNER_KEY } from '../lib/panel.js'
import { clearUsage, MAX_SESSIONS, noteSkillInjection, noteToolCall, usageOf } from '../lib/usage.js'

/** 和真宿主一样：同一个 (kind, path) 注册两次直接抛错。 */
function makeServer() {
  const exact = new Map()
  return {
    exact,
    register({ kind, path, handler }) {
      if (kind === 'exact' && exact.has(path)) {
        throw new Error(`webserver: duplicate ${kind} route "${path}"`)
      }
      exact.set(path, handler)
      return () => {
        exact.delete(path)
      }
    },
  }
}

test('重复接管路由不抛错，且只有一条路由', () => {
  const server = makeServer()
  for (let i = 0; i < 10; i += 1) claimRoute(server, () => i)
  assert.equal(server.exact.size, 1)
  delete globalThis[ROUTE_OWNER_KEY]
})

test('旧实例销毁时不会拆掉新实例的路由', () => {
  const server = makeServer()
  const releaseOld = claimRoute(server, () => 'old')
  const releaseNew = claimRoute(server, () => 'new')

  // 关键：旧实例的 effect 之后才被清理（重载时的真实顺序）
  releaseOld()

  assert.equal(server.exact.size, 1, '新实例的路由必须还在')
  assert.equal(server.exact.get(ROUTE)(), 'new', '在用的必须是最新那个 handler')

  releaseNew()
  assert.equal(server.exact.size, 0, '最后一个持有者才真正释放')
  delete globalThis[ROUTE_OWNER_KEY]
})

test('接管道具被调用时 apply 不抛错（注册失败也只是这一项没成）', () => {
  const server = {
    register() {
      throw new Error('webserver: duplicate exact route "/api/dsh-smart-router"')
    },
  }
  const handlers = new Map()
  const services = { webServer: server }
  const ctx = {
    get: (name) => services[name],
    inject: (deps, cb) => {
      const inner = { ...ctx }
      for (const dep of deps) inner[dep] = services[dep]
      cb(inner)
    },
    effect: (fn) => fn(),
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
  }
  assert.doesNotThrow(() => apply(ctx, { debug: false }))
  delete globalThis[ROUTE_OWNER_KEY]
})

test('钉住项按会话有上限，不会一路涨上去', () => {
  clearPins()
  for (let i = 0; i < MAX_PIN_SESSIONS * 3; i += 1) {
    setPinned(`s${i}`, { skills: [`skill-${i}`] })
  }
  // 最新的必须还在，最旧的必须已经被淘汰
  assert.deepEqual(peekPinned(`s${MAX_PIN_SESSIONS * 3 - 1}`).skills, [`skill-${MAX_PIN_SESSIONS * 3 - 1}`])
  assert.deepEqual(peekPinned('s0').skills, [], '最旧的应被淘汰')
  clearPins()
})

test('用量记录按会话有上限', () => {
  clearUsage()
  for (let i = 0; i < MAX_SESSIONS * 2; i += 1) noteToolCall(`u${i}`, 'read_file')
  assert.deepEqual(usageOf(`u${MAX_SESSIONS * 2 - 1}`).tools.map((row) => [row.name, row.count]), [['read_file', 1]])
  assert.deepEqual(usageOf('u0'), { skills: [], tools: [] }, '最旧的应被淘汰')
  clearUsage()
})

test('上游 decision 缺 messages 时仍然注入，不静默跳过', async () => {
  const handlers = new Map()
  const skills = {
    snapshot: async () => ({
      skills: [{ name: 'pdf-tools', description: 'pdf 工具', invocation: { modelInvocable: true } }],
    }),
    get: async () => undefined,
  }
  const services = {
    skills,
    tools: { definitions: () => [{ name: 'pdf_extract' }, { name: 'pdf_merge' }] },
    agents: { get: () => undefined, roots: () => [], list: () => [] },
  }
  const ctx = {
    get: (name) => services[name],
    inject: () => {},
    effect: () => {},
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
  }
  apply(ctx, { debug: false })
  const pre = handlers.get('agent/pre-step')[0]

  const out = await pre(
    {
      agent: { id: 'shape', session: { header: { cwd: '/tmp' } } },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '读一下这个 PDF' }] }],
      step: 1,
    },
    async () => ({ kind: 'enter' }), // 故意不带 messages
  )

  assert.equal(out.kind, 'enter')
  assert.ok(Array.isArray(out.messages), 'messages 必须是数组')
  assert.ok(out.messages.length > 0, '这一轮必须有注入，而不是被静默丢掉')
})

test('同一次工具调用只记一遍（多实例并存时不重复记账）', async () => {
  clearUsage()
  const channels = []
  const makeCtx = () => {
    const handlers = new Map()
    const ctx = {
      get: () => undefined,
      inject: () => {},
      effect: () => {},
      on: (event, handler) => {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(handler)
      },
    }
    ctx.handlers = handlers
    channels.push(ctx)
    return ctx
  }
  // 重载时常见的形态：旧实例还在，新实例已经挂上
  apply(makeCtx(), { debug: false })
  apply(makeCtx(), { debug: false })

  const exec = { agent: { id: 'dup-session' }, name: 'read_file', arguments: {} }
  for (const ctx of channels) {
    const record = ctx.handlers.get('tools/execute')[0]
    await record(exec, async () => 'ok')
  }
  assert.deepEqual(usageOf('dup-session').tools.map((row) => [row.name, row.count]), [['read_file', 1]])

  // 另一次真实调用必须照常累加
  const again = { agent: { id: 'dup-session' }, name: 'read_file', arguments: {} }
  await channels[0].handlers.get('tools/execute')[0](again, async () => 'ok')
  assert.deepEqual(usageOf('dup-session').tools.map((row) => [row.name, row.count]), [['read_file', 2]])
  clearUsage()
})

test('两个实例并存时，同一轮不会重复注入', async () => {
  const channels = []
  const services = {
    skills: {
      snapshot: async () => ({
        skills: [{ name: 'pdf-tools', description: 'pdf 工具', invocation: { modelInvocable: true } }],
      }),
      get: async () => undefined,
    },
    tools: { definitions: () => [{ name: 'pdf_extract' }, { name: 'pdf_merge' }] },
    agents: { get: () => undefined, roots: () => [], list: () => [] },
  }
  const makeCtx = () => {
    const handlers = new Map()
    const ctx = {
      get: (name) => services[name],
      inject: () => {},
      effect: () => {},
      on: (event, handler) => {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(handler)
      },
    }
    ctx.handlers = handlers
    channels.push(ctx)
    return ctx
  }
  apply(makeCtx(), { debug: false })
  apply(makeCtx(), { debug: false })

  const payload = {
    agent: { id: 'both', session: { header: { cwd: '/tmp' } } },
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '读一下这个 PDF' }] }],
    step: 1,
  }
  let injected = 0
  for (const ctx of channels) {
    const decision = await ctx.handlers.get('agent/pre-step')[0](payload, async () => ({ kind: 'enter', messages: [] }))
    injected += decision.messages.length
  }
  // 第一个实例发内容，第二个实例因为去重键已存在而不再发同样的东西
  assert.ok(injected > 0, '至少有一个实例要注入')
  assert.ok(injected < 4, `不该两边各发一遍（实际 ${injected} 条）`)
})

test('技能服务挂住时，回合不被拖死（这一轮降级、照常继续）', async () => {
  const handlers = new Map()
  const services = {
    // 永远不 resolve —— 模拟服务卡死
    skills: { snapshot: () => new Promise(() => {}), get: () => new Promise(() => {}) },
    tools: { definitions: () => [{ name: 'pdf_extract' }, { name: 'pdf_merge' }] },
    agents: { get: () => undefined, roots: () => [], list: () => [] },
  }
  const ctx = {
    get: (name) => services[name],
    inject: () => {},
    effect: () => {},
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
  }
  apply(ctx, { debug: false })
  const pre = handlers.get('agent/pre-step')[0]

  const started = Date.now()
  const decision = await pre(
    {
      agent: { id: 'hung', session: { header: { cwd: '/tmp' } } },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '读一下这个 PDF' }] }],
      step: 1,
    },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const elapsed = Date.now() - started

  assert.equal(decision.kind, 'enter', '必须把这一步还回去，不能卡死')
  assert.ok(elapsed < 3000, `应在超时后返回（实际 ${elapsed}ms）`)
})

test('钉住的技能：注入了才算「已注入」，取不到记为「未找到」', async () => {
  clearUsage()
  const handlers = new Map()
  const services = {
    skills: {
      snapshot: async () => ({ skills: [] }),
      get: async (name) => (name === 'real-skill' ? { name, content: '正文', provider: 'filesystem' } : undefined),
    },
    tools: { definitions: () => [] },
    agents: { get: () => undefined, roots: () => [], list: () => [] },
  }
  const ctx = {
    get: (name) => services[name],
    inject: () => {},
    effect: () => {},
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
  }
  apply(ctx, { debug: false })
  const pre = handlers.get('agent/pre-step')[0]

  setPinned('pin-session', { skills: ['real-skill', 'ghost-skill'] })
  const out = await pre(
    {
      agent: { id: 'pin-session', session: { header: { cwd: '/tmp' } } },
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '随便问一句' }] }],
      step: 1,
    },
    async () => ({ kind: 'enter', messages: [] }),
  )

  const usage = usageOf('pin-session')
  const byName = Object.fromEntries(usage.skills.map((row) => [row.name, row.via]))
  assert.equal(byName['real-skill'], 'injected', '取到的技能应记为已注入')
  assert.equal(byName['ghost-skill'], 'missing', '取不到的技能必须留痕，不能让用户以为勾对了')
  assert.ok(out.messages.some((message) => JSON.stringify(message).includes('正文')), '真正的技能正文要进上下文')
  // 队列被消费掉：不会每轮重复加载
  assert.deepEqual(peekPinned('pin-session').skills, [])
})

test('模型自己加载过的技能，不会被后来的注入降级', () => {
  clearUsage()
  noteToolCall('rank', 'skill', { name: 'shared' })
  noteSkillInjection('rank', ['shared'])
  assert.equal(usageOf('rank').skills[0].via, 'tool')
})
