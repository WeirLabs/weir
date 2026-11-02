// One manager-owned Operation Coordination module. The per-identity FIFO,
// runtime fence/token and admission-drain transitions are inseparable here;
// mount/probe/registry/CAS work remains in their existing modules.
// The independent createMcpMount Disposal Barrier deliberately stays inner.

/**
 * Per-identity FIFO for operations that open a runtime fence. A rejected task
 * does not poison its identity, and identities have independent tails. The
 * queue is not reentrant: a caller already in a slot passes its fence token to
 * the inner manager operation instead of serializing the same identity again.
 */
export function createMcpIdentityLock() {
  const tails = new Map()
  return function serialize(identity, task) {
    const previous = tails.get(identity) ?? Promise.resolve()
    const run = previous.then(() => task())
    const tail = run.then(() => {}, () => {})
    tails.set(identity, tail)
    void tail.then(() => { if (tails.get(identity) === tail) tails.delete(identity) })
    return run
  }
}

const fallbackLocks = new WeakMap()
/**
 * Resolve the manager's own queue. The WeakMap fallback only supports legacy
 * test/older faces without serialize; a real manager always exposes its one
 * coordinator queue so this adapter cannot silently fork production ordering.
 */
export function mcpIdentityLockFor(manager) {
  if (typeof manager?.serialize === 'function') return (identity, task) => manager.serialize(identity, task)
  if (!manager || (typeof manager !== 'object' && typeof manager !== 'function')) return createMcpIdentityLock()
  let lock = fallbackLocks.get(manager)
  if (!lock) { lock = createMcpIdentityLock(); fallbackLocks.set(manager, lock) }
  return lock
}

/**
 * @param {{
 *   runtime: ReturnType<typeof import('./mcp-runtime.js').createMcpRuntime>,
 *   drain: { closeAll: (identity: string) => void, reopenAll: (identity: string) => void },
 *   transition?: <T>(identity: string, change: () => T) => T,
 * }} options
 */
export function createMcpOperationCoordinator({ runtime, drain, transition = (_identity, change) => change() }) {
  const serialize = createMcpIdentityLock()

  function beginOperation(identity, phase = 'replacing', details = {}) {
    return transition(identity, () => {
      // Both transitions are synchronous and precede every async operation
      // step. No registry, credential or probe await can precede this fence.
      const token = runtime.begin(identity, { phase, ...details })
      drain.closeAll(identity)
      return token
    })
  }

  function finishOperation(token, phase, details = {}) {
    const finished = transition(token.identity, () => runtime.finish(token, phase, details))
    // A stale finish cannot report mounted through runtime.finish and must not
    // reopen admission for whichever operation now owns the identity.
    if (finished && phase === 'mounted') drain.reopenAll(token.identity)
    return finished
  }

  function abortOperation(token) {
    const previousPhase = token.previous?.phase
    return transition(token.identity, () => {
      const restored = runtime.restore(token)
      if (restored && previousPhase === 'mounted') drain.reopenAll(token.identity)
      return restored
    })
  }

  return { serialize, beginOperation, finishOperation, abortOperation }
}
