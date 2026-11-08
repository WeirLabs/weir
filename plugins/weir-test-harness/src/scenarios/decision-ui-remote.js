// P1 direct remote-service integration: every read/action method, bare child ids and error envelopes.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { DECISION_EVENTS, decisionStoreDirectory, observeDecision, parseDecisionToolResult, readDecisionEvents, readDecisionStore } from '../decision-test-kit.js'

const id = 'decision-ui-remote'
const prompt = 'decision-ui-remote-probe'
const CHILD_TASK = 'DECISION_REMOTE_CHILD_TASK'
const CHILD_DONE = 'DECISION_REMOTE_CHILD_DONE'
const CHILD_QUESTION = 'REMOTE_CHILD: escalate a delegated consultation'
const METHODS = ['overview', 'agents', 'agent', 'records', 'record', 'inbox', 'metrics', 'caseForCall', 'caseForToolCall', 'setSelector', 'decide', 'reassign', 'cancel', 'retry', 'feedback', 'correction', 'profileUpsert', 'profileSetState']

function decide(options, obs) {
  const history = obs.transcript
  if (history.includes('DECISION_REMOTE error')) return textChunks('DECISION_UI_REMOTE_FAILED')
  const child = history.includes(CHILD_TASK) && !history.includes(prompt)
  if (child) {
    if (!history.includes('"outcome":"awaiting_user"')) return toolCallChunks('decision_consult', { question: CHILD_QUESTION, options: [{ label: 'User child' }, { label: 'Other' }], request_id: 'remote-child' })
    if (!history.includes('DECISION_REMOTE done child-read')) {
      const result = parseDecisionToolResult(obs.lastTool)
      if (!result) return textChunks('DECISION_REMOTE_CHILD_FAILED')
      return toolCallChunks('decision_remote_probe', { op: 'child-read', caseId: result.caseId })
    }
    return textChunks(`STATUS: completed\nREPORT: ${CHILD_DONE}`)
  }
  if (history.includes('DECISION_REMOTE_CHILD_FAILED')) return textChunks('DECISION_UI_REMOTE_FAILED')
  if (!history.includes('DECISION_REMOTE done root')) return toolCallChunks('decision_remote_probe', { op: 'root' })
  if (!history.includes(CHILD_DONE)) {
    return toolCallChunks('delegate', { category: 'quick', prompt: `TASK: Create a delegated Decision Case and read it through the remote service.\nDELIVERABLE: STATUS completed with ${CHILD_DONE}.\nSCOPE: decision_consult then decision_remote_probe only; never ask the user.\nVERIFY: Both case lookup methods succeed with the bare child sessionId.\nSTOP WHEN: Child reads are complete.\n${CHILD_TASK}` })
  }
  return textChunks('DECISION_UI_REMOTE_DONE')
}

function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const question = pack.L4.request.questions[0]
  if (question.question.startsWith('REMOTE_ANSWER')) {
    const evidenceId = pack.L5.find(evidence => evidence.source === 'user_profile')?.evidenceId
    if (evidenceId) return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Remote A is supported by the user profile.', evidenceIds: [evidenceId] }], answers: [{ id: question.id, selected: ['Remote A'] }] }))
  }
  return textChunks(JSON.stringify({ outcome: 'escalate', missing: [`${question.question} requires a new user judgment`] }))
}

function report(ws, name) {
  const path = join(ws, name)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function assert(run) {
  const root = report(run.ws, 'decision-ui-remote-report.json')
  const child = report(run.ws, 'decision-ui-remote-child.json')
  const store = readDecisionStore(run.ws, decisionStoreDirectory(id))
  const calls = root?.calls ?? {}
  const fixtures = root?.fixtures
  const missing = METHODS.filter(method => calls[method]?.ok !== true)
  const caseById = caseId => store.cases.find(item => item.case_id === caseId)
  const reassignCase = caseById(fixtures?.waiting?.reassign?.caseId)
  const retryCase = caseById(fixtures?.waiting?.retry?.caseId)

  run.check('all 18 remote read/action methods return ok envelopes with bare args and no agent lookup', Boolean(root) && missing.length === 0 && root.noAgentLookup === true && child?.noAgentLookup === true && calls.overview?.value?.selector?.agentId === fixtures?.agentA && calls.agents?.value?.length === 2 && calls.agent?.value?.agentId === fixtures?.agentA, JSON.stringify({ missing, noAgentLookup: [root?.noAgentLookup, child?.noAgentLookup] }))
  run.check('read models, record detail, inbox, metrics and both root case lookups return authoritative shapes', calls.records?.value?.records?.length === 5 && calls.record?.value?.case?.caseId === fixtures?.answered?.caseId && Array.isArray(calls.inbox?.value) && calls.inbox.value.length === 4 && calls.metrics?.value?.casesOpened === 5 && calls.caseForCall?.value?.case?.caseId === fixtures?.answered?.caseId && calls.caseForToolCall?.value?.case?.caseId === fixtures?.answered?.caseId, JSON.stringify({ records: calls.records, record: calls.record, inbox: calls.inbox, metrics: calls.metrics, caseForCall: calls.caseForCall, caseForToolCall: calls.caseForToolCall }))
  run.check('decide/reassign/cancel/retry/feedback/correction/profile actions mutate the authoritative store', calls.decide?.value?.closing === 'escalated' && caseById(fixtures?.waiting?.decide?.caseId)?.decision?.kind === 'user_decision' && reassignCase?.agent_id === fixtures?.agentB && store.routes.some(route => route.case_id === reassignCase?.case_id && route.mode === 'manual_reassign') && calls.cancel?.value?.closing === 'cancelled' && caseById(fixtures?.waiting?.cancel?.caseId)?.closing === 'cancelled' && retryCase?.attempt_count === 2 && calls.feedback?.value?.kind === 'rating_up' && calls.correction?.value?.kind === 'correction' && calls.profileSetState?.value?.state === 'disabled', JSON.stringify({ decide: calls.decide, reassignCase, cancel: calls.cancel, retryCase, feedback: calls.feedback, correction: calls.correction, profileSetState: calls.profileSetState }))
  run.check('bare child sessionId resolves both case lookups and root inbox without agent lookup', Boolean(child) && child.childSessionId !== child.calls.record?.value?.case?.rootSessionId && child.calls.caseForCall?.value?.case?.caseId === child.caseId && child.calls.caseForToolCall?.value?.case?.caseId === child.caseId && child.calls.record?.value?.case?.originSessionId === child.childSessionId && child.calls.inbox?.value?.some(item => item.caseId === child.caseId), JSON.stringify(child))
  run.check('error paths return bounded ok:false envelopes without throwing or stacks', root?.calls?.errorPath?.ok === false && root.calls.errorPath.error.code === 'PROFILE_NOT_FOUND' && child?.calls?.errorPath?.ok === false && child.calls.errorPath.error.code === 'PROFILE_NOT_FOUND' && !JSON.stringify([root.calls.errorPath, child.calls.errorPath]).includes('stack'), JSON.stringify({ root: root?.calls?.errorPath, child: child?.calls?.errorPath }))
  run.check('headless remote run has no native question path and exits cleanly', (run.code === 0 || run.code === null) && run.stdout.includes('DECISION_UI_REMOTE_DONE') && !run.requests.some(request => request.emittedNames?.includes('ask_user_question')) && readDecisionEvents().length === 0 && store.cases.length === 6, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default {
  id, prompt, decide, decideDecision, observe: observeDecision, assert,
  env: { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_REMOTE: '1', WEIR_IT_DECISION_EVENTS: DECISION_EVENTS, WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id) },
}
