// P1 two-process restart recovery, waiting-state preservation and idempotent replay.
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { DECISION_EVENTS, decisionStoreDirectory, observeDecision, parseDecisionToolResult, readDecisionStore } from '../decision-test-kit.js'
import { parseJsonlLines } from '../jsonl.js'

const id = 'decision-recovery'
const prompt = 'decision-recovery-probe'
const REPLAY = { question: 'RECOVERY_REPLAY: choose the persisted answer', options: [{ label: 'Persisted answer' }, { label: 'New answer' }], request_id: 'recovery-replay' }

function decide(options, obs) {
  const history = obs.transcript
  const phase = process.env.WEIR_IT_DECISION_PHASE === 'after' ? 'after' : 'before'
  if (history.includes('DECISION_TEST error') || history.includes('DECISION_RECOVERY error')) return textChunks(`DECISION_RECOVERY_${phase.toUpperCase()}_FAILED`)
  if (phase === 'before' && !history.includes('DECISION_TEST done setup')) return toolCallChunks('decision_integration_probe', { op: 'setup' })
  const answeredCount = (history.match(/"outcome":"answered"/g) ?? []).length
  if (answeredCount < (phase === 'after' ? 2 : 1)) return toolCallChunks('decision_consult', REPLAY)
  if (phase === 'before' && !history.includes('DECISION_RECOVERY done seed')) return toolCallChunks('decision_recovery_probe', { op: 'seed' })
  if (phase === 'after' && !history.includes('DECISION_RECOVERY done verify')) return toolCallChunks('decision_recovery_probe', { op: 'verify' })
  return textChunks(`DECISION_RECOVERY_${phase.toUpperCase()}_DONE`)
}

function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const question = pack.L4.request.questions[0]
  const evidenceId = pack.L5.find(evidence => evidence.source === 'user_profile')?.evidenceId
  if (question.question.startsWith('RECOVERY_REPLAY') && evidenceId) {
    return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'The persisted profile supports the replay answer.', evidenceIds: [evidenceId] }], answers: [{ id: question.id, selected: ['Persisted answer'] }] }))
  }
  return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['Unknown recovery evaluation fixture'] }))
}

function observe(obs) {
  return { ...observeDecision(obs), decisionRecoveryReplay: parseDecisionToolResult(obs.lastTool) }
}

async function run(driver) {
  const trace = join(driver.IT_ROOT, `trace-${id}-before.jsonl`)
  const before = await driver.spawnHeadless(['weir-it', '--json', prompt], driver.scenarioEnv(id, trace, { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_RECOVERY: '1', WEIR_IT_DECISION_EVENTS: DECISION_EVENTS, WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id), WEIR_IT_DECISION_PHASE: 'before' }))
  const sessionId = parseJsonlLines(before.stdout).find(row => row?.type === 'session')?.sessionId
  const trace2 = join(driver.IT_ROOT, `trace-${id}-after.jsonl`)
  const after = sessionId
    ? await driver.spawnHeadless(['weir-it', '--session-id', sessionId, prompt], driver.scenarioEnv(id, trace2, { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_RECOVERY: '1', WEIR_IT_DECISION_EVENTS: DECISION_EVENTS, WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id), WEIR_IT_DECISION_PHASE: 'after' }))
    : { code: 1, stdout: '', stderr: 'missing phase-one session id' }
  return {
    scenario: id, trace, trace2, sessionId,
    code: before.code === 0 && after.code === 0 ? 0 : 1,
    stdout: `${before.stdout}\n${after.stdout}`, stderr: `${before.stderr}\n${after.stderr}`,
    processRuns: [{ phase: 'before', exitCode: before.code }, { phase: 'after', exitCode: after.code }],
  }
}

function report(ws, phase) {
  const path = join(ws, `decision-recovery-${phase}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function assert(run) {
  const before = report(run.ws, 'before')
  const after = report(run.ws, 'after')
  const store = readDecisionStore(run.ws, decisionStoreDirectory(id))
  const caseFor = (snapshot, suffix) => snapshot?.cases.find(item => item.request.questions?.[0]?.id === `decision-recovery-${suffix}`)
  const waitingBefore = caseFor(before, 'waiting')
  const waitingAfter = caseFor(after, 'waiting')
  const revisionBefore = caseFor(before, 'revision')
  const revisionAfter = caseFor(after, 'revision')
  const evaluatingBefore = caseFor(before, 'evaluating')
  const recoveredAfter = caseFor(after, 'evaluating')
  const replayBefore = before?.cases.find(item => item.idempotency_key?.endsWith(':recovery-replay'))
  const replayAfter = after?.cases.find(item => item.idempotency_key?.endsWith(':recovery-replay'))
  const interrupted = after?.attempts.filter(attempt => attempt.case_id === recoveredAfter?.case_id) ?? []
  const replayRequests = [...run.requests, ...run.requests2].map(request => request.decisionRecoveryReplay).filter(value => value?.caseId === replayBefore?.case_id)

  run.check('awaiting_user and awaiting_revision survive a real process restart unchanged', waitingBefore?.state === 'awaiting_user' && waitingAfter?.state === 'awaiting_user' && waitingAfter?.awaiting_reason === waitingBefore?.awaiting_reason && revisionBefore?.state === 'awaiting_revision' && revisionAfter?.state === 'awaiting_revision' && revisionAfter?.attempt_count === revisionBefore?.attempt_count, JSON.stringify({ waitingBefore, waitingAfter, revisionBefore, revisionAfter }))
  run.check('open evaluating Attempt becomes interrupted awaiting_user without becoming an answer', evaluatingBefore?.state === 'evaluating' && recoveredAfter?.state === 'awaiting_user' && recoveredAfter?.awaiting_reason === 'interrupted' && !recoveredAfter?.decision && interrupted.length === 1 && interrupted[0].outcome === 'failed' && interrupted[0].error?.kind === 'interrupted', JSON.stringify({ evaluatingBefore, recoveredAfter, interrupted }))
  run.check('same consult idempotency key returns the terminal Case without a new Attempt', replayBefore?.closing === 'answered' && replayAfter?.case_id === replayBefore?.case_id && replayAfter?.attempt_count === 1 && replayRequests.length === 2 && replayRequests.every(value => value.outcome === 'answered') && store.attempts.filter(attempt => attempt.case_id === replayBefore?.case_id).length === 1, JSON.stringify({ replayBefore, replayAfter, replayRequests }))
  run.check('selector and recovered/waiting inbox entries survive; total records stay bounded', before?.selector?.agentId === after?.selector?.agentId && after?.inbox?.some(item => item.caseId === waitingAfter?.case_id) && after?.inbox?.some(item => item.caseId === recoveredAfter?.case_id) && !after?.inbox?.some(item => item.caseId === revisionAfter?.case_id) && before?.cases.length === 4 && after?.cases.length === 4 && after?.attempts.length === 4, JSON.stringify({ beforeSelector: before?.selector, afterSelector: after?.selector, inbox: after?.inbox, cases: after?.cases.length, attempts: after?.attempts.length }))
  run.check('both real headless recovery processes exited cleanly', run.code === 0 && run.stdout.includes('DECISION_RECOVERY_BEFORE_DONE') && run.stdout.includes('DECISION_RECOVERY_AFTER_DONE'), `processes=${JSON.stringify(run.processRuns)} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt, decide, decideDecision, observe, run, assert }
