/**
 * lib/client.js — 聊天界面里的「技能路由」面板（浏览器半区）。
 *
 * 位置：输入框上方的整宽插槽 `conversation.input.dock`。
 * 为什么放这儿：它和「这一轮要带什么进去」是同一件事，就该和输入框在一起，
 * 而不是藏在设置里翻三层。
 *
 * 它只做三件事：
 *   1. 把当前会话能用的技能列出来（来自宿主路由，不是硬编码）
 *   2. 让用户勾选，可以多选
 *   3. 勾完点「下一轮加载」，宿主会在下一轮开头真正把正文加载进去
 *
 * 为什么是「下一轮」而不是立刻：技能正文只有在模型准备动手的那一刻才有意义，
 * 提前塞进去只会变成历史噪声。这一点在面板上是明说的，不让人猜。
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
          open: '技能',
          title: '本轮要带哪些技能',
          hint: '勾中的技能会在你下一条消息发出时加载，不是立刻。不勾就由模型自己判断。',
          empty: '这个会话没有可加载的技能。',
          apply: '下一轮加载',
          clear: '清空',
          saving: '保存中…',
          saved: '已记下，下一条消息发出时生效。',
          failed: '没保存成功，请重试。',
          pinned: '已选',
          close: '收起',
          reload: '刷新',
        }
      : {
          open: 'Skills',
          title: 'Skills to load next',
          hint: 'Selected skills load when you send your next message, not now. Load none and the model decides by itself.',
          empty: 'No loadable skills in this session.',
          apply: 'Load next turn',
          clear: 'Clear',
          saving: 'Saving…',
          saved: 'Saved. Takes effect on your next message.',
          failed: 'Could not save. Try again.',
          pinned: 'selected',
          close: 'Close',
          reload: 'Refresh',
        }

    const css = {
      root: { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', boxSizing: 'border-box' },
      bar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      button: {
        appearance: 'none',
        border: '1px solid color-mix(in oklab, currentColor 22%, transparent)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '999px',
        padding: '4px 12px',
        font: 'inherit',
        fontSize: '0.85em',
        cursor: 'pointer',
        lineHeight: 1.4,
      },
      primary: {
        border: '1px solid color-mix(in oklab, currentColor 45%, transparent)',
        background: 'color-mix(in oklab, currentColor 12%, transparent)',
        fontWeight: 600,
      },
      card: {
        border: '1px solid color-mix(in oklab, currentColor 18%, transparent)',
        borderRadius: '12px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        background: 'color-mix(in oklab, currentColor 4%, transparent)',
      },
      hint: { fontSize: '0.8em', opacity: 0.72, lineHeight: 1.5 },
      list: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '220px', overflowY: 'auto' },
      row: {
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
        padding: '4px 2px',
        cursor: 'pointer',
        borderRadius: '6px',
      },
      name: { fontSize: '0.85em', fontWeight: 600, lineHeight: 1.4 },
      desc: { fontSize: '0.78em', opacity: 0.7, lineHeight: 1.45 },
      error: { fontSize: '0.8em', color: '#e5484d' },
      ok: { fontSize: '0.8em', opacity: 0.8 },
      badge: { fontSize: '0.8em', opacity: 0.7 },
    }

    /** 把复选框那一行做成整行可点，省得手机上点不准。 */
    function SkillRow({ skill, checked, onToggle }) {
      return h(
        'label',
        { style: { ...css.row, background: checked ? 'color-mix(in oklab, currentColor 8%, transparent)' : 'transparent' } },
        h('input', {
          type: 'checkbox',
          checked,
          onChange: () => onToggle(skill.name),
          style: { marginTop: '2px', accentColor: 'currentColor' },
        }),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } },
          h('span', { style: css.name }, skill.name),
          skill.description ? h('span', { style: css.desc }, skill.description) : null,
        ),
      )
    }

    function SkillRouterPanel(props) {
      const sessionId = props?.sessionId
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState({ status: 'idle', skills: [], pinned: [] })
      const [selected, setSelected] = React.useState([])
      const [notice, setNotice] = React.useState('')

      const load = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        setState((prev) => ({ ...prev, status: 'loading' }))
        try {
          const response = await fetch(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { Accept: 'application/json' },
          })
          const data = await response.json()
          if (!data?.ok) throw new Error(data?.error ?? 'failed')
          setState({ status: 'ready', skills: data.skills ?? [], pinned: data.pinned ?? [] })
          setSelected(data.pinned ?? [])
        } catch {
          setState({ status: 'error', skills: [], pinned: [] })
        }
      }, [sessionId])

      React.useEffect(() => {
        if (open) void load()
      }, [open, load])

      const toggle = (name) => {
        setNotice('')
        setSelected((prev) => (prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]))
      }

      const save = async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        setNotice('saving')
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, skills: selected }),
          })
          const data = await response.json()
          if (!data?.ok) throw new Error(data?.error ?? 'failed')
          setState((prev) => ({ ...prev, pinned: data.pinned ?? [] }))
          setNotice('saved')
        } catch {
          setNotice('failed')
        }
      }

      if (!open) {
        const count = state.pinned.length
        return h(
          'div',
          { style: css.bar },
          h(
            'button',
            { type: 'button', style: css.button, onClick: () => setOpen(true), title: TEXT.title },
            `${TEXT.open}${count > 0 ? ` · ${count} ${TEXT.pinned}` : ''}`,
          ),
        )
      }

      return h(
        'div',
        { style: css.root },
        h(
          'div',
          { style: css.card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
            h('strong', { style: { fontSize: '0.9em' } }, TEXT.title),
            h('button', { type: 'button', style: css.button, onClick: () => setOpen(false) }, TEXT.close),
          ),
          h('div', { style: css.hint }, TEXT.hint),
          state.status === 'loading' ? h('div', { style: css.hint }, '…') : null,
          state.status === 'error' ? h('div', { style: css.error }, TEXT.failed) : null,
          state.status === 'ready' && state.skills.length === 0 ? h('div', { style: css.hint }, TEXT.empty) : null,
          state.status === 'ready' && state.skills.length > 0
            ? h(
                'div',
                { style: css.list },
                ...state.skills.map((skill) =>
                  h(SkillRow, { key: skill.name, skill, checked: selected.includes(skill.name), onToggle: toggle }),
                ),
              )
            : null,
          h(
            'div',
            { style: { ...css.bar, justifyContent: 'space-between' } },
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h(
                'button',
                { type: 'button', style: { ...css.button, ...css.primary }, onClick: save, disabled: notice === 'saving' },
                notice === 'saving' ? TEXT.saving : TEXT.apply,
              ),
              h('button', { type: 'button', style: css.button, onClick: () => { setSelected([]); setNotice('') } }, TEXT.clear),
              h('button', { type: 'button', style: css.button, onClick: () => void load() }, TEXT.reload),
            ),
            notice === 'saved' ? h('span', { style: css.ok }, TEXT.saved) : null,
            notice === 'failed' ? h('span', { style: css.error }, TEXT.failed) : null,
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
