// P1 explicit consultation: three outcomes, delegated root escalation and one-shot Case retrieval.
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { DECISION_EVENTS, decisionStoreDirectory, observeDecision, parseDecisionToolResult, readDecisionEvents, readDecisionStore } from '../decision-test-kit.js'

const id = 'decision-consult'
const prompt = 'decision-consult-probe'
const CHILD_TASK = 'DECISION_CONSULT_CHILD_TASK'
const CHILD_DONE = 'DECISION_CONSULT_CHILD_DONE'

const CONSULTS = {
  answered: { question: 'CONSULT_ANSWER: choose the evidenced title', options: [{ label: 'Concise' }, { label: 'Detailed' }], request_id: 'consult-answered' },
  returned: { question: 'CONSULT_RETURN: choose without audience context', options: [{ label: 'Concise' }, { label: 'Detailed' }], request_id: 'consult-returned' },
  awaiting: { question: 'CONSULT_ESCALATE: choose a genuinely new product direction', options: [{ label: 'Direction A' }, { label: 'Direction B' }], request_id: 'consult-escalated' },
}

function decide(options, obs) {
  const history = obs.transcript
  if (history.includes('DECISION_TEST error')) return textChunks('DECISION_CONSULT_FAILED')
  if (history.includes('INVALID_TOOL_OUTPUT') || history.includes('Error: tool "decision_consult"')) return textChunks('DECISION_CONSULT_FAILED')
  if (history.includes('DECISION_CONSULT_CHILD_FAILED')) return textChunks('DECISION_CONSULT_FAILED')
  const child = history.includes(CHILD_TASK) && !history.includes(prompt)
  if (child) {
    if (!history.includes('"outcome":"awaiting_user"')) return toolCallChunks('decision_consult', CONSULTS.awaiting)
    if (!history.includes('DECISION_TEST done record')) {
      const result = parseDecisionToolResult(obs.lastTool)
      if (result?.outcome !== 'awaiting_user') return textChunks('DECISION_CONSULT_CHILD_FAILED')
      return toolCallChunks('decision_integration_probe', { op: 'record', caseId: result.caseId })
    }
    return textChunks(`STATUS: completed\nREPORT: ${CHILD_DONE}`)
  }
  if (!history.includes('DECISION_TEST done setup')) return toolCallChunks('decision_integration_probe', { op: 'setup' })
  if (!history.includes('"outcome":"answered"')) return toolCallChunks('decision_consult', CONSULTS.answered)
  if (!history.includes('"outcome":"returned"')) return toolCallChunks('decision_consult', CONSULTS.returned)
  if (!history.includes(CHILD_DONE)) {
    return toolCallChunks('delegate', {
      category: 'quick',
      prompt: `TASK: Run one delegated Decision consultation and retrieve its persisted Case once.\nDELIVERABLE: STATUS completed with ${CHILD_DONE}.\nSCOPE: Use only decision_consult and decision_integration_probe; never ask the user.\nVERIFY: Consult returns awaiting_user and the single record read has the same caseId.\nSTOP WHEN: The root-layer Case has been read once.\n${CHILD_TASK}`,
    })
  }
  return textChunks('DECISION_CONSULT_DONE')
}

function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const question = pack.L4.request.questions[0]
  const evidenceId = pack.L5.find(evidence => evidence.source === 'user_profile')?.evidenceId
  if (question.question.startsWith('CONSULT_ANSWER') && evidenceId) {
    return textChunks(JSON.stringify({
      outcome: 'answer',
      claims: [{ text: 'The pinned user profile selects Concise.', evidenceIds: [evidenceId] }],
      answers: [{ id: question.id, selected: ['Concise'] }],
    }))
  }
  if (question.question.startsWith('CONSULT_RETURN')) {
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Provide the target audience and retry the consultation.' }))
  }
  return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['A genuinely new product direction requires user judgment.'] }))
}

function observe(obs) {
  let probeRecord = null
  if (obs.lastTool.startsWith('DECISION_TEST done record')) {
    try { probeRecord = JSON.parse(obs.lastTool.slice(obs.lastTool.indexOf(':') + 1)) } catch {}
  }
  return {
    ...observeDecision(obs),
    decisionConsultResult: parseDecisionToolResult(obs.lastTool),
    decisionProbeRecord: probeRecord,
  }
}

function readProbeRecord(run) {
  return run.requests.find(request => request.decisionProbeRecord)?.decisionProbeRecord ?? null
}

function assert(run) {
  const store = readDecisionStore(run.ws, decisionStoreDirectory(id))
  const outputs = [...new Map(run.requests.map(request => request.decisionConsultResult).filter(Boolean).map(value => [value.caseId, value])).values()]
  const answeredOutput = outputs.find(value => value.outcome === 'answered')
  const returnedOutput = outputs.find(value => value.outcome === 'returned')
  const awaitingOutput = outputs.find(value => value.outcome === 'awaiting_user')
  const caseFor = marker => store.cases.find(item => item.request.questions?.[0]?.question?.startsWith(marker))
  const answered = caseFor('CONSULT_ANSWER')
  const returned = caseFor('CONSULT_RETURN')
  const awaiting = caseFor('CONSULT_ESCALATE')
  const retrieved = readProbeRecord(run)
  const stubEvents = readDecisionEvents()
  const asked = run.requests.some(request => request.emittedNames?.includes('ask_user_question'))

  run.check('answered consult carries caseId, evidence provenance and pins in the real tool output', Boolean(answered && answeredOutput) && answeredOutput.caseId === answered.case_id && answeredOutput.evidence?.some(ref => ref.source === 'user_profile') && answeredOutput.pins?.promptVersion === 'evaluator-contract/1' && answered.state === 'closed' && answered.closing === 'answered', JSON.stringify({ answeredOutput, answered }))
  run.check('returned consult is awaiting_revision at delivery and closed(returned) after turn stopping', returnedOutput?.outcome === 'returned' && returnedOutput.code === 'MISSING_CONTEXT' && returnedOutput.hint?.includes('target audience') && returned?.state === 'closed' && returned?.closing === 'returned' && returned?.decision?.code === 'MISSING_CONTEXT', JSON.stringify({ returnedOutput, returned }))
  run.check('delegated awaiting_user persists in the root inbox and is retrieved once by caseId', awaiting?.state === 'awaiting_user' && awaiting?.awaiting_reason === 'consult_escalate' && awaiting?.origin_kind === 'delegated' && awaiting?.root_session_id !== awaiting?.origin_session_id && retrieved?.record?.case?.caseId === awaiting?.case_id && retrieved?.record?.case?.state === 'awaiting_user' && retrieved?.inbox?.some(item => item.caseId === awaiting?.case_id), JSON.stringify({ awaitingOutput, awaiting, retrieved }))
  run.check('three consult outcomes have exactly one Attempt each and no user-question path', outputs.length === 3 && store.cases.length === 3 && store.attempts.length === 3 && !asked && stubEvents.length === 0, JSON.stringify({ outputs, attempts: store.attempts, stubEvents, asked }))
  run.check('strict-provider headless consult run exited cleanly', (run.code === 0 || run.code === null) && run.stdout.includes('DECISION_CONSULT_DONE'), `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default {
  id, prompt, decide, decideDecision, observe, assert,
  env: { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_EVENTS: DECISION_EVENTS, WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id) },
}
