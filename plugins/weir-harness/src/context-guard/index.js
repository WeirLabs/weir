// One native maintenance opportunity per planned request. No retry timers,
// synthetic provider overflows, or interception of Agent.cancel.
import { randomUUID } from 'node:crypto'
import { computePressure, createPressureState, PRESSURE_DEFAULTS, renderAdvisory, RESUME_AFTER_COMPACTION } from './pressure.js'
import { classifyCompactionOutcome } from './compaction-outcome.js'
import { userTextMessage } from '../shared/user-message.js'
import { isGenuineUserMessage, overlayConfig } from '../shared/runtime-messages.js'
import { createAudit, AUDIT_TYPES } from '../shared/audit.js'

const name = 'weir-context-guard'
const inject = ['tools', 'agents', 'tokenMeter', 'compaction', 'llm']
const COMPACT_CONTEXT_DESCRIPTION = `Request native history compaction after saving key state at a safe subtask boundary. This call ends the turn and only queues a request, not a completed summary. A confirmed summary resumes the task once. If maintenance is busy or another wake wins, the request is blocked without background retry; wait for genuine user input before requesting again.`

function apply(ctx, config = {}) {
  const audit = createAudit(ctx)
  const states = new Map() // Agent identity, not reusable session id.
  let disposed = false
  function stateOf(agent) {
    let state = states.get(agent)
    if (!state) {
      state = { key: '', version: 0, measurement: 0, pressure: createPressureState(), request: null, blocked: false, notice: null }
      states.set(agent, state)
    }
    return state
  }
  const live = (agent) => !disposed && ctx.agents.get(agent.id) === agent
  const pending = (request) => request && ['requested', 'waiting-boundary', 'attempting'].includes(request.kind)
  function record(agent, request, kind, details = {}) {
    audit(agent.session, AUDIT_TYPES.compaction, { requestId: request.id, sources: [...request.sources], kind, ...details })
  }
  function settle(agent, state, kind, details = {}) {
    const request = state.request
    if (!pending(request)) return
    request.kind = kind
    request.detach?.()
    if (kind !== 'applied') {
      request.controller.abort({ kind: 'hook', reason: `planned compaction ${kind}` })
      state.blocked = true
      state.notice = `Planned compaction ${kind} (${request.id}). ${details['reason'] ?? 'No confirmed summary is available.'} No background retry is scheduled. You may request a new compaction after this genuine user interaction.`
    }
    record(agent, request, kind, details)
  }
  function fresh(agent) {
    const state = stateOf(agent)
    const opts = overlayConfig(ctx, 'contextGuard', config, { defaults: PRESSURE_DEFAULTS })
    if (!Number.isFinite(opts.softThreshold) || !Number.isFinite(opts.hardThreshold) || !(0 < opts.softThreshold && opts.softThreshold < opts.hardThreshold && opts.hardThreshold < 1)) {
      settle(agent, state, 'cancelled', { reason: 'Invalid guard thresholds: require 0 < softThreshold < hardThreshold < 1.' })
      throw new Error('Context guard requires 0 < softThreshold < hardThreshold < 1')
    }
    const route = agent.session.requestContext?.() ?? {}
    const key = JSON.stringify([opts.enabled, opts.softThreshold, opts.hardThreshold, route.provider, route.model, route.contextWindow])
    if (state.key !== key) {
      if (state.key) settle(agent, state, 'cancelled', { reason: 'Guard configuration or model route changed.' })
      state.key = key
      state.version++
      state.pressure = createPressureState(opts)
    }
    return { state, opts, route }
  }
  function bindAbort(agent, state, signal) {
    if (!signal) return () => {}
    const abort = () => settle(agent, state, 'cancelled', { reason: 'Active work was interrupted.' })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    return () => signal.removeEventListener('abort', abort)
  }
  function request(agent, source, signal) {
    const { state, opts } = fresh(agent)
    if (!live(agent) || !opts.enabled || state.blocked || signal?.aborted) return null
    if (pending(state.request)) { state.request.sources.add(source); return state.request }
    state.request = {
      id: randomUUID(), kind: 'requested', sources: new Set([source]),
      acceptedSeq: agent.session.seq, generation: agent.session.surface?.replaceGeneration,
      version: state.version, controller: new AbortController(), ended: false, delivered: false,
    }
    state.request.detach = bindAbort(agent, state, signal)
    record(agent, state.request, 'requested')
    return state.request
  }
  async function evaluate(agent, boundary, signal) {
    if (!live(agent)) return
    const { state, opts, route } = fresh(agent)
    if (!opts.enabled || state.blocked || signal?.aborted) return
    const version = state.version, measurement = ++state.measurement
    const generation = agent.session.surface?.replaceGeneration
    const tokens = ctx.tokenMeter.measure(agent.session).totalTokens
    let window = route.contextWindow
    if (!window && route.provider && route.model) window = (await ctx.llm.resolveModelInfo(route.provider, route.model))?.context?.contextWindow
    fresh(agent)
    if (!live(agent) || version !== state.version || measurement !== state.measurement || generation !== agent.session.surface?.replaceGeneration || signal?.aborted) return
    const pressure = computePressure(tokens, window)
    const decision = state.pressure.evaluate(pressure, boundary)
    if (decision.kind === 'force') request(agent, 'hard', signal)
    // The awaited pre-step waterfall delivers advisories without append reentry.
    if (decision.kind === 'advise' && !pending(state.request)) return renderAdvisory(pressure)
  }
  async function evaluateBoundary(agent, signal) {
    await evaluate(agent, 'turn', signal)
    const state = stateOf(agent)
    if (pending(state.request) && state.request.kind === 'requested') state.request.kind = 'waiting-boundary'
  }
  function deliver(agent, state) {
    const request = state.request
    if (!live(agent) || request?.kind !== 'applied' || request.delivered) return
    fresh(agent)
    if (request.controller.signal.aborted || ctx.get?.('weirEditLock')?.blocksContinuation?.(agent)) {
      state.blocked = true
      request.delivered = true
      record(agent, request, 'resume-blocked')
      return
    }
    request.delivered = true // Before publication, which may reenter hooks.
    try { agent.followup(userTextMessage(RESUME_AFTER_COMPACTION, 'weir-context-guard')) }
    catch (error) {
      state.blocked = true
      state.notice = 'Compaction produced a summary, but continuation delivery was unconfirmed. Inspect the summary and continue manually; compaction will not be repeated.'
      record(agent, request, 'resume-blocked', { reason: String(error) })
    }
  }
  function attempt(agent) {
    const { state, opts, route } = fresh(agent)
    const current = state.request
    if (!live(agent) || !opts.enabled || !pending(current) || !current.ended || current.kind === 'attempting') return
    current.kind = 'attempting'
    let result
    try {
      // No await before DSH admission. Public idle is only an opportunity.
      result = ctx.compaction.compactNow({
        session: agent.session,
        options: { provider: route.provider, model: route.model },
        runMaintenance: (job) => agent.runMaintenance(async (signal) => {
          const detach = bindAbort(agent, state, signal)
          try { return await job(signal) } finally { detach() }
        }),
      }, current.controller.signal)
    } catch (error) { failed(error); return }
    Promise.resolve(result).then((result) => {
      if (!live(agent)) return
      fresh(agent)
      if (state.request !== current || !pending(current)) return
      if (result == null) { settle(agent, state, 'noop', { reason: 'DSH found no safe useful range; no summary was created.' }); return }
      if (result.summarySeq === undefined) { settle(agent, state, 'failed', { reason: 'DSH returned no verifiable summary sequence.' }); return }
      settle(agent, state, 'applied', { summarySeq: result.summarySeq, compactionId: result.compactionId })
      deliver(agent, state)
      // Never reset hysteresis on success: only a low reading rearms it.
    }, failed)
    function failed(error) {
      if (!live(agent) || state.request !== current || !pending(current)) return
      if (classifyCompactionOutcome(error) === 'busy') settle(agent, state, 'blocked', { reason: 'DSH maintenance was busy; the request remains unfinished.' })
      else {
        settle(agent, state, 'failed', { reason: String(error?.message ?? error), uncertain: ['commit', 'persistence'].includes(error?.code) })
        ctx.logger?.warn?.(`context-guard: compaction failed: ${error?.message ?? error}`)
      }
    }
  }
  ctx.reflect.provide('weirCompactionCoordinator', {
    evaluateBoundary,
    blocksContinuation: (agent) => { const { state } = fresh(agent); return state.blocked || !!pending(state.request) },
  })
  ctx.on('agent/turn-stopping', ({ agent, signal }) => evaluateBoundary(agent, signal))
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') attempt(agent) })
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const state = stateOf(agent)
    let notice
    if (messages.some(isGenuineUserMessage)) {
      notice = state.notice
      state.notice = null
      state.blocked = false
    }
    const advisory = await evaluate(agent, 'step', signal)
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const text = notice ?? advisory
    return text ? { ...decision, messages: [...decision.messages, userTextMessage(text, 'weir-context-guard')] } : decision
  })
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id)
    if (!agent || agent.session !== session) return
    const state = stateOf(agent), current = state.request
    if (!pending(current)) return
    if (event.type === 'turn/end') {
      if (event.data?.reason?.kind === 'aborted') settle(agent, state, 'cancelled', { reason: 'Turn interrupted.' })
      else current.ended = true
    } else if (event.type === 'turn/start' && current.ended && current.kind !== 'attempting') {
      settle(agent, state, 'blocked', { reason: 'Another wake reached the next turn before maintenance.' })
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (state) settle(agent, state, 'cancelled', { reason: 'Agent disposed.' })
    states.delete(agent)
  })
  ctx.on('loader/volatile-update', () => { for (const agent of states.keys()) fresh(agent) })
  ctx.tools.register({
    name: 'compact_context', description: COMPACT_CONTEXT_DESCRIPTION,
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(_args, exec) {
      if (!exec.agent) throw new Error('compact_context requires an owning agent session')
      const accepted = request(exec.agent, 'model', exec.signal)
      if (!accepted) return { queued: false, text: 'Compaction not scheduled: guard disabled, interrupted, or blocked pending genuine user input.' }
      exec.concludeTurn?.()
      return { queued: true, requestId: accepted.id, text: `Compaction request ${accepted.id} queued, not completed. The turn will end. If maintenance is busy or another wake wins, it will be blocked without background retry.` }
    },
  })
  return () => {
    disposed = true
    for (const [agent, state] of states) settle(agent, state, 'cancelled', { reason: 'Coordinator disposed.' })
    states.clear()
  }
}
export { name, inject, apply }
