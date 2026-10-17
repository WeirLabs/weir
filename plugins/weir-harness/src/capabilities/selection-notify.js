// Task 12.4 of the session-capability-manager change: the model-facing
// removal notification (the D-E invariant). Net changes merge across queued
// applications; at the next safe request the merged notification rides WITH
// that request as a full UserMessage (shared helper shape) — it never
// creates a turn of its own, never runs inside a session/event listener as
// a synchronous followup, and the advisory text promises neither history
// erasure nor call retraction. A failed injection is audit/warn only and
// never affects the accepted commit.
//
// durable-pending-notice (D1/D2/D4/D5/D6): the queued obligation is a durable
// capability-store unit ({kind:'notice', sessionId} → sessions/<id>/notice.json),
// not process memory — an Apply that was accepted is owed a notice even if the
// host exits before the session's next request. The queue write happens inside
// the engine's one non-yielding publication segment (commitSync), coalescing
// with whatever is already pending through the unchanged mergeNetChanges; the
// obligation is cleared only AFTER the text has actually been injected, by
// subtracting exactly the delivered names. Failing to read, write or clear
// never fabricates a notice, never deletes a damaged unit and never touches the
// accepted selection record — it is reported on the cold-safe audit channel
// (AUDIT_TYPES.capabilityNotice; counts, never names).
import { AUDIT_TYPES } from '../shared/audit.js'
import { userTextMessage } from '../shared/user-message.js'

export const NOTIFY_SOURCE = 'weir-selection-notify'

/**
 * The accepted-set delta for the model-facing notice (apply-delta-durable-basis
 * D1): two `{ skills: identities[], mcpServers: string[] }` set objects in —
 * the durable pre-write accepted record and the just-committed payload — one
 * sorted `{ added, removed }` name delta out. Skill identities map to display
 * names (`identity?.name`), MCP server names pass through unchanged; nameless
 * entries never leak. Pure: the same inputs always yield the same delta, so
 * the committed branch and the recovery-'published' branch share it.
 * @param {{ skills?: unknown[], mcpServers?: string[] } | null | undefined} previousSets
 * @param {{ skills?: unknown[], mcpServers?: string[] } | null | undefined} acceptedSets
 * @returns {{ added: string[], removed: string[] }}
 */
export function selectionDelta(previousSets, acceptedSets) {
  const names = identities => new Set((Array.isArray(identities) ? identities : []).map(identity => String(identity?.name ?? '')).filter(Boolean))
  const servers = value => new Set(Array.isArray(value) ? value : [])
  const before = names(previousSets?.skills)
  const after = names(acceptedSets?.skills)
  const beforeMcp = servers(previousSets?.mcpServers)
  const afterMcp = servers(acceptedSets?.mcpServers)
  return {
    added: [...after].filter(name => !before.has(name)).concat([...afterMcp].filter(name => !beforeMcp.has(name))).sort(),
    removed: [...before].filter(name => !after.has(name)).concat([...beforeMcp].filter(name => !afterMcp.has(name))).sort(),
  }
}

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

/** The empty net: nothing is owed to the model. */
const NO_CHANGES = Object.freeze({ added: [], removed: [] })

/**
 * Normalize a stored notice payload into a net change set. Only non-empty
 * strings are names, both lists dedupe and sort, and a payload that is not an
 * object reads as an empty net: a damaged payload is NEVER turned into a
 * fabricated notice (the notice is advisory — nothing is owed when nothing
 * readable names a change).
 * @param {unknown} payload
 * @returns {{ added: string[], removed: string[] }}
 */
export function noticeNet(payload) {
  const value = /** @type {Record<string, unknown>} */ (payload !== null && typeof payload === 'object' ? payload : {})
  const names = list => Array.isArray(list)
    ? [...new Set(list.filter(name => typeof name === 'string' && name.length > 0))].sort()
    : []
  return { added: names(value.added), removed: names(value.removed) }
}

/** @param {{ added: string[], removed: string[] }} net */
const isEmptyNet = net => net.added.length === 0 && net.removed.length === 0

/** @param {{ added: string[], removed: string[] }} a @param {{ added: string[], removed: string[] }} b */
const sameNet = (a, b) => a.added.length === b.added.length && a.removed.length === b.removed.length
  && a.added.every((name, index) => name === b.added[index])
  && a.removed.every((name, index) => name === b.removed[index])

