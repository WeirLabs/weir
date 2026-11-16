import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

async function load() {
  return (await loadClientChunk('lib/client.decision-model.js')).exports
}

const agents = [
  { agentId: 'a', name: 'Tone', state: 'enabled' },
  { agentId: 'b', name: 'Archived helper', state: 'archived' },
  { agentId: 'c', name: 'Disabled helper', state: 'disabled' },
]

test('product vocabulary is localized while advanced diagnostics retain technical facts', async () => {
  const model = await load()
  assert.deepEqual(Object.keys(model.dictionaries.en).sort(), Object.keys(model.dictionaries.zh).sort())
  assert.equal(model.dictionaries.en.decisionSelector, 'Decision assistant')
  assert.equal(model.dictionaries.zh.decisionSelector, '决策助手')
  assert.equal(model.dictionaries.en.decisionInbox, 'Needs your decision')
  assert.equal(model.dictionaries.zh.decisionInbox, '待你决定')
  assert.equal(model.dictionaries.en.decisionRecords, 'Decision records')
  assert.equal(model.dictionaries.zh.decisionRecords, '判断记录')
  assert.equal(model.dictionaries.en.decisionEvidence, 'Rationale')
  assert.equal(model.dictionaries.zh.decisionEvidence, '判断依据')
  assert.equal(model.dictionaries.en.decisionCurrentSnapshot, 'Current principle version')
  assert.equal(model.dictionaries.zh.decisionCurrentSnapshot, '当前原则版本')
  assert.match(model.dictionaries.en.decisionAdvancedDiagnostics, /Advanced diagnostics/)
  assert.match(model.dictionaries.zh.decisionAdvancedDiagnostics, /高级诊断/)
  assert.match(model.dictionaries.en.decisionStructuralQualityWarning, /does not guarantee content quality/)
  assert.match(model.dictionaries.zh.decisionStructuralQualityWarning, /不代表内容质量/)
  assert.match(model.dictionaries.en.decisionRateNotQuality, /not a quality metric/)
  assert.match(model.dictionaries.zh.decisionRateNotQuality, /不是质量指标/)
  assert.match(model.dictionaries.en.decisionHistoricalNotEvidence, /not evidence/)
  assert.match(model.dictionaries.zh.decisionHistoricalNotEvidence, /不是判断依据/)
})

test('page defaults to inbox with three primary destinations and advanced metrics', async () => {
  const model = await load()
  assert.deepEqual(model.pageView({}), {
    tab: 'inbox',
    tabs: ['inbox', 'records', 'agents'],
    advancedViews: ['metrics'],
    agents: [], records: [], inbox: [], metrics: null,
  })
  assert.equal(model.pageView({ tab: 'metrics' }).tab, 'metrics')
  assert.equal(model.pageView({ tab: 'unknown' }).tab, 'inbox')
})

test('selector projection never guesses Off and pins an unavailable selection honestly', async () => {
  const model = await load()
  const loading = model.selectorView({ phase: 'loading' })
  assert.equal(loading.phase, 'loading')
  assert.equal(loading.selected, null)
  assert.equal(loading.triggerKey, 'decisionLoadingShort')
  assert.deepEqual(loading.options, [])

  const selected = model.selectorView({ phase: 'ready', selector: { mode: 'agent', agentId: 'b' }, agents })
  assert.equal(selected.selected, 'b')
  assert.equal(selected.selectedName, 'Archived helper')
  assert.equal(selected.unavailable, true)
  assert.deepEqual(selected.options.map(option => option.value), ['off', 'auto', 'a'])
  assert.equal(selected.options[1].mode, 'auto')
  assert.equal(selected.options.some(option => option.value === 'b'), false)

  const saving = model.selectorView({ phase: 'saving', selector: { mode: 'agent', agentId: 'a' }, agents })
  assert.equal(saving.phase, 'saving')
  assert.equal(saving.selected, 'a')
  const failed = model.selectorView({ phase: 'error', selector: { mode: 'agent', agentId: 'a' }, agents, error: new Error('offline') })
  assert.equal(failed.selected, 'a')
  assert.equal(failed.error.message, 'offline')
  assert.deepEqual(model.selectorView({ phase: 'ready', selector: { mode: 'off' }, agents: [] }).options.map(option => option.value), ['off', 'auto'])
  const globalOff = model.selectorView({ phase: 'ready', status: { enabled: false, reason: 'disabled' }, selector: { mode: 'agent', agentId: 'a' }, agents })
  assert.equal(globalOff.globalOff, true)
  assert.equal(globalOff.selected, 'a')
  assert.deepEqual(globalOff.options.map(option => option.value), ['off', 'auto', 'a'])
  const automatic = model.selectorView({ phase: 'ready', selector: { mode: 'auto', agentId: null }, agents, auto: { autoAnswer: false, shadow: false } })
  assert.equal(automatic.selected, 'auto')
  assert.equal(automatic.selectedName, null)
  assert.equal(automatic.unavailable, false)
  assert.equal(automatic.triggerKey, 'decisionAuto')
  assert.equal(automatic.options[1].descriptionKey, 'decisionAutoAnswerOff')
})

