// Tasks 5.1-5.4 of the session-capability-manager change: cold-session
// fail-closed listing, invalidation re-emission, resume-failure status and
// the single Skill trigger source.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'
import { createSkillSelectionProvider } from '../src/capabilities/skill-selection-provider.js'
import { createSkillSelectionPlugin, skillSelectionFor } from '../src/capabilities/skill-selection-plugin.js'
import { PRESET_SELECTED_EVENT, createPresetInvalidation, emitPresetSelected } from '../src/capabilities/preset-invalidation.js'
import { classifySelectionFailure } from '../src/capabilities/selection-status.js'
import { createApplyEngine } from '../src/capabilities/apply-engine.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'

const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const alpha = identity('user', 'alpha')
const beta = identity('project', 'beta')
const candidateOf = value => ({ status: 'parsed', name: value.name, identity: value,
  path: `/${value.scope}/${value.name}/SKILL.md`, digest: createHash('sha256').update(`${value.scope}:${value.name}`).digest('hex') })

const scopeOf = id => ({ cwd: '/work', scope: { session: { id } } })
const STANDING = { cwd: '/work' }

function providerSetup({ readSelection } = {}) {
  const selections = new Map()
  const provider = createSkillSelectionProvider({
    control: { invalidate() {} },
    readSelection: readSelection ?? (async options => selections.get(options.scope?.session?.id) ?? []),
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
  })
  return { provider, selections }
}

// --- 5.1 cold-session fail closed -------------------------------------------

test('5.1: the standing preset key lists empty — never a cwd or preset-default guess', async () => {
  const { provider } = providerSetup()
  provider.acceptSelection([alpha], scopeOf('session-a'))
  const listed = await provider.list(STANDING)
  expect(listed.candidates).toEqual([])
  expect(listed.complete).toBe(true)
  const status = provider.status(STANDING)
  expect(status.error).toBeNull()
  expect(status.reason).toBeNull()
})

test('5.1: a live scope returns exactly its own accepted selection', async () => {
  const { provider } = providerSetup()
  provider.acceptSelection([alpha], scopeOf('session-a'))
  const listed = await provider.list(scopeOf('session-a'))
  expect(listed.candidates.map(candidate => candidate.identity)).toEqual([alpha])
})

test('5.1: two sessions of one directory hold different selections without leaking', async () => {
  const { provider } = providerSetup()
  provider.acceptSelection([alpha], scopeOf('session-a'))
  provider.acceptSelection([beta], scopeOf('session-b'))
  const a = await provider.list(scopeOf('session-a'))
  const b = await provider.list(scopeOf('session-b'))
  expect(a.candidates.map(candidate => candidate.identity)).toEqual([alpha])
  expect(b.candidates.map(candidate => candidate.identity)).toEqual([beta])
  // The shared cwd never became a key: the standing list is still empty.
  expect((await provider.list(STANDING)).candidates).toEqual([])
})

test('5.1: persisted per-session reads stay isolated for one cwd (plugin default readSelection)', async () => {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'orrery-cold-slash-'))
  try {
    // Persist two different selections for two sessions of the same directory,
    // through the same profileContext-rooted store the plugin will open.
    const profileContext = { home: root, name: 'test' }
    const store = openCapabilityStore({ profileContext, platform: 'darwin', liveness: createStubLiveness() })
    await store.commit({ kind: 'selection', sessionId: 'session-a' }, 0, () => ({ skills: [alpha], mcpServers: [] }))
    await store.commit({ kind: 'selection', sessionId: 'session-b' }, 0, () => ({ skills: [beta], mcpServers: [] }))
    let registered
    const ctx = {
      skills: { registerProvider(create) { registered = create({ invalidate() {} }) } },
      on() {},
      get(name) { return name === 'profileContext' ? profileContext : undefined },
    }
    createSkillSelectionPlugin({
      inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
      office: async () => ({ complete: true, candidates: [] }),
    })(ctx)
    const a = await registered.list(scopeOf('session-a'))
    const b = await registered.list(scopeOf('session-b'))
    const standing = await registered.list(STANDING)
    expect(a.candidates.filter(candidate => candidate.identity).map(candidate => candidate.identity)).toEqual([alpha])
    expect(b.candidates.filter(candidate => candidate.identity).map(candidate => candidate.identity)).toEqual([beta])
    expect(standing.candidates.filter(candidate => candidate.identity)).toEqual([])
  } finally {
    assert.ok(resolve(root).startsWith(join(base, 'orrery-cold-slash-')))
    await rm(root, { recursive: true, force: true })
  }
})

// --- 5.2 invalidation re-emission -------------------------------------------

