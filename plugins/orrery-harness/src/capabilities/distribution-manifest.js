// Task 10.1 of the session-capability-manager change: the distribution-side
// input manifest and provenance records. Every entry carries the source
// repository, source kind, requested ref, subpath, install location and
// content identity (reusing the group-3 raw inventory). Values that cannot
// be established are reported as `unknown` — never inferred, never
// fabricated, and a missing identity is never claimed as "unchanged".
// Entries that are unavailable, name-conflicting or locally modified stay
// listed (with their state), never silently dropped.

export const DISTRIBUTION_SCHEMA_VERSION = 1

/**
 * @typedef {{ repository: string, sourceKind: string, requestedRef: string, subpath: string|null,
 *   installLocation: string, contentIdentity: string|null,
 *   state: 'ok'|'unavailable'|'name-conflict'|'locally-modified'|'unknown' }} DistributionEntry
 */

/** @param {unknown} value */
const isNonEmptyString = value => typeof value === 'string' && value.length > 0

/**
 * Normalize one raw record into a manifest entry. Anything not established
 * by the record becomes 'unknown' verbatim — no inference, no comparison.
 * @param {Record<string, unknown>} raw
 * @returns {DistributionEntry}
 */
export function manifestEntryOf(raw) {
  const unknown = { repository: 'unknown', sourceKind: 'unknown', requestedRef: 'unknown', subpath: null, installLocation: 'unknown', contentIdentity: null, state: 'unknown' }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return unknown
  return {
    repository: isNonEmptyString(raw.repository) ? raw.repository : 'unknown',
    sourceKind: isNonEmptyString(raw.sourceKind) ? raw.sourceKind : 'unknown',
    requestedRef: isNonEmptyString(raw.requestedRef) ? raw.requestedRef : 'unknown',
    subpath: typeof raw.subpath === 'string' ? raw.subpath : null,
    installLocation: isNonEmptyString(raw.installLocation) ? raw.installLocation : 'unknown',
    contentIdentity: isNonEmptyString(raw.contentIdentity) ? raw.contentIdentity : null,
    state: ['ok', 'unavailable', 'name-conflict', 'locally-modified'].includes(raw.state) ? raw.state : 'unknown',
  }
}

/**
 * Compare is only defined when BOTH identities are established; a missing
 * identity is never claimed as "unchanged" — it reports as unknown.
 * @param {DistributionEntry} entry @param {string|null} currentIdentity
 */
export function changeVerdict(entry, currentIdentity) {
  if (entry.contentIdentity === null || typeof currentIdentity !== 'string' || currentIdentity.length === 0) {
    return 'unknown'
  }
  return entry.contentIdentity === currentIdentity ? 'unchanged' : 'changed'
}

// Task 10.2 of the session-capability-manager change: the bundle-owned
// builtin guard. Builtin skills are delivered and updated ONLY through the
// bundle's own workflow; no third-party process may write, update, move or
// delete their content, and a same-named third-party skill is never a valid
// definition of a builtin identity.

/**
 * Whether a target location falls inside the Orrery builtin skills root —
 * distribution writes there are always refused (10.2).
 * @param {string} targetPath @param {string} builtinRoot
 */
export function isBuiltinTarget(targetPath, builtinRoot) {
  if (typeof targetPath !== 'string' || typeof builtinRoot !== 'string') return false
  const root = builtinRoot.endsWith('/') ? builtinRoot : `${builtinRoot}/`
  return targetPath === builtinRoot || targetPath.startsWith(root)
}

/**
 * Whether a candidate may serve as the definition of a builtin identity: a
 * third-party same-name candidate is NEVER valid for a builtin identity
 * (10.2).
 * @param {{ scope?: string, provider?: string }} candidate
 */
export function isValidBuiltinDefinition(candidate) {
  return candidate?.scope === 'orrery-builtin'
}
