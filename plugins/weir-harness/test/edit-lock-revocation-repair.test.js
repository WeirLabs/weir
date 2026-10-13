// Epoch-scoped revocation (change edit-lock-revoked-session-repair, D1-D3):
// a disposition revokes its owner exactly at revokedEpoch; a trusted resume
// advances the epoch past it and ends the revoked state atomically, without a
// ledger change. The append-only ledger admits re-revocation with strictly
// increasing revokedEpoch; row-level invariants bind only still-revoked
// owners; a record's unresolved scope is bounded by its revokedEpoch and
// excludes operations earlier rows of the same owner already cover.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager, recoverEditLockManager } from '../src/edit-lock/manager.js'
import { recoverAuthority, recoveryConfirmation } from '../src/edit-lock/admin-recovery.js'
import { revokedOwner } from '../src/edit-lock/admin-ledger.js'
import { validateImage } from '../src/edit-lock/snapshot.js'

const roots = []
test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

test('revokedOwner is epoch-scoped: within the revokedEpoch true, past it false, unknown session false', () => {
  const row = { owner: 's', revokedEpoch: 3 }
  const state = { adminRecoveries: [row], sessions: [{ sessionId: 's', executionEpoch: 3, interrupted: true }] }
  assert.equal(revokedOwner(state, 's'), true)
  assert.equal(revokedOwner({ ...state, sessions: [{ sessionId: 's', executionEpoch: 2, interrupted: true }] }, 's'), true)
  // A trusted resume advanced the epoch past the disposition: not revoked.
  assert.equal(revokedOwner({ ...state, sessions: [{ sessionId: 's', executionEpoch: 4, interrupted: false }] }, 's'), false)
  assert.equal(revokedOwner(state, 'other'), false)
  assert.equal(revokedOwner({ adminRecoveries: [row], sessions: [] }, 's'), false)
  assert.equal(revokedOwner({ sessions: [{ sessionId: 's', executionEpoch: 1 }] }, 's'), false)
})

/** Build an online-recovery-capable manager over a fresh authority with the
 * given owner sessions open. */
async function revokedFixture({ owners = ['owner'], processIdentity = null } = {}) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-revocation-repair-')))
  roots.push(root)
  const directory = join(root, 'authority')
  await mkdir(directory, { recursive: true })
  const target = join(root, 'a.txt')
  await writeFile(target, 'original')
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  const writeBackup = async (file, bytes) => writeFile(join(directory, file), bytes)
  const manager = createEditLockManager({ store, managerIncarnation: 'm', root, writeBackup, processIdentity })
  const executions = new Map()
  for (const owner of owners) executions.set(owner, await manager.openSession(owner))
  return { root, directory, target, store, manager, executions }
}

