import { createEditLockHost } from './host.js'

/** Host-owned lifecycle controller. The authenticated transport must await stop;
 * stock GUI cancel acceptance alone does not constitute this acknowledgement.
 * @param {Awaited<ReturnType<typeof import('./runtime.js').openEditLockRuntime>>} runtime
 * @param {(agent: object) => string | undefined} sessionForAgent */
export function createEditLockLifecycle(runtime, sessionForAgent) {
  /** @type {Map<object, {sessionId:string, stopped:boolean, ready:Promise<void>, stop?:Promise<void>}>} */
  const entries = new Map()
  const host = createEditLockHost(runtime, agent => {
    const entry = entries.get(agent)
    return !!entry && !entry.stopped && sessionForAgent(agent) === entry.sessionId
  })
  let closed = false
  /** @type {Promise<void> | undefined} */
  let shutdown
  /** @param {object} agent */
  function stop(agent) {
    const entry = entries.get(agent)
    if (!entry) return Promise.reject(new Error('unknown lifecycle agent'))
    if (entry.stop) return entry.stop
    // Registry predicate closes admission synchronously, even before openSession
    // has settled. Manager cancels pending registration at its queue position.
    entry.stopped = true
    try { entry.stop = Promise.resolve(runtime.control.cancelSession(entry.sessionId)) }
    catch (error) { entry.stop = Promise.reject(error) }
    return entry.stop
  }
  return Object.freeze({
    // Only this narrowed service belongs in the tool context.
    service: Object.freeze({publish: host.publish, publishBatch: host.publishBatch}),
    /** Register once before publishing an agent's editing tools. Repeated start
     * cannot resume an interrupted execution. @param {object} agent */
    start(agent) {
      if (closed) return Promise.reject(new Error('edit lifecycle closed'))
      if (entries.has(agent)) return Promise.reject(new Error('agent already registered'))
      const sessionId = sessionForAgent(agent)
      if (!sessionId) return Promise.reject(new Error('unregistered lifecycle agent'))
      if ([...entries.values()].some(entry => entry.sessionId === sessionId)) return Promise.reject(new Error('session already bound'))
      const entry = {sessionId, stopped:false, ready:Promise.resolve()}
      entries.set(agent, entry)
      entry.ready = (async () => {
        try {
          const execution = await runtime.control.openSession(sessionId)
          if (closed || entry.stopped || sessionForAgent(agent) !== sessionId) throw new Error('agent stopped during registration')
          host.attach(agent, execution)
        } catch (error) {
          // Failed registration never leaves an armed manager session behind.
          await stop(agent)
          throw error
        }
      })()
      return entry.ready
    },
    stop,
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
