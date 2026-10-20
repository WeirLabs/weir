// Scenario: filelease-lineage — a delegated child edits the very file its
// parent claimed for the turn, and the broker does NOT refuse it
// (edit-lock-rebuild task 3.3; design D9).
//
// WHAT THIS PINS
// `lineage = delegationDepth > 0 ? the initiator's lineage : the session id`
// (D9). The parent's managed `write` claims the target as one owner id; the
// child, one delegation level down in the SAME process, must resolve to the
// same owner id — so its own managed `write` adopts the lease instead of
// colliding with it. The failure mode this exists to catch is the one D9
// names: the orchestrator holds a file for a long turn, delegates an edit of
// that file, and the delegation chain deadlocks on a self-conflict.
//
// HOW THE CLAIM IS TAKEN
// A managed `write`, not `edit_lock_acquire`. Children never see the
// edit_lock_* tools (CHILD_DENY_TOOLS), while the managed write is the surface
// that acquires implicitly — which is exactly the surface the deadlock would
// hit in production. The parent therefore writes first (claiming the path for
// its turn), waits inside the turn while the DRIVER contends as a foreign
// owner, and only then delegates. The child's write is the lineage proof: a
// refused acquire is thrown by the client, so a successful `Updated file:`
// result means the broker accepted the same-lineage adoption.
//
// WHY THE DRIVER MUST CONTEND BEFORE THE DELEGATION
// The child's turn-end releases what its session acquired (D10), and a lease
// adopted by the child carries the child session, so the driver's foreign
// `acquire` could race that release. The parent's own window (a shell wait
// inside its still-running turn) is the deterministic moment where the path
// is provably held by a real owner, and a different lineage must still be
// refused there: same lineage merges, different lineage does not.
//
// EVIDENCE CHANNELS
// The driver's own broker connection (the foreign refusal) and the boot's
// mock trace (which request wrote what, and which agent ran it). The mock
// trace also records `sessionId` and `sawParentPrompt`, so the parent's and
// the child's requests are never confused — the delegated task text itself
// appears in the parent's history too (it is the delegate call's argument),
// so a bare marker match would misattribute.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { connectLeaseBroker, pollUntil, retryUntil } from '../lease-probe.js'

const id = 'filelease-lineage'
const prompt = 'filelease-lineage-probe'
const WS = join(IT_ROOT, 'ws')
const TARGET = join(WS, 'lease-lineage-shared.txt')
const PARENT_CONTENT = 'parent claim written inside the parent turn\n'
const CHILD_CONTENT = 'child edit written under the inherited lineage\n'

// The delegated task text carries this token so the child can recognize its
// own prompt; the child's REPORT carries the done marker, which is the only
// thing the parent's history gains from the delegation result.
const CHILD_TASK_MARKER = 'filelease-lineage-child-task'
const CHILD_DONE = 'MARKER_CHILD_LINEAGE_EDIT_OK'
const CHILD_REFUSED = 'MARKER_CHILD_LINEAGE_EDIT_REFUSED'

// The hold-the-turn-open window: the driver needs a poll + handshake + one
// acquire, so this is a timeout for a broken driver, not a race budget.
const WINDOW_MARKER = 'WEIR_LEASE_LINEAGE_WINDOW'
const WINDOW_SECONDS = 4

// A real foreign owner: different lineage, different session, human label.
const DRIVER = Object.freeze({
  id: 'weir-it-lineage-driver',
  session: 'session-weir-it-lineage-driver',
  label: 'Second owner (integration driver)',
})

const env = { WEIR_IT_EDIT_LOCK: '1' }

/**
 * The delegated child's brain. It is identified by the ABSENCE of the parent
 * prompt (a child session starts from the delegated task, never from the
 * root prompt — the same discriminator `robash` uses).
 *
 * The child must READ the target before overwriting it (the managed write's
 * own anti-blind-overwrite guard, observed as `cannot overwrite existing …
 * without reading it first`), which is also what lets it edit deliberately.
 * The read is bounded to one attempt: after a read tool result the file
 * contents are either in history or the read failed, and a failed read ends
 * the child with a marker instead of looping.
 *
 * A refused same-lineage edit must likewise end the child, not loop: the
 * managed write surfaces the broker's refusal as a failed tool result, so the
 * second decider call sees the refusal text and reports a failure marker.
 * @param {string} history @param {any[]} messages
 * @returns {Generator}
 */
