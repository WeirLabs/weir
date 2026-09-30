import { describe, expect, it } from './helpers.js'
import {
  ESCALATION_TARGETS,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  probeEscalation,
  resolveCallPolicy,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
} from '../src/hashline-edit/sandbox.js'

describe('escalation vocabulary', () => {
  it('advertises the closed two-target vocabulary', () => {
    expect(ESCALATION_TARGETS).toEqual(['workspace-write', 'danger-full-access'])
    expect(WIDER_MODES).toEqual({
      'read-only': ['workspace-write', 'danger-full-access'],
      'workspace-write': ['danger-full-access'],
    })
  })

  it('pins the denial marker, hint, and description texts verbatim', () => {
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write mode]')
    expect(escalationHintMarker('operation')).toBe(
      '[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
    )
    expect(sandboxPermissionsDescription('operation')).toBe(
      'The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.',
    )
  })
})

describe('validateEscalationArgs', () => {
  it('rejects a permission without a justification', () => {
    expect(() => validateEscalationArgs('workspace-write', undefined)).toThrow(
      /sandbox_permissions requires a justification/,
    )
  })

  it('rejects a justification without a permission', () => {
    expect(() => validateEscalationArgs(undefined, 'because')).toThrow(
      /justification is only valid together with sandbox_permissions/,
    )
  })

  it('rejects an empty justification', () => {
    expect(() => validateEscalationArgs('workspace-write', '   ')).toThrow(/expected a non-empty sentence/)
  })

  it('accepts a well-formed pair and the absent pair', () => {
    validateEscalationArgs('danger-full-access', 'needs it') // throws = failure
    validateEscalationArgs(undefined, undefined) // throws = failure
  })
})

describe('approveEscalation', () => {
  const approvalOf = (outcomes) => {
    const requests = []
    return {
      requests,
      approval: {
        approver: { request: async (req) => { requests.push(req); return outcomes.shift() } },
        agent: { id: 'agent-1' },
        toolName: 'hash_edit',
        callId: 'call-1',
      },
    }
  }

  const request = (mode, effective = 'workspace-write') => ({
    requestedMode: mode,
    effectiveMode: effective,
    justification: 'the report needs to land outside the workspace',
    subject: 'operation',
  })

  it('returns the effective mode without approval when repeating it', async () => {
    const { approval, requests } = approvalOf(['allowed-once'])
    const granted = await approveEscalation(request('workspace-write'), approval)
    expect(granted).toBe('workspace-write')
    expect(requests).toHaveLength(0)
  })

  it('grants the strictly wider mode on allowed-once and shapes the ask', async () => {
    const { approval, requests } = approvalOf(['allowed-once'])
    const granted = await approveEscalation(request('danger-full-access'), approval)
    expect(granted).toBe('danger-full-access')
    expect(requests).toHaveLength(1)
    expect(requests[0].agent).toEqual({ id: 'agent-1' })
    expect(requests[0].toolName).toBe('hash_edit')
    expect(requests[0].callId).toBe('call-1')
    expect(requests[0].reason).toContain('escalate sandbox to danger-full-access')
    expect(requests[0].displayReason.en).toContain('danger-full-access')
    expect(requests[0].displayReason.zh).toContain('danger-full-access')
  })

  it('covers the full wider ladder from read-only', async () => {
    for (const target of ['workspace-write', 'danger-full-access']) {
      const { approval } = approvalOf(['allowed-once'])
      expect(await approveEscalation(request(target, 'read-only'), approval)).toBe(target)
    }
  })

  it('rejects narrower and unknown targets before any approval', async () => {
    const { approval, requests } = approvalOf([])
    await expect(async () => approveEscalation(request('workspace-write', 'danger-full-access'), approval)).rejects
      .toThrow(/not strictly wider/)
    await expect(async () => approveEscalation(request('sideways', 'workspace-write'), approval)).rejects
      .toThrow(/not strictly wider/)
    expect(requests).toHaveLength(0)
  })

  it('fails closed when no approval service or agent exists', async () => {
    await expect(async () => approveEscalation(request('danger-full-access'), { approver: undefined, agent: {}, toolName: 'hash_edit' })).rejects
      .toThrow(/no approval service is composed/)
    await expect(async () => approveEscalation(request('danger-full-access'), { approver: { request: async () => 'allowed-once' }, agent: undefined, toolName: 'hash_edit' })).rejects
      .toThrow(/no agent to route it through/)
  })

  it('maps rejected, cancelled, and unavailable outcomes to fail-closed errors', async () => {
    await expect(async () => approveEscalation(request('danger-full-access'), approvalOf(['rejected']).approval)).rejects
      .toThrow(/user rejected escalating this operation/)
    await expect(async () => approveEscalation(request('danger-full-access'), approvalOf(['cancelled']).approval)).rejects
      .toThrow(/was cancelled/)
    await expect(async () => approveEscalation(request('danger-full-access'), approvalOf(['unavailable']).approval)).rejects
      .toThrow(/no approval channel is available/)
  })

  it('rejects unknown outcome tokens instead of granting', async () => {
    await expect(async () => approveEscalation(request('danger-full-access'), approvalOf(['allowed-forever']).approval)).rejects
      .toThrow(/unexpected approval outcome/)
  })
})

