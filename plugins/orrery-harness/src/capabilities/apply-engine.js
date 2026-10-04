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
//   5. CAS-commit the new selection and receipt through the group-2 store,
//      then in ONE non-async segment: swap the in-memory snapshot, call the
//      provider's control.invalidate() and release the fence. invalidate()
//      happens before the fence release and before the step-6 response.
//   6. Send the response: accepted revision, effective sets, unresolved
//      warnings and a drain snapshot taken at send time (never awaited).
// Audit and notification are scheduled best-effort after the response; their
// failure never rolls back accepted policy. Commands and audit logs are not
// commit evidence: durable acceptance is only the store record.
import { digestOf } from './store/record.js'
import { isSegment } from './store/paths.js'
import { skillIdentityKey } from './skill-identity.js'
import { validateSkillSelection } from './skill-selection-provider.js'
import { normalizeEnabledSets } from './selection-draft.js'

/** Audit event type (without the 'orrery/' prefix) emitted after acceptance. */
export const APPLY_AUDIT_TYPE = 'capability-apply'

/**
 * @typedef {import('./skill-selection-provider.js')} SelectionProviderModule
 * @typedef {{ kind: 'skill'|'mcp', ref: string, reason: string }} UnresolvedRef
 * @typedef {{ server: string, state: 'draining'|'settled', inFlight: number }} DrainStatus
 * A step-tagged rejection keeps the old authority and the user's draft.
 * @typedef {{ status: 'applied', revision: number, receipt: unknown, effective: unknown, unresolvedWarnings: UnresolvedRef[], draining?: DrainStatus[], warnings?: string[] }
 *   | { status: 'duplicate', revision: number, receipt: unknown, effective: unknown }
 *   | { status: 'rejected', reason: string, step: number, conflicts?: unknown[], missing?: string[], current?: unknown, receipt?: unknown }
 *   | { status: 'write-failed', step: 5 }
 *   | { status: 'indeterminate', step: 5 }} ApplyResult
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
 * Drain coordinator for managed MCP servers removed by an Apply (step 4 seam;
 * group 8.6 wires it to the real MCP facade with timeouts). Closing a gate is
 * reversible until the commit succeeds: a rejected or failed Apply aborts the
 * closure. In-flight calls are reported, never force-cancelled.
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
 *   drain?: ReturnType<typeof createDrainCoordinator>,
 *   conditions?: () => string[] | Promise<string[]>,
 *   verifyContent?: (candidate: unknown) => Promise<void> | void,
 *   audit?: (session: { id?: string }, type: string, data?: unknown) => void,
 *   notify?: (response: unknown) => unknown,
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
    audit, notify, trace = () => {},
  } = options
  /** In-memory authority snapshots per session (D6 seam; group 6 loads them at mount). */
  const snapshots = new Map()
  /** Per-session in-process serialization; cross-process exclusion is the store lock. */
  const queues = new Map()

  /** @template T @param {string} sessionId @param {() => Promise<T>} task @returns {Promise<T>} */
  function serialize(sessionId, task) {
    const previous = queues.get(sessionId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => {})
    queues.set(sessionId, tail)
    tail.then(() => { if (queues.get(sessionId) === tail) queues.delete(sessionId) })
    return run
  }

  /** Best-effort follow-up scheduled after the response; failures never roll back policy. */
  function followup(sessionId, response) {
    queueMicrotask(() => {
      try { audit?.({ id: sessionId }, APPLY_AUDIT_TYPE, { requestId: response.receipt?.requestId ?? null, revision: response.revision ?? null }) } catch {}
      try { Promise.resolve(notify?.(response)).catch(() => {}) } catch {}
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
      drainHandle = removedServers.length ? drain.begin(removedServers) : null
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
      return { status: 'indeterminate', step: 5 }
    }
    trace('commit', { sessionId, status: result.status })

    if (result.status === 'committed') {
      // Synchronous publication segment: no await between the snapshot swap,
      // the provider invalidation and the fence release. invalidate() must
      // complete before the fence release and before the step-6 response, so
      // a client that sees the new receipt never refetches a stale list.
      /** @type {string[]} */
      const warnings = []
      trace('snapshot-swap', { sessionId, revision: result.revision })
      snapshots.set(sessionId, { revision: result.revision, selection: structuredClone(payload), handles: prepared.handles, view: prepared.view })
      try {
        trace('invalidate', { sessionId })
        const accepted = provider.acceptSelection(prepared.identities, viewOptions)
        if (!accepted?.accepted) warnings.push('provider-publication-degraded')
      } catch {
        // The record is durably accepted; a failed cache invalidation degrades
        // convergence, never the policy. The warning is reported, not hidden.
        warnings.push('invalidate-failed')
      } finally {
        trace('fence-release', { sessionId })
        lease.release()
      }
      const response = {
        status: 'applied',
        revision: result.revision,
        receipt: result.receipt,
        effective: { skills: structuredClone(prepared.identities), mcpServers: [...normalized.mcpServers] },
        unresolvedWarnings: normalized.unresolved.map(entry => ({ ...entry })),
        ...(drainHandle ? { draining: drainHandle.snapshot() } : {}),
        ...(warnings.length ? { warnings } : {}),
      }
      trace('response', { sessionId, revision: result.revision })
      followup(sessionId, response)
      return response
    }

    // Known uncommitted outcomes: no durable change happened, so reopen any
    // gates we closed and release the fence. An UNKNOWN store outcome keeps
    // the fence held and the gates closed: blocking is the conservative state.
    const KNOWN_UNCOMMITTED = new Set(['duplicate', 'request-conflict', 'revision-conflict', 'locked', 'unreadable', 'unsupported', 'write-failed'])
    if (!KNOWN_UNCOMMITTED.has(result.status)) {
      trace('indeterminate', { sessionId, status: result.status })
      return { status: 'indeterminate', step: 5 }
    }
    drainHandle?.abort()
    lease.release()
    trace('fence-release', { sessionId })

    switch (result.status) {
      case 'duplicate': {
        // The same accepted request: return the original receipt, never a second commit.
        const settled = await store.read(unit).catch(() => null)
        const effective = settled?.kind === 'ok' ? safeSets(settled.payload) : { skills: [], mcpServers: [] }
        return { status: 'duplicate', revision: result.revision, receipt: result.receipt, effective }
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
   * Receipt query (tasks 4.4 seam): after a lost response or an indeterminate
   * write, the client queries the original requestId instead of claiming a
   * cancellation or a rollback that never happened.
   * @param {unknown} authSession @param {string} requestId
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
    const record = await store.read({ kind: 'selection', sessionId: located.sessionId })
    if (record.kind === 'unsupported') return { status: 'rejected', reason: `unsupported:${record.reason}` }
    if (record.kind !== 'ok') return { status: 'not-found', revision: record.kind === 'absent' ? 0 : null }
    const receipt = record.receipts.find(entry => entry.requestId === requestId)
    return receipt
      ? { status: 'found', revision: record.revision, receipt, applied: safeSets(record.payload) }
      : { status: 'not-found', revision: record.revision }
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