function decideChild(history, messages) {
  if (history.includes(CHILD_REFUSED)) return textChunks(`${CHILD_REFUSED}: the same-lineage edit was refused`)
  const wrote = history.includes(`Created file: ${TARGET}`) || history.includes(`Updated file: ${TARGET}`)
  if (!wrote) {
    if (history.includes('lease broker refused acquire: held')) {
      return textChunks(`${CHILD_REFUSED}: the broker refused the inherited lineage`)
    }
    // `PARENT_CONTENT` arrives only through the read result (the child's own
    // prompt and write arguments never contain it).
    if (!history.includes(PARENT_CONTENT.trim())) {
      const toolResults = (messages ?? []).filter((message) => message?.role === 'tool').length
      if (toolResults >= 1) return textChunks(`${CHILD_REFUSED}: the target could not be read before editing`)
      return toolCallChunks('read', { file_path: TARGET })
    }
    return toolCallChunks('write', { file_path: TARGET, content: CHILD_CONTENT })
  }
  return textChunks(`${CHILD_DONE}: the managed edit landed`)
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return decideChild(history, obs?.messages)

  // The parent claims the shared path with a managed write.
  if (!history.includes(`Created file: ${TARGET}`) && !history.includes(`Updated file: ${TARGET}`)) {
    return toolCallChunks('write', { file_path: TARGET, content: PARENT_CONTENT })
  }
  // Keep the parent's turn (and therefore its lease) running while the
  // driver's foreign owner is refused.
  if (!history.includes(WINDOW_MARKER)) {
    return shellCall(
      'echo-and-wait',
      { text: WINDOW_MARKER, seconds: WINDOW_SECONDS },
      'Hold the parent turn open while a foreign owner is refused',
    )
  }
  // The child's report rode the delegate result into this history.
  if (history.includes(CHILD_DONE) || history.includes(CHILD_REFUSED)) {
    return textChunks('parent observed the child edit report')
  }
  return toolCallChunks('delegate', {
    category: 'quick',
    prompt: `TASK: with the managed write tool, replace the contents of ${TARGET} in one call.\n${CHILD_TASK_MARKER}\nDELIVERABLE: the managed write, then a one-line report\nSCOPE: that one file only\nVERIFY: the write result names the file\nSTOP WHEN: the edit landed`,
    task_summary: 'lineage child edit',
  })
}

function observe(obs) {
  const history = obs.transcript
  return {
    // Which agent made this request: the root prompt is present only in the
    // parent's history, and `sessionId` names the agent outright when the
    // runtime supplies it.
    sessionId: obs.sessionId ?? null,
    sawParentPrompt: history.includes(prompt),
    sawChildTask: history.includes(CHILD_TASK_MARKER),
    sawChildDone: history.includes(CHILD_DONE),
    editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire'),
  }
}

/**
 * One acquire attempt recorded as facts: a protocol refusal is the answer this
 * scenario asserts on, and a transport failure is a different fact reported
 * verbatim.
 * @param {any} broker @param {string[]} paths
 */
async function attemptAcquire(broker, paths) {
  try {
    const reply = await broker.acquire(DRIVER, paths, WS)
    return reply?.ok === true
      ? { refused: false, granted: (Array.isArray(reply.granted) ? reply.granted : []).map((lease) => lease?.path ?? null) }
      : { refused: true, code: reply?.error?.code ?? null, conflicts: Array.isArray(reply?.error?.conflicts) ? reply.error.conflicts : [] }
  } catch (error) {
    return { refused: null, transport: true, code: error?.code ?? 'transport', message: String(error?.message ?? error) }
  }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const socketPath = process.env.WEIR_EDITLOCKD_SOCKET
  const outcomePromise = spawnHeadless(['weir-it', prompt], scenarioEnv(id, trace, env))
  const broker = connectLeaseBroker(socketPath, { timeoutMs: 3_000 })
  /** @type {Record<string, any>} */
  const report = { kind: 'filelease-lineage-report', socketPath, target: TARGET }
  /** @type {any} */
  let outcome = null
  try {
    // The managed write publishes only after its claim was granted, so the
    // file appearing is the driver's signal that the parent turn holds it.
    report.parentWriteAppeared = (await pollUntil(() => existsSync(TARGET), { timeoutMs: 60_000, stepMs: 20 })) !== null
    if (report.parentWriteAppeared) {
      // Read the parent's bytes while the parent turn is still inside its
      // window: the later child edit must not be mistaken for this write.
      report.parentBytes = readFileSync(TARGET, 'utf8')
      const handshake = await retryUntil(() => broker.hello(), { timeoutMs: 20_000, stepMs: 100 })
      report.arbiter = handshake.ok
        ? { ok: true, startedAt: handshake.value?.startedAt ?? null }
        : { ok: false, error: String(handshake.error?.message ?? handshake.error) }
      if (handshake.ok) report.conflict = await attemptAcquire(broker, [TARGET])
    }
  } catch (error) {
    report.driverError = String(/** @type {any} */ (error)?.message ?? error)
  } finally {
    outcome = await outcomePromise
    broker.close()
    // The end state of the shared file: the child's edit is the last writer.
    report.childBytes = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null
    appendFileSync(trace, JSON.stringify(report) + '\n')
  }
  return { scenario: id, trace, ...outcome }
}

