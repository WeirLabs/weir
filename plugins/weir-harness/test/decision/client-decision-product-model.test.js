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
  assert.deepEqual(selected.options.map(option => option.value), ['off', 'a'])
  assert.equal(JSON.stringify(selected.options).includes('Auto'), false)
  assert.equal(selected.options.some(option => option.value === 'b'), false)

  const saving = model.selectorView({ phase: 'saving', selector: { mode: 'agent', agentId: 'a' }, agents })
  assert.equal(saving.phase, 'saving')
  assert.equal(saving.selected, 'a')
  const failed = model.selectorView({ phase: 'error', selector: { mode: 'agent', agentId: 'a' }, agents, error: new Error('offline') })
  assert.equal(failed.selected, 'a')
  assert.equal(failed.error.message, 'offline')
  assert.deepEqual(model.selectorView({ phase: 'ready', selector: { mode: 'off' }, agents: [] }).options.map(option => option.value), ['off'])
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
