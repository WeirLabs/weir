// Synchronous per-identity replacement fence. The runtime phase is authoritative
// for admission; registry/mount joins are for inventory, never for reopening a
// closed replacement window early.
import { randomUUID } from 'node:crypto'

const OPEN = new Set(['mounted'])
const RESTORABLE = new Set(['mounted', 'registered', 'saved-degraded', 'unknown', 'cleanup-failed', 'cleanup-unknown'])
const clone = value => value == null ? value : structuredClone(value)

export function createMcpRuntime() {
  const states = new Map()

  function snapshot(identity) {
    const state = states.get(identity)
    return state ? clone(state) : { phase: 'unknown', generation: null, incarnation: null, operationId: null }
  }
  function begin(identity, { phase = 'replacing', generation = null, incarnation = null, operationId = randomUUID() } = {}) {
    const previous = states.get(identity) ?? null
    const token = { identity, operationId, previous }
    // This transition is deliberately synchronous and happens before the
    // caller's first registry/credential/probe await.
    states.set(identity, { phase, generation, incarnation, operationId })
    return token
  }
  function current(token) {
    return states.get(token.identity)?.operationId === token.operationId
  }
  function finish(token, phase, details = {}) {
    if (!current(token)) return false
    states.set(token.identity, {
      phase,
      generation: details.generation ?? states.get(token.identity).generation,
      incarnation: details.incarnation === undefined ? states.get(token.identity).incarnation : details.incarnation,
      operationId: token.operationId,
    })
    return true
  }
  function restore(token) {
    if (!current(token)) return false
    const previous = token.previous
    if (previous && RESTORABLE.has(previous.phase)) states.set(token.identity, previous)
    else states.set(token.identity, { phase: 'unknown', generation: null, incarnation: null, operationId: token.operationId })
    return true
  }
  function enabledFor(identity) {
    return OPEN.has(snapshot(identity).phase)
  }
  function registrationFor(identity) {
    const state = snapshot(identity)
    return enabledFor(identity)
      ? { identity, generation: state.generation, incarnation: state.incarnation, operationId: state.operationId }
      : null
  }
  function permit(identity, { generation, incarnation }) {
    const state = snapshot(identity)
    if (!enabledFor(identity) || state.generation !== generation || (state.incarnation ?? null) !== (incarnation ?? null)) return null
    return { identity, generation, incarnation: incarnation ?? null, operationId: state.operationId }
  }
  function assertPermit(value) {
    if (!value || typeof value !== 'object') return false
    const state = snapshot(value.identity)
    return enabledFor(value.identity)
      && state.operationId === value.operationId
      && state.generation === value.generation
      && (state.incarnation ?? null) === (value.incarnation ?? null)
  }
  return {
    begin, finish, restore, snapshot, enabledFor, registrationFor, permit, assertPermit,
    beforeRead: enabledFor,
    afterRead: enabledFor,
    states,
  }
}
