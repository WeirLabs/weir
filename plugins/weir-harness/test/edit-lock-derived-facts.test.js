// Derived-facts unification (change edit-lock-deepening, task 1.1): the shared
// pure module must be OUTPUT-EQUIVALENT to the three implementations it
// replaced — admin-ledger.js `revokedOwner`/`dispositionFor` and state.js
// `settleHold` (strict mode), and the cold view's inline derivations
// (partial mode: deliberately tolerant of partial images, view.js:139-143).
// The replaced implementations are embedded here verbatim as oracles; the
// matrices compare them pointwise, including the documented divergence rows
// where partial mode is intentionally more lenient than the strict kernel.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dispositionFor, revokedOwner, settleHoldFacts } from '../src/edit-lock/derived-facts.js'
import { createEditLockState } from '../src/edit-lock/state.js'

// --- Oracles: the pre-extraction implementations, verbatim -----------------

// admin-ledger.js:21-25 (strict kernel rule).
const oracleRevokedOwner = (state, owner) => {
  const session = state.sessions?.find(s => s.sessionId === owner)
  if (!session) return false
  return state.adminRecoveries?.some(row => row.owner === owner && session.executionEpoch <= row.revokedEpoch) === true
}

// view.js:139-147 (cold rule over the pre-normalized collections).
const oracleColdRevoked = (image, sessionId) => {
  const sessions = Array.isArray(image?.sessions) ? image.sessions : []
  const adminRecoveries = Array.isArray(image?.adminRecoveries) ? image.adminRecoveries : []
  const session = sessions.find(row => row?.sessionId === sessionId) ?? null
  return session != null && adminRecoveries.some(row => row?.owner === sessionId && Number.isSafeInteger(row?.revokedEpoch) && session.executionEpoch <= row.revokedEpoch)
}

// state.js:163-171 settleHold, row-present computation (strict).
const oracleSettleHold = (sessionId, held, owns, now) => {
  const remainingMs = held.holdUntil === null ? 0 : Math.max(0, held.holdUntil - now)
  const holding = held.holding && owns
  return { sessionId, held: holding, expired: holding && held.holdUntil !== null && remainingMs === 0,
    holdUntil: held.holdUntil, remainingMs, holdCumulativeMs: held.holdCumulativeMs }
}

// view.js:152-157 buildColdView retention computation (partial), row-present branch.
const oracleColdRetention = (sessionId, held, owns, now) => {
  const remainingMs = held?.holdUntil == null ? 0 : Math.max(0, held.holdUntil - now)
  const holding = held?.holding === true && owns
  return held ? { sessionId, held: holding, expired: holding && held.holdUntil !== null && remainingMs === 0,
    holdUntil: held.holdUntil, remainingMs, holdCumulativeMs: held.holdCumulativeMs } : null
}

// admin-ledger.js:15 and inspect.js:55 (identical at both sites).
const oracleDispositionFor = (state, op) => state.adminRecoveries?.find(row => row.owner === op.sessionId && row.operations.some(item => item.operationId === op.operationId))

// --- revokedOwner: strict mode is the ledger rule, byte for byte -----------

test('revokedOwner strict mode matches the replaced admin-ledger rule pointwise', () => {
  const rows = [
    { owner: 's', revokedEpoch: 3 },
    { owner: 's', revokedEpoch: 5 },
    { owner: 'other', revokedEpoch: 9 },
  ]
  const images = [
    // Validated-image shapes: revoked while the recorded epoch is within the
    // disposition, repaired once the epoch advances past every revokedEpoch.
    { sessions: [{ sessionId: 's', executionEpoch: 1, interrupted: true }], adminRecoveries: rows },
    { sessions: [{ sessionId: 's', executionEpoch: 3, interrupted: true }], adminRecoveries: rows },
    { sessions: [{ sessionId: 's', executionEpoch: 5, interrupted: true }], adminRecoveries: rows },
    { sessions: [{ sessionId: 's', executionEpoch: 6, interrupted: false }], adminRecoveries: rows },
    { sessions: [{ sessionId: 's', executionEpoch: 1, interrupted: true }], adminRecoveries: [] },
    { sessions: [{ sessionId: 's', executionEpoch: 1, interrupted: true }] },
    { adminRecoveries: rows },
    { sessions: [], adminRecoveries: rows },
    { sessions: [{ sessionId: 's', executionEpoch: 2, interrupted: true }], adminRecoveries: [{ owner: 'other', revokedEpoch: 9 }] },
  ]
  for (const state of images) {
    for (const owner of ['s', 'other', 'nobody']) {
      assert.deepEqual(revokedOwner(state, owner), oracleRevokedOwner(state, owner), `strict ${JSON.stringify({ state, owner })}`)
      assert.deepEqual(revokedOwner(state, owner, { partial: true }), oracleColdRevoked(state, owner), `partial ${JSON.stringify({ state, owner })}`)
    }
  }
})