function assert(run) {
  const report = run.records.find((row) => row?.kind === 'filelease-lineage-report')
  const target = join(run.ws, 'lease-lineage-shared.txt')
  const bytes = existsSync(target) ? readFileSync(target, 'utf8') : null
  const records = run.records
  const child = run.created.find((row) => row?.origin === 'subagent' && row?.depth === 1) ?? null
  const root = run.created.find((row) => typeof row?.session === 'string' && row?.depth !== 1) ?? null
  const parentRequests = run.requests.filter((request) => request?.sawParentPrompt === true)
  const childRequests = run.requests.filter((request) => request?.sawParentPrompt === false && request?.sawChildTask === true)
  const parentWrite = parentRequests.some((request) => typeof request?.lastTool === 'string' && request.lastTool.includes(`Created file: ${target}`))
  const childWrite = childRequests.some((request) => typeof request?.lastTool === 'string' && request.lastTool.includes(`Updated file: ${target}`))
  const childHeld = childRequests.some((request) => typeof request?.lastTool === 'string' && request.lastTool.includes('lease broker refused acquire: held'))
  const parentSawChild = parentRequests.some((request) => request?.sawChildDone === true && typeof request?.lastTool === 'string' && request.lastTool.includes(CHILD_DONE))
  const conflict = report?.conflict ?? {}
  const holder = conflict.conflicts?.[0]?.holder ?? {}
  const driverError = report?.driverError ?? null
  // The parent's lease lives until its turn ends (D10), and the child's whole
  // edit happens inside the parent's `delegate` tool call. Trace order makes
  // that premise checkable instead of assumed: the child's write RESULT is
  // recorded before the parent session's first `turn/end`.
  const parentSession = root?.session ?? parentRequests.find((request) => typeof request?.sessionId === 'string' && request.sessionId.length > 0)?.sessionId ?? null
  const parentTurnEnds = records.filter((row) => row?.kind === 'session-event' && row?.type === 'turn/end' && row?.session === parentSession)
  const childWriteRequest = childRequests.find((request) => typeof request?.lastTool === 'string' && request.lastTool.includes(`Updated file: ${target}`)) ?? null
  const childWriteIndex = childWriteRequest === null ? -1 : records.indexOf(childWriteRequest)
  const parentTurnEndIndex = parentTurnEnds.length === 0 ? -1 : records.indexOf(parentTurnEnds[0])

  run.check(
    'the parent managed write published its bytes before the delegation',
    report?.parentBytes === PARENT_CONTENT && parentWrite,
    JSON.stringify({ parentBytes: report?.parentBytes, parentWrite, driverError }),
  )
  run.check(
    'the delegated child is a depth-1 subagent whose managed edit of the same path succeeded',
    child !== null && childWrite && childHeld === false,
    JSON.stringify({ child, childWrite, childHeld, childRequests: childRequests.map((request) => request?.lastTool) }),
  )
  run.check(
    'the child edited while the parent turn was still running (its claim was live, not released)',
    childWriteIndex >= 0 && parentTurnEndIndex > childWriteIndex,
    JSON.stringify({ parentSession, childWriteIndex, parentTurnEndIndex, turnEnds: parentTurnEnds.length }),
  )
  run.check(
    'the target now contains exactly the child\'s edit (same lineage was never refused)',
    bytes === CHILD_CONTENT && report?.childBytes === CHILD_CONTENT,
    JSON.stringify({ bytes, childBytes: report?.childBytes }),
  )
  run.check(
    'the parent observed the child\'s edit report (the delegation did not deadlock)',
    parentSawChild,
    JSON.stringify(parentRequests.map((request) => request?.lastTool)),
  )
  run.check(
    'a foreign-lineage owner was refused with held, naming the holder\'s label',
    conflict.refused === true
      && conflict.code === 'held'
      && conflict.conflicts?.[0]?.path === target
      && typeof holder.label === 'string' && holder.label.trim().length > 0,
    JSON.stringify(conflict),
  )
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env, decide, observe, run, assert }
