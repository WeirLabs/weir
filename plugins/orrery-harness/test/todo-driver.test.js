import { describe, expect, it } from './helpers.js'
import {
  backoffDelay,
  classifyTurnOutcome,
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

describe('classifyTurnOutcome', () => {
  const cases = [
    // Row 1: durable completed.
    { name: 'durable completed', input: { reason: { kind: 'completed' } }, expected: { kind: 'completed' } },
    // Row 2: durable user abort.
    { name: 'durable user abort', input: { reason: { kind: 'aborted', reason: { kind: 'user' } } }, expected: { kind: 'user-abort' } },
    // Row 3: durable non-user abort carries the cause kind (when known).
    { name: 'durable hook abort', input: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } } }, expected: { kind: 'abort', causeKind: 'hook' } },
    { name: 'durable abort without a cause', input: { reason: { kind: 'aborted' } }, expected: { kind: 'abort' } },
    // Row 4: durable provider error.
    { name: 'durable provider error', input: { reason: { kind: 'error', error: { status: 503 } } }, expected: { kind: 'provider-error', failure: { status: 503 } } },
    // Row 5: durable non-provider error.
    { name: 'durable non-provider error', input: { reason: { kind: 'error', error: { status: 400 } } }, expected: { kind: 'error', failure: { status: 400 } } },
    // Row 6: durable other/unknown kinds.
    { name: 'durable blocked', input: { reason: { kind: 'blocked' } }, expected: { kind: 'other' } },
    { name: 'durable max-tokens', input: { reason: { kind: 'max-tokens' } }, expected: { kind: 'other' } },
    { name: 'durable interrupted', input: { reason: { kind: 'interrupted' } }, expected: { kind: 'other' } },
    { name: 'durable forked', input: { reason: { kind: 'forked' } }, expected: { kind: 'other' } },
    { name: 'durable unknown kind', input: { reason: { kind: 'some-unknown' } }, expected: { kind: 'other' } },
    // Row 7: signal pre-classifies a user abort.
    { name: 'signal user abort', input: { signal: { aborted: true, reason: { kind: 'user' } } }, expected: { kind: 'user-abort' } },
    // Row 8: signal pre-classifies other/missing-cause aborts.
    { name: 'signal parent abort', input: { signal: { aborted: true, reason: { kind: 'parent' } } }, expected: { kind: 'abort', causeKind: 'parent' } },
    { name: 'signal abort without a cause', input: { signal: { aborted: true } }, expected: { kind: 'abort' } },
    // Row 9: side-channel provider error.
    { name: 'pending provider error', input: { error: { code: 'ECONNRESET' } }, expected: { kind: 'provider-error', failure: { code: 'ECONNRESET' } } },
    // Row 10: side-channel non-provider error.
    { name: 'pending non-provider error', input: { error: { status: 400 } }, expected: { kind: 'error', failure: { status: 400 } } },
    // Row 11: nothing anomalous.
    { name: 'empty input', input: {}, expected: { kind: 'ok' } },
    { name: 'signal not aborted', input: { signal: { aborted: false } }, expected: { kind: 'ok' } },
    { name: 'null reason', input: { reason: null }, expected: { kind: 'ok' } },
    { name: 'non-object reason', input: { reason: 'completed' }, expected: { kind: 'ok' } },
  ]
  for (const { name, input, expected } of cases) {
    it(`${name} → ${expected.kind}`, () => {
      expect(classifyTurnOutcome(input)).toEqual(expected)
    })
  }

  it('durable reason wins over signal and side-channel error', () => {
    expect(
      classifyTurnOutcome({
        reason: { kind: 'completed' },
        signal: { aborted: true, reason: { kind: 'user' } },
        error: { status: 503 },
      }),
    ).toEqual({ kind: 'completed' })
    expect(
      classifyTurnOutcome({
        reason: { kind: 'aborted', reason: { kind: 'user' } },
        error: { status: 503 },
      }),
    ).toEqual({ kind: 'user-abort' })
  })

  it('signal pre-classifies before the side-channel error', () => {
    expect(
      classifyTurnOutcome({
        signal: { aborted: true, reason: { kind: 'user' } },
        error: { status: 503 },
      }),
    ).toEqual({ kind: 'user-abort' })
  })
})

