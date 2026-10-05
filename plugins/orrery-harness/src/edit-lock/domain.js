/** One interface for the publisher-local and remote-client compositions.
 * Every method is trusted host ingress; only `service` reaches tools. */

/** @param {ReturnType<typeof import('./lifecycle.js').createEditLockLifecycle>} lifecycle
 * @param {{close: () => Promise<void>} | undefined} endpoint */
export function localDomain(lifecycle, endpoint) {
  return Object.freeze({
    mode: 'publisher',
    service: lifecycle.service,
    /** @param {object} agent */
    start: agent => lifecycle.start(agent),
    /** Synchronous admission fence for an aborted turn. @param {object} agent */
    latch: agent => { lifecycle.stop(agent).catch(() => {}) },
    /** @param {object} agent */
    stop: async agent => { await lifecycle.stop(agent); return lifecycle.status(agent) },
    /** @param {object} agent */
    dispose: agent => lifecycle.dispose(agent),
    /** @param {object} agent @param {string} requestId */
    resume: (agent, requestId) => lifecycle.resume(agent, requestId),
    /** @param {object} agent @param {string} resourceId */
    confirm: async (agent, resourceId) => { await lifecycle.confirm(agent, resourceId); return lifecycle.status(agent) },
    /** @param {object} agent */
    status: async agent => lifecycle.status(agent),
    /** @param {object} _agent */
    locks: async _agent => lifecycle.locks(),
    /** @param {object} _agent @param {string} resourceId @param {number} generation */
    unlock: (_agent, resourceId, generation) => lifecycle.unlock(resourceId, generation),
    /** Detached stale-lock sweep trigger; the scan runs publisher-side.
     * @param {object} _agent @param {string | null} [triggerSessionId] */
    sweepStale: (_agent, triggerSessionId) => lifecycle.sweepStale(triggerSessionId ?? null),
    /** @param {object} agent @param {string} reason */
    classifyAbnormal: (agent, reason) => lifecycle.classifyAbnormal(agent, reason),
    /** @param {object} agent */
    recoveryUsage: async agent => lifecycle.recoveryUsage(agent),
    /** @param {object} agent @param {any} delta */
    chargeRecovery: (agent, delta) => lifecycle.chargeRecovery(agent, delta),
    /** @param {object} agent @param {number} minutes */
    pause: (agent, minutes) => lifecycle.pause(agent, minutes),
    /** @param {object} agent @param {number} ms @param {{singleMaxMs: number, cumulativeMaxMs: number}} caps */
    hold: (agent, ms, caps) => lifecycle.hold(agent, ms, caps),
    /** The holder started a new turn: every held lock leaves holding at once.
     * @param {object} agent */
    turnStarted: agent => lifecycle.turnStarted(agent),
    /** Release this session's active locks at their current generation, the
     * disposition used when a finished turn's locks were never settled.
     * @param {object} agent */
    releaseHeld: agent => lifecycle.settleExpired(agent, true),
    /** Read-time settlement plus the release half of an elapsed period. Also the
     * trigger for the expiry timer. @param {object} agent */
    settleExpired: (agent, idle) => lifecycle.settleExpired(agent, false, idle),
    /** @param {object} agent */
    retention: agent => lifecycle.retention(agent),
    blocks(agent) { try { return lifecycle.status(agent).state !== 'active' } catch { return true } },
    async close() {
      // Seal remote admission and revoke its channels before local shutdown.
      try { await endpoint?.close() } finally { await lifecycle.close() }
    },
  })
}

/** @param {ReturnType<typeof import('./remote.js').createRemoteEditLockDomain>} remote */
export function remoteDomain(remote) {
  /** @param {string} kind */
  const forward = kind => (/** @type {any} */ exec, /** @type {unknown} */ request) =>
    remote.call(exec.agent, kind, request, exec.signal, kind === 'publish' || kind === 'batch' ? exec.callId : undefined)
  return Object.freeze({
    mode: 'client',
    service: Object.freeze({
      publish: forward('publish'), publishBatch: forward('batch'), acquire: forward('acquire'), release: forward('release'),
      locks: (/** @type {any} */ exec) => remote.call(exec.agent, 'locks'), trySteal: forward('trySteal'), reply: forward('reply'),
    }),
    /** @param {object} agent */
    start: async agent => (await remote.channelFor(agent)).state,
    /** Closing the channel makes the publisher revoke on EOF. @param {object} agent */
    latch: agent => remote.drop(agent),
    /** Awaits the publisher's durable revocation. @param {object} agent */
    stop: async agent => { const status = await remote.call(agent, 'stop'); remote.setState(agent, 'stopped'); return status },
    /** @param {object} agent */
    dispose: async agent => {
      // Clean end: let the publisher release this agent's active locks first.
      try { await remote.call(agent, 'dispose') } catch { /* EOF below still revokes */ }
      remote.drop(agent)
    },
    /** @param {object} agent @param {string} requestId */
    resume: async (agent, requestId) => {
      const status = await remote.call(agent, 'resume', { requestId })
      remote.setState(agent, status.state)
      return status
    },
    /** @param {object} agent @param {string} resourceId */
    confirm: (agent, resourceId) => remote.call(agent, 'confirm', { resourceId }),
    /** @param {object} agent */
    status: agent => remote.call(agent, 'status'),
    /** @param {object} agent */
    locks: agent => remote.call(agent, 'allLocks'),
    /** @param {object} agent @param {string} resourceId @param {number} generation */
    unlock: (agent, resourceId, generation) => remote.call(agent, 'unlock', { resourceId, generation }),
    /** The publisher performs the scan (it shares the filesystem); a client
     * process only triggers it through the channel. @param {object} agent
     * @param {string | null} [triggerSessionId] */
    sweepStale: (agent, triggerSessionId) => remote.call(agent, 'staleSweep', { trigger: triggerSessionId ?? agent?.id ?? null }),
    /** @param {object} agent @param {string} reason */
    classifyAbnormal: async (agent, reason) => {
      const marked = await remote.call(agent, 'classifyAbnormal', { reason })
      if (marked.length) remote.setState(agent, 'recovering')
      return marked
    },
    /** @param {object} agent */
    recoveryUsage: agent => remote.call(agent, 'recoveryUsage'),
    /** @param {object} agent @param {any} delta */
    chargeRecovery: (agent, delta) => remote.call(agent, 'chargeRecovery', delta),
    pause: (agent, minutes) => remote.call(agent, 'pause', { minutes }),
    /** @param {object} agent @param {number} ms @param {{singleMaxMs: number, cumulativeMaxMs: number}} caps */
    hold: (agent, ms, caps) => remote.call(agent, 'hold', { ms, singleMaxMs: caps.singleMaxMs, cumulativeMaxMs: caps.cumulativeMaxMs }),
    /** @param {object} agent */
    turnStarted: agent => remote.call(agent, 'turnStarted'),
    /** @param {object} agent */
    releaseHeld: agent => remote.call(agent, 'releaseHeld'),
    /** @param {object} agent */
    /** @param {object} agent @param {boolean} [idle] */
    settleExpired: (agent, idle) => remote.call(agent, 'settleExpired', { idle: idle ?? /** @type {any} */ (agent)?.status === 'idle' }),
    /** @param {object} agent */
    retention: agent => remote.call(agent, 'retention'),
    /** @param {object} agent */
    blocks: agent => remote.state(agent) !== 'active',
    async close() { remote.close() },
  })
}
