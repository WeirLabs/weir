// P1 all-or-nothing question batches through the real Hook and G7 shape gate.
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { DECISION_EVENTS, decisionStoreDirectory, observeDecision, readDecisionEvents, readDecisionStore } from '../decision-test-kit.js'

const id = 'decision-batch'
const prompt = 'decision-batch-probe'

const ALL = [
  { id: 'decision-batch-all-1', question: 'Choose the first evidenced label', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
  { id: 'decision-batch-all-2', question: 'Choose both evidenced labels', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multi_select: true },
  { id: 'decision-batch-all-3', question: 'Choose the final evidenced label', options: [{ label: 'Short' }, { label: 'Long' }] },
]
const PARTIAL = [
  { id: 'decision-batch-partial-1', question: 'Choose the first partially evidenced label', options: [{ label: 'Native One' }, { label: 'Auto One' }] },
  { id: 'decision-batch-partial-2', question: 'Choose without the missing decisive evidence', options: [{ label: 'Native Two' }, { label: 'Auto Two' }] },
  { id: 'decision-batch-partial-3', question: 'Choose the third partially evidenced label', options: [{ label: 'Native Three' }, { label: 'Auto Three' }] },
]
const APPROVAL = [
  { id: 'decision-batch-approval-1', question: 'Choose an ordinary label beside the approval', options: [{ label: 'Native Ordinary' }, { label: 'Auto Ordinary' }] },
  { id: 'decision-batch-approval-2', question: 'Approve this sensitive operation?', options: [{ label: 'Native Approval' }, { label: 'Auto Approval' }], intent: { kind: 'approval' } },
]

function decide(options, obs) {
  const history = obs.transcript
  if (history.includes('DECISION_TEST error')) return textChunks('DECISION_BATCH_FAILED')
  if (!history.includes('DECISION_TEST done setup')) return toolCallChunks('decision_integration_probe', { op: 'setup' })
  if (!history.includes(ALL[0].id)) return toolCallChunks('ask_user_question', { questions: ALL })
  if (!history.includes(PARTIAL[0].id)) return toolCallChunks('ask_user_question', { questions: PARTIAL })
  if (!history.includes(APPROVAL[0].id)) return toolCallChunks('ask_user_question', { questions: APPROVAL })
  return textChunks('DECISION_BATCH_DONE')
}

function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const questions = pack.L4.request.questions
  const evidenceId = pack.L5.find(evidence => evidence.source === 'user_profile')?.evidenceId
  const ids = questions.map(question => question.id)
  if (!evidenceId) return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['The profile evidence fixture is absent'] }))
  if (ids.includes(ALL[0].id)) {
    const selected = ['Alpha', ['A', 'B'], 'Short']
    const answers = questions.map((question, index) => ({ id: question.id, selected: Array.isArray(selected[index]) ? selected[index] : [selected[index]] }))
    return textChunks(JSON.stringify({
      outcome: 'answer',
      claims: answers.map(answer => ({ text: `${answer.id} is supported by the pinned profile.`, evidenceIds: [evidenceId] })),
      answers,
    }))
  }
  if (ids.includes(PARTIAL[0].id)) {
    const answers = [{ id: PARTIAL[0].id, selected: ['Auto One'] }, { id: PARTIAL[2].id, selected: ['Auto Three'] }]
    return textChunks(JSON.stringify({
      outcome: 'answer',
      claims: answers.map(answer => ({ text: `${answer.id} is supported; the middle question is unresolved.`, evidenceIds: [evidenceId] })),
      answers,
    }))
  }
  return textChunks('approval batches must not reach the Decision evaluator')
}

function assert(run) {
  const store = readDecisionStore(run.ws, decisionStoreDirectory(id))
  const events = readDecisionEvents()
  const caseFor = questionId => store.cases.find(item => item.request.questions?.some(question => question.id === questionId))
  const all = caseFor(ALL[0].id)
  const partial = caseFor(PARTIAL[0].id)
  const approval = caseFor(APPROVAL[0].id) ?? caseFor(APPROVAL[1].id)
  const stubFor = questionId => events.find(event => event.questionIds?.includes(questionId))
  const allStub = stubFor(ALL[0].id)
  const partialStub = stubFor(PARTIAL[0].id)
  const partialSnapshot = partialStub?.caseSnapshot?.case
  const finalPartialAnswers = partial?.decision?.answers ?? []
  const perQuestion = partial?.escalation?.perQuestion ?? []

  run.check('three-question batch including multiSelect returns one complete evidenced answer', all?.state === 'closed' && all?.closing === 'answered' && all?.decision?.answers?.length === 3 && all.decision.answers[0].selected[0] === 'Alpha' && all.decision.answers[1].selected.join('+') === 'A+B' && all.decision.answers[2].selected[0] === 'Short' && !allStub, JSON.stringify({ all, allStub }))
  run.check('one missing answer sends the original whole batch to the native stub with partial_batch snapshot', partialSnapshot?.state === 'awaiting_user' && partialSnapshot?.awaitingReason === 'partial_batch' && partialStub?.answer?.answers?.length === 3 && partialStub.answer.answers.every((answer, index) => answer.id === PARTIAL[index].id && answer.selected[0] === PARTIAL[index].options[0].label), JSON.stringify({ partialSnapshot, partialStub }))
  run.check('partial auto answers remain suggestions only and never replace native answers', perQuestion.length === 3 && perQuestion[0].outcome === 'answer' && perQuestion[1].outcome === 'return' && perQuestion[2].outcome === 'answer' && finalPartialAnswers.length === 3 && finalPartialAnswers.every((answer, index) => answer.selected[0] === PARTIAL[index].options[0].label) && partial?.closing === 'escalated', JSON.stringify({ perQuestion, partial }))
  run.check('approval contaminates the whole batch into bypass with zero Case, route or evaluator sample', !approval && store.cases.length === 2 && store.routes.length === 2 && Boolean(stubFor(APPROVAL[0].id)) && Boolean(stubFor(APPROVAL[1].id)) && !run.requests.some(request => request.decisionQuestionIds?.some(id => id.startsWith('decision-batch-approval'))), JSON.stringify({ approval, cases: store.cases.length, routes: store.routes }))
  run.check('headless Decision batch run exited cleanly', (run.code === 0 || run.code === null) && run.stdout.includes('DECISION_BATCH_DONE'), `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default {
  id, prompt, decide, decideDecision, observe: observeDecision, assert,
  env: { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_EVENTS: DECISION_EVENTS, WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id) },
}
