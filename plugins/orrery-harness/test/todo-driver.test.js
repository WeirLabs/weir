import { describe, expect, it } from './helpers.js'
import {
  backoffDelay,
  createContinuationState,
  DEFAULTS,
  isProviderError,
  renderContinuation,
} from '../src/todo-driver/state-machine.js'
import { apply } from '../src/todo-driver/index.js'

describe('isProviderError', () => {
  it('classifies 429/5xx and network codes as provider errors', () => {
    expect(isProviderError({ status: 429 })).toBe(true)
    expect(isProviderError({ status: 503 })).toBe(true)
    expect(isProviderError({ code: 'ECONNRESET' })).toBe(true)
    expect(isProviderError({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isProviderError({ message: 'fetch failed: network timeout' })).toBe(true)
  })

  it('rejects other failures', () => {
    expect(isProviderError({ status: 400 })).toBe(false)
    expect(isProviderError({ code: 'INVALID_ARGUMENTS' })).toBe(false)
    expect(isProviderError(undefined)).toBe(false)
    expect(isProviderError({ message: 'schema validation failed' })).toBe(false)
  })
})

describe('backoffDelay', () => {
  it('doubles from the base with a cap', () => {
    expect(backoffDelay(1, 30_000, 300_000)).toBe(30_000)
    expect(backoffDelay(2, 30_000, 300_000)).toBe(60_000)
    expect(backoffDelay(3, 30_000, 300_000)).toBe(120_000)
    expect(backoffDelay(10, 30_000, 300_000)).toBe(300_000)
  })
})

describe('continuation state machine', () => {
  it('continues on completed turns with remaining todos', () => {
    const state = createContinuationState()
    const decision = state.decideTurnEnd({ kind: 'completed' }, true)
    expect(decision.kind).toBe('continue')
    expect(decision.delayMs).toBe(0)
    expect(state.consecutive).toBe(1)
  })

  it('stays quiet when no todos remain', () => {
    const state = createContinuationState()
    expect(state.decideTurnEnd({ kind: 'completed' }, false).kind).toBe('none')
  })

  it('disarms on user abort until the next user message', () => {
    const state = createContinuationState()
    expect(state.decideTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }, true).kind).toBe('none')
    expect(state.armed).toBe(false)
    expect(state.decideTurnEnd({ kind: 'completed' }, true).kind).toBe('none')
    state.onUserMessage()
    expect(state.armed).toBe(true)
    expect(state.decideTurnEnd({ kind: 'completed' }, true).kind).toBe('continue')
  })

  it('does not disarm on non-user aborts', () => {
    const state = createContinuationState()
    expect(state.decideTurnEnd({ kind: 'aborted', reason: { kind: 'parent' } }, true).kind).toBe('none')
    expect(state.armed).toBe(true)
  })

  it('delays provider-error continuations with growing backoff', () => {
    const state = createContinuationState()
    const first = state.decideTurnEnd({ kind: 'error', error: { status: 429 } }, true)
    expect(first.kind).toBe('continue')
    expect(first.delayMs).toBe(30_000)
    const second = state.decideTurnEnd({ kind: 'error', error: { status: 503 } }, true)
    expect(second.delayMs).toBe(60_000)
    expect(state.errorStreak).toBe(2)
  })

  it('blocks after the provider-error cap and disarms', () => {
    const state = createContinuationState({ errorRetryMax: 3 })
    state.decideTurnEnd({ kind: 'error', error: { status: 429 } }, true)
    state.decideTurnEnd({ kind: 'error', error: { status: 429 } }, true)
    state.decideTurnEnd({ kind: 'error', error: { status: 429 } }, true)
    const fourth = state.decideTurnEnd({ kind: 'error', error: { status: 429 } }, true)
    expect(fourth.kind).toBe('blocked')
    expect(fourth.notice).toContain('3 consecutive provider errors')
    expect(state.armed).toBe(false)
  })

  it('does not continue on non-provider errors', () => {
    const state = createContinuationState()
    expect(state.decideTurnEnd({ kind: 'error', error: { status: 400 } }, true).kind).toBe('none')
  })

  it('resets the error streak on a completed turn', () => {
    const state = createContinuationState()
    state.decideTurnEnd({ kind: 'error', error: { status: 429 } }, true)
    state.decideTurnEnd({ kind: 'completed' }, false)
    expect(state.errorStreak).toBe(0)
  })

  it('honors the consecutive cap', () => {
    const state = createContinuationState({ maxConsecutive: 2 })
    state.decideTurnEnd({ kind: 'completed' }, true)
    state.decideTurnEnd({ kind: 'completed' }, true)
    expect(state.decideTurnEnd({ kind: 'completed' }, true).kind).toBe('none')
  })

  it('stop_continuation disarms with a recorded reason', () => {
    const state = createContinuationState()
    state.onStopContinuation('need user credentials')
    expect(state.armed).toBe(false)
    expect(state.stopReason).toBe('need user credentials')
    expect(state.decideTurnEnd({ kind: 'completed' }, true).kind).toBe('none')
  })

  it('disabled config never continues', () => {
    const state = createContinuationState({ enabled: false })
    expect(state.decideTurnEnd({ kind: 'completed' }, true).kind).toBe('none')
  })
})

