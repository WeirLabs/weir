// Scenario: filelease-watch-reset — a broker that DIES while a release
// subscription is active must end the subscription explicitly and must never be
// reported as a release (design D5; spec "Watch state is volatile and reset is
// explicit").
//
// WHY THIS IS ITS OWN SCENARIO
// `filelease-fault-injection` proves the write path survives a SIGKILLed
// arbiter. This one proves what happens to a SUBSCRIPTION, which is a different
// fact: a killed broker cannot broadcast anything, so the only honest signal is
// the client's own transport reset. It must (a) cancel the old subscription,
// (b) tell the model to re-check and re-subscribe — never that the path is free
// — and (c) not resurrect anything after a fresh incarnation appears.
//
// THE TOPOLOGY
// As in the fault-injection scenario, the driver OWNS the daemon (private
// socket, exact PID) so the kill is exact and observable. The driver holds the
// target, so the boot's managed write is refused; the boot subscribes with
// `edit_lock_watch` and publishes a marker file. The driver then:
//   SIGKILL daemon → start a fresh incarnation → acquire + release the target.
// The second acquire/release happens AFTER the boot reconnected, so it is a real
// broadcast on a live connection: if the pre-restart subscription had been
// restored anywhere, this is exactly where it would fire. It must not.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IT_ROOT, shellCall, textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'
import { parseJsonlLines } from '../jsonl.js'
import { connectLeaseBroker, pollUntil, retryUntil } from '../lease-probe.js'

const id = 'filelease-watch-reset'
const prompt = 'filelease-watch-reset-probe'
const WS = join(IT_ROOT, 'ws')
const TARGET = join(WS, 'lease-watch-reset-target.txt')
const MARKER = join(WS, 'lease-watch-reset-subscribed.txt')
const MARKER_CONTENT = 'the boot established its subscription before the fault\n'

const HOLDER = Object.freeze({
  id: 'weir-it-watch-reset-holder',
  session: 'session-weir-it-watch-reset-holder',
  label: 'Second owner (integration driver)',
})

// The product's texts this scenario keys on (plugin.resetNoticeText /
// plugin.releasedNoticeText / tools.js watch result).
const RESET_NOTICE = 'connection was reset'
const RELEASE_NOTICE = 'no longer held by another session'
const RE_CHECK = 'Re-check with edit_lock_status'
const WATCH_RESULT = 'Watching'
const SETTLE_MARKER = 'WEIR_WATCH_RESET_SETTLE'
const POST_RESTART_MARKER = 'WEIR_WATCH_RESET_POST_RESTART'

/** Wall-clock ceiling for the whole boot; a stuck reset would hang here. */
const RUN_BUDGET_MS = 120_000
/** How long the driver waits for the daemon process to be reaped. */
const KILL_WAIT_MS = 10_000
/** Let the boot reconnect before the post-restart release broadcast. */
const POST_RESTART_DELAY_MS = 4_000

/** Unique per invocation: no daemon, stale or live, can answer for this boot. */
const SOCKET = join(tmpdir(), `weir-it-watch-reset-${createHash('sha256').update(`${IT_ROOT}:${process.pid}:${randomBytes(4).toString('hex')}`).digest('hex').slice(0, 12)}.sock`)

const env = { WEIR_IT_EDIT_LOCK: '1', WEIR_EDITLOCKD_SOCKET: SOCKET }

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return textChunks('unhandled filelease-watch-reset turn')

  // 1. The foreign holder owns the target: the managed write is refused.
  if (!history.includes('lease broker refused acquire: held')) {
    return toolCallChunks('write', { file_path: TARGET, content: 'the driver owns this path\n' })
  }

  // 2. Subscribe while the path is still held.
  if (!history.includes(WATCH_RESULT)) {
    return toolCallChunks('edit_lock_watch', { file_path: TARGET })
  }

  // 3. Prove the subscription exists before the fault: the driver polls this.
  if (!history.includes(`Created file: ${MARKER}`)) {
    return toolCallChunks('write', { file_path: MARKER, content: MARKER_CONTENT })
  }

  // 4. Wait for the reset notice. The daemon is killed under the subscription.
  if (!history.includes(RESET_NOTICE)) {
    const verdict = waitForMarker(history, RESET_NOTICE, 30)
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('the connection reset was never reported')
  }

  // 5. Give the driver time to start a fresh incarnation BEFORE reconnecting,
  // so this session reconnects to the driver's daemon instead of spawning one.
  if (!history.includes(SETTLE_MARKER)) {
    return shellCall('echo-and-wait', { text: SETTLE_MARKER, seconds: 2 }, 'Let the fresh arbiter come up before re-checking')
  }

  // 6. Re-check ownership. This also reconnects the shared client, so a release
  // broadcast after this point would reach a LIVE connection. A transient
  // unreadable arbiter gets a bounded retry (the fresh daemon may still be
  // binding); it never turns into an unbounded loop.
  const readable = history.includes('This session holds nothing') || history.includes('Held by other sessions here')
  if (!readable) {
    const unreadable = (history.match(/The ownership arbiter is unreachable/gu) ?? []).length
    if (unreadable < 3) return toolCallChunks('edit_lock_status', {})
  }

  // 7. Stay alive while the driver acquires and releases the path on the fresh
  // incarnation. If the old subscription had been restored, this is where it
  // would notify — the assertion below says it must not.
  if (!history.includes(POST_RESTART_MARKER)) {
    return shellCall('echo-and-wait', { text: POST_RESTART_MARKER, seconds: 5 }, 'Stay alive while the fresh arbiter releases the path')
  }

  if (history.includes(RELEASE_NOTICE)) return textChunks('a restored subscription fired after the restart (must not happen)')
  return textChunks('watch reset settled: subscription ended, re-check told, nothing restored')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_watch') }
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

