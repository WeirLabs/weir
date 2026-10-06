import { createHash, randomUUID } from 'node:crypto'
import { createEditLockState } from './state.js'
import { bindRequest } from './request-binding.js'
import { lookupOperation } from './operation-history.js'
import { canonicalRequestData } from './request-data.js'
import { admitMutation as admitHistory, publicationCandidate } from './admission.js'
import { administrativeState, AUTOMATIC_RECOVERY_ACTOR, digest, dispositionFor, LATE_WRITER_RISK, revokedOwner } from './admin-ledger.js'
import { incarnationProcess, withIncarnation } from './incarnations.js'

/**
 * Unmounted trusted manager core. Caller exclusively owns the store lifecycle;
 * this factory does not elect a singleton or expose any file publication path.
 * This fresh-store factory is separate from the trusted recovery entrypoint.
 * The optional process identity (shared Liveness adapter, design D2) is
 * registered in the durable image with the first committed write.
 * @param {{store: Awaited<ReturnType<typeof import('./store.js').openEditLockStore>>, managerIncarnation: string, processIdentity?: import('./incarnations.js').ProcessIdentity|null}} options
 */
export function createEditLockManager({ store, managerIncarnation, processIdentity = null }) {
  const confirmed = store.snapshot()
  if (confirmed.revision !== 0 || confirmed.state.managerIncarnation !== null) {
    throw new Error('fresh store required; use trusted recovery entrypoint')
  }
  return managerCore(store, createEditLockState(managerIncarnation), { processIdentity })
}

/**
 * Design D3 eligibility for one recovery open: an owner is settled only when
 * it is not already revoked, every one of its unresolved (unknown) operations
 * originates from an incarnation whose recorded process identity differs from
 * the recovering process, AND the shared Liveness adapter proves that process
 * dead. Null identities and same-process remount incarnations never qualify.
 * The records reuse the v5 adminRecoveries shape; the actor marks them
 * automatic. @param {any} previous @param {any} base
 * @param {{liveness: import('../capabilities/store/liveness.js').Liveness, root: string,
 *   processIdentity: import('./incarnations.js').ProcessIdentity, now: () => number}} options
 */
async function automaticSettlementRecords(previous, base, { liveness, root, processIdentity, now }) {
  /** @type {Map<string, any[]>} */
  const unknownByOwner = new Map()
  for (const operation of base.operations) {
    if (operation.phase !== 'unknown') continue
    const ops = unknownByOwner.get(operation.sessionId) ?? []
    ops.push(operation)
    unknownByOwner.set(operation.sessionId, ops)
  }
  /** @type {any[]} */
  const records = []
  for (const [owner, ops] of unknownByOwner) {
    if (revokedOwner(base, owner)) continue
    const session = base.sessions.find(s => s.sessionId === owner)
    if (!session?.interrupted) continue
    let eligible = true
    for (const operation of ops) {
      const process = incarnationProcess(base, operation.origin.managerIncarnation)
      if (!process) { eligible = false; break }
      if (process.pid === processIdentity.pid && process.bootNonce === processIdentity.bootNonce) { eligible = false; break }
      const state = await liveness.state({ pid: process.pid, host: process.host, startIdentity: { osStart: process.osStart, bootNonce: process.bootNonce } })
      if (state !== 'dead') { eligible = false; break }
    }
    if (!eligible) continue
    const recoveryId = `automatic-${randomUUID()}`
    const operationIds = ops.map(operation => operation.operationId).sort()
    records.push({
      recoveryId, root, owner,
      expectedRevision: previous.revision, committedRevision: previous.revision + 1,
      at: now(), actor: AUTOMATIC_RECOVERY_ACTOR,
      reason: 'Every unresolved publication of this owner originated in a manager incarnation whose process is proven dead (pid and start identity), so that lifetime has no live writer; settled automatically on recovery open.',
      risk: LATE_WRITER_RISK,
      confirmation: digest({ root, owner, expectedRevision: previous.revision, operationIds, risk: LATE_WRITER_RISK }),
      // Filled from the recovered pre-image bytes before the commit.
      backup: { file: `admin-backup-${digest([root, recoveryId])}.json`, sha256: '', bytes: 0 },
      operations: ops.map(operation => ({ operationId: operation.operationId, sha256: digest(operation) })),
      releasedLocks: base.locks.filter((/** @param {any} lock */ lock) => lock.owner === owner),
      revokedEpoch: session.executionEpoch + 1,
    })
  }
  return records
}

