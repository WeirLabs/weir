// Scenario: filelease-wake — a transfer request delivered while the holder is
// MID-TURN lands inside that turn, and the holder answers it there without a
// second turn (edit-lock-rebuild task 3.5; design D4 "递话机制").
//
// THE TWO DELIVERY SHAPES OF D4
// A holder that is idle gets ONE wake turn (`followup`) so it can answer; a
// holder that is already running simply receives the request inside the turn
// it is in (`steer`) and spends no extra turn. This scenario pins the second
// shape, because it is the one a race can silently degrade into the first:
//
//   1. the managed `write` claims the target (the premise of any negotiation);
//   2. a shell wait keeps the turn RUNNING while the driver, as the second
//      owner, sends exactly one `request` op 0.5s into that window;
//   3. the notice is delivered into the running turn, the mock model answers
//      `edit_lock_reply` with `release` from INSIDE that turn, and the broker
//      transfers ownership to the driver.
//
// WHY THE REPLY RESULT ITSELF ALREADY IMPLIES IN-TURN DELIVERY
// A wake turn is opened after the previous turn ended, and `turn/end` releases
// the holder's non-retained leases (D10). A reply that answers from a wake
// turn would therefore be answering a request whose lease is already gone —
// `stale`/`expired`, never `transferred`. The additional trace assertion
// below pins the mechanism directly instead of relying on that argument: the
// injected notice (`user/message`, source `weir-file-lease`) is ordered
// BEFORE the holder's first `turn/end`, and the holder's run has exactly one
// `turn/end` — one turn, no extra wake.
//
// NOT COVERED HERE (reported honestly, not asserted): the idle-holder branch
// (`followup` opens one wake turn) cannot be produced by a one-turn headless
// boot — the process exits at its first turn end, so no session is ever alive
// and idle. That branch stays covered by the product's unit tests.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, shellCall, textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'
import { parseJsonlLines } from '../jsonl.js'
import { connectLeaseBroker, pollUntil, retryUntil } from '../lease-probe.js'

const id = 'filelease-wake'
const prompt = 'filelease-wake-probe'
const WS = join(IT_ROOT, 'ws')
const TARGET = join(WS, 'lease-wake-target.txt')
const CONTENT = 'wake delivery target\n'

// The running-turn window. Three seconds leaves room for a slow boot on CI
// (the driver sends its one request 0.5s after the claim is published), so a
// failure here means the delivery is broken, not that the machine was busy.
const WINDOW_MARKER = 'WEIR_LEASE_WAKE_WINDOW'
const WINDOW_SECONDS = 3
/** The single request is sent this far into the window, never retried. */
const REQUEST_OFFSET_MS = 500

// The fragment of the product's request notice (src/file-lease/plugin.js
// `requestText`) that both identifies the notice and names its request id.
const NOTICE_FRAGMENT = 'edit_lock_reply: request_id "'
const NOTICE_PATTERN = /is asking to take over (\S+?)\. Answer with edit_lock_reply: request_id "([^"]+)"/g

// A real foreign owner: different lineage, different session, human label.
const DRIVER = Object.freeze({
  id: 'weir-it-wake-driver',
  session: 'session-weir-it-wake-driver',
  label: 'Second owner (integration driver)',
})

const env = { WEIR_IT_EDIT_LOCK: '1' }

/**
 * Every transfer-request notice in a transcript, in delivery order. Both the
 * short path and the request id are exactly what the answer needs.
 * @param {string} history
 * @returns {{ short: string, requestId: string }[]}
 */
