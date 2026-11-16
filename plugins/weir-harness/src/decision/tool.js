// decision_consult: one explicit, evidence-gated consultation without polling.
export const DECISION_CONSULT_PARAMETERS = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The concrete judgment to evaluate.' },
    detail: { type: 'string', description: 'Optional clarification shown with the question.' },
    header: { type: 'string', description: 'Optional short question heading.' },
    options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] }, description: 'Allowed answer labels; omit for a custom text answer.' },
    multi_select: { type: 'boolean', description: 'Whether the answer may select multiple labels.' },
    scope: { type: 'object', properties: {
      workspaces: { type: 'array', items: { type: 'string' } },
      paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative path prefixes.' },
      tags: { type: 'array', items: { type: 'string' } },
    } },
    context: { type: 'string', description: 'Bounded task summary; never paste a full session log.' },
    evidence: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, excerpt_hint: { type: 'string' } }, required: ['path'] }, description: 'Files to re-read as current evidence.' },
    agent_id: { type: 'string', description: 'Optional enabled Decision Agent for this consultation only; does not change the session selector.' },
    request_id: { type: 'string', description: 'Optional idempotency key supplied by the caller.' },
  },
  required: ['question'],
}

/** @param {any} ctx */
export function registerDecisionConsultTool(ctx) {
  return ctx.tools.register({
    name: 'decision_consult',
    description: 'Consult the selected or explicitly named Decision Agent once. Returns answered with evidence and record pins, returned with a repairable reason, or awaiting_user with a persistent caseId. Answers never grant execution or approval authority; do not poll for user decisions.',
    parameters: DECISION_CONSULT_PARAMETERS,
    output: {
      schema: { type: 'object' },
      render: (_args, result) => [{ type: 'text', text: result.message }],
    },
    async execute(args, exec) {
      const broker = ctx.get('weirDecisionBroker')
      if (!broker || broker.status().available !== true) throw new Error(`decision_consult: ${broker?.status().reason ?? 'Decision Broker is unavailable'}`)
      const result = await broker.consult({ agent: exec.agent, args, signal: exec.signal, toolCallId: exec.toolCallId ?? exec.callId ?? exec.id })
      // The Host tool boundary rejects undefined anywhere in the returned value.
      // EvidenceRef and pins intentionally model absent optional fields that way.
      const value = JSON.parse(JSON.stringify(result))
      const summary = value.outcome === 'answered'
        ? `Decision ${value.caseId} answered with ${value.evidence?.length ?? 0} evidence reference(s).`
        : value.outcome === 'returned'
          ? `Decision ${value.caseId} returned ${value.code}: ${value.hint}`
          : `Decision ${value.caseId} is awaiting user judgment; retrieve it later by caseId without polling.`
      return { ...value, message: `${JSON.stringify(value)}\n${summary}` }
    },
  })
}
