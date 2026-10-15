// Office capability gate (design D2 of test-harness-env-capability-skip): the
// OFFICE skill-composition mode probes an OPTIONAL environment capability —
// the bundled dsh-office skill candidates. When they are not all present in
// the observed inventory, the probe records the absence marker below (with
// the observed evidence) instead of throwing, so the scenario reports SKIP
// rather than FAIL. Extracted as a pure unit so the branch is testable
// without booting the probe (same pattern as src/run-lock.js).

/** The raw host Office candidates the OFFICE mode composes. */
export const OFFICE_CANDIDATES = ['office-docx', 'office-pptx', 'office-xlsx']

/**
 * Evaluate Office capability availability from a live selection inventory.
 * @param {{ candidates: Array<{ name?: string, provider?: string }> }} inventory
 * @returns {null|{ missing: string[], providers: string[] }} null when every
 *   Office candidate is present; otherwise the absence marker: the missing
 *   candidate names plus the deduplicated provider ids actually observed.
 */
export function officeUnavailable(inventory) {
  const missing = OFFICE_CANDIDATES.filter((name) => !inventory.candidates.some((candidate) => candidate.name === name))
  if (missing.length === 0) return null
  return { missing, providers: [...new Set(inventory.candidates.map((candidate) => candidate.provider))] }
}
