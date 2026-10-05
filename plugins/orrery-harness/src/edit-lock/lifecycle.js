import { createEditLockHost } from './host.js'
import { createNegotiation } from './negotiation.js'
import { RECOVERY_LIMITS } from './recovery.js'
import { isMissingTarget } from './stale-sweep.js'

/** Host-owned lifecycle controller. The authenticated transport must await stop;
 * stock GUI cancel acceptance alone does not constitute this acknowledgement.
 * Resume and confirm are trusted human ingress only; never expose them as tools.
 * @param {Awaited<ReturnType<typeof import('./runtime.js').openEditLockRuntime>>} runtime
 * @param {(agent: object) => string | undefined} sessionForAgent
 * @param {{deliver?: (agent: object, text: string, wake?: boolean) => void, onPending?: (agent: object, pending: number) => void, negotiationTimeoutMs?: number, onStaleRelease?: (row: {resourceId: string, owner: string, generation: number}, triggerSessionId: string | null) => void}} [options] */
export function createEditLockLifecycle(runtime, sessionForAgent, options = {}) {
  /** @typedef {{sessionId:string, state:'starting'|'active'|'recovering'|'stopped'|'resuming', attempt:number, ready:Promise<'active'|'interrupted'>, stop?:Promise<unknown>}} Entry */
  /** @type {Map<object, Entry>} */
  const entries = new Map()
  const host = createEditLockHost(runtime, agent => {
    const entry = entries.get(agent)
    // Cleanup-only recovery keeps the execution for release/reply; business
    // ingress is gated separately below.
    return !!entry && (entry.state === 'active' || entry.state === 'recovering') && sessionForAgent(agent) === entry.sessionId
  })
  /** A stopped session must say so: the generic authentication error made a
   * deliberate Stop look like a broken registration. @param {Entry | undefined} entry */
  function denyStopped(entry) {
    if (entry?.state === 'stopped' || entry?.state === 'resuming') {
      throw new Error('Edit Lock: editing in this session was stopped by the user. Edits and new ownership stay denied until the user chooses Continue editing (Edit Lock panel or /edit-lock resume); edit_lock_release and edit_lock_status still work. Do not retry the edit.')
    }
    if (entry?.state === 'starting') throw new Error('Edit Lock: this session is still registering; retry shortly.')
  }
  /** Session-owned token at the current epoch for subtractive cleanup only.
   * @param {Entry} entry @param {string} resourceId */
  function cleanupToken(entry, resourceId) {
    const { status, session } = sessionStatus(entry.sessionId)
    const lock = status.locks.find(/** @param {any} item */ item => item.resourceId === resourceId)
    if (!session || !lock || lock.owner !== entry.sessionId) throw new Error('lock not owned by this session')
    return { managerIncarnation: status.managerIncarnation, sessionId: entry.sessionId, executionEpoch: session.executionEpoch, resourceId, generation: lock.generation }
  }
  /** Business edits and new ownership need an active (not recovering) session.
   * @param {any} exec */
  function business(exec) {
    const entry = entries.get(exec?.agent)
    denyStopped(entry)
    if (entry?.state === 'recovering') throw new Error('cleanup-only recovery: business edits and new ownership are denied; release locks, answer requests or pause, then wait for a human /edit-lock resume')
  }
  /** A bare "resource owned" left the model without a next step. Name the owner
   * and the two things that can be done; keep the original words so callers and
   * logs that match on them still do. Never changes the decision.
   * @param {() => Promise<any>} attempt @param {{filePath?: string, cwd?: string}} request */
  async function explainOwned(attempt, request) {
    try { return await attempt() } catch (error) {
      if (!/^resource owned$/.test(String(/** @type {any} */ (error)?.message))) throw error
      let owner = 'another session'
      try {
        const resourceId = runtime.requests.resource(String(request?.filePath), String(request?.cwd))
        const lock = runtime.control.status().locks.find(/** @param {any} item */ item => item.resourceId === resourceId)
        if (lock) owner = `session ${lock.owner}${lock.status === 'active' ? '' : ` (${lock.status})`}`
      } catch { /* the plain explanation still applies */ }
      throw new Error(`resource owned: this file is being edited by ${owner}. Ask for it with edit_lock_try_steal, or work on other files; do not retry the same edit.`, { cause: error })
    }
  }
  let closed = false
  /** @type {Promise<void> | undefined} */
  let shutdown
  /** @type {Set<Promise<unknown>>} */
  const disposing = new Set()
  const negotiation = createNegotiation({
    control: runtime.control,
    executionFor: agent => host.executionFor(agent),
    agentFor: sessionId => [...entries].find(([agent, entry]) => entry.sessionId === sessionId && sessionForAgent(agent) === sessionId)?.[0],
    deliver: options.deliver ?? (() => {}),
    onPending: options.onPending,
    timeoutMs: options.negotiationTimeoutMs,
  })
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
  /** Stop, await durable revocation, then forget this agent object. A new
   * agent for the same session starts interrupted. @param {object} agent */
  async function forget(agent) {
    if (!entries.has(agent)) return
    // Forget synchronously (admission is already sealed by stop) so a
    // reconnect for the same session can start interrupted at once.
    const stopping = stop(agent)
    entries.delete(agent)
    disposing.add(stopping)
    try { await stopping } finally { disposing.delete(stopping) }
  }
  /** @param {object} agent */
  function statusOf(agent) {
    const entry = entryFor(agent)
    const { session, status } = sessionStatus(entry.sessionId)
    // Retention settlement is read-time as well as timer-driven (design D5), so a
    // missed timer can never leave stale ownership behind a status read.
    return {
      sessionId: entry.sessionId,
      state: entry.state,
      interrupted: session?.interrupted ?? null,
      revoked: session?.revoked ?? null,
      executionEpoch: session?.executionEpoch ?? null,
      locks: status.locks.filter(/** @param {any} lock */ lock => lock.owner === entry.sessionId),
      recovery: runtime.control.recoveryUsage(entry.sessionId),
      retention: runtime.control.settlement(entry.sessionId, Date.now()),
    }
  }
  return Object.freeze({
    // Only this narrowed service belongs in the tool context.
    service: Object.freeze({
      /** @param {any} exec @param {any} request */
      async publish(exec, request) { business(exec); return explainOwned(() => host.publish(exec, request), request) },
      /** @param {any} exec @param {any} request */
      async publishBatch(exec, request) { business(exec); return host.publishBatch(exec, request) },
      /** @param {any} exec @param {any} request */
      async acquire(exec, request) { business(exec); return explainOwned(() => host.acquire(exec, request), request) },
      /** Release stays available while stopped or recovering: it only removes authority.
       * @param {any} exec @param {{filePath: string, cwd: string}} request */
      async release(exec, request) {
        const entry = entries.get(exec?.agent)
        if (!entry || sessionForAgent(exec.agent) !== entry.sessionId) throw new Error('agent has no authenticated edit execution')
        const resourceId = runtime.requests.resource(request.filePath, request.cwd)
        await runtime.control.release(cleanupToken(entry, resourceId))
        return { resourceId, released: true }
      },
      /** Read-only observation; available in every lifecycle state. @param {any} exec */
      locks(exec) {
        const entry = entries.get(exec?.agent)
        if (!entry || sessionForAgent(exec.agent) !== entry.sessionId) throw new Error('agent has no authenticated edit execution')
        return runtime.control.status().locks.map(/** @param {any} lock */ lock => ({ ...lock, mine: lock.owner === entry.sessionId }))
      },
      /** @param {{agent: object}} exec @param {{filePath: string, cwd: string}} request */
      async trySteal(exec, request) {
        business(exec)
        host.executionFor(exec.agent)
        return negotiation.request(exec.agent, runtime.requests.resource(request.filePath, request.cwd))
      },
      /** @param {{agent: object}} exec @param {{requestId: string, decision: 'release'|'keep'}} request */
      async reply(exec, request) { denyStopped(entries.get(exec?.agent)); return negotiation.reply(exec.agent, request.requestId, request.decision) },
      /** @param {{agent: object}} exec */
      pendingRequests(exec) { return negotiation.pending(host.executionFor(exec.agent).sessionId) },
    }),
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
    /** Normal end of an agent: an agent that is still active (never stopped,
     * not recovering) can never edit again, so its active locks are released
     * first — otherwise every finished subagent would block its files forever.
     * Stopped, abnormal and unresolved state is retained for a human.
     * @param {object} agent */
    async dispose(agent) {
      const entry = entries.get(agent)
      if (entry?.state === 'active') {
        try {
          const tokens = sessionStatus(entry.sessionId).status.locks
            .filter(/** @param {any} lock */ lock => lock.owner === entry.sessionId && lock.status === 'active')
            .map(/** @param {any} lock */ lock => cleanupToken(entry, lock.resourceId))
          if (tokens.length) await runtime.control.releaseMany(tokens)
        } catch { /* an unresolved fence or race keeps the locks; revocation still follows */ }
      }
      return forget(agent)
    },
    /** Connection loss or crash: stop and forget WITHOUT releasing anything.
     * @param {object} agent */
    forget,
    /** Trusted explicit Continue. Consumes a one-use receipt bound to requestId;
     * retained interrupted locks become pending-confirmation, never active.
     * @param {object} agent @param {string} requestId */
    async resume(agent, requestId) {
      if (closed) throw new Error('edit lifecycle closed')
      const entry = entryFor(agent)
      // A recovering session is first durably revoked; abnormal locks stay abnormal.
      if (entry.state === 'recovering') revoke(entry)
      if (entry.state !== 'stopped' || !entry.stop) throw new Error('agent is not interrupted')
      await entry.stop
      if (closed || entry.state !== 'stopped') throw new Error('agent state changed before resume')
      entry.state = 'resuming'
      const attempt = ++entry.attempt
      try {
        const { status, session } = sessionStatus(entry.sessionId)
        if (session?.revoked) throw new Error('Edit Lock: editing authority in this session was permanently revoked by an administrative recovery and cannot be resumed. Start a new conversation to edit this workspace again.')
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
    /** Trusted classifier (durable turn/end error): retained locks become
     * abnormal and the session enters cleanup-only recovery. No locks → no-op.
     * @param {object} agent @param {string} reason @returns {Promise<string[]>} */
    async classifyAbnormal(agent, reason) {
      const entry = entryFor(agent)
      if (entry.state !== 'active') return []
      const marked = await runtime.control.markAbnormal(entry.sessionId, reason)
      const abnormal = statusOf(agent).locks.some(/** @param {any} lock */ lock => lock.status === 'abnormal')
      if (abnormal && entry.state === 'active') entry.state = 'recovering'
      return marked
    },
    /** Explicit bounded retention of every lock the session currently holds. The
     * caller resolves the configured caps; ownership is untouched, so this only
     * extends it. Never available while stopped or recovering: those locks are
     * handled as abnormal locks, and a retention period must not hide them.
     * @param {object} agent @param {number} ms
     * @param {{singleMaxMs: number, cumulativeMaxMs: number}} caps */
    async hold(agent, ms, caps) {
      const entry = entryFor(agent)
      denyStopped(entry)
      if (entry.state === 'recovering') throw new Error('cleanup-only recovery: no retention request is available while abnormal locks are pending')
      const held = await runtime.control.hold(entry.sessionId, ms, { ...caps, now: Date.now() })
      return { ...held, lockCount: statusOf(agent).locks.length }
    },
    /** The holder started a new turn: every lock it holds leaves the holding state
     * at once (spec: Holding state semantics). Safe while stopped; a stopped
     * session has no retention period anyway. @param {object} agent */
    async turnStarted(agent) {
      const entry = entries.get(agent)
      if (!entry) return null
      return runtime.control.endHold(entry.sessionId, Date.now())
    },
    /** Read-time settlement plus its release half (design D5). Releases the
     * session's active locks when the period has genuinely run out, so it is
     * idempotent and safe from a status read or a timer. A host that is mid-turn is
     * never released implicitly: the release is deferred to the turn it ends on,
     * because releasing under a running turn would drop the holder's own locks.
     * `force` is the fallback disposition after the notices run out, which is a
     * deliberate policy decision rather than an expiry.
     * @param {object} agent @param {boolean} [force]
     * @returns {Promise<{released: string[]}>} */
    async settleExpired(agent, force = false, idle = undefined) {
      const entry = entries.get(agent)
      if (!entry) return { released: [] }
      // A channel agent on the publisher side has no status of its own; the host
      // that runs the agent says whether it is idle.
      const isIdle = idle ?? /** @type {any} */ (agent)?.status === 'idle'
      if (!force && !isIdle) return { released: [], deferred: true }
      if (!force && !runtime.control.settlement(entry.sessionId, Date.now()).expired) return { released: [] }
      // Expiry is re-checked inside the transaction, so a hold extended or ended
      // after the check above is never released by this call.
      const released = await runtime.control.releaseActive(entry.sessionId, Date.now(), !force)
      return { released }
    },
    /** Retention state of one session, settled. @param {object} agent */
    retention(agent) { return runtime.control.settlement(entryFor(agent).sessionId, Date.now()) },
    /** @param {object} agent */
    recoveryUsage(agent) { return runtime.control.recoveryUsage(entryFor(agent).sessionId) },
    /** @param {object} agent @param {{attempts?: number, elapsedMs?: number, pauseMs?: number}} delta */
    chargeRecovery(agent, delta) { return runtime.control.chargeRecovery(entryFor(agent).sessionId, delta) },
    /** Bounded pause; charged durably up front, never extends or releases.
     * @param {object} agent @param {number} minutes */
    async pause(agent, minutes) {
      const entry = entryFor(agent)
      if (entry.state !== 'recovering') throw new Error('pause is only available during cleanup-only recovery')
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be positive')
      const ms = Math.round(minutes * 60_000)
      if (ms > RECOVERY_LIMITS.singlePauseMs) throw new Error(`a single pause is limited to ${RECOVERY_LIMITS.singlePauseMs / 60_000} minutes`)
      const usage = runtime.control.recoveryUsage(entry.sessionId)
      if (usage.pauseMs + ms > RECOVERY_LIMITS.cumulativePauseMs) throw new Error(`cumulative pause budget exhausted (${Math.floor((RECOVERY_LIMITS.cumulativePauseMs - usage.pauseMs) / 60_000)} minutes left)`)
      await runtime.control.chargeRecovery(entry.sessionId, { pauseMs: ms })
      return { pausedMs: ms, cumulativePauseMs: usage.pauseMs + ms }
    },
    /** Trusted maintenance ingress for the stale-lock sweep (message-triggered;
     * local composition and the peer channel both land here). The publisher
     * shares the filesystem with the authority, so the scan ALWAYS runs on this
     * side — a client process only triggers it. A lock row is a candidate ONLY
     * when lstat of its stored canonical resource id fails with ENOENT; the
     * manager's releaseStale re-verifies the full observed row (owner,
     * generation, owner execution epoch, lock status) and re-probes the target
     * at the FIFO execution point, so an owner that resumed, confirmed,
     * re-generated or sits under an unresolved fence between scan and
     * execution is a skip, never an error. Silent by contract: each durable
     * release is reported through options.onStaleRelease (shared audit);
     * skips and failures surface only in the returned counts for the caller's
     * bounded logging. Never writes to any conversation.
     * @param {string | null} [triggerSessionId] session whose genuine user
     * message armed the sweep (audit metadata only)
     * @returns {Promise<{released: any[], skipped: any[]}>} */
    async sweepStale(triggerSessionId = null) {
      if (closed) throw new Error('edit lifecycle closed')
      const status = runtime.control.status()
      const sessions = new Map(status.sessions.map(/** @param {any} item */ item => [item.sessionId, item]))
      /** @type {{resourceId: string, owner: string, generation: number, executionEpoch: number, status: string}[]} */
      const observed = []
      for (const lock of status.locks) {
        const session = sessions.get(lock.owner)
        if (!session || !isMissingTarget(lock.resourceId)) continue
        observed.push({ resourceId: lock.resourceId, owner: lock.owner, generation: lock.generation, executionEpoch: session.executionEpoch, status: lock.status })
      }
      if (observed.length === 0) return { released: [], skipped: [] }
      const result = await runtime.control.releaseStale(observed, isMissingTarget)
      for (const row of result.released) {
        try { options.onStaleRelease?.(row, triggerSessionId) } catch { /* audit is log-only and never breaks the sweep */ }
      }
      return result
    },
    /** Trusted human unlock by exact generation; never exposed as a tool.
     * Session interruption and pending confirmations are untouched.
     * @param {string} resourceId @param {number} generation */
    unlock(resourceId, generation) {
      if (closed) return Promise.reject(new Error('edit lifecycle closed'))
      return runtime.control.adminUnlock(resourceId, generation)
    },
    /** Domain-wide observation for trusted UI/commands; grants nothing. */
    locks() { return runtime.control.status().locks },
    /** Effective observation for trusted UI/commands; not a write permission. */
    status: statusOf,
    close() {
      if (shutdown) return shutdown
      closed = true
      negotiation.close()
      const stops = [...entries.keys()].map(stop).concat([...disposing])
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
