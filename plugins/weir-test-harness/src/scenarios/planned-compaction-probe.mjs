// Live parent owns the interval; no fake compaction implementation. Competing
// maintenance uses the real idle admission API. Timers below are test watchdogs
// and finite observation windows, never production retries.
import { randomUUID } from 'node:crypto'
import { textOf } from '../message-text.js'
const message = (text, kind = 'user') => ({ id: randomUUID(), role: 'user', source: { kind }, content: [{ type: 'text', text }] })
export function installPlannedCompactionProbe(ctx, tap) {
  if (process.env.WEIR_IT_PLANNED_COMPACTION !== '1') return
  const mode = process.env.WEIR_IT_COMPACTION_MODE ?? 'success'
  const subjects = new Map()
  // This listener is mounted before the product guard, so it can win admission.
  ctx.on('agent/status', ({ agent, status }) => {
    const state = subjects.get(agent.id)
    if (!state || mode !== 'busy' || status !== 'idle' || state.occupied) return
    state.occupied = true
    state.maintenance = agent.runMaintenance(() => new Promise((resolve) => { state.release = resolve }))
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const state = subjects.get(agent.id)
    if (state?.requested && mode === 'wake' && !state.woke) {
      state.woke = true
      agent.followup(message('planned-background-notice', 'jobs'))
    }
    if (state?.requested && mode === 'noop' && !state.reshaped) {
      state.reshaped = true
      // Fixture an external surface rewrite leaving one indivisible node.
      // This is a native user/message replacement, not a synthetic compaction
      // event or mocked null return. The real DSH selector must return null.
      const nodes = agent.session.surface.nodes
      const first = agent.session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
      agent.session.append('user/message', message('planned-noop-only-node', 'weir-it-surface-fixture'), {
        surfaceOp: { op: 'replace', startSeq: nodes[first], endSeq: nodes[nodes.length - 1] },
        sourceEventSeqs: nodes.slice(first),
      })
    }
  })
  ctx.tools.register({
    name: 'planned_compaction_probe', description: 'Run the development-only planned compaction subject to completion.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(_args, exec) {
      const sessionId = `session-${randomUUID()}`, state = { requested: false }
      subjects.set(sessionId, state)
      let finish, fail, handle
      const done = new Promise((resolve, reject) => { finish = resolve; fail = reject })
      const offAudit = ctx.on('weir/compaction', (record) => {
        if (record.session !== sessionId) return
        if (record.data.kind === 'requested') state.requested = true
        if (mode !== 'success' && mode !== 'hard' && ['blocked', 'cancelled', 'noop', 'failed'].includes(record.data.kind)) finish(record.data.kind)
      })
      const off = ctx.on('session/event', (session, event) => {
        if (session.id !== sessionId) return
        if (event.type === 'request/header' && !state.measured) {
          state.measured = true
          const after = event.data.header
          const before = { ...after, tools: after.tools.map((tool) => tool.name !== 'compact_context' ? tool : { ...tool, parameters: { type: 'object', properties: {} }, description: `Compact this session's conversation history into a summary, then continue the task from that summary. Call this when a context-pressure advisory arrives and the current subtask has reached a safe point: persist key state first (plan, findings, evidence paths). The current turn ends at this call; compaction runs at the turn boundary; a continuation resumes the task automatically. Not callable while another compaction is active.` }) }
          const meter = ctx.get('tokenMeter')
          tap({ kind: 'planned-prompt-cost', session: sessionId, before: meter.measure(session, before).totalTokens, after: meter.measure(session, after).totalTokens, basis: 'DSH first-request envelope heuristic; only compact_context schema differs' })
        }
        if (event.type === 'compaction/start' && mode === 'cancel') ctx.agents.get(sessionId).cancel({ kind: 'user' }, { keepInbox: true })
        if (event.type === 'assistant/message' && textOf(event.data.message).includes('planned-subject-finished') && ['success', 'hard'].includes(mode)) finish('applied')
        if (event.type === 'turn/end' && event.data.reason?.kind === 'error') fail(new Error(JSON.stringify(event.data.reason)))
      })
      const timeout = setTimeout(() => fail(new Error('planned subject did not settle within 15s')), 15000)
      try {
        handle = await ctx.agents.create({ sessionId, parentAgent: exec.agent,
          meta: { cwd: exec.agent.session.header.cwd }, agentOptions: { provider: 'mock', model: 'mock-1' } })
        tap({ kind: 'planned-subject', session: sessionId })
        handle.agent.followup(message('planned-compaction-subject'))
        const outcome = await done
        state.release?.()
        await state.maintenance
        await handle.agent.whenIdle()
        if (['busy', 'wake'].includes(mode)) {
          handle.agent.cancel({ kind: 'user' }, { keepInbox: true }) // Real idle Stop is intentionally unobservable.
          await new Promise((resolve) => setTimeout(resolve, 30))
          handle.agent.followup(message('planned-background-notice', 'jobs'))
          await handle.agent.whenIdle()
        }
        tap({ kind: 'planned-outcome', session: sessionId, outcome, mode })
        return { text: 'planned-probe-finished' }
      } catch (error) {
        tap({ kind: 'planned-probe-error', message: String(error) })
        return { text: `planned-probe-finished with error: ${error}` }
      } finally {
        clearTimeout(timeout)
        state.release?.()
        off?.(); offAudit?.()
        subjects.delete(sessionId)
        await handle?.dispose()
      }
    },
  })
}
