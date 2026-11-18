/**
 * lib/client.js — 聊天界面里的「技能与能力」面板（浏览器半区）。
 *
 * 位置：输入框上方 `conversation.input.dock`。
 *
 * ── 这一版解决的三件事 ─────────────────────────────────────────────────
 * 1. **不再铺满屏幕。** 整块限高（58vh / 440px），内部滚动，头部和底栏常驻，
 *    任何时候都点得到「收起」——上一版把内容直接铺开，滚不动又关不掉。
 * 2. **分区，而不是一长条。** 技能 / 插件 / 能力 / 用量 四个页签，每个页签
 *    拿到完整高度，列表再长也是列表内部滚，不会把输入框挤走。
 * 3. **用量放到显眼位置。** token 总数用大字，输入/输出/上下文并排；
 *    用过的技能和工具单独一屏，不再挤在页脚。
 *
 * 颜色一律从 currentColor 混出来，跟着宿主主题走；不写死色值。
 */
window.__ModuleLoader__.load({
  id: 'dsh-smart-router',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/api/dsh-smart-router'
    const SLOT = 'conversation.input.dock'
    const CELL_ID = 'smart-router'
    const CELL_ORDER = 30

    const ZH = navigator.language?.toLowerCase().startsWith('zh') === true
    const TEXT = ZH
      ? {
          trigger: '技能与能力',
          title: '这一轮带什么进去',
          hint: '勾中的在下一轮生效；不勾就由模型自己判断。',
          tabSkills: '技能',
          tabPlugins: '插件',
          tabAbilities: '能力',
          tabUsage: '用量',
          emptySkills: '这个会话没有可加载的技能。',
          emptyPlugins: '没有已安装的插件。',
          emptyAbilities: '没有可单独指名的能力族。',
          apply: '下一轮加载',
          clear: '清空',
          reload: '刷新',
          close: '收起',
          saving: '保存中',
          saved: '已记下，下一条消息生效',
          failed: '读取失败，点刷新重试',
          saveFailed: '保存失败，重试一次',
          used: '用过',
          tokens: '总 token',
          input: '输入',
          output: '输出',
          context: '上下文',
          usedSkills: '这个会话用过的技能',
          usedTools: '这个会话用过的工具',
          none: '还没有记录',
          noUsage: '还没有用量数据',
        }
      : {
          trigger: 'Skills & abilities',
          title: 'What goes into the next turn',
          hint: 'Selected items apply to your next message. Select nothing and the model decides.',
          tabSkills: 'Skills',
          tabPlugins: 'Plugins',
          tabAbilities: 'Abilities',
          tabUsage: 'Usage',
          emptySkills: 'No loadable skills in this session.',
          emptyPlugins: 'No plugins installed.',
          emptyAbilities: 'No ability groups to name.',
          apply: 'Load next turn',
          clear: 'Clear',
          reload: 'Refresh',
          close: 'Close',
          saving: 'Saving',
          saved: 'Saved — applies to your next message',
          failed: 'Could not load. Press refresh.',
          saveFailed: 'Could not save. Try again.',
          used: 'used',
          tokens: 'Total tokens',
          input: 'In',
          output: 'Out',
          context: 'Context',
          usedSkills: 'Skills used in this session',
          usedTools: 'Tools used in this session',
          none: 'Nothing yet',
          noUsage: 'No usage recorded yet',
        }

    /** 12px 的叉。画出来的，不用字形。 */
    function CloseIcon() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', {
          d: 'M3 3 L9 9 M9 3 L3 9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      )
    }

    function Chevron({ open }) {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 12 12',
          'aria-hidden': true,
          style: { flex: '0 0 auto', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 140ms cubic-bezier(0.2, 0, 0, 1)' },
        },
        h('path', {
          d: 'M4 2.5 L8 6 L4 9.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    const S = {
      root: { width: '100%', maxWidth: '100%', boxSizing: 'border-box', fontSize: '13px', lineHeight: 1.55 },
      trigger: {
        appearance: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        width: '100%',
        padding: '6px 10px',
        margin: 0,
        border: 0,
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
        opacity: 0.72,
      },
      triggerHover: { opacity: 1, background: 'color-mix(in oklab, currentColor 6%, transparent)' },
      count: { opacity: 0.6, fontVariantNumeric: 'tabular-nums' },
      panel: {
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'min(58vh, 440px)',
        border: '1px solid color-mix(in oklab, currentColor 14%, transparent)',
        borderRadius: '10px',
        overflow: 'hidden',
        background: 'color-mix(in oklab, currentColor 3%, transparent)',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '10px 12px 8px',
        flex: '0 0 auto',
      },
      title: { fontWeight: 600, letterSpacing: '0.01em' },
      hint: { padding: '0 12px 8px', opacity: 0.6, fontSize: '11.5px', flex: '0 0 auto' },
      tabs: {
        display: 'flex',
        gap: '2px',
        padding: '0 8px',
        flex: '0 0 auto',
        borderBottom: '1px solid color-mix(in oklab, currentColor 10%, transparent)',
      },
      tab: {
        appearance: 'none',
        border: 0,
        borderBottom: '2px solid transparent',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        padding: '6px 8px 7px',
        cursor: 'pointer',
        opacity: 0.6,
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
      },
      tabOn: { opacity: 1, borderBottomColor: 'currentColor', fontWeight: 600 },
      tabCount: { opacity: 0.55, fontSize: '11px', fontVariantNumeric: 'tabular-nums' },
      body: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        WebkitOverflowScrolling: 'touch',
        padding: '6px 8px 8px',
      },
      list: { display: 'flex', flexDirection: 'column', gap: '1px' },
      row: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '6px', borderRadius: '6px', cursor: 'pointer' },
      rowOn: { background: 'color-mix(in oklab, currentColor 8%, transparent)' },
      check: { margin: '3px 0 0', accentColor: 'currentColor', flex: '0 0 auto' },
      col: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
      name: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px', letterSpacing: '-0.01em', overflowWrap: 'anywhere' },
      desc: { opacity: 0.72, fontSize: '12px' },
      badge: { fontSize: '10.5px', opacity: 0.5, marginInlineStart: '6px', whiteSpace: 'nowrap' },
      foot: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '8px 10px',
        flex: '0 0 auto',
        borderTop: '1px solid color-mix(in oklab, currentColor 10%, transparent)',
        background: 'color-mix(in oklab, currentColor 4%, transparent)',
      },
      actions: { display: 'flex', gap: '2px', alignItems: 'center', flexWrap: 'wrap' },
      btn: {
        appearance: 'none',
        border: 0,
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        padding: '5px 10px',
        cursor: 'pointer',
        opacity: 0.78,
      },
      primary: { background: 'color-mix(in oklab, currentColor 12%, transparent)', opacity: 1, fontWeight: 600 },
      off: { opacity: 0.4, cursor: 'default' },
      note: { fontSize: '11.5px', opacity: 0.6, padding: '10px 6px' },
      error: { fontSize: '11.5px', color: '#d4380d', padding: '10px 6px' },
      stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: '10px 14px', padding: '4px 6px 2px' },
      stat: { display: 'flex', flexDirection: 'column' },
      big: { fontSize: '20px', lineHeight: 1.2, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' },
      mid: { fontSize: '14px', lineHeight: 1.3, fontVariantNumeric: 'tabular-nums' },
      label: { fontSize: '11px', opacity: 0.55, marginTop: '1px' },
      group: { padding: '8px 6px 0' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' },
      chip: { fontSize: '11px', padding: '1px 7px', borderRadius: '999px', background: 'color-mix(in oklab, currentColor 9%, transparent)' },
    }

    const merge = (base, extra) => (extra === undefined ? base : { ...base, ...extra })

    /**
     * 把服务端返回的载荷归一成固定形状。
     *
     * 这一条是踩出来的：之前直接 setData(payload)，一旦某个字段缺席，
     * 页签里的 `data.plugins.length` 就会抛错，整块面板当场卸载 ——
     * 表现就是「点了一下插件页签，面板突然没了」。
     */
    const normalize = (payload) => ({
      skills: Array.isArray(payload?.skills) ? payload.skills : [],
      plugins: Array.isArray(payload?.plugins) ? payload.plugins : [],
      families: Array.isArray(payload?.families) ? payload.families : [],
      pinned: {
        skills: Array.isArray(payload?.pinned?.skills) ? payload.pinned.skills : [],
        families: Array.isArray(payload?.pinned?.families) ? payload.pinned.families : [],
        plugins: Array.isArray(payload?.pinned?.plugins) ? payload.pinned.plugins : [],
      },
      usage: payload?.usage !== null && typeof payload?.usage === 'object' ? payload.usage : {},
      used: {
        skills: Array.isArray(payload?.used?.skills) ? payload.used.skills : [],
        tools: Array.isArray(payload?.used?.tools) ? payload.used.tools : [],
      },
    })
    const nf = new Intl.NumberFormat()
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? nf.format(value) : '—')

    function CheckRow({ id, title, description, checked, badge, onToggle }) {
      return h(
        'label',
        { style: merge(S.row, checked ? S.rowOn : undefined) },
        h('input', { type: 'checkbox', checked, onChange: () => onToggle(id), style: S.check }),
        h(
          'span',
          { style: S.col },
          h('span', { style: S.name }, title, badge ? h('span', { style: S.badge }, badge) : null),
          description ? h('span', { style: S.desc }, description) : null,
        ),
      )
    }

    function SkillRouterPanel(props) {
      const sessionId = props?.sessionId
      const [open, setOpen] = React.useState(false)
      const [tab, setTab] = React.useState('skills')
      const [status, setStatus] = React.useState('idle')
      const [data, setData] = React.useState({
        skills: [],
        plugins: [],
        families: [],
        pinned: { skills: [], families: [], plugins: [] },
        usage: {},
        used: { skills: [], tools: [] },
      })
      const [selected, setSelected] = React.useState({ skills: [], families: [], plugins: [] })
      const [notice, setNotice] = React.useState('')
      const [hover, setHover] = React.useState(false)
      const [refreshed, setRefreshed] = React.useState(false)

      // 拿不到 sessionId 也不放弃：发一个哨兵值，宿主那边会解析到唯一活跃会话。
      // 这条是防「props 没给 sessionId 就整块不可用」——上一版就是那么挂的。
      const sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'current'

      const load = React.useCallback(async () => {
        setStatus('loading')
        setRefreshed(false)
        try {
          const response = await fetch(`${ROUTE}?sessionId=${encodeURIComponent(sid)}`, { headers: { Accept: 'application/json' } })
          const payload = await response.json()
          if (!payload?.ok) throw new Error(payload?.error ?? 'failed')
          const next = normalize(payload)
          setData(next)
          setSelected({ skills: next.pinned.skills, families: next.pinned.families, plugins: next.pinned.plugins })
          setStatus('ready')
        } catch {
          setStatus('error')
        }
      }, [sid])

      /**
       * 只刷新数据，不动用户已经勾的那几项。
       *
       * 加它的原因：新装的技能没有手写中文，走的是后台机器翻译，**第一次
       * 打开面板时往往还没翻完**，于是显示英文，翻完落盘要等下次打开才看得见。
       * 现在只要发现有未翻的条目，就安静地补刷一次 —— 用户不用关掉再开。
       */
      const refresh = React.useCallback(async () => {
        try {
          const response = await fetch(`${ROUTE}?sessionId=${encodeURIComponent(sid)}`, { headers: { Accept: 'application/json' } })
          const payload = await response.json()
          if (payload?.ok) setData(normalize(payload))
        } catch {
          // 补刷失败只是这次没变中文，不影响已经显示的内容
        }
      }, [sid])

      React.useEffect(() => {
        if (open) void load()
      }, [open, load])

      // 每个会话只补刷一次，避免和翻译服务互相追着跑。
      React.useEffect(() => {
        if (!open || status !== 'ready' || refreshed) return undefined
        const pending = (data.skills ?? []).some((row) => row.translated === false)
          || (data.plugins ?? []).some((row) => row.translated === false)
        if (!pending) return undefined
        const timer = setTimeout(() => {
          setRefreshed(true)
          void refresh()
        }, 4000)
        return () => clearTimeout(timer)
      }, [open, status, data, refreshed, refresh])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const toggle = (kind, name) => {
        setNotice('')
        setSelected((prev) => {
          const list = prev[kind]
          return { ...prev, [kind]: list.includes(name) ? list.filter((item) => item !== name) : [...list, name] }
        })
      }

      const save = async () => {
        setNotice('saving')
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, skills: selected.skills, families: selected.families, plugins: selected.plugins }),
          })
          const payload = await response.json()
          if (!payload?.ok) throw new Error(payload?.error ?? 'failed')
          setData(normalize(payload))
          setNotice('saved')
        } catch {
          setNotice('save-failed')
        }
      }

      const totalSelected = selected.skills.length + selected.families.length + selected.plugins.length

      if (!open) {
        return h(
          'div',
          { style: S.root },
          h(
            'button',
            {
              type: 'button',
              style: merge(S.trigger, hover ? S.triggerHover : undefined),
              onMouseEnter: () => setHover(true),
              onMouseLeave: () => setHover(false),
              onClick: () => setOpen(true),
              'aria-expanded': false,
            },
            h(Chevron, { open: false }),
            h('span', null, TEXT.trigger),
            totalSelected > 0 ? h('span', { style: S.count }, `· ${totalSelected}`) : null,
          ),
        )
      }

      const usage = data.usage ?? {}
      const usedSkills = data.used?.skills ?? []
      const usedTools = data.used?.tools ?? []
      const hasUsage = typeof usage.total === 'number' && usage.total > 0

      const tabs = [
        { id: 'skills', label: TEXT.tabSkills, count: data.skills?.length ?? 0 },
        { id: 'plugins', label: TEXT.tabPlugins, count: data.plugins?.length ?? 0 },
        { id: 'abilities', label: TEXT.tabAbilities, count: data.families?.length ?? 0 },
        { id: 'usage', label: TEXT.tabUsage, count: 0 },
      ]

      const body = () => {
        if (status === 'loading') return h('div', { style: S.note }, '…')
        if (status === 'error') return h('div', { style: S.error }, TEXT.failed)

        if (tab === 'skills') {
          if (data.skills.length === 0) return h('div', { style: S.note }, TEXT.emptySkills)
          return h(
            'div',
            { style: S.list },
            ...data.skills.map((skill) =>
              h(CheckRow, {
                key: skill.name,
                id: skill.name,
                title: skill.name,
                description: skill.description,
                badge: usedSkills.includes(skill.name) ? TEXT.used : undefined,
                checked: selected.skills.includes(skill.name),
                onToggle: (name) => toggle('skills', name),
              }),
            ),
          )
        }

        if (tab === 'plugins') {
          if (data.plugins.length === 0) return h('div', { style: S.note }, TEXT.emptyPlugins)
          return h(
            'div',
            { style: S.list },
            ...data.plugins.map((plugin) =>
              h(CheckRow, {
                key: plugin.name,
                id: plugin.name,
                title: plugin.title ?? plugin.name,
                description: plugin.description,
                checked: selected.plugins.includes(plugin.name),
                onToggle: (name) => toggle('plugins', name),
              }),
            ),
          )
        }

        if (tab === 'abilities') {
          if (data.families.length === 0) return h('div', { style: S.note }, TEXT.emptyAbilities)
          return h(
            'div',
            { style: S.list },
            ...data.families.map((family) =>
              h(CheckRow, {
                key: family.name,
                id: family.name,
                title: family.name,
                description: `${family.count} · ${family.sample}`.trim(),
                checked: selected.families.includes(family.name),
                onToggle: (name) => toggle('families', name),
              }),
            ),
          )
        }

        return h(
          'div',
          null,
          hasUsage
            ? h(
                'div',
                { style: S.stats },
                h('div', { style: S.stat }, h('span', { style: S.big }, num(usage.total)), h('span', { style: S.label }, TEXT.tokens)),
                h('div', { style: S.stat }, h('span', { style: S.mid }, num(usage.input)), h('span', { style: S.label }, TEXT.input)),
                h('div', { style: S.stat }, h('span', { style: S.mid }, num(usage.output)), h('span', { style: S.label }, TEXT.output)),
                usage.window > 0
                  ? h(
                      'div',
                      { style: S.stat },
                      h('span', { style: S.mid }, `${Math.round((usage.pressure / usage.window) * 100)}%`),
                      h('span', { style: S.label }, TEXT.context),
                    )
                  : null,
              )
            : h('div', { style: S.note }, TEXT.noUsage),
          h(
            'div',
            { style: S.group },
            h('div', { style: S.label }, TEXT.usedSkills),
            h(
              'div',
              { style: S.chips },
              usedSkills.length === 0
                ? h('span', { style: S.note }, TEXT.none)
                : usedSkills.map((name) => h('span', { key: name, style: S.chip }, name)),
            ),
          ),
          h(
            'div',
            { style: S.group },
            h('div', { style: S.label }, TEXT.usedTools),
            h(
              'div',
              { style: S.chips },
              usedTools.length === 0
                ? h('span', { style: S.note }, TEXT.none)
                : usedTools.map((tool) => h('span', { key: tool.name, style: S.chip }, `${tool.name} ×${tool.count}`)),
            ),
          ),
        )
      }

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.panel, role: 'region', 'aria-label': TEXT.title },
          h(
            'div',
            { style: S.head },
            h('span', { style: S.title }, TEXT.title),
            h(
              'button',
              { type: 'button', style: S.btn, onClick: () => setOpen(false), title: TEXT.close, 'aria-label': TEXT.close },
              h(CloseIcon),
              h('span', { style: { marginInlineStart: '4px' } }, TEXT.close),
            ),
          ),
          h('div', { style: S.hint }, TEXT.hint),
          h(
            'div',
            { style: S.tabs, role: 'tablist' },
            ...tabs.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab === item.id,
                  style: merge(S.tab, tab === item.id ? S.tabOn : undefined),
                  onClick: () => setTab(item.id),
                },
                item.label,
                item.count > 0 ? h('span', { style: S.tabCount }, item.count) : null,
              ),
            ),
          ),
          h('div', { style: S.body }, body()),
          h(
            'div',
            { style: S.foot },
            h(
              'div',
              { style: S.actions },
              h(
                'button',
                {
                  type: 'button',
                  style: merge(merge(S.btn, S.primary), notice === 'saving' ? S.off : undefined),
                  onClick: save,
                  disabled: notice === 'saving',
                },
                notice === 'saving' ? TEXT.saving : `${TEXT.apply}${totalSelected > 0 ? ` (${totalSelected})` : ''}`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.btn,
                  onClick: () => {
                    setSelected({ skills: [], families: [], plugins: [] })
                    setNotice('')
                  },
                },
                TEXT.clear,
              ),
              h('button', { type: 'button', style: S.btn, onClick: () => void load() }, TEXT.reload),
            ),
            notice === 'saved'
              ? h('span', { style: S.note }, TEXT.saved)
              : notice === 'save-failed'
                ? h('span', { style: S.error }, TEXT.saveFailed)
                : null,
          ),
        ),
      )
    }

    /**
     * 只按 sessionId 重渲染。
     *
     * 这个插槽的属性里带着输入框状态，用户每敲一个字都会推一次新 props；
     * 不拦的话面板会跟着输入法一起重渲染 —— 打字时的卡顿就是这么来的。
     * 面板自己需要的数据全部来自它自己的 state，所以只认 sessionId 就够了。
     */
    const MemoPanel = React.memo(SkillRouterPanel, (prev, next) => prev?.sessionId === next?.sessionId)

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: CELL_ID, order: CELL_ORDER }, MemoPanel),
        )
      },
    }
  },
})
