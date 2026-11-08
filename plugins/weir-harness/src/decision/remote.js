// JSON-only remote face. Every method takes one bare args object; no agent lookup.
export const DECISION_REMOTE_NAMESPACE = 'weirDecision'
export const DECISION_REMOTE_SERVICE_KEY = 'weirDecisionRemote'
export const DECISION_REMOTE_METHODS = Object.freeze([
  'overview', 'agents', 'agent', 'records', 'record', 'inbox', 'metrics', 'caseForCall', 'caseForToolCall',
  'setSelector', 'decide', 'reassign', 'cancel', 'retry', 'feedback', 'correction', 'profileUpsert', 'profileSetState',
])
const CASE_MUTATIONS = new Set(['decide', 'reassign', 'cancel', 'retry', 'feedback', 'correction'])

/** @param {{broker:()=>any,ensureRegistered?:()=>boolean}} dependencies */
export function createDecisionRemoteService(dependencies) {
  const ensure = dependencies.ensureRegistered ?? (() => true)
  async function invoke(method, args) {
    try {
      if (!ensure()) return { ok: false, error: { code: 'CHANNEL_UNAVAILABLE', message: 'Decision remote is not registered' } }
      const broker = dependencies.broker()
      if (!broker || broker.status().available !== true) return { ok: false, error: { code: 'DECISION_UNAVAILABLE', message: broker?.status().reason ?? 'Decision Broker is unavailable' } }
      let value
      const needsContext = method === 'setSelector' || method === 'profileUpsert' || method === 'profileSetState' || CASE_MUTATIONS.has(method)
      const context = needsContext ? await broker.sessionContext(args.sessionId) : undefined
      if (method === 'setSelector') value = await broker.setSelector(context.rootSessionId, args.mode, args.agentId, context.workspaceKey)
      else if (method === 'profileSetState') value = await broker.profileSetState(args.agentId, args.state, context.workspaceKey)
      else if (method === 'profileUpsert') value = await broker.profileUpsert({ ...args, workspaceKey: context.workspaceKey })
      else if (CASE_MUTATIONS.has(method)) value = await broker[method]({ ...args, sessionId: context.rootSessionId, workspaceKey: context.workspaceKey })
      else value = await broker[method](args)
      return { ok: true, value: value === undefined ? null : value }
    } catch (error) {
      return { ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'DECISION_REMOTE_FAILED', message: String(error?.message ?? 'Decision remote failed').slice(0, 200) } }
    }
  }
  return Object.fromEntries(DECISION_REMOTE_METHODS.map(method => [method, args => invoke(method, args ?? {})]))
}

/** Hand-written src-json contribution with no scope or agent-lookup parameter. */
export function decisionRemoteContribution() {
  return {
    package: 'weir-decision', face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: DECISION_REMOTE_METHODS.map(method => ({
      id: `weir-decision.${DECISION_REMOTE_NAMESPACE}.${method}`,
      service: DECISION_REMOTE_SERVICE_KEY,
      namespace: DECISION_REMOTE_NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }],
      result: { mode: 'src-json' },
    })),
  }
}
