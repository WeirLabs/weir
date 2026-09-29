// Report whitelist drift between the shipped baseline and the declared one.
//
// WHY THIS EXISTS — the baseline is INVISIBLE at runtime. DSH composes patch
// layers by WHOLE-VALUE replacement rather than deep merge (`applyEntryPatches`
// does `target[key] = value`, and the host README states "does not deep-merge").
// So when a profile declares its own `orrery-settings` row, the bundle's
// `config` object is discarded outright and the plugin can no longer see what
// the baseline would have allowed. A stale snapshot in a user's profile row
// therefore shadows every later baseline addition — which is exactly how
// `Start-Sleep` was missing from a live Windows session while the repo baseline
// carried it, with no signal anywhere that anything had drifted.
//
// The baseline can only be recovered from the bundle's own built patch file, so
// that is what this module reads. It REPORTS ONLY: it never rewrites a profile,
// never widens a guard, and never blocks activation.
import { readFileSync } from 'node:fs'

/** The flat settings keys that hold the guard's whitelist tables. */
const BASELINE_KEYS = ['robashAllow', 'robashGitAllow', 'robashDeny', 'robashPwshAllow', 'robashPwshDeny']

/** The two pwsh tables are matched case-insensitively — the guard lowercases before lookup. */
const CASE_INSENSITIVE_KEYS = new Set(['robashPwshAllow', 'robashPwshDeny'])

/** One `key: '<json array>'` row per whitelist table, as written in the patch file. */
function rowPattern(key) {
  return new RegExp(`^\\s*${key}:\\s*'(\\[.*?\\])'\\s*$`, 'm')
}
/** Default reader: the shipped patch file is UTF-8 text. */
function readPatchFile(pathOrUrl) {
  return readFileSync(pathOrUrl, 'utf8')
}

/**
 * Read the bundle's own `cordis.patch.yml` and extract the whitelist tables it
 * declares. Returns `{}` on any failure: a missing or unreadable patch file must
 * degrade to "nothing to compare", never to a crash at activation.
 *
 * @param {(pathOrUrl: URL) => string} [read] - injectable reader; tests pass a stub or `readFileSync`
 * @returns {Record<string, string[]>}
 */
function readBaselineWhitelists(read = readPatchFile) {
  let text
  try {
    // From src/shared/ the shipped patch file is two levels up, at the package root.
    text = read(new URL('../../cordis.patch.yml', import.meta.url))
  } catch {
    return {}
  }
  if (typeof text !== 'string') return {}
  const baseline = {}
  for (const key of BASELINE_KEYS) {
    const match = text.match(rowPattern(key))
    if (!match) continue
    try {
      const parsed = JSON.parse(match[1])
      if (Array.isArray(parsed)) baseline[key] = parsed
    } catch {
      // A malformed row is not this module's business — the parity test guards it.
    }
  }
  return baseline
}

/**
 * Compare the declared whitelists against the baseline.
 *
 * Only MISSING entries count as drift. Extra entries are the user widening their
 * own guard, which is their call. A table the baseline does not declare is
 * skipped, and a table declared empty is treated as an intentional clearing
 * (documented fail-closed behaviour), not as drift.
 *
 * @param {Record<string, unknown> | null | undefined} declared - the raw settings section
 * @param {Record<string, string[]>} baseline
 * @returns {{ missing: Array<{key: string, entry: string}> } | null} null when there is nothing to report
 */
function diffWhitelist(declared, baseline) {
  if (!declared || typeof declared !== 'object') return null
  const missing = []
  for (const key of BASELINE_KEYS) {
    const declaredList = declared[key]
    const baselineList = baseline?.[key]
    if (!Array.isArray(declaredList) || !Array.isArray(baselineList)) continue
    // Empty = explicitly cleared on purpose; saying "drift" would fight the
    // documented "present and empty is authoritative" semantics.
    if (declaredList.length === 0) continue
    const fold = CASE_INSENSITIVE_KEYS.has(key) ? (entry) => String(entry).toLowerCase() : (entry) => String(entry)
    const present = new Set(declaredList.map(fold))
    for (const entry of baselineList) {
      if (!present.has(fold(entry))) missing.push({ key, entry })
    }
  }
  return missing.length > 0 ? { missing } : null
}

/**
 * Render the drift as a one-line English warning (AGENTS.md §3.7: template text
 * is English; the module-name prefix follows the existing convention).
 *
 * @param {{ missing: Array<{key: string, entry: string}> }} drift
 * @param {number} [limit] - how many entries to spell out before summarising
 */
function renderDriftWarning(drift, limit = 8) {
  const shown = drift.missing.slice(0, limit).map((item) => `${item.key}=${item.entry}`)
  const rest = drift.missing.length - shown.length
  const listed = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
  return (
    'orrery-settings: read-only whitelist drift — this row is missing ' +
    `${drift.missing.length} entr${drift.missing.length === 1 ? 'y' : 'ies'} the shipped baseline allows: ${listed}. ` +
    'A profile-level patch row REPLACES the bundle config (no deep merge), so baseline additions do not reach it; ' +
    're-add them, or clear the row\'s whitelist keys to use the module defaults.'
  )
}

export { BASELINE_KEYS, diffWhitelist, readBaselineWhitelists, renderDriftWarning }
