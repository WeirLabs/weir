import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDecisionAttempt } from '../../src/decision/evaluator/attempt-pipeline.js'

const profile = { agentId: 'agent-a', revision: 1, userDescription: { revision: 1, text: 'Prefer A' }, scope: { workspaces: ['/repo'], authorizationClasses: ['A'] } }
const request = { entry: 'hook', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
const evidence = [{ evidenceId: 'ev_a', agentId: 'agent-a', source: 'user_decision', locator: { kind: 'case', caseId: 'dc_a' }, scope: { workspaces: ['/repo'] }, status: 'active' }]

function fakeCtx(text, finishKind = 'stop') {
  const calls = { stream: 0, tools: 0, session: 0, otherModel: 0 }
  return {
    calls,
    tools: { register: () => { calls.tools++ } },
    session: { append: () => { calls.session++ } },
    llm: {
      stream: () => {
        calls.stream++
        return (async function * () {
          if (finishKind === 'timeout') {
            await new Promise(() => {})
            return
          }
          if (text) yield { type: 'text-delta', text }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
          yield { type: 'finish', reason: { kind: finishKind, ...(finishKind === 'error' ? { failure: { code: 'UPSTREAM' } } : {}) } }
        })()
      },
      generate: () => { calls.otherModel++ },
    },
  }
}

function run(ctx, overrides = {}) {
  return runDecisionAttempt({
    ctx, profile, request, evidence, modelRoute: { kind: 'resolved', provider: 'p', model: 'm' },
    budgetTokens: 24000, maxOutputTokens: 1600, timeoutMs: 20,
    workspaceKey: '/repo', scope: { workspaces: ['/repo'] }, authorizationClass: 'A', attemptStartedAt: 100,
    ...overrides,
  })
}

test('pipeline returns answer only after all seven gates and preserves pins/usage', async () => {
  const output = { outcome: 'answer', claims: [{ text: 'Use A', evidenceIds: ['ev_a'] }], answers: [{ id: 'q', selected: ['A'] }] }
  const ctx = fakeCtx(JSON.stringify(output))
  const result = await run(ctx)
  assert.equal(result.outcome, 'answer')
  assert.deepEqual(result.answers, output.answers)
  assert.equal(result.gates.gaps.length, 0)
  assert.equal(result.pins.promptVersion, 'evaluator-contract/1')
  assert.equal(result.inputTokens, 10)
  assert.equal(result.outputTokens, 5)
  assert.deepEqual(ctx.calls, { stream: 1, tools: 0, session: 0, otherModel: 0 })
})

test('protocol return and escalate pass through without becoming runtime failures', async () => {
  const returned = await run(fakeCtx(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add the path scope.' })))
  assert.equal(returned.outcome, 'return')
  assert.equal(returned.reasonCode, 'MISSING_CONTEXT')
  const escalated = await run(fakeCtx(JSON.stringify({ outcome: 'escalate', missing: ['A new product judgment is required.'] })))
  assert.equal(escalated.outcome, 'escalate')
  assert.deepEqual(escalated.missing, ['A new product judgment is required.'])
})

for (const [expected, text, finish] of [
  ['model_error', '', 'error'],
  ['invalid_output', 'not json', 'stop'],
  ['truncated', '{"outcome":', 'max-tokens'],
  ['timeout', '', 'timeout'],
]) {
  test(`pipeline classifies ${expected} without protocol laundering`, async () => {
    const result = await run(fakeCtx(text, finish))
    assert.equal(result.outcome, 'failed')
    assert.equal(result.error.kind, expected)
    assert.ok(result.packManifest)
    assert.ok(result.contextPackHash)
  })
}

test('an answer without claim evidence is downgraded by G1, never delivered', async () => {
  const output = { outcome: 'answer', claims: [{ text: 'Guess A', evidenceIds: [] }], answers: [{ id: 'q', selected: ['A'] }] }
  const result = await run(fakeCtx(JSON.stringify(output)))
  assert.equal(result.outcome, 'return')
  assert.equal(result.reasonCode, 'MISSING_CONTEXT')
  assert.equal(result.gates.g1, false)
})

test('fixed-layer overflow escalates before any model, tool or session side effect', async () => {
  const ctx = fakeCtx('')
  const result = await run(ctx, { budgetTokens: 1 })
  assert.equal(result.outcome, 'escalate')
  assert.deepEqual(ctx.calls, { stream: 0, tools: 0, session: 0, otherModel: 0 })
})
