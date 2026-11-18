import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createTranslationStore } from '../lib/translate.js'

const fakeTranslator = (map = {}) => ({
  resolve: ({ text }) => ({ text, targetLanguage: 'zh-Hans', provider: 'google' }),
  translate: async (spec) => map[spec.text] ?? `译:${spec.text}`,
})

test('翻一次就缓存，第二次不再调用翻译器', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'smart-router-tr-')), 'tr.json')
  let calls = 0
  const translator = {
    resolve: ({ text }) => ({ text }),
    translate: async (spec) => {
      calls += 1
      return `译:${spec.text}`
    },
  }
  const store = createTranslationStore({ getTranslator: () => translator, file })
  await store.ensure([{ key: 'a', text: 'hello' }])
  assert.equal(store.get('a'), '译:hello')
  assert.equal(calls, 1)

  await store.ensure([{ key: 'a', text: 'hello' }])
  assert.equal(calls, 1, '已有缓存就不该再翻')
})

test('翻译结果写进磁盘，新实例直接读得到', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'smart-router-tr-')), 'tr.json')
  const first = createTranslationStore({ getTranslator: () => fakeTranslator(), file })
  await first.ensure([{ key: 'b', text: 'world' }])
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.b, '译:world')

  const second = createTranslationStore({ getTranslator: () => fakeTranslator(), file })
  assert.equal(second.get('b'), '译:world')
})

test('没有翻译服务时安静退化，不抛错也不写坏文件', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'smart-router-tr-')), 'tr.json')
  const store = createTranslationStore({ getTranslator: () => undefined, file })
  await store.ensure([{ key: 'c', text: 'text' }])
  assert.equal(store.get('c'), undefined)
})

test('翻译器抛错不影响其他条目', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'smart-router-tr-')), 'tr.json')
  const translator = {
    resolve: ({ text }) => ({ text }),
    translate: async (spec) => {
      if (spec.text === 'bad') throw new Error('provider down')
      return `译:${spec.text}`
    },
  }
  const store = createTranslationStore({ getTranslator: () => translator, file })
  await store.ensure([{ key: 'x', text: 'bad' }, { key: 'y', text: 'good' }])
  assert.equal(store.get('x'), undefined)
  assert.equal(store.get('y'), '译:good')
})

test('空文本不送去翻译', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'smart-router-tr-')), 'tr.json')
  let calls = 0
  const translator = { resolve: (r) => r, translate: async () => { calls += 1; return 'x' } }
  const store = createTranslationStore({ getTranslator: () => translator, file })
  await store.ensure([{ key: 'e', text: '   ' }])
  assert.equal(calls, 0)
})
