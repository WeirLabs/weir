// Lane state watches (worktree_watch): the pure registry logic behind lane
// subscriptions. A watch is one-shot — it delivers once (state hit OR expiry)
// and is then gone — and lives in the ledger's top-level `watches` array so
// every mutation here is just an array transform the caller runs inside the
// ledger lock. Pure module (no ctx, no node: imports).
import { WORKTREE_CODES, WorktreeError } from './errors.js'
import { WATCHABLE } from './state.js'

/** Default watch lifetime in minutes (design decision 7); the settings key
 * worktreeWatchTimeoutMinutes overrides it, floored at one minute. */
export const DEFAULT_WATCH_TIMEOUT_MINUTES = 360

/**
 * Resolve the configured watch timeout in minutes: a finite number >= 1
 * (floored), otherwise the default. Used by the service for every subscribe,
 * so an online settings edit applies to the NEXT watch only.
 * @param {any} settings - the worktree settings object (may lack the key)
 * @returns {number}
 */
export function watchTimeoutMinutesOf(settings) {
  const value = Number(settings?.watchTimeoutMinutes)
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_WATCH_TIMEOUT_MINUTES
}

/**
 * Validate and normalize the target-state list of a new watch: at least one
 * state, every one a conclusion state (WATCHABLE), duplicates removed. An
 * empty list or any transient/unknown state refuses with UNWATCHABLE_STATE
 * and no watch is created.
 * @param {any} states
 * @returns {string[]}
 */
export function normalizeWatchStates(states) {
  const list = Array.isArray(states) ? [...new Set(states)] : []
  const invalid = list.filter((state) => typeof state !== 'string' || !WATCHABLE.includes(state))
  if (list.length === 0 || invalid.length > 0) {
    throw new WorktreeError(
      WORKTREE_CODES.UNWATCHABLE_STATE,
      invalid.length > 0
        ? `cannot watch ${invalid.map((state) => JSON.stringify(state)).join(', ')}: only conclusion states are watchable (transient states — preparing, working, checking, awaiting-approval — always resolve on their own)`
        : 'states must name at least one conclusion state',
      { data: { watchable: [...WATCHABLE] } },
    )
  }
  return /** @type {string[]} */ (list)
}

/**
 * Build the watch record for one subscribe call. `expiresAt` is frozen at
 * subscribe time from the CURRENT timeout setting; editing the setting later
 * does not move this watch's deadline.
 * @param {{ id: string, laneId: string, sessionId: string, states: string[], now: number, timeoutMinutes: number }} input
 * @returns {{ id: string, laneId: string, sessionId: string, states: string[], createdAt: number, expiresAt: number }}
 */
export function createWatch({ id, laneId, sessionId, states, now, timeoutMinutes }) {
  return { id, laneId, sessionId, states, createdAt: now, expiresAt: now + timeoutMinutes * 60_000 }
}

/**
 * Insert a watch into the ledger's watches array, replacing any existing
 * watch of the same (sessionId, laneId) — one active watch per subscriber per
 * lane, the newest wins. Mutates the (locked, deep-copied) ledger.
 * @param {{ watches: any[] }} ledger
 * @param {any} entry
 * @returns {any | null} the replaced watch, if any
 */
export function upsertWatch(ledger, entry) {
  let replaced = null
  const kept = []
  for (const watch of ledger.watches ?? []) {
    if (watch.sessionId === entry.sessionId && watch.laneId === entry.laneId) replaced = watch
    else kept.push(watch)
  }
  kept.push(entry)
  ledger.watches = kept
  return replaced
}

/**
 * One-shot hit scan after a lane transition: remove every watch whose lane
 * just entered one of its target states and return the removed watches. Runs
 * inside the same ledger write as the transition itself, so a hit can never
 * be collected twice (a concurrent instance sees the watches already gone).
 * @param {{ watches: any[] }} ledger
 * @param {{ id: string, state: string }} lane - the lane AFTER its transition
 * @returns {any[]} the watches this transition consumed
 */
export function collectWatchHits(ledger, lane) {
  const hits = []
  const kept = []
  for (const watch of ledger.watches ?? []) {
    if (watch.laneId === lane.id && watch.states.includes(lane.state)) hits.push(watch)
    else kept.push(watch)
  }
  if (hits.length > 0) ledger.watches = kept
  return hits
}

/**
 * Partition watches into live/expired at `at`, removing the expired ones from
 * the ledger (restart pruning: silent, audited by the caller, never delivered).
 * @param {{ watches: any[] }} ledger
 * @param {number} at
 * @returns {any[]} the expired watches removed
 */
export function pruneExpiredWatches(ledger, at) {
  const expired = []
  const kept = []
  for (const watch of ledger.watches ?? []) {
    if (watch.expiresAt <= at) expired.push(watch)
    else kept.push(watch)
  }
  if (expired.length > 0) ledger.watches = kept
  return expired
}

/**
 * Remove one watch by id when its expiry timer fires. The lock arbitrates
 * between service instances: only the instance that actually removes the
 * record delivers the expiry notice; everybody else sees it already gone.
 * @param {{ watches: any[] }} ledger
 * @param {string} watchId
 * @param {number} at - re-checked inside the lock (a replaced watch is a new record)
 * @returns {any | null} the removed watch, or null when there was nothing to do
 */
export function removeWatchForExpiry(ledger, watchId, at) {
  const index = (ledger.watches ?? []).findIndex((watch) => watch.id === watchId)
  if (index === -1) return null
  const watch = ledger.watches[index]
  if (watch.expiresAt > at) return null
  ledger.watches.splice(index, 1)
  return watch
}

/**
 * Per-lane watch facts for the board and the view endpoint.
 * @param {any[] | undefined} watches
 * @param {string} laneId
 * @returns {{ watchCount: number, watchStates: string[] }}
 */
export function watchFacts(watches, laneId) {
  const states = []
  let count = 0
  for (const watch of watches ?? []) {
    if (watch.laneId !== laneId) continue
    count += 1
    for (const state of watch.states) if (!states.includes(state)) states.push(state)
  }
  return { watchCount: count, watchStates: states }
}
