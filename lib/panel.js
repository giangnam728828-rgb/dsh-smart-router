/**
 * lib/panel.js — 聊天界面那块面板的宿主半区。
 *
 * 面板要做的事：列出技能、让用户勾选、勾中的技能在下一轮被真正加载。
 *
 * 为什么要走「钉住 → 下一轮加载」而不是立刻往对话里塞：
 *   技能的正文只有在模型要动手的那一刻才有意义。提前塞进去，
 *   要么被当成历史噪声，要么污染当前这一轮。钉住到下轮开头再加载，
 *   时机正好是模型准备干活之前 —— 和它自己调 skill 的时机一模一样。
 *
 * 这条通道是只读 + 一次性消费的：钩住就等下一轮，用完即清。
 */

/** 面板与浏览器之间的接口路径。 */
export const ROUTE = '/api/dsh-smart-router'

/** 一次最多钉几个技能。防手滑全选把上下文撑爆。 */
export const MAX_PINS = 12

/** sessionId -> 已钉住的技能名。进程内存储：面板是即时交互，不需要持久化。 */
const pins = new Map()

/** 读出某个会话当前钉住的技能（不消费）。 */
export function peekPinned(sessionId) {
  return [...(pins.get(sessionId) ?? [])]
}

/** 取走并清空 —— 下一轮加载完之后就不该再重复加载。 */
export function takePinned(sessionId) {
  const current = pins.get(sessionId)
  pins.delete(sessionId)
  return current === undefined ? [] : [...current]
}

/** 设置钉住的技能；返回生效后的列表。 */
export function setPinned(sessionId, names) {
  const unique = [...new Set(names)].slice(0, MAX_PINS)
  if (unique.length === 0) pins.delete(sessionId)
  else pins.set(sessionId, new Set(unique))
  return unique
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

const BODY_LIMIT = 4096

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > BODY_LIMIT) throw Object.assign(new Error('body too large'), { code: 'payload-too-large' })
  }
  return body
}

/**
 * 造一个路由处理函数。
 *
 * 依赖以回调形式注入，这样这个文件不碰任何 DSH 服务，能直接测。
 *
 * @param {{ connection: { requestRejection(req: any): number | undefined },
 *           listSkills: (sessionId: string) => Promise<Array<{ name: string, description?: string }>>,
 *           sessionExists?: (sessionId: string) => boolean }} options
 */
export function createPanelHandler(options) {
  const { connection, listSkills, sessionExists } = options

  return async (req, res) => {
    try {
      const rejection = connection?.requestRejection?.(req)
      if (rejection !== undefined) return respond(res, rejection, { ok: false, error: 'access-denied' })

      const url = new URL(req.url ?? ROUTE, 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''

      if (req.method === 'GET') {
        if (sessionId === '') return respond(res, 400, { ok: false, error: 'missing-session' })
        if (sessionExists !== undefined && !sessionExists(sessionId)) {
          return respond(res, 404, { ok: false, error: 'unknown-session' })
        }
        const skills = await listSkills(sessionId)
        return respond(res, 200, {
          ok: true,
          pinned: peekPinned(sessionId),
          skills: skills.map((skill) => ({ name: skill.name, description: skill.description ?? '' })),
        })
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
      const names = Array.isArray(payload?.skills) ? payload.skills.filter((name) => typeof name === 'string') : []
      if (target === '') return respond(res, 400, { ok: false, error: 'missing-session' })
      if (sessionExists !== undefined && !sessionExists(target)) {
        return respond(res, 404, { ok: false, error: 'unknown-session' })
      }

      const pinned = setPinned(target, names)
      return respond(res, 200, { ok: true, pinned })
    } catch {
      try {
        respond(res, 500, { ok: false, error: 'internal' })
      } catch {
        // 响应头可能已经发出去了 —— 这里再抛只会把宿主日志弄脏
      }
    }
  }
}
