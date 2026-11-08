import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failureOutcome, parseDecision } from '../../src/decision/evaluator/parse.js'

const valid = {
  outcome: 'answer',
  claims: [{ text: 'Use A', evidenceIds: ['ev_a'] }],
  answers: [{ id: 'q', selected: ['A'] }],
}
const parse = value => parseDecision(typeof value === 'string' ? value : JSON.stringify(value), { evidenceIds: ['ev_a'] })

test('valid and fenced JSON parse into the strict protocol envelope', () => {
  assert.deepEqual(parse(valid), valid)
  assert.deepEqual(parse(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``), valid)
  assert.deepEqual(parse(`prefix ${JSON.stringify(valid)} suffix`), valid)
})

test('truncated and non-JSON output have different classified failures', () => {
  assert.equal(parse('{"outcome":"answer","claims":[').error.kind, 'truncated')
  const invalid = parse('Which title? definitely A')
  assert.equal(invalid.error.kind, 'invalid_output')
  assert.ok(invalid.error.detail.length <= 200)
  assert.ok(!invalid.error.detail.includes('Which title?'))
})

test('unknown evidence, unknown fields and empty claims are invalid output', () => {
  for (const value of [
    { ...valid, claims: [{ text: 'Invented', evidenceIds: ['ev_unknown'] }] },
    { ...valid, confidence: 0.99 },
    { ...valid, claims: [] },
    { ...valid, claims: [{ text: 'A', evidenceIds: ['ev_a'], extra: true }] },
  ]) {
    const result = parse(value)
    assert.equal(result.outcome, 'failed')
    assert.equal(result.error.kind, 'invalid_output')
    assert.ok(result.error.detail.length <= 200)
  }
})

test('scale limits reject too many claims, citations and answers', () => {
  for (const value of [
    { ...valid, claims: Array.from({ length: 33 }, (_, index) => ({ text: `c${index}`, evidenceIds: ['ev_a'] })) },
    { ...valid, claims: [{ text: 'A', evidenceIds: Array.from({ length: 9 }, (_, index) => index === 0 ? 'ev_a' : `ev_${index}`) }] },
    { ...valid, answers: Array.from({ length: 17 }, (_, index) => ({ id: `q${index}`, selected: ['A'] })) },
  ]) assert.equal(parse(value).error.kind, 'invalid_output')
})

test('return requires a known code and actionable bounded hint', () => {
  const returned = parseDecision(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add the missing path scope.' }))
  assert.deepEqual(returned, { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add the missing path scope.' })
  for (const value of [
    { outcome: 'return', reasonCode: 'UNKNOWN', hint: 'Fix it' },
    { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: '' },
    { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'x'.repeat(401) },
  ]) assert.equal(parse(value).error.kind, 'invalid_output')
})

test('runtime model error, timeout, truncation and abort remain separate from protocol outcomes', () => {
  for (const kind of ['model_error', 'timeout', 'truncated', 'aborted']) {
    const result = parseDecision('ignored', { finishReason: kind })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.error.kind, kind)
  }
  assert.deepEqual(failureOutcome('model_error', 'UPSTREAM_429').error, {
    kind: 'model_error', code: 'UPSTREAM_429', detail: 'The configured evaluator model failed',
  })
})
