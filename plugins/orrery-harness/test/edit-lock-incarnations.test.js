import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager, recoverEditLockManager } from '../src/edit-lock/manager.js'
import { parseSnapshot, validateImage } from '../src/edit-lock/snapshot.js'
import { expectedRegistry, incarnationProcess, isRegistryUpgrade, referencedIncarnations,
  seedIncarnations, withIncarnation } from '../src/edit-lock/incarnations.js'

/** @param {number} pid @param {string} [bootNonce] */
const identity = (pid, bootNonce = 'boot-1') => ({ pid, host: 'host-a', osStart: 'start-a', bootNonce })

/** @param {(dir: string) => Promise<void>} run */
async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-incarnations-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

/** A minimal v4 image with one session, one lock and one operation origin. */
function historicalImage() {
  const digest = 'a'.repeat(64)
  return {
    version: 4, managerIncarnation: 'old-incarnation', operations: [{
      sessionId: 'alice', operationId: 'op-1', origin: { executionEpoch: 1, managerIncarnation: 'old-incarnation' },
      binding: { tool: 'write', filePath: '/w/a.txt', cwd: '/w', requestDigest: digest, argsDigest: digest, payloadDigest: digest,
        target: { kind: 'update', resourceId: '/w/a.txt', generation: 1, policy: { kind: 'replaceIfVersion', version: 'v0' } } },
      phase: 'unknown', fence: { kind: 'resource', resourceId: '/w/a.txt' }, outcome: { kind: 'unknown' }, closeouts: [],
    }],
    sessions: [{ sessionId: 'alice', executionEpoch: 2, interrupted: true }],
    generations: [{ resourceId: '/w/a.txt', generation: 1 }],
    locks: [{ resourceId: '/w/a.txt', owner: 'alice', generation: 1, status: 'user-interrupted' }],
    issuedRequests: [], recovery: [],
    holds: [{ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 }],
  }
}

test('referenced incarnations are the manager incarnation plus operation origins; seeds carry null identity', () => {
  const state = historicalImage()
  assert.deepEqual([...referencedIncarnations(state)], ['old-incarnation'])
  state.operations.push({ ...structuredClone(state.operations[0]), operationId: 'op-2',
    origin: { executionEpoch: 3, managerIncarnation: 'older-incarnation' } })
  assert.deepEqual([...referencedIncarnations(state)], ['old-incarnation', 'older-incarnation'])
  assert.deepEqual(seedIncarnations(state), [
    { incarnation: 'old-incarnation', process: null },
    { incarnation: 'older-incarnation', process: null },
  ])
  assert.deepEqual([...referencedIncarnations({ managerIncarnation: null, operations: [] })], [])
})

test('withIncarnation is a no-op without a process identity and keeps entries immutable', () => {
  const state = historicalImage()
  assert.equal(withIncarnation(state, 'new-incarnation', null), state)
  const upgraded = withIncarnation(state, 'new-incarnation', identity(42), 'old-incarnation')
  assert.equal(upgraded.version, 6)
  assert.deepEqual(upgraded.adminRecoveries, [])
  assert.deepEqual(upgraded.incarnations, [
    { incarnation: 'old-incarnation', process: null },
    { incarnation: 'new-incarnation', process: identity(42) },
  ])
  assert.equal(incarnationProcess(upgraded, 'new-incarnation').pid, 42)
  assert.equal(incarnationProcess(upgraded, 'old-incarnation'), null)
  // Already registered: a second identity never rewrites the durable entry.
  assert.equal(withIncarnation(upgraded, 'new-incarnation', identity(99)), upgraded)
  // A null entry stays null forever (never backfilled by a later writer).
  const again = withIncarnation(upgraded, 'third-incarnation', identity(100))
  assert.equal(incarnationProcess(again, 'old-incarnation'), null)
  assert.deepEqual(again.incarnations.map(entry => entry.incarnation), ['old-incarnation', 'new-incarnation', 'third-incarnation'])
})

test('the exact registry a v6 transition must carry admits only the current incarnation as a new entry', () => {
  const before = historicalImage()
  const after = withIncarnation({ ...before, managerIncarnation: 'new-incarnation' }, 'new-incarnation', identity(42), 'old-incarnation')
  assert.deepEqual(expectedRegistry(before, after), after.incarnations)
  assert.equal(isRegistryUpgrade(before, after), true)
  // Registry tampering is not the upgrade: backfill, reorder, drop or append.
  for (const tamper of [
    registry => { registry[0] = { incarnation: 'old-incarnation', process: identity(7) } },
    registry => registry.reverse(),
    registry => registry.pop(),
    registry => registry.push({ incarnation: 'extra', process: null }),
  ]) {
    const forged = structuredClone(after)
    tamper(forged.incarnations)
    assert.equal(isRegistryUpgrade(before, forged), false)
  }
  assert.equal(isRegistryUpgrade(after, after), false, 'v6 to v6 is not an upgrade')
  assert.equal(isRegistryUpgrade(before, { ...before, version: 5 }), false, 'v4 to v5 is administrative only')
})

