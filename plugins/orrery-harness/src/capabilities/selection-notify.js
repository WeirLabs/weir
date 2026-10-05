// Task 12.4 of the session-capability-manager change: the model-facing
// removal notification (the D-E invariant). Net changes merge across queued
// applications; at the next safe request the merged notification rides WITH
// that request as a full UserMessage (shared helper shape) — it never
// creates a turn of its own, never runs inside a session/event listener as
// a synchronous followup, and the advisory text promises neither history
// erasure nor call retraction. A failed injection is audit/warn only and
// never affects the accepted commit.

export const NOTIFY_SOURCE = 'orrery-selection-notify'

/**
 * The merged net change set for one session (12.4): a name queued as added
 * then removed nets out of BOTH sets (and vice versa).
 * @param {{ added: string[], removed: string[] }} pending
 * @param {{ added?: string[], removed?: string[] }} delta
 */
export function mergeNetChanges(pending, delta) {
  const added = new Set(pending.added)
  const removed = new Set(pending.removed)
  for (const name of delta.added ?? []) {
    if (removed.has(name)) removed.delete(name)
    else added.add(name)
  }
  for (const name of delta.removed ?? []) {
    if (added.has(name)) added.delete(name)
    else removed.add(name)
  }
  return { added: [...added].sort(), removed: [...removed].sort() }
}

/**
 * The advisory text (English template, 12.4): states the merged change,
 * explicitly that this is an automated notice rather than a user message,
 * and the two boundaries — already handed-off calls may still complete, and
 * nothing in the history is retracted.
 * @param {{ added: string[], removed: string[] }} net
 */
export function notificationText(net) {
  const parts = []
  if (net.removed.length > 0) parts.push(`Removed: ${net.removed.join(', ')}.`)
  if (net.added.length > 0) parts.push(`Added: ${net.added.join(', ')}.`)
  if (parts.length === 0) return null
  return [
    '[Automated capability notice — not a user message]',
    `The capability selection for this session changed. ${parts.join(' ')}`,
    'Calls already handed off to a removed capability may still complete; no prior turn or call is retracted or erased from history.',
  ].join('\n')
}

/**
 * The per-session pending queue + injection seam (12.4).
 */
export function createSelectionNotifier() {
  const pending = new Map()
  return {
    /** Queue a net delta for a session (merged with anything pending). */
    queue(sessionId, delta) {
      const current = pending.get(sessionId) ?? { added: [], removed: [] }
      pending.set(sessionId, mergeNetChanges(current, delta))
    },
    /**
     * Consume the merged notification for the session's next safe request,
     * or null when nothing is pending.
     */
    consume(sessionId) {
      const net = pending.get(sessionId)
      pending.delete(sessionId)
      if (!net) return null
      const text = notificationText(net)
      return text === null ? null : { text, net }
    },
    has(sessionId) { return pending.has(sessionId) },
  }
}
