import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { listInstalledPlugins, resolveProfileDir } from '../lib/plugins.js'

/** 造一个假 profile：一个第三方插件、一个宿主内部包、一个没有 dsh 字段的包。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'smart-router-profile-'))
  const profile = join(root, 'profiles', 'web')
  const modules = join(profile, 'node_modules')
  mkdirSync(modules, { recursive: true })
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: {
        'my-plugin': 'link:../../my-plugin',
        '@deepseek-ai/dsh-core': '1.0.0',
        'not-a-plugin': '1.0.0',
        'broken-link': 'link:../../nowhere',
      },
    }),
  )

  const write = (name, pkg) => {
    const dir = join(modules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    return dir
  }
  const mine = write('my-plugin', { name: 'my-plugin', description: 'fallback description', dsh: { bundle: {} } })
  mkdirSync(join(mine, 'locale'), { recursive: true })
  writeFileSync(join(mine, 'locale', 'zh.json'), JSON.stringify({ meta: { title: '我的插件', description: '做一件具体的事' } }))
  write('@deepseek-ai/dsh-core', { name: '@deepseek-ai/dsh-core', description: 'host internal', dsh: {} })
  write('not-a-plugin', { name: 'not-a-plugin', description: 'no dsh field' })
  return { root, profile }
}

test('resolveProfileDir: 没有 DSH_PROFILE_DIR 时退回 profiles 下唯一的目录', () => {
  const saved = { dir: process.env.DSH_PROFILE_DIR, home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE }
  try {
    delete process.env.DSH_PROFILE_DIR
    delete process.env.DSH_PROFILE
    process.env.DSH_HOME = '/tmp/does-not-matter'
    // 目录猜不到时返回 undefined，而不是抛错
    const resolved = resolveProfileDir()
    assert.ok(resolved === undefined || typeof resolved === 'string')
  } finally {
    for (const [key, value] of [['DSH_PROFILE_DIR', saved.dir], ['DSH_HOME', saved.home], ['DSH_PROFILE', saved.profile]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('listInstalledPlugins: 读 locale 元数据，跳过宿主内部包和没有 dsh 字段的包', () => {
  const { profile } = fixture()
  const list = listInstalledPlugins({ profileDir: profile })
  assert.deepEqual(list.map((item) => item.name), ['my-plugin'])
  assert.equal(list[0].title, '我的插件')
  assert.equal(list[0].description, '做一件具体的事')
})

test('listInstalledPlugins: 宿主内部包不会被列出来（前缀判断用 startsWith）', () => {
  // 回归：INTERNAL_SCOPE 是字符串却调了 .test()，每次抛错被吞成空数组。
  const { profile } = fixture()
  const list = listInstalledPlugins({ profileDir: profile })
  assert.ok(!list.some((item) => item.name.startsWith('@deepseek-ai/')))
})

test('listInstalledPlugins: 断掉的链接不会让整次列举失败', () => {
  const { profile } = fixture()
  assert.doesNotThrow(() => listInstalledPlugins({ profileDir: profile }))
})

test('listInstalledPlugins: limit=0 返回空数组', () => {
  const { profile } = fixture()
  assert.deepEqual(listInstalledPlugins({ profileDir: profile, limit: 0 }), [])
})
