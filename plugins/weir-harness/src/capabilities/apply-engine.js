// Apply engine of the session capability manager (design D2 "Apply 的顺序",
// tasks 4.2). One Apply is a six-step transaction:
//   1. Locate workspace/preset from the AUTHENTICATED SESSION server-side;
//      client-supplied cwd, scope roots and server config are never trusted.
//   2. Validate requestId/payload digest, expected revision, complete
//      inventory, exact identities/conflicts and conformance conditions.
//   3. Prepare a pure snapshot, filtered view and verified content handles;
//      no permission publication, no external installs, no notifications.
//   4. Enter the session admission fence; close the gate and start draining
//      removed managed MCP servers (drain is a stub seam until group 8.6).
//   5. CAS-commit the new selection and receipt through the group-2 store, which
//      reports the payload its CAS replaced — the authority for the net-change
//      notice and for the gate/drain set — then in ONE non-async segment: swap
//      the in-memory snapshot, call the provider's control.invalidate() and
//      release the fence. invalidate()
//      happens before the fence release and before the step-6 response.
//   6. Send the response: accepted revision, effective sets, unresolved
//      warnings and a drain snapshot taken at send time (never awaited).
// Audit and notification are scheduled best-effort after the response; their
// failure never rolls back accepted policy. Commands and audit logs are not
// commit evidence: durable acceptance is only the store record.
// Tasks 4.6 gate capability calls on the fence and the authority snapshot
// exposed here.
import { digestOf } from './store/record.js'
import { isSegment } from './store/paths.js'
import { skillIdentityKey } from './skill-identity.js'
import { validateSkillSelection } from './skill-selection-provider.js'
import { normalizeEnabledSets } from './selection-draft.js'
import { AUDIT_TYPES } from '../shared/audit.js'
import { selectionDelta } from './selection-notify.js'

/** Audit event type (without the 'weir/' prefix) emitted after acceptance.
 * Registered in src/shared/audit.js (AUDIT_TYPES); emit sites never invent
 * string literals and never touch session.append (cold-read red line). */
export const APPLY_AUDIT_TYPE = AUDIT_TYPES.capabilityApply

/**
 * @typedef {import('./skill-selection-provider.js')} SelectionProviderModule
 * @typedef {{ kind: 'skill'|'mcp', ref: string, reason: string }} UnresolvedRef
 * @typedef {{ server: string, state: 'draining'|'settled', inFlight: number }} DrainStatus
 * The engine drain seam (step 4). begin(removed, sessionId) closes the gates
 * of the removed servers FOR THAT SESSION and returns a handle: snapshot()
 * reports the live in-flight counts (sent with the response, never awaited)
 * and abort() reopens exactly the gates begin() closed when the Apply does
 * not commit — abort() and begin() act on the SAME drain, so a failed Apply
 * never leaves a session permanently gated. Production wires the manager's
 * (agent, server)-keyed drain here (createSessionDrainAdapter, mcp-drain.js).
 * @typedef {{ begin(removed: string[], sessionId: string): { snapshot(): DrainStatus[], abort(): void } }} ApplyDrain
 * A step-tagged rejection keeps the old authority and the user's draft.
 * @typedef {{ status: 'applied', revision: number, receipt: unknown, effective: unknown, unresolvedWarnings: UnresolvedRef[], draining?: DrainStatus[], warnings?: string[] }
 *   | { status: 'duplicate', revision: number, receipt: unknown, effective: unknown, warnings?: string[] }
 *   | { status: 'rejected', reason: string, step: number, conflicts?: unknown[], missing?: string[], current?: unknown, receipt?: unknown }
 *   | { status: 'write-failed', step: 5 }
 *   | { status: 'indeterminate', step: 5 }} ApplyResult
 *
 * Receipt query outcome (tasks 4.4). `recovery` reports how a pending
 * indeterminate write of the SAME session was settled by this query:
 * - 'published': the pending receipt was found in a clean record — the write
 *   had landed, so the prepared authority was published and the fence released;
 * - 'not-committed': a digest-verified record WITHOUT the pending receipt
 *   proves the write never landed — drain gates reopen, the fence releases;
 * - 'blocked': the record cannot vouch either way — blocking is maintained.
 * The query never claims a cancellation succeeded and never fabricates a
 * rollback: 'not-committed' describes proven absence, not a revert.
 * @typedef {{ status: 'found', revision: number, receipt: unknown, applied: { skills: unknown[], mcpServers: string[] }, recovery?: 'published'|'not-committed'|'blocked' }
 *   | { status: 'not-found', revision: number|null, recovery?: 'published'|'not-committed'|'blocked' }
 *   | { status: 'rejected', reason: string }} ReceiptQueryResult
 */

