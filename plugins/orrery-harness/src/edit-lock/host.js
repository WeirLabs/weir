import { createEditLockAdapter } from './adapter.js'
import { randomUUID } from 'node:crypto'
import { canonicalRequestData } from './request-data.js'

/** Trusted host binding. Registration is an explicit lifecycle action, never a
 * tool argument or inference from a user-message source tag. Not auto-mounted.
 * @param {Awaited<ReturnType<typeof import('./runtime.js').openEditLockRuntime>>} runtime
 * @param {(agent: object) => boolean} isRegisteredAgent */
export function createEditLockHost(runtime, isRegisteredAgent) {
  // Provider tool-call ids are not unique across turns (some reuse call_0):
  // one operation identity per actual execution object, stable within it.
  /** @type {WeakMap<object, string>} */
  const operationIds = new WeakMap()
  /** @param {{callId: string}} exec */
  function operationIdFor(exec) {
    let id = operationIds.get(exec)
    if (!id) { id = `${exec.callId}@${randomUUID()}`; operationIds.set(exec, id) }
    return id
  }
  const adapter = createEditLockAdapter(runtime)
  /** @type {WeakMap<object, import('./state.js').Execution>} */
  const executions = new WeakMap()
  const activeBatches = new Set()
  let closed = false
  function live() { if (closed) throw new Error('edit lock host closed') }
  return Object.freeze({
    /** Called by the authenticated host lifecycle after durable registration or resume.
     * @param {object} agent @param {import('./state.js').Execution} execution */
    attach(agent, execution) {
      live()
      if (!isRegisteredAgent(agent)) throw new Error('unregistered host agent')
      executions.set(agent, Object.freeze({ ...execution }))
    },
    /** Revoke admission before waiting for durable cancellation.
     * @param {object} agent */
    detach(agent) {
      live()
      const execution = executions.get(agent)
      executions.delete(agent)
      if (!execution) throw new Error('agent has no edit execution')
      return runtime.control.cancelSession(execution.sessionId)
    },
    /** Trusted lifecycle lookup of the current admitted execution only.
     * @param {object} agent */
    executionFor(agent) {
      live()
      const execution = executions.get(agent)
      if (!execution || !isRegisteredAgent(agent)) throw new Error('agent has no authenticated edit execution')
      return execution
    },
    /** Tool implementation ingress AFTER effective policy resolution.
     * @param {{agent: object, signal: AbortSignal, callId: string}} exec
     * @param {Parameters<typeof adapter.publish>[1] & {cwd: string, effectivePolicy: unknown}} request */
    async publish(exec, request) {
      live()
      const execution = executions.get(exec.agent)
      if (!execution || !isRegisteredAgent(exec.agent)) throw new Error('agent has no authenticated edit execution')
      const call = adapter.bind(execution, { cwd: request.cwd, effectivePolicy: request.effectivePolicy,
        callId: operationIdFor(exec), signal: exec.signal })
      const operation = await adapter.publish(call, request)
      return operation.outcome
    },
    /** Existing-file batch only. Failed batches retain every temporary lock.
     * @param {{agent: object, signal: AbortSignal, callId: string}} exec
     * @param {{cwd: string, effectivePolicy: any, args: unknown, plans: Array<{filePath: string, content: string, version: string}>}} request */
    async publishBatch(exec, request) {
      live()
      request = JSON.parse(canonicalRequestData(request))
      if (typeof exec.callId !== 'string' || !exec.callId.trim()) throw new Error('call id required')
      const execution = executions.get(exec.agent)
      if (!execution || !isRegisteredAgent(exec.agent)) throw new Error('agent has no authenticated edit execution')
      if (exec.signal.aborted) throw new Error('call aborted')
      if (!['workspace-write', 'danger-full-access'].includes(request.effectivePolicy?.mode)) throw new Error('writable effective policy required')
      const operation = operationIdFor(exec)
      const ids = request.plans.map((_, index) => JSON.stringify(['lsp_rename', operation, index]))
      // Never restart a partially applied batch by reacquiring released ownership.
      for (const id of ids) if (runtime.control.history(execution.sessionId, id)) throw new Error('rename batch has history; inspect retained outcomes before retry')
      const batchKey = JSON.stringify([execution.sessionId, exec.callId])
      if (activeBatches.has(batchKey)) throw new Error('rename batch already in progress')
      activeBatches.add(batchKey)
      const abort = () => { try { void runtime.control.cancel(execution).catch(() => {}) } catch {} }
      exec.signal.addEventListener('abort', abort, {once: true})
      const written = []
      let index = 0
      try {
        const ownership = await runtime.requests.acquireBatch(execution, request.plans.map(plan => plan.filePath), request.cwd)
        for (const plan of request.plans) {
          live()
          const batchOwnership = ownership.ordered[index]
          if (!batchOwnership) throw new Error('missing batch ownership')
          const call = adapter.bind(execution, {cwd: request.cwd, effectivePolicy: request.effectivePolicy, callId: ids[index], signal: exec.signal})
          await adapter.publish(call, {tool: 'lsp_rename', filePath: plan.filePath, content: plan.content,
            batchOwnership, args: request.args, expected: {kind: 'replaceIfVersion', version: plan.version}})
          written.push(plan.filePath)
          index++
        }
        if (exec.signal.aborted) throw new Error('call aborted before temporary ownership cleanup')
        await runtime.control.releaseMany(ownership.temporary)
        return { written }
      } catch (error) {
        /** @type {string[]} */
        let uncertain = []
        if (index < request.plans.length) {
          try {
            const operation = runtime.control.history(execution.sessionId, ids[index])
            if (operation && ['publishing', 'unknown', 'created', 'updated'].includes(operation.phase)) uncertain = [request.plans[index].filePath]
          } catch { uncertain = [request.plans[index].filePath] }
        }
        const notWritten = request.plans.slice(index).map(plan => plan.filePath).filter(path => !uncertain.includes(path))
        throw new Error(`rename stopped: ${String(error)}; filesAlreadyWritten: ${JSON.stringify(written)}; filesNotWritten: ${JSON.stringify(notWritten)}; filesUncertain: ${JSON.stringify(uncertain)}; ownership retained (no rollback)`, {cause: error})
      } finally {
        activeBatches.delete(batchKey)
        exec.signal.removeEventListener('abort', abort)
      }
    },
    /** Ordinary owner tool: acquire one existing file. Activates this
     * session's own pending-confirmation lock; never steals another owner's.
     * @param {{agent: object}} exec @param {{filePath: string, cwd: string}} request */
    async acquire(exec, request) {
      live()
      const execution = executions.get(exec.agent)
      if (!execution || !isRegisteredAgent(exec.agent)) throw new Error('agent has no authenticated edit execution')
      const resourceId = runtime.requests.resource(request.filePath, request.cwd)
      const token = await runtime.control.acquire(execution, resourceId)
      return { resourceId, generation: token.generation }
    },
    /** Ordinary owner tool: release one owned lock. Release never asserts
     * content correctness. @param {{agent: object}} exec @param {{filePath: string, cwd: string}} request */
    async release(exec, request) {
      live()
      const execution = executions.get(exec.agent)
      if (!execution || !isRegisteredAgent(exec.agent)) throw new Error('agent has no authenticated edit execution')
      const resourceId = runtime.requests.resource(request.filePath, request.cwd)
      const lock = runtime.control.status().locks.find(/** @param {any} item */ item => item.resourceId === resourceId)
      if (!lock || lock.owner !== execution.sessionId) throw new Error('lock not owned by this session')
      await runtime.control.release({ ...execution, resourceId, generation: lock.generation })
      return { resourceId, released: true }
    },
    /** Effective lock observation for one admitted agent; grants nothing.
     * @param {{agent: object}} exec */
    locks(exec) {
      live()
      const execution = executions.get(exec.agent)
      if (!execution || !isRegisteredAgent(exec.agent)) throw new Error('agent has no authenticated edit execution')
      return runtime.control.status().locks.map(/** @param {any} lock */ lock => ({ ...lock, mine: lock.owner === execution.sessionId }))
    },
    close() { closed = true; return adapter.close() },
  })
}
