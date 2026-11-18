import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SOURCE_KIND } from '../lib/plugin.js'

/**
 * 用**框架自己的**校验器验一遍注入消息的来源形状。
 *
 * 这一条是从真实事故里长出来的：最初照抄上游写成
 * `{ kind: 'plugin', plugin: name }`，那是 V3 的旧写法，
 * V4 写入会话时直接抛
 * `format v4 message requires a producer-owned source kind`。
 *
 * 校验器在 dsh 安装目录里，属于内部包：装得上就测，装不上就跳过，
 * 不让这个测试成为别人 clone 之后的阻碍。
 */
const MODULE = '@deepseek-ai/dsh-session-format-v3-to-v4'

let admission
try {
  const module = await import(MODULE)
  admission = module.assertV4RowAdmission
} catch {
  admission = undefined
}

const row = (kind) => ({
  type: 'user/message',
  seq: 1,
  data: {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind, form: 'instructions' },
  },
})

test('注入消息的 source 能通过 V4 的行准入校验', { skip: admission === undefined ? `${MODULE} 不可用` : false }, () => {
  assert.doesNotThrow(() => admission(row(SOURCE_KIND)))
})

test('对照：退役的 "plugin" 写法必须被拒绝', { skip: admission === undefined ? `${MODULE} 不可用` : false }, () => {
  assert.throws(() => admission(row('plugin')), /producer-owned source kind/)
})
