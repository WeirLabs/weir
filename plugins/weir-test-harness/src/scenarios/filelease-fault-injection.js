// Scenario: filelease-fault-injection — killing the arbiter mid-turn must not
// block the rest of the turn (edit-lock-rebuild tasks 5.2 / 5.6; design D1/D7).
//
// HOW THE DAEMON IS IDENTIFIED (and why this way)
// The product spawns the daemon detached on the first managed write, so the
// driver never holds a PID for it. Instead this scenario OWNS the endpoint: it
// gives the boot a private socket address and starts the REAL product daemon
// (`weir-harness/src/lease-broker/entry.js`, the same file the product's own
// spawn hook runs) itself, so the SIGKILL targets an exact process and its exit
// is observable (`signal === 'SIGKILL'`). A `ps`/`lsof` lookup by socket name
// was rejected as the primary mechanism: it silently matches nothing (or the
// wrong process) on a busy machine, which would make the scenario pass without
// injecting anything. A private endpoint also keeps this scenario independent
// of whichever daemon a preceding scenario left on the run's shared socket.
//
// WHAT IT ASSERTS
// The turn keeps going after the kill: the second managed write publishes
// (whatever path it takes — a fresh daemon takes the claim, an unreachable one
// degrades and the write proceeds), the killed incarnation never answers again,
// nothing times out, and the whole boot stays under a generous wall-clock
// bound. A hang is the failure this scenario exists to catch, so the bound is
// an assertion, not a comment.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IT_ROOT, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { connectLeaseBroker, pollUntil, retryUntil } from '../lease-probe.js'

const id = 'filelease-fault-injection'
const prompt = 'filelease-fault-injection-probe'
const WS = join(IT_ROOT, 'ws')
const FIRST = join(WS, 'lease-fault-first.txt')
const SECOND = join(WS, 'lease-fault-second.txt')
const FIRST_CONTENT = 'written while the arbiter lived\n'
const SECOND_CONTENT = 'written after the arbiter was killed\n'

/** Wall-clock ceiling for the whole boot; a blocked write blows past this. */
const RUN_BUDGET_MS = 90_000
/** How long the driver waits for the daemon's replacement to appear afterwards. */
const AFTER_LOOKUP_MS = 3_000
/** How long the driver waits for the killed child to be reaped. */
const KILL_WAIT_MS = 10_000

const env = { WEIR_IT_EDIT_LOCK: '1' }
/** Unique per invocation: no daemon, stale or live, can answer for this boot. */
const FAULT_SOCKET = join(tmpdir(), `weir-it-fault-${createHash('sha256').update(`${IT_ROOT}:${process.pid}:${randomBytes(4).toString('hex')}`).digest('hex').slice(0, 12)}.sock`)

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return textChunks('unhandled filelease turn')
  if (!history.includes(`Created file: ${FIRST}`)) return toolCallChunks('write', { file_path: FIRST, content: FIRST_CONTENT })
  // The shell wait holds the turn open while the driver kills the daemon.
  if (!history.includes('WEIR_FAULT_INJECTED')) {
    return shellCall('echo-and-wait', { text: 'WEIR_FAULT_INJECTED', seconds: 2 }, 'Hold the turn open while the arbiter is killed')
  }
  if (!history.includes(`Created file: ${SECOND}`)) return toolCallChunks('write', { file_path: SECOND, content: SECOND_CONTENT })
  return textChunks('post-kill write observed')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire') }
}

/** @param {import('node:child_process').ChildProcess} child */
function waitForExit(child) {
  return new Promise((resolvePromise) => {
    // Ref'd: the wait itself must keep the driver alive (the daemon handle is
    // unref'd on purpose so a forgotten daemon cannot pin the whole run).
    const timer = setTimeout(() => resolvePromise({ timedOut: true }), KILL_WAIT_MS)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ timedOut: false, code, signal })
    })
  })
}

/**
 * Start the real broker entry with this scenario's endpoint. Never spawns a
 * second copy on top of a live daemon: the address is unique, and a failed bind
 * is reported as a failed precondition by the driver below.
 * @param {string} entry
 */
function startDaemon(entry) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, WEIR_EDITLOCKD_SOCKET: FAULT_SOCKET, WEIR_EDITLOCKD_IDLE_MS: '120000' },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return child
}

