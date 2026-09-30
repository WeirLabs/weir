import { describe, expect, it } from './helpers.js'
import { createTargetResolver, modelFamily, pickVariant } from '../src/delegate/target-resolver.js'
import { CURATED_AGENTS } from '../src/delegate/agents.js'
import { DEFAULT_CATEGORIES } from '../src/delegate/categories.js'

// Duck-typed overlay bundle (settings-overlay.js shape) with a robashNow call
// counter: the D5 fix is "exactly one guard resolution per delegation".
function fakeOverlay({ robashEnabled = true, shellName = 'bash', categories, agents } = {}) {
  const calls = { robashNow: 0 }
  const overlay = {
    calls,
    categoriesNow: () => categories ?? { ...DEFAULT_CATEGORIES },
    agentsNow: () => agents ?? { ...CURATED_AGENTS },
    robashNow: () => {
      calls.robashNow += 1
      return { enabled: robashEnabled, lists: {} }
    },
    readOnlyTools: (base, resolved) => (resolved.enabled ? [...new Set([...base, shellName])] : [...base]),
    shellName,
  }
  return overlay
}

function fakeLlm({ providers = [], models = {}, modelInfo = {} } = {}) {
  return {
    listProviders: () => providers,
    listModels: async (id) => models[id] ?? [],
    resolveModelInfo: async (provider, model) => modelInfo[`${provider}/${model}`],
  }
}

function makeResolver({ agents = CURATED_AGENTS, userCategories, overlay, llm } = {}) {
  const listeners = []
  const targetResolver = createTargetResolver({
    agents,
    userCategories,
    overlay: overlay ?? fakeOverlay({ agents }),
    llm: llm ?? fakeLlm(),
    onAdaptersUpdated: (fn) => listeners.push(fn),
  })
  return { resolveTarget: targetResolver.resolveTarget, listeners }
}

