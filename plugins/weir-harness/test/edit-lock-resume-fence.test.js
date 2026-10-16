// Regression pins for OpenSpec change edit-lock-resume-fence-escape (incident
// 2026-10-16): a write version-CAS denial is conservatively recorded as an
// unknown-phase operation with a resource fence (correct), but the trusted
// Continue (manager.resume) was then denied `resource-conflict` because its
// admission candidate enumerates every session-owned resource. Resume is a
// session-level recovery transaction that publishes nothing, so an unresolved
// RESOURCE-level fence must never block it. The fenced resource itself stays
// barred — confirm/acquire/publish resource-conflict, release
// retained-ownership — until administrative recovery settles the operation.
import { it } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { admitMutation } from '../src/edit-lock/admission.js'
import { bindRequest } from '../src/edit-lock/request-binding.js'

/** The incident request shape: a `write` update guarded by replaceIfVersion. */
function request(operationId, resourceId, generation = 1) {
  return { operationId, tool: 'write', filePath: resourceId, cwd: '/w', args: {}, content: 'new',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId, generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
}
function hooks(resourceId, publish = async () => ({ version: 'new' })) {
  return { validate() {}, publish, identify: () => resourceId }
}

/** An unknown-phase operation with a resource fence, produced the way the
 * incident produced it: the publisher hook's outcome is lost mid-commit. */
async function manufactureUnknown(manager, execution, operationId, resourceId) {
  const token = await manager.acquire(execution, resourceId)
  const ready = await manager.prepare(execution, request(operationId, resourceId, token.generation),
    hooks(resourceId, async () => { throw new Error('writer outcome lost') }))
  await assert.rejects(manager.commit(ready.submission), /writer outcome lost/)
  const operation = manager.history(execution.sessionId, operationId)
  assert.equal(operation.phase, 'unknown')
  assert.deepEqual(operation.fence, { kind: 'resource', resourceId })
  return token
}

it('resume tolerates an unresolved resource fence on an owned resource; the fence still bars every other path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weir-resume-fence-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'm' })
    const execution = await manager.openSession('alice')
    const fenced = await manufactureUnknown(manager, execution, 'cas-denied', '/w/r.txt')
    await manager.acquire(execution, '/w/q.txt')
    const stopped = await manager.cancel(execution)
    const receipt = await manager.issueExecutionReceipt(stopped, 'continue')

    // The fix: the session-level recovery transaction crosses the resource
    // fence. Before it, this resume was denied `resource-conflict`.
    const resumed = await manager.resume(stopped, 'continue', receipt)
    assert.equal(resumed.executionEpoch, stopped.executionEpoch + 1)
    assert.equal(manager.status().sessions[0].interrupted, false)
    const locks = manager.status().locks
    assert.equal(locks.find(l => l.resourceId === '/w/r.txt').status, 'pending-confirmation')
    assert.equal(locks.find(l => l.resourceId === '/w/q.txt').status, 'pending-confirmation')

    // The fence still bars the resource itself on every other ingress.
    await assert.rejects(manager.confirm(resumed, '/w/r.txt'), /resource-conflict/)
    await assert.rejects(manager.releaseMany([{ ...resumed, resourceId: '/w/r.txt', generation: fenced.generation }]), /retained-ownership/)
    await assert.rejects(manager.prepare(resumed, request('rewrite-r', '/w/r.txt', fenced.generation), hooks('/w/r.txt')), /resource-conflict/)
    assert.equal(manager.history('alice', 'cas-denied').phase, 'unknown')
    assert.equal(manager.status().locks.find(l => l.resourceId === '/w/r.txt').status, 'pending-confirmation')

    // Every unfenced resource works normally right after the resume.
    assert.equal((await manager.confirm(resumed, '/w/q.txt')).generation, 1)
    assert.equal(manager.status().locks.find(l => l.resourceId === '/w/q.txt').status, 'active')
    assert.equal((await manager.acquire(resumed, '/w/new.txt')).generation, 1)
    const ready = await manager.prepare(resumed, request('update-q', '/w/q.txt', 1), hooks('/w/q.txt'))
    assert.equal((await manager.commit(ready.submission)).phase, 'updated')
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it("another session's unresolved resource fence does not block resume, and still bars this session from that resource", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weir-resume-fence-'))
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'm' })
    const alice = await manager.openSession('alice')
    const bob = await manager.openSession('bob')
    // Bob's own incident: a lost write outcome leaves bob's resource fenced.
    // (The image invariant in operation-history.js keeps unresolved update
    // ownership with the op's own session, so a durable authority never
    // carries bob's update fence on a resource alice owns.)
    await manufactureUnknown(manager, bob, 'bob-cas-denied', '/w/r2.txt')
    await manager.acquire(alice, '/w/q2.txt')
    const stopped = await manager.cancel(alice)
    const receipt = await manager.issueExecutionReceipt(stopped, 'continue')

    // Another session's live fence never enters alice's session-level resume.
    const resumed = await manager.resume(stopped, 'continue', receipt)
    assert.equal(resumed.executionEpoch, stopped.executionEpoch + 1)
    assert.equal(manager.status().locks.find(l => l.resourceId === '/w/q2.txt').status, 'pending-confirmation')
    // Bob's ownership and unknown history are untouched by alice's resume.
    const bobs = manager.status().locks.find(l => l.resourceId === '/w/r2.txt')
    assert.equal(bobs.owner, 'bob')
    assert.equal(bobs.status, 'active')
    assert.equal(manager.history('bob', 'bob-cas-denied').phase, 'unknown')

    // Bob's fence still bars alice from bob's retained resource everywhere.
    await assert.rejects(manager.acquire(resumed, '/w/r2.txt'), /resource-conflict/)
    await assert.rejects(manager.prepare(resumed, request('steal-r2', '/w/r2.txt'), hooks('/w/r2.txt')), /resource-conflict/)

    // Alice's own resource is unaffected by bob's fence.
    assert.equal((await manager.confirm(resumed, '/w/q2.txt')).generation, 1)
    const ready = await manager.prepare(resumed, request('update-q2', '/w/q2.txt', 1), hooks('/w/q2.txt'))
    assert.equal((await manager.commit(ready.submission)).phase, 'updated')
  } finally {
    await store.close()
    // directory is the exact absolute mkdtemp result created by this test.
    await rm(directory, { recursive: true, force: true })
  }
})

