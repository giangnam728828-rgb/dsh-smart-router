/**
 * lib/index.js — 宿主插件入口。
 *
 * 一句话：**把「该用哪个技能 / 哪块插件能力」的判断交还给模型；插件只负责
 * 在每一轮把「候选 + 规矩」送到模型面前，并且保证这件事是它自己做的。**
 *
 * ── 为什么必须是插件，不能是技能 ─────────────────────────────────────────
 * 技能（skill）是一段说明书：没有执行上下文、没有事件、没有生命周期，
 * 只能被人或模型「翻开」。所以技能**不可能自己主动生效** —— 这不是缺陷，
 * 是它的定义。能让路由「每轮自动发生」的只有插件：`apply()` 里挂上
 * `agent/pre-step`，于是每一轮模型开口之前，插件已经跑过一遍了。
 *
 * 本文件就是这个分工的实现：**插件负责主动（推送候选与规矩），技能保持被动
 * （被模型按需翻开）**。两者不是替代关系，是驱动与被驱动的关系。
 *
 * ── 和上游（lau4tin1/dsh-skill-router）的关键差别 ─────────────────────────
 * 1. 没有 543MB 的 bge-m3、没有 ONNX、没有向量库：零依赖，装上就能用。
 * 2. 不再有「过线就注入正文」的阈值判定（minScore / zThreshold / maxSkills）。
 *    打分只用来**收窄候选**，判定在模型手里；正文永远由模型自己调 skill 取。
 * 3. 中文不再漏：候选来自字面重合，只是提示，不需要在某个语料上标定阈值。
 * 4. 覆盖插件：上游只看得见技能；这里额外读 profile 里装的插件与工具族，
 *    让「这件事该用哪块插件能力」也有据可依。
 * 5. 每种注入都有去重键：同一组内容不会在一段对话里反复出现。
 *
 * ── 失败姿态 ─────────────────────────────────────────────────────────────
 * 全链路 fail-open：任何一步抛错都只是「这一轮没有提示」，绝不阻断用户这一轮。
 * 也刻意**不写模块级 `inject`** —— 硬依赖缺失会让 entry 永远 pending，
 * 进而拖垮整棵插件树（dsh-device-shell-guide 0.1.9 出过这个事故）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { resolveConfig, userTaskText } from './config.js'
import { listInstalledPlugins } from './plugins.js'
import { digestOf, familyOf, narrow, rankTools, summarizeTools, tokenize } from './route.js'
import { matchReasons, renderPinnedBlock, renderStaticBlock, renderTurnBlock } from './render.js'
import { record } from './log.js'
import { ROUTE, createPanelHandler, takePinned } from './panel.js'
import { describeSkill } from './zh.js'
import { noteToolCall, usageOf } from './usage.js'

/** 插件名：出现在会话消息的 source 里，也是插件页的标识。 */
export const name = 'dsh-smart-router'

/** 版本号同时写进加载日志，用来确认「跑的是哪一版」。 */
export const VERSION = '0.4.4'

/**
 * 注入消息的来源标签。
 *
 * ⚠️ 这里必须是**生产者自己的** kind，不能写 `'plugin'`。
 * `'plugin'` 是 V3 会话格式的旧写法，V4 在写入时会直接拒绝：
 *   `format v4 message requires a producer-owned source kind`
 * 内置的技能目录用的是 `{ kind: 'skill-catalog', form: 'catalog' }`；
 * 本插件同理，用自己的名字。`form` 是给 UI 分类用的附加字段，框架不校验。
 */
export const SOURCE_KIND = 'smart-router'
const SOURCE = Object.freeze({ kind: SOURCE_KIND, form: 'instructions' })

/**
 * 去重状态挂在进程级，而不是每个 apply() 各一份。
 *
 * 原因是实测过的：换入口文件那一次，`apply()` 在一个进程里被调了十遍
 * （loader 重建 bundle 时的重入）。如果状态跟着实例走，十个实例就会
 * 各自注入一遍同样的内容。挂在 globalThis 上，后到的实例看到的
 * 去重键已经是「发过了」，自然不再重复。
 *
 * 键用 Symbol.for，跨模块实例共享；agent 用 WeakMap，会话结束自动回收。
 */
export const SHARED_STATE_KEY = Symbol.for('dsh-smart-router.shared')

function sharedStates() {
  let states = globalThis[SHARED_STATE_KEY]
  if (states === undefined) {
    states = new WeakMap()
    globalThis[SHARED_STATE_KEY] = states
  }
  return states
}

