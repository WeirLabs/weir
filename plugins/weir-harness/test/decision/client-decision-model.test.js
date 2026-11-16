import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

async function load() {
  const { definition, exports } = await loadClientChunk('lib/client.decision-model.js')
  assert.equal(definition.id, 'weir-harness')
  return exports
}

test('selector offers localized Off/Auto labels, sanitized readiness, and enabled Agents as distinct modes', async () => {
  const model = await load()
  const options = model.selectorOptions({ ok: true, value: {
    auto: { autoAnswer: true, shadow: true },
    agents: [
      { agentId: 'a', name: 'A', state: 'enabled' },
      { agentId: 'b', name: 'B', state: 'disabled' },
      { agentId: 'c', name: 'C', state: 'archived' },
    ],
  } })
  assert.deepEqual(options.map(option => option.value), ['off', 'auto', 'a'])
  assert.equal(options[0].labelKey, 'decisionOff')
  assert.equal(options[0].label, undefined)
  assert.equal(options[1].labelKey, 'decisionAuto')
  assert.equal(options[1].label, undefined)
  assert.equal(options[1].mode, 'auto')
  assert.deepEqual(options[1].auto, { known: true, autoAnswer: true, shadow: true, ready: true })
  assert.equal(options[1].descriptionKey, 'decisionAutoAnswerOn')
  assert.equal(options[1].shadowKey, 'decisionAutoShadowOn')

  const empty = model.selectorOptions({ auto: { autoAnswer: false, shadow: false }, agents: [] })
  assert.equal(empty[1].descriptionKey, 'decisionAutoAnswerOff')
  assert.equal(empty[1].shadowKey, 'decisionAutoShadowOff')
  const unknown = model.selectorOptions({ agents: [] })
  assert.equal(unknown[1].auto.ready, false)
  assert.equal(unknown[1].descriptionKey, 'decisionAutoReadinessUnknown')
  assert.equal(unknown[1].shadowKey, 'decisionAutoShadowUnknown')
  assert.deepEqual(model.selectorOptions({ ok: false, error: { message: 'off' } }).map(option => option.value), ['off', 'auto'])
})

test('selector dictionaries use ordinary bilingual task language without hiding real Auto state', async () => {
  const model = await load()
  const { en, zh } = model.dictionaries
  assert.equal(en.decisionOff, 'Do not use an assistant')
  assert.equal(zh.decisionOff, '不启用助手')
  assert.equal(en.decisionAuto, 'Automatically choose an assistant')
  assert.equal(zh.decisionAuto, '自动选择助手')
  assert.match(zh.decisionAutoAnswerOff, /仍会自动选择助手/)
  assert.match(zh.decisionAutoAnswerOff, /自动回答未开启/)
  assert.match(en.decisionAutoAnswerOff, /still chosen automatically/i)
  assert.match(en.decisionAutoAnswerOff, /automatic answers are disabled/i)
  assert.match(en.decisionAutoAnswerOn, /may be adopted/i)
  assert.match(zh.decisionAutoAnswerOn, /采纳其结论/)
  assert.match(en.decisionAutoReadinessUnknown, /status is unknown/i)
  assert.match(zh.decisionAutoReadinessUnknown, /状态未知/)
  assert.match(en.decisionAutoShadowOn, /Selection comparison/)
  assert.match(zh.decisionAutoShadowOn, /选择对比/)
  assert.match(en.decisionAutoShadowOn, /never changes the actual result/)
  for (const key of ['decisionOff', 'decisionAuto', 'decisionAutoAnswerOn', 'decisionAutoAnswerOff', 'decisionAutoReadinessUnknown', 'decisionAutoShadowOn', 'decisionAutoShadowOff', 'decisionAutoShadowUnknown']) {
    assert.doesNotMatch(en[key], /\b(?:Off|Auto|Shadow)\b|whitelist|A\/B\/C/i, key)
    assert.doesNotMatch(zh[key], /\b(?:Off|Auto|Shadow)\b|白名单|A\/B\/C/i, key)
  }
})

