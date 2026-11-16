// P1 two-process restart recovery, waiting-state preservation and idempotent replay.
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { DECISION_EVENTS, decisionStoreDirectory, observeDecision, parseDecisionToolResult, readDecisionStore } from '../decision-test-kit.js'
import { parseJsonlLines } from '../jsonl.js'

const id = 'decision-recovery'
const prompt = 'decision-recovery-probe'
const REPLAY = { question: 'RECOVERY_REPLAY: choose the persisted answer', options: [{ label: 'Persisted answer' }, { label: 'New answer' }], request_id: 'recovery-replay' }
const AUTO_REPLAY = { question: 'AUTO_RECOVERY_INTERRUPT: never answer an interrupted intake', options: [{ label: 'Automatic answer must not exist' }], request_id: 'auto-recovery-interrupt' }

function decide(options, obs) {
  const history = obs.transcript
  const phase = process.env.WEIR_IT_DECISION_PHASE ?? 'before'
  if (history.includes('DECISION_TEST error') || history.includes('DECISION_RECOVERY error')) return textChunks(`DECISION_RECOVERY_${phase.toUpperCase()}_FAILED`)
  if (phase === 'auto-before') {
    if (!history.includes('DECISION_TEST done auto-setup')) return toolCallChunks('decision_integration_probe', { op: 'auto-setup' })
    return toolCallChunks('decision_consult', AUTO_REPLAY)
  }
  if (phase === 'auto-after') {
    if (!history.includes('"outcome":"awaiting_user"')) return toolCallChunks('decision_consult', AUTO_REPLAY)
    if (!history.includes('DECISION_RECOVERY done auto-verify')) return toolCallChunks('decision_recovery_probe', { op: 'auto-verify' })
    return textChunks('DECISION_RECOVERY_AUTO_AFTER_DONE')
  }
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

function decideRouterRoute(options, obs) {
  let pack
  try { pack = JSON.parse(obs.lastUser) } catch { pack = null }
  if (!Array.isArray(pack?.candidates) || pack.candidates.length === 0) throw new Error('decision-recovery: malformed Auto Router pack')
  const selected = pack.candidates[0]
  return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'selected', agentId: selected.agentId, reason: 'Recovery fixture routes deterministically' }))
}

function observe(obs) {
  const base = { ...observeDecision(obs), decisionRecoveryReplay: parseDecisionToolResult(obs.lastTool) }
  const routing = obs.system.split('\n', 1)[0] === 'Auto candidate router contract: router-contract/1'
  if (!routing) return base
  let pack
  try { pack = JSON.parse(obs.lastUser) } catch { pack = null }
  const question = pack?.questions?.[0]?.question ?? ''
  return {
    ...base, autoRecoveryRoute: true, autoRecoveryQuestionIds: pack?.questions?.map(item => item.id) ?? [],
    ...(question.startsWith('AUTO_RECOVERY_INTERRUPT') ? { autoRouterHold: 'interruption' } : {}),
  }
}

