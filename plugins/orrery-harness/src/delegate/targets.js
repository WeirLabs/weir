// Delegate target guidance: the static prompt-section template plus the live
// renderer for the enabled-target list. Pure module — no ctx, no imports. The
// composition root (src/delegate/index.js) registers the section and its
// variable with the systemPrompt service and feeds this renderer fresh overlay
// snapshots, so the list is re-evaluated at every prompt assembly (design D1).
// Template-layer text is English by charter rule 3.7.

/** Name of the system-prompt section this guidance is registered under. */
export const DELEGATE_TARGETS_SECTION_NAME = 'orchestrator:delegate-targets'

/** Interpolation variable embedded in the template; its provider returns the renderDelegateTargets output. */
export const DELEGATE_TARGETS_VARIABLE_NAME = 'orrery_delegate_targets'

/**
 * Order offset from the doctrine section's order (DOCTRINE_SECTION_ORDER in
 * src/core/doctrine.js). The composition root adds it when registering the
 * section; this module stays pure and does not import core.
 */
export const DELEGATE_TARGETS_SECTION_ORDER_OFFSET = 10

// The template states the calling contract and embeds exactly ONE variable
// reference — the live target list below. Any OTHER {{name}} reference would
// make prompt assembly throw (unregistered variable), so none may be added.
export const DELEGATE_TARGETS_TEMPLATE = `## Delegation targets

\`delegate\` takes exactly one target per item: either a category or a curated agent. The category lane has no default — a category must always be named explicitly. The curated agent lane is for the read-only research specialists. The currently enabled delegation targets:

{{${DELEGATE_TARGETS_VARIABLE_NAME}}}`

/**
 * @typedef {object} DelegateTargetEntry
 * @property {string} [description] - caller-facing: what the target is for
 * @property {string} [guidance] - categories only: what work routes here
 * @property {boolean} [disabled] - hidden from the model-facing list
 */

/**
 * Render the live enabled-target list embedded in the delegate-targets
 * section: one line per enabled category (name, description, routing
 * guidance) and one per enabled curated agent (name, description), both in
 * registry order. Disabled entries are skipped; each set degrades to an
 * explicit sentence when it is empty or fully disabled. Never throws and
 * never returns undefined or an empty string — the variable provider is
 * called at every prompt assembly, and a missing value would fail it (D1).
 *
 * @param {{ categories?: Record<string, DelegateTargetEntry | null | undefined>, agents?: Record<string, DelegateTargetEntry | null | undefined> }} [registries]
 * @returns {string}
 */
export function renderDelegateTargets({ categories, agents } = {}) {
  const categoryLines = enabledEntries(categories).map(
    ([name, entry]) =>
      `- ${name} — ${textOr(entry.description, 'No description provided.')} Routing guidance: ${textOr(entry.guidance, 'Not specified.')}`,
  )
  const agentLines = enabledEntries(agents).map(
    ([name, entry]) => `- ${name} — ${textOr(entry.description, 'No description provided.')}`,
  )
  return [
    'Categories:',
    categoryLines.length > 0 ? categoryLines.join('\n') : 'No categories are currently enabled.',
    '',
    'Curated agents:',
    agentLines.length > 0 ? agentLines.join('\n') : 'No curated agents are currently enabled.',
  ].join('\n')
}

/**
 * Enabled entries of one registry, in registry (key insertion) order.
 * Missing or malformed entries are skipped rather than rendered.
 *
 * @param {Record<string, DelegateTargetEntry | null | undefined> | undefined} record
 * @returns {Array<[string, DelegateTargetEntry]>}
 */
function enabledEntries(record) {
  if (!record || typeof record !== 'object') return []
  /** @type {Array<[string, DelegateTargetEntry]>} */
  const entries = []
  for (const [name, entry] of Object.entries(record)) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.disabled) continue
    entries.push([name, entry])
  }
  return entries
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function textOr(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}
