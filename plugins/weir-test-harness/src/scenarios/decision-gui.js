// Opt-in real-Desktop Decision QA brain. It only emits product tool calls.
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { observeDecision } from '../decision-test-kit.js'

const id = 'decision-gui'
const prompt = 'decision-gui-probe'
const QUESTIONS = {
  GUI_A_ANSWER: { id: 'gui-a-answer', question: 'Choose the evidenced GUI title', options: [{ label: 'Native fallback' }, { label: 'Concise' }] },
  GUI_A_OFF: { id: 'gui-a-off', question: 'Choose while the selector is Off', options: [{ label: 'Native Off' }, { label: 'Automatic' }] },
  GUI_B_NEW: { id: 'gui-b-new', question: 'Choose a genuinely new GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_REUSE: { id: 'gui-b-reuse', question: 'Reuse the same GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_AFTER_DOWN: { id: 'gui-b-after-down', question: 'Reuse the disputed GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_AFTER_UNDO: { id: 'gui-b-after-undo', question: 'Reuse the restored GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_AFTER_COMMENT: { id: 'gui-b-after-comment', question: 'Reuse after a neutral GUI comment', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_CORRECTED: { id: 'gui-b-corrected', question: 'Apply the corrected GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_C_OFF: { id: 'gui-c-off', question: 'Choose in a fresh Off profile', options: [{ label: 'Native Off' }, { label: 'Automatic' }] },
  GUI_C_APPROVAL: { id: 'gui-c-approval', question: 'Approve the GUI operation?', options: [{ label: 'Approve' }, { label: 'Reject' }], intent: { kind: 'approval' } },
  GUI_C_PLAN: { id: 'gui-c-plan', question: 'Review the GUI plan?', options: [{ label: 'Accept' }, { label: 'Revise' }], intent: { kind: 'plan-review' } },
  GUI_MEMORY_SOURCE: { id: 'gui-memory-source', question: 'Choose the neutral GUI memory source', options: [{ label: 'Source native' }, { label: 'Neutral GUI answer' }] },
  GUI_MEMORY_REUSE: { id: 'gui-memory-reuse', question: 'Reuse neutral GUI memory without decisive evidence', options: [{ label: 'User resolves GUI memory' }, { label: 'Neutral GUI answer' }] },
  GUI_LEARNING_SOURCE: { id: 'gui-learning-source', question: 'Choose the authoritative GUI learning source', options: [{ label: 'User backed GUI answer' }, { label: 'Other GUI answer' }] },
  GUI_LEARNING_AFTER_V1: { id: 'gui-learning-after-v1', question: 'Use the first published GUI Snapshot', options: [{ label: 'Learned GUI answer' }, { label: 'Other GUI answer' }] },
  GUI_LEARNING_AFTER_V2: { id: 'gui-learning-after-v2', question: 'Use the successor GUI Snapshot', options: [{ label: 'Learned GUI answer' }, { label: 'Other GUI answer' }] },
  GUI_LEARNING_AFTER_ROLLBACK: { id: 'gui-learning-after-rollback', question: 'Use the predecessor GUI Snapshot after rollback', options: [{ label: 'Learned GUI answer' }, { label: 'Other GUI answer' }] },
  GUI_LEARNING_AFTER_EMPTY: { id: 'gui-learning-after-empty', question: 'Answer after all GUI Snapshots roll back', options: [{ label: 'Learned GUI answer' }, { label: 'Other GUI answer' }] },
}
const GUI_LEARNING_QUESTION_IDS = Object.values(QUESTIONS).map(question => question.id).filter(id => id.startsWith('gui-learning-'))

function consultArgs(marker) {
  return { question: `${marker}: needs a new user judgment`, options: [{ label: 'User choice' }, { label: 'Other' }], request_id: marker.toLowerCase() }
}

function decide(options, obs) {
  const messages = options.messages ?? []
  if (messages.at(-1)?.role === 'tool') return textChunks('GUI_SCENARIO_DONE')
  const lastTool = messages.findLastIndex(message => message.role === 'tool')
  const history = JSON.stringify(messages.slice(lastTool + 1))
  const markers = Object.keys(QUESTIONS)
  const marker = markers.find(key => history.includes(key))
  if (marker) return toolCallChunks('ask_user_question', { questions: [QUESTIONS[marker]] })
  const action = ['GUI_B_DECIDE', 'GUI_B_REASSIGN', 'GUI_B_CANCEL', 'GUI_B_RETRY', 'GUI_C_RETURN'].find(key => history.includes(key))
  if (action) return toolCallChunks('decision_consult', consultArgs(action))
  return textChunks('unhandled Decision GUI turn')
}

function decideConsolidation(options, obs) {
  const projection = JSON.parse(obs.lastUser)
  const source = projection.cases.find(item => item.excerpt?.includes('Question gui-learning-source:'))?.caseId
  const rejecting = projection.cases.some(item => item.excerpt?.includes('Question gui-learning-after-empty:'))
  const correction = (projection.feedback ?? []).find(item => item.kind === 'correction')
  const successor = Boolean(projection.parentSnapshot)
  const text = rejecting
    ? 'Rejected GUI candidate: this principle must never become current.'
    : correction
      ? 'Reviewed GUI correction principle: prefer the corrected cross-root answer.'
      : successor
        ? 'Reviewed GUI successor principle: prefer the second source-backed answer.'
        : 'Reviewed GUI principle: prefer the source-backed answer.'
  return textChunks(JSON.stringify({ operations: [{
    op: 'add', principleId: 'temporary-gui-learning', text,
    scope: { workspaces: [projection.workspaceKey] }, sources: correction ? [correction.feedbackId] : source ? [source] : [],
  }] }))
}
function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const question = pack.L4.request.questions[0]
  if (GUI_LEARNING_QUESTION_IDS.includes(question.id) && question.id !== 'gui-learning-source') {
    const principles = Array.isArray(pack.L2) ? pack.L2 : []
    const principle = question.id === 'gui-learning-after-v2'
      ? principles.find(item => item.text?.includes('successor'))
      : principles[0]
    const mapped = principle?.evidenceIds?.[0]
    const fallback = question.id === 'gui-learning-after-empty'
      ? pack.L5.find(ref => ref.source === 'user_decision')?.evidenceId
      : undefined
    const evidenceId = mapped ?? fallback
    if (evidenceId && pack.L5.some(ref => ref.evidenceId === evidenceId)) {
      return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: `${question.id} uses actual L5 provenance.`, evidenceIds: [evidenceId] }], answers: [{ id: question.id, selected: [question.options[0].label] }] }))
    }
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'A reviewed principle must map to actual L5 evidence.' }))
  }
  if (question.id === 'gui-memory-source') {
    const ref = pack.L5.find(evidence => evidence.source === 'user_profile')
    if (ref) return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Neutral GUI answer is supported by the user profile.', evidenceIds: [ref.evidenceId] }], answers: [{ id: question.id, selected: ['Neutral GUI answer'] }] }))
  }
  if (question.id === 'gui-memory-reuse') {
    const episode = Array.isArray(pack.L3) ? pack.L3[0] : undefined
    if (episode) return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Deliberately treat neutral GUI history as evidence.', evidenceIds: [episode.sourceCaseId] }], answers: [{ id: question.id, selected: ['Neutral GUI answer'] }] }))
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'The actual neutral GUI source episode is required for this negative fixture.' }))
  }
  if (question.id === 'gui-a-answer') {
    const ref = pack.L5[0]
    if (ref) return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Concise is supported by the supplied evidence.', evidenceIds: [ref.evidenceId] }], answers: [{ id: question.id, selected: ['Concise'] }] }))
  }
  if (question.id?.startsWith('gui-b-') && question.id !== 'gui-b-new') {
    const correction = pack.L5.find(evidence => evidence.source === 'user_correction')
    const decision = pack.L5.find(evidence => evidence.source === 'user_decision')
    const ref = correction ?? decision
    const selected = ref ? ['Use Long', 'Use Short'].find(choice => ref.excerpt?.includes(choice)) : undefined
    if (ref && selected) {
      return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: `${selected} uses the current ${ref.source}.`, evidenceIds: [ref.evidenceId] }], answers: [{ id: question.id, selected: [selected] }] }))
    }
  }
  if (question.question?.includes('GUI_C_RETURN')) {
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add the missing GUI scope and retry the consultation.' }))
  }
  return textChunks(JSON.stringify({ outcome: 'escalate', missing: [`${question.question} requires a new user judgment`] }))
}

