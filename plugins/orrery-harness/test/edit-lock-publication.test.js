import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'

test('durable creation, retry and in-flight cancellation converge without redispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-publication-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager' })
    const execution = await manager.openSession('alice')
    const request = { operationId: 'one', tool: 'write', filePath: 'file', cwd: '/workspace', args: { content: 'hello' },
      content: 'hello', effectivePolicy: { mode: 'workspace-write' },
      target: { kind: 'create', ancestor: '/workspace', suffix: 'file', policy: { kind: 'createIfAbsent' } } }
    const started = Promise.withResolvers()
    const finish = Promise.withResolvers()
    let invoked = 0
    const ready = await manager.prepare(execution, request, { validate() {},
      publish() { invoked++; started.resolve(); return finish.promise }, identify() { return '/workspace/file' } })
    assert.equal(ready.kind, 'ready')
    assert.equal(manager.status().locks.length, 0)
    const publishing = manager.commit(ready.submission)
    await started.promise
    const cancellation = manager.cancel(execution)
    finish.resolve({ version: 'opaque' })
    const result = await publishing
    await cancellation
    assert.equal(result.phase, 'created')
    assert.equal(manager.status().locks[0].status, 'user-interrupted')
    assert.equal(manager.status().sessions[0].executionEpoch, 2)
    assert.equal((await manager.commit(ready.submission)).phase, 'created')
    assert.equal((await manager.prepare(execution, request, { validate() { throw new Error('must not run') } })).kind, 'history')
    assert.equal(invoked, 1)
    await assert.rejects(manager.prepare(execution, { ...request, content: 'different' }, {}), /ID_REUSE/)
  } finally { await store.close() }
})


test('batch ownership rejects a conflict atomically and excludes pre-existing locks from cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-batch-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'manager' })
    const alice = await manager.openSession('alice')
    const bob = await manager.openSession('bob')
    await manager.acquire(alice, '/workspace/owned')
    await manager.acquire(bob, '/workspace/conflict')
    await assert.rejects(manager.acquireMany(alice, ['/workspace/new', '/workspace/conflict']), /owned/)
    assert.equal(manager.status().locks.some(lock => lock.resourceId === '/workspace/new'), false)
    const batch = await manager.acquireMany(alice, ['/workspace/owned', '/workspace/new'])
    assert.deepEqual(batch.temporary.map(token => token.resourceId), ['/workspace/new'])
    assert.equal(batch.tokens.length, 2)
  } finally { await store.close() }
})
