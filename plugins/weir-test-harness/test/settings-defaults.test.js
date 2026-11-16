import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FIELD_DEFAULTS } from '../../weir-harness/src/settings/sections.js'

const KEYS = ['decisionAgentSelectorDefault', 'decisionAgentAutoShadow']

function rowEntries(file, id) {
  const patch = readFileSync(new URL(file, import.meta.url), 'utf8')
  const start = patch.indexOf(`- id: ${id}`)
  assert.notEqual(start, -1, `${id} must exist`)
  const end = patch.indexOf('- id:', start + 1)
  const row = patch.slice(start, end < 0 ? patch.length : end)
  return new Map([...row.matchAll(/^ {8}(\w+): (.+)$/gm)].map((match) => [match[1], match[2]]))
}

function scalar(raw, env = {}) {
  if (raw?.startsWith('!!js ')) return Function('process', `return (${raw.slice(5)})`)({ env })
  if (raw === 'true') return true
  if (raw === 'false') return false
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
  assert.equal(production.get('decisionAgentAutoAnswer'), 'false')
  // The retired authorization-class array never rides a row again.
  assert.equal(production.has('decisionAgentAutoAnswerClasses'), false)
  assert.equal(headless.has('decisionAgentAutoAnswerClasses'), false)
})

test('scenario Auto overrides are opt-in and unset values retain conservative field defaults', () => {
  const headless = rowEntries('../cordis.patch.yml', 'weir-it-settings')
  assert.equal(scalar(headless.get('decisionAgentAutoAnswer')), FIELD_DEFAULTS.decisionAgentAutoAnswer)
  assert.equal(scalar(headless.get('decisionAgentSelectorDefault')), FIELD_DEFAULTS.decisionAgentSelectorDefault)
  assert.equal(scalar(headless.get('decisionAgentSelectorDefault'), { WEIR_IT_DECISION_SELECTOR_DEFAULT: 'auto' }), 'auto')
  assert.equal(scalar(headless.get('decisionAgentAutoAnswer'), { WEIR_IT_DECISION_AUTO_ANSWER: '1' }), true)
  assert.equal(scalar(headless.get('decisionAgentAutoAnswer'), { WEIR_IT_DECISION_AUTO_ANSWER: '' }), false)
  assert.equal(scalar(headless.get('decisionAgentAnswerTimeoutMs')), FIELD_DEFAULTS.decisionAgentAnswerTimeoutMs)
  assert.equal(scalar(headless.get('decisionAgentAnswerTimeoutMs'), { WEIR_IT_DECISION_TIMEOUT_MS: '100' }), 100)
  assert.equal(scalar(headless.get('decisionAgentMaxAttemptsPerCase')), FIELD_DEFAULTS.decisionAgentMaxAttemptsPerCase)
  assert.equal(scalar(headless.get('decisionAgentMaxAttemptsPerCase'), { WEIR_IT_DECISION_MAX_ATTEMPTS: '8' }), 8)
})