test('record summaries and card evidence follow the current Attempt only', async () => {
  const model = await load()
  const detail = {
    case: {
      caseId: 'dc-current', agentId: 'a', state: 'closed', closing: 'answered', revision: 4,
      createdAt: '2026-01-02T03:04:05.000Z', feedbackState: 'none',
      request: { questions: [{ id: 'q', question: 'Which title should we use?' }] },
      decision: { answers: [{ id: 'q', selected: ['Concise title'] }], hint: 'Use concise wording' },
    },
    attempts: [
      { attemptId: 'da-old', claims: [{ text: 'Old rationale' }], evidence: [{ evidenceId: 'ev-old', excerpt: 'old evidence' }] },
      { attemptId: 'da-new', claims: [{ text: 'Current rationale' }], evidence: [{ evidenceId: 'ev-new', excerpt: 'current evidence' }] },
    ],
  }
  const card = model.cardView(detail, agents)
  assert.equal(card.variant, 'answered')
  assert.equal(card.questionSummary, 'Which title should we use?')
  assert.equal(card.answerSummary, 'Concise title')
  assert.equal(card.summary, 'Use concise wording')
  assert.deepEqual(card.evidence.map(item => item.evidenceId), ['ev-new'])
  assert.equal(card.currentAttempt.attemptId, 'da-new')
  assert.deepEqual(card.history.map(group => [group.attempt.attemptId, group.evidence.map(item => item.evidenceId)]), [
    ['da-old', ['ev-old']], ['da-new', ['ev-new']],
  ])
  const summary = model.recordSummary(detail.case, agents, 'en')
  assert.equal(summary.title, 'Which title should we use?')
  assert.equal(summary.answerSummary, 'Concise title')
  assert.equal(summary.agentName, 'Tone')
  assert.equal(summary.statusKey, 'decisionStatusAnswered')
  assert.equal(summary.time, '2026-01-02T03:04:05.000Z')
})

test('record and card fallbacks follow the active locale including regional Chinese and translator seats', async () => {
  const model = await load()
  const current = { caseId: 'dc-fallback', agentId: 'missing', state: 'closed', closing: 'answered', request: { questions: [] } }
  const detail = { case: current, attempts: [] }
  const english = model.recordSummary(current, [])
  assert.equal(english.title, 'Decision record')
  assert.equal(english.agentName, 'Decision assistant')
  assert.equal(model.cardView(detail, []).agentName, 'Decision assistant')

  for (const locale of ['zh', 'zh-CN', key => model.dictionaries.zh[key]]) {
    const summary = model.recordSummary(current, [], locale)
    assert.equal(summary.title, '判断记录')
    assert.equal(summary.agentName, '决策助手')
    assert.equal(model.cardView(detail, [], locale).agentName, '决策助手')
  }
})

