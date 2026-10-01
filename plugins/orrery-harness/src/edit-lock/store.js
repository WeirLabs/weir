import { createHash, randomUUID } from 'node:crypto'
import { open, rename, lstat, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Unmounted historical Edit Lock snapshot storage, NOT a kernel restore interface.
 * The caller MUST already hold an externally proven exclusive directory lifecycle
 * and establish old-publisher quiescence, continuously through close(). This module
 * supplies neither singleton election nor cross-handle CAS, authentication or fences.
 * No intent/outcome ledger, operation idempotency or file publication lives here.
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
 * @typedef {{ version: 1, managerIncarnation: string|null, sessions: Session[], generations: Generation[], locks: Lock[], issuedRequests: IssuedRequest[], recovery: Recovery[] }} AuthorityImage
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
    const payload = { version: 1, domainId, ...snapshot }
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
    current = { revision: 0, state: { version: 1, managerIncarnation: null, sessions: [], generations: [], locks: [], issuedRequests: [], recovery: [] } }
    await persist(current)
  } else {
    valid((await lstat(target)).isFile(), 'snapshot must be regular file')
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      valid((await file.stat()).isFile(), 'snapshot must be regular file')
      const bytes = await file.readFile()
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const envelope = JSON.parse(text)
      // Exact byte equality rejects duplicate keys at every depth as well as
      // alternate number/escape spellings, whitespace and reordered keys.
      valid(Buffer.from(canonical(envelope)).equals(bytes), 'noncanonical snapshot')
      shape(envelope, ['payload', 'checksum'])
      const payload = envelope.payload
      shape(payload, ['version', 'domainId', 'revision', 'state'])
      valid(payload.version === 1 && payload.domainId === domainId, 'snapshot version/domain')
      valid(integer(payload.revision), 'snapshot revision')
      valid(typeof envelope.checksum === 'string' && envelope.checksum === createHash('sha256').update(canonical(payload)).digest('hex'), 'snapshot checksum')
      const state = /** @type {AuthorityImage} */ (payload.state)
      validateImage(state)
      current = { revision: payload.revision, state }
    } finally { await file.close() }
  }
  let tail = Promise.resolve()
  let closed = false
  /** @type {unknown} */
  let poison
  function healthy() { if (poison) throw new Error('store poisoned; recover under exclusive lifecycle', { cause: poison }) }
  return {
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
      const pending = tail.then(async () => {
        healthy()
        if (expectedRevision !== current.revision) throw new Error('revision conflict')
        validateTransition(current.state, state)
        valid(integer(current.revision + 1), 'revision overflow')
        const next = { revision: current.revision + 1, state }
        try { await persist(next) } catch (error) { poison = error; throw error }
        current = next
        return structuredClone(current)
      })
      tail = pending.then(() => {}, () => {})
      return pending
    },
    async close() { closed = true; await tail },
  }
}

/** Deterministic JSON: UTF-16 key order, JSON scalar spelling, no whitespace.
 * Array order is retained (including the historical image's ordered collections).
 * @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
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
/** @param {AuthorityImage} state */
function validateImage(state) {
  shape(state, ['version', 'managerIncarnation', 'sessions', 'generations', 'locks', 'issuedRequests', 'recovery'])
  valid(state.version === 1, 'image version')
  valid(state.managerIncarnation === null || id(state.managerIncarnation), 'incarnation')
  for (const collection of [state.sessions, state.generations, state.locks, state.issuedRequests, state.recovery]) {
    valid(Array.isArray(collection) && Object.getPrototypeOf(collection) === Array.prototype, 'collection')
    valid(Reflect.ownKeys(collection).length === collection.length + 1, 'dense collection keys')
    for (let i = 0; i < collection.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(collection, i)
      valid(descriptor && 'value' in descriptor && descriptor.enumerable, 'collection data property')
    }
  }
  valid(state.managerIncarnation !== null || [state.sessions, state.generations, state.locks, state.issuedRequests, state.recovery].every(list => list.length === 0), 'null incarnation with history')
  const sessions = new Map(state.sessions.map(session => {
    shape(session, ['sessionId', 'executionEpoch', 'interrupted'])
    valid(id(session.sessionId) && integer(session.executionEpoch, 1) && typeof session.interrupted === 'boolean', 'session')
    return [session.sessionId, session]
  }))
  valid(sessions.size === state.sessions.length, 'duplicate session')
  const generations = new Map(state.generations.map(entry => {
    shape(entry, ['resourceId', 'generation'])
    valid(id(entry.resourceId) && integer(entry.generation, 1), 'generation')
    return [entry.resourceId, entry.generation]
  }))
  valid(generations.size === state.generations.length, 'duplicate generation')
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
}


/** Storage invariants, not authorization of a kernel transition.
 * Counters are cumulative lifetime charges, never resettable retry policy.
 * @param {AuthorityImage} before @param {AuthorityImage} after */
function validateTransition(before, after) {
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
}
