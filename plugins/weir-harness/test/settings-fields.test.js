import { describe, expect, it } from './helpers.js'
import { readFileSync } from 'node:fs'
import { EDIT_LOCK_DEFAULTS, FIELD_DEFAULTS, FIELDS, RESTART_KEYS, computeSections, editLockLimits } from '../src/settings/sections.js'
import { DEFAULT_CLASSIFIER_TIMEOUT_MS } from '../src/intent-gate/classifier.js'
import { DEFAULT_SUPERVISION } from '../src/delegate/group-coordinator.js'
import { DEFAULTS as TODO_DEFAULTS } from '../src/todo-driver/state-machine.js'
import { PRESSURE_DEFAULTS } from '../src/context-guard/pressure.js'
import { LSP_DEFAULTS } from '../src/lsp/manager.js'
import { APPROVE_MODES } from '../src/worktree/projection.js'
import { DEFAULTS as WORKTREE_DEFAULTS, resolveApproveMode } from '../src/worktree/index.js'
import { DEFAULT_ROOT } from '../src/worktree/rules.js'
import { DEFAULT_WATCH_TIMEOUT_MINUTES } from '../src/worktree/watches.js'
import { DEFAULTS as NOTIFY_DEFAULTS } from '../src/notify/policy.js'

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
  const rowStart = patch.indexOf('- id: weir-settings')
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

// FIELD_DEFAULTS（产品默认值的唯一声明，sections.js）：四层对拍——
// ① 声明本体（39 键、冻结、unset 有语义的键无条目）；② ↔ 可导入的模块
// 常量（源头）；③ ↔ 客户端 chunk 手维护镜像（ModuleLoader 同包同步
// require 不可能的既定代价，raw 文本提取）；④ ↔ cordis.patch.yml
// weir-settings 行（raw 文本提取，不引入 yaml 依赖）。
// unset 有语义、刻意无默认条目的键：
const NO_DEFAULT_KEYS = [
  'intentGateProvider', 'intentGateModel', 'intentGateReasoningEffort',
  'jevEndpoint', 'jevApiKeyEnv',
  'delegateCategoryChains', 'delegateAgentChains', 'delegateDisabledCategories',
  'robashAllow', 'robashGitAllow', 'robashDeny', 'robashPwshAllow', 'robashPwshDeny',
  'robashDefaultsPath', 'robashDefaultsReload', 'lspServers',
]