test('card and page projections are complete and malformed payloads stay neutral', async () => {
  const model = await load()
  const detail = {
    case: { caseId: 'dc', agentId: 'a', state: 'closed', closing: 'answered', revision: 4, feedbackState: 'none', decision: { answers: [{ id: 'q', selected: ['A'] }] } },
    attempts: [{ attemptId: 'da', claims: [{ text: 'Use a concise title', evidenceIds: ['ev'] }], evidence: [{ evidenceId: 'ev', locator: { kind: 'case', caseId: 'source' } }] }],
  }
  const card = model.cardView(detail, [{ agentId: 'a', name: 'Tone' }])
  assert.equal(card.agentName, 'Tone')
  assert.equal(card.outcome, 'answered')
  assert.equal(card.summary, 'Use a concise title')
  assert.equal(card.evidence[0].evidenceId, 'ev')
  assert.equal(card.recordLink, 'weir-decisions:dc')
  assert.equal(model.cardView(null), null)
  assert.deepEqual(model.pageView({ tab: 'invalid' }).tabs, ['inbox', 'records', 'agents'])
  assert.deepEqual(model.narrowRecords({ ok: false }), { records: [], nextCursor: null })
  assert.deepEqual(model.narrowInbox({ ok: false }), [])
  assert.deepEqual(model.narrowRecords({ records: [{ caseId: 'dc-plain' }], nextCursor: 'next' }), { records: [{ caseId: 'dc-plain' }], nextCursor: 'next' })
  assert.deepEqual(model.narrowInbox([{ caseId: 'dc-plain' }]), [{ caseId: 'dc-plain', sessionId: '', sourceActive: true, updatedAt: 0 }])
})


test('RPC uses /api weirDecision namespace and exposes readable failures', async () => {
  const model = await load()
  const calls = []
  const connection = { rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: { ok: true, value: { ok: true } } } } } }
  assert.deepEqual(await model.decisionRpc(connection, 'inbox', { sessionId: 'child' }), { ok: true })
  assert.deepEqual(calls, [['/api', 'weirDecision/inbox', { args: { args: { sessionId: 'child' } } }]])
  const failed = { rpc: { call: async () => ({ ok: false, error: { code: 'OFF', message: 'Decision Off' } }) } }
  await assert.rejects(model.decisionRpc(failed, 'overview'), error => error.code === 'OFF' && error.message === 'Decision Off')
  const serviceFailed = { rpc: { call: async () => ({ ok: true, value: { ok: false, error: { code: 'OFF', message: 'Decision Off' } } }) } }
  await assert.rejects(model.decisionRpc(serviceFailed, 'overview'), error => error.code === 'OFF' && error.message === 'Decision Off')
})