/** @param {string} entry @param {string} socket */
function startDaemon(entry, socket) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, WEIR_EDITLOCKD_SOCKET: socket, WEIR_EDITLOCKD_IDLE_MS: '120000', WEIR_EDITLOCKD_SWEEP_MS: '1000' },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return child
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** @param {import('node:child_process').ChildProcess} child */
function waitForExit(child) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise({ timedOut: true }), KILL_WAIT_MS)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ timedOut: false, code, signal })
    })
  })
}

/** @param {string} trace @param {Record<string, any>} report */
function appendReport(trace, report) {
  try {
    appendFileSync(trace, JSON.stringify(report) + '\n')
  } catch {
    // Reporting must never fail the scenario.
  }
}

async function run({ IT_ROOT: root, WS_ROOT, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const entry = join(WS_ROOT, 'plugins/weir-harness/src/lease-broker/entry.js')
  mkdirSync(WS, { recursive: true })
  rmSync(SOCKET, { force: true })
  rmSync(MARKER, { force: true })
  rmSync(TARGET, { force: true })

  /** @type {Record<string, any>} */
  const report = { kind: 'filelease-watch-reset-report', socket: SOCKET }
  const first = startDaemon(entry, SOCKET)
  report.firstPid = first.pid ?? null
  /** @type {any} */
  let second = null
  /** @type {any} */
  let outcome = null
  let holder = null
  try {
    const startedAt = Date.now()
    const up = await retryUntil(() => {
      holder ??= connectLeaseBroker(SOCKET, { timeoutMs: 3_000 })
      return holder.hello()
    }, { timeoutMs: 15_000, stepMs: 100 })
    report.arbiterBefore = up.ok ? { ok: true, startedAt: up.value?.startedAt ?? null } : { ok: false, error: String(up.error?.message ?? up.error) }
    if (!up.ok) {
      appendReport(trace, report)
      return { scenario: id, trace, code: 1, stdout: '', stderr: `daemon did not start: ${report.arbiterBefore.error}` }
    }
    report.holderAcquire = await holder.acquire(HOLDER, [TARGET], WS).then((reply) => ({ ok: reply?.ok === true, granted: (reply?.granted ?? []).map((lease) => lease?.path ?? null) }))

    const outcomePromise = spawnHeadless(['weir-it', '--json', prompt], scenarioEnv(id, trace, env))
    outcome = outcomePromise

    // The boot subscribes only after its managed write is refused; the marker
    // write after the watch result is its proof that the subscription exists.
    report.subscribed = (await pollUntil(() => existsSync(MARKER), { timeoutMs: 90_000, stepMs: 20 })) !== null
    if (report.subscribed) {
      // THE FAULT: kill the arbiter while the subscription is active.
      first.kill('SIGKILL')
      report.killed = { requested: true, ...(await waitForExit(first)) }

      // A fresh incarnation on the same endpoint. The boot reconnects on its own
      // re-check (step 6), then this connection performs a real acquire+release:
      // the broadcast is delivered to a live client, so a restored subscription
      // would fire here.
      holder.close()
      holder = connectLeaseBroker(SOCKET, { timeoutMs: 3_000 })
      second = startDaemon(entry, SOCKET)
      report.secondPid = second.pid ?? null
      const fresh = await retryUntil(() => holder.hello(), { timeoutMs: 15_000, stepMs: 100 })
      report.arbiterAfter = fresh.ok ? { ok: true, startedAt: fresh.value?.startedAt ?? null } : { ok: false, error: String(fresh.error?.message ?? fresh.error) }
      if (fresh.ok) {
        // Deliberate delay: the boot reconnects on its own re-check about two
        // seconds after the reset, and the post-restart release must land on
        // that LIVE connection or the "nothing was restored" check proves
        // nothing. The boot then stays alive for five more seconds.
        await delay(POST_RESTART_DELAY_MS)
        report.postRestartAcquire = await holder.acquire(HOLDER, [TARGET], WS).then((reply) => ({ ok: reply?.ok === true }))
        report.postRestartRelease = await holder.release(HOLDER, [TARGET]).then((reply) => ({ released: reply?.released ?? [], notOwned: reply?.notOwned ?? [] }))
        report.postRestartBroadcast = await holder.nextEvent('released', (event) => event?.path === TARGET, { timeoutMs: 10_000 })
          .then((event) => ({ path: event?.path ?? null, reason: event?.reason ?? null }))
          .catch((error) => ({ error: String(error?.message ?? error) }))
      }
    }
    report.durationMs = Date.now() - startedAt
  } catch (error) {
    report.driverError = String(/** @type {any} */ (error)?.message ?? error)
  } finally {
    for (const child of [first, second]) {
      try {
        child?.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    try {
      holder?.close()
    } catch {
      // Already gone.
    }
    rmSync(SOCKET, { force: true })
  }

  report.targetBytes = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null
  report.markerBytes = existsSync(MARKER) ? readFileSync(MARKER, 'utf8') : null
  appendReport(trace, report)
  const settledOutcome = await Promise.resolve(outcome).catch((error) => ({ code: 1, stdout: '', stderr: String(error?.message ?? error) }))
  return { scenario: id, trace, ...settledOutcome }
}

function assert(run) {
  const report = run.records.find((row) => row?.kind === 'filelease-watch-reset-report')
  const tools = toolStream(run.stdout)
  const watches = tools.filter((tool) => tool.tool === 'edit_lock_watch')
  const status = tools.find((tool) => tool.tool === 'edit_lock_status')
  const targetPath = join(run.ws, 'lease-watch-reset-target.txt')
  const markerPath = join(run.ws, 'lease-watch-reset-subscribed.txt')
  const markerBytes = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null
  const targetBytes = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null

  const resetNotices = run.inboxInserted.filter((row) => String(row?.text ?? '').includes(RESET_NOTICE))
  const resetMessages = run.events.filter((row) => row?.type === 'user/message' && String(row?.text ?? '').includes(RESET_NOTICE))
  const releaseNotices = run.inboxInserted.filter((row) => String(row?.text ?? '').includes(RELEASE_NOTICE))
  const releaseMessages = run.events.filter((row) => row?.type === 'user/message' && String(row?.text ?? '').includes(RELEASE_NOTICE))
  const before = report?.arbiterBefore ?? {}
  const after = report?.arbiterAfter ?? {}
  const killed = report?.killed ?? {}

  run.check(
    'a real product daemon served the boot and the subscription was established',
    before.ok === true
      && report?.holderAcquire?.ok === true
      && report?.subscribed === true
      && watches[0]?.status === 'completed'
      && String(watches[0]?.result ?? '').includes(WATCH_RESULT)
      && markerBytes === MARKER_CONTENT,
    JSON.stringify({ before, holderAcquire: report?.holderAcquire, subscribed: report?.subscribed, watches, markerBytes, driverError: report?.driverError }),
  )
  run.check(
    'the arbiter was really SIGKILLed while the subscription was active',
    killed.requested === true && killed.timedOut === false && killed.signal === 'SIGKILL',
    JSON.stringify(killed),
  )
  run.check(
    'the model was told the connection was reset, exactly once, in its running turn',
    resetNotices.length === 1
      && resetMessages.length === 1
      && String(resetMessages[0]?.source ?? '') === 'weir-file-lease',
    JSON.stringify({ resetNotices, resetMessages }),
  )
  run.check(
    'the reset notice asks for a re-check and subscribes again instead of claiming a release',
    String(resetNotices[0]?.text ?? '').includes(RE_CHECK)
      && String(resetNotices[0]?.text ?? '').includes('still held by another session')
      && !String(resetNotices[0]?.text ?? '').includes(RELEASE_NOTICE)
      && !String(resetNotices[0]?.text ?? '').includes('not a grant of ownership'),
    JSON.stringify({ text: resetNotices[0]?.text ?? null }),
  )
  run.check(
    'the subscription did not outlive the reset: no release notice anywhere in the run',
    releaseNotices.length === 0 && releaseMessages.length === 0,
    JSON.stringify({ releaseNotices, releaseMessages }),
  )
  run.check(
    'a fresh incarnation appeared and the release broadcast reached live connections only',
    after.ok === true && typeof after.startedAt === 'number' && after.startedAt !== before.startedAt
      && report?.postRestartAcquire?.ok === true
      && report?.postRestartRelease?.released?.[0] === targetPath
      && report?.postRestartBroadcast?.reason === 'released',
    JSON.stringify({ before: before.startedAt, after, acquire: report?.postRestartAcquire, release: report?.postRestartRelease, broadcast: report?.postRestartBroadcast }),
  )
  run.check(
    'the boot reconnected and re-checked ownership instead of spawning a second arbiter',
    status?.status === 'completed' && typeof status?.result === 'string' && /holds nothing|Held by other sessions/u.test(status.result),
    JSON.stringify({ status, secondPid: report?.secondPid }),
  )
  run.check(
    'nothing was written through the refused path and no subscription was restored',
    targetBytes === null,
    JSON.stringify({ targetBytes }),
  )
  run.check(
    `the whole run stayed under ${RUN_BUDGET_MS / 1000}s (a stuck reset would hang here)`,
    typeof report?.durationMs === 'number' && report.durationMs < RUN_BUDGET_MS,
    JSON.stringify({ durationMs: report?.durationMs, budgetMs: RUN_BUDGET_MS }),
  )
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env, decide, observe, run, assert }
