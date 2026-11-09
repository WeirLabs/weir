import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as decisionQuery from '../../src/decision/store/query.js'

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
