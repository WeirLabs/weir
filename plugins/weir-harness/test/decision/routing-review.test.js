import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import * as decisionQuery from '../../src/decision/store/query.js'
import { brokerFixture } from './p3-fixtures.js'

function route(caseId, routeDecisionId, mode, createdAt, extra = {}) {
  return {
    schemaVersion: 1, caseId, rootSessionId: 'root', routeDecisionId, mode,
    candidates: [], reason: 'route fact', revision: 1, createdAt, updatedAt: createdAt,
    ...extra,
  }
}

function chain(caseId, routes, agentId = 'agent-current') {
  return {
    case: {
      caseId, agentId,
      request: { questions: [{ id: 'q', question: `Question for ${caseId}` }] },
    },
    routes,
  }
}

test('pure RouteDecision chains distinguish comparisons, automatic outcomes, reassignment and uncomparable history', () => {
  const input = [
    chain('agreement', [
      route('agreement', 'rd-pin-agree', 'pinned', 1, { chosen: 'agent-a' }),
      route('agreement', 'rd-shadow-agree', 'auto_shadow', 2, { chosen: 'agent-a', reason: 'Model selected A' }),
    ]),
    chain('disagreement', [
      route('disagreement', 'rd-pin-differ', 'pinned', 3, { chosen: 'agent-a' }),
      route('disagreement', 'rd-shadow-differ', 'auto_shadow', 4, { chosen: 'agent-b', reason: 'Model selected B' }),
    ]),
    chain('shadow-none', [
      route('shadow-none', 'rd-pin-none', 'pinned', 5, { chosen: 'agent-a' }),
      route('shadow-none', 'rd-shadow-none', 'auto_shadow', 6, { reason: 'none:no_candidates' }),
    ]),
    chain('shadow-ambiguous', [
      route('shadow-ambiguous', 'rd-pin-ambiguous', 'pinned', 7, { chosen: 'agent-a' }),
      route('shadow-ambiguous', 'rd-shadow-ambiguous', 'auto_shadow', 8, {
        reason: 'Overlapping profiles', ambiguity: { candidates: ['agent-a', 'agent-b'], conflict: 'Both scopes cover the request' },
      }),
    ]),
    chain('shadow-failure', [
      route('shadow-failure', 'rd-pin-failure', 'pinned', 9, { chosen: 'agent-a' }),
      route('shadow-failure', 'rd-shadow-failure', 'auto_shadow', 10, { reason: 'failure:timeout' }),
    ]),
    chain('auto-none', [route('auto-none', 'rd-auto-none', 'auto', 11, { reason: 'No candidate fits' })]),
    chain('auto-ambiguous', [route('auto-ambiguous', 'rd-auto-ambiguous', 'auto', 12, {
      reason: 'Substantive overlap', ambiguity: { candidates: ['agent-a'], conflict: 'Same scope' },
    })]),
    chain('auto-failure', [route('auto-failure', 'rd-auto-failure', 'auto', 13, { reason: 'failure:model_error' })]),
    chain('manual', [
      route('manual', 'rd-auto-manual', 'auto', 14, { chosen: 'agent-a', reason: 'deterministic:single_candidate' }),
      route('manual', 'rd-manual', 'manual_reassign', 15, { chosen: 'agent-b', reason: 'User chose B' }),
    ], 'agent-b'),
    chain('manual-unowned', [route('manual-unowned', 'rd-manual-unowned', 'manual_reassign', 16, { chosen: 'agent-c' })], 'agent-c'),
    chain('explicit', [route('explicit', 'rd-explicit', 'explicit', 17, { chosen: 'agent-a', reason: 'Explicit agent_id' })]),
    chain('orphan-shadow', [route('orphan-shadow', 'rd-orphan-shadow', 'auto_shadow', 18, { chosen: 'agent-a' })]),
    chain('legacy', [route('legacy', 'rd-legacy', 'legacy_unknown', 19, { chosen: 'agent-a', reason: 'Old opaque route' })]),
    chain('pinned-only', [route('pinned-only', 'rd-pinned-only', 'pinned', 20, { chosen: 'agent-a' })]),
  ]
  const before = JSON.stringify(input)

  const projected = decisionQuery.projectRoutingChains(input)

  assert.deepEqual(projected.summary, {
    agreement: 1,
    disagreement: 1,
    shadowNone: 1,
    shadowAmbiguous: 1,
    shadowFailure: 1,
    autoNone: 1,
    autoAmbiguous: 1,
    autoFailure: 1,
    manualReassign: 2,
    uncomparable: 4,
  })
  const byId = new Map(projected.items.map(item => [item.routeDecisionId, item]))
  assert.equal(byId.get('rd-shadow-agree').outcome, 'agreement')
  assert.equal(byId.get('rd-shadow-agree').baselineAgentId, 'agent-a')
  assert.equal(byId.get('rd-shadow-differ').outcome, 'disagreement')
  assert.equal(byId.get('rd-shadow-none').outcome, 'shadow_none')
  assert.equal(byId.get('rd-shadow-ambiguous').outcome, 'shadow_ambiguous')
  assert.equal(byId.get('rd-shadow-failure').outcome, 'shadow_failure')
  assert.equal(byId.get('rd-auto-none').outcome, 'auto_none')
  assert.equal(byId.get('rd-auto-ambiguous').outcome, 'auto_ambiguous')
  assert.equal(byId.get('rd-auto-failure').outcome, 'auto_failure')
  assert.deepEqual(byId.get('rd-manual').reassignment, { from: 'agent-a', to: 'agent-b' })
  assert.deepEqual(byId.get('rd-manual-unowned').reassignment, { from: null, to: 'agent-c' })
  assert.equal(byId.get('rd-explicit').outcome, 'uncomparable')
  assert.equal(byId.get('rd-orphan-shadow').outcome, 'uncomparable')
  assert.equal(byId.get('rd-legacy').outcome, 'uncomparable')
  assert.equal(byId.get('rd-pinned-only').outcome, 'uncomparable')
  assert.equal(byId.get('rd-pin-agree').outcome, 'baseline')
  assert.equal(byId.get('rd-auto-manual').outcome, 'auto_selected')
  assert.deepEqual(projected.items.map(item => item.routeDecisionId), [...projected.items]
    .sort((left, right) => right.createdAt - left.createdAt || right.routeDecisionId.localeCompare(left.routeDecisionId))
    .map(item => item.routeDecisionId))
  assert.equal(JSON.stringify(input), before, 'projection must not rewrite historical inputs')
  assert.equal(Object.isFrozen(input), false, 'projection must not freeze caller-owned inputs')
  assert.equal(Object.isFrozen(projected), true)
  assert.equal(Object.isFrozen(projected.summary), true)
  assert.equal(Object.isFrozen(projected.items[0]), true)
  assert.throws(() => { projected.summary.agreement = 99 }, TypeError)
})

