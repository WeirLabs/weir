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
    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe('delegate')
  })
})
