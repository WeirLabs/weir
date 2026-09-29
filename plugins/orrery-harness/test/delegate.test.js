import { describe, expect, it } from './helpers.js'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURATED_AGENTS } from '../src/delegate/agents.js'
import { DEFAULT_CATEGORIES } from '../src/delegate/categories.js'
import { parseEscalation } from '../src/delegate/escalate.js'
import { modelFamily, pickVariant } from '../src/delegate/families.js'
import { resolveCategory, rungResolves, snapshotProviders } from '../src/delegate/resolver.js'
import { createDelegateTool, normalizeItems, supervisedToolFilter, DELEGATE_DESCRIPTION } from '../src/delegate/tool.js'
import { apply, readOnlyShellName } from '../src/delegate/index.js'
import { readWhitelistDefaults } from '../src/shared/whitelist-defaults.js'
/** Mutable settings service with an onChange broadcast (mirrors lsp.test.js).
 * Sections start undefined so the existing fallback semantics stay observable;
 * commit() publishes one section change to every subscriber, exactly like the
 * real service does on loader/volatile-update. Shared by both harnesses below. */
// The real settings service publishes the product defaults beside the user's
// list keys (they come from the plugin's own data file, not from any config
// row). A stub that omitted them would test a state the product cannot reach.
function withDefaults(section) {
  if (!section || section.defaults) return section
  return { ...section, defaults: readWhitelistDefaults().tables }
}

