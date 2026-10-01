import { createEditLockHost } from './host.js'

/** Host-owned lifecycle controller. The authenticated transport must await stop;
 * stock GUI cancel acceptance alone does not constitute this acknowledgement.
 * Resume and confirm are trusted human ingress only; never expose them as tools.
 * @param {Awaited<ReturnType<typeof import('./runtime.js').openEditLockRuntime>>} runtime
 * @param {(agent: object) => string | undefined} sessionForAgent */
export function createEditLockLifecycle(runtime, sessionForAgent) {
  /** @typedef {{sessionId:string, state:'starting'|'active'|'stopped'|'resuming', attempt:number, ready:Promise<'active'|'interrupted'>, stop?:Promise<unknown>}} Entry */
  /** @type {Map<object, Entry>} */
  const entries = new Map()
  const host = createEditLockHost(runtime, agent => {
    const entry = entries.get(agent)
    return !!entry && entry.state === 'active' && sessionForAgent(agent) === entry.sessionId
  })
  let closed = false
  /** @type {Promise<void> | undefined} */
  let shutdown
  /** Close admission synchronously, then revoke at the manager queue position.
   * @param {Entry} entry */
  function revoke(entry) {
    entry.state = 'stopped'
    entry.attempt++
    try { entry.stop = Promise.resolve(runtime.control.cancelSession(entry.sessionId)) }
    catch (error) { entry.stop = Promise.reject(error) }
    entry.stop.catch(() => {})
    return entry.stop
  }
  /** @param {object} agent */
  function stop(agent) {
    const entry = entries.get(agent)
    if (!entry) return Promise.reject(new Error('unknown lifecycle agent'))
    if (entry.state === 'stopped' && entry.stop) return entry.stop
    return revoke(entry)
  }
  /** @param {object} agent */
  function entryFor(agent) {
    const entry = entries.get(agent)
    if (!entry || sessionForAgent(agent) !== entry.sessionId) throw new Error('unknown lifecycle agent')
    return entry
  }
  /** @param {string} sessionId */
  function sessionStatus(sessionId) {
    const status = runtime.control.status()
    return { status, session: status.sessions.find(/** @param {any} s */ s => s.sessionId === sessionId) }
  }
  /** @param {object} agent */
  function statusOf(agent) {
    const entry = entryFor(agent)
    const { session, status } = sessionStatus(entry.sessionId)
    return {
      sessionId: entry.sessionId,
      state: entry.state,
      interrupted: session?.interrupted ?? null,
      executionEpoch: session?.executionEpoch ?? null,
      locks: status.locks.filter(/** @param {any} lock */ lock => lock.owner === entry.sessionId),
    }
  }
  return Object.freeze({
    // Only this narrowed service belongs in the tool context.
    service: Object.freeze({publish: host.publish, publishBatch: host.publishBatch}),
    /** Register once before publishing an agent's editing tools. A session the
     * manager already knows (restart, re-created agent) is never re-armed: it
     * starts interrupted and needs trusted resume. @param {object} agent
     * @returns {Promise<'active'|'interrupted'>} */
    start(agent) {
      if (closed) return Promise.reject(new Error('edit lifecycle closed'))
      if (entries.has(agent)) return Promise.reject(new Error('agent already registered'))
      const sessionId = sessionForAgent(agent)
      if (!sessionId) return Promise.reject(new Error('unregistered lifecycle agent'))
      if ([...entries.values()].some(entry => entry.sessionId === sessionId)) return Promise.reject(new Error('session already bound'))
      /** @type {Entry} */
      const entry = {sessionId, state:'starting', attempt:0, ready:Promise.resolve(/** @type {'active'} */ ('active'))}
      entries.set(agent, entry)
      entry.ready = (async () => {
        let known
        try { known = sessionStatus(sessionId).session }
        catch (error) { await revoke(entry).catch(() => {}); throw error }
        if (known) {
          await revoke(entry)
          return /** @type {'interrupted'} */ ('interrupted')
        }
        const attempt = entry.attempt
        try {
          const execution = await runtime.control.openSession(sessionId)
          if (closed || entry.state !== 'starting' || entry.attempt !== attempt || sessionForAgent(agent) !== sessionId) {
            throw new Error('agent stopped during registration')
          }
          entry.state = 'active'
          host.attach(agent, execution)
          return /** @type {'active'} */ ('active')
        } catch (error) {
          // Failed registration never leaves an armed manager session behind.
          await stop(agent)
          throw error
        }
      })()
      return entry.ready
    },
    stop,
    /** Stop, await durable revocation, then forget this agent object. A new
     * agent for the same session starts interrupted. @param {object} agent */
    async dispose(agent) {
      if (!entries.has(agent)) return
      try { await stop(agent) } finally { entries.delete(agent) }
    },
    /** Trusted explicit Continue. Consumes a one-use receipt bound to requestId;
     * retained interrupted locks become pending-confirmation, never active.
     * @param {object} agent @param {string} requestId */
    async resume(agent, requestId) {
      if (closed) throw new Error('edit lifecycle closed')
      const entry = entryFor(agent)
      if (entry.state !== 'stopped' || !entry.stop) throw new Error('agent is not interrupted')
      await entry.stop
      if (closed || entry.state !== 'stopped') throw new Error('agent state changed before resume')
      entry.state = 'resuming'
      const attempt = ++entry.attempt
      try {
        const { status, session } = sessionStatus(entry.sessionId)
        if (!session?.interrupted) throw new Error('session is not durably interrupted')
        const execution = {managerIncarnation: status.managerIncarnation, sessionId: entry.sessionId, executionEpoch: session.executionEpoch}
        const receipt = await runtime.control.issueExecutionReceipt(execution, requestId)
        const resumed = await runtime.control.resume(execution, requestId, receipt)
        if (closed || entry.state !== 'resuming' || entry.attempt !== attempt || sessionForAgent(agent) !== entry.sessionId) {
          throw new Error('agent stopped during resume')
        }
        entry.state = 'active'
        host.attach(agent, resumed)
        return statusOf(agent)
      } catch (error) {
        // Anything that may have resumed without attaching is revoked again.
        if (entry.state === 'resuming' && entry.attempt === attempt) await revoke(entry).catch(() => {})
        throw error
      }
    },
    /** Trusted per-file confirmation of a pending-confirmation lock.
     * @param {object} agent @param {string} resourceId */
    async confirm(agent, resourceId) {
      if (closed) throw new Error('edit lifecycle closed')
      entryFor(agent)
      await runtime.control.confirm(host.executionFor(agent), resourceId)
    },
    /** Effective observation for trusted UI/commands; not a write permission. */
    status: statusOf,
    close() {
      if (shutdown) return shutdown
      closed = true
      const stops = [...entries.keys()].map(stop)
      shutdown = (async () => {
        const results = await Promise.allSettled(stops)
        await Promise.allSettled([...entries.values()].map(entry => entry.ready))
        await host.close()
        // host.close drains and closes its runtime. The external owner must
        // seal IPC admission before calling this and retain its lease until return.
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
        if (errors.length) throw new AggregateError(errors, 'edit lifecycle revocation failed')
      })()
      return shutdown
    },
  })
}
