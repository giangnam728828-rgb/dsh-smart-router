/**
 * lib/plugins.js — 读取「这台机器上装了哪些插件、它们各自是干什么的」。
 *
 * 为什么需要这一层：技能目录里只有技能。插件提供的面板、设置项、市场、
 * 页面建议这类能力，**不会出现在任何给模型看的清单里** ——
 * 模型的工具表里只有工具名 + 一句参数说明，看不出「哪个插件负责哪件事」。
 *
 * 所以这里直接读 profile 的依赖清单和每个包的 locale 元数据，
 * 拼出一份「插件 -> 一句话用途」的目录。只读，不加载，不改任何状态。
 *
 * 全部包在 try/catch 里：读不到就当作没有插件目录，绝不影响主流程。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 一眼就知道是宿主内部实现的包，列出来对模型没有信息量，跳过。 */
const INTERNAL_SCOPE = '@deepseek-ai/'

/**
 * 解析当前 profile 的目录。
 *
 * 注意：宿主进程里**只有 `DSH_HOME`，没有 `DSH_PROFILE_DIR`**（实测过）。
 * 早先只认后者，于是插件列表永远是空数组 —— 面板上「插件」页签一片空白。
 * 这里按 DSH_PROFILE_DIR → DSH_PROFILE → profiles 下唯一子目录 的顺序兜底。
 *
 * @param {string} [explicit]
 * @returns {string | undefined}
 */
export function resolveProfileDir(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv

  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home.length === 0) return undefined
  const profilesDir = join(home, 'profiles')

  // 宿主启动时会把自己正在用哪个 profile 写进 DSHA_STARTUP_PROFILE，这是**最权威**
  // 的信号，优先于下面的猜测。
  //
  // 为什么不能只靠「profiles 下恰好一个目录」兜底：profiles 下会多出别的 profile
  // （比如跑无头任务时建的 headless）。一旦变成两个，那条兜底就返回 undefined，
  // 插件清单恒为空 —— 面板「插件」页签直接显示 0。实测过：headless 一出现，
  // 13 个插件就全没了。
  const startup = process.env.DSHA_STARTUP_PROFILE
  if (typeof startup === 'string' && startup.length > 0) {
    const candidate = join(profilesDir, startup)
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // 声明了但目录不存在 —— 继续往下找
    }
  }

  const named = process.env.DSH_PROFILE
  if (typeof named === 'string' && named.length > 0) {
    const candidate = join(profilesDir, named)
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // 同上
    }
  }

  try {
    const entries = readdirSync(profilesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    return entries.length === 1 ? join(profilesDir, entries[0].name) : undefined
  } catch {
    return undefined
  }
}

/** 读一个 JSON，失败返回 undefined。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 找一个包的一句话用途。优先 locale 里的 meta.title/description（人写给用户看的），
 * 退回到 package.json 的 description。两种都没有就返回 undefined。
 *
 * @param {string} dir - 包的实际目录
 * @param {string} fallback - package.json 的 description
 */
function describePackage(dir, fallback) {
  for (const file of ['zh.json', 'zh-CN.json', 'en.json']) {
    const locale = readJson(join(dir, 'locale', file))
    const meta = locale?.meta
    if (meta === undefined || meta === null) continue
    const title = typeof meta.title === 'string' ? meta.title.trim() : ''
    const description = typeof meta.description === 'string' ? meta.description.trim() : ''
    if (title.length > 0 || description.length > 0) {
      return { title: title.length > 0 ? title : undefined, description: description.length > 0 ? description : undefined }
    }
  }
  return { description: typeof fallback === 'string' && fallback.trim().length > 0 ? fallback.trim() : undefined }
}

/**
 * 列出 profile 里装的第三方插件。
 *
 * 只返回「有名字、有用途、不是宿主内部包」的条目，按名字排序后截断。
 * 目录不存在、没有 node_modules、包坏了，都只是少几条，不抛错。
 *
 * @param {{ profileDir?: string, limit?: number, exclude?: readonly string[] }} [options]
 * @returns {Array<{ name: string, title?: string, description?: string }>}
 */
export function listInstalledPlugins(options = {}) {
  const limit = Math.max(0, options.limit ?? 8)
  if (limit === 0) return []

  const profileDir = resolveProfileDir(options.profileDir)
  if (profileDir === undefined) return []

  const manifest = readJson(join(profileDir, 'package.json'))
  const dependencies = manifest?.dependencies
  if (dependencies === undefined || dependencies === null || typeof dependencies !== 'object') return []

  const exclude = new Set(options.exclude ?? [])
  const modulesDir = join(profileDir, 'node_modules')
  const found = []

  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') continue
    // INTERNAL_SCOPE 是前缀字符串，不是正则：早先写成 .test(name) 会直接抛错，
    // 被上层的兜底吞成「空列表」，于是插件页签永远是空的。
    if (name.startsWith(INTERNAL_SCOPE) || exclude.has(name)) continue

    let dir
    try {
      dir = realpathSync(join(modulesDir, name))
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue // 链接断了 / 没装 —— 不猜
    }

    const pkg = readJson(join(dir, 'package.json'))
    if (pkg === undefined || pkg === null) continue

    // 只收「给 DSH 用的包」：有 dsh 字段（bundle/client/engines 皆可）才算。
    if (pkg.dsh === undefined || pkg.dsh === null) continue

    const described = describePackage(dir, pkg.description)
    if (described.description === undefined && described.title === undefined) continue

    found.push({ name, ...described })
  }

  found.sort((a, b) => a.name.localeCompare(b.name))
  return found.slice(0, limit)
}

/**
 * 有没有任何插件带浏览器端（Web UI 面板）。用来给模型一句提示：
 * 「这些插件的能力在界面里，不是工具」。
 *
 * @param {string} [profileDir]
 * @returns {boolean}
 */
export function hasAnyClientHalf(explicit) {
  const profileDir = resolveProfileDir(explicit)
  if (profileDir === undefined) return false
  try {
    const manifest = readJson(join(profileDir, 'package.json'))
    const dependencies = manifest?.dependencies ?? {}
    for (const name of Object.keys(dependencies)) {
      const dir = join(profileDir, 'node_modules', name)
      if (!existsSync(dir)) continue
      const pkg = readJson(join(realpathSync(dir), 'package.json'))
      if (pkg?.dsh?.client !== undefined) return true
    }
  } catch {
    // 读不到就是 false —— 这句提示只是锦上添花
  }
  return false
}

/** 导出的包名列表（给测试用；运行时只用上面两个函数）。 */
export function dependencyNames(profileDir) {
  const manifest = readJson(join(profileDir, 'package.json'))
  return Object.keys(manifest?.dependencies ?? {}).sort()
}

/** 读目录里的文件数，只在诊断时用。 */
export function countFiles(dir) {
  try {
    return readdirSync(dir).length
  } catch {
    return 0
  }
}
