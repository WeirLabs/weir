// apply-delta-durable-basis (design D5): the production Apply-engine wiring
// pin. The production engine must run with the shared cold-safe audit channel
// (createAudit(ctx) → cordis emit + .weir/audit.jsonl mirror) and logger-backed
// trace diagnostics — before this change the production createApplyEngine call
// wired neither, so the capability-apply audit fired only in tests.
//
// Two surfaces:
//   1. the mounted plugin end-to-end (committed Apply through the face);
//   2. the exported hook assembly engineFor() spreads into createApplyEngine,
//      driven over a lossy store so the recovery-'published' settle is
//      reachable (the face exposes no receipt query, and a mount cannot force
//      an indeterminate write without a rigged store).
import { test, expect, storePlatformSkip, pinHermeticHostRoots } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'
import { APPLY_AUDIT_TYPE, createApplyEngine } from '../src/capabilities/apply-engine.js'
import { createSelectionNotifier } from '../src/capabilities/selection-notify.js'
import { applyEngineHooks, createSkillSelectionPlugin, skillSelectionFor } from '../src/capabilities/skill-selection-plugin.js'

const skip = storePlatformSkip
const SESSION = 'session-wiring-0000-4aaa-8bbb-cccccccccccc'
const auth = { id: SESSION, authenticated: true }

const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const alpha = identity('user', 'alpha')
const beta = identity('project', 'beta')
const candidateOf = value => ({ status: 'parsed', name: value.name, identity: value,
  path: `/${value.scope}/${value.name}/SKILL.md`, digest: createHash('sha256').update(`${value.scope}:${value.name}`).digest('hex') })

test('production wiring: a committed Apply through the mounted plugin emits capability-apply audit on the cold-safe channel', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-wiring-'))
    mkdirSync(join(root, 'custom-skills', 'alpha'), { recursive: true })
    writeFileSync(join(root, 'custom-skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: wiring fixture\n---\nALPHA\n')
    let provider
    const emitted = []
    const ctx = {
      skills: {
        registerProvider(create) { provider = create({ invalidate() {} }) },
        async list(options) { return (await provider.list(options)).candidates },
        layers: { global: { providers: new Map() } },
      },
      on() {},
      effect(fn) { fn(); return () => {} },
      emit(...args) { emitted.push(args) },
      logger: { warn() {}, debug() {} },
      get(name) {
        if (name === 'profileContext') return { home: root, name: 'it' }
        return undefined
      },
    }
    createSkillSelectionPlugin()(ctx, {
      machineId: 'weir-it-machine',
      includeDefaultRoots: false,
      customSkillDirs: [join(root, 'custom-skills')],
      agentsHome: host.agentsHome,
      dshHome: root,
    })
    const face = skillSelectionFor(ctx)
    const lookup = { cwd: root, scope: { session: { id: 'sess-wire' } } }
    const fixtureIdentity = (await face.inventory(lookup)).candidates.find(candidate => candidate.name === 'alpha')?.identity
    expect(fixtureIdentity !== undefined).toBe(true)
    const response = await face.applySelection(
      { sessionId: 'sess-wire', cwd: root, presetId: 'weir' },
      { requestId: 'wire-1', expectedRevision: 0, selection: { skills: [fixtureIdentity], mcpServers: [] }, unresolved: [] },
      lookup,
    )
    expect(response.status).toBe('applied')
    await new Promise(resolveImmediate => setImmediate(resolveImmediate))
    const audits = emitted.filter(([type]) => type === `weir/${APPLY_AUDIT_TYPE}`)
    expect(audits).toHaveLength(1)
    expect(audits[0][1].session).toBe('sess-wire')
    expect(audits[0][1].data.revision).toBe(1)
    // The face diagnostic reports the queued notice for that session (12.4).
    expect(face.hasPendingNotification('sess-wire')).toBe(true)
    expect(face.hasPendingNotification('sess-other')).toBe(false)
  } finally {
    host.restore()
  }
})

test('production wiring: the hook assembly audits a committed Apply and a recovery-published settle, and leaves notify unwired', { skip }, async t => {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-wiring-recovery-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    await rm(root, { recursive: true, force: true })
  })
  const store = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  const emitted = []
  const ctx = {
    emit: (...args) => emitted.push(args),
    get: () => undefined,
    logger: { warn() {}, debug() {} },
  }
  const notifier = createSelectionNotifier({ store })
  const hooks = applyEngineHooks({ ctx, lifecycle: null, notifier })
  // Design D5: notify is the response-bus seam and no production consumer
  // exists — the production wiring deliberately leaves it unset.
  expect(hooks.notify).toBeUndefined()
  expect(typeof hooks.audit).toBe('function')
  expect(typeof hooks.trace).toBe('function')
  let lose = false
  const lossy = { ...store, commit: async (...args) => {
    const result = await store.commit(...args)
    if (lose) throw new Error('response lost after durable acceptance')
    return result
  } }
  const engine = createApplyEngine({
    store: lossy,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    ...hooks,
  })
  const first = await engine.apply(auth, { requestId: 'req-1', expectedRevision: 0, selection: { skills: [alpha], mcpServers: [] }, unresolved: [] })
  expect(first.status).toBe('applied')
  await new Promise(resolveImmediate => setImmediate(resolveImmediate))
  let audits = emitted.filter(([type]) => type === `weir/${APPLY_AUDIT_TYPE}`)
  expect(audits).toHaveLength(1)
  expect(audits[0][1].data).toEqual({ requestId: 'req-1', revision: 1 })
  // Deliver the committed Apply's own notice so the recovery delta is observed
  // in isolation (the notifier net-merges across queued Applies by design).
  const committed = await notifier.pending(SESSION)
  expect(committed).toEqual({ added: ['alpha'], removed: [], revision: 1 })
  expect((await notifier.clearDelivered(SESSION, committed)).status).toBe('cleared')

  lose = true
  const second = await engine.apply(auth, { requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] }, unresolved: [] })
  expect(second.status).toBe('indeterminate')
  const query = await engine.queryReceipt(auth, 'req-2')
  expect(query.recovery).toBe('published')
  await new Promise(resolveImmediate => setImmediate(resolveImmediate))
  audits = emitted.filter(([type]) => type === `weir/${APPLY_AUDIT_TYPE}`)
  expect(audits).toHaveLength(2)
  expect(audits[1][1].data).toEqual({ requestId: 'req-2', revision: 2, recovery: 'published' })
  // The recovery publication also queued the model-facing notice through the
  // wired onAccepted hook — exactly one delta computed against the captured
  // pre-write sets ({alpha} → {beta}).
  expect(notifier.has(SESSION)).toBe(true)
  const recovered = await notifier.pending(SESSION)
  expect(recovered).toEqual({ added: ['beta'], removed: ['alpha'], revision: 3 })

  // Delivery is the only clear (durable-pending-notice D4): the diagnostic
  // follows the durable unit exactly (1.4) — true while queued, false once the
  // notice has been handed to a request boundary.
  const messages = []
  expect(await notifier.deliver(SESSION, messages)).toBe('delivered')
  expect(messages).toHaveLength(1)
  expect(messages[0].source.kind).toBe('weir-selection-notify')
  expect(notifier.has(SESSION)).toBe(false)
  expect(await notifier.pending(SESSION)).toBeNull()
})

