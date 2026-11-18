/**
 * lib/panel.js — 聊天界面面板的宿主半区。
 *
 * 面板做三件事：列技能、列插件、列能力族；勾中的在下一轮真正生效。
 *
 * ── 一条踩过的坑 ──────────────────────────────────────────────────────
 * 第一版拿「客户端传来的 sessionId」去 `agents.get()` 查 agent，查不到就 404。
 * 结果面板整块报「没保存成功」——因为 id 对不上。这里改成：
 *   1. 查不到就直接用一个安全兜底（进程里只有一个活跃 agent 时就用它）；
 *   2. 钉住项永远记在**解析出来的 agent 的 id** 上，而不是客户端传来的那个字符串，
 *      这样下一轮 pre-step 按 `agent.id` 取的时候必然能取到；
 *   3. 只有空 id 才报 400。别的一律尽力服务。
 */

/** 面板与浏览器之间的接口路径。 */
export const ROUTE = '/api/dsh-smart-router'

/** 一次最多钉几个。防手滑全选把上下文撑爆。 */
export const MAX_PINS = 12

/** sessionId -> { skills: Set, families: Set, plugins: Set } */
const pins = new Map()

function emptyPins() {
  return { skills: [], families: [], plugins: [] }
}

/** 读出当前钉住项（不消费）。 */
export function peekPinned(sessionId) {
  const entry = pins.get(sessionId)
  if (entry === undefined) return emptyPins()
  return { skills: [...entry.skills], families: [...entry.families], plugins: [...entry.plugins] }
}

/** 取走并清空。 */
export function takePinned(sessionId) {
  const entry = pins.get(sessionId)
  pins.delete(sessionId)
  if (entry === undefined) return emptyPins()
  return { skills: [...entry.skills], families: [...entry.families], plugins: [...entry.plugins] }
}

/**
 * 设置钉住项。三类分开存：技能要加载正文，能力族要列出工具，插件只作为提示。
 *
 * @param {string} sessionId
 * @param {{ skills?: readonly string[], families?: readonly string[], plugins?: readonly string[] }} value
 */
export function setPinned(sessionId, value) {
  const clean = (list) => [...new Set(list ?? [])].slice(0, MAX_PINS)
  const skills = clean(value?.skills)
  const families = clean(value?.families)
  const plugins = clean(value?.plugins)
  if (skills.length === 0 && families.length === 0 && plugins.length === 0) pins.delete(sessionId)
  else pins.set(sessionId, { skills: new Set(skills), families: new Set(families), plugins: new Set(plugins) })
  return { skills, families, plugins }
}

/** 清空全部（测试与停用时用）。 */
export function clearPins() {
  pins.clear()
}

function respond(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

const BODY_LIMIT = 8192

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > BODY_LIMIT) throw Object.assign(new Error('body too large'), { code: 'payload-too-large' })
  }
  return body
}

/**
 * 造一个路由处理函数。依赖全部以回调注入，这个文件不碰任何 DSH 服务，能直接测。
 *
 * @param {{ connection: { requestRejection(req: any): number | undefined },
 *           resolveAgent?: (sessionId: string) => { id: string } | undefined,
 *           listSkills: (sessionId: string) => Promise<Array<{ name: string, description?: string, descriptionZh?: string }>>,
 *           listFamilies?: (sessionId: string) => Array<{ name: string, count: number, sample: string }>,
 *           listPlugins?: () => Array<{ name: string, title?: string, description?: string }>,
 *           readUsage?: (sessionId: string) => { input?: number, output?: number, total?: number, pressure?: number, window?: number },
 *           readUsed?: (sessionId: string) => { skills: string[], tools: Array<{ name: string, count: number }> },
 *           sessionExists?: (sessionId: string) => boolean }} options
 */
export function createPanelHandler(options) {
  const { connection, resolveAgent, listSkills, listFamilies, listPlugins, readUsage, readUsed, sessionExists } = options

  /** 每个数据源各自兜底：一块取不到不影响其他块。 */
  const attempt = async (fn, fallback) => {
    try {
      return await fn()
    } catch {
      return fallback
    }
  }

  const snapshotOf = async (sessionId) => {
    // ⚠️ 这里每一个都必须 await。`attempt` 是 async 的，少一个 await 就会把
    // Promise 塞进响应，JSON.stringify 把它变成 `{}`，客户端归一化后就是空数组 ——
    // 表现正是「技能能显示，插件和能力永远是空的」。这一条有回归测试守着。
    const skills = await attempt(() => listSkills(sessionId), [])
    const families = listFamilies === undefined ? [] : await attempt(() => listFamilies(sessionId), [])
    const plugins = listPlugins === undefined ? [] : await attempt(() => listPlugins(), [])
    const usage = readUsage === undefined ? {} : await attempt(() => readUsage(sessionId), {})
    const used = readUsed === undefined
      ? { skills: [], tools: [] }
      : await attempt(() => readUsed(sessionId), { skills: [], tools: [] })

    return {
      ok: true,
      session: sessionId,
      pinned: peekPinned(sessionId),
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.descriptionZh ?? skill.description ?? '',
        translated: skill.descriptionZh !== undefined,
      })),
      families,
      plugins,
      usage,
      used,
    }
  }

  return async (req, res) => {
    try {
      const rejection = connection?.requestRejection?.(req)
      if (rejection !== undefined) return respond(res, rejection, { ok: false, error: 'access-denied' })

      const url = new URL(req.url ?? ROUTE, 'http://localhost')
      const requested = url.searchParams.get('sessionId') ?? ''

      // 客户端传来的 id 可能和 agent.id 对不上：能解析就用 agent 的 id，
      // 解析不了就用它传来的那个字符串 —— 但绝不因此拒绝服务。
      const keyOf = (id) => {
        const agent = resolveAgent?.(id)
        return agent === undefined ? id : String(agent.id)
      }

      if (req.method === 'GET') {
        if (requested === '') return respond(res, 400, { ok: false, error: 'missing-session' })
        if (sessionExists !== undefined && !sessionExists(requested) && resolveAgent?.(requested) === undefined) {
          // 宽松处理：仍然返回全局可见的部分，而不是整块 404
          return respond(res, 200, await snapshotOf(requested))
        }
        return respond(res, 200, await snapshotOf(keyOf(requested)))
      }

      if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })

      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch (error) {
        if (error?.code === 'payload-too-large') return respond(res, 413, { ok: false, error: 'payload-too-large' })
        return respond(res, 400, { ok: false, error: 'invalid-body' })
      }

      const target = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (target === '') return respond(res, 400, { ok: false, error: 'missing-session' })

      const key = keyOf(target)
      const clean = (list) => (Array.isArray(list) ? list.filter((name) => typeof name === 'string') : [])
      setPinned(key, {
        skills: clean(payload?.skills),
        families: clean(payload?.families),
        plugins: clean(payload?.plugins),
      })
      return respond(res, 200, await snapshotOf(key))
    } catch {
      try {
        respond(res, 500, { ok: false, error: 'internal' })
      } catch {
        // 响应头可能已经发出 —— 再抛只会把宿主日志弄脏
      }
    }
  }
}
