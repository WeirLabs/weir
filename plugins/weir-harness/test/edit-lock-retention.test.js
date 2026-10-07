// Retention (design D1/D2/D4/D5) is a SESSION-level budget, not a lock status.
// These cases pin the two things the user actually depends on: a held lock is
// still an ordinary lock for everyone else, and the allowance for one batch is
// never refunded.
import { expect, it } from './helpers.js'
import { createEditLockState } from '../src/edit-lock/state.js'

const MINUTE = 60_000
const caps = (over = {}) => ({ now: 1_000_000, singleMaxMs: 30 * MINUTE, cumulativeMaxMs: 120 * MINUTE, ...over })

/** One session holding one lock, plus its retention caps. */
function held() {
  const kernel = createEditLockState('manager-1')
  const execution = kernel.authority.openSession('alice')
  kernel.operations.acquire(execution, 'file:a')
  return { kernel, execution, operations: kernel.operations, authority: kernel.authority }
}

it('every registered session carries exactly one retention row, starting at zero', () => {
  const { operations, authority } = held()
  authority.openSession('bob')
  expect(operations.status().holds).toEqual([
    { sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 },
    { sessionId: 'bob', holding: false, holdUntil: null, holdCumulativeMs: 0 },
  ])
})

it('a retention request charges the batch and leaves ownership untouched', () => {
  const { operations, authority } = held()
  const held30 = operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps()))
  expect(held30).toEqual({ sessionId: 'alice', holding: true, holdUntil: 1_000_000 + 30 * MINUTE, holdCumulativeMs: 30 * MINUTE })
  // Retention extends ownership; it is not a second ownership ledger.
  expect(operations.status().locks).toEqual([{ resourceId: 'file:a', owner: 'alice', generation: 1, status: 'active' }])
  expect(operations.checkWrite({ managerIncarnation: 'manager-1', sessionId: 'alice', executionEpoch: 1, resourceId: 'file:a', generation: 1 }))
    .toEqual({ allowed: true })
})

it('holding keeps refusing other sessions exactly like ordinary ownership', () => {
  const { operations, authority } = held()
  authority.openSession('bob')
  operations.hold(operations.holdCandidate('alice', 10 * MINUTE, caps()))
  const bob = { managerIncarnation: 'manager-1', sessionId: 'bob', executionEpoch: 1 }
  // The held lock is still an ordinary active lock, so the ordinary refusal applies.
  expect(() => operations.acquire(bob, 'file:a')).toThrow(/owned/)
  expect(() => operations.checkWrite({ ...bob, resourceId: 'file:a', generation: 1 })).toThrow(/stale ownership/)
})

it('the holder keeps editing its own held file while holding', () => {
  const { operations, authority, execution } = held()
  operations.hold(operations.holdCandidate('alice', 10 * MINUTE, caps()))
  const token = operations.acquire(execution, 'file:a')
  expect(token.generation).toBe(1)
  expect(operations.checkWrite(token)).toEqual({ allowed: true })
})

it('settlement is read-time and idempotent, and expiry is reported without releasing', () => {
  const { operations, authority } = held()
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps()))
  const before = operations.settleHold('alice', 1_000_000 + MINUTE)
  expect(before.held).toBe(true)
  expect(before.expired).toBe(false)
  expect(before.remainingMs).toBe(29 * MINUTE)
  const at = operations.settleHold('alice', 1_000_000 + 30 * MINUTE)
  expect(at.expired).toBe(true)
  expect(at.remainingMs).toBe(0)
  // A missed timer must not change the answer, and settling never releases.
  expect(operations.settleHold('alice', 1_000_000 + 999 * MINUTE)).toEqual(at)
  expect(operations.status().locks).toHaveLength(1)
})

it('a new turn clears holding for every lock at once but keeps the charged allowance', () => {
  const { operations, authority } = held()
  operations.acquire({ managerIncarnation: 'manager-1', sessionId: 'alice', executionEpoch: 1 }, 'file:b')
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps()))
  operations.endHold('alice')
  const settled = operations.settleHold('alice', 1_000_000)
  expect(settled.held).toBe(false)
  expect(settled.holdUntil).toBeNull()
  expect(settled.holdCumulativeMs).toBe(30 * MINUTE)
  // The locks themselves are ordinary active ownership again, not released or confirmed.
  expect(operations.status().locks.map(lock => lock.status)).toEqual(['active', 'active'])
})

