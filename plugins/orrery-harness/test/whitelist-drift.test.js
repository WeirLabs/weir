// The preset's whitelist baseline is INVISIBLE at runtime.
//
// DSH composes patch layers by WHOLE-VALUE replacement, not deep merge
// (dsh-app-boot `applyEntryPatches`: `target[key] = value`, and the host README
// says "does not deep-merge"). So when a profile declares its own
// `orrery-settings` row it replaces the bundle's `config` object entirely, and
// the running plugin can no longer see which commands the baseline would have
// allowed. That is how `Start-Sleep` went missing from a live Windows session
// while the repo baseline had it: a stale snapshot in the user's profile row,
// silently shadowing the newer baseline.
//
// This module re-reads the baseline from the bundle's own built patch file and
// reports the drift, so the gap is visible instead of silent. It only reports —
// it never rewrites the user's profile.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from './helpers.js'
import {
  BASELINE_KEYS,
  diffWhitelist,
  readBaselineWhitelists,
  renderDriftWarning,
} from '../src/shared/whitelist-drift.js'

// The exact stale row from a real user profile: the baseline of that day, minus
// the entry that was added later. Reproduces the observed incident.
const STALE_ROW = {
  robashAllow: ['ls', 'cat', 'sleep'],
  robashGitAllow: ['status', 'log'],
  robashDeny: ['rm', 'sudo'],
  robashPwshAllow: ['Get-Content', 'Write-Output', 'git'],
  robashPwshDeny: ['iex', 'Remove-Item'],
}
const CURRENT_BASELINE = {
  robashAllow: ['ls', 'cat', 'sleep'],
  robashGitAllow: ['status', 'log'],
  robashDeny: ['rm', 'sudo'],
  robashPwshAllow: ['Get-Content', 'Write-Output', 'git', 'Start-Sleep'],
  robashPwshDeny: ['iex', 'Remove-Item'],
}

describe('diffWhitelist', () => {
  it('reports nothing when every table matches the baseline', () => {
    expect(diffWhitelist(CURRENT_BASELINE, STALE_ROW)).toBe(null)
  })

  it('reports the entry the baseline gained but the declared row lacks', () => {
    const drift = diffWhitelist(STALE_ROW, CURRENT_BASELINE)
    expect(drift).not.toBe(null)
    expect(drift.missing).toEqual([{ key: 'robashPwshAllow', entry: 'Start-Sleep' }])
  })

  it('ignores entries the declared row ADDS (widening is the user\'s call, not drift)', () => {
    const widened = { ...CURRENT_BASELINE, robashPwshAllow: [...CURRENT_BASELINE.robashPwshAllow, 'Get-ChildItem'] }
    expect(diffWhitelist(widened, CURRENT_BASELINE)).toBe(null)
  })

  it('reports each table independently, in BASELINE_KEYS order', () => {
    const twoMissing = {
      ...CURRENT_BASELINE,
      robashAllow: ['ls'],
      robashPwshAllow: ['git'],
    }
    const drift = diffWhitelist(twoMissing, CURRENT_BASELINE)
    expect(drift.missing).toEqual([
      { key: 'robashAllow', entry: 'cat' },
      { key: 'robashAllow', entry: 'sleep' },
      { key: 'robashPwshAllow', entry: 'Get-Content' },
      { key: 'robashPwshAllow', entry: 'Write-Output' },
      { key: 'robashPwshAllow', entry: 'Start-Sleep' },
    ])
  })

  it('compares the pwsh tables case-insensitively (the guard lowercases before lookup)', () => {
    const lowercased = {
      ...CURRENT_BASELINE,
      robashPwshAllow: ['get-content', 'write-output', 'GIT', 'start-sleep'],
    }
    expect(diffWhitelist(lowercased, CURRENT_BASELINE)).toBe(null)
  })

  it('treats the POSIX tables case-sensitively', () => {
    const wrongCase = { ...CURRENT_BASELINE, robashAllow: ['LS', 'cat', 'sleep'] }
    expect(diffWhitelist(wrongCase, CURRENT_BASELINE)?.missing).toEqual([{ key: 'robashAllow', entry: 'ls' }])
  })

  it('stays silent when the composition declares NO whitelist at all', () => {
    // The integration harness mounts the settings row without robash keys and
    // expects the module defaults to apply; warning there would be noise.
    expect(diffWhitelist({ intentGateProvider: 'mock' }, STALE_ROW)).toBe(null)
    expect(diffWhitelist({}, STALE_ROW)).toBe(null)
    expect(diffWhitelist(null, STALE_ROW)).toBe(null)
  })

  it('treats an explicitly emptied table as an intentional clearing, not drift', () => {
    // "present and empty = authoritative fail-closed" is documented behaviour;
    // same deliberate shape as the settings page offering an empty list.
    const cleared = { ...CURRENT_BASELINE, robashPwshAllow: [] }
    expect(diffWhitelist(cleared, CURRENT_BASELINE)).toBe(null)
  })

  it('skips a table the baseline does not declare, and one declared empty', () => {
    // Narrow fixtures on purpose: the larger STALE/CURRENT pair differs on several
    // tables at once, which would mask the single behaviour under test.
    const baseline = { robashAllow: ['ls', 'cat'], robashPwshAllow: ['Get-Date'] }
    expect(diffWhitelist({ robashAllow: ['ls', 'cat'], robashPwshAllow: [] }, baseline)).toBe(null)
  })
})

