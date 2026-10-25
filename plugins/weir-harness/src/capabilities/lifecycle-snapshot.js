// Lifecycle readiness of the session capability manager (design D6, tasks
// 6.1/6.2): the in-memory authority snapshot and the synchronous durable
// capture of inherited subagent snapshots.
//
// G4b (EXECUTED, 266/266) proved the discriminating failure shape is YIELDING
// the event loop, not slowness: a listener sleeping 100 ms broke agent
// creation while a listener busy-waiting 100 ms passed. Every code path in
// this module is therefore fully synchronous — the `agent/created` listener
// never yields: no promise chains, no async helpers, only blocking
// synchronous file I/O where durability is required.
//
// 6.1 — in-memory snapshot: the session's EFFECTIVE capability set is loaded
// into memory at plugin apply (lifecycle-preload.js) and after every Apply
// acceptance (the apply-engine publishSnapshot hook, invoked inside the same
// non-async segment as the internal snapshot swap). The listener reads the
// memory snapshot synchronously (measured ≈0.2 ms in G4b); on a memory miss it
// falls back to blocking synchronous reads of the session records — the
// accepted selection FIRST, then the durable inherited snapshot when no
// accepted record exists (a fork of a fork, a resumed incarnation), never the
// host storageDomain (a promise interface, unusable here, CITED).
//
// 6.2 — synchronous durable capture: a subagent's inherited snapshot is
// written inside the listener through the capability store's SYNC commit path
// (store/store.js commitSync — the group-2 unit layout, record schema, fsync
// order and the nominal-lease sync lock of store/lock.js, all shared with the
// async path; capabilities-deepening D4 retired this module's private
// reimplementation of exactly those conventions). A lock conflict fails the
// capture — the synchronous listener cannot run the async reclamation
// protocol, so contention fails closed instead of blocking the event loop on
// backoff sleeps.
//
// The capture is NOT ATOMIC with the host's session publication: the host
// writing the child session header and this plugin writing the snapshot are
// two separate durable acts, and a crash between them leaves a child
// session without a snapshot. A later explicit resume of such a child hits
// the subagent fail-closed rule below (the listener throws, that resume is
// refused, the parent session is informed) — stated honestly, never hidden.
//
// Fail-closed rules (6.4; exactly one rule per case):
// - root / existing session: a selection record that cannot be read or
//   decoded does NOT throw — the session is created/resumed as usual and
//   the memory snapshot becomes BLOCKED (empty Skill view, all managed MCP
//   calls refused, recovery entry visible). Never a full-discovery
//   fallback; the original file is never rewritten. An inherited record is
//   consulted ONLY when no accepted record exists, and an existing record
//   that cannot be decoded blocks just as hard — a corrupt higher-priority
//   record is never skipped in favour of a lower-priority one or of the
//   initial baseline.
// - resume/fork incarnation (depth 0 yet a parentSession header): the named
//   parent's EFFECTIVE snapshot (accepted, inherited, or the already-resolved
//   initial one) is captured best-effort under the SAME root rule — a failed
//   capture never throws and never rejects the session; the session runs
//   BLOCKED like an unreadable root record, with the manager naming an
//   explicit Apply as the recovery gesture. A parent with NO effective
//   snapshot at all (proven absent on supported storage) is not an empty
//   set: the capture is skipped and the fork resolves the ordinary root
//   initialization policy for itself.
// - subagent (one-shot / background / supervised member / escalation; a
//   depth-0 fork child is handled by the incarnation rule above): a parent
//   snapshot that cannot be read, or a capture that cannot be written, makes
//   the listener THROW. The host dispatches agent/created serially and a
//   listener failure rejects the creation, so throwing is the INTENTIONAL
//   bail that refuses the subagent while the parent session continues and
//   learns the reason through the delegation result. Never an unrestricted
//   pass, and never the root-initialization fallback (that is a depth-0 fork
//   affordance only).
import { isSegment } from './store/paths.js'
import { openCapabilityStore } from './store/store.js'
import { skillIdentityKey } from './skill-identity.js'

/** origin marker of a captured inherited snapshot payload. */
export const INHERITED_ORIGIN = 'inherited'