describe('probeEscalation', () => {
  it('returns null when the backend exposes no sandboxMode', () => {
    expect(probeEscalation(undefined)).toBe(null)
    expect(probeEscalation({})).toBe(null)
  })

  it('advertises the modes and schema fields under a confining backend', () => {
    const probe = probeEscalation({ sandboxMode: 'workspace-write' })
    expect(probe.modes).toEqual(ESCALATION_TARGETS)
    expect(probe.fields.sandbox_permissions).toEqual({
      type: 'string',
      enum: ['workspace-write', 'danger-full-access'],
      description: 'The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.',
    })
    expect(probe.fields.justification).toEqual({
      type: 'string',
      description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access. Use the language of the user’s current request.',
    })
  })
})

describe('resolveCallPolicy', () => {
  const session = { id: 'session-1' }
  const standing = { mode: 'workspace-write', workspaceRoot: '/ws', sessionId: 's1' }

  // Plain arg/env fakes: no filesystem, no ctx. `requests` counts approval
  // asks, `resolveCalls` pins the standing-resolve input shape.
  const envOf = (overrides = {}) => {
    const requests = []
    const resolveCalls = []
    const env = {
      escalation: probeEscalation({ sandboxMode: 'workspace-write' }),
      sandboxPolicy: {
        resolve: (req) => {
          resolveCalls.push(req)
          return standing
        },
      },
      session,
      sessionCwd: '/session-cwd',
      approval: {
        approver: { request: async (req) => { requests.push(req); return 'allowed-once' } },
        agent: { id: 'agent-1' },
        toolName: 'hash_edit',
        callId: 'call-1',
      },
      ...overrides,
    }
    return { env, requests, resolveCalls }
  }

  it('throws the pairing errors verbatim before any approval request', async () => {
    const { env, requests } = envOf()
    await expect(async () => resolveCallPolicy({ sandbox_permissions: 'danger-full-access' }, env)).rejects
      .toThrow(/sandbox_permissions requires a justification/)
    await expect(async () => resolveCallPolicy({ justification: 'because' }, env)).rejects
      .toThrow(/justification is only valid together with sandbox_permissions/)
    await expect(async () => resolveCallPolicy({ sandbox_permissions: 'danger-full-access', justification: '   ' }, env)).rejects
      .toThrow(/expected a non-empty sentence/)
    expect(requests).toHaveLength(0)
  })

  it('returns the standing policy by reference when no escalation args are present', async () => {
    const { env, requests, resolveCalls } = envOf()
    const result = await resolveCallPolicy({ file_path: '/ws/a.js', edits: [] }, env)
    expect(result.policy).toBe(standing)
    expect(result.resolveCwd).toBe('/ws')
    expect(result.advertisedFields).toBe(env.escalation.fields)
    expect(requests).toHaveLength(0)
    expect(resolveCalls).toEqual([{ session }])
  })

  it('derives resolveCwd from the session cwd when no standing policy resolves', async () => {
    const { env } = envOf({ sandboxPolicy: undefined })
    const result = await resolveCallPolicy({}, env)
    expect(result.policy).toBeUndefined()
    expect(result.resolveCwd).toBe('/session-cwd')
  })

  it('repeats the effective mode without an approval request', async () => {
    const { env, requests } = envOf()
    const result = await resolveCallPolicy(
      { sandbox_permissions: 'workspace-write', justification: 'still inside the workspace' },
      env,
    )
    expect(requests).toHaveLength(0)
    expect(result.policy).toEqual({ mode: 'workspace-write', workspaceRoot: '/ws', sessionId: 's1' })
    expect(result.resolveCwd).toBe('/ws')
  })

  it('merges the granted mode over the standing policy on a strictly wider grant', async () => {
    const { env, requests } = envOf()
    const result = await resolveCallPolicy(
      { sandbox_permissions: 'danger-full-access', justification: 'the report must land outside the workspace' },
      env,
    )
    expect(requests).toHaveLength(1)
    expect(result.policy).toEqual({ mode: 'danger-full-access', workspaceRoot: '/ws', sessionId: 's1' })
  })

  it('gates escalation before the approval ask when no sandboxing filesystem exists', async () => {
    const { env, requests } = envOf({ escalation: null })
    await expect(async () =>
      resolveCallPolicy({ sandbox_permissions: 'danger-full-access', justification: 'needs it' }, env),
    ).rejects.toThrow(/no sandboxing filesystem to escalate/)
    expect(requests).toHaveLength(0)
  })

  it('advertises no fields when the capability is absent', async () => {
    const { env } = envOf({ escalation: null })
    const result = await resolveCallPolicy({}, env)
    expect(result.advertisedFields).toEqual({})
  })

  it('passes the approval failure outcomes through unchanged', async () => {
    for (const [outcome, pattern] of [
      ['rejected', /user rejected escalating this operation/],
      ['cancelled', /was cancelled/],
      ['unavailable', /no approval channel is available/],
      ['allowed-forever', /unexpected approval outcome/],
    ]) {
      const { env } = envOf({
        approval: { approver: { request: async () => outcome }, agent: { id: 'agent-1' }, toolName: 'hash_edit' },
      })
      await expect(async () =>
        resolveCallPolicy({ sandbox_permissions: 'danger-full-access', justification: 'needs it' }, env),
      ).rejects.toThrow(pattern)
    }
  })
})
