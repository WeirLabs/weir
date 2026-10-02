import { randomUUID } from 'node:crypto'

/** Request-bound holder negotiation (try_steal → holder reply).
 *
 * Requests live in memory on purpose: a manager restart advances every
 * session epoch and the incarnation, so a request from before a restart could
 * only ever be stale. Timeout, delivery failure, silence and an interrupted
 * holder all retain ownership; only a current reply from the exact bound
 * holder execution transfers, and the transfer itself is one durable manager
 * transaction. Waiting holds no manager queue slot.
 * @param {{
 *   control: {status: () => any, transfer: (holder: any, requester: any) => Promise<any>},
 *   executionFor: (agent: object) => import('./state.js').Execution,
 *   agentFor: (sessionId: string) => object | undefined,
 *   deliver: (agent: object, text: string, wake?: boolean) => void,
 *   onPending?: (agent: object, pending: number) => void,
 *   timeoutMs?: number, now?: () => number,
 * }} options */
export function createNegotiation(options) {
  const { control, executionFor, agentFor, deliver } = options
  const timeoutMs = options.timeoutMs ?? 120_000
  const now = options.now ?? Date.now
  /** @typedef {{requestId: string, resourceId: string, generation: number,
   * holder: {sessionId: string, executionEpoch: number}, requester: import('./state.js').Execution,
   * state: 'pending'|'transferring'|'transferred'|'declined'|'expired'|'stale'|'failed', expiresAt: number,
   * timer?: ReturnType<typeof setTimeout>}} Request */
  /** @type {Map<string, Request>} */
  const requests = new Map()
  let closed = false

  /** `wake` opens an idle turn, which a holder needs in order to answer at all;
   * it is never used for interrupted holders or for outcome notices.
   * @param {string} sessionId @param {string} text @param {boolean} [wake] */
  function notify(sessionId, text, wake = false) {
    const agent = agentFor(sessionId)
    if (!agent) return
    try { deliver(agent, text, wake) } catch { /* delivery failure never implies consent */ }
  }
  /** @param {string} sessionId */
  function pendingFor(sessionId) {
    return [...requests.values()].filter(request => request.holder.sessionId === sessionId && request.state === 'pending')
  }
  /** @param {string} sessionId */
  function refresh(sessionId) {
    const agent = agentFor(sessionId)
    if (agent) options.onPending?.(agent, pendingFor(sessionId).length)
  }
  /** @param {Request} request @param {Request['state']} state @param {string} text */
  function settle(request, state, text) {
    if (request.state !== 'pending' && request.state !== 'transferring') return
    request.state = state
    if (request.timer) clearTimeout(request.timer)
    notify(request.requester.sessionId, text)
    refresh(request.holder.sessionId)
  }
  /** @param {string} resourceId */
  function lockOf(resourceId) {
    return control.status().locks.find(/** @param {any} lock */ lock => lock.resourceId === resourceId)
  }

  return Object.freeze({
    /** Requester side; never waits for the holder.
     * @param {object} agent @param {string} resourceId */
    request(agent, resourceId) {
      if (closed) throw new Error('negotiation closed')
      const requester = executionFor(agent)
      const lock = lockOf(resourceId)
      if (!lock) throw new Error('file is not locked; acquire it instead')
      if (lock.owner === requester.sessionId) throw new Error('file is already owned by this session')
      const existing = [...requests.values()].find(request => request.state === 'pending'
        && request.resourceId === resourceId && request.requester.sessionId === requester.sessionId)
      if (existing) return { requestId: existing.requestId, state: 'pending', holder: lock.owner, holderStatus: lock.status }
      const session = control.status().sessions.find(/** @param {any} item */ item => item.sessionId === lock.owner)
      /** @type {Request} */
      const request = { requestId: `steal-${randomUUID()}`, resourceId, generation: lock.generation,
        holder: { sessionId: lock.owner, executionEpoch: session?.executionEpoch ?? 0 },
        requester: { ...requester }, state: 'pending', expiresAt: now() + timeoutMs }
      requests.set(request.requestId, request)
      request.timer = setTimeout(() => settle(request, 'expired',
        `Edit Lock request ${request.requestId} for ${resourceId} expired without a holder reply; ownership is unchanged.`), timeoutMs)
      request.timer.unref?.()
      // An interrupted holder is never woken; its request simply expires.
      if (session && !session.interrupted) {
        refresh(lock.owner)
        notify(lock.owner, `Edit Lock: session ${requester.sessionId} requests ownership of ${resourceId} (request ${request.requestId}). ` +
          `Call edit_lock_reply with this request_id and decision "release" to hand the file over, or "keep" to retain it. No reply keeps your ownership.`, true)
      }
      return { requestId: request.requestId, state: 'pending', holder: lock.owner, holderStatus: lock.status }
    },
    /** Holder side; the reply binds request, generation, holder and epoch.
     * @param {object} agent @param {string} requestId @param {'release'|'keep'} decision */
    async reply(agent, requestId, decision) {
      if (closed) throw new Error('negotiation closed')
      const request = requests.get(requestId)
      if (!request || request.state !== 'pending') throw new Error('request is not pending')
      const holder = executionFor(agent)
      if (holder.sessionId !== request.holder.sessionId || holder.executionEpoch !== request.holder.executionEpoch) {
        throw new Error('reply is not from the bound holder execution')
      }
      if (now() >= request.expiresAt) {
        settle(request, 'expired', `Edit Lock request ${requestId} expired; ownership is unchanged.`)
        throw new Error('request expired')
      }
      const lock = lockOf(request.resourceId)
      if (!lock || lock.owner !== holder.sessionId || lock.generation !== request.generation) {
        settle(request, 'stale', `Edit Lock request ${requestId} is stale: ownership of ${request.resourceId} changed.`)
        throw new Error('ownership changed since the request')
      }
      if (decision === 'keep') {
        settle(request, 'declined', `Edit Lock request ${requestId} declined: the holder keeps ${request.resourceId}.`)
        return { requestId, state: 'declined' }
      }
      if (decision !== 'release') throw new Error('decision must be "release" or "keep"')
      request.state = 'transferring'
      try {
        const token = await control.transfer({ ...holder, resourceId: request.resourceId, generation: request.generation }, request.requester)
        settle(request, 'transferred', `Edit Lock request ${requestId} granted: this session now owns ${request.resourceId} (generation ${token.generation}).`)
        return { requestId, state: 'transferred', generation: token.generation }
      } catch (error) {
        settle(request, 'failed', `Edit Lock request ${requestId} failed; ownership is unchanged: ${/** @type {any} */ (error)?.message ?? error}`)
        throw error
      }
    },
    /** @param {string} sessionId */
    pending(sessionId) { return pendingFor(sessionId).map(({ requestId, resourceId, requester, expiresAt }) => ({ requestId, resourceId, requester: requester.sessionId, expiresAt })) },
    close() {
      closed = true
      for (const request of requests.values()) if (request.timer) clearTimeout(request.timer)
    },
  })
}
