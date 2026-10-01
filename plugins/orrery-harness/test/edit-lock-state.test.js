import { expect, it } from './helpers.js'
import { createEditLockState } from '../src/edit-lock/state.js'

it('creation settlement rejects invalid origins and preserves generation history', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const alice = authority.openSession('alice')
  const before = authority.checkpoint()
  for (const origin of [
    { ...alice, managerIncarnation: 'old' }, { ...alice, sessionId: 'unknown' },
    { ...alice, executionEpoch: 0 }, { ...alice, executionEpoch: 2 },
    { ...alice, executionEpoch: 1.5 },
  ]) expect(() => authority.settleCreated(origin, 'file:new')).toThrow()
  expect(authority.checkpoint()).toEqual(before)
  const token = authority.settleCreated(alice, 'file:new')
  expect(operations.checkWrite(token)).toEqual({ allowed: true })
  operations.release(token)
  expect(authority.settleCreated(alice, 'file:new').generation).toBe(2)
})

it('old creation origin stays disarmed even after the owner explicitly resumes', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const origin = authority.openSession('alice')
  const cancelled = authority.cancel(origin)
  const receipt = authority.issueExecutionReceipt(cancelled, 'continue')
  operations.resume(cancelled, 'continue', receipt)
  const token = authority.settleCreated(origin, 'file:late')
  expect(() => operations.checkWrite(token)).toThrow(/active/)
  expect(operations.status().sessions[0].interrupted).toBe(false)
  expect(operations.status().locks[0].status).toBe('user-interrupted')
})

it('settles a late successful creation as retained interrupted ownership without rearming', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const alice = authority.openSession('alice')
  authority.cancel(alice)
  const token = authority.settleCreated(alice, 'file:new')
  expect(operations.status().locks).toEqual([
    { resourceId: 'file:new', owner: 'alice', generation: 1, status: 'user-interrupted' },
  ])
  expect(() => operations.checkWrite(token)).toThrow(/active/)
  expect(operations.status().sessions[0]).toEqual({ sessionId: 'alice', executionEpoch: 2, interrupted: true })
  expect(() => authority.settleCreated(alice, 'file:new')).toThrow(/owned/)
})

it('checkpoints detached lifetime tombstones without serializing execution receipts', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const alice = authority.openSession('alice')
  const token = operations.acquire(alice, 'file:a')
  operations.release(token)
  authority.issueExecutionReceipt(alice, 'continue-1')
  const checkpoint = authority.checkpoint()
  expect(checkpoint).toEqual({
    managerIncarnation: 'manager-1',
    sessions: [{ sessionId: 'alice', executionEpoch: 1, interrupted: false }],
    locks: [], generations: [{ resourceId: 'file:a', generation: 1 }],
    issuedRequests: [{ sessionId: 'alice', requestId: 'continue-1' }],
  })
  checkpoint.generations[0].generation = 99
  checkpoint.sessions[0].interrupted = true
  expect(authority.checkpoint().generations[0].generation).toBe(1)
  expect(operations.acquire(alice, 'file:a').generation).toBe(2)
})

it('grants exclusive canonical-resource ownership with separate fencing credentials', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const alice = authority.openSession('alice')
  const bob = authority.openSession('bob')
  const token = operations.acquire(alice, 'file:a')
  expect(token).toEqual({ managerIncarnation: 'manager-1', sessionId: 'alice', executionEpoch: 1, resourceId: 'file:a', generation: 1 })
  expect(operations.checkWrite(token)).toEqual({ allowed: true })
  expect(() => operations.acquire(bob, 'file:a')).toThrow(/owned/)
  expect(operations.acquire(alice, 'file:a')).toEqual(token)
  expect(operations.status().locks).toEqual([{ resourceId: 'file:a', owner: 'alice', generation: 1, status: 'active' }])
})

it('release and reacquire never revive old ownership, even for the same owner', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const alice = authority.openSession('alice')
  const bob = authority.openSession('bob')
  const old = operations.acquire(alice, 'file:a')
  operations.release(old)
  const next = operations.acquire(alice, 'file:a')
  expect(next.generation).toBeGreaterThan(old.generation)
  const before = operations.status()
  expect(() => operations.release(old)).toThrow(/ownership/)
  expect(() => operations.checkWrite(old)).toThrow(/ownership/)
  expect(operations.status()).toEqual(before)
  operations.release(next)
  const other = operations.acquire(bob, 'file:a')
  expect(other.generation).toBeGreaterThan(next.generation)
  expect(() => operations.checkWrite(next)).toThrow(/ownership/)
  expect(operations.checkWrite(other)).toEqual({ allowed: true })
})

