// Scenario: filelease-negotiation — ownership moves only when the holder says
// so, and "keep" moves nothing (edit-lock-rebuild tasks 5.2 / 5.5; design
// D4/D5/D6; spec "Ownership moves by negotiation").
//
// The driver is the SECOND owner (src/lease-probe.js), exactly as in
// filelease-turn-release: a headless boot is one process with one broker
// connection, so a genuinely foreign owner has to come from outside. What this
// scenario adds is the whole negotiation round trip:
//
//   1. the session claims two paths with managed writes; the driver's `acquire`
//      is refused (`held`) while that turn owns them;
//   2. the driver asks for the first path with a `request` op and gets
//      `pending` plus a request id — the requester never waits for an answer;
//   3. the request notice reaches the holder INSIDE its running turn (the
//      shell wait is what keeps that turn open and costs no extra wake), the
//      mock model answers `edit_lock_reply` with `release`, and the broker
//      reports `transferred` to the requesting connection;
//   4. the driver's `acquire` now succeeds, the holder's later managed write to
//      the same path is refused, and the holder's own read-only status names
//      the driver-side owner label;
//   5. for the second path the holder answers `keep`: the request settles
//      `declined` and the driver's `acquire` is still refused.
//
// Evidence channels: the driver's own broker connection (acquire verdicts, the
// request replies and the pushed `settled` events) and the boot's `--json`
// tool stream (full, untruncated tool results — the mock trace caps tool text
// at 300 characters).
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { parseJsonlLines } from '../jsonl.js'
import { connectLeaseBroker, pollUntil, retryUntil } from '../lease-probe.js'

const id = 'filelease-negotiation'
const prompt = 'filelease-negotiation-probe'
const WS = join(IT_ROOT, 'ws')
const PATH_A = join(WS, 'lease-negotiation-a.txt')
const PATH_B = join(WS, 'lease-negotiation-b.txt')
const NAME_A = 'lease-negotiation-a.txt'
const NAME_B = 'lease-negotiation-b.txt'
const CONTENT_A = 'negotiation target a\n'
const CONTENT_B = 'negotiation target b\n'

// A real foreign owner: different lineage, different session, and a label the
// holder's own ownership read is expected to name.
const DRIVER = Object.freeze({
  id: 'weir-it-negotiation-driver',
  session: 'session-weir-it-negotiation-driver',
  label: 'Second owner (integration driver)',
})

// The marker of one wait step. The turn is the driver's only window (the
// process exits at turn end), so the wait is what keeps it open; every step has
// its own echo marker so each is emitted exactly once and a missing request
// cannot loop forever.
const WAIT_MARKERS = ['WEIR_LEASE_NEGOTIATED_1', 'WEIR_LEASE_NEGOTIATED_2', 'WEIR_LEASE_NEGOTIATED_3']

const env = { WEIR_IT_EDIT_LOCK: '1' }

/**
 * The transfer-request notices in a transcript, in delivery order.
 * `requestText` (src/file-lease/plugin.js) renders the short path and the
 * request id in one sentence; both are exactly what the answer needs.
 * @param {string} history
 * @returns {{ requestId: string, short: string }[]}
 */
function notices(history) {
  const out = []
  const pattern = /is asking to take over (\S+?)\. Answer with edit_lock_reply: request_id "([^"]+)"/g
  for (const match of history.matchAll(pattern)) out.push({ short: match[1], requestId: match[2] })
  return out
}

/**
 * Whether this request was already answered: the reply tool's result message
 * starts with `Request <id>:`, so the id is the marker.
 * @param {string} history
 * @param {string} requestId
 * @returns {boolean}
 */
