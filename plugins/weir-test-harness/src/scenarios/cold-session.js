// Scenario: cold-session — session-capability-manager task 5.5 integration
// acceptance (cold session + slash consistency). A four-boot driver override
// reproduces the desktop "open a cold session" race with real gateway-wire
// frames and a simulated client cache, and the writer-held resume failure
// with a real second process:
//   1. seed boot: a real root preset session accepts a selection through the
//      real Apply engine; the 5.2 surfaces emit the real
//      agent-preset/selected frames (agent/created + applied followup);
//   2. holder boot: a second process resumes the preset-less seeded session
//      and stays alive inside a long tool call, holding the log writer;
//   3. contender boot: a concurrent resume of the held session fails with
//      the real SessionAlreadyOwnedError (captured to
//      <ws>/cold-session-held-error.txt);
//   4. open boot (a genuinely cold process): the simulated client cache runs
//      both prefetch timings (prefetch-at-open on the standing preset key /
//      wait-for-event) against the REAL frame from the seed generation and
//      must converge to the accepted selection without ever listing the
//      unselected skill; then the 5.3 status face keeps the menu empty under
//      the pinned writer-held failure with reason + actionable hint, and
//      clearFailure restores the persisted selection.
// Assertion surface: the probe report files (the traced tool result is
// truncated at 300 chars; recordRun whitelists the files).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, shellCall, textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'cold-session'
const prompt = 'cold-session-seed'
const env = { WEIR_IT_COLD_SESSION: '1' }

// The holder must outlive the contender's whole boot + resume attempt.
const HOLD_SECONDS = 15
const HOLD_READY_TIMEOUT_MS = 60_000

const SELECTED = 'cold-fixture-a'
const UNSELECTED = 'cold-fixture-b'
const PRESET = 'weir-it-cold'

function decide(options, obs) {
  // Branch on the whole transcript, not the last user message: after the
  // first request the runtime-context / agent-instructions reminders are the
  // newest user-role messages, so prompt sniffing via lastUser misfires.
  const history = obs?.transcript ?? ''
  const toolText = lastOfRole(options, 'tool')
  if (history.includes('cold-session-hold')) {
    // echo-and-wait: the marker proves the wait already ran (sleep alone
    // produces empty tool output, which would re-arm the wait forever).
    return toolText.includes('COLD_SESSION_HELD')
      ? textChunks('hold released')
      : shellCall('echo-and-wait', { text: 'COLD_SESSION_HELD', seconds: HOLD_SECONDS }, 'Keep this process holding the resumed session log writer')
  }
  // The contender must never get this far: the held writer rejects its resume.
  if (history.includes('cold-session-held')) return textChunks('the contender unexpectedly resumed the held session')
  return toolText.includes('COLD_SESSION_PROBE') ? textChunks('cold session probe done') : toolCallChunks('cold_session_probe', {})
}

function observe(obs) {
  return { coldProbeSeen: obs.toolNames.includes('cold_session_probe') }
}

/** @param {unknown} value @returns {string} */
const json = value => JSON.stringify(value)

/** @param {unknown} a @param {unknown} b */
const sameNames = (a, b) => json([...(Array.isArray(a) ? a : [])].sort()) === json([...(Array.isArray(b) ? b : [])].sort())

