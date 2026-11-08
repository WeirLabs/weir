// Disposable mock brain for the authorized current-Desktop P0 fixture.
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'decision-spike-current'
const prompt = 'P0_CURRENT_PROFILE'

function ask(questionId) {
  return {
    id: questionId,
    question: 'Which option should be recorded?',
    options: [{ label: 'A', description: 'First option' }, { label: 'B', description: 'Second option' }],
  }
}

function decide(options, obs) {
  const history = obs.transcript
  const lastTool = lastOfRole(options, 'tool')
  if (history.includes('P0_SUBAGENT')) {
    if (lastTool.includes('"outcome":"answered"')) return textChunks('STATUS: completed\nREPORT: P0_SUBAGENT_DONE')
    return toolCallChunks('decision_consult', { question: 'Subagent decision for remote read proof', request_id: 'p0-subagent', options: [{ label: 'A' }, { label: 'B' }] })
  }
  if (lastTool) return textChunks('P0_TOOL_RESULT_OBSERVED')
  if (history.includes('P0_BATCH_ALL')) return toolCallChunks('ask_user_question', {
    questions: [
      { ...ask('all-a'), question: 'Batch question A' },
      { ...ask('all-b'), question: 'Batch question B (multi)', multi_select: true },
      { ...ask('all-c'), question: 'Batch question C' },
    ],
  })
  if (history.includes('P0_BATCH_PARTIAL')) return toolCallChunks('ask_user_question', {
    questions: [
      { ...ask('partial-a'), question: 'Batch question A' },
      { ...ask('partial-b'), question: 'Batch question B (multi)', multi_select: true },
      { ...ask('partial-c'), question: 'Batch question C' },
    ],
  })
  if (history.includes('P0_NATIVE')) return toolCallChunks('ask_user_question', { questions: [ask('native-card')] })
  if (history.includes('P0_OFF')) return toolCallChunks('ask_user_question', { questions: [ask('desktop-choice')] })
  if (history.includes('P0_ANSWERED')) return toolCallChunks('ask_user_question', { questions: [ask('desktop-choice')] })
  if (history.includes(prompt)) return textChunks('P0_CURRENT_READY')
  return textChunks('P0_CURRENT_IDLE')
}

function assert(run) {
  run.skip('Current-Desktop-only mock brain', 'driven by current-profile fixture, not headless evidence')
}

export default { id, prompt, decide, assert }