const message = error => error instanceof Error ? error.message : String(error)

/**
 * Admission fence (step 4 seam; the real capability-call gating of tasks 4.6
 * and the prompt-publication freeze subscribe to `admit`). While a session's
 * fence is held, admissions for not-yet-handed-off calls are refused. On an
 * indeterminate write the fence stays held: blocking is the conservative
 * state until a receipt query confirms the authority.
 */
export function createAdmissionFence() {
  /** @type {Set<string>} */
  const held = new Set()
  return {
    /**
     * @param {string} scope - session scope to freeze
     * @returns {{ release(): void }}
     */
    enter(scope) {
      if (held.has(scope)) throw new Error(`admission fence already held for ${scope}`)
      held.add(scope)
      let released = false
      return {
        release() {
          if (released) return
          released = true
          held.delete(scope)
        },
      }
    },
    /** @param {string} scope @returns {boolean} whether a not-yet-handed-off call may proceed */
    admit(scope) { return !held.has(scope) },
    /** @param {string} scope */
    isHeld(scope) { return held.has(scope) },
  }
}

/**
 * Drain coordinator for managed MCP servers removed by an Apply: the
 * server-keyed DEFAULT seam implementation (the test surface). Production
 * wires the manager's (agent, server)-keyed drain through
 * createSessionDrainAdapter in mcp-drain.js — the engine passes the session
 * id to begin(), which a server-keyed coordinator simply ignores. Closing a
 * gate is reversible until the commit succeeds: a rejected or failed Apply
 * aborts the closure. In-flight calls are reported, never force-cancelled.
 */
export function createDrainCoordinator() {
  /** @type {Map<string, { closed: boolean, inFlight: Set<Promise<unknown>> }>} */
  const servers = new Map()
  const stateOf = server => {
    if (!servers.has(server)) servers.set(server, { closed: false, inFlight: new Set() })
    return /** @type {{ closed: boolean, inFlight: Set<Promise<unknown>> }} */ (servers.get(server))
  }
  return {
    /**
     * Register an in-flight call a handoff has already admitted. Returns false
     * when the server's gate is closed (the call must be rejected instead).
     * @param {string} server @param {Promise<unknown>} call
     */
    track(server, call) {
      const state = stateOf(server)
      if (state.closed) return false
      state.inFlight.add(call)
      call.catch(() => {}).finally(() => { state.inFlight.delete(call) })
      return true
    },
    /** @param {string} server */
    isClosed(server) { return stateOf(server).closed },
    /** @param {string} server @returns {DrainStatus} */
    status(server) {
      const state = stateOf(server)
      return { server, state: state.inFlight.size ? 'draining' : 'settled', inFlight: state.inFlight.size }
    },
    /**
     * Close the gates of removed servers and start draining.
     * @param {string[]} removed
     * @returns {{ snapshot(): DrainStatus[], abort(): void }}
     */
    begin(removed) {
      const states = removed.map(server => {
        const state = stateOf(server)
        state.closed = true
        return { server, state }
      })
      let aborted = false
      return {
        /** Drain status at the moment of the call; never waits for completion. */
        snapshot() {
          return states.map(({ server, state }) => ({ server, state: state.inFlight.size ? 'draining' : 'settled', inFlight: state.inFlight.size }))
        },
        /** Reopen the gates: the Apply that closed them did not commit. */
        abort() {
          if (aborted) return
          aborted = true
          for (const { state } of states) state.closed = false
        },
      }
    },
  }
}

/**
 * Request digest: the full normalized request payload, so any field change
 * under a reused requestId is a different request (spec: requestId reuse with
 * a changed payload is rejected).
 * @param {{ expectedRevision: number, skills: string[], mcpServers: string[], unresolved: UnresolvedRef[] }} normalized
 */
export function digestApplyRequest(normalized) {
  return digestOf({
    expectedRevision: normalized.expectedRevision,
    skills: normalized.skills,
    mcpServers: normalized.mcpServers,
    unresolved: normalized.unresolved,
  })
}

