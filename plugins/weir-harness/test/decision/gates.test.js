import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateGates, gateFailureOutcome } from '../../src/decision/gates.js'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionAttempts } from '../../src/decision/store/attempts.js'
import { DecisionEvidence } from '../../src/decision/store/evidence.js'
import { DecisionFeedback } from '../../src/decision/store/feedback.js'

const base = () => ({
  claims: [{ text: 'Use A', evidenceIds: ['ev_a'] }],
  answers: [{ id: 'q', selected: ['A'] }],
  questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
  evidence: [{ evidenceId: 'ev_a', agentId: 'agent-a', source: 'user_decision', scope: { workspaces: ['/repo'], paths: ['src'] }, status: 'active' }],
  packEvidenceIds: ['ev_a'],
  profile: { agentId: 'agent-a', scope: { workspaces: ['/repo'], paths: ['src'] } },
  workspaceKey: '/repo', scope: { workspaces: ['/repo'], paths: ['src'] },
  attemptStartedAt: 100, attemptEndedAt: 200,
})

test('all seven structural gates pass for a scoped evidence-backed matching answer', () => {
  const gates = evaluateGates(base())
  assert.deepEqual(Object.keys(gates).filter(key => /^g[1-7]$/.test(key)).map(key => gates[key]), [true, true, true, true, true, true, true])
  assert.deepEqual(gates.gaps, [])
  assert.equal(gateFailureOutcome(gates), null)
})
test('G5 requires an explicit fresh hash from the production observation', () => {
  const input = base()
  input.evidence[0] = { ...input.evidence[0], source: 'current_observation', observedAt: 100, hash: 'fresh' }
  assert.equal(evaluateGates(input).g5, false)
  input.currentObservationHashes = { ev_a: 'fresh' }
  assert.equal(evaluateGates(input).g5, true)
})

for (const [gate, mutate] of [
  ['g1', input => { input.claims = [{ text: 'Unsupported', evidenceIds: [] }] }],
  ['g2', input => { input.evidence[0].scope = { workspaces: ['/other'] } }],
  ['g3', input => { input.recheckEvidence = () => ({ evidence: { ...input.evidence[0], status: 'deleted' } }) }],
  ['g4', input => {
    input.evidence.push({ ...input.evidence[0], evidenceId: 'ev_b' })
    input.packEvidenceIds.push('ev_b')
    input.claims[0].evidenceIds.push('ev_b')
    input.conflictPairs = [['ev_a', 'ev_b']]
  }],
  ['g5', input => {
    input.evidence[0] = { ...input.evidence[0], source: 'current_observation', observedAt: 50, hash: 'old' }
    input.currentObservationHashes = { ev_a: 'current' }
  }],
  ['g6', input => { input.intentKind = 'approval' }],
  ['g7', input => { input.answers[0].id = 'other' }],
]) {
  test(`${gate} fails independently with a named structural gap`, () => {
    const input = base()
    mutate(input)
    const gates = evaluateGates(input)
    assert.equal(gates[gate], false)
    assert.ok(gates.gaps.some(gap => gap.gate === gate.toUpperCase()))
    const outcome = gateFailureOutcome(gates)
    assert.ok(['return', 'escalate'].includes(outcome.outcome))
    const gap = gates.gaps.find(item => item.gate === gate.toUpperCase())
    assert.ok(gap.detail.length > 0)
    assert.ok(gap.scope.includes('/repo'))
    assert.ok('claim' in gap && 'evidenceId' in gap)
  })
}

test('G3 rechecks a post-pack downvote without rewriting an old Attempt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-gates-'))
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const cases = new DecisionCases(store)
  const attempts = new DecisionAttempts(store)
  const evidence = new DecisionEvidence(store)
  const feedback = new DecisionFeedback(store)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  let source = (await cases.createCase({ workspaceKey: '/repo', rootSessionId: 'root', entry: 'hook', agentId: 'agent-a', request: { questions: [] }, scope: { workspaces: ['/repo'] }, idempotencyKey: 'source' })).case
  source = await cases.transition({ caseId: source.caseId, expectedState: 'received', expectedRevision: source.revision, state: 'awaiting_user' })
  source = await cases.transition({ caseId: source.caseId, expectedState: 'awaiting_user', expectedRevision: source.revision, state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers: [{ id: 'q', selected: ['A'] }] } })
  const ref = await evidence.add({ agentId: 'agent-a', source: 'user_decision', locator: { kind: 'case', caseId: source.caseId }, scope: { workspaces: ['/repo'] } })

  let target = (await cases.createCase({ workspaceKey: '/repo', rootSessionId: 'root', entry: 'hook', agentId: 'agent-a', request: { questions: [] }, scope: { workspaces: ['/repo'] }, idempotencyKey: 'target' })).case
  target = await cases.transition({ caseId: target.caseId, expectedState: 'received', expectedRevision: target.revision, state: 'evaluating' })
  const old = await attempts.start({ caseId: target.caseId, agentId: 'agent-a', pins: {}, contextPackHash: 'old', packManifest: {} })
  await attempts.finish(old.attemptId, { outcome: 'answer', claims: [{ text: 'Use A', evidenceIds: [ref.evidenceId] }] })
  const before = attempts.get(old.attemptId)

  await feedback.append({ actor: { kind: 'user' }, caseId: source.caseId, kind: 'rating_down' })
  const input = { ...base(), claims: [{ text: 'Use A', evidenceIds: [ref.evidenceId] }], evidence: [ref], packEvidenceIds: [ref.evidenceId], scope: { workspaces: ['/repo'] }, profile: { ...base().profile, scope: { workspaces: ['/repo'] } } }
  const gates = evaluateGates({ ...input, recheckEvidence: evidenceId => {
    const current = evidence.get(evidenceId)
    return { evidence: current, sourceCase: current.locator.kind === 'case' ? cases.getCase(current.locator.caseId) : undefined }
  } })
  assert.equal(gates.g3, false)
  assert.equal(gateFailureOutcome(gates).reasonCode, 'STALE_EVIDENCE')
  assert.deepEqual(attempts.get(old.attemptId), before)
})
