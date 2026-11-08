import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionAttempts } from '../../src/decision/store/attempts.js'

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-attempts-'))
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const cases = new DecisionCases(store)
  const attempts = new DecisionAttempts(store)
  const created = await cases.createCase({
    workspaceKey: '/repo', rootSessionId: 'root', entry: 'consult', agentId: 'agent-a',
    request: { questions: [] }, scope: { workspaces: ['/repo'] }, idempotencyKey: 'case-attempts',
  })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, cases, attempts, current: created.case }
}

test('Attempt finalization is immutable and idempotent intake does not add attempts', async t => {
  const { cases, attempts, current } = await fixture(t)
  const attempt = await attempts.start({ caseId: current.caseId, agentId: 'agent-a', pins: {}, contextPackHash: 'hash', packManifest: {} })
  await attempts.finish(attempt.attemptId, { outcome: 'answer', claims: [], citedEvidenceIds: [] })
  await assert.rejects(attempts.finish(attempt.attemptId, { outcome: 'return' }), error => error.code === 'ATTEMPT_IMMUTABLE')
  const duplicate = await cases.createCase({
    workspaceKey: '/repo', rootSessionId: 'root', entry: 'consult', agentId: 'agent-a',
    request: { questions: [] }, scope: { workspaces: ['/repo'] }, idempotencyKey: 'case-attempts',
  })
  assert.equal(duplicate.created, false)
  assert.equal(attempts.forCase(current.caseId).length, 1)
  assert.equal(cases.getCase(current.caseId).attemptCount, 1)
})

test('restart recovery marks open Attempt interrupted and never creates an answer', async t => {
  const { cases, attempts, current } = await fixture(t)
  await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  const attempt = await attempts.start({ caseId: current.caseId, agentId: 'agent-a', pins: {}, contextPackHash: 'hash', packManifest: {} })
  const result = await attempts.recoverInterrupted()
  assert.deepEqual(result, { interruptedAttempts: 1, recoveredCases: 1, at: result.at })
  assert.equal(attempts.get(attempt.attemptId).error.kind, 'interrupted')
  const recovered = cases.getCase(current.caseId)
  assert.equal(recovered.state, 'awaiting_user')
  assert.equal(recovered.awaitingReason, 'interrupted')
  assert.equal(recovered.decision, null)
  assert.equal(recovered.attemptCount, 1)
})