/** 每个 agent 一份状态：静态块发没发过、上一轮候选的去重键是什么。 */
function createStateStore() {
  const states = sharedStates()
  return {
    get(agent) {
      let state = states.get(agent)
      if (state === undefined) {
        state = { staticDigest: undefined, turnDigest: undefined, injected: 0 }
        states.set(agent, state)
      }
      return state
    },
  }
}

/**
 * 组装一份注入文本对应的消息。
 * 用 createUserMessage 而不是手写对象：消息的身份、冻结、source 形状
 * 都由框架负责，插件不该自己拼一个「看起来像」的消息。
 */
function makeMessage(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: SOURCE })
}

/**
 * 把一份技能正文包成一条消息。
 *
 * `kind: 'skill-invocation'` 是框架认可的「有人点名要了这个技能」的来源，
 * 和内置 skill 工具被用户唤出时用的是同一个 —— 于是下游（会话视图、
 * 重放、计费）看到的就是一次正常的技能调用，不是插件凭空塞的东西。
 */
export function skillMessage(definition) {
  const text = typeof renderSkillContent === 'function'
    ? renderSkillContent(definition)
    : `<skill_content name="${definition.name}">\n${definition.content}\n</skill_content>`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'skill-invocation', name: definition.name, form: 'instructions' },
  })
}

