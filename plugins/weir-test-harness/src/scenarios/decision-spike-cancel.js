// P0-S6: two real headless processes share the durable disposable Case store.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'
import { writeDecisionEvidence } from '../decision-spike-evidence.js'

const id = 'decision-spike-cancel'
const prompt = 'decision-spike-cancel-probe'

function decide(options, obs) {
  if (obs.system.includes('Decision evaluator contract v1')) return textChunks('HANG')
  const lastTool = lastOfRole(options, 'tool')
  if (lastTool.includes('DECISION_SPIKE')) {
    const phase = process.env.WEIR_IT_DECISION_PHASE === 'after' ? 'AFTER' : 'BEFORE'
    return textChunks(lastTool.includes('"pass":true') ? `S6_${phase}_DONE` : `S6_${phase}_FAILED`)
  }
  if (lastTool.startsWith('Error:')) return textChunks(process.env.WEIR_IT_DECISION_PHASE === 'after' ? 'S6_AFTER_FAILED' : 'S6_BEFORE_FAILED')
  if (obs.transcript.includes(prompt)) return toolCallChunks('decision_cancel_spike', {})
  return textChunks('unhandled decision cancel turn')
}

function observe(obs) {
  return { s6Fixture: /FIXTURE:([a-z-]+)/.exec(obs.transcript)?.[1] ?? null }
}

async function run(driver) {
  const events = join(driver.IT_ROOT, 'decision-spike-events.jsonl')
  const trace = join(driver.IT_ROOT, `trace-${id}-before.jsonl`)
  const before = await driver.spawnHeadless(['weir-it', prompt], driver.scenarioEnv(id, trace, { WEIR_IT_DECISION_SPIKE: 'cancel', WEIR_IT_DECISION_PHASE: 'before', WEIR_DECISION_SPIKE_EVENTS: events }))
  const trace2 = join(driver.IT_ROOT, `trace-${id}-after.jsonl`)
  const after = await driver.spawnHeadless(['weir-it', prompt], driver.scenarioEnv(id, trace2, { WEIR_IT_DECISION_SPIKE: 'cancel', WEIR_IT_DECISION_PHASE: 'after', WEIR_DECISION_SPIKE_EVENTS: events }))
  return {
    scenario: id, trace, trace2,
    code: before.code === 0 && after.code === 0 ? 0 : 1,
    stdout: `${before.stdout}\n${after.stdout}`, stderr: `${before.stderr}\n${after.stderr}`,
    processRuns: [{ phase: 'before', exitCode: before.code }, { phase: 'after', exitCode: after.code }],
  }
}

function assert(run) {
  const read = phase => {
    const path = join(run.ws, `decision-spike-cancel-${phase}.json`)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  }
  const before = read('before')
  const after = read('after')
  const uiBefore = before?.store?.attempts?.find(attempt => attempt.caseId === 'dc_s6_ui')
  const uiAfter = after?.store?.attempts?.find(attempt => attempt.caseId === 'dc_s6_ui')
  const hookBefore = before?.store?.attempts?.find(attempt => attempt.caseId === 'dc_s6_hook')
  const hookAfter = after?.store?.attempts?.find(attempt => attempt.caseId === 'dc_s6_hook')
  const noAnswers = report => report?.store?.cases?.every(item => item.answer === null) === true
  const pass = before?.pass === true && after?.pass === true && run.code === 0 && run.stdout.includes('S6_BEFORE_DONE') && run.stdout.includes('S6_AFTER_DONE')
  writeDecisionEvidence(run, 'S6', 'cancel-idempotency.json', {
    processRuns: run.processRuns,
    beforeRestart: before, afterRestart: after,
    assertions: {
      requestSignalAbort: before?.askAbort?.code === 'ASK_ABORTED' && after?.store?.askAbort?.code === 'ASK_ABORTED' && hookBefore?.failure === 'aborted' && hookAfter?.failure === 'aborted',
      uiCancelInterruptedAttempt: uiBefore?.failure === 'interrupted' && before?.llmFinish?.kind === 'aborted' && uiAfter?.failure === 'interrupted',
      idempotentReplayNoNewAttempt: before?.replay?.created === false && before?.replay?.afterAttempts === 2 && after?.replay?.created === false && after?.replay?.afterAttempts === 2,
      noAnswerAfterCancel: noAnswers(before) && noAnswers(after),
    },
    pass,
  })
  run.check('request.signal abort persists cancellation and yields ASK_ABORTED across restart', before?.askAbort?.code === 'ASK_ABORTED' && after?.store?.askAbort?.code === 'ASK_ABORTED' && hookBefore?.failure === 'aborted' && hookAfter?.failure === 'aborted', JSON.stringify({ before: before?.askAbort, after: after?.store?.askAbort, hookBefore, hookAfter }))
  run.check('UI cancel interrupts the in-flight Attempt without an answer', uiBefore?.failure === 'interrupted' && before?.llmFinish?.kind === 'aborted' && noAnswers(before) && noAnswers(after), JSON.stringify({ uiBefore, uiAfter, before: before?.llmFinish }))
  run.check('same idempotency key adds no Attempt before or after restart', before?.replay?.created === false && before?.replay?.afterAttempts === 2 && after?.replay?.created === false && after?.replay?.afterAttempts === 2, JSON.stringify({ before: before?.replay, after: after?.replay }))
  run.check('both real headless processes exited cleanly', run.code === 0, `processes=${JSON.stringify(run.processRuns)} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt, decide, observe, run, assert }
