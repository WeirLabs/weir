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
}

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

function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const question = pack.L4.request.questions[0]
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
  if (!observation.decisionEvaluator || !observation.decisionQuestionIds.some(id => ['gui-memory-source', 'gui-memory-reuse'].includes(id))) return observation
  let pack
  try { pack = JSON.parse(obs.lastUser) } catch { return observation }
  return { ...observation, decisionGuiMemorySystem: obs.system, decisionGuiMemoryPack: pack }
}

export default { id, prompt, decide, decideDecision, observe, assert }
