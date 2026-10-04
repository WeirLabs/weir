import { createHash, randomUUID } from 'node:crypto'
import { open, rename, lstat, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateOperationTransitions } from './operation-history.js'
import { canonical, parseSnapshot, validateImage } from './snapshot.js'

/**
 * Unmounted historical Edit Lock snapshot storage, NOT a kernel restore interface.
 * The caller MUST already hold an externally proven exclusive directory lifecycle
 * and establish old-publisher quiescence, continuously through close(). This module
 * supplies neither singleton election nor cross-handle CAS, authentication or live fences.
 * Operation history shares this image; it cannot publish files or restore authority.
 * Receipts are process-local capabilities and MUST NOT be persisted.
 * POSIX local-filesystem foundation: the dedicated directory and its ancestors
 * must remain under the caller's exclusive control, with no concurrent mutation.
 * No cleanup/repair is automatic; failed creates may leave a temp or snapshot.
 * Recover reads only snapshot.json; integrity is a checksum, not authentication.
 * Unsupported directory sync semantics fail the open/write, never weaken the ack.
 * A poisoned handle rejects reads too, so stale memory cannot imply rollback.
 * close() drains and releases admission only; record promises carry write errors.
 *
 * @typedef {{ sessionId: string, executionEpoch: number, interrupted: boolean }} Session
 * @typedef {{ resourceId: string, generation: number }} Generation
 * @typedef {{ resourceId: string, owner: string, generation: number, status: 'active'|'user-interrupted'|'pending-confirmation'|'abnormal', reason?: string }} Lock
 * @typedef {{ sessionId: string, requestId: string }} IssuedRequest
 * @typedef {{ sessionId: string, attempts: number, elapsedMs: number, pauseMs: number }} Recovery
 * Retention (design D1) is a session-level budget: one lock batch shares one
 * cumulative allowance, and `holdUntil` is an absolute epoch-ms instant. A held
 * lock keeps its ordinary status, so `holds` is a separate table, never a lock
 * status. Version 3 adds it; a version 2 image is upgraded losslessly on recover
 * (one empty retention row per session). Version 4 preserves v2/v3 historical
 * assertions as inert records; the next durable write uses version 4.
 * @typedef {{ sessionId: string, holding: boolean, holdUntil: number|null, holdCumulativeMs: number }} HoldState
 * @typedef {{ version: 4, managerIncarnation: string|null, sessions: Session[], generations: Generation[], locks: Lock[], issuedRequests: IssuedRequest[], recovery: Recovery[], holds: HoldState[], operations: import('./operation-history.js').Operation[] }} AuthorityImage
 * @typedef {{ revision: number, state: AuthorityImage }} Snapshot
 */

/**
 * snapshot() and record() return detached historical data, never live authority.
 * record() captures input before yielding; acknowledgement follows directory sync
 * and close. Revisions are local to this handle, not a singleton mechanism.
 * @param {{ directory: string, domainId: string, mode: 'create'|'recover' }} options
 * @param {{ checkpoint?: (point: string) => void|Promise<void> }} [testing]
 * Test-only syscall barriers surround REAL IO; they never replace filesystem calls.
 */