test('Context Pack dictionaries are localized and mark L3 as non-authoritative', async () => {
  const model = await load()
  const keys = [
    'decisionContextPack', 'decisionL2Memory', 'decisionMemoryEmpty', 'decisionNeutralEpisodes', 'decisionNoMemory', 'decisionLayerSizes', 'decisionOmissions',
    'decisionLearningGovernance', 'decisionConsolidate', 'decisionPublish', 'decisionReject', 'decisionRollback', 'decisionCurrentSnapshot', 'decisionNoCurrentSnapshot',
    'decisionLearningIdle', 'decisionLearningNoChanges', 'decisionLearningStartUnavailable', 'decisionLearningStartRunning', 'decisionLearningStartCandidate', 'decisionLearningWorking', 'decisionPrincipleVersion',
    'decisionLearningReadFailed', 'decisionCandidateLoading', 'decisionCandidateNotReady', 'decisionSourceCase', 'decisionSourceCorrection',
    'decisionApplyTitle', 'decisionApplyConfirmation', 'decisionApplyChangeCount', 'decisionApplyReplaceCurrent', 'decisionApplyFutureOnly',
    'decisionDiscardCandidateTitle', 'decisionDiscardCandidateConfirmation', 'decisionRollbackTitle', 'decisionRollbackConfirmation',
    'decisionLearningRuns', 'decisionNoLearningRuns', 'decisionSnapshots', 'decisionNoSnapshots', 'decisionLearningDetail', 'decisionNoLearningDetail',
    'decisionFrozenInput', 'decisionStructuralReplay', 'decisionStructuralReplayHint', 'decisionReplayPassed', 'decisionReplayFailed', 'decisionReplayPending',
    'decisionOperations', 'decisionNoOperations', 'decisionPrincipleDiff', 'decisionDiffAdded', 'decisionDiffChanged', 'decisionDiffRemoved', 'decisionBefore', 'decisionAfter',
    'decisionNoPrincipleChanges', 'decisionNoSnapshotForRun', 'decisionSnapshotPin', 'decisionNoSnapshotPin', 'decisionReviewedPrinciples', 'decisionL5Mappings',
    'decisionExclusions', 'decisionNoExclusions', 'decisionLearningOutcome_running', 'decisionLearningOutcome_candidate', 'decisionLearningOutcome_published',
    'decisionLearningOutcome_rejected', 'decisionLearningOutcome_rolled_back', 'decisionLearningOutcome_failed', 'decisionSnapshotState_draft',
    'decisionSnapshotState_published', 'decisionSnapshotState_rolled_back',
  ]
  assert.deepEqual(Object.keys(model.dictionaries.en).sort(), Object.keys(model.dictionaries.zh).sort())
  for (const key of keys) {
    assert.equal(typeof model.dictionaries.en[key], 'string', `en ${key}`)
    assert.equal(typeof model.dictionaries.zh[key], 'string', `zh ${key}`)
    assert.ok(model.dictionaries.en[key].length > 0, `en ${key}`)
    assert.ok(model.dictionaries.zh[key].length > 0, `zh ${key}`)
  }
  assert.match(model.dictionaries.en.decisionNeutralEpisodes, /non-authoritative/)
  assert.match(model.dictionaries.zh.decisionNeutralEpisodes, /非权威/)
  assert.match(model.dictionaries.en.decisionL2Memory, /L2/)
  assert.match(model.dictionaries.zh.decisionL2Memory, /L2/)
  assert.match(model.dictionaries.en.decisionReviewedPrinciples, /non-authoritative/)
  assert.match(model.dictionaries.zh.decisionReviewedPrinciples, /非权威/)
  assert.match(model.dictionaries.en.decisionStructuralReplayHint, /manual/)
  assert.match(model.dictionaries.zh.decisionStructuralReplayHint, /手动/)
})