function assert(run) {
  run.check('GUI scenario is opt-in and only produces product tool calls', true, 'Real Desktop assertions live in .weir/decision-qa/gui-*')
}

function observe(obs) {
  const observation = observeDecision(obs)
  const contract = obs.system.split('\n', 1)[0]
  const learning = contract === 'Decision consolidation contract v1' || observation.decisionQuestionIds.some(id => GUI_LEARNING_QUESTION_IDS.includes(id))
  if (learning) {
    let pack
    if (observation.decisionEvaluator) { try { pack = JSON.parse(obs.lastUser) } catch { pack = undefined } }
    return { ...observation, decisionGuiLearning: {
      kind: contract === 'Decision consolidation contract v1' ? 'consolidation' : 'evaluator',
      system: obs.system, content: obs.lastUser, tools: obs.toolNames,
      hasTemperature: obs.hasTemperature, provider: obs.provider, model: obs.model, maxTokens: obs.maxTokens,
      ...(pack ? { pack } : {}),
    } }
  }
  if (!observation.decisionEvaluator || !observation.decisionQuestionIds.some(id => ['gui-memory-source', 'gui-memory-reuse'].includes(id))) return observation
  let pack
  try { pack = JSON.parse(obs.lastUser) } catch { return observation }
  return { ...observation, decisionGuiMemorySystem: obs.system, decisionGuiMemoryPack: pack }
}

export default { id, prompt, decide, decideConsolidation, decideDecision, observe, assert }
