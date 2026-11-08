import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDecisionAttempt } from '../../src/decision/evaluator/attempt-pipeline.js'
import { buildContextPack } from '../../src/decision/evaluator/pack.js'

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
  assert.equal(result.pins.promptVersion, 'evaluator-contract/3')
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

const neutralMemory = {
  L2: { schemaVersion: 1, status: 'empty', snapshotId: null, items: [] },
  L3: [{
    schemaVersion: 1, kind: 'neutral_agent_answer', sourceCaseId: 'dc_neutral', sourceRevision: 2,
    scope: { workspaces: ['/repo'] }, excerpt: 'Answer q: A\nQuestion q: Which?', createdAt: 10, closedAt: 20,
  }],
}

test('L3 reaches the model as neutral context but cannot authorize an answer or evidence citation', async () => {
  for (const evidenceId of ['dc_neutral', 'mem_invented']) {
    const ctx = fakeCtx(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Reuse history', evidenceIds: [evidenceId] }], answers: [{ id: 'q', selected: ['A'] }] }))
    let sent
    const stream = ctx.llm.stream
    ctx.llm.stream = options => { sent = options; return stream(options) }
    const result = await run(ctx, { evidence: [], memory: neutralMemory })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.error.kind, 'invalid_output')
    assert.equal(result.packManifest.evidenceIds.length, 0)
    const body = JSON.parse(sent.messages[0].content[0].text)
    assert.equal(body.L3[0].sourceCaseId, 'dc_neutral')
    assert.match(sent.system, /Decision evaluator contract v3/)
    assert.deepEqual(ctx.calls, { stream: 1, tools: 0, session: 0, otherModel: 0 })
  }

  const empty = await run(fakeCtx(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Reuse history', evidenceIds: [] }], answers: [{ id: 'q', selected: ['A'] }] })), { evidence: [], memory: neutralMemory })
  assert.equal(empty.outcome, 'return')
  assert.equal(empty.reasonCode, 'MISSING_CONTEXT')
  assert.equal(empty.gates.g1, false)
})

test('G4 uses the full pre-trim conflict set when only one side remains packed', async () => {
  const conflicting = [
    { ...evidence[0], evidenceId: 'ev_a', locator: { kind: 'case', caseId: `dc_${'a'.repeat(1500)}` }, excerpt: 'A'.repeat(900), createdAt: 10 },
    { ...evidence[0], evidenceId: 'ev_b', locator: { kind: 'case', caseId: `dc_${'b'.repeat(1500)}` }, excerpt: 'B'.repeat(900), createdAt: 20 },
  ]
  let packed
  for (let budgetTokens = 800; budgetTokens <= 6000; budgetTokens += 5) {
    const candidate = buildContextPack({ profile, request, evidence: conflicting, modelRoute: { kind: 'resolved', provider: 'p', model: 'm' }, budgetTokens, criticalEvidenceIds: [] })
    if (candidate.outcome === 'ready' && candidate.packManifest.evidenceIds.length === 1) { packed = candidate; break }
  }
  assert.ok(packed, 'a one-sided trimmed pack is required for this contract test')
  const cited = packed.packManifest.evidenceIds[0]
  const result = await run(fakeCtx(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Use one side', evidenceIds: [cited] }], answers: [{ id: 'q', selected: ['A'] }] })), {
    evidence: conflicting, packed, conflictPairs: [['ev_a', 'ev_b']],
  })
  assert.equal(result.outcome, 'return')
  assert.equal(result.reasonCode, 'CONFLICTING_EVIDENCE')
  assert.equal(result.gates.g4, false)
})
