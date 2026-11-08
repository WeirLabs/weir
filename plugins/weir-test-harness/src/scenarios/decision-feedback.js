// P1 immediate feedback semantics and User Override corrections on the real Hook/Broker path.
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { DECISION_EVENTS, decisionStoreDirectory, observeDecision, readDecisionEvents, readDecisionStore } from '../decision-test-kit.js'

const id = 'decision-feedback'
const prompt = 'decision-feedback-probe'
const SOURCE = { id: 'decision-feedback-source', question: 'Choose a new title direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] }
const FOLLOWUPS = {
  reuse1: { id: 'decision-feedback-reuse-1', question: 'Reuse the title direction after the user decision', options: [{ label: 'Native judgment' }, { label: 'Use Short' }, { label: 'Use Long' }] },
  blocked: { id: 'decision-feedback-blocked', question: 'Reuse the title direction after a downvote', options: [{ label: 'Native judgment' }, { label: 'Use Short' }, { label: 'Use Long' }] },
  reuse2: { id: 'decision-feedback-reuse-2', question: 'Reuse the title direction after undo', options: [{ label: 'Native judgment' }, { label: 'Use Short' }, { label: 'Use Long' }] },
  comment: { id: 'decision-feedback-comment', question: 'Reuse the title direction after a neutral comment', options: [{ label: 'Native judgment' }, { label: 'Use Short' }, { label: 'Use Long' }] },
  corrected: { id: 'decision-feedback-corrected', question: 'Apply the corrected title direction now', options: [{ label: 'Native judgment' }, { label: 'Use Short' }, { label: 'Use Long' }] },
}

function sourceCaseId(history) {
  return /"caseId":"(dc_[^"]+)"/.exec(history)?.[1]
}

function decide(options, obs) {
  const history = obs.transcript
  if (history.includes('DECISION_TEST error')) return textChunks('DECISION_FEEDBACK_FAILED')
  if (!history.includes('DECISION_TEST done setup')) return toolCallChunks('decision_integration_probe', { op: 'setup' })
  if (!history.includes(SOURCE.id)) return toolCallChunks('ask_user_question', { questions: [SOURCE] })
  if (!history.includes('DECISION_TEST done case-for-call')) return toolCallChunks('decision_integration_probe', { op: 'case-for-call', questions: [SOURCE] })
  if (!history.includes(FOLLOWUPS.reuse1.id)) return toolCallChunks('ask_user_question', { questions: [FOLLOWUPS.reuse1] })
  if (!history.includes('"kind":"rating_down"')) return toolCallChunks('decision_integration_probe', { op: 'feedback', caseId: sourceCaseId(history), verb: 'rating_down' })
  if (!history.includes(FOLLOWUPS.blocked.id)) return toolCallChunks('ask_user_question', { questions: [FOLLOWUPS.blocked] })
  if (!history.includes('"kind":"undo_rating_down"')) return toolCallChunks('decision_integration_probe', { op: 'feedback', caseId: sourceCaseId(history), verb: 'undo_rating_down' })
  if (!history.includes(FOLLOWUPS.reuse2.id)) return toolCallChunks('ask_user_question', { questions: [FOLLOWUPS.reuse2] })
  if (!history.includes('"kind":"comment"')) return toolCallChunks('decision_integration_probe', { op: 'feedback', caseId: sourceCaseId(history), verb: 'comment', text: 'Neutral context only; do not change the direction.' })
  if (!history.includes(FOLLOWUPS.comment.id)) return toolCallChunks('ask_user_question', { questions: [FOLLOWUPS.comment] })
  if (!history.includes('DECISION_TEST done correction')) {
    const workspaceKey = /"workspaceKey":"([^"]+)"/.exec(history)?.[1]
    return toolCallChunks('decision_integration_probe', { op: 'correction', caseId: sourceCaseId(history), direction: 'Use Long', scope: { workspaces: [workspaceKey] }, supersedes: [sourceCaseId(history)] })
  }
  if (!history.includes(FOLLOWUPS.corrected.id)) return toolCallChunks('ask_user_question', { questions: [FOLLOWUPS.corrected] })
  return textChunks('DECISION_FEEDBACK_DONE')
}

function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const question = pack.L4.request.questions[0]
  if (question.id === SOURCE.id) return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['The title direction is a genuinely new user judgment'] }))
  const correction = pack.L5.find(evidence => evidence.source === 'user_correction')
  const decision = pack.L5.find(evidence => evidence.source === 'user_decision')
  const ref = correction ?? decision
  const selected = ref ? ['Use Long', 'Use Short'].find(choice => ref.excerpt?.includes(choice)) : undefined
  if (!ref || !selected) return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Provide a fresh user decision because the prior record has no expandable answer content.' }))
  return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: `${selected} is supported by the current ${ref.source}.`, evidenceIds: [ref.evidenceId] }], answers: [{ id: question.id, selected: [selected] }] }))
}