test('unowned Auto cases project routing failure, no match, and ambiguity from the latest non-Shadow route', async () => {
  const model = await load()
  const waiting = { caseId: 'dc-route-reason', agentId: null, state: 'awaiting_user', awaitingReason: 'no_route', feedbackState: 'none', request: { questions: [{ id: 'q', question: 'Choose' }] } }
  const route = (mode, extra = {}) => ({ routeDecisionId: `rd-${mode}`, mode, chosen: null, reason: 'none:no_candidates', createdAt: '2026-01-02T03:04:05.000Z', ...extra })
  const truncated = route('auto', { reason: 'failure:truncated' })
  const ambiguous = route('auto', { ambiguity: { candidates: ['a', 'b'], conflict: 'Both claim it' } })

  assert.equal(model.recordSummary(waiting, [], 'en', [truncated]).reasonKey, 'decisionReasonRouteFailure')
  assert.equal(model.cardView({ case: waiting, attempts: [], feedback: [], routeDecisions: [truncated] }, []).reasonKey, 'decisionReasonRouteFailure')
  assert.equal(model.recordSummary(waiting, [], 'en', [route('auto')]).reasonKey, 'decisionReasonUnownedNoRoute')
  assert.equal(model.recordSummary(waiting, [], 'en', [ambiguous]).reasonKey, 'decisionReasonRouteAmbiguous')
  // A Shadow sample is diagnostic only and never overrides the real outcome.
  assert.equal(model.recordSummary(waiting, [], 'en', [truncated, route('auto_shadow', { chosen: 'a' })]).reasonKey, 'decisionReasonRouteFailure')
  assert.equal(model.recordSummary(waiting, [], 'en', [ambiguous, route('auto_shadow', { reason: 'failure:truncated' })]).reasonKey, 'decisionReasonRouteAmbiguous')
  // The inbox projection's bounded routeStatus answers before the record is read.
  assert.equal(model.recordSummary({ ...waiting, routeStatus: 'failure' }, [], 'en').reasonKey, 'decisionReasonRouteFailure')
  assert.equal(model.recordSummary({ ...waiting, routeStatus: 'ambiguous' }, [], 'en').reasonKey, 'decisionReasonRouteAmbiguous')
  assert.equal(model.recordSummary({ ...waiting, routeStatus: 'none' }, [], 'en').reasonKey, 'decisionReasonUnownedNoRoute')
  assert.equal(model.recordSummary(waiting, [], 'en').reasonKey, 'decisionReasonUnownedNoRoute')
  assert.equal(model.recordSummary({ ...waiting, routeStatus: 'not-a-status' }, [], 'en').reasonKey, 'decisionReasonUnownedNoRoute')
  // An owned Case keeps its awaiting-reason wording; the route history is not a reason there.
  const owned = { ...waiting, agentId: 'a', awaitingReason: 'authority' }
  assert.equal(model.recordSummary(owned, [], 'en', [truncated]).reasonKey, 'decisionReasonAuthority')

  const { en, zh } = model.dictionaries
  assert.match(en.decisionReasonRouteFailure, /routing failed/i)
  assert.match(en.decisionReasonRouteFailure, /answer directly/)
  assert.match(en.decisionReasonRouteFailure, /reassign/)
  assert.match(zh.decisionReasonRouteFailure, /自动路由失败/)
  assert.match(zh.decisionReasonRouteFailure, /直接回答/)
  assert.match(zh.decisionReasonRouteFailure, /改派/)
  // Definitely a failure, never the no-match / unavailable wording.
  assert.doesNotMatch(en.decisionReasonRouteFailure, /no assistant(?: was)? selected|selection is unavailable/i)
  assert.doesNotMatch(zh.decisionReasonRouteFailure, /尚未选择助手|未选择助手|助手不可用/)
  for (const dictionary of [en, zh]) {
    assert.doesNotMatch(dictionary.decisionReasonRouteFailure, /failure:|truncated|max-tokens/i)
  }
})