export function apply(ctx, config) {
  const settings = resolveConfig(config)
  if (!settings.enabled) return

  // 加载即落一行。这一行同时是运维信息（谁在什么时候加载了哪个版本）
  // 和自检信号：改完代码重载插件后，看日志就知道新模块有没有真的被读进来
  // （Node 的 ESM 缓存按 URL 命中，只改文件内容是不会重新求值的）。
  record({ event: 'loaded', kind: SOURCE_KIND, rev: VERSION })

  const store = createStateStore()

  // ── 聊天界面面板：技能列表 + 勾选 ──────────────────────────────────────
  //
  // 关键：**不能在 apply 时同步取 webServer**。插件行的启动顺序不保证 webServer
  // 已经就绪，`ctx.get('webServer')` 拿到 undefined 的话，路由就永远没注册，
  // 面板只会一直显示「读取失败」。用 ctx.inject 等服务就绪再注册。
  ctx.inject(['webServer'], (inner) => {
    const panelDeps = {
            // 其余服务在**请求发生时**再取：它们晚于路由就绪也不影响。
            connection: {
              requestRejection: (req) => ctx.get('connection')?.requestRejection(req),
            },
            resolveAgent: (sessionId) => {
              const agents = ctx.get('agents')
              if (agents === undefined) return undefined
              const direct = agents.get?.(sessionId)
              if (direct !== undefined) return direct
              // id 认不出来时的兜底，按可靠性排序：
              // 根会话 > 唯一活跃会话 > 放弃（返回 undefined 由下面各自兜底）。
              const roots = agents.roots?.() ?? []
              if (roots.length === 1) return roots[0]
              const all = agents.list?.() ?? []
              return all.length === 1 ? all[0] : undefined
            },
            listSkills: async (sessionId) => {
              const registry = ctx.get('skills')
              if (registry === undefined) return []
              const agent = ctx.get('agents')?.get?.(sessionId)
              const cwd = agent?.session?.header?.cwd
              const snapshot = await registry.snapshot({
                ...(typeof cwd === 'string' ? { cwd } : {}),
                ...(agent === undefined ? {} : { scope: agent }),
              })
              return (snapshot?.skills ?? [])
                .filter((skill) => skill?.invocation?.modelInvocable !== false)
                .map((skill) => {
                  const described = describeSkill(skill.name, skill.description)
                  return {
                    name: skill.name,
                    description: skill.description,
                    descriptionZh: described.translated ? described.text : undefined,
                  }
                })
            },
            listFamilies: (sessionId) => {
              const toolset = ctx.get('tools')
              if (toolset === undefined) return []
              // 工具是全局注册的：拿不到 agent 也照样能列，不能因为一个 agent
              // 解析失败就让整个「能力」页签空着。
              const agent = ctx.get('agents')?.get?.(sessionId)
              const definitions = agent === undefined ? toolset.definitions() : toolset.definitions(agent)
              return summarizeTools(definitions ?? [], { maxFamilies: 40 })
            },
            listPlugins: () => listInstalledPlugins({ limit: 30, exclude: [name] }),
            readUsage: (sessionId) => {
              const session = ctx.get('agents')?.get?.(sessionId)?.session
              const meter = ctx.get('tokenMeter')
              if (session === undefined || meter === undefined) return {}
              try {
                const measurement = meter.measure(session)
                const usage = measurement?.baseline?.kind === 'usage' ? measurement.baseline.usage : undefined
                const pressure = meter.contextPressure?.(session) ?? {}
                return {
                  input: usage?.inputTokens ?? 0,
                  output: usage?.outputTokens ?? 0,
                  total: usage?.totalTokens ?? measurement?.totalTokens ?? 0,
                  pressure: pressure.pressureTokens ?? 0,
                  window: pressure.contextWindow ?? 0,
                }
              } catch {
                return {}
              }
            },
      readUsed: (sessionId) => usageOf(sessionId),
    }

    inner.effect(
      () => inner.webServer.register({ kind: 'exact', path: ROUTE, handler: createPanelHandler(panelDeps) }),
      'smart-router: panel route',
    )
    record({ event: 'panel-route' })

    // 启动自检：按真实数据源各算一次，把条数写进日志。
    // 面板显示不出来时，先看这行就知道是「取不到数」还是「取到了没渲染」。
    void (async () => {
      const count = async (fn) => {
        try {
          const value = await fn()
          return Array.isArray(value) ? value.length : 0
        } catch (error) {
          return `error:${String(error?.message ?? error).slice(0, 60)}`
        }
      }
      record({
        event: 'panel-selftest',
        skills: await count(() => panelDeps.listSkills('__selftest__')),
        plugins: await count(() => panelDeps.listPlugins()),
        families: await count(() => panelDeps.listFamilies('__selftest__')),
      })
    })()
  })

  // 只记真正派发出去的工具调用 —— 推荐过什么不算「用了」。
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    try {
      noteToolCall(String(exec?.agent?.id ?? ''), exec?.name, exec?.arguments)
    } catch {
      // 记账失败不能影响工具本身
    }
    return result
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision

    const { agent, messages, step, signal } = payload ?? {}
    // 只在每轮第一步做：一轮里模型可能走好几步，重复推候选纯属浪费。
    if (step !== 1) return decision

    try {
      const task = userTaskText(messages)
      if (task === undefined) return decision

      const skills = ctx.get('skills')
      const tools = ctx.get('tools')
      const state = store.get(agent)
      const additions = []
      const cwd = agent?.session?.header?.cwd
      const lookup = {
        ...(typeof cwd === 'string' ? { cwd } : {}),
        scope: agent,
        signal,
      }

      // ── 面板上勾选的技能：在这一轮开头真正加载 ──────────────────────────
      // 一次性消费：加载过就从钉住列表里去掉，不会每轮重复塞同一份正文。
      const leading = []
      const pinned = takePinned(String(agent?.id ?? ''))
      if (pinned.skills.length > 0 && skills !== undefined) {
        for (const skillName of pinned.skills) {
          try {
            const definition = await skills.get(skillName, lookup)
            if (definition !== undefined) leading.push(skillMessage(definition))
          } catch {
            // 单个技能读不出来不影响其余几个
          }
        }
      }
      const pinnedPlugins = pinned.plugins.length > 0
        ? pinned.plugins.map((pluginName) => {
            const found = safe(() => listInstalledPlugins({ limit: 40 }), []).find((item) => item.name === pluginName)
            return found ?? { name: pluginName }
          })
        : []
      if ((pinned.families.length > 0 || pinnedPlugins.length > 0) && tools !== undefined) {
        const definitions = safe(() => tools.definitions(agent) ?? [], [])
        const rows = pinned.families.map((family) => ({
          name: family,
          tools: definitions.filter((tool) => familyOf(tool.name) === family).slice(0, 8).map((tool) => tool.name),
        }))
        const text = renderPinnedBlock({ families: rows, plugins: pinnedPlugins })
        if (text.length > 0) leading.push(makeMessage(text))
      }
      if (leading.length > 0 && settings.debug) {
        record({ event: 'pinned', session: String(agent?.id ?? ''), count: leading.length })
      }

      // ── 静态块：插件能力 + 工具族 + 规矩 ────────────────────────────────
      // 不是「只发一次」：装了新插件、接了新 MCP，工具族和插件目录都会变。
      // 每轮复核一次（按 TTL 限频，避免每轮都读 profile 的 package.json），
      // 内容变了就补发一条更新。
      const now = Date.now()
      const stale = state.staticCheckedAt === undefined || now - state.staticCheckedAt >= settings.staticTtlMs
      if (state.staticDigest === undefined || stale) {
        const plugins = settings.includePlugins
          ? safe(() => listInstalledPlugins({ limit: settings.pluginsLimit, exclude: [name] }), [])
          : []
        const families = settings.includeToolFamilies && tools !== undefined
          ? safe(() => summarizeTools(tools.definitions(agent) ?? [], { maxFamilies: settings.familiesLimit }), [])
          : []

        const staticText = renderStaticBlock({
          plugins,
          families,
          includePlugins: settings.includePlugins,
          includeToolFamilies: settings.includeToolFamilies,
        })
        state.staticCheckedAt = now
        const digest = staticText.length > 0 ? digestOf(staticText) : ''
        if (digest !== state.staticDigest) {
          const first = state.staticDigest === undefined
          state.staticDigest = digest
          // 第一次照常发；之后只在内容真的变了（新插件/新工具）时补发。
          if (staticText.length > 0) additions.push(staticText)
          if (!first && settings.debug) record({ event: 'static-refresh', session: String(agent?.id ?? '') })
        }
      }

      // ── 回合块：本轮技能候选 + 本轮可能用得上的具体工具 ────────────────
      // 按指令挑工具的部分放在这里、而不是静态块里：静态块只回答
      // 「这台机器有什么能力」，回合块回答「这一句话可能用到什么」。
      const rankedTools = settings.includeToolFamilies && tools !== undefined
        ? safe(() => rankTools(tools.definitions(agent) ?? [], task, { limit: 3, minimum: settings.minScore }), [])
        : []

      if (skills !== undefined) {
        const snapshot = await skills.snapshot(lookup)
        signal?.throwIfAborted()

        // 只推荐模型能自己加载的技能；userInvocable-only 的应该由用户唤出。
        const invocable = (snapshot?.skills ?? [])
          .filter((skill) => skill?.invocation?.modelInvocable !== false)
          .map((skill) => {
            // 把中文说明挂到 keywords 上：面板显示什么，匹配就按什么算。
            const described = describeSkill(skill.name, skill.description)
            return described.translated ? { ...skill, keywords: described.text } : skill
          })
        const result = narrow(invocable, task, {
          limit: settings.maxCandidates,
          minimum: settings.minScore,
        })

        if (!result.empty || rankedTools.length > 0) {
          const queryTokens = tokenize(task)
          const reasons = Object.create(null)
          for (const candidate of result.selected) {
            reasons[candidate.name] = matchReasons(queryTokens, candidate, tokenize)
          }
          const turnText = renderTurnBlock({
            task,
            candidates: result.selected,
            reasons,
            tools: rankedTools,
            total: result.total,
          })
          const digest = digestOf(turnText)
          if (digest !== state.turnDigest) {
            state.turnDigest = digest
            additions.push(turnText)
          }
        } else {
          // 这一轮没有候选：不硬凑，也不留着上一轮的结论误导下一轮。
          state.turnDigest = ''
        }
      } else if (rankedTools.length > 0) {
        // 技能服务不可用，但工具还有话说 —— 照样给，只是没有技能那一半。
        const turnText = renderTurnBlock({ task, candidates: [], tools: rankedTools, total: 0 })
        const digest = digestOf(turnText)
        if (digest !== state.turnDigest) {
          state.turnDigest = digest
          additions.push(turnText)
        }
      }

      const outbound = [...leading, ...additions.map(makeMessage)]
      if (outbound.length === 0) return decision

      state.injected += outbound.length
      if (settings.debug) {
        record({
          event: 'inject',
          session: String(agent?.id ?? ''),
          blocks: additions.length,
          chars: additions.reduce((sum, text) => sum + text.length, 0),
        })
      }

      return { ...decision, messages: [...decision.messages, ...outbound] }
    } catch (error) {
      // 用户取消要照常向上抛，其余一律降级成「这一轮没有提示」。
      if (signal?.aborted === true) throw error
      if (settings.debug) record({ event: 'error', message: String(error?.message ?? error) })
      return decision
    }
  })
}

/** 跑一个可能抛错的取数步骤，失败就用兜底值 —— 提示缺一块不影响整轮。 */
function safe(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}