function answered(history, requestId) {
  return history.includes(`Request ${requestId}:`)
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return textChunks('unhandled filelease-negotiation turn')

  // Two managed writes claim both targets for this turn: the negotiation is
  // about claims a real managed write took, so it can never be about nothing.
  if (!history.includes(`Created file: ${PATH_A}`) && !history.includes(`Updated file: ${PATH_A}`)) {
    return toolCallChunks('write', { file_path: PATH_A, content: CONTENT_A })
  }
  if (!history.includes(`Created file: ${PATH_B}`) && !history.includes(`Updated file: ${PATH_B}`)) {
    return toolCallChunks('write', { file_path: PATH_B, content: CONTENT_B })
  }

  const received = notices(history)
  if (received.length < 2) {
    // Keep the turn alive while the driver contends. The first step is long
    // enough for a poll + handshake + two requests; the follow-ups only cover a
    // slow boot. Budget exhausted means the request never arrived, which the
    // assertion below reports instead of a hung run.
    const waited = WAIT_MARKERS.filter((marker) => history.includes(marker)).length
    if (waited < WAIT_MARKERS.length) {
      return shellCall(
        'echo-and-wait',
        { text: WAIT_MARKERS[waited], seconds: waited === 0 ? 4 : 2 },
        'Keep the turn open while the second owner negotiates',
      )
    }
    return textChunks('the transfer requests never reached this turn')
  }

  // `release` first: the transfer must be observable by the requester before it
  // tries to acquire, and the second request keeps the reply tool alive.
  const release = received.find((notice) => notice.short === NAME_A)
  if (release === undefined) return textChunks('the transfer request for the first path never arrived')
  if (!answered(history, release.requestId)) {
    return toolCallChunks('edit_lock_reply', { request_id: release.requestId, decision: 'release' })
  }

  // The transfer is settled: a managed write to that path must now be refused,
  // because the requester owns it. A missing refusal settles instead of
  // looping (the tool result is the only marker the model gets back).
  if (!history.includes('lease broker refused acquire: held')) {
    const toolResults = (options.messages ?? []).filter((message) => message.role === 'tool').length
    if (toolResults >= 16) return textChunks('the post-transfer refusal did not surface')
    return toolCallChunks('write', { file_path: PATH_A, content: `${CONTENT_A}written after the transfer\n` })
  }

  // `keep` for the second path: ownership stays exactly where it is.
  const keep = received.find((notice) => notice.short === NAME_B)
  if (keep === undefined) return textChunks('the transfer request for the second path never arrived')
  if (!answered(history, keep.requestId)) {
    return toolCallChunks('edit_lock_reply', { request_id: keep.requestId, decision: 'keep' })
  }

  // Read-only evidence for the refusal: the ownership report names the holder.
  if (!history.includes('Held by other sessions here')) return toolCallChunks('edit_lock_status', {})
  return textChunks('negotiation settled: release transferred, keep declined')
}

function observe(obs) {
  return {
    editLockToolsSeen: obs.toolNames.includes('edit_lock_status'),
    // The reply tool is registered on the holder's scope only while a request
    // is pending: this records whether the running turn was offered it.
    replyToolOffered: obs.toolNames.includes('edit_lock_reply'),
  }
}

/**
 * Tool call/result pairs from a boot's `--json` stdout (full, untruncated).
 * @param {unknown} stdout
 * @returns {{ tool: string, status: string | null, result: any }[]}
 */
function toolStream(stdout) {
  const records = parseJsonlLines(stdout)
  const calls = records.filter((entry) => entry?.type === 'tool_call')
  const results = records.filter((entry) => entry?.type === 'tool_result')
  return calls.map((call, index) => ({ tool: call.tool, status: results[index]?.status ?? null, result: results[index]?.result ?? null }))
}

/**
 * One acquire attempt recorded as facts: a protocol refusal is the answer this
 * scenario asserts on, and a transport failure is a different fact the assert
 * reports verbatim.
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

/**
 * One transfer request; the answer arrives later as a pushed `settled` event.
 * @param {any} broker @param {string} path
 */
async function attemptTransfer(broker, path) {
  try {
    const reply = await broker.transfer(DRIVER, path)
    return reply?.ok === true
      ? {
          ok: true,
          state: reply.state ?? null,
          requestId: typeof reply.requestId === 'string' ? reply.requestId : null,
          holder: reply.holder ?? null,
          expiresAt: reply.expiresAt ?? null,
        }
      : { ok: false, code: reply?.error?.code ?? null }
  } catch (error) {
    return { ok: false, transport: true, code: error?.code ?? 'transport', message: String(error?.message ?? error) }
  }
}

/**
 * The settlement of one request, as pushed to THIS connection.
 * @param {any} broker @param {string | null} requestId
 */
async function settleOf(broker, requestId) {
  try {
    const event = await broker.nextEvent('settled', (candidate) => candidate?.requestId === requestId, { timeoutMs: 30_000 })
    return { requestId: event?.requestId ?? null, path: event?.path ?? null, state: event?.state ?? null }
  } catch (error) {
    return { requestId, state: null, error: String(error?.message ?? error) }
  }
}

