// Design D3: on recovery open, unknown-phase publications of provably dead
// incarnation processes are administratively settled in the SAME durable
// commit — ledger record, unknown outcome preserved, only admission blockage
// lifted. Null identities, same-process remounts and live/unknown owners are
// never settled.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager, recoverEditLockManager } from '../src/edit-lock/manager.js'
import { AUTOMATIC_RECOVERY_ACTOR, LATE_WRITER_RISK, digest } from '../src/edit-lock/admin-ledger.js'

const NOW = 1_700_000_000_000
/** @param {number} pid @param {string} [bootNonce] */
const identity = (pid, bootNonce = 'boot-1') => ({ pid, host: 'host-a', osStart: 'start-a', bootNonce })
/** @param {'alive'|'dead'|'unknown'} outcome */
const livenessStub = outcome => ({
  pid: 4242, host: 'host-a',
  identity: async () => ({ osStart: 'start-a', bootNonce: 'boot-self' }),
  state: async () => outcome,
})

/** @param {(dir: string) => Promise<void>} run */
async function withRoot(run) {
  const directory = await mkdtemp(join(tmpdir(), 'weir-auto-recovery-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

/** Manufacture one unknown-phase publication for `sessionId` on `target`
 * through the real prepare/commit path (the publish hook fails after being
 * invoked, exactly like a crashed writer). @param {any} manager @param {any} execution
 * @param {string} operationId @param {string} target @param {number} generation */
async function manufactureUnknown(manager, execution, operationId, target, generation) {
  const request = { operationId, tool: 'write', filePath: target, cwd: '/', args: {}, content: 'late',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
  const ready = await manager.prepare(execution, request, {
    validate() {}, publish: async () => { throw new Error('writer outcome lost') }, identify: () => target,
  })
  await assert.rejects(manager.commit(ready.submission), /writer outcome lost/)
}

/**
 * One crashed incarnation ('incarnation-1', identity(111)) whose sessions own
 * one lock and one unknown publication each, then a recovery open under
 * 'incarnation-2' with the D3 wiring (liveness, root, backup writer).
 * @param {string} directory @param {{owners?: string[], identity?: any, recoveryIdentity?: any, livenessOutcome?: 'alive'|'dead'|'unknown'}} [options]
 */
async function crashAndRecover(directory, { owners = ['alice'], identity: identityOne = identity(111), recoveryIdentity = identity(222, 'boot-2'), livenessOutcome = 'dead' } = {}) {
  let store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const original = createEditLockManager({ store, managerIncarnation: 'incarnation-1', processIdentity: identityOne })
  const targets = new Map()
  for (const owner of owners) {
    const execution = await original.openSession(owner)
    const target = `/w/${owner}.txt`
    const token = await original.acquire(execution, target)
    await manufactureUnknown(original, execution, `unknown-${owner}`, target, token.generation)
    targets.set(owner, target)
  }
  // The crash: no cancel, no close of authority state — just drop the handle.
  await store.close()
  const preImageBytes = await readFile(join(directory, 'snapshot.json'))

  store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  const before = store.snapshot()
  /** @type {{file: string, bytes: Buffer}[]} */
  const backups = []
  /** @type {{records: any[], revision: number}[]} */
  const reports = []
  const recovered = await recoverEditLockManager({
    store, managerIncarnation: 'incarnation-2', processIdentity: recoveryIdentity,
    liveness: livenessStub(livenessOutcome), root: 'd',
    writeBackup: async (file, bytes) => { backups.push({ file, bytes }) },
    now: () => NOW,
    onAutomaticRecovery: info => reports.push(info),
  })
  return { store, recovered, before, preImageBytes, backups, reports, targets }
}

test('a dead incarnation process\'s unknown is settled in the recovery commit: ledger, locks, epoch, admission', () => withRoot(async directory => {
  const { store, recovered, before, preImageBytes, backups, reports, targets } = await crashAndRecover(directory)
  try {
    const state = store.snapshot().state
    // ONE durable commit for recovery plus settlement.
    assert.equal(store.snapshot().revision, before.revision + 1)
    assert.equal(state.version, 6)
    assert.equal(state.adminRecoveries.length, 1)
    const record = state.adminRecoveries[0]
    assert.equal(record.actor, AUTOMATIC_RECOVERY_ACTOR)
    assert.equal(record.owner, 'alice')
    assert.equal(record.expectedRevision, before.revision)
    assert.equal(record.committedRevision, before.revision + 1)
    assert.equal(record.at, NOW)
    assert.deepEqual(record.operations.map(item => item.operationId), ['unknown-alice'])
    assert.equal(record.operations[0].sha256, digest(state.operations.find(o => o.operationId === 'unknown-alice')))
    assert.equal(record.confirmation, digest({ root: 'd', owner: 'alice', expectedRevision: before.revision, operationIds: ['unknown-alice'], risk: LATE_WRITER_RISK }))
    assert.equal(record.revokedEpoch, state.sessions.find(s => s.sessionId === 'alice').executionEpoch)
    assert.equal(state.sessions.find(s => s.sessionId === 'alice').interrupted, true)
    // The owner's locks are released; the unknown outcome and history stay.
    assert.equal(state.locks.some(lock => lock.owner === 'alice'), false)
    assert.equal(record.releasedLocks.length, 1)
    assert.equal(record.releasedLocks[0].resourceId, targets.get('alice'))
    const operation = state.operations.find(o => o.operationId === 'unknown-alice')
    assert.equal(operation.phase, 'unknown')
    assert.equal(operation.outcome.kind, 'unknown')
    // The backup artifact is the exact pre-image and was written before commit.
    assert.equal(backups.length, 1)
    assert.equal(backups[0].file, record.backup.file)
    assert.deepEqual(backups[0].bytes, preImageBytes)
    assert.equal(record.backup.sha256, createHash('sha256').update(preImageBytes).digest('hex'))
    assert.equal(record.backup.bytes, preImageBytes.length)
    // One report for the whole recovery.
    assert.equal(reports.length, 1)
    assert.equal(reports[0].records.length, 1)
    assert.equal(reports[0].revision, before.revision + 1)
    // Only admission blockage is lifted: new work proceeds, history is intact,
    // the revoked owner is terminal.
    const bob = await recovered.openSession('bob')
    await recovered.acquire(bob, targets.get('alice'))
    assert.equal((await recovered.history('alice', 'unknown-alice')).phase, 'unknown')
    assert.equal(recovered.status().sessions.find(s => s.sessionId === 'alice').revoked, true)
    await assert.rejects(recovered.openSession('alice'), /revoked/)
    await recovered.close()
  } finally { await store.close() }
}))

test('multiple dead owners settle in ONE commit with one ledger record each and one report', () => withRoot(async directory => {
  const { store, before, backups, reports } = await crashAndRecover(directory, { owners: ['alice', 'bob'] })
  try {
    const state = store.snapshot().state
    assert.equal(store.snapshot().revision, before.revision + 1)
    assert.equal(state.adminRecoveries.length, 2)
    assert.deepEqual(state.adminRecoveries.map(row => row.owner).sort(), ['alice', 'bob'])
    for (const row of state.adminRecoveries) {
      assert.equal(row.expectedRevision, before.revision)
      assert.equal(row.committedRevision, before.revision + 1)
      assert.equal(row.actor, AUTOMATIC_RECOVERY_ACTOR)
    }
    assert.equal(state.locks.length, 0)
    assert.equal(backups.length, 2)
    assert.notEqual(backups[0].file, backups[1].file)
    assert.deepEqual(backups[0].bytes, backups[1].bytes)
    assert.equal(reports.length, 1)
    assert.equal(reports[0].records.length, 2)
    await store.close()
    // The batch ledger validates on the next recover (byte-level discipline).
    const reopened = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
    assert.equal(reopened.snapshot().state.adminRecoveries.length, 2)
    await reopened.close()
  } finally { await store.close() }
}))

test('a second recovery never re-settles: revoked owners are terminal', () => withRoot(async directory => {
  const first = await crashAndRecover(directory)
  await first.recovered.close()
  await first.store.close()
  const reports = []
  const backups = []
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  try {
    const before = store.snapshot()
    const recovered = await recoverEditLockManager({
      store, managerIncarnation: 'incarnation-3', processIdentity: identity(333, 'boot-3'),
      liveness: livenessStub('dead'), root: 'd',
      writeBackup: async (file, bytes) => { backups.push({ file, bytes }) },
      onAutomaticRecovery: info => reports.push(info),
    })
    assert.equal(store.snapshot().revision, before.revision + 1)
    assert.equal(store.snapshot().state.adminRecoveries.length, 1)
    assert.equal(reports.length, 0)
    assert.equal(backups.length, 0)
    await recovered.close()
  } finally { await store.close() }
}))

test('a live or indeterminate incarnation process is never settled', () => withRoot(async directory => {
  for (const outcome of ['alive', 'unknown']) {
    const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
    const original = createEditLockManager({ store, managerIncarnation: 'incarnation-1', processIdentity: identity(111) })
    const execution = await original.openSession('alice')
    const token = await original.acquire(execution, '/w/alice.txt')
    await manufactureUnknown(original, execution, 'unknown-alice', '/w/alice.txt', token.generation)
    await store.close()
    const reports = []
    const recoveredStore = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
    const recovered = await recoverEditLockManager({
      store: recoveredStore, managerIncarnation: 'incarnation-2', processIdentity: identity(222, 'boot-2'),
      liveness: livenessStub(outcome), root: 'd',
      writeBackup: async () => { throw new Error('no backup may be written') },
      onAutomaticRecovery: info => reports.push(info),
    })
    try {
      const state = recoveredStore.snapshot().state
      assert.equal(state.adminRecoveries.length, 0)
      assert.equal(reports.length, 0)
      assert.equal(state.locks.some(lock => lock.owner === 'alice'), true)
      const bob = await recovered.openSession('bob')
      await assert.rejects(recovered.acquire(bob, '/w/alice.txt'), /unresolved publication fence/)
      await recovered.close()
    } finally { await recoveredStore.close() }
    // Reset the fixture for the second outcome.
    await rm(join(directory, 'snapshot.json'), { force: true })
  }
}))

test('a same-process remount incarnation is never settled, even when the probe would call it dead', () => withRoot(async directory => {
  const shared = identity(111)
  const { store, recovered, before, reports, backups } = await crashAndRecover(directory, { identity: shared, recoveryIdentity: shared })
  try {
    // Recover under the SAME process identity (plugin remount in one process).
    const state = store.snapshot().state
    assert.equal(state.adminRecoveries.length, 0)
    assert.equal(reports.length, 0)
    assert.equal(backups.length, 0)
    const bob = await recovered.openSession('bob')
    await assert.rejects(recovered.acquire(bob, '/w/alice.txt'), /unresolved publication fence/)
    await recovered.close()
  } finally { await store.close() }
}))

test('null identities are never settled: pre-registry history waits for the explicit paths', () => withRoot(async directory => {
  // Manufacture the unknown with an identity-LESS manager: the image stays v4.
  let store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const original = createEditLockManager({ store, managerIncarnation: 'incarnation-1' })
  const execution = await original.openSession('alice')
  const token = await original.acquire(execution, '/w/alice.txt')
  await manufactureUnknown(original, execution, 'unknown-alice', '/w/alice.txt', token.generation)
  await store.close()
  store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  const reports = []
  const recovered = await recoverEditLockManager({
    store, managerIncarnation: 'incarnation-2', processIdentity: identity(222, 'boot-2'),
    liveness: livenessStub('dead'), root: 'd',
    writeBackup: async () => { throw new Error('no backup may be written') },
    onAutomaticRecovery: info => reports.push(info),
  })
  try {
    const state = store.snapshot().state
    // The recovery still registers the new incarnation (v6) — but the seeded
    // null identity of incarnation-1 keeps the unknown manual.
    assert.equal(state.version, 6)
    assert.deepEqual(state.incarnations[0], { incarnation: 'incarnation-1', process: null })
    assert.equal(state.adminRecoveries.length, 0)
    assert.equal(reports.length, 0)
    const bob = await recovered.openSession('bob')
    await assert.rejects(recovered.acquire(bob, '/w/alice.txt'), /unresolved publication fence/)
    await recovered.close()
  } finally { await store.close() }
}))

test('an owner with a mixed-incarnation scope is never partially settled', () => withRoot(async directory => {
  // unknown-1: incarnation-1 WITH identity (provably dead at recovery).
  let store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const first = createEditLockManager({ store, managerIncarnation: 'incarnation-1', processIdentity: identity(111) })
  const execution1 = await first.openSession('alice')
  const token1 = await first.acquire(execution1, '/w/a.txt')
  await manufactureUnknown(first, execution1, 'unknown-1', '/w/a.txt', token1.generation)
  await store.close()
  // unknown-2: crafted through raw store transitions (the manager.test.js
  // pattern) under an identity-less incarnation-2 — a live flow cannot reach a
  // mixed scope because unknown-1's fence blocks re-arming the owner.
  store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  await recoverEditLockManager({ store, managerIncarnation: 'incarnation-2' })
  const digest64 = 'b'.repeat(64)
  const state = store.snapshot().state
  const prepared = {
    sessionId: 'alice', operationId: 'unknown-2', origin: { executionEpoch: 2, managerIncarnation: 'incarnation-2' },
    binding: { tool: 'write', filePath: '/w/b.txt', cwd: '/w', requestDigest: digest64, argsDigest: digest64, payloadDigest: digest64,
      target: { kind: 'create', ancestor: '/w', suffix: 'b.txt', policy: { kind: 'createIfAbsent' } } },
    phase: 'prepared', fence: null, outcome: null, closeouts: [],
  }
  state.operations = [...state.operations, prepared]
  await store.record({ expectedRevision: store.snapshot().revision, nextState: state })
  state.operations = state.operations.map(o => o.operationId === 'unknown-2'
    ? { ...o, phase: 'publishing', fence: { kind: 'subtree', ancestor: '/w', basis: 'observed-ancestor' } } : o)
  await store.record({ expectedRevision: store.snapshot().revision, nextState: state })
  await store.close()
  // Recover with full D3 wiring and a dead proof for incarnation-1: the owner
  // scope mixes a dead-identified and a null-identity incarnation, so nothing
  // settles.
  store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  const reports = []
  const recovered = await recoverEditLockManager({
    store, managerIncarnation: 'incarnation-3', processIdentity: identity(333, 'boot-3'),
    liveness: livenessStub('dead'), root: 'd',
    writeBackup: async () => { throw new Error('no backup may be written') },
    onAutomaticRecovery: info => reports.push(info),
  })
  try {
    const final = store.snapshot().state
    assert.equal(final.adminRecoveries.length, 0)
    assert.equal(reports.length, 0)
    assert.equal(final.operations.filter(o => o.sessionId === 'alice' && o.phase === 'unknown').length, 2)
    assert.equal(final.locks.some(lock => lock.owner === 'alice'), true)
    await recovered.close()
  } finally { await store.close() }
}))