/** @param {string} file */
function readJson(file) {
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** Poll until the holder's trace proves its resume + first request (writer held). */
async function waitForTrace(trace, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (existsSync(trace) && readFileSync(trace, 'utf8').trim().length > 0) return true
    } catch { /* keep polling */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

/**
 * Four-boot runner override. ctx is supplied by the driver:
 *   - ctx.spawnHeadless(args, env) → Promise<{ code, stdout, stderr }>
 *   - ctx.scenarioEnv(scenarioId, trace, extra) → the WEIR_IT_* env for one boot
 */
async function run(ctx) {
  const ws = join(ctx.IT_ROOT, 'ws')
  const traceSeed = join(ctx.IT_ROOT, 'trace-cold-session-seed.jsonl')
  const traceHold = join(ctx.IT_ROOT, 'trace-cold-session-hold.jsonl')
  const traceContender = join(ctx.IT_ROOT, 'trace-cold-session-held.jsonl')
  const traceOpen = join(ctx.IT_ROOT, 'trace-cold-session-open.jsonl')
  const overlay = mode => ({ ...env, WEIR_IT_COLD_MODE: mode })

  const seed = await ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, traceSeed, overlay('seed')))
  const seeded = readJson(join(ws, 'cold-session-seed.json'))
  const plainSessionId = typeof seeded?.plainSessionId === 'string' ? seeded.plainSessionId : null

  const heldCapture = join(ws, 'cold-session-held-error.txt')
  let holder = null
  if (plainSessionId) {
    // The holder resumes the preset-less seeded session and parks inside a
    // long tool call — a real second process holding the log write handle.
    holder = ctx.spawnHeadless(['weir-it', '--session-id', plainSessionId, 'cold-session-hold'], ctx.scenarioEnv(id, traceHold, overlay('hold')))
    await waitForTrace(traceHold, HOLD_READY_TIMEOUT_MS)
    const contender = await ctx.spawnHeadless(['weir-it', '--session-id', plainSessionId, 'cold-session-held'], ctx.scenarioEnv(id, traceContender, overlay('contender')))
    writeFileSync(heldCapture, `code=${contender.code}\n${contender.stderr}\n${contender.stdout}`)
  } else {
    writeFileSync(heldCapture, 'code=missing\nseed report carried no plain session id\n')
  }

  const open = await ctx.spawnHeadless(['weir-it', 'cold-session-open'], ctx.scenarioEnv(id, traceOpen, overlay('open')))
  if (holder) await holder
  return { scenario: id, trace: traceOpen, trace2: traceSeed, code: open.code, stdout: open.stdout, stderr: open.stderr, seedCode: seed.code }
}

