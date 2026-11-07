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
  const trace = join(driver.IT_ROOT, `trace-${id}-before.jsonl`)
  const before = await driver.spawnHeadless(['weir-it', prompt], driver.scenarioEnv(id, trace, { WEIR_IT_DECISION_SPIKE: 'cancel', WEIR_IT_DECISION_PHASE: 'before' }))
  const trace2 = join(driver.IT_ROOT, `trace-${id}-after.jsonl`)
  const after = await driver.spawnHeadless(['weir-it', prompt], driver.scenarioEnv(id, trace2, { WEIR_IT_DECISION_SPIKE: 'cancel', WEIR_IT_DECISION_PHASE: 'after' }))
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
  const pass = before?.pass === true && after?.pass === true && run.code === 0 && run.stdout.includes('S6_BEFORE_DONE') && run.stdout.includes('S6_AFTER_DONE')
  writeDecisionEvidence(run, 'S6', 'cancel-idempotency.json', {
    processRuns: run.processRuns,
    beforeRestart: before, afterRestart: after,
    assertions: {
      requestSignalAbort: before?.askAbort?.code === 'ASK_ABORTED' && after?.store?.askAbort?.code === 'ASK_ABORTED',
      uiCancelInterruptedAttempt: before?.store?.attempts?.[0]?.failure === 'interrupted' && before?.llmFinish?.kind === 'aborted' && after?.store?.attempts?.[0]?.failure === 'interrupted',
      idempotentReplayNoNewAttempt: before?.replay?.created === false && before?.replay?.afterAttempts === 1 && after?.replay?.created === false && after?.replay?.afterAttempts === 1,
      noAnswerAfterCancel: before?.store?.cases?.[0]?.answer === null && after?.store?.cases?.[0]?.answer === null,
    },
    pass,
  })
  run.check('request.signal abort yields ASK_ABORTED and survives restart', before?.askAbort?.code === 'ASK_ABORTED' && after?.store?.askAbort?.code === 'ASK_ABORTED', JSON.stringify({ before: before?.askAbort, after: after?.store?.askAbort }))
  run.check('UI cancel interrupts the in-flight Attempt without an answer', before?.store?.attempts?.[0]?.failure === 'interrupted' && before?.llmFinish?.kind === 'aborted' && after?.store?.cases?.[0]?.answer === null, JSON.stringify({ before, after }))
  run.check('same idempotency key adds no Attempt before or after restart', before?.replay?.created === false && before?.replay?.afterAttempts === 1 && after?.replay?.created === false && after?.replay?.afterAttempts === 1, JSON.stringify({ before: before?.replay, after: after?.replay }))
  run.check('both real headless processes exited cleanly', run.code === 0, `processes=${JSON.stringify(run.processRuns)} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt, decide, observe, run, assert }
