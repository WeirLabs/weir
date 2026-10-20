// Scenario: filelease-holder-death — killing the process that HOLDS a lease
// releases it immediately, because the arbiter releases everything a closed
// connection holds (edit-lock-rebuild task 5.6, the holder-process branch;
// design D8/D10).
//
// WHAT THIS PINS
// "Connection close ⇒ every lease of that process is released" (D8) is what
// makes the zero-persistence arbiter safe: a crashed editor cannot leave a row
// that blocks another session until the TTL lapses. The counterpart scenario
// (`filelease-fault-injection`) kills the DAEMON; this one kills a HOLDER, and
// the two failure directions must not be conflated.
//
// WHY THE HOLDER IS A SEPARATE PROCESS
// A headless boot is ONE process with ONE broker connection (D8), so a lease
// killed inside it would also kill the arbiter's client — the opposite of the
// scenario. The driver therefore spawns an independent Node process that
// connects to the run-private socket through the SAME driver-side client
// (src/lease-probe.js), acquires the path as a foreign owner, prints one JSON
// line, and stays connected until it is SIGKILLed. The kill signal is observed
// on the child's own exit event, so "we killed it" is a fact, not an intent.
//
// WHY THE ARBITER IS REAL
// The daemon is the one the PRODUCT spawns on the boot's first managed write
// (the same path every other filelease scenario uses), not a hand-started
// copy: the run then exercises the exact server incarnation and endpoint the
// product would use. The driver keeps its own connection open, so the daemon
// cannot idle out while the holder is being killed and the path re-acquired.
//
// ORDER OF EVIDENCE
//   1. the holder lives and a foreign acquire is refused (`held`, naming it);
//   2. SIGKILL is observed on the child's exit event (signal, no timeout);
//   3. `status` stops reporting the path within 1s (connection close, not TTL —
//      the TTL is minutes away, so a TTL release could never satisfy this);
//   4. the driver's acquire succeeds within the same 1s window;
//   5. the final `status` contains only the driver's row: no residual lease
//      owned by the dead process.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { connectLeaseBroker, pollUntil, retryUntil } from '../lease-probe.js'

const id = 'filelease-holder-death'
const prompt = 'filelease-holder-death-probe'
const WS = join(IT_ROOT, 'ws')
// The boot's own target: its only job is to make the product spawn the arbiter.
const BOOT_TARGET = join(WS, 'lease-holder-death-boot.txt')
const BOOT_CONTENT = 'arbiter bootstrap write\n'
// The path the doomed process owns. Nobody else claims it.
const TARGET = join(WS, 'lease-holder-death-owned.txt')
const TARGET_NAME = 'lease-holder-death-owned.txt'

/** The release contract under test: a closed connection releases in ms, not TTL. */
const RELEASE_BUDGET_MS = 1_000
/** How long the driver waits for each observable state change. */
const STAGE_BUDGET_MS = 5_000
/** How long the driver waits for the child to report its grant. */
const ACQUIRE_BUDGET_MS = 15_000
/** How long the driver waits for the SIGKILLed child to be reaped. */
const EXIT_BUDGET_MS = 10_000

const DRIVER = Object.freeze({
  id: 'weir-it-holder-death-driver',
  session: 'session-weir-it-holder-death-driver',
  label: 'Second owner (integration driver)',
})
const VICTIM = Object.freeze({
  id: 'weir-it-holder-death-victim',
  session: 'session-weir-it-holder-death-victim',
  label: 'Doomed holder (integration driver child)',
})

const env = { WEIR_IT_EDIT_LOCK: '1' }

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return textChunks('unhandled filelease-holder-death turn')
  // A managed write is what spawns the arbiter (the client's own spawn hook).
  if (!history.includes(`Created file: ${BOOT_TARGET}`) && !history.includes(`Updated file: ${BOOT_TARGET}`)) {
    if (history.includes('lease broker refused acquire')) return textChunks('the arbiter refused the bootstrap write')
    return toolCallChunks('write', { file_path: BOOT_TARGET, content: BOOT_CONTENT })
  }
  return textChunks('arbiter online')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire') }
}

/**
 * The doomed holder, as a standalone script. It reuses the driver-side broker
 * client (`src/lease-probe.js`) rather than re-implementing the wire protocol,
 * so the scenario exercises the same frames a real second owner would send.
 * The interval keeps the process (and therefore its connection) alive until
 * the driver SIGKILLs it; the client's socket is unref'd on purpose.
 * @param {string} probeUrl file URL of src/lease-probe.js
 * @returns {string} the script source
 */
