import { describe, expect, it } from './helpers.js'
import { CURATED_AGENTS } from '../src/delegate/agents.js'
import { DEFAULT_CATEGORIES } from '../src/delegate/categories.js'
import { parseEscalation } from '../src/delegate/escalate.js'
import { modelFamily, pickVariant } from '../src/delegate/families.js'
import { resolveCategory, rungResolves, snapshotProviders } from '../src/delegate/resolver.js'
import { createDelegateTool, normalizeItems } from '../src/delegate/tool.js'
import { apply } from '../src/delegate/index.js'

describe('resolver', () => {
  const snapshot = new Map([
    ['deepseek', ['deepseek-chat', 'deepseek-reasoner']],
    ['empty-catalog', null],
  ])

  it('resolves the first resolvable rung', () => {
    const category = {
      chain: [
        { provider: 'absent', model: 'x' },
        { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
      ],
    }
    const route = resolveCategory(category, snapshot, false)
    expect(route.kind).toBe('resolved')
    expect(route.provider).toBe('deepseek')
    expect(route.model).toBe('deepseek-chat')
    expect(route.reasoningEffort).toBe('low')
  })

  it('inherits when the chain is empty', () => {
    expect(resolveCategory({ chain: [] }, snapshot, false).kind).toBe('inherited')
  })

  it('reports unavailable when no rung resolves', () => {
    const route = resolveCategory({ chain: [{ provider: 'absent', model: 'x' }] }, snapshot, false)
    expect(route.kind).toBe('unavailable')
    expect(route.reason).toContain('absent/x')
  })

  it('treats null catalogs as unconstrained', () => {
    expect(rungResolves({ provider: 'empty-catalog', model: 'anything' }, snapshot)).toBe(true)
  })

  it('enforces gateModels unless the user configured the category', () => {
    const category = { chain: [], gateModels: ['gpt-6-astra'] }
    expect(resolveCategory(category, snapshot, false).kind).toBe('unavailable')
    expect(resolveCategory(category, snapshot, true).kind).toBe('inherited')
  })

  it('snapshots providers with catalog failure tolerance', async () => {
    const llm = {
      listProviders: () => [{ id: 'a' }, { id: 'b' }],
      listModels: async (provider) => (provider === 'a' ? [{ id: 'm1' }] : Promise.reject(new Error('no catalog'))),
    }
    const snap = await snapshotProviders(llm)
    expect(snap.get('a')).toEqual(['m1'])
    expect(snap.get('b')).toBeNull()
  })
})

describe('families', () => {
  it('detects families from model ids', () => {
    expect(modelFamily('claude-opus-5-5')).toBe('mechanics')
    expect(modelFamily('kimi-k3')).toBe('mechanics')
    expect(modelFamily('gpt-6-astra')).toBe('principle')
    expect(modelFamily('deepseek-chat')).toBe('neutral')
    expect(modelFamily(undefined)).toBe('neutral')
  })

  it('picks variants with default fallback', () => {
    const append = { default: 'd', mechanics: 'm', principle: 'p' }
    expect(pickVariant(append, 'mechanics')).toBe('m')
    expect(pickVariant(append, 'principle')).toBe('p')
    expect(pickVariant(append, 'neutral')).toBe('d')
    expect(pickVariant('plain', 'mechanics')).toBe('plain')
    expect(pickVariant({ default: 'd' }, 'mechanics')).toBe('d')
  })
})

describe('escalate', () => {
  it('parses a first-line escalation with findings', () => {
    const parsed = parseEscalation('ESCALATE: deep-plus\nI read X and cannot settle Y.')
    expect(parsed.target).toBe('deep-plus')
    expect(parsed.findings).toContain('cannot settle Y')
  })

  it('ignores non-escalations and mid-text mentions', () => {
    expect(parseEscalation('all done')).toBeNull()
    expect(parseEscalation('result\nESCALATE: deep-plus')).toBeNull()
  })
})

describe('normalizeItems', () => {
  it('accepts a single category call', () => {
    const items = normalizeItems({ category: 'quick', prompt: 'TASK: fix typo' })
    expect(items).toHaveLength(1)
    expect(items[0].category).toBe('quick')
  })

  it('rejects prompt+tasks together', () => {
    expect(() => normalizeItems({ prompt: 'x', tasks: [{ prompt: 'y', agent: 'explore' }] })).toThrow(/either prompt/)
  })

  it('rejects items with both or neither target', () => {
    expect(() => normalizeItems({ tasks: [{ prompt: 'x', category: 'quick', agent: 'explore' }] })).toThrow(/exactly one/)
    expect(() => normalizeItems({ tasks: [{ prompt: 'x' }] })).toThrow(/exactly one/)
  })

  it('rejects model with category', () => {
    expect(() => normalizeItems({ category: 'quick', prompt: 'x', model: 'm' })).toThrow(/must not combine model/)
  })

  it('caps batch size', () => {
    const tasks = Array.from({ length: 17 }, (_, i) => ({ prompt: `t${i}`, agent: 'explore' }))
    expect(() => normalizeItems({ tasks })).toThrow(/capped at 16/)
  })

  it('inherits top-level options into items', () => {
    const [item] = normalizeItems({
      tasks: [{ prompt: 'x', category: 'quick' }],
      load_skills: ['debugging'],
      task_summary: 'batch label',
    })
    expect(item.load_skills).toEqual(['debugging'])
    expect(item.task_summary).toBe('batch label')
  })
})

describe('delegate tool', () => {
  function fakeExec(depth = 0) {
    return {
      agent: {
        id: 'parent-session',
        session: {
          header: { delegationDepth: depth },
          requestContext: () => undefined,
        },
      },
      signal: new AbortController().signal,
    }
  }

  function fakeDeps(overrides = {}) {
    const spawned = []
    return {
      spawned,
      resolveTarget: overrides.resolveTarget ?? (async (item) => ({
        persona: 'persona',
        label: item.name ?? 'child',
        ...(item.agent === 'explore' ? { toolFilter: { allow: ['read'] } } : {}),
      })),
      loadSkill: async () => 'skill-body',
      subagents: {
        async start(provider, request) {
          spawned.push({ provider, request })
          return {
            id: 'child-1',
            result: Promise.resolve({
              output: [{ type: 'text', text: 'done the thing' }],
              stopReason: 'completed',
            }),
            dispose: async () => {},
          }
        },
      },
      jobs: overrides.jobs,
    }
  }

  it('spawns a foreground child and returns its text', async () => {
    const deps = fakeDeps()
    const tool = createDelegateTool(deps)
    const result = await tool.execute({ category: 'quick', prompt: 'TASK: fix' }, fakeExec())
    expect(result.background).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].text).toBe('done the thing')
    expect(deps.spawned[0].request.maxDepth).toBe(1)
    expect(deps.spawned[0].request.persona).toBe('persona')
  })

  it('refuses delegation from a child session', async () => {
    const tool = createDelegateTool(fakeDeps())
    await expect(async () => tool.execute({ category: 'quick', prompt: 'x' }, fakeExec(1))).rejects.toThrow(/depth limit/)
  })

  it('registers a background job and returns its id', async () => {
    const started = []
    const deps = fakeDeps({
      jobs: {
        start(spec) {
          started.push(spec)
          return 'subagent-7'
        },
      },
    })
    const tool = createDelegateTool(deps)
    const result = await tool.execute({ agent: 'explore', prompt: 'TASK: find', run_in_background: true }, fakeExec())
    expect(result.background).toBe(true)
    expect(result.jobs[0].job_id).toBe('subagent-7')
    expect(started[0].kind).toBe('subagent')
    expect(started[0].owner).toBe('parent-session')
  })

  it('fails background calls without a jobs registry', async () => {
    const tool = createDelegateTool(fakeDeps({ jobs: undefined }))
    await expect(async () =>
      tool.execute({ agent: 'explore', prompt: 'x', run_in_background: true }, fakeExec()),
    ).rejects.toThrow(/background jobs are unavailable/)
  })

  it('respawns once on ESCALATE with findings', async () => {
    const deps = fakeDeps()
    const calls = []
    deps.subagents.start = async (provider, request) => {
      calls.push({ provider, request })
      return {
        id: `child-${calls.length}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: calls.length === 1 ? 'ESCALATE: deep-plus\nfound the boundary' : 'settled properly' }],
          stopReason: 'completed',
        }),
        dispose: async () => {},
      }
    }
    const tool = createDelegateTool(deps)
    const result = await tool.execute({ category: 'deep', prompt: 'TASK: decide' }, fakeExec())
    expect(result.results[0].escalated).toBe('deep-plus')
    expect(result.results[0].text).toBe('settled properly')
    expect(calls).toHaveLength(2)
    expect(calls[1].request.prompt.at(-1).text).toContain('found the boundary')
  })
})

describe('registry defaults', () => {
  it('ships the nine categories and three curated agents', () => {
    expect(Object.keys(DEFAULT_CATEGORIES).sort()).toEqual([
      'architect', 'artistry', 'deep', 'deep-plus', 'general-high', 'general-low', 'quick', 'visual', 'writing',
    ])
    expect(Object.keys(CURATED_AGENTS).sort()).toEqual(['explore', 'librarian', 'oracle'])
  })

  it('curated agents are read-only', () => {
    for (const agent of Object.values(CURATED_AGENTS)) {
      expect(agent.tools).not.toContain('write')
      expect(agent.tools).not.toContain('edit')
      expect(agent.tools).not.toContain('bash')
    }
  })

  it('architect is a read-only advisory lane', () => {
    expect(DEFAULT_CATEGORIES.architect.readOnly).toBe(true)
  })
})

describe('delegate plugin apply', () => {
  const execStub = () => ({ agent: { id: 'parent-session', session: { header: { delegationDepth: 0 } } }, signal: undefined })

  it('registers the delegate tool', () => {
    const registered = []
    const ctx = {
      tools: { register: (tool) => registered.push(tool) },
      subagents: {},
      llm: { listProviders: () => [], listModels: async () => [] },
      skills: {},
      get: () => undefined,
      on: () => {},
    }
    apply(ctx, {})
    expect(registered.map((tool) => tool.name)).toEqual(['delegate', 'resume_agent', 'terminate_agent'])
  })

  function applyHarness(config = {}) {
    const registered = []
    const spawned = []
    const guards = []
    const ctx = {
      tools: { register: (tool) => registered.push(tool) },
      subagents: {
        async start(provider, request) {
          spawned.push({ provider, request })
          return {
            id: 'child-ro',
            localAgent: {
              ctx: {
                tools: {
                  guard: (fn) => {
                    guards.push(fn)
                    return () => {}
                  },
                },
              },
            },
            result: Promise.resolve({ output: [{ type: 'text', text: 'ro findings' }], stopReason: 'completed' }),
            dispose: async () => {},
          }
        },
      },
      llm: { listProviders: () => [], listModels: async () => [] },
      skills: {},
      get: () => undefined,
      on: () => {},
    }
    apply(ctx, config)
    return { tool: registered[0], spawned, guards }
  }

  it('curated spawns get bash in the allowlist, a persona note, and a live guard', async () => {
    const { tool, spawned, guards } = applyHarness()
    const result = await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(result.results[0].text).toBe('ro findings')
    expect(spawned[0].request.toolFilter.allow).toContain('bash')
    expect(spawned[0].request.toolFilter.allow).toContain('read')
    expect(spawned[0].request.persona).toContain('guarded read-only')
    expect(guards).toHaveLength(1)
    expect(guards[0]({ name: 'bash', arguments: { command: 'git status' } })).toBe(undefined)
    expect(guards[0]({ name: 'bash', arguments: { command: 'rm x' } })).toMatch(/explicitly denied/)
  })

  it('non-read-only targets get no guard', async () => {
    const { tool, guards } = applyHarness()
    await tool.execute({ category: 'quick', prompt: 'TASK: go' }, execStub())
    expect(guards).toHaveLength(0)
  })

  it('readOnlyBash disabled drops bash from the allowlist and skips the guard', async () => {
    const { tool, spawned, guards } = applyHarness({ readOnlyBash: { enabled: false } })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(spawned[0].request.toolFilter.allow).not.toContain('bash')
    expect(spawned[0].request.persona).not.toContain('guarded read-only')
    expect(guards).toHaveLength(0)
  })

  it('a failing guard attach disposes the child and fails the call', async () => {
    const disposed = []
    const deps = {
      resolveTarget: async () => ({ persona: 'p', label: 'ro', readOnly: true }),
      loadSkill: async () => 's',
      subagents: {
        async start() {
          return {
            id: 'child-x',
            localAgent: { ctx: { tools: { guard: () => { throw new Error('no tools service') } } } },
            result: Promise.resolve({ output: [], stopReason: 'completed' }),
            dispose: async () => {
              disposed.push(true)
            },
          }
        },
      },
      jobs: undefined,
      robash: { enabled: true, lists: { allow: ['ls'], gitAllow: [], deny: [] } },
    }
    const guardedTool = createDelegateTool(deps)
    await expect(async () => guardedTool.execute({ agent: 'explore', prompt: 'x' }, execStub())).rejects.toThrow(/failed to attach/)
    expect(disposed).toEqual([true])
  })
})

describe('supervised groups (mount layer)', () => {
  const execStub = () => ({ agent: { id: 'parent-session', session: { header: { delegationDepth: 0 } } }, signal: new AbortController().signal })

  function groupHarness(config = {}) {
    const registered = []
    const continued = []
    const sent = []
    const interruptedCalls = []
    const scheduled = []
    const steered = []
    const sessionEvents = []
    const handlers = {}
    const ctx = {
      tools: { register: (tool) => registered.push(tool) },
      subagents: {
        async startContinuable(spec) {
          continued.push(spec)
          return { childId: `child-${continued.length}`, messageId: `msg-${continued.length}` }
        },
        async sendMessage(sender, targetId, content) {
          sent.push({ targetId, text: content[0].text })
          return `msg-${sent.length}`
        },
        interrupt(targetId, authority) {
          interruptedCalls.push({ targetId, authority })
        },
      },
      llm: { listProviders: () => [], listModels: async () => [] },
      skills: {},
      get: () => undefined,
      on(event, handler) {
        handlers[event] = handler
      },
      emit: (type, record) => emitted.push({ type, record }),
    }
    const emitted = []
    apply(ctx, config)
    return {
      ctx,
      handlers,
      continued,
      sent,
      interruptedCalls,
      scheduled,
      steered,
      sessionEvents,
      emitted,
      tools: Object.fromEntries(registered.map((tool) => [tool.name, tool])),
    }
  }

  it('registers resume_agent and terminate_agent with object-rooted schemas', () => {
    const { tools } = groupHarness()
    expect(tools.resume_agent.parameters.type).toBe('object')
    expect(tools.resume_agent.parameters.required).toEqual(['agent', 'context'])
    expect(tools.terminate_agent.parameters.type).toBe('object')
    expect(tools.terminate_agent.parameters.required).toEqual(['agent'])
  })

  it('spawns a supervised group as continuable children with the status contract', async () => {
    const { tools, continued } = groupHarness()
    const result = await tools.delegate.execute(
      { group: 'scan', tasks: [
        { category: 'quick', prompt: 'TASK: a' },
        { category: 'quick', prompt: 'TASK: b' },
      ] },
      execStub(),
    )
    expect(result.supervised).toBe(true)
    expect(result.group).toBe('scan')
    expect(result.members).toHaveLength(2)
    expect(continued).toHaveLength(2)
    expect(continued[0].request.persona).toContain('STATUS: completed')
    expect(continued[0].request.persona).toContain('Terminal status contract')
    expect(continued[0].request.maxDepth).toBe(1)
  })

  it('rejects a second delegation into a live group', async () => {
    const { tools } = groupHarness()
    await tools.delegate.execute({ group: 'scan', category: 'quick', prompt: 'TASK: a' }, execStub())
    await expect(async () =>
      tools.delegate.execute({ group: 'scan', category: 'quick', prompt: 'TASK: b' }, execStub()),
    ).rejects.toThrow(/does not accept insertion/)
  })

  it('rejects group combined with run_in_background', async () => {
    const { tools } = groupHarness()
    await expect(async () =>
      tools.delegate.execute({ group: 'scan', category: 'quick', prompt: 'TASK: a', run_in_background: true }, execStub()),
    ).rejects.toThrow(/cannot be combined/)
  })

  it('drives child turn ends through the state machine and flushes at turn-stopping', async () => {
    const { tools, handlers } = groupHarness()
    await tools.delegate.execute(
      { group: 'scan', tasks: [
        { category: 'quick', prompt: 'TASK: a', name: 'alpha' },
        { category: 'quick', prompt: 'TASK: b', name: 'beta' },
      ] },
      execStub(),
    )
    const agent = { id: 'parent-session', steer: (message) => steered.push(message) }
    const steered = []

    // parent is mid-turn: notices queue and flush at turn-stopping
    handlers['session/event']({ id: 'parent-session' }, { type: 'turn/start', data: { turn: 1 } })

    // child-1 completes; child-2 reports blocked → blocked notice flushes first
    handlers['session/event']({ id: 'child-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: alpha done' }] } } })
    await handlers['session/event']({ id: 'child-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    handlers['session/event']({ id: 'child-2' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: blocked\nREPORT: beta stuck' }] } } })
    await handlers['session/event']({ id: 'child-2' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

    handlers['agent/turn-stopping']({ agent })
    expect(steered).toHaveLength(1)
    expect(steered[0].content[0].text).toContain('supervised_blocked')
    expect(steered[0].content[0].text).toContain('beta stuck')
    expect(steered[0].content[0].text).not.toContain('supervised_group_report')
    expect(steered[0].source.kind).toBe('orrery-delegate')
  })

  it('merged report flushes after the last member settles (termination counts)', async () => {
    const { tools, handlers } = groupHarness()
    await tools.delegate.execute(
      { group: 'scan', tasks: [
        { category: 'quick', prompt: 'TASK: a', name: 'alpha' },
        { category: 'quick', prompt: 'TASK: b', name: 'beta' },
      ] },
      execStub(),
    )
    const steered = []
    const agent = { id: 'parent-session', steer: (message) => steered.push(message) }

    // parent is mid-turn: the merged report flushes at turn-stopping
    handlers['session/event']({ id: 'parent-session' }, { type: 'turn/start', data: { turn: 1 } })

    await tools.terminate_agent.execute({ agent: 'alpha', reason: 'redirected' }, execStub())
    handlers['session/event']({ id: 'child-2' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: beta done' }] } } })
    await handlers['session/event']({ id: 'child-2' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

    handlers['agent/turn-stopping']({ agent })
    expect(steered).toHaveLength(1)
    expect(steered[0].content[0].text).toContain('supervised_group_report')
    expect(steered[0].content[0].text).toContain('terminated')
    expect(steered[0].content[0].text).toContain('beta done')
  })

  it('resume_agent delivers context and flips the child back to running', async () => {
    const { tools, handlers, sent } = groupHarness()
    await tools.delegate.execute({ group: 'scan', category: 'quick', prompt: 'TASK: a', name: 'alpha' }, execStub())
    handlers['session/event']({ id: 'child-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: blocked\nREPORT: stuck' }] } } })
    await handlers['session/event']({ id: 'child-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

    const outcome = await tools.resume_agent.execute({ agent: 'alpha', context: 'registry is back' }, execStub())
    expect(outcome.status).toBe('running')
    expect(sent.at(-1).text).toContain('registry is back')
    expect(sent.at(-1).targetId).toBe('child-1')
  })

  it('terminate_agent on a running child interrupts for real', async () => {
    const { tools, interruptedCalls } = groupHarness()
    await tools.delegate.execute({ group: 'scan', category: 'quick', prompt: 'TASK: a', name: 'alpha' }, execStub())
    const outcome = await tools.terminate_agent.execute({ agent: 'alpha' }, execStub())
    expect(outcome.interrupted).toBe(true)
    expect(interruptedCalls).toHaveLength(1)
    expect(interruptedCalls[0].targetId).toBe('child-1')
    expect(interruptedCalls[0].authority.kind).toBe('ancestor')
  })

  it('supervision tools are depth-gated', async () => {
    const { tools } = groupHarness()
    const childExec = () => ({ agent: { id: 'child-x', session: { header: { delegationDepth: 1 } } }, signal: undefined })
    await expect(async () => tools.resume_agent.execute({ agent: 'x', context: 'y' }, childExec())).rejects.toThrow(/only the main agent/)
    await expect(async () => tools.terminate_agent.execute({ agent: 'x' }, childExec())).rejects.toThrow(/only the main agent/)
  })
})
