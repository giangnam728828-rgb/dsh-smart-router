import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name } from '../lib/index.js'

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
  assert.equal(injected.source.kind, 'plugin')
  assert.equal(injected.source.plugin, 'dsh-smart-router')
  const text = injected.content[0].text
  assert.ok(text.includes('pdf-tools'))
  assert.ok(text.includes('skill 工具'))
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