export async function openEditLockStore({ directory, domainId, mode }, testing = {}) {
  valid(id(directory) && id(domainId) && (mode === 'create' || mode === 'recover'), 'store options')
  directory = resolve(directory)
  valid((await lstat(directory)).isDirectory(), 'store directory')
  if (mode === 'create') valid((await readdir(directory)).length === 0, 'create requires empty directory')
  const target = join(resolve(directory), 'snapshot.json')
  /** @type {Snapshot} */
  let current
  /** @param {Snapshot} snapshot */
  async function persist(snapshot) {
    const payload = { version: 4, domainId, ...snapshot }
    const body = canonical(payload)
    const bytes = canonical({ payload, checksum: createHash('sha256').update(body).digest('hex') })
    const temporary = join(resolve(directory), `.snapshot-${randomUUID()}.tmp`)
    /** @type {import('node:fs/promises').FileHandle|undefined} */
    let file
    /** @type {import('node:fs/promises').FileHandle|undefined} */
    let dir
    let renameStarted = false
    /** @param {string} step @param {() => Promise<void>} operation */
    async function io(step, operation) {
      await testing.checkpoint?.(`before:${step}`)
      await operation()
      await testing.checkpoint?.(`after:${step}`)
    }
    try {
      await io('temp-open', async () => { file = await open(temporary, 'wx', 0o600) })
      valid(file, 'opened snapshot descriptor')
      const openedFile = file
      await io('write', async () => { await openedFile.writeFile(bytes, 'utf8') })
      await io('file-sync', async () => { await openedFile.sync() })
      await io('file-close', async () => { await openedFile.close(); file = undefined })
      await io('rename', async () => { renameStarted = true; await rename(temporary, target) })
      await io('directory-open', async () => { dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) })
      valid(dir, 'opened directory descriptor')
      const openedDirectory = dir
      await io('directory-sync', async () => { await openedDirectory.sync() })
      await io('directory-close', async () => { await openedDirectory.close(); dir = undefined })
    } catch (cause) {
      // Never remove/promote a temp or roll back a rename. Once rename was
      // attempted its result is conservatively uncertain, including syscall errors.
      const error = Object.assign(new Error('snapshot persistence failed; handle poisoned', { cause }), {
        code: 'EDIT_LOCK_STORE_PERSISTENCE', commitStatus: renameStarted ? 'uncertain' : 'not-renamed',
      })
      // Close any acquired descriptors, but cleanup cannot turn failure into ack.
      await Promise.allSettled([file?.close(), dir?.close()])
      throw error
    }
  }
  if (mode === 'create') {
    current = { revision: 0, state: { version: 4, managerIncarnation: null, sessions: [], generations: [], locks: [], issuedRequests: [], recovery: [], holds: [], operations: [] } }
    await persist(current)
  } else {
    valid((await lstat(target)).isFile(), 'snapshot must be regular file')
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      valid((await file.stat()).isFile(), 'snapshot must be regular file')
      const bytes = await file.readFile()
      // The byte-level validation (canonical form, version, domain, checksum,
      // lossless upgrades, image invariants) lives in ./snapshot.js, shared
      // verbatim with the read-only maintenance inspector: a snapshot the
      // inspector calls valid is exactly one this recover accepts.
      current = parseSnapshot(bytes, domainId)
    } finally { await file.close() }
  }
  let tail = Promise.resolve()
  let closed = false
  /** @type {unknown} */
  let poison
  function healthy() { if (poison) throw new Error('store poisoned; recover under exclusive lifecycle', { cause: poison }) }
  /** Process-local evidence is issued only after permanently closing a live attempt. */
  const undispatched = new WeakMap()
  const recoveredKeys = new Set(current.state.operations.map(o => canonical([o.sessionId, o.operationId])))
  const api = {
    snapshot() { healthy(); return structuredClone(current) },
    /** @param {{ expectedRevision: number, nextState: AuthorityImage }} input */
    async record(input) {
      if (closed) throw new Error('store closed')
      healthy()
      shape(input, ['expectedRevision', 'nextState'])
      const { expectedRevision, nextState } = input
      valid(integer(expectedRevision), 'expected revision')
      validateImage(nextState)
      const state = structuredClone(nextState)
      validateImage(state)
      const proof = undispatched.get(input)
      undispatched.delete(input)
      const pending = tail.then(async () => {
        healthy()
        if (expectedRevision !== current.revision) throw new Error('revision conflict')
        let previous = current.state
        if (proof) {
          const index = previous.operations.findIndex(o => o.sessionId === proof.sessionId && o.operationId === proof.operationId)
          valid(index >= 0 && canonical(previous.operations[index]) === proof.operation, 'undispatched binding')
          previous = structuredClone(previous)
          // Validate the ordinary prepared -> not-published transition, only for
          // the privately proven never-invoked operation. All other invariants remain.
          previous.operations[index].phase = 'prepared'
          previous.operations[index].fence = null
        }
        validateTransition(previous, state)
        valid(integer(current.revision + 1), 'revision overflow')
        const next = { revision: current.revision + 1, state }
        try { await persist(next) } catch (error) { poison = error; throw error }
        current = next
        return structuredClone(current)
      })
      tail = pending.then(() => {}, () => {})
      return pending
    },
    /** Internal manager seam, not a tool API or an authorization check.
     * The caller exclusively owns the original mutation closure and lifecycle.
     * @template T
     * @param {{ expectedRevision: number, nextState: AuthorityImage }} input
     * @param {{sessionId: string, operationId: string}} key
     * @param {() => T} mutation */
    async beginPublication(input, key, mutation) {
      healthy()
      valid(typeof mutation === 'function', 'original mutation')
      const sessionId = key.sessionId, operationId = key.operationId
      const old = current.state.operations.find(o => o.sessionId === sessionId && o.operationId === operationId)
      valid(old?.phase === 'prepared' && !recoveredKeys.has(canonical([sessionId, operationId])), 'live prepared attempt required')
      const next = input.nextState.operations.find(o => o.sessionId === sessionId && o.operationId === operationId)
      valid(next?.phase === 'publishing', 'publishing intent required')
      const saved = await api.record(input)
      const operation = saved.state.operations.find(o => o.sessionId === sessionId && o.operationId === operationId)
      let available = true
      function consume() {
        if (!available) throw new Error('publication attempt closed')
        available = false
        healthy()
        if (closed || current.revision !== saved.revision) throw new Error('publication attempt stale or store closed')
      }
      return Object.freeze({
        invoke() { consume(); return mutation() },
        /** @param {'cancelled-before-dispatch'|'rejected-before-dispatch'} reason */
        async finishWithoutDispatch(reason) {
          consume()
          const state = structuredClone(saved.state)
          const op = state.operations.find(o => o.sessionId === sessionId && o.operationId === operationId)
          if (!op) throw new Error('missing publication')
          op.phase = 'not-published'; op.fence = null
          op.outcome = { kind: 'not-published', reason }
          const settlement = { expectedRevision: saved.revision, nextState: state }
          undispatched.set(settlement, { sessionId, operationId, operation: canonical(operation) })
          return api.record(settlement)
        },
      })
    },
    async close() { closed = true; await tail },
  }
  return Object.freeze(api)
}
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