/**
 * @typedef {{ state: 'ready', sessionId: string, revision: number, skills: unknown[], mcpServers: string[],
 *   captured: { parentSessionId: string, parentRevision: number | null, capturedAt: number } | null }} ReadySnapshot
 * @typedef {{ state: 'blocked', sessionId: string, reason: 'corrupt'|'unknown-schema'|'torn'|'unreadable' }} BlockedSnapshot
 * @typedef {ReadySnapshot | BlockedSnapshot} LifecycleSnapshot
 * @typedef {{ revision: number, skills?: unknown[], mcpServers?: string[],
 *   captured?: { parentSessionId: string, parentRevision: number | null, capturedAt: number } | null }} SnapshotInput
 */

/** @param {unknown} error */
const message = error => (error instanceof Error ? error.message : String(error))

/**
 * In-memory lifecycle snapshots plus the synchronous read/capture paths.
 * All durable I/O delegates to the capability store's sync path: the same
 * root resolution (from `profileContext` or an explicit test root), the same
 * platform gate, the same unit layout and record schema — never a parallel
 * layout.
 * @param {{
 *   profileContext?: unknown,
 *   root?: string,
 *   platform?: string,
 *   warn?: (text: string) => void,
 *   now?: () => number,
 * }} [options]
 */
export function createLifecycleSnapshots(options = {}) {
  const warn = options.warn ?? (() => {})
  const now = options.now ?? Date.now
  const store = openCapabilityStore({
    root: options.root,
    platform: options.platform,
    profileContext: options.profileContext,
    now,
  })
  const support = store.support
  /** @type {Map<string, LifecycleSnapshot>} */
  const snapshots = new Map()

  /**
   * Publish an accepted selection into the memory snapshot. Called at
   * plugin apply (preload), after every Apply acceptance (the engine's
   * publishSnapshot hook) and by the synchronous disk-read miss path.
   * The stored snapshot is frozen; readers never receive mutable state.
   * @param {string} sessionId @param {SnapshotInput} next
   * @returns {ReadySnapshot}
   */
  function publish(sessionId, next) {
    if (!isSegment(sessionId)) throw new TypeError(`invalid lifecycle snapshot session: ${JSON.stringify(sessionId)}`)
    if (!Number.isSafeInteger(next?.revision) || /** @type {number} */ (next?.revision) < 0) {
      throw new TypeError(`invalid lifecycle snapshot revision: ${JSON.stringify(next?.revision)}`)
    }
    /** @type {ReadySnapshot} */
    const snapshot = Object.freeze({
      state: 'ready',
      sessionId,
      revision: next.revision,
      skills: Object.freeze(structuredClone(Array.isArray(next.skills) ? next.skills : [])),
      mcpServers: Object.freeze((Array.isArray(next.mcpServers) ? next.mcpServers : []).slice()),
      captured: next.captured ? Object.freeze({ ...next.captured }) : null,
    })
    snapshots.set(sessionId, snapshot)
    return snapshot
  }

  /**
   * Pin the fail-closed BLOCKED marker (6.4 root-session rule): an
   * unreadable/corrupt/unknown-schema/torn record yields an empty Skill
   * view and refused managed MCP calls, never a full-discovery fallback.
   * @param {string} sessionId @param {BlockedSnapshot['reason']} reason
   * @returns {BlockedSnapshot}
   */
  function markBlocked(sessionId, reason) {
    if (!isSegment(sessionId)) throw new TypeError(`invalid lifecycle snapshot session: ${JSON.stringify(sessionId)}`)
    /** @type {BlockedSnapshot} */
    const snapshot = Object.freeze({ state: 'blocked', sessionId, reason })
    snapshots.set(sessionId, snapshot)
    return snapshot
  }

  /** Memory-only lookup (6.3 inheritance checks; preload freshness guard). @param {string} sessionId @returns {LifecycleSnapshot | null} */
  function peek(sessionId) {
    return snapshots.get(sessionId) ?? null
  }

  /**
   * THE synchronous read path (6.1): memory hit returns immediately; a
   * miss performs blocking synchronous reads of the durable records — the
   * store's sync read, never a promise, never a yield. The effective snapshot
   * is the accepted selection when one exists, otherwise the durable inherited
   * snapshot (a fork whose source only ever resolved an initial set, or a fork
   * of a fork). An absent pair returns null (no effective snapshot; the fork's
   * own root initialization is layered above this mechanism). Any record that
   * exists and does not decode becomes BLOCKED — a corrupt higher-priority
   * record never falls through to a lower-priority one.
   * @param {string} sessionId
   * @returns {LifecycleSnapshot | null}
   */
  function snapshotFor(sessionId) {
    const memory = snapshots.get(sessionId)
    if (memory) return memory
    if (!support.supported) return null
    let record
    try {
      record = store.readSync({ kind: 'selection', sessionId })
    } catch {
      // EACCES and friends: the record exists but cannot be read — fail
      // closed BLOCKED (6.4), never a guessed full authorization.
      return markBlocked(sessionId, 'unreadable')
    }
    if (record.kind === 'ok') {
      const payload = /** @type {Record<string, unknown>} */ (record.payload ?? {})
      return publish(sessionId, {
        revision: record.revision,
        skills: Array.isArray(payload.skills) ? payload.skills : [],
        mcpServers: Array.isArray(payload.mcpServers) ? /** @type {string[]} */ (payload.mcpServers) : [],
      })
    }
    // corrupt / unknown-schema / torn / unsupported: fail closed BLOCKED
    // (6.4 root rule). The original file is never rewritten from this path.
    if (record.kind !== 'absent') return markBlocked(sessionId, /** @type {BlockedSnapshot['reason']} */ (record.kind))
    // No accepted record — a legitimate cold state. The EFFECTIVE set may still
    // be the durable inherited snapshot this session was created with.
    return snapshotFromInherited(sessionId)
  }

  /**
   * The inherited fallback of {@link snapshotFor}: no accepted record exists,
   * so the effective set is whatever durable inheritance the session was given
   * at creation. The snapshot keeps the inherited revision and restores the
   * parent/captured metadata — it is NEVER reported as an accepted revision
   * (the receipt's CAS token stays accepted-only, 0 when absent). A record
   * that exists but does not decode blocks exactly like a corrupt selection
   * record: no fall-through to the initial baseline.
   * @param {string} sessionId
   * @returns {LifecycleSnapshot | null}
   */
  function snapshotFromInherited(sessionId) {
    let inherited
    try {
      inherited = store.readSync({ kind: 'inherited', sessionId })
    } catch {
      return markBlocked(sessionId, 'unreadable')
    }
    if (inherited.kind !== 'ok') {
      if (inherited.kind === 'absent') return null
      return markBlocked(sessionId, /** @type {BlockedSnapshot['reason']} */ (inherited.kind))
    }
    const payload = /** @type {Record<string, unknown>} */ (inherited.payload ?? {})
    const parent = /** @type {Record<string, unknown> | null} */ (
      payload.parent && typeof payload.parent === 'object' ? payload.parent : null)
    const capturedAt = typeof payload.capturedAt === 'number' && Number.isFinite(payload.capturedAt) ? payload.capturedAt : 0
    return publish(sessionId, {
      revision: inherited.revision,
      skills: Array.isArray(payload.skills) ? payload.skills : [],
      mcpServers: Array.isArray(payload.mcpServers) ? /** @type {string[]} */ (payload.mcpServers) : [],
      captured: parent && typeof parent.sessionId === 'string' && parent.sessionId.length > 0
        ? {
          parentSessionId: parent.sessionId,
          parentRevision: Number.isSafeInteger(parent.revision) ? /** @type {number} */ (parent.revision) : null,
          capturedAt,
        }
        : null,
    })
  }

  /**
   * Creation-time inheritance (6.3). The base is the parent's accepted set
   * VERBATIM at creation, or the child's own previous snapshot on an explicit
   * resume/escalation — intersected with the CURRENT parent accepted set,
   * then narrowed by the delegation constraints (read-only/tool/depth).
   * Intersection only: a resumed subagent never regains a capability the
   * parent removed, never receives one the parent added later, constraints
   * never widen, and a live subagent's snapshot is simply never recomputed
   * (messaging a live child produces no agent/created, so no recapture).
   * @param {unknown[]} parentSkills @param {unknown[] | null} previousChildSkills
   * @param {{ allowSkills?: unknown[] }} [constraints]
   * @returns {unknown[]}
   */
  function deriveInheritedSkills(parentSkills, previousChildSkills, constraints = {}) {
    const parent = Array.isArray(parentSkills) ? parentSkills : []
    const base = previousChildSkills == null ? parent.slice() : intersectIdentities(previousChildSkills, parent)
    if (!Array.isArray(constraints.allowSkills)) return base
    return intersectIdentities(base, constraints.allowSkills)
  }

  /** @param {unknown[]} skills @param {unknown[]} allowed @returns {unknown[]} */
  function intersectIdentities(skills, allowed) {
    const keys = new Set()
    for (const identity of Array.isArray(allowed) ? allowed : []) {
      try { keys.add(skillIdentityKey(identity)) } catch { /* unidentifiable entries cannot authorize */ }
    }
    return (Array.isArray(skills) ? skills : []).filter(identity => {
      try { return keys.has(skillIdentityKey(identity)) } catch { return false }
    })
  }

  /** String-set counterpart for managed MCP identities. @param {unknown[]} values @param {unknown[]} allowed @returns {string[]} */
  function intersectStrings(values, allowed) {
    const keep = new Set(Array.isArray(allowed) ? allowed : [])
    return (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && keep.has(value))
  }

  /**
   * Durably capture a session's inherited snapshot (6.2), synchronously.
   * The inherited sets follow creation-time inheritance (6.3): verbatim
   * parent at creation, child-previous ∩ current-parent on an explicit
   * resume/escalation, narrowed by delegation constraints — never widened.
   * The parent's EFFECTIVE set is its accepted selection when one exists,
   * otherwise its own inherited snapshot (a fork of a fork). A parent with NO
   * effective snapshot at all is not an empty inheritance: the depth-0 fork
   * caller skips this capture entirely (see `agentCreated`) and lets that fork
   * run the ordinary root initialization instead.
   *
   * NOT ATOMIC with the host's session publication (see the module header):
   * a crash between the two durable acts leaves a child session without a
   * snapshot, which a later explicit resume settles through the subagent
   * fail-closed rule.
   * @param {string} childSessionId @param {string} parentSessionId
   * @param {{ allowSkills?: unknown[], allowMcpServers?: string[] }} [constraints] delegation constraints (6.3): intersection only, never a widening
   * @returns {ReadySnapshot}
   */
  function captureInherited(childSessionId, parentSessionId, constraints = {}) {
    if (!isSegment(childSessionId)) throw new TypeError(`invalid inherited snapshot session: ${JSON.stringify(childSessionId)}`)
    if (childSessionId === parentSessionId) throw new Error(`inherited snapshot capture refused: session "${childSessionId}" cannot inherit from itself`)
    const parent = snapshotFor(parentSessionId)
    if (parent?.state === 'blocked') {
      throw new Error(`parent snapshot of "${parentSessionId}" is unreadable (${parent.reason}); refusing to capture the inherited snapshot of subagent "${childSessionId}"`)
    }
    if (!support.supported) {
      throw new Error(`inherited snapshot capture unsupported for subagent "${childSessionId}": ${support.reason}`)
    }
    // Same-unit CAS discipline, synchronously through the store's sync commit
    // path: the record decodes under the store's sync lock and the next
    // revision commits only over the exact expected one. A record that cannot
    // be decoded fails closed — it is never overwritten from this path.
    const unit = { kind: 'inherited', sessionId: childSessionId }
    const current = store.readSync(unit)
    if (current.kind !== 'absent' && current.kind !== 'ok') {
      throw new Error(`existing inherited snapshot of "${childSessionId}" is ${current.kind}; refusing to overwrite it`)
    }
    const capturedAt = now()
    // 6.3: an existing record means an explicit resume/escalation — the
    // child's previous snapshot intersected with the CURRENT parent set
    // (removed capabilities never return, added ones never arrive). A fresh
    // capture starts from the parent verbatim. Constraints narrow further.
    const previousSkills = current.kind === 'ok'
      ? (Array.isArray(/** @type {Record<string, unknown>} */ (current.payload)?.skills) ? /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (current.payload).skills) : [])
      : null
    const parentSkills = parent ? parent.skills : []
    const skills = deriveInheritedSkills(parentSkills, previousSkills, constraints)
    const parentMcp = parent ? parent.mcpServers : []
    const previousMcp = current.kind === 'ok' && Array.isArray(/** @type {Record<string, unknown>} */ (current.payload)?.mcpServers)
      ? /** @type {string[]} */ (/** @type {Record<string, unknown>} */ (current.payload).mcpServers)
      : null
    let mcpServers = previousMcp == null ? parentMcp.slice() : intersectStrings(previousMcp, parentMcp)
    if (Array.isArray(constraints.allowMcpServers)) mcpServers = intersectStrings(mcpServers, constraints.allowMcpServers)
    const payload = {
      skills: structuredClone(skills),
      mcpServers,
      origin: INHERITED_ORIGIN,
      parent: { sessionId: parentSessionId, revision: parent ? parent.revision : null },
      capturedAt,
    }
    // The store's sync commit performs the temp+fsync+rename+directory-fsync
    // sequence under the sync lock. A non-committed outcome (lock contention,
    // a CAS race, a failed write) fails the capture and refuses the subagent
    // creation; a later explicit resume recaptures.
    const result = store.commitSync(unit, current.kind === 'ok' ? current.revision : 0, () => payload)
    if (result.status !== 'committed') {
      const reason = /** @type {{ reason?: unknown }} */ (result).reason ?? result.status
      throw new Error(`inherited snapshot capture failed for subagent "${childSessionId}": ${reason}`)
    }
    return publish(childSessionId, {
      revision: result.revision,
      skills: payload.skills,
      mcpServers: payload.mcpServers,
      captured: { parentSessionId, parentRevision: payload.parent.revision, capturedAt },
    })
  }

  return {
    support,
    publish,
    markBlocked,
    peek,
    snapshotFor,
    captureInherited,
    /**
     * The `agent/created` listener entry (6.1/6.2). Fully synchronous —
     * the host dispatches serially with bail-on-value semantics, so every
     * success path returns undefined (a truthy value would cut off every
     * listener row registered after this one, lesson e3182af) and only the
     * subagent fail-closed paths throw — an INTENTIONAL bail that rejects
     * that subagent's creation (6.4 rule), never a silent unrestricted pass.
     * @param {{ agent?: any }} payload
     * @returns {undefined}
     */
    agentCreated(payload) {
      const session = payload?.agent?.session
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      if ((session.header?.delegationDepth ?? 0) === 0) {
        // Root / existing session: synchronous read only. An undecodable
        // record becomes BLOCKED inside snapshotFor — this path NEVER throws.
        const own = snapshotFor(sessionId)
        // Resume/fork incarnation (D1): depth zero yet a parentSession
        // header. The read side demands an effective snapshot for such a
        // session exactly when it carries NO accepted record of its own, so
        // the capture side aligns with that gate: an incarnation WITH its
        // own accepted record keeps it verbatim (an explicit user Apply is
        // never narrowed by the parent lineage). The capture follows the
        // ROOT failure rule, never the subagent rule below: a failed capture
        // does NOT throw — the session is created and runs BLOCKED like an
        // unreadable root record (6.4), never a full-discovery fallback. A
        // parentSession equal to the session id is no parent (defensive).
        const parentSessionId = session.header?.parentSession
        if (own === null && typeof parentSessionId === 'string' && parentSessionId.length > 0 && parentSessionId !== sessionId) {
          // The fork inherits the source's EFFECTIVE set: accepted, else
          // inherited, else the already-resolved initial snapshot. Only a
          // parent snapshot PROVEN absent (null on supported storage) is not a
          // set to copy — an unsupported store proves nothing, so that case
          // keeps the old attempt-and-block shape instead of silently
          // initializing the fork.
          const parent = snapshotFor(parentSessionId)
          const provenAbsent = parent === null && support.supported
          if (!provenAbsent) {
            try {
              captureInherited(sessionId, parentSessionId)
            } catch (captureError) {
              warn(`resume incarnation capture failed for session "${sessionId}": ${message(captureError)}`)
              markBlocked(sessionId, 'unreadable')
            }
          }
          // provenAbsent: no capture and no empty inherited record. The first
          // readSelection then runs the ordinary root initialization for this
          // depth-0 fork and publishes its own revision-0 snapshot.
        }
        return undefined
      }
      // Subagent: durably capture the inherited snapshot NOW with blocking
      // synchronous I/O. A missing parent linkage is as unreadable as a
      // missing parent snapshot — fail closed by throwing.
      const parentSessionId = session.header?.parentSession
      if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
        throw new Error(`inherited snapshot capture refused: subagent session "${sessionId}" carries no parent session id`)
      }
      captureInherited(sessionId, parentSessionId)
      return undefined
    },
  }
}
