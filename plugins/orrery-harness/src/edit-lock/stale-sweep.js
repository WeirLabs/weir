// Message-triggered stale-lock sweep: the missing-target classifier and the
// per-domain detached scheduler. Plain ESM, no ctx, no @deepseek-ai imports;
// the scheduler's job, clock and timer are injected so the composition and
// the unit tests share one core.
import { lstatSync } from 'node:fs'

/** Missing-target classification for one stored canonical resource id. ONLY
 * ENOENT counts: a successful lstat — including of a dangling symlink — is
 * not missing, and any other error (EACCES, ENOTDIR, symlink loops) skips the
 * row. Never follows a moved file, never resolves aliases into a replacement
 * identity, never fabricates a resource key for a missing path.
 * @param {string} resourceId */
export function isMissingTarget(resourceId) {
  if (typeof resourceId !== 'string' || resourceId.length === 0) return false
  try {
    lstatSync(resourceId)
    return false
  } catch (error) {
    return /** @type {any} */ (error)?.code === 'ENOENT'
  }
}

/** Cooldown between two sweeps of one management domain. */
export const STALE_SWEEP_COOLDOWN_MS = 60_000

/** Per-key detached sweep scheduler. At most one in-flight sweep and one
 * cooldown window per key (the management-domain ROOT, not a session), so
 * message volume across sessions never scales the aggregate scan cost. Idle
 * entries whose cooldown window expired are RECLAIMED — on each trigger pass
 * and when a job completes — and close() empties the registry, so the map
 * never grows unboundedly with the number of domains a process has touched.
 *
 * Dispatch happens on a zero-delay timer and is NEVER awaited by the caller:
 * the turn proceeds immediately (unlike auto-resume, which must precede the
 * first step). close() cancels undispatched work; an already-running job
 * always settles on its own — an already-submitted authority transaction is
 * never cancelled or reinterpreted. A failed job warns once through the
 * injected sink and still opens the cooldown window.
 * @param {{cooldownMs?: number, now?: () => number,
 *   setTimer?: (fn: () => void) => unknown, clearTimer?: (handle: unknown) => void,
 *   warn?: (message: string) => void}} [options] */
export function createStaleSweepScheduler({ cooldownMs = STALE_SWEEP_COOLDOWN_MS, now = () => Date.now(), setTimer, clearTimer, warn = () => {} } = {}) {
  const arm = setTimer ?? ((fn) => globalThis.setTimeout(fn, 0))
  const disarm = clearTimer ?? ((handle) => globalThis.clearTimeout(handle))
  /** @type {Map<string, {inFlight: Promise<unknown> | null, coolingUntil: number, handle: unknown}>} */
  const entries = new Map()
  let closed = false
  /** Reclaim entries that are neither dispatched nor in flight and whose
   * cooldown window expired. @param {unknown} [except] */
  function prune(except = undefined) {
    const at = now()
    for (const [key, entry] of entries) {
      if (entry === except) continue
      if (entry.inFlight === null && entry.handle === null && at >= entry.coolingUntil) entries.delete(key)
    }
  }
  return Object.freeze({
    /** Arm one sweep for key. Returns false when the key is closed, one is
     * already dispatched or in flight, or the cooldown window is still open.
     * @param {string} key @param {() => unknown} job */
    trigger(key, job) {
      if (closed || typeof key !== 'string' || key.length === 0 || typeof job !== 'function') return false
      prune()
      let entry = entries.get(key)
      if (!entry) {
        entry = { inFlight: null, coolingUntil: 0, handle: null }
        entries.set(key, entry)
      }
      if (entry.inFlight !== null || entry.handle !== null || now() < entry.coolingUntil) return false
      entry.handle = arm(() => {
        entry.handle = null
        if (closed) return
        const pending = Promise.resolve()
          .then(job)
          .then(
            () => {},
            (error) => warn(`edit lock stale sweep failed: ${/** @type {any} */ (error)?.message ?? error}`),
          )
          .then(() => {
            entry.inFlight = null
            entry.coolingUntil = now() + cooldownMs
            // Completion is the other reclamation point: peers whose windows
            // lapsed while this job ran are dropped here.
            prune(entry)
          })
        entry.inFlight = pending
      })
      return true
    },
    /** Entry count, for diagnostics and tests. */
    get size() { return entries.size },
    /** Cancel every undispatched sweep and forget every key. In-flight jobs
     * settle untouched. */
    close() {
      closed = true
      for (const entry of entries.values()) {
        if (entry.handle !== null) disarm(entry.handle)
        entry.handle = null
      }
      entries.clear()
    },
  })
}