function holderScript(probeUrl) {
  return [
    `import { connectLeaseBroker } from ${JSON.stringify(probeUrl)}`,
    '',
    'const [socketPath, ownerJson, target] = process.argv.slice(2)',
    'const owner = JSON.parse(ownerJson)',
    'const broker = connectLeaseBroker(socketPath, { timeoutMs: 5000 })',
    'try {',
    '  const reply = await broker.acquire(owner, [target], process.cwd())',
    '  const granted = reply?.ok === true && Array.isArray(reply.granted) ? reply.granted.map((lease) => lease.path) : []',
    '  process.stdout.write(JSON.stringify({ ok: reply?.ok === true, granted, error: reply?.ok === true ? null : (reply?.error ?? null) }) + "\\n")',
    '  if (reply?.ok !== true) process.exit(3)',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ ok: false, transport: String(error?.message ?? error) }) + "\\n")',
    '  process.exit(4)',
    '}',
    '// Hold the connection (and the lease) open until the driver kills this process.',
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n')
}

/**
 * The child's first stdout line: its acquire verdict.
 * @param {import('node:child_process').ChildProcess} child
 */
function waitForGrant(child) {
  return new Promise((resolvePromise) => {
    let buffered = ''
    let settled = false
    /** @type {any} */
    let timer = null
    /** @param {Record<string, any>} value */
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    timer = setTimeout(() => finish({ timedOut: true, buffered }), ACQUIRE_BUDGET_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      buffered += chunk
      const line = buffered.split('\n').find((entry) => entry.trim().length > 0)
      if (line === undefined) return
      try {
        finish({ timedOut: false, line: JSON.parse(line) })
      } catch {
        finish({ timedOut: false, parseError: line })
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', () => {})
    child.once('error', (error) => finish({ timedOut: false, error: String(error?.message ?? error) }))
    child.once('exit', (code, signal) => finish({ timedOut: false, exitedEarly: true, code, signal, buffered }))
  })
}

/**
 * The child's own exit event after the SIGKILL.
 * @param {import('node:child_process').ChildProcess} child
 */
function waitForExit(child) {
  return new Promise((resolvePromise) => {
    // A child that is already gone cannot emit again: report what it exited as.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ timedOut: false, code: child.exitCode, signal: child.signalCode })
      return
    }
    const timer = setTimeout(() => resolvePromise({ timedOut: true }), EXIT_BUDGET_MS)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ timedOut: false, code, signal })
    })
  })
}

/**
 * One acquire attempt recorded as facts.
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
 * The arbiter's rows for one path.
 * @param {any} broker @param {string} path
 */
async function readStatus(broker, path) {
  try {
    const reply = await broker.status({ path })
    const leases = Array.isArray(reply?.leases) ? reply.leases : []
    return { ok: reply?.ok === true, leases: leases.map((lease) => ({ path: lease?.path ?? null, owner: lease?.owner ?? null })) }
  } catch (error) {
    return { ok: false, leases: [], error: String(error?.message ?? error) }
  }
}

