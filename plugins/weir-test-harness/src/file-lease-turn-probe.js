// In-process turn-boundary lease probe for the filelease-* integration
// scenarios (edit-lock-rebuild tasks 5.2 / 5.5 / 5.6).
//
// WHY THIS PLUGIN EXISTS
// A headless integration boot is one process, so a snapshot taken by the DRIVER
// after the boot exits cannot distinguish "the turn ended and released the
// claim" from "the process died and the broker dropped the connection" — the
// broker releases a connection's leases on disconnect (design D10). The only
// honest evidence for turn-end semantics is an observation made INSIDE the
// session process, between `turn/end` and process teardown. That is this probe:
// it subscribes to the durable `turn/end` event, reads the arbiter's table over
// its own protocol connection, and writes what it saw to
// `WEIR_IT_LEASE_SNAPSHOT` for the scenario to assert on.
//
// HOW IT READS
// The probe is a reader, never an owner: `hello` + `status` only (it never
// acquires, releases or negotiates), and it imports nothing from the product.
// The connection is opened eagerly at mount and retried in the background,
// because the ordering at `turn/end` is the whole point: the product's release
// frame is written synchronously by its own listener, and this probe's status
// frame must follow it on an ALREADY-LIVE connection. A lazy dial there would
// race the release (and the teardown) and could report the wrong world.
//
// WHAT IT WRITES
// One snapshot file, re-written after every reading so a process that exits
// mid-window still leaves the latest observation behind:
//
//   {
//     kind: 'file-lease-turn-probe', version: 1, socket,
//     runs: [{
//       trigger: 'session/event:turn/end' | 'turn/end' | 'agent/disposed',
//       at, session, cwd,
//       readings: [{ at, elapsedMs, ok, leases: [...], error }],
//     }],
//   }
//
// Reading offsets are bounded (the window below), and a reading that finds the
// table empty ends the window early. A retained lease keeps the window open
// until its last offset: retention is exactly the case where "still held" is
// the expected answer and the extra readings show it surviving turn end.
//
// Enabled per boot by `WEIR_IT_LEASE_PROBE=1` (the patch row gates on it) and
// inert otherwise, like every other probe in this package.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { connectLeaseBroker } from './lease-probe.js'

const name = 'weir-it-file-lease-turn-probe'

/** The snapshot format this plugin writes. */
const SNAPSHOT_VERSION = 1

/** Offsets (ms from the turn boundary) at which the table is read. */
const READINGS_MS = [0, 60, 200, 500]

/** Grace added to the keep-alive timer past the last reading. */
const KEEP_ALIVE_SLACK_MS = 400

/** Background reconnect cadence while the daemon does not exist yet. */
const CONNECT_RETRY_MS = 150

/** How long the background connect keeps retrying after mount (boot budget). */
const CONNECT_BUDGET_MS = 120_000

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms)
    // A retry wait must never be the thing that keeps the process alive.
    timer.unref?.()
  })
}

/** @param {unknown} value @returns {string | null} */
function textOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * @param {any} session live session object (durable header preferred)
 * @returns {{ id: string | null, cwd: string | null }}
 */
function sessionFacts(session) {
  return {
    id: textOf(session?.header?.id) ?? textOf(session?.id) ?? null,
    cwd: textOf(session?.header?.cwd) ?? null,
  }
}

/**
 * @param {any} ctx @param {{ enabled?: boolean }} [config]
 * @returns {(() => void) | undefined} disposer (listeners only; see below)
 */