/**
 * @param {{
 *   store: { read(unit: unknown): Promise<any>, commit(unit: unknown, expectedRevision: number, mutate: (payload: unknown, info: { revision: number }) => unknown, request?: { requestId?: string, requestDigest?: string }): Promise<any> },
 *   locateSession: (authSession: unknown) => Promise<{ sessionId: string, workspaceKey?: string, presetId?: string, cwd?: string } | null> | { sessionId: string, workspaceKey?: string, presetId?: string, cwd?: string } | null,
 *   inventory: (options: { cwd?: string, scope: { session: { id: string } } }) => Promise<{ complete: boolean, candidates: any[] }>,
 *   provider: { acceptSelection(identities: unknown[], options?: unknown): { accepted: boolean, conflicts?: unknown[] } },
 *   fence?: ReturnType<typeof createAdmissionFence>,
 *   drain?: ApplyDrain,
 *   conditions?: () => string[] | Promise<string[]>,
 *   verifyContent?: (candidate: unknown) => Promise<void> | void,
 *   audit?: (session: { id?: string }, type: string, data?: unknown) => void,
 *   notify?: (response: unknown) => unknown,
 *   onAccepted?: (sessionId: string, delta: { added: string[], removed: string[] }) => void,
 *   invalidate?: (sessionId: string, presetId: string) => void,
 *   publishSnapshot?: (sessionId: string, snapshot: { revision: number, skills: unknown[], mcpServers: string[] }) => void,
 *   warn?: (message: string) => void,
 *   trace?: (event: string, data?: unknown) => void,
 * }} options
 */
