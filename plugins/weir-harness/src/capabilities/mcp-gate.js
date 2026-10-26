// Managed MCP admission combines runtime registration generation/incarnation,
// the accepted lifecycle selection, and (when mounted) the per-identity runtime
// phase. Legacy compatibility exists only when BOTH sides lack incarnations.

export function mcpIncarnationMatches(snapshot, identity, entry) {
  if (!entry) return false
  const mapping = snapshot?.mcpIncarnations
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    if (!Object.hasOwn(mapping, identity)) return false
    return mapping[identity] === (entry.incarnation ?? null)
  }
  // A legacy selection without a mapping remains valid only for a legacy entry.
  return entry.incarnation == null
}

function acceptedSnapshot(lifecycle, agent, { parentFallback = false } = {}) {
  const sessionId = agent?.session?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  let snapshot = lifecycle.snapshotFor(sessionId)
  if (snapshot == null && parentFallback) {
    const parentId = agent?.session?.header?.parentSession
    if (typeof parentId === 'string' && parentId.length > 0) snapshot = lifecycle.snapshotFor(parentId)
  }
  return snapshot?.state === 'ready' ? snapshot : null
}

export function createMcpGate({ registry, lifecycle, sessionMcpServers, registrationFor, runtime }) {
  const acceptedOf = sessionId => {
    if (typeof sessionMcpServers === 'function') return sessionMcpServers(sessionId)
    const snapshot = lifecycle.snapshotFor(sessionId)
    if (snapshot?.state !== 'ready') return null
    return snapshot.mcpServers
  }

  async function admit(agent, identity, generation) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    if (runtime?.enabledFor && runtime.enabledFor(identity) === false) return false
    const snapshot = acceptedSnapshot(lifecycle, agent)
    if (!snapshot) return false
    const accepted = acceptedOf(sessionId)
    if (!Array.isArray(accepted) || !accepted.includes(identity)) return false
    if (runtime?.beforeRead && runtime.beforeRead(identity) === false) return false
    const current = await registry.read()
    if (current.kind !== 'ok') return false
    const entry = current.servers[identity]
    if (!entry || entry.generation !== generation || !mcpIncarnationMatches(snapshot, identity, entry)) return false
    if (runtime?.afterRead && runtime.afterRead(identity) === false) return false
    return true
  }

  function enabledFor(agent, identity) {
    if (runtime?.enabledFor && runtime.enabledFor(identity) === false) return false
    const snapshot = acceptedSnapshot(lifecycle, agent, { parentFallback: true })
    if (!snapshot || !Array.isArray(snapshot.mcpServers) || !snapshot.mcpServers.includes(identity)) return false
    if (typeof registrationFor !== 'function') {
      // Pure legacy tests without a runtime registry still get mapping-shape
      // enforcement; production always supplies registrationFor below.
      const mapping = snapshot.mcpIncarnations
      return !(mapping && typeof mapping === 'object' && !Array.isArray(mapping) && !Object.hasOwn(mapping, identity))
    }
    return mcpIncarnationMatches(snapshot, identity, registrationFor(identity))
  }

  return { admit, enabledFor }
}
