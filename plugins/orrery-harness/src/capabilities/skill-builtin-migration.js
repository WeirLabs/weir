// First-run migration check for the Orrery builtin skills (D-H 6).
// Pre-migration the bundle's skills/ directory reached sessions through the
// removed skill-filesystem row's customSkillDirs: the custom source label and
// rank 300. Post-migration the selection provider enumerates the same
// directory under the 'orrery-builtin' scope — the Orrery-builtin label,
// never the host 'bundled' source or its rank 600 — while preserving that
// source label and rank. The check runs on every builtin discovery, the
// first of which IS the first run after the old row's removal: any deviation
// fails closed with a visible reason instead of serving skills under
// non-equivalent semantics.

/** The contracted builtin catalog, matching the bundle's skills/ directory. */
export const ORRERY_BUILTIN_SKILLS = Object.freeze([
  'debugging',
  'deep-work',
  'git-master',
  'programming',
  'refactor',
  'remove-ai-slops',
  'remove-deadcode',
  'research',
  'review-work',
  'work-with-pr',
])

/** Pre-migration customSkillDirs semantics, frozen as the equivalence contract. */
export const ORRERY_BUILTIN_SOURCE = 'custom'
export const ORRERY_BUILTIN_RANK = 300
export const ORRERY_BUILTIN_SCOPE = 'orrery-builtin'

export const MIGRATION_FAILURE = 'Orrery builtin skill migration check failed'

/**
 * Verify a discovery snapshot against the pre-migration contract: exactly one
 * readable orrery-builtin root whose parsed candidates are exactly the
 * contracted ten, each carrying the custom source label and rank 300.
 * @param {{ roots?: Array<{ root: Record<string, unknown>, complete: boolean, error?: string }>,
 *   candidates?: Array<Record<string, any>> }} snapshot
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkBuiltinSkillMigration(snapshot) {
  const roots = (snapshot?.roots ?? []).filter(observation => observation.root?.scope === ORRERY_BUILTIN_SCOPE)
  if (roots.length !== 1) {
    return { ok: false, reason: `${MIGRATION_FAILURE}: expected exactly one ${ORRERY_BUILTIN_SCOPE} root, found ${roots.length}` }
  }
  const [observation] = roots
  if (!observation.complete) {
    return { ok: false, reason: `${MIGRATION_FAILURE}: the builtin root is unreadable${observation.error ? ` (${observation.error})` : ''}` }
  }
  const candidates = (snapshot?.candidates ?? []).filter(candidate => candidate.root?.scope === ORRERY_BUILTIN_SCOPE)
  const unparsed = candidates.filter(candidate => candidate.status !== 'parsed')
  if (unparsed.length) {
    const names = unparsed.map(candidate => candidate.entryName ?? candidate.locator?.path ?? 'unknown').join(', ')
    return { ok: false, reason: `${MIGRATION_FAILURE}: unparsed builtin entries: ${names}` }
  }
  const names = candidates.map(candidate => candidate.name).sort()
  const missing = ORRERY_BUILTIN_SKILLS.filter(name => !names.includes(name))
  const unexpected = names.filter(name => !ORRERY_BUILTIN_SKILLS.includes(name))
  if (missing.length || unexpected.length) {
    const parts = []
    if (missing.length) parts.push(`missing skills: ${missing.join(', ')}`)
    if (unexpected.length) parts.push(`unexpected skills: ${unexpected.join(', ')}`)
    return { ok: false, reason: `${MIGRATION_FAILURE}: ${parts.join('; ')}` }
  }
  const mislabeled = candidates.filter(candidate => candidate.source !== ORRERY_BUILTIN_SOURCE || candidate.rank !== ORRERY_BUILTIN_RANK)
  if (mislabeled.length) {
    const detail = mislabeled.map(candidate => `${candidate.name} (source=${candidate.source}, rank=${candidate.rank})`).join(', ')
    return { ok: false, reason: `${MIGRATION_FAILURE}: labels diverge from the pre-migration custom/rank-300 contract: ${detail}` }
  }
  return { ok: true }
}

/**
 * Throwing form used on the discovery path: a non-equivalent snapshot must
 * fail the enumeration closed (visible provider error, denials only), never
 * serve skills under divergent semantics.
 * @template T
 * @param {T} snapshot
 * @returns {T}
 */
export function assertBuiltinSkillMigration(snapshot) {
  const verdict = checkBuiltinSkillMigration(snapshot)
  if (!verdict.ok) throw new Error(verdict.reason)
  return snapshot
}
