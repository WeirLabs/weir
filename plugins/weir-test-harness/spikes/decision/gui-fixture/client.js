window.__ModuleLoader__.load({
  id: 'weir-decision-gui-fixture',
  factory(require) {
    return {
      inject: ['slots', 'layout', 'uiWorkspace'],
      apply(ctx) {
        async function fixture(method, args = {}) {
          const connection = ctx.get('connection')
          if (!connection?.rpc?.call) throw new Error('QA raw RPC connection unavailable')
          const result = await connection.rpc.call('/api', `weirDecisionGuiFixture/${method}`, { args: { args } })
          if (result?.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? 'QA fixture call failed')
          return result?.ok === true ? result.value : result
        }
        const decisionControls = []
        let controlSequence = 0
        let originalRpcCall = null
        let controlledConnection = null
        function decisionControlState() {
          return decisionControls.map(control => ({ id: control.id, method: control.method, args: control.args ?? null, action: control.action, used: control.used, started: control.started, released: control.released, settled: control.settled }))
        }
        function ensureDecisionControls() {
          const connection = ctx.get('connection')
          if (!connection?.rpc?.call) throw new Error('Decision RPC connection unavailable')
          if (controlledConnection === connection) return connection
          if (controlledConnection) throw new Error('Decision RPC connection changed while UIUX controls were active')
          originalRpcCall = connection.rpc.call
          async function controlledCall(...callArgs) {
            const endpoint = callArgs[1]
            if (typeof endpoint !== 'string' || !endpoint.startsWith('weirDecision/')) return originalRpcCall.apply(this, callArgs)
            const method = endpoint.slice('weirDecision/'.length)
            const args = callArgs[2]?.args?.args ?? {}
            const control = decisionControls.find(control => !control.used && control.method === method && (control.args === undefined || JSON.stringify(control.args) === JSON.stringify(args)))
            if (!control) return originalRpcCall.apply(this, callArgs)
            control.used = true
            control.started = true
            if (control.action==='fail') {
              control.settled = true
              return { ok: false, error: { code: 'WEIR_UIUX_INJECTED_FAILURE', message: `Isolated UIUX ${method} failure` } }
            }
            const pending = originalRpcCall.apply(this, callArgs)
            pending.catch(() => {})
            if (control.action==='hold'||control.action==='hold-fail') await new Promise(resolve => { control.release = resolve })
            try {
              if (control.action==='hold-fail') {
                control.settled = true
                return { ok: false, error: { code: 'WEIR_UIUX_INJECTED_FAILURE', message: `Isolated UIUX ${method} failure` } }
              }
              const result = await pending
              if (control.action==='delivery-unavailable') {
                // The undelivered branch is the Host's terminal answer for an
                // unresumable source session; this stub keeps the real Case action
                // and rewrites only the reported delivery, so the page's inline
                // notice is exercised on a real Desktop surface.
                const clone = structuredClone(result)
                const service = clone?.value
                const closed = service?.ok === true ? service.value : service
                if (!closed || typeof closed !== 'object') throw new Error('delivery-unavailable control requires a Case payload')
                closed.delivery = { state: 'unavailable' }
                control.settled = true
                return clone
              }
              if (control.action==='unknown-auto') {
                const clone = structuredClone(result)
                const service = clone?.value
                const overview = service?.ok === true ? service.value : service
                if (!overview || typeof overview !== 'object') throw new Error('unknown-auto control requires an overview payload')
                overview.auto = null
                control.settled = true
                return clone
              }
              control.settled = true
              return result
            } catch (error) {
              control.settled = true
              throw error
            }
          }
          connection.rpc.call=controlledCall
          controlledConnection = connection
          return connection
        }
        function controlDecision(spec) {
          ensureDecisionControls()
          if (!spec || typeof spec.method !== 'string' || !['fail', 'hold', 'hold-fail', 'unknown-auto', 'delivery-unavailable'].includes(spec.action)) throw new Error('Invalid isolated Decision RPC control')
          const control = { id: `uiux-rpc-${++controlSequence}`, method: spec.method, args: spec.args, action: spec.action, used: false, started: false, released: false, settled: false, release: null }
          decisionControls.push(control)
          return control.id
        }
        function releaseDecisionControl(id) {
          const control = decisionControls.find(item => item.id === id && (item.action === 'hold' || item.action === 'hold-fail'))
          if (!control) throw new Error(`Unknown Decision hold: ${id}`)
          if (!control.released) { control.released = true; control.release?.() }
          return decisionControlState()
        }
        async function decision(method, args = {}) {
          const connection = ensureDecisionControls()
          return connection.rpc.call('/api', `weirDecision/${method}`, { args: { args } })
        }
        async function createSession(args) {
          const created = await fixture('createSession', args)
          const sessionId = created.sessionId
          await openSession(sessionId)
          return created
        }
        async function openSession(sessionId) {
          const currentSessionId = ctx.uiWorkspace.mainReference?.sessionId ?? ctx.uiWorkspace.selection?.getSnapshot?.().sessionId ?? null
          if (currentSessionId && currentSessionId !== sessionId) await ctx.uiWorkspace.sessions.using(currentSessionId, { source: 'decisionQA' }, async () => {})
          ctx.uiWorkspace.openSession(sessionId)
          await ctx.uiWorkspace.sessions.using(sessionId, { source: 'decisionQA' }, async () => {})
          ctx.layout.selectPanel(null)
        }
        function selectDecisions() { ctx.layout.selectPanel('weir-decisions') }
        function getState() {
          const sessions = ctx.uiWorkspace.sessions?.list?.getSnapshot?.()
          return {
            activeSessionId: Object.values(sessions?.byId ?? {}).find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id ?? null,
            activePanelId: ctx.layout.panelInfo.getSnapshot().activePanelId ?? null,
            sidebar: ctx.slots.entries('sidebar.panellist').map(entry => entry.options.id),
            main: ctx.slots.entries('main').map(entry => entry.options.key),
            composer: ctx.slots.entries('conversation.input.right').map(entry => entry.options.id),
            toolviews: ctx.slots.entries('tool.call.toolview').map(entry => entry.options.key),
          }
        }
        window.__decisionQA = { fixture, decision, createSession, openSession, selectDecisions, getState, controlDecision, releaseDecisionControl, decisionControlState }
        ctx.on('dispose', () => {
          for (const control of decisionControls) if ((control.action === 'hold' || control.action === 'hold-fail') && !control.released) { control.released = true; control.release?.() }
          if (controlledConnection && originalRpcCall) controlledConnection.rpc.call=originalRpcCall
          delete window.__decisionQA
        })
      },
    }
  },
})