test('record pages append without duplicates and empty states remain specific', async () => {
  const model = await load()
  const first = [{ caseId: 'dc-a', request: { questions: [{ question: 'A' }] } }]
  const page = { records: [{ caseId: 'dc-a', request: { questions: [{ question: 'A updated' }] } }, { caseId: 'dc-b' }], nextCursor: 'next' }
  assert.deepEqual(model.appendRecordPage(first, page), {
    records: [first[0], page.records[1]], nextCursor: 'next',
  })
  assert.deepEqual(model.appendRecordPage([], page).records.map(item => item.caseId), ['dc-a', 'dc-b'])
  assert.equal(model.recordEmptyState({ sessionId: null }), 'decisionNoSession')
  assert.equal(model.recordEmptyState({ sessionId: 's', loading: true }), 'decisionLoading')
  assert.equal(model.recordEmptyState({ sessionId: 's', error: new Error('x') }), 'decisionReadFailed')
  assert.equal(model.recordEmptyState({ sessionId: 's', permissionDenied: true }), 'decisionNoPermission')
  assert.equal(model.recordEmptyState({ sessionId: 's', cleaned: true }), 'decisionRecordsCleaned')
  assert.equal(model.recordEmptyState({ sessionId: 's', filtered: true }), 'decisionNoFilteredRecords')
  assert.equal(model.recordEmptyState({ sessionId: 's' }), 'decisionNoRecord')
})

test('feedback actions and drafts follow state and Case/session boundaries', async () => {
  const model = await load()
  assert.deepEqual(model.feedbackActions('none').map(action => action.verb), ['rating_up', 'rating_down'])
  assert.deepEqual(model.feedbackActions('validated').map(action => action.verb), ['undo_rating_up'])
  assert.deepEqual(model.feedbackActions('disputed').map(action => action.verb), ['undo_rating_down'])
  assert.deepEqual(model.feedbackActions('unknown'), [])

  let drafts = model.draftsReducer(undefined, { type: 'update', sessionId: 'root', caseId: 'dc-a', field: 'comment', value: 'note A' })
  drafts = model.draftsReducer(drafts, { type: 'update', sessionId: 'root', caseId: 'dc-a', field: 'correction', value: 'correct A' })
  drafts = model.draftsReducer(drafts, { type: 'update', sessionId: 'root', caseId: 'dc-b', field: 'answers', value: { q: { selected: ['B'] } } })
  drafts = model.draftsReducer(drafts, { type: 'update', sessionId: 'other', caseId: 'dc-a', field: 'comment', value: 'other session' })
  assert.equal(model.readDraft(drafts, 'root', 'dc-a').comment, 'note A')
  assert.equal(model.readDraft(drafts, 'root', 'dc-a').correction, 'correct A')
  assert.equal(model.readDraft(drafts, 'root', 'dc-b').comment, '')
  assert.deepEqual(model.readDraft(drafts, 'root', 'dc-b').answers, { q: { selected: ['B'] } })
  assert.equal(model.readDraft(drafts, 'other', 'dc-a').comment, 'other session')
  const cleared = model.draftsReducer(drafts, { type: 'clear', sessionId: 'root', caseId: 'dc-a', fields: ['comment'] })
  assert.equal(model.readDraft(cleared, 'root', 'dc-a').comment, '')
  assert.equal(model.readDraft(cleared, 'root', 'dc-a').correction, 'correct A')
  assert.equal(model.readDraft(cleared, 'other', 'dc-a').comment, 'other session')
  assert.throws(() => model.draftsReducer(drafts, { type: 'update', sessionId: 'root', caseId: 'dc-a', field: 'unexpected', value: 'x' }), /draft field/)
})

