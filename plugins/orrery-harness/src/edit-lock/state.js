/**
 * Unmounted, synchronous, in-memory authorization kernel. No IO or runtime imports.
 * The embedding manager MUST keep `authority` private, derive session identity from
 * trusted execution context, and supply canonical resource IDs. Fencing fields are
 * not authentication secrets. checkWrite is an observation, NOT a transferable
 * permission to publish later; a future manager must serialize actual publication.
 *
 * @typedef {{ managerIncarnation: string, sessionId: string, executionEpoch: number }} Execution
 * @typedef {Execution & { resourceId: string, generation: number }} Ownership
 * @typedef {{ sessionId: string, executionEpoch: number, interrupted: boolean }} Session
 * @typedef {{ resourceId: string, owner: string, generation: number, status: 'active' | 'user-interrupted' | 'pending-confirmation' | 'abnormal', reason?: string }} Lock
 */

/** @param {string} managerIncarnation */
export function createEditLockState(managerIncarnation) {
  requireId(managerIncarnation)
  /** @type {Map<string, Session>} */
  const sessions = new Map()
  /** @type {Map<string, Lock>} */
  const locks = new Map()
  // Tombstones survive release so the same owner cannot revive an old token.
  /** @type {Map<string, number>} */
  const generations = new Map()
  /** @type {WeakMap<object, Execution & { requestId: string }>} */
  const receipts = new WeakMap()
  // Keep request tombstones for this in-memory manager lifetime, even after consumption.
  /** @type {Map<string, Set<string>>} */
  const issuedRequests = new Map()

  /** @param {Execution} execution */
  function sessionFor(execution) {
    if (!execution || typeof execution !== 'object') throw new Error('invalid execution')
    if (execution.managerIncarnation !== managerIncarnation) throw new Error('stale incarnation')
    const session = sessions.get(execution.sessionId)
    if (!session) throw new Error('unknown session')
    if (session.executionEpoch !== execution.executionEpoch) throw new Error('stale epoch')
    return session
  }

  /** @param {Ownership} token */
  function lockFor(token) {
    sessionFor(token)
    const lock = locks.get(token.resourceId)
    if (!lock || lock.owner !== token.sessionId || lock.generation !== token.generation) {
      throw new Error('stale ownership')
    }
    return lock
  }

  const operations = {
    /** @param {Execution} execution @param {string} resourceId @returns {Ownership} */
    acquire(execution, resourceId) {
      const session = sessionFor(execution)
      requireId(resourceId)
      if (session.interrupted) throw new Error('session interrupted')
      const existing = locks.get(resourceId)
      if (existing && existing.owner !== execution.sessionId) throw new Error('resource owned')
      if (existing?.status === 'abnormal') throw new Error('lock abnormal')
      const lock = existing ?? { resourceId, owner: execution.sessionId, generation: (generations.get(resourceId) ?? 0) + 1, status: 'active' }
      lock.status = 'active'
      generations.set(resourceId, lock.generation)
      locks.set(resourceId, lock)
      return { ...execution, resourceId, generation: lock.generation }
    },
    /** @param {Ownership} token */
    release(token) {
      lockFor(token)
      locks.delete(token.resourceId)
    },
    /** @param {Ownership} token */
    checkWrite(token) {
      const lock = lockFor(token)
      if (lock.status !== 'active') throw new Error('lock not active')
      return { allowed: true }
    },
    /** Consume an opaque receipt issued only by the trusted authority facet.
     * @param {Execution} execution @param {string} requestId @param {object} receipt
     * @returns {Execution} */
    resume(execution, requestId, receipt) {
      const session = sessionFor(execution)
      const binding = receipts.get(receipt)
      if (!binding || binding.sessionId !== session.sessionId ||
          binding.executionEpoch !== session.executionEpoch || binding.requestId !== requestId) {
        throw new Error('invalid receipt')
      }
      receipts.delete(receipt)
      session.executionEpoch += 1
      session.interrupted = false
      for (const lock of locks.values()) {
        if (lock.owner === session.sessionId && lock.status === 'user-interrupted') lock.status = 'pending-confirmation'
      }
      return { managerIncarnation, sessionId: session.sessionId, executionEpoch: session.executionEpoch }
    },
    status() {
      return {
        managerIncarnation,
        sessions: [...sessions.values()].map(session => ({ ...session })),
        locks: [...locks.values()].map(lock => ({ ...lock })),
      }
    },
  }

  const authority = {
    /** Record only a trusted, already successful native creation, never an acquisition.
     * The manager must validate publishing history and canonical identity first.
     * @param {Execution} origin @param {string} resourceId @returns {Ownership} */
    settleCreated(origin, resourceId) {
      requireId(resourceId)
      if (!origin || origin.managerIncarnation !== managerIncarnation) throw new Error('stale incarnation')
      const session = sessions.get(origin.sessionId)
      if (!session) throw new Error('unknown session')
      if (!Number.isSafeInteger(origin.executionEpoch) || origin.executionEpoch < 1 ||
          origin.executionEpoch > session.executionEpoch) throw new Error('invalid creation epoch')
      if (locks.has(resourceId)) throw new Error('resource owned')
      const generation = (generations.get(resourceId) ?? 0) + 1
      if (!Number.isSafeInteger(generation)) throw new Error('generation exhausted')
      const active = !session.interrupted && origin.executionEpoch === session.executionEpoch
      locks.set(resourceId, { resourceId, owner: session.sessionId, generation,
        status: active ? 'active' : 'user-interrupted' })
      generations.set(resourceId, generation)
      return { managerIncarnation, sessionId: session.sessionId, executionEpoch: session.executionEpoch, resourceId, generation }
    },
    /** Detached historical core, not a permission or a restore credential. */
    checkpoint() {
      return {
        ...operations.status(),
        generations: [...generations].map(([resourceId, generation]) => ({ resourceId, generation })),
        issuedRequests: [...issuedRequests].flatMap(([sessionId, requests]) =>
          [...requests].map(requestId => ({ sessionId, requestId }))),
      }
    },
    /** Register a trusted initial execution, never rearm an existing session.
     * @param {string} sessionId @returns {Execution} */
    openSession(sessionId) {
      requireId(sessionId)
      if (sessions.has(sessionId)) throw new Error('session already registered')
      sessions.set(sessionId, { sessionId, executionEpoch: 1, interrupted: false })
      return { managerIncarnation, sessionId, executionEpoch: 1 }
    },
    /** Revoke one trusted execution; the returned epoch allows cleanup, not edits.
     * @param {Execution} execution @returns {Execution} */
    cancel(execution) {
      const session = sessionFor(execution)
      session.executionEpoch += 1
      session.interrupted = true
      for (const lock of locks.values()) {
        if (lock.owner === session.sessionId && lock.status !== 'abnormal') lock.status = 'user-interrupted'
      }
      return { managerIncarnation, sessionId: session.sessionId, executionEpoch: session.executionEpoch }
    },
    /** Retain a trusted abnormal classification; no automatic recovery is provided.
     * @param {Ownership} token @param {string} reason */
    markAbnormal(token, reason) {
      const lock = lockFor(token)
      requireId(reason)
      lock.status = 'abnormal'
      lock.reason = reason
    },
    /** Trusted explicit-intent boundary, NOT a model-callable tool or classifier.
     * Call only after authenticating a human execution request outside this kernel.
     * Receipts are process-local object capabilities; copies/JSON cannot redeem them.
     * @param {Execution} execution @param {string} requestId @returns {object} */
    issueExecutionReceipt(execution, requestId) {
      sessionFor(execution)
      requireId(requestId)
      const issued = issuedRequests.get(execution.sessionId) ?? new Set()
      if (issued.has(requestId)) throw new Error('request already issued')
      issued.add(requestId)
      issuedRequests.set(execution.sessionId, issued)
      const receipt = Object.freeze({})
      receipts.set(receipt, { ...execution, requestId })
      return receipt
    },
  }
  return { operations, authority }
}

/** Validate opaque identifiers without interpreting or normalizing paths.
 * @param {string} value */
function requireId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid identifier')
}
