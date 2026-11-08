window.__ModuleLoader__.load({
  id: 'weir-decision-desktop-spike',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        const panelId = 'weir-decision-spike'
        let disposers = []
        let mounts = 0
        let lastComposerSessionId = null
        let lastError = null

        function selectPanel() {
          ctx.layout.selectPanel(panelId)
        }

        function PanelIcon() {
          return h('button', {
            id: 'decision-spike-panel-button', type: 'button', onClick: selectPanel,
            'aria-label': 'Open decision spike panel',
            style: { color: 'var(--dsw-alias-foreground)', background: 'transparent', border: 0, cursor: 'pointer' },
          }, 'D')
        }

        function Page() {
          const [revision, setRevision] = React.useState(0)
          return h('main', { id: 'decision-spike-page', style: { padding: 24, color: 'var(--dsw-alias-foreground)' } },
            h('h1', null, 'Decision spike panel'),
            h('p', { 'data-mounts': mounts }, `Panel mounted ${mounts} time(s)`),
            h('button', {
              id: 'decision-spike-remount', type: 'button',
              onClick: () => { window.__decisionSpike.remount(); setRevision(revision + 1) },
            }, 'Remount spike surfaces'),
            lastError ? h('pre', { role: 'alert' }, lastError) : null,
          )
        }

        function Composer(props) {
          return h('button', { id: 'decision-spike-composer', type: 'button', 'data-session-id': props.sessionId ?? '' },
            `Off · ${props.sessionId ?? 'no-session'}`)
        }

        function mount() {
          mounts++
          disposers = [
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
              name: 'sidebar.panellist', id: panelId, order: 12, label: () => 'Decision spike',
            }, PanelIcon)),
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, Page)),
            ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
              name: 'conversation.input.right', id: 'weir-decision-spike-selector', order: 90,
              inject: sessionId => {
                lastComposerSessionId = sessionId ?? null
                return sessionId ? { sessionId } : {}
              },
            }, Composer)),
          ]
        }

        window.__decisionSpike = {
          selectPanel,
          remount() {
            lastError = null
            try {
              for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
              disposers = []
              mount()
            } catch (error) {
              lastError = String(error?.stack ?? error)
            }
            return this.getState()
          },
          getState() {
            return {
              mounts, lastError, lastComposerSessionId,
              activePanelId: ctx.layout.panelInfo.getSnapshot().activePanelId ?? null,
              sidebar: ctx.slots.entries('sidebar.panellist').map(entry => ({ id: entry.options.id, key: entry.options.key ?? null })),
              main: ctx.slots.entries('main').map(entry => ({ id: entry.options.id ?? null, key: entry.options.key ?? null })),
              composer: ctx.slots.entries('conversation.input.right').map(entry => ({ id: entry.options.id, key: entry.options.key ?? null })),
            }
          },
        }
        mount()
        ctx.on('dispose', () => {
          for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
          delete window.__decisionSpike
        })
      },
    }
  },
})
