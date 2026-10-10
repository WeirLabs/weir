import { describe, expect, it } from './helpers.js'
import {
  computePressure,
  createPressureState,
  renderAdvisory,
  RESUME_AFTER_COMPACTION,
} from '../src/context-guard/pressure.js'
import { classifyCompactionOutcome } from '../src/context-guard/compaction-outcome.js'
import { apply } from '../src/context-guard/index.js'

describe('classifyCompactionOutcome', () => {
  // The live-bug wording: the current host throws this busy variant whose
  // message matches none of the legacy regex words.
  const HOST_BUSY_MESSAGE = 'manual compaction requires an idle agent with no waking queued work'
  const cases = [
    // Row 1: structured string code 'busy' decides, whatever the message says.
    { name: 'structured busy code', error: { code: 'busy' }, expected: 'busy' },
    { name: 'structured busy code with regex-miss wording', error: { code: 'busy', message: HOST_BUSY_MESSAGE }, expected: 'busy' },
    // Row 2: any other string code fails, never falling back to the regex.
    { name: 'persistence code', error: { code: 'persistence', message: 'could not persist' }, expected: 'failed' },
    { name: 'commit code', error: { code: 'commit' }, expected: 'failed' },
    { name: 'changed code', error: { code: 'changed' }, expected: 'failed' },
    { name: 'summary code', error: { code: 'summary' }, expected: 'failed' },
    { name: 'cancelled code', error: { code: 'cancelled' }, expected: 'failed' },
    { name: 'unknown future code', error: { code: 'some-future-code', message: 'x' }, expected: 'failed' },
    // Counterexample: non-busy code whose message contains busy words must not re-queue.
    { name: 'non-busy code with busy words in message', error: { code: 'commit', message: 'commit failed while another job is active' }, expected: 'failed' },
    // Row 3: no string code — legacy message regex fallback (name as last resort).
    { name: 'legacy busy message', error: { message: 'agent is busy' }, expected: 'busy' },
    { name: 'legacy active message', error: { message: 'another compaction is active' }, expected: 'busy' },
    { name: 'legacy not-idle message', error: { message: 'agent is not idle' }, expected: 'busy' },
    { name: 'legacy running message', error: { message: 'compaction already running' }, expected: 'busy' },
    { name: 'legacy name fallback', error: { name: 'BusyError' }, expected: 'busy' },
    // Row 4: everything else fails.
    { name: 'plain unmatched message', error: { message: 'disk full' }, expected: 'failed' },
    { name: 'non-string code falls through to the regex', error: { code: 42, message: '42' }, expected: 'failed' },
    { name: 'empty object', error: {}, expected: 'failed' },
    { name: 'undefined error', error: undefined, expected: 'failed' },
    { name: 'null error', error: null, expected: 'failed' },
  ]
  for (const { name, error, expected } of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyCompactionOutcome(error)).toBe(expected)
    })
  }
})

describe('computePressure', () => {
  it('computes the ratio', () => {
    expect(computePressure(72_000, 100_000)).toBe(0.72)
  })

  it('returns undefined when inputs are unknown', () => {
    expect(computePressure(undefined, 100_000)).toBeUndefined()
    expect(computePressure(1000, undefined)).toBeUndefined()
    expect(computePressure(1000, 0)).toBeUndefined()
  })
})

describe('pressure state', () => {
  it('advises once per soft crossing with hysteresis', () => {
    const state = createPressureState()
    expect(state.evaluate(0.75, 'step').kind).toBe('advise')
    expect(state.evaluate(0.78, 'step').kind).toBe('none') // already advised
    expect(state.evaluate(0.6, 'step').kind).toBe('none') // fell below: rearm
    expect(state.evaluate(0.8, 'step').kind).toBe('advise') // new crossing
  })

  it('forces only at turn boundaries', () => {
    const state = createPressureState()
    expect(state.evaluate(0.9, 'step').kind).toBe('advise') // mid-turn: advise
    expect(state.evaluate(0.91, 'turn').kind).toBe('force') // boundary: force
    expect(state.evaluate(0.92, 'turn').kind).toBe('none') // force once
  })

  it('resets after compaction', () => {
    const state = createPressureState()
    state.evaluate(0.9, 'turn')
    state.reset()
    expect(state.evaluate(0.91, 'turn').kind).toBe('force')
  })

  it('never fires when disabled or unknown', () => {
    const disabled = createPressureState({ enabled: false })
    expect(disabled.evaluate(0.95, 'turn').kind).toBe('none')
    const state = createPressureState()
    expect(state.evaluate(undefined, 'turn').kind).toBe('none')
  })

  it('honors custom thresholds', () => {
    const state = createPressureState({ softThreshold: 0.5, hardThreshold: 0.6 })
    expect(state.evaluate(0.55, 'turn').kind).toBe('advise')
    expect(state.evaluate(0.65, 'turn').kind).toBe('force')
  })
})

