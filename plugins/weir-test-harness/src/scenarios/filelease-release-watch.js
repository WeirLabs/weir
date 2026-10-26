// Scenario: filelease-release-watch — two waiting sessions compete after ONE
// release, through the product's own `edit_lock_watch` subscription (design
// D1/D2/D4, spec "Waiting sessions compete without broker arbitration").
//
// TOPOLOGY (and why it takes this shape)
// A headless boot is one process with one broker connection, so the holder and
// the second waiter both have to come from the driver:
//
//   holder   — the driver's own broker connection, owning the target before the
//              boot even starts (it also owns the daemon, on a private socket,
//              so an earlier scenario's arbiter can never answer for this run);
//   waiter B — the headless session: its managed write is refused, its transfer
//              request is DECLINED by the holder, and it then subscribes with
//              `edit_lock_watch`, which is the flow the spec describes;
//   waiter C — a second driver connection: refused with the ordinary holder
//              conflict, then waiting for the same release.
//
// THE SEQUENCE
//   1. the holder owns the target; the boot's managed write is refused `held`;
//   2. the boot asks for a transfer; the holder answers `keep`, so the boot sees
//      `declined` — a subscription is only interesting after a real refusal;
//   3. the boot subscribes (`watching`) and, as its own proof of establishment,
//      publishes an unrelated marker file the driver polls;
//   4. waiter C is refused and starts waiting for the broadcast;
//   5. the holder releases: the REAL broker broadcasts one `released` fact to
//      every connection (both driver connections observe it);
//   6. waiter C claims the path first — the broker assigned no order, it just
//      answered the first acquire;
//   7. the boot's release notice arrives as a message inside its own turn, it
//      tries to claim the path, gets the ordinary `held` conflict naming waiter
//      C, and subscribes again for the next release.
//
// NOTHING IS ASSERTED ABOUT WINNER SELECTION. The point of the scenario is that
// the notice creates an opportunity: both waiters are notified exactly once, one
// acquire wins, the loser sees a normal conflict with a named holder, and no
// subscription survives its own release.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IT_ROOT, shellCall, textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'
import { parseJsonlLines } from '../jsonl.js'
import { connectLeaseBroker, pollUntil, retryUntil } from '../lease-probe.js'

const id = 'filelease-release-watch'
const prompt = 'filelease-release-watch-probe'
const WS = join(IT_ROOT, 'ws')
const TARGET = join(WS, 'lease-watch-target.txt')
const MARKER = join(WS, 'lease-watch-subscribed.txt')
const TARGET_CONTENT = 'held by the driver before the boot starts\n'
const MARKER_CONTENT = 'the boot established its subscription\n'

// Two genuinely foreign owners: different lineage, session and label, so the
// conflict text the boot receives can only be about these connections.
const HOLDER = Object.freeze({
  id: 'weir-it-watch-holder',
  session: 'session-weir-it-watch-holder',
  label: 'Second owner (integration driver)',
})
const RIVAL = Object.freeze({
  id: 'weir-it-watch-rival',
  session: 'session-weir-it-watch-rival',
  label: 'Third owner (integration driver)',
})

// The fragments of the product's own texts this scenario keys on: the release
// notice (plugin.releasedNoticeText), the decline notice, and the tool results.
const RELEASE_NOTICE = 'no longer held by another session'
const DECLINE_NOTICE = 'the holder kept'
const WATCH_RESULT = 'Watching'
const REFUSAL = 'Refused: 1 of the requested path(s) are owned by another session.'

/** Unique per invocation: no daemon, stale or live, can answer for this boot. */
const SOCKET = join(tmpdir(), `weir-it-watch-${createHash('sha256').update(`${IT_ROOT}:${process.pid}:${randomBytes(4).toString('hex')}`).digest('hex').slice(0, 12)}.sock`)

const env = { WEIR_IT_EDIT_LOCK: '1', WEIR_EDITLOCKD_SOCKET: SOCKET }