async function manufactureUnknown(f, execution, operationId, target) {
  const token = await f.manager.acquire(execution, target)
  const request = { operationId, tool: 'write', filePath: target, cwd: f.root, args: {}, content: 'late',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
  const ready = await f.manager.prepare(execution, request, {
    validate() {}, publish: async () => { throw new Error('writer outcome lost') }, identify: () => target,
  })
  await assert.rejects(f.manager.commit(ready.submission), /writer outcome lost/)
  return token
}

function onlineRecoveryInput(f, owner, operationIds, recoveryId) {
  const input = { owner, expectedRevision: f.store.snapshot().revision, operationIds,
    recoveryId, reason: 'Operator accepts residual late writer risk', acceptLateWriterRisk: true }
  input.confirmation = recoveryConfirmation({ root: f.root, ...input })
  return input
}

test('revoke → repair → new activity → re-revoke: two rows, strictly increasing epochs, image validates', async () => {
  const f = await revokedFixture()
  try {
    const owner = f.executions.get('owner')
    await manufactureUnknown(f, owner, 'op-1', f.target)
    await f.manager.cancel(owner)
    const first = await f.manager.adminRecoverOnline(onlineRecoveryInput(f, 'owner', ['op-1'], 'recovery-1'))
    const firstEpoch = first.record.revokedEpoch
    assert.equal(f.manager.status().sessions.find(s => s.sessionId === 'owner').revoked, true)

    // A still-revoked owner cannot be revoked again.
    await assert.rejects(f.manager.adminRecoverOnline(onlineRecoveryInput(f, 'owner', ['op-1'], 'recovery-duplicate')), /owner already revoked/)

    // Repair: receipt + resume at the current epoch; no ledger change.
    const repair = { managerIncarnation: 'm', sessionId: 'owner', executionEpoch: firstEpoch }
    const receipt = await f.manager.issueExecutionReceipt(repair, 'repair-1')
    const repaired = await f.manager.resume(repair, 'repair-1', receipt)
    assert.equal(repaired.executionEpoch, firstEpoch + 1)
    assert.equal(f.manager.status().sessions.find(s => s.sessionId === 'owner').revoked, false)
    assert.equal(f.store.snapshot().state.adminRecoveries.length, 1)

    // The repaired owner works: a new lock and a new (unknown) operation.
    await manufactureUnknown(f, repaired, 'op-2', join(f.root, 'b.txt'))
    await f.manager.cancel(repaired)

    // The earlier disposition covers op-1: the operator confirms ONLY op-2.
    const namedBoth = onlineRecoveryInput(f, 'owner', ['op-1', 'op-2'], 'recovery-2')
    await assert.rejects(f.manager.adminRecoverOnline(namedBoth), /every unresolved operation/)
    const preSecondEpoch = f.manager.status().sessions.find(s => s.sessionId === 'owner').executionEpoch
    const second = await f.manager.adminRecoverOnline(onlineRecoveryInput(f, 'owner', ['op-2'], 'recovery-2'))
    assert.equal(second.record.revokedEpoch, preSecondEpoch + 1)
    assert.ok(second.record.revokedEpoch > firstEpoch)
    assert.deepEqual(second.record.operations.map(item => item.operationId), ['op-2'])

    const image = f.store.snapshot().state
    assert.equal(image.adminRecoveries.length, 2)
    validateImage(image) // two rows for one owner, strictly increasing: valid
    assert.equal(f.manager.status().sessions.find(s => s.sessionId === 'owner').revoked, true)
  } finally { await f.manager.close(); await f.store.close() }
})

test('row-level invariants still bind a still-revoked owner; repaired-owner tampering is what they now ignore', async () => {
  const f = await revokedFixture()
  try {
    const owner = f.executions.get('owner')
    await manufactureUnknown(f, owner, 'op-1', f.target)
    await f.manager.cancel(owner)
    await f.manager.adminRecoverOnline(onlineRecoveryInput(f, 'owner', ['op-1'], 'recovery-1'))
    const revoked = f.store.snapshot()

    // Still revoked: un-interrupting or re-locking the owner stays invalid.
    const uninterrupt = structuredClone(revoked.state)
    uninterrupt.sessions.find(s => s.sessionId === 'owner').interrupted = false
    assert.throws(() => validateImage(uninterrupt), /revoked owner/)
    const relock = structuredClone(revoked.state)
    const tombstone = relock.generations.find(g => g.resourceId === f.target).generation
    relock.locks.push({ resourceId: f.target, owner: 'owner', generation: tombstone, status: 'user-interrupted' })
    assert.throws(() => validateImage(relock), /revoked owner/)
    // The revokedEpoch regression and duplication stay invalid.
    const regressed = structuredClone(revoked.state)
    regressed.sessions.find(s => s.sessionId === 'owner').executionEpoch -= 1
    assert.throws(() => validateImage(regressed), /revoked owner epoch/)
    const duplicated = structuredClone(revoked.state)
    duplicated.adminRecoveries.push({ ...structuredClone(revoked.state.adminRecoveries[0]), recoveryId: 'recovery-2' })
    assert.throws(() => validateImage(duplicated), /revocation epoch progression/)

    // After a repair the same row no longer requires an interrupted,
    // lock-free owner: the image with the owner active and holding a lock is
    // exactly what the resume + acquire commit produces, and it validates.
    const repair = { managerIncarnation: 'm', sessionId: 'owner', executionEpoch: revoked.state.adminRecoveries[0].revokedEpoch }
    const receipt = await f.manager.issueExecutionReceipt(repair, 'repair-1')
    const repaired = await f.manager.resume(repair, 'repair-1', receipt)
    await f.manager.acquire(repaired, join(f.root, 'c.txt'))
    validateImage(f.store.snapshot().state)
    const session = f.store.snapshot().state.sessions.find(s => s.sessionId === 'owner')
    assert.equal(session.interrupted, false)
    assert.equal(f.store.snapshot().state.locks.some(lock => lock.owner === 'owner'), true)
  } finally { await f.manager.close(); await f.store.close() }
})
test('automatic settlement after a repair binds only the new unknowns (second row, new epoch)', async () => {
  // Every operation originates in incarnation 'm' with a recorded, provably
  // dead process identity: both the pre-revocation and the post-repair unknowns
  // are eligible, but the already-disposed one is never re-bound.
  const identityOne = { pid: 4242, host: 'host-a', osStart: 'start-a', bootNonce: 'boot-1' }
  const f = await revokedFixture({ processIdentity: identityOne })
  const NOW = 1_700_000_000_000
  const owner = f.executions.get('owner')
  await manufactureUnknown(f, owner, 'op-1', f.target)
  await f.manager.cancel(owner)
  const first = await f.manager.adminRecoverOnline(onlineRecoveryInput(f, 'owner', ['op-1'], 'recovery-1'))
  // Repair through the trusted path, then a new unknown in the new epoch.
  const repair = { managerIncarnation: 'm', sessionId: 'owner', executionEpoch: first.record.revokedEpoch }
  const receipt = await f.manager.issueExecutionReceipt(repair, 'repair-1')
  const repaired = await f.manager.resume(repair, 'repair-1', receipt)
  await manufactureUnknown(f, repaired, 'op-2', join(f.root, 'b.txt'))
  // The crash: no cancel, no close of authority state — just drop the handle.
  await f.store.close()

  const store = await openEditLockStore({ directory: f.directory, domainId: f.root, mode: 'recover' })
  try {
    const reports = []
    const backups = []
    const liveness = { pid: 9999, host: 'host-a', identity: async () => ({ osStart: 'start-c', bootNonce: 'boot-2' }), state: async () => 'dead' }
    const recovered = await recoverEditLockManager({ store, managerIncarnation: 'm2',
      processIdentity: { pid: 9999, host: 'host-a', osStart: 'start-c', bootNonce: 'boot-2' },
      liveness, root: f.root, writeBackup: async (file, bytes) => { backups.push({ file, bytes }) },
      now: () => NOW, onAutomaticRecovery: info => reports.push(info) })
    // The repaired owner is NOT skipped as revoked (its epoch advanced past the
    // first row), and its already-disposed op-1 is skipped: the second row
    // binds exactly op-2.
    assert.equal(reports.length, 1)
    assert.equal(reports[0].records.length, 1)
    const row = reports[0].records[0]
    assert.equal(row.owner, 'owner')
    assert.deepEqual(row.operations.map(item => item.operationId), ['op-2'])
    const image = store.snapshot().state
    assert.equal(image.adminRecoveries.length, 2)
    assert.ok(image.adminRecoveries[1].revokedEpoch > image.adminRecoveries[0].revokedEpoch)
    assert.equal(image.locks.some(lock => lock.owner === 'owner'), false)
    validateImage(image)
    assert.equal(recovered.status().sessions.find(s => s.sessionId === 'owner').revoked, true)
    await recovered.close()
  } finally { await store.close() }
})
