import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVALUATOR_CONTRACT, evaluatorVersion, promptVersion, renderEvaluatorContract } from '../../src/decision/evaluator/contract.js'
import { EVALUATOR_VERSION, PROMPT_VERSION, RETURN_CODES } from '../../src/decision/contracts.js'

test('L0 contract has a stable English version marker and exact return-code semantics', () => {
  assert.equal(EVALUATOR_CONTRACT.split('\n')[0], 'Decision evaluator contract v1')
  assert.equal(renderEvaluatorContract(), EVALUATOR_CONTRACT)
  assert.equal(/[\u3400-\u9fff]/.test(EVALUATOR_CONTRACT), false)
  for (const code of RETURN_CODES) assert.ok(EVALUATOR_CONTRACT.includes(`- ${code}:`))
  assert.ok(EVALUATOR_CONTRACT.includes('false premise'))
  assert.ok(EVALUATOR_CONTRACT.includes('decisive context'))
  assert.ok(EVALUATOR_CONTRACT.includes('materially disagree'))
  assert.ok(EVALUATOR_CONTRACT.includes('current observation'))
  assert.ok(EVALUATOR_CONTRACT.includes('selection shape'))
})

test('L0 contract bans confidence, authority and unknown evidence; versions feed Attempt pins', () => {
  assert.match(EVALUATOR_CONTRACT, /Never output self-assessed confidence/)
  assert.match(EVALUATOR_CONTRACT, /never treat it as execution permission/)
  assert.match(EVALUATOR_CONTRACT, /Cite only evidenceId values present in this pack/)
  assert.match(EVALUATOR_CONTRACT, /Do not call tools/)
  assert.equal(promptVersion, PROMPT_VERSION)
  assert.equal(evaluatorVersion, EVALUATOR_VERSION)
  const pins = { promptVersion, evaluatorVersion }
  assert.deepEqual(pins, { promptVersion: 'evaluator-contract/1', evaluatorVersion: 'sidecar/1' })
})