/** Trusted lifecycle only: caller must establish exclusive ownership and old
 * publisher quiescence before opening the store. No IPC or automatic election.
 * When the shared Liveness adapter, the domain root and a backup writer are
 * supplied, unknown-phase publications of provably dead incarnation processes
 * are administratively settled in the SAME durable commit as the recovery
 * (design D3): one snapshot commit, one ledger record per settled owner, the
 * unknown outcomes and history preserved.
 * @param {{store: Awaited<ReturnType<typeof import('./store.js').openEditLockStore>>, managerIncarnation: string,
 *   processIdentity?: import('./incarnations.js').ProcessIdentity|null,
 *   liveness?: import('../capabilities/store/liveness.js').Liveness|null, root?: string|null,
 *   writeBackup?: ((file: string, bytes: Buffer) => Promise<void>)|null, now?: () => number,
 *   onAutomaticRecovery?: (info: {records: any[], revision: number}) => void}} options */
export async function recoverEditLockManager({ store, managerIncarnation, processIdentity = null, liveness = null, root = null, writeBackup = null, now = Date.now, onAutomaticRecovery = undefined }) {
  const previous = store.snapshot()
  if (!previous.state.managerIncarnation) throw new Error('historical store required')
  // Phase 1: the ordinary recovery mapping (staging kernel, never installed).
  const staging = createEditLockState(managerIncarnation)
  const staged = staging.authority.beginRecovery({ ...previous.state, managerIncarnation: previous.state.managerIncarnation })
  const mapped = staging.authority.checkpoint(staged)
  staging.authority.discard(staged)
  const operations = previous.state.operations.map(operation => {
    if (operation.phase === 'prepared') return { ...operation, phase: 'not-published',
      outcome: { kind: 'not-published', reason: 'rejected-before-dispatch' } }
    if (operation.phase === 'publishing') return { ...operation, phase: 'unknown', outcome: { kind: 'unknown' } }
    return operation
  })
  let base = withIncarnation({ ...previous.state, ...mapped, operations }, managerIncarnation, processIdentity, previous.state.managerIncarnation)
  if (base.version === 6 && !(base.incarnations ?? []).some(entry => entry.incarnation === managerIncarnation)) {
    // An identity-less recovery of a v6 image still registers the new
    // incarnation — with a null identity, so it can never be auto-settled —
    // because the registry must cover every incarnation the image references.
    base = { ...base, incarnations: [...base.incarnations, { incarnation: managerIncarnation, process: null }] }
  }
  const settle = liveness !== null && root !== null && writeBackup !== null && processIdentity !== null
  const records = settle ? await automaticSettlementRecords(previous, base, { liveness, root, processIdentity, now }) : []
  if (records.length > 0) {
    // Every record backs up the same recovered pre-image; the backup fields
    // are part of the immutable ledger row, so they are filled BEFORE the
    // administrative fold builds the committed state.
    const bytes = store.recoveredBytes()
    if (!bytes) throw new Error('automatic settlement requires the recovered pre-image bytes')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    for (const record of records) record.backup = { file: record.backup.file, sha256, bytes: bytes.length }
    for (const record of records) await writeBackup(record.backup.file, bytes)
  }
  const nextState = records.reduce((state, record) => administrativeState(state, record), base)
  // Phase 2: the installed kernel hydrates from the FINAL kernel fields
  // (post-settlement), so the in-memory authority matches the durable image.
  const kernel = createEditLockState(managerIncarnation)
  const draft = kernel.authority.beginRecovery({ ...nextState, managerIncarnation: previous.state.managerIncarnation })
  if (records.length === 0) {
    await store.record({ expectedRevision: previous.revision, nextState })
  } else {
    await store.recordAdministrativeRecovery({ expectedRevision: previous.revision, nextState, base })
  }
  kernel.authority.install(draft)
  if (records.length > 0) onAutomaticRecovery?.({ records: structuredClone(records), revision: previous.revision + 1 })
  return managerCore(store, kernel, { processIdentity })
}

/** @param {Awaited<ReturnType<typeof import('./store.js').openEditLockStore>>} store
 * @param {ReturnType<typeof createEditLockState>} kernel
 * @param {{processIdentity?: import('./incarnations.js').ProcessIdentity|null}} [options] */