describe('renderDriftWarning', () => {
  it('names the module, the keys, and the remediation in English', () => {
    const drift = diffWhitelist(STALE_ROW, CURRENT_BASELINE)
    const text = renderDriftWarning(drift)
    expect(text).toContain('orrery-settings')
    expect(text).toContain('robashPwshAllow')
    expect(text).toContain('Start-Sleep')
    expect(text).toContain('patch row')
    // Template layer is English (AGENTS.md §3.7). The custom expect facade has no
    // not.toMatch, so the negation is expressed as a boolean assertion.
    expect(/[\u4e00-\u9fff]/.test(text)).toBe(false)
  })

  it('caps the listing so a wholesale mismatch cannot flood the log', () => {
    const huge = { robashAllow: Array.from({ length: 40 }, (_, i) => `cmd${i}`) }
    const text = renderDriftWarning(diffWhitelist({ robashAllow: ['ls'] }, huge), 3)
    expect(text).toContain('and 37 more')
    expect(text.length < 400).toBe(true)
  })
})

describe('readBaselineWhitelists', () => {
  it('reads the bundle baseline from disk and yields every table the patch declares', () => {
    const baseline = readBaselineWhitelists()
    for (const key of BASELINE_KEYS) {
      expect(Array.isArray(baseline[key])).toBe(true)
      expect(baseline[key].length).toBeGreaterThan(0)
    }
    // The regression that started all this: the shipped baseline must carry it.
    expect(baseline.robashPwshAllow).toContain('Start-Sleep')
  })

  it('agrees with the schema-declared key list (no table silently left unchecked)', () => {
    const fromDisk = Object.keys(readBaselineWhitelists()).sort()
    expect(fromDisk).toEqual([...BASELINE_KEYS].sort())
  })

  it('returns an empty object rather than throwing when the file is unreadable', () => {
    const baseline = readBaselineWhitelists(() => {
      throw new Error('ENOENT')
    })
    expect(baseline).toEqual({})
    expect(diffWhitelist(STALE_ROW, baseline)).toBe(null)
  })

  it('returns an empty object when the file has no parsable whitelist rows', () => {
    expect(readBaselineWhitelists(() => 'not: [a, patch, file]\n')).toEqual({})
  })

  it('does not throw on a real read (the bundle always ships the patch file)', () => {
    expect(typeof readBaselineWhitelists().robashAllow).toBe('object')
  })
})
