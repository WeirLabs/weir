// Transfer Negotiation owns the local reply window, not the broker request.
//
// One instance belongs to one plugin mount, matching the mount's conditional
// tool registrations. Process-wide request dedupe remains in the plugin: a
// sibling mount that did not deliver a request has no local window to close.
// The broker remains the only ownership and request-settlement authority.

/** @param {unknown} value @returns {string | undefined} */
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Whether one structured tool outcome closes its local request.
 *
 * `transferred` and `declined` are broker settlements; `expired` and `stale`
 * say the broker request is already over; `not-holder` closes only this
 * unauthorized agent's local window. A transport result contains no broker
 * verdict, so a valid pending request survives for an idempotent retry.
 * Unknown results and failures retain the old finally-block behaviour and
 * close the local request rather than inventing a new retry contract.
 *
 * @param {any} outcome a reply result or thrown error carrying state/code
 * @returns {boolean}
 */
function closesLocalRequest(outcome) {
  const code = text(outcome?.code)
  const state = text(outcome?.state)
  if (code === 'transport') return false
  if (state === 'transferred' || state === 'declined') return true
  if (code === 'expired' || code === 'stale' || code === 'not-holder') return true
  return true
}

/**
 * Create the pending-request and reply-window state for one plugin mount.
 *
 * This module never calls the client. In particular, local `not-holder`
 * cleanup cannot consume the broker request, which remains answerable by the
 * real holder.
 */
export function createTransferNegotiation() {
  /** @type {WeakMap<object, Map<string, { path: string, from: any }>>} */
  const pendingByAgent = new WeakMap()

  return {
    /**
     * Add or refresh one request in an agent's local reply window.
     * @param {object} agent
     * @param {string} requestId
     * @param {{ path: string, from: any }} request
     */
    openRequest(agent, requestId, request) {
      let pending = pendingByAgent.get(agent)
      if (pending === undefined) {
        pending = new Map()
        pendingByAgent.set(agent, pending)
      }
      pending.set(requestId, request)
    },

    /**
     * Apply one reply attempt's structured outcome to its own request id.
     *
     * @param {object} agent
     * @param {unknown} requestId
     * @param {any} outcome reply result or thrown error
     * @returns {number | undefined} requests still pending, or undefined when
     * this agent has no local window (the adapter then has nothing to retire)
     */
    finishReply(agent, requestId, outcome) {
      const pending = pendingByAgent.get(agent)
      if (pending === undefined) return undefined
      const id = text(requestId)
      if (closesLocalRequest(outcome) && id !== undefined) pending.delete(id)
      if (pending.size === 0) pendingByAgent.delete(agent)
      return pending.size
    },

    /**
     * Close every local request for an agent. Turn end, disposal and unmount
     * call this independently of any broker outcome.
     * @param {object} agent
     */
    closeAgent(agent) {
      pendingByAgent.delete(agent)
    },
  }
}