function managerCore(store, kernel, { processIdentity = null } = {}) {
  const { operations, authority } = kernel
  const managerIncarnation = operations.status().managerIncarnation
  // Every durable write of an identity-aware manager carries the incarnation
  // registry (design D2); a no-op once this incarnation is registered.
  /** @param {any} state @returns {any} */
  const withIdentity = processIdentity ? state => withIncarnation(state, managerIncarnation, processIdentity) : state => state
  let confirmed = store.snapshot()
  // Only validated administrative dispositions lift a historical fence. The
  // immutable history still participates in operation-ID lookup before admission.
  function admitMutation(history, candidate, mode = 'normal') {
    return admitHistory(history.filter(op => !dispositionFor(confirmed.state, op)), candidate, mode)
  }
  function checkNotRevoked(sessionId) {
    if (revokedOwner(confirmed.state, sessionId)) throw new Error('owner revoked by administrative recovery')
  }
  let tail = Promise.resolve()
  /** @type {unknown} */
  let poison
  let closed = false
  // Denial only: never a second ownership ledger or a grant source.
  const cancelled = new Map()
  function healthy() {
    if (closed) throw new Error('manager closed')
    if (poison) throw new Error('manager poisoned', { cause: poison })
  }
  /** @typedef {{validate: () => void, publish: () => Promise<{version: string}>, identify: () => string}} Publisher
   * @type {WeakMap<object, {execution: import('./state.js').Execution, request: any, hooks: Publisher}>} */
  const submissions = new WeakMap()
  /** @param {import('./state.js').Execution} execution */
  function checkExecution(execution) {
    healthy()
    checkNotRevoked(execution.sessionId)
    const session = operations.status().sessions.find(s => s.sessionId === execution.sessionId)
    if (!session || execution.managerIncarnation !== managerIncarnation ||
        execution.executionEpoch !== session.executionEpoch || session.interrupted || cancelled.has(execution.sessionId)) {
      throw new Error('execution is not active')
    }
  }
  /** @param {string} sessionId @returns {import('./admission.js').Candidate} */
  function sessionResources(sessionId) {
    return { kind: 'resources', resourceIds: operations.status().locks.filter(lock => lock.owner === sessionId).map(lock => lock.resourceId) }
  }
  /** @param {(draft: ReturnType<typeof authority.begin>) => any} transition
   * @param {import('./admission.js').Candidate | (() => import('./admission.js').Candidate)} candidate
   * @param {import('./admission.js').Mode} [mode]
   * @param {(state: any) => object} [patch] Extra durable fields (recovery budgets only). */
  function transact(transition, candidate, mode = 'normal', patch = undefined) {
    const pending = tail.then(async () => {
      healthy()
      admitMutation(confirmed.state.operations, typeof candidate === 'function' ? candidate() : candidate, mode)
      const draft = authority.begin()
      let result
      try { result = transition(draft) } catch (error) {
        authority.discard(draft)
        throw error
      }
      try {
        const nextState = { ...confirmed.state, ...authority.checkpoint(draft) }
        if (patch) Object.assign(nextState, patch(nextState))
        const saved = await store.record({ expectedRevision: confirmed.revision, nextState: withIdentity(nextState) })
        authority.install(draft)
        confirmed = saved
        return result
      } catch (error) {
        poison = error
        throw new Error('manager persistence or installation failed; poisoned', { cause: error })
      }
    })
    tail = pending.then(() => {}, () => {})
    return pending
  }
  return Object.freeze({
    /** Historical target lookup for a trusted authenticated session; never acquires.
     * @param {string} sessionId @param {string} operationId */
    history(sessionId, operationId) {
      healthy()
      if (!operations.status().sessions.some(s => s.sessionId === sessionId)) throw new Error('unknown session')
      const operation = confirmed.state.operations.find(o => o.sessionId === sessionId && o.operationId === operationId)
      return operation ? structuredClone(operation) : null
    },
    /** Trusted adapter ingress: binding and observed target are immutable data.
     * validate must synchronously recheck policy/topology/signal at queue position.
     * Existing history is returned before current authority checks, never replayed.
     * @param {import('./state.js').Execution} execution
     * @param {Parameters<typeof bindRequest>[0] & {operationId: string}} request
     * @param {Publisher} publisher */
    prepare(execution, request, publisher) {
      const hooks = Object.freeze({ validate: publisher.validate, publish: publisher.publish, identify: publisher.identify })
      const captured = { ...execution }
      const data = JSON.parse(canonicalRequestData(request))
      const binding = bindRequest(data)
      if (typeof data.operationId !== 'string' || !data.operationId.trim()) throw new Error('invalid operation id')
      const pending = tail.then(async () => {
        healthy()
        if (!operations.status().sessions.some(s => s.sessionId === captured.sessionId)) throw new Error('unknown session')
        const previous = lookupOperation(confirmed.state, { sessionId: captured.sessionId, operationId: data.operationId, binding })
        if (previous) return { kind: 'history', operation: previous }
        checkExecution(captured)
        admitMutation(confirmed.state.operations, publicationCandidate(binding.target))
        if (binding.target.kind === 'update') operations.checkWrite({ ...captured,
          resourceId: binding.target.resourceId, generation: binding.target.generation })
        hooks.validate()
        /** @type {import('./operation-history.js').Operation} */
        const operation = { sessionId: captured.sessionId, operationId: data.operationId,
          origin: { executionEpoch: captured.executionEpoch, managerIncarnation: captured.managerIncarnation },
          binding, phase: 'prepared', fence: null, outcome: null, closeouts: [] }
        try {
          confirmed = await store.record({ expectedRevision: confirmed.revision,
            nextState: withIdentity({ ...confirmed.state, operations: [...confirmed.state.operations, operation] }) })
        } catch (error) { poison = error; throw error }
        // A cancellation during durability must not deliver a ready submission.
        if (cancelled.has(captured.sessionId)) {
          const rejected = { ...operation, phase: /** @type {const} */ ('not-published'),
            outcome: { kind: /** @type {const} */ ('not-published'), reason: /** @type {const} */ ('cancelled-before-dispatch') } }
          try {
            confirmed = await store.record({ expectedRevision: confirmed.revision,
              nextState: withIdentity({ ...confirmed.state, operations: confirmed.state.operations.map(o => o === confirmed.state.operations.at(-1) ? rejected : o) }) })
          } catch (error) { poison = error; throw error }
          throw new Error('session cancelled during preparation')
        }
        const submission = Object.freeze({})
        submissions.set(submission, { execution: captured, request: data, hooks })
        return { kind: 'ready', submission }
      })
      tail = pending.then(() => {}, () => {})
      return pending
    },
    /** Trusted publisher hooks must close over the original fs and frozen call.
     * No caller may dispatch outside this serialized task.
     * @param {object} submission */
    commit(submission) {
      const job = submissions.get(submission)
      if (!job) throw new Error('unknown submission')
      const { execution, request, hooks } = job
      const binding = bindRequest(request)
      const key = { sessionId: execution.sessionId, operationId: request.operationId, binding }
      const pending = tail.then(async () => {
        healthy()
        const original = lookupOperation(confirmed.state, key)
        if (!original) throw new Error('missing prepared history')
        if (original.phase !== 'prepared') return original
        /** @param {import('./operation-history.js').Operation} operation
         * @param {ReturnType<typeof authority.begin>} [draft] */
        const save = async (operation, draft) => {
          try {
            const saved = await store.record({ expectedRevision: confirmed.revision, nextState: withIdentity({
              ...confirmed.state, ...(draft ? authority.checkpoint(draft) : {}),
              operations: confirmed.state.operations.map(o => o.sessionId === key.sessionId && o.operationId === key.operationId ? operation : o),
            }) })
            if (draft) authority.install(draft)
            confirmed = saved
          } catch (error) { poison = error; throw error }
        }
        const validate = () => {
          checkExecution(execution)
          if (binding.target.kind === 'update') operations.checkWrite({ ...execution,
            resourceId: binding.target.resourceId, generation: binding.target.generation })
          hooks.validate()
        }
        try {
          admitMutation(confirmed.state.operations, publicationCandidate(binding.target))
          validate()
        } catch (error) {
          await save({ ...original, phase: 'not-published', outcome: { kind: 'not-published',
            reason: cancelled.has(execution.sessionId) ? 'cancelled-before-dispatch' : 'rejected-before-dispatch' } })
          throw error
        }
        /** @type {import('./operation-history.js').Operation} */
        const publishing = { ...original, phase: 'publishing', fence: binding.target.kind === 'update'
          ? { kind: 'resource', resourceId: binding.target.resourceId }
          : { kind: 'subtree', ancestor: binding.target.ancestor, basis: 'observed-ancestor' } }
        let attempt
        try {
          attempt = await store.beginPublication({ expectedRevision: confirmed.revision,
            nextState: withIdentity({ ...confirmed.state, operations: confirmed.state.operations.map(o =>
              o.sessionId === key.sessionId && o.operationId === key.operationId ? publishing : o) }) }, key, hooks.publish)
          confirmed = store.snapshot()
        } catch (error) { poison = error; throw error }
        try { validate() } catch (error) {
          try {
            confirmed = await attempt.finishWithoutDispatch(cancelled.has(execution.sessionId)
              ? 'cancelled-before-dispatch' : 'rejected-before-dispatch')
          } catch (failure) { poison = failure; throw failure }
          throw error
        }
        let draft
        try {
          const result = await attempt.invoke()
          const resourceId = hooks.identify()
          draft = authority.begin()
          let ownership
          if (binding.target.kind === 'create') ownership = draft.authority.settleCreated(execution, resourceId)
          else {
            if (resourceId !== binding.target.resourceId) throw new Error('published identity changed')
            ownership = { ...execution, resourceId, generation: binding.target.generation }
            draft.operations.checkWrite(ownership)
          }
          if (cancelled.has(execution.sessionId)) draft.authority.cancel(execution)
          const kind = binding.target.kind === 'create' ? 'created' : 'updated'
          const completed = { ...publishing, phase: /** @type {'created'|'updated'} */ (kind),
            outcome: { kind: /** @type {'created'|'updated'} */ (kind), resourceId, generation: ownership.generation, version: result.version } }
          await save(completed, draft)
          draft = undefined
          // Cancellation can arrive while the successful active image is syncing.
          const session = operations.status().sessions.find(s => s.sessionId === execution.sessionId)
          if (cancelled.has(execution.sessionId) && session && !session.interrupted) {
            const corrective = authority.begin()
            corrective.authority.cancel(execution)
            await save(completed, corrective)
          }
          return completed
        } catch (error) {
          if (draft) { try { authority.discard(draft) } catch {} }
          if (!poison) await save({ ...publishing, phase: 'unknown', outcome: { kind: 'unknown' } })
          throw error
        }
      })
      tail = pending.then(() => {}, () => {})
      return pending
    },
    /** Only authenticated human intent may reach this trusted ingress.
     * @param {import('./state.js').Execution} execution @param {string} requestId */
    issueExecutionReceipt(execution, requestId) {
      const captured = { ...execution }
      return transact(draft => {
        if (cancelled.has(captured.sessionId)) throw new Error('session cancelled')
        checkNotRevoked(captured.sessionId)
        return draft.authority.issueExecutionReceipt(captured, requestId)
      }, { kind: 'none' }).then(async receipt => {
        const cancellation = cancelled.get(captured.sessionId)
        if (cancellation) {
          await cancellation
          throw new Error('session cancelled during receipt issuance')
        }
        healthy()
        const current = operations.status().sessions.find(s => s.sessionId === captured.sessionId)
        if (current?.executionEpoch !== captured.executionEpoch) throw new Error('stale receipt execution')
        return receipt
      })
    },
    /** @param {import('./state.js').Execution} execution @param {string} requestId @param {object} receipt */
    resume(execution, requestId, receipt) {
      const captured = { ...execution }
      return transact(draft => {
        if (cancelled.has(captured.sessionId)) throw new Error('session cancelled')
        checkNotRevoked(captured.sessionId)
        return draft.operations.resume(captured, requestId, receipt)
      }, () => sessionResources(captured.sessionId)).then(async resumed => {
        const cancellation = cancelled.get(captured.sessionId)
        if (cancellation) {
          await cancellation
          throw new Error('session cancelled during resume')
        }
        healthy()
        const current = operations.status().sessions.find(s => s.sessionId === captured.sessionId)
        if (current?.interrupted || current?.executionEpoch !== resumed.executionEpoch) throw new Error('stale resumed execution')
        return resumed
      })
    },
    /** @param {string} sessionId */
    openSession(sessionId) {
      return transact(draft => {
        if (cancelled.has(sessionId)) throw new Error('session cancelled')
        checkNotRevoked(sessionId)
        return draft.authority.openSession(sessionId)
      }, { kind: 'none' }).then(async execution => {
        const cancellation = cancelled.get(sessionId)
        if (cancellation) {
          await cancellation
          throw new Error('session cancelled during registration')
        }
        healthy()
        return execution
      })
    },
    /** Trusted lifecycle ingress, never a model-facing authority argument.
     * Cancels the session at its queue position, including pending registration.
     * @param {string} sessionId */
    cancelSession(sessionId) {
      healthy()
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('invalid session')
      const existing = cancelled.get(sessionId)
      if (existing) return existing
      const pending = transact(draft => {
        const session = operations.status().sessions.find(s => s.sessionId === sessionId)
        if (!session) throw new Error('unknown session')
        if (session.interrupted) return { sessionId, executionEpoch: session.executionEpoch, managerIncarnation }
        return draft.authority.cancel({ sessionId, executionEpoch: session.executionEpoch, managerIncarnation })
      }, { kind: 'none' }, 'revocation')
      cancelled.set(sessionId, pending)
      void pending.then(() => cancelled.delete(sessionId), () => {})
      return pending
    },
    /** Trusted canonical identity input only; not a path-based tool interface.
     * @param {import('./state.js').Execution} execution @param {string} resourceId */
    acquire(execution, resourceId) {
      const captured = { ...execution }
      return transact(draft => {
        if (cancelled.has(captured.sessionId)) throw new Error('session cancelled')
        checkNotRevoked(captured.sessionId)
        return draft.operations.acquire(captured, resourceId)
      }, { kind: 'resources', resourceIds: [resourceId] }).then(async token => {
        const cancellation = cancelled.get(captured.sessionId)
        if (cancellation) {
          await cancellation
          throw new Error('session cancelled during acquisition')
        }
        healthy()
        operations.checkWrite(token)
        return token
      })
    },
    /** Trusted per-file confirmation after explicit resume. Never acquires an
     * unowned resource: only this session's pending-confirmation lock activates.
     * @param {import('./state.js').Execution} execution @param {string} resourceId */
    confirm(execution, resourceId) {
      const captured = { ...execution }
      return transact(draft => {
        if (cancelled.has(captured.sessionId)) throw new Error('session cancelled')
        const lock = operations.status().locks.find(item => item.resourceId === resourceId)
        if (!lock || lock.owner !== captured.sessionId || lock.status !== 'pending-confirmation') {
          throw new Error('resource has no pending confirmation for this session')
        }
        return draft.operations.acquire(captured, resourceId)
      }, { kind: 'resources', resourceIds: [resourceId] }).then(async token => {
        const cancellation = cancelled.get(captured.sessionId)
        if (cancellation) {
          await cancellation
          throw new Error('session cancelled during confirmation')
        }
        healthy()
        operations.checkWrite(token)
        return token
      })
    },
    /** Success-only cleanup is atomic; cancellation retains all batch ownership.
     * @param {import('./state.js').Ownership[]} tokens */
    releaseMany(tokens) {
      const captured = tokens.map(token => ({ ...token }))
      return transact(draft => {
        for (const token of captured) {
          if (cancelled.has(token.sessionId)) throw new Error('session cancelled')
          draft.operations.checkWrite(token)
        }
        for (const token of captured) draft.operations.release(token)
      }, { kind: 'resources', resourceIds: captured.map(token => token.resourceId) }, 'release')
    },
    /** Atomic acquisition of existing canonical resources for a trusted batch editor.
     * Pre-existing ownership is retained and explicitly excluded from cleanup.
     * @param {import('./state.js').Execution} execution @param {string[]} resourceIds */
    acquireMany(execution, resourceIds) {
      const captured = { ...execution }
      const ids = [...new Set(resourceIds)].sort()
      return transact(draft => {
        if (cancelled.has(captured.sessionId)) throw new Error('session cancelled')
        const before = operations.status().locks
        if (before.some(lock => ids.includes(lock.resourceId) && lock.status === 'pending-confirmation')) {
          throw new Error('resource requires explicit per-file confirmation (/edit-lock confirm <path>)')
        }
        const tokens = ids.map(resourceId => draft.operations.acquire(captured, resourceId))
        for (const token of tokens) draft.operations.checkWrite(token)
        return { tokens, temporary: tokens.filter(token => !before.some(lock => lock.resourceId === token.resourceId)) }
      }, { kind: 'resources', resourceIds: ids }).then(async result => {
        const cancellation = cancelled.get(captured.sessionId)
        if (cancellation) { await cancellation; throw new Error('session cancelled during batch acquisition') }
        healthy()
        for (const token of result.tokens) operations.checkWrite(token)
        return result
      })
    },
    /** Cleanup authenticates the captured owner/generation through the kernel.
     * @param {import('./state.js').Ownership} token */
    release(token) {
      const captured = { ...token }
      return transact(draft => draft.operations.release(captured), { kind: 'resources', resourceIds: [captured.resourceId] }, 'release')
    },
    /** Give up every active lock of one session: the disposition used when a
     * finished turn's locks were never sorted out. Retention is a policy decision
     * that lives above this layer, so the caller supplies the cap. Refusal is
     * always safe. @param {string} sessionId @param {number} now */
    releaseActive(sessionId, now, requireExpired = false) {
      return transact(draft => {
        if (requireExpired && !operations.settleHold(sessionId, now).expired) return []
        const status = operations.status()
        const session = status.sessions.find(item => item.sessionId === sessionId)
        if (!session) throw new Error('unknown session')
        const released = []
        for (const lock of status.locks) {
          if (lock.owner !== sessionId || lock.status !== 'active') continue
          draft.operations.release({ managerIncarnation, sessionId, executionEpoch: session.executionEpoch, resourceId: lock.resourceId, generation: lock.generation })
          released.push(lock.resourceId)
        }
        return released
      }, () => ({ kind: 'resources', resourceIds: operations.status().locks
        .filter(lock => lock.owner === sessionId && lock.status === 'active').map(lock => lock.resourceId) }), 'release')
    },
    /** Charge and record an explicit retention request (design D2). The caller
     * resolves the configured caps and supplies the instant, so this layer holds
     * no policy and no clock. Ownership is untouched: retention only extends it.
     * @param {string} sessionId @param {number} ms
     * @param {{now: number, singleMaxMs: number, cumulativeMaxMs: number}} caps
     * @returns {Promise<import('./state.js').HoldState>} */
    hold(sessionId, ms, caps) {
      // The candidate is computed on the draft, i.e. at this request's FIFO
      // position: computed earlier on the live kernel it could be based on a hold
      // that a queued turn start is about to end, and would revive it. The draft
      // is only installed after persistence, so a store failure changes nothing.
      return transact(draft => draft.operations.hold(draft.operations.holdCandidate(sessionId, ms, caps)), () => sessionResources(sessionId))
    },
    /** Retention state of one session, settled against the caller's instant so a
     * missed timer cannot leave stale ownership. Pure read; never mutates.
     * @param {string} sessionId @param {number} now */
    settlement(sessionId, now) {
      healthy()
      return operations.settleHold(sessionId, now)
    },
    /** The holder started a new turn: every lock it holds leaves the holding state
     * at once (design D4). Never releases. @param {string} sessionId @param {number} now */
    endHold(sessionId, now) {
      healthy()
      const held = operations.settleHold(sessionId, now)
      if (!held.held) return held
      return transact(draft => draft.operations.endHold(sessionId), { kind: 'none' }, 'revocation').then(() => operations.settleHold(sessionId, now))
    },
    /** Consented transfer: release the holder's exact generation and acquire
     * for the requester in ONE durable transaction. Either side cancelled,
     * stale or interrupted rejects the whole transfer and ownership stays.
     * @param {import('./state.js').Ownership} holder @param {import('./state.js').Execution} requester */
    transfer(holder, requester) {
      const from = { ...holder }, to = { ...requester }
      return transact(draft => {
        if (cancelled.has(from.sessionId) || cancelled.has(to.sessionId)) throw new Error('session cancelled')
        draft.operations.release(from)
        return draft.operations.acquire(to, from.resourceId)
      }, { kind: 'resources', resourceIds: [from.resourceId] }).then(async token => {
        const cancellation = cancelled.get(to.sessionId)
        if (cancellation) { await cancellation; throw new Error('session cancelled during transfer') }
        healthy()
        return token
      })
    },
    /** Controlled human unlock. Runs at its FIFO position, so every earlier
     * commit has settled; refuses removal of unresolved publication ownership
     * or a generation other than the expected current generation. A
     * prepared old-owner write then fails its generation check. There is no
     * unconditional variant. @param {string} resourceId @param {number} generation */
    adminUnlock(resourceId, generation) {
      return transact(draft => {
        const status = operations.status()
        const lock = status.locks.find(item => item.resourceId === resourceId)
        if (!lock) throw new Error('resource is not locked')
        if (lock.generation !== generation) throw new Error(`expected generation ${generation}, current is ${lock.generation}`)
        const session = status.sessions.find(item => item.sessionId === lock.owner)
        if (!session) throw new Error('owner session unknown')
        draft.operations.release({ managerIncarnation, sessionId: lock.owner, executionEpoch: session.executionEpoch, resourceId, generation })
        return { resourceId, generation, owner: lock.owner }
      }, { kind: 'resources', resourceIds: [resourceId] }, 'release')
    },
    /** Trusted maintenance ingress for the stale-lock sweep: conditionally
     * release rows a publisher-side scan observed with a missing target. Every
     * row runs in its OWN FIFO transaction that re-verifies the full
     * observation at the execution point — owner, generation, owner execution
     * epoch and lock status — and re-probes through the caller's isMissing
     * that the resource is still missing; only then an ordinary release.
     * Scope is every observed row regardless of owner state (active, holding,
     * pending-confirmation, user-interrupted, abnormal): the row predicate,
     * not the owner class, provides the safety. Any mismatch, an already-gone
     * row, or the ordinary unresolved-publication fence admission refusal is
     * a SKIP — a discarded draft, never a persisted no-op, never an error —
     * and every other row is still processed. Persistence, poison and any
     * unexpected error are NOT skips: the row lands in `failed` so the caller
     * can log it (fail-closed semantics untouched: nothing was persisted).
     * The missing-target probe is injected: this layer performs no filesystem IO.
     * @param {{resourceId: string, owner: string, generation: number, executionEpoch: number, status: string}[]} observed
     * @param {(resourceId: string) => boolean} isMissing
     * @returns {Promise<{released: {resourceId: string, owner: string, generation: number}[], skipped: {row: object, reason: string}[], failed: {row: object, reason: string}[]}>} */
    async releaseStale(observed, isMissing) {
      healthy()
      if (typeof isMissing !== 'function') throw new Error('stale release requires a missing-target probe')
      const released = []
      const skipped = []
      /** @type {{row: object, reason: string}[]} */
      const failed = []
      /** An expected skip: the observation no longer holds at the execution
       * point; a discarded draft, never a persisted no-op, never an error.
       * @param {string} reason */
      const staleSkip = reason => Object.assign(new Error(reason), { staleSkip: true })
      for (const input of Array.isArray(observed) ? observed : []) {
        const row = { resourceId: input?.resourceId, owner: input?.owner, generation: input?.generation, executionEpoch: input?.executionEpoch, status: input?.status }
        try {
          released.push(await transact(draft => {
            const status = operations.status()
            const lock = status.locks.find(item => item.resourceId === row.resourceId)
            if (!lock) throw staleSkip('stale row already released')
            const session = status.sessions.find(item => item.sessionId === lock.owner)
            if (!session || lock.owner !== row.owner || lock.generation !== row.generation ||
                lock.status !== row.status || session.executionEpoch !== row.executionEpoch) {
              throw staleSkip('stale row changed before execution')
            }
            if (!isMissing(row.resourceId)) throw staleSkip('stale row target exists again')
            draft.operations.release({ managerIncarnation, sessionId: lock.owner, executionEpoch: session.executionEpoch, resourceId: lock.resourceId, generation: lock.generation })
            return { resourceId: lock.resourceId, owner: lock.owner, generation: lock.generation }
          }, { kind: 'resources', resourceIds: [row.resourceId] }, 'release'))
        } catch (error) {
          const reason = String(/** @type {any} */ (error)?.message ?? error)
          // Quiet, counted skips: the row was gone, the predicate no longer
          // matched, or ordinary fence admission refused. Anything else —
          // persistence failure, poison, unexpected — is a surfaced failure.
          if (/** @type {any} */ (error)?.staleSkip === true || /** @type {any} */ (error)?.admissionRefusal === true) skipped.push({ row, reason })
          else failed.push({ row, reason })
        }
      }
      return { released, skipped, failed }
    },
    /** Trusted classifier only (durable turn/end error). Marks every retained,
     * not yet abnormal lock of the session abnormal; never releases. Subtractive,
     * so it may cross an unresolved publication fence.
     * @param {string} sessionId @param {string} reason */
    markAbnormal(sessionId, reason) {
      return transact(draft => {
        const status = operations.status()
        const session = status.sessions.find(item => item.sessionId === sessionId)
        if (!session) throw new Error('unknown session')
        const marked = []
        for (const lock of status.locks) {
          if (lock.owner !== sessionId || lock.status === 'abnormal') continue
          draft.authority.markAbnormal({ managerIncarnation, sessionId, executionEpoch: session.executionEpoch, resourceId: lock.resourceId, generation: lock.generation }, reason)
          marked.push(lock.resourceId)
        }
        return marked
      }, { kind: 'none' }, 'revocation')
    },
    /** Monotonic durable recovery budget charge; restart never refunds it.
     * @param {string} sessionId @param {{attempts?: number, elapsedMs?: number, pauseMs?: number}} delta */
    chargeRecovery(sessionId, delta) {
      for (const value of [delta.attempts ?? 0, delta.elapsedMs ?? 0, delta.pauseMs ?? 0]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid recovery charge')
      }
      /** @type {any} */
      let charged
      return transact(() => {
        if (!operations.status().sessions.some(item => item.sessionId === sessionId)) throw new Error('unknown session')
      }, { kind: 'none' }, 'revocation', state => {
        const recovery = state.recovery.map(/** @param {any} item */ item => ({ ...item }))
        let entry = recovery.find(/** @param {any} item */ item => item.sessionId === sessionId)
        if (!entry) { entry = { sessionId, attempts: 0, elapsedMs: 0, pauseMs: 0 }; recovery.push(entry) }
        entry.attempts += delta.attempts ?? 0
        entry.elapsedMs += delta.elapsedMs ?? 0
        entry.pauseMs += delta.pauseMs ?? 0
        charged = { ...entry }
        return { recovery }
      }).then(() => charged)
    },
    /** Durable recovery usage of one session (zeros when never charged).
     * @param {string} sessionId */
    recoveryUsage(sessionId) {
      healthy()
      const entry = confirmed.state.recovery.find(/** @param {any} item */ item => item.sessionId === sessionId)
      return entry ? { ...entry } : { sessionId, attempts: 0, elapsedMs: 0, pauseMs: 0 }
    },
    /** Synchronous denial overlay must be checked before publication.
     * @param {import('./state.js').Ownership} token */
    checkWrite(token) {
      healthy()
      if (cancelled.has(token.sessionId)) throw new Error('session cancelled')
      return operations.checkWrite(token)
    },
    /** @param {import('./state.js').Execution} execution */
    cancel(execution) {
      healthy()
      execution = { ...execution }
      const session = operations.status().sessions.find(s => s.sessionId === execution.sessionId)
      if (execution.managerIncarnation !== managerIncarnation || !session || session.executionEpoch !== execution.executionEpoch) {
        throw new Error('invalid cancellation execution')
      }
      const existing = cancelled.get(execution.sessionId)
      if (existing) return existing
      const pending = transact(draft => {
        // Admission authenticated the live execution; cancellation also seals an
        // earlier queued resume that installs before this revocation is durable.
        const current = operations.status().sessions.find(s => s.sessionId === execution.sessionId)
        if (!current) throw new Error('unknown session')
        if (current.interrupted) return { ...execution, executionEpoch: current.executionEpoch }
        return draft.authority.cancel({ ...execution, executionEpoch: current.executionEpoch })
      }, { kind: 'none' }, 'revocation')
      cancelled.set(execution.sessionId, pending)
      // Keep denial on failure; poisoned state must never expose rollback authority.
      void pending.then(() => cancelled.delete(execution.sessionId), () => {})
      return pending
    },
    /** Host shutdown waits for every queued authority and publication mutation. */
    async drain() { await tail },
    /** Seal authority after draining; never a permission to enable unlocked edits. */
    async close() { closed = true; await tail },
    status() {
      healthy()
      const snapshot = operations.status()
      for (const session of snapshot.sessions) {
        if (cancelled.has(session.sessionId)) session.interrupted = true
        session.revoked = revokedOwner(confirmed.state, session.sessionId)
      }
      for (const lock of snapshot.locks) {
        if (cancelled.has(lock.owner) && lock.status !== 'abnormal') lock.status = 'user-interrupted'
      }
      return snapshot
    },
  })
}
