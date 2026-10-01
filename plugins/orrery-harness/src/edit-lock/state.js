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

/** Private transfer seam; no raw hydration is exported. */
const cores = new WeakMap()
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
  let revision = 0
  const drafts = new WeakMap()
  /** @param {object} draft */
  function draftFor(draft) {
    const entry = drafts.get(draft)
    if (!entry || entry.closed || entry.base !== revision) throw new Error('invalid or stale draft')
    return entry
  }

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
    /** Import only a validated historical checkpoint into a fresh kernel.
     * The opaque candidate has no mutation facets; it can only be inspected,
     * installed after persistence, or discarded. No receipts are imported.
     * @param {{ managerIncarnation: string, sessions: Session[], locks: Lock[], generations: {resourceId: string, generation: number}[], issuedRequests: {sessionId: string, requestId: string}[] }} history */
    beginRecovery(history) {
      if (revision !== 0) throw new Error('recovery requires fresh kernel')
      if (!history || history.managerIncarnation === managerIncarnation) throw new Error('recovery requires new incarnation')
      requireId(history.managerIncarnation)
      const child = createEditLockState(managerIncarnation)
      const core = cores.get(child)
      for (const session of history.sessions) {
        requireId(session.sessionId)
        const epoch = session.executionEpoch + (session.interrupted ? 0 : 1)
        if (typeof session.interrupted !== 'boolean' || !Number.isSafeInteger(session.executionEpoch) ||
            session.executionEpoch < 1 || !Number.isSafeInteger(epoch) || core.sessions.has(session.sessionId)) throw new Error('invalid recovery session')
        core.sessions.set(session.sessionId, { sessionId: session.sessionId, executionEpoch: epoch, interrupted: true })
      }
      for (const item of history.generations) {
        requireId(item.resourceId)
        if (!Number.isSafeInteger(item.generation) || item.generation < 1 || core.generations.has(item.resourceId)) throw new Error('invalid recovery generation')
        core.generations.set(item.resourceId, item.generation)
      }
      for (const lock of history.locks) {
        requireId(lock.resourceId)
        if (!core.sessions.has(lock.owner) || core.locks.has(lock.resourceId) || core.generations.get(lock.resourceId) !== lock.generation ||
            !['active', 'pending-confirmation', 'user-interrupted', 'abnormal'].includes(lock.status)) throw new Error('invalid recovery lock')
        if (lock.status === 'abnormal') {
          if (typeof lock.reason !== 'string') throw new Error('invalid recovery reason')
          requireId(lock.reason)
        }
        core.locks.set(lock.resourceId, { resourceId: lock.resourceId, owner: lock.owner, generation: lock.generation,
          status: lock.status === 'abnormal' ? 'abnormal' : 'user-interrupted',
          ...(lock.status === 'abnormal' ? { reason: lock.reason } : {}) })
      }
      for (const item of history.issuedRequests) {
        requireId(item.requestId)
        if (!core.sessions.has(item.sessionId)) throw new Error('invalid recovery request')
        const issued = core.issuedRequests.get(item.sessionId) ?? new Set()
        if (issued.has(item.requestId)) throw new Error('duplicate recovery request')
        issued.add(item.requestId)
        core.issuedRequests.set(item.sessionId, issued)
      }
      // Seal the fresh-only ingress and invalidate earlier empty candidates.
      revision += 1
      const draft = Object.freeze({})
      drafts.set(draft, { base: revision, closed: false, child, core, issued: new Map() })
      return draft
    },
    begin() {
      const child = createEditLockState(managerIncarnation)
      const core = cores.get(child)
      for (const [key, value] of sessions) core.sessions.set(key, { ...value })
      for (const [key, value] of locks) core.locks.set(key, { ...value })
      for (const [key, value] of generations) core.generations.set(key, value)
      for (const [key, value] of issuedRequests) core.issuedRequests.set(key, new Set(value))
      const entry = { base: revision, closed: false, child, core, issued: new Map() }
      /** @param {object} facet */
      const guard = facet => Object.freeze(Object.fromEntries(Object.entries(facet).map(([key, method]) => [key,
        /** @param {...any} args */
        (...args) => {
          if (entry.closed || entry.base !== revision) throw new Error('invalid or stale draft')
          if (['begin', 'beginRecovery', 'install', 'discard'].includes(key)) {
            throw new Error('operation unavailable in draft')
          }
          if (key === 'issueExecutionReceipt') {
            const receipt = method(...args)
            entry.issued.set(receipt, core.receipts.get(receipt))
            core.receipts.delete(receipt)
            return receipt
          }
          if (key === 'resume') {
            const receipt = args[2]
            const binding = receipts.get(receipt)
            if (!binding) throw new Error('invalid receipt')
            core.receipts.set(receipt, binding)
            try {
              const result = method(...args)
              receipts.delete(receipt)
              revision += 1
              entry.base = revision
              return result
            } finally {
              core.receipts.delete(receipt)
            }
          }
          return method(...args)
        },
      ])))
      const draft = Object.freeze({ operations: guard(child.operations), authority: guard(child.authority) })
      drafts.set(draft, entry)
      return draft
    },
    /** @param {object} draft */
    install(draft) {
      const entry = draftFor(draft)
      entry.closed = true
      sessions.clear(); locks.clear(); generations.clear(); issuedRequests.clear()
      for (const [key, value] of entry.core.sessions) sessions.set(key, { ...value })
      for (const [key, value] of entry.core.locks) locks.set(key, { ...value })
      for (const [key, value] of entry.core.generations) generations.set(key, value)
      for (const [key, value] of entry.core.issuedRequests) issuedRequests.set(key, new Set(value))
      for (const [receipt, binding] of entry.issued) receipts.set(receipt, binding)
      entry.issued.clear()
      revision += 1
    },
    /** @param {object} draft */
    discard(draft) {
      const entry = draftFor(draft)
      entry.closed = true
      entry.issued.clear()
    },
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
    /** Detached historical core, not a permission or a restore credential.
     * @param {object} [draft] */
    checkpoint(draft) {
      if (draft) return draftFor(draft).child.authority.checkpoint()
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
  // Advance even on rejection: conservatively invalidate outstanding candidates.
  /** @param {Record<string, (...args: any[]) => any>} facet @param {string[]} names */
  function track(facet, names) {
    for (const name of names) {
      const method = facet[name]
      /** @param {...any} args */
      facet[name] = (...args) => { revision += 1; return method(...args) }
    }
  }
  track(operations, ['acquire', 'release', 'resume'])
  track(authority, ['openSession', 'cancel', 'markAbnormal', 'issueExecutionReceipt', 'settleCreated'])
  const kernel = { operations: Object.freeze(operations), authority: Object.freeze(authority) }
  cores.set(kernel, { sessions, locks, generations, issuedRequests, receipts })
  return Object.freeze(kernel)
}

/** Validate opaque identifiers without interpreting or normalizing paths.
 * @param {string} value */
function requireId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid identifier')
}