function notices(history) {
  const out = []
  for (const match of history.matchAll(NOTICE_PATTERN)) out.push({ short: match[1], requestId: match[2] })
  return out
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return textChunks('unhandled filelease-wake turn')

  // One managed write claims the target for this turn: the negotiation is
  // about a claim a real managed operation took.
  if (!history.includes(`Created file: ${TARGET}`) && !history.includes(`Updated file: ${TARGET}`)) {
    return toolCallChunks('write', { file_path: TARGET, content: CONTENT })
  }
  // The shell wait holds the turn open; the driver's request must land inside
  // it. `echo-and-wait` is one tool call, so the turn is genuinely running.
  if (!history.includes(WINDOW_MARKER)) {
    return shellCall(
      'echo-and-wait',
      { text: WINDOW_MARKER, seconds: WINDOW_SECONDS },
      'Keep the turn running while a second owner asks for the path',
    )
  }

  const [request] = notices(history)
  if (request === undefined) {
    // Keep the SAME turn open until the notice lands in it. This is the
    // holder waiting, not a retried request: the driver sends exactly one.
    const verdict = waitForMarker(history, NOTICE_FRAGMENT, 3)
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('the transfer request never reached this turn')
  }
  // The reply tool is registered on this agent's scope only while the request
  // is pending, so emitting it here is also the "it was offered mid-turn"
  // observation the assertion checks against the request's tool catalog.
  if (!history.includes(`Request ${request.requestId}:`)) {
    return toolCallChunks('edit_lock_reply', { request_id: request.requestId, decision: 'release' })
  }
  return textChunks('transfer answered inside the running turn')
}

