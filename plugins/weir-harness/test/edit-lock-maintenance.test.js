import { it, describe } from './helpers.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, lstat, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { parseSnapshot } from '../src/edit-lock/snapshot.js'
import { summarizeAuthorityImage, maintenanceState } from '../src/edit-lock/inspect.js'
import {
  createEditLockEvidence,
  inspectAuthority,
  maintenanceStatus,
  registerEditLockMaintenanceEndpoints,
  wireEditLockMaintenance,
} from '../src/edit-lock/maintenance.js'
import { createSettingsPlugin, maintenanceRoots } from '../src/settings/index.js'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { fixtureRoot, fixtureEndpoint, fixtureExclude } from './helpers/edit-lock-fixtures.js'
const applySettings = createSettingsPlugin({ resolveRoot: fixtureRoot })
const applyEditLock = createEditLockPlugin({ resolveRoot: fixtureRoot, endpoint: fixtureEndpoint, exclude: fixtureExclude })

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function tempRoot(prefix = 'weir-maint-') {
  // realpath: the inspector canonicalizes (macOS /var → /private/var), so the
  // fixture root must be canonical from the start (domainId equality depends).
  return realpathSync.native(await mkdtemp(join(tmpdir(), prefix)))
}

/** A real authority at <root>/.weir/edit-lock carrying one genuinely
 * `unknown` publication (invoked publisher rejection) and its retained lock. */
async function authorityWithUnknown(t) {
  const root = await tempRoot()
  const directory = join(root, '.weir', 'edit-lock')
  await mkdir(directory, { recursive: true })
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const manager = createEditLockManager({ store, managerIncarnation: 'm' })
  const child = await manager.openSession('child')
  const token = await manager.acquire(child, '/w/child.txt')
  const input = {
    operationId: 'interrupted', tool: 'write', filePath: '/w/child.txt', cwd: '/w', args: {}, content: 'new',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: token.resourceId, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
  }
  const publisher = { validate() {}, publish: async () => { throw new Error('invoked failure') }, identify: () => token.resourceId }
  const ready = await manager.prepare(child, input, publisher)
  await assert.rejects(manager.commit(ready.submission), /invoked failure/)
  assert.equal(manager.history('child', 'interrupted').phase, 'unknown')
  await store.close()
  return { root, directory, resourceId: token.resourceId }
}

function fakeConnection() {
  const routes = new Map()
  const connection = {
    fetch: {
      register(definition) {
        routes.set(definition.path, definition)
        return () => routes.delete(definition.path)
      },
    },
  }
  const call = async (path, body) => {
    const definition = routes.get(path)
    assert.ok(definition, `endpoint registered: ${path}`)
    const response = await definition.fetch({ json: async () => body })
    return { status: response.status, payload: await response.json() }
  }
  return { connection, routes, call }
}

function deps(overrides = {}) {
  return {
    savedEnabled: () => false,
    evidence: createEditLockEvidence(),
    candidateRoots: () => [],
    ...overrides,
  }
}

describe('maintenance switch state decision', () => {
  it('distinguishes saved from mounted and never guesses on missing evidence', () => {
    assert.equal(maintenanceState({ saved: true, enabledAtMount: true }), 'enforced')
    assert.equal(maintenanceState({ saved: false, enabledAtMount: true }), 'disable-requested')
    assert.equal(maintenanceState({ saved: true, enabledAtMount: false }), 'enable-requested')
    assert.equal(maintenanceState({ saved: false, enabledAtMount: false }), 'disabled')
    assert.equal(maintenanceState({ saved: true, enabledAtMount: undefined }), 'unknown')
    assert.equal(maintenanceState({ saved: false, enabledAtMount: undefined }), 'unknown')
  })
})