test('comparison requires a preceding chosen pinned baseline and never infers labels from reason prose', () => {
  const projected = decisionQuery.projectRoutingChains([
    chain('late-baseline', [
      route('late-baseline', 'rd-shadow-first', 'auto_shadow', 1, { reason: 'failure:timeout' }),
      route('late-baseline', 'rd-pinned-later', 'pinned', 2, { chosen: 'agent-a' }),
    ]),
    chain('explicit-is-not-baseline', [
      route('explicit-is-not-baseline', 'rd-explicit-first', 'explicit', 3, { chosen: 'agent-a' }),
      route('explicit-is-not-baseline', 'rd-shadow-after-explicit', 'auto_shadow', 4, { chosen: 'agent-a' }),
    ]),
    chain('selected-prose', [
      route('selected-prose', 'rd-pinned-prose', 'pinned', 5, { chosen: 'agent-a' }),
      route('selected-prose', 'rd-shadow-prose', 'auto_shadow', 6, { chosen: 'agent-a', reason: 'failure:timeout' }),
    ]),
  ])

  const byId = new Map(projected.items.map(item => [item.routeDecisionId, item]))
  assert.equal(byId.get('rd-shadow-first').outcome, 'uncomparable')
  assert.equal(byId.get('rd-shadow-after-explicit').outcome, 'uncomparable')
  assert.equal(byId.get('rd-shadow-prose').outcome, 'agreement')
  assert.equal(projected.summary.shadowFailure, 0)
  assert.equal(projected.summary.agreement, 1)
  assert.equal(projected.summary.uncomparable, 3)
})

function reviewFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-routing-review-'))
  const at = 1_000_000_000
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const cases = new DecisionCases(store, { now: () => at })
  const query = new decisionQuery.DecisionQuery(store, { now: () => at })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  async function addCase(key, options = {}) {
    const workspaceKey = options.workspaceKey ?? '/repo'
    const rootSessionId = options.rootSessionId ?? 'root'
    return (await cases.createCase({
      workspaceKey, rootSessionId, entry: 'hook',
      agentId: Object.hasOwn(options, 'agentId') ? options.agentId : 'agent-current',
      request: { questions: [{ id: 'q', question: options.question ?? `Question ${key}` }] },
      scope: { workspaces: [workspaceKey] }, idempotencyKey: key,
    })).case
  }
  async function addRoute(current, options = {}) {
    const id = await cases.recordRoute({
      caseId: current.caseId, rootSessionId: options.rootSessionId ?? current.rootSessionId,
      mode: options.mode ?? 'auto', candidates: options.candidates ?? [],
      ...(options.chosen === undefined ? {} : { chosen: options.chosen }),
      reason: options.reason ?? 'none:no_candidates',
      ...(options.ambiguity === undefined ? {} : { ambiguity: options.ambiguity }),
    })
    if (options.createdAt !== undefined) {
      store.db.prepare('UPDATE route_decisions SET created_at=?,updated_at=? WHERE route_decision_id=?').run(options.createdAt, options.createdAt, id)
    }
    return id
  }
  return { store, cases, query, addCase, addRoute, at }
}

test('routingReview limits associations to the authorized root and workspace and returns bounded record navigation', async t => {
  const f = reviewFixture(t)
  const longQuestion = `${'😀'.repeat(300)}PRIVATE_SUFFIX`
  const allowed = await f.addCase('allowed', { question: longQuestion, agentId: 'agent-a' })
  const allowedRoute = await f.addRoute(allowed, {
    chosen: 'agent-a', reason: 'deterministic:single_candidate',
    candidates: [{ agentId: 'agent-a', enabled: true, name: 'PROFILE_NAME_MUST_NOT_LEAK' }],
  })
  const legacy = await f.addCase('legacy', { question: 'Legacy opaque question' })
  const legacyRoute = await f.addRoute(legacy, { mode: 'explicit', chosen: 'agent-explicit' })
  f.store.db.prepare("UPDATE route_decisions SET mode='legacy_unknown' WHERE route_decision_id=?").run(legacyRoute)

  const foreignRoot = await f.addCase('foreign-root', { rootSessionId: 'other', question: 'FOREIGN_ROOT_QUESTION' })
  await f.addRoute(foreignRoot, { chosen: 'foreign-agent' })
  const foreignWorkspace = await f.addCase('foreign-workspace', { workspaceKey: '/foreign', question: 'FOREIGN_WORKSPACE_QUESTION' })
  await f.addRoute(foreignWorkspace, { chosen: 'foreign-agent' })
  await f.addRoute(foreignRoot, { rootSessionId: 'root', reason: 'none:no_candidates' })
  await f.cases.recordRoute({ caseId: 'missing-case', rootSessionId: 'root', mode: 'auto', reason: 'failure:model_error' })

  const review = f.query.routingReview({ sessionId: 'root', workspaceKey: '/repo', window: 'all' })
  assert.equal(review.window, 'all')
  assert.equal(review.nextCursor, null)
  assert.equal(review.items.length, 2)
  const item = review.items.find(row => row.routeDecisionId === allowedRoute)
  assert.equal(Array.from(item.questionSummary).length, 240)
  assert.equal(item.questionSummary.includes('PRIVATE_SUFFIX'), false)
  assert.equal(item.agentId, 'agent-a')
  assert.deepEqual(item.record, { caseId: allowed.caseId })
  assert.deepEqual(item.candidates, [{ agentId: 'agent-a', enabled: true }])
  assert.equal(review.items.find(row => row.routeDecisionId === legacyRoute).outcome, 'uncomparable')
  assert.equal(review.summary.uncomparable, 1)
  assert.ok(f.query.record({ sessionId: 'root', caseId: item.record.caseId }))
  assert.equal(f.query.record({ sessionId: 'other', caseId: item.record.caseId }), null)
  const serialized = JSON.stringify(review)
  for (const secret of ['PRIVATE_SUFFIX', 'PROFILE_NAME_MUST_NOT_LEAK', 'FOREIGN_ROOT_QUESTION', 'FOREIGN_WORKSPACE_QUESTION', 'foreign-agent']) {
    assert.equal(serialized.includes(secret), false, secret)
  }
  assert.deepEqual(f.query.routingReview({ sessionId: 'other', workspaceKey: '/repo', window: 'all' }).items.map(row => row.caseId), [foreignRoot.caseId])
  assert.equal(f.query.metrics({ sessionId: 'root', workspaceKey: '/repo', window: 'all' }).casesOpened, 2)
})

