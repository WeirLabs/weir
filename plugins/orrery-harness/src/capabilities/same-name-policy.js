// Task 10.3 of the session-capability-manager change: same-name listing and
// the "no silent substitute / no silent overwrite" rules. Every same-name
// entry is listed with its scope, provenance and discovery precedence —
// informational only, never an authorization signal. A missing reference is
// never satisfied by a same-named entry, and installing into an occupied
// name writes ONLY after an explicit replace / coexist-distinct / cancel
// decision.

/**
 * Rank the entries for the informational listing (10.3): discovery
 * precedence is REPORTED, never interpreted as authorization.
 * @param {Array<{ name: string, scope?: string, rank?: number, provenance?: unknown }>} entries
 */
export function sameNameListing(entries) {
  return entries
    .filter(entry => entry && typeof entry.name === 'string')
    .map(entry => ({
      name: entry.name,
      scope: entry.scope ?? 'unknown',
      provenance: entry.provenance ?? null,
      precedence: Number.isSafeInteger(entry.rank) ? entry.rank : null,
    }))
    .sort((a, b) => (a.precedence ?? Number.MAX_SAFE_INTEGER) - (b.precedence ?? Number.MAX_SAFE_INTEGER) || a.scope.localeCompare(b.scope))
}

/**
 * The install-into-occupied-name decision (10.3): the default is CANCEL —
 * nothing is written unless the caller explicitly chooses 'replace' (the
 * named entry is overwritten after confirmation) or 'coexist' (the install
 * must target a distinct name).
 * @param {{ name: string, occupied: boolean, decision?: 'replace'|'coexist'|'cancel', targetName?: string }} input
 * @returns {{ write: boolean, target: string|null, status: string }}
 */
export function installTargetFor({ name, occupied, decision = 'cancel', targetName }) {
  if (!occupied) return { write: true, target: name, status: 'write' }
  if (decision === 'replace') return { write: true, target: name, status: 'replace-confirmed' }
  if (decision === 'coexist') {
    if (typeof targetName !== 'string' || targetName.length === 0 || targetName === name) {
      return { write: false, target: null, status: 'coexist-needs-distinct-name' }
    }
    return { write: true, target: targetName, status: 'coexist-distinct' }
  }
  return { write: false, target: null, status: 'cancelled' }
}

/**
 * A missing reference is never satisfied by a same-named entry (10.3): the
 * resolution of a ref matches by IDENTITY, and an identity mismatch is
 * always unresolved even when the display name matches.
 * @param {{ name?: string, identity?: unknown }} wanted @param {{ name?: string, identity?: unknown }} candidate
 * @param {(identity: unknown) => string} identityKeyOf
 */
export function refSatisfiedBy(wanted, candidate, identityKeyOf) {
  if (wanted?.identity === undefined || wanted.identity === null) return false
  if (candidate?.identity === undefined || candidate.identity === null) return false
  try {
    return identityKeyOf(wanted.identity) === identityKeyOf(candidate.identity)
  } catch {
    return false
  }
}
