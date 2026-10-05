// Task 8.6 of the session-capability-manager change: the admission fence and
// drain for managed MCP calls. Each (agent, server) pair keeps an in-flight
// count. When an Apply accepts a removal, the gate CLOSES first — new calls
// (including queued ones and calls generated from a stale schema) are
// rejected immediately — then already-admitted in-flight calls are waited
// out. The drain has a timeout; after it only "still in flight" (with the
// count and the call list) is reported. There is NO forced cancellation and
// external side effects are never claimed as undone (1.8 was only a
// partial pass; the forced-abort variant of 8.7 stays unimplemented).

/**
 * @param {{ timeoutMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function createMcpDrain({ timeoutMs = 30_000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  /** @type {Map<string, { count: number, calls: Map<number, string>, closed: boolean }>} */
  const flights = new Map()
  let sequence = 0

  const keyOf = (agentId, server) => `${agentId ?? 'unknown'}${server}`
  const stateOf = (agentId, server) => {
    const key = keyOf(agentId, server)
    if (!flights.has(key)) flights.set(key, { count: 0, calls: new Map(), closed: false })
    return flights.get(key)
  }

  /**
   * Fence check at the wrapper's head (8.3 runs this before admit): a closed
   * gate rejects immediately — no new call enters flight after the removal
   * was accepted, however it was generated.
   */
  function enter(agentId, server, label = 'call') {
    const state = stateOf(agentId, server)
    if (state.closed) return null
    sequence += 1
    state.count += 1
    state.calls.set(sequence, label)
    return sequence
  }

  function exit(agentId, server, token) {
    if (token == null) return
    const state = stateOf(agentId, server)
    if (state.calls.delete(token)) state.count = Math.max(0, state.count - 1)
  }

  /** Close the gate for one (agent, server); existing flights continue. */
  function close(agentId, server) {
    stateOf(agentId, server).closed = true
  }

  /**
   * Wait for the in-flight calls of one (agent, server) to finish.
   * @returns {Promise<{ drained: true, waitedMs: number } | { drained: false, inFlight: number, calls: string[], waitedMs: number }>}
   */
  async function drain(agentId, server) {
    const state = stateOf(agentId, server)
    const started = now()
    while (state.count > 0 && now() - started < timeoutMs) {
      await sleep(Math.min(50, timeoutMs))
    }
    if (state.count === 0) return { drained: true, waitedMs: now() - started }
    return { drained: false, inFlight: state.count, calls: [...state.calls.values()], waitedMs: now() - started }
  }

  /** The Apply-time snapshot the response carries (sent at response time). */
  function snapshot(agentId, server) {
    const state = stateOf(agentId, server)
    return { server, state: state.count === 0 ? 'settled' : 'draining', inFlight: state.count }
  }

  return { enter, exit, close, drain, snapshot }
}