test('revokedOwner partial mode keeps the cold path’s deliberate tolerance of partial images', () => {
  const partial = [
    // Missing/mistyped collections read as empty instead of throwing.
    [{ adminRecoveries: 'junk' }, 's', false],
    [{ sessions: null, adminRecoveries: [{ owner: 's', revokedEpoch: 3 }] }, 's', false],
    [undefined, 's', false],
    // Malformed rows are skipped: a non-integer revokedEpoch never marks a
    // session revoked on the cold path.
    [{ sessions: [{ sessionId: 's', executionEpoch: 1 }], adminRecoveries: [{ owner: 's', revokedEpoch: '3' }] }, 's', false],
    [{ sessions: [{ sessionId: 's', executionEpoch: 1 }], adminRecoveries: [null] }, 's', false],
    [{ sessions: [null], adminRecoveries: [{ owner: 's', revokedEpoch: 3 }] }, 's', false],
    [{ sessions: [{ sessionId: 's', executionEpoch: 1 }], adminRecoveries: [{ owner: 's' }] }, 's', false],
    // The genuine revoked row still marks the session.
    [{ sessions: [{ sessionId: 's', executionEpoch: 1 }], adminRecoveries: [{ owner: 's', revokedEpoch: 3 }] }, 's', true],
  ]
  for (const [state, owner, expected] of partial) {
    assert.equal(revokedOwner(state, owner, { partial: true }), expected, `partial ${JSON.stringify(state)}`)
    assert.equal(revokedOwner(state, owner, { partial: true }), oracleColdRevoked(state, owner))
  }
  // Strict mode trusts the validated image: the same malformed rows either
  // throw (null row) or read by the kernel's plain comparison (string epoch
  // coerces) — the documented strictness the cold path deliberately relaxes.
  assert.throws(() => revokedOwner({ sessions: [{ sessionId: 's', executionEpoch: 1 }], adminRecoveries: [null] }, 's'))
  assert.equal(revokedOwner({ sessions: [{ sessionId: 's', executionEpoch: 1 }], adminRecoveries: [{ owner: 's', revokedEpoch: '3' }] }, 's'), true)
})

// --- settleHoldFacts: strict mode is the kernel rule, byte for byte ---------

test('settleHoldFacts strict mode matches the replaced settleHold computation pointwise', () => {
  const heldRows = [
    { sessionId: 's', holding: true, holdUntil: 5_000, holdCumulativeMs: 60_000 },
    { sessionId: 's', holding: true, holdUntil: null, holdCumulativeMs: 0 },
    { sessionId: 's', holding: false, holdUntil: null, holdCumulativeMs: 120_000 },
    { sessionId: 's', holding: true, holdUntil: 1_000, holdCumulativeMs: 60_000 },
  ]
  for (const held of heldRows) {
    for (const owns of [true, false]) {
      for (const now of [0, 1_000, 5_000, 9_999]) {
        assert.deepEqual(settleHoldFacts('s', held, owns, now), oracleSettleHold('s', held, owns, now), `strict ${JSON.stringify({ held, owns, now })}`)
        assert.deepEqual(settleHoldFacts('s', held, owns, now, { partial: true }), oracleColdRetention('s', held, owns, now), `partial ${JSON.stringify({ held, owns, now })}`)
      }
    }
  }
})

