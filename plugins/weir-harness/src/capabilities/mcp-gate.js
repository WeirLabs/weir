// Task 8.2/8.5 of the session-capability-manager change: the admission gate
// service the facades consume. The verdict for "is this managed server
// usable by this agent" combines, in order:
//   1. the registry's configured identity + current generation (8.1) — a
//      reconnect mounts a NEW generation and every old-generation handle is
//      rejected; a same-named DIFFERENT identity inherits nothing (8.5);
//   2. the session lifecycle snapshot: BLOCKED sessions refuse every managed
//      call (6.4); a dispose/reload window without an initialized snapshot
//      refuses too (8.5);
//   3. the session's accepted managed-MCP set (the selection record's
//      mcpServers): a server not in the set is not enabled for that agent.
// Connections stay shared at the host plane — a session losing a server
// never disposes anything (8.5).

/**
 * @param {{ registry: { read(): Promise<any> },
 *   lifecycle: { snapshotFor(sessionId: string): any },
 *   sessionMcpServers?: (sessionId: string) => string[] | null }} options
 */
export function createMcpGate({ registry, lifecycle, sessionMcpServers }) {
  const acceptedOf = sessionId => {
    if (typeof sessionMcpServers === 'function') return sessionMcpServers(sessionId)
    const snapshot = lifecycle.snapshotFor(sessionId)
    if (snapshot?.state !== 'ready') return null
    return snapshot.mcpServers
  }

  /**
   * The facade-side verdict for one call.
   * @param {unknown} agent @param {string} identity @param {number} generation
   * @returns {Promise<boolean>}
   */
  async function admit(agent, identity, generation) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    const snapshot = lifecycle.snapshotFor(sessionId)
    // BLOCKED (6.4) or no initialized snapshot (dispose/reload window, 8.5):
    // every managed call is refused, never an unrestricted pass.
    if (snapshot?.state !== 'ready') return false
    const accepted = acceptedOf(sessionId)
    if (!Array.isArray(accepted) || !accepted.includes(identity)) return false
    const current = await registry.read()
    if (current.kind !== 'ok') return false
    const entry = current.servers[identity]
    return Boolean(entry && entry.generation === generation)
  }

  /**
   * Instruction-section filtering (8.4): is the server in the session's
   * accepted set? At a subagent's creation the inherited capture is what the
   * child gets — the parent's accepted set VERBATIM at that moment — so when
   * the child's own snapshot is not visible yet (the creation-time
   * schema-hiding listener races the capture listener), the parent's
   * snapshot stands in. Call admission (admit) never uses this fallback: a
   * snapshot-less child is refused, never granted the parent's set.
   */
  function enabledFor(agent, identity) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    let snapshot = lifecycle.snapshotFor(sessionId)
    if (snapshot?.state !== 'ready') {
      const parentId = agent?.session?.header?.parentSession
      if (typeof parentId === 'string' && parentId.length > 0) snapshot = lifecycle.snapshotFor(parentId)
    }
    if (snapshot?.state !== 'ready') return false
    const accepted = snapshot.mcpServers
    return Array.isArray(accepted) && accepted.includes(identity)
  }

  return { admit, enabledFor }
}
