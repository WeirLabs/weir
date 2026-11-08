window.__ModuleLoader__.load({
  id: 'weir-decision-p0-current-profile',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    return {
      inject: ['slots', 'layout', 'uiWorkspace'],
      apply(ctx) {
        const panelId = 'weir-decision-p0'
        const listeners = new Set()
        const snapshots = new Map()
        const created = {}
        let activeSessionId = null
        let lastComposerSessionId = null
        let lastResult = null
        let duplicateOutcome = null
        let subagent = null
        let seeded = null
        let realResult = null
        let mounts = 0
        let disposers = []

        function emit() { for (const listener of listeners) listener() }
        async function call(method, args = {}) {
          const connection = ctx.get('connection')
          if (!connection?.rpc?.call) throw new Error('raw Typert connection unavailable')
          const result = await connection.rpc.call('/api', `weirDecisionP0R2/${method}`, { args: { args } })
          if (result?.ok === true) return result.value
          throw new Error(result?.error?.message ?? result?.error?.code ?? JSON.stringify(result))
        }
        async function refresh(sessionId = activeSessionId) {
          if (!sessionId) return null
          const value = await call('state', { sessionId })
          snapshots.set(sessionId, value)
          emit()
          return value
        }
        function useSnapshot(sessionId) {
          return React.useSyncExternalStore(
            listener => { listeners.add(listener); return () => listeners.delete(listener) },
            () => snapshots.get(sessionId) ?? null,
          )
        }
        async function run(label, action) {
          lastResult = { label, pending: true }
          emit()
          try {
            const value = await action()
            lastResult = { label, pending: false, value }
            await refresh()
            return value
          } catch (error) {
            lastResult = { label, pending: false, error: error?.message ?? String(error) }
            emit()
            return null
          }
        }
        function selectPanel() { ctx.layout.selectPanel(panelId) }
        function openSession(sessionId) { ctx.uiWorkspace.openSession(sessionId); ctx.layout.selectPanel(null) }

        function Selector(props) {
          const data = useSnapshot(props.sessionId)
          React.useEffect(() => { refresh(props.sessionId).catch(() => {}) }, [props.sessionId])
          const mode = data?.selector?.mode ?? 'off'
          return h('button', {
            id: 'decision-p0-selector', type: 'button', 'data-session-id': props.sessionId,
            'data-mode': mode, 'aria-label': 'Decision Agent selector',
            onClick: () => run('selector', async () => {
              const value = await call('setSelector', { sessionId: props.sessionId, mode: mode === 'off' ? 'agent' : 'off' })
              await refresh(props.sessionId)
              return value
            }),
          }, mode === 'off' ? 'Off' : 'Agent A')
        }

        function PanelIcon() {
          return h('button', { id: 'decision-p0-panel-button', type: 'button', onClick: selectPanel, 'aria-label': 'Open decision P0 panel' }, 'D0')
        }

        function ToolCard(props) {
          const data = useSnapshot(props.sessionId)
          React.useEffect(() => { refresh(props.sessionId).catch(() => {}) }, [props.sessionId])
          const cases = data?.cases?.filter(item => item.originSessionId === props.sessionId || item.rootSessionId === props.sessionId) ?? []
          const latest = cases.at(-1)
          return h('section', { id: `decision-p0-row-${props.sessionId}`, 'data-case-id': latest?.caseId ?? '', style: { padding: 8, border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-foreground)' } },
            h('strong', null, 'Decision P0 read-only row'),
            latest ? h('div', { 'data-state': latest.state }, ` ${latest.caseId} · ${latest.state}${latest.closing ? `(${latest.closing})` : ''} · ${latest.feedbackState}`) : null,
            latest?.suggestion?.perQuestion ? h('ul', { id: 'decision-p0-suggestions' }, latest.suggestion.perQuestion.map(item => h('li', { key: item.id, 'data-question-id': item.id }, `${item.id}: ${item.outcome} — ${item.detail}`))) : null,
          )
        }

        function Panel() {
          const data = useSnapshot(activeSessionId)
          React.useEffect(() => { refresh().catch(() => {}) }, [activeSessionId])
          const cases = data?.cases ?? []
          const answered = seeded?.answered ?? cases.find(item => item.closing === 'answered')?.caseId
          const inbox = seeded?.inbox ?? cases.find(item => item.state === 'awaiting_user')?.caseId
          const button = (id, label, action, disabled = false) => h('button', { id, type: 'button', onClick: () => run(label, action), disabled }, label)
          return h('main', { id: 'decision-p0-page', style: { padding: 20, color: 'var(--dsw-alias-foreground)', overflow: 'auto' } },
            h('h1', null, 'Decision P0 evidence fixture'),
            h('p', { id: 'decision-p0-active-session' }, `Session: ${activeSessionId ?? 'none'} · Selector: ${data?.selector?.mode ?? 'unknown'}`),
            h('section', null,
              button('decision-p0-remount', 'Remount surfaces', async () => { window.__decisionP0.remount(); return mounts }),
              button('decision-p0-inspect-before', 'Inspect slots before', () => call('inspectSlots', { sessionId: activeSessionId, phase: 'before' })),
              button('decision-p0-inspect-after', 'Inspect slots after', () => call('inspectSlots', { sessionId: activeSessionId, phase: 'after' })),
              button('decision-p0-duplicate', 'Register duplicate toolview', async () => {
                try {
                  const dispose = ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'ask_user_question' }, ToolCard))
                  duplicateOutcome = { error: null, accepted: true }
                  dispose?.()
                } catch (error) {
                  duplicateOutcome = { error: error?.message ?? String(error), accepted: false }
                }
                emit()
                return duplicateOutcome
              }),
            ),
            h('section', null,
              ...[['answered', 'P0_ANSWERED'], ['off', 'P0_OFF'], ['batch-all', 'P0_BATCH_ALL'], ['batch-partial', 'P0_BATCH_PARTIAL'], ['native', 'P0_NATIVE']].map(([mode, prompt]) =>
                button(`decision-p0-create-${mode}`, `Create ${mode} session`, async () => {
                  const value = await call('createTestSession', { mode, prompt })
                  created[mode] = value.sessionId
                  activeSessionId = value.sessionId
                  emit()
                  return value
                }))),
            h('section', null,
              button('decision-p0-seed-actions', 'Seed remote actions', async () => {
                seeded = await call('seedActions', { sessionId: activeSessionId })
                emit()
                return seeded
              }),
              button('decision-p0-down', 'Rating down', () => call('feedback', { caseId: answered, kind: 'rating_down' }), !answered),
              button('decision-p0-undo', 'Undo rating down', () => call('feedback', { caseId: answered, kind: 'undo_rating_down' }), !answered),
              button('decision-p0-decide', 'Decide inbox case', () => call('decide', { caseId: inbox }), !inbox),
              button('decision-p0-scan-baseline', 'Scan baseline', () => call('sessionScan', { sessionId: activeSessionId, phase: 'baseline' })),
              button('decision-p0-scan-actions', 'Scan after actions', () => call('sessionScan', { sessionId: activeSessionId, phase: 'actions' })),
              button('decision-p0-scan-restart', 'Scan after restart', () => call('sessionScan', { sessionId: activeSessionId, phase: 'restart' })),
            ),
            h('section', null,
              button('decision-p0-real-samples', 'Run 20 real model samples', async () => {
                realResult = await call('runRealSamples', {})
                emit()
                return realResult
              }),
              realResult ? h('span', { id: 'decision-p0-real-result' }, ` ${realResult.sampleCount} samples, ${realResult.failureCount} failures`) : null,
            ),
            h('section', null,
              button('decision-p0-seed-recovery', 'Seed restart recovery', () => call('seedRecovery', { sessionId: activeSessionId })),
              button('decision-p0-create-subagent', 'Create subagent proof', async () => {
                subagent = await call('createSubagent', { sessionId: activeSessionId })
                emit()
                return subagent
              }),
              button('decision-p0-export-subagent', 'Export subagent proof', () => call('exportSubagent', {
                sessionId: subagent?.childId,
                caseId: data?.cases?.find(item => item.originSessionId === subagent?.childId)?.caseId ?? data?.cases?.at(-1)?.caseId,
              }), !subagent),
            ),
            lastResult ? h('pre', { id: 'decision-p0-last-result' }, JSON.stringify(lastResult)) : null,
            duplicateOutcome ? h('pre', { id: 'decision-p0-duplicate-result' }, JSON.stringify(duplicateOutcome)) : null,
            h('div', { id: 'decision-p0-cases' }, cases.map(item => h('div', { key: item.caseId, 'data-case-id': item.caseId }, `${item.caseId} · ${item.state}${item.closing ? `(${item.closing})` : ''} · ${item.awaitingReason ?? ''} · ${item.feedbackState} · attempts=${item.attempts.length}`))),
          )
        }

        function mount() {
          mounts++
          disposers = [
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: 12, label: () => 'Decision P0' }, PanelIcon)),
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, Panel)),
            ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
              name: 'conversation.input.right', id: 'weir-decision-p0-selector', order: 90,
              inject: sessionId => {
                lastComposerSessionId = sessionId ?? null
                if (sessionId) activeSessionId = sessionId
                return sessionId ? { sessionId } : {}
              },
            }, Selector)),
            ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'ask_user_question', priority: -10 }, ToolCard)),
            ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'decision_consult', priority: -10 }, ToolCard)),
          ]
        }

        window.__decisionP0 = {
          call, refresh, selectPanel, openSession,
          remount() {
            for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
            disposers = []
            mount()
            emit()
            return this.getState()
          },
          getState() {
            return {
              mounts, activeSessionId, lastComposerSessionId, created, seeded, subagent, realResult, lastResult, duplicateOutcome,
              activePanelId: ctx.layout.panelInfo.getSnapshot().activePanelId ?? null,
              sidebar: ctx.slots.entries('sidebar.panellist').map(entry => entry.options.id),
              main: ctx.slots.entries('main').map(entry => entry.options.key),
              composer: ctx.slots.entries('conversation.input.right').map(entry => entry.options.id),
              toolviews: ctx.slots.entries('tool.call.toolview').map(entry => entry.options.key),
              currentData: activeSessionId ? snapshots.get(activeSessionId) ?? null : null,
            }
          },
        }
        mount()
        ctx.layout.panelInfo.subscribe(() => { if (ctx.layout.panelInfo.getSnapshot().activePanelId === panelId) refresh().catch(() => {}) })
        ctx.on('dispose', () => {
          for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
          delete window.__decisionP0
        })
      },
    }
  },
})
