// Pure durable-image validation shared by the authority store and the
// read-only maintenance inspector. Everything here is a function of its
// arguments: no filesystem access, no clock, no ctx. `parseSnapshot` performs
// EXACTLY the checks the store's recover path always performed (same order,
// same messages) so an inspection verdict can never diverge from what a real
// recover would accept — corruption is reported, never repaired.
import { createHash } from 'node:crypto'
import { validateOperations } from './operation-history.js'
import { validateAdminLedger } from './admin-ledger.js'
import { validateIncarnations } from './incarnations.js'

/**
 * @typedef {import('./store.js').AuthorityImage} AuthorityImage
 * @typedef {{ revision: number, state: AuthorityImage }} Snapshot
 */

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function valid(condition, message) {
  if (!condition) throw new Error(`invalid ${message}`)
}
/** @param {unknown} value @returns {value is string} */
function id(value) { return typeof value === 'string' && value.length > 0 }
/** @param {unknown} value @param {number} [minimum] @returns {value is number} */
function integer(value, minimum = 0) { return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum }
/** @param {unknown} value @param {string[]} keys @returns {asserts value is Record<string, unknown>} */
function shape(value, keys) {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value), 'object')
  valid(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'object prototype')
  valid(Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'schema keys')
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    valid(descriptor && 'value' in descriptor && descriptor.enumerable, 'data property')
  }
}

/** Deterministic JSON: UTF-16 key order, JSON scalar spelling, no whitespace.
 * Array order is retained (including the historical image's ordered collections).
 * @param {unknown} value @returns {string} */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Lossless v2 -> v3 upgrade: add one empty retention row per known session.
 * @param {any} state @returns {any} */
export function upgradeFromV2(state) {
  valid(state && typeof state === 'object' && !Array.isArray(state) && !Object.hasOwn(state, 'holds') && state.version === 2, 'v2 image')
  valid(Array.isArray(state.sessions), 'v2 sessions')
  const holds = state.sessions.map((/** @type {any} */ session) => ({ sessionId: session?.sessionId, holding: false, holdUntil: null, holdCumulativeMs: 0 }))
  const { version: _v, operations, ...rest } = state
  return { ...rest, version: 3, holds, operations }
}

/** Lossless v3 -> v4: historical assertions remain inert, never upgraded to proof.
 * @param {any} state @returns {AuthorityImage} */
export function upgradeFromV3(state) {
  valid(state?.version === 3 && Array.isArray(state.operations), 'v3 image')
  for (const operation of state.operations) {
    valid(Array.isArray(operation.closeouts), 'v3 closeouts')
    for (const closeout of operation.closeouts) shape(closeout, ['kind', 'assertionId'])
  }
  return { ...state, version: 4 }
}

