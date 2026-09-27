import { describe, expect, it } from './helpers.js'
import { createClassifier, CLASSIFIER_MODES } from '../src/intent-gate/classifier.js'
import { compileIntentTable, DEFAULT_INTENTS } from '../src/intent-gate/matcher.js'
import { apply } from '../src/intent-gate/index.js'

const INTENTS = compileIntentTable(DEFAULT_INTENTS)

function fakeLlm(answer, options = {}) {
  const calls = []
  return {
    calls,
    stream: async function* (request) {
      calls.push(request)
      if (options.hang) {
        await new Promise(() => {}) // never resolves: timeout probe
      }
      if (options.error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: options.error, code: 'X' } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const OVERRIDE = { provider: 'mock', model: 'mock-1' }

describe('createClassifier', () => {
  it('returns null for regex and unknown modes', () => {
    expect(createClassifier({ mode: 'regex', llm: {} })).toBeNull()
    expect(createClassifier({ mode: 'wat', llm: {} })).toBeNull()
    expect(CLASSIFIER_MODES).toEqual(['regex', 'llm', 'jev'])
  })

  it('classifies a semantic hit through the llm sidecar', async () => {
    const audits = []
    const classify = createClassifier({ mode: 'llm', llm: fakeLlm('deep-work'), routeOverride: OVERRIDE })
    const hit = await classify('please grind through this whole task end to end', INTENTS, {
      agent: { id: 's1' },
      onAudit: (event) => audits.push(event),
    })
    expect(hit).toBe('deep-work')
    expect(audits).toEqual([{ mode: 'llm', hit: 'deep-work' }])
  })

  it('sends the intent catalog and a capped prompt to the sidecar', async () => {
    const llm = fakeLlm('none')
    const classify = createClassifier({ mode: 'llm', llm, routeOverride: OVERRIDE })
    await classify('x'.repeat(5000), INTENTS, { agent: { id: 's1' } })
    const request = llm.calls[0]
    expect(request.provider).toBe('mock')
    expect(request.model).toBe('mock-1')
    expect(request.maxTokens).toBe(16)
    expect(request.temperature).toBe(0)
    expect(request.system).toContain('deep-work')
    expect(request.system).toContain('think')
    expect(request.messages[0].content[0].text).toHaveLength(4000)
  })

  it('falls back to the session route when no override is configured', async () => {
    const llm = fakeLlm('none')
    const classify = createClassifier({ mode: 'llm', llm })
    await classify('hello there', INTENTS, {
      agent: { id: 's1', session: { requestContext: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) } },
    })
    expect(llm.calls[0].provider).toBe('deepseek')
  })

  it('treats none / empty answers as no hit without fallback', async () => {
    const audits = []
    const classify = createClassifier({ mode: 'llm', llm: fakeLlm('none'), routeOverride: OVERRIDE })
    expect(await classify('just chatting', INTENTS, { agent: { id: 's1' }, onAudit: (e) => audits.push(e) })).toBeNull()
    expect(audits[0].fallback).toBeUndefined()
  })

  it('rejects unknown answers with a fallback audit', async () => {
    const audits = []
    const classify = createClassifier({ mode: 'llm', llm: fakeLlm('hallucinated-intent'), routeOverride: OVERRIDE })
    const hit = await classify('do something', INTENTS, { agent: { id: 's1' }, onAudit: (e) => audits.push(e) })
    expect(hit).toBeNull()
    expect(audits[0].fallback).toMatch(/^unknown-answer:hallucinated-intent/)
  })

  it('fails open on timeout', async () => {
    const audits = []
    const classify = createClassifier({ mode: 'llm', llm: fakeLlm('', { hang: true }), routeOverride: OVERRIDE, timeoutMs: 20 })
    const hit = await classify('slow prompt', INTENTS, { agent: { id: 's1' }, onAudit: (e) => audits.push(e) })
    expect(hit).toBeNull()
    expect(audits[0].fallback).toBe('timeout')
  })

  it('fails open on stream errors', async () => {
    const audits = []
    const classify = createClassifier({ mode: 'llm', llm: fakeLlm('', { error: 'provider down' }), routeOverride: OVERRIDE })
    expect(await classify('any prompt', INTENTS, { agent: { id: 's1' }, onAudit: (e) => audits.push(e) })).toBeNull()
    expect(audits[0].fallback).toMatch(/^error:provider down/)
  })

  it('fails open when no route resolves', async () => {
    const audits = []
    const classify = createClassifier({ mode: 'llm', llm: fakeLlm('deep-work') })
    expect(await classify('no route here', INTENTS, { agent: { id: 's1' }, onAudit: (e) => audits.push(e) })).toBeNull()
    expect(audits[0].fallback).toMatch(/no classifier route/)
  })

  it('caches per session and prompt (one sidecar call per distinct prompt)', async () => {
    const llm = fakeLlm('research')
    const classify = createClassifier({ mode: 'llm', llm, routeOverride: OVERRIDE })
    const agentA = { id: 'A' }
    const agentB = { id: 'B' }
    await classify('same words', INTENTS, { agent: agentA })
    await classify('same words', INTENTS, { agent: agentA })
    await classify('same words', INTENTS, { agent: agentB })
    expect(llm.calls).toHaveLength(2)
  })

  it('jev mode fails open without an endpoint and classifies with one', async () => {
    const audits = []
    const noEndpoint = createClassifier({ mode: 'jev', llm: {}, jev: {} })
    expect(await noEndpoint('prompt', INTENTS, { agent: { id: 's1' }, onAudit: (e) => audits.push(e) })).toBeNull()
    expect(audits[0].fallback).toMatch(/jev\.endpoint/)

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      expect(url).toBe('https://jev.example/decide')
      expect(JSON.parse(init.body).options).toContain('deep-work')
      return { ok: true, json: async () => ({ option: 'research' }) }
    }
    try {
      const classify = createClassifier({ mode: 'jev', llm: {}, jev: { endpoint: 'https://jev.example/decide' } })
      expect(await classify('investigate this library', INTENTS, { agent: { id: 's1' } })).toBe('research')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('intent-gate with a semantic classifier', () => {
  function fakeCtx(llm) {
    const handlers = {}
    const emitted = []
    return {
      handlers,
      emitted,
      llm,
      on(event, handler) {
        handlers[event] = handler
      },
      emit(type, record) {
        emitted.push({ type, record })
      },
    }
  }
  const promptMessage = (text) => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const agentOf = (appended) => ({ id: 'session-1', session: { append: (type, data) => appended.push({ type, data }) } })

  it('regex hit short-circuits the sidecar in llm mode', async () => {
    const llm = fakeLlm('research')
    const ctx = fakeCtx(llm)
    apply(ctx, { classifier: 'llm', classifierProvider: 'mock', classifierModel: 'mock-1' })
    await ctx.handlers['agent/pre-step'](
      { agent: agentOf([]), messages: [promptMessage('do deep work now')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(llm.calls).toHaveLength(0)
  })

  it('semantic hit injects like a keyword hit', async () => {
    const llm = fakeLlm('deep-work')
    const ctx = fakeCtx(llm)
    apply(ctx, { classifier: 'llm', classifierProvider: 'mock', classifierModel: 'mock-1' })
    const result = await ctx.handlers['agent/pre-step'](
      { agent: agentOf([]), messages: [promptMessage('grind this task to full completion with evidence')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content[0].text).toContain('deep-work')
    expect(llm.calls).toHaveLength(1)
  })

  it('semantic think hit raises the reasoning effort', async () => {
    const llm = fakeLlm('think')
    const ctx = fakeCtx(llm)
    apply(ctx, { classifier: 'llm', classifierProvider: 'mock', classifierModel: 'mock-1' })
    const agent = agentOf([])
    await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('reason very carefully about this proof')], turn: 3, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const raised = await ctx.handlers['agent/request']({ agent, turn: 3, step: 1 }, async () => ({}))
    expect(raised.reasoningEffort).toBe('high')
  })

  it('classifier fallback passes the prompt through and records the audit', async () => {
    const llm = fakeLlm('', { error: 'provider down' })
    const ctx = fakeCtx(llm)
    apply(ctx, { classifier: 'llm', classifierProvider: 'mock', classifierModel: 'mock-1' })
    const result = await ctx.handlers['agent/pre-step'](
      { agent: agentOf([]), messages: [promptMessage('no keywords here')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(result.messages).toHaveLength(0)
    expect(ctx.emitted.some((e) => e.type === 'orrery/intent-classify' && e.record.data.fallback)).toBe(true)
  })

  it('regex mode never touches the sidecar', async () => {
    const llm = fakeLlm('deep-work')
    const ctx = fakeCtx(llm)
    apply(ctx, {})
    await ctx.handlers['agent/pre-step'](
      { agent: agentOf([]), messages: [promptMessage('no keywords at all')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(llm.calls).toHaveLength(0)
  })
})