describe('maintenanceStatus', () => {
  it('reports the four states plus unknown, restart semantics and profile scope', () => {
    const evidence = createEditLockEvidence()
    // no mount evidence at all → unknown (saved alone proves nothing)
    assert.equal(maintenanceStatus(deps({ evidence })).state, 'unknown')
    assert.equal(maintenanceStatus(deps({ evidence })).mounted, null)
    evidence.recordMount({ enabled: true })
    assert.equal(maintenanceStatus(deps({ evidence, savedEnabled: () => true })).state, 'enforced')
    const disableRequested = maintenanceStatus(deps({ evidence, savedEnabled: () => false }))
    assert.equal(disableRequested.state, 'disable-requested')
    assert.equal(disableRequested.restartRequired, true)
    assert.equal(disableRequested.scope, 'profile')
    const evidence2 = createEditLockEvidence()
    evidence2.recordMount({ enabled: false })
    assert.equal(maintenanceStatus(deps({ evidence: evidence2, savedEnabled: () => true })).state, 'enable-requested')
    assert.equal(maintenanceStatus(deps({ evidence: evidence2, savedEnabled: () => false })).state, 'disabled')
  })

  it('surfaces initialization-blocked evidence (domain open failure, unregistered session)', () => {
    const evidence = createEditLockEvidence()
    const mount = evidence.recordMount({ enabled: true })
    mount.recordDomain('/work/broken', { error: 'authority image corrupt' })
    mount.recordDomain('/work/fine', { mode: 'publisher' })
    mount.recordSessionFailure('sess-1', 'reservation replaced')
    const status = maintenanceStatus(deps({ evidence, savedEnabled: () => true }))
    assert.deepEqual(status.blocked, [
      { kind: 'domain', root: '/work/broken', reason: 'authority image corrupt' },
      { kind: 'session', sessionId: 'sess-1', reason: 'reservation replaced' },
    ])
    const broken = status.domains.find(domain => domain.root === '/work/broken')
    assert.equal(broken.error, 'authority image corrupt')
    const fine = status.domains.find(domain => domain.root === '/work/fine')
    assert.equal(fine.mode, 'publisher')
    assert.equal(fine.hasAuthority, false) // cheap fs fact, honestly absent in this fixture
  })
})