it('the cumulative allowance spans a batch and is never refunded by ending a hold', () => {
  const { operations, authority } = held()
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps()))
  operations.endHold('alice')
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps({ now: 2_000_000 })))
  expect(operations.holdState('alice').holdCumulativeMs).toBe(60 * MINUTE)
  operations.endHold('alice')
  const candidate = operations.holdCandidate('alice', 30 * MINUTE, caps({ now: 3_000_000 }))
  expect(candidate.holdCumulativeMs).toBe(90 * MINUTE)
  operations.hold(candidate)
  operations.endHold('alice')
  // 90 of 120 minutes are spent, so one more equal request would exceed the
  // budget and is refused rather than clamped (the allowance is never refunded).
  expect(operations.holdCandidate('alice', 30 * MINUTE, caps({ now: 4_000_000 })).holdCumulativeMs).toBe(120 * MINUTE)
  // Exactly at the budget is still allowed; one more request is refused rather
  // than clamped, because clamping would quietly change how long others wait.
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps({ now: 4_000_000 })))
  expect(operations.holdState('alice').holdCumulativeMs).toBe(120 * MINUTE)
  expect(() => operations.holdCandidate('alice', 1, caps({ now: 5_000_000 }))).toThrow(/budget exhausted/)
  expect(() => operations.holdCandidate('alice', 31 * MINUTE, caps({ now: 4_000_000 }))).toThrow(/limited to 30 minutes/)
})

it('a request above the single cap is refused and changes nothing', () => {
  const { operations, authority } = held()
  expect(() => operations.holdCandidate('alice', 31 * MINUTE, caps())).toThrow(/limited to 30 minutes/)
  expect(() => operations.holdCandidate('alice', 0, caps())).toThrow(/positive/)
  expect(() => operations.holdCandidate('alice', 1.5, caps())).toThrow(/positive/)
  expect(operations.holdState('alice')).toEqual({ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 })
  })

it('a retention request needs an instant and a lock to retain', () => {
  const { operations } = held()
  expect(() => operations.holdCandidate('alice', 10 * MINUTE, caps({ now: undefined }))).toThrow(/finite instant/)
  const empty = (() => {
    const kernel = createEditLockState('manager-1')
    kernel.authority.openSession('alice')
    return kernel.operations
  })()
  expect(() => empty.holdCandidate('alice', 10 * MINUTE, caps())).toThrow(/no lock to retain/)
})

it('an extension continues from the current expiry and cannot shorten it', () => {
  const { operations, authority } = held()
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps()))
  // 25 minutes in, 5 remain: extending by 10 makes a 15-minute window from now, and
  // only those 10 added minutes are charged — asking again never re-buys the period.
  const extension = operations.holdCandidate('alice', 10 * MINUTE, caps({ now: 1_000_000 + 25 * MINUTE }))
  expect(extension.holdUntil).toBe(1_000_000 + 40 * MINUTE)
  expect(extension.holdCumulativeMs).toBe(40 * MINUTE)
  operations.hold(extension)
  // A window from now beyond the single cap is refused even as an extension.
  expect(() => operations.holdCandidate('alice', 30 * MINUTE, caps({ now: 1_000_000 + 26 * MINUTE }))).toThrow(/limited to 30 minutes/)
  // A candidate that would shorten a running period is refused outright.
  expect(() => operations.hold({ sessionId: 'alice', holding: true, holdUntil: 1_000_000 + MINUTE, holdCumulativeMs: 50 * MINUTE }))
    .toThrow(/shortens/)
  // A smaller allowance is refused before the period is even considered.
  expect(() => operations.hold({ sessionId: 'alice', holding: true, holdUntil: 1_000_000 + 99 * MINUTE, holdCumulativeMs: 5 * MINUTE }))
    .toThrow(/loses allowance/)
})

