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

/**
 * 钉住项按会话存，最多留这么多个会话。
 *
 * 不设上限就是内存泄漏：每个用过的会话留一个小对象，跑到几十个会话
 * 之后一直不释放。满了按插入顺序淘汰最旧的（Map 保序，够用）。
 */
export const MAX_PIN_SESSIONS = 64

/** sessionId -> { skills: Set, families: Set, plugins: Set } */
const pins = new Map()

/**
 * 路由归属表。
 *
 * ── 为什么需要它（实测过的事故）────────────────────────────────────────
 * host 的 `webServer.register` 对同一个 (kind, path) **重复注册直接抛错**：
 *   `webserver: duplicate exact route "/api/dsh-smart-router"`
 * 而本插件在一个进程里被 `apply()` 多次是常态（loader 重建 bundle 会重入）。
 * 旧实例还没销毁、新实例先注册，就会撞上这条例外；更糟的是**旧实例后销毁时
 * 会把新实例正在用的路由一起删掉** —— 面板从此 404，只能重启宿主。
 *
 * 所以注册权收归进程一份：拿路由之前先撤销上一个持有者，撤销时也只由
 * 「当前持有者」执行删除。挂在 globalThis 上，跨模块实例共享。
 */
export const ROUTE_OWNER_KEY = Symbol.for('dsh-smart-router.route-owner')

function routeOwners() {
  let owners = globalThis[ROUTE_OWNER_KEY]
  if (owners === undefined) {
    owners = new Map()
    globalThis[ROUTE_OWNER_KEY] = owners
  }
  return owners
}

/**
 * 接管面板路由：先撤旧持有者，再注册自己，并返回只撤自己的释放函数。
 *
 * 两种撤销语义必须分开，否则会互相踩：
 *   - `revoke()`：接管时**强制**撤掉上一个持有者（它已经过时了）。
 *   - `release()`：作为 effect 的清理函数用，**只有自己还是当前持有者**才真正
 *     删除路由。否则旧实例被销毁时，会把新实例刚注册的路由一起拆掉 ——
 *     宿主的 disposer 是无条件 `table.delete(path)`，撤销别人就是删别人的。
 *
 * @param {{ register(route: { kind: string, path: string, handler: Function }): Function }} server
 * @param {Function} handler
 * @returns {() => void}
 */
export function claimRoute(server, handler) {
  const owners = routeOwners()
  const previous = owners.get(ROUTE)
  if (previous !== undefined) {
    owners.delete(ROUTE)
    previous.revoke()
  }

  const dispose = server.register({ kind: 'exact', path: ROUTE, handler })
  let released = false

  const entry = {
    /** 无条件撤销自己（接管流程用）。 */
    revoke() {
      if (released) return
      released = true
      try {
        dispose()
      } catch {
        // 服务已经在收尾 —— 不是错误
      }
    },
    /** 按归属撤销（effect 清理用）。 */
    release() {
      if (released) return
      // 已经不是当前持有者了：这条路由不归我管，删了就是删别人的。
      if (owners.get(ROUTE) !== entry) return
      released = true
      owners.delete(ROUTE)
      try {
        dispose()
      } catch {
        // 同上
      }
    },
  }

  owners.set(ROUTE, entry)
  return entry.release
}

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
  if (skills.length === 0 && families.length === 0 && plugins.length === 0) {
    pins.delete(sessionId)
    return { skills, families, plugins }
  }
  // 重新插入，让它成为「最新」的一个，淘汰时先掉最旧的。
  pins.delete(sessionId)
  pins.set(sessionId, { skills: new Set(skills), families: new Set(families), plugins: new Set(plugins) })
  while (pins.size > MAX_PIN_SESSIONS) {
    const oldest = pins.keys().next().value
    if (oldest === undefined) break
    pins.delete(oldest)
  }
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
    const rawPlugins = listPlugins === undefined ? [] : await attempt(() => listPlugins(), [])
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
      plugins: rawPlugins.map((plugin) => ({
        name: plugin.name,
        title: plugin.title,
        description: plugin.descriptionZh ?? plugin.description ?? '',
        // 和技能一样带上「已翻/未翻」：客户端靠它决定要不要补刷一次。
        translated: plugin.descriptionZh !== undefined,
      })),
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
