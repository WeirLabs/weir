import { createEditLockState } from './state.js'

/**
 * Unmounted trusted manager core. Caller exclusively owns the store lifecycle;
 * this factory does not elect a singleton or expose any file publication path.
 * This fresh-store factory is separate from the trusted recovery entrypoint.
 * @param {{store: Awaited<ReturnType<typeof import('./store.js').openEditLockStore>>, managerIncarnation: string}} options
 */
export function createEditLockManager({ store, managerIncarnation }) {
  const confirmed = store.snapshot()
  if (confirmed.revision !== 0 || confirmed.state.managerIncarnation !== null) {
    throw new Error('fresh store required; use trusted recovery entrypoint')
  }
  return managerCore(store, createEditLockState(managerIncarnation))
}

/** Trusted lifecycle only: caller must establish exclusive ownership and old
 * publisher quiescence before opening the store. No IPC or automatic election.
 * @param {{store: Awaited<ReturnType<typeof import('./store.js').openEditLockStore>>, managerIncarnation: string}} options */
export async function recoverEditLockManager({ store, managerIncarnation }) {
  const previous = store.snapshot()
  if (!previous.state.managerIncarnation) throw new Error('historical store required')
  const kernel = createEditLockState(managerIncarnation)
  const draft = kernel.authority.beginRecovery({ ...previous.state, managerIncarnation: previous.state.managerIncarnation })
  const operations = previous.state.operations.map(operation => {
    if (operation.phase === 'prepared') return { ...operation, phase: 'not-published',
      outcome: { kind: 'not-published', reason: 'rejected-before-dispatch' } }
    if (operation.phase === 'publishing') return { ...operation, phase: 'unknown', outcome: { kind: 'unknown' } }
    return operation
  })
  await store.record({ expectedRevision: previous.revision,
    nextState: { ...previous.state, ...kernel.authority.checkpoint(draft), operations } })
  kernel.authority.install(draft)
  return managerCore(store, kernel)
}

/** @param {Awaited<ReturnType<typeof import('./store.js').openEditLockStore>>} store
 * @param {ReturnType<typeof createEditLockState>} kernel */
function managerCore(store, kernel) {
  const { operations, authority } = kernel
  const managerIncarnation = operations.status().managerIncarnation
  let confirmed = store.snapshot()
  let tail = Promise.resolve()
  /** @type {unknown} */
  let poison
  // Denial only: never a second ownership ledger or a grant source.
  const cancelled = new Map()
  function healthy() {
    if (poison) throw new Error('manager poisoned', { cause: poison })
  }
  /** @param {(draft: ReturnType<typeof authority.begin>) => any} transition */
  function transact(transition) {
    const pending = tail.then(async () => {
      healthy()
      // Until canonical overlap admission is wired, unresolved publication
      // conservatively closes the entire recovered manager to mutations.
      if (confirmed.state.operations.some(operation => ['publishing', 'unknown'].includes(operation.phase))) {
        throw new Error('unresolved publication fence')
      }
      const draft = authority.begin()
      let result
      try { result = transition(draft) } catch (error) {
        authority.discard(draft)
        throw error
      }
      try {
        const nextState = { ...confirmed.state, ...authority.checkpoint(draft) }
        const saved = await store.record({ expectedRevision: confirmed.revision, nextState })
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
    /** Only authenticated human intent may reach this trusted ingress.
     * @param {import('./state.js').Execution} execution @param {string} requestId */
    issueExecutionReceipt(execution, requestId) {
      const captured = { ...execution }
      return transact(draft => {
        if (cancelled.has(captured.sessionId)) throw new Error('session cancelled')
        return draft.authority.issueExecutionReceipt(captured, requestId)
      }).then(async receipt => {
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
        return draft.operations.resume(captured, requestId, receipt)
      }).then(async resumed => {
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
        return draft.authority.openSession(sessionId)
      }).then(async execution => {
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
        return draft.authority.cancel({ sessionId, executionEpoch: session.executionEpoch, managerIncarnation })
      })
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
        return draft.operations.acquire(captured, resourceId)
      }).then(async token => {
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
        return draft.authority.cancel({ ...execution, executionEpoch: current.executionEpoch })
      })
      cancelled.set(execution.sessionId, pending)
      // Keep denial on failure; poisoned state must never expose rollback authority.
      void pending.then(() => cancelled.delete(execution.sessionId), () => {})
      return pending
    },
    status() {
      healthy()
      const snapshot = operations.status()
      for (const session of snapshot.sessions) {
        if (cancelled.has(session.sessionId)) session.interrupted = true
      }
      for (const lock of snapshot.locks) {
        if (cancelled.has(lock.owner) && lock.status !== 'abnormal') lock.status = 'user-interrupted'
      }
      return snapshot
    },
  })
}
