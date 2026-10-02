import { createCallContexts } from './call-context.js'

/** Trusted tool adapter. The host binds exec.agent to an authenticated execution;
 * model arguments never contain epochs, ownership tokens or effective policy.
 * @param {Awaited<ReturnType<typeof import('./runtime.js').openEditLockRuntime>>} runtime */
export function createEditLockAdapter(runtime) {
  const calls = createCallContexts()
  const active = new Set()
  const used = new WeakSet()
  let closing = false
  return Object.freeze({
    /** Host-only ingress after effective per-call sandbox policy resolution.
     * @param {import('./state.js').Execution} execution
     * @param {Parameters<typeof calls.bind>[1]} context */
    bind(execution, context) {
      if (closing) throw new Error('edit lock adapter closing')
      const call = calls.bind(execution, context, origin => {
        try { void runtime.control.cancel(origin).catch(() => {}) } catch { /* stale origin cannot cancel a new execution */ }
      })
      active.add(call)
      return call
    },
    /** @param {object} call
     * @param {{tool: 'write'|'hash_edit'|'lsp_rename', filePath: string, args: unknown, content: string,
     * batchOwnership?: import('./state.js').Ownership,
     * expected: {kind: 'createIfAbsent'}|{kind: 'replaceIfVersion', version: string}}} request */
    async publish(call, request) {
      if (closing) throw new Error('edit lock adapter closing')
      if (used.has(call)) throw new Error('call already submitted')
      used.add(call)
      calls.inspect(call)
      try {
        const context = calls.requireLive(call)
        const prepared = await runtime.requests.prepare(context.execution, {
          ...request, operationId: context.callId, cwd: context.cwd, effectivePolicy: context.effectivePolicy,
        }, context.signal)
        const operation = prepared.kind === 'history' ? prepared.operation
          : prepared.submission ? await runtime.requests.commit(prepared.submission) : null
        if (!operation || !['created', 'updated'].includes(operation.phase)) {
          throw new Error(`publication not acknowledged: ${operation?.phase ?? 'missing'}`)
        }
        return operation
      } finally {
        calls.close(call)
        active.delete(call)
      }
    },
    /** Stop dispatch and retain interrupted ownership before host disposal. */
    async close() {
      closing = true
      for (const call of active) calls.revoke(call)
      await runtime.close()
      for (const call of active) calls.close(call)
      active.clear()
    },
  })
}