/** Storage invariants, not authorization of a kernel transition.
 * Counters are cumulative lifetime charges, never resettable retry policy.
 * @param {AuthorityImage} before @param {AuthorityImage} after */
function validateTransition(before, after) {
  validateOperationTransitions(before, after)
  valid(before.managerIncarnation === null || after.managerIncarnation !== null, 'incarnation history')
  const sessions = new Map(after.sessions.map(s => [s.sessionId, s]))
  for (const old of before.sessions) {
    const next = sessions.get(old.sessionId)
    valid(next && next.executionEpoch >= old.executionEpoch, 'epoch history')
    if (next.interrupted !== old.interrupted) valid(next.executionEpoch > old.executionEpoch, 'interruption epoch')
  }
  const generations = new Map(after.generations.map(g => [g.resourceId, g.generation]))
  const previousGenerations = new Map(before.generations.map(g => [g.resourceId, g.generation]))
  const previousLocks = new Map(before.locks.map(lock => [lock.resourceId, lock]))
  for (const old of before.generations) valid((generations.get(old.resourceId) ?? 0) >= old.generation, 'generation history')
  for (const lock of after.locks) {
    const old = previousLocks.get(lock.resourceId)
    if (!old || old.owner !== lock.owner) valid(lock.generation > (previousGenerations.get(lock.resourceId) ?? 0), 'new ownership generation')
    if (old?.status === 'abnormal' && old.generation === lock.generation) valid(lock.status === 'abnormal', 'retained abnormal classification')
  }
  const requests = new Set(after.issuedRequests.map(r => canonical([r.sessionId, r.requestId])))
  for (const old of before.issuedRequests) valid(requests.has(canonical([old.sessionId, old.requestId])), 'request tombstone removal')
  const recoveries = new Map(after.recovery.map(r => [r.sessionId, r]))
  for (const old of before.recovery) {
    const next = recoveries.get(old.sessionId)
    valid(next && next.attempts >= old.attempts && next.elapsedMs >= old.elapsedMs && next.pauseMs >= old.pauseMs, 'recovery history')
  }
  // Retention history: the cumulative allowance only ever grows inside a batch.
  // A row may appear or disappear (a batch starts with the first lock and ends
  // with the last), but an existing row never loses allowance, and starting a
  // fresh batch is only legitimate when the session held no lock at all.
  const previousHolds = new Map(before.holds.map(held => [held.sessionId, held]))
  for (const held of after.holds) {
    const old = previousHolds.get(held.sessionId)
    if (old) {
      // The allowance never shrinks inside a batch; it returns to zero only when the
      // batch has ended, i.e. the session holds no lock any more.
      const batchEnded = !after.locks.some(lock => lock.owner === held.sessionId)
      valid(held.holdCumulativeMs >= old.holdCumulativeMs || (batchEnded && held.holdCumulativeMs === 0), 'retention history')
    } else {
      valid(held.holdCumulativeMs === 0 || !before.locks.some(lock => lock.owner === held.sessionId), 'retention batch restart')
    }
  }
}