describe('renderContinuation', () => {
  it('lists remaining todos in the English template with original text', () => {
    const text = renderContinuation(['修复登录按钮', 'add tests'])
    expect(text).toContain('<todo_continuation>')
    expect(text).toContain('- 修复登录按钮')
    expect(text).toContain('- add tests')
    expect(text).toContain('stop_continuation')
  })
})

describe('todo-driver plugin', () => {
  function harness() {
    const handlers = {}
    const registered = []
    const followups = []
    const appended = []
    const agents = new Map()
    const ctx = {
      tools: { register: (tool) => registered.push(tool) },
      agents: { get: (id) => agents.get(id) },
      get: () => undefined,
      on: (event, handler) => {
        handlers[event] = handler
      },
      logger: { warn: () => {} },
    }
    return { handlers, registered, followups, appended, agents, ctx }
  }

  function fakeSession(id, todos) {
    return {
      id,
      snapshotEvents: () => [{ type: 'todo/write', data: { todos } }],
      append: (type, data) => harness0.appended.push({ type, data }),
    }
  }

  let harness0
  function setup(todos = [{ content: 'pending task', status: 'pending' }]) {
    harness0 = harness()
    harness0.dispose = apply(harness0.ctx, {})
    const session = fakeSession('s1', todos)
    const agent = { id: 's1', session, followup: (blocks) => harness0.followups.push(blocks) }
    harness0.agents.set('s1', agent)
    return { ...harness0, session, agent }
  }

  it('follows up when a turn completes with remaining todos', () => {
    const { handlers, followups, session } = setup()
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(followups).toHaveLength(1)
    expect(followups[0][0].text).toContain('pending task')
    expect(followups[0][0].text).toContain('<todo_continuation>')
  })

  it('does not follow up when todos are complete', () => {
    const { handlers, followups, session } = setup([{ content: 'done', status: 'completed' }])
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(followups).toHaveLength(0)
  })

  it('does not follow up after a user abort', () => {
    const { handlers, followups, session } = setup()
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(followups).toHaveLength(0)
  })

  it('schedules a delayed continuation on provider error', async () => {
    const { handlers, followups, session, dispose } = setup()
    handlers['session/event'](session, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { status: 503 } } },
    })
    expect(followups).toHaveLength(0) // delayed, not immediate
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(followups).toHaveLength(0) // backoff is 30s; not fired yet
    dispose() // clears the pending timer
  })

  it('stop_continuation disarms and records the reason', async () => {
    const { registered, session, agent, appended } = setup()
    const tool = registered.find((t) => t.name === 'stop_continuation')
    const result = await tool.execute({ reason: 'need user decision' }, { agent })
    expect(result.stopped).toBe(true)
    expect(appended.some((e) => e.type === 'orrery/continuation-stop')).toBe(true)
    const handlers = harness0.handlers
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(harness0.followups).toHaveLength(0)
  })

  it('user messages rearm continuation', () => {
    const { handlers, followups, session } = setup()
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    handlers['session/event'](session, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'carry on' }], source: { kind: 'user' } },
    })
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(followups).toHaveLength(1)
  })

  it('ignores its own injected messages as user input', () => {
    const { handlers, session } = setup()
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    handlers['session/event'](session, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: '<todo_continuation>...' }], source: { kind: 'orrery-todo-driver' } },
    })
    const decision = handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(decision).toBeUndefined()
    expect(harness0.followups).toHaveLength(0)
  })
})
