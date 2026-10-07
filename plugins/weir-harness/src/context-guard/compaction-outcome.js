// Compaction outcome classifier — the context guard's single interpretation
// point for compaction failures. Pure module: the host's structured error
// `code` contract ("stable failure class") decides first; the legacy message
// regex only ever runs as a fallback for errors without a string code.
// Upgrade path: future busy-class host codes extend the first rule only.

const LEGACY_BUSY_MESSAGE = /busy|active|not idle|running/i

/**
 * Classify a compaction failure. Order-sensitive cascade:
 * 1. `error.code === 'busy'` (string) → 'busy'.
 * 2. Any OTHER string code → 'failed' — the message text never participates,
 *    so a non-busy error whose message happens to contain busy words can
 *    never re-queue a compaction forever.
 * 3. No string code: legacy regex over `error.message` (fallback `error.name`).
 * 4. Everything else → 'failed'.
 * @param {any} error
 * @returns {'busy' | 'failed'}
 */
export function classifyCompactionOutcome(error) {
  const code = error?.code
  if (typeof code === 'string') return code === 'busy' ? 'busy' : 'failed'
  const text = String(error?.message ?? error?.name ?? '')
  return LEGACY_BUSY_MESSAGE.test(text) ? 'busy' : 'failed'
}
