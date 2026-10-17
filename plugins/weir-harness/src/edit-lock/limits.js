// Edit Lock retention policy: the defaults and the overlay resolver the
// lifecycle (edit-lock/index.js) consumes. Moved verbatim out of
// src/settings/sections.js (subsystem-seam-hygiene, D4) — the owner subsystem
// now holds the policy; settings/sections.js keeps a TEMPORARY re-export for
// existing callers (test/settings-fields.test.js), removal is a follow-up.

/** Resolved Edit Lock retention policy. The flat keys are declared in the
 * settings sections table; this is the ONE place that turns them into the
 * values the lifecycle consumes, so defaults and validation cannot drift
 * apart. */
export const EDIT_LOCK_DEFAULTS = Object.freeze({
  holdDefaultMinutes: 30,
  holdSingleMaxMinutes: 30,
  holdCumulativeMaxMinutes: 120,
  nudgeAttempts: 2,
  nudgeFallback: 'release',
})

/** Overlay one Edit Lock section onto the defaults. A key the user never set
 * falls back to its default; a key that is present but unusable (alone or in
 * combination) throws with the flat settings key named, because silently clamping
 * a retention cap would change how long other sessions stay blocked from those
 * files. The Edit Lock composition refuses retention requests with that error and
 * runs every other path (settling, status, release, stop, unlock) on defaults.
 * @param {any} section */
export function editLockLimits(section) {
  const value = section && typeof section === 'object' ? section : {}
  /** @type {{holdDefaultMinutes: number, holdSingleMaxMinutes: number, holdCumulativeMaxMinutes: number, nudgeAttempts: number, nudgeFallback: 'release'|'abnormal'}} */
  const limits = { ...EDIT_LOCK_DEFAULTS }
  /** @param {'holdDefaultMinutes'|'holdSingleMaxMinutes'|'holdCumulativeMaxMinutes'} key @param {string} name */
  const take = (key, name) => {
    const input = value[key]
    if (input === undefined) return
    if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
      throw new Error(`weir-settings: ${name} must be a positive number`)
    }
    limits[key] = input
  }
  take('holdDefaultMinutes', 'editLockHoldDefaultMinutes')
  take('holdSingleMaxMinutes', 'editLockHoldSingleMaxMinutes')
  take('holdCumulativeMaxMinutes', 'editLockHoldCumulativeMaxMinutes')
  if (limits.holdDefaultMinutes > limits.holdSingleMaxMinutes) {
    throw new Error('weir-settings: editLockHoldDefaultMinutes must not exceed editLockHoldSingleMaxMinutes')
  }
  if (limits.holdCumulativeMaxMinutes < limits.holdSingleMaxMinutes) {
    throw new Error('weir-settings: editLockHoldCumulativeMaxMinutes must be at least editLockHoldSingleMaxMinutes')
  }
  if (value.nudgeAttempts !== undefined) {
    if (!Number.isSafeInteger(value.nudgeAttempts) || value.nudgeAttempts < 0) {
      throw new Error('weir-settings: editLockNudgeAttempts must be a non-negative integer')
    }
    limits.nudgeAttempts = value.nudgeAttempts
  }
  if (value.nudgeFallback !== undefined) {
    if (value.nudgeFallback !== 'release' && value.nudgeFallback !== 'abnormal') {
      throw new Error('weir-settings: editLockNudgeFallback must be "release" or "abnormal"')
    }
    limits.nudgeFallback = value.nudgeFallback
  }
  return Object.freeze(limits)
}