describe('templates', () => {
  it('advisory carries the percent and the tool name', () => {
    const text = renderAdvisory(0.74)
    expect(text).toContain('74%')
    expect(text).toContain('compact_context')
  })

  it('resume template instructs continuation', () => {
    expect(RESUME_AFTER_COMPACTION).toContain('Resume the task')
  })
})

describe('context-guard plugin', () => {
  function harness(pressure = 0.5, options = {}) {
    const handlers = {}, services = {}, registered = [], injected = [], followups = [], compactions = [], audits = [], warns = []
    const settings = { enabled: true, softThreshold: 0.72, hardThreshold: 0.88 }
    let tokens = pressure * 100000, publishing = false, phase = 'running'
    const turnAbort = new AbortController(), maintenanceAbort = new AbortController()
    const session = {
      id: 's1', seq: 10, surface: { replaceGeneration: 0 },
      requestContext: () => ({ provider: 'mock', model: 'test', contextWindow: 100000 }),
      snapshotEvents: () => [],
      append() { throw new Error('custom session append forbidden') },
    }
    const agent = {
      id: 's1', session, get status() { return phase === 'maintenance' ? 'idle' : phase },
      inject(message) { if (publishing) throw new Error('append reentry'); injected.push(message) },
      followup(message) { if (publishing) throw new Error('append reentry'); followups.push(message) },
      runMaintenance(job) {
        if (phase !== 'idle') throw Object.assign(new Error('not idle'), { code: 'busy' })
        phase = 'maintenance'
        return Promise.resolve(job(maintenanceAbort.signal)).finally(() => { phase = 'idle' })
      },
    }
    const ctx = {
      reflect: { provide: (key, value) => { services[key] = value } },
      get: (key) => key === 'weirSettings' ? { get: () => settings } : services[key],
      tools: { register: (tool) => registered.push(tool) }, agents: { get: () => agent },
      tokenMeter: { measure: () => ({ totalTokens: tokens }) }, llm: {},
      compaction: { compactNow(agentCtx, signal) {
        compactions.push({ agentCtx, signal, phase, publishing })
        if (options.error) return Promise.reject(options.error)
        return agentCtx.runMaintenance(async () => options.run ? options.run() : ('result' in options ? options.result : { summarySeq: 12, compactionId: 'c1' }))
      } },
      emit: (_type, record) => audits.push(record.data),
      on: (event, handler) => { handlers[event] = handler },
      logger: { warn: (text) => warns.push(text) },
    }
    const dispose = apply(ctx, {})
    const event = async (type, data = {}) => {
      publishing = true
      let result
      try { result = handlers['session/event'](session, { type, data, seq: session.seq++ }) } finally { publishing = false }
      await result
    }
    const stopping = () => handlers['agent/turn-stopping']?.({ agent, turn: 1, signal: turnAbort.signal })
    const idle = async () => {
      phase = 'idle'
      await handlers['agent/status']?.({ agent, status: 'idle' })
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    const preStep = async (messages = []) => handlers['agent/pre-step']?.({ agent, turn: 2, step: 1, messages, signal: turnAbort.signal }, async () => ({ kind: 'enter', messages }))
    return { ctx, handlers, services, settings, injected, followups, compactions, audits, warns, session, agent, dispose, event, stopping, idle, preStep, turnAbort, maintenanceAbort,
      tokens: (value) => { tokens = value },
      tool: registered.find((tool) => tool.name === 'compact_context'),
      request: () => registered.find((tool) => tool.name === 'compact_context').execute({}, { agent, signal: turnAbort.signal, concludeTurn() {} }),
    }
  }

  it('does not attempt manual compaction inside the turn/end publication', async () => {
    const h = harness()
    const result = await h.request()
    expect(result.queued).toBe(true)
    expect(h.compactions).toHaveLength(0)
    await h.event('turn/end', { reason: { kind: 'completed' } })
    expect(h.compactions).toHaveLength(0)
    await h.idle()
    expect(h.compactions).toHaveLength(1)
    expect(h.compactions[0].publishing).toBe(false)
    expect(h.followups).toHaveLength(1)
    expect(h.followups[0].role).toBe('user')
    expect(h.followups[0].source.kind).toBe('weir-context-guard')
  })

  it('coalesces model and hard requests and resumes at most once', async () => {
    const h = harness(0.95)
    const first = await h.request(), second = await h.request()
    expect(typeof first.requestId).toBe('string')
    expect(second.requestId).toBe(first.requestId)
    await h.stopping()
    await h.event('turn/end', { reason: { kind: 'completed' } })
    await h.idle(); await h.idle()
    expect(h.compactions).toHaveLength(1)
    expect(h.followups).toHaveLength(1)
    expect(h.compactions[0].agentCtx.options).toEqual({ provider: 'mock', model: 'test' })
    await h.stopping(); await h.idle()
    expect(h.compactions).toHaveLength(1) // summary did not lower measured pressure
  })

  for (const error of [{ code: 'busy', message: 'no waking queued work' }, { message: 'already active' }]) {
    it(`busy becomes blocked without retry or idle-Stop wake: ${JSON.stringify(error)}`, async () => {
      const h = harness(0.95, { error })
      await h.request(); await h.stopping(); await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle()
      expect(h.audits.some((a) => a.kind === 'blocked')).toBe(true)
      expect(h.services.weirCompactionCoordinator.blocksContinuation(h.agent)).toBe(true)
      await h.idle(); await h.stopping(); await h.idle()
      expect(h.compactions).toHaveLength(1)
      expect(h.followups).toHaveLength(0)
      expect(h.warns).toHaveLength(0)
      await h.preStep([{ source: { kind: 'jobs' } }])
      expect(h.services.weirCompactionCoordinator.blocksContinuation(h.agent)).toBe(true)
      const next = await h.preStep([{ role: 'user', source: { kind: 'user' }, content: [] }])
      expect(next.messages.some((m) => m.content?.some((b) => b.text?.includes('blocked')))).toBe(true)
      expect(h.services.weirCompactionCoordinator.blocksContinuation(h.agent)).toBe(false)
      expect(h.followups).toHaveLength(0)
    })
  }

  it('a competing next turn blocks the queued request instead of attempting late', async () => {
    const h = harness()
    await h.request(); await h.event('turn/end', { reason: { kind: 'completed' } })
    await h.event('turn/start', { turn: 2 }); await h.idle()
    expect(h.compactions).toHaveLength(0)
    expect(h.services.weirCompactionCoordinator.blocksContinuation(h.agent)).toBe(true)
  })

  for (const result of [null, undefined]) {
    it(`does not claim a summary for ${result}`, async () => {
      const h = harness(0.95, { result })
      await h.request(); await h.stopping(); await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle()
      expect(h.followups).toHaveLength(0)
      expect(h.audits.some((a) => a.kind === 'noop')).toBe(true)
      await h.stopping(); await h.idle()
      expect(h.compactions).toHaveLength(1)
    })
  }

  it('structured commit failure remains failed and uncertain, never busy', async () => {
    const h = harness(0.5, { error: { code: 'commit', message: 'active commit failed' } })
    await h.request(); await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle(); await h.idle()
    expect(h.compactions).toHaveLength(1)
    expect(h.followups).toHaveLength(0)
    expect(h.audits.some((a) => a.kind === 'failed' && a.uncertain === true)).toBe(true)
  })

  it('observable turn cancellation suppresses pending work', async () => {
    const h = harness()
    await h.request()
    h.turnAbort.abort({ kind: 'user' })
    await h.event('turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } }); await h.idle()
    expect(h.compactions).toHaveLength(0)
    expect(h.followups).toHaveLength(0)
  })

  it('maintenance cancellation suppresses a late successful result', async () => {
    let resolve
    const h = harness(0.5, { run: () => new Promise((done) => { resolve = done }) })
    await h.request(); await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle()
    h.maintenanceAbort.abort({ kind: 'user' })
    resolve({ summarySeq: 12, compactionId: 'c1' }); await h.idle()
    expect(h.followups).toHaveLength(0)
  })

  it('live disabling invalidates an accepted request before idle', async () => {
    const h = harness()
    await h.request(); h.settings.enabled = false
    await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle()
    expect(h.compactions).toHaveLength(0)
    expect((await h.request()).queued).toBe(false)
  })

  it('coalesces a verified native summary and replacement without manual compaction', async () => {
    const h = harness()
    await h.request()
    await h.event('compaction/start', { compactionId: 'native' })
    await h.event('compaction/summary', { compactionId: 'native', summary: [{ type: 'text', text: 'summary' }] })
    h.session.surface.replaceGeneration++
    h.handlers['session/event'](h.session, { type: 'user/message', seq: 12, data: { source: { kind: 'compact-checkpoint', compactionId: 'native' } }, surfaceOp: { op: 'replace' }, sourceEventSeqs: [10, 11] })
    await h.event('compaction/end', { compactionId: 'native' })
    const step = await h.preStep()
    expect(step.messages.some((m) => m.content?.some((b) => b.text?.includes('Resume the task')))).toBe(true)
    await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle()
    expect(h.compactions).toHaveLength(0)
    expect(h.followups).toHaveLength(0)
  })

  it('summary without a committed replacement does not count as native success', async () => {
    const h = harness()
    await h.request()
    await h.event('compaction/start', { compactionId: 'native' })
    await h.event('compaction/summary', { compactionId: 'native' })
    await h.event('compaction/end', { compactionId: 'native', error: ['commit failed'] })
    await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle()
    expect(h.compactions).toHaveLength(1)
  })

  it('cold queued evidence blocks without inventing a queue or a summary', async () => {
    const h = harness()
    h.session.snapshotEvents = () => [
      { seq: 1, type: 'tool/call', data: { name: 'compact_context', callId: 'old' } },
      { seq: 2, type: 'tool/result', data: { message: { toolCallId: 'old', content: [{ type: 'text', text: 'Compaction request old queued, not completed.' }] } } },
    ]
    await h.handlers['agent/created']?.({ agent: h.agent, source: 'resume' })
    expect(h.services.weirCompactionCoordinator.blocksContinuation(h.agent)).toBe(true)
    await h.idle()
    expect(h.compactions).toHaveLength(0)
    const step = await h.preStep([{ source: { kind: 'user' }, content: [] }])
    expect(step.messages.some((m) => m.content?.some((b) => b.text?.includes('unconfirmed')))).toBe(true)
  })

  it('rejects a stale asynchronous route measurement after settings change', async () => {
    const h = harness(0.95)
    let resolve
    h.session.requestContext = () => ({ provider: 'mock', model: 'unknown' })
    h.ctx.llm.resolveModelInfo = () => new Promise((done) => { resolve = done })
    const measurement = h.stopping()
    h.settings.hardThreshold = 0.99
    resolve({ context: { contextWindow: 100000 } })
    await measurement
    await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle()
    expect(h.compactions).toHaveLength(0)
  })

  it('publishes a stopping-boundary soft advisory exactly once when no request is pending', async () => {
    const h = harness(0.75)
    await h.stopping(); await h.stopping()
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0].content[0].text).toContain('75%')
    await h.request(); await h.stopping()
    expect(h.injected).toHaveLength(1)
  })

  it('a wake entering after maintenance receives a non-waking resume, not another turn', async () => {
    const h = harness()
    const compact = h.ctx.compaction.compactNow
    h.ctx.compaction.compactNow = (...args) => compact(...args).then((result) => {
      Object.defineProperty(h.agent, 'status', { value: 'running' })
      return result
    })
    await h.request(); await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle()
    expect(h.followups).toHaveLength(0)
    expect(h.injected).toHaveLength(1)
  })

  it('live thresholds affect the next stopping decision', async () => {
    const h = harness(0.65)
    await h.stopping(); expect(h.compactions).toHaveLength(0)
    h.settings.softThreshold = 0.5; h.settings.hardThreshold = 0.6
    await h.stopping(); await h.event('turn/end', { reason: { kind: 'completed' } }); await h.idle()
    expect(h.compactions).toHaveLength(1)
  })
})
