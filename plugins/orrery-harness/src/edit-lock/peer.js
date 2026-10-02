import { canonicalRequestData } from './request-data.js'

/** Model-facing tool kinds and trusted human-ingress kinds. The connecting
 * host process is the trusted ingress for the latter (same trust base). */
export const PEER_KINDS = Object.freeze(['publish', 'batch', 'acquire', 'release', 'locks', 'trySteal', 'reply', 'pending',
  'status', 'stop', 'resume', 'confirm', 'unlock', 'allLocks', 'classifyAbnormal', 'recoveryUsage', 'chargeRecovery', 'pause',
  'hold', 'turnStarted', 'releaseHeld', 'settleExpired', 'retention', 'dispose'])

/** Bind an already authenticated, host-owned channel to ONE registered agent.
 * No identity or lifecycle capability is accepted in a wire message. The caller
 * process is trusted to resolve policy; this is not remote attestation.
 * @param {ReturnType<typeof import('./lifecycle.js').createEditLockLifecycle>} lifecycle
 * @param {object} agent */
export function createEditLockPeer(lifecycle, agent) {
  const pending = new Set()
  let closed = false
  /** @type {Promise<unknown> | undefined} */
  let closing
  function disconnect() {
    if (closing) return closing
    closed = true
    // stop synchronously fences the registry before waiting for any publication;
    // Connection loss may be a crash: revoke and forget, never release. A
    // clean client end sends 'dispose' first.
    closing = lifecycle.forget ? lifecycle.forget(agent) : lifecycle.stop(agent)
    return /** @type {Promise<void>} */ (closing)
  }
  return Object.freeze({
    /** Transport must bound frame bytes before JSON parsing and call disconnect
     * on EOF/error. Responses carry outcomes, never reusable write permissions.
     * @param {unknown} input */
    async receive(input) {
      if (closed) throw new Error('edit peer disconnected')
      const message = JSON.parse(canonicalRequestData(input))
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).sort().join(',') !== 'callId,kind,request'
        || !PEER_KINDS.includes(message.kind)
        || typeof message.callId !== 'string' || !message.callId.trim()) throw new Error('invalid edit peer message')
      if (pending.has(message.callId)) throw new Error('edit peer call already pending')
      if (pending.size >= 32) throw new Error('edit peer admission limit')
      pending.add(message.callId)
      try {
        const exec = {agent,callId:message.callId,signal:new AbortController().signal}
        const request = /** @type {any} */ (message.request)
        const service = /** @type {any} */ (lifecycle.service)
        switch (message.kind) {
          case 'publish': return await service.publish(exec, request)
          case 'batch': return await service.publishBatch(exec, request)
          case 'acquire': return await service.acquire(exec, request)
          case 'release': return await service.release(exec, request)
          case 'locks': return await service.locks(exec)
          case 'trySteal': return await service.trySteal(exec, request)
          case 'reply': return await service.reply(exec, request)
          case 'pending': return await service.pendingRequests(exec)
          case 'status': return lifecycle.status(agent)
          case 'stop': await lifecycle.stop(agent); return lifecycle.status(agent)
          case 'resume': return await lifecycle.resume(agent, `remote:${String(request?.requestId)}`)
          case 'confirm': await lifecycle.confirm(agent, request?.resourceId); return lifecycle.status(agent)
          case 'unlock': return await lifecycle.unlock(request?.resourceId, request?.generation)
          case 'allLocks': return lifecycle.locks()
          case 'classifyAbnormal': return await lifecycle.classifyAbnormal(agent, String(request?.reason ?? 'abnormal'))
          case 'recoveryUsage': return lifecycle.recoveryUsage(agent)
          case 'chargeRecovery': return await lifecycle.chargeRecovery(agent, request ?? {})
          case 'pause': return await lifecycle.pause(agent, Number(request?.minutes))
          case 'hold': return await lifecycle.hold(agent, Number(request?.ms), { singleMaxMs: Number(request?.singleMaxMs), cumulativeMaxMs: Number(request?.cumulativeMaxMs) })
          case 'turnStarted': return await lifecycle.turnStarted(agent)
          case 'releaseHeld': return await lifecycle.settleExpired(agent, true)
          case 'settleExpired': return await lifecycle.settleExpired(agent)
          case 'retention': return lifecycle.retention(agent)
          case 'dispose': { closed = true; await lifecycle.dispose(agent); return { disposed: true } }
          default: throw new Error('invalid edit peer message')
        }
      } finally { pending.delete(message.callId) }
    },
    // Trusted channel lifecycle only, not a model-controlled request method.
    disconnect,
  })
}