async function run({ IT_ROOT: root, WS_ROOT, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const socketPath = process.env.WEIR_EDITLOCKD_SOCKET
  const scriptPath = join(root, 'lease-holder-death-runner.mjs')
  const probeUrl = pathToFileURL(join(WS_ROOT, 'plugins/weir-test-harness/src/lease-probe.js')).href
  const outcomePromise = spawnHeadless(['weir-it', prompt], scenarioEnv(id, trace, env))
  const broker = connectLeaseBroker(socketPath, { timeoutMs: 3_000 })
  /** @type {import('node:child_process').ChildProcess | null} */
  let holder = null
  /** @type {Record<string, any>} */
  const report = { kind: 'filelease-holder-death-report', socketPath, target: TARGET, victimOwner: VICTIM }
  /** @type {any} */
  let outcome = null
  try {
    // The boot's managed write is what starts the product's arbiter; the file
    // appearing is the driver's signal that the daemon is about to answer.
    report.bootWriteAppeared = (await pollUntil(() => existsSync(BOOT_TARGET), { timeoutMs: 60_000, stepMs: 20 })) !== null
    const handshake = await retryUntil(() => broker.hello(), { timeoutMs: 20_000, stepMs: 100 })
    report.arbiter = handshake.ok
      ? { ok: true, startedAt: handshake.value?.startedAt ?? null, daemonVersion: handshake.value?.daemonVersion ?? null }
      : { ok: false, error: String(handshake.error?.message ?? handshake.error) }
    if (handshake.ok) {
      // The doomed holder: its own process, its own connection, its own owner.
      writeFileSync(scriptPath, holderScript(probeUrl))
      holder = spawn(process.execPath, [scriptPath, socketPath, JSON.stringify(VICTIM), TARGET], {
        cwd: WS,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      report.holderPid = holder.pid ?? null
      report.holderGrant = await waitForGrant(holder)
      report.holderAcquired = report.holderGrant?.line?.ok === true
        && (report.holderGrant?.line?.granted ?? []).includes(TARGET)
      if (report.holderAcquired) {
        // Precondition: the lease is real, and a foreign owner is refused by
        // it (the same refusal shape every other filelease scenario asserts).
        report.conflictBeforeDeath = await attemptAcquire(broker, [TARGET])
        const killedAt = Date.now()
        report.killRequested = holder.kill('SIGKILL')
        report.exit = await waitForExit(holder)
        // `status` must stop reporting the path: the release comes from the
        // connection close, long before the (minutes-long) TTL could apply.
        const free = await pollUntil(async () => {
          const snapshot = await readStatus(broker, TARGET)
          return snapshot.ok === true && snapshot.leases.length === 0 ? { at: Date.now(), snapshot } : null
        }, { timeoutMs: STAGE_BUDGET_MS, stepMs: 10 })
        report.releasedAfterMs = free === null ? null : free.at - killedAt
        report.statusWhenFree = free?.snapshot ?? null
        // The driver is now the next owner: the released path must be grantable
        // inside the same 1s budget the release was judged by.
        const acquired = await pollUntil(async () => {
          const attempt = await attemptAcquire(broker, [TARGET])
          report.lastAcquireAttempt = attempt
          return attempt.refused === false && (attempt.granted ?? []).includes(TARGET) ? { at: Date.now(), attempt } : null
        }, { timeoutMs: STAGE_BUDGET_MS, stepMs: 10 })
        report.acquireAfterDeath = acquired?.attempt ?? report.lastAcquireAttempt ?? null
        report.acquireAfterMs = acquired === null ? null : acquired.at - killedAt
        report.statusAfter = await readStatus(broker, TARGET)
      }
    }
  } catch (error) {
    report.driverError = String(/** @type {any} */ (error)?.message ?? error)
  } finally {
    // A surviving child would defeat the scenario's premise; never leave it.
    if (holder !== null && holder.exitCode === null && holder.signalCode === null) {
      try {
        holder.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
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

function assert(run) {
  const report = run.records.find((row) => row?.kind === 'filelease-holder-death-report')
  const target = join(run.ws, TARGET_NAME)
  const grant = report?.holderGrant ?? {}
  const conflict = report?.conflictBeforeDeath ?? {}
  const holder = conflict.conflicts?.[0]?.holder ?? {}
  const exit = report?.exit ?? {}
  const afterDeath = report?.acquireAfterDeath ?? {}
  const statusAfter = report?.statusAfter ?? {}
  const leasesAfter = (statusAfter.leases ?? []).map((lease) => ({
    path: lease?.path,
    id: lease?.owner?.id,
    session: lease?.owner?.session,
  }))
  const deadRow = leasesAfter.find((lease) => lease?.id === VICTIM.id || lease?.session === VICTIM.session) ?? null

  run.check(
    'a real product arbiter served the boot and the independent holder acquired the path',
    report?.bootWriteAppeared === true
      && report?.arbiter?.ok === true
      && report?.holderAcquired === true
      && typeof report?.holderPid === 'number'
      && (grant?.line?.granted ?? []).includes(report?.target),
    JSON.stringify({ bootWriteAppeared: report?.bootWriteAppeared, arbiter: report?.arbiter, holderGrant: grant, holderPid: report?.holderPid, driverError: report?.driverError }),
  )
  run.check(
    'while that process lived, a foreign acquire was refused with held naming its session and label',
    conflict.refused === true
      && conflict.code === 'held'
      && conflict.conflicts?.[0]?.path === target
      && holder.session === VICTIM.session
      && typeof holder.label === 'string' && holder.label.trim().length > 0,
    JSON.stringify(conflict),
  )
  run.check(
    'the holder process was really SIGKILLed (its own exit event reports the signal)',
    report?.killRequested === true && exit.timedOut === false && exit.signal === 'SIGKILL',
    JSON.stringify({ killRequested: report?.killRequested, exit }),
  )
  run.check(
    `the path became free within ${RELEASE_BUDGET_MS / 1000}s of the kill (connection close, not the TTL)`,
    typeof report?.releasedAfterMs === 'number' && report.releasedAfterMs <= RELEASE_BUDGET_MS && report?.statusWhenFree?.leases?.length === 0,
    JSON.stringify({ releasedAfterMs: report?.releasedAfterMs, statusWhenFree: report?.statusWhenFree }),
  )
  run.check(
    `the driver acquired the freed path within ${RELEASE_BUDGET_MS / 1000}s of the kill`,
    afterDeath.refused === false
      && (afterDeath.granted ?? []).includes(target)
      && typeof report?.acquireAfterMs === 'number' && report.acquireAfterMs <= RELEASE_BUDGET_MS,
    JSON.stringify({ afterDeath, acquireAfterMs: report?.acquireAfterMs, lastAcquireAttempt: report?.lastAcquireAttempt }),
  )
  run.check(
    'the final table contains no row owned by the dead process',
    statusAfter.ok === true
      && leasesAfter.length === 1
      && deadRow === null
      && leasesAfter[0]?.id === DRIVER.id
      && leasesAfter[0]?.session === DRIVER.session,
    JSON.stringify({ leasesAfter, deadRow }),
  )
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env, decide, observe, run, assert }
