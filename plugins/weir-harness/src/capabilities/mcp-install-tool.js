// Primary-Orchestrator MCP installation. Preview is inert; install executes only
// the Host-stored plan approved through userQuestions, never post-answer model input.
import { createHash } from 'node:crypto'
import { parseMcpDocument, fingerprintMcpEntry } from './mcp-config.js'
import { mcpDiagnostic, sanitizeMcpPayload } from './mcp-diagnostics.js'

export const MCP_INSTALL_TOOL_NAME = 'mcp_install'
export const MCP_INSTALL_APPROVE_LABEL = 'Install MCP server'
export const MCP_INSTALL_CANCEL_LABEL = 'Cancel'
export const MCP_INSTALL_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000

const CREDENTIAL_REF = {
  type: 'object',
  properties: {
    ref: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', description: 'Existing DSH credential reference.' },
    prefix: { type: 'string', description: 'Optional non-secret prefix, such as Bearer .' },
  },
  required: ['ref'], additionalProperties: false,
}
const REF_MAP = { type: 'object', additionalProperties: CREDENTIAL_REF }
const RECONNECT = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    initialDelayMs: { type: 'number', exclusiveMinimum: 0 },
    maxDelayMs: { type: 'number', exclusiveMinimum: 0 },
    maxAttempts: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

export const MCP_INSTALL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string', enum: ['preview', 'install'],
      description: 'preview only validates and returns a redacted plan; install requests Host confirmation before any probe or write.',
    },
    plan: {
      type: 'object',
      description: 'One fresh MCP server. Use credential references for every environment/header/secret-argument value and for any URL with userinfo, query, or fragment.',
      properties: {
        identity: { type: 'string', description: 'Fresh stable logical identity; installation never edits or replaces an existing registration.' },
        label: { type: 'string' },
        transport: { type: 'string', enum: ['stdio', 'streamable-http'] },
        serverName: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' },
        command: { type: 'string', description: 'stdio executable; required for stdio and forbidden for HTTP.' },
        args: {
          type: 'array', maxItems: 128,
          description: 'Non-secret stdio arguments. Use a credential-reference object instead of a string for every sensitive argument.',
          items: { anyOf: [{ type: 'string' }, CREDENTIAL_REF] },
        },
        secretArgs: { type: 'object', description: 'Credential references keyed by sensitive argument index.', additionalProperties: CREDENTIAL_REF },
        env: { ...REF_MAP, description: 'stdio environment values as credential references; literal values are not accepted.' },
        cwd: { type: 'string' },
        url: {
          description: 'Non-sensitive absolute HTTP(S) URL, or a credential reference for any URL containing userinfo, query, or fragment.',
          anyOf: [{ type: 'string', pattern: '^https?://' }, CREDENTIAL_REF],
        },
        headers: { ...REF_MAP, description: 'HTTP header values as credential references; literal values are not accepted.' },
        toolCallTimeoutMs: { type: 'number', exclusiveMinimum: 0 },
        maxInstructionBytes: { type: 'integer', minimum: 1 },
        reconnect: RECONNECT,
      },
      required: ['identity', 'transport'], additionalProperties: false,
    },
  },
  required: ['action', 'plan'], additionalProperties: false,
}

function failure(status, code, message, extra = {}) {
  return {
    status, saved: false,
    error: mcpDiagnostic(new Error(message), { code, hint: code === 'DELEGATED_CALLER' ? 'Ask the parent Orchestrator to perform MCP setup.' : undefined }),
    ...extra,
  }
}

function delegated(agent) {
  return (agent?.session?.header?.delegationDepth ?? 0) >= 1
}

function delegatedResult() {
  return failure('unsupported', 'DELEGATED_CALLER', 'MCP installation belongs to the primary Orchestrator; delegate the setup request to the parent.', {
    next: { action: 'delegate-to-parent-orchestrator' },
  })
}

export function mcpInstallApproved(answer, questionId, approveLabel = MCP_INSTALL_APPROVE_LABEL) {
  if (!Array.isArray(answer?.answers) || answer.answers.length !== 1) return false
  const item = answer.answers[0]
  return item?.id === questionId && Array.isArray(item.selected) && item.selected.length === 1 && item.selected[0] === approveLabel && !item.custom
}

export function assertMcpInstallStoredPlan(stored) {
  const digest = createHash('sha256').update(JSON.stringify(stored?.plan)).digest('hex')
  if (digest !== stored?.digest || fingerprintMcpEntry(stored?.entry) !== stored?.entryFingerprint) {
    throw Object.assign(new Error('The stored MCP installation plan changed while confirmation was open'), { code: 'plan-changed' })
  }
  return true
}

