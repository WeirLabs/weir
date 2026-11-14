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
    auto: { answerClasses: ['A', 'A', 'B', 'D'], shadow: true },
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
  assert.deepEqual(options[1].auto, { known: true, answerClasses: ['A', 'B'], shadow: true, ready: true })
  assert.equal(options[1].descriptionKey, 'decisionAutoWhitelist')
  assert.equal(options[1].shadowKey, 'decisionAutoShadowOn')

  const empty = model.selectorOptions({ auto: { answerClasses: [], shadow: false }, agents: [] })
  assert.equal(empty[1].descriptionKey, 'decisionAutoEmptyWhitelist')
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
  assert.equal(zh.decisionAutoEmptyWhitelist, '仍会自动选择助手并交由其评估；自动回答尚未允许，新判断仍会询问你。')
  assert.match(en.decisionAutoEmptyWhitelist, /still chosen to evaluate/i)
  assert.match(en.decisionAutoEmptyWhitelist, /new decisions will still ask you/i)
  assert.equal(en.decisionAutoWhitelist, 'Automatic answers are currently allowed for {count} decision categories.')
  assert.equal(zh.decisionAutoWhitelist, '当前允许自动回答 {count} 类判断。')
  assert.match(en.decisionAutoReadinessUnknown, /status is unknown/i)
  assert.match(zh.decisionAutoReadinessUnknown, /状态未知/)
  assert.match(en.decisionAutoShadowOn, /Selection comparison/)
  assert.match(zh.decisionAutoShadowOn, /选择对比/)
  assert.match(en.decisionAutoShadowOn, /never changes the actual result/)
  for (const key of ['decisionOff', 'decisionAuto', 'decisionAutoWhitelist', 'decisionAutoEmptyWhitelist', 'decisionAutoReadinessUnknown', 'decisionAutoShadowOn', 'decisionAutoShadowOff', 'decisionAutoShadowUnknown']) {
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
  assert.deepEqual(model.narrowInbox([{ caseId: 'dc-plain' }]), [{ caseId: 'dc-plain' }])
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
