import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionProfiles } from '../../src/decision/store/profiles.js'
import { DecisionAttempts } from '../../src/decision/store/attempts.js'
import { DecisionEvidence } from '../../src/decision/store/evidence.js'
import { DecisionFeedback } from '../../src/decision/store/feedback.js'
import { DecisionQuery } from '../../src/decision/store/query.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-versions-'))
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const cases = new DecisionCases(store)
  const profiles = new DecisionProfiles(store)
  const attempts = new DecisionAttempts(store)
  const evidence = new DecisionEvidence(store)
  const feedback = new DecisionFeedback(store)
  const query = new DecisionQuery(store)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, cases, profiles, attempts, evidence, feedback, query }
}

function caseInput() {
  return { workspaceKey: '/repo', rootSessionId: 'root', entry: 'hook', agentId: 'agent-a', request: { questions: [] }, scope: { workspaces: ['/repo'] }, idempotencyKey: 'version-case' }
}

function unsupported(run) {
  return error => {
    assert.equal(error.code, 'UNSUPPORTED_SCHEMA_VERSION')
    return true
  }
}

test('Case rows above the supported record version are refused', async t => {
  const { store, cases } = fixture(t)
  const current = (await cases.createCase(caseInput())).case
  store.db.prepare('UPDATE cases SET schema_version=99 WHERE case_id=?').run(current.caseId)
  assert.throws(() => cases.getCase(current.caseId), unsupported())
})

test('Profile rows above the supported record version are refused', async t => {
  const { store, profiles } = fixture(t)
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'A' })
  store.db.prepare('UPDATE agent_profiles SET schema_version=99 WHERE agent_id=?').run(profile.agentId)
  assert.throws(() => profiles.getProfile(profile.agentId), unsupported())
})

test('Attempt rows above the supported record version are refused', async t => {
  const { store, cases, attempts } = fixture(t)
  let current = (await cases.createCase(caseInput())).case
  current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  const attempt = await attempts.start({ caseId: current.caseId, agentId: current.agentId, pins: {}, contextPackHash: 'version', packManifest: {} })
  store.db.prepare('UPDATE attempts SET schema_version=99 WHERE attempt_id=?').run(attempt.attemptId)
  assert.throws(() => attempts.get(attempt.attemptId), unsupported())
})

test('Evidence rows above the supported record version are refused', async t => {
  const { store, evidence } = fixture(t)
  const ref = await evidence.add({ agentId: 'agent-a', source: 'user_profile', locator: { kind: 'profile', descriptionKind: 'user', revision: 1 }, scope: { workspaces: ['/repo'] } })
  store.db.prepare('UPDATE evidence SET schema_version=99 WHERE evidence_id=?').run(ref.evidenceId)
  assert.throws(() => evidence.get(ref.evidenceId), unsupported())
})

test('Feedback rows above the supported record version are refused by the detail reader', async t => {
  const { store, cases, feedback, query } = fixture(t)
  const current = (await cases.createCase(caseInput())).case
  const appended = await feedback.append({ actor: { kind: 'user' }, caseId: current.caseId, kind: 'comment', payload: { text: 'note' } })
  store.db.prepare('UPDATE feedback SET schema_version=99 WHERE feedback_id=?').run(appended.feedbackId)
  assert.throws(() => query.record({ caseId: current.caseId }), unsupported())
})

test('RouteDecision rows above the supported record version are refused by the detail reader', async t => {
  const { store, cases, query } = fixture(t)
  const current = (await cases.createCase(caseInput())).case
  const routeId = await cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'pinned', chosen: 'agent-a', reason: 'Pinned' })
  store.db.prepare('UPDATE route_decisions SET schema_version=99 WHERE route_decision_id=?').run(routeId)
  assert.throws(() => query.record({ caseId: current.caseId }), unsupported())
})
