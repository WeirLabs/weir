import { isAbsolute, relative } from 'node:path'

/** Historical assertions only: no authentication, live permission or FS publication.
 * Digests MUST be computed by a future trusted publisher over canonical requests,
 * original arguments and actual payload bytes. Strings supplied here are not proof.
 * @typedef {{ kind: 'create', ancestor: string, suffix: string, policy: { kind: 'createIfAbsent' } } | { kind: 'update', resourceId: string, generation: number, policy: { kind: 'replaceIfVersion', version: string } }} Target
 * @typedef {{ tool: 'write'|'hash_edit'|'edit', filePath: string, cwd: string, requestDigest: string, argsDigest: string, payloadDigest: string, target: Target }} Binding
 * @typedef {{ kind: 'resource', resourceId: string } | { kind: 'subtree', ancestor: string, basis: 'observed-ancestor'|'conservative-ancestor' } | { kind: 'domain', basis: 'containment-unproved' }} Fence
 * @typedef {{ kind: 'created'|'updated', resourceId: string, generation: number, version: string } | { kind: 'unknown' } | { kind: 'not-published', reason: 'cancelled-before-dispatch'|'rejected-before-dispatch' }} Outcome
 * @typedef {{ kind: 'abandoned-unknown'|'not-published-evidence', assertionId: string }} Closeout
 * @typedef {{ sessionId: string, operationId: string, origin: { executionEpoch: number, managerIncarnation: string }, binding: Binding, phase: 'prepared'|'publishing'|'created'|'updated'|'unknown'|'not-published', fence: Fence|null, outcome: Outcome|null, closeouts: Closeout[] }} Operation
 */

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function valid(condition, message) {
  if (!condition) throw new Error(`invalid operation ${message}`)
}
/** @param {unknown} value @returns {value is string} */
function id(value) { return typeof value === 'string' && value.length > 0 && !value.includes('\0') }
/** @param {unknown} value @returns {value is number} */
function positive(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
/** @param {unknown} value @param {string[]} keys @returns {asserts value is Record<string, unknown>} */
function shape(value, keys) {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value), 'object')
  valid(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'prototype')
  valid(Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'schema keys')
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key)
    valid(d && 'value' in d && d.enumerable, 'data property')
  }
}
/** @param {unknown} value @returns {asserts value is unknown[]} */
function array(value) {
  valid(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, 'array')
  valid(Reflect.ownKeys(value).length === value.length + 1, 'array keys')
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, i)
    valid(d && 'value' in d && d.enumerable, 'array data')
  }
}
/** @param {Binding} binding */
export function validateBinding(binding) {
  shape(binding, ['tool', 'filePath', 'cwd', 'requestDigest', 'argsDigest', 'payloadDigest', 'target'])
  valid(['write', 'hash_edit', 'edit'].includes(binding.tool), 'tool')
  valid(id(binding.filePath) && id(binding.cwd) && isAbsolute(binding.cwd), 'literal path/cwd')
  for (const digest of [binding.requestDigest, binding.argsDigest, binding.payloadDigest]) {
    valid(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'digest')
  }
  const target = binding.target
  if (target.kind === 'create') {
    shape(target, ['kind', 'ancestor', 'suffix', 'policy'])
    valid(binding.tool === 'write', 'creation is write-only')
    valid(id(target.ancestor) && isAbsolute(target.ancestor) && id(target.suffix) && !isAbsolute(target.suffix) && !target.suffix.split('/').includes('..'), 'create descriptor')
    shape(target.policy, ['kind'])
    valid(target.policy.kind === 'createIfAbsent', 'frozen create policy')
  } else {
    shape(target, ['kind', 'resourceId', 'generation', 'policy'])
    valid(target.kind === 'update' && id(target.resourceId) && isAbsolute(target.resourceId) && positive(target.generation), 'update descriptor')
    shape(target.policy, ['kind', 'version'])
    valid(target.policy.kind === 'replaceIfVersion' && typeof target.policy.version === 'string', 'guarded update policy')
  }
}
/** Store-internal validation; collections are never a second authority map.
 * @param {import('./store.js').AuthorityImage} state */