describe('decideAtTurnStopping', () => {
  it('continues when todos remain', () => {
    const state = createContinuationState()
    const decision = state.decideAtTurnStopping({ todosRemain: true, signal: notAbortedSignal() })
    expect(decision.kind).toBe('continue')
    expect(state.consecutive).toBe(1)
  })

  it('makes waiting for jobs invisible to the cap and resumes at the old count', () => {
    const state = createContinuationState({ maxConsecutive: 2 })
    expect(state.decideAtTurnStopping({ todosRemain: true, jobsRunning: true }).kind).toBe('none')
    expect(state.consecutive).toBe(0)
    expect(state.decideAtTurnStopping({ todosRemain: true, jobsRunning: false }).kind).toBe('continue')
    for (let i = 0; i < 3; i++) {
      expect(state.decideAtTurnStopping({ todosRemain: true, jobsRunning: true }).kind).toBe('none')
      expect(state.consecutive).toBe(1)
    }
    expect(state.decideAtTurnStopping({ todosRemain: true, jobsRunning: false }).kind).toBe('continue')
    expect(state.consecutive).toBe(2)
    expect(state.decideAtTurnStopping({ todosRemain: true, jobsRunning: false }).kind).toBe('none')
  })

  it('still disarms user interrupts while jobs are running', () => {
    const state = createContinuationState()
    expect(state.decideAtTurnStopping({ todosRemain: true, jobsRunning: true, signal: abortedSignal('user') }).kind).toBe('none')
    expect(state.armed).toBe(false)
    expect(state.consecutive).toBe(0)
  })
  it('stays quiet when no todos remain', () => {
    const state = createContinuationState()
    expect(state.decideAtTurnStopping({ todosRemain: false, signal: notAbortedSignal() }).kind).toBe('none')
  })

  it('disarms on user abort', () => {
    const state = createContinuationState()
    expect(state.decideAtTurnStopping({ todosRemain: true, signal: abortedSignal('user') }).kind).toBe('none')
    expect(state.armed).toBe(false)
    expect(state.stopReason).toBe('user interrupt')
  })

  it('does not disarm on non-user aborts', () => {
    const state = createContinuationState()
    state.decideAtTurnStopping({ todosRemain: true, signal: abortedSignal('parent') })
    expect(state.armed).toBe(true)
  })

  it('never doubles up while a provider-error retry is pending', () => {
    const state = createContinuationState()
    expect(state.decideAtTurnStopping({ todosRemain: true, signal: notAbortedSignal(), error: { status: 503 } }).kind).toBe('none')
  })

  it('honors the consecutive cap', () => {
    const state = createContinuationState({ maxConsecutive: 2 })
    state.decideAtTurnStopping({ todosRemain: true, signal: notAbortedSignal() })
    state.decideAtTurnStopping({ todosRemain: true, signal: notAbortedSignal() })
    expect(state.decideAtTurnStopping({ todosRemain: true, signal: notAbortedSignal() }).kind).toBe('none')
  })

  it('disabled config never continues', () => {
    const state = createContinuationState({ enabled: false })
    expect(state.decideAtTurnStopping({ todosRemain: true, signal: notAbortedSignal() }).kind).toBe('none')
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

  for (const status of ['running', 'stopping']) {
    it(`suppresses ${status} jobs owned by session.id without spending the cap`, () => {
      const { ctx, handlers, agent, steers } = setup()
      agent.id = 'different-agent-id'
      const owners = []
      let jobs = [{ status }]
      ctx.get = (name) => name === 'jobs' ? { list: (owner) => { owners.push(owner); return jobs } } : undefined
      for (let i = 0; i < 10; i++) handlers['agent/turn-stopping']({ agent })
      expect(steers).toHaveLength(0)
      expect(owners.every((owner) => owner === 's1')).toBe(true)
      jobs = [{ status: 'completed' }, { status: 'failed' }, { status: 'killed' }]
      for (let i = 0; i < 9; i++) handlers['agent/turn-stopping']({ agent })
      expect(steers).toHaveLength(8)
    })
  }

  it('fails open with a warning when the jobs lookup throws', () => {
    const { ctx, handlers, agent, steers } = setup()
    const warnings = []
    ctx.logger.warn = (message) => warnings.push(message)
    ctx.get = (name) => name === 'jobs' ? { list: () => { throw new Error('registry unavailable') } } : undefined
    handlers['agent/turn-stopping']({ agent })
    expect(steers).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('registry unavailable')
  })

  for (const status of ['running', 'stopping']) {
    it(`rechecks ${status} jobs at retry fire without rescheduling or changing the error streak`, () => {
      const { ctx, handlers, session, followups, dispose } = setup()
      const timers = []
      let jobs = []
      ctx.get = (name) => name === 'jobs' ? { list: () => jobs } : undefined
      ctx.setTimeout = (fire, delay) => { timers.push({ fire, delay }); return timers.length }
      const fail = () => handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'error', error: { status: 503 } } } })
      fail()
      expect(timers[0].delay).toBe(30_000)
      jobs = [{ status }]
      timers[0].fire()
      expect(followups).toHaveLength(0)
      expect(timers).toHaveLength(1)
      // The next durable error advances from streak 1 to 2, proving fire
      // neither incremented nor reset the existing streak.
      fail()
      expect(timers[1].delay).toBe(60_000)
      jobs = []
      timers[1].fire()
      expect(followups).toHaveLength(1)
      expect(timers).toHaveLength(2)
      dispose()
    })
  }

  for (const mode of ['absent', 'throws']) {
    it(`fails open at retry fire when jobs service ${mode}`, () => {
      const { ctx, handlers, session, followups, dispose } = setup()
      let fire
      const warnings = []
      ctx.logger.warn = (message) => warnings.push(message)
      ctx.setTimeout = (callback) => { fire = callback; return 1 }
      ctx.get = (name) => name === 'jobs' && mode === 'throws' ? { list: () => { throw new Error('jobs failure') } } : undefined
      handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'error', error: { status: 503 } } } })
      fire()
      expect(followups).toHaveLength(1)
      expect(warnings).toHaveLength(mode === 'throws' ? 1 : 0)
      dispose()
    })
  }

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