test('candidate readiness requires matching loaded detail and accepts a first candidate without parent', async () => {
  const model = await load()
  const agent = {
    agentId: 'a', state: 'enabled', currentSnapshotId: null,
    learningRuns: [{ learningRunId: 'lr-one', outcome: 'candidate' }],
    snapshots: [{ snapshotId: 'ms-one', learningRunId: 'lr-one', state: 'draft', version: 1, revision: 1, parentSnapshotId: null }],
  }
  assert.equal(model.candidateReadiness({ agent, detail: null }).ready, false)
  assert.equal(model.candidateReadiness({ agent, detail: null }).reason, 'loading')
  const detail = {
    agentId: 'a',
    run: { learningRunId: 'lr-one', agentId: 'a', outcome: 'candidate', inputFrozen: { parentSnapshotId: null }, operations: [{ op: 'add' }] },
    snapshot: { snapshotId: 'ms-one', agentId: 'a', learningRunId: 'lr-one', state: 'draft', revision: 3, principles: [{ principleId: 'p', text: 'Use B' }] },
    parentSnapshot: null,
  }
  const ready = model.candidateReadiness({ agent, detail })
  assert.deepEqual(ready, { ready: true, reason: null, snapshotId: 'ms-one', expectedRevision: 3, changeCount: 1 })
  assert.equal(model.candidateReadiness({ agent, detail: { ...detail, snapshot: null } }).ready, false)
  assert.equal(model.candidateReadiness({ agent, detail: { ...detail, snapshot: { ...detail.snapshot, revision: undefined } } }).ready, false)
  assert.equal(model.candidateReadiness({ agent, detail: { ...detail, run: { ...detail.run, learningRunId: 'lr-other' } } }).ready, false)
  assert.equal(model.candidateReadiness({ agent, detail, error: new Error('offline') }).reason, 'error')

  const withParent = {
    agent: {
      ...agent, currentSnapshotId: 'ms-parent',
      snapshots: [{ ...agent.snapshots[0], snapshotId: 'ms-two', version: 2, parentSnapshotId: 'ms-parent' }],
    },
    detail: {
      ...detail,
      run: { ...detail.run, inputFrozen: { parentSnapshotId: 'ms-parent' } },
      snapshot: { ...detail.snapshot, snapshotId: 'ms-two', parentSnapshotId: 'ms-parent' },
      parentSnapshot: null,
    },
  }
  assert.equal(model.candidateReadiness(withParent).reason, 'parent')
  assert.equal(model.candidateReadiness({ ...withParent, detail: { ...withParent.detail, parentSnapshot: { snapshotId: 'ms-parent', state: 'published', revision: 8, principles: [] } } }).ready, true)
})

test('memory summaries distinguish used, empty, pinned-empty, and legacy attempts without inventing hits', async () => {
  const model = await load()
  const used = model.memoryView({
    packManifest: { memory: {
      L2: { status: 'populated', snapshotId: 'ms-private', snapshotRevision: 3, snapshotHash: 'a'.repeat(64), principleIds: ['pr-one'], items: [{ principleId: 'pr-one' }] },
      publicL2: { status: 'populated', zone: 'public', snapshotId: 'ms-public', snapshotRevision: 2, snapshotHash: 'b'.repeat(64), principleIds: ['pr-public'], items: [{ principleId: 'pr-public', sources: ['ws-alias-1'] }] },
      L3: { sourceCaseIds: ['dc-one', 'dc-two'] },
    } },
  })
  assert.equal(used.l2, 'used')
  assert.equal(used.l2Count, 1)
  assert.equal(used.public, 'used')
  assert.equal(used.publicCount, 1)
  assert.deepEqual(used.publicPrinciples, [{ principleId: 'pr-public', sources: ['ws-alias-1'], evidenceIds: [] }])
  assert.equal(used.l3, 'used')
  assert.equal(used.l3Count, 2)
  const pinnedEmpty = model.memoryView({
    pins: { memorySnapshotId: 'ms-pinned' },
    packManifest: { memory: { L2: { status: 'empty', principleIds: [], items: [] }, L3: { sourceCaseIds: [] } } },
  })
  assert.equal(pinnedEmpty.l2, 'pinned-empty')
  assert.equal(pinnedEmpty.public, 'legacy')
  assert.equal(pinnedEmpty.l3, 'empty')
  for (const legacy of [{ packManifest: { layerSizes: { L2: 0, L3: 0 } } }, {}]) {
    const value = model.memoryView(legacy)
    assert.equal(value.l2, 'legacy')
    assert.equal(value.public, 'legacy')
    assert.equal(value.l3, 'legacy')
    assert.equal(value.l2Count, 0)
    assert.equal(value.publicCount, 0)
  }
})

