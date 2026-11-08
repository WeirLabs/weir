// P1 namespace isolation: no cross-Agent or cross-workspace evidence enters an Attempt pack.
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { DECISION_EVENTS, decisionStoreDirectory, observeDecision, readDecisionStore } from '../decision-test-kit.js'

const id = 'decision-isolation'
const prompt = 'decision-isolation-probe'
const SOURCE = { id: 'decision-isolation-source', question: 'Choose A\'s new private direction', options: [{ label: 'A user answer' }, { label: 'Other A answer' }] }
const B_QUESTION = { id: 'decision-isolation-b', question: 'Answer the similar question using only B evidence', options: [{ label: 'Native B' }, { label: 'Leaked A' }] }
const CROSS_QUESTION = 'ISOLATION_CROSS: answer W2 using only W2 evidence'

function decide(options, obs) {
  const history = obs.transcript
  if (history.includes('DECISION_TEST error')) return textChunks('DECISION_ISOLATION_FAILED')
  if (!history.includes('DECISION_TEST done isolation-setup')) return toolCallChunks('decision_integration_probe', { op: 'isolation-setup' })
  if (!history.includes(SOURCE.id)) return toolCallChunks('ask_user_question', { questions: [SOURCE] })
  if (!history.includes('DECISION_TEST done case-for-call')) return toolCallChunks('decision_integration_probe', { op: 'case-for-call', questions: [SOURCE] })
  if (!history.includes('"kind":"comment"')) {
    const caseId = /"caseId":"(dc_[^"]+)"/.exec(history)?.[1]
    return toolCallChunks('decision_integration_probe', { op: 'feedback', caseId, verb: 'comment', text: 'A private feedback marker must never reach Agent B.' })
  }
  if (!history.includes('DECISION_TEST done select')) {
    const agentId = /"agentB":"([^"]+)"/.exec(history)?.[1]
    return toolCallChunks('decision_integration_probe', { op: 'select', agentId })
  }
  if (!history.includes(B_QUESTION.id)) return toolCallChunks('ask_user_question', { questions: [B_QUESTION] })
  if (!history.includes('DECISION_TEST done cross-consult')) {
    const agentId = /"agentC":"([^"]+)"/.exec(history)?.[1]
    const otherWorkspace = /"otherWorkspace":"([^"]+)"/.exec(history)?.[1]
    return toolCallChunks('decision_integration_probe', { op: 'cross-consult', agentId, otherWorkspace, question: CROSS_QUESTION })
  }
  return textChunks('DECISION_ISOLATION_DONE')
}

function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const question = pack.L4.request.questions[0]
  if (question.id === SOURCE.id) return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['A has no prior user decision'] }))
  if (question.id === B_QUESTION.id) {
    const leaked = pack.L5.find(evidence => evidence.source === 'user_decision')
    if (leaked) return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'A leaked record would incorrectly answer B.', evidenceIds: [leaked.evidenceId] }], answers: [{ id: question.id, selected: ['Leaked A'] }] }))
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'B needs its own same-scope user decision; A records are not available.' }))
  }
  if (question.question.startsWith('ISOLATION_CROSS')) return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'OUT_OF_SCOPE', hint: 'Provide W2 evidence; W1 records are outside this request.' }))
  return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['Unknown isolation fixture'] }))
}

function observe(obs) {
  const observation = observeDecision(obs)
  const body = observation.decisionEvaluator ? obs.lastUser : ''
  return { ...observation, decisionIsolationLeak: body.includes('A private profile marker') || body.includes('A private feedback marker') }
}

function assert(run) {
  const store = readDecisionStore(run.ws, decisionStoreDirectory(id))
  const caseFor = marker => store.cases.find(item => item.request.questions?.[0]?.id === marker || item.request.questions?.[0]?.question?.startsWith(marker))
  const source = caseFor(SOURCE.id)
  const bCase = caseFor(B_QUESTION.id)
  const cross = caseFor('ISOLATION_CROSS')
  const aEvidence = store.evidence.filter(ref => ref.agent_id === source?.agent_id)
  const aEvidenceIds = new Set(aEvidence.map(ref => ref.evidence_id))
  const bAttempt = store.attempts.find(attempt => attempt.case_id === bCase?.case_id)
  const crossAttempt = store.attempts.find(attempt => attempt.case_id === cross?.case_id)
  const bPackIds = bAttempt?.packManifest?.evidenceIds ?? []
  const crossPackIds = crossAttempt?.packManifest?.evidenceIds ?? []
  const bEvaluator = run.requests.find(request => request.decisionQuestionIds?.includes(B_QUESTION.id))

  run.check('A owns the source user decision and private feedback; B cannot read that namespace', source?.closing === 'escalated' && source?.agent_id !== bCase?.agent_id && store.feedback.some(item => item.case_id === source?.case_id && item.kind === 'comment') && bCase?.closing === 'returned' && bCase?.decision?.code === 'MISSING_CONTEXT' && bEvaluator?.decisionIsolationLeak === false && !bPackIds.some(id => aEvidenceIds.has(id)) && bPackIds.every(id => store.evidence.find(ref => ref.evidence_id === id)?.agent_id === bCase?.agent_id), JSON.stringify({ source, bCase, bPackIds, aEvidenceIds: [...aEvidenceIds], bEvaluator }))
  run.check('cross-workspace consult returns OUT_OF_SCOPE and its pack contains no W1 evidence', cross?.closing === 'returned' && cross?.decision?.code === 'OUT_OF_SCOPE' && cross?.workspace_key !== source?.workspace_key && !crossPackIds.some(id => aEvidenceIds.has(id)) && crossPackIds.every(id => store.evidence.find(ref => ref.evidence_id === id)?.agent_id === cross?.agent_id), JSON.stringify({ cross, crossPackIds, aEvidenceIds: [...aEvidenceIds] }))
  run.check('three isolated Cases keep separate Agents and exactly one Attempt each', store.cases.length === 3 && store.attempts.length === 3 && new Set(store.cases.map(item => item.agent_id)).size === 3 && !store.feedback.some(item => item.case_id === bCase?.case_id || item.case_id === cross?.case_id), JSON.stringify({ cases: store.cases.map(item => ({ caseId: item.case_id, agentId: item.agent_id, workspace: item.workspace_key })), feedback: store.feedback }))
  run.check('headless Decision isolation run exited cleanly', (run.code === 0 || run.code === null) && run.stdout.includes('DECISION_ISOLATION_DONE'), `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default {
  id, prompt, decide, decideDecision, observe, assert,
  env: { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_EVENTS: DECISION_EVENTS, WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id) },
}