it("admission 'resume' mode skips only the resource-conflict denial: domain fences and every shape denial still hold", () => {
  const unknownOn = (operationId, resourceId, fence, sessionId = 'alice') => ({
    sessionId, operationId,
    origin: { executionEpoch: 1, managerIncarnation: 'm' },
    binding: bindRequest(request(operationId, resourceId)),
    phase: /** @type {const} */ ('unknown'), fence, outcome: { kind: /** @type {const} */ ('unknown') }, closeouts: [],
  })
  const candidate = { kind: /** @type {const} */ ('resources'), resourceIds: ['/w/r.txt'] }
  const fenced = [unknownOn('op', '/w/r.txt', { kind: 'resource', resourceId: '/w/r.txt' })]

  // Control: default and explicit 'normal' modes keep denying the conflict.
  assert.throws(() => admitMutation(fenced, candidate), /resource-conflict/)
  assert.throws(() => admitMutation(fenced, candidate, 'normal'), /resource-conflict/)
  // The fix: 'resume' tolerates exactly this resource-level fence.
  assert.doesNotThrow(() => admitMutation(fenced, candidate, 'resume'))

  // Authorship is irrelevant: the same fence authored by ANOTHER session on
  // the resuming session's resource is likewise tolerated. (No durable image
  // carries this shape — operation-history.js pins unresolved update ownership
  // to the op's own session — so this pin lives at the admission layer.)
  const foreign = [unknownOn('op-bob', '/w/r.txt', { kind: 'resource', resourceId: '/w/r.txt' }, 'bob')]
  assert.throws(() => admitMutation(foreign, candidate), /resource-conflict/)
  assert.doesNotThrow(() => admitMutation(foreign, candidate, 'resume'))

  // A domain fence still denies resume mode.
  const domain = [unknownOn('op', '/w/r.txt', { kind: 'domain', basis: 'containment-unproved' })]
  assert.throws(() => admitMutation(domain, candidate, 'resume'), /unresolved publication fence: domain/)

  // Every shape denial still binds resume mode.
  assert.throws(() => admitMutation(fenced, undefined, 'resume'), /scope-unproved/)
  assert.throws(() => admitMutation(fenced, { kind: 'scope', ancestor: '/w' }, 'resume'), /scope-continuity-unproved/)
  assert.throws(() => admitMutation(fenced, { kind: 'resources', resourceIds: ['relative.txt'] }, 'resume'), /identity-unproved/)
  const subtree = [unknownOn('op', '/w/r.txt', { kind: 'subtree', ancestor: '/w', basis: 'observed-ancestor' })]
  assert.throws(() => admitMutation(subtree, candidate, 'resume'), /scope-continuity-unproved/)
})