function assert(run) {
  run.check('seed probe advertised', run.requests2.some((r) => r.coldProbeSeen), json(run.requests2.map((r) => r.coldProbeSeen)))
  run.check('open probe advertised', run.requests.some((r) => r.coldProbeSeen), json(run.requests.map((r) => r.coldProbeSeen)))
  const seed = readJson(join(run.ws, 'cold-session-seed.json'))
  const open = readJson(join(run.ws, 'cold-session-open.json'))
  const heldFile = join(run.ws, 'cold-session-held-error.txt')
  const heldText = existsSync(heldFile) ? readFileSync(heldFile, 'utf8') : ''
  run.check('seed probe report written without probe error', seed !== null && seed.error === undefined, json(seed?.error ?? 'missing or unparsable seed report'))
  run.check('open probe report written without probe error', open !== null && open.error === undefined, json(open?.error ?? 'missing or unparsable open report'))
  if (seed === null || seed.error !== undefined) return

  // ---- seed generation: real preset session, real frames, real Apply ----
  run.check('real root agent created under the probe preset', seed.created === PRESET && seed.createdAgents?.some((entry) => entry.id === seed.sessionId && entry.depth === 0), json({ created: seed.created, sessionId: seed.sessionId, createdAgents: seed.createdAgents }))
  run.check('the unselected fixture is a real inventory candidate', seed.unselectedPresent === true, json(seed.unselectedPresent))
  const frameShape = (frame) => frame?.type === 'emit' && frame?.event === 'agent-preset/selected' && frame?.args?.[0] === seed.sessionId && frame?.args?.[1] === PRESET
  run.check('agent/created re-emitted exactly one real invalidation frame for the preset session', seed.framesBeforeApply === 1 && frameShape(seed.frames?.[0]), json({ frames: seed.frames, framesBeforeApply: seed.framesBeforeApply }))
  run.check('the accepted Apply re-emitted exactly one more frame with the session actual preset id', seed.framesAfterApply === 2 && frameShape(seed.frames?.[1]), json({ frames: seed.frames, framesAfterApply: seed.framesAfterApply }))
  run.check('the preset-less held session never emitted a frame', !seed.frames?.some((frame) => frame?.args?.[0] === seed.plainSessionId) && seed.framesAfterHeldApply === seed.framesBeforeHeldApply, json({ frames: seed.frames, before: seed.framesBeforeHeldApply, after: seed.framesAfterHeldApply }))
  run.check('Apply accepted at revision 1 with the selected fixture effective', seed.apply?.status === 'applied' && seed.apply.revision === 1 && sameNames(seed.apply.effectiveNames, [SELECTED]), json(seed.apply))
  {
    const order = seed.order ?? []
    const at = (event) => order.indexOf(event)
    run.check('invalidate precedes fence release and the response (G2c ordering)', at('invalidate') !== -1 && at('invalidate') < at('fence-release') && at('fence-release') < at('response'), json(order))
  }
  run.check('standing preset key lists empty before and after the Apply (fail closed)', sameNames(seed.standingBefore, []) && sameNames(seed.standingAfter, []), json({ before: seed.standingBefore, after: seed.standingAfter }))
  run.check('session scope lists exactly the accepted selection', sameNames(seed.sessionListed, [SELECTED]), json(seed.sessionListed))
  run.check('store record persisted revision 1 with the seed receipt', seed.record?.kind === 'ok' && seed.record.revision === 1 && sameNames(seed.record.receipts, ['cold-seed-1']) && sameNames(seed.record.skillNames, [SELECTED]), json(seed.record))
  run.check('held session selection persisted for the writer-held phase', seed.heldApply?.status === 'applied' && seed.heldRecord?.kind === 'ok' && sameNames(seed.heldRecord.skillNames, [SELECTED]), json({ apply: seed.heldApply, record: seed.heldRecord }))

  // ---- contender: a real second process holding the log writer ----
  run.check('concurrent resume of the held session failed with the real writer-held error', /^code=[1-9]/m.test(heldText) && heldText.includes('already owned by an active write handle'), heldText.slice(0, 300))
  if (open === null || open.error !== undefined) return

  // ---- 1. G2c open race: both prefetch timings converge, never unselected ----
  const timings = open.timings ?? []
  const prefetch = timings.find((entry) => entry.timing === 'prefetch-at-open')
  const waitForEvent = timings.find((entry) => entry.timing === 'wait-for-event')
  run.check('prefetch-at-open starts empty on the standing preset key (empty-then-converged shape)', sameNames(prefetch?.steps?.[0]?.names, []) && prefetch?.steps?.[0]?.scope === 'standing', json(prefetch?.steps))
  run.check('prefetch timing refetches on the real frame and converges to the accepted selection', sameNames(prefetch?.steps?.[1]?.names, [SELECTED]) && prefetch?.steps?.[1]?.scope === 'session' && prefetch?.steps?.[1]?.frame?.args?.[0] === seed.sessionId && prefetch?.steps?.[1]?.frame?.args?.[1] === PRESET, json(prefetch?.steps))
  run.check('wait-for-event timing fetches on the real frame and converges to the accepted selection', sameNames(waitForEvent?.steps?.[0]?.names, [SELECTED]) && waitForEvent?.steps?.[0]?.frame?.args?.[0] === seed.sessionId, json(waitForEvent?.steps))
  run.check('neither timing ever lists the unselected skill', timings.every((entry) => (entry.steps ?? []).every((step) => !(step.names ?? []).includes(UNSELECTED))), json(timings))
  run.check('provider status clean after convergence', open.convergenceStatus?.error === null && open.convergenceStatus?.reason === null, json(open.convergenceStatus))

  // ---- 2. writer-held: pinned failure keeps the menu empty with reason + hint ----
  run.check('manager status carries the writer-held reason and an actionable hint', open.held?.statusUnderNote?.reason === 'session-writer-held' && open.held.statusUnderNote.hint?.includes('Another process holds this session log') === true && open.held.statusUnderNote.error?.includes('already owned by an active write handle') === true, json(open.held?.statusUnderNote))
  run.check('menu and list stay empty under the pinned failure — never a fallback list', sameNames(open.held?.standingUnderNote, []) && sameNames(open.held?.sessionUnderNote, []), json({ standing: open.held?.standingUnderNote, session: open.held?.sessionUnderNote }))
  run.check('the empty menu is the pinned note, not an absent record', open.held?.rawRecord?.kind === 'ok' && sameNames(open.held.rawRecord.skillNames, [SELECTED]), json(open.held?.rawRecord))
  run.check('clearing the note restores the persisted selection and a clean status', sameNames(open.held?.sessionAfterClear, [SELECTED]) && open.held?.statusAfterClear?.reason === null && open.held?.statusAfterClear?.error === null, json({ after: open.held?.sessionAfterClear, status: open.held?.statusAfterClear }))

  run.check('open boot exited cleanly', run.code === 0 || run.code === null, `code=${run.code}`)
}

export default { id, prompt, env, decide, observe, run, assert }
