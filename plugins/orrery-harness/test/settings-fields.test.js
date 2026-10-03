import { describe, expect, it } from './helpers.js'
import { readFileSync } from 'node:fs'
import { EDIT_LOCK_DEFAULTS, FIELDS, editLockLimits } from '../src/settings/sections.js'

// Drift防线：settings 键的三处表示（sections.js 的 FIELDS / cordis.patch.yml
// 行 config 的产品默认镜像 / 设置页 GROUPS 字段集）由本对拍测试守卫——
// D5 显式拒绝跨运行时统一（ModuleLoader 同包同步 require 不可能 + YAML 层），
// 代价是新增字段要改三处，本测试让"忘了改"变成响亮失败。
// 刻意不在设置页出现的配置面键（见 category-delegation.md:35）：
const CONFIG_FACE_ONLY = new Set(['robashDefaultsPath', 'robashDefaultsReload'])
// §3.8 例外：五张 whitelist 表的默认值住 whitelist-defaults.json，
// 绝不出现在 patch 行 config（整值替换契约会冻结它们）。
const WHITELIST_TABLE_KEYS = new Set(['robashAllow', 'robashGitAllow', 'robashDeny', 'robashPwshAllow', 'robashPwshDeny'])

const fieldKeys = new Set(FIELDS.map(({ key }) => key))

function patchRowKeys() {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rowStart = patch.indexOf('- id: orrery-settings')
  const rowEnd = patch.indexOf('- id:', rowStart + 1)
  const row = patch.slice(rowStart, rowEnd)
  const keys = new Set()
  for (const match of row.matchAll(/^ {8}(\w+):/gm)) keys.add(match[1])
  return keys
}

function settingsPageFields() {
  const page = readFileSync(new URL('../lib/client.settings-page.js', import.meta.url), 'utf8')
  const fields = new Set()
  for (const match of page.matchAll(/field: "(\w+)"/g)) fields.add(match[1])
  return fields
}

describe('settings field-key parity (FIELDS ↔ patch row ↔ settings page)', () => {
  it('every mirrored product default in the patch row resolves to a declared field', () => {
    const row = patchRowKeys()
    expect(row.size).toBeGreaterThan(0)
    for (const key of row) expect(fieldKeys.has(key), `patch row key ${key} is not declared in FIELDS`).toBe(true)
  })

  it('no whitelist table key ever appears in the patch row (§3.8 whole-value replacement)', () => {
    const row = patchRowKeys()
    for (const key of WHITELIST_TABLE_KEYS) expect(row.has(key), `whitelist table ${key} must not ride the patch row`).toBe(false)
  })

  it('the settings page shows exactly FIELDS minus the config-face-only keys', () => {
    const page = settingsPageFields()
    const expected = new Set([...fieldKeys].filter((key) => !CONFIG_FACE_ONLY.has(key)))
    expect([...page].sort()).toEqual([...expected].sort())
  })
})

