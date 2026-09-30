import { describe, expect, it } from './helpers.js'
import {
  backoffDelay,
  createContinuationState,
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

describe('decideAtTurnStopping', () => {
  it('continues when todos remain', () => {
    const state = createContinuationState()
    const decision = state.decideAtTurnStopping({ todosRemain: true, aborted: false, providerErrorPending: false })
    expect(decision.kind).toBe('continue')
    expect(state.consecutive).toBe(1)
  })

  it('stays quiet when no todos remain', () => {
    const state = createContinuationState()
    expect(state.decideAtTurnStopping({ todosRemain: false, aborted: false, providerErrorPending: false }).kind).toBe('none')
  })

  it('disarms on user abort', () => {
    const state = createContinuationState()
    expect(
      state.decideAtTurnStopping({ todosRemain: true, aborted: true, abortCauseKind: 'user', providerErrorPending: false }).kind,
    ).toBe('none')
    expect(state.armed).toBe(false)
    expect(state.decideAtTurnStopping({ todosRemain: true, aborted: false, providerErrorPending: false }).kind).toBe('none')
    state.onUserMessage()
    expect(state.decideAtTurnStopping({ todosRemain: true, aborted: false, providerErrorPending: false }).kind).toBe('continue')
  })

  it('does not disarm on non-user aborts', () => {
    const state = createContinuationState()
    state.decideAtTurnStopping({ todosRemain: true, aborted: true, abortCauseKind: 'parent', providerErrorPending: false })
    expect(state.armed).toBe(true)
  })

  it('never doubles up while a provider-error retry is pending', () => {
    const state = createContinuationState()
    expect(state.decideAtTurnStopping({ todosRemain: true, aborted: false, providerErrorPending: true }).kind).toBe('none')
  })

  it('honors the consecutive cap', () => {
    const state = createContinuationState({ maxConsecutive: 2 })
    state.decideAtTurnStopping({ todosRemain: true, aborted: false, providerErrorPending: false })
    state.decideAtTurnStopping({ todosRemain: true, aborted: false, providerErrorPending: false })
    expect(state.decideAtTurnStopping({ todosRemain: true, aborted: false, providerErrorPending: false }).kind).toBe('none')
  })

  it('disabled config never continues', () => {
    const state = createContinuationState({ enabled: false })
    expect(state.decideAtTurnStopping({ todosRemain: true, aborted: false, providerErrorPending: false }).kind).toBe('none')
  })
})

describe('decideTurnEnd bookkeeping', () => {
  it('completed resets the error streak and never continues here', () => {
    const state = createContinuationState()
    state.decideTurnEnd({ kind: 'error', error: { status: 429 } }, true)
    const decision = state.decideTurnEnd({ kind: 'completed' }, true)
    expect(decision.kind).toBe('none')
    expect(state.errorStreak).toBe(0)
  })

  it('disarms on user abort', () => {
    const state = createContinuationState()
    state.decideTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }, true)
    expect(state.armed).toBe(false)
    expect(state.stopReason).toBe('user interrupt')
  })

  it('keeps armed on non-user aborts', () => {
    const state = createContinuationState()
    state.decideTurnEnd({ kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } }, true)
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

  it('does not continue on non-provider errors or unknown reasons', () => {
    const state = createContinuationState()
    expect(state.decideTurnEnd({ kind: 'error', error: { status: 400 } }, true).kind).toBe('none')
    expect(state.decideTurnEnd({ kind: 'blocked' }, true).kind).toBe('none')
    expect(state.decideTurnEnd({ kind: 'max-tokens' }, true).kind).toBe('none')
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
    const steers = []
    const followups = []
    const appended = []
    const emitted = []
    const ctx = {
      tools: { register: (tool) => registered.push(tool) },
      agents: { get: (id) => harness0.agents.get(id) },
      get: () => undefined,
      on: (event, handler) => {
        handlers[event] = handler
      },
      emit: (type, record) => emitted.push({ type, record }),
      logger: { warn: () => {} },
    }
    return { handlers, registered, steers, followups, appended, emitted, agents: new Map(), ctx }
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
    const agent = {
      id: 's1',
      session,
      steer: (blocks) => harness0.steers.push(blocks),
      followup: (blocks) => harness0.followups.push(blocks),
    }
    harness0.agents.set('s1', agent)
    return { ...harness0, session, agent }
  }

  const notAborted = { aborted: false }

  it('steers a continuation at turn-stopping with remaining todos', () => {
    const { handlers, steers, agent } = setup()
    handlers['agent/turn-stopping']({ agent, turn: 1, signal: notAbortedSignal() })
    expect(steers).toHaveLength(1)
    expect(steers[0].role).toBe('user')
    expect(steers[0].source.kind).toBe('orrery-todo-driver')
    expect(steers[0].content[0].text).toContain('pending task')
    expect(steers[0].content[0].text).toContain('<todo_continuation>')
  })

  it('stays quiet when todos are complete', () => {
    const { handlers, steers, agent } = setup([{ content: 'done', status: 'completed' }])
    handlers['agent/turn-stopping']({ agent, turn: 1, signal: notAbortedSignal() })
    expect(steers).toHaveLength(0)
  })

  it('does not steer after a user abort', () => {
    const { handlers, steers, agent, session } = setup()
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    handlers['agent/turn-stopping']({ agent, turn: 1, signal: abortedSignal('user') })
    expect(steers).toHaveLength(0)
    // and stays disarmed afterwards
    handlers['agent/turn-stopping']({ agent, turn: 2, signal: notAbortedSignal() })
    expect(steers).toHaveLength(0)
  })

  it('never steers while a provider-error retry is pending', () => {
    const { handlers, steers, agent } = setup()
    handlers['agent/error']({ agent, turn: 1, step: 1, error: { status: 503 } })
    handlers['agent/turn-stopping']({ agent, turn: 1, signal: notAbortedSignal() })
    expect(steers).toHaveLength(0)
  })

  it('schedules a delayed retry on provider error turn end', async () => {
    const { handlers, followups, session, agent } = setup()
    handlers['session/event'](session, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { status: 503 } } },
    })
    expect(followups).toHaveLength(0) // delayed, not immediate
    harness0.dispose()
  })

  it('stop_continuation disarms and records the reason', async () => {
    const { registered, session, agent, emitted, handlers } = setup()
    const tool = registered.find((t) => t.name === 'stop_continuation')
    const result = await tool.execute({ reason: 'need user decision' }, { agent })
    expect(result.stopped).toBe(true)
    expect(emitted.some((e) => e.type === 'orrery/continuation-stop')).toBe(true)
    handlers['agent/turn-stopping']({ agent, turn: 1, signal: notAbortedSignal() })
    expect(harness0.steers).toHaveLength(0)
  })

  it('user messages rearm continuation', () => {
    const { handlers, steers, session, agent } = setup()
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    handlers['agent/turn-stopping']({ agent, turn: 1, signal: notAbortedSignal() })
    expect(steers).toHaveLength(0)
    handlers['session/event'](session, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'carry on' }], source: { kind: 'user' } },
    })
    handlers['agent/turn-stopping']({ agent, turn: 2, signal: notAbortedSignal() })
    expect(steers).toHaveLength(1)
  })

  // Plugin-level behavior assertion: the driver's own injected continuation
  // never rearms it. The full injection-source exemption matrix lives in
  // test/runtime-messages.test.js.
  it('ignores its own injected messages as user input', () => {
    const { handlers, session, agent, steers } = setup()
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    handlers['session/event'](session, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: '<todo_continuation>...' }], source: { kind: 'orrery-todo-driver' } },
    })
    handlers['agent/turn-stopping']({ agent, turn: 2, signal: notAbortedSignal() })
    expect(steers).toHaveLength(0)
  })
})

function notAbortedSignal() {
  return { aborted: false, reason: undefined }
}

function abortedSignal(kind) {
  return { aborted: true, reason: { kind } }
}
