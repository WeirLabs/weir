import { canonicalRequestData } from './request-data.js'

/** Bind an already authenticated, host-owned channel to ONE registered agent.
 * No identity or lifecycle capability is accepted in a wire message. The caller
 * process is trusted to resolve policy; this is not remote attestation.
 * @param {ReturnType<typeof import('./lifecycle.js').createEditLockLifecycle>} lifecycle
 * @param {object} agent */
export function createEditLockPeer(lifecycle, agent) {
  const pending = new Set()
  let closed = false
  /** @type {Promise<void> | undefined} */
  let closing
  function disconnect() {
    if (closing) return closing
    closed = true
    // stop synchronously fences the registry before waiting for any publication.
    closing = lifecycle.stop(agent)
    return closing
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
        || !['publish', 'batch'].includes(message.kind)
        || typeof message.callId !== 'string' || !message.callId.trim()) throw new Error('invalid edit peer message')
      if (pending.has(message.callId)) throw new Error('edit peer call already pending')
      if (pending.size >= 32) throw new Error('edit peer admission limit')
      pending.add(message.callId)
      try {
        const exec = {agent,callId:message.callId,signal:new AbortController().signal}
        return message.kind === 'publish'
          ? await lifecycle.service.publish(exec, message.request)
          : await lifecycle.service.publishBatch(exec, message.request)
      } finally { pending.delete(message.callId) }
    },
    // Trusted channel lifecycle only, not a model-controlled request method.
    disconnect,
  })
}
