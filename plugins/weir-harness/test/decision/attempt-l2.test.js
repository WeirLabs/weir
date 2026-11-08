import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDecisionAttempt } from '../../src/decision/evaluator/attempt-pipeline.js'
import { EVALUATOR_CONTRACT, evaluatorVersion, promptVersion } from '../../src/decision/evaluator/contract.js'

const profile = { agentId: 'agent-a', revision: 1, userDescription: { revision: 1, text: 'Prefer A' }, scope: { workspaces: ['/repo'] } }
const request = { entry: 'hook', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
const L2 = {
  schemaVersion: 1, status: 'populated', snapshotId: 'ms_only', snapshotRevision: 1, snapshotHash: 'c'.repeat(64),
  items: [{
    schemaVersion: 1, kind: 'reviewed_principle', principleId: 'pr_only', text: 'Prefer A',
    scope: { workspaces: ['/repo'] }, sources: ['dc_unavailable'], evidenceIds: [],
  }],
  exclusions: [],
}

async function run(output) {
  const calls = { stream: 0, tools: 0, session: 0 }
  const requests = []
  const ctx = {
    tools: { register: () => { calls.tools++ } },
    session: { append: () => { calls.session++ } },
    llm: { stream: options => {
      calls.stream++
      requests.push(options)
      return (async function * () {
        yield { type: 'text-delta', text: JSON.stringify(output) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    } },
  }
  const result = await runDecisionAttempt({
    ctx, profile, request, evidence: [], memory: { L2, L3: [] },
    modelRoute: { kind: 'resolved', provider: 'p', model: 'm' },
    budgetTokens: 24_000, maxOutputTokens: 1_600, timeoutMs: 20,
    workspaceKey: '/repo', scope: { workspaces: ['/repo'] }, attemptStartedAt: 100,
    conflictPairs: [], currentObservationHashes: {},
  })
  return { result, calls, requests }
}

test('only-L2 answers and Snapshot/principle citations cannot satisfy G1 or become an answer', async () => {
  const cited = await run({
    outcome: 'answer', claims: [{ text: 'Trust the summary', evidenceIds: ['pr_only'] }],
    answers: [{ id: 'q', selected: ['A'] }],
  })
  assert.equal(cited.result.outcome, 'failed')
  assert.equal(cited.result.error.kind, 'invalid_output')
  assert.deepEqual(cited.result.packManifest.evidenceIds, [])
  assert.match(cited.requests[0].system, /Decision evaluator contract v3/)
  assert.equal('temperature' in cited.requests[0], false)
  assert.deepEqual(cited.calls, { stream: 1, tools: 0, session: 0 })

  const unsupported = await run({
    outcome: 'answer', claims: [{ text: 'Trust only the summary', evidenceIds: [] }],
    answers: [{ id: 'q', selected: ['A'] }],
  })
  assert.equal(unsupported.result.outcome, 'return')
  assert.equal(unsupported.result.reasonCode, 'MISSING_CONTEXT')
  assert.equal(unsupported.result.gates.g1, false)
})

test('evaluator-contract/3 marks reviewed L2 as non-authoritative without changing sidecar versioning', () => {
  assert.equal(promptVersion, 'evaluator-contract/3')
  assert.equal(EVALUATOR_CONTRACT.split('\n')[0], 'Decision evaluator contract v3')
  assert.match(EVALUATOR_CONTRACT, /L2.*reviewed.*non-authoritative/is)
  assert.match(EVALUATOR_CONTRACT, /L2.*cannot.*satisfy.*G1/is)
  assert.match(EVALUATOR_CONTRACT, /Never cite.*Snapshot.*principle/is)
  assert.equal(evaluatorVersion, 'sidecar/1')
})
