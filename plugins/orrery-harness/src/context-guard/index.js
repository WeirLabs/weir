// Orrery context guard: context-pressure monitoring and boundary-safe,
// model-timed compaction. Plain ESM, ctx-only.
import { computePressure, createPressureState, PRESSURE_DEFAULTS, renderAdvisory, RESUME_AFTER_COMPACTION } from './pressure.js'

const name = 'orrery-context-guard'
const inject = ['tools', 'agents', 'tokenMeter', 'compaction', 'llm']

const COMPACT_CONTEXT_DESCRIPTION = `Compact this session's conversation history into a summary, then continue the task from that summary. Call this when a context-pressure advisory arrives and the current subtask has reached a safe point: persist key state first (plan, findings, evidence paths). The current turn ends at this call; compaction runs at the turn boundary; a continuation resumes the task automatically. Not callable while another compaction is active.`

function apply(ctx, config = {}) {
  const opts = { ...PRESSURE_DEFAULTS, ...config }
  /** Per-session pressure hysteresis state. */
  const states = new Map()
  /** Sessions with a model-requested compaction pending at the boundary. */
  const pendingCompactions = new Set()
  /** contextWindow cache per provider/model route. */
  const windowCache = new Map()

  function stateOf(sessionId) {
    let state = states.get(sessionId)
    if (!state) {
      state = createPressureState(opts)
      states.set(sessionId, state)
    }
    return state
  }

  async function contextWindowOf(session) {
    const route = session.requestContext?.()
    if (route?.contextWindow) return route.contextWindow
    if (!route?.provider || !route?.model) return undefined
    const key = `${route.provider}/${route.model}`
    if (windowCache.has(key)) return windowCache.get(key)
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
      const window = info?.context?.contextWindow
      windowCache.set(key, window)
      return window
    } catch {
      windowCache.set(key, undefined)
      return undefined
    }
  }

  async function measurePressure(session) {
    const measurement = ctx.tokenMeter.measure(session)
    const window = await contextWindowOf(session)
    return computePressure(measurement.totalTokens, window)
  }

  async function compactNow(session, origin) {
    const agent = ctx.agents.get(session.id)
    if (!agent) return { kind: 'unavailable' }
    const route = session.requestContext?.()
    try {
      const result = await ctx.compaction.compactNow(
        {
          session,
          options: route ? { provider: route.provider, model: route.model } : {},
          runMaintenance: (job) => agent.runMaintenance(job),
        },
        new AbortController().signal,
      )
      stateOf(session.id).reset()
      try {
        agent.followup([{ type: 'text', text: RESUME_AFTER_COMPACTION }])
      } catch (error) {
        ctx.logger?.warn?.(`context-guard: post-compaction followup failed for "${session.id}": ${error?.message ?? error}`)
      }
      return { kind: 'compacted', result }
    } catch (error) {
      const code = error?.code ?? error?.name ?? 'unknown'
      if (/busy|active|not idle|running/i.test(String(error?.message ?? code))) {
        return { kind: 'busy' }
      }
      ctx.logger?.warn?.(`context-guard: compaction (${origin}) failed for "${session.id}": ${error?.message ?? error}`)
      return { kind: 'failed', error }
    }
  }

  // Soft advisory mid-turn at step boundaries; force + pending at turn end.
  ctx.on('session/event', async (session, event) => {
    if (!opts.enabled) return
    const sessionId = session.id

    if (event.type === 'step/end') {
      const state = stateOf(sessionId)
      const pressure = await measurePressure(session)
      const decision = state.evaluate(pressure, 'step')
      if (decision.kind !== 'advise') return
      const agent = ctx.agents.get(sessionId)
      if (!agent) return
      try {
        agent.inject([{ type: 'text', text: renderAdvisory(pressure) }])
      } catch (error) {
        ctx.logger?.warn?.(`context-guard: advisory injection failed for "${sessionId}": ${error?.message ?? error}`)
      }
      return
    }

    if (event.type !== 'turn/end') return
    const wantsCompact = pendingCompactions.delete(sessionId)
    if (wantsCompact) {
      const outcome = await compactNow(session, 'model')
      if (outcome.kind === 'busy') pendingCompactions.add(sessionId) // retry at the next boundary
      return
    }
    const state = stateOf(sessionId)
    const pressure = await measurePressure(session)
    const decision = state.evaluate(pressure, 'turn')
    if (decision.kind === 'advise') {
      const agent = ctx.agents.get(sessionId)
      if (!agent) return
      try {
        agent.inject([{ type: 'text', text: renderAdvisory(pressure) }])
      } catch (error) {
        ctx.logger?.warn?.(`context-guard: advisory injection failed for "${sessionId}": ${error?.message ?? error}`)
      }
      return
    }
    if (decision.kind !== 'force') return
    await compactNow(session, 'hard-threshold')
  })

  ctx.tools.register({
    name: 'compact_context',
    description: COMPACT_CONTEXT_DESCRIPTION,
    parameters: {},
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      if (!exec.agent) throw new Error('compact_context requires an owning agent session')
      const session = exec.agent.session
      if (!opts.enabled) return { queued: false, text: 'Context guard is disabled; compaction was not scheduled.' }
      pendingCompactions.add(session.id)
      // End the current turn so compaction can run at the boundary.
      exec.concludeTurn?.()
      return {
        queued: true,
        text: 'Compaction scheduled at the turn boundary. The task continues automatically afterwards from the compaction summary.',
      }
    },
  })

  return () => {
    states.clear()
    pendingCompactions.clear()
    windowCache.clear()
  }
}

export { name, inject, apply }
