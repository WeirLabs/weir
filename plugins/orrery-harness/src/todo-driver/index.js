// Orrery todo driver: continues the session while todos remain unfinished.
// Normal continuation steers at the sanctioned agent/turn-stopping boundary;
// the provider-error path schedules a counted, delayed Agent.followup from a
// timer (never inside an event dispatch — session appends reject reentry).
// Plain ESM, ctx-only.
import { createContinuationState, DEFAULTS, isProviderError, renderContinuation } from './state-machine.js'
import { createAudit } from '../shared/audit.js'
import { userTextMessage } from '../shared/user-message.js'

const name = 'orrery-todo-driver'
const inject = ['tools', 'agents']

const STOP_CONTINUATION_DESCRIPTION = `Stop the todo continuation driver for this session. Call this ONLY when remaining todos are genuinely blocked: a decision only the user can make, a missing credential or permission, or repeated identical failures. Provide the concrete reason. Continuation stays off until the user's next message.`

function apply(ctx, config = {}) {
  const audit = createAudit(ctx)
  const opts = { ...DEFAULTS, ...config }
  /** Per-session continuation states. */
  const states = new Map()
  /** Per-session pending delayed-continuation timer handles. */
  const timers = new Map()
  /** Sessions whose current/last turn errored on a provider failure. */
  const providerErrorPending = new Map()

  function stateOf(sessionId) {
    let state = states.get(sessionId)
    if (!state) {
      state = createContinuationState(opts)
      states.set(sessionId, state)
    }
    return state
  }

  function remainingTodos(session) {
    const projections = ctx.get('sessionProjections')
    if (projections) {
      const todos = projections.stateOf(session, 'todos')
      if (Array.isArray(todos)) return todos.filter((todo) => todo.status !== 'completed').map((todo) => todo.content)
    }
    // Fallback: replay the last todo/write event from the in-memory log.
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event.type === 'todo/write' && Array.isArray(event.data?.todos)) {
        return event.data.todos.filter((todo) => todo.status !== 'completed').map((todo) => todo.content)
      }
    }
    return []
  }

  function cancelTimer(sessionId) {
    const handle = timers.get(sessionId)
    if (handle !== undefined) {
      clearTimeout(handle)
      timers.delete(sessionId)
    }
  }

  /** Delayed followup continuation for the provider-error path. */
  function scheduleRetry(session, delayMs) {
    const fire = () => {
      cancelTimer(session.id)
      const agent = ctx.agents.get(session.id)
      if (!agent) return
      const remaining = remainingTodos(session)
      if (remaining.length === 0) return
      if (!stateOf(session.id).armed) return
      try {
        agent.followup(userTextMessage(renderContinuation(remaining), 'orrery-todo-driver'))
      } catch (error) {
        ctx.logger?.warn?.(`todo-driver: could not queue continuation for "${session.id}": ${error?.message ?? error}`)
      }
    }
    cancelTimer(session.id)
    const setTimer = ctx.setTimeout ?? globalThis.setTimeout
    timers.set(session.id, setTimer(fire, Math.max(0, delayMs)))
  }

  // The sanctioned continuation boundary: steer and the turn runs on.
  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (!opts.enabled) return
    const aborted = signal.aborted
    const cause = aborted ? abortCauseKind(signal.reason) : undefined
    const state = stateOf(agent.id)
    const remaining = remainingTodos(agent.session)
    const decision = state.decideAtTurnStopping({
      todosRemain: remaining.length > 0,
      aborted,
      abortCauseKind: cause,
      providerErrorPending: providerErrorPending.has(agent.id),
    })
    if (decision.kind !== 'continue') return
    try {
      agent.steer(userTextMessage(renderContinuation(remaining), 'orrery-todo-driver'))
    } catch (error) {
      ctx.logger?.warn?.(`todo-driver: could not steer continuation for "${agent.id}": ${error?.message ?? error}`)
    }
  })

  // Mark provider failures as they happen; the turn boundary owns the retry.
  ctx.on('agent/error', ({ agent, error }) => {
    if (isProviderError(error)) providerErrorPending.set(agent.id, error)
  })

  // Bookkeeping from the durable turn/end reason feed.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      // Genuine user input rearms; injected continuations carry our own source kind.
      const sourceKind = event.data?.source?.kind
      if (sourceKind !== 'orrery-todo-driver') {
        cancelTimer(session.id)
        providerErrorPending.delete(session.id)
        stateOf(session.id).onUserMessage()
      }
      return
    }
    if (event.type !== 'turn/end') return
    if (!opts.enabled) return
    const reason = event.data?.reason
    const state = stateOf(session.id)
    const decision = state.decideTurnEnd(reason, remainingTodos(session).length > 0)
    if (reason?.kind !== 'error') providerErrorPending.delete(session.id)
    if (decision.kind === 'continue') {
      scheduleRetry(session, decision.delayMs)
    } else if (decision.kind === 'blocked') {
      audit(session, 'continuation-blocked', { notice: decision.notice })
      ctx.logger?.warn?.(`todo-driver: ${decision.notice}`)
    }
  })

  ctx.tools.register({
    name: 'stop_continuation',
    description: STOP_CONTINUATION_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'The concrete blocker that prevents progress.' },
      },
      required: ['reason'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Continuation stopped: ${value.reason}` }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('stop_continuation requires an owning agent session')
      const reason = typeof args.reason === 'string' && args.reason.trim().length > 0 ? args.reason.trim() : 'unspecified'
      stateOf(exec.agent.id).onStopContinuation(reason)
      cancelTimer(exec.agent.id)
      providerErrorPending.delete(exec.agent.id)
      audit(exec.agent.session, 'continuation-stop', { reason })
      return { stopped: true, reason }
    },
  })

  // Dispose: drop all pending timers.
  return () => {
    for (const handle of timers.values()) clearTimeout(handle)
    timers.clear()
    states.clear()
    providerErrorPending.clear()
  }
}

/** Read the abort cause kind off the turn signal's reason, when present. */
function abortCauseKind(reason) {
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

export { name, inject, apply }
