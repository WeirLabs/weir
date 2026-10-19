// The read-only ownership view of the status surface (design D13).
//
// This module is the ONE place that decides what a user may see about
// ownership, and it is deliberately the narrowest possible projection:
//
//  - three facts and nothing else — who holds which short path, when the hold
//    started, and how long it can last. No epoch, no generation, no
//    reservation, no recovery record, no operation history, no fence. Those
//    concepts were deleted with the durable authority (D12); a view that still
//    carried them would let the panel grow a story that no longer exists.
//  - short names only. An absolute path in `path` would leak the user's home
//    directory into a UI string and, worse, invite someone to "fix" a row by
//    path. `pathFull` is the separate, mechanically faithful field the
//    technical layer may use; the panel does not render it by default.
//  - purity. No IO, no clock, no arbiter, no cordis: `now` arrives as an
//    argument so the expiry comparison is the caller's clock, exactly the
//    "read-time comparison" the lease protocol specifies (D2). A lapsed row is
//    therefore not ownership any more — showing it would invent a state whose
//    only exit is somebody cleaning it up, which the rebuild forbids.
//
// The arbiter's own health is a closed three-value vocabulary (D7): a healthy
// arbiter arbitrates, a degraded one lost the connection it once had, and an
// unavailable one was never reached in this process. Anything else is reported
// as `unavailable` — an unknown state must never be presented as healthy.

import { shortName as shortPathName } from './tools.js'

/** The only shape of this view the panel understands. */
export const VIEW_SCHEMA_VERSION = 1

/** Closed arbiter vocabulary (design D7); anything else renders as unavailable. */
export const ARBITER_STATES = Object.freeze(['ok', 'degraded', 'unavailable'])

/** @returns {string | undefined} the value when it is a non-empty string */
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * A millisecond instant, or `null` when the field is absent. `null` (not 0) is
 * the view's "no such deadline" — the panel distinguishes "not retained" from
 * "retained until the epoch".
 * @param {unknown} value
 * @returns {number | null}
 */
function instant(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * When a lease stops being ownership: `max(expiresAt, holdUntil ?? 0)`, the
 * protocol's one validity rule (D2). Not a second authority — the arbiter
 * already applied it; this is what makes the view agree with the arbiter
 * without asking it again.
 * @param {any} lease
 * @returns {number}
 */
function validUntil(lease) {
  const expiresAt = instant(lease?.expiresAt) ?? 0
  const holdUntil = instant(lease?.holdUntil) ?? 0
  return Math.max(expiresAt, holdUntil)
}

/**
 * The short name of one lease path: relative inside the session's cwd, the
 * basename outside it. Never absolute (the rule itself lives in `tools.js`, so
 * the model-facing status text and this view cannot disagree).
 * @param {string} path
 * @param {string | undefined} cwd
 * @returns {string}
 */
function shortName(path, cwd) {
  try {
    return shortPathName(path, cwd)
  } catch {
    // A malformed path must degrade to something renderable, never throw in
    // the endpoint: the panel is an observability surface, not a validator.
    return path
  }
}

/**
 * Build the read-only ownership view.
 *
 * @param {object} input
 * @param {any[]} [input.leases] the arbiter's `status` snapshot (`LeaseView[]`)
 * @param {string | undefined} [input.mineLineage] the calling session's lineage id (design D9)
 * @param {string | undefined} [input.cwd] the session's working directory (short-name base and scope)
 * @param {'ok' | 'degraded' | 'unavailable' | string} [input.arbiter] the client's read-only connection state
 * @param {number} [input.now] read-time instant (epoch ms) used for the expiry comparison
 * @returns {{
 *   schemaVersion: number,
 *   arbiter: 'ok' | 'degraded' | 'unavailable',
 *   mine: { path: string, pathFull: string, label: string, heldSince: number | null, holdUntil: number | null }[],
 *   others: { path: string, pathFull: string, holder: { label: string, session: string }, expiresAt: number | null, holdUntil: number | null }[],
 * }}
 */
export function buildLeaseView({ leases, mineLineage, cwd, arbiter, now } = {}) {
  const at = instant(now) ?? 0
  const base = text(cwd)
  const mineId = text(mineLineage)
  /** @type {any[]} */
  const mine = []
  /** @type {any[]} */
  const others = []
  for (const lease of Array.isArray(leases) ? leases : []) {
    if (lease === null || typeof lease !== 'object') continue
    const path = text(lease.path)
    if (path === undefined) continue
    // Lapsed rows are not ownership: ownership ends by itself (D2/D10), and the
    // view says so instead of presenting a row somebody would have to clear.
    if (validUntil(lease) <= at) continue
    const owner = lease.owner !== null && typeof lease.owner === 'object' ? lease.owner : {}
    const label = text(owner.label) ?? text(owner.session) ?? ''
    const short = shortName(path, base)
    const holdUntil = instant(lease.holdUntil)
    if (mineId !== undefined && text(owner.id) === mineId) {
      mine.push({ path: short, pathFull: path, label, heldSince: instant(lease.acquiredAt), holdUntil })
      continue
    }
    others.push({
      path: short,
      pathFull: path,
      holder: { label, session: text(owner.session) ?? '' },
      expiresAt: instant(lease.expiresAt),
      holdUntil,
    })
  }
  // Deterministic order, independent of the snapshot's own ordering: by the
  // short name the user actually reads (two basenames may collide), then by the
  // full path, which is unique per lease and therefore a total order.
  const byPath = (/** @type {any} */ left, /** @type {any} */ right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    return left.pathFull < right.pathFull ? -1 : left.pathFull > right.pathFull ? 1 : 0
  }
  mine.sort(byPath)
  others.sort(byPath)
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    arbiter: ARBITER_STATES.includes(/** @type {any} */ (arbiter)) ? /** @type {any} */ (arbiter) : 'unavailable',
    mine,
    others,
  }
}
