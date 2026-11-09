import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FIELD_DEFAULTS } from '../../weir-harness/src/settings/sections.js'

const KEYS = ['decisionAgentSelectorDefault', 'decisionAgentAutoShadow', 'decisionAgentAutoAnswerClasses']

function rowEntries(file, id) {
  const patch = readFileSync(new URL(file, import.meta.url), 'utf8')
  const start = patch.indexOf(`- id: ${id}`)
  assert.notEqual(start, -1, `${id} must exist`)
  const end = patch.indexOf('- id:', start + 1)
  const row = patch.slice(start, end < 0 ? patch.length : end)
  return new Map([...row.matchAll(/^ {8}(\w+): (.+)$/gm)].map((match) => [match[1], match[2]]))
}

function scalar(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === "'[]'") return '[]'
  return raw
}

test('production and headless settings overlays mirror the conservative Auto defaults', () => {
  const production = rowEntries('../../weir-harness/cordis.patch.yml', 'weir-settings')
  const headless = rowEntries('../cordis.patch.yml', 'weir-it-settings')
  for (const key of KEYS) {
    assert.equal(scalar(production.get(key)), FIELD_DEFAULTS[key], `production ${key}`)
    assert.equal(scalar(headless.get(key)), FIELD_DEFAULTS[key], `headless ${key}`)
  }
  assert.equal(production.get('decisionAgentsEnabled'), 'false')
  assert.equal(production.get('decisionAgentSelectorDefault'), 'off')
  assert.equal(production.get('decisionAgentAutoShadow'), 'false')
  assert.equal(production.get('decisionAgentAutoAnswerClasses'), "'[]'")
})
