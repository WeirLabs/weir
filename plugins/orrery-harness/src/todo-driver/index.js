// Orrery todo driver: continues the session while todos remain unfinished.
// Driven by the durable turn/end reason feed (session/event), continuations
// are Agent.followup prompts; provider errors get counted, delayed retries.
// Plain ESM, ctx-only.
import { createContinuationState, DEFAULTS, renderContinuation } from './state-machine.js'

const name = 'orrery-todo-driver'
const inject = ['tools', 'agents']

const STOP_CONTINUATION_DESCRIPTION = `Stop the todo continuation driver for this session. Call this ONLY when remaining todos are genuinely blocked: a decision only the user can make, a missing credential or permission, or repeated identical failures. Provide the concrete reason. Continuation stays off until the user's next message.`

function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config }
  /** Per-session continuation states. */
  const states = new Map()
  /** Per-session pending delayed-continuation timer handles. */
  const timers = new Map()

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

  function scheduleContinuation(session, delayMs) {
    const agent = ctx.agents.get(session.id)
    if (!agent) return
    const fire = () => {
      cancelTimer(session.id)
      const remaining = remainingTodos(session)
      if (remaining.length === 0) return
      if (!stateOf(session.id).armed) return
      try {
        agent.followup([{ type: 'text', text: renderContinuation(remaining) }])
      } catch (error) {
        ctx.logger?.warn?.(`todo-driver: could not queue continuation for "${session.id}": ${error?.message ?? error}`)
      }
    }
    if (delayMs <= 0) {
      fire()
      return
    }
    cancelTimer(session.id)
    const setTimer = ctx.setTimeout ?? globalThis.setTimeout
    timers.set(session.id, setTimer(fire, delayMs))
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      // Genuine user input rearms; injected continuations carry our own source kind.
      const sourceKind = event.data?.source?.kind
      if (sourceKind !== 'orrery-todo-driver') {
        cancelTimer(session.id)
        stateOf(session.id).onUserMessage()
      }
      return
    }
    if (event.type !== 'turn/end') return
    if (!opts.enabled) return
    const state = stateOf(session.id)
    const decision = state.decideTurnEnd(event.data?.reason, remainingTodos(session).length > 0)
    if (decision.kind === 'continue') {
      scheduleContinuation(session, decision.delayMs)
    } else if (decision.kind === 'blocked') {
      try {
        session.append('orrery/continuation-blocked', { notice: decision.notice })
      } catch {
        // log-only
      }
      ctx.logger?.warn?.(`todo-driver: ${decision.notice}`)
    }
  })

  ctx.tools.register({
    name: 'stop_continuation',
    description: STOP_CONTINUATION_DESCRIPTION,
    parameters: {
      reason: { type: 'string', required: true, description: 'The concrete blocker that prevents progress.' },
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
      try {
        exec.agent.session.append('orrery/continuation-stop', { reason })
      } catch {
        // log-only
      }
      return { stopped: true, reason }
    },
  })

  // Dispose: drop all pending timers.
  return () => {
    for (const handle of timers.values()) clearTimeout(handle)
    timers.clear()
    states.clear()
  }
}

export { name, inject, apply }
