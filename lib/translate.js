/**
 * lib/translate.js — 把英文说明自动翻成中文，并缓存到磁盘。
 *
 * 为什么不用「词表」：技能和插件会一直增加，靠人肉补词表永远追不上。
 * DSH 本身带一个 translator 服务（google / bing 匿名路由，或 deepseek 付费路由），
 * 直接用它，翻译一次就落盘，之后每次打开面板读缓存，不再发请求。
 *
 * 三条硬约束：
 *   1. **绝不阻塞面板。** 单次请求最多等一小会儿（默认 2.5s），翻不完就让它们
 *      在后台继续，下次打开就是中文。
 *   2. **绝不因为翻译失败而少东西。** 翻不出来就原样显示英文。
 *   3. **不覆盖人写的翻译。** 用户在 skills.zh.json 里写的优先，缓存只是兜底。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 缓存文件位置：$DSH_HOME/smart-router/translations.zh.json */
export function defaultCacheFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'smart-router', 'translations.zh.json')
}

function load(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function save(file, map) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false // 落盘失败不影响这一轮显示
  }
}

/**
 * 造一个翻译缓存。
 *
 * @param {{ getTranslator: () => any, file?: string, target?: string,
 *           budgetMs?: number, concurrency?: number }} options
 */
export function createTranslationStore(options) {
  const { getTranslator, target = 'zh-Hans' } = options
  const file = options.file ?? defaultCacheFile()
  const budgetMs = options.budgetMs ?? 2500
  const concurrency = Math.max(1, options.concurrency ?? 4)

  const map = load(file)
  const inFlight = new Map()
  let dirty = false

  const get = (key) => (typeof map[key] === 'string' && map[key].length > 0 ? map[key] : undefined)

  async function translateOne(key, text) {
    const translator = getTranslator()
    if (translator === undefined || typeof translator.resolve !== 'function' || typeof translator.translate !== 'function') {
      return undefined
    }
    const spec = translator.resolve({ text, targetLanguage: target })
    const output = await translator.translate(spec)
    if (typeof output === 'string' && output.trim().length > 0) {
      map[key] = output.trim()
      dirty = true
      return map[key]
    }
    return undefined
  }

  /**
   * 确保这批条目有中文。用时受限：等不超过 budgetMs，剩下的在后台继续。
   *
   * @param {ReadonlyArray<{ key: string, text: string }>} items
   */
  async function ensure(items) {
    const missing = []
    for (const item of items) {
      if (get(item.key) !== undefined || inFlight.has(item.key)) continue
      if (typeof item.text !== 'string' || item.text.trim().length === 0) continue
      missing.push(item)
    }
    if (missing.length === 0) return

    const queue = missing.slice(0, 40)
    const run = async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (item === undefined) break
        const task = translateOne(item.key, item.text)
          .catch(() => undefined)
          .finally(() => inFlight.delete(item.key))
        inFlight.set(item.key, task)
        await task
      }
    }

    // 并发跑，但只等一小会儿
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => run())
    await Promise.race([
      Promise.allSettled(workers),
      new Promise((resolve) => setTimeout(resolve, budgetMs)),
    ])
    if (dirty) {
      dirty = false
      save(file, map)
    }
  }

  return { get, ensure, file }
}