function apply(ctx, config = {}) {
  // Composition seam: with the row switched off this mount does nothing at all.
  if (config?.enabled !== true) return undefined
  const snapshotTarget = textOf(process.env.WEIR_IT_LEASE_SNAPSHOT)
  const socketPath = textOf(process.env.WEIR_EDITLOCKD_SOCKET)
  // Both are scenario-supplied: without them there is nothing to observe.
  if (snapshotTarget === null || socketPath === null) return undefined

  let disposed = false
  let busy = false
  /** @type {any} */
  let client = connectLeaseBroker(socketPath, { timeoutMs: 1_500 })
  /** @type {any} */
  const snapshot = {
    kind: 'file-lease-turn-probe',
    version: SNAPSHOT_VERSION,
    socket: socketPath,
    probe: name,
    runs: [],
  }
  /** @type {string | null} */
  let snapshotPath = null

  /** @param {any} session */
  function pathFor(session) {
    if (snapshotPath !== null) return snapshotPath
    // The session workspace is the natural base: the env value is a bare file
    // name and the driver looks for it under the same ws root.
    const base = textOf(session?.header?.cwd) ?? process.cwd()
    snapshotPath = isAbsolute(snapshotTarget) ? snapshotTarget : resolve(base, snapshotTarget)
    return snapshotPath
  }

  /** @param {string} path */
  function persist(path) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n')
    } catch {
      // A probe must never be able to break the turn it observes.
    }
  }

  /** Keep a live connection ready for the moment the turn ends. */
  async function maintainConnection(deadline) {
    while (!disposed && Date.now() < deadline) {
      if (client.connected()) return true
      try {
        await client.open()
        return true
      } catch {
        await sleep(CONNECT_RETRY_MS)
      }
    }
    return client.connected()
  }

  /** @param {unknown} error */
  function errorFacts(error) {
    return {
      code: textOf(/** @type {any} */ (error)?.code) ?? 'transport',
      message: String(/** @type {any} */ (error)?.message ?? error),
    }
  }

  /**
   * Read the arbiter's whole table at the fixed offsets from the boundary,
   * persisting after every reading.
   * @param {string} trigger
   * @param {any} session
   */
  async function observe(trigger, session) {
    // Both the host event and the durable event report one boundary; a single
    // observation answers both. The window is short, so a genuine second turn
    // never falls inside it.
    if (busy || disposed) return
    busy = true
    const startedAt = Date.now()
    const target = pathFor(session)
    const facts = sessionFacts(session)
    const run = {
      trigger,
      at: new Date(startedAt).toISOString(),
      session: facts.id,
      cwd: facts.cwd,
      readings: [],
    }
    snapshot.runs.push(run)
    // Bounded keep-alive: the runtime may let the event loop drain after the
    // turn, and the readings must still be written before the process is gone.
    const keepAlive = setTimeout(() => {}, READINGS_MS[READINGS_MS.length - 1] + KEEP_ALIVE_SLACK_MS)
    try {
      await maintainConnection(startedAt + 1_000)
      for (const offset of READINGS_MS) {
        const wait = startedAt + offset - Date.now()
        if (wait > 0) await sleep(wait)
        const at = Date.now()
        try {
          const reply = await client.status({})
          const ok = reply?.ok === true
          const leases = ok && Array.isArray(reply.leases) ? reply.leases : []
          run.readings.push({ at, elapsedMs: at - startedAt, ok, leases, error: ok ? null : reply?.error ?? null })
          persist(target)
          if (ok && leases.length === 0) break
        } catch (error) {
          run.readings.push({ at, elapsedMs: at - startedAt, ok: false, leases: [], error: errorFacts(error) })
          persist(target)
          // The daemon may have restarted (or died): a fresh connection is the
          // only way the remaining readings can say anything.
          try {
            client.close()
          } catch {
            // Already gone.
          }
          client = connectLeaseBroker(socketPath, { timeoutMs: 1_500 })
          void maintainConnection(Date.now() + 800)
        }
      }
    } finally {
      clearTimeout(keepAlive)
      busy = false
    }
  }

  /** @param {unknown} payload */
  const onTurnEnd = (payload) => {
    const agent = /** @type {any} */ (payload)?.agent
    void observe('turn/end', agent?.session ?? null)
  }
  /** @param {any} session @param {any} event */
  const onSessionEvent = (session, event) => {
    if (event?.type !== 'turn/end') return
    void observe('session/event:turn/end', session)
  }
  /** @param {unknown} payload */
  const onDisposed = (payload) => {
    const agent = /** @type {any} */ (payload)?.agent
    void observe('agent/disposed', agent?.session ?? null)
  }

  /** @type {(() => void)[]} */
  const offs = []
  for (const [event, handler] of [
    ['turn/end', onTurnEnd],
    ['session/event', onSessionEvent],
    ['agent/disposed', onDisposed],
  ]) {
    const off = ctx.on?.(event, handler)
    if (typeof off === 'function') offs.push(off)
  }

  // Start looking for the arbiter now, not at turn end: the daemon is spawned
  // by the first managed write, so the background retry is what turns the later
  // status frame into a synchronous write on a live socket.
  void maintainConnection(Date.now() + CONNECT_BUDGET_MS)

  return () => {
    disposed = true
    for (const off of offs.splice(0)) {
      try {
        off()
      } catch {
        // Already gone.
      }
    }
    // The connection is deliberately NOT closed here: teardown may unmount this
    // row while a boundary observation is still awaiting its reply, and that
    // observation is the one fact the run exists to capture. The socket is
    // unref'd, so it cannot keep the process alive on its own.
  }
}

export { name, apply }
