// Scenario: filelease-turn-release — a managed write claims its target for the
// turn, a SECOND owner is refused while the turn runs, and the turn boundary
// gives the claim back without any model or user action (edit-lock-rebuild
// tasks 5.2 / 5.5; design D2/D7/D10).
//
// The second owner is the driver itself: a headless boot is one process with
// one broker connection, so the only way to produce a genuinely foreign owner
// is to open another connection from outside (src/lease-probe.js). The driver
// waits for the managed write to land (which implies the claim was taken
// before publication), asks for the same path, and must be refused with
// `held` naming the holder's label.
//
// Turn-end release is observed INSIDE the session process
// (src/file-lease-turn-probe.js): after the boot exits, the broker has already
// dropped every lease of the disconnecting process, so a driver-side snapshot
// could not tell turn-end release apart from process death. The probe reads
// the table right after `turn/end`; the snapshot must show an empty table.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { connectLeaseBroker, pollUntil, retryUntil } from '../lease-probe.js'

const id = 'filelease-turn-release'
const prompt = 'filelease-turn-release-probe'
const WS = join(IT_ROOT, 'ws')
const TARGET = join(WS, 'lease-target.txt')
const CONTENT = 'turn release target\n'
const SNAPSHOT = 'lease-turn-release-snapshot.json'

// A real foreign owner: different lineage, different session, human label the
// refusal is expected to name.
const SECOND_OWNER = { id: 'weir-it-second-owner', session: 'session-weir-it-second-owner', label: 'Second owner (integration driver)' }

const env = {
  WEIR_IT_EDIT_LOCK: '1',
  WEIR_IT_LEASE_PROBE: '1',
  WEIR_IT_LEASE_SNAPSHOT: SNAPSHOT,
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return textChunks('unhandled filelease turn')
  // One managed write claims the path for this turn...
  if (!history.includes(`Created file: ${TARGET}`) && !history.includes(`Updated file: ${TARGET}`)) {
    return toolCallChunks('write', { file_path: TARGET, content: CONTENT })
  }
  // ...and the shell wait holds the turn open while the driver contends.
  if (!history.includes('WEIR_LEASE_CONTENDED')) {
    return shellCall('echo-and-wait', { text: 'WEIR_LEASE_CONTENDED', seconds: 2 }, 'Hold the turn open while a second owner contends')
  }
  return textChunks('turn release observed')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire') }
}

/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const socketPath = process.env.WEIR_EDITLOCKD_SOCKET
  const outcomePromise = spawnHeadless(['weir-it', prompt], scenarioEnv(id, trace, env))
  const broker = connectLeaseBroker(socketPath, { timeoutMs: 3_000 })
  /** @type {Record<string, any>} */
  const report = { kind: 'filelease-turn-release-report', socketPath, target: TARGET }
  try {
    // The managed write publishes only after the claim is granted, so the file
    // appearing is the driver's signal that the turn holds the lease.
    report.writeAppeared = (await pollUntil(() => existsSync(TARGET), { timeoutMs: 60_000, stepMs: 20 })) !== null
    if (report.writeAppeared) {
      const handshake = await retryUntil(() => broker.hello(), { timeoutMs: 20_000, stepMs: 100 })
      report.arbiter = handshake.ok
        ? { ok: true, startedAt: handshake.value?.startedAt ?? null, daemonVersion: handshake.value?.daemonVersion ?? null }
        : { ok: false, error: String(handshake.error?.message ?? handshake.error) }
      if (handshake.ok) {
        try {
          const reply = await broker.acquire(SECOND_OWNER, [TARGET], WS)
          report.conflict = reply?.ok === true
            ? { refused: false, granted: (Array.isArray(reply.granted) ? reply.granted : []).map((lease) => lease?.path) }
            : { refused: true, code: reply?.error?.code ?? null, conflicts: Array.isArray(reply?.error?.conflicts) ? reply.error.conflicts : [] }
        } catch (error) {
          report.conflict = { refused: false, transport: true, code: error?.code ?? 'transport', message: String(error?.message ?? error) }
        }
      }
    }
  } finally {
    broker.close()
  }
  const outcome = await outcomePromise
  report.snapshot = readJson(join(WS, SNAPSHOT))
  appendFileSync(trace, JSON.stringify(report) + '\n')
  return { scenario: id, trace, ...outcome }
}

function assert(run) {
  const report = run.records.find((row) => row?.kind === 'filelease-turn-release-report')
  const text = run.requests.map((request) => `${request.lastTool ?? ''}\n${request.lastUser ?? ''}`).join('\n')
  const target = join(run.ws, 'lease-target.txt')
  const bytes = existsSync(target) ? readFileSync(target, 'utf8') : null
  const conflict = report?.conflict ?? {}
  const holder = conflict.conflicts?.[0]?.holder ?? {}
  const runs = report?.snapshot?.runs ?? []
  // Turn-end evidence specifically: an `agent/disposed` observation may follow
  // during teardown (it releases retained claims too, D10) and says nothing
  // about the turn boundary this scenario is about.
  const turnRuns = runs.filter((entry) => /turn\/end/.test(entry?.trigger ?? ''))
  const lastRun = turnRuns.at(-1) ?? runs.at(-1)
  const lastReading = lastRun?.readings?.at(-1)

  run.check('managed write published the target before the driver contended', report?.writeAppeared === true && bytes !== null, JSON.stringify(report?.writeAppeared))
  run.check(
    'second owner was refused with `held` while the turn held the path',
    conflict.refused === true && conflict.code === 'held' && conflict.conflicts?.[0]?.path === target,
    JSON.stringify(conflict),
  )
  // The holder is the PRODUCT session, not the second owner: a non-empty label
  // and the session the in-process probe observed make the refusal a real
  // cross-owner verdict rather than a fabricated frame.
  const observedSession = runs[0]?.session ?? null
  run.check(
    'the refusal names a holder label and the actual holding session',
    typeof holder.label === 'string' && holder.label.trim().length > 0
      && (observedSession === null || holder.session === observedSession),
    JSON.stringify({ holder, observedSession }),
  )
  run.check('in-process probe observed the turn boundary and wrote a snapshot', runs.length > 0 && (lastRun?.readings?.length ?? 0) > 0, JSON.stringify(runs.map((entry) => entry?.trigger)))
  run.check(
    'turn end released the claim: the arbiter table is empty afterwards',
    lastReading?.ok === true && Array.isArray(lastReading.leases) && lastReading.leases.length === 0,
    JSON.stringify(lastRun?.readings?.map((reading) => ({ ok: reading.ok, leases: reading.leases?.map((lease) => lease.path), error: reading.error }))),
  )
  run.check('target bytes are exactly the managed write content', bytes === CONTENT, JSON.stringify(bytes))
  run.check('the model saw the managed write succeed', text.includes(`Created file: ${TARGET}`) || text.includes(`Updated file: ${TARGET}`), text.slice(-500))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env, decide, observe, run, assert }
