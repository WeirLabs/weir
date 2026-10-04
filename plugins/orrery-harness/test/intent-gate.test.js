import { describe, expect, it } from './helpers.js'
import {
  compileIntentTable,
  DEFAULT_INTENTS,
  matchIntents,
  renderReminder,
  renderSkillPointer,
  stripQuotedRegions,
} from '../src/intent-gate/matcher.js'
import { apply } from '../src/intent-gate/index.js'

describe('stripQuotedRegions', () => {
  it('blanks fenced code blocks', () => {
    const input = 'please debug this\n```\ndeep work code\n```\nafter'
    const stripped = stripQuotedRegions(input)
    expect(stripped).toContain('please debug this')
    expect(stripped).toContain('after')
    expect(stripped).not.toContain('deep work code')
  })

  it('blanks inline code and blockquotes', () => {
    const input = 'run `deep work` now\n> research is great\nplain research'
    const stripped = stripQuotedRegions(input)
    expect(stripped).toContain('plain research')
    expect(stripped).not.toContain('`deep work`')
    expect(stripped).not.toContain('research is great')
  })
})

describe('compileIntentTable', () => {
  it('compiles the default table', () => {
    const table = compileIntentTable(DEFAULT_INTENTS)
    expect(table).toHaveLength(5)
    expect(table[0].id).toBe('deep-work')
  })

  it('rejects invalid regexes with the intent id', () => {
    expect(() => compileIntentTable([{ id: 'bad', matchers: ['(['], injection: { kind: 'message', text: 'x' } }]))
      .toThrow(/bad/)
  })

  it('rejects duplicate ids', () => {
    const entry = { id: 'x', matchers: ['x'], injection: { kind: 'message', text: 't' } }
    expect(() => compileIntentTable([entry, entry])).toThrow(/duplicate/)
  })

  it('rejects unknown injection kinds', () => {
    expect(() => compileIntentTable([{ id: 'x', matchers: ['x'], injection: { kind: 'wat' } }]))
      .toThrow(/unknown injection kind/)
  })
})

describe('matchIntents', () => {
  const table = compileIntentTable(DEFAULT_INTENTS)

  it('matches deep-work in English and Chinese', () => {
    expect(matchIntents('do some deep work here', table).map((i) => i.id)).toEqual(['deep-work'])
    expect(matchIntents('请深度工作一下', table).map((i) => i.id)).toEqual(['deep-work'])
  })

  it('returns nothing without a keyword', () => {
    expect(matchIntents('fix the login button alignment', table)).toHaveLength(0)
  })

  it('does not match keywords inside code regions', () => {
    const text = stripQuotedRegions('```\n深度工作\n```\nnormal task')
    expect(matchIntents(text, table)).toHaveLength(0)
  })

  it('keeps table order on multiple hits', () => {
    const hits = matchIntents('调研 then deep work', table)
    expect(hits.map((i) => i.id)).toEqual(['deep-work', 'research'])
  })
})

describe('intent-gate plugin', () => {
  function fakeCtx() {
    const handlers = {}
    const emitted = []
    return {
      handlers,
      emitted,
      on(event, handler) {
        handlers[event] = handler
      },
      emit(type, record) {
        emitted.push({ type, record })
      },
    }
  }
  function fakeAgent(appended) {
    return {
      id: 'session-1',
      session: { append: (type, data) => appended.push({ type, data }) },
    }
  }
  function promptMessage(text) {
    return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  }

  it('injects the full payload on first hit and a reminder on repeat', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])

    const first = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('do deep work on this')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [promptMessage('do deep work on this')] }),
    )
    expect(first.kind).toBe('enter')
    expect(first.messages).toHaveLength(2)
    expect(first.messages[1].content[0].text).toContain('deep-work')
    expect(first.messages[1].content[0].text).toContain('skill')

    const second = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('more deep work please')], turn: 2, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0].content[0].text).toContain('already armed')

    expect(ctx.emitted.filter((e) => e.type === 'orrery/intent-hit')).toHaveLength(2)
  })

  it('uses an overlay route that becomes visible only after apply (rc.2 activation timing)', async () => {
    const ctx = fakeCtx()
    let service
    ctx.get = (name) => (name === 'orrerySettings' ? service : undefined)
    const calls = []
    ctx.llm = {
      stream: async function* (request) {
        calls.push(request)
        yield { type: 'text-delta', index: 0, text: 'deep-work' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    // The settings service is still invisible at apply (rc.2 cordis activates
    // providers after the apply batch).
    apply(ctx, { classifier: 'llm' })
    service = { get: (section) => (section === 'intentGate' ? { classifierProvider: 'mock', classifierModel: 'mock-1' } : undefined) }
    const agent = fakeAgent([])
    const result = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('把这个任务从头到尾彻底完成，每一步都要拿出证据')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].provider).toBe('mock')
    expect(calls[0].model).toBe('mock-1')
    expect(result.messages.at(-1).content[0].text).toContain('deep-work')
  })

  it('passes through without keywords', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    const result = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('plain question')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(result.messages).toHaveLength(0)
  })

  it('scans past injected messages to the newest genuine user prompt', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    const settled = {
      id: 's1',
      role: 'user',
      content: [{ type: 'text', text: 'deep work research debugging review' }],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'abc' },
    }
    const result = await ctx.handlers['agent/pre-step'](
      { agent, messages: [settled, promptMessage('do deep work now')], turn: 3, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content[0].text).toContain('deep-work')
  })

  // Plugin-level behavior assertion: the gate's own injected notice is never
  // treated as user intent. The full injection-source exemption matrix lives
  // in test/runtime-messages.test.js.
  it('does not re-scan its own injected notices', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    const own = {
      id: 'g1',
      role: 'user',
      content: [{ type: 'text', text: 'The user request matched the "research" intent. Load and follow the "research" skill NOW.' }],
      source: { kind: 'orrery-intent-gate' },
    }
    const result = await ctx.handlers['agent/pre-step'](
      { agent, messages: [own], turn: 4, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(result.messages).toHaveLength(0)
    expect(ctx.emitted.filter((e) => e.type === 'orrery/intent-hit')).toHaveLength(0)
  })

  it('raises reasoning effort for the think intent in the same turn', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('ultrathink this design')], turn: 7, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const raised = await ctx.handlers['agent/request'](
      { agent, turn: 7, step: 1 },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    )
    expect(raised.reasoningEffort).toBe('high')
    const untouched = await ctx.handlers['agent/request'](
      { agent, turn: 8, step: 1 },
      async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    )
    expect(untouched.reasoningEffort).toBeUndefined()
  })

  it('rejects invalid config at activation', () => {
    expect(() => apply(fakeCtx(), { intents: [{ id: 'x', matchers: ['(['], injection: { kind: 'message', text: 't' } }] }))
      .toThrow(/invalid matcher/)
  })
})

describe('templates', () => {
  it('skill pointer names the skill and the tool call', () => {
    const text = renderSkillPointer({ id: 'deep-work', injection: { skill: 'deep-work' } })
    expect(text).toContain('skill(name="deep-work")')
    expect(text).toContain('once per session')
  })

  it('reminder is short and names the intent', () => {
    const text = renderReminder({ id: 'deep-work' })
    expect(text).toContain('deep-work')
    expect(text.split('\n')).toHaveLength(1)
  })
})
