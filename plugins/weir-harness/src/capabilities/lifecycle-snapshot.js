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
// 6.1 — in-memory snapshot: accepted selections are loaded into memory at
// plugin apply (lifecycle-preload.js) and after every Apply acceptance (the
// apply-engine publishSnapshot hook, invoked inside the same non-async
// segment as the internal snapshot swap). The listener reads the memory
// snapshot synchronously (measured ≈0.2 ms in G4b); on a memory miss it
// falls back to ONE blocking synchronous read of the session record (never
// the host storageDomain — a promise interface, unusable here, CITED).
//
// 6.2 — synchronous durable capture: a subagent's inherited snapshot is
// written inside the listener with writeFileSync + fsyncSync through the
// group-2 unit layout (sessions/<sessionId>/inherited.json, own lock and
// revision) and the group-2 lock convention (private candidate + fsync +
// link publication, OwnerDoc schema, remove-only-if-ours release). A lock
// conflict fails the capture — the synchronous listener cannot run the
// async reclamation protocol, so contention fails closed instead of
// blocking the event loop on backoff sleeps.
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
//   fallback; the original file is never rewritten.
// - resume/fork incarnation (depth 0 yet a parentSession header): the named
//   parent's accepted snapshot is captured best-effort under the SAME root
//   rule — a failed capture never throws and never rejects the session; the
//   session runs BLOCKED like an unreadable root record, with the manager
//   naming an explicit Apply as the recovery gesture.
// - subagent (one-shot / background / supervised member / escalation /
//   fork child): a parent snapshot that cannot be read, or a capture that
//   cannot be written, makes the listener THROW. The host dispatches
//   agent/created serially and a listener failure rejects the creation, so
//   throwing is the INTENTIONAL bail that refuses the subagent while the
//   parent session continues and learns the reason through the delegation
//   result. Never an unrestricted pass.
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isSegment, resolveStoreRoot, unitLayout } from './store/paths.js'
import { decodeRecord, encodeRecord } from './store/record.js'
import { LOCK_SCHEMA_VERSION, parseOwnerDoc } from './store/lock.js'
import { skillIdentityKey } from './skill-identity.js'
import { SUPPORTED_PLATFORMS } from './store/store.js'

/** origin marker of a captured inherited snapshot payload. */
export const INHERITED_ORIGIN = 'inherited'
/** Nominal lease of the synchronously acquired capture lock (released immediately). */
export const SYNC_LOCK_LEASE_MS = 10_000

/**
 * @typedef {{ state: 'ready', sessionId: string, revision: number, skills: unknown[], mcpServers: string[],
 *   captured: { parentSessionId: string, parentRevision: number | null, capturedAt: number } | null }} ReadySnapshot
 * @typedef {{ state: 'blocked', sessionId: string, reason: 'corrupt'|'unknown-schema'|'torn'|'unreadable' }} BlockedSnapshot
 * @typedef {ReadySnapshot | BlockedSnapshot} LifecycleSnapshot
 * @typedef {{ revision: number, skills?: unknown[], mcpServers?: string[],
 *   captured?: { parentSessionId: string, parentRevision: number | null, capturedAt: number } | null }} SnapshotInput
 */

/** @param {unknown} error @param {...string} codes */
const hasCode = (error, ...codes) => codes.includes(/** @type {{ code?: string }} */ (error)?.code ?? '')

/** @param {unknown} error */
const message = error => (error instanceof Error ? error.message : String(error))

