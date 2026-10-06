import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager, recoverEditLockManager } from '../src/edit-lock/manager.js'
import { recoverAuthority, recoveryConfirmation } from '../src/edit-lock/admin-recovery.js'
import { canonical } from '../src/edit-lock/snapshot.js'
import { expectedRegistry, isRegistryUpgrade, withIncarnation } from '../src/edit-lock/incarnations.js'

// Regression for the P1 review finding on the v4/v5 → v6 migration: a valid
// legacy image whose CURRENT manager incarnation differs from the OLDEST
// retained operation origin failed recovery with "version transition
// requires explicit override", because withIncarnation seeded the registry
// from the candidate (new manager incarnation already installed, previous
// one appended last) while expectedRegistry derives the seed from the
// UNCHANGED pre-image (previous current manager FIRST, then operation
// origins in encounter order). The development checkout's own authority is
// exactly this shape: a v5 image whose current manager is a later
// incarnation than the ones its retained operations originate from.

/** @param {number} pid @param {string} [bootNonce] */
const identity = (pid, bootNonce = 'boot-1') => ({ pid, host: 'host-a', osStart: 'start-a', bootNonce })

/** @param {(root: string) => Promise<void>} run */
async function withRoot(prefix, run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

/** A legacy v4 image built exclusively through the pre-registry write paths
 * (identity-less managers): manager-a leaves a retained unknown publication,
 * manager-b (the CURRENT manager) adds its own completed operation. The
 * retained operation origins start with an incarnation that is NOT the
 * current manager. @param {string} root */
async function legacyV4(root) {
  const directory = join(root, '.orrery/edit-lock')
  await mkdir(directory, { recursive: true })
  const target = join(root, 'held.txt')
  const other = join(root, 'other.txt')
  await writeFile(target, 'original')
  await writeFile(other, 'before')
  let store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  let manager = createEditLockManager({ store, managerIncarnation: 'manager-a' })
  const alice = await manager.openSession('alice')
  const token = await manager.acquire(alice, target)
  const ready = await manager.prepare(alice, {
    operationId: 'op-unknown', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
  }, { validate() {}, publish: async () => { throw new Error('unknown writer outcome') }, identify: () => target })
  await assert.rejects(manager.commit(ready.submission), /unknown writer outcome/)
  await manager.cancel(alice)
  await manager.close()
  await store.close()

  // manager-b takes over WITHOUT a process identity (old build behavior):
  // the image stays v4 and its current manager is no longer its oldest origin.
  store = await openEditLockStore({ directory, domainId: root, mode: 'recover' })
  manager = await recoverEditLockManager({ store, managerIncarnation: 'manager-b' })
  const bob = await manager.openSession('bob')
  const bobToken = await manager.acquire(bob, other)
  const committed = await manager.prepare(bob, {
    operationId: 'op-bob', tool: 'write', filePath: other, cwd: root, args: {}, content: 'after',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: other, generation: bobToken.generation, policy: { kind: 'replaceIfVersion', version: 'v0' } },
  }, { validate() {}, publish: async () => { await writeFile(other, 'after'); return { version: 'new' } }, identify: () => other })
  await manager.commit(committed.submission)
  await manager.close()
  await store.close()
  return directory
}

/** The v5 fixture: the v4 legacy image plus one offline ADMIN OVERRIDE, so
 * the image carries a non-empty administrative ledger — the same shape as
 * the development checkout's own authority (v5, ledger present, current
 * manager younger than retained operation origins). @param {string} root */
async function legacyV5(root) {
  const directory = await legacyV4(root)
  const store = await openEditLockStore({ directory, domainId: root, mode: 'recover' })
  const before = store.snapshot()
  await store.close()
  const input = { root, recoveryId: 'admin-fixture-1', expectedRevision: before.revision, owner: 'alice',
    operationIds: ['op-unknown'], reason: 'Fixture operator accepts residual late writer risk', acceptLateWriterRisk: true }
  await recoverAuthority({ ...input, confirmation: recoveryConfirmation(input) })
  return directory
}