function coerceRowValue(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

function patchRowEntries() {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rowStart = patch.indexOf('- id: weir-settings')
  const row = patch.slice(rowStart, patch.indexOf('- id:', rowStart + 1))
  const entries = new Map()
  for (const match of row.matchAll(/^ {8}(\w+): (.+)$/gm)) entries.set(match[1], match[2])
  return entries
}

function chunkFieldDefaults() {
  const page = readFileSync(new URL('../lib/client.settings-page.js', import.meta.url), 'utf8')
  const start = page.indexOf('const FIELD_DEFAULTS = Object.freeze({')
  if (start < 0) throw new Error('client.settings-page.js: frozen FIELD_DEFAULTS literal not found')
  const block = page.slice(start, page.indexOf('})', start))
  const entries = new Map()
  for (const match of block.matchAll(/(\w+): (".+"|true|false|[\d.]+),?/g)) {
    const raw = match[2]
    entries.set(match[1], raw === 'true' ? true : raw === 'false' ? false : raw.startsWith('"') ? raw.slice(1, -1) : Number(raw))
  }
  return entries
}

describe('FIELD_DEFAULTS (canonical product-default declaration)', () => {
  it('declares exactly the 41 concrete defaults, frozen, with no entry where unset is meaningful', () => {
    expect(Object.isFrozen(FIELD_DEFAULTS)).toBe(true)
    expect(Object.keys(FIELD_DEFAULTS)).toHaveLength(41)
    for (const key of NO_DEFAULT_KEYS) {
      expect(Object.hasOwn(FIELD_DEFAULTS, key), `${key} must stay unset-meaningful (no default entry)`).toBe(false)
    }
    for (const key of Object.keys(FIELD_DEFAULTS)) {
      expect(fieldKeys.has(key), `FIELD_DEFAULTS key ${key} is not declared in FIELDS`).toBe(true)
    }
  })

  it('agrees with every importable module constant (source of truth)', () => {
    expect(FIELD_DEFAULTS.intentGateTimeoutMs).toBe(DEFAULT_CLASSIFIER_TIMEOUT_MS)
    expect(FIELD_DEFAULTS.supervisionMaxRetries).toBe(DEFAULT_SUPERVISION.maxRetries)
    expect(FIELD_DEFAULTS.supervisionInitialBackoffMs).toBe(DEFAULT_SUPERVISION.initialBackoffMs)
    expect(FIELD_DEFAULTS.supervisionMaxBackoffMs).toBe(DEFAULT_SUPERVISION.maxBackoffMs)
    expect(FIELD_DEFAULTS.todoEnabled).toBe(TODO_DEFAULTS.enabled)
    expect(FIELD_DEFAULTS.todoMaxConsecutive).toBe(TODO_DEFAULTS.maxConsecutive)
    expect(FIELD_DEFAULTS.todoErrorRetryMax).toBe(TODO_DEFAULTS.errorRetryMax)
    expect(FIELD_DEFAULTS.todoErrorBackoffBaseMs).toBe(TODO_DEFAULTS.errorBackoffBaseMs)
    expect(FIELD_DEFAULTS.todoErrorBackoffCapMs).toBe(TODO_DEFAULTS.errorBackoffCapMs)
    expect(FIELD_DEFAULTS.guardEnabled).toBe(PRESSURE_DEFAULTS.enabled)
    expect(FIELD_DEFAULTS.guardSoftThreshold).toBe(PRESSURE_DEFAULTS.softThreshold)
    expect(FIELD_DEFAULTS.guardHardThreshold).toBe(PRESSURE_DEFAULTS.hardThreshold)
    expect(FIELD_DEFAULTS.editLockHoldDefaultMinutes).toBe(EDIT_LOCK_DEFAULTS.holdDefaultMinutes)
    expect(FIELD_DEFAULTS.editLockHoldSingleMaxMinutes).toBe(EDIT_LOCK_DEFAULTS.holdSingleMaxMinutes)
    expect(FIELD_DEFAULTS.editLockHoldCumulativeMaxMinutes).toBe(EDIT_LOCK_DEFAULTS.holdCumulativeMaxMinutes)
    expect(FIELD_DEFAULTS.editLockNudgeAttempts).toBe(EDIT_LOCK_DEFAULTS.nudgeAttempts)
    expect(FIELD_DEFAULTS.editLockNudgeFallback).toBe(EDIT_LOCK_DEFAULTS.nudgeFallback)
    expect(FIELD_DEFAULTS.lspIdleMs).toBe(LSP_DEFAULTS.idleMs)
    expect(FIELD_DEFAULTS.lspRequestTimeoutMs).toBe(LSP_DEFAULTS.requestTimeoutMs)
    expect(FIELD_DEFAULTS.lspDiagnosticsWaitMs).toBe(LSP_DEFAULTS.diagnosticsWaitMs)
    expect(FIELD_DEFAULTS.worktreeEnabled).toBe(WORKTREE_DEFAULTS.enabled)
    expect(FIELD_DEFAULTS.worktreeRoot).toBe(DEFAULT_ROOT)
    expect(FIELD_DEFAULTS.worktreeRoot).toBe(WORKTREE_DEFAULTS.root)
    expect(FIELD_DEFAULTS.worktreeMaxActive).toBe(WORKTREE_DEFAULTS.maxActive)
    expect(FIELD_DEFAULTS.worktreeAutoSetup).toBe(WORKTREE_DEFAULTS.autoSetup)
    expect(FIELD_DEFAULTS.worktreeWatchTimeoutMinutes).toBe(DEFAULT_WATCH_TIMEOUT_MINUTES)
    expect(FIELD_DEFAULTS.worktreeWatchTimeoutMinutes).toBe(WORKTREE_DEFAULTS.watchTimeoutMinutes)
    expect(FIELD_DEFAULTS.worktreeAutoApprove).toBe('auto-clean')
    expect(FIELD_DEFAULTS.worktreeAutoApprove).toBe(resolveApproveMode(undefined, undefined))
    expect(FIELD_DEFAULTS.notifyEnabled).toBe(NOTIFY_DEFAULTS.enabled)
    expect(FIELD_DEFAULTS.notifyOnComplete).toBe(NOTIFY_DEFAULTS.onComplete)
    expect(FIELD_DEFAULTS.notifyOnAttention).toBe(NOTIFY_DEFAULTS.onAttention)
    expect(FIELD_DEFAULTS.notifyMinTurnSeconds).toBe(NOTIFY_DEFAULTS.minTurnSeconds)
    expect(FIELD_DEFAULTS.notifySound).toBe(NOTIFY_DEFAULTS.sound)
    expect(FIELD_DEFAULTS.notifyForeground).toBe(NOTIFY_DEFAULTS.foreground)
  })

  it('the client chunk mirrors it verbatim (exact key set, values, frozen literal)', () => {
    const mirror = chunkFieldDefaults()
    expect([...mirror.keys()].sort()).toEqual([...Object.keys(FIELD_DEFAULTS)].sort())
    for (const [key, value] of mirror) {
      expect(value, `chunk FIELD_DEFAULTS.${key} drifted from sections.js`).toEqual(FIELD_DEFAULTS[key])
    }
  })

  it('the patch row mirrors it: every row key is a FIELD_DEFAULTS key with the same value', () => {
    const entries = patchRowEntries()
    // the 32 row keys are a subset of FIELD_DEFAULTS keys; the deliberate
    // absences (whitelist tables, defaultsPath/Reload) are covered by the
    // dedicated tests above, not required here
    expect(entries.size).toBe(32)
    for (const [key, raw] of entries) {
      expect(Object.hasOwn(FIELD_DEFAULTS, key), `patch row key ${key} has no FIELD_DEFAULTS entry`).toBe(true)
      expect(FIELD_DEFAULTS[key], `patch row value of ${key} drifted from FIELD_DEFAULTS`).toEqual(coerceRowValue(raw))
    }
  })

  it('the boolean subset is exactly the 14 switch defaults the patch row declares', () => {
    const booleans = Object.entries(FIELD_DEFAULTS).filter(([, value]) => typeof value === 'boolean')
    expect(booleans).toHaveLength(14)
    const row = patchRowEntries()
    for (const [key, value] of booleans) {
      expect(row.get(key), `${key} must ride the patch row as a boolean product default`).toBe(String(value))
    }
  })
})

describe('RESTART_KEYS (restart-required settings declaration)', () => {
  // 重启生效键的唯一声明住 FIELDS 的 restart 标记；本清单是全量对拍——
  // 增删重启键必须显式改这里，漂移即红。消费侧快照语义见
  // docs/features/category-delegation.md 的插件快照注记。
  const EXPECTED = [
    'intentGateClassifier', 'intentGateProvider', 'intentGateModel', 'intentGateReasoningEffort',
    'intentGateTimeoutMs', 'jevEndpoint', 'jevModel', 'jevApiKeyEnv',
    'todoEnabled', 'todoMaxConsecutive', 'todoErrorRetryMax', 'todoErrorBackoffBaseMs', 'todoErrorBackoffCapMs',
    'guardEnabled', 'guardSoftThreshold', 'guardHardThreshold',
    'hashlineHideStockEdit', 'editLockEnabled',
  ]

  it('contains exactly the restart-required keys in declaration order', () => {
    expect([...RESTART_KEYS]).toEqual(EXPECTED)
  })

  it('is derived from the FIELDS restart markers (declared once, no second list)', () => {
    expect(RESTART_KEYS).toEqual(FIELDS.filter(({ restart }) => restart).map(({ key }) => key))
  })

  it('is frozen so consumers cannot widen or reorder it in place', () => {
    expect(Object.isFrozen(RESTART_KEYS)).toBe(true)
  })
})

describe('editLockAutoResume (message-driven auto-resume switch)', () => {
  // D5: the row is declared once in FIELDS; the runtime judges the section per
  // message as `autoResume !== false`, so a missing key (old profile, or the
  // patch default not yet declared by the main session) means ON.
  it('declares the editLock.autoResume field row, live (no restart marker)', () => {
    const row = FIELDS.find(({ key }) => key === 'editLockAutoResume')
    expect(row).toEqual({
      key: 'editLockAutoResume', section: 'editLock', field: 'autoResume', type: 'boolean',
      description: 'Edit Lock: a genuine user message automatically resumes a stopped session and confirms its retained files (default on)',
    })
    expect(RESTART_KEYS.includes('editLockAutoResume')).toBe(false)
  })

  it('the autoResume !== false judgment defaults on; only an explicit false gates off', () => {
    // The same section shape the weirSettings service publishes, judged with
    // the runtime's exact predicate (src/edit-lock/index.js user/message branch).
    const gate = (config) => computeSections(config).editLock?.autoResume !== false
    expect(gate({})).toBe(true)
    expect(gate({ editLockAutoResume: true })).toBe(true)
    expect(gate({ editLockAutoResume: false })).toBe(false)
  })
})

describe('editLockStaleSweep (message-triggered stale-lock sweep switch)', () => {
  // Same declaration style as editLockAutoResume: the row lives once in
  // FIELDS; the runtime judges the section per message as
  // `staleSweep !== false`, so a missing key means ON.
  it('declares the editLock.staleSweep field row, live (no restart marker)', () => {
    const row = FIELDS.find(({ key }) => key === 'editLockStaleSweep')
    expect(row).toEqual({
      key: 'editLockStaleSweep', section: 'editLock', field: 'staleSweep', type: 'boolean',
      description: 'Edit Lock: a genuine user message silently releases locks whose target file no longer exists (default on; read per message, applies immediately)',
    })
    expect(RESTART_KEYS.includes('editLockStaleSweep')).toBe(false)
  })

  it('the staleSweep !== false judgment defaults on; only an explicit false gates off', () => {
    const gate = (config) => computeSections(config).editLock?.staleSweep !== false
    expect(gate({})).toBe(true)
    expect(gate({ editLockStaleSweep: true })).toBe(true)
    expect(gate({ editLockStaleSweep: false })).toBe(false)
  })
})

describe('worktreeAutoApprove (worktree auto-approve mode)', () => {
  it('declares the union row once in FIELDS, matching the APPROVE_MODES vocabulary', () => {
    const row = FIELDS.find(({ key }) => key === 'worktreeAutoApprove')
    expect(row).toEqual({
      key: 'worktreeAutoApprove', section: 'worktree', field: 'autoApprove', type: { union: APPROVE_MODES },
      description: 'Worktree auto-approve mode: manual shows every decision card; auto-keep auto-approves merges and abandons, removing the worktree but keeping the branch; auto-clean also deletes the branch. The initial mode for sessions without a /worktree approve override (default auto-clean); a session override wins over this global value',
    })
    expect(RESTART_KEYS.includes('worktreeAutoApprove')).toBe(false)
  })

  it('the resolver prefers a valid session override over a valid global value, then the module default', () => {
    expect(resolveApproveMode('manual', 'auto-clean')).toBe('manual')
    expect(resolveApproveMode('auto-keep', 'auto-clean')).toBe('auto-keep')
    expect(resolveApproveMode(null, 'auto-keep')).toBe('auto-keep')
    expect(resolveApproveMode('sometimes', 'auto-keep')).toBe('auto-keep')
    expect(resolveApproveMode(undefined, 'sometimes')).toBe('auto-clean')
    expect(resolveApproveMode(null, undefined)).toBe('auto-clean')
  })
})
