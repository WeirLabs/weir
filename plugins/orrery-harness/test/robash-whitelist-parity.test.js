// The preset row and the module defaults must not drift apart.
//
// `cordis.patch.yml` carries `robashPwshAllow`/`robashPwshDeny` as the preset's
// COMPOSITION BASE, and the settings layer merges last and authoritatively
// (src/delegate/index.js `robashNow`). So a module-default edit that is not
// mirrored into the patch row is INERT in the shipped preset: the unit tests
// above pass (they build their lists from DEFAULT_ROBASH_PWSH) while every real
// Windows session keeps refusing the command. That drift is exactly how
// `Start-Sleep` came to be missing from the guard's reachable allow list, so it
// gets a test instead of a comment.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from './helpers.js'
import { DEFAULT_ROBASH_PWSH } from '../src/delegate/robash-guard-pwsh.js'
import { DEFAULT_ROBASH } from '../src/delegate/robash-guard.js'

const PATCH = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/** Read one `key: '<json array>'` row from the patch file. */
function patchList(key) {
  const match = PATCH.match(new RegExp(`^\\s*${key}:\\s*'(\\[.*?\\])'\\s*$`, 'm'))
  if (!match) throw new Error(`cordis.patch.yml: no single-quoted JSON row for ${key}`)
  return JSON.parse(match[1])
}

describe('preset patch mirrors the module whitelists', () => {
  it('robashPwshAllow mirrors DEFAULT_ROBASH_PWSH.allow (same order, same entries)', () => {
    expect(patchList('robashPwshAllow')).toEqual([...DEFAULT_ROBASH_PWSH.allow])
  })

  it('robashPwshDeny mirrors DEFAULT_ROBASH_PWSH.deny', () => {
    expect(patchList('robashPwshDeny')).toEqual([...DEFAULT_ROBASH_PWSH.deny])
  })

  it('robashAllow mirrors DEFAULT_ROBASH.allow', () => {
    expect(patchList('robashAllow')).toEqual([...DEFAULT_ROBASH.allow])
  })

  it('robashDeny mirrors DEFAULT_ROBASH.deny', () => {
    expect(patchList('robashDeny')).toEqual([...DEFAULT_ROBASH.deny])
  })

  it('robashGitAllow mirrors DEFAULT_ROBASH.gitAllow', () => {
    expect(patchList('robashGitAllow')).toEqual([...DEFAULT_ROBASH.gitAllow])
  })
})

describe('the wait primitive is allow-listed on both platforms', () => {
  it('pwsh allows Start-Sleep, the counterpart of the POSIX sleep entry', () => {
    expect([...DEFAULT_ROBASH_PWSH.allow].map((entry) => entry.toLowerCase())).toContain('start-sleep')
    expect([...DEFAULT_ROBASH.allow]).toContain('sleep')
  })
})