function cancellation(execSignal, timeoutMs, setTimer, clearTimer) {
  const controller = new AbortController()
  const abort = () => controller.abort(execSignal?.reason)
  if (execSignal?.aborted) abort()
  else execSignal?.addEventListener?.('abort', abort, { once: true })
  const timer = setTimer(() => controller.abort(Object.assign(new Error('MCP installation confirmation timed out'), { code: 'confirmation-timeout' })), timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimer(timer)
      execSignal?.removeEventListener?.('abort', abort)
    },
  }
}

async function firstConfirmationSettlement(ask, signal) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }
    const aborted = () => finish({ kind: 'cancelled', cause: signal.reason })
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve().then(ask).then(
      value => finish({ kind: 'answer', value }),
      cause => finish({ kind: 'error', cause }),
    )
  })
}

function confirmationFailure(cause) {
  const code = cause?.code ?? 'confirmation-failed'
  if (code === 'NO_PROVIDER') return failure('unsupported', code, 'Host user confirmation is unavailable; MCP installation was not attempted.')
  if (code === 'DELEGATED_CALLER') return delegatedResult()
  if (code === 'CALLER_NOT_LIVE') return failure('owner-changed', code, 'The calling agent is no longer the exact live runtime root; MCP installation was not attempted.')
  return failure('cancelled', code, 'MCP installation confirmation was cancelled, closed, timed out, or failed; no probe or write occurred.')
}

function questionFor(stored, execution) {
  const entry = stored.entry
  const transport = entry.transport.kind
  const effect = transport === 'stdio'
    ? `Process effect: run ${execution?.requestedCommand ?? entry.client.command} and perform MCP discovery.${execution?.resolvedCommand ? `\nResolved executable: ${execution.resolvedCommand}` : ''}`
    : `Network effect: connect to ${entry.client.url ?? 'the credential-referenced endpoint'} and perform MCP discovery.`
  const detail = [
    `Plan digest: ${stored.digest}`,
    effect,
    'Default for new sessions: off. No session selection or Apply is changed.',
    `Exact redacted plan:\n${JSON.stringify(stored.plan, null, 2)}`,
  ].join('\n')
  return {
    id: 'mcp-install-confirmation',
    header: 'MCP server setup',
    question: `Install MCP server "${stored.identity}" with exactly this plan?`,
    detail,
    options: [
      { label: MCP_INSTALL_APPROVE_LABEL, description: 'Probe first; only a successful probe may register and strictly mount this server.' },
      { label: MCP_INSTALL_CANCEL_LABEL, description: 'Do not probe, write credentials or registry records, or change selection.' },
    ],
    multiSelect: false,
  }
}

function previewConflict(preview) {
  const target = preview?.targets?.[0]
  return target?.conflict || target?.namespaceConflict || null
}

