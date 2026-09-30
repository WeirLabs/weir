import { describe, expect, it } from './helpers.js'
import { readFileSync } from 'node:fs'
import { FIELDS } from '../src/settings/sections.js'

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
