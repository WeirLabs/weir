// The in-memory release-subscription coordinator behind `edit_lock_watch`.
//
// There is ONE coordinator per lease client (design D2/D4), not one per preset
// mount. Every mount of this bundle shares one client, so it must also share one
// view of "which session is waiting for which path": a per-mount registry would
// let two mounts subscribe the same `(session, path)` twice — two entries, two
// notices for one release — and would let one mount's teardown cancel a wait
// another mount still owns.
//
// The coordinator holds three collections and nothing else:
//
//   active           one entry per `(session, normalized path)`, in `watching`
//   pendingDelivery  consumed entries (`hit` / `reset`) whose notice has not
//                    been delivered yet, so disposal can still cancel them
//   mounts           the mount references that may deliver a notice
//
// The five states are a closed set:
//
//   watching   — registered, waiting for a release fact
//   hit        — a release fact consumed this subscription; it is over
//   reset      — the connection that could have delivered the fact is gone; it
//                is over, and NOTHING is claimed about ownership
//   self       — this session already owns the path (an authoritative read said
//                so, or a transfer settled); it is over, and there is nothing
//                left to wait for
//   cancelled  — the subscriber went away (agent disposal, unmount, or a read
//                that found the path free); it is over
//
// Consumption is one-way and happens in the event callback, BEFORE any notice is
// scheduled, so a duplicate or repeated release observation can never deliver a
// subscription twice. The notice itself is deferred by one turn of the event
// loop, because its caller is a socket callback and a message must never be
// injected from inside the transport's publish stack.
//
// Nothing here talks to a socket or a cordis context. A mount handle supplies
// the two things only the plugin knows: how to resolve the live agent for a
// session, and how to deliver a notice to it. Everything else — entries, the
// one shared status flight per entry, the pending-delivery window, the deferred
// timer — is decided here.

/** The closed subscription-state vocabulary. */
export const WATCH_STATES = Object.freeze(['watching', 'hit', 'reset', 'self', 'cancelled'])

/**
 * @typedef {'watching' | 'hit' | 'reset' | 'self' | 'cancelled'} WatchState
 */

/**
 * @typedef {object} WatchEntry
 * @property {string} sessionId the session that subscribed
 * @property {string} path normalized absolute path
 * @property {WatchState} state
 * @property {boolean} settledByTool true once a running tool already reported
 *   this episode to the model, so a deferred notice would only repeat it
 * @property {any} agent the agent that subscribed: delivery re-resolves the
 *   session and refuses to land on a replacement agent
 * @property {Promise<any> | null} statusFlight the ONE authoritative read this
 *   entry is currently sharing, so overlapping calls cannot disagree
 * @property {Set<WatchMount>} mounts the mount references that still want it
 * @property {ReturnType<typeof setTimeout> | null} timer the deferred notice
 */

/**
 * @typedef {object} WatchMount
 * @property {boolean} disposed set by the coordinator when the mount leaves
 * @property {(sessionId: string) => any} agentFor the live agent for a session
 * @property {(entry: WatchEntry, agent: any) => void} notify deliver one notice
 */

/**
 * @typedef {object} WatchProjection
 * @property {string} sessionId
 * @property {string} path
 * @property {WatchState} state
 * @property {boolean} settledByTool
 */

/**
 * Do not keep a finished process alive for a notice (design D4).
 * @param {ReturnType<typeof setTimeout>} timer
 */
function unrefTimer(timer) {
  const handle = /** @type {{ unref?: () => void }} */ (/** @type {unknown} */ (timer))
  if (typeof handle.unref === 'function') handle.unref()
}

/**
 * The coordinator surface: one factory is the single definition of what a
 * consumer holds, so the tool surface and the plugin row never re-describe it.
 * @typedef {ReturnType<typeof createWatchCoordinator>} WatchCoordinator
 */
