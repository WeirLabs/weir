import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionCases } from '../../src/decision/store/cases.js'

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-cases-'))
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const cases = new DecisionCases(store)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, cases }
}

const input = (key = 'request-1') => ({
  workspaceKey: '/repo', rootSessionId: 'root', originSessionId: 'root', entry: 'hook',
  agentId: 'agent-a', request: { questions: [{ id: 'q', question: 'Choose A?' }] },
  scope: { workspaces: ['/repo'] }, idempotencyKey: key,
})

test('idempotent intake returns the same Case for duplicate delivery', async t => {
  const { store, cases } = fixture(t)
  const first = await cases.createCase(input())
  const second = await cases.createCase(input())
  assert.equal(second.created, false)
  assert.equal(second.case.caseId, first.case.caseId)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 1)
})
test('concurrent first delivery returns the persisted Case instead of a uniqueness error', async t => {
  const { store, cases } = fixture(t)
  const results = await Promise.all([cases.createCase(input('concurrent')), cases.createCase(input('concurrent'))])
  assert.equal(results[0].case.caseId, results[1].case.caseId)
  assert.deepEqual(results.map(result => result.created).sort(), [false, true])
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 1)
})

test('allowed state transitions preserve immutable terminal answers', async t => {
  const { cases } = fixture(t)
  const created = await cases.createCase(input())
  let current = created.case
  current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  current = await cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'closed', closing: 'answered', decision: { kind: 'answer', answers: [{ id: 'q', selected: ['A'] }] } })
  assert.equal(current.closing, 'answered')
  await assert.rejects(cases.transition({ caseId: current.caseId, expectedState: 'closed', expectedRevision: current.revision, state: 'evaluating' }), error => error.code === 'ILLEGAL_TRANSITION')
  assert.equal(cases.getCase(current.caseId).decision.answers[0].selected[0], 'A')
})

test('return, revision, escalation, cancellation and route facts follow the contract', async t => {
  const { store, cases } = fixture(t)
  let current = (await cases.createCase(input())).case
  await assert.rejects(cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'closed', closing: 'answered' }), error => error.code === 'ILLEGAL_TRANSITION')
  current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  current = await cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_revision' })
  current = await cases.transition({ caseId: current.caseId, expectedState: 'awaiting_revision', expectedRevision: current.revision, state: 'closed', closing: 'returned', decision: { kind: 'return', code: 'MISSING_CONTEXT', hint: 'Add scope' } })
  assert.equal(current.closing, 'returned')
  const waiting = (await cases.createCase(input('other'))).case
  const cancelled = await cases.transition({ caseId: waiting.caseId, expectedState: 'received', expectedRevision: waiting.revision, state: 'closed', closing: 'cancelled', decision: { kind: 'cancelled' } })
  assert.equal(cancelled.closing, 'cancelled')
  const routeId = await cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'pinned', chosen: 'agent-a', reason: 'Pinned by user' })
  assert.equal(store.db.prepare('SELECT mode FROM route_decisions WHERE route_decision_id=?').get(routeId).mode, 'pinned')
})

test('stale revision cannot overwrite a newer Case', async t => {
  const { cases } = fixture(t)
  const current = (await cases.createCase(input())).case
  await assert.rejects(cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: 99, state: 'evaluating' }), error => error.code === 'REVISION_CONFLICT')
})