// The profile-wide inbox projection names no workspace (no path, no raw
// workspace key), and the grouping is a pure function over host snapshots.
test('inbox projection keeps the source session and never invents workspace data', async () => {
  const model = await load()
  const items = model.narrowInbox({ ok: true, value: [
    { caseId: 'dc-a', rootSessionId: 's-a', workspaceKey: 'must-not-render', state: 'awaiting_user', updatedAt: 30, sourceActive: false, routeStatus: 'failure' },
    { caseId: 'dc-b', rootSessionId: 's-b', state: 'awaiting_user', updatedAt: 20 },
    { caseId: 'dc-c', rootSessionId: 's-c', state: 'awaiting_user', updatedAt: 10, routeStatus: 'not-a-status' },
  ] })
  assert.deepEqual(items.map(item => item.caseId), ['dc-a', 'dc-b', 'dc-c'])
  assert.equal(items[0].sessionId, 's-a')
  assert.equal(items[0].sourceActive, false)
  assert.equal(items[0].routeStatus, 'failure')
  assert.equal(items[1].sourceActive, true, 'an absent live flag is unknown, not "not running"')
  assert.equal(items[2].routeStatus, undefined)
  for (const item of items) assert.equal(item.crossWorkspace, undefined, 'grouping owns the cross-workspace verdict')

  const grouped = model.groupInbox(items, {
    workspaces: [
      { workspaceId: 'w1', title: 'Orrery', path: '/work/orrery', sessionIds: ['s-a'] },
      { workspaceId: 'w2', title: 'Atlas', path: '/work/atlas/', sessionIds: ['s-c'] },
    ],
    sessions: { 's-a': { cwd: '/work/orrery' }, 's-b': { cwd: '/work/atlas' }, 's-c': { cwd: '/work/atlas' } },
    currentSessionId: 's-b',
    t: key => key,
  })
  assert.equal(grouped.by, 'workspace')
  assert.equal(grouped.workspaceCount, 2)
  assert.equal(grouped.switchable, true)
  assert.deepEqual(grouped.groups.map(group => [group.label, group.count]), [['Orrery', 1], ['Atlas', 2]])
  assert.deepEqual(grouped.groups[1].items.map(item => item.caseId), ['dc-b', 'dc-c'], 'group items stay newest first')
  const atlasB = grouped.groups[1].items[0]
  assert.equal(atlasB.caseId, 'dc-b')
  assert.equal(atlasB.workspaceLabel, 'Atlas')
  assert.equal(atlasB.crossWorkspace, false, 'the current session sits in Atlas')
  assert.equal(atlasB.openSourceSession, false, 'the item of the open session offers no jump')
  assert.equal(grouped.groups[1].items[1].openSourceSession, true, 'another session of the same workspace is still openable')
  assert.equal(grouped.groups[0].items[0].crossWorkspace, true, 'Orrery differs from the current workspace')
  assert.equal(model.groupInbox(items.slice(0, 1), { workspaces: [{ workspaceId: 'w1', title: 'Orrery', sessionIds: ['s-a'] }], currentSessionId: 's-a' }).switchable, false, 'one workspace offers no switch')
})

test('grouping sorts by newest pending decision, hides empty groups, and falls back by agent', async () => {
  const model = await load()
  const items = model.narrowInbox([
    { caseId: 'dc-old', rootSessionId: 's-1', agentId: 'a', updatedAt: 1_000 },
    { caseId: 'dc-new', rootSessionId: 's-2', agentId: 'b', updatedAt: 9_000 },
    { caseId: 'dc-mid', rootSessionId: 's-2', agentId: 'a', updatedAt: 5_000 },
    { caseId: 'dc-unowned', rootSessionId: 's-3', agentId: null, updatedAt: 3_000 },
  ])
  const workspaces = [{ workspaceId: 'w1', title: 'One', sessionIds: ['s-1'] }, { workspaceId: 'w2', title: 'Two', sessionIds: ['s-2'] }]
  const byWorkspace = model.groupInbox(items, { workspaces, sessions: [] })
  assert.deepEqual(byWorkspace.groups.map(group => group.label), ['Two', 'Other workspace', 'One'])
  assert.deepEqual(byWorkspace.groups.map(group => group.count), [2, 1, 1])
  assert.equal(byWorkspace.groups[1].key, 'workspace:other', 'an unmapped session lands in one fallback bucket')
  assert.equal(byWorkspace.groups[1].label, 'Other workspace')

  const byAgent = model.groupInbox(items, { by: 'agent', workspaces, agents: [{ agentId: 'a', name: 'Tone' }], t: key => key })
  assert.deepEqual(byAgent.groups.map(group => [group.label, group.count]), [['decisionInboxAssistantFallback', 1], ['Tone', 2], ['decisionInboxUnownedAgent', 1]])
  assert.equal(byAgent.by, 'agent')
  assert.equal(byAgent.switchable, true, 'the switch reflects the workspace spread, not the grouping dimension')
  assert.equal(model.groupInbox([], { workspaces }).groups.length, 0, 'no items, no empty groups')
})
