// The in-memory release-subscription registry behind `edit_lock_watch`.
//
// Pure state machine: no timers, no sockets, no ctx, no DSH imports. It holds
// ONE kind of state — "this session is waiting for the next release of this
// normalized path" — and it exists only for as long as the mount that built it,
// so a broker restart, a process exit or an unmount takes every subscription
// with it. Nothing here is persisted and nothing is repaired afterwards.
//
// Why the registry is client-side (design D1/D2): the broker only broadcasts a
// release FACT and never remembers who wanted it. That keeps the arbiter a
// two-state table (held / free) with no queue, no reservation and no second
// notion of ownership — a subscription creates an opportunity to compete, never
// a claim.
//
// The four states are a closed set:
//
//   watching   — registered, authoritative status still says someone else holds
//   hit        — a release fact consumed this subscription; it is over
//   reset      — the connection that could have delivered the fact is gone; it
//                is over, and NOTHING is claimed about ownership
//   cancelled  — the subscriber went away (agent disposal, unmount, transfer,
//                or the tool decided no subscription is needed); it is over
//
// Consumption is one-way and happens in the event callback, BEFORE any notice is
// scheduled, so a duplicate or repeated release observation can never deliver a
// subscription twice.

/** The closed subscription-state vocabulary. */
export const WATCH_STATES = Object.freeze(['watching', 'hit', 'reset', 'cancelled'])

/**
 * @typedef {object} WatchEntry
 * @property {string} sessionId the session that subscribed
 * @property {string} path normalized absolute path
 * @property {'watching' | 'hit' | 'reset' | 'cancelled'} state
 * @property {boolean} settledByTool true once a running tool already reported
 *   this episode to the model, so a deferred notice would only repeat it
 */

/**
 * One registry per mount. Multiple mounts of this bundle share ONE client (and
 * therefore hear every broadcast), so the registry is also the routing fact:
 * only the mount that created an entry can consume it.
 */
export function createWatchRegistry() {
  /** @type {Map<string, WatchEntry>} */
  const active = new Map()

  /**
   * @param {string} sessionId
   * @param {string} path
   * @returns {string}
   */
  function keyOf(sessionId, path) {
    return `${sessionId}\u0000${path}`
  }

  /**
   * Find or create the single entry for one session and path. Repeating a
   * subscription is idempotent: the same entry comes back, so one release can
   * produce at most one notice.
   * @param {string} sessionId
   * @param {string} path
   * @returns {WatchEntry}
   */
  function register(sessionId, path) {
    const key = keyOf(sessionId, path)
    const known = active.get(key)
    if (known !== undefined) return known
    /** @type {WatchEntry} */
    const entry = { sessionId, path, state: 'watching', settledByTool: false }
    active.set(key, entry)
    return entry
  }

  /**
   * @param {string} sessionId
   * @param {string} path
   * @returns {WatchEntry | undefined}
   */
  function peek(sessionId, path) {
    return active.get(keyOf(sessionId, path))
  }

  /**
   * End one subscription without a release: the caller no longer needs it.
   * @param {string} sessionId
   * @param {string} path
   * @returns {WatchEntry | undefined}
   */
  function cancel(sessionId, path) {
    const key = keyOf(sessionId, path)
    const entry = active.get(key)
    if (entry === undefined) return undefined
    active.delete(key)
    entry.state = 'cancelled'
    return entry
  }

  /**
   * Consume every subscription for one path (the release fact carries no
   * session, and one path may be watched by several sessions of this mount).
   * Each returned entry is already in `hit` and out of the active map, so a
   * second observation of the same release finds nothing.
   * @param {string} path
   * @returns {WatchEntry[]}
   */
  function consumePath(path) {
    /** @type {WatchEntry[]} */
    const consumed = []
    for (const [key, entry] of [...active]) {
      if (entry.path !== path) continue
      active.delete(key)
      entry.state = 'hit'
      consumed.push(entry)
    }
    return consumed
  }

  /**
   * The connection that could have delivered a release is gone. Every active
   * subscription becomes `reset` (a terminal state that says nothing about
   * ownership) and is returned so the caller can tell each subscriber to
   * re-check and subscribe again.
   * @returns {WatchEntry[]}
   */
  function resetAll() {
    const entries = [...active.values()]
    active.clear()
    for (const entry of entries) entry.state = 'reset'
    return entries
  }

  /**
   * End every active subscription of one session (agent disposal).
   * @param {string} sessionId
   * @returns {WatchEntry[]}
   */
  function cancelSession(sessionId) {
    /** @type {WatchEntry[]} */
    const cancelled = []
    for (const [key, entry] of [...active]) {
      if (entry.sessionId !== sessionId) continue
      active.delete(key)
      entry.state = 'cancelled'
      cancelled.push(entry)
    }
    return cancelled
  }

  /**
   * End everything (mount unmount). No entry can be revived afterwards: the
   * deferred notice checks the state and the subscriber's liveness again.
   * @returns {WatchEntry[]}
   */
  function clear() {
    const entries = [...active.values()]
    active.clear()
    for (const entry of entries) entry.state = 'cancelled'
    return entries
  }

  /** @returns {number} how many subscriptions are still active */
  function size() {
    return active.size
  }

  /** @returns {WatchEntry[]} the active entries, as copies */
  function entries() {
    return [...active.values()].map((entry) => ({ ...entry }))
  }

  return Object.freeze({ register, peek, cancel, consumePath, resetAll, cancelSession, clear, size, entries })
}
