// Orrery's self-contained sandbox-escalation vocabulary and choreography.
// Mirrors @deepseek-ai/dsh-sandbox — which the link-bundle red line forbids
// importing — so the `hash_edit` tool escalates exactly like the stock
// `write`/`edit`/`bash` tools: same field vocabulary, same strictly-wider
// ladder, same approval ordering, same model-facing denial markers. All
// texts are copied verbatim from the host package and pinned by unit tests.

/** The closed escalation-target vocabulary advertised on a confining backend. */
export const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']

/**
 * The strictly-wider table: what a call whose effective mode is the key may
 * escalate TO. Checked at EXECUTION, never baked into the tool schema.
 */
export const WIDER_MODES = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * Validate the escalation argument pairing a tool schema cannot express:
 * `sandbox_permissions` and `justification` travel together, and the
 * justification must be a non-empty sentence.
 */
export function validateEscalationArgs(sandboxPermissions, justification) {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

/** The model-facing denial marker, exactly as the stock tools report it. */
export function sandboxDenialMarker(mode) {
  return `[sandbox: file access denied under ${mode} mode]`
}

/** The same-turn escalation hint that rides a denial when escalation is advertised. */
export function escalationHintMarker(subject) {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/** The model-facing `sandbox_permissions` parameter description. */
export function sandboxPermissionsDescription(subject) {
  return `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.`
}

/**
 * Probe the composed filesystem's escalation capability once at registration.
 * A confining backend exposes `fs.sandboxMode`; anything else means the
 * composition has no sandbox to escalate, so the escalation fields stay
 * unadvertised. The returned `fields` drop straight into the tool schema.
 * @param fs - the host filesystem service reference (may be undefined)
 * @param subject - mirror vocabulary for the field descriptions
 * @returns null, or { modes, fields } for the schema and the runtime gate
 */
export function probeEscalation(fs, subject = 'operation') {
  if (fs?.sandboxMode === undefined) return null
  return {
    modes: ESCALATION_TARGETS,
    fields: {
      sandbox_permissions: {
        type: 'string',
        enum: [...ESCALATION_TARGETS],
        description: sandboxPermissionsDescription(subject),
      },
      justification: {
        type: 'string',
        description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access. Use the language of the user’s current request.',
      },
    },
  }
}
/**
 * Resolve a sandbox permission request before execution. Repeating the call's
 * effective mode returns it without approval. A strictly wider mode requires
 * approval and applies only to this call. Narrower or unsupported targets,
 * missing approval services or agents for widening, and non-grant outcomes
 * throw before execution.
 * @param request - { requestedMode, effectiveMode, justification, subject }
 * @param approval - { approver, agent, toolName, callId?, signal? }
 * @returns the granted mode, consumed by the one call that asked.
 */
export async function approveEscalation(request, approval) {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  if (mode === effectiveMode) return effectiveMode
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  }
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    ...(approval.callId !== undefined ? { callId: approval.callId } : {}),
    reason: `escalate sandbox to ${mode}: ${justification}`,
    displayReason: {
      en: `Allow this operation with ${mode} permissions: ${justification}`,
      zh: `允许本次操作使用 ${mode} 权限：${justification}`,
    },
    ...(approval.signal ? { signal: approval.signal } : {}),
  })
  switch (outcome) {
    case 'allowed-once':
      return mode
    case 'rejected':
      throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`)
    case 'cancelled':
      throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case 'unavailable':
      throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default:
      throw new Error(`unexpected approval outcome: ${String(outcome)}`)
  }
}
/**
 * Resolve the policy for one whole tool call, mirroring the stock tools'
 * resolvePolicy ordering exactly: standing policy first (S23, computed per
 * call), then the escalation pairing validation, then the no-capability
 * gate, then the approval ask, then the one-shot merge. A same-mode repeat
 * rides the standing policy without asking; a strictly wider grant widens
 * THIS call only. ctx-free by construction so unit tests drive it with
 * plain fakes.
 * @param args - raw tool arguments (only sandbox_permissions / justification are read)
 * @param env - { escalation, sandboxPolicy, session, sessionCwd, approval: { approver, agent, toolName, callId?, signal? }, subject? }
 * @returns {Promise<{ policy: any, resolveCwd: Function, advertisedFields: any }>}
 */
export async function resolveCallPolicy(args, env) {
  const standingPolicy = env.sandboxPolicy?.resolve({ session: env.session })
  validateEscalationArgs(args.sandbox_permissions, args.justification)
  let policy = standingPolicy
  if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
    if (env.escalation === null) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)')
    }
    const granted = await approveEscalation(
      {
        requestedMode: args.sandbox_permissions,
        effectiveMode: standingPolicy?.mode,
        justification: args.justification,
        subject: env.subject ?? 'operation',
      },
      env.approval,
    )
    policy = { ...(standingPolicy ?? {}), mode: granted }
  }
  const resolveCwd = policy?.workspaceRoot ?? env.sessionCwd
  return { policy, resolveCwd, advertisedFields: env.escalation?.fields ?? {} }
}
