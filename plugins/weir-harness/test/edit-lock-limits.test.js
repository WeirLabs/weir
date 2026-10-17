import test from 'node:test'
import assert from 'node:assert/strict'
import { EDIT_LOCK_DEFAULTS, editLockLimits } from '../src/edit-lock/limits.js'

// Focused unit pin for src/edit-lock/limits.js (change test-surface-pinning,
// task 6.1), the retention-policy resolver extracted by subsystem-seam-hygiene
// (D4) with zero direct test imports. settings-fields.test.js now imports this
// module directly too (the temporary sections.js re-export was removed by
// dead-export-cleanup); this pin nails the flat settings key names in the
// error faces.

test('the defaults are the documented frozen retention policy', () => {
  assert.deepEqual(EDIT_LOCK_DEFAULTS, {
    holdDefaultMinutes: 30,
    holdSingleMaxMinutes: 30,
    holdCumulativeMaxMinutes: 120,
    nudgeAttempts: 2,
    nudgeFallback: 'release',
  })
  assert.ok(Object.isFrozen(EDIT_LOCK_DEFAULTS))
})

test('an absent or unusable section resolves to frozen defaults', () => {
  for (const section of [undefined, null, 'nope', 42]) {
    const limits = editLockLimits(section)
    assert.deepEqual(limits, EDIT_LOCK_DEFAULTS)
    assert.ok(Object.isFrozen(limits))
  }
})

test('a valid overlay wins per key; invalid values throw naming the flat settings key', () => {
  const limits = editLockLimits({ holdDefaultMinutes: 10, holdSingleMaxMinutes: 60, holdCumulativeMaxMinutes: 180, nudgeAttempts: 0, nudgeFallback: 'abnormal' })
  assert.deepEqual(limits, { holdDefaultMinutes: 10, holdSingleMaxMinutes: 60, holdCumulativeMaxMinutes: 180, nudgeAttempts: 0, nudgeFallback: 'abnormal' })
  for (const [key, flat, bad] of /** @type {const} */ ([
    ['holdDefaultMinutes', 'editLockHoldDefaultMinutes', -1],
    ['holdSingleMaxMinutes', 'editLockHoldSingleMaxMinutes', Number.NaN],
    ['holdCumulativeMaxMinutes', 'editLockHoldCumulativeMaxMinutes', '30'],
  ])) {
    assert.throws(() => editLockLimits({ [key]: bad }), (/** @type {any} */ error) => {
      assert.match(error.message, new RegExp(`weir-settings: ${flat} must be a positive number`))
      return true
    })
  }
})

test('cross-field caps are validated, never silently clamped', () => {
  assert.throws(() => editLockLimits({ holdDefaultMinutes: 45, holdSingleMaxMinutes: 30 }),
    /weir-settings: editLockHoldDefaultMinutes must not exceed editLockHoldSingleMaxMinutes/)
  assert.throws(() => editLockLimits({ holdSingleMaxMinutes: 45, holdCumulativeMaxMinutes: 30 }),
    /weir-settings: editLockHoldCumulativeMaxMinutes must be at least editLockHoldSingleMaxMinutes/)
})

test('nudge policy validation: non-negative integer attempts, release|abnormal fallback', () => {
  assert.equal(editLockLimits({ nudgeAttempts: 0 }).nudgeAttempts, 0)
  assert.throws(() => editLockLimits({ nudgeAttempts: 1.5 }), /weir-settings: editLockNudgeAttempts must be a non-negative integer/)
  assert.throws(() => editLockLimits({ nudgeAttempts: -1 }), /weir-settings: editLockNudgeAttempts must be a non-negative integer/)
  assert.equal(editLockLimits({ nudgeFallback: 'abnormal' }).nudgeFallback, 'abnormal')
  assert.throws(() => editLockLimits({ nudgeFallback: 'escalate' }), /weir-settings: editLockNudgeFallback must be "release" or "abnormal"/)
})