/**
 * Subtract exactly the delivered names (D4): an added name leaves the added
 * set, a removed name leaves the removed set. A concurrent Apply's delta merged
 * under the CAS therefore survives a clear.
 * @param {{ added: string[], removed: string[] }} current
 * @param {{ added: string[], removed: string[] }} delivered
 */
function subtractDelivered(current, delivered) {
  const added = new Set(current.added)
  const removed = new Set(current.removed)
  for (const name of delivered.added) added.delete(name)
  for (const name of delivered.removed) removed.delete(name)
  return { added: [...added].sort(), removed: [...removed].sort() }
}

/**
 * @typedef {{ added: string[], removed: string[] }} NetChange
 * @typedef {{ added: string[], removed: string[], revision: number }} PendingNotice
 * @typedef {{ read(unit: unknown): Promise<any>, readSync(unit: unknown): any,
 *   commit(unit: unknown, expectedRevision: number, mutate: (payload: unknown, info: { revision: number }) => unknown): Promise<any>,
 *   commitSync(unit: unknown, expectedRevision: number, mutate: (payload: unknown, info: { revision: number }) => unknown): any }} NoticeStore
 */

/**
 * The durable pending-notice queue + injection seam (12.4, made durable by
 * durable-pending-notice). One instance per host process:
 * - `queueSync` runs inside the Apply publication segment (no await allowed) and
 *   THROWS on any non-committed outcome, so the engine's existing catch degrades
 *   the response instead of silently dropping the obligation;
 * - `pending`/`deliver`/`clearDelivered` are the request-boundary side: read,
 *   inject, then clear;
 * - `has` is the synchronous diagnostic (`hasPendingNotification`).
 * A per-session mirror (D6) keeps the steady state free of extra disk reads: a
 * session is read on its first boundary of this process and after any local
 * write. A notice written by ANOTHER process is therefore not observed until the
 * next cold load — a stated limit, strictly better than the process Map it
 * replaces.
 * @param {{ store?: NoticeStore, audit?: (session: { id?: string } | null, type: string, data?: unknown) => void }} [options]
 */