/**
 * The arbiter's view of one path.
 * @param {any} broker @param {string} path
 */
async function readStatus(broker, path) {
  try {
    const reply = await broker.status({ path })
    const leases = Array.isArray(reply?.leases) ? reply.leases : []
    return {
      ok: reply?.ok === true,
      leases: leases.map((lease) => ({ path: lease?.path ?? null, owner: lease?.owner ?? null })),
    }
  } catch (error) {
    return { ok: false, leases: [], error: String(error?.message ?? error) }
  }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const socketPath = process.env.WEIR_EDITLOCKD_SOCKET
  const outcomePromise = spawnHeadless(['weir-it', '--json', prompt], scenarioEnv(id, trace, env))
  const broker = connectLeaseBroker(socketPath, { timeoutMs: 3_000 })
  /** @type {Record<string, any>} */
  const report = { kind: 'filelease-negotiation-report', socketPath, paths: { a: PATH_A, b: PATH_B } }
  /** @type {any} */
  let outcome = null
  try {
    // A managed write publishes only after its claim was granted, so both files
    // appearing is the driver's signal that both paths are owned by the turn.
    report.claimsAppeared = (await pollUntil(() => existsSync(PATH_A) && existsSync(PATH_B), { timeoutMs: 60_000, stepMs: 20 })) !== null
    if (report.claimsAppeared) {
      const handshake = await retryUntil(() => broker.hello(), { timeoutMs: 20_000, stepMs: 100 })
      report.arbiter = handshake.ok
        ? { ok: true, startedAt: handshake.value?.startedAt ?? null }
        : { ok: false, error: String(handshake.error?.message ?? handshake.error) }
      if (handshake.ok) {
        report.conflictBefore = await attemptAcquire(broker, [PATH_A])
        // Ask for both paths: the first answer must transfer, the second must
        // preserve ownership. Both requests land in the holder's running turn.
        report.requestA = await attemptTransfer(broker, PATH_A)
        report.requestB = await attemptTransfer(broker, PATH_B)
        if (report.requestA?.ok === true) {
          report.settledA = await settleOf(broker, report.requestA.requestId)
          report.acquireAfterTransfer = await attemptAcquire(broker, [PATH_A])
        }
        if (report.requestB?.ok === true) {
          report.settledB = await settleOf(broker, report.requestB.requestId)
          report.conflictAfterKeep = await attemptAcquire(broker, [PATH_B])
          report.statusAfterKeep = await readStatus(broker, PATH_B)
        }
      }
    }
  } catch (error) {
    report.driverError = String(/** @type {any} */ (error)?.message ?? error)
  } finally {
    // The connection stays open until the holder's turn ends: closing earlier
    // would release the transferred claim and turn the holder's later write
    // into a success — the very assertion this scenario makes.
    outcome = await outcomePromise
    try {
      broker.close()
    } catch {
      // Already gone.
    }
    appendReport(trace, report)
  }
  return { scenario: id, trace, ...outcome }
}

/** @param {string} trace @param {Record<string, any>} report */
function appendReport(trace, report) {
  try {
    // The trace is the mock tap's JSONL; one report record per run, appended so
    // the driver facts and the model's requests stay in ONE replayable file.
    appendFileSync(trace, JSON.stringify(report) + '\n')
  } catch {
    // Reporting must never fail the scenario; the assertions report absence.
  }
}

