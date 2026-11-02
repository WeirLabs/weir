import { orderState, record, snapshotSummary } from './capability-lifecycle-dual-state.js'

export const name = 'capability-lifecycle-manager-observer'
export const inject = ['weirMcpManager']

export function apply(ctx, config = {}) {
  const { orderId, presetId } = config
  const manager = ctx.get('weirMcpManager')
  if (!manager) throw new Error(`real manager face did not mount for ${presetId}`)
  const state = orderState(orderId)
  state.managers.set(presetId, manager)
  const start = manager.start
  manager.start = (...args) => {
    const pending = Promise.resolve(start.apply(manager, args))
    state.managerStarts.set(presetId, pending)
    return pending
  }
  const syncSession = manager.syncSession
  manager.syncSession = sessionId => {
    record(orderId, 'manager-sync', {
      presetId,
      sessionId,
      snapshot: snapshotSummary(state.selections.get(presetId)?.lifecycle.peek(sessionId)),
    })
    return syncSession.call(manager, sessionId)
  }
  record(orderId, 'manager-mounted', {
    presetId,
    managerTag: `${orderId}:${presetId}`,
    faceType: typeof manager,
    hasGate: typeof manager.gate?.enabledFor === 'function' && typeof manager.gate?.permit === 'function',
  })
}
