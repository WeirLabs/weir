import { describe, expect, it } from './helpers.js'
import { Config } from '../src/settings/sections.js'
import { flattenConfig } from '../src/settings/volatile.js'

// Compatibility pin for profile rows saved before the edit-lock rebuild: such
// a row may still carry all eight legacy flat edit-lock keys. Two properties
// hold through the real schema path — `Config['~standard'].validate` reports no
// issues, and the keys survive flattenConfig as inert data. Rejecting unknowns
// or silently stripping them must fail here rather than at a user's saved
// profile, so this test asserts "accepted AND carried", never "threw or not".
const LEGACY_EDIT_LOCK = Object.freeze({
  editLockEnabled: true,
  editLockHoldDefaultMinutes: 30,
  editLockHoldSingleMaxMinutes: 30,
  editLockHoldCumulativeMaxMinutes: 120,
  editLockNudgeAttempts: 2,
  editLockNudgeFallback: 'release',
  editLockAutoResume: true,
  editLockStaleSweep: true,
})

/** The eight legacy keys exactly as one validation pass carried them. */
function legacySubset(flat) {
  return Object.fromEntries(Object.keys(LEGACY_EDIT_LOCK).map((key) => [key, flat[key]]))
}

describe('edit-lock settings compatibility (pre-rebuild profiles)', () => {
  it('accepts all eight legacy edit-lock keys mixed with current keys', () => {
    const raw = {
      ...LEGACY_EDIT_LOCK,
      todoEnabled: true,
      todoMaxConsecutive: 4,
      guardSoftThreshold: 0.5,
      guardHardThreshold: 0.6,
      notifyEnabled: false,
      worktreeMaxActive: 3,
      lspEnabled: true,
      blackboardWriteTokenTtlMinutes: 45,
    }
    const result = Config['~standard'].validate(raw)
    expect(result.issues).toBe(undefined)
    const flat = flattenConfig(result.value)
    expect(legacySubset(flat)).toEqual(LEGACY_EDIT_LOCK)
    // The current-key siblings are unaffected by the legacy row.
    expect(flat.todoMaxConsecutive).toBe(4)
    expect(flat.notifyEnabled).toBe(false)
    expect(flat.blackboardWriteTokenTtlMinutes).toBe(45)
  })

  it('accepts a legacy opt-out and flattens the eight keys losslessly', () => {
    const raw = { ...LEGACY_EDIT_LOCK, editLockEnabled: false }
    const result = Config['~standard'].validate(raw)
    expect(result.issues).toBe(undefined)
    const flat = flattenConfig(result.value)
    // Falsy-but-set survives flattening (it is data, not an unset field) …
    expect(flat.editLockEnabled).toBe(false)
    expect(legacySubset(flat)).toEqual(raw)
    // … and nothing else is fabricated alongside the eight legacy keys.
    expect(Object.keys(flat).sort()).toEqual(Object.keys(raw).sort())
  })
})