test('metrics projection preserves raw values while formatting counts, rates, durations, and diagnostic groups', async () => {
  const model = await load()
  const raw = {
    window: 'all', since: null, casesOpened: 12, attemptsTotal: 20, autoAnswered: 3, autoAnswerRate: 0.25,
    returnedByCode: { STALE_EVIDENCE: 2 }, escalated: 4, exhausted: 1, cancelled: 2, interrupted: 1,
    evidenceFailures: { stale: 2, conflicting: 1, deleted: 0 }, ratings: { up: 5, down: 1, undone: 1 },
    corrections: 2, reassignments: 3, feedbackParticipation: 6, selectorOffBypasses: 0, meanAttemptLatencyMs: 1500,
  }
  const view = model.metricsView(raw)
  assert.equal(view.raw, raw)
  assert.equal(view.window, 'all')
  const rows = view.sections.flatMap(section => section.rows)
  const row = key => rows.find(item => item.key === key)
  assert.equal(row('casesOpened').display, '12')
  assert.equal(row('autoAnswerRate').display, '25%')
  assert.equal(row('autoAnswerRate').value, 0.25)
  assert.equal(row('meanAttemptLatencyMs').display, '1.5 s')
  assert.equal(row('returnedByCode.STALE_EVIDENCE').labelKey, 'decisionReasonStaleEvidence')
  assert.equal(row('returnedByCode.STALE_EVIDENCE').display, '2')
  assert.equal(row('evidenceFailures.conflicting').display, '1')
  assert.equal(row('ratings.undone').display, '1')
  assert.equal('qualityScore' in view, false)
  assert.deepEqual(model.metricsView(null), { window: null, since: null, sections: [], raw: null })
})


test('routing review projects every diagnostic outcome without inventing a quality score or record link', async () => {
  const model = await load()
  const outcomes = ['agreement', 'disagreement', 'shadow_none', 'shadow_ambiguous', 'shadow_failure', 'auto_none', 'auto_ambiguous', 'auto_failure', 'manual_reassign', 'uncomparable', 'baseline', 'auto_selected']
  const outcomeKeys = ['decisionRoutingAgreement', 'decisionRoutingDisagreement', 'decisionRoutingShadowNone', 'decisionRoutingShadowAmbiguous', 'decisionRoutingShadowFailure', 'decisionRoutingAutoNone', 'decisionRoutingAutoAmbiguous', 'decisionRoutingAutoFailure', 'decisionRoutingManualReassign', 'decisionRoutingUncomparable', 'decisionRoutingBaseline', 'decisionRoutingAutoSelected']
  const items = outcomes.map((outcome, index) => ({
    caseId: `dc-${index}`, routeDecisionId: `rd-${index}`, outcome,
    questionSummary: `Question ${index}`, createdAt: '2026-01-02T03:04:05.000Z', record: { caseId: `dc-${index}` },
  }))
  const summary = { agreement: 1, disagreement: 2, shadowNone: 3, shadowAmbiguous: 4, shadowFailure: 5, autoNone: 6, autoAmbiguous: 7, autoFailure: 8, manualReassign: 9, uncomparable: 10 }
  const raw = { window: '7d', summary, items, nextCursor: 'next' }
  assert.deepEqual(model.narrowRoutingReview({ ok: true, value: raw }), raw)
  const view = model.routingReviewView(raw)
  assert.equal(view.raw, raw)
  assert.deepEqual(view.items.map(item => item.outcomeKey), outcomeKeys)
  assert.deepEqual(view.summary.map(row => [row.key, row.display]), Object.entries(summary).map(([key, value]) => [key, String(value)]))
  assert.equal(view.items[0].recordCaseId, 'dc-0')
  assert.equal('qualityScore' in view, false)
  assert.match(model.dictionaries.en.decisionRoutingUncomparable, /baseline/i)
  assert.match(model.dictionaries.zh.decisionRoutingUncomparable, /基线/)
  assert.match(model.dictionaries.en.decisionRoutingDiagnostic, /not a quality/i)
  assert.match(model.dictionaries.zh.decisionRoutingDiagnostic, /不是质量/)
  assert.equal(model.routingReviewView(null).items.length, 0)
  assert.equal(model.routingReviewView({ items: [{ ...items[0], record: { caseId: 'other' } }] }).items[0].recordCaseId, null)
})