describe('inspectAuthority (read-only)', () => {
  it('reports an unresolved publication with its fence scope and leaves every byte identical', async (t) => {
    const { root, directory, resourceId } = await authorityWithUnknown(t)
    // a stranded publisher reservation is a reported fact, never removed
    const reservation = join(root, '.weir', '.edit-lock.publisher-reservation')
    await mkdir(reservation)
    const snapshotPath = join(directory, 'snapshot.json')
    const before = await readFile(snapshotPath)
    const listingBefore = await readdir(directory)
    const result = inspectAuthority(root)
    assert.equal(result.presence, 'valid')
    assert.equal(result.reservation, true)
    const { snapshot } = result
    assert.equal(snapshot.version, 4)
    assert.equal(snapshot.counts.unresolved, 1)
    const [op] = snapshot.unresolved
    assert.equal(op.phase, 'unknown')
    assert.equal(op.outcome, 'unknown')
    assert.deepEqual(op.scope, { kind: 'file', path: resourceId })
    assert.deepEqual(op.fence, { kind: 'resource', resourceId })
    assert.equal(op.target.tool, 'write')
    assert.equal(op.key.sessionId, 'child')
    assert.equal(op.key.operationId, 'interrupted')
    assert.equal(op.closeouts, 0)
    // read-only: bytes, listing and reservation untouched
    assert.equal(sha256(await readFile(snapshotPath)), sha256(before))
    assert.deepEqual(await readdir(directory), listingBefore)
    assert.ok((await lstat(reservation)).isDirectory())
  })

  it('surfaces corruption as a visible state, never repairs, and preserves the refusal reason', async (t) => {
    const { root, directory } = await authorityWithUnknown(t)
    const snapshotPath = join(directory, 'snapshot.json')
    const original = (await readFile(snapshotPath)).toString('utf8')
    const truncated = `${original.slice(0, -4)}xxxx`
    await writeFile(snapshotPath, truncated)
    const result = inspectAuthority(root)
    assert.equal(result.presence, 'corrupt')
    assert.ok(typeof result.message === 'string' && result.message.length > 0)
    // never repaired: the corrupt bytes stand
    assert.equal((await readFile(snapshotPath)).toString('utf8'), truncated)
    // a checksum mismatch names the integrity failure specifically
    const corrupted = original.replace(/"checksum":"([a-f0-9])/, (_match, digit) => `"checksum":"${digit === 'a' ? 'b' : 'a'}`)
    assert.notEqual(corrupted, original)
    await writeFile(snapshotPath, corrupted)
    const checksum = inspectAuthority(root)
    assert.equal(checksum.presence, 'corrupt')
    assert.match(checksum.message, /snapshot checksum/)
    await writeFile(snapshotPath, original)
  })

  it('distinguishes none / empty / no-committed-snapshot presence facts without creating anything', async (t) => {
    const root = await tempRoot()
    t.after(() => rm(root, { recursive: true, force: true }))
    assert.equal(inspectAuthority(root).presence, 'none')
    const directory = join(root, '.weir', 'edit-lock')
    await mkdir(directory, { recursive: true })
    assert.equal(inspectAuthority(root).presence, 'empty')
    await writeFile(join(directory, 'stray'), 'x')
    const junk = inspectAuthority(root)
    assert.equal(junk.presence, 'no-committed-snapshot')
    assert.deepEqual(await readdir(directory), ['stray'])
  })
})

describe('snapshot validator (extracted, shared with the store)', () => {
  it('parses the exact bytes the store wrote and rejects version/domain/checksum deviations', async (t) => {
    const { root, directory } = await authorityWithUnknown(t)
    const bytes = await readFile(join(directory, 'snapshot.json'))
    const parsed = parseSnapshot(bytes, root)
    assert.equal(parsed.state.version, 4)
    assert.equal(parsed.state.operations.length, 1)
    assert.throws(() => parseSnapshot(bytes, 'other-domain'), /snapshot domain/)
    assert.throws(() => parseSnapshot(Buffer.from(`${bytes.toString('utf8')}\n`), root), /noncanonical/)
  })
})

describe('summarizeAuthorityImage (pure projection)', () => {
  it('keeps non-active locks as retained rows with reason and counts inert closeouts', () => {
    const summary = summarizeAuthorityImage({
      revision: 7,
      state: {
        version: 4,
        managerIncarnation: 'm',
        sessions: [{ sessionId: 's', executionEpoch: 3, interrupted: true }],
        generations: [{ resourceId: '/w/a.txt', generation: 2 }],
        locks: [
          { resourceId: '/w/a.txt', owner: 's', generation: 2, status: 'user-interrupted' },
          { resourceId: '/w/b.txt', owner: 's', generation: 1, status: 'abnormal', reason: 'provider error' },
        ],
        issuedRequests: [],
        recovery: [{ sessionId: 's', attempts: 1, elapsedMs: 1000, pauseMs: 0 }],
        holds: [{ sessionId: 's', holding: false, holdUntil: null, holdCumulativeMs: 0 }],
        operations: [{
          sessionId: 's', operationId: 'op',
          origin: { executionEpoch: 2, managerIncarnation: 'm' },
          binding: { tool: 'write', filePath: '/w/a.txt' },
          phase: 'unknown', outcome: { kind: 'unknown' },
          fence: { kind: 'resource', resourceId: '/w/a.txt' },
          closeouts: [{ kind: 'abandoned-unknown', assertionId: 'a1' }],
        }],
      },
    })
    assert.equal(summary.counts.unresolved, 1)
    assert.equal(summary.unresolved[0].closeouts, 1)
    assert.equal(summary.retainedLocks.length, 2)
    assert.equal(summary.retainedLocks[1].reason, 'provider error')
    assert.equal(summary.sessions[0].recovery.attempts, 1)
  })

  it('exposes prepared operations so the panel can hide impossible recoveries', () => {
    const summary = summarizeAuthorityImage({
      revision: 3,
      state: {
        version: 4,
        managerIncarnation: 'm',
        sessions: [{ sessionId: 's', executionEpoch: 1, interrupted: true }],
        generations: [],
        locks: [],
        issuedRequests: [],
        recovery: [],
        holds: [],
        operations: [
          { sessionId: 's', operationId: 'op-prepared', binding: { tool: 'write', filePath: '/w/c.txt' }, phase: 'prepared' },
          { sessionId: 's', operationId: 'op-unknown', binding: { tool: 'write', filePath: '/w/a.txt' }, phase: 'unknown', outcome: { kind: 'unknown' }, fence: { kind: 'resource', resourceId: '/w/a.txt' } },
        ],
      },
    })
    assert.equal(summary.unresolved.length, 1)
    assert.deepEqual(summary.prepared, [{ target: { tool: 'write', filePath: '/w/c.txt' }, key: { sessionId: 's', operationId: 'op-prepared' } }])
  })
})

describe('maintenance endpoints', () => {
  it('serves status and inspect over the connection registry, reachable with the manager disabled', async () => {
    const { connection, call } = fakeConnection()
    const evidence = createEditLockEvidence() // nothing mounted: the disabled case
    registerEditLockMaintenanceEndpoints({ connection }, deps({ evidence }))
    const status = await call('/api/weir-edit-lock/maintenance/status')
    assert.equal(status.status, 200)
    assert.equal(status.payload.ok, true)
    assert.equal(status.payload.value.state, 'unknown')
    assert.equal(status.payload.value.scope, 'profile')
  })

  it('refuses a client-supplied path that the server never derived (authorization)', async (t) => {
    const trusted = await tempRoot()
    const untrusted = await tempRoot('weir-maint-untrusted-')
    t.after(() => rm(trusted, { recursive: true, force: true }))
    t.after(() => rm(untrusted, { recursive: true, force: true }))
    // even a REAL authority is never read when its root was not server-derived
    const authority = join(untrusted, '.weir', 'edit-lock')
    await mkdir(authority, { recursive: true })
    const store = await openEditLockStore({ directory: authority, domainId: untrusted, mode: 'create' })
    await store.close()
    const { connection, call } = fakeConnection()
    registerEditLockMaintenanceEndpoints({ connection }, deps({ candidateRoots: () => [trusted] }))
    const missing = await call('/api/weir-edit-lock/maintenance/inspect')
    assert.equal(missing.status, 400)
    const unresolvable = await call('/api/weir-edit-lock/maintenance/inspect', { root: join(untrusted, 'does-not-exist') })
    assert.equal(unresolvable.status, 403)
    assert.equal(unresolvable.payload.error.code, 'weir-edit-lock/untrusted-root')
    const refused = await call('/api/weir-edit-lock/maintenance/inspect', { root: untrusted })
    assert.equal(refused.status, 403)
    assert.equal(refused.payload.error.code, 'weir-edit-lock/untrusted-root')
    assert.match(refused.payload.error.message, /not an Edit Lock domain root/)
    // the trusted root is served
    const served = await call('/api/weir-edit-lock/maintenance/inspect', { root: trusted })
    assert.equal(served.status, 200)
    assert.equal(served.payload.value.presence, 'none')
  })

  it('mount-evidence roots stay inspectable when the manager is off (the historical-disable case)', async (t) => {
    const { root } = await authorityWithUnknown(t)
    const { connection, call } = fakeConnection()
    const evidence = createEditLockEvidence()
    const mount = evidence.recordMount({ enabled: false })
    mount.recordDomain(root, { mode: 'publisher' })
    registerEditLockMaintenanceEndpoints({ connection }, deps({ evidence }))
    const status = await call('/api/weir-edit-lock/maintenance/status')
    assert.equal(status.payload.value.state, 'disabled')
    assert.deepEqual(status.payload.value.domains.map(domain => domain.root), [root])
    const inspected = await call('/api/weir-edit-lock/maintenance/inspect', { root })
    assert.equal(inspected.status, 200)
    assert.equal(inspected.payload.value.snapshot.counts.unresolved, 1)
  })

  it('wireEditLockMaintenance resolves connection through ctx.inject and disposes', async () => {
    const { connection, routes } = fakeConnection()
    const injections = []
    const ctx = { inject: (names, callback) => { injections.push({ names, callback }) } }
    const off = wireEditLockMaintenance(ctx, deps())
    const injection = injections.find(entry => entry.names.join(',') === 'connection')
    assert.ok(injection, 'connection inject requested')
    injection.callback({ connection })
    assert.equal(routes.size, 3)
    off()
    assert.equal(routes.size, 0)
  })

  it('a status handler failure surfaces as a structured error, never an exception into settings', async () => {
    const { connection, call } = fakeConnection()
    registerEditLockMaintenanceEndpoints({ connection }, deps({
      candidateRoots: () => { throw new Error('agents exploded') },
    }))
    const status = await call('/api/weir-edit-lock/maintenance/status')
    assert.equal(status.status, 500)
    assert.equal(status.payload.ok, false)
    assert.match(status.payload.error.message, /agents exploded/)
  })
})

describe('no hot tool bypass', () => {
  it('the maintenance module registers no tools and names no agent-facing tool surface', async () => {
    const source = await readFile(new URL('../src/edit-lock/maintenance.js', import.meta.url), 'utf8')
    assert.equal(source.includes('tools.register'), false)
    assert.equal(source.includes('edit_lock_'), false)
    assert.equal(source.includes('pre-execute'), false)
    assert.equal(source.includes('commands'), false)
  })
})

/** Settings-row wiring harness: provide/get/on/inject/emit captured. */
function settingsHarness(config, { agents } = {}) {
  const provided = new Map()
  const handlers = new Map()
  const emitted = []
  const injections = []
  const ctx = {
    logger: { warn() {} },
    reflect: { provide: (name, impl) => provided.set(name, impl) },
    get: (key) => (key === 'agents' ? agents : undefined),
    on: (event, handler) => handlers.set(event, handler),
    inject: (names, callback) => injections.push({ names, callback }),
    emit: (...args) => emitted.push(args),
  }
  const dispose = applySettings(ctx, config)
  return { ctx, provided, handlers, emitted, injections, dispose, service: provided.get('weirSettings') }
}

describe('settings row maintenance wiring', () => {
  it('records enable/disable intent through shared audit on committed transitions only', () => {
    const config = { editLockEnabled: false }
    const { handlers, emitted } = settingsHarness(config)
    // mounting emits nothing: the initial value is not an intent
    assert.equal(emitted.length, 0)
    config.editLockEnabled = true
    handlers.get('loader/volatile-update')()
    config.editLockEnabled = false
    handlers.get('loader/volatile-update')()
    // a repeated commit of the SAME value is not a new intent
    handlers.get('loader/volatile-update')()
    const records = emitted.filter(([type]) => type === 'weir/edit-lock-maintenance').map(([, record]) => record)
    assert.deepEqual(records.map(record => record.data.kind), ['enable-requested', 'disable-requested'])
    assert.equal(records[0].data.scope, 'profile')
    assert.equal(records[0].data.appliesAfterRestart, true)
    assert.equal(records[0].session, null) // profile-level intent, no session log (S13)
  })

  it('an audit-channel failure cannot make a committed setting look failed', () => {
    const config = { editLockEnabled: false }
    const { handlers, service } = settingsHarness(config)
    // break the audit channel after mount: audit() never throws by contract,
    // and the observer runs after the commit — the saved value must stick.
    service.get('editLock') // service healthy before
    handlers.get('loader/volatile-update')() // baseline: no throw
    config.editLockEnabled = true
    handlers.get('loader/volatile-update')()
    assert.equal(service.get('editLock').enabled, true)
  })

  it('serves status reflecting saved value and row-reported mount evidence; disposes cleanly', async () => {
    const config = { editLockEnabled: true }
    const { connection, call, routes } = fakeConnection()
    const harness = settingsHarness(config)
    const injection = harness.injections.find(entry => entry.names.join(',') === 'connection')
    assert.ok(injection, 'maintenance wiring requested the connection service')
    injection.callback({ connection })
    // unknown until the preset row reports — the saved value alone is not proof
    let status = (await call('/api/weir-edit-lock/maintenance/status')).payload.value
    assert.equal(status.state, 'unknown')
    assert.equal(status.saved, true)
    // the preset row reports through the host-plane service recorder
    const disabled = harness.service.editLockEvidence.recordMount({ enabled: false, pinned: false, fixed: false })
    status = (await call('/api/weir-edit-lock/maintenance/status')).payload.value
    assert.equal(status.state, 'enable-requested')
    assert.equal(status.restartRequired, true)
    disabled.dispose()
    const enabled = harness.service.editLockEvidence.recordMount({ enabled: true })
    status = (await call('/api/weir-edit-lock/maintenance/status')).payload.value
    assert.equal(status.state, 'enforced')
    enabled.dispose()
    status = (await call('/api/weir-edit-lock/maintenance/status')).payload.value
    assert.equal(status.state, 'unknown')
    harness.dispose()
    assert.equal(routes.size, 0)
  })

  it('derives roots with the production resolver seam, never a client path', () => {
    const seen = []
    const agents = { roots: () => [{ session: { header: { cwd: '/fixture/project/sub' } } }] }
    assert.deepEqual(maintenanceRoots(agents, cwd => { seen.push(cwd); return '/fixture/project' }), ['/fixture/project'])
    assert.deepEqual(seen, ['/fixture/project/sub'])
  })
})

describe('edit-lock row mount evidence', () => {
  const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }
  function rowHost(evidence) {
    const provided = new Map()
    const listeners = new Map()
    const ctx = {
      fs: stubFs,
      logger: { warn() {} },
      on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
      reflect: { provide: (name, value) => provided.set(name, value) },
      get: (name) => (name === 'weirSettings'
        ? { get: () => undefined, editLockEvidence: evidence }
        : provided.get(name)),
      tools: { get: (name, agent) => agent?.visible?.get(name), register: () => () => {} },
    }
    const agentCreated = (agent) => Promise.all((listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
    return { ctx, provided, agentCreated }
  }
  const fakeAgent = (id, root) => {
    const visible = new Map(Object.entries({ write: { name: 'write', execute() {} }, edit: { name: 'edit', execute() {} } }))
    return {
      id,
      visible,
      session: { header: { cwd: root } },
      ctx: { tools: {
        restrict({ deny }) { for (const name of deny) visible.delete(name) },
        register(definition) { visible.set(definition.name, definition); return () => visible.delete(definition.name) },
      } },
    }
  }

  it('disabled rows own disposable evidence too', () => {
    const evidence = createEditLockEvidence()
    const { ctx } = rowHost(evidence)
    const dispose = applyEditLock(ctx, {})
    assert.equal(evidence.snapshot().mounts[0].enabled, false)
    dispose()
    assert.equal(evidence.snapshot().mounts.length, 0)
  })

  it('an enabled row records the mount and the fixed domain mode, and clears on dispose', async (t) => {
    const evidence = createEditLockEvidence()
    const root = await tempRoot()
    t.after(() => rm(root, { recursive: true, force: true }))
    const directory = join(root, 'authority')
    await mkdir(directory, { recursive: true })
    const { ctx, agentCreated } = rowHost(evidence)
    const dispose = applyEditLock(ctx, { enabled: true, root, authorityDirectory: directory })
    assert.equal(evidence.snapshot().mounts[0].enabled, true)
    assert.equal(evidence.snapshot().mounts[0].pinned, true)
    assert.equal(evidence.snapshot().mounts[0].fixed, true)
    await agentCreated(fakeAgent('sess-x', root))
    const domains = evidence.snapshot().domains
    assert.equal(domains.length, 1)
    assert.equal(domains[0].root, root)
    assert.equal(domains[0].mode, 'publisher')
    await dispose()
    assert.equal(evidence.snapshot().mounts.length, 0)
    assert.equal(evidence.snapshot().domains.length, 0)
  })

  it('a failed registration records the session failure and the domain-open error', async (t) => {
    const evidence = createEditLockEvidence()
    const root = await tempRoot()
    t.after(() => rm(root, { recursive: true, force: true }))
    const directory = join(root, 'authority')
    await mkdir(directory, { recursive: true })
    // junk in the authority directory: storeMode refuses → the domain never opens
    await writeFile(join(directory, 'stray'), 'x')
    const { ctx, agentCreated } = rowHost(evidence)
    const dispose = applyEditLock(ctx, { enabled: true, root, authorityDirectory: directory })
    t.after(dispose)
    await agentCreated(fakeAgent('sess-y', root))
    const snapshot = evidence.snapshot()
    assert.equal(snapshot.domains[0].root, root)
    assert.match(snapshot.domains[0].error ?? '', /no committed snapshot/)
    assert.equal(snapshot.sessionFailures.length, 1)
    assert.equal(snapshot.sessionFailures[0].sessionId, 'sess-y')
  })
})
