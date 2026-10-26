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

  async function permit(agent, identity, generation) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    if (runtime?.enabledFor && runtime.enabledFor(identity) === false) return null
    const snapshot = acceptedSnapshot(lifecycle, agent)
    if (!snapshot) return null
    const accepted = acceptedOf(sessionId)
    if (!Array.isArray(accepted) || !accepted.includes(identity)) return null
    if (runtime?.beforeRead && runtime.beforeRead(identity) === false) return null
    const current = await registry.read()
    if (current.kind !== 'ok') return null
    const entry = current.servers[identity]
    if (!entry || entry.generation !== generation || !mcpIncarnationMatches(snapshot, identity, entry)) return null
    if (runtime?.afterRead && runtime.afterRead(identity) === false) return null
    if (runtime?.permit) return runtime.permit(identity, { generation, incarnation: entry.incarnation ?? null })
    return { identity, generation, incarnation: entry.incarnation ?? null, operationId: null }
  }
  async function admit(agent, identity, generation) {
    return (await permit(agent, identity, generation)) !== null
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

  return { admit, permit, enabledFor, assertPermit: value => runtime?.assertPermit ? runtime.assertPermit(value) : Boolean(value) }
}
