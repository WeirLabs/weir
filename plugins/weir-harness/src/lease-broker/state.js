// In-memory arbitration kernel behind `weir-editlockd`.
//
// Pure state machine: no IO, no timers, no real clock (the clock is injected),
// no DSH/cordis/@deepseek-ai imports. Everything the kernel knows lives in two
// maps and is thrown away when the process dies — that is the whole point of
// the design (design D6): `kill` equals "every lease expired at once", and no
// question about who owns what survives the process.
//
// Two states only (design D3): a path is `held` by exactly one connection, or
// it is free. A transfer request is a mailbox entry with a bounded window, not
// a third ownership state.
//
// Multiplicity rules that are easy to get wrong and are therefore stated once
// here and enforced in one place:
//
// - Identity is `owner.id` (the client's lineage). `session` and `label` are
//   display/delivery hints and may change; an acquisition from the SAME
//   `owner.id` on the SAME connection is the same owner, so it adopts and
//   refreshes instead of conflicting. The same `owner.id` through a DIFFERENT
//   connection is a different owner for arbitration purposes (spec: "Same
//   owner identifier from another connection").
// - Validity is `max(expiresAt, holdUntil ?? 0)`. Once `now() >=` that instant
//   the path is free for anyone, without negotiation and without notification
//   unless a session explicitly subscribed on its own side.
// - Removal has exactly one outlet (`removeLease`): the row is deleted first and
//   then the fact is announced as `released` to every connected client. Explicit
//   release, holder disconnect, and expiry observed by
//   acquire/status/request/reply/hold/sweep all pass through it, so a lapsed row
//   can never be silently overwritten by a new grant. An atomic transfer never
//   comes through it because the path never becomes unowned.
// - `release` judges identity only (a lapsed row still belongs to its owner, so
//   releasing it is `released`, keeping the call idempotent), while `hold`
//   additionally requires the row to still be valid — you cannot extend
//   ownership that already lapsed, you must acquire again first.

/**
 * @typedef {{ id: string, session: string, label: string }} Owner
 * @typedef {{ path: string, connectionId: string, owner: Owner, scope: string, acquiredAt: number, expiresAt: number, holdUntil: number | null }} Lease
 * @typedef {{ path: string, holder: Owner, expiresAt: number, holdUntil: number | null }} Conflict
 * @typedef {{ path: string, owner: Owner, scope: string, acquiredAt: number, expiresAt: number, holdUntil: number | null }} LeaseView
 * @typedef {{ requestId: string, path: string, from: Owner, connectionId: string, holderConnectionId: string, holderId: string, expiresAt: number }} PendingRequest
 * @typedef {{ event: 'request', requestId: string, path: string, from: Owner, expiresAt: number }} RequestEvent
 * @typedef {{ event: 'settled', requestId: string, path: string, state: 'transferred' | 'declined' | 'expired' }} SettledEvent
 * @typedef {{ event: 'released', path: string, reason: 'released' | 'disconnected' | 'expired' }} ReleasedEvent
 * @typedef {{ connectionId: string, owner: Owner, scope: string, paths: string[], ttlMs?: number }} AcquireInput
 * @typedef {{ connectionId: string, owner: Owner, paths: string[] }} ReleaseInput
 * @typedef {{ connectionId: string, owner: Owner, paths: string[], minutes: number }} HoldInput
 * @typedef {{ connectionId: string, from: Owner, path: string }} RequestInput
 * @typedef {{ connectionId: string, owner: Owner, requestId: string, decision: 'release' | 'keep' }} ReplyInput
 * @typedef {{ scope?: string, session?: string, path?: string }} StatusFilter
 * @typedef {{ ok: true, granted: LeaseView[] } | { ok: false, code: 'held', conflicts: Conflict[] }} AcquireResult
 * @typedef {{ ok: true, released: string[], notOwned: string[] }} ReleaseResult
 * @typedef {{ ok: true, held: { path: string, expiresAt: number, holdUntil: number | null }[] } | { ok: false, code: 'limit', maxMinutes: number } | { ok: false, code: 'not-owned', paths: string[] } | { ok: false, code: 'bad-request' }} HoldResult
 * @typedef {{ ok: true, leases: LeaseView[] }} StatusResult
 * @typedef {{ ok: true, state: 'pending', requestId: string, holder: Owner, expiresAt: number } | { ok: false, code: 'free' | 'self' }} RequestResult
 * @typedef {{ ok: true, state: 'transferred' | 'declined' } | { ok: false, code: 'expired' | 'stale' | 'not-holder' }} ReplyResult
 */

/**
 * @param {Lease} lease
 * @returns {LeaseView}
 */
function view(lease) {
  return {
    path: lease.path,
    owner: { ...lease.owner },
    scope: lease.scope,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    holdUntil: lease.holdUntil,
  }
}

