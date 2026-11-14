// JSON-only remote face. Every method takes one bare args object; no agent lookup
// and no caller-supplied workspace or Agent ownership override.
export const DECISION_REMOTE_NAMESPACE = 'weirDecision'
export const DECISION_REMOTE_SERVICE_KEY = 'weirDecisionRemote'
export const DECISION_REMOTE_METHODS = Object.freeze([
  'overview', 'agents', 'agent', 'records', 'record', 'inbox', 'metrics', 'routingReview', 'caseForCall', 'caseForToolCall', 'waitForToolCall',
  'setSelector', 'decide', 'reassign', 'cancel', 'retry', 'feedback', 'correction', 'returnToCaller', 'clarify', 'profileUpsert', 'profileSetState', 'profileDeletePreview', 'profileDelete',
  'learningStart', 'learningRun', 'snapshotPublish', 'snapshotReject', 'snapshotRollback', 'memorySnapshot',
  'publicMemoryRefresh', 'publicCandidate', 'exportData',
])
const CASE_MUTATIONS = new Set(['decide', 'reassign', 'cancel', 'retry', 'feedback', 'correction', 'returnToCaller', 'clarify'])
const LEARNING_MUTATIONS = new Set(['learningStart', 'snapshotPublish', 'snapshotReject', 'snapshotRollback'])
const PUBLIC_MEMORY_METHODS = new Set(['publicMemoryRefresh', 'publicCandidate'])
// The export forwards one caller value, its session: the Host derives the root
// session, the workspace and the file location, so no field can widen the scope.
const EXPORT_METHODS = new Set(['exportData'])

/**
 * Public-memory calls cross workspaces, so a caller may name only its own
 * session, the assistant and an optional review target. The root session, the
 * invoking workspace and every source stay server-derived: a caller-named
 * workspace, zone or ownership field is dropped before the Broker sees it.
 * @param {any} args
 */
export function publicMemoryArgs(args) {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const input = {}
  for (const key of ['sessionId', 'agentId', 'learningRunId']) {
    if (typeof value[key] === 'string') input[key] = value[key]
  }
  // Both flags are user gestures, so only the literal `true` counts.
  if (value.acknowledgedDisclosure === true) input.acknowledgedDisclosure = true
  if (value.retryFailedExtraction === true) input.retryFailedExtraction = true
  return input
}

/** @param {{broker:()=>any,ensureRegistered?:()=>boolean}} dependencies */
export function createDecisionRemoteService(dependencies) {
  const ensure = dependencies.ensureRegistered ?? (() => true)
  async function invoke(method, args, signal) {
    try {
      if (!ensure()) return { ok: false, error: { code: 'CHANNEL_UNAVAILABLE', message: 'Decision remote is not registered' } }
      const broker = dependencies.broker()
      const status = broker?.status()
      if (!broker || (status.available !== true && !(method === 'overview' && status.reason === 'disabled'))) return { ok: false, error: { code: 'DECISION_UNAVAILABLE', message: status?.reason ?? 'Decision Broker is unavailable' } }
      let value
      const needsContext = method === 'routingReview' || method === 'setSelector' || method === 'profileUpsert' || method === 'profileSetState' || method === 'profileDelete' || CASE_MUTATIONS.has(method) || LEARNING_MUTATIONS.has(method) || EXPORT_METHODS.has(method)
      const context = needsContext ? await broker.sessionContext(args.sessionId) : undefined
      // Identity calls take no workspace: the caller cannot name one, and the
      // profile-global identity must not depend on where the call came from.
      if (method === 'setSelector') value = await broker.setSelector(context.rootSessionId, args.mode, args.agentId)
      else if (method === 'profileSetState') value = await broker.profileSetState(args.agentId, args.state)
      // Delete calls forward only the two caller-owned fields; everything else
      // about the cascade is derived server-side.
      else if (method === 'profileDelete') value = await broker.profileDelete({ agentId: args.agentId, expectedCases: args.expectedCases })
      else if (method === 'profileDeletePreview') value = await broker.profileDeletePreview({ agentId: args.agentId })
      else if (method === 'profileUpsert') value = await broker.profileUpsert(args)
      else if (method === 'routingReview') value = await broker.routingReview({ ...args, sessionId: context.rootSessionId, workspaceKey: context.workspaceKey })
      else if (CASE_MUTATIONS.has(method) || LEARNING_MUTATIONS.has(method)) value = await broker[method]({ ...args, sessionId: context.rootSessionId, workspaceKey: context.workspaceKey })
      else if (PUBLIC_MEMORY_METHODS.has(method)) value = await broker[method](publicMemoryArgs(args))
      else if (EXPORT_METHODS.has(method)) value = await broker[method]({ sessionId: context.rootSessionId })
      else if (method === 'waitForToolCall') value = await broker[method](args, signal)
      else value = await broker[method](args)
      return { ok: true, value: value === undefined ? null : value }
    } catch (error) {
      return { ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'DECISION_REMOTE_FAILED', message: String(error?.message ?? 'Decision remote failed').slice(0, 200) } }
    }
  }
  return Object.fromEntries(DECISION_REMOTE_METHODS.map(method => [method, (args, signal) => invoke(method, args ?? {}, signal)]))
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
      ...(method === 'waitForToolCall' ? { cancellation: { parameter: 'signal' } } : {}),
      result: { mode: 'src-json' },
    })),
  }
}