// Edit Lock retention policy: the defaults are the contract other sessions rely
// on (how long a file stays locked after a turn ends), so a missing or unusable
// value must fall back or fail loud — never be silently clamped.
describe('editLockLimits (retention policy resolution)', () => {
  it('falls back to the documented defaults when nothing is configured', () => {
    expect(editLockLimits(undefined)).toEqual(EDIT_LOCK_DEFAULTS)
    expect(editLockLimits({})).toEqual(EDIT_LOCK_DEFAULTS)
    expect(EDIT_LOCK_DEFAULTS).toEqual({
      holdDefaultMinutes: 30, holdSingleMaxMinutes: 30, holdCumulativeMaxMinutes: 120,
      nudgeAttempts: 2, nudgeFallback: 'release',
    })
  })

  it('overlays each configured value and accepts a value equal to its default', () => {
    expect(editLockLimits({ holdSingleMaxMinutes: 30 }).holdSingleMaxMinutes).toBe(30)
    expect(editLockLimits({ holdDefaultMinutes: 5, holdSingleMaxMinutes: 60, holdCumulativeMaxMinutes: 180 })
      .holdDefaultMinutes).toBe(5)
    expect(editLockLimits({ nudgeAttempts: 0 }).nudgeAttempts).toBe(0)
    expect(editLockLimits({ nudgeFallback: 'abnormal' }).nudgeFallback).toBe('abnormal')
  })

  it('accepts a cumulative cap exactly equal to the single cap and rejects a smaller one', () => {
    expect(editLockLimits({ holdSingleMaxMinutes: 30, holdCumulativeMaxMinutes: 30 }).holdCumulativeMaxMinutes).toBe(30)
    expect(() => editLockLimits({ holdSingleMaxMinutes: 60, holdCumulativeMaxMinutes: 30 }))
      .toThrow(/editLockHoldCumulativeMaxMinutes must be at least editLockHoldSingleMaxMinutes/)
  })

  it('names the flat settings key when a present value is unusable', () => {
    expect(() => editLockLimits({ holdDefaultMinutes: 0 })).toThrow(/editLockHoldDefaultMinutes/)
    expect(() => editLockLimits({ holdDefaultMinutes: 'soon' })).toThrow(/editLockHoldDefaultMinutes/)
    expect(() => editLockLimits({ holdSingleMaxMinutes: -5 })).toThrow(/editLockHoldSingleMaxMinutes/)
    expect(() => editLockLimits({ holdCumulativeMaxMinutes: Number.NaN })).toThrow(/editLockHoldCumulativeMaxMinutes/)
    expect(() => editLockLimits({ nudgeAttempts: 1.5 })).toThrow(/editLockNudgeAttempts must be a non-negative integer/)
    expect(() => editLockLimits({ nudgeAttempts: -1 })).toThrow(/editLockNudgeAttempts/)
    expect(() => editLockLimits({ nudgeFallback: 'auto' })).toThrow(/editLockNudgeFallback must be "release" or "abnormal"/)
  })

  it('returns a frozen policy so callers cannot widen a cap in place', () => {
    const limits = editLockLimits({})
    expect(Object.isFrozen(limits)).toBe(true)
    expect(() => { limits.holdSingleMaxMinutes = 9999 }).toThrow()
  })
})

describe('editLockLimits default/single coherence', () => {
  it('refuses a default retention longer than the single cap, so a plain hold is never refused', () => {
    expect(() => editLockLimits({ holdDefaultMinutes: 45 })).toThrow(/editLockHoldDefaultMinutes must not exceed editLockHoldSingleMaxMinutes/)
    expect(editLockLimits({ holdDefaultMinutes: 45, holdSingleMaxMinutes: 60, holdCumulativeMaxMinutes: 120 }).holdDefaultMinutes).toBe(45)
  })
})

describe('settings page boolean defaults', () => {
  it('every switch default the page assumes equals the bundle row product default', async () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const rowStart = patch.indexOf('- id: orrery-settings')
    const row = patch.slice(rowStart, patch.indexOf('- id:', rowStart + 1))
    const page = readFileSync(new URL('../lib/client.settings-page.js', import.meta.url), 'utf8')
    const block = page.slice(page.indexOf('const BOOLEAN_DEFAULTS = {'), page.indexOf('};', page.indexOf('const BOOLEAN_DEFAULTS = {')))
    const entries = [...block.matchAll(/(\w+): (true|false)/g)].map((match) => [match[1], match[2]])
    expect(entries.length).toBeGreaterThan(0)
    for (const [key, value] of entries) {
      const declared = new RegExp(`^ {8}${key}: (true|false)$`, 'm').exec(row)?.[1]
      expect(declared, `${key} must be a boolean product default in the patch row`).toBe(value)
    }
    expect(entries.map(([key]) => key)).toContain('worktreeEnabled')
    expect(entries.map(([key]) => key)).toContain('worktreeAutoSetup')
  })
})
