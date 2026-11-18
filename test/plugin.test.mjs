import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, SHARED_STATE_KEY, SOURCE_KIND } from '../lib/plugin.js'
import { clearPins, setPinned } from '../lib/panel.js'

/** 造一个最小的假 ctx：只实现 apply() 用到的那几个面。 */
function makeCtx({ skills, tools } = {}) {
  const listeners = new Map()
  return {
    listeners,
    get(service) {
      if (service === 'skills') return skills
      if (service === 'tools') return tools
      return undefined
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
  }
}

const skills = {
  async snapshot() {
    return {
      complete: true,
      skills: [
        {
          name: 'pdf-tools',
          description: '合并、拆分 PDF 文件',
          invocation: { modelInvocable: true, userInvocable: true },
        },
        {
          name: 'deploy-vercel',
          description: 'Deploy an application to Vercel',
          invocation: { modelInvocable: true, userInvocable: true },
        },
      ],
    }
  },
}

const userMessage = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** 跑一次 pre-step，返回下一个流转的 decision。 */
async function once(listener, { agent, messages, step = 1 }) {
  const controller = new AbortController()
  return listener(
    { agent, messages, turn: 1, step, signal: controller.signal, modelSelection: {} },
    async () => ({ kind: 'enter', messages }),
  )
}

test('插件导出 name 与 apply', () => {
  assert.equal(name, 'dsh-smart-router')
  assert.equal(typeof apply, 'function')
})

test('step 1 且任务与技能重合时，追加一条候选消息', async () => {
  const ctx = makeCtx({ skills })
  apply(ctx, { enabled: true })
  const listener = ctx.listeners.get('agent/pre-step')
  assert.equal(typeof listener, 'function', '必须挂上 agent/pre-step')

  const agent = { id: 's1', session: { header: { cwd: '/tmp' } } }
  const decision = await once(listener, { agent, messages: [userMessage('帮我把两个 PDF 合并成一个文件')] })

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, '原消息 + 一条注入')
  const injected = decision.messages[1]
  assert.equal(injected.source.kind, 'smart-router')
  const text = injected.content[0].text
  assert.ok(text.includes('pdf-tools'))
  assert.ok(text.includes('skill 工具'))
})

test('注入消息的 source.kind 不能是 V3 的 "plugin"（V4 会拒绝）', async () => {
  // 回归测试：曾经照抄上游写成 { kind: 'plugin', plugin: name }，
  // V4 会话写入时报 "format v4 message requires a producer-owned source kind"。
  const ctx = makeCtx({ skills })
  apply(ctx, { enabled: true })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's-kind', session: { header: { cwd: '/tmp' } } }
  const decision = await once(listener, { agent, messages: [userMessage('合并 PDF')] })

  const injected = decision.messages.slice(1)
  assert.ok(injected.length > 0, '这一轮应当有注入')
  for (const message of injected) {
    const kind = message.source?.kind
    assert.equal(typeof kind, 'string')
    assert.ok(kind.length > 0, 'kind 不能为空')
    assert.notEqual(kind, 'plugin', 'plugin 是已退役的 V3 写法')
    assert.equal(kind, SOURCE_KIND)
  }
})

test('不匹配时不注入 —— 宁可不给，也不要让模型硬套', async () => {
  const ctx = makeCtx({ skills })
  apply(ctx, { enabled: true })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's2', session: { header: { cwd: '/tmp' } } }
  const decision = await once(listener, { agent, messages: [userMessage('今天天气怎么样')] })
  assert.equal(decision.messages.length, 1, '没有候选就不该有任何追加')
})

test('step 2 及以后不再重复推候选', async () => {
  const ctx = makeCtx({ skills })
  apply(ctx, { enabled: true })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's3', session: { header: { cwd: '/tmp' } } }
  const decision = await once(listener, { agent, messages: [userMessage('合并 PDF')], step: 2 })
  assert.equal(decision.messages.length, 1)
})

test('同一组候选在一个会话里只推一次', async () => {
  const ctx = makeCtx({ skills })
  apply(ctx, { enabled: true })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's4', session: { header: { cwd: '/tmp' } } }

  const first = await once(listener, { agent, messages: [userMessage('合并 PDF')] })
  assert.equal(first.messages.length, 2)
  const second = await once(listener, { agent, messages: [userMessage('合并 PDF')] })
  assert.equal(second.messages.length, 1, '去重键没变就不该重复注入')
})

test('换一个任务时，候选会重新推一次', async () => {
  const ctx = makeCtx({ skills })
  apply(ctx, { enabled: true })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's5', session: { header: { cwd: '/tmp' } } }

  await once(listener, { agent, messages: [userMessage('合并 PDF')] })
  const decision = await once(listener, { agent, messages: [userMessage('deploy to vercel')] })
  assert.equal(decision.messages.length, 2)
  assert.ok(decision.messages[1].content[0].text.includes('deploy-vercel'))
})

test('关闭开关后什么都不注册', () => {
  const ctx = makeCtx({ skills })
  apply(ctx, { enabled: false })
  assert.equal(ctx.listeners.size, 0)
})

test('技能服务缺失时不抛错，也不阻断这一轮', async () => {
  const ctx = makeCtx({})
  apply(ctx, { enabled: true })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's6' }
  const decision = await once(listener, { agent, messages: [userMessage('合并 PDF')] })
  assert.equal(decision.kind, 'enter')
})

test('技能快照抛错时降级为「这一轮没有提示」', async () => {
  const broken = { async snapshot() { throw new Error('boom') } }
  const ctx = makeCtx({ skills: broken })
  apply(ctx, { enabled: true })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's7' }
  const decision = await once(listener, { agent, messages: [userMessage('合并 PDF')] })
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
})

