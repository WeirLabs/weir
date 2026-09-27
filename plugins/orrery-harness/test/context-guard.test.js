import { describe, expect, it } from './helpers.js'
import {
  computePressure,
  createPressureState,
  renderAdvisory,
  RESUME_AFTER_COMPACTION,
} from '../src/context-guard/pressure.js'
import { apply } from '../src/context-guard/index.js'

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
  function harness(pressure) {
    const handlers = {}
    const registered = []
    const injected = []
    const followups = []
    const compactions = []
    const agents = new Map()
    const totalTokens = 100_000
    const contextWindow = Math.round(totalTokens / pressure)
    const session = {
      id: 's1',
      requestContext: () => ({ provider: 'deepseek', model: 'deepseek-chat', contextWindow }),
      append: () => {},
    }
    const agent = {
      id: 's1',
      session,
      inject: (blocks) => injected.push(blocks),
      followup: (blocks) => followups.push(blocks),
      runMaintenance: (job) => job(new AbortController().signal),
    }
    agents.set('s1', agent)
    const ctx = {
      tools: { register: (tool) => registered.push(tool) },
      agents: { get: (id) => agents.get(id) },
      tokenMeter: { measure: () => ({ totalTokens }) },
      compaction: {
        compactNow: async (agentCtx) => {
          compactions.push(agentCtx)
          return { kind: 'ok' }
        },
      },
      llm: {},
      on: (event, handler) => {
        handlers[event] = handler
      },
      logger: { warn: () => {} },
    }
    apply(ctx, {})
    return { handlers, registered, injected, followups, compactions, session, agent }
  }

  it('advises mid-turn at step boundaries over the soft threshold', async () => {
    const { handlers, injected, session } = harness(0.75)
    await handlers['session/event'](session, { type: 'step/end', data: {} })
    expect(injected).toHaveLength(1)
    expect(injected[0].content[0].text).toContain('75%')
    await handlers['session/event'](session, { type: 'step/end', data: {} })
    expect(injected).toHaveLength(1) // once per crossing
  })

  it('stays quiet below the soft threshold', async () => {
    const { handlers, injected, session } = harness(0.5)
    await handlers['session/event'](session, { type: 'step/end', data: {} })
    await handlers['session/event'](session, { type: 'turn/end', data: {} })
    expect(injected).toHaveLength(0)
  })

  it('forces compaction at a turn boundary over the hard threshold', async () => {
    const { handlers, compactions, followups, session } = harness(0.9)
    await handlers['session/event'](session, { type: 'turn/end', data: {} })
    expect(compactions).toHaveLength(1)
    expect(followups).toHaveLength(1) // resume continuation
    expect(followups[0].content[0].text).toContain('Resume the task')
  })

  it('compact_context queues compaction and concludes the turn', async () => {
    const { handlers, registered, compactions, session, agent } = harness(0.5)
    const tool = registered.find((t) => t.name === 'compact_context')
    let concluded = false
    const exec = { agent, concludeTurn: () => { concluded = true } }
    const result = await tool.execute({}, exec)
    expect(result.queued).toBe(true)
    expect(concluded).toBe(true)
    await handlers['session/event'](session, { type: 'turn/end', data: {} })
    expect(compactions).toHaveLength(1)
    expect(compactions[0].session.id).toBe('s1')
  })

  it('passes the current route to compaction options', async () => {
    const { handlers, registered, compactions, session, agent } = harness(0.5)
    const tool = registered.find((t) => t.name === 'compact_context')
    await tool.execute({}, { agent, concludeTurn: () => {} })
    await handlers['session/event'](session, { type: 'turn/end', data: {} })
    expect(compactions[0].options.provider).toBe('deepseek')
    expect(compactions[0].options.model).toBe('deepseek-chat')
  })
})
