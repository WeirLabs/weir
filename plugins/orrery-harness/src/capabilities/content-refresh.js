// Content refresh engine of the session capability manager (design D2,
// tasks 4.5). A refresh re-scans the content of the CURRENTLY selected skills
// and durably records fresh content handles in the session's CONTENT unit —
// an independent store record with its own revision and receipts, never the
// selection record. One refresh is a four-step transaction:
//   1. Locate the session server-side from the AUTHENTICATED session; the
//      client never supplies cwd, scope roots or server config.
//   2. Validate requestId, the expected content revision, the expected
//      selection revision and the optional exact identity subset.
//   3. Read the CURRENT selection, verify every requested identity is still
//      selected (a removed skill is never re-published), collect and verify
//      fresh content handles server-side, then RE-READ the selection
//      immediately before committing: if its revision moved, the refresh is
//      rejected — a skill removed while a refresh was collecting is never
//      published by that refresh.
//   4. CAS-commit the content handles through the group-2 store with an
//      independent requestId receipt.
// The whole transaction runs through the SAME commit coordinator as selection
// Applies (the apply engine's per-session serialization point, exposed as
// `coordinate`), so a refresh and an Apply never interleave in-process;
// cross-process exclusion is the store lock plus the pre-commit selection
// re-check. A refresh enters no admission fence and publishes nothing
// in-memory: the recorded `selectionRevision` marks exactly which selection
// authority the handles were verified against, so any consumer can detect
// staleness after a later Apply.
// Audit is scheduled best-effort after the response and reuses the registered
// capability-apply type (adding a type would touch src/shared/audit.js, which
// is outside this group); its failure never rolls back accepted policy.
import { digestOf } from './store/record.js'
import { isSegment } from './store/paths.js'
import { createSkillIdentity, skillIdentityKey } from './skill-identity.js'
import { AUDIT_TYPES } from '../shared/audit.js'

/** Refresh acceptance is audited under the registered capability-apply type
 * with an `operation: 'refresh'` marker; the emit site never invents a type
 * literal and never touches session.append (cold-read red line). */
export const REFRESH_AUDIT_TYPE = AUDIT_TYPES.capabilityApply

/**
 * @typedef {{ status: 'refreshed', revision: number, receipt: unknown, selectionRevision: number, contents: unknown[] }
 *   | { status: 'duplicate', revision: number, receipt: unknown, selectionRevision?: unknown, warnings?: string[] }
 *   | { status: 'rejected', reason: string, step: number, missing?: string[], current?: unknown, receipt?: unknown }
 *   | { status: 'write-failed', step: 4 }
 *   | { status: 'indeterminate', step: 4 }} RefreshResult
 * @typedef {{ status: 'found', revision: number, receipt: unknown, selectionRevision: unknown, contents: unknown[] }
 *   | { status: 'not-found', revision: number|null }
 *   | { status: 'rejected', reason: string }} RefreshReceiptQueryResult
 */

const message = error => error instanceof Error ? error.message : String(error)

/**
 * Request digest: the full normalized request payload, so any field change
 * under a reused requestId is a different request. `skills` is the sorted
 * identity-key vector (null when the request refreshes the whole selection).
 * @param {{ expectedRevision: number, expectedSelectionRevision: number, skills: string[]|null }} normalized
 */
export function digestRefreshRequest(normalized) {
  return digestOf({
    expectedRevision: normalized.expectedRevision,
    expectedSelectionRevision: normalized.expectedSelectionRevision,
    skills: normalized.skills,
  })
}

/** @param {unknown} payload @returns {unknown[]} */
function safeSkills(payload) {
  const value = /** @type {Record<string, unknown>} */ (payload ?? {})
  return Array.isArray(value.skills) ? value.skills : []
}

