// Task 11.6 of the session-capability-manager change: session content pins,
// explicit refresh, local-change confirmation and GC.
//
// The first time a session accepts Skill content, the pin durably records
// the body, relatively-referenced assets, resourceBase and manifest through
// the group-2 store. Non-managed sources are copied first and verified as a
// consistent snapshot — a source that changes mid-copy is retried or
// refused. After an update is published the session keeps using its pinned
// content and reports update-available; adopting new content needs an
// explicit refresh with a content-revision CAS (the 4.5 refresh engine),
// which never changes the selection identity and never removes history.
// With the original install directory gone, a fully pinned identity stays
// usable. When local content diverges from the last managed digest,
// publication pauses and the user chooses overwrite (report: local changes
// discarded) or leave unchanged (report: skipped). A generation whose
// reference count is non-zero (live/durable sessions, subagents/forks or
// unsettled receipts) is never collected; anomalous recovery keeps
// conservatively.

/**
 * The pin snapshot recorded for one accepted identity (11.6).
 * @param {{ identity: unknown, body: string, assets: Record<string, string>, resourceBase: unknown, manifest: unknown }} input
 */
export function contentPinOf({ identity, body, assets = {}, resourceBase = null, manifest = null }) {
  if (typeof body !== 'string') throw new TypeError('a content pin needs a body string')
  return {
    identity,
    body,
    assets: { ...assets },
    resourceBase,
    manifest,
    revision: 1,
  }
}

/**
 * Consistent-snapshot verification for non-managed sources (11.6): two reads
 * of the same logical content must match exactly, or the copy is refused.
 * @param {string} first @param {string} second
 */
export function snapshotVerdict(first, second) {
  if (first !== second) return { ok: false, reason: 'source content changed mid-copy — the pin is refused (retry only if the source settles)' }
  return { ok: true }
}

/**
 * Whether a pinned identity stays usable with its origin directory gone
 * (11.6): a full pin (body + manifest) is sufficient on its own.
 * @param {{ body?: unknown, manifest?: unknown }} pin
 */
export function pinSelfSufficient(pin) {
  return typeof pin?.body === 'string' && pin.body.length > 0 && pin.manifest !== null && pin.manifest !== undefined
}

/**
 * The refresh verdict for adopting published content (11.6): an explicit,
 * CAS-guarded refresh that never changes the selection identity.
 * @param {{ expectedRevision: number, currentRevision: number }} input
 */
export function refreshVerdict({ expectedRevision, currentRevision }) {
  if (expectedRevision !== currentRevision) {
    return { refresh: false, reason: `content revision moved: expected ${expectedRevision}, found ${currentRevision} — nothing adopted (retry against the fresh revision)` }
  }
  return { refresh: true }
}

/**
 * The local-change decision (11.6): publication pauses on divergence and the
 * user's choice is reported, never silent.
 * @param {'overwrite'|'leave-unchanged'} decision
 */
export function localChangeOutcome(decision) {
  if (decision === 'overwrite') return { publish: true, report: 'local modifications were discarded by overwrite' }
  if (decision === 'leave-unchanged') return { publish: false, report: 'publication skipped; local content left unchanged' }
  return { publish: false, report: 'publication paused — no decision yet (overwrite / leave unchanged required)' }
}

/**
 * The GC reference-count gate (11.6): any live reference blocks collection;
 * an unreadable or anomalous record keeps conservatively.
 * @param {{ liveSessions?: number, durablePins?: number, subagentRefs?: number, unsettledReceipts?: number, anomaly?: boolean }} counts
 */
export function gcVerdict(counts) {
  if (counts.anomaly) return { collect: false, reason: 'anomalous recovery state — kept conservatively' }
  const held = (counts.liveSessions ?? 0) + (counts.durablePins ?? 0) + (counts.subagentRefs ?? 0) + (counts.unsettledReceipts ?? 0)
  if (held > 0) return { collect: false, reason: `reference count non-zero (${held}) — generation kept` }
  return { collect: true }
}