function observe(obs) {
  return {
    // The reply tool is registered dynamically on the HOLDER's scope: this
    // records whether the running turn's LLM request was offered it.
    replyToolOffered: obs.toolNames.includes('edit_lock_reply'),
    noticeDelivered: obs.transcript.includes(NOTICE_FRAGMENT),
  }
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  // Ref'd on purpose: these waits exist because the driver is waiting for a
  // real event, and an unref'd timer would let the driver exit mid-wait.
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
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
 * One acquire attempt recorded as facts (a refusal is a value, a transport
 * failure is a different fact).
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
  // `--json` keeps the boot's stdout machine-readable: the assertion reads the
  // full (untruncated) reply result and the real session id from it.
  const outcomePromise = spawnHeadless(['weir-it', '--json', prompt], scenarioEnv(id, trace, env))
  const broker = connectLeaseBroker(socketPath, { timeoutMs: 3_000 })
  /** @type {Record<string, any>} */
  const report = { kind: 'filelease-wake-report', socketPath, target: TARGET }
  /** @type {any} */
  let outcome = null
  try {
    // The daemon is spawned by the boot's first managed write, so the
    // handshake retry is the boot-start wait (a transport retry, not a test
    // retry). Once greeted, the write's publication is the only fact left.
    const handshake = await retryUntil(() => broker.hello(), { timeoutMs: 20_000, stepMs: 100 })
    report.arbiter = handshake.ok
      ? { ok: true, startedAt: handshake.value?.startedAt ?? null }
      : { ok: false, error: String(handshake.error?.message ?? handshake.error) }
    if (handshake.ok) {
      const appearedAt = Date.now()
      report.writeAppeared = (await pollUntil(() => existsSync(TARGET), { timeoutMs: 60_000, stepMs: 20 })) !== null
      if (report.writeAppeared) {
        report.bytesBeforeRequest = readFileSync(TARGET, 'utf8')
        // Half a second into the holder's window: early enough to be mid-turn,
        // late enough that the claim is provably published.
        await sleep(REQUEST_OFFSET_MS)
        report.requestSentAfterAppearanceMs = Date.now() - appearedAt
        report.request = await attemptTransfer(broker, TARGET)
        if (report.request?.ok === true) {
          report.settled = await settleOf(broker, report.request.requestId)
          report.acquireAfterTransfer = await attemptAcquire(broker, [TARGET])
        }
      }
    }
  } catch (error) {
    report.driverError = String(/** @type {any} */ (error)?.message ?? error)
  } finally {
    // The connection stays open until the holder's turn ends: closing earlier
    // would release the transferred claim and turn the ownership assertion
    // into a tautology.
    outcome = await outcomePromise
    try {
      broker.close()
    } catch {
      // Already gone.
    }
    appendFileSync(trace, JSON.stringify(report) + '\n')
  }
  return { scenario: id, trace, ...outcome }
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

function assert(run) {
  const report = run.records.find((row) => row?.kind === 'filelease-wake-report')
  const sessionId = parseJsonlLines(run.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
  const tools = toolStream(run.stdout)
  const reply = tools.find((tool) => tool.tool === 'edit_lock_reply') ?? null
  const target = join(run.ws, 'lease-wake-target.txt')
  const bytes = existsSync(target) ? readFileSync(target, 'utf8') : null
  const request = report?.request ?? {}
  const settled = report?.settled ?? {}
  const afterTransfer = report?.acquireAfterTransfer ?? {}

  // Trace-order facts: the injected notice and the reply request must both
  // precede the holder's first turn boundary, and the holder's whole run must
  // contain exactly ONE boundary (a wake turn would add a second).
  const records = run.records
  const injected = records.filter(
    (row) => row?.kind === 'session-event'
      && row?.type === 'user/message'
      && row?.session === sessionId
      && row?.source === 'weir-file-lease'
      && typeof row?.text === 'string' && row.text.includes(NOTICE_FRAGMENT),
  )
  const turnEnds = records.filter((row) => row?.kind === 'session-event' && row?.type === 'turn/end' && row?.session === sessionId)
  const replyRequest = run.requests.find((entry) => entry?.emittedNames?.includes('edit_lock_reply')) ?? null
  const noticeIndex = injected.length > 0 ? records.indexOf(injected[0]) : -1
  const turnEndIndex = turnEnds.length > 0 ? records.indexOf(turnEnds[0]) : -1
  const replyIndex = replyRequest === null ? -1 : records.indexOf(replyRequest)

  run.check(
    'the managed write published the claimed target before the request was sent',
    report?.writeAppeared === true && report?.bytesBeforeRequest === CONTENT && bytes === CONTENT,
    JSON.stringify({ writeAppeared: report?.writeAppeared, bytesBeforeRequest: report?.bytesBeforeRequest, bytes, driverError: report?.driverError }),
  )
  run.check(
    `the request was sent about ${REQUEST_OFFSET_MS}ms into the holder's running turn`,
    typeof report?.requestSentAfterAppearanceMs === 'number'
      && report.requestSentAfterAppearanceMs >= REQUEST_OFFSET_MS
      && report.requestSentAfterAppearanceMs < WINDOW_SECONDS * 1000,
    JSON.stringify({ sentMs: report?.requestSentAfterAppearanceMs, windowMs: WINDOW_SECONDS * 1000 }),
  )
  run.check(
    'the request returned pending with a request id and named the live holder session',
    request.ok === true
      && request.state === 'pending'
      && typeof request.requestId === 'string' && request.requestId.length > 0
      && request.holder?.session === sessionId,
    JSON.stringify({ request, sessionId }),
  )
  run.check(
    'the notice reached the holder inside the running turn, before its first turn end',
    injected.length >= 1
      && noticeIndex >= 0
      && noticeIndex < turnEndIndex
      && typeof injected[0]?.text === 'string' && injected[0].text.includes(`request_id "${request.requestId}"`),
    JSON.stringify({ injected: injected.map((row) => row?.text?.slice(0, 200)), noticeIndex, turnEndIndex }),
  )
  run.check(
    'the holder was offered the reply tool mid-turn and answered release',
    replyRequest?.replyToolOffered === true
      && replyRequest?.noticeDelivered === true
      && replyRequest?.emittedNames?.includes('edit_lock_reply') === true
      && reply?.status === 'completed'
      && typeof reply?.result === 'string' && reply.result.includes(`${request.requestId}: transferred`),
    JSON.stringify({ replyToolOffered: replyRequest?.replyToolOffered, reply }),
  )
  run.check(
    'the reply ran in that same turn: the holder spent exactly one turn, no extra wake',
    turnEnds.length === 1 && replyIndex >= 0 && replyIndex < turnEndIndex,
    JSON.stringify({ turnEnds: turnEnds.length, replyIndex, turnEndIndex, turns: records.filter((row) => row?.type === 'turn/end').map((row) => row?.session) }),
  )
  run.check(
    'ownership transferred: the broker pushed transferred and the driver\'s acquire then succeeded',
    settled.state === 'transferred' && afterTransfer.refused === false && (afterTransfer.granted ?? []).includes(target),
    JSON.stringify({ settled, afterTransfer }),
  )
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env, decide, observe, run, assert }