export function validateOperations(state) {
  array(state.operations)
  const keys = new Set()
  const generations = new Map(state.generations.map(g => [g.resourceId, g.generation]))
  for (const op of state.operations) {
    shape(op, ['sessionId', 'operationId', 'origin', 'binding', 'phase', 'fence', 'outcome', 'closeouts'])
    valid(id(op.sessionId) && id(op.operationId), 'key')
    const key = JSON.stringify([op.sessionId, op.operationId])
    valid(!keys.has(key), 'duplicate key'); keys.add(key)
    const session = state.sessions.find(s => s.sessionId === op.sessionId)
    shape(op.origin, ['executionEpoch', 'managerIncarnation'])
    valid(positive(op.origin.executionEpoch) && id(op.origin.managerIncarnation) && session && session.executionEpoch >= op.origin.executionEpoch, 'origin')
    validateBinding(op.binding)
    valid(['prepared', 'publishing', 'created', 'updated', 'unknown', 'not-published'].includes(op.phase), 'phase')
    if (op.phase === 'prepared') valid(op.fence === null && op.outcome === null, 'prepared phase')
    else if (op.phase === 'not-published') {
      valid(op.fence === null, 'undispatched fence')
      shape(op.outcome, ['kind', 'reason'])
      valid(op.outcome.kind === 'not-published' && ['cancelled-before-dispatch', 'rejected-before-dispatch'].includes(op.outcome.reason), 'undispatched outcome')
    }
    else {
      validateFence(op)
      if (op.phase === 'publishing') valid(op.outcome === null, 'publishing outcome')
      else if (op.phase === 'unknown') {
        shape(op.outcome, ['kind'])
        valid(op.outcome.kind === 'unknown', 'unknown outcome')
      }
      else {
        shape(op.outcome, ['kind', 'resourceId', 'generation', 'version'])
        valid(op.outcome.kind === 'created' || op.outcome.kind === 'updated', 'success outcome')
        valid(op.outcome.kind === op.phase && id(op.outcome.resourceId) && isAbsolute(op.outcome.resourceId) && positive(op.outcome.generation) && typeof op.outcome.version === 'string', 'outcome')
        // Lifetime references survive release/reownership; current locks are irrelevant.
        valid((generations.get(op.outcome.resourceId) ?? 0) >= op.outcome.generation, 'success generation history')
        valid(op.phase === (op.binding.target.kind === 'create' ? 'created' : 'updated'), 'outcome channel')
        if (op.binding.target.kind === 'update') valid(op.outcome.resourceId === op.binding.target.resourceId && op.outcome.generation === op.binding.target.generation, 'update outcome binding')
        if (op.phase === 'created' && op.fence?.kind === 'subtree') {
          const suffix = relative(op.fence.ancestor, op.outcome.resourceId)
          valid(suffix.length > 0 && suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix), 'created containment')
        }
      }
    }
    if ((op.phase === 'publishing' || op.phase === 'unknown') && op.binding.target.kind === 'update') {
      const target = op.binding.target
      const lock = state.locks.find(l => l.resourceId === target.resourceId)
      valid(lock && lock.owner === op.sessionId && lock.generation === target.generation, 'retained unresolved ownership')
    }
    array(op.closeouts)
    valid(op.phase === 'unknown' || op.closeouts.length === 0, 'unknown-only closeout')
    const assertions = new Set()
    for (const closeout of op.closeouts) {
      shape(closeout, ['kind', 'assertionId'])
      valid(['abandoned-unknown', 'not-published-evidence'].includes(closeout.kind) && id(closeout.assertionId) && !assertions.has(closeout.assertionId), 'closeout assertion')
      assertions.add(closeout.assertionId)
    }
  }
}

/** Containment here is a historical assertion, NOT filesystem/alias proof. The
 * future publisher must establish the observed ancestor and scope before dispatch.
 * @param {Operation} op */
