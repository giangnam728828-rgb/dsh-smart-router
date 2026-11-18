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
import { claimRoute, createPanelHandler, takePinned } from './panel.js'
import { describeSkill } from './zh.js'
import { noteSkillInjection, noteSkillMissing, noteToolCall, usageOf } from './usage.js'
import { createTranslationStore } from './translate.js'

/** 插件名：出现在会话消息的 source 里，也是插件页的标识。 */
export const name = 'dsh-smart-router'

/** 版本号同时写进加载日志，用来确认「跑的是哪一版」。 */
export const VERSION = '0.6.0'

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

/**
 * 记过账的 exec 对象，用来把「同一次工具调用」在多实例下只记一遍。
 * 同样是进程级、WeakSet（对象用完即可回收）。
 */
export const SEEN_EXEC_KEY = Symbol.for('dsh-smart-router.seen-exec')

function seenExecs() {
  let seen = globalThis[SEEN_EXEC_KEY]
  if (seen === undefined) {
    seen = new WeakSet()
    globalThis[SEEN_EXEC_KEY] = seen
  }
  return seen
}

/**
 * 插件清单缓存（进程级，两个半区共用）。
 *
 * 为什么要缓存：`listInstalledPlugins` 是**同步**读盘的，实测 13 个插件要 86ms。
 * 它同时被 pre-step（静态块，TTL 30s 复核一次）和面板（每次打开）调用。
 * 不加缓存的话，这 86ms 会直接压在宿主的事件循环上 —— 表现就是
 * 「每半分钟整个界面顿一下」。缓存后同一份结果给所有调用方切片。
 */
const INVENTORY_TTL_MS = 20000
const inventory = { at: 0, value: undefined }

/** 取全部（带缓存）。失败返回空数组，不让调用方各自兜底。 */
function inventoryAll() {
  const now = Date.now()
  if (inventory.value === undefined || now - inventory.at >= INVENTORY_TTL_MS) {
    inventory.value = safe(() => listInstalledPlugins({ limit: 100, exclude: [] }), [])
    inventory.at = now
  }
  return inventory.value
}

