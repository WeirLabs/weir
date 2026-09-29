// The preset patch row must NOT carry the whitelist tables, and the defaults
// file must agree with the built-in constants.
//
// WHY THIS DIRECTION — this file used to assert the opposite ("the row mirrors
// the module defaults"). That invariant was the wrong shape: DSH composes patch
// layers by WHOLE-VALUE replacement (`applyEntryPatches` does `target[key] =
// value`, and the host README states "does not deep-merge"), so the row's
// `config` is discarded outright the moment a profile declares its own settings
// row. Keeping the tables there is what made a whitelist addition unreachable
// for every profile that had ever edited a list — `Start-Sleep` missing from a
// live Windows session while the repo baseline carried it. The tables now live
// in `whitelist-defaults.json`, which the plugin reads itself at runtime, and
// the row must stay free of them: putting them back re-arms the defect.
//
// The other half of the guard is that the data file and the built-in constants
// agree entry for entry. The constants are the per-table fallback for a
// defective file, so a silent divergence between them would let a broken file
// quietly narrow the guard.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from './helpers.js'
import { DEFAULT_ROBASH_PWSH } from '../src/delegate/robash-guard-pwsh.js'
import { DEFAULT_ROBASH } from '../src/delegate/robash-guard.js'
import { WHITELIST_KEYS } from '../src/shared/whitelist-defaults.js'

const PATCH = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const DEFAULTS = JSON.parse(readFileSync(new URL('../whitelist-defaults.json', import.meta.url), 'utf8'))

describe('preset patch row does not carry the whitelist tables', () => {
  it('declares none of the five whitelist keys', () => {
    for (const key of WHITELIST_KEYS) {
      expect(new RegExp(`^\\s*${key}:`, 'm').test(PATCH)).toBe(false)
    }
  })

  it('keeps the guard switch, which is not part of the shadowing hazard', () => {
    // a plain boolean cannot freeze a growing table, so it stays a row default
    expect(/^\s*robashEnabled:\s*true\s*$/m.test(PATCH)).toBe(true)
  })

  it('points at the defaults file instead, so the removal is discoverable', () => {
    expect(PATCH).toContain('whitelist-defaults.json')
  })
})

describe('defaults data file mirrors the built-in constants', () => {
  it('robashAllow mirrors DEFAULT_ROBASH.allow (same order, same entries)', () => {
    expect(DEFAULTS.robashAllow).toEqual([...DEFAULT_ROBASH.allow])
  })

  it('robashGitAllow mirrors DEFAULT_ROBASH.gitAllow', () => {
    expect(DEFAULTS.robashGitAllow).toEqual([...DEFAULT_ROBASH.gitAllow])
  })

  it('robashDeny mirrors DEFAULT_ROBASH.deny', () => {
    expect(DEFAULTS.robashDeny).toEqual([...DEFAULT_ROBASH.deny])
  })

  it('robashPwshAllow mirrors DEFAULT_ROBASH_PWSH.allow', () => {
    expect(DEFAULTS.robashPwshAllow).toEqual([...DEFAULT_ROBASH_PWSH.allow])
  })

  it('robashPwshDeny mirrors DEFAULT_ROBASH_PWSH.deny', () => {
    expect(DEFAULTS.robashPwshDeny).toEqual([...DEFAULT_ROBASH_PWSH.deny])
  })

  it('declares exactly the five tables, so a renamed key cannot go unnoticed', () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual([...WHITELIST_KEYS].sort())
  })
})
