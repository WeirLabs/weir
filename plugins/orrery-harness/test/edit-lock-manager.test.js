import { it } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'

it('settles historical prepared work and fences unresolved publication without replay', async () => {
  const { recoverEditLockManager } = await import('../src/edit-lock/manager.js')
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const original = createEditLockManager({ store, managerIncarnation: 'old' })
    await original.openSession('alice')
    const state = store.snapshot().state
    const digest = 'a'.repeat(64)
    const prepared = {
      sessionId: 'alice', operationId: 'prepared', origin: { executionEpoch: 1, managerIncarnation: 'old' },
      binding: { tool: 'write', filePath: 'new.txt', cwd: '/workspace', requestDigest: digest, argsDigest: digest, payloadDigest: digest,
        target: { kind: 'create', ancestor: '/workspace', suffix: 'new.txt', policy: { kind: 'createIfAbsent' } } },
      phase: 'prepared', fence: null, outcome: null, closeouts: [],
    }
    state.operations = [prepared, { ...structuredClone(prepared), operationId: 'publishing' }]
    await store.record({ expectedRevision: store.snapshot().revision, nextState: state })
    state.operations[1].phase = 'publishing'
    state.operations[1].fence = { kind: 'domain', basis: 'containment-unproved' }
    await store.record({ expectedRevision: store.snapshot().revision, nextState: state })
    const recovered = await recoverEditLockManager({ store, managerIncarnation: 'new' })
    const history = store.snapshot().state.operations
    assert.equal(history[0].phase, 'not-published')
    assert.equal(history[0].outcome.reason, 'rejected-before-dispatch')
    assert.equal(history[1].phase, 'unknown')
    assert.deepEqual(history[1].fence, state.operations[1].fence)
    await assert.rejects(recovered.openSession('bob'), /fence/)
    assert.equal(recovered.status().sessions[0].interrupted, true)
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not expose a recovered manager before persistence and rejects uncertain recovery IO', async () => {
  const { recoverEditLockManager } = await import('../src/edit-lock/manager.js')
  for (const fail of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
    const gate = Promise.withResolvers()
    const entered = Promise.withResolvers()
    let barrier
    const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' }, {
      checkpoint: point => point === 'before:directory-sync' ? barrier?.() : undefined,
    })
    try {
      const original = createEditLockManager({ store, managerIncarnation: 'old' })
      await original.openSession('alice')
      // No original manager calls after handing this exclusively owned store over.
      barrier = async () => { entered.resolve(); await gate.promise; if (fail) throw new Error('recovery IO fault') }
      let delivered = false
      const recovering = recoverEditLockManager({ store, managerIncarnation: 'new' }).then(manager => {
        delivered = true
        return manager
      })
      const rejected = fail ? assert.rejects(recovering, error => {
        assert.match(error.message, /persistence failed; handle poisoned/)
        assert.equal(error.cause.message, 'recovery IO fault')
        return true
      }) : undefined
      await entered.promise
      assert.equal(delivered, false)
      gate.resolve()
      if (fail) {
        await rejected
        assert.equal(delivered, false)
      } else {
        const recovered = await recovering
        assert.equal(recovered.status().sessions[0].interrupted, true)
        assert.equal(store.snapshot().state.managerIncarnation, 'new')
      }
    } finally {
      gate.resolve()
      await store.close()
      // directory is the exact absolute mkdtemp result created by this test.
      await rm(directory, { recursive: true, force: true })
    }
  }
})

