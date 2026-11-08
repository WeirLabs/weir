// P1 Decision Hook through the real prepend adapter, Broker, mock sidecar and SQLite store.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IT_ROOT, textChunks, toolCallChunks } from '../mock-kit.js'
import { observeDecision } from '../decision-test-kit.js'

const id = 'decision-hook'
const prompt = 'decision-hook-probe'
const EVENTS = join(IT_ROOT, 'decision-integration-events.jsonl')

const QUESTIONS = {
  off: { id: 'decision-hook-off', question: 'While Off, who should answer?', options: [{ label: 'Native Off' }, { label: 'Automatic Off' }] },
  answer: { id: 'decision-hook-answer', question: 'Which title style is evidenced?', options: [{ label: 'Native fallback' }, { label: 'Concise' }] },
  missing: { id: 'decision-hook-missing', question: 'Which title fits the unstated audience?', options: [{ label: 'User context' }, { label: 'Guess' }] },
  invalid: { id: 'decision-hook-invalid', question: 'Which option survives malformed evaluator output?', options: [{ label: 'User judgment' }, { label: 'Malformed output' }] },
}

function ask(key) {
  return toolCallChunks('ask_user_question', { questions: [QUESTIONS[key]] })
}

function decide(options, obs) {
  const history = obs.transcript
  if (history.includes('DECISION_TEST error')) return textChunks('DECISION_HOOK_FAILED')
  if (!history.includes(QUESTIONS.off.id)) return ask('off')
  if (!history.includes('DECISION_TEST done setup')) return toolCallChunks('decision_integration_probe', { op: 'setup' })
  if (!history.includes(QUESTIONS.answer.id)) return ask('answer')
  if (!history.includes(QUESTIONS.missing.id)) return ask('missing')
  if (!history.includes(QUESTIONS.invalid.id)) return ask('invalid')
  return textChunks('DECISION_HOOK_DONE')
}

function packOf(obs) {
  try { return JSON.parse(obs.lastUser) } catch { return undefined }
}

function decideDecision(options, obs) {
  const pack = packOf(obs)
  const questions = pack?.L4?.request?.questions ?? []
  const questionId = questions[0]?.id
  const evidenceId = pack?.L5?.find(evidence => evidence.source === 'user_profile')?.evidenceId
  if (questionId === QUESTIONS.answer.id && evidenceId) {
    return textChunks(JSON.stringify({
      outcome: 'answer',
      claims: [{ text: 'The pinned user profile selects the Concise title.', evidenceIds: [evidenceId] }],
      answers: [{ id: questionId, selected: ['Concise'] }],
    }))
  }
  if (questionId === QUESTIONS.missing.id) {
    return textChunks(JSON.stringify({
      outcome: 'return', reasonCode: 'MISSING_CONTEXT',
      hint: 'Name the target audience before selecting a title.',
    }))
  }
  if (questionId === QUESTIONS.invalid.id) return textChunks('this is not JSON')
  return textChunks(JSON.stringify({ outcome: 'escalate', missing: [`No scripted evidence-backed outcome for ${questionId ?? 'unknown question'}`] }))
}

function observe(obs) {
  return observeDecision(obs)
}

function readEvents() {
  if (!existsSync(EVENTS)) return []
  return readFileSync(EVENTS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function readStore(ws) {
  const path = join(ws, '..', 'home', 'weir', 'profiles', 'weir-it', 'decisions', 'decision.db')
  if (!existsSync(path)) return { path, cases: [], attempts: [], routes: [] }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      path,
      cases: db.prepare('SELECT case_id,state,closing,awaiting_reason,request_json,decision_json,attempt_count FROM cases ORDER BY created_at,case_id').all()
        .map(row => ({ ...row, request: JSON.parse(row.request_json), decision: row.decision_json ? JSON.parse(row.decision_json) : null })),
      attempts: db.prepare('SELECT case_id,attempt_no,outcome,return_code,error_json FROM attempts ORDER BY case_id,attempt_no').all()
        .map(row => ({ ...row, error: row.error_json ? JSON.parse(row.error_json) : null })),
      routes: db.prepare('SELECT case_id,mode,chosen FROM route_decisions ORDER BY created_at,route_decision_id').all(),
    }
  } finally {
    db.close()
  }
}

function assert(run) {
  const store = readStore(run.ws)
  const events = readEvents()
  const caseFor = questionId => store.cases.find(item => item.request.questions?.some(question => question.id === questionId))
  const off = caseFor(QUESTIONS.off.id)
  const answered = caseFor(QUESTIONS.answer.id)
  const missing = caseFor(QUESTIONS.missing.id)
  const invalid = caseFor(QUESTIONS.invalid.id)
  const stubIds = events.filter(event => event.listener === 'user-questions-stub').flatMap(event => event.questionIds ?? [])
  const answerAttempts = store.attempts.filter(attempt => attempt.case_id === answered?.case_id)
  const invalidAttempts = store.attempts.filter(attempt => attempt.case_id === invalid?.case_id)
  const evaluatorAnswer = run.requests.find(request => request.decisionEvaluator && request.decisionQuestionIds?.includes(QUESTIONS.answer.id))

  run.check('Off creates no Case, route sample, evaluator call or pre-setup store', !off && store.cases.length === 3 && store.routes.length === 3 && !run.requests.some(request => request.decisionQuestionIds?.includes(QUESTIONS.off.id)) && run.requests.some(request => request.lastTool.includes('"storeExistedBeforeSetup":false')), JSON.stringify({ cases: store.cases.map(item => item.request.questions?.map(question => question.id)), routes: store.routes }))
  run.check('answerable Hook returns the evidenced complete batch without the native stub', answered?.state === 'closed' && answered?.closing === 'answered' && answered?.decision?.answers?.[0]?.selected?.[0] === 'Concise' && answerAttempts.length === 1 && answerAttempts[0].outcome === 'answer' && !stubIds.includes(QUESTIONS.answer.id) && (evaluatorAnswer?.decisionEvidenceIds?.length ?? 0) > 0, JSON.stringify({ answered, answerAttempts, stubIds, evaluatorAnswer }))
  run.check('missing context falls through next() and closes returned at turn stopping', missing?.state === 'closed' && missing?.closing === 'returned' && missing?.decision?.code === 'MISSING_CONTEXT' && stubIds.includes(QUESTIONS.missing.id), JSON.stringify({ missing, stubIds }))
  run.check('malformed evaluator output retries then escalates without fabricating an answer', invalid?.state === 'closed' && invalid?.closing === 'escalated' && invalid?.decision?.kind === 'user_decision' && invalidAttempts.length === 3 && invalidAttempts.every(attempt => attempt.outcome === 'failed' && attempt.error?.kind === 'invalid_output') && stubIds.includes(QUESTIONS.invalid.id), JSON.stringify({ invalid, invalidAttempts }))
  run.check('headless Decision Hook run exited cleanly', (run.code === 0 || run.code === null) && run.stdout.includes('DECISION_HOOK_DONE'), `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default {
  id, prompt, decide, decideDecision, observe, assert,
  env: { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_EVENTS: EVENTS },
}