it('cancellation revokes only the current session and releasing its last lock does not rearm it', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const parent = authority.openSession('parent')
  const child = authority.openSession('child')
  const old = operations.acquire(parent, 'file:parent')
  const childToken = operations.acquire(child, 'file:child')
  const stopped = authority.cancel(parent)
  expect(stopped.executionEpoch).toBe(2)
  expect(() => operations.checkWrite(old)).toThrow(/epoch/)
  expect(() => operations.release(old)).toThrow(/epoch/)
  expect(() => operations.acquire(stopped, 'file:new')).toThrow(/interrupted/)
  expect(operations.status().locks[0].status).toBe('user-interrupted')
  expect(operations.checkWrite(childToken)).toEqual({ allowed: true })
  operations.release({ ...old, ...stopped })
  const before = operations.status()
  expect(before.sessions[0].interrupted).toBe(true)
  expect(before.locks).toHaveLength(1)
  expect(() => authority.openSession('parent')).toThrow(/registered/)
  expect(() => operations.acquire(stopped, 'file:parent')).toThrow(/interrupted/)
  expect(operations.status()).toEqual(before)
})

it('trusted explicit resume requires a new epoch and individual confirmation of retained files', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const execution = authority.openSession('alice')
  const a = operations.acquire(execution, 'file:a')
  const b = operations.acquire(execution, 'file:b')
  const stopped = authority.cancel(execution)
  const receipt = authority.issueExecutionReceipt(stopped, 'continue-1')
  const resumed = operations.resume(stopped, 'continue-1', receipt)
  expect(resumed.executionEpoch).toBe(3)
  expect(operations.status().sessions[0].interrupted).toBe(false)
  expect(operations.status().locks.map(lock => lock.status)).toEqual(['pending-confirmation', 'pending-confirmation'])
  expect(() => operations.checkWrite({ ...a, ...resumed })).toThrow(/not active/)
  const confirmed = operations.acquire(resumed, 'file:a')
  expect(confirmed.generation).toBe(a.generation)
  expect(operations.checkWrite(confirmed)).toEqual({ allowed: true })
  expect(() => operations.checkWrite(a)).toThrow(/epoch/)
  expect(() => operations.acquire(stopped, 'file:a')).toThrow(/epoch/)
  expect(() => operations.checkWrite({ ...b, ...resumed })).toThrow(/not active/)
  operations.release({ ...b, ...resumed })
  expect(operations.status().locks).toHaveLength(1)
})

it('receipts reject forgery, cross-session/request/manager use, stale epochs and replay without consuming valid intent', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const alice = authority.cancel(authority.openSession('alice'))
  const bob = authority.cancel(authority.openSession('bob'))
  const receipt = authority.issueExecutionReceipt(alice, 'request-1')
  const before = operations.status()
  for (const attempt of [
    () => operations.resume(alice, 'request-1', {}),
    () => operations.resume(alice, 'request-1', { ...receipt }),
    () => operations.resume(bob, 'request-1', receipt),
    () => operations.resume(alice, 'wrong-request', receipt),
    () => operations.resume({ ...alice, managerIncarnation: 'old' }, 'request-1', receipt),
  ]) {
    expect(attempt).toThrow()
    expect(operations.status()).toEqual(before)
  }
  const foreign = createEditLockState('manager-2')
  const foreignAlice = foreign.authority.cancel(foreign.authority.openSession('alice'))
  expect(() => foreign.operations.resume(foreignAlice, 'request-1', receipt)).toThrow(/receipt/)
  const resumed = operations.resume(alice, 'request-1', receipt)
  const after = operations.status()
  expect(() => operations.resume(resumed, 'request-1', receipt)).toThrow(/receipt/)
  expect(operations.status()).toEqual(after)
  const stoppedAgain = authority.cancel(resumed)
  expect(() => authority.issueExecutionReceipt(stoppedAgain, 'request-1')).toThrow(/request/)
  const stale = authority.issueExecutionReceipt(stoppedAgain, 'request-2')
  const cancelledAgain = authority.cancel(stoppedAgain)
  const final = operations.status()
  expect(() => operations.resume(cancelledAgain, 'request-2', stale)).toThrow(/receipt/)
  expect(() => operations.resume(stoppedAgain, 'request-2', stale)).toThrow(/epoch/)
  expect(operations.status()).toEqual(final)
})