/**
 * @param {{
 *   store: { read(unit: unknown): Promise<any>, commit(unit: unknown, expectedRevision: number, mutate: (payload: unknown, info: { revision: number }) => unknown, request?: { requestId?: string, requestDigest?: string }): Promise<any> },
 *   locateSession: (authSession: unknown) => Promise<{ sessionId: string, cwd?: string } | null> | { sessionId: string, cwd?: string } | null,
 *   coordinate: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>,
 *   collect: (options: { cwd?: string, scope: { session: { id: string } } }) => Promise<{ complete: boolean, candidates: any[] }>,
 *   verifyContent?: (candidate: unknown) => Promise<void> | void,
 *   audit?: (session: { id?: string }, type: string, data?: unknown) => void,
 *   warn?: (message: string) => void,
 *   trace?: (event: string, data?: unknown) => void,
 * }} options
 */
export function createContentRefresh(options) {
  const { store, locateSession, coordinate, collect, verifyContent, audit, warn = () => {}, trace = () => {} } = options
  if (typeof coordinate !== 'function') throw new TypeError('The shared commit coordinator is required')
  if (typeof collect !== 'function') throw new TypeError('A server-side content collector is required')

  /** Best-effort audit scheduled after the response; failures warn and are swallowed, never rolling back policy. */
  function followup(sessionId, response) {
    queueMicrotask(() => {
      try {
        audit?.({ id: sessionId }, REFRESH_AUDIT_TYPE, { operation: 'refresh', requestId: response.receipt?.requestId ?? null, revision: response.revision ?? null, selectionRevision: response.selectionRevision ?? null })
      } catch (error) {
        warn(`refresh audit failed: ${message(error)}`)
      }
    })
  }

  /** @param {unknown} request */
  function validateRequest(request) {
    const input = /** @type {Record<string, unknown>} */ (request ?? {})
    if (typeof input.requestId !== 'string' || !input.requestId.length) return { error: 'invalid-request:requestId' }
    if (!Number.isSafeInteger(input.expectedRevision) || /** @type {number} */ (input.expectedRevision) < 0) return { error: 'invalid-request:expectedRevision' }
    if (!Number.isSafeInteger(input.expectedSelectionRevision) || /** @type {number} */ (input.expectedSelectionRevision) < 0) return { error: 'invalid-request:expectedSelectionRevision' }
    /** @type {{ keys: string[], identities: unknown[] } | null} */
    let skills = null
    if (input.skills !== undefined) {
      if (!Array.isArray(input.skills)) return { error: 'invalid-request:skills' }
      try {
        const byKey = new Map(input.skills.map(raw => {
          const identity = createSkillIdentity(raw)
          return [skillIdentityKey(identity), identity]
        }))
        skills = { keys: [...byKey.keys()].sort(), identities: [...byKey.values()] }
      } catch (error) {
        return { error: `invalid-request:skills:${message(error)}` }
      }
    }
    return {
      normalized: {
        requestId: input.requestId,
        expectedRevision: /** @type {number} */ (input.expectedRevision),
        expectedSelectionRevision: /** @type {number} */ (input.expectedSelectionRevision),
        skills,
      },
    }
  }

  /**
   * @param {unknown} authSession - authenticated session handle; the ONLY
   *   source of the session location
   * @param {unknown} request - client request; only requestId, the expected
   *   revisions and the optional identity subset are read
   * @returns {Promise<RefreshResult>}
   */
  async function refresh(authSession, request) {
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
    // The SAME commit coordinator the selection Apply uses.
    return coordinate(sessionId, () => transact(sessionId, located, request))
  }

  /** @param {string} sessionId @param {{ cwd?: string }} located @param {unknown} request @returns {Promise<RefreshResult>} */
  async function transact(sessionId, located, request) {
    const contentUnit = { kind: 'content', sessionId }
    const selectionUnit = { kind: 'selection', sessionId }
    const viewOptions = { ...(located.cwd === undefined ? {} : { cwd: located.cwd }), scope: { session: { id: sessionId } } }

    // Step 2: validate the request shape and the exact identity subset.
    const validated = validateRequest(request)
    if (validated.error) return { status: 'rejected', reason: validated.error, step: 2 }
    const { normalized } = validated

    // Step 3: read the CURRENT selection — the only authority a refresh serves.
    const first = await store.read(selectionUnit)
    if (first.kind === 'unsupported') return { status: 'rejected', reason: `unsupported:${first.reason}`, step: 3 }
    if (first.kind !== 'ok' && first.kind !== 'absent') return { status: 'rejected', reason: `policy-unreadable:${first.kind}`, step: 3 }
    const selectionRevision = first.kind === 'ok' ? first.revision : 0
    trace('selection-read', { sessionId, revision: selectionRevision })
    if (selectionRevision !== normalized.expectedSelectionRevision) {
      trace('selection-revision-changed', { sessionId, from: normalized.expectedSelectionRevision, to: selectionRevision })
      return { status: 'rejected', reason: 'selection-revision-changed', step: 3, current: { revision: selectionRevision } }
    }
    /** @type {Map<string, unknown>} */
    const selected = new Map()
    if (first.kind === 'ok') {
      for (const raw of safeSkills(first.payload)) {
        try {
          const identity = createSkillIdentity(raw)
          selected.set(skillIdentityKey(identity), identity)
        } catch {
          // A durably accepted record holds valid identities; a stray entry is
          // skipped here and stays unrefreshable, never substituted by name.
        }
      }
    }
    const requested = normalized.skills ? normalized.skills.keys : [...selected.keys()].sort()
    const notSelected = requested.filter(key => !selected.has(key))
    if (notSelected.length) {
      // A removed skill is never re-published by a refresh.
      trace('skill-not-selected', { sessionId, missing: notSelected })
      return { status: 'rejected', reason: 'skill-not-selected', step: 3, missing: notSelected }
    }

    // Collect and verify fresh content handles server-side; nothing is
    // committed or published here.
    /** @type {Readonly<{ identity: unknown, name: string|null, digest: string|null, path: string|null }>[]} */
    let prepared
    try {
      const snapshot = await collect(viewOptions)
      if (!snapshot || snapshot.complete !== true || !Array.isArray(snapshot.candidates)) {
        return { status: 'rejected', reason: 'inventory-incomplete', step: 3 }
      }
      const parsed = snapshot.candidates.filter(candidate => candidate?.status === 'parsed' && candidate.identity)
      /** @type {Map<string, unknown[]>} */
      const byKey = new Map()
      for (const candidate of parsed) {
        const key = skillIdentityKey(candidate.identity)
        byKey.set(key, [...(byKey.get(key) ?? []), candidate])
      }
      const missing = requested.filter(key => (byKey.get(key) ?? []).length !== 1)
      if (missing.length) return { status: 'rejected', reason: 'selected-identity-missing', step: 3, missing }
      const matched = requested.map(key => /** @type {unknown[]} */ (byKey.get(key))[0])
      if (verifyContent) for (const candidate of matched) await verifyContent(candidate)
      prepared = matched.map(candidate => Object.freeze({
        identity: candidate.identity,
        name: candidate.name ?? null,
        digest: candidate.digest ?? null,
        path: candidate.path ?? null,
      }))
    } catch (error) {
      return { status: 'rejected', reason: `preparation-failed:${message(error)}`, step: 3 }
    }

    // Step 3 (final): RE-CHECK the selection revision immediately before the
    // commit. Inside the shared coordinator no in-process Apply can
    // interleave; against a cross-process writer this is the last durable
    // look — the invariant is that a skill removed AT COMMIT TIME is never
    // published by this refresh.
    const settled = await store.read(selectionUnit)
    if (settled.kind === 'unsupported') return { status: 'rejected', reason: `unsupported:${settled.reason}`, step: 3 }
    if (settled.kind !== 'ok' && settled.kind !== 'absent') return { status: 'rejected', reason: `policy-unreadable:${settled.kind}`, step: 3 }
    const settledRevision = settled.kind === 'ok' ? settled.revision : 0
    trace('selection-recheck', { sessionId, revision: settledRevision })
    if (settledRevision !== selectionRevision) {
      trace('selection-revision-changed', { sessionId, from: selectionRevision, to: settledRevision })
      return { status: 'rejected', reason: 'selection-revision-changed', step: 3, current: { revision: settledRevision } }
    }

    // Step 4: durable CAS write through the group-2 store; the content unit
    // owns its revision and receipts independently of the selection unit.
    const payload = { contents: prepared, selectionRevision, origin: 'refresh' }
    const requestDigest = digestRefreshRequest({
      expectedRevision: normalized.expectedRevision,
      expectedSelectionRevision: normalized.expectedSelectionRevision,
      skills: normalized.skills ? normalized.skills.keys : null,
    })
    let result
    try {
      result = await store.commit(contentUnit, normalized.expectedRevision, () => payload, { requestId: normalized.requestId, requestDigest })
    } catch {
      // The write outcome is UNKNOWN: nothing is held (no fence, no in-memory
      // publication), so a receipt query settles it from durable evidence.
      trace('indeterminate', { sessionId })
      return { status: 'indeterminate', step: 4 }
    }
    trace('commit', { sessionId, status: result.status })

    switch (result.status) {
      case 'committed': {
        const response = { status: /** @type {const} */ ('refreshed'), revision: result.revision, receipt: result.receipt, selectionRevision, contents: structuredClone(prepared) }
        trace('response', { sessionId, revision: result.revision })
        followup(sessionId, response)
        return response
      }
      case 'duplicate': {
        // The same accepted request: return the original receipt, never a
        // second commit. Re-read so revision and marker come from the SAME
        // settled record the read actually observed.
        const settledRecord = await store.read(contentUnit).catch(() => null)
        const receipt = /** @type {{ requestId: string, requestDigest: string }} */ (result.receipt)
        const evidenced = settledRecord?.kind === 'ok'
          && settledRecord.receipts.some(entry => entry.requestId === receipt.requestId && entry.requestDigest === receipt.requestDigest)
        if (evidenced && settledRecord?.kind === 'ok') {
          const settledPayload = /** @type {Record<string, unknown>} */ (settledRecord.payload ?? {})
          return { status: 'duplicate', revision: settledRecord.revision, receipt: result.receipt, selectionRevision: settledPayload.selectionRevision }
        }
        return { status: 'duplicate', revision: result.revision, receipt: result.receipt, warnings: ['settlement-unverified'] }
      }
      case 'request-conflict':
        return { status: 'rejected', reason: 'request-conflict', step: 4, receipt: result.receipt }
      case 'revision-conflict': {
        const current = await store.read(contentUnit).catch(() => null)
        return { status: 'rejected', reason: 'revision-conflict', step: 4, current: current?.kind === 'ok' ? { revision: current.revision } : { revision: result.revision } }
      }
      case 'locked':
        return { status: 'rejected', reason: `locked:${result.reason}`, step: 4 }
      case 'unreadable':
        return { status: 'rejected', reason: `policy-unreadable:${result.kind}`, step: 4 }
      case 'unsupported':
        return { status: 'rejected', reason: `unsupported:${result.reason}`, step: 4 }
      case 'write-failed':
        trace('write-failed', { sessionId })
        return { status: 'write-failed', step: 4 }
      default:
        // Unknown store outcome: nothing was held, report indeterminate.
        trace('indeterminate', { sessionId, status: result.status })
        return { status: 'indeterminate', step: 4 }
    }
  }

  /**
   * Receipt query on the CONTENT unit: after a lost response or an
   * indeterminate write, the client queries the original requestId instead of
   * claiming a cancellation or a rollback that never happened.
   * @param {unknown} authSession @param {string} requestId
   * @returns {Promise<RefreshReceiptQueryResult>}
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
    const record = await store.read({ kind: 'content', sessionId: located.sessionId })
    if (record.kind === 'unsupported') return { status: 'rejected', reason: `unsupported:${record.reason}` }
    if (record.kind !== 'ok') return { status: 'not-found', revision: record.kind === 'absent' ? 0 : null }
    const payload = /** @type {Record<string, unknown>} */ (record.payload ?? {})
    const receipt = record.receipts.find(entry => entry.requestId === requestId)
    return receipt
      ? { status: 'found', revision: record.revision, receipt, selectionRevision: payload.selectionRevision, contents: Array.isArray(payload.contents) ? payload.contents : [] }
      : { status: 'not-found', revision: record.revision }
  }

  return { refresh, queryReceipt }
}
