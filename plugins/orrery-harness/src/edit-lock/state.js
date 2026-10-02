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
 *
 * Retention (design D1) is a SESSION-level budget: one lock batch shares a single
 * cumulative allowance, so the user reads one expiry instead of N countdowns.
 * `holding` means the session's turn ended while it still owns locks. It is NOT a
 * lock status: a held lock keeps its ordinary `active` status and its ordinary
 * meaning, so another session is still refused and a transfer is still negotiated.
 * `holdUntil` is an absolute epoch-ms instant supplied by the caller (this kernel
 * reads no clock). `holdCumulativeMs` only ever grows within a batch and is never
 * refunded. A new turn clears `holding`/`holdUntil` but NOT the cumulative usage;
 * releasing every lock ends the batch and resets it.
 * @typedef {{ sessionId: string, holding: boolean, holdUntil: number | null, holdCumulativeMs: number }} HoldState
 * @typedef {{ sessionId: string, held: boolean, expired: boolean, holdUntil: number | null, remainingMs: number, holdCumulativeMs: number }} HoldSettlement
 * @typedef {{ now?: number, singleMaxMs: number, cumulativeMaxMs: number }} HoldCaps
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
  /** Retention state per registered session; a session with no batch has none.
   * @type {Map<string, HoldState>} */
  const holds = new Map()
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

  /** Retention is a session-level budget, never a lock status: a held lock stays
   * `active` so other sessions are refused exactly as before and a transfer is
   * still negotiated. This block only owns the hold bookkeeping. */
  const retention = {
    /** @param {string} sessionId */
    holdState(sessionId) {
      const held = holds.get(sessionId)
      return held ? Object.freeze({ ...held }) : undefined
    },
    /** End the batch once its last lock is gone: the cumulative allowance belongs
     * to the batch, not to the session forever. The row itself is NEVER removed —
     * the image keeps exactly one row per known session — it returns to zero.
     * Idempotent. @param {string} sessionId */
    endBatch(sessionId) {
      const held = holds.get(sessionId)
      if (!held || [...locks.values()].some(lock => lock.owner === sessionId)) return
      held.holding = false
      held.holdUntil = null
      held.holdCumulativeMs = 0
    },
    /** Clear retention because the holder started a new turn (design D4): its
     * locks stay owned and are ordinary active ownership again immediately, while
     * the batch's accumulated allowance stays charged. @param {string} sessionId */
    endHold(sessionId) {
      const held = holds.get(sessionId)
      if (!held) return
      held.holding = false
      held.holdUntil = null
    },
    /** Pure computation of the retention row a request would produce. The manager
     * persists this before installing it, so an IO failure can never leave the live
     * kernel ahead of the image. Refusal is always safe, and the caller supplies
     * already-resolved caps so this kernel holds no configuration.
     * @param {string} sessionId @param {number} ms @param {HoldCaps} caps
     * @returns {HoldState} */
    holdCandidate(sessionId, ms, caps) {
      if (!sessions.has(sessionId)) throw new Error('unknown session')
      if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('hold duration must be a positive whole number of milliseconds')
      if (!caps || typeof caps !== 'object') throw new Error('hold caps required')
      if (!Number.isFinite(caps.singleMaxMs) || caps.singleMaxMs <= 0) throw new Error('invalid single retention cap')
      if (!Number.isFinite(caps.cumulativeMaxMs) || caps.cumulativeMaxMs <= 0) throw new Error('invalid cumulative retention cap')
      if (ms > caps.singleMaxMs) throw new Error(`a single retention is limited to ${Math.round(caps.singleMaxMs / 60_000)} minutes`)
      if (![...locks.values()].some(lock => lock.owner === sessionId)) throw new Error('this session holds no lock to retain')
      const held = holds.get(sessionId) ?? { sessionId, holding: false, holdUntil: null, holdCumulativeMs: 0 }
      // A reservation still running is EXTENDED by `ms`, never re-bought.
      const now = Number.isFinite(caps.now) ? /** @type {number} */ (caps.now) : null
      // A persisted retention must always carry an expiry: without an instant the
      // row could never be settled on read, so the caller must supply one.
      if (now === null) throw new Error('a retention request requires a finite instant')
      const running = held.holding && held.holdUntil !== null && held.holdUntil > now
      // Charged: only the added minutes. Bounded: the whole window from now, so
      // repeated asks can neither re-buy paid time nor stack past the single cap.
      const charged = ms
      const windowMs = running ? /** @type {number} */ (held.holdUntil) + ms - now : ms
      if (windowMs > caps.singleMaxMs) {
        throw new Error(`a single retention is limited to ${Math.round(caps.singleMaxMs / 60_000)} minutes`)
      }
      if (held.holdCumulativeMs + charged > caps.cumulativeMaxMs) {
        throw new Error(`cumulative retention budget exhausted (${Math.floor((caps.cumulativeMaxMs - held.holdCumulativeMs) / 60_000)} minutes left)`)
      }
      const base = running ? /** @type {number} */ (held.holdUntil) : now
      return Object.freeze({ sessionId, holding: true, holdUntil: base + ms, holdCumulativeMs: held.holdCumulativeMs + charged })
    },
    /** Install a candidate from `holdCandidate`. One-shot and validated, so a
     * tampered, replayed or stale row cannot be installed: allowance never
     * decreases and an active period is never shortened. @param {HoldState} candidate
     * @returns {HoldState} */
    hold(candidate) {
      if (!candidate || typeof candidate !== 'object') throw new Error('invalid retention candidate')
      const current = holds.get(candidate.sessionId)
      if (!current) throw new Error('unknown session')
      if (candidate.holding !== true || !Number.isFinite(candidate.holdUntil)) throw new Error('retention candidate is not active')
      if (!Number.isSafeInteger(candidate.holdCumulativeMs) || candidate.holdCumulativeMs <= current.holdCumulativeMs) {
        throw new Error('retention candidate loses allowance')
      }
      const until = /** @type {number} */ (candidate.holdUntil)
      if (current.holding && current.holdUntil !== null && until < current.holdUntil) {
        throw new Error('retention candidate shortens an active period')
      }
      if (![...locks.values()].some(lock => lock.owner === candidate.sessionId)) throw new Error('this session holds no lock to retain')
      const held = { sessionId: candidate.sessionId, holding: true, holdUntil: until, holdCumulativeMs: candidate.holdCumulativeMs }
      holds.set(candidate.sessionId, held)
      return Object.freeze({ ...held })
    },
    /** Settle retention against a caller-supplied instant (read-time settlement,
     * design D5). Idempotent, and it never releases anything, so it is safe on a
     * read path. @param {string} sessionId @param {number} now @returns {HoldSettlement} */
    settleHold(sessionId, now) {
      if (!Number.isFinite(now)) throw new Error('settlement requires a finite instant')
      const held = holds.get(sessionId)
      if (!held) return Object.freeze({ sessionId, held: false, expired: false, holdUntil: null, remainingMs: 0, holdCumulativeMs: 0 })
      const owns = [...locks.values()].some(lock => lock.owner === sessionId)
      const remainingMs = held.holdUntil === null ? 0 : Math.max(0, held.holdUntil - now)
      const holding = held.holding && owns
      return Object.freeze({ sessionId, held: holding, expired: holding && held.holdUntil !== null && remainingMs === 0,
        holdUntil: held.holdUntil, remainingMs, holdCumulativeMs: held.holdCumulativeMs })
    },
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
      // The batch ends with its last lock: the cumulative allowance is per batch.
      retention.endBatch(token.sessionId)
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
      // A trusted resume restores editing authority; it is not a continuing turn,
      // so the batch keeps its retention state.
      return { managerIncarnation, sessionId: session.sessionId, executionEpoch: session.executionEpoch }
    },
    status() {
      return {
        managerIncarnation,
        sessions: [...sessions.values()].map(session => ({ ...session })),
        locks: [...locks.values()].map(lock => ({ ...lock })),
        holds: [...holds.values()].map(held => ({ ...held })),
      }
    },
  }

  const authority = {
    /** Import only a validated historical checkpoint into a fresh kernel.
     * The opaque candidate has no mutation facets; it can only be inspected,
     * installed after persistence, or discarded. No receipts are imported.
     * @param {{ managerIncarnation: string, sessions: Session[], locks: Lock[], generations: {resourceId: string, generation: number}[], issuedRequests: {sessionId: string, requestId: string}[], holds?: HoldState[] }} history */
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
        // Recovery restores ownership, never a running retention period, and the
        // batch's consumed allowance is carried over, not refunded.
        core.holds.set(session.sessionId, { sessionId: session.sessionId, holding: false, holdUntil: null, holdCumulativeMs: 0 })
      }
      for (const held of history.holds ?? []) {
        const restored = core.holds.get(held.sessionId)
        if (!restored || typeof held.holding !== 'boolean' || !Number.isSafeInteger(held.holdCumulativeMs) || held.holdCumulativeMs < 0 ||
            (held.holdUntil !== null && (!Number.isSafeInteger(held.holdUntil) || held.holdUntil < 0))) throw new Error('invalid recovery hold')
        // An expiry never survives a restart: clocks and timers are gone, so the row
        // returns to ordinary ownership without a running retention period.
        restored.holding = false
        restored.holdUntil = null
        restored.holdCumulativeMs = held.holdCumulativeMs
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
      for (const [key, value] of holds) core.holds.set(key, { ...value })
      const entry = { base: revision, closed: false, child, core, issued: new Map() }
      /** @param {object} facet */
      const guard = facet => Object.freeze(Object.fromEntries(Object.entries(facet).map(([key, method]) => [key,
        /** @param {...any} args */
        (...args) => {
          if (entry.closed || entry.base !== revision) throw new Error('invalid or stale draft')
          if (['begin', 'beginRecovery', 'install', 'discard', 'holdState', 'settleHold'].includes(key)) {
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
      sessions.clear(); locks.clear(); generations.clear(); issuedRequests.clear(); holds.clear()
      for (const [key, value] of entry.core.sessions) sessions.set(key, { ...value })
      for (const [key, value] of entry.core.locks) locks.set(key, { ...value })
      for (const [key, value] of entry.core.generations) generations.set(key, value)
      for (const [key, value] of entry.core.issuedRequests) issuedRequests.set(key, new Set(value))
      for (const [key, value] of entry.core.holds) holds.set(key, { ...value })
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
      // A successful creation starts a batch when the session had none yet.
      if (!holds.has(session.sessionId)) holds.set(session.sessionId, { sessionId: session.sessionId, holding: false, holdUntil: null, holdCumulativeMs: 0 })
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
      holds.set(sessionId, { sessionId, holding: false, holdUntil: null, holdCumulativeMs: 0 })
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
      // Precedence (spec: Lock lifecycle disclosure): a stopped session's locks are
      // handled as abnormal locks, so no retention period applies to them any more.
      retention.endHold(session.sessionId)
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
  // Retention lives with the operations facet: both answer "may this session do
  // this now" against the same core. `holdState`/`settleHold` are reads and stay
  // callable anywhere (including a draft); the mutations advance the revision so
  // an outstanding draft is invalidated rather than silently stale.
  Object.assign(operations, retention)
  track(operations, ['acquire', 'release', 'resume', 'hold', 'endHold', 'endBatch'])
  track(authority, ['openSession', 'cancel', 'markAbnormal', 'issueExecutionReceipt', 'settleCreated'])
  const kernel = { operations: Object.freeze(operations), authority: Object.freeze(authority) }
  cores.set(kernel, { sessions, locks, generations, issuedRequests, receipts, holds })
  return Object.freeze(kernel)
}

/** Validate opaque identifiers without interpreting or normalizing paths.
 * @param {string} value */
function requireId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid identifier')
}
