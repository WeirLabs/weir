const orders = new Map()

export function beginOrder(orderId, order) {
  const state = {
    orderId,
    order,
    phase: 'mount',
    managers: new Map(),
    managerStarts: new Map(),
    selections: new Map(),
    lifecycleTags: new Map(),
    events: [],
    applySelectionCalls: 0,
  }
  orders.set(orderId, state)
  return state
}

export function orderState(orderId) {
  const state = orders.get(orderId)
  if (!state) throw new Error(`lifecycle probe order is not initialized: ${orderId}`)
  return state
}

export function setPhase(orderId, phase) {
  orderState(orderId).phase = phase
}

export function record(orderId, kind, data = {}) {
  const state = orderState(orderId)
  state.events.push({ seq: state.events.length + 1, time: Date.now(), phase: state.phase, kind, ...data })
}

export function snapshotSummary(snapshot) {
  if (snapshot == null) return null
  return {
    state: snapshot.state ?? null,
    sessionId: snapshot.sessionId ?? null,
    revision: snapshot.revision ?? null,
    reason: snapshot.reason ?? null,
    skillCount: Array.isArray(snapshot.skills) ? snapshot.skills.length : null,
    mcpServers: Array.isArray(snapshot.mcpServers) ? [...snapshot.mcpServers] : null,
    mcpIncarnations: snapshot.mcpIncarnations ? { ...snapshot.mcpIncarnations } : null,
    captured: snapshot.captured ? { ...snapshot.captured } : null,
  }
}
