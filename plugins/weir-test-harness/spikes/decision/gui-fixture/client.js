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
        async function decision(method, args = {}) {
          const connection = ctx.get('connection')
          if (!connection?.rpc?.call) throw new Error('Decision RPC connection unavailable')
          return connection.rpc.call('/api', `weirDecision/${method}`, { args: { args } })
        }
        async function createSession(args) {
          const created = await fixture('createSession', args)
          const sessionId = created.sessionId
          await openSession(sessionId)
          return created
        }
        async function openSession(sessionId) {
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
        window.__decisionQA = { fixture, decision, createSession, openSession, selectDecisions, getState }
        ctx.on('dispose', () => { delete window.__decisionQA })
      },
    }
  },
})
