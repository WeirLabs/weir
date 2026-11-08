// Host-level typert remote for Decision read models and genuine user actions.
import { createDecisionRemoteService, decisionRemoteContribution, DECISION_REMOTE_METHODS, DECISION_REMOTE_NAMESPACE, DECISION_REMOTE_SERVICE_KEY } from './remote.js'

export function apply(ctx) {
  const typert = ctx.get?.('typert')
  if (!typert?.register) {
    ctx.logger?.warn?.('weir decision remote: typert is unavailable; Decision UI stays unavailable')
    return
  }
  const endpointsLive = () => {
    try { return DECISION_REMOTE_METHODS.every(method => Boolean(typert.local?.get?.(`${DECISION_REMOTE_NAMESPACE}/${method}`))) } catch { return false }
  }
  const ensureRegistered = () => {
    if (endpointsLive()) return true
    try { typert.register(decisionRemoteContribution()) } catch (error) {
      if (!endpointsLive()) {
        ctx.logger?.warn?.(`weir decision remote: registration failed (${error?.code ?? 'register failed'})`)
        return false
      }
    }
    return endpointsLive()
  }
  let service = ctx.get?.(DECISION_REMOTE_SERVICE_KEY)
  if (!service) {
    service = createDecisionRemoteService({ broker: () => ctx.get('weirDecisionBroker'), ensureRegistered })
    service.typertRemote = Object.freeze({ service, serviceKey: DECISION_REMOTE_SERVICE_KEY, namespace: DECISION_REMOTE_NAMESPACE })
    Object.freeze(service)
    ctx.root.reflect.provide(DECISION_REMOTE_SERVICE_KEY, service)
  }
  ensureRegistered()
  return service
}

export const name = 'weir-decision-remote'
export const inject = ['typert']
