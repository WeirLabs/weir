import { isAbsolute } from 'node:path'
import { canonicalRequestData } from './request-data.js'

/** Private process-local association, not a durable authority ledger.
 * Only a trusted manager may bind calls; consumers must still authenticate the
 * captured execution against current durable authority before every mutation. */
export function createCallContexts() {
  /** @typedef {{execution: import('./state.js').Execution, cwd: string, effectivePolicy: any, callId: string, signal: AbortSignal}} Context */
  /** @type {WeakMap<object, {context: Context, closed: boolean, abort: () => void, detach: () => void}>} */
  const calls = new WeakMap()
  /** @param {object} call */
  function entry(call) {
    const value = calls.get(call)
    if (!value) throw new Error('unknown call')
    if (value.closed) throw new Error('closed call')
    return value
  }
  /** @param {any} data */
  function freeze(data) {
    if (data && typeof data === 'object') {
      for (const value of Object.values(data)) freeze(value)
      Object.freeze(data)
    }
    return data
  }
  return Object.freeze({
    /** @param {import('./state.js').Execution} execution
     * @param {{signal: AbortSignal, cwd: string, effectivePolicy: unknown, callId: string}} options
     * @param {(execution: import('./state.js').Execution) => void} onAbort */
    bind(execution, { signal, cwd, effectivePolicy, callId }, onAbort) {
      if (!isAbsolute(cwd) || cwd.includes('\0') || typeof callId !== 'string' || !callId.trim()) throw new Error('invalid call context')
      const captured = freeze(JSON.parse(canonicalRequestData({ execution, cwd, effectivePolicy, callId })))
      const controller = new AbortController()
      const call = Object.freeze({})
      let notified = false
      const abort = () => {
        if (notified) return
        notified = true
        try { onAbort(captured.execution) } finally { controller.abort() }
      }
      calls.set(call, { context: Object.freeze({ ...captured, signal: controller.signal }), closed: false, abort,
        detach: () => signal.removeEventListener('abort', abort) })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      return call
    },
    /** @param {object} call */
    inspect(call) { return entry(call).context },
    /** @param {object} call */
    requireLive(call) {
      const context = entry(call).context
      if (context.signal.aborted) throw new Error('call aborted')
      return context
    },
    /** Trusted manager revocation shares the host-abort denial path.
     * @param {object} call */
    revoke(call) { entry(call).abort() },
    /** @param {object} call */
    close(call) {
      const value = entry(call)
      value.closed = true
      value.detach()
    },
  })
}