test('5.2: emitPresetSelected validates argument shapes and contains emit failures', () => {
  const sent = []
  const emit = (...args) => sent.push(args)
  expect(emitPresetSelected(emit, 'sess-1', 'orrery')).toBe(true)
  expect(sent).toEqual([[PRESET_SELECTED_EVENT, 'sess-1', 'orrery']])
  // Non-string arguments are dropped, never emitted.
  for (const [sessionId, presetId] of [[null, 'orrery'], ['sess-1', undefined], [42, 'orrery'], ['sess-1', {}], ['', 'orrery']]) {
    expect(emitPresetSelected(emit, sessionId, presetId)).toBe(false)
  }
  expect(sent).toHaveLength(1)
  // An emit failure is caught and warned, never propagated.
  const warnings = []
  const down = () => { throw new Error('broadcast bus down') }
  expect(emitPresetSelected(down, 'sess-1', 'orrery', text => warnings.push(text))).toBe(false)
  expect(warnings[0]).toContain('broadcast bus down')
})

test('5.2: agent/created re-emits only for root sessions, with the session actual preset id', () => {
  const sent = []
  const session = { id: 'sess-root', header: { delegationDepth: 0 } }
  const projections = () => ({ stateOf: (target, key) => target === session && key === 'agentPreset' ? 'orrery' : undefined })
  const watcher = createPresetInvalidation({ emit: (...args) => sent.push(args), projections })
  expect(watcher.agentCreated({ agent: { id: 'sess-root', session } })).toBe(true)
  expect(sent).toEqual([[PRESET_SELECTED_EVENT, 'sess-root', 'orrery']])
  // Subagents never re-emit (G2c argues root sessions only).
  const child = { id: 'sess-child', session: { id: 'sess-child', header: { delegationDepth: 1, parentSession: 'sess-root' } } }
  expect(watcher.agentCreated({ agent: child })).toBe(false)
  expect(sent).toHaveLength(1)
  // A session without a resolvable actual preset id emits nothing (never a constant).
  const unknown = { id: 'sess-x', session: { id: 'sess-x', header: {} } }
  expect(watcher.agentCreated({ agent: unknown })).toBe(false)
  expect(sent).toHaveLength(1)
})

test('5.2: listener and projection failures are contained — the serial dispatch never rejects', () => {
  const warnings = []
  const watcher = createPresetInvalidation({
    emit: () => { throw new Error('emit down') },
    projections: () => { throw new Error('projections down') },
    warn: text => warnings.push(text),
  })
  const agent = { id: 'sess-1', session: { id: 'sess-1', header: { delegationDepth: 0 } } }
  expect(watcher.agentCreated({ agent })).toBe(false)
  expect(warnings.some(text => text.includes('projections down'))).toBe(true)
  expect(watcher.agentCreated(null)).toBe(false)
  expect(watcher.agentCreated({})).toBe(false)
})

test('5.2: the mounted plugin wires agent/created to ctx.emit for root sessions only', () => {
  const handlers = new Map()
  const sent = []
  const session = { id: 'sess-root', header: { delegationDepth: 0 } }
  const ctx = {
    skills: { registerProvider(create) { create({ invalidate() {} }) } },
    on(event, listener) { handlers.set(event, listener) },
    get(name) {
      if (name === 'sessionProjections') return { stateOf: () => 'orrery' }
      return undefined
    },
    emit(...args) { sent.push(args) },
  }
  createSkillSelectionPlugin({ readSelection: async () => [], inventory: async () => ({ complete: true, candidates: [] }), office: async () => ({ complete: true, candidates: [] }) })(ctx)
  // The host dispatches agent/created SERIALLY with bail-on-value semantics:
  // the listener must return undefined so later rows still receive the event.
  expect(handlers.get('agent/created')({ agent: { id: 'sess-root', session } })).toBeUndefined()
  expect(sent).toEqual([[PRESET_SELECTED_EVENT, 'sess-root', 'orrery']])
  expect(handlers.get('agent/created')({ agent: { id: 'sess-child', session: { id: 'sess-child', header: { delegationDepth: 2 } } } })).toBeUndefined()
  expect(sent).toHaveLength(1)
})

const SESSION = 'session-eeeeeeee-1111-4aaa-8bbb-cccccccccccc'
const auth = { id: SESSION, authenticated: true }

async function engineFixture(t, { located = { sessionId: SESSION, cwd: '/server-workspace', presetId: 'orrery' }, invalidate } = {}) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'orrery-cold-apply-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    await rm(root, { recursive: true, force: true })
  })
  const store = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  const engine = createApplyEngine({
    store,
    locateSession: async session => session?.id === SESSION ? located : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    invalidate,
  })
  return { store, engine }
}