it('only a candidate from this kernel can be installed, once', () => {
  const { operations, authority } = held()
  const candidate = operations.holdCandidate('alice', 10 * MINUTE, caps())
  operations.hold(candidate)
  expect(() => operations.hold(candidate)).toThrow(/loses allowance/)
  expect(() => operations.hold({ ...candidate, holdCumulativeMs: 1 * MINUTE })).toThrow(/loses allowance/)
  expect(() => operations.hold({ sessionId: 'nobody', holding: true, holdUntil: 2_000_000, holdCumulativeMs: 10 * MINUTE })).toThrow(/unknown session/)
  expect(() => operations.hold({ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 60 * MINUTE })).toThrow(/not active/)
})

it('the batch ends with its last lock: the row stays and returns to zero', () => {
  const { operations, authority, execution } = held()
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps()))
  operations.release({ ...execution, resourceId: 'file:a', generation: 1 })
  expect(operations.holdState('alice')).toEqual({ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 })
  // A fresh batch starts clean, so the next holder of the file is not penalised.
  operations.acquire(execution, 'file:a')
  expect(operations.holdCandidate('alice', 30 * MINUTE, caps({ now: 5_000_000 })).holdCumulativeMs).toBe(30 * MINUTE)
})

it('stopping a session ends its retention period: those locks are handled as abnormal', () => {
  const { operations, authority, execution } = held()
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps()))
  authority.cancel(execution)
  expect(operations.holdState('alice')).toEqual({ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 30 * MINUTE })
  // The consumed allowance is still charged, but no period is running.
  expect(operations.settleHold('alice', 1_000_000).held).toBe(false)
  expect(operations.settleHold('alice', 1_000_000).holdCumulativeMs).toBe(30 * MINUTE)
})

it('a trusted resume restores authority without restarting a retention period', () => {
  const { operations, authority, execution } = held()
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps()))
  const stopped = authority.cancel(execution)
  const receipt = authority.issueExecutionReceipt(stopped, 'continue')
  const resumed = operations.resume(stopped, 'continue', receipt)
  const settled = operations.settleHold('alice', 1_000_000)
  expect(settled.held).toBe(false)
  expect(settled.holdCumulativeMs).toBe(30 * MINUTE)
  expect(operations.status().locks[0].status).toBe('pending-confirmation')
  void resumed
})

it('recovery restores ownership but never a running period, and keeps the charge', () => {
  const old = createEditLockState('old')
  const execution = old.authority.openSession('alice')
  old.operations.acquire(execution, 'file:a')
  old.operations.hold(old.operations.holdCandidate('alice', 30 * MINUTE, caps()))
  const fresh = createEditLockState('new')
  const draft = fresh.authority.beginRecovery({ ...old.authority.checkpoint(), managerIncarnation: 'old' })
  fresh.authority.install(draft)
  const settled = fresh.operations.settleHold('alice', 1_000_000)
  expect(settled.held).toBe(false)
  expect(settled.holdUntil).toBeNull()
  expect(settled.holdCumulativeMs).toBe(30 * MINUTE)
  expect(fresh.operations.status().holds).toHaveLength(1)
})

it('recovery rejects a malformed retention row without installing anything', () => {
  const old = createEditLockState('old')
  old.operations.acquire(old.authority.openSession('alice'), 'file:a')
  const history = old.authority.checkpoint()
  const fresh = createEditLockState('new')
  expect(() => fresh.authority.beginRecovery({ ...history, holds: [{ sessionId: 'alice', holding: true, holdUntil: -1, holdCumulativeMs: 0 }] }))
    .toThrow(/invalid recovery hold/)
  expect(() => fresh.authority.beginRecovery({ ...history, holds: [{ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: -5 }] }))
    .toThrow(/invalid recovery hold/)
  expect(() => fresh.authority.beginRecovery({ ...history, holds: [{ sessionId: 'ghost', holding: false, holdUntil: null, holdCumulativeMs: 0 }] }))
    .toThrow(/invalid recovery hold/)
  expect(fresh.operations.status().sessions).toHaveLength(0)
})

it('a retention request never grants write authority on its own', () => {
  const { operations, authority, execution } = held()
  operations.hold(operations.holdCandidate('alice', 30 * MINUTE, caps()))
  // A token from a stale epoch or another resource is still refused after holding.
  expect(() => operations.checkWrite({ ...execution, resourceId: 'file:a', generation: 1, executionEpoch: 99 })).toThrow(/stale epoch/)
  expect(() => operations.checkWrite({ ...execution, resourceId: 'file:z', generation: 1 })).toThrow(/stale ownership/)
})