test('routingReview pages exactly 20 stable items with duplicate-resistant, root-and-window-bound cursors', async t => {
  const f = reviewFixture(t)
  for (let index = 0; index < 45; index++) {
    const current = await f.addCase(`page-${index}`)
    await f.addRoute(current)
  }

  const first = f.query.routingReview({ sessionId: 'root', window: 'all' })
  assert.equal(first.items.length, 20)
  assert.equal(first.summary.autoNone, 45)
  assert.ok(first.nextCursor)
  const second = f.query.routingReview({ sessionId: 'root', window: 'all', cursor: first.nextCursor })
  assert.equal(second.items.length, 20)
  assert.equal(second.summary.autoNone, 45)
  assert.ok(second.nextCursor)
  const third = f.query.routingReview({ sessionId: 'root', window: 'all', cursor: second.nextCursor })
  assert.equal(third.items.length, 5)
  assert.equal(third.nextCursor, null)
  const items = [...first.items, ...second.items, ...third.items]
  assert.equal(new Set(items.map(item => item.routeDecisionId)).size, 45)
  assert.deepEqual(items.map(item => item.routeDecisionId), [...items]
    .sort((left, right) => right.createdAt - left.createdAt || right.routeDecisionId.localeCompare(left.routeDecisionId))
    .map(item => item.routeDecisionId))
  assert.deepEqual(f.query.routingReview({ sessionId: 'root', window: 'all' }), first)
  assert.deepEqual(f.query.routingReview({ sessionId: 'root', window: 'all', cursor: first.nextCursor }), second)

  const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))
  const reencode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const invalid = [
    '', 'not-base64-json', reencode({ ...decoded, extra: true }),
    reencode({ ...decoded, window: '7d' }), reencode({ ...decoded, sessionId: 'other' }),
  ]
  for (const cursor of invalid) {
    assert.throws(() => f.query.routingReview({ sessionId: 'root', window: 'all', cursor }), error => error.code === 'INVALID_ROUTING_CURSOR')
  }
  assert.throws(() => f.query.routingReview({ sessionId: 'root', cursor: { after: first.nextCursor } }), error => error.code === 'INVALID_ROUTING_CURSOR')
  for (const window of ['week', '', null, 7, 'toString', '__proto__']) {
    assert.throws(() => f.query.routingReview({ sessionId: 'root', window }), error => error.code === 'INVALID_ROUTING_WINDOW')
  }
  assert.throws(() => f.query.routingReview({ sessionId: '', window: 'all' }), error => error.code === 'INVALID_SESSION')
})