// --- durable-pending-notice group 3.4: the delivery seam ----------------------
// The `agent/pre-step` listener becomes read → build → inject → clear: the
// obligation is cleared only AFTER the message landed in the request, so a
// failed injection now leaves it pending for the next safe boundary instead of
// dropping it (the old consume-before-push deleted it first).

test('3.4 delivery seam: a pre-seeded obligation is injected once and cleared after the push; a failed injection leaves it pending', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-wiring-deliver-'))
    const listeners = []
    const emitted = []
    let provider
    const ctx = {
      skills: {
        registerProvider(create) { provider = create({ invalidate() {} }) },
        async list(options) { return (await provider.list(options)).candidates },
        layers: { global: { providers: new Map() } },
      },
      on(name, handler) { listeners.push({ name, handler }) },
      effect(fn) { fn(); return () => {} },
      emit(...args) { emitted.push(args) },
      logger: { warn() {}, debug() {} },
      get(name) {
        if (name === 'profileContext') return { home: root, name: 'it' }
        return undefined
      },
    }
    createSkillSelectionPlugin()(ctx, {
      machineId: 'weir-it-machine',
      includeDefaultRoots: false,
      customSkillDirs: [],
      agentsHome: host.agentsHome,
      dshHome: root,
    })
    const preSteps = listeners.filter(listener => listener.name === 'agent/pre-step')
    expect(preSteps).toHaveLength(1)
    const preStep = preSteps[0].handler
    const face = skillSelectionFor(ctx)

    // The obligation is pre-seeded exactly where the plugin's store resolves it.
    const store = openCapabilityStore({ root: join(root, 'weir', 'profiles', 'it', 'capabilities'), platform: 'darwin', liveness: createStubLiveness() })
    const notice = { kind: 'notice', sessionId: 'sess-deliver' }
    assert.equal(store.commitSync(notice, 0, () => ({ added: ['alpha'], removed: ['beta'] })).status, 'committed')
    const stillPending = () => store.read(notice).then(record => record.payload)

    // A throwing push leaves the obligation pending (deliver-then-clear).
    await preStep({ agent: { id: 'sess-deliver' }, messages: Object.freeze([]) }, () => 'next')
    expect(await stillPending()).toEqual({ added: ['alpha'], removed: ['beta'] })
    // A non-array `messages` does the same: nothing injected, nothing cleared.
    await preStep({ agent: { id: 'sess-deliver' }, messages: {} }, () => 'next')
    expect(await stillPending()).toEqual({ added: ['alpha'], removed: ['beta'] })
    expect(face.hasPendingNotification('sess-deliver')).toBe(true)
    const failures = emitted
      .filter(([type]) => type === 'weir/capability-notice')
      .map(([, record]) => record.data)
      .filter(data => data.outcome === 'injection-failed')
    expect(failures).toHaveLength(2)

    // The next healthy boundary injects exactly one UserMessage and clears it.
    const messages = []
    await preStep({ agent: { id: 'sess-deliver' }, messages }, () => 'next')
    expect(messages).toHaveLength(1)
    const injected = messages[0]
    expect(injected.role).toBe('user')
    expect(injected.source.kind).toBe('weir-selection-notify')
    expect(injected.content[0].text).toContain('Removed: beta.')
    expect(injected.content[0].text).toContain('Added: alpha.')
    expect(injected.content[0].text).toContain('not a user message')
    expect(await stillPending()).toEqual({ added: [], removed: [] })
    expect(face.hasPendingNotification('sess-deliver')).toBe(false)

    // Cleared means cleared: a second boundary injects nothing.
    const again = []
    await preStep({ agent: { id: 'sess-deliver' }, messages: again }, () => 'next')
    expect(again).toHaveLength(0)
    const outcomes = emitted
      .filter(([type]) => type === 'weir/capability-notice')
      .map(([, record]) => record.data.outcome)
    expect(outcomes).toContain('delivered')
    expect(outcomes).toContain('cleared')
  } finally {
    host.restore()
  }
})