function observe(obs) {
  let action = null
  if (obs.lastTool.startsWith('DECISION_TEST done feedback') || obs.lastTool.startsWith('DECISION_TEST done correction')) {
    try { action = JSON.parse(obs.lastTool.slice(obs.lastTool.indexOf(':') + 1)) } catch {}
  }
  return { ...observeDecision(obs), decisionFeedbackAction: action }
}

function assert(run) {
  const store = readDecisionStore(run.ws, decisionStoreDirectory(id))
  const events = readDecisionEvents()
  const caseFor = questionId => store.cases.find(item => item.request.questions?.[0]?.id === questionId)
  const source = caseFor(SOURCE.id)
  const reuse1 = caseFor(FOLLOWUPS.reuse1.id)
  const blocked = caseFor(FOLLOWUPS.blocked.id)
  const reuse2 = caseFor(FOLLOWUPS.reuse2.id)
  const comment = caseFor(FOLLOWUPS.comment.id)
  const corrected = caseFor(FOLLOWUPS.corrected.id)
  const actions = run.requests.map(request => request.decisionFeedbackAction).filter(Boolean)
  const down = actions.find(action => action.result?.kind === 'rating_down')
  const undo = actions.find(action => action.result?.kind === 'undo_rating_down')
  const commentAction = actions.find(action => action.result?.kind === 'comment')
  const correctionFeedback = store.feedback.find(item => item.kind === 'correction' && item.case_id === source?.case_id)
  const correctedEvidence = corrected?.decision?.evidenceIds?.map(id => store.evidence.find(ref => ref.evidence_id === id)) ?? []
  const sourceEvidence = store.evidence.find(ref => ref.locator?.kind === 'case' && ref.locator.caseId === source?.case_id)
  const blockedStub = events.find(event => event.questionIds?.includes(FOLLOWUPS.blocked.id))

  run.check('user decision is reused with evidence, then one-click downvote is immediately disputed and blocks auto-answer', reuse1?.closing === 'answered' && reuse1.decision.answers[0].selected[0] === 'Use Short' && down?.case?.caseId === source?.case_id && down.case.feedbackState === 'disputed' && down.case.needsReview === true && blocked?.closing === 'returned' && blocked?.decision?.code === 'MISSING_CONTEXT' && blockedStub?.caseSnapshot?.case?.state === 'awaiting_revision' && blockedStub.answer.answers[0].selected[0] === 'Native judgment', JSON.stringify({ reuse1, down, blocked, blockedStub }))
  run.check('undo restores eligibility and neutral comment does not change subsequent behavior', undo?.case?.feedbackState === 'none' && undo.case.needsReview === false && reuse2?.closing === 'answered' && reuse2.decision.answers[0].selected[0] === 'Use Short' && commentAction?.case?.feedbackState === 'none' && commentAction.case.needsReview === false && comment?.closing === 'answered' && comment.decision.answers[0].selected[0] === 'Use Short', JSON.stringify({ undo, reuse2, commentAction, comment }))
  run.check('correction immediately drives the next Attempt and cites its User Override EvidenceRef', corrected?.closing === 'answered' && corrected.decision.answers[0].selected[0] === 'Use Long' && correctedEvidence.some(ref => ref?.source === 'user_correction' && ref.locator?.feedbackId === correctionFeedback?.feedback_id) && correctedEvidence[0]?.excerpt === 'Use Long', JSON.stringify({ corrected, correctedEvidence, correctionFeedback }))
  run.check('negative feedback never infers the opposite answer and old history remains immutable', source?.closing === 'escalated' && source.decision?.answers?.[0]?.selected?.[0] === 'Use Short' && sourceEvidence?.status === 'superseded' && [reuse1, blocked, reuse2, comment].every(item => item?.decision?.answers?.[0]?.selected?.[0] !== 'Use Long') && store.cases.length === 6 && store.attempts.length === 6, JSON.stringify({ source, sourceEvidence, cases: store.cases.length, attempts: store.attempts.length }))
  run.check('headless Decision feedback run exited cleanly', (run.code === 0 || run.code === null) && run.stdout.includes('DECISION_FEEDBACK_DONE'), `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default {
  id, prompt, decide, decideDecision, observe, assert,
  env: { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_EVENTS: DECISION_EVENTS, WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id) },
}
