import { it } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager, recoverEditLockManager } from '../src/edit-lock/manager.js'

async function fixture(run, testing) {
  const directory = await mkdtemp(join(tmpdir(), 'orrery-quarantine-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' }, testing)
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'm' })
    const child = await manager.openSession('child')
    const parent = await manager.openSession('parent')
    await run({ store, manager, child, parent })
  } finally {
    await store.close()
    // Exact absolute directory returned by mkdtemp above; never a product snapshot.
    await rm(directory, { recursive: true, force: true })
  }
}

function request(operationId, resourceId = '/w/child.txt', generation = 1) {
  return { operationId, tool: 'write', filePath: resourceId, cwd: '/w', args: {}, content: 'new',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId, generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
}
function hooks(resourceId, publish = async () => ({ version: 'new' })) {
  return { validate() {}, publish, identify: () => resourceId }
}
async function unknown(manager, child) {
  const token = await manager.acquire(child, '/w/child.txt')
  const input = request('interrupted')
  let invoked = 0
  const publisher = hooks(token.resourceId, async () => { invoked++; throw new Error('invoked failure') })
  const ready = await manager.prepare(child, input, publisher)
  await assert.rejects(manager.commit(ready.submission), /invoked failure/)
  assert.equal(invoked, 1)
  assert.equal(manager.history('child', input.operationId).phase, 'unknown')
  return { token, input, publisher, ready, invoked: () => invoked }
}

it('quarantines an invoked child failure without blocking parent publication or replaying history', async () => {
  await fixture(async ({ store, manager, child, parent }) => {
    const failed = await unknown(manager, child)
    const historical = manager.history('child', 'interrupted')
    const token = await manager.acquire(parent, '/w/parent.txt')
    const ready = await manager.prepare(parent, request('parent-write', token.resourceId), hooks(token.resourceId))
    assert.equal((await manager.commit(ready.submission)).phase, 'updated')
    await manager.openSession('unrelated')
    await assert.rejects(manager.acquire(parent, failed.token.resourceId), /fence/)
    await assert.rejects(manager.acquire(child, failed.token.resourceId), /fence/)
    await assert.rejects(manager.prepare(child, request('new-child-write'), failed.publisher), /fence/)
    assert.equal((await manager.prepare(child, failed.input, failed.publisher)).kind, 'history')
    assert.deepEqual(await manager.commit(failed.ready.submission), historical)
    assert.equal(failed.invoked(), 1)
    assert.deepEqual(manager.history('child', 'interrupted'), historical)
    assert.equal(store.snapshot().state.locks.find(l => l.resourceId === failed.token.resourceId).owner, 'child')
  })
})

it('checks every member of acquisition, release, transfer and session-wide cleanup before persistence', async () => {
  await fixture(async ({ store, manager, child, parent }) => {
    const safe = await manager.acquire(child, '/w/safe.txt')
    const { token } = await unknown(manager, child)
    for (const action of [
      () => manager.acquireMany(parent, ['/w/new.txt', token.resourceId]),
      () => manager.releaseMany([safe, token]),
      () => manager.release(token),
      () => manager.releaseActive('child', 100),
      () => manager.adminUnlock(token.resourceId, token.generation),
      () => manager.transfer(token, parent),
      () => manager.confirm(child, token.resourceId),
      () => manager.hold('child', 10, { now: 100, singleMaxMs: 100, cumulativeMaxMs: 100 }),
    ]) {
      const before = store.snapshot()
      await assert.rejects(action(), /fence/)
      assert.deepEqual(store.snapshot(), before)
      assert.deepEqual(manager.status().locks, before.state.locks)
    }
    const transferred = await manager.transfer(safe, parent)
    await manager.releaseMany([transferred])
    const batch = await manager.acquireMany(parent, ['/w/one.txt', '/w/two.txt'])
    await manager.releaseMany(batch.tokens)
    await manager.acquire(parent, '/w/held.txt')
    await manager.hold('parent', 10, { now: 100, singleMaxMs: 100, cumulativeMaxMs: 100 })
    await manager.endHold('parent', 101)
    assert.deepEqual(await manager.releaseActive('parent', 102), ['/w/held.txt'])
    assert.equal(manager.status().locks.length, 1)
  })
})

it('resume inspects retained ownership and does not consume a receipt or poison the manager on denial', async () => {
  await fixture(async ({ store, manager, child, parent }) => {
    await unknown(manager, child)
    const stopped = await manager.cancel(child)
    const receipt = await manager.issueExecutionReceipt(stopped, 'continue-child')
    const before = store.snapshot()
    await assert.rejects(manager.resume(stopped, 'continue-child', receipt), /fence/)
    await assert.rejects(manager.resume(stopped, 'continue-child', receipt), /fence/)
    assert.deepEqual(store.snapshot(), before)
    assert.equal(manager.status().locks[0].status, 'user-interrupted')
    await manager.acquire(parent, '/w/parent.txt')
    const stoppedParent = await manager.cancel(parent)
    const intent = await manager.issueExecutionReceipt(stoppedParent, 'continue-parent')
    const resumed = await manager.resume(stoppedParent, 'continue-parent', intent)
    await manager.confirm(resumed, '/w/parent.txt')
    await manager.markAbnormal('child', 'publication unresolved')
    await manager.chargeRecovery('child', { attempts: 1 })
    assert.equal(manager.history('child', 'interrupted').outcome.kind, 'unknown')
  })
})

it('rechecks prepared commits at FIFO admission and records denial as never dispatched', async () => {
  await fixture(async ({ manager, child, parent }) => {
    await manager.acquire(child, '/w/child.txt')
    await manager.acquire(parent, '/w/parent.txt')
    let invoked = 0
    const later = await manager.prepare(child, request('later'), hooks('/w/child.txt', async () => { invoked++; return { version: 'new' } }))
    const unrelated = await manager.prepare(parent, request('unrelated', '/w/parent.txt'), hooks('/w/parent.txt'))
    await unknown(manager, child)
    await assert.rejects(manager.commit(later.submission), /fence/)
    assert.equal(invoked, 0)
    assert.deepEqual(manager.history('child', 'later').outcome, { kind: 'not-published', reason: 'rejected-before-dispatch' })
    assert.equal((await manager.commit(unrelated.submission)).phase, 'updated')
  })
})

it('recovered resource quarantine allows unrelated work and retains immutable unknown ownership', async () => {
  await fixture(async ({ store, manager, child }) => {
    await unknown(manager, child)
    const history = manager.history('child', 'interrupted')
    await manager.close()
    const recovered = await recoverEditLockManager({ store, managerIncarnation: 'next' })
    const parent = await recovered.openSession('new-parent')
    await recovered.acquire(parent, '/w/parent.txt')
    await assert.rejects(recovered.adminUnlock('/w/child.txt', 1), /fence/)
    assert.deepEqual(recovered.history('child', 'interrupted'), history)
    assert.equal(recovered.status().locks.find(l => l.owner === 'child').status, 'user-interrupted')
  })
})

it('fails closed for unproved subtree continuity, including apparent prefix siblings and opaque IDs', async () => {
  await fixture(async ({ store, manager, child, parent }) => {
    const input = { ...request('create'), target: { kind: 'create', ancestor: '/w/tree', suffix: 'new.txt', policy: { kind: 'createIfAbsent' } } }
    const ready = await manager.prepare(child, input, hooks('/w/tree/new.txt', async () => { throw new Error('invoked failure') }))
    await assert.rejects(manager.commit(ready.submission), /invoked failure/)
    for (const id of ['/w/tree/file.txt', '/w/tree-sibling/file.txt', '/other/file.txt', 'opaque']) {
      await assert.rejects(manager.acquire(parent, id), /fence/)
    }
    // Registration has no ownership effect; it is not a blind exemption for resume.
    await manager.openSession('targetless')
    const before = store.snapshot().state.operations
    await manager.cancel(child)
    await manager.chargeRecovery('child', { attempts: 1 })
    assert.deepEqual(store.snapshot().state.operations, before)
  })
})

it('domain quarantine rejects normal targetless mutations but permits strictly subtractive revocation', async () => {
  await fixture(async ({ store, manager, child, parent }) => {
    const safe = await manager.acquire(parent, '/w/parent.txt')
    await manager.hold('parent', 10, { now: 100, singleMaxMs: 100, cumulativeMaxMs: 100 })
    // v3 domain fences are historical input, not generated by today's publisher.
    const state = store.snapshot().state
    const input = { ...request('domain'), target: { kind: 'create', ancestor: '/w', suffix: 'new.txt', policy: { kind: 'createIfAbsent' } } }
    const { bindRequest } = await import('../src/edit-lock/request-binding.js')
    state.operations.push({ sessionId: 'child', operationId: 'domain', origin: { executionEpoch: 1, managerIncarnation: 'm' },
      binding: bindRequest(input), phase: 'prepared', fence: null, outcome: null, closeouts: [] })
    await manager.close()
    await store.record({ expectedRevision: store.snapshot().revision, nextState: state })
    state.operations[0].phase = 'publishing'
    state.operations[0].fence = { kind: 'domain', basis: 'containment-unproved' }
    await store.record({ expectedRevision: store.snapshot().revision, nextState: state })
    const recovered = await recoverEditLockManager({ store, managerIncarnation: 'next' })
    const stopped = { ...parent, managerIncarnation: 'next', executionEpoch: 2 }
    for (const action of [
      () => recovered.openSession('new'),
      () => recovered.issueExecutionReceipt(stopped, 'intent'),
      () => recovered.acquire(stopped, '/other.txt'),
      () => recovered.acquireMany(stopped, []),
      () => recovered.resume(stopped, 'intent', {}),
    ]) await assert.rejects(action(), /fence/)
    await recovered.cancelSession('child')
    await recovered.markAbnormal('parent', 'stopped')
    await recovered.chargeRecovery('child', { attempts: 1 })
    await recovered.endHold('parent', 200)
    await recovered.release({ ...safe, ...stopped })
    assert.equal(recovered.status().locks.length, 0)
    assert.equal(recovered.history('child', 'domain').phase, 'unknown')
  })
})

it('does not treat noncanonical or missing target identity as proof of resource non-overlap', async () => {
  await fixture(async ({ manager, child, parent }) => {
    await unknown(manager, child)
    for (const id of [undefined, '', 'opaque', '/w/../w/child.txt', '/w//child.txt']) {
      await assert.rejects(manager.acquire(parent, id), /fence/)
    }
    const input = { ...request('create'), target: { kind: 'create', ancestor: '/elsewhere', suffix: 'new.txt', policy: { kind: 'createIfAbsent' } } }
    await assert.rejects(manager.prepare(parent, input, hooks('/elsewhere/new.txt')), /fence/)
  })
})

it('unrelated admitted work still loses authority to cancellation before dispatch', async () => {
  await fixture(async ({ manager, child, parent }) => {
    await unknown(manager, child)
    await manager.acquire(parent, '/w/parent.txt')
    let invoked = 0
    const ready = await manager.prepare(parent, request('cancelled', '/w/parent.txt'), hooks('/w/parent.txt', async () => { invoked++; return { version: 'new' } }))
    await manager.cancel(parent)
    await assert.rejects(manager.commit(ready.submission), /active/)
    assert.equal(invoked, 0)
    assert.equal(manager.history('parent', 'cancelled').phase, 'not-published')
  })
})

it('uncertain persistence still poisons unrelated admitted work instead of granting rollback authority', async () => {
  let fail = false
  await fixture(async ({ manager, child, parent }) => {
    await unknown(manager, child)
    fail = true
    await assert.rejects(manager.acquire(parent, '/w/parent.txt'), /poisoned/)
    assert.throws(() => manager.status(), /poisoned/)
    await assert.rejects(manager.openSession('later'), /poisoned/)
  }, { checkpoint(point) { if (fail && point === 'before:directory-sync') throw new Error('disk failure') } })
})