export function createMcpInstallTool(dependencies) {
  const timeoutMs = dependencies.timeoutMs ?? MCP_INSTALL_CONFIRMATION_TIMEOUT_MS
  const setTimer = dependencies.setTimeout ?? setTimeout
  const clearTimer = dependencies.clearTimeout ?? clearTimeout
  return {
    name: MCP_INSTALL_TOOL_NAME,
    description: 'Preview or install one fresh MCP server using credential references. Install requires exact-plan Host user confirmation, probes before registration, and never changes defaults or session selection.',
    parameters: MCP_INSTALL_PARAMETERS,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const session = agent?.session
      if (delegated(agent)) return delegatedResult()
      if (!session || !['preview', 'install'].includes(args?.action)) return failure('validation-failed', 'invalid-config', 'mcp_install requires a live session and action preview or install.')

      let mutationStarted = false
      try {
        const operations = dependencies.operationsFor(session)
        const parsed = parseMcpDocument(args.plan, { surface: 'refs' })
        if (parsed.entries.length !== 1) return failure('validation-failed', 'invalid-config', 'mcp_install accepts exactly one server plan.')
        const normalized = parsed.entries[0]
        const identity = normalized.entry.identity
        const request = { action: 'preview', mode: 'add', identity, config: args.plan, refsOnly: true, surface: 'refs' }
        const preview = await operations.preview(request)
        if (preview.digest !== parsed.digest) throw Object.assign(new Error('MCP preview normalization was not stable'), { code: 'plan-changed' })
        if (args.action === 'preview') return sanitizeMcpPayload({ ...preview, next: { action: 'review-plan-then-install' } })
        if (previewConflict(preview)) {
          return failure('conflict', 'name-conflict', `MCP identity or namespace is already registered: ${previewConflict(preview)}`, { identity, registryRevision: preview.registryRevision })
        }
        if (dependencies.isLiveRoot?.(agent) !== true) return confirmationFailure({ code: 'CALLER_NOT_LIVE' })
        const questions = dependencies.userQuestions?.()
        if (typeof questions?.ask !== 'function') return confirmationFailure({ code: 'NO_PROVIDER' })
        if (typeof dependencies.mutate !== 'function' || typeof dependencies.captureOwnership !== 'function') {
          return failure('unsupported', 'ownership-unavailable', 'Exact MCP mutation ownership cannot be verified; installation was not attempted.')
        }

        const ownership = await dependencies.captureOwnership(session.id)
        const execution = await dependencies.describeExecution?.(normalized.entry) ?? null
        const stored = {
          identity,
          plan: structuredClone(preview.plan),
          entry: structuredClone(normalized.entry),
          digest: preview.digest,
          entryFingerprint: fingerprintMcpEntry(normalized.entry),
          registryRevision: preview.registryRevision,
        }
        const retained = dependencies.storePlan?.(stored) ?? stored
        const question = questionFor(retained, execution)
        const combined = cancellation(exec.signal, timeoutMs, setTimer, clearTimer)
        let settlement
        try {
          settlement = await firstConfirmationSettlement(() => questions.ask({ agent, questions: [question], signal: combined.signal }), combined.signal)
        } finally { combined.dispose() }
        if (settlement.kind !== 'answer') return confirmationFailure(settlement.cause)
        if (!mcpInstallApproved(settlement.value, question.id)) {
          return failure('cancelled', 'confirmation-not-approved', 'The exact approval option was not selected alone; no probe or write occurred.')
        }

        if (dependencies.isLiveRoot?.(agent) !== true) return confirmationFailure({ code: 'CALLER_NOT_LIVE' })
        assertMcpInstallStoredPlan(retained)
        const currentOwner = await dependencies.captureOwnership(session.id)
        if (!dependencies.sameOwnership(ownership, currentOwner)) {
          return failure('owner-changed', 'owner-changed', 'MCP mutation ownership changed while confirmation was open; no probe or write occurred.', {
            next: { action: 'preview-again' },
          })
        }
        const current = await operations.preview({
          action: 'preview', mode: 'add', identity, config: retained.entry, refsOnly: true, surface: 'refs',
        })
        if (current.digest !== retained.digest || current.registryRevision !== retained.registryRevision) {
          return failure('revision-conflict', 'plan-or-revision-changed', 'The MCP plan or registry revision changed while confirmation was open; preview again.', {
            identity, registryRevision: current.registryRevision, next: { action: 'preview-again' },
          })
        }
        if (previewConflict(current)) {
          return failure('conflict', 'name-conflict', `MCP identity or namespace changed while confirmation was open: ${previewConflict(current)}`, {
            identity, registryRevision: current.registryRevision, next: { action: 'preview-again' },
          })
        }

        mutationStarted = true
        const outcome = await dependencies.mutate(session.id, {
          action: 'installFromAgent', identity, config: retained.entry, refsOnly: true, surface: 'refs', targetFingerprint: null,
        })
        return sanitizeMcpPayload(outcome)
      } catch (cause) {
        const code = cause?.code ?? (mutationStarted ? 'indeterminate' : 'validation-failed')
        if (code === 'CALLER_NOT_LIVE' || code === 'NO_PROVIDER' || code === 'DELEGATED_CALLER') return confirmationFailure(cause)
        if (code === 'owner-changed') return failure('owner-changed', code, 'MCP mutation ownership changed; inspect actual state before retrying.', { next: { action: 'inspect-actual-state' } })
        if (code === 'plan-changed') return failure('conflict', code, 'The approved MCP plan changed; no probe or write occurred.', { next: { action: 'preview-again' } })
        return failure(mutationStarted ? 'indeterminate' : code === 'invalid-config' || code === 'executable-not-found' ? 'validation-failed' : 'indeterminate', code,
          mutationStarted ? 'The confirmed MCP installation outcome is unavailable; inspect actual registry and mount state.' : 'MCP installation could not be prepared.', {
            ...(mutationStarted ? { next: { action: 'reread-registry' } } : {}),
          })
      }
    },
  }
}