const applyRequest = ({ requestId = 'req-1', expectedRevision = 0, skills = [alpha] } = {}) =>
  ({ requestId, expectedRevision, selection: { skills, mcpServers: [] }, unresolved: [] })

test('5.2: an accepted Apply re-emits the invalidation with the session preset id', async t => {
  const sent = []
  const { engine } = await engineFixture(t, { invalidate: (...args) => sent.push(args) })
  const response = await engine.apply(auth, applyRequest())
  expect(response.status).toBe('applied')
  await new Promise(resolve => setImmediate(resolve))
  expect(sent).toEqual([[SESSION, 'orrery']])
})

test('5.2: a failed invalidation is captured and never changes the Apply result', async t => {
  const { engine } = await engineFixture(t, { invalidate: () => { throw new Error('broadcast down') } })
  const response = await engine.apply(auth, applyRequest())
  expect(response.status).toBe('applied')
  await new Promise(resolve => setImmediate(resolve))
  expect((await engine.queryReceipt(auth, 'req-1')).status).toBe('found')
})

test('5.2: no invalidation without a session preset id, and rejection emits nothing', async t => {
  const sent = []
  const { engine } = await engineFixture(t, {
    located: { sessionId: SESSION, cwd: '/server-workspace' },
    invalidate: (...args) => sent.push(args),
  })
  const response = await engine.apply(auth, applyRequest())
  expect(response.status).toBe('applied')
  await new Promise(resolve => setImmediate(resolve))
  expect(sent).toEqual([])
  // A rejected Apply (revision conflict) never emits either.
  const conflicted = await engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 9 }))
  expect(conflicted.status).toBe('rejected')
  await new Promise(resolve => setImmediate(resolve))
  expect(sent).toEqual([])
})

test('5.2: a recovered (published) indeterminate write re-emits the invalidation too', async t => {
  const sent = []
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'orrery-cold-apply-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  let lose = false
  const lossy = { ...store, commit: async (...args) => {
    const result = await store.commit(...args)
    if (lose) throw new Error('response lost after durable acceptance')
    return result
  } }
  const engine = createApplyEngine({
    store: lossy,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/w', presetId: 'orrery' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    invalidate: (...args) => sent.push(args),
  })
  lose = true
  const response = await engine.apply(auth, applyRequest())
  expect(response.status).toBe('indeterminate')
  await new Promise(resolve => setImmediate(resolve))
  expect(sent).toEqual([])
  const query = await engine.queryReceipt(auth, 'req-1')
  expect(query.recovery).toBe('published')
  await new Promise(resolve => setImmediate(resolve))
  expect(sent).toEqual([[SESSION, 'orrery']])
})

// --- 5.3 resume-failure status face ------------------------------------------

test('5.3: classification maps writer-held and policy failures to reason plus actionable hint', () => {
  const held = classifySelectionFailure({ code: 'session/' + 'writer-held', message: 'session log owned elsewhere' })
  expect(held.reason).toBe('session-writer-held')
  expect(held.hint).toContain('Another process holds this session log')
  expect(classifySelectionFailure(new Error('Skill selection policy is corrupt')).reason).toBe('policy-unreadable:corrupt')
  expect(classifySelectionFailure(new Error('Skill selection policy is torn')).reason).toBe('policy-unreadable:torn')
  expect(classifySelectionFailure(new Error('Skill selection policy is unknown-schema')).reason).toBe('policy-unreadable:unknown-schema')
  expect(classifySelectionFailure(new Error('Skill selection policy is unsupported')).reason).toBe('policy-unsupported')
  expect(classifySelectionFailure(new Error('something else entirely')).reason).toBe('selection-unavailable')
  expect(classifySelectionFailure(new Error('something else entirely')).hint.length > 0).toBe(true)
})

test('5.3: a pinned resume failure keeps the menu empty with reason and hint — never a fallback list', async () => {
  const { provider } = providerSetup()
  const scope = scopeOf('session-cold')
  provider.noteFailure(scope, { code: 'session/' + 'writer-held', message: 'session log owned by pid 4242' })
  const status = provider.status(scope)
  expect(status.reason).toBe('session-writer-held')
  expect(status.hint).toContain('Another process holds this session log')
  expect(status.error).toContain('pid 4242')
  // The menu stays EMPTY even though the store read alone would succeed.
  const listed = await provider.list(scope)
  expect(listed.candidates).toEqual([])
  expect(listed.complete).toBe(false)
  // Lifting the note (recovery hook) restores normal reads.
  provider.clearFailure(scope)
  provider.acceptSelection([alpha], scope)
  const after = await provider.list(scope)
  expect(after.candidates.map(candidate => candidate.identity)).toEqual([alpha])
  expect(provider.status(scope).reason).toBeNull()
})