/** fsync one file (mirrors the group-2 fs-adapter fsyncFile step). @param {string} path */
function fsyncPath(path) {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** fsync one directory entry change (mirrors the fs-adapter fsyncDir step). @param {string} dir */
function fsyncDirectory(dir) {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * In-memory lifecycle snapshots plus the synchronous read/capture paths.
 * Resolution mirrors the group-2 store exactly: root from `profileContext`
 * (or an explicit test root), the same platform gate, the same unit layout
 * and record schema — never a parallel layout.
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
  const platform = options.platform ?? process.platform
  const located = typeof options.root === 'string' ? { supported: true, root: options.root } : resolveStoreRoot(options.profileContext)
  /** @type {{ supported: true, root: string } | { supported: false, reason: string }} */
  const support = !SUPPORTED_PLATFORMS.includes(platform)
    ? { supported: false, reason: `platform-unsupported:${platform}` }
    : /** @type {any} */ (located)
  /** @type {Map<string, LifecycleSnapshot>} */
  const snapshots = new Map()

  /**
   * @param {'selection'|'inherited'} kind @param {string} sessionId
   * @returns {{ dir: string, record: string, name: string }}
   */
  function locate(kind, sessionId) {
    const layout = unitLayout(/** @type {import('./store/paths.js').Unit} */ ({ kind, sessionId }))
    const dir = join(/** @type {{ root: string }} */ (support).root, ...layout.segments)
    return { dir, record: join(dir, `${layout.name}.json`), name: layout.name }
  }

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
   * miss performs ONE blocking synchronous read of the durable record —
   * never a promise, never a yield. An absent record returns null (no
   * accepted selection; initialization priority for brand-new root
   * sessions is task 6.5). An undecodable record becomes BLOCKED.
   * @param {string} sessionId
   * @returns {LifecycleSnapshot | null}
   */
  function snapshotFor(sessionId) {
    const memory = snapshots.get(sessionId)
    if (memory) return memory
    if (!support.supported) return null
    const { record } = locate('selection', sessionId)
    let text
    try {
      text = readFileSync(record, 'utf8')
    } catch (error) {
      // No accepted record yet — a legitimate cold state, not a failure.
      if (hasCode(error, 'ENOENT')) return null
      // EACCES and friends: the record exists but cannot be read — fail
      // closed BLOCKED (6.4), never a guessed full authorization.
      return markBlocked(sessionId, 'unreadable')
    }
    const decoded = decodeRecord(text)
    if (decoded.kind === 'ok') {
      const payload = /** @type {Record<string, unknown>} */ (decoded.payload ?? {})
      return publish(sessionId, {
        revision: decoded.revision,
        skills: Array.isArray(payload.skills) ? payload.skills : [],
        mcpServers: Array.isArray(payload.mcpServers) ? /** @type {string[]} */ (payload.mcpServers) : [],
      })
    }
    // corrupt / unknown-schema / torn: fail closed BLOCKED (6.4 root rule).
    // The original file is never rewritten from this path.
    return markBlocked(sessionId, decoded.kind)
  }

  /**
   * Synchronous acquisition of `<unit>.lock` through the group-2 lock
   * convention: private candidate + fsync + link publication (never
   * wx-then-write, which strands 0-byte locks on crash), OwnerDoc schema,
   * remove-only-if-ours release. A conflict fails the capture immediately:
   * the listener cannot run the async reclamation protocol without
   * yielding, so contention fails closed.
   * @param {string} dir @param {string} name @returns {string} owner token
   */
  function acquireLockSync(dir, name) {
    const token = randomBytes(12).toString('hex')
    const lockFile = join(dir, `${name}.lock`)
    const candidate = `${lockFile}.${token}.cand`
    const at = now()
    const doc = {
      schemaVersion: LOCK_SCHEMA_VERSION,
      ownerToken: token,
      pid: process.pid,
      host: hostname(),
      startIdentity: { osStart: null, bootNonce: 'sync-capture' },
      acquiredAt: at,
      leaseUntil: at + SYNC_LOCK_LEASE_MS,
    }
    try {
      writeFileSync(candidate, JSON.stringify(doc), { mode: 0o600 })
      fsyncPath(candidate)
      linkSync(candidate, lockFile)
    } catch (error) {
      if (hasCode(error, 'EEXIST')) throw new Error(`inherited snapshot capture lost the lock race for unit "${name}"`, { cause: error })
      if (hasCode(error, 'ENOENT')) throw new Error(`inherited snapshot capture lock candidate vanished for unit "${name}"`, { cause: error })
      throw error
    } finally {
      try {
        unlinkSync(candidate)
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) warn(`inherited snapshot capture candidate cleanup failed: ${message(error)}`)
      }
    }
    return token
  }

  /** Remove `<unit>.lock` only while it still names our token (mirrors releaseOwned). @param {string} dir @param {string} name @param {string} token */
  function releaseLockSync(dir, name, token) {
    const lockFile = join(dir, `${name}.lock`)
    try {
      const doc = parseOwnerDoc(readFileSync(lockFile, 'utf8'))
      if (doc.kind === 'ok' && doc.value.ownerToken !== token) return
      unlinkSync(lockFile)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) warn(`inherited snapshot capture lock release failed: ${message(error)}`)
    }
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

  /** String-set counterpart for managed MCP identities. @param {unknown} values @param {unknown} allowed @returns {string[]} */
  function intersectStrings(values, allowed) {
    const keep = new Set(Array.isArray(allowed) ? allowed : [])
    return (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && keep.has(value))
  }

  /**
   * Durably capture a subagent's inherited snapshot (6.2), synchronously.
   * The inherited sets follow creation-time inheritance (6.3): verbatim
   * parent at creation, child-previous ∩ current-parent on an explicit
   * resume/escalation, narrowed by delegation constraints — never widened.
   * A parent without any accepted record yields
   * an empty inherited set (the no-policy initialization priority of task
   * 6.5 is a root-session concern layered above this mechanism).
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
    const { dir, record, name } = locate('inherited', childSessionId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const token = acquireLockSync(dir, name)
    try {
      // Same-unit CAS discipline, synchronously: decode the current record
      // under the lock and write the NEXT revision. A record that cannot be
      // decoded fails closed — it is never overwritten from this path.
      let current
      try {
        current = decodeRecord(readFileSync(record, 'utf8'))
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error
        current = /** @type {import('./store/record.js').RecordRead} */ ({ kind: 'absent', revision: 0 })
      }
      if (current.kind !== 'absent' && current.kind !== 'ok') {
        throw new Error(`existing inherited snapshot of "${childSessionId}" is ${current.kind}; refusing to overwrite it`)
      }
      const revision = current.revision + 1
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
      // Atomic commit through the group-2 record schema: temp + fsync +
      // rename + directory fsync. A rename failure is INDETERMINATE — the
      // record may or may not have landed — so the capture fails and the
      // subagent creation is refused; a later explicit resume recaptures.
      const next = encodeRecord(revision, payload, [])
      const temp = join(dir, `${name}.${token}.tmp`)
      try {
        writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
        fsyncPath(temp)
      } catch (error) {
        try {
          unlinkSync(temp)
        } catch { /* best effort */ }
        throw new Error(`inherited snapshot capture write failed for subagent "${childSessionId}": ${message(error)}`, { cause: error })
      }
      try {
        renameSync(temp, record)
        fsyncDirectory(dir)
      } catch (error) {
        try {
          unlinkSync(temp)
        } catch { /* best effort */ }
        throw new Error(`inherited snapshot capture commit failed for subagent "${childSessionId}": ${message(error)}`, { cause: error })
      }
      return publish(childSessionId, {
        revision,
        skills: payload.skills,
        mcpServers: payload.mcpServers,
        captured: { parentSessionId, parentRevision: payload.parent.revision, capturedAt },
      })
    } finally {
      releaseLockSync(dir, name, token)
    }
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
        // header. The read side demands an inherited snapshot for such a
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
          try {
            captureInherited(sessionId, parentSessionId)
          } catch (captureError) {
            warn(`resume incarnation capture failed for session "${sessionId}": ${message(captureError)}`)
            markBlocked(sessionId, 'unreadable')
          }
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