describe('modelFamily / pickVariant (folded from families.js)', () => {
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

describe('target-resolver agent branch', () => {
  it('rejects unknown and disabled agents', async () => {
    const { resolveTarget } = makeResolver()
    await expect(async () => resolveTarget({ agent: 'nope', prompt: 'x' })).rejects.toThrow(/unknown_target "nope"/)
    const disabled = makeResolver({ agents: { broken: { prompt: 'p', tools: [], disabled: true } } })
    await expect(async () => disabled.resolveTarget({ agent: 'broken', prompt: 'x' })).rejects.toThrow(/agent "broken" is disabled/)
  })

  it('appends the persona note only when the guard is enabled', async () => {
    const on = makeResolver({ overlay: fakeOverlay({ robashEnabled: true, shellName: 'pwsh' }) })
    const resolved = await on.resolveTarget({ agent: 'finder', prompt: 'TASK: find' })
    expect(resolved.persona).toContain('guarded read-only')
    expect(resolved.persona).toContain('`pwsh`')
    expect(resolved.toolFilter.allow).toContain('pwsh')
    expect(resolved.readOnly).toBe(true)

    const off = makeResolver({ overlay: fakeOverlay({ robashEnabled: false }) })
    const unguarded = await off.resolveTarget({ agent: 'finder', prompt: 'TASK: find' })
    expect(unguarded.persona).not.toContain('guarded read-only')
    expect(unguarded.toolFilter.allow).not.toContain('bash')
  })

  it('label priority: name > task_summary > first line of prompt', async () => {
    const { resolveTarget } = makeResolver()
    expect((await resolveTarget({ agent: 'finder', prompt: 'p', name: 'nm' })).label).toBe('nm')
    expect((await resolveTarget({ agent: 'finder', prompt: 'p', task_summary: 'ts' })).label).toBe('ts')
    expect((await resolveTarget({ agent: 'finder', prompt: 'first line\nsecond' })).label).toBe('finder: first line')
  })

  it('resolves the guard overlay exactly once per delegation (D5)', async () => {
    const overlay = fakeOverlay()
    const { resolveTarget } = makeResolver({ overlay })
    await resolveTarget({ agent: 'finder', prompt: 'x' })
    expect(overlay.calls.robashNow).toBe(1)
  })

  it('a configured agent chain wins over inheritance', async () => {
    const routed = {
      ...CURATED_AGENTS,
      finder: { ...CURATED_AGENTS.finder, chain: [{ provider: 'acme', model: 'm1' }] },
    }
    const { resolveTarget } = makeResolver({
      overlay: fakeOverlay({ agents: routed }),
      llm: fakeLlm({ providers: [{ id: 'acme' }], models: { acme: [{ id: 'm1' }] } }),
    })
    const resolved = await resolveTarget({ agent: 'finder', prompt: 'x' }, { provider: 'parent-p', model: 'parent-m' })
    expect(resolved.agentOptions).toEqual({ provider: 'acme', model: 'm1' })
    // routing never touches the read-only surface
    expect(resolved.readOnly).toBe(true)
    expect(resolved.toolFilter.allow).toContain('read')
  })

  it('an empty agent chain inherits the caller route and gates the effort hint on it', async () => {
    const parentRoute = { provider: 'p', model: 'm' }
    // supported: the parent route advertises finder's 'low' hint
    const supported = makeResolver({ llm: fakeLlm({ modelInfo: { 'p/m': { reasoning: { efforts: [{ id: 'low' }] } } } }) })
    expect((await supported.resolveTarget({ agent: 'finder', prompt: 'x' }, parentRoute)).agentOptions).toEqual({ reasoningEffort: 'low' })

    // unsupported: dropped silently
    const unsupported = makeResolver({ llm: fakeLlm({ modelInfo: { 'p/m': { reasoning: { efforts: [{ id: 'high' }] } } } }) })
    expect((await unsupported.resolveTarget({ agent: 'finder', prompt: 'x' }, parentRoute)).agentOptions).toBeUndefined()

    // unknown route metadata: omit the hint rather than risk a rejection
    const noInfo = makeResolver()
    expect((await noInfo.resolveTarget({ agent: 'finder', prompt: 'x' }, parentRoute)).agentOptions).toBeUndefined()
    const throwing = makeResolver({ llm: { ...fakeLlm(), resolveModelInfo: async () => { throw new Error('no metadata') } } })
    expect((await throwing.resolveTarget({ agent: 'finder', prompt: 'x' }, parentRoute)).agentOptions).toBeUndefined()

    // no known parent route: pure inheritance, no options at all
    const noParent = makeResolver()
    expect((await noParent.resolveTarget({ agent: 'finder', prompt: 'x' })).agentOptions).toBeUndefined()
  })

  it('a non-empty agent chain whose rungs all fail throws an explicit error naming agent and rungs', async () => {
    const dead = {
      ...CURATED_AGENTS,
      finder: {
        ...CURATED_AGENTS.finder,
        chain: [
          { provider: 'gone', model: 'x' },
          { provider: 'also-gone', model: 'y' },
        ],
      },
    }
    const { resolveTarget } = makeResolver({ overlay: fakeOverlay({ agents: dead }) })
    const error = await resolveTarget({ agent: 'finder', prompt: 'x' }).then(
      () => { throw new Error('expected a rejection') },
      (err) => err,
    )
    expect(error.message).toContain('agent "finder" unavailable')
    expect(error.message).toContain('gone/x')
    expect(error.message).toContain('also-gone/y')
  })

  it('item.model overrides the model id while the provider stays the route provider', async () => {
    // Resolved chain route: the override keeps the chain's provider, and an
    // unlisted id is still attempted (catalogs are advisory).
    const routed = {
      ...CURATED_AGENTS,
      finder: { ...CURATED_AGENTS.finder, chain: [{ provider: 'acme', model: 'm1' }] },
    }
    const chained = makeResolver({
      overlay: fakeOverlay({ agents: routed }),
      llm: fakeLlm({ providers: [{ id: 'acme' }], models: { acme: [{ id: 'm1' }] } }),
    })
    const overridden = await chained.resolveTarget({ agent: 'finder', model: 'unlisted-model', prompt: 'x' })
    expect(overridden.agentOptions).toEqual({ provider: 'acme', model: 'unlisted-model' })

    // Inherited route: the provider is the caller's.
    const plain = makeResolver()
    const inherited = await plain.resolveTarget({ agent: 'finder', model: 'unlisted-model', prompt: 'x' }, { provider: 'parent-p', model: 'parent-m' })
    expect(inherited.agentOptions).toEqual({ provider: 'parent-p', model: 'unlisted-model' })
  })

  it('keeps a rung effort the resolved agent route advertises and drops one it does not', async () => {
    const rung = { provider: 'acme', model: 'm1', reasoningEffort: 'high' }
    const routed = { ...CURATED_AGENTS, finder: { ...CURATED_AGENTS.finder, chain: [rung] } }
    const llmWith = (efforts) => fakeLlm({
      providers: [{ id: 'acme' }],
      models: { acme: [{ id: 'm1' }] },
      modelInfo: { 'acme/m1': { reasoning: { efforts } } },
    })
    const supported = makeResolver({ overlay: fakeOverlay({ agents: routed }), llm: llmWith([{ id: 'high' }]) })
    expect((await supported.resolveTarget({ agent: 'finder', prompt: 'x' })).agentOptions).toEqual({ provider: 'acme', model: 'm1', reasoningEffort: 'high' })

    const unsupported = makeResolver({ overlay: fakeOverlay({ agents: routed }), llm: llmWith([{ id: 'low' }]) })
    expect((await unsupported.resolveTarget({ agent: 'finder', prompt: 'x' })).agentOptions).toEqual({ provider: 'acme', model: 'm1' })
  })

  it('available-target lists in error messages name only enabled targets', async () => {
    const withDisabledAgent = { ...CURATED_AGENTS, hidden: { prompt: 'p', tools: [], disabled: true } }
    const agentsCase = makeResolver({ agents: withDisabledAgent })
    const agentError = await agentsCase.resolveTarget({ agent: 'nope', prompt: 'x' }).then(
      () => { throw new Error('expected a rejection') },
      (err) => err,
    )
    expect(agentError.message).toContain('unknown_target "nope"')
    expect(agentError.message).toContain('finder')
    expect(agentError.message).not.toContain('hidden')

    const withDisabledCategory = { ...DEFAULT_CATEGORIES, secret: { chain: [], disabled: true } }
    const categoriesCase = makeResolver({ overlay: fakeOverlay({ categories: withDisabledCategory }) })
    const categoryError = await categoriesCase.resolveTarget({ category: 'nope', prompt: 'x' }).then(
      () => { throw new Error('expected a rejection') },
      (err) => err,
    )
    expect(categoryError.message).toContain('unknown_target category "nope"')
    expect(categoryError.message).toContain('quick')
    expect(categoryError.message).not.toContain('secret')
  })
})

describe('target-resolver category branch', () => {
  const chained = {
    chain: [
      { provider: 'acme', model: 'm1', reasoningEffort: 'high' },
    ],
  }

  it('resolves a chain rung to provider/model options', async () => {
    const { resolveTarget } = makeResolver({
      overlay: fakeOverlay({ categories: { custom: chained } }),
      llm: fakeLlm({
        providers: [{ id: 'acme' }],
        models: { acme: [{ id: 'm1' }] },
        modelInfo: { 'acme/m1': { reasoning: { efforts: [{ id: 'high' }] } } },
      }),
    })
    const resolved = await resolveTarget({ category: 'custom', prompt: 'TASK: go' })
    expect(resolved.agentOptions).toEqual({ provider: 'acme', model: 'm1', reasoningEffort: 'high' })
    expect(resolved.categoryName).toBe('custom')
  })

  it('drops a reasoningEffort the resolved route does not advertise', async () => {
    const { resolveTarget } = makeResolver({
      overlay: fakeOverlay({ categories: { custom: chained } }),
      llm: fakeLlm({
        providers: [{ id: 'acme' }],
        models: { acme: [{ id: 'm1' }] },
        modelInfo: { 'acme/m1': { reasoning: { efforts: [{ id: 'low' }] } } },
      }),
    })
    const resolved = await resolveTarget({ category: 'custom', prompt: 'x' })
    expect(resolved.agentOptions).toEqual({ provider: 'acme', model: 'm1' })
  })

  it('inherits the parent route on an empty chain', async () => {
    const { resolveTarget } = makeResolver()
    const resolved = await resolveTarget({ category: 'quick', prompt: 'x' })
    expect(resolved.agentOptions).toBeUndefined()
    expect(resolved.categoryName).toBe('quick')
  })

  it('keeps the inherited-route effort hint only when the parent route advertises it', async () => {
    const llm = fakeLlm({ modelInfo: { 'p/m': { reasoning: { efforts: [{ id: 'low' }] } } } })
    const { resolveTarget } = makeResolver({ llm })
    const parentRoute = { provider: 'p', model: 'm' }
    const kept = await resolveTarget({ category: 'quick', prompt: 'x' }, parentRoute)
    expect(kept.agentOptions).toEqual({ reasoningEffort: 'low' })

    const noEffortLlm = fakeLlm({ modelInfo: { 'p/m': { reasoning: { efforts: [{ id: 'high' }] } } } })
    const dropped = makeResolver({ llm: noEffortLlm })
    expect((await dropped.resolveTarget({ category: 'quick', prompt: 'x' }, parentRoute)).agentOptions).toBeUndefined()

    // unknown route metadata: omit the hint rather than risk a rejection
    const throwing = fakeLlm()
    throwing.resolveModelInfo = async () => { throw new Error('no metadata') }
    const silent = makeResolver({ llm: throwing })
    expect((await silent.resolveTarget({ category: 'quick', prompt: 'x' }, parentRoute)).agentOptions).toBeUndefined()
  })

  it('reports unknown and unavailable categories explicitly', async () => {
    const { resolveTarget } = makeResolver()
    await expect(async () => resolveTarget({ category: 'nope', prompt: 'x' })).rejects.toThrow(/unknown_target category "nope"/)
    const unavailable = makeResolver({ overlay: fakeOverlay({ categories: { custom: chained } }) })
    await expect(async () => unavailable.resolveTarget({ category: 'custom', prompt: 'x' })).rejects.toThrow(/category "custom" unavailable/)
  })

  it('readOnly categories get the platform shell in the toolFilter', async () => {
    const { resolveTarget } = makeResolver({ overlay: fakeOverlay({ shellName: 'pwsh' }) })
    const resolved = await resolveTarget({ category: 'architect', prompt: 'x' })
    expect(resolved.readOnly).toBe(true)
    expect(resolved.toolFilter.allow).toEqual(['read', 'glob', 'grep', 'pwsh'])
  })

  it('resolves the guard overlay exactly once per category delegation (D5)', async () => {
    const overlay = fakeOverlay()
    const { resolveTarget } = makeResolver({ overlay })
    await resolveTarget({ category: 'quick', prompt: 'x' })
    expect(overlay.calls.robashNow).toBe(1)
  })
})

describe('target-resolver provider snapshot cache', () => {
  it('caches the snapshot and invalidates on adapters-updated', async () => {
    let listCalls = 0
    const llm = {
      listProviders: () => [{ id: 'acme' }],
      listModels: async () => {
        listCalls += 1
        return [{ id: 'm1' }]
      },
    }
    const { resolveTarget, listeners } = makeResolver({ llm })
    expect(listeners).toHaveLength(1)
    await resolveTarget({ category: 'quick', prompt: 'x' })
    await resolveTarget({ category: 'quick', prompt: 'y' })
    expect(listCalls).toBe(1)
    listeners[0]() // llm/adapters-updated
    await resolveTarget({ category: 'quick', prompt: 'z' })
    expect(listCalls).toBe(2)
  })
})
