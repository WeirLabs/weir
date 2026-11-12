import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionProfiles } from '../../src/decision/store/profiles.js'

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-cases-'))
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const cases = new DecisionCases(store)
  const profiles = new DecisionProfiles(store)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, cases, profiles }
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

test('auto and auto_shadow append independent immutable route facts and reject unknown modes', async t => {
  const { store, cases } = fixture(t)
  const current = (await cases.createCase(input('auto-routes'))).case
  const pinnedId = await cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'pinned', chosen: 'agent-a', reason: 'Pinned by user' })
  const shadowId = await cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'auto_shadow', chosen: 'agent-b', reason: 'Suggested shadow route' })
  const autoId = await cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'auto', chosen: 'agent-b', reason: 'deterministic:single_candidate' })
  const rows = store.db.prepare('SELECT route_decision_id,mode,chosen,reason,revision FROM route_decisions ORDER BY created_at,route_decision_id').all()
  assert.equal(rows.length, 3)
  assert.deepEqual({ ...rows.find(row => row.route_decision_id === pinnedId) }, {
    route_decision_id: pinnedId, mode: 'pinned', chosen: 'agent-a', reason: 'Pinned by user', revision: 1,
  })
  assert.equal(rows.find(row => row.route_decision_id === shadowId).mode, 'auto_shadow')
  assert.equal(rows.find(row => row.route_decision_id === autoId).mode, 'auto')
  await assert.rejects(cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'automatic', reason: 'not in contract' }), error => error.code === 'INVALID_ROUTE_MODE')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n, 3)
})

test('stale revision cannot overwrite a newer Case', async t => {
  const { cases } = fixture(t)
  const current = (await cases.createCase(input())).case
  await assert.rejects(cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: 99, state: 'evaluating' }), error => error.code === 'REVISION_CONFLICT')
})

test('an unowned user decision closes truthfully without creating Agent Evidence', async t => {
  const { store, cases } = fixture(t)
  let current = (await cases.createCase({ ...input('unowned-decision'), agentId: null })).case
  current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'no_route' })
  current = await cases.transition({
    caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision,
    state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers: [{ id: 'q', selected: ['A'] }] },
  })
  assert.equal(current.agentId, null)
  assert.equal(current.state, 'closed')
  assert.deepEqual(current.decision.answers, [{ id: 'q', selected: ['A'] }])
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 0)
})

test('transitionWithRoute atomically persists Auto selection, derived request, and Case ownership', async t => {
  const { store, cases, profiles } = fixture(t)
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'Auto target' })
  const current = (await cases.createCase({ ...input('atomic-auto'), agentId: null })).case
  const { change, route } = autoSelection(current, profile.agentId)
  const committed = await cases.transitionWithRoute(change, route)
  assert.equal(committed.state, 'evaluating')
  assert.equal(committed.agentId, profile.agentId)
  assert.equal(committed.revision, current.revision + 1)
  assert.equal(committed.request.questions[0].authorizationClass, 'A')
  assert.equal(committed.request.questions[0].authorizationClassSource, 'auto_classifier')
  const persistedRoute = store.db.prepare('SELECT * FROM route_decisions WHERE case_id=?').get(current.caseId)
  assert.equal(persistedRoute.mode, 'auto')
  assert.equal(persistedRoute.chosen, profile.agentId)
  assert.equal(persistedRoute.reason, 'deterministic:single_candidate')
})

test('transitionWithRoute rolls back the appended route when the guarded Case update fails', async t => {
  const { store, cases, profiles } = fixture(t)
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'Rollback target' })
  const current = (await cases.createCase({ ...input('rollback-auto'), agentId: null })).case
  const { change, route } = autoSelection(current, profile.agentId)
  await assert.rejects(cases.transitionWithRoute({ ...change, expectedRevision: current.revision + 1 }, route), error => error.code === 'REVISION_CONFLICT')
  assert.deepEqual(cases.getCase(current.caseId), current)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions WHERE case_id=?').get(current.caseId).n, 0)
})

test('transitionWithRoute revalidates enabled, scope hints, and final classes before selection', async t => {
  const { store, cases, profiles } = fixture(t)
  // Workspace membership is not an identity field any more, so the only reasons
  // a re-read may reject the candidate are disabled state, expertise hints and
  // the final authorization classes.
  const rejected = [
    { key: 'disabled', workspaceKey: '/repo', disable: true },
    { key: 'narrow', workspaceKey: '/repo', scope: { paths: ['src'], authorizationClasses: ['A'] } },
    { key: 'wrong-class', workspaceKey: '/repo', scope: { authorizationClasses: ['B'] } },
  ]
  for (const scenario of rejected) {
    const profile = await profiles.createProfile({ workspaceKey: scenario.workspaceKey, name: scenario.key, ...(scenario.scope ? { scope: scenario.scope } : {}) })
    if (scenario.disable) await profiles.setProfileState(profile.agentId, 'disabled')
    const current = (await cases.createCase({ ...input(`revalidate-${scenario.key}`), agentId: null })).case
    const { change, route } = autoSelection(current, profile.agentId)
    const committed = await cases.transitionWithRoute(change, route)
    assert.equal(committed.state, 'awaiting_user', scenario.key)
    assert.equal(committed.awaitingReason, 'no_route', scenario.key)
    assert.equal(committed.agentId, null, scenario.key)
    assert.equal(committed.request.questions[0].authorizationClassSource, 'auto_classifier', scenario.key)
    const persistedRoute = store.db.prepare('SELECT * FROM route_decisions WHERE case_id=?').get(current.caseId)
    assert.equal(persistedRoute.chosen, null, scenario.key)
    assert.equal(persistedRoute.reason, 'none:no_candidates', scenario.key)
  }
  // An assistant created in another workspace is NOT rejected: identity is shared.
  const shared = await profiles.createProfile({ workspaceKey: '/other', name: 'shared-identity' })
  const current = (await cases.createCase({ ...input('revalidate-shared'), agentId: null })).case
  const selection = autoSelection(current, shared.agentId)
  const committed = await cases.transitionWithRoute(selection.change, selection.route)
  assert.equal(committed.state, 'evaluating')
  assert.equal(committed.agentId, shared.agentId)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0)
})

function autoSelection(current, agentId) {
  const request = {
    ...current.request,
    questions: current.request.questions.map(question => ({ ...question, authorizationClass: 'A', authorizationClassSource: 'auto_classifier' })),
  }
  return {
    change: {
      caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision,
      state: 'evaluating', agentId, request, scope: current.scope,
    },
    route: {
      caseId: current.caseId, rootSessionId: current.rootSessionId, mode: 'auto',
      candidates: [{ agentId, enabled: true }], chosen: agentId, reason: 'deterministic:single_candidate',
    },
  }
}