export function createSelectionNotifier({ store, audit: emitAudit = () => {} } = {}) {
  /** @type {Map<string, { net: NetChange, revision: number, present: boolean }>} */
  const mirror = new Map()

  /** @param {string} sessionId */
  const unitOf = sessionId => ({ kind: 'notice', sessionId })

  /**
   * One audit record on the cold-safe channel (D7): counts, never names.
   * @param {string} sessionId @param {string} outcome @param {Record<string, unknown>} [data]
   */
  function note(sessionId, outcome, data = {}) {
    try { emitAudit({ id: sessionId }, AUDIT_TYPES.capabilityNotice, { outcome, ...data }) } catch { /* audit never breaks a turn */ }
  }

  /** @param {string} sessionId @param {{ net: NetChange, revision: number, present: boolean }} entry */
  const remember = (sessionId, entry) => { mirror.set(sessionId, entry) }

  /**
   * Queue a net delta for a session, merged with whatever is already durable.
   * Runs in the publication segment: no await, and a failed write THROWS so the
   * engine can degrade the response (D2). Merging the same delta twice is a
   * no-op — the merge absorbs it, so a double settle can never double-announce.
   * @param {string} sessionId
   * @param {{ added?: string[], removed?: string[] }} delta
   * @param {{ revision?: number }} [info] the accepted revision (diagnosis/audit)
   * @returns {NetChange}
   */
  function queueSync(sessionId, delta, info = {}) {
    const acceptedRevision = typeof info.revision === 'number' ? info.revision : undefined
    if (!store) {
      note(sessionId, 'queue-failed', { status: 'unavailable', revision: acceptedRevision })
      throw new Error('capability notice queue failed: unavailable')
    }
    // One retry on a lost CAS race (a foreign writer landed between read and
    // write); every other outcome fails loudly on the first attempt.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let record
      try {
        record = store.readSync(unitOf(sessionId))
      } catch (error) {
        note(sessionId, 'queue-failed', { status: 'read-failed', revision: acceptedRevision })
        throw new Error(`capability notice queue failed: read-failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (record.kind !== 'ok' && record.kind !== 'absent') {
        // Never repaired by a rewrite: a damaged unit is reported and left alone.
        note(sessionId, 'queue-failed', { status: record.kind, revision: acceptedRevision })
        throw new Error(`capability notice queue failed: ${record.kind}`)
      }
      const previous = record.kind === 'ok' ? noticeNet(record.payload) : NO_CHANGES
      const merged = mergeNetChanges(previous, delta)
      if (sameNet(merged, previous)) {
        // Nothing changed (an absorbed re-queue): no write, no revision bump.
        remember(sessionId, { net: merged, revision: record.kind === 'ok' ? record.revision : 0, present: record.kind === 'ok' })
        note(sessionId, 'queued', { added: merged.added.length, removed: merged.removed.length, revision: acceptedRevision })
        return merged
      }
      const result = store.commitSync(unitOf(sessionId), record.kind === 'ok' ? record.revision : 0, () => merged)
      if (result.status === 'committed') {
        remember(sessionId, { net: merged, revision: result.revision, present: true })
        note(sessionId, 'queued', { added: merged.added.length, removed: merged.removed.length, revision: acceptedRevision })
        return merged
      }
      if (result.status === 'revision-conflict' && attempt === 0) continue
      note(sessionId, 'queue-failed', { added: merged.added.length, removed: merged.removed.length, status: result.status, revision: acceptedRevision })
      throw new Error(`capability notice queue failed: ${result.status}`)
    }
    /* c8 ignore next */
    throw new Error('capability notice queue failed: unsettled')
  }

  /**
   * Load what the durable unit says about this session, distinguishing the three
   * outcomes the boundary must not conflate (D5): nothing owed, an obligation,
   * or a unit that cannot be read. Never throws — a read failure is reported and
   * delivers nothing, because the notice is advisory and must not block a
   * request. One cold read per session per process, then the mirror.
   * @param {string} sessionId
   * @returns {Promise<{ kind: 'owed', net: NetChange, revision: number } | { kind: 'none' } | { kind: 'unreadable', status: string }>}
   */
  async function loadPending(sessionId) {
    const cached = mirror.get(sessionId)
    if (cached) return cached.present && !isEmptyNet(cached.net)
      ? { kind: 'owed', net: cached.net, revision: cached.revision }
      : { kind: 'none' }
    if (!store) return { kind: 'none' }
    let record
    try {
      record = await store.read(unitOf(sessionId))
    } catch {
      note(sessionId, 'unreadable', { status: 'read-failed' })
      return { kind: 'unreadable', status: 'read-failed' }
    }
    // The platform gate is not an error: no durable queue exists, and no
    // accepted selection can owe a notice here (the same store backs Apply).
    if (record.kind === 'unsupported') return { kind: 'none' }
    if (record.kind !== 'ok' && record.kind !== 'absent') {
      // Delivered nothing, deleted nothing: reported, never repaired.
      note(sessionId, 'unreadable', { status: record.kind })
      return { kind: 'unreadable', status: record.kind }
    }
    const present = record.kind === 'ok'
    const net = present ? noticeNet(record.payload) : NO_CHANGES
    remember(sessionId, { net, revision: present ? record.revision : 0, present })
    return present && !isEmptyNet(net) ? { kind: 'owed', net, revision: record.revision } : { kind: 'none' }
  }

  /**
   * The obligation owed to this session right now, or null when nothing is owed
   * (absent unit, an empty unit, an unsupported store). A unit that cannot be
   * read also answers null — `deliver` reports that case separately.
   * @param {string} sessionId
   * @returns {Promise<PendingNotice | null>}
   */
  async function pending(sessionId) {
    const state = await loadPending(sessionId)
    return state.kind === 'owed' ? { ...state.net, revision: state.revision } : null
  }

  /**
   * Subtract exactly the delivered names (D4). A lost CAS race is retried once
   * against a fresh read — that retry is what preserves a concurrent Apply's
   * delta; a second conflict (or any other failure) leaves the pending intact,
   * which repeats a notice rather than losing one.
   * @param {string} sessionId
   * @param {{ added?: string[], removed?: string[] }} delivered
   * @param {{ revision?: number }} [info] the revision observed when delivering
   * @returns {Promise<{ status: string, revision?: number, kind?: string }>}
   */
  async function clearDelivered(sessionId, delivered, info = {}) {
    if (!store) return { status: 'unsupported' }
    const owed = noticeNet(delivered)
    /** @type {number | null} */
    let expected = typeof info.revision === 'number' ? info.revision : null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (expected === null) {
        let record
        try {
          record = await store.read(unitOf(sessionId))
        } catch {
          note(sessionId, 'clear-failed', { status: 'read-failed' })
          return { status: 'read-failed' }
        }
        if (record.kind === 'unsupported') return { status: 'unsupported' }
        if (record.kind === 'absent') {
          remember(sessionId, { net: NO_CHANGES, revision: 0, present: false })
          return { status: 'absent' }
        }
        if (record.kind !== 'ok') {
          note(sessionId, 'clear-failed', { status: record.kind })
          return { status: 'unreadable', kind: record.kind }
        }
        // An empty obligation needs no write at all.
        if (isEmptyNet(noticeNet(record.payload))) {
          remember(sessionId, { net: NO_CHANGES, revision: record.revision, present: true })
          return { status: 'empty', revision: record.revision }
        }
        expected = record.revision
      }
      const result = await store.commit(unitOf(sessionId), expected, previous => subtractDelivered(noticeNet(previous), owed))
      if (result.status === 'committed') {
        remember(sessionId, { net: noticeNet(result.payload), revision: result.revision, present: true })
        note(sessionId, 'cleared', { added: owed.added.length, removed: owed.removed.length, revision: result.revision })
        return { status: 'cleared', revision: result.revision }
      }
      if (result.status === 'revision-conflict' && attempt === 0) {
        expected = null
        continue
      }
      note(sessionId, 'clear-failed', { added: owed.added.length, removed: owed.removed.length, status: result.status })
      return { status: result.status }
    }
    /* c8 ignore next */
    return { status: 'unsettled' }
  }

  /**
   * Deliver the pending notice into the session's next request boundary:
   * read → build → inject → clear (D4). The obligation is cleared only after the
   * message landed, so a failed injection leaves it for the next boundary — the
   * old consume-before-push lost it silently.
   * @param {string} sessionId @param {unknown[] | unknown} messages
   * @returns {Promise<'absent'|'delivered'|'injection-failed'|'clear-failed'|'unreadable'>}
   */
  async function deliver(sessionId, messages) {
    const state = await loadPending(sessionId)
    // A unit that cannot be read delivers nothing and deletes nothing (D5).
    if (state.kind === 'unreadable') return 'unreadable'
    // Nothing owed — including an empty unit, which holds no names to clear.
    if (state.kind !== 'owed') return 'absent'
    const owed = state.net
    const text = notificationText(owed)
    /* c8 ignore next */
    if (text === null) return 'absent'
    try {
      if (!Array.isArray(messages)) throw new TypeError('messages is not an array')
      messages.push(userTextMessage(text, NOTIFY_SOURCE))
    } catch (error) {
      note(sessionId, 'injection-failed', { added: owed.added.length, removed: owed.removed.length, status: error instanceof Error ? error.message : String(error) })
      return 'injection-failed'
    }
    note(sessionId, 'delivered', { added: owed.added.length, removed: owed.removed.length })
    const cleared = await clearDelivered(sessionId, owed, { revision: owed.revision })
    return cleared.status === 'cleared' || cleared.status === 'absent' || cleared.status === 'empty' ? 'delivered' : 'clear-failed'
  }

  /**
   * Synchronous diagnostic: is a notice queued for this session? Answers from
   * the mirror, else from one synchronous read — never a stale cache guess.
   * @param {string} sessionId
   */
  function has(sessionId) {
    const cached = mirror.get(sessionId)
    if (cached) return cached.present && !isEmptyNet(cached.net)
    if (!store) return false
    let record
    try { record = store.readSync(unitOf(sessionId)) } catch { return false }
    return record.kind === 'ok' && !isEmptyNet(noticeNet(record.payload))
  }

  return { queueSync, pending, clearDelivered, deliver, has }
}