/** 从缓存里按需切片：排除自己、按上限截断。 */
function inventorySlice({ limit, exclude }) {
  const skip = new Set(exclude ?? [])
  return inventoryAll()
    .filter((plugin) => !skip.has(plugin.name))
    .slice(0, limit ?? 100)
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
  // 渲染器对形状有要求（要有 provider 或 resourceBase）。宿主换了版本、
  // 或者某个 provider 给的定义缺字段，这里就会抛 —— 抛了不能把整份技能丢掉，
  // 退回最简单的包裹格式，正文照样进上下文。
  const text = (() => {
    if (typeof renderSkillContent === 'function') {
      try {
        return renderSkillContent(definition)
      } catch {
        // 走下面的兜底
      }
    }
    return `<skill_content name="${definition.name}">\n${definition.content}\n</skill_content>`
  })()
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
  // 翻译缓存：第一次遇到就翻，翻完落盘，之后都读缓存。
  const translations = createTranslationStore({ getTranslator: () => ctx.get('translator') })
  // 用量缓存：tokenMeter.measure 要遍历整个 surface，5 秒内重复读没有意义。
  const usageCache = { at: 0, bySession: new Map() }

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
              const snapshot = await withDeadline(
                registry.snapshot({
                  ...(typeof cwd === 'string' ? { cwd } : {}),
                  ...(agent === undefined ? {} : { scope: agent }),
                }),
                1500,
              )
              const rows = (snapshot?.skills ?? [])
                .filter((skill) => skill?.invocation?.modelInvocable !== false)
                .map((skill) => {
                  const described = describeSkill(skill.name, skill.description)
                  return {
                    name: skill.name,
                    description: skill.description,
                    // 优先级：人写的（skills.zh.json / 内置表）> 自动翻译缓存 > 英文
                    descriptionZh: described.translated ? described.text : translations.get(skill.name),
                  }
                })

              // 缺中文的丢给翻译器**在后台跑**，请求不等它。
              // 等 2.5 秒换一次「这次就显示中文」不值：面板会明显卡一下，
              // 而用户下次打开照样能看到中文。
              void translations.ensure(
                rows
                  .filter((row) => row.descriptionZh === undefined && typeof row.description === 'string')
                  .map((row) => ({ key: row.name, text: row.description })),
              )
              return rows
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
            listPlugins: () => {
              // 与静态块共用同一个进程级缓存：两边都扫一遍纯属浪费，
              // 而且这份扫描是同步的，会压在事件循环上。
              const list = inventorySlice({ limit: 30, exclude: [name] })
              void translations.ensure(
                list
                  .filter((plugin) => typeof plugin.description === 'string' && plugin.description.length > 0)
                  .map((plugin) => ({ key: `plugin:${plugin.name}`, text: plugin.description })),
              )
              return list.map((plugin) => ({
                ...plugin,
                descriptionZh: translations.get(`plugin:${plugin.name}`),
              }))
            },
            readUsage: (sessionId) => {
              const session = ctx.get('agents')?.get?.(sessionId)?.session
              const meter = ctx.get('tokenMeter')
              if (session === undefined || meter === undefined) return {}
              const now = Date.now()
              const cached = usageCache.bySession.get(sessionId)
              if (cached !== undefined && now - cached.at < 5000) return cached.value
              try {
                const measurement = meter.measure(session)
                const usage = measurement?.baseline?.kind === 'usage' ? measurement.baseline.usage : undefined
                const pressure = meter.contextPressure?.(session) ?? {}
                const value = {
                  // 这一份数据是什么时候量的 —— 面板要显示「几秒前」，
                  // 否则用户只能盯着数字猜它是不是旧的。
                  at: now,
                  input: usage?.inputTokens ?? 0,
                  output: usage?.outputTokens ?? 0,
                  total: usage?.totalTokens ?? measurement?.totalTokens ?? 0,
                  pressure: pressure.pressureTokens ?? 0,
                  window: pressure.contextWindow ?? 0,
                }
                usageCache.bySession.set(sessionId, { at: now, value })
                // 同样不许无限涨：5 秒缓存，留最近 64 个会话足够。
                while (usageCache.bySession.size > 64) {
                  const oldest = usageCache.bySession.keys().next().value
                  if (oldest === undefined) break
                  usageCache.bySession.delete(oldest)
                }
                return value
              } catch {
                return {}
              }
            },
      readUsed: (sessionId) => usageOf(sessionId),
    }

    // 路由注册必须容错：宿主对同一 path 重复注册是直接抛错的
    // （`webserver: duplicate exact route`），而本插件在一个进程里被 apply
    // 多次是常态。claimRoute 负责「先撤旧持有者再注册」，这里再兜一层：
    // 万一还有别的插件占了同一个路径，也只是这次没注册上，绝不让 apply 炸掉。
    inner.effect(() => {
      try {
        return claimRoute(inner.webServer, createPanelHandler(panelDeps))
      } catch (error) {
        record({ event: 'panel-route-failed', message: String(error?.message ?? error) })
        return () => {}
      }
    }, 'smart-router: panel route')
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
      // 自检要量「面板真正会看到的东西」，所以先解析出一个真实会话再数。
      // 早先用哨兵 id 直接取快照：没有 agent 就没有 scope，技能根按默认集合算，
      // 结果和面板显示的数量对不上 —— 自检说 2、实际装了 6，白查半天。
      const probeId = (() => {
        try {
          const agent = panelDeps.resolveAgent?.('')
          if (agent !== undefined && typeof agent.id === 'string' && agent.id !== '') return String(agent.id)
        } catch {
          // 解析失败就用哨兵 —— 自检不能反过来变成故障源
        }
        return '__selftest__'
      })()
      record({
        event: 'panel-selftest',
        probe: probeId === '__selftest__' ? 'no-agent' : 'session',
        skills: await count(() => panelDeps.listSkills(probeId)),
        plugins: await count(() => panelDeps.listPlugins()),
        families: await count(() => panelDeps.listFamilies(probeId)),
      })
    })()
  })

  // 只记真正派发出去的工具调用 —— 推荐过什么不算「用了」。
  //
  // ⚠️ 记账必须是幂等的：重载时同一进程里可能短暂并存两个实例，两边都挂着
  // `tools/execute`，同一次调用会被记两遍（实测 count 变成 2）。
  // 用 exec 对象本身做一次性标记（WeakSet，不阻碍回收）。
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    try {
      const isObject = exec !== null && typeof exec === 'object'
      if (isObject) {
        const seen = seenExecs()
        if (seen.has(exec)) return result
        seen.add(exec)
      }
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
      const agentId = String(agent?.id ?? '')
      const pinned = takePinned(agentId)
      const pinnedLoaded = []
      if (pinned.skills.length > 0) {
        for (const skillName of pinned.skills) {
          if (skills === undefined) {
            // 技能服务不可用：勾了也不会有人加载，必须让用户在面板上看到
            noteSkillMissing(agentId, skillName)
            continue
          }
          try {
            const definition = await withDeadline(skills.get(skillName, lookup), 1500)
            if (definition === undefined) noteSkillMissing(agentId, skillName)
            else {
              leading.push(skillMessage(definition))
              pinnedLoaded.push(skillName)
            }
          } catch {
            // 单个技能读不出来不影响其余几个
            noteSkillMissing(agentId, skillName)
          }
        }
        // 只有真的进了上下文才算「已注入」——勾选本身不算。
        noteSkillInjection(agentId, pinnedLoaded)
      }
      const pinnedPlugins = pinned.plugins.length > 0
        ? pinned.plugins.map((pluginName) => {
            const found = inventoryAll().find((item) => item.name === pluginName)
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
          ? inventorySlice({ limit: settings.pluginsLimit, exclude: [name] })
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
        const snapshot = await withDeadline(skills.snapshot(lookup), 1500)
        signal?.throwIfAborted()

        // 只推荐模型能自己加载的技能；userInvocable-only 的应该由用户唤出。
        const invocable = (snapshot?.skills ?? [])
          .filter((skill) => skill?.invocation?.modelInvocable !== false)
          .map((skill) => {
            // 把中文说明挂到 keywords 上：面板显示什么，匹配就按什么算。
            // 优先人写的，其次自动翻译缓存 —— 于是翻译过一次的技能，
            // 之后中文提问就能按中文匹配到。
            const described = describeSkill(skill.name, skill.description)
            const keyword = described.translated ? described.text : translations.get(skill.name)
            return keyword === undefined ? skill : { ...skill, keywords: keyword }
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

      // decision.messages 理论上一定是数组；别的前提下一旦是 undefined，
      // 上一版会在展开时抛 TypeError，被 catch 兜住 —— 表现是「这一轮静默没有提示」。
      // 宁可当成空数组接着注入，也不要悄悄省掉。
      const base = Array.isArray(decision.messages) ? decision.messages : []
      return { ...decision, messages: [...base, ...outbound] }
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

/**
 * 等一个 promise，但最多等这么久。超时返回 undefined。
 *
 * 用在哪：`skills.snapshot()` / `skills.get()` 这类「本地读盘、不该慢」的服务调用。
 * 它们真挂住时，上一版会让**整个回合**停在 pre-step 里 —— 用户看到的是「发出去
 * 没反应」，比「这一轮没有提示」坏得多。这里宁可放弃这一轮的提示。
 *
 * 定时器一定清掉：不清的话进程会为每个回合多留一个 1.5 秒的句柄。
 */
function withDeadline(promise, ms) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