async function waitForAutoIntake(root, storePath, readyPath) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(readyPath)) {
      const store = readDecisionStore(join(root, 'ws'), storePath)
      const current = store.cases.find(item => item.request.questions?.[0]?.question?.startsWith('AUTO_RECOVERY_INTERRUPT'))
      if (current?.state === 'received' && current.agent_id === null) {
        return { ready: JSON.parse(readFileSync(readyPath, 'utf8')), current }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for the real received+null Auto intake and held Router verdict')
}

async function run(driver) {
  const root = driver.IT_ROOT
  const traces = []
  const runs = []
  const processRuns = []
  const spawn = async (phase, sessionId, storePath, events, onChild) => {
    const trace = join(root, `trace-${id}-${phase}.jsonl`)
    traces.push(trace)
    const args = sessionId ? ['weir-it', '--session-id', sessionId, prompt] : ['weir-it', '--json', prompt]
    const outcome = await driver.spawnHeadless(args, driver.scenarioEnv(id, trace, {
      WEIR_IT_DECISION: '1', WEIR_IT_DECISION_RECOVERY: '1', WEIR_IT_DECISION_EVENTS: events,
      WEIR_IT_DECISION_STORE_PATH: storePath, WEIR_IT_DECISION_PHASE: phase,
      ...(phase.startsWith('auto-') ? { WEIR_IT_DECISION_AUTO_ANSWER: '1', WEIR_IT_DECISION_TIMEOUT_MS: '30000' } : {}),
    }), onChild)
    const resolvedSessionId = sessionId ?? parseJsonlLines(outcome.stdout).find(row => row?.type === 'session')?.sessionId
    const value = { ...outcome, sessionId: resolvedSessionId, phase }
    runs.push(value)
    processRuns.push({ phase, pid: outcome.pid, exitCode: outcome.code ?? null, signal: outcome.signal ?? null, trace })
    return value
  }

  const before = await spawn('before', undefined, decisionStoreDirectory(id), DECISION_EVENTS)
  const after = await spawn('after', before.sessionId, decisionStoreDirectory(id), DECISION_EVENTS)

  const autoStore = join(root, 'decision-stores', 'decision-recovery-auto')
  const autoEvents = join(root, 'decision-auto-recovery-events.jsonl')
  const autoReady = join(root, 'decision-auto-interruption.ready')
  let child
  const pending = spawn('auto-before', undefined, autoStore, autoEvents, value => { child = value })
  let interruption
  try {
    const observed = await waitForAutoIntake(root, autoStore, autoReady)
    const killRequested = child.kill('SIGKILL')
    const outcome = await pending
    interruption = { ...observed, killRequested, outcome: { code: outcome.code ?? null, signal: outcome.signal ?? null, pid: outcome.pid } }
  } catch (error) {
    child?.kill('SIGKILL')
    const outcome = await pending
    interruption = { error: error?.message ?? String(error), outcome: { code: outcome.code ?? null, signal: outcome.signal ?? null, pid: outcome.pid } }
  }
  const autoBefore = runs.find(item => item.phase === 'auto-before')
  const killedStore = readDecisionStore(join(root, 'ws'), autoStore)
  writeFileSync(join(root, 'ws', 'decision-recovery-auto-killed.json'), JSON.stringify({ interruption, store: killedStore }, null, 2) + '\n')
  const autoAfter = autoBefore?.sessionId && !interruption.error
    ? await spawn('auto-after', autoBefore.sessionId, autoStore, autoEvents)
    : { code: 1, stdout: '', stderr: 'missing Auto interruption session id or failed preconditions', sessionId: null }

  const trace = join(root, `trace-${id}.jsonl`)
  const body = traces.filter(path => existsSync(path)).map(path => readFileSync(path, 'utf8').trim()).filter(Boolean).join('\n')
  writeFileSync(trace, body ? body + '\n' : '')
  writeFileSync(join(root, 'ws', 'decision-recovery-processes.json'), JSON.stringify({ processRuns, autoSessionId: autoBefore?.sessionId ?? null }, null, 2) + '\n')
  return {
    scenario: id, trace, sessionId: before.sessionId,
    code: before.code === 0 && after.code === 0 && autoAfter.code === 0 && autoBefore?.signal === 'SIGKILL' ? 0 : 1,
    stdout: runs.map(item => item.stdout).concat(autoAfter.stdout).join('\n'),
    stderr: runs.map(item => item.stderr).concat(autoAfter.stderr).join('\n'),
    processRuns,
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

  const autoKilledPath = join(run.ws, 'decision-recovery-auto-killed.json')
  const autoKilled = existsSync(autoKilledPath) ? JSON.parse(readFileSync(autoKilledPath, 'utf8')) : null
  const autoAfter = report(run.ws, 'auto-after')
  const processPath = join(run.ws, 'decision-recovery-processes.json')
  const processes = existsSync(processPath) ? JSON.parse(readFileSync(processPath, 'utf8')) : null
  const autoKilledCase = autoKilled?.store?.cases?.find(item => item.request.questions?.[0]?.question?.startsWith('AUTO_RECOVERY_INTERRUPT'))
  const autoAfterCase = autoAfter?.cases?.find(item => item.request.questions?.[0]?.question?.startsWith('AUTO_RECOVERY_INTERRUPT'))
  const autoReplay = run.requests.map(request => request.decisionRecoveryReplay).find(value => value?.caseId === autoAfterCase?.case_id)
  const autoInterruptRun = processes?.processRuns?.find(item => item.phase === 'auto-before')
  run.check('exact-PID SIGKILL captures a real received+null Auto intake before any route, answer, or Attempt', autoKilled?.interruption?.killRequested === true && autoKilled.interruption.outcome?.signal === 'SIGKILL' && autoKilled.interruption.ready?.pid === autoKilled.interruption.outcome?.pid && autoInterruptRun?.signal === 'SIGKILL' && autoKilledCase?.state === 'received' && autoKilledCase?.agent_id === null && autoKilledCase?.decision === null && autoKilled.store.routes.length === 0 && autoKilled.store.attempts.length === 0, JSON.stringify({ interruption: autoKilled?.interruption, autoKilledCase, autoInterruptRun }))

  const autoRoutes = run.requests.filter(request => request.autoRecoveryRoute)
  run.check('restart and same-key replay recover interrupted waiting without automatic answer, reroute, late write, or new model work', autoAfterCase?.case_id === autoKilledCase?.case_id && autoAfterCase?.state === 'awaiting_user' && autoAfterCase?.awaiting_reason === 'interrupted' && autoAfterCase?.agent_id === null && autoAfterCase?.decision === null && autoAfter?.selectors?.[0]?.mode === 'auto' && autoAfter?.routes?.length === 0 && autoAfter?.attempts?.length === 0 && autoAfter?.evidence?.length === 0 && autoAfter?.inbox?.some(item => item.caseId === autoAfterCase.case_id) && autoReplay?.outcome === 'awaiting_user' && autoReplay?.reason === 'interrupted' && autoAfter?.lateStable === true && autoRoutes.length === 1 && run.stdout.includes('DECISION_RECOVERY_AUTO_AFTER_DONE'), JSON.stringify({ autoAfterCase, selector: autoAfter?.selectors, autoReplay, lateStable: autoAfter?.lateStable, autoRoutes }))

  const auditPath = join(run.ws, '.weir', 'audit.jsonl')
  const audit = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : ''
  const auditEvents = JSON.stringify(run.events.filter(event => event.type?.startsWith('weir/decision/')))
  run.check('Auto recovery audit has lifecycle facts but no interrupted question body', !audit.includes(AUTO_REPLAY.question) && !auditEvents.includes(AUTO_REPLAY.question) && auditEvents.includes('weir/decision/recover'), JSON.stringify({ auditBytes: audit.length, recovered: auditEvents.includes('weir/decision/recover') }))
  run.check('both real headless recovery processes exited cleanly', run.code === 0 && run.stdout.includes('DECISION_RECOVERY_BEFORE_DONE') && run.stdout.includes('DECISION_RECOVERY_AFTER_DONE'), `processes=${JSON.stringify(run.processRuns)} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt, decide, decideDecision, decideRouterRoute, observe, run, assert }
