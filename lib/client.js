/**
 * lib/client.js — 聊天界面里的「技能与能力」面板（浏览器半区）。
 *
 * 位置：输入框上方 `conversation.input.dock`，和待办、目标、排队提示同一排。
 *
 * 设计取向：这是一块**操作型**界面（Operate），不是展示型。
 * 用的人正在输入框里准备说话，面板只需要让他两秒内完成「挑东西 → 下一轮生效」。
 * 所以：单层表面、细分隔线、清楚的字阶、不抢注意力的颜色；所有颜色都从
 * currentColor 混出来，跟着宿主主题走，不写死任何色值。
 *
 * 它只做三件事：
 *   1. 列出技能（中文说明）和能力族，多选
 *   2. 点「下一轮加载」后由宿主在下一轮真正生效
 *   3. 显示这个会话的真实用量：用了哪些技能/工具、花了多少 token
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
          hint: '勾中的技能会在你下一条消息发出时加载；不勾就由模型自己判断。',
          skills: '技能',
          abilities: '能力',
          usage: '本会话',
          emptySkills: '这个会话没有可加载的技能。',
          emptyAbilities: '没有可单独指名的能力族。',
          apply: '下一轮加载',
          clear: '清空',
          reload: '刷新',
          saving: '保存中',
          saved: '已记下，下一条消息生效',
          failed: '没保存成功，重试一次',
          selected: '已选',
          used: '用过',
          tokens: 'token',
          context: '上下文',
          noUsage: '还没有用量记录',
          usedSkills: '用过的技能',
          usedTools: '用过的工具',
          none: '无',
          close: '收起',
        }
      : {
          trigger: 'Skills & abilities',
          title: 'What goes into the next turn',
          hint: 'Selected skills load when you send your next message. Select nothing and the model decides.',
          skills: 'Skills',
          abilities: 'Abilities',
          usage: 'This session',
          emptySkills: 'No loadable skills in this session.',
          emptyAbilities: 'No ability groups to name individually.',
          apply: 'Load next turn',
          clear: 'Clear',
          reload: 'Refresh',
          saving: 'Saving',
          saved: 'Saved — applies to your next message',
          failed: 'Could not save. Try again.',
          selected: 'selected',
          used: 'used',
          tokens: 'tokens',
          context: 'context',
          noUsage: 'No usage recorded yet',
          usedSkills: 'Skills used',
          usedTools: 'Tools used',
          none: 'none',
          close: 'Close',
        }

    /** 一个 8px 的折角箭头。画出来的，不用字形。 */
    function Chevron({ open }) {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 12 12',
          'aria-hidden': true,
          style: {
            flex: '0 0 auto',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 140ms cubic-bezier(0.2, 0, 0, 1)',
          },
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

    const styles = {
      root: { width: '100%', boxSizing: 'border-box', fontSize: '13px', lineHeight: 1.55 },
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
        border: '1px solid color-mix(in oklab, currentColor 14%, transparent)',
        borderRadius: '10px',
        overflow: 'hidden',
        background: 'color-mix(in oklab, currentColor 3%, transparent)',
      },
      header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', padding: '10px 12px 0' },
      heading: { fontWeight: 600, letterSpacing: '0.01em' },
      hint: { padding: '2px 12px 0', opacity: 0.62, fontSize: '12px' },
      section: { padding: '10px 12px', borderTop: '1px solid color-mix(in oklab, currentColor 10%, transparent)' },
      label: {
        fontSize: '11px',
        letterSpacing: '0.08em',
        opacity: 0.55,
        marginBottom: '6px',
        display: 'flex',
        justifyContent: 'space-between',
      },
      list: { display: 'flex', flexDirection: 'column', gap: '1px' },
      row: {
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
        padding: '5px 6px',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      rowOn: { background: 'color-mix(in oklab, currentColor 8%, transparent)' },
      check: { margin: '3px 0 0', accentColor: 'currentColor', flex: '0 0 auto' },
      body: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
      name: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px', letterSpacing: '-0.01em' },
      desc: { opacity: 0.72, fontSize: '12px' },
      badge: {
        fontSize: '10.5px',
        letterSpacing: '0.02em',
        opacity: 0.5,
        marginInlineStart: '6px',
        whiteSpace: 'nowrap',
      },
      footer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '10px 12px',
        borderTop: '1px solid color-mix(in oklab, currentColor 10%, transparent)',
      },
      actions: { display: 'flex', gap: '4px', alignItems: 'center' },
      button: {
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
      primary: {
        background: 'color-mix(in oklab, currentColor 12%, transparent)',
        opacity: 1,
        fontWeight: 600,
      },
      disabled: { opacity: 0.4, cursor: 'default' },
      note: { fontSize: '11.5px', opacity: 0.65 },
      failed: { fontSize: '11.5px', color: '#d4380d' },
      stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '8px 14px' },
      stat: { display: 'flex', flexDirection: 'column', gap: '0px' },
      statValue: { fontVariantNumeric: 'tabular-nums', fontSize: '14px', letterSpacing: '-0.01em' },
      statLabel: { fontSize: '11px', opacity: 0.55 },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' },
      chip: {
        fontSize: '11px',
        padding: '1px 7px',
        borderRadius: '999px',
        background: 'color-mix(in oklab, currentColor 9%, transparent)',
        opacity: 0.85,
      },
    }

    function merge(base, extra) {
      return extra === undefined ? base : { ...base, ...extra }
    }

    const nf = new Intl.NumberFormat()
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? nf.format(value) : '—')

    function Row({ id, title, description, checked, badge, onToggle }) {
      return h(
        'label',
        { style: merge(styles.row, checked ? styles.rowOn : undefined) },
        h('input', { type: 'checkbox', checked, onChange: () => onToggle(id), style: styles.check }),
        h(
          'span',
          { style: styles.body },
          h(
            'span',
            { style: styles.name },
            title,
            badge ? h('span', { style: styles.badge }, badge) : null,
          ),
          description ? h('span', { style: styles.desc }, description) : null,
        ),
      )
    }

    function Section({ label, right, children }) {
      return h('div', { style: styles.section }, h('div', { style: styles.label }, h('span', null, label), right ?? null), children)
    }

    function SkillRouterPanel(props) {
      const sessionId = props?.sessionId
      const [open, setOpen] = React.useState(false)
      const [status, setStatus] = React.useState('idle')
      const [data, setData] = React.useState({ skills: [], families: [], pinned: { skills: [], families: [] }, usage: {}, used: { skills: [], tools: [] } })
      const [selected, setSelected] = React.useState({ skills: [], families: [] })
      const [notice, setNotice] = React.useState('')
      const [hover, setHover] = React.useState(false)

      const load = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        setStatus('loading')
        try {
          const response = await fetch(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { Accept: 'application/json' } })
          const payload = await response.json()
          if (!payload?.ok) throw new Error(payload?.error ?? 'failed')
          setData(payload)
          setSelected({ skills: payload.pinned?.skills ?? [], families: payload.pinned?.families ?? [] })
          setStatus('ready')
        } catch {
          setStatus('error')
        }
      }, [sessionId])

      React.useEffect(() => {
        if (open) void load()
      }, [open, load])

      const toggle = (kind, name) => {
        setNotice('')
        setSelected((prev) => {
          const list = prev[kind]
          return { ...prev, [kind]: list.includes(name) ? list.filter((item) => item !== name) : [...list, name] }
        })
      }

      const save = async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        setNotice('saving')
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, skills: selected.skills, families: selected.families }),
          })
          const payload = await response.json()
          if (!payload?.ok) throw new Error(payload?.error ?? 'failed')
          setData(payload)
          setNotice('saved')
        } catch {
          setNotice('failed')
        }
      }

      const selectedCount = selected.skills.length + selected.families.length

      if (!open) {
        return h(
          'div',
          { style: styles.root },
          h(
            'button',
            {
              type: 'button',
              style: merge(styles.trigger, hover ? styles.triggerHover : undefined),
              onMouseEnter: () => setHover(true),
              onMouseLeave: () => setHover(false),
              onClick: () => setOpen(true),
              'aria-expanded': false,
            },
            h(Chevron, { open: false }),
            h('span', null, TEXT.trigger),
            selectedCount > 0 ? h('span', { style: styles.count }, `· ${selectedCount}`) : null,
          ),
        )
      }

      const usage = data.usage ?? {}
      const usedSkills = data.used?.skills ?? []
      const usedTools = data.used?.tools ?? []
      const hasUsage = typeof usage.total === 'number' && usage.total > 0

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.panel },
          h(
            'div',
            { style: styles.header },
            h('span', { style: styles.heading }, TEXT.title),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: () => setOpen(false) },
              TEXT.close,
            ),
          ),
          h('div', { style: styles.hint }, TEXT.hint),

          h(
            Section,
            { label: TEXT.skills, right: status === 'ready' ? h('span', { style: styles.count }, data.skills.length) : null },
            status === 'loading'
              ? h('div', { style: styles.note }, '…')
              : status === 'error'
                ? h('div', { style: styles.failed }, TEXT.failed)
                : data.skills.length === 0
                  ? h('div', { style: styles.note }, TEXT.emptySkills)
                  : h(
                      'div',
                      { style: styles.list },
                      ...data.skills.map((skill) =>
                        h(Row, {
                          key: skill.name,
                          id: skill.name,
                          title: skill.name,
                          description: skill.description,
                          badge: usedSkills.includes(skill.name) ? TEXT.used : undefined,
                          checked: selected.skills.includes(skill.name),
                          onToggle: (name) => toggle('skills', name),
                        }),
                      ),
                    ),
          ),

          h(
            Section,
            { label: TEXT.abilities, right: status === 'ready' ? h('span', { style: styles.count }, data.families.length) : null },
            data.families.length === 0
              ? h('div', { style: styles.note }, TEXT.emptyAbilities)
              : h(
                  'div',
                  { style: styles.list },
                  ...data.families.map((family) =>
                    h(Row, {
                      key: family.name,
                      id: family.name,
                      title: family.name,
                      description: `${family.count} · ${family.sample}`.trim(),
                      checked: selected.families.includes(family.name),
                      onToggle: (name) => toggle('families', name),
                    }),
                  ),
                ),
          ),

          h(
            Section,
            { label: TEXT.usage },
            hasUsage
              ? h(
                  'div',
                  { style: styles.stats },
                  h(
                    'div',
                    { style: styles.stat },
                    h('span', { style: styles.statValue }, num(usage.total)),
                    h('span', { style: styles.statLabel }, `${TEXT.tokens}`),
                  ),
                  h(
                    'div',
                    { style: styles.stat },
                    h('span', { style: styles.statValue }, num(usage.input)),
                    h('span', { style: styles.statLabel }, 'in'),
                  ),
                  h(
                    'div',
                    { style: styles.stat },
                    h('span', { style: styles.statValue }, num(usage.output)),
                    h('span', { style: styles.statLabel }, 'out'),
                  ),
                  usage.window
                    ? h(
                        'div',
                        { style: styles.stat },
                        h('span', { style: styles.statValue }, `${Math.round((usage.pressure / usage.window) * 100)}%`),
                        h('span', { style: styles.statLabel }, TEXT.context),
                      )
                    : null,
                )
              : h('div', { style: styles.note }, TEXT.noUsage),
            h(
              'div',
              { style: { marginTop: '8px' } },
              h('div', { style: styles.statLabel }, TEXT.usedSkills),
              h(
                'div',
                { style: styles.chips },
                usedSkills.length === 0
                  ? h('span', { style: styles.note }, TEXT.none)
                  : usedSkills.map((name) => h('span', { key: name, style: styles.chip }, name)),
              ),
              h('div', { style: { ...styles.statLabel, marginTop: '6px' } }, TEXT.usedTools),
              h(
                'div',
                { style: styles.chips },
                usedTools.length === 0
                  ? h('span', { style: styles.note }, TEXT.none)
                  : usedTools.slice(0, 12).map((tool) =>
                      h('span', { key: tool.name, style: styles.chip }, `${tool.name} ×${tool.count}`),
                    ),
              ),
            ),
          ),

          h(
            'div',
            { style: styles.footer },
            h(
              'div',
              { style: styles.actions },
              h(
                'button',
                {
                  type: 'button',
                  style: merge(merge(styles.button, styles.primary), notice === 'saving' ? styles.disabled : undefined),
                  onClick: save,
                  disabled: notice === 'saving',
                },
                notice === 'saving' ? TEXT.saving : TEXT.apply,
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: styles.button,
                  onClick: () => {
                    setSelected({ skills: [], families: [] })
                    setNotice('')
                  },
                },
                TEXT.clear,
              ),
              h('button', { type: 'button', style: styles.button, onClick: () => void load() }, TEXT.reload),
            ),
            notice === 'saved'
              ? h('span', { style: styles.note }, TEXT.saved)
              : notice === 'failed'
                ? h('span', { style: styles.failed }, TEXT.failed)
                : null,
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: CELL_ID, order: CELL_ORDER }, SkillRouterPanel),
        )
      },
    }
  },
})