/** How many watch results the transcript already carries. */
function watchCount(history) {
  return [...history.matchAll(/Watching \S+? for its next release/gu)].length
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return textChunks('unhandled filelease-release-watch turn')

  // 1. The managed write is the premise: the holder owns the target, so this
  // call is refused before any byte is published.
  if (!history.includes('lease broker refused acquire: held')) {
    return toolCallChunks('write', { file_path: TARGET, content: TARGET_CONTENT })
  }

  // 2. Negotiate: this is how a real session ends up with a declined request.
  if (!history.includes('is pending with')) {
    return toolCallChunks('edit_lock_try_steal', { file_path: TARGET })
  }

  // 3. A declined transfer is exactly the spec's starting point for a watch.
  if (!history.includes(DECLINE_NOTICE)) {
    const verdict = waitForMarker(history, DECLINE_NOTICE, 16)
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('the transfer request was never declined')
  }

  // 4. Subscribe for the next release.
  if (watchCount(history) < 1) {
    return toolCallChunks('edit_lock_watch', { file_path: TARGET })
  }

  // 5. Publish the marker the driver polls: it is the boot's own evidence that
  // the subscription exists, so the release cannot race the registration.
  if (!history.includes(`Created file: ${MARKER}`)) {
    return toolCallChunks('write', { file_path: MARKER, content: MARKER_CONTENT })
  }

  // 6. Wait for the release notice INSIDE this turn (no extra wake is needed
  // for a running session, which is what D4 claims).
  if (!history.includes(RELEASE_NOTICE)) {
    const verdict = waitForMarker(history, RELEASE_NOTICE, 16)
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('the release notice never arrived')
  }

  // A claim against a live holder must never succeed. If it did, end the turn
  // instead of retrying, so the assertion reports the fact instead of a loop.
  if (history.includes('Claimed 1 path(s) for this turn: lease-watch-target.txt')) {
    return textChunks('the boot claimed a path the other waiter already held (unexpected)')
  }

  // 7. Compete for the path now that it is free — and lose, because the other
  // waiter already claimed it. The refusal is the ordinary holder conflict.
  if (!history.includes(REFUSAL)) {
    return toolCallChunks('edit_lock_acquire', { paths: [TARGET] })
  }

  // 8. A lost race is not a dead end: subscribing again is allowed immediately.
  if (watchCount(history) < 2) {
    return toolCallChunks('edit_lock_watch', { file_path: TARGET })
  }

  return textChunks('release watch settled: one release, rival won, ordinary conflict, re-watched')
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

/** @param {any} reply */
function acquireReport(reply) {
  if (reply?.ok === true) return { refused: false, granted: (Array.isArray(reply.granted) ? reply.granted : []).map((lease) => lease?.path ?? null) }
  return {
    refused: true,
    code: reply?.error?.code ?? null,
    conflicts: (Array.isArray(reply?.error?.conflicts) ? reply.error.conflicts : []).map((conflict) => ({ path: conflict?.path ?? null, holder: conflict?.holder ?? null })),
  }
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

/** @param {string} trace @param {Record<string, any>} report */
function appendReport(trace, report) {
  try {
    appendFileSync(trace, JSON.stringify(report) + '\n')
  } catch {
    // Reporting must never fail the scenario; the assertions report absence.
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
  const report = { kind: 'filelease-release-watch-report', socket: SOCKET }
  const daemon = startDaemon(entry, SOCKET)
  report.daemonPid = daemon.pid ?? null
  const holder = connectLeaseBroker(SOCKET, { timeoutMs: 3_000 })
  const rival = connectLeaseBroker(SOCKET, { timeoutMs: 3_000 })
  /** @type {any} */
  let outcome = null
  try {
    const up = await retryUntil(() => holder.hello(), { timeoutMs: 15_000, stepMs: 100 })
    report.arbiter = up.ok ? { ok: true, startedAt: up.value?.startedAt ?? null } : { ok: false, error: String(up.error?.message ?? up.error) }
    if (!up.ok) {
      report.durationMs = 0
      appendReport(trace, report)
      return { scenario: id, trace, code: 1, stdout: '', stderr: `daemon did not start: ${report.arbiter.error}` }
    }

    // The holder owns the target BEFORE the boot boots, so the boot's first
    // managed write is a genuine foreign conflict and not a race.
    report.holderAcquire = acquireReport(await holder.acquire(HOLDER, [TARGET], WS))
    report.targetBytesBefore = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null

    const startedAt = Date.now()
    const outcomePromise = spawnHeadless(['weir-it', '--json', prompt], scenarioEnv(id, trace, env))
    outcome = outcomePromise

    // 1. The boot asks for the path; the holder declines it. The `settled`
    // event belongs to the requester's connection (the boot's), so the holder's
    // own reply verdict is the driver-side evidence here.
    const request = await holder.nextEvent('request', (event) => event?.path === TARGET, { timeoutMs: 90_000 })
    report.request = { requestId: request?.requestId ?? null, path: request?.path ?? null, from: request?.from ?? null }
    report.reply = await holder.reply(HOLDER, request.requestId, 'keep')

    // 2. Wait for the boot's own proof that `edit_lock_watch` established the
    // subscription (the marker write follows the watch result).
    report.subscribed = (await pollUntil(() => existsSync(MARKER), { timeoutMs: 90_000, stepMs: 20 })) !== null

    // 3. Waiter C is a second foreign session, refused in the ordinary way.
    report.rivalConflict = acquireReport(await rival.acquire(RIVAL, [TARGET], WS))

    // 4. ONE release: the real broker broadcasts it to every connection.
    report.release = await holder.release(HOLDER, [TARGET])
    report.holderSawReleased = await holder.nextEvent('released', (event) => event?.path === TARGET, { timeoutMs: 15_000 })
      .then((event) => ({ path: event?.path ?? null, reason: event?.reason ?? null }))
      .catch((error) => ({ error: String(error?.message ?? error) }))
    report.rivalSawReleased = await rival.nextEvent('released', (event) => event?.path === TARGET, { timeoutMs: 15_000 })
      .then((event) => ({ path: event?.path ?? null, reason: event?.reason ?? null }))
      .catch((error) => ({ error: String(error?.message ?? error) }))

    // 5. Waiter C claims it first. The broker chose nobody: it answered an
    // acquire, and the boot's later acquire will be refused normally.
    report.rivalAcquire = acquireReport(await rival.acquire(RIVAL, [TARGET], WS))
    report.rivalHolds = await holder.status({ path: TARGET }).then((reply) => (Array.isArray(reply?.leases) ? reply.leases.map((lease) => ({ session: lease?.owner?.session ?? null, label: lease?.owner?.label ?? null })) : []))

    // The boot finishes WHILE the rival still holds the path: closing the rival
    // connection earlier would free the lease and turn the boot's claim into a
    // success, invalidating the very race this scenario measures.
    outcome = await outcomePromise
    report.rivalHoldsAfter = await holder.status({ path: TARGET }).then((reply) => (Array.isArray(reply?.leases) ? reply.leases.map((lease) => ({ session: lease?.owner?.session ?? null, label: lease?.owner?.label ?? null })) : []))
    report.durationMs = Date.now() - startedAt
  } catch (error) {
    report.driverError = String(/** @type {any} */ (error)?.message ?? error)
  } finally {
    try {
      daemon.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    holder.close()
    rival.close()
    rmSync(SOCKET, { force: true })
  }

  report.targetBytes = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null
  report.markerBytes = existsSync(MARKER) ? readFileSync(MARKER, 'utf8') : null
  appendReport(trace, report)
  // The boot's own outcome is the run's outcome: a driver error above is
  // reported as a failed check, never as a silent pass.
  const settledOutcome = await Promise.resolve(outcome).catch((error) => ({ code: 1, stdout: '', stderr: String(error?.message ?? error) }))
  return { scenario: id, trace, ...settledOutcome }
}

function assert(run) {
  const report = run.records.find((row) => row?.kind === 'filelease-release-watch-report')
  const tools = toolStream(run.stdout)
  const sessionId = parseJsonlLines(run.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
  const writes = tools.filter((tool) => tool.tool === 'write')
  const steals = tools.filter((tool) => tool.tool === 'edit_lock_try_steal')
  const watches = tools.filter((tool) => tool.tool === 'edit_lock_watch')
  const acquires = tools.filter((tool) => tool.tool === 'edit_lock_acquire')
  const targetPath = join(run.ws, 'lease-watch-target.txt')
  const markerPath = join(run.ws, 'lease-watch-subscribed.txt')
  const targetBytes = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null
  const markerBytes = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null

  const releaseNotices = run.inboxInserted.filter((row) => String(row?.text ?? '').includes(RELEASE_NOTICE))
  const releaseMessages = run.events.filter((row) => row?.type === 'user/message' && String(row?.text ?? '').includes(RELEASE_NOTICE))
  const holder = report?.holderAcquire ?? {}
  const request = report?.request ?? {}
  const reply = report?.reply ?? {}
  const settled = report?.settled ?? {}
  const rivalConflict = report?.rivalConflict ?? {}
  const rivalAcquire = report?.rivalAcquire ?? {}
  const firstWatch = watches[0] ?? null
  const secondWatch = watches[1] ?? null
  const refusedAcquire = acquires[acquires.length - 1] ?? null

  run.check(
    'the driver-owned arbiter held the target before the boot booted',
    report?.arbiter?.ok === true && holder.refused === false && (holder.granted ?? []).includes(targetPath),
    JSON.stringify({ arbiter: report?.arbiter, holder, targetPath, driverError: report?.driverError }),
  )
  run.check(
    'the boot\'s managed write was refused with held while the target had a foreign holder',
    writes[0]?.status === 'error' && String(writes[0]?.result ?? '').includes('lease broker refused acquire: held'),
    JSON.stringify({ writes }),
  )
  run.check(
    'the transfer request was pending with the live holder and the holder declined it',
    typeof request.requestId === 'string' && request.from?.session === sessionId && reply?.ok === true && reply?.state === 'declined',
    JSON.stringify({ request, reply, sessionId }),
  )
  run.check(
    'the release subscription was established while the path was still held',
    report?.subscribed === true
      && firstWatch?.status === 'completed'
      && String(firstWatch?.result ?? '').includes(WATCH_RESULT)
      && String(firstWatch?.result ?? '').includes(HOLDER.label)
      && markerBytes === MARKER_CONTENT,
    JSON.stringify({ subscribed: report?.subscribed, firstWatch, markerBytes }),
  )
  run.check(
    'the second waiting session was refused with the ordinary holder conflict',
    rivalConflict.refused === true && rivalConflict.code === 'held' && (rivalConflict.conflicts ?? [])[0]?.path === targetPath,
    JSON.stringify(rivalConflict),
  )
  run.check(
    'one release broadcast reached every connection with reason released',
    report?.release?.released?.[0] === targetPath
      && report?.holderSawReleased?.reason === 'released'
      && report?.rivalSawReleased?.reason === 'released',
    JSON.stringify({ release: report?.release, holderSaw: report?.holderSawReleased, rivalSaw: report?.rivalSawReleased }),
  )
  run.check(
    'the boot was notified exactly once, inside its running turn, as a full UserMessage',
    releaseNotices.length === 1
      && releaseMessages.length === 1
      && String(releaseMessages[0]?.source ?? '') === 'weir-file-lease'
      && String(releaseNotices[0]?.text ?? '').includes('edit_lock_acquire')
      && String(releaseNotices[0]?.text ?? '').includes('not a grant of ownership'),
    JSON.stringify({ releaseNotices, releaseMessages }),
  )
  run.check(
    'the other subscriber received the same fact on its own connection (no broker-chosen winner)',
    report?.rivalSawReleased?.path === targetPath && (report?.rivalAcquire?.refused === false),
    JSON.stringify({ rivalSaw: report?.rivalSawReleased, rivalAcquire }),
  )
  run.check(
    'the boot\'s claim lost the race with the ordinary held conflict naming the new holder',
    refusedAcquire?.status === 'error'
      && String(refusedAcquire?.result ?? '').includes(REFUSAL)
      && String(refusedAcquire?.result ?? '').includes(RIVAL.label)
      && (report?.rivalHolds ?? []).some((lease) => lease.session === RIVAL.session),
    JSON.stringify({ refusedAcquire, rivalHolds: report?.rivalHolds }),
  )
  run.check(
    'a lost race can subscribe again immediately (the notice was consumed, not replayed)',
    secondWatch?.status === 'completed'
      && String(secondWatch?.result ?? '').includes(WATCH_RESULT)
      && String(secondWatch?.result ?? '').includes(RIVAL.label),
    JSON.stringify({ secondWatch }),
  )
  run.check(
    'the refused write created nothing: the target file does not exist',
    targetBytes === null,
    JSON.stringify({ targetBytes }),
  )
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env, decide, observe, run, assert }
