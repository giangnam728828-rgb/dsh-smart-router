/**
 * lib/panel.js — 聊天界面面板的宿主半区。
 *
 * 面板要做三件事：列技能、列能力族、让用户勾选。勾中的在下一轮真正生效。
 *
 * 为什么走「钉住 → 下一轮」而不是立刻篡改当前这轮：技能正文只有在模型准备
 * 动手那一刻才有意义。提前塞进去要么被当成历史噪声，要么污染正在进行的推理。
 * 钉到下轮开头，时机正好和模型自己调 skill 一样。
 *
 * 钉住是一次性消费：生效一次就清空，不会每轮重复塞同一份正文。
 */

/** 面板与浏览器之间的接口路径。 */
export const ROUTE = '/api/dsh-smart-router'

/** 一次最多钉几个。防手滑全选把上下文撑爆。 */
export const MAX_PINS = 12

/** sessionId -> { skills: Set, families: Set } */
const pins = new Map()

function emptyPins() {
  return { skills: [], families: [] }
}

/** 读出当前钉住项（不消费）。 */
export function peekPinned(sessionId) {
  const entry = pins.get(sessionId)
  if (entry === undefined) return emptyPins()
  return { skills: [...entry.skills], families: [...entry.families] }
}

/** 取走并清空。 */
export function takePinned(sessionId) {
  const entry = pins.get(sessionId)
  pins.delete(sessionId)
  if (entry === undefined) return emptyPins()
  return { skills: [...entry.skills], families: [...entry.families] }
}

/**
 * 设置钉住项。两类分开存：技能要加载正文，能力族只需要把工具列出来。
 *
 * @param {string} sessionId
 * @param {{ skills?: readonly string[], families?: readonly string[] }} value
 */
export function setPinned(sessionId, value) {
  const skills = [...new Set(value?.skills ?? [])].slice(0, MAX_PINS)
  const families = [...new Set(value?.families ?? [])].slice(0, MAX_PINS)
  if (skills.length === 0 && families.length === 0) pins.delete(sessionId)
  else pins.set(sessionId, { skills: new Set(skills), families: new Set(families) })
  return { skills, families }
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
 *           listSkills: (sessionId: string) => Promise<Array<{ name: string, description?: string, descriptionZh?: string }>>,
 *           listFamilies?: (sessionId: string) => Array<{ name: string, count: number, sample: string }>,
 *           readUsage?: (sessionId: string) => { input?: number, output?: number, total?: number, pressure?: number, window?: number },
 *           readUsed?: (sessionId: string) => { skills: string[], tools: Array<{ name: string, count: number }> },
 *           sessionExists?: (sessionId: string) => boolean }} options
 */
export function createPanelHandler(options) {
  const { connection, listSkills, listFamilies, readUsage, readUsed, sessionExists } = options

  const snapshotOf = async (sessionId) => {
    const skills = await listSkills(sessionId)
    return {
      ok: true,
      pinned: peekPinned(sessionId),
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.descriptionZh ?? skill.description ?? '',
        translated: skill.descriptionZh !== undefined,
      })),
      families: typeof listFamilies === 'function' ? listFamilies(sessionId) : [],
      usage: typeof readUsage === 'function' ? readUsage(sessionId) : {},
      used: typeof readUsed === 'function' ? readUsed(sessionId) : { skills: [], tools: [] },
    }
  }

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
        return respond(res, 200, await snapshotOf(sessionId))
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
      if (sessionExists !== undefined && !sessionExists(target)) {
        return respond(res, 404, { ok: false, error: 'unknown-session' })
      }

      const skills = Array.isArray(payload?.skills) ? payload.skills.filter((name) => typeof name === 'string') : []
      const families = Array.isArray(payload?.families)
        ? payload.families.filter((name) => typeof name === 'string')
        : []
      setPinned(target, { skills, families })
      return respond(res, 200, await snapshotOf(target))
    } catch {
      try {
        respond(res, 500, { ok: false, error: 'internal' })
      } catch {
        // 响应头可能已经发出 —— 再抛只会把宿主日志弄脏
      }
    }
  }
}