test('v6 images validate their registry: shape, uniqueness, identity fields and reference coverage', () => {
  const good = withIncarnation({ ...historicalImage(), managerIncarnation: 'new-incarnation' }, 'new-incarnation', identity(42), 'old-incarnation')
  assert.doesNotThrow(() => validateImage(good))
  for (const tamper of [
    s => { delete s.incarnations },
    s => { s.incarnations = {} },
    s => { s.incarnations.push({ ...s.incarnations[0] }) },
    s => { s.incarnations[0] = { incarnation: 'old-incarnation' } },
    s => { s.incarnations[1].process = { pid: 0, host: 'h', osStart: null, bootNonce: 'b' } },
    s => { s.incarnations[1].process = { pid: 1.5, host: 'h', osStart: null, bootNonce: 'b' } },
    s => { delete s.incarnations[1].process.bootNonce },
    s => { s.incarnations[1].process.osStart = 42 },
    s => { s.incarnations = s.incarnations.filter(entry => entry.incarnation !== 'old-incarnation') },
    s => { s.operations.push({ ...structuredClone(s.operations[0]), operationId: 'op-2', origin: { executionEpoch: 1, managerIncarnation: 'unregistered' } }) },
  ]) {
    const forged = structuredClone(good)
    tamper(forged)
    assert.throws(() => validateImage(forged), /invalid/, JSON.stringify(forged.incarnations))
  }
})

test('an identity-aware manager writes v6 from the first commit and keeps the registry immutable afterwards', () => withStore(async directory => {
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'incarnation-1', processIdentity: identity(111) })
    const execution = await manager.openSession('alice')
    let state = store.snapshot().state
    assert.equal(state.version, 6)
    assert.deepEqual(state.incarnations, [{ incarnation: 'incarnation-1', process: identity(111) }])
    assert.deepEqual(state.adminRecoveries, [])
    await manager.acquire(execution, '/w/a.txt')
    const registry = store.snapshot().state.incarnations
    assert.deepEqual(registry, [{ incarnation: 'incarnation-1', process: identity(111) }])
    // Registry tampering in a later record is refused by the transition discipline.
    const forged = structuredClone(store.snapshot().state)
    forged.incarnations = [{ incarnation: 'incarnation-1', process: identity(999) }]
    await assert.rejects(store.record({ expectedRevision: store.snapshot().revision, nextState: forged }), /incarnation registry/)
    await manager.close()
  } finally { await store.close() }
}))

test('a pre-v6 image upgrades losslessly on recovery: null identities for history, identity for the new incarnation', () => withStore(async directory => {
  let store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  try {
    // Historical writer without identity: the image stays v4 (today's behavior).
    const original = createEditLockManager({ store, managerIncarnation: 'old-incarnation' })
    const execution = await original.openSession('alice')
    await original.acquire(execution, '/w/a.txt')
    await original.close()
    await store.close()
    assert.equal((await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })).snapshot().state.version, 4)

    store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
    const before = store.snapshot()
    const recovered = await recoverEditLockManager({ store, managerIncarnation: 'new-incarnation', processIdentity: identity(222) })
    const state = store.snapshot().state
    assert.equal(state.version, 6)
    assert.equal(store.snapshot().revision, before.revision + 1)
    assert.deepEqual(state.incarnations, [
      { incarnation: 'old-incarnation', process: null },
      { incarnation: 'new-incarnation', process: identity(222) },
    ])
    // Lossless: sessions, locks, generations and history ride through unchanged.
    assert.equal(state.sessions[0].sessionId, 'alice')
    assert.equal(state.locks[0].resourceId, '/w/a.txt')
    assert.equal(recovered.status().locks[0].status, 'user-interrupted')
    await recovered.close()
  } finally { await store.close() }
}))

test('a v6 image round-trips byte-exact and a v6 payload without a registry is refused', () => withStore(async directory => {
  const { readFile, writeFile } = await import('node:fs/promises')
  let store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'incarnation-1', processIdentity: identity(111) })
    await manager.openSession('alice')
    await manager.close()
    await store.close()
    store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
    const state = store.snapshot().state
    assert.equal(state.version, 6)
    const recovered = await recoverEditLockManager({ store, managerIncarnation: 'incarnation-2', processIdentity: identity(222, 'boot-2') })
    assert.equal(store.snapshot().state.incarnations.length, 2)
    await recovered.close()
    // A v6 payload whose state lacks the registry fails closed (old builds
    // refuse v6 wholesale; this build refuses a torn one).
    const bytes = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'))
    const forgedState = structuredClone(store.snapshot().state)
    delete forgedState.incarnations
    const payload = { ...bytes.payload, state: forgedState }
    const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
        : JSON.stringify(value)
    await writeFile(join(directory, 'snapshot.json'), canonical({ payload, checksum: createHash('sha256').update(canonical(payload)).digest('hex') }))
    await assert.rejects(openEditLockStore({ directory, domainId: 'd', mode: 'recover' }), /schema keys/)
    assert.doesNotThrow(() => parseSnapshot(Buffer.from(canonical({ payload: bytes.payload, checksum: bytes.checksum })), 'd'))
  } finally { await store.close() }
}))