test('routing review pages dedupe only repeated RouteDecisions and retain distinct facts for one Case', async () => {
  const model = await load()
  const first = { caseId: 'dc-a', routeDecisionId: 'rd-a', questionSummary: 'Original A' }
  const shadow = { caseId: 'dc-a', routeDecisionId: 'rd-shadow', questionSummary: 'Shadow A' }
  const page = { window: 'all', summary: { agreement: 1 }, items: [
    { ...first, questionSummary: 'Updated duplicate A' }, shadow,
    { caseId: 'dc-b', routeDecisionId: 'rd-b', questionSummary: 'B' },
  ], nextCursor: null }
  assert.deepEqual(model.appendRoutingPage([first], page), { items: [first, shadow, page.items[2]], nextCursor: null })
  assert.deepEqual(model.narrowRoutingReview({ ok: false }), { window: 'all', summary: {}, items: [], nextCursor: null })
  assert.deepEqual(model.narrowRoutingReview({ window: 'invalid', items: null, nextCursor: 4 }), { window: 'all', summary: {}, items: [], nextCursor: null })
})


test('unowned Auto records expose truthful route history and only owned waiting Cases can retry', async () => {
  const model = await load()
  const auto = { routeDecisionId: 'rd-auto', mode: 'auto', chosen: null, reason: 'failure:timeout', createdAt: '2026-01-02T03:04:05.000Z' }
  const shadow = { routeDecisionId: 'rd-shadow', mode: 'auto_shadow', chosen: 'a', reason: 'observation', createdAt: '2026-01-02T03:05:05.000Z' }
  const detail = {
    case: { caseId: 'dc-unowned', agentId: null, state: 'awaiting_user', awaitingReason: 'no_route', feedbackState: 'none', request: { questions: [{ id: 'q', question: 'Choose' }] } },
    attempts: [], feedback: [], routeDecisions: [auto, shadow],
  }
  const card = model.cardView(detail, agents)
  assert.equal(card.assigned, false)
  assert.equal(card.canRetry, false)
  assert.equal(card.agentName, 'No assistant selected')
  assert.equal(card.routeStatusKey, 'decisionRoutingAutoFailure')
  assert.deepEqual(card.routeHistory.map(item => [item.modeKey, item.statusKey]), [
    ['decisionRouteModeAuto', 'decisionRouteStatusFailure'],
    ['decisionRouteModeShadow', 'decisionRouteStatusSelected'],
  ])
  assert.deepEqual(card.evidence, [])
  const summary = model.recordSummary(detail.case, agents)
  assert.equal(summary.assigned, false)
  assert.equal(summary.canRetry, false)
  assert.equal(summary.agentName, 'No assistant selected')
  // The RouteDecision history is the authoritative reason once it is readable;
  // without it the projection falls back to the existing unowned wording.
  assert.equal(model.recordSummary(detail.case, agents, 'en', detail.routeDecisions).reasonKey, 'decisionReasonRouteFailure')
  assert.equal(summary.reasonKey, 'decisionReasonUnownedNoRoute')
  assert.equal(model.cardView(detail, agents).reasonKey, 'decisionReasonRouteFailure')

  const manual = { routeDecisionId: 'rd-manual', mode: 'manual_reassign', chosen: 'a', reason: '', createdAt: '2026-01-02T03:06:05.000Z' }
  const reassigned = model.cardView({ ...detail, case: { ...detail.case, agentId: 'a' }, routeDecisions: [auto, manual] }, agents)
  assert.equal(reassigned.assigned, true)
  assert.equal(reassigned.canRetry, true)
  assert.equal(reassigned.agentName, 'Tone')
  assert.equal(reassigned.routeStatusKey, 'decisionRoutingManualReassign')
  assert.equal(reassigned.routeHistory.at(-1).from, null)
  assert.equal(reassigned.routeHistory.at(-1).to, 'a')
  assert.equal(reassigned.routeHistory.at(-1).toName, 'Tone')
  assert.equal(model.cardView({ ...detail, case: { ...detail.case, agentId: 'a', state: 'closed', closing: 'answered' } }, agents).canRetry, false)
  const unknown = model.cardView({ ...detail, case: { ...detail.case, agentId: 'missing' }, routeDecisions: [{ ...manual, chosen: 'missing' }] }, [])
  assert.equal(unknown.assigned, true)
  assert.equal(unknown.routeHistory.at(-1).toName, 'The current selection is unavailable.')
})
