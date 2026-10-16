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
  const notifier = createSelectionNotifier()
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
  // Drain the committed Apply's own notice so the recovery delta is observed
  // in isolation (the notifier net-merges across queued Applies by design).
  expect(notifier.consume(SESSION)?.net).toEqual({ added: ['alpha'], removed: [] })

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
  expect(notifier.consume(SESSION).net).toEqual({ added: ['beta'], removed: ['alpha'] })
})
