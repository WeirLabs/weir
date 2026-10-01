import { it } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'

it('persists ownership, rejects competitors without poisoning, and refuses historical reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    const alice = await manager.openSession('alice')
    const bob = await manager.openSession('bob')
    const token = await manager.acquire(alice, 'file:canonical')
    assert.equal(token.generation, 1)
    assert.equal(store.snapshot().state.locks[0].owner, 'alice')
    const revision = store.snapshot().revision
    await assert.rejects(manager.acquire(bob, 'file:canonical'), /owned/)
    assert.equal(store.snapshot().revision, revision)
    assert.equal((await manager.acquire(bob, 'file:other')).generation, 1)
    assert.throws(() => createEditLockManager({ store, managerIncarnation: 'manager-2' }), /fresh store/)
    await manager.cancel(alice)
    const status = manager.status()
    assert.equal(status.sessions.find(s => s.sessionId === 'bob').interrupted, false)
    assert.equal(status.locks.find(l => l.owner === 'bob').status, 'active')
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it('captures cancellation credentials before the caller can mutate them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    const execution = await manager.openSession('alice')
    const pending = manager.cancel(execution)
    execution.sessionId = 'mallory'
    execution.executionEpoch = 99
    assert.equal((await pending).sessionId, 'alice')
    assert.equal(manager.status().sessions[0].interrupted, true)
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it('denies a pending acquisition when cancellation arrives during its durable acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  let barrier
  const gate = Promise.withResolvers()
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' }, {
    checkpoint: point => point === 'before:directory-sync' ? barrier?.() : undefined,
  })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    const execution = await manager.openSession('alice')
    const entered = Promise.withResolvers()
    barrier = () => { entered.resolve(); return gate.promise }
    const acquiring = manager.acquire(execution, 'file:canonical')
    const rejected = assert.rejects(acquiring, /cancelled/)
    await entered.promise
    const cancellation = manager.cancel(execution)
    assert.equal(manager.cancel(execution), cancellation)
    gate.resolve()
    await rejected
    await cancellation
    const retained = manager.status().locks[0]
    assert.equal(retained.owner, 'alice')
    assert.equal(retained.status, 'user-interrupted')
    assert.equal(store.snapshot().state.locks[0].status, 'user-interrupted')
    await assert.rejects(manager.acquire(execution, 'file:other'), /epoch|interrupted/)
  } finally {
    gate.resolve()
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it('exposes session authority only after the real store acknowledges persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  let barrier
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' }, {
    checkpoint: point => point === 'before:directory-sync' ? barrier?.() : undefined,
  })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    const entered = Promise.withResolvers()
    const gate = Promise.withResolvers()
    barrier = () => { entered.resolve(); return gate.promise }
    const opening = manager.openSession('alice')
    await entered.promise
    assert.deepEqual(manager.status().sessions, [])
    gate.resolve()
    const execution = await opening
    assert.deepEqual(execution, { managerIncarnation: 'manager-1', sessionId: 'alice', executionEpoch: 1 })
    assert.equal(manager.status().sessions[0].sessionId, 'alice')
    assert.equal(store.snapshot().state.sessions[0].sessionId, 'alice')
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})


it('disarms cancellation synchronously before its durable acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  let barrier
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' }, {
    checkpoint: point => point === 'before:directory-sync' ? barrier?.() : undefined,
  })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    const execution = await manager.openSession('alice')
    const gate = Promise.withResolvers()
    const entered = Promise.withResolvers()
    barrier = () => { entered.resolve(); return gate.promise }
    const cancellation = manager.cancel(execution)
    assert.equal(manager.status().sessions[0].interrupted, true)
    await entered.promise
    assert.equal(store.snapshot().state.sessions[0].interrupted, false)
    gate.resolve()
    const stopped = await cancellation
    assert.equal(stopped.executionEpoch, 2)
    assert.equal(store.snapshot().state.sessions[0].interrupted, true)
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})


it('poisons manager admission after an uncertain persistence failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  let fail = false
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' }, {
    checkpoint(point) {
      if (fail && point === 'before:directory-sync') throw new Error('disk failure')
    },
  })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    fail = true
    const first = manager.openSession('alice')
    const queued = manager.openSession('bob')
    await assert.rejects(first, /poisoned/)
    await assert.rejects(queued, /poisoned/)
    assert.throws(() => manager.status(), /poisoned/)
    await assert.rejects(manager.openSession('charlie'), /poisoned/)
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})