function liveSettings(initial = {}) {
  const listeners = new Set()
  const sections = { robash: undefined, delegate: undefined, ...initial }
  return {
    service: {
      get: (key) => withDefaults(sections[key]),
      onChange: (callback) => {
        listeners.add(callback)
        return () => listeners.delete(callback)
      },
    },
    commit(section, value) {
      sections[section] = value
      for (const callback of listeners) callback()
    },
    listenerCount: () => listeners.size,
  }
}

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
    expect(registered.map((tool) => tool.name)).toEqual(['delegate', 'resume_agent', 'terminate_agent', 'supervised_status'])
  })

  function applyHarness(config = {}, settingsSections = undefined, settingsService = undefined) {
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
      get: (name) =>
        name === 'orrerySettings'
          ? (settingsService ?? (settingsSections ? { get: (section) => withDefaults(settingsSections[section]) } : undefined))
          : undefined,
      on: () => {},
    }
    const dispose = apply(ctx, config)
    return { tool: registered[0], spawned, guards, ctx, dispose }
  }


  it('curated spawns get the platform shell in the allowlist, a persona note, and a live guard', async () => {
    const { tool, spawned, guards } = applyHarness()
    const result = await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(result.results[0].text).toBe('ro findings')
    // win32 gets pwsh, elsewhere bash: the read-only shell follows the platform
    const shell = readOnlyShellName(process.platform)
    expect(spawned[0].request.toolFilter.allow).toContain(shell)
    expect(spawned[0].request.toolFilter.allow).toContain('read')
    expect(spawned[0].request.persona).toContain('guarded read-only')
    expect(guards).toHaveLength(1)
    expect(guards[0]({ name: shell, arguments: { command: 'git status' } })).toBe(undefined)
    const denied = shell === 'pwsh' ? { command: 'iex "rm x"' } : { command: 'rm x' }
    expect(guards[0]({ name: shell, arguments: denied })).toMatch(/read-only agent/)
  })

  it('readOnlyShellNote names the platform shell and keeps the guard contract wording', async () => {
    const { readOnlyShellNote } = await import('../src/delegate/agents.js')
    expect(readOnlyShellNote('bash')).toContain('`bash`')
    expect(readOnlyShellNote('bash')).toContain('guarded read-only')
    expect(readOnlyShellNote('pwsh')).toContain('`pwsh`')
    expect(readOnlyShellNote('pwsh')).toContain('guarded read-only')
    expect(readOnlyShellNote('pwsh')).not.toContain('`bash`')
  })

  it('non-read-only targets get no guard', async () => {
    const { tool, guards } = applyHarness()
    await tool.execute({ category: 'quick', prompt: 'TASK: go' }, execStub())
    expect(guards).toHaveLength(0)
  })

  it('readOnlyBash disabled drops the shell from the allowlist and skips the guard', async () => {
    const { tool, spawned, guards } = applyHarness({ readOnlyBash: { enabled: false } })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(spawned[0].request.toolFilter.allow).not.toContain(readOnlyShellName(process.platform))
    expect(spawned[0].request.persona).not.toContain('guarded read-only')
    expect(guards).toHaveLength(0)
  })

  it('settings override allow: [] adds nothing and the product defaults still govern', async () => {
    const { tool, guards } = applyHarness({}, { robash: { allow: [] } })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(guards).toHaveLength(1)
    // an empty addition is a no-op: the default command still passes, and no
    // configuration value can clear the whitelist any more
    expect(guards[0]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)
    // the product defaults for the deny side are in effect too
    expect(guards[0]({ name: 'bash', arguments: { command: 'rm x' } })).toMatch(/explicitly denied/)
  })

  it('settings allow additions are APPENDED to the product defaults, never substituted for them', async () => {
    // `uniq` is a product default; `sort` is too. The addition names neither, so
    // a substitution-style merge would drop both and only allow the addition.
    const { tool, guards } = applyHarness({}, { robash: { allow: ['custom-reader'] } })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(guards[0]({ name: 'bash', arguments: { command: 'custom-reader x' } })).toBe(undefined)
    expect(guards[0]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)
    expect(guards[0]({ name: 'bash', arguments: { command: 'uniq a.txt' } })).toBe(undefined)
  })

  it('settings override deny: ["ls"] denies ls but keeps the default allow list', async () => {
    const { tool, guards } = applyHarness({}, { robash: { deny: ['ls'] } })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(guards).toHaveLength(1)
    expect(guards[0]({ name: 'bash', arguments: { command: 'ls' } })).toMatch(/explicitly denied/)
    expect(guards[0]({ name: 'bash', arguments: { command: 'cat x' } })).toBe(undefined)
  })

  it('settings service without a robash section keeps the module defaults', async () => {
    const { tool, guards } = applyHarness({}, { delegate: { supervisionMaxRetries: 2 } })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(guards).toHaveLength(1)
    expect(guards[0]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)
  })

  // --- Volatile settings hot reload (same process, no plugin rebuild) -------
  // spec: category-delegation / "volatile 设置在同一进程内即提交即生效".
  // The settings service re-computes on every get() and broadcasts on commit;
  // the delegate must consume both, or the feature doc's "在线编辑即刻生效"
  // promise (_category-delegation.md_) is false and edits need an app restart.

  it('hot reload: committing robashEnabled=false withdraws the shell without a rebuild', async () => {
    const live = liveSettings()
    const { tool, spawned } = applyHarness({}, undefined, live.service)
    const shell = readOnlyShellName(process.platform)

    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(spawned[0].request.toolFilter.allow).toContain(shell)

    // Same process, same plugin instance: only the settings commit changes.
    live.commit('robash', { enabled: false })

    await tool.execute({ agent: 'explore', prompt: 'TASK: find again' }, execStub())
    expect(spawned[1].request.toolFilter.allow).not.toContain(shell)
  })

  it('hot reload: a committed allow list governs the next delegation fail-closed', async () => {
    const live = liveSettings()
    const { tool, guards } = applyHarness({}, undefined, live.service)

    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(guards[0]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)

    // A committed empty list adds nothing, so the defaults still govern.
    live.commit('robash', { allow: [] })

    await tool.execute({ agent: 'explore', prompt: 'TASK: find again' }, execStub())
    expect(guards[1]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)
    // ...and a committed ADDITION is visible to the next delegation
    live.commit('robash', { allow: ['custom-reader'] })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find once more' }, execStub())
    expect(guards[2]({ name: 'bash', arguments: { command: 'custom-reader x' } })).toBe(undefined)
    expect(guards[2]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)
  })

  it('hot reload: the before-commit spawn is unaffected by a later commit', async () => {
    // Guards capture the lists they were handed at delegation time; a later
    // commit must not retroactively change an already-granted surface, and the
    // tool filter and the guard must agree within one delegation.
    const live = liveSettings()
    const { tool, guards } = applyHarness({}, undefined, live.service)

    live.commit('robash', { allow: ['ls'] })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(guards[0]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)

    live.commit('robash', { allow: [] })
    // the earlier delegation keeps its own resolved allowlist
    expect(guards[0]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)
  })

  it('hot reload: disposal unsubscribes so later commits are inert', async () => {
    const live = liveSettings()
    const { dispose } = applyHarness({}, undefined, live.service)
    expect(live.listenerCount()).toBe(1)
    dispose?.()
    expect(live.listenerCount()).toBe(0)
  })

  it('readOnlyShellName follows the platform (pwsh on win32, bash elsewhere)', () => {
    expect(readOnlyShellName('win32')).toBe('pwsh')
    expect(readOnlyShellName('darwin')).toBe('bash')
    expect(readOnlyShellName('linux')).toBe('bash')
  })

  it('the live guard dispatches pwsh executions to the pwsh parser', async () => {
    const { tool, guards } = applyHarness()
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(guards).toHaveLength(1)
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'Get-Content README.md' } })).toBe(undefined)
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'iex "rm x"' } })).toMatch(/'iex' is explicitly denied/)
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'git status' } })).toBe(undefined)
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'git push' } })).toMatch(/git subcommand 'push'/)
  })

  it('settings override pwshAllow: [] adds nothing; the pwsh defaults and the bash defaults both govern', async () => {
    const { tool, guards } = applyHarness({}, { robash: { pwshAllow: [] } })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    expect(guards).toHaveLength(1)
    // the empty addition is a no-op: default cmdlets still pass
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'Get-Content x' } })).toBe(undefined)
    // the bash side keeps the product defaults
    expect(guards[0]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)
    // the product defaults for pwshDeny are in effect too
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'iex x' } })).toMatch(/explicitly denied/)
  })

  it('config.readOnlyPwsh ADDS to the pwsh defaults instead of replacing them', async () => {
    const { tool, guards } = applyHarness({ readOnlyPwsh: { allow: ['Get-Date'] } })
    await tool.execute({ agent: 'explore', prompt: 'TASK: find' }, execStub())
    // the row-config addition is accepted...
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'Get-Date' } })).toBe(undefined)
    // ...and the product defaults are still there (a spread would have dropped them)
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'Get-Content x' } })).toBe(undefined)
    // an addition cannot shrink the defaults either, and things outside both lists stay denied
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'Get-ChildItem' } })).toBe(undefined)
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
      // deps.robash is a live resolver resolved per delegation (see tool.js)
      robash: () => ({ enabled: true, lists: { bash: { allow: ['ls'], gitAllow: [], deny: [] }, pwsh: { allow: ['Get-Content'], gitAllow: [], deny: [] } } }),
    }
    const guardedTool = createDelegateTool(deps)
    await expect(async () => guardedTool.execute({ agent: 'explore', prompt: 'x' }, execStub())).rejects.toThrow(/failed to attach/)
    expect(disposed).toEqual([true])
  })
})