function validateFence(op) {
  const fence = op.fence
  valid(fence, 'durable fence required')
  const target = op.binding.target
  if (target.kind === 'update') {
    shape(fence, ['kind', 'resourceId'])
    valid(fence.kind === 'resource' && fence.resourceId === target.resourceId, 'resource fence')
  } else if (fence.kind === 'subtree') {
    shape(fence, ['kind', 'ancestor', 'basis'])
    valid(id(fence.ancestor) && isAbsolute(fence.ancestor), 'subtree scope')
    if (fence.basis === 'observed-ancestor') valid(fence.ancestor === target.ancestor, 'minimal ancestor')
    else {
      valid(fence.basis === 'conservative-ancestor', 'scope basis')
      const suffix = relative(fence.ancestor, target.ancestor)
      valid(suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix), 'conservative containment')
    }
  } else {
    shape(fence, ['kind', 'basis'])
    valid(fence.kind === 'domain' && fence.basis === 'containment-unproved', 'domain fallback')
  }
}

/** Structural comparison independent of object insertion order.
 * @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
/** No current authority checks: authenticate the querying session outside this
 * historical seam. Original epoch/incarnation are NOT fields of a retry query.
 * A returned prepared/publishing record is never permission to redispatch.
 * @param {import('./store.js').AuthorityImage} state
 * @param {{sessionId: string, operationId: string, binding: Binding}} query
 * @returns {Operation|null} */
export function lookupOperation(state, query) {
  const op = state.operations.find(o => o.sessionId === query.sessionId && o.operationId === query.operationId)
  if (!op) return null
  if (canonical(op.binding) !== canonical(query.binding)) throw new Error('ID_REUSE: operation binding differs')
  return structuredClone(op)
}
/** Always called by raw store.record too.
 * @param {import('./store.js').AuthorityImage} before
 * @param {import('./store.js').AuthorityImage} after */
export function validateOperationTransitions(before, after) {
  for (const next of after.operations) {
    const old = lookupOperation(before, next)
    if (!old) {
      valid(next.phase === 'prepared', 'new history must be prepared')
      valid(next.origin.managerIncarnation === after.managerIncarnation && next.origin.executionEpoch === after.sessions.find(s => s.sessionId === next.sessionId)?.executionEpoch, 'initial origin')
    }
  }
  // One before/after ownership transition can credit only one new creation.
  // Do not count unchanged successful history from earlier generations.
  const createdResources = new Set()
  for (const old of before.operations) {
    const next = lookupOperation(after, old)
    valid(next, 'history removal')
    valid(canonical(next.origin) === canonical(old.origin), 'immutable origin')
    const previousSession = before.sessions.find(s => s.sessionId === old.sessionId)
    const session = after.sessions.find(s => s.sessionId === old.sessionId)
    valid(previousSession && session, 'operation session')
    if (canonical(old) !== canonical(next) && previousSession.interrupted) valid(session.interrupted && session.executionEpoch === previousSession.executionEpoch, 'operation transition cannot rearm session')
    if (old.phase === 'prepared') valid(['prepared', 'publishing', 'not-published'].includes(next.phase), 'prepared transition')
    else {
      valid(canonical(old.fence) === canonical(next.fence), 'immutable fence')
      if (old.phase === 'publishing') valid(['publishing', 'created', 'updated', 'unknown'].includes(next.phase), 'publishing transition')
      else {
        valid(old.phase === next.phase && canonical(old.outcome) === canonical(next.outcome), 'immutable terminal history')
        valid(next.closeouts.length >= old.closeouts.length && old.closeouts.every((c, i) => canonical(c) === canonical(next.closeouts[i])), 'append-only closeout')
      }
    }
    if (old.phase === 'publishing' && next.outcome && (next.outcome.kind === 'created' || next.outcome.kind === 'updated')) {
      const outcome = next.outcome
      const lock = after.locks.find(l => l.resourceId === outcome.resourceId)
      valid(lock && lock.owner === next.sessionId && lock.generation === outcome.generation, 'atomic outcome ownership')
      if (next.outcome.kind === 'created') {
        valid(!before.locks.some(l => l.resourceId === outcome.resourceId), 'created requires new ownership')
        valid(!createdResources.has(outcome.resourceId), 'duplicate created resource attribution')
        createdResources.add(outcome.resourceId)
      }
      if (session.interrupted) valid(lock.status === 'user-interrupted' || lock.status === 'abnormal', 'retained interrupted classification')
      if (session.executionEpoch !== old.origin.executionEpoch || after.managerIncarnation !== old.origin.managerIncarnation) valid(lock.status !== 'active', 'retained stale execution classification')
    }
  }
}