it('durably disarms historical ownership before returning a recovered manager', async () => {
  const { recoverEditLockManager } = await import('../src/edit-lock/manager.js')
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  let store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const original = createEditLockManager({ store, managerIncarnation: 'old' })
    const execution = await original.openSession('alice')
    await original.acquire(execution, 'file')
    await store.close()
    store = await openEditLockStore({ directory, domainId: 'test', mode: 'recover' })
    const recovered = await recoverEditLockManager({ store, managerIncarnation: 'new' })
    assert.equal(store.snapshot().state.managerIncarnation, 'new')
    assert.equal(recovered.status().sessions[0].interrupted, true)
    assert.equal(recovered.status().locks[0].status, 'user-interrupted')
    await assert.rejects(recovered.acquire(execution, 'file'), /incarnation/)
    await assert.rejects(recovered.openSession('alice'), /registered/)
    const stopped = { ...execution, managerIncarnation: 'new', executionEpoch: 2 }
    const receipt = await recovered.issueExecutionReceipt(stopped, 'new-intent')
    const resumed = await recovered.resume(stopped, 'new-intent', receipt)
    assert.equal(recovered.status().locks[0].status, 'pending-confirmation')
    assert.equal((await recovered.acquire(resumed, 'file')).generation, 1)
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it('withholds a receipt cancelled during its durable issuance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  let barrier
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' }, {
    checkpoint: point => point === 'before:directory-sync' ? barrier?.() : undefined,
  })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    const initial = await manager.openSession('alice')
    barrier = () => { entered.resolve(); return gate.promise }
    const issuing = manager.issueExecutionReceipt(initial, 'continue')
    const rejected = assert.rejects(issuing, /cancelled/)
    await entered.promise
    const cancellation = manager.cancelSession('alice')
    gate.resolve()
    await rejected
    const stopped = await cancellation
    assert.equal(stopped.executionEpoch, 2)
    await assert.rejects(manager.issueExecutionReceipt(stopped, 'continue'), /already issued/)
  } finally {
    gate.resolve()
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it('cancels a pending resume using its installed epoch rather than stale credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  let barrier
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' }, {
    checkpoint: point => point === 'before:directory-sync' ? barrier?.() : undefined,
  })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    const initial = await manager.openSession('alice')
    const stopped = await manager.cancel(initial)
    const receipt = await manager.issueExecutionReceipt(stopped, 'continue')
    barrier = () => { entered.resolve(); return gate.promise }
    const resuming = manager.resume(stopped, 'continue', receipt)
    const rejected = assert.rejects(resuming, /cancelled/)
    await entered.promise
    assert.equal(manager.status().sessions[0].interrupted, true)
    const cancellation = manager.cancel(stopped)
    gate.resolve()
    await rejected
    assert.equal((await cancellation).executionEpoch, 4)
    assert.equal(store.snapshot().state.sessions[0].interrupted, true)
  } finally {
    gate.resolve()
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it('persists one-use execution intent and resumes without rearming retained locks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    const initial = await manager.openSession('alice')
    await manager.acquire(initial, 'file:canonical')
    const stopped = await manager.cancel(initial)
    const receipt = await manager.issueExecutionReceipt(stopped, 'human-continue-1')
    assert.deepEqual(store.snapshot().state.issuedRequests, [{ sessionId: 'alice', requestId: 'human-continue-1' }])
    await assert.rejects(manager.resume(stopped, 'human-continue-1', {}), /receipt/)
    const resumed = await manager.resume(stopped, 'human-continue-1', receipt)
    assert.equal(resumed.executionEpoch, 3)
    assert.equal(store.snapshot().state.sessions[0].interrupted, false)
    assert.equal(manager.status().locks[0].status, 'pending-confirmation')
    await assert.rejects(manager.resume(resumed, 'human-continue-1', receipt), /receipt/)
    await assert.rejects(manager.issueExecutionReceipt(resumed, 'human-continue-1'), /already issued/)
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not install initial authority after an unresolved early cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    await assert.rejects(manager.cancelSession('alice'), /unknown session/)
    const revision = store.snapshot().revision
    await assert.rejects(manager.openSession('alice'), /cancelled/)
    assert.equal(store.snapshot().revision, revision)
    assert.deepEqual(manager.status().sessions, [])
    assert.equal((await manager.openSession('bob')).executionEpoch, 1)
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it('trusted session cancellation prevents the first pending execution from escaping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-'))
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  let barrier
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' }, {
    checkpoint: point => point === 'before:directory-sync' ? barrier?.() : undefined,
  })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager-1' })
    barrier = () => { entered.resolve(); return gate.promise }
    const opening = manager.openSession('alice')
    const rejected = assert.rejects(opening, /cancelled/)
    await entered.promise
    const cancellation = manager.cancelSession('alice')
    gate.resolve()
    await rejected
    assert.equal((await cancellation).executionEpoch, 2)
    assert.equal(manager.status().sessions[0].interrupted, true)
    assert.equal(store.snapshot().state.sessions[0].interrupted, true)
  } finally {
    gate.resolve()
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

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

it('a hold computed behind a queued turn start does not revive the hold that turn start ends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-manager-hold-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'm' })
    const execution = await manager.openSession('alice')
    await manager.acquire(execution, '/w/a.txt')
    const caps = (now) => ({ now, singleMaxMs: 60_000, cumulativeMaxMs: 120_000 })
    const start = Date.now()
    await manager.hold('alice', 60_000, caps(start))
    // The cross-process race: a turn start and a short hold arrive together.
    const ended = manager.endHold('alice', start + 10)
    const short = manager.hold('alice', 2_000, caps(start + 20))
    await ended
    const held = await short
    assert.equal(held.holdUntil, start + 20 + 2_000)
    assert.equal(manager.settlement('alice', start + 3_000).expired, true)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