/**
 * Create one arbitration kernel.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] injected clock (epoch ms)
 * @param {number} [options.ttlMs] default lease time-to-live
 * @param {number} [options.requestWindowMs] bounded negotiation window
 * @param {number} [options.holdMaxMinutes] retention bound in minutes
 * @param {(connectionId: string, event: RequestEvent | SettledEvent | ReleasedEvent) => void} [options.onEvent] event sink; a missing connection or a throwing sink never affects arbitration
 */
export function createBroker({
  now = Date.now,
  ttlMs = 120_000,
  requestWindowMs = 120_000,
  holdMaxMinutes = 60,
  onEvent = () => {},
} = {}) {
  /** @type {Map<string, Lease>} */
  const leases = new Map()
  /** @type {Map<string, PendingRequest>} */
  const pending = new Map()
  /** @type {Map<string, string>} requester+path → requestId, at most one per pair */
  const pendingKeys = new Map()
  /** @type {Set<string>} */
  const connections = new Set()
  let requestSeq = 0

  /** @param {Lease} lease */
  function validUntil(lease) {
    return Math.max(lease.expiresAt, lease.holdUntil ?? 0)
  }

  /** @param {Lease} lease */
  function isValid(lease) {
    return now() < validUntil(lease)
  }

  /** @param {string} path @param {string} fromId */
  function requestKey(path, fromId) {
    return `${fromId}\u0000${path}`
  }

  /** Drop a mailbox entry and its (requester, path) index slot. @param {string} requestId */
  function dropRequest(requestId) {
    const record = pending.get(requestId)
    if (!record) return
    pending.delete(requestId)
    const key = requestKey(record.path, record.from.id)
    if (pendingKeys.get(key) === requestId) pendingKeys.delete(key)
  }

  /**
   * Deliver one event. Delivery is best effort by contract: an unknown
   * connection is a silent drop and a throwing sink cannot break arbitration.
   * @param {string} connectionId
   * @param {RequestEvent | SettledEvent | ReleasedEvent} event
   */
  function deliver(connectionId, event) {
    if (!connections.has(connectionId)) return
    try {
      onEvent(connectionId, event)
    } catch {
      // The sink is a transport; it must never be able to corrupt the table.
    }
  }

  /**
   * The ONE removal outlet for a lease row.
   *
   * The row is deleted before anything is announced, so a later observation of
   * the same lapsed record finds nothing to announce (no duplicate), and every
   * receiver sees the path as unowned at the moment it hears about it. Delivery
   * is a best-effort fact to every currently connected client: a missing or
   * disconnected recipient is skipped, one throwing sink cannot affect the
   * others, and the verdict that caused the removal is already decided.
   *
   * @param {string} path
   * @param {'released' | 'disconnected' | 'expired'} reason
   * @returns {boolean} whether a row was removed
   */
  function removeLease(path, reason) {
    if (!leases.delete(path)) return false
    for (const connectionId of [...connections]) {
      deliver(connectionId, { event: 'released', path, reason })
    }
    return true
  }

  /**
   * Announce the end of a request to the requester.
   * @param {PendingRequest} record
   * @param {'transferred' | 'declined' | 'expired'} state
   */
  function settle(record, state) {
    deliver(record.connectionId, { event: 'settled', requestId: record.requestId, path: record.path, state })
  }

  /** @param {string[]} paths */
  function normalize(paths) {
    return [...new Set(paths)].sort()
  }

  /** Register a connection. @param {string} connectionId */
  function connect(connectionId) {
    connections.add(connectionId)
  }

  /**
   * Forget a connection: every lease it holds is released immediately (no
   * expiry wait), and every mailbox entry it takes part in is dropped. A
   * request whose holder went away settles as `expired` for a requester that is
   * still connected; a request owned by the departing connection simply dies
   * with it.
   * @param {string} connectionId
   */
  function disconnect(connectionId) {
    connections.delete(connectionId)
    for (const [path, lease] of [...leases]) {
      if (lease.connectionId === connectionId) removeLease(path, 'disconnected')
    }
    for (const [requestId, record] of [...pending]) {
      if (record.connectionId === connectionId) {
        dropRequest(requestId)
        continue
      }
      if (record.holderConnectionId === connectionId) {
        dropRequest(requestId)
        settle(record, 'expired')
      }
    }
  }

  /**
   * Acquire a whole path set atomically. Paths are evaluated in sorted order so
   * two overlapping requests cannot deadlock and the reply is deterministic.
   * One live foreign holder refuses the entire batch — nothing is granted.
   * @param {AcquireInput} input
   * @returns {AcquireResult}
   */
  function acquire({ connectionId, owner, scope, paths, ttlMs: requestTtlMs }) {
    const at = now()
    const ttl = requestTtlMs !== undefined ? requestTtlMs : ttlMs
    /** @type {Conflict[]} */
    const conflicts = []
    /** @type {string[]} */
    const fresh = []
    /** @type {Lease[]} */
    const adopt = []
    for (const path of normalize(paths)) {
      const lease = leases.get(path)
      if (!lease || !isValid(lease)) {
        // A lapsed row nobody observed yet is a free path whose record is still
        // in the table: reclaim it through the ONE removal outlet so the release
        // is announced instead of being silently overwritten by the grant below.
        if (lease !== undefined) removeLease(path, 'expired')
        fresh.push(path)
        continue
      }
      if (lease.owner.id === owner.id && lease.connectionId === connectionId) {
        adopt.push(lease)
        continue
      }
      conflicts.push({ path, holder: { ...lease.owner }, expiresAt: lease.expiresAt, holdUntil: lease.holdUntil })
    }
    if (conflicts.length > 0) return { ok: false, code: 'held', conflicts }
    /** @type {LeaseView[]} */
    const granted = []
    for (const lease of adopt) {
      // Same owner, same connection: adopt. `acquiredAt` and `holdUntil` are
      // preserved (only the sliding validity moves); session/label/scope are
      // refreshed because this is the latest touch of that lineage.
      lease.owner = { ...owner }
      lease.scope = scope
      lease.expiresAt = at + ttl
      granted.push(view(lease))
    }
    for (const path of fresh) {
      /** @type {Lease} */
      const lease = {
        path,
        connectionId,
        owner: { ...owner },
        scope,
        acquiredAt: at,
        expiresAt: at + ttl,
        holdUntil: null,
      }
      leases.set(path, lease)
      granted.push(view(lease))
    }
    granted.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    return { ok: true, granted }
  }

  /**
   * Release whatever this owner still holds in the set. `notOwned` is NOT an
   * error — after a broker restart every path is simply free, and the client's
   * release list is its own business. Repeating a release is therefore a no-op
   * that reports `notOwned`.
   * @param {ReleaseInput} input
   * @returns {ReleaseResult}
   */
  function release({ connectionId, owner, paths }) {
    /** @type {string[]} */
    const released = []
    /** @type {string[]} */
    const notOwned = []
    for (const path of normalize(paths)) {
      const lease = leases.get(path)
      if (lease && lease.connectionId === connectionId && lease.owner.id === owner.id) {
        // Even a lapsed row belongs to its owner until removed, so the explicit
        // release is what takes it out of the table and what gets announced.
        removeLease(path, 'released')
        released.push(path)
      } else {
        notOwned.push(path)
      }
    }
    return { ok: true, released, notOwned }
  }

  /**
   * Extend validity to a wall-clock deadline. All-or-nothing: one path this
   * owner does not (still) hold refuses the whole batch. The bound is a product
   * constant, never a budget: reaching it has no consequence other than the
   * refusal itself.
   * @param {HoldInput} input
   * @returns {HoldResult}
   */
  function hold({ connectionId, owner, paths, minutes }) {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return { ok: false, code: 'bad-request' }
    if (minutes > holdMaxMinutes) return { ok: false, code: 'limit', maxMinutes: holdMaxMinutes }
    const at = now()
    const targets = normalize(paths)
    /** @type {string[]} */
    const missing = []
    for (const path of targets) {
      const lease = leases.get(path)
      if (lease !== undefined && !isValid(lease)) removeLease(path, 'expired')
      if (!lease || lease.connectionId !== connectionId || lease.owner.id !== owner.id || !isValid(lease)) missing.push(path)
    }
    if (missing.length > 0) return { ok: false, code: 'not-owned', paths: missing }
    const deadline = at + minutes * 60_000
    /** @type {{ path: string, expiresAt: number, holdUntil: number | null }[]} */
    const held = []
    for (const path of targets) {
      const lease = /** @type {Lease} */ (leases.get(path))
      // Only ever later: an earlier deadline never shortens an existing one.
      lease.holdUntil = Math.max(lease.holdUntil ?? 0, deadline)
      held.push({ path, expiresAt: lease.expiresAt, holdUntil: lease.holdUntil })
    }
    return { ok: true, held }
  }

  /**
   * Read-only projection. Filters stack (AND). Lapsed rows are not reported:
   * they are free regardless of what is still in the table, and `sweep`
   * reclaims the memory. Returned leases are copies.
   * @param {StatusFilter} [filter]
   * @returns {StatusResult}
   */
  function status(filter = {}) {
    /** @type {LeaseView[]} */
    const out = []
    /** @type {string[]} */
    const lapsed = []
    for (const lease of leases.values()) {
      if (!isValid(lease)) {
        // Read-only means "takes no valid lease": a record the clock already
        // made free is reclaimed and announced here, exactly like a sweep.
        lapsed.push(lease.path)
        continue
      }
      if (filter.scope !== undefined && lease.scope !== filter.scope) continue
      if (filter.session !== undefined && lease.owner.session !== filter.session) continue
      if (filter.path !== undefined && lease.path !== filter.path) continue
      out.push(view(lease))
    }
    for (const path of lapsed) removeLease(path, 'expired')
    out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    return { ok: true, leases: out }
  }

  /**
   * Ask the holder of a path to hand it over. At most one pending request per
   * (requester id, path): a repeat reuses the same `requestId` and the same
   * window instead of opening a second mailbox entry — unless ownership changed
   * hands in between, in which case the stale entry is replaced so the request
   * reaches the actual holder.
   * @param {RequestInput} input
   * @returns {RequestResult}
   */
  function request({ connectionId, from, path }) {
    const at = now()
    const lease = leases.get(path)
    if (!lease || !isValid(lease)) {
      if (lease !== undefined) removeLease(path, 'expired')
      return { ok: false, code: 'free' }
    }
    if (lease.owner.id === from.id) return { ok: false, code: 'self' }
    const key = requestKey(path, from.id)
    const knownId = pendingKeys.get(key)
    const known = knownId !== undefined ? pending.get(knownId) : undefined
    if (known && known.holderId === lease.owner.id) {
      return { ok: true, state: 'pending', requestId: known.requestId, holder: { ...lease.owner }, expiresAt: known.expiresAt }
    }
    if (known) dropRequest(known.requestId)
    const requestId = `req-${++requestSeq}`
    /** @type {PendingRequest} */
    const record = {
      requestId,
      path,
      from: { ...from },
      connectionId,
      holderConnectionId: lease.connectionId,
      holderId: lease.owner.id,
      expiresAt: at + requestWindowMs,
    }
    pending.set(requestId, record)
    pendingKeys.set(key, requestId)
    deliver(lease.connectionId, { event: 'request', requestId, path, from: { ...from }, expiresAt: record.expiresAt })
    return { ok: true, state: 'pending', requestId, holder: { ...lease.owner }, expiresAt: record.expiresAt }
  }

  /**
   * Answer a pending request as the holder.
   *
   * Precedence, in this order — the order is what makes all four documented
   * outcomes reachable: unknown/elapsed request → `expired`; ownership gone or
   * changed hands → `stale` (no ownership change); reply not from the holding
   * connection/owner → `not-holder` and the request stays pending (a stranger
   * must not be able to consume someone else's request); otherwise `keep`
   * declines, `release` transfers in place.
   * @param {ReplyInput} input
   * @returns {ReplyResult}
   */
  function reply({ connectionId, owner, requestId, decision }) {
    const at = now()
    const record = pending.get(requestId)
    if (!record) return { ok: false, code: 'expired' }
    if (at >= record.expiresAt) {
      dropRequest(requestId)
      settle(record, 'expired')
      return { ok: false, code: 'expired' }
    }
    const lease = leases.get(record.path)
    if (!lease || !isValid(lease)) {
      if (lease !== undefined) removeLease(record.path, 'expired')
      dropRequest(requestId)
      settle(record, 'expired')
      return { ok: false, code: 'stale' }
    }
    if (lease.owner.id !== record.holderId) {
      dropRequest(requestId)
      settle(record, 'expired')
      return { ok: false, code: 'stale' }
    }
    if (lease.connectionId !== connectionId || lease.owner.id !== owner.id) return { ok: false, code: 'not-holder' }
    dropRequest(requestId)
    if (decision === 'keep') {
      settle(record, 'declined')
      return { ok: true, state: 'declined' }
    }
    lease.owner = { ...record.from }
    lease.connectionId = record.connectionId
    lease.acquiredAt = at
    lease.expiresAt = at + ttlMs
    lease.holdUntil = null
    settle(record, 'transferred')
    return { ok: true, state: 'transferred' }
  }

  /**
   * Reclaim memory for lapsed leases and elapsed requests. Purely an
   * optimisation for long-lived brokers — validity is decided by the clock, not
   * by this pass — except that an elapsed request is the only moment the
   * requester learns its request expired.
   * @returns {{ droppedLeases: number, droppedRequests: number }}
   */
  function sweep() {
    const at = now()
    let droppedLeases = 0
    let droppedRequests = 0
    for (const [path, lease] of [...leases]) {
      if (at >= validUntil(lease)) {
        if (removeLease(path, 'expired')) droppedLeases += 1
      }
    }
    for (const [requestId, record] of [...pending]) {
      if (at >= record.expiresAt) {
        dropRequest(requestId)
        settle(record, 'expired')
        droppedRequests += 1
      }
    }
    return { droppedLeases, droppedRequests }
  }

  return Object.freeze({ connect, disconnect, acquire, release, hold, status, request, reply, sweep })
}