/** @param {AuthorityImage} state */
export function validateImage(state) {
  shape(state, ['version', 'managerIncarnation', 'sessions', 'generations', 'locks', 'issuedRequests', 'recovery', 'holds', 'operations', ...(state.version === 5 ? ['adminRecoveries'] : []), ...(state.version === 6 ? ['adminRecoveries', 'incarnations'] : [])])
  valid(state.version === 4 || state.version === 5 || state.version === 6, `image version ${state.version}; expected 4, 5 or 6`)
  valid(state.managerIncarnation === null || id(state.managerIncarnation), 'incarnation')
  for (const collection of [state.sessions, state.generations, state.locks, state.issuedRequests, state.recovery, state.holds]) {
    valid(Array.isArray(collection) && Object.getPrototypeOf(collection) === Array.prototype, 'collection')
    valid(Reflect.ownKeys(collection).length === collection.length + 1, 'dense collection keys')
    for (let i = 0; i < collection.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(collection, i)
      valid(descriptor && 'value' in descriptor && descriptor.enumerable, 'collection data property')
    }
  }
  valid(state.managerIncarnation !== null || [state.sessions, state.generations, state.locks, state.issuedRequests, state.recovery, state.holds, state.operations].every(list => list.length === 0), 'null incarnation with history')
  const sessions = new Map(state.sessions.map(session => {
    shape(session, ['sessionId', 'executionEpoch', 'interrupted'])
    valid(id(session.sessionId) && integer(session.executionEpoch, 1) && typeof session.interrupted === 'boolean', 'session')
    return [session.sessionId, session]
  }))
  valid(sessions.size === state.sessions.length, 'duplicate session')
  // Retention is a session-level budget (design D1): one row per session, only for
  // sessions the image knows, and the cumulative allowance is a lifetime charge
  // that is never refunded.
  const holds = new Map()
  for (const held of state.holds) {
    shape(held, ['sessionId', 'holding', 'holdUntil', 'holdCumulativeMs'])
    valid(sessions.has(held.sessionId) && !holds.has(held.sessionId), 'hold reference')
    valid(typeof held.holding === 'boolean' && integer(held.holdCumulativeMs), 'hold flags')
    valid(held.holdUntil === null || integer(held.holdUntil, 1), 'hold expiry')
    valid(held.holding ? held.holdUntil !== null : held.holdUntil === null, 'hold expiry coherence')
    holds.set(held.sessionId, held)
  }
  for (const session of state.sessions) valid(holds.has(session.sessionId), 'missing hold row')
  const generations = new Map(state.generations.map(entry => {
    shape(entry, ['resourceId', 'generation'])
    valid(id(entry.resourceId) && integer(entry.generation, 1), 'generation')
    return [entry.resourceId, entry.generation]
  }))
  valid(generations.size === state.generations.length, 'duplicate generation')
  // A session whose last lock is gone has no batch left: the row stays (one row per
  // session) but must be back at zero, so a stale allowance cannot survive a batch.
  for (const held of state.holds) {
    if (state.locks.some(lock => lock.owner === held.sessionId)) continue
    valid(!held.holding && held.holdUntil === null && held.holdCumulativeMs === 0, 'hold without a lock')
  }
  const resources = new Set()
  for (const lock of state.locks) {
    shape(lock, lock.status === 'abnormal' ? ['resourceId', 'owner', 'generation', 'status', 'reason'] : ['resourceId', 'owner', 'generation', 'status'])
    valid(id(lock.resourceId) && id(lock.owner) && integer(lock.generation, 1), 'lock')
    const session = sessions.get(lock.owner)
    valid(session && generations.get(lock.resourceId) === lock.generation && !resources.has(lock.resourceId), 'lock reference')
    resources.add(lock.resourceId)
    valid(['active', 'user-interrupted', 'pending-confirmation', 'abnormal'].includes(lock.status), 'lock status')
    if (lock.status === 'abnormal') valid(id(lock.reason), 'abnormal reason')
    else valid(session.interrupted === (lock.status === 'user-interrupted'), 'lock interruption')
  }
  const requests = new Set()
  for (const request of state.issuedRequests) {
    shape(request, ['sessionId', 'requestId'])
    valid(sessions.has(request.sessionId) && id(request.requestId), 'issued request')
    const key = canonical([request.sessionId, request.requestId])
    valid(!requests.has(key), 'duplicate request')
    requests.add(key)
  }
  const recoveries = new Set()
  for (const recovery of state.recovery) {
    shape(recovery, ['sessionId', 'attempts', 'elapsedMs', 'pauseMs'])
    valid(sessions.has(recovery.sessionId) && !recoveries.has(recovery.sessionId), 'recovery reference')
    valid(integer(recovery.attempts) && integer(recovery.elapsedMs) && integer(recovery.pauseMs), 'recovery counters')
    recoveries.add(recovery.sessionId)
  }
  validateAdminLedger(state)
  validateOperations(state)
  if (state.version === 6) validateIncarnations(state)
}

/**
 * Parse and validate one committed snapshot's raw bytes for `domainId`.
 * Byte-for-byte the store recover path's validation, in the same order with
 * the same refusal messages; the caller supplies the bytes, so a read-only
 * inspection runs no store, no recovery and no reservation. Throws on any
 * deviation — the caller decides how corruption is surfaced; nothing here
 * repairs, rewrites or upgrades the file on disk.
 * @param {Buffer} bytes @param {string} domainId @returns {Snapshot}
 */
export function parseSnapshot(bytes, domainId) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const envelope = JSON.parse(text)
  // Exact byte equality rejects duplicate keys at every depth as well as
  // alternate number/escape spellings, whitespace and reordered keys.
  valid(Buffer.from(canonical(envelope)).equals(bytes), 'noncanonical snapshot')
  shape(envelope, ['payload', 'checksum'])
  const payload = envelope.payload
  shape(payload, ['version', 'domainId', 'revision', 'state'])
  valid(typeof payload.version === 'number' && [2, 3, 4, 5, 6].includes(payload.version), `snapshot version ${payload.version}; supported: 2, 3, 4, 5, 6; recover with a newer build or restore a pre-upgrade snapshot`)
  valid(payload.domainId === domainId, 'snapshot domain')
  valid(payload.state !== null && typeof payload.state === 'object' && 'version' in payload.state && payload.state.version === payload.version, 'snapshot/image version mismatch')
  valid(integer(payload.revision), 'snapshot revision')
  valid(typeof envelope.checksum === 'string' && envelope.checksum === createHash('sha256').update(canonical(payload)).digest('hex'), 'snapshot checksum')
  // Verify legacy closeout shapes before upgrading: new semantics must never
  // be smuggled into an old image. Integrity above is against the original bytes.
  const legacy = payload.version === 2 ? upgradeFromV2(payload.state) : payload.state
  const state = /** @type {AuthorityImage} */ (payload.version < 4 ? upgradeFromV3(legacy) : legacy)
  validateImage(state)
  for (const row of state.adminRecoveries ?? []) valid(row.root === domainId && row.committedRevision <= payload.revision, 'administrative domain/revision')
  return { revision: payload.revision, state }
}