function assert(run) {
  const report = run.records.find((row) => row?.kind === 'filelease-negotiation-report')
  const sessionId = parseJsonlLines(run.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
  const tools = toolStream(run.stdout)
  const writes = tools.filter((tool) => tool.tool === 'write')
  const replies = tools.filter((tool) => tool.tool === 'edit_lock_reply')
  const status = tools.find((tool) => tool.tool === 'edit_lock_status')
  const refusedWrite = writes[writes.length - 1] ?? null
  const replyA = replies[0] ?? null
  const replyB = replies[1] ?? null

  const before = report?.conflictBefore ?? {}
  const requestA = report?.requestA ?? {}
  const requestB = report?.requestB ?? {}
  const settledA = report?.settledA ?? {}
  const settledB = report?.settledB ?? {}
  const afterTransfer = report?.acquireAfterTransfer ?? {}
  const afterKeep = report?.conflictAfterKeep ?? {}
  const keepStatus = report?.statusAfterKeep ?? {}
  const pathA = join(run.ws, NAME_A)
  const pathB = join(run.ws, NAME_B)
  const bytesA = existsSync(pathA) ? readFileSync(pathA, 'utf8') : null
  const bytesB = existsSync(pathB) ? readFileSync(pathB, 'utf8') : null
  const conflictHolder = (before.conflicts ?? [])[0]?.holder ?? {}
  const keepHolder = (afterKeep.conflicts ?? [])[0]?.holder ?? {}
  const keepLease = (keepStatus.leases ?? []).find((lease) => lease?.path === pathB) ?? {}
  const kept = (keepStatus.leases ?? []).map((lease) => ({ path: lease?.path, session: lease?.owner?.session, label: lease?.owner?.label }))

  run.check(
    'both managed writes published their targets before the driver contended',
    report?.claimsAppeared === true && bytesA === CONTENT_A && bytesB === CONTENT_B,
    JSON.stringify({ claimsAppeared: report?.claimsAppeared, bytesA, bytesB, driverError: report?.driverError }),
  )
  run.check(
    'the driver was refused with held while the running turn owned the first path',
    before.refused === true && before.code === 'held' && before.conflicts?.[0]?.path === pathA,
    JSON.stringify(before),
  )
  run.check(
    'the transfer request returned pending with a request id and named the live holder session',
    requestA.ok === true
      && requestA.state === 'pending'
      && typeof requestA.requestId === 'string' && requestA.requestId.length > 0
      && requestA.holder?.session === sessionId
      && typeof requestA.holder?.label === 'string' && requestA.holder.label.length > 0,
    JSON.stringify({ requestA, sessionId }),
  )
  run.check(
    'the holder was offered the reply tool inside its running turn and answered release',
    run.requests.some((request) => request?.replyToolOffered === true && (request?.emittedNames ?? []).includes('edit_lock_reply'))
      && replyA?.status === 'completed'
      && typeof replyA?.result === 'string' && replyA.result.includes(`${requestA.requestId}: transferred`),
    JSON.stringify({ replies, requestId: requestA.requestId, offered: run.requests.filter((request) => request?.replyToolOffered === true).length }),
  )
  run.check(
    'the broker pushed transferred to the requester and its acquire then succeeded',
    settledA.state === 'transferred' && afterTransfer.refused === false && (afterTransfer.granted ?? []).includes(pathA),
    JSON.stringify({ settledA, afterTransfer }),
  )
  run.check(
    'the holder\'s later managed write to the transferred path was refused as held and left the bytes untouched',
    refusedWrite?.status === 'error'
      && typeof refusedWrite?.result === 'string' && refusedWrite.result.includes('held')
      && writes.length === 3
      && bytesA === CONTENT_A,
    JSON.stringify({ writes, bytesA }),
  )
  run.check(
    'the holder\'s own ownership read names the driver-side owner as the holder of the transferred path',
    typeof status?.result === 'string'
      && status.result.includes(NAME_A)
      && status.result.includes(DRIVER.label)
      && status.result.includes(DRIVER.session),
    JSON.stringify({ status }),
  )
  run.check(
    'the second request was pending under its own id and the holder answered keep',
    requestB.ok === true
      && requestB.state === 'pending'
      && typeof requestB.requestId === 'string' && requestB.requestId.length > 0
      && requestB.requestId !== requestA.requestId
      && replyB?.status === 'completed'
      && typeof replyB?.result === 'string' && replyB.result.includes(`${requestB.requestId}: declined`),
    JSON.stringify({ requestB, replyB }),
  )
  run.check(
    'the requester saw declined and its acquire stayed refused with held, naming the holder session',
    settledB.state === 'declined'
      && afterKeep.refused === true
      && afterKeep.code === 'held'
      && keepHolder.session === sessionId,
    JSON.stringify({ settledB, afterKeep, sessionId }),
  )
  run.check(
    'the kept path is still owned by the holder (keep moved nothing)',
    keepStatus.ok === true && keepLease?.owner?.session === sessionId && bytesB === CONTENT_B,
    JSON.stringify({ kept, bytesB }),
  )
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env, decide, observe, run, assert }