test('the migration seed keeps the pre-image order: previous manager first, then operation origins', () => {
  const before = {
    version: 4, managerIncarnation: 'manager-b',
    operations: [
      { origin: { executionEpoch: 1, managerIncarnation: 'manager-a' } },
      { origin: { executionEpoch: 1, managerIncarnation: 'manager-b' } },
      { origin: { executionEpoch: 2, managerIncarnation: 'manager-a' } },
    ],
  }
  // The recovery candidate already carries the NEW manager incarnation.
  const candidate = { ...before, managerIncarnation: 'manager-c' }
  const upgraded = withIncarnation(candidate, 'manager-c', identity(7), 'manager-b')
  assert.deepEqual(upgraded.incarnations, [
    { incarnation: 'manager-b', process: null },
    { incarnation: 'manager-a', process: null },
    { incarnation: 'manager-c', process: identity(7) },
  ])
  // Byte-identical to the validator's expectation for this transition.
  assert.equal(canonical(upgraded.incarnations), canonical(expectedRegistry(before, upgraded)))
  assert.equal(isRegistryUpgrade(before, upgraded), true)
})

test('v4 fixture: current manager younger than the oldest operation origin migrates to v6 on identity-aware recovery', () => withRoot('orrery-migration-v4-', async root => {
  const directory = await legacyV4(root)
  const store = await openEditLockStore({ directory, domainId: root, mode: 'recover' })
  try {
    const before = store.snapshot()
    assert.equal(before.state.version, 4)
    assert.equal(before.state.managerIncarnation, 'manager-b')
    assert.deepEqual([...new Set(before.state.operations.map(op => op.origin.managerIncarnation))], ['manager-a', 'manager-b'])

    const manager = await recoverEditLockManager({ store, managerIncarnation: 'manager-c', processIdentity: identity(4242) })
    const after = store.snapshot()
    assert.equal(after.revision, before.revision + 1)
    assert.equal(after.state.version, 6)
    // The seed derives from the UNCHANGED pre-image in the validator's
    // order: the previous current manager first, then operation origins.
    assert.deepEqual(after.state.incarnations, [
      { incarnation: 'manager-b', process: null },
      { incarnation: 'manager-a', process: null },
      { incarnation: 'manager-c', process: identity(4242) },
    ])
    assert.equal(canonical(after.state.incarnations), canonical(expectedRegistry(before.state, after.state)))
    // Lossless: unknown and completed history ride through unchanged.
    assert.deepEqual(after.state.operations, before.state.operations)
    await manager.close()
  } finally { await store.close() }
}))

test('v5 fixture (admin ledger, current manager younger than the oldest operation origin) migrates to v6 on identity-aware recovery', () => withRoot('orrery-migration-v5-', async root => {
  const directory = await legacyV5(root)
  const store = await openEditLockStore({ directory, domainId: root, mode: 'recover' })
  try {
    const before = store.snapshot()
    assert.equal(before.state.version, 5)
    assert.equal(before.state.managerIncarnation, 'manager-b')
    assert.equal(before.state.adminRecoveries.length, 1)
    assert.deepEqual([...new Set(before.state.operations.map(op => op.origin.managerIncarnation))], ['manager-a', 'manager-b'])

    const manager = await recoverEditLockManager({ store, managerIncarnation: 'manager-c', processIdentity: identity(4242) })
    const after = store.snapshot()
    assert.equal(after.revision, before.revision + 1)
    assert.equal(after.state.version, 6)
    assert.deepEqual(after.state.incarnations, [
      { incarnation: 'manager-b', process: null },
      { incarnation: 'manager-a', process: null },
      { incarnation: 'manager-c', process: identity(4242) },
    ])
    assert.equal(canonical(after.state.incarnations), canonical(expectedRegistry(before.state, after.state)))
    // The administrative ledger is carried over byte-identically; history is
    // unchanged (the settled unknown stays unknown with its disposition).
    assert.deepEqual(after.state.adminRecoveries, before.state.adminRecoveries)
    assert.deepEqual(after.state.operations, before.state.operations)
    await manager.close()
  } finally { await store.close() }
}))
