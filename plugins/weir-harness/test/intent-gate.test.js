import { describe, expect, it } from './helpers.js'
import {
  compileIntentTable,
  DEFAULT_INTENTS,
  matchIntents,
  renderReminder,
  renderSkillPointer,
  stripQuotedRegions,
  WRITING_DIRECTIVE,
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
    expect(table).toHaveLength(7)
    expect(table[1].id).toBe('deep-work')
    const writing = table.find((intent) => intent.id === 'writing')
    expect(writing.id).toBe('writing')
    expect(writing.oncePerSession).toBe(false)
    expect(writing.summary).toBe('author a documentation-style deliverable (docs, README, guide, report) as the finished result')
    expect(writing.patterns).toHaveLength(7)
  })

  it('keeps a configured summary and omits an absent or empty one', () => {
    const table = compileIntentTable([
      { id: 'described', matchers: ['x'], summary: 'one-line catalog description', injection: { kind: 'message', text: 't' } },
      { id: 'empty', matchers: ['y'], summary: '', injection: { kind: 'message', text: 't' } },
      { id: 'absent', matchers: ['z'], injection: { kind: 'message', text: 't' } },
    ])
    expect(table[0].summary).toBe('one-line catalog description')
    expect('summary' in table[1]).toBe(false)
    expect('summary' in table[2]).toBe(false)
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
  it('matches genuine English and Chinese MCP setup requests only', () => {
    const positive = [
      'please install an MCP server',
      'add the filesystem MCP server',
      'set up GitHub MCP',
      'configure the remote MCP server',
      '请安装一个 MCP 服务器',
      '配置 GitHub MCP 服务器',
    ]
    for (const text of positive) expect(matchIntents(text, table).map(intent => intent.id)).toContain('mcp-server-setup')
    const negative = [
      'do not install an MCP server',
      'don’t install an MCP server',
      'never add an MCP server',
      '不要安装 MCP 服务器',
      'what does MCP configuration mean?',
      'explain how to configure an MCP server',
      'call the existing MCP server tool',
      'troubleshoot the configured MCP server',
      'MCP server installation is unavailable',
    ]
    for (const text of negative) expect(matchIntents(text, table).map(intent => intent.id)).not.toContain('mcp-server-setup')
  })

  it('suppresses quoted and unclosed MCP configuration examples', () => {
    const examples = [
      '> please install an MCP server',
      '```json\n{"mcpServers":{"docs":{"command":"install MCP"}}}',
      'example: `install an MCP server',
    ]
    for (const text of examples) expect(matchIntents(stripQuotedRegions(text), table).map(intent => intent.id)).not.toContain('mcp-server-setup')
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
  const eligibleSelection = {
    selectionFor: () => ({
      provider: {
        list: async () => ({
          candidates: ['mcp-server-setup', 'deep-work', 'research', 'review-work', 'debugging'].map(name => ({
            name, provider: 'weir-selected', invocation: { modelInvocable: true, userInvocable: true },
          })),
        }),
      },
    }),
  }
  const applyEligible = (ctx, config = {}) => apply(ctx, config, eligibleSelection)
  function promptMessage(text) {
    return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  }

  it('injects the full payload on first hit and a reminder on repeat', async () => {
    const ctx = fakeCtx()
    applyEligible(ctx, {})
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

    expect(ctx.emitted.filter((e) => e.type === 'weir/intent-hit')).toHaveLength(2)
  })

  it('injects the writing directive for a Chinese doc-writing request', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    const prompt = promptMessage('帮我写一份部署说明')
    const result = await ctx.handlers['agent/pre-step'](
      { agent, messages: [prompt], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [prompt] }),
    )
    expect(result.messages).toHaveLength(2)
    const text = result.messages[1].content[0].text
    expect(text).toContain('<intent-gate id="writing">')
    expect(text).toContain('no trace')
    expect(text).toContain('explanatory UI copy')
    expect(result.messages[0]).toBe(prompt)
    expect(result.messages[0].content[0].text).toBe('帮我写一份部署说明')
    const hits = ctx.emitted.filter((event) => event.type === 'weir/intent-hit')
    expect(hits).toHaveLength(1)
    expect(hits[0].record.data.intent).toBe('writing')
  })

  it('injects the writing directive for an English doc-writing request', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    const result = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('write a deployment guide')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(result.messages).toHaveLength(1)
    const text = result.messages[0].content[0].text
    expect(text).toContain('<intent-gate id="writing">')
    expect(text).toContain('finished product')
    expect(ctx.emitted.filter((event) => event.type === 'weir/intent-hit')).toHaveLength(1)
  })

  it('re-injects the full writing directive on every doc-writing request', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    const first = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('帮我写一份部署说明')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const second = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('再写一篇 FAQ 文档')], turn: 2, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(first.messages).toHaveLength(1)
    expect(second.messages).toHaveLength(1)
    expect(first.messages[0].content[0].text).toContain('no trace')
    expect(second.messages[0].content[0].text).toContain('no trace')
    expect(second.messages[0].content[0].text).not.toContain('already armed')
    const hits = ctx.emitted.filter((event) => event.type === 'weir/intent-hit' && event.record.data.intent === 'writing')
    expect(hits).toHaveLength(2)
    expect(hits.every((event) => event.record.data.first === true)).toBe(true)
  })

  it('passes through a doc-reading request without a writing verb', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    const result = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('读一下这份文档，然后修掉这个 bug')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(result.messages).toHaveLength(0)
    expect(ctx.emitted.filter((event) => event.type === 'weir/intent-hit')).toHaveLength(0)
  })

  it('passes through when the writing keyword sits inside a fenced code block', async () => {
    const ctx = fakeCtx()
    apply(ctx, {})
    const agent = fakeAgent([])
    const result = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('```\n写文档\n```\n现在实现这个功能')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(result.messages).toHaveLength(0)
    expect(ctx.emitted.filter((event) => event.type === 'weir/intent-hit')).toHaveLength(0)
  })

  it('uses an overlay route that becomes visible only after apply (rc.2 activation timing)', async () => {
    const ctx = fakeCtx()
    let service
    ctx.get = (name) => (name === 'weirSettings' ? service : undefined)
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
    applyEligible(ctx, { classifier: 'llm' })
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
    applyEligible(ctx, {})
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
      source: { kind: 'weir-intent-gate' },
    }
    const result = await ctx.handlers['agent/pre-step'](
      { agent, messages: [own], turn: 4, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(result.messages).toHaveLength(0)
    expect(ctx.emitted.filter((e) => e.type === 'weir/intent-hit')).toHaveLength(0)
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

  it('injects the MCP setup pointer once with cold-safe audit and reminders', async () => {
    const ctx = fakeCtx()
    const appended = []
    applyEligible(ctx, {})
    const agent = fakeAgent(appended)
    const first = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('please install an MCP server')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0].content[0].text).toContain('mcp-server-setup')
    expect(first.messages[0].content[0].text).toContain('skill(name="mcp-server-setup")')
    const second = await ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('add another MCP server')], turn: 2, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(second.messages[0].content[0].text).toContain('already armed')
    expect(appended).toEqual([])
    const hits = ctx.emitted.filter(event => event.type === 'weir/intent-hit' && event.record.data.intent === 'mcp-server-setup')
    expect(hits.map(hit => hit.record.data.first)).toEqual([true, false])
  })

  it('suppresses missing, throwing, and non-explicit eligibility without arming MCP setup', async () => {
    const ctx = fakeCtx()
    let mode = 'missing'
    const selectionFor = () => {
      if (mode === 'missing') return null
      if (mode === 'throw') return { provider: { list: async () => { throw new Error('view unavailable') } } }
      if (mode === 'truthy') return {
        provider: {
          list: async () => ({ candidates: [{ name: 'mcp-server-setup', provider: 'weir-selected', invocation: { modelInvocable: 'yes', userInvocable: true } }] }),
        },
      }
      return eligibleSelection.selectionFor()
    }
    apply(ctx, {}, { selectionFor })
    const agent = fakeAgent([])
    const hit = () => ctx.handlers['agent/pre-step'](
      { agent, messages: [promptMessage('install an MCP server')], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect((await hit()).messages).toHaveLength(0)
    mode = 'truthy'
    expect((await hit()).messages).toHaveLength(0)
    mode = 'throw'
    expect((await hit()).messages).toHaveLength(0)
    mode = 'eligible'
    const recovered = await hit()
    expect(recovered.messages).toHaveLength(1)
    expect(recovered.messages[0].content[0].text).not.toContain('already armed')
    const audits = ctx.emitted.filter(event => event.type === 'weir/intent-hit' && event.record.data.intent === 'mcp-server-setup')
    expect(audits.slice(0, 3).every(event => event.record.data.first === false && event.record.data.suppressed)).toBe(true)
    expect(audits.at(-1).record.data.first).toBe(true)
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

describe('WRITING_DIRECTIVE', () => {
  it('states the finished-product discipline as an English template', () => {
    for (const lead of ['finished product', 'implementation rationale', 'explanatory UI copy', 'verification method', 'no trace']) {
      expect(WRITING_DIRECTIVE).toContain(lead)
    }
    expect(/[\u4e00-\u9fff]/.test(WRITING_DIRECTIVE)).toBe(false)
  })
})