test('任务命中工具族时，即使没有技能候选也会给一条能力提示', async () => {
  const fakeTools = {
    definitions() {
      return [
        { name: 'android_click', description: '真实触控点击实体主屏' },
        { name: 'android_swipe', description: '真实触控滑动实体主屏' },
        { name: 'schedule_create', description: '创建定时任务' },
      ]
    },
  }
  const ctx = makeCtx({ skills, tools: fakeTools })
  apply(ctx, { enabled: true, includePlugins: false })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's8', session: { header: { cwd: '/tmp' } } }
  const decision = await once(listener, { agent, messages: [userMessage('在手机屏幕上点击那个按钮')] })
  // 静态块（工具族概览）+ 回合块（本轮可能用到的族），各一条。
  assert.equal(decision.messages.length, 3)
  const texts = decision.messages.slice(1).map((m) => m.content[0].text)
  const turn = texts[texts.length - 1]
  assert.ok(turn.includes('本轮可能用得上'), '最后一条应当是回合块')
  assert.ok(turn.includes('android'), '应当把 android 族排到前面')
})

test('同一进程里 apply() 被调多次时，不会重复注入同一份内容', async () => {
  // 实测触发过：换入口文件那一次，loader 在一个进程里把 apply() 调了十遍。
  // 去重状态若跟着实例走，十个实例就各注入一遍。
  delete globalThis[SHARED_STATE_KEY]

  const ctxA = makeCtx({ skills })
  const ctxB = makeCtx({ skills })
  apply(ctxA, { enabled: true })
  apply(ctxB, { enabled: true })

  const agent = { id: 's-shared', session: { header: { cwd: '/tmp' } } }
  const first = await once(ctxA.listeners.get('agent/pre-step'), { agent, messages: [userMessage('合并 PDF')] })
  assert.ok(first.messages.length > 1, '第一个实例负责注入')

  const second = await once(ctxB.listeners.get('agent/pre-step'), { agent, messages: [userMessage('合并 PDF')] })
  assert.equal(second.messages.length, 1, '第二个实例看到去重键已存在，不该再注入')
})

test('中途新增工具（装了新插件）后，静态块会补发一条更新', async () => {
  delete globalThis[SHARED_STATE_KEY]
  const toolList = [
    { name: 'android_click', description: '真实触控点击实体主屏' },
    { name: 'android_swipe', description: '真实触控滑动实体主屏' },
  ]
  const fakeTools = { definitions: () => toolList }
  const ctx = makeCtx({ skills, tools: fakeTools })
  // staticTtlMs: 0 表示每轮都复核，测试里不用等时间。
  apply(ctx, { enabled: true, includePlugins: false, staticTtlMs: 0 })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's-refresh', session: { header: { cwd: '/tmp' } } }

  const first = await once(listener, { agent, messages: [userMessage('随便聊聊')] })
  assert.equal(first.messages.length, 2, '第一轮应当有静态块')

  // 模拟「中途装了新插件」：工具表变了。
  toolList.push({ name: 'schedule_create', description: '创建定时任务' })
  toolList.push({ name: 'schedule_list', description: '列出定时任务' })

  const second = await once(listener, { agent, messages: [userMessage('随便聊聊')] })
  assert.equal(second.messages.length, 2, '内容变了应当补发')
  assert.ok(second.messages[1].content[0].text.includes('schedule'), '新工具族要出现在更新里')
})

test('面板勾选的技能，在下一轮开头被真正加载（一次性）', async () => {
  delete globalThis[SHARED_STATE_KEY]
  clearPins()
  const registry = {
    async snapshot() {
      return { complete: true, skills: [{ name: 'pdf-tools', description: '合并、拆分 PDF 文件', invocation: { modelInvocable: true, userInvocable: true } }] }
    },
    async get(name) {
      if (name !== 'pdf-tools') return undefined
      return { name: 'pdf-tools', provider: 'fs', content: '用 pypdf 合并。', invocation: { modelInvocable: true, userInvocable: true } }
    },
  }
  const ctx = makeCtx({ skills: registry })
  apply(ctx, { enabled: true, includePlugins: false })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's-pin', session: { header: { cwd: '/tmp' } } }

  setPinned('s-pin', ['pdf-tools'])
  const first = await once(listener, { agent, messages: [userMessage('随便聊聊')] })
  const pinnedMessage = first.messages.find((m) => m.source?.kind === 'skill-invocation')
  assert.ok(pinnedMessage, '钉住的技能必须被加载')
  assert.equal(pinnedMessage.source.name, 'pdf-tools')
  assert.ok(pinnedMessage.content[0].text.includes('pypdf'), '正文要真的进来')

  // 第二轮不该再塞一次
  const second = await once(listener, { agent, messages: [userMessage('随便聊聊')] })
  assert.equal(second.messages.filter((m) => m.source?.kind === 'skill-invocation').length, 0)
})

test('钉住一个不存在的技能不会炸，也不会阻断这一轮', async () => {
  delete globalThis[SHARED_STATE_KEY]
  clearPins()
  const ctx = makeCtx({ skills })
  apply(ctx, { enabled: true, includePlugins: false })
  const listener = ctx.listeners.get('agent/pre-step')
  const agent = { id: 's-pin2', session: { header: { cwd: '/tmp' } } }
  setPinned('s-pin2', ['ghost-skill'])
  const decision = await once(listener, { agent, messages: [userMessage('随便聊聊')] })
  assert.equal(decision.kind, 'enter')
})