it('explicit resume and acquire cannot erase a retained abnormal reason', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const execution = authority.openSession('alice')
  const token = operations.acquire(execution, 'file:a')
  authority.markAbnormal(token, 'publication-uncertain')
  expect(() => operations.checkWrite(token)).toThrow(/not active/)
  const stopped = authority.cancel(execution)
  const receipt = authority.issueExecutionReceipt(stopped, 'continue-1')
  const resumed = operations.resume(stopped, 'continue-1', receipt)
  const before = operations.status()
  expect(before.locks[0].status).toBe('abnormal')
  expect(before.locks[0].reason).toBe('publication-uncertain')
  expect(() => operations.acquire(resumed, 'file:a')).toThrow(/abnormal/)
  expect(() => operations.checkWrite({ ...token, ...resumed })).toThrow(/not active/)
  expect(operations.status()).toEqual(before)
  operations.release({ ...token, ...resumed })
  expect(operations.status().locks).toHaveLength(0)
})

it('malformed identities and unknown or stale credentials fail without changing observable state', () => {
  expect(() => createEditLockState('')).toThrow()
  const { operations, authority } = createEditLockState('manager-1')
  const alice = authority.openSession('alice')
  const token = operations.acquire(alice, 'file:a')
  const before = operations.status()
  const attempts = [
    () => authority.openSession(''),
    () => operations.acquire(alice, ''),
    () => authority.issueExecutionReceipt(alice, ''),
    () => authority.markAbnormal(token, {}),
  ]
  for (const bad of [null, {}, { ...alice, sessionId: 'unknown' }, { ...alice, executionEpoch: 0 }, { ...alice, managerIncarnation: 'old' }]) {
    attempts.push(
      () => operations.acquire(bad, 'file:new'),
      () => authority.cancel(bad),
      () => authority.issueExecutionReceipt(bad, 'request'),
      () => operations.resume(bad, 'request', {}),
      () => operations.release({ ...token, ...bad, sessionId: bad?.sessionId }),
      () => operations.checkWrite({ ...token, ...bad, sessionId: bad?.sessionId }),
    )
  }
  for (const badToken of [{ ...token, resourceId: 'file:unknown' }, { ...token, generation: 0 }, { ...token, generation: 2 }]) {
    attempts.push(() => operations.checkWrite(badToken), () => operations.release(badToken), () => authority.markAbnormal(badToken, 'uncertain'))
  }
  for (const attempt of attempts) {
    expect(attempt).toThrow()
    expect(operations.status()).toEqual(before)
  }
  // Failed issuance must not reserve the request ID.
  const receipt = authority.issueExecutionReceipt(alice, 'request')
  expect(operations.resume(alice, 'request', receipt).executionEpoch).toBe(2)
})

it('zero-lock cancellation remains latched across queries, repeated cancellation and resume cycles', () => {
  const { operations, authority } = createEditLockState('manager-1')
  let execution = authority.openSession('alice')
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const old = execution
    execution = authority.cancel(execution)
    const before = operations.status()
    expect(before.locks).toHaveLength(0)
    expect(before.sessions[0].interrupted).toBe(true)
    expect(() => authority.cancel(old)).toThrow(/epoch/)
    expect(() => operations.acquire(execution, 'file:a')).toThrow(/interrupted/)
    expect(operations.status()).toEqual(before)
    const request = `continue-${cycle}`
    const receipt = authority.issueExecutionReceipt(execution, request)
    execution = operations.resume(execution, request, receipt)
    const token = operations.acquire(execution, 'file:a')
    expect(operations.checkWrite(token)).toEqual({ allowed: true })
    operations.release(token)
  }
  expect(execution.executionEpoch).toBe(7)
})

it('returned snapshots and credentials cannot mutate kernel state and queries have no effects', () => {
  const { operations, authority } = createEditLockState('manager-1')
  const execution = authority.openSession('alice')
  const token = operations.acquire(execution, 'file:a')
  const original = { ...token }
  const before = operations.status()
  const snapshot = operations.status()
  snapshot.sessions[0].executionEpoch = 999
  snapshot.sessions[0].interrupted = true
  snapshot.locks[0].owner = 'intruder'
  snapshot.locks[0].generation = 999
  snapshot.locks.length = 0
  execution.executionEpoch = 999
  token.generation = 999
  expect(operations.checkWrite(original)).toEqual({ allowed: true })
  expect(operations.status()).toEqual(before)
  const stopped = authority.cancel(original)
  const interrupted = operations.status()
  const view = operations.status()
  view.sessions[0].interrupted = false
  view.locks[0].status = 'active'
  expect(() => operations.checkWrite({ ...original, ...stopped })).toThrow(/not active/)
  expect(operations.status()).toEqual(interrupted)
})