test('settleHoldFacts partial mode keeps the cold path’s deliberate tolerance of malformed rows', () => {
  // A truthy non-boolean `holding` never counts on the cold path (the kernel
  // trusts its validated row and propagates the truthiness).
  assert.deepEqual(settleHoldFacts('s', { sessionId: 's', holding: 1, holdUntil: 5_000, holdCumulativeMs: 0 }, true, 1_000),
    oracleSettleHold('s', { sessionId: 's', holding: 1, holdUntil: 5_000, holdCumulativeMs: 0 }, true, 1_000))
  assert.equal(settleHoldFacts('s', { sessionId: 's', holding: 1, holdUntil: 5_000, holdCumulativeMs: 0 }, true, 1_000).held, true)
  assert.equal(settleHoldFacts('s', { sessionId: 's', holding: 1, holdUntil: 5_000, holdCumulativeMs: 0 }, true, 1_000, { partial: true }).held, false)
  // An undefined holdUntil reads as "no expiry" on the cold path; the strict
  // computation propagates the kernel's arithmetic (NaN remaining).
  const lax = settleHoldFacts('s', { sessionId: 's', holding: true, holdCumulativeMs: 0 }, true, 1_000, { partial: true })
  assert.equal(lax.remainingMs, 0)
  assert.equal(lax.expired, true)
  const strict = settleHoldFacts('s', { sessionId: 's', holding: true, holdCumulativeMs: 0 }, true, 1_000)
  assert.deepEqual(strict, oracleSettleHold('s', { sessionId: 's', holding: true, holdCumulativeMs: 0 }, true, 1_000))
  assert.ok(Number.isNaN(strict.remainingMs))
})

test('the kernel settleHold now delegates to the shared derived fact, unchanged end to end', () => {
  const kernel = createEditLockState('m1')
  const now = 1_000
  // Unknown session: the zero row is the kernel's empty case, unchanged.
  assert.deepEqual(kernel.operations.settleHold('stranger', now),
    { sessionId: 'stranger', held: false, expired: false, holdUntil: null, remainingMs: 0, holdCumulativeMs: 0 })
  assert.throws(() => kernel.operations.settleHold('s', Number.NaN), /finite instant/)
  const execution = kernel.authority.openSession('s')
  kernel.operations.acquire(execution, '/r/a')
  kernel.operations.hold(kernel.operations.holdCandidate('s', 60_000, { now, singleMaxMs: 600_000, cumulativeMaxMs: 3_600_000 }))
  const status = kernel.operations.status()
  const held = status.holds.find(row => row.sessionId === 's')
  const owns = status.locks.some(lock => lock.owner === 's')
  // The kernel read equals the shared rule applied to the same image rows.
  for (const instant of [now, now + 30_000, now + 60_000, now + 61_000]) {
    assert.deepEqual(kernel.operations.settleHold('s', instant), settleHoldFacts('s', held, owns, instant))
  }
  // Releasing the last lock ends the batch (the kernel resets the row), and
  // the next read equals the shared rule applied to the FRESH row.
  kernel.operations.release({ ...execution, resourceId: '/r/a', generation: 1 })
  const after = kernel.operations.status()
  assert.deepEqual(kernel.operations.settleHold('s', now),
    settleHoldFacts('s', after.holds.find(row => row.sessionId === 's'), after.locks.some(lock => lock.owner === 's'), now))
})

// --- dispositionFor: one lookup, both former call sites ---------------------

test('dispositionFor matches the replaced admin-ledger/inspect lookup pointwise', () => {
  const row = (owner, ids) => ({ owner, operations: ids.map(operationId => ({ operationId })) })
  const states = [
    { adminRecoveries: [row('s', ['op1', 'op2']), row('s', ['op3']), row('other', ['op1'])] },
    { adminRecoveries: [] },
    {},
    { adminRecoveries: [row('other', ['op9'])] },
  ]
  const ops = [
    { sessionId: 's', operationId: 'op1' },
    { sessionId: 's', operationId: 'op3' },
    { sessionId: 's', operationId: 'missing' },
    { sessionId: 'other', operationId: 'op1' },
  ]
  for (const state of states) {
    for (const op of ops) {
      assert.deepEqual(dispositionFor(state, op), oracleDispositionFor(state, op), `${JSON.stringify({ state, op })}`)
    }
  }
})