async function run({ IT_ROOT: root, WS_ROOT, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const entry = join(WS_ROOT, 'plugins/weir-harness/src/lease-broker/entry.js')
  rmSync(FAULT_SOCKET, { force: true })
  /** @type {Record<string, any>} */
  const report = { kind: 'filelease-fault-injection-report', socket: FAULT_SOCKET, entry }
  const startedAt = Date.now()
  const daemon = startDaemon(entry)
  report.daemonPid = daemon.pid ?? null
  const broker = connectLeaseBroker(FAULT_SOCKET, { timeoutMs: 3_000 })
  /** @type {any} */
  let outcome = null
  try {
    const up = await retryUntil(() => broker.hello(), { timeoutMs: 10_000, stepMs: 100 })
    report.arbiterBefore = up.ok ? { ok: true, startedAt: up.value?.startedAt ?? null, daemonVersion: up.value?.daemonVersion ?? null } : { ok: false, error: String(up.error?.message ?? up.error) }
    if (!up.ok) {
      report.durationMs = Date.now() - startedAt
      appendFileSync(trace, JSON.stringify(report) + '\n')
      return { scenario: id, trace, code: 1, stdout: '', stderr: `daemon did not start: ${report.arbiterBefore.error}` }
    }
    const outcomePromise = spawnHeadless(['weir-it', prompt], scenarioEnv(id, trace, { ...env, WEIR_EDITLOCKD_SOCKET: FAULT_SOCKET }))
    // The first managed write acquires from THIS daemon; once the file is there
    // the turn provably holds a lease from it, so killing now is the intended
    // fault and not a no-op on an unused process.
    report.firstWriteAppeared = (await pollUntil(() => existsSync(FIRST), { timeoutMs: 60_000, stepMs: 20 })) !== null
    if (report.firstWriteAppeared) {
      report.killed = { requested: daemon.kill('SIGKILL'), ...(await waitForExit(daemon)) }
    }
    outcome = await outcomePromise
    report.durationMs = Date.now() - startedAt
  } finally {
    try {
      daemon.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    broker.close()
    // After the boot: does the endpoint answer again? A fresh incarnation is the
    // product's own recovery; silence means the write had to degrade. Both are
    // allowed — being blocked is not, and that is asserted on the write above.
    const after = connectLeaseBroker(FAULT_SOCKET, { timeoutMs: 2_000 })
    const lookup = await retryUntil(() => after.hello(), { timeoutMs: AFTER_LOOKUP_MS, stepMs: 100 })
    report.arbiterAfter = lookup.ok
      ? { absent: false, startedAt: lookup.value?.startedAt ?? null }
      : { absent: true, error: String(lookup.error?.message ?? lookup.error) }
    after.close()
    rmSync(FAULT_SOCKET, { force: true })
  }
  report.secondBytes = existsSync(SECOND) ? readFileSync(SECOND, 'utf8') : null
  report.firstBytes = existsSync(FIRST) ? readFileSync(FIRST, 'utf8') : null
  appendFileSync(trace, JSON.stringify(report) + '\n')
  return { scenario: id, trace, ...outcome }
}

function assert(run) {
  const report = run.records.find((row) => row?.kind === 'filelease-fault-injection-report')
  const text = run.requests.map((request) => `${request.lastTool ?? ''}\n${request.lastUser ?? ''}`).join('\n')
  const second = join(run.ws, 'lease-fault-second.txt')
  const secondBytes = existsSync(second) ? readFileSync(second, 'utf8') : null
  const before = report?.arbiterBefore ?? {}
  const killed = report?.killed ?? {}
  const after = report?.arbiterAfter ?? {}

  run.check(
    'a real product daemon served the boot before the fault (precondition, not the test)',
    before.ok === true && typeof before.startedAt === 'number' && report?.daemonPid !== null && report?.firstWriteAppeared === true,
    JSON.stringify({ before, daemonPid: report?.daemonPid, firstWriteAppeared: report?.firstWriteAppeared }),
  )
  run.check(
    'the daemon was really SIGKILLed (its own exit reports the signal)',
    killed.requested === true && killed.timedOut === false && killed.signal === 'SIGKILL',
    JSON.stringify(killed),
  )
  run.check(
    'the killed incarnation never answers again',
    after.absent === true || (typeof after.startedAt === 'number' && after.startedAt !== before.startedAt),
    JSON.stringify({ before: before.startedAt, after }),
  )
  run.check(
    'the post-kill managed write published its bytes (no blocking, no lost write)',
    secondBytes === SECOND_CONTENT && text.includes(`Created file: ${SECOND}`),
    JSON.stringify({ secondBytes, secondStep: text.slice(-500) }),
  )
  run.check(
    `the whole run stayed under ${RUN_BUDGET_MS / 1000}s (a blocked arbiter would hang here)`,
    typeof report?.durationMs === 'number' && report.durationMs < RUN_BUDGET_MS,
    JSON.stringify({ durationMs: report?.durationMs, budgetMs: RUN_BUDGET_MS }),
  )
  run.check('the first write (from the killed daemon) is intact', report?.firstBytes === FIRST_CONTENT, JSON.stringify(report?.firstBytes))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env, decide, observe, run, assert }