test('metrics and routingReview share one windowed summary without rewriting Case or RouteDecision history', async t => {
  const f = reviewFixture(t)
  const agreement = await f.addCase('metric-agreement')
  await f.addRoute(agreement, { mode: 'pinned', chosen: 'agent-a', createdAt: f.at - 20 })
  await f.addRoute(agreement, { mode: 'auto_shadow', chosen: 'agent-a', createdAt: f.at - 19 })
  const reassigned = await f.addCase('metric-reassigned')
  await f.addRoute(reassigned, { mode: 'auto', chosen: 'agent-a' })
  await f.addRoute(reassigned, { mode: 'manual_reassign', chosen: 'agent-b' })
  const old = await f.addCase('metric-old')
  const oldRoute = await f.addRoute(old, { reason: 'failure:timeout' })
  f.store.db.prepare('UPDATE route_decisions SET created_at=?,updated_at=? WHERE route_decision_id=?')
    .run(f.at - 8 * 24 * 60 * 60 * 1000, f.at - 8 * 24 * 60 * 60 * 1000, oldRoute)
  const history = () => ({
    cases: f.store.db.prepare('SELECT * FROM cases ORDER BY case_id').all(),
    routes: f.store.db.prepare('SELECT * FROM route_decisions ORDER BY route_decision_id').all(),
  })
  const before = history()

  for (const window of ['all', '24h', '7d']) {
    const review = f.query.routingReview({ sessionId: 'root', window })
    const metrics = f.query.metrics({ sessionId: 'root', window })
    assert.deepEqual(metrics.routing, review.summary, window)
    assert.equal(metrics.reassignments, review.summary.manualReassign, window)
    assert.equal(metrics.selectorOffBypasses, 0, window)
  }
  assert.equal(f.query.metrics({ sessionId: 'root', window: '24h' }).routing.autoFailure, 0)
  assert.equal(f.query.metrics({ sessionId: 'root', window: '7d' }).routing.autoFailure, 0)
  assert.equal(f.query.metrics({ sessionId: 'root', window: 'all' }).routing.autoFailure, 1)
  await f.query.rebuildMetrics({ sessionId: 'root', window: '24h' })
  assert.equal(f.store.db.prepare("SELECT value FROM metrics_counters WHERE bucket='root:24h:routing.agreement'").get().value, 1)
  assert.deepEqual(history(), before)
  for (const window of ['invalid', 'toString', '__proto__']) assert.equal(f.query.metrics({ sessionId: 'root', window }), null)
})

test('Broker routingReview resolves the authorized root/workspace and preserves existing record navigation', async t => {
  const f = await brokerFixture(t)
  const local = (await f.broker.cases.createCase({
    workspaceKey: f.workspace, rootSessionId: 'root', entry: 'hook', agentId: null,
    request: { questions: [{ id: 'q', question: 'Authorized routing question' }] },
    scope: { workspaces: [f.workspace] }, idempotencyKey: 'broker-routing-local',
  })).case
  await f.broker.cases.recordRoute({ caseId: local.caseId, rootSessionId: 'root', mode: 'auto', reason: 'none:no_candidates' })
  for (const [key, rootSessionId, workspaceKey, question] of [
    ['broker-routing-workspace', 'root', '/foreign', 'FOREIGN_WORKSPACE_BROKER'],
    ['broker-routing-root', 'other', f.workspace, 'FOREIGN_ROOT_BROKER'],
  ]) {
    const foreign = (await f.broker.cases.createCase({
      workspaceKey, rootSessionId, entry: 'hook', agentId: 'foreign-agent',
      request: { questions: [{ id: 'q', question }] }, scope: { workspaces: [workspaceKey] }, idempotencyKey: key,
    })).case
    await f.broker.cases.recordRoute({ caseId: foreign.caseId, rootSessionId, mode: 'auto', chosen: 'foreign-agent', reason: 'deterministic:single_candidate' })
  }
  f.broker.ctx.sessionQuery = {
    traceSession: async sessionId => {
      if (sessionId === 'child') return { complete: true, root: { header: { id: 'root', cwd: f.workspace } } }
      throw new Error(`unknown session ${sessionId}`)
    },
  }

  const review = await f.broker.routingReview({ sessionId: 'child', workspaceKey: '/spoof', window: 'all' })
  assert.deepEqual(review.items.map(item => item.caseId), [local.caseId])
  assert.equal(review.summary.autoNone, 1)
  assert.equal(JSON.stringify(review).includes('FOREIGN_'), false)
  assert.equal(JSON.stringify(review).includes('foreign-agent'), false)
  assert.ok(await f.broker.record({ sessionId: 'child', caseId: review.items[0].record.caseId }))
  assert.equal((await f.broker.metrics({ sessionId: 'child', window: 'all' })).casesOpened, 1)
  await assert.rejects(f.broker.routingReview({ sessionId: 'child', window: 'invalid' }), error => error.code === 'INVALID_ROUTING_WINDOW')
  await assert.rejects(f.broker.routingReview({ sessionId: 'child', cursor: 'not-a-cursor' }), error => error.code === 'INVALID_ROUTING_CURSOR')
  await assert.rejects(f.broker.routingReview({ sessionId: 'missing' }), error => error.message.includes('unknown session'))
})