export function createWatchCoordinator() {
  /** @type {Map<string, WatchEntry>} */
  const active = new Map()
  /** @type {Set<WatchEntry>} */
  const pendingDelivery = new Set()
  /** @type {Set<WatchMount>} */
  const mounts = new Set()

  /** @param {string} sessionId @param {string} path @returns {string} */
  function keyOf(sessionId, path) {
    return `${sessionId}\u0000${path}`
  }

  /**
   * The public shape of an entry. Internals (mounts, flight, timer, agent
   * identity) stay inside the coordinator.
   * @param {WatchEntry} entry
   * @returns {WatchProjection}
   */
  function project(entry) {
    return { sessionId: entry.sessionId, path: entry.path, state: entry.state, settledByTool: entry.settledByTool }
  }

  /**
   * The mount that may deliver one notice: the entry's own references first, so
   * the mount that registered the wait speaks for it, then any live mount of the
   * same client — a notice survives the unmount that created it (design D4).
   * @param {WatchEntry} entry
   * @returns {WatchMount | undefined}
   */
  function liveMount(entry) {
    for (const mount of entry.mounts) if (!mount.disposed) return mount
    for (const mount of mounts) if (!mount.disposed) return mount
    return undefined
  }

  /** @param {WatchEntry} entry */
  function cancelTimer(entry) {
    if (entry.timer === null) return
    clearTimeout(entry.timer)
    entry.timer = null
  }

  /**
   * Consume one entry and schedule its notice: it joins `pendingDelivery` first,
   * so a disposal between now and the timer still cancels it.
   *
   * The timer re-checks everything that could have ended the subscription in the
   * meantime — the terminal state, the mount references, and the live agent
   * identity — so a late notice can never revive one or land on a replacement
   * agent (design D4/D5).
   * @param {WatchEntry} entry
   */
  function scheduleNotice(entry) {
    pendingDelivery.add(entry)
    const timer = setTimeout(() => {
      entry.timer = null
      pendingDelivery.delete(entry)
      if (entry.state !== 'hit' && entry.state !== 'reset') return
      if (entry.settledByTool === true) return
      const mount = liveMount(entry)
      if (mount === undefined) return
      const agent = mount.agentFor(entry.sessionId)
      if (agent === undefined || agent === null) return
      if (entry.agent !== undefined && agent !== entry.agent) return
      try {
        mount.notify(entry, agent)
      } catch {
        // A notice is best effort: delivery must never break the transport.
      }
    }, 0)
    entry.timer = timer
    unrefTimer(timer)
  }

  /**
   * End a PENDING entry: its notice is over and its timer must not fire.
   * @param {WatchEntry} entry
   * @param {WatchState} state
   */
  function endPending(entry, state) {
    if (pendingDelivery.delete(entry)) cancelTimer(entry)
    entry.state = state
  }

  /**
   * Attach one mount reference. The first reference starts the subscription
   * lifetime of this coordinator; a later mount of the same client reuses the
   * same entries, flights and notices.
   * @param {WatchMount} mount
   */
  function join(mount) {
    mounts.add(mount)
  }

  /**
   * Drop one mount reference (unmount). A single mount leaving removes only its
   * own references: entries another mount still wants stay active, and a pending
   * notice transfers to a surviving reference. When the LAST mount leaves, the
   * whole coordinator — entries, pending notices, timers — is cleared so a later
   * mount starts with no inherited wait.
   * @param {WatchMount} mount
   */
  function leave(mount) {
    if (!mounts.delete(mount)) return
    mount.disposed = true
    for (const [key, entry] of [...active]) {
      if (!entry.mounts.delete(mount)) continue
      if (entry.mounts.size > 0) continue
      active.delete(key)
      entry.state = 'cancelled'
    }
    for (const entry of [...pendingDelivery]) entry.mounts.delete(mount)
    if (mounts.size === 0) clear()
  }

  /**
   * Find or create the single entry for one session and path. Repeating a
   * subscription is idempotent: the same entry comes back, so one release can
   * produce at most one notice however many times or from however many mounts
   * the subscription was requested.
   * @param {string} sessionId
   * @param {string} path
   * @param {WatchMount} [mount]
   * @param {any} [agent]
   * @returns {WatchEntry}
   */
  function register(sessionId, path, mount, agent) {
    const key = keyOf(sessionId, path)
    const known = active.get(key)
    if (known !== undefined) {
      if (mount !== undefined) known.mounts.add(mount)
      if (agent !== undefined && agent !== null) known.agent = agent
      return known
    }
    /** @type {WatchEntry} */
    const entry = {
      sessionId,
      path,
      state: 'watching',
      settledByTool: false,
      agent,
      statusFlight: null,
      mounts: new Set(),
      timer: null,
    }
    if (mount !== undefined) entry.mounts.add(mount)
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
   * One authoritative read per entry, shared by every overlapping caller
   * (design D2). Two calls for the same `(session, path)` must not run two
   * reads and then disagree about whether the entry is still active: they await
   * the same answer and apply the same terminal rules to the same object.
   * @param {WatchEntry} entry
   * @param {() => any} run the arbitration read
   * @returns {Promise<any>}
   */
  function shareStatus(entry, run) {
    if (entry.statusFlight !== null) return entry.statusFlight
    /** @type {Promise<any>} */
    const flight = Promise.resolve()
      .then(run)
      .finally(() => {
        if (entry.statusFlight === flight) entry.statusFlight = null
      })
    entry.statusFlight = flight
    return flight
  }

  /**
   * End one subscription because the caller no longer needs it. `expected`
   * makes the removal conditional on the SAME entry object still being active:
   * a late caller can then never cancel a newer episode, and can never report
   * `watching` for an entry it no longer owns.
   * @param {string} sessionId
   * @param {string} path
   * @param {WatchEntry} [expected]
   * @param {WatchState} [state]
   * @returns {WatchEntry | undefined}
   */
  function cancel(sessionId, path, expected, state = 'cancelled') {
    const key = keyOf(sessionId, path)
    const entry = active.get(key)
    if (entry === undefined) return undefined
    if (expected !== undefined && entry !== expected) return undefined
    active.delete(key)
    if (pendingDelivery.delete(entry)) cancelTimer(entry)
    entry.state = state
    return entry
  }

  /**
   * This session acquired the path by another route (a transfer settled as
   * `transferred`). The wait is over because its goal was reached, and any
   * notice already consumed for that path is moot: waking the session would
   * only make it compete with itself (design D4).
   * @param {string} sessionId
   * @param {string} path
   * @returns {WatchEntry | undefined}
   */
  function settleSelf(sessionId, path) {
    /** @type {WatchEntry | undefined} */
    let ended
    for (const entry of [...pendingDelivery]) {
      if (entry.sessionId !== sessionId || entry.path !== path) continue
      endPending(entry, 'self')
      ended = ended ?? entry
    }
    const key = keyOf(sessionId, path)
    const activeEntry = active.get(key)
    if (activeEntry !== undefined) {
      active.delete(key)
      activeEntry.state = 'self'
      ended = ended ?? activeEntry
    }
    return ended
  }

  /**
   * Consume every subscription for one path (the release fact carries no
   * session, and one path may be watched by several sessions of this client).
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
      scheduleNotice(entry)
      consumed.push(entry)
    }
    return consumed
  }

  /**
   * The connection that could have delivered a release is gone. Every active
   * subscription becomes `reset` — a terminal state that says nothing about
   * ownership — and is scheduled for the re-check notice.
   * @returns {WatchEntry[]}
   */
  function resetAll() {
    const entries = [...active.values()]
    active.clear()
    for (const entry of entries) {
      entry.state = 'reset'
      scheduleNotice(entry)
    }
    return entries
  }

  /**
   * End every subscription of one session — active waits AND consumed entries
   * whose notice has not been delivered yet (agent disposal, design D4).
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
    for (const entry of [...pendingDelivery]) {
      if (entry.sessionId !== sessionId) continue
      endPending(entry, 'cancelled')
      cancelled.push(entry)
    }
    return cancelled
  }

  /**
   * End everything: no entry can be revived afterwards, and no scheduled notice
   * survives. Called when the last mount of the client leaves.
   * @returns {WatchEntry[]}
   */
  function clear() {
    /** @type {WatchEntry[]} */
    const entries = [...active.values(), ...pendingDelivery]
    active.clear()
    for (const entry of [...pendingDelivery]) cancelTimer(entry)
    pendingDelivery.clear()
    for (const entry of entries) entry.state = 'cancelled'
    return entries
  }

  /** @returns {number} how many subscriptions are still active */
  function size() {
    return active.size
  }

  /** @returns {number} how many consumed notices are still undelivered */
  function pendingSize() {
    return pendingDelivery.size
  }

  /** @returns {number} how many mount references are attached */
  function mountCount() {
    return mounts.size
  }

  /** @returns {WatchProjection[]} the active entries, as copies */
  function entries() {
    return [...active.values()].map(project)
  }

  /** @returns {WatchProjection[]} the pending notices, as copies */
  function pendingEntries() {
    return [...pendingDelivery].map(project)
  }

  return Object.freeze({
    join,
    leave,
    register,
    peek,
    shareStatus,
    cancel,
    settleSelf,
    consumePath,
    resetAll,
    cancelSession,
    clear,
    size,
    pendingSize,
    mountCount,
    entries,
    pendingEntries,
  })
}
