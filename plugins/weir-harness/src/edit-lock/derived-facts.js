/** Ledger derived facts (change edit-lock-deepening, design D1): the three
 * derivation rules an authority image supports — epoch-scoped revocation
 * (`revokedOwner`), read-time hold settlement (`settleHoldFacts`) and the
 * administrative disposition lookup (`dispositionFor`) — in ONE pure home,
 * shared by the manager status path, the kernel's settleHold, the cold view
 * and the maintenance inspector. Pure: no IO, no clock, no ctx, no imports.
 *
 * Each rule takes a `partial` option for the cold read (buildColdView): the
 * panel is deliberately more tolerant than the kernel — a partial image (a
 * missing collection, a malformed row) degrades to "not revoked / no hold"
 * instead of throwing on data the kernel would already have rejected at parse
 * time. The strict default is byte-identical to the kernel/ledger rules the
 * call sites previously inlined or imported. */

/**
 * Epoch-scoped revocation: a disposition revokes its owner's execution
 * authority exactly at the recorded revokedEpoch; the owner stays revoked
 * while its recorded epoch is within it, and a trusted resume advancing the
 * epoch past every revokedEpoch ends the revoked state without any ledger
 * change (append-only: dispositions are never removed or altered). Extracted
 * from admin-ledger.js; the cold view applied the same rule inline.
 * @param {any} state the authority image (or the in-memory status state)
 * @param {string} owner
 * @param {{ partial?: boolean }} [options] partial tolerates a partial image:
 *   missing collections read as empty and malformed rows are skipped; the
 *   strict default trusts the validated image.
 */
export function revokedOwner(state, owner, { partial = false } = {}) {
  if (partial) {
    const sessions = Array.isArray(state?.sessions) ? state.sessions : []
    const session = sessions.find(row => row?.sessionId === owner) ?? null
    if (session == null) return false
    const ledger = Array.isArray(state?.adminRecoveries) ? state.adminRecoveries : []
    return ledger.some(row => row?.owner === owner && Number.isSafeInteger(row?.revokedEpoch) && session.executionEpoch <= row.revokedEpoch)
  }
  const session = state.sessions?.find(s => s.sessionId === owner)
  if (!session) return false
  return state.adminRecoveries?.some(row => row.owner === owner && session.executionEpoch <= row.revokedEpoch) === true
}

/**
 * Read-time retention settlement (design D5), byte-identical to the kernel's
 * settleHold rule it was extracted from (state.js): a hold counts only while
 * the session owns a lock, and the remaining budget is computed against the
 * read instant, so a missed expiry timer can never leave stale ownership
 * behind a status read. The caller keeps its container lookup and its empty
 * case (the kernel's zero row vs the cold view's null): `held` is the
 * session's PRESENT hold row, `owns` whether the session owns any lock, `now`
 * the read instant.
 * @param {string} sessionId @param {any} held @param {boolean} owns @param {number} now
 * @param {{ partial?: boolean }} [options] partial keeps the cold path's
 *   defensive tolerance of a partial image: an undefined holdUntil reads as no
 *   expiry and only a literal `holding === true` counts.
 */
export function settleHoldFacts(sessionId, held, owns, now, { partial = false } = {}) {
  const until = held.holdUntil
  const remainingMs = (partial ? until == null : until === null) ? 0 : Math.max(0, until - now)
  const holding = (partial ? held.holding === true : held.holding) && owns
  return { sessionId, held: holding, expired: holding && until !== null && remainingMs === 0,
    holdUntil: until, remainingMs, holdCumulativeMs: held.holdCumulativeMs }
}

/**
 * The administrative disposition covering one operation, if any. Extracted
 * verbatim from admin-ledger.js; the maintenance inspector's inline copy was
 * identical (inspect.js). @param {any} state @param {any} op */
export const dispositionFor = (state, op) => state.adminRecoveries?.find(row => row.owner === op.sessionId && row.operations.some(item => item.operationId === op.operationId))