export function createApplyEngine(options) {
  const {
    store, locateSession, inventory, provider,
    fence = createAdmissionFence(),
    drain = createDrainCoordinator(),
    conditions = () => [],
    verifyContent,
    audit, notify, invalidate, publishSnapshot, onAccepted, warn = () => {}, trace = () => {},
  } = options
  /** In-memory authority snapshots per session (D6 seam): written only by the publication segment, never loaded from disk — after a restart the durable accepted record is the only delta/recovery basis (apply-delta-durable-basis D2). */
  const snapshots = new Map()
  /** Per-session in-process serialization; cross-process exclusion is the store lock. */
  const queues = new Map()
  /**
   * Sessions whose last write ended indeterminate: the fence lease stays held
   * and the prepared (never published) transaction is kept so a receipt query
   * can settle it from durable evidence — publish on proof, reopen on proven
   * absence, keep blocking while the record cannot vouch either way. The entry
   * captures the publication basis (`basisSets`) of the aborted transaction: at
   * settle time the durable record already holds the LANDED write, so the
   * recovery notice delta cannot re-read it. Which record that is depends on the
   * site — the committed-over record when the commit result proved it (a landed
   * write whose fence was lost before publication), otherwise the transaction-
   * start store read (the commit threw or its outcome is unknown: this process
   * never observed the locked record, so no committed-over proof exists).
   * @type {Map<string, { lease: { release(): void }, requestId: string, prepared: { handles: unknown[], identities: unknown[], view: unknown }, payload: unknown, basisSets: { skills: unknown[], mcpServers: string[] }, drainHandle: { abort(): void } | null, viewOptions: unknown }>}
   */
  const blocked = new Map()

  /** @template T @param {string} sessionId @param {() => Promise<T>} task @returns {Promise<T>} */
  function serialize(sessionId, task) {
    const previous = queues.get(sessionId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => {})
    queues.set(sessionId, tail)
    tail.then(() => { if (queues.get(sessionId) === tail) queues.delete(sessionId) })
    return run
  }

  /**
   * Best-effort follow-up scheduled after the response; failures warn and are
   * swallowed, never rolling back policy. The invalidation re-emission (task
   * 5.2, step 6 "then re-emit the invalidation event") rides the same path:
   * after an accepted Apply every client re-pulls its command/skill lists.
   * Both arguments are validated strings — a non-string preset id (session
   * location did not carry one) skips the emission; the emit itself stays
   * try/catch guarded so a failed broadcast never changes the Apply result.
   */
  function followup(sessionId, response, presetId) {
    queueMicrotask(() => {
      try { audit?.({ id: sessionId }, APPLY_AUDIT_TYPE, { requestId: response.receipt?.requestId ?? null, revision: response.revision ?? null }) } catch (error) { warn(`apply audit failed: ${message(error)}`) }
      try { Promise.resolve(notify?.(response)).catch(error => warn(`apply notify failed: ${message(error)}`)) } catch (error) { warn(`apply notify failed: ${message(error)}`) }
      try {
        if (typeof presetId === 'string' && presetId.length) invalidate?.(sessionId, presetId)
      } catch (error) { warn(`apply invalidate failed: ${message(error)}`) }
    })
  }

  /** @param {string} sessionId @param {unknown} request */
  function validateRequest(sessionId, request) {
    const input = /** @type {Record<string, unknown>} */ (request ?? {})
    if (typeof input.requestId !== 'string' || !input.requestId.length) return { error: 'invalid-request:requestId' }
    if (!Number.isSafeInteger(input.expectedRevision) || /** @type {number} */ (input.expectedRevision) < 0) return { error: 'invalid-request:expectedRevision' }
    let enabled
    try {
      enabled = normalizeEnabledSets(input.selection)
    } catch (error) {
      return { error: `invalid-request:selection:${message(error)}` }
    }
    let unresolved
    try {
      unresolved = (Array.isArray(input.unresolved) ? input.unresolved : []).map(raw => {
        const entry = /** @type {Record<string, unknown>} */ (raw ?? {})
        if ((entry.kind !== 'skill' && entry.kind !== 'mcp') || typeof entry.ref !== 'string' || !entry.ref.length || typeof entry.reason !== 'string') {
          throw new TypeError('invalid unresolved ref')
        }
        return { kind: entry.kind, ref: entry.ref, reason: entry.reason }
      })
    } catch (error) {
      return { error: `invalid-request:unresolved:${message(error)}` }
    }
    const selection = validateSkillSelection(enabled.skills)
    if (selection.conflicts.length) return { error: 'same-name-conflict', conflicts: structuredClone(selection.conflicts) }
    return {
      normalized: {
        requestId: input.requestId,
        expectedRevision: /** @type {number} */ (input.expectedRevision),
        skills: selection.identities.map(skillIdentityKey).sort(),
        identities: selection.identities,
        mcpServers: enabled.mcpServers,
        unresolved,
      },
    }
  }

  /**
   * @param {unknown} authSession - authenticated session handle; the ONLY
   *   source of session/workspace/preset location
   * @param {unknown} request - client request; only requestId, expectedRevision,
   *   selection and unresolved are read — never cwd, scope roots or server config
   * @returns {Promise<ApplyResult>}
   */
  async function apply(authSession, request) {
    // Step 1: locate server-side from the authenticated session.
    let located
    try {
      located = await locateSession(authSession)
    } catch (error) {
      return { status: 'rejected', reason: `unauthenticated:${message(error)}`, step: 1 }
    }
    if (located === null || typeof located !== 'object' || !isSegment(located.sessionId)) {
      return { status: 'rejected', reason: 'unauthenticated:session-unavailable', step: 1 }
    }
    const { sessionId } = located
    return serialize(sessionId, () => transact(sessionId, located, request))
  }

  /** @param {string} sessionId @param {{ cwd?: string }} located @param {unknown} request @returns {Promise<ApplyResult>} */
  async function transact(sessionId, located, request) {
    const unit = { kind: 'selection', sessionId }
    const viewOptions = { ...(located.cwd === undefined ? {} : { cwd: located.cwd }), scope: { session: { id: sessionId } } }

    // Step 1 (continued): read the latest accepted revision, the authority.
    const record = await store.read(unit)
    if (record.kind === 'unsupported') return { status: 'rejected', reason: `unsupported:${record.reason}`, step: 1 }
    if (record.kind !== 'ok' && record.kind !== 'absent') return { status: 'rejected', reason: `policy-unreadable:${record.kind}`, step: 1 }

    // Step 2: validate request shape, exact identities and conflicts.
    const validated = validateRequest(sessionId, request)
    if (validated.error) {
      return { status: 'rejected', reason: validated.error, step: 2, ...(validated.conflicts ? { conflicts: validated.conflicts } : {}) }
    }
    const { normalized } = validated

    // Conformance conditions (C0-C4): unmet conditions show unsupported.
    let unmet
    try {
      unmet = await conditions()
    } catch (error) {
      unmet = [`conditions-unavailable:${message(error)}`]
    }
    if (!Array.isArray(unmet)) unmet = ['conditions-invalid']
    if (unmet.length) return { status: 'rejected', reason: `unsupported:${unmet.join(';')}`, step: 2 }

    // Complete inventory and exact identity resolution; no name substitution.
    let snapshot
    try {
      snapshot = await inventory(viewOptions)
    } catch (error) {
      return { status: 'rejected', reason: `inventory-unavailable:${message(error)}`, step: 2 }
    }
    if (!snapshot || snapshot.complete !== true || !Array.isArray(snapshot.candidates)) {
      return { status: 'rejected', reason: 'inventory-incomplete', step: 2 }
    }
    const parsed = snapshot.candidates.filter(candidate => candidate?.status === 'parsed' && candidate.identity)
    /** @type {Map<string, unknown[]>} */
    const byKey = new Map()
    for (const candidate of parsed) {
      const key = skillIdentityKey(candidate.identity)
      byKey.set(key, [...(byKey.get(key) ?? []), candidate])
    }
    const missing = normalized.skills.filter(key => (byKey.get(key) ?? []).length !== 1)
    if (missing.length) return { status: 'rejected', reason: 'selected-identity-missing', step: 2, missing }

    // Step 3: prepare a pure snapshot, filtered view and verified content
    // handles. Nothing is published, installed or notified here.
    let prepared
    try {
      const matched = normalized.skills.map(key => /** @type {unknown[]} */ (byKey.get(key))[0])
      if (verifyContent) for (const candidate of matched) await verifyContent(candidate)
      prepared = {
        handles: matched.map(candidate => Object.freeze({
          identityKey: skillIdentityKey(candidate.identity),
          name: candidate.name ?? null,
          digest: candidate.digest ?? null,
          path: candidate.path ?? null,
        })),
        identities: normalized.identities,
        view: { sessionId, selected: normalized.skills.slice() },
      }
    } catch (error) {
      // Preparation failure keeps the old authority and the user's draft.
      return { status: 'rejected', reason: `preparation-failed:${message(error)}`, step: 3 }
    }

    const previousSets = record.kind === 'ok' ? safeSets(record.payload) : { skills: [], mcpServers: [] }
    const removedServers = previousSets.mcpServers.filter(server => !normalized.mcpServers.includes(server))
    const payload = { skills: prepared.identities, mcpServers: normalized.mcpServers, origin: 'apply' }
    const requestDigest = digestApplyRequest(normalized)

    // Step 4: enter the admission fence, close removed-server gates, start draining.
    trace('fence-enter', { sessionId })
    let lease
    try {
      lease = fence.enter(sessionId)
    } catch (error) {
      return { status: 'rejected', reason: `fence-unavailable:${message(error)}`, step: 4 }
    }
    let drainHandle = null
    try {
      drainHandle = removedServers.length ? drain.begin(removedServers, sessionId) : null
    } catch (error) {
      lease.release()
      return { status: 'rejected', reason: `drain-failed:${message(error)}`, step: 4 }
    }

    // Step 5: durable CAS write of selection + receipt through the group-2 store.
    let result
    try {
      result = await store.commit(unit, normalized.expectedRevision, () => payload, { requestId: normalized.requestId, requestDigest })
    } catch {
      // The write outcome is UNKNOWN: stay blocked (fence held, gates closed)
      // and let a receipt query confirm the authority; never roll back on a guess.
      trace('indeterminate', { sessionId })
      blocked.set(sessionId, { lease, requestId: normalized.requestId, prepared, payload, basisSets: previousSets, drainHandle, viewOptions })
      return { status: 'indeterminate', step: 5 }
    }
    trace('commit', { sessionId, status: result.status })

    if (result.status === 'committed') {
      // Basis authority (D2/D5): the store hands back the payload its CAS replaced,
      // read under the same per-unit lock. The transaction-start read above is NOT
      // that authority — a foreign writer can land between it and this commit, and
      // the CAS then passes on a revision this engine never saw. A committed result
      // that cannot prove the record (a store double, a future store that does not
      // honour the interface) keeps that read and reports
      // `committed-over-unavailable`: never a fabricated full-set delta.
      const proven = Object.hasOwn(result, 'committedOver')
      const basisSets = proven
        ? (result.committedOver === undefined ? { skills: [], mcpServers: [] } : safeSets(result.committedOver))
        : previousSets
      /** @type {string[]} */
      const warnings = []
      const degraded = (code, error) => {
        warnings.push(code)
        if (code === 'accepted-notification-degraded') warn(`apply onAccepted hook failed: ${message(error)}`)
        else if (code === 'committed-over-unavailable') warn('apply commit result cannot prove the committed-over record: notice and drain basis fall back to the transaction-start read')
      }
      if (!proven) degraded('committed-over-unavailable')
      // Two-phase drain (D3): the pre-commit closure above started draining from
      // the transaction-start read — early, but possibly one revision stale.
      // Servers the committed-over record drops that the earlier read could not
      // name get their gates closed HERE, inside the still-held fence and before
      // publication. The residual is a strict difference against the early set, so
      // the two handles are disjoint by construction, and the reconciled handle is
      // never abortable: a commit already landed.
      const residualServers = basisSets.mcpServers.filter(server => !normalized.mcpServers.includes(server) && !removedServers.includes(server))
      let reconciledHandle = null
      if (residualServers.length) {
        try {
          reconciledHandle = drain.begin(residualServers, sessionId)
        } catch (error) {
          // The write is already durable: a reconciliation failure must never
          // become a rejection. Report it and keep what the early handle closed.
          degraded('drain-reconciliation-degraded', error)
        }
      }
      // Re-check the fence before publishing: the lease must still be ours.
      // The revision was already re-checked by the store CAS (expectedRevision).
      if (!fence.isHeld(sessionId)) {
        // The write LANDED but an atomic publication can no longer be
        // guaranteed: stay blocked and let a receipt query publish the
        // authority from durable evidence. The entry carries the basis this
        // transaction would have published with (D4).
        trace('indeterminate', { sessionId, reason: 'fence-lost-before-publish' })
        blocked.set(sessionId, { lease, requestId: normalized.requestId, prepared, payload, basisSets, drainHandle, viewOptions })
        return { status: 'indeterminate', step: 5 }
      }
      // Synchronous publication segment: no await between the snapshot swap,
      // the provider invalidation and the fence release. invalidate() must
      // complete before the fence release and before the step-6 response, so
      // a client that sees the new receipt never refetches a stale list. The
      // SAME segment runs on the recovery-'published' path (D4).
      trace('snapshot-swap', { sessionId, revision: result.revision })
      publishAccepted({
        sessionId,
        revision: result.revision,
        payload,
        prepared,
        viewOptions,
        basisSets,
        lease,
        degraded,
      })
      // The response's drain snapshot is the union of both closures: the early
      // one from the transaction-start read and the reconciled one from the
      // committed-over record. Disjoint by construction; absent when empty.
      const draining = [
        ...(drainHandle ? drainHandle.snapshot() : []),
        ...(reconciledHandle ? reconciledHandle.snapshot() : []),
      ]
      const response = {
        status: 'applied',
        revision: result.revision,
        receipt: result.receipt,
        effective: { skills: structuredClone(prepared.identities), mcpServers: [...normalized.mcpServers] },
        unresolvedWarnings: normalized.unresolved.map(entry => ({ ...entry })),
        ...(draining.length ? { draining } : {}),
        ...(warnings.length ? { warnings } : {}),
      }
      trace('response', { sessionId, revision: result.revision })
      followup(sessionId, response, located.presetId)
      return response
    }

    // Known uncommitted outcomes: no durable change happened, so reopen any
    // gates we closed and release the fence. An UNKNOWN store outcome keeps
    // the fence held and the gates closed: blocking is the conservative state.
    const KNOWN_UNCOMMITTED = new Set(['duplicate', 'request-conflict', 'revision-conflict', 'locked', 'unreadable', 'unsupported', 'write-failed'])
    if (!KNOWN_UNCOMMITTED.has(result.status)) {
      trace('indeterminate', { sessionId, status: result.status })
      blocked.set(sessionId, { lease, requestId: normalized.requestId, prepared, payload, basisSets: previousSets, drainHandle, viewOptions })
      return { status: 'indeterminate', step: 5 }
    }
    drainHandle?.abort()
    lease.release()
    trace('fence-release', { sessionId })

    switch (result.status) {
      case 'duplicate': {
        // The same accepted request: return the original receipt, never a
        // second commit. The fence was released above, so this async read can
        // observe a NEWER record than the receipt's revision: re-check and
        // publish only what the settled record still evidences, at the
        // revision the read actually observed — never a mix of the receipt's
        // revision with a later record's sets.
        const settled = await store.read(unit).catch(() => null)
        const receipt = /** @type {{ requestId: string, requestDigest: string }} */ (result.receipt)
        const evidenced = settled?.kind === 'ok'
          && settled.receipts.some(entry => entry.requestId === receipt.requestId && entry.requestDigest === receipt.requestDigest)
        if (evidenced && settled?.kind === 'ok') {
          return { status: 'duplicate', revision: settled.revision, receipt: result.receipt, effective: safeSets(settled.payload) }
        }
        return { status: 'duplicate', revision: result.revision, receipt: result.receipt, effective: { skills: [], mcpServers: [] }, warnings: ['settlement-unverified'] }
      }
      case 'request-conflict':
        return { status: 'rejected', reason: 'request-conflict', step: 5, receipt: result.receipt }
      case 'revision-conflict': {
        const settled = await store.read(unit).catch(() => null)
        return { status: 'rejected', reason: 'revision-conflict', step: 5, current: settled?.kind === 'ok' ? { revision: settled.revision, ...safeSets(settled.payload) } : { revision: result.revision } }
      }
      case 'locked':
        return { status: 'rejected', reason: `locked:${result.reason}`, step: 5 }
      case 'unreadable':
        return { status: 'rejected', reason: `policy-unreadable:${result.kind}`, step: 5 }
      case 'unsupported':
        return { status: 'rejected', reason: `unsupported:${result.reason}`, step: 5 }
      case 'write-failed':
        // Definite failure: the fence is released and the old snapshot is intact.
        trace('write-failed', { sessionId })
        return { status: 'write-failed', step: 5 }
      default:
        // Unreachable: unknown outcomes kept the fence held above.
        return { status: 'indeterminate', step: 5 }
    }
  }

  /** @param {unknown} payload @returns {{ skills: unknown[], mcpServers: string[] }} */
  function safeSets(payload) {
    const value = /** @type {Record<string, unknown>} */ (payload ?? {})
    return {
      skills: Array.isArray(value.skills) ? value.skills : [],
      mcpServers: Array.isArray(value.mcpServers) ? /** @type {string[]} */ (value.mcpServers) : [],
    }
  }

  /**
   * The ONE synchronous publication segment (apply-delta-durable-basis D4),
   * run by BOTH the committed branch and the recovery-'published' branch:
   * net delta → notice queue → snapshot swap → lifecycle publication →
   * provider invalidation → fence release (→ blocked settle on recovery).
   * No await anywhere in the segment: the atomicity invariant the committed
   * branch documents (a client that sees the new receipt never refetches a
   * stale list) holds for a recovered publication too.
   *
   * The delta basis is the durable evidence only (D2): `basisSets` is the
   * accepted state this publication replaces — on the committed path the payload
   * `store.commit` reports it committed over (read under the commit's own lock),
   * carried into the recovery path by the blocked entry. It is never the
   * in-memory snapshots map and never an unlocked re-read. A failed hook
   * degrades, never changes the accepted policy; per-branch surfacing travels
   * through `degraded` — the committed branch collects response warnings, the
   * recovery branch warns only (it has no response payload).
   *
   * @param {{ sessionId: string, revision: number, payload: unknown,
   *   prepared: { handles: unknown[], identities: unknown[], view: unknown },
   *   viewOptions: unknown,
   *   basisSets: { skills: unknown[], mcpServers: string[] },
   *   lease: { release(): void }, settle?: (() => void) | null,
   *   degraded: (code: string, error?: unknown) => void }} segment
   */
  function publishAccepted({ sessionId, revision, payload, prepared, viewOptions, basisSets, lease, settle = null, degraded }) {
    // Task 12.4: the net accepted delta is known only HERE (durable pre-write
    // record vs the just-committed payload); notify consumers queue it for
    // the next safe request.
    try {
      const delta = selectionDelta(basisSets, safeSets(payload))
      if (delta.added.length > 0 || delta.removed.length > 0) onAccepted?.(sessionId, delta)
    } catch (error) {
      degraded('accepted-notification-degraded', error)
    }
    snapshots.set(sessionId, { revision, selection: structuredClone(payload), handles: prepared.handles, view: prepared.view })
    // Task 6.1: load the accepted selection into the shared lifecycle memory
    // snapshot inside the SAME non-async segment (committed or recovered), so
    // the agent/created listener's synchronous read never observes a durable
    // acceptance this process has not published. A publication failure
    // degrades to the listener's blocking synchronous disk read of the
    // just-committed record — reported, never fatal.
    try {
      const sets = safeSets(payload)
      publishSnapshot?.(sessionId, { revision, skills: structuredClone(sets.skills), mcpServers: [...sets.mcpServers] })
    } catch (error) {
      degraded('snapshot-publication-degraded', error)
    }
    try {
      trace('invalidate', { sessionId })
      const accepted = provider.acceptSelection(prepared.identities, viewOptions)
      if (!accepted?.accepted) degraded('provider-publication-degraded')
    } catch (error) {
      // The record is durably accepted; a failed cache invalidation degrades
      // convergence, never the policy. The warning is reported, not hidden.
      degraded('invalidate-failed', error)
    } finally {
      trace('fence-release', { sessionId })
      lease.release()
      settle?.()
    }
  }

  /**
   * Receipt query (tasks 4.4): after a lost response or an indeterminate
   * write, the client enters "result pending confirmation" and queries the
   * original requestId instead of claiming a cancellation or a rollback that
   * never happened. Receipts are retained for the session lifecycle, so the
   * accepted revision is always retrievable.
   *
   * Recovery of a pending indeterminate write of the SAME session (4.2/4.3):
   * the query is serialized behind any in-flight Apply, then settles the
   * pending transaction from durable evidence only —
   * - pending receipt FOUND in a clean record: the write had landed; run the
   *   publication segment the lost response never ran — the SAME segment the
   *   committed path runs (delta → notice queue → snapshot swap → lifecycle
   *   publication → provider invalidation → fence release, D4), with the
   *   delta computed against the pre-write sets captured at transaction
   *   start — and report recovery 'published';
   * - a digest-verified record WITHOUT the pending receipt: durable proof the
   *   write never landed; reopen the drain gates, release the fence and
   *   report recovery 'not-committed' (proven absence, NOT a rollback);
   * - an unreadable record vouches neither way: keep blocking and report
   *   recovery 'blocked' — never a guessed rollback, never unrestricted.
   * @param {unknown} authSession @param {string} requestId
   * @returns {Promise<ReceiptQueryResult>}
   */
  async function queryReceipt(authSession, requestId) {
    if (typeof requestId !== 'string' || !requestId.length) return { status: 'rejected', reason: 'invalid-request:requestId' }
    let located
    try {
      located = await locateSession(authSession)
    } catch (error) {
      return { status: 'rejected', reason: `unauthenticated:${message(error)}` }
    }
    if (located === null || typeof located !== 'object' || !isSegment(located.sessionId)) {
      return { status: 'rejected', reason: 'unauthenticated:session-unavailable' }
    }
    const sessionId = located.sessionId
    return serialize(sessionId, () => settleReceipt(sessionId, requestId, located.presetId))
  }

  /** @param {string} sessionId @param {string} requestId @param {unknown} presetId @returns {Promise<ReceiptQueryResult>} */
  async function settleReceipt(sessionId, requestId, presetId) {
    const unit = { kind: 'selection', sessionId }
    const record = await store.read(unit)
    if (record.kind === 'unsupported') return { status: 'rejected', reason: `unsupported:${record.reason}` }

    const pending = blocked.get(sessionId) ?? null
    /** @type {'published'|'not-committed'|'blocked'|undefined} */
    let recovery
    if (pending) {
      const confirmed = record.kind === 'ok' ? record.receipts.find(entry => entry.requestId === pending.requestId) ?? null : null
      if (confirmed) {
        // The indeterminate write LANDED: run the ONE publication segment the
        // lost response never ran (D4), delta against the captured pre-write
        // sets included, so the recovered acceptance notifies the model
        // exactly once (the segment settles the blocked entry).
        trace('recovery-publish', { sessionId, revision: confirmed.revision })
        publishAccepted({
          sessionId,
          revision: confirmed.revision,
          payload: pending.payload,
          prepared: pending.prepared,
          viewOptions: pending.viewOptions,
          basisSets: pending.basisSets,
          lease: pending.lease,
          settle: () => blocked.delete(sessionId),
          // Recovery has no response payload: degradation is warn-only.
          degraded: (code, error) => {
            if (code === 'snapshot-publication-degraded') warn(`snapshot publication failed: ${message(error)}`)
            else if (code === 'invalidate-failed') warn(`receipt-recovery invalidate failed: ${message(error)}`)
            else warn(`receipt-recovery publication degraded: ${code}${error instanceof Error ? `: ${message(error)}` : ''}`)
          },
        })
        recovery = 'published'
        queueMicrotask(() => {
          try { audit?.({ id: sessionId }, APPLY_AUDIT_TYPE, { requestId: confirmed.requestId, revision: confirmed.revision, recovery }) } catch (error) { warn(`apply audit failed: ${message(error)}`) }
          // The lost response never ran the step-6 re-emission; clients hold
          // equally stale lists, so a recovered publication re-emits too.
          try {
            if (typeof presetId === 'string' && presetId.length) invalidate?.(sessionId, presetId)
          } catch (error) { warn(`apply invalidate failed: ${message(error)}`) }
        })
      } else if (record.kind === 'ok' || record.kind === 'absent') {
        // A clean, digest-verified record without the pending receipt is
        // durable proof the write never landed: reopen the gates and release
        // the fence. Nothing is rolled back — nothing was committed.
        trace('recovery-not-committed', { sessionId })
        pending.drainHandle?.abort()
        pending.lease.release()
        blocked.delete(sessionId)
        recovery = 'not-committed'
      } else {
        // corrupt/torn/unknown-schema: maintain blocking until a later query
        // can read the record again.
        trace('recovery-blocked', { sessionId, kind: record.kind })
        recovery = 'blocked'
      }
    }

    if (record.kind !== 'ok') return { status: 'not-found', revision: record.kind === 'absent' ? 0 : null, ...(recovery ? { recovery } : {}) }
    const receipt = record.receipts.find(entry => entry.requestId === requestId)
    return receipt
      ? { status: 'found', revision: record.revision, receipt, applied: safeSets(record.payload), ...(recovery ? { recovery } : {}) }
      : { status: 'not-found', revision: record.revision, ...(recovery ? { recovery } : {}) }
  }

  return {
    apply,
    queryReceipt,
    /** Synchronous in-memory authority snapshot for a session (null until loaded). */
    authority(sessionId) {
      const snapshot = snapshots.get(sessionId)
      return snapshot ? structuredClone(snapshot) : null
    },
    fence,
    drain,
  }
}
