import { createEditLockState } from './state.js'

/**
 * Unmounted trusted manager core. Caller exclusively owns the store lifecycle;
 * this factory does not elect a singleton or expose any file publication path.
 * Recovery is not implemented: only a pristine store is accepted.
 * @param {{store: Awaited<ReturnType<typeof import('./store.js').openEditLockStore>>, managerIncarnation: string}} options
 */
export function createEditLockManager({ store, managerIncarnation }) {
  const { operations, authority } = createEditLockState(managerIncarnation)
  let confirmed = store.snapshot()
  if (confirmed.revision !== 0 || confirmed.state.managerIncarnation !== null) {
    throw new Error('fresh store required; recovery unavailable')
  }
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
    /** @param {string} sessionId */
    openSession(sessionId) { return transact(draft => draft.authority.openSession(sessionId)) },
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
      const pending = transact(draft => draft.authority.cancel(execution))
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