describe('supervised groups (mount layer)', () => {
  const execStub = () => ({ agent: { id: 'parent-session', session: { id: 'parent-session', header: { delegationDepth: 0 } } }, signal: new AbortController().signal })

  function groupHarness(config = {}, settingsService = undefined) {
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
        listChildren: async () => catalogEntries,
      },
      llm: { listProviders: () => [], listModels: async () => [] },
      skills: {},
      get: (name) => {
        if (name === 'agents') return { get: (id) => ({ id, ctx: { tools: { guard: (fn) => { guards.push(fn); return () => {} } } } }) }
        if (name === 'orrerySettings') return settingsService
        return undefined
      },
      on(event, handler) {
        handlers[event] = handler
      },
      emit: (type, record) => emitted.push({ type, record }),
    }
    const emitted = []
    const guards = []
    let catalogEntries = []
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
      guards,
      setCatalog: (entries) => {
        catalogEntries = entries
      },
      tools: Object.fromEntries(registered.map((tool) => [tool.name, tool])),
      settingsService,
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

  it('denies send_message on category members without a caller filter', async () => {
    const { tools, continued } = groupHarness()
    await tools.delegate.execute(
      { group: 'scan', tasks: [{ category: 'quick', prompt: 'TASK: a' }] },
      execStub(),
    )
    expect(continued[0].request.toolFilter.deny).toContain('send_message')
  })

  it('writes structured supervision facts to the cold-safe audit channel', async () => {
    const { tools, emitted } = groupHarness()
    await tools.delegate.execute(
      { group: 'scan', tasks: [{ category: 'quick', prompt: 'TASK: a', name: 'alpha' }] },
      execStub(),
    )
    const spawnRecord = emitted.find((entry) => entry.type === 'orrery/supervision/spawn')
    const sealRecord = emitted.find((entry) => entry.type === 'orrery/supervision/seal')
    expect(spawnRecord).toBeTruthy()
    expect(spawnRecord.record.session).toBe('parent-session')
    expect(spawnRecord.record.data).toEqual({ kind: 'spawn', childId: 'child-1', name: 'alpha', group: 'scan' })
    expect(sealRecord).toBeTruthy()
    expect(sealRecord.record.data).toEqual({ kind: 'seal', group: 'scan', memberIds: ['child-1'] })
  })

  it('keeps the allow-list filter unchanged for read-only members', async () => {
    const { tools, continued } = groupHarness()
    await tools.delegate.execute(
      { group: 'scan', tasks: [{ category: 'architect', prompt: 'TASK: a' }] },
      execStub(),
    )
    expect(continued[0].request.toolFilter.allow).toContain('read')
    expect(continued[0].request.toolFilter.deny).toBeUndefined()
  })

  it('rejects a second delegation into a live group', async () => {
    const { tools } = groupHarness()
    await tools.delegate.execute({ group: 'scan', category: 'quick', prompt: 'TASK: a' }, execStub())
    await expect(async () =>
      tools.delegate.execute({ group: 'scan', category: 'quick', prompt: 'TASK: b' }, execStub()),
    ).rejects.toThrow(/does not accept insertion/)
  })

  it('supervised_status renders the live registry through the mount layer', async () => {
    const { tools } = groupHarness()
    await tools.delegate.execute(
      { group: 'scan', tasks: [{ category: 'quick', prompt: 'TASK: a', name: 'alpha' }] },
      execStub(),
    )
    const value = await tools.supervised_status.execute({}, execStub())
    const text = value.children.map((child) => `${child.name}:${child.status}`).join(',')
    expect(text).toContain('alpha:running')
    expect(value.groups[0].name).toBe('scan')
    expect(value.groups[0].sealed).toBe(true)
  })

  it('rejects group combined with run_in_background', async () => {
    const { tools } = groupHarness()
    await expect(async () =>
      tools.delegate.execute({ group: 'scan', category: 'quick', prompt: 'TASK: a', run_in_background: true }, execStub()),
    ).rejects.toThrow(/cannot be combined/)
  })

  it('delivers one group-settled signal via deferred followup after every settlement notice', async () => {
    const followedUp = []
    const { tools, handlers } = groupHarness()
    const parentExec = () => ({ agent: { id: 'parent-session', status: 'idle', session: { id: 'parent-session', header: { delegationDepth: 0 }, requestContext: () => undefined }, followup: (message) => followedUp.push(message) }, signal: new AbortController().signal })
    const notice = (childId) => handlers['session/event']({ id: 'parent-session' }, { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: childId }, message: { content: [] } } })
    await tools.delegate.execute(
      { group: 'scan', tasks: [
        { category: 'quick', prompt: 'TASK: a', name: 'alpha' },
        { category: 'quick', prompt: 'TASK: b', name: 'beta' },
      ] },
      parentExec(),
    )

    handlers['session/event']({ id: 'child-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: alpha done' }] } } })
    await handlers['session/event']({ id: 'child-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(followedUp).toHaveLength(0) // group still open

    handlers['session/event']({ id: 'child-2' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: beta done' }] } } })
    await handlers['session/event']({ id: 'child-2' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(followedUp).toHaveLength(0) // ordering gate: notices not observed yet

    notice('child-1')
    expect(followedUp).toHaveLength(0)
    notice('child-2')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(followedUp).toHaveLength(1)
    expect(followedUp[0].content[0].text).toContain('supervised_group_settled')
    expect(followedUp[0].content[0].text).toContain('group="scan"')
    expect(followedUp[0].content[0].text).not.toContain('alpha done') // no member bodies
    expect(followedUp[0].source.kind).toBe('orrery-delegate')
  })

  it('steers the group-settled signal into the current turn after every settlement notice', async () => {
    const steered = []
    const { tools, handlers } = groupHarness()
    const busyExec = () => ({ agent: { id: 'parent-session', status: 'streaming', session: { id: 'parent-session', header: { delegationDepth: 0 }, requestContext: () => undefined }, steer: (message) => steered.push(message) }, signal: new AbortController().signal })
    const notice = (childId) => handlers['session/event']({ id: 'parent-session' }, { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: childId }, message: { content: [] } } })
    await tools.delegate.execute(
      { group: 'scan', tasks: [
        { category: 'quick', prompt: 'TASK: a', name: 'alpha' },
        { category: 'quick', prompt: 'TASK: b', name: 'beta' },
      ] },
      busyExec(),
    )
    handlers['session/event']({ id: 'child-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: alpha done' }] } } })
    await handlers['session/event']({ id: 'child-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    handlers['session/event']({ id: 'child-2' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: beta done' }] } } })
    await handlers['session/event']({ id: 'child-2' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(steered).toHaveLength(0) // ordering gate
    notice('child-1')
    notice('child-2')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(steered).toHaveLength(1)
    expect(steered[0].content[0].text).toContain('supervised_group_settled')
    expect(steered[0].source.kind).toBe('orrery-delegate')
  })

  it('emits no parent signal while the group is still open (blocked member)', async () => {
    const followedUp = []
    const { tools, handlers } = groupHarness()
    const parentExec = () => ({ agent: { id: 'parent-session', status: 'idle', session: { id: 'parent-session', header: { delegationDepth: 0 }, requestContext: () => undefined }, followup: (message) => followedUp.push(message) }, signal: new AbortController().signal })
    await tools.delegate.execute(
      { group: 'scan', tasks: [
        { category: 'quick', prompt: 'TASK: a', name: 'alpha' },
        { category: 'quick', prompt: 'TASK: b', name: 'beta' },
      ] },
      parentExec(),
    )
    handlers['session/event']({ id: 'child-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: blocked\nREPORT: beta stuck' }] } } })
    await handlers['session/event']({ id: 'child-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(followedUp).toHaveLength(0) // blocked settle emits no Orrery notice
    const status = await tools.supervised_status.execute({}, parentExec())
    expect(status.children.find((child) => child.id === 'child-1').status).toBe('blocked')
  })

  it('group-settled signal fires after termination once both notices are observed', async () => {
    const followedUp = []
    const { tools, handlers } = groupHarness()
    const parentExec = () => ({ agent: { id: 'parent-session', status: 'idle', session: { id: 'parent-session', header: { delegationDepth: 0 }, requestContext: () => undefined }, followup: (message) => followedUp.push(message) }, signal: new AbortController().signal })
    const notice = (childId) => handlers['session/event']({ id: 'parent-session' }, { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: childId }, message: { content: [] } } })
    await tools.delegate.execute(
      { group: 'scan', tasks: [
        { category: 'quick', prompt: 'TASK: a', name: 'alpha' },
        { category: 'quick', prompt: 'TASK: b', name: 'beta' },
      ] },
      parentExec(),
    )

    await tools.terminate_agent.execute({ agent: 'alpha', reason: 'redirected' }, parentExec())
    handlers['session/event']({ id: 'child-2' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: beta done' }] } } })
    await handlers['session/event']({ id: 'child-2' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(followedUp).toHaveLength(0) // ordering gate
    notice('child-1')
    notice('child-2')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(followedUp).toHaveLength(1)
    expect(followedUp[0].content[0].text).toContain('supervised_group_settled')
    expect(followedUp[0].content[0].text).toContain('members="2"')
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

  it('never claims no supervised children after a restart rebuild', async () => {
    const { tools } = groupHarness()
    // No prior spawn, no audit: coordinatorFor rehydrates an empty registry.
    await expect(async () =>
      tools.resume_agent.execute({ agent: 'ghost', context: 'x' }, execStub()),
    ).rejects.toThrow(/no supervised child named/)
  })


  it('resolves every member before spawning any child (no live group after a resolution failure)', async () => {
    const { tools, continued, emitted } = groupHarness()
    await expect(async () =>
      tools.delegate.execute(
        { group: 'scan', tasks: [
          { category: 'quick', prompt: 'TASK: a', name: 'alpha' },
          { category: 'unknown-category', prompt: 'TASK: b', name: 'beta' },
        ] },
        execStub(),
      ),
    ).rejects.toThrow(/unknown_target/)
    expect(continued).toHaveLength(0) // phase 1 failed: zero spawns
    expect(emitted.some((entry) => entry.type === 'orrery/supervision/seal')).toBe(false)

    // the group name is still free
    const result = await tools.delegate.execute(
      { group: 'scan', tasks: [{ category: 'quick', prompt: 'TASK: a', name: 'alpha' }] },
      execStub(),
    )
    expect(result.supervised).toBe(true)
  })

  it('rolls back spawned members and releases the group name when a mid-batch spawn fails', async () => {
    const { ctx, tools, continued, interruptedCalls, emitted } = groupHarness()
    let calls = 0
    ctx.subagents.startContinuable = async (spec) => {
      calls += 1
      if (calls === 2) throw new Error('spawn exploded')
      continued.push(spec)
      return { childId: `child-${calls}`, messageId: `msg-${calls}` }
    }
    await expect(async () =>
      tools.delegate.execute(
        { group: 'scan', tasks: [
          { category: 'quick', prompt: 'TASK: a', name: 'alpha' },
          { category: 'quick', prompt: 'TASK: b', name: 'beta' },
        ] },
        execStub(),
      ),
    ).rejects.toThrow(/spawn exploded/)
    expect(interruptedCalls.length).toBeGreaterThanOrEqual(1) // rollback interrupt
    expect(emitted.some((entry) => entry.type === 'orrery/supervision/group-released')).toBe(true)

    // the name is reusable after the failed batch
    const result = await tools.delegate.execute(
      { group: 'scan', tasks: [{ category: 'quick', prompt: 'TASK: c', name: 'gamma' }] },
      execStub(),
    )
    expect(result.supervised).toBe(true)
    expect(result.members).toHaveLength(1)
  })

  it('attaches the read-only bash guard to read-only supervised members via the live agent handle', async () => {
    const { tools, guards } = groupHarness()
    await tools.delegate.execute(
      { group: 'scan', tasks: [{ category: 'architect', prompt: 'TASK: a' }] },
      execStub(),
    )
    expect(guards).toHaveLength(1)
    expect(guards[0]({ name: 'bash', arguments: { command: 'git status' } })).toBe(undefined)
    expect(guards[0]({ name: 'bash', arguments: { command: 'rm x' } })).toMatch(/explicitly denied/)
  })

  it('keeps the new signal contract in the tool description and result text', async () => {
    expect(DELEGATE_DESCRIPTION).toContain('group-settled signal')
    expect(DELEGATE_DESCRIPTION).not.toContain('merged group report')
    const { tools } = groupHarness()
    const result = await tools.delegate.execute(
      { group: 'scan', tasks: [{ category: 'quick', prompt: 'TASK: a', name: 'alpha' }] },
      execStub(),
    )
    const rendered = tools.delegate.output.render({}, result)[0].text
    expect(rendered).toContain('group-settled signal')
    expect(rendered).toContain('settlement notice')
    expect(rendered).not.toContain('merged group report')
  })
  it('appends an untracked-catalog hint when rebuilt state is partial', async () => {
    const { tools, setCatalog } = groupHarness()
    setCatalog([{ id: 'orphan-9', label: 'leftover', mode: 'continuable' }])
    await expect(async () =>
      tools.resume_agent.execute({ agent: 'ghost', context: 'x' }, execStub()),
    ).rejects.toThrow(/untracked continuable child/)
  })

  it('rehydrates a full registry from the audit JSONL and resumes a blocked child', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orrery-audit-'))
    mkdirSync(join(cwd, '.orrery'), { recursive: true })
    const line = (type, data) => `${JSON.stringify({ time: 1, session: 'parent-1', type, data })}\n`
    writeFileSync(join(cwd, '.orrery', 'audit.jsonl'), [
      line('orrery/supervision/spawn', { kind: 'spawn', childId: 'child-1', name: 'alpha', group: 'scan' }),
      line('orrery/supervision/seal', { kind: 'seal', group: 'scan', memberIds: ['child-1'] }),
      line('orrery/supervision/settle', { kind: 'settle', childId: 'child-1', status: 'blocked', report: 'stuck before restart' }),
    ].join(''))
    const { tools, sent } = groupHarness()
    const restartExec = () => ({ agent: { id: 'parent-1', session: { id: 'parent-1', header: { delegationDepth: 0, cwd } } }, signal: new AbortController().signal })
    const outcome = await tools.resume_agent.execute({ agent: 'alpha', context: 'restored' }, restartExec())
    expect(outcome.status).toBe('running')
    expect(sent.at(-1).text).toContain('restored')
    expect(sent.at(-1).targetId).toBe('child-1')
  })

  // --- Live supervision tuning through the mount layer ---------------------
  // spec: category-delegation / "volatile 设置在同一进程内即提交即生效".
  // The coordinator is created on first delegation and cached per parent
  // session, so this exercises the subscription path: a commit must reach the
  // coordinator that is already serving this parent.

  it('a settings commit reaches the coordinator of an already-delegated parent', async () => {
    const live = liveSettings()
    const { tools, handlers } = groupHarness({}, live.service)

    // Establish the coordinator: one supervised member, still running.
    await tools.delegate.execute(
      { group: 'scan', tasks: [{ category: 'quick', prompt: 'TASK: a', name: 'alpha' }] },
      execStub(),
    )
    const memberOf = async () => (await tools.supervised_status.execute({}, execStub())).children[0]

    // First provider error: well under the default cap of 5, so the child is
    // retried and stays running.
    handlers['session/event']({ id: 'child-1' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '500' } } } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await memberOf()).retries).toBe(1)
    expect((await memberOf()).status).toBe('running')

    // Commit the settings change: no plugin rebuild, no new delegation.
    live.commit('delegate', { supervisionMaxRetries: 1 })

    // The tightened cap governs the coordinator that is already serving this
    // parent: the very next provider error exhausts the budget.
    handlers['session/event']({ id: 'child-1' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '500' } } } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const settled = await memberOf()
    expect(settled.status).toBe('blocked')
    expect(settled.report).toContain('provider-error')
  })

  it('a settings commit changes the read-only surface of the next supervised spawn', async () => {
    const shell = readOnlyShellName(process.platform)

    // Before the commit: the guard is on and a curated member gets the shell.
    const before = groupHarness()
    await before.tools.delegate.execute(
      { group: 'g1', tasks: [{ agent: 'explore', prompt: 'TASK: a' }] },
      execStub(),
    )
    expect(before.continued[0].request.toolFilter.allow).toContain(shell)
    expect(before.guards).toHaveLength(1)

    // A commit turning the guard off governs the very next spawn: the same
    // settings service now yields a shell-free, unguarded member.
    const live = liveSettings()
    const after = groupHarness({}, live.service)
    live.commit('robash', { enabled: false })
    await after.tools.delegate.execute(
      { group: 'g1', tasks: [{ agent: 'explore', prompt: 'TASK: a' }] },
      execStub(),
    )
    expect(after.continued[0].request.toolFilter.allow).not.toContain(shell)
    expect(after.guards).toHaveLength(0)
  })
})

describe('supervisedToolFilter', () => {
  it('returns a send_message deny filter when no caller filter exists', () => {
    expect(supervisedToolFilter(undefined)).toEqual({ deny: ['send_message'] })
  })

  it('keeps allow-list filters unchanged (read-only targets)', () => {
    const allow = { allow: ['read', 'glob', 'grep'] }
    expect(supervisedToolFilter(allow)).toBe(allow)
  })

  it('merges send_message into caller deny lists without duplicates', () => {
    const merged = supervisedToolFilter({ deny: ['write'] })
    expect(merged.deny).toEqual(['write', 'send_message'])
    const deduped = supervisedToolFilter({ deny: ['send_message', 'write'] })
    expect(deduped.deny).toEqual(['send_message', 'write'])
  })
})