test('5.3: an accepted Apply clears a pinned failure note', async () => {
  const { provider } = providerSetup()
  const scope = scopeOf('session-cold')
  provider.noteFailure(scope, 'session log owned elsewhere (writer-held)')
  expect(provider.status(scope).reason).toBe('session-writer-held')
  provider.acceptSelection([alpha], scope)
  expect(provider.status(scope).reason).toBeNull()
  expect(provider.status(scope).error).toBeNull()
})

test('5.3: collect failures surface reason and hint on the status face', async () => {
  const provider = createSkillSelectionProvider({
    control: { invalidate() {} },
    readSelection: async () => { throw new Error('Skill selection policy is corrupt') },
    inventory: async () => ({ complete: true, candidates: [] }),
  })
  const listed = await provider.list(scopeOf('session-x'))
  expect(listed.candidates).toEqual([])
  const status = provider.status(scopeOf('session-x'))
  expect(status.error).toContain('corrupt')
  expect(status.reason).toBe('policy-unreadable:corrupt')
  expect(status.hint.length > 0).toBe(true)
})

test('5.3: the plugin-mounted face exposes noteFailure and status reason/hint', () => {
  const ctx = {
    skills: { registerProvider(create) { create({ invalidate() {} }) } },
    on() {},
    get() { return undefined },
  }
  createSkillSelectionPlugin({ readSelection: async () => [], inventory: async () => ({ complete: true, candidates: [] }), office: async () => ({ complete: true, candidates: [] }) })(ctx)
  const manager = skillSelectionFor(ctx)
  const scope = scopeOf('session-cold')
  manager.noteFailure(scope, { code: 'session/' + 'writer-held', message: 'session log owned by pid 7' })
  const status = manager.status(scope)
  expect(status.reason).toBe('session-writer-held')
  expect(status.hint).toContain('Another process holds this session log')
  manager.clearFailure(scope)
  expect(manager.status(scope).reason).toBeNull()
})

// --- 5.4 single Skill trigger source -----------------------------------------

/**
 * Test double encoding the host inputTriggers contract (EXECUTED): duplicate
 * (trigger, name) registrations throw; the disposer removes the source, after
 * which a re-registration succeeds. This is the exact semantics of the host
 * registerSource the preset relies on by NOT registering any parallel source.
 */
function createTriggerRegistry() {
  const sources = []
  return {
    sources: () => sources.slice(),
    registerSource(source) {
      if (sources.some(entry => entry.trigger === source.trigger && entry.name === source.name)) {
        throw new Error(`slash source "${source.trigger}${source.name}" is already registered`)
      }
      sources.push(source)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        const at = sources.indexOf(source)
        if (at >= 0) sources.splice(at, 1)
      }
    },
  }
}

test('5.4: the host trigger contract rejects duplicate (trigger, name) and allows re-registration after dispose', () => {
  const registry = createTriggerRegistry()
  const stock = { trigger: '/', name: 'skill', candidates: async () => [] }
  const dispose = registry.registerSource(stock)
  expect(() => registry.registerSource({ trigger: '/', name: 'skill', candidates: async () => [] })).toThrow(/already registered/)
  expect(registry.sources()).toHaveLength(1)
  dispose()
  expect(registry.sources()).toHaveLength(0)
  const again = registry.registerSource({ trigger: '/', name: 'skill', candidates: async () => [] })
  expect(registry.sources()).toHaveLength(1)
  again()
})

// --- static red lines ---------------------------------------------------------

test('static: capabilities add no session.append, no direct agents.resume, no new event or trigger source', () => {
  const capabilitiesDir = fileURLToPath(new URL('../src/capabilities/', import.meta.url))
  const names = readdirSync(capabilitiesDir, { recursive: true }).filter(name => String(name).endsWith('.js'))
  assert.ok(names.length > 0)
  for (const name of names) {
    const text = readFileSync(join(capabilitiesDir, String(name)), 'utf8')
    assert.ok(!/session\.append\(/.test(text), `${name}: session.append call (cold-read red line)`)
    assert.ok(!/agents\.resume\(/.test(text), `${name}: direct agents.resume call (use sessionController.resolveAgent if ever needed)`)
    assert.ok(!/registerSource|inputTriggers/.test(text), `${name}: new trigger source (single Skill trigger red line)`)
    // The one event this change emits lives in exactly one module.
    if (String(name) !== 'preset-invalidation.js') {
      assert.ok(!text.includes('agent-preset/selected'), `${name}: invalidation event literal outside preset-invalidation.js`)
    }
  }
})
