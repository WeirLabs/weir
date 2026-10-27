// Shared Host MCP operations. UI mutations, user commands and AI installation
// converge here: normalized preview → ownership/support checks → staged refs →
// optional probe → current-read fingerprint/CAS → strict targeted mount/readback.
import { parseMcpDocument, normalizeMcpServer, fingerprintMcpEntry, hasMcpSecrets, assertMcpPlanSize, resolveMcpEditArgs } from './mcp-config.js'
import { stageMcpCredentials, compensateMcpCredentialAttempt } from './mcp-credentials.js'
import { mcpDiagnostic, sanitizeMcpPayload } from './mcp-diagnostics.js'
import { mcpIdentityLockFor } from './mcp-runtime.js'
import { AUDIT_TYPES } from '../shared/audit.js'

const has = value => value && typeof value === 'object' && !Array.isArray(value)
const clone = value => value == null ? value : structuredClone(value)
const currentServers = current => current?.kind === 'ok' ? current.servers : {}
const committed = result => result?.status === 'committed'
const failedStatuses = new Set(['revision-conflict', 'conflict', 'validation-failed', 'unsupported', 'probe-failed', 'owner-changed', 'indeterminate', 'cleanup-failed', 'cleanup-unknown', 'cancelled'])

function failure(status, code, cause, extra = {}) {
  return { status, saved: false, error: mcpDiagnostic(cause ?? new Error(code), { code, action: status === 'cleanup-unknown' ? 'recover-residue' : 'retry' }), ...extra }
}
function resultForBatch(item) {
  const succeeded = item.status === 'mounted'
  return { ...item, succeeded, failed: !succeeded, notAttempted: item.status === 'not-attempted' }
}

function mergeRefs(existing, incoming) {
  if (!incoming) return clone(existing)
  const out = clone(existing ?? {})
  for (const kind of ['env', 'headers', 'args']) if (incoming[kind]) out[kind] = { ...(out[kind] ?? {}), ...clone(incoming[kind]) }
  if (incoming.url) out.url = clone(incoming.url)
  return out
}
function editSource(existing, raw) {
  const source = clone(raw)
  source.identity = existing.identity
  source.label ??= existing.label
  source.serverName ??= existing.client?.serverName
  if (existing.transport?.kind === 'stdio' || existing.client?.transport === 'stdio') {
    source.command ??= existing.client?.command
    // Omitted args keep the stored argv; supplied args resolve projection
    // placeholders back to the stored values and refuse any other placeholder.
    source.args = source.args == null ? clone(existing.client?.args ?? []) : resolveMcpEditArgs(existing, source.args)
  } else {
    source.url ??= clone(existing.secretRefs?.url ?? existing.client?.url)
    source.headers ??= undefined
  }
  source.secretRefs = mergeRefs(existing.secretRefs, source.secretRefs)
  return source
}

export function createMcpOperations({ registry, manager, credentials, audit, assertOwner = async () => {}, session = null }) {
  if (!registry || !manager) throw new TypeError('MCP operations require registry and manager')
  const serialize = mcpIdentityLockFor(manager)
  const emit = (action, result, identity) => {
    try {
      audit?.(session, AUDIT_TYPES.capabilityMcp, {
        action, identity: identity ?? null, status: result.status,
        generation: result.generation ?? null, incarnation: result.incarnation ?? null,
        registryRevision: result.registryRevision ?? null, saved: result.saved === true,
        errorCode: result.error?.code ?? null,
      })
    } catch { /* audit never changes policy */ }
  }
  const finalize = (action, result, identity, secrets = []) => {
    const bounded = sanitizeMcpPayload(result, secrets)
    assertMcpPlanSize(bounded)
    emit(action, bounded, identity)
    return bounded
  }
  const owner = async phase => {
    try { await assertOwner(phase) } catch (cause) {
      const error = new Error(`MCP mutation ownership changed before ${phase}`, { cause })
      error.code = 'owner-changed'
      throw error
    }
  }
  const read = async () => {
    const current = await registry.read()
    if (!['ok', 'absent'].includes(current.kind)) {
      const error = new Error(`MCP registry is ${current.kind}`)
      error.code = 'registry-unavailable'
      throw error
    }
    return current
  }
  const revisionConflict = (current, extra = {}) => ({ status: 'revision-conflict', saved: false, registryRevision: current.revision ?? 0, next: { action: 'preview-again' }, ...extra })

  async function preview(request = {}) {
    const surface = request.surface ?? (request.refsOnly ? 'refs' : 'ui')
    const parsed = parseMcpDocument(request.document ?? request.config ?? request, { surface })
    const current = await read()
    const mode = request.mode ?? (request.action === 'edit' ? 'edit' : 'add')
    const targets = parsed.entries.map(item => {
      const existing = currentServers(current)[item.entry.identity]
      return {
        identity: item.entry.identity,
        fingerprint: existing ? fingerprintMcpEntry(existing) : null,
        generation: existing?.generation ?? null,
        incarnation: existing?.incarnation ?? null,
        conflict: mode === 'add' && existing ? 'identity-exists' : mode === 'edit' && !existing ? 'identity-unregistered' : null,
        namespaceConflict: namespaceConflict(current, item.entry),
      }
    })
    return {
      status: 'preview', plan: parsed.plan, digest: parsed.digest, targets,
      registryRevision: current.revision ?? 0,
      capabilities: manager.support(),
      saved: false,
    }
  }

  function namespaceConflict(current, entry) {
    const serverName = entry.client?.serverName ?? entry.identity
    const sibling = Object.values(currentServers(current)).find(other => other.identity !== entry.identity && (other.client?.serverName ?? other.identity) === serverName)
    if (sibling) return `managed server "${sibling.identity}" already reserves serverName "${serverName}"`
    return manager.serverNameConflict?.(serverName, entry.identity) ?? null
  }

  function ensureSupport(normalized) {
    const support = manager.support()
    if (normalized.hasSecrets && !support.ephemeral) return failure('unsupported', 'ephemeral-loader-unavailable', new Error('secret-bearing MCP work requires a proven ephemeral Loader parent'))
    if (Object.keys(normalized.secretValues ?? {}).length > 0 && !support.credentials) return failure('unsupported', 'credentials-unavailable', new Error('new MCP secret values require DSH credentials'))
    return null
  }

  async function compensate(attempt, provenUncommitted) {
    return compensateMcpCredentialAttempt({ attempt, registry, credentials, provenUncommitted })
  }

  /**
   * Every operation that fences a registered identity runs inside the
   * manager's per-identity queue, so overlapping same-identity operations are
   * strictly serialized. A Test of a fresh (add-mode) config is probe-only: it
   * uses a throwaway probe identity, never fences or closes admission of the
   * named identity, and therefore needs no queue slot.
   */
  async function mutateOne(action, request, normalized, options = {}) {
    const identity = normalized.entry.identity
    if (action === 'test' && options.liveTarget !== true) return runOne(action, request, normalized, options, false)
    return serialize(identity, () => runOne(action, request, normalized, options, true))
  }

  async function runOne(action, request, normalized, options, fenced) {
    const identity = normalized.entry.identity
    const token = fenced ? manager.beginOperation(identity, action === 'remove' ? 'removing' : 'replacing') : null
    let attempt = null
    let committedWrite = false
    let actualRevision = null
    const secrets = []
    const finish = async (result, { beforeCommit = false, provenUncommitted = false } = {}) => {
      const projectedSecrets = () => [...secrets, ...(attempt?.secrets ?? [])]
      if (beforeCommit && token) manager.abortOperation(token)
      if (attempt && !committedWrite) {
        const cleanup = await compensate(attempt, provenUncommitted)
        if (cleanup.status !== 'cleaned') return finalize(action, { ...result, status: cleanup.status, cleanup, saved: committedWrite || result.saved === true }, identity, projectedSecrets())
      }
      return finalize(action, { ...result, registryRevision: result.registryRevision ?? actualRevision }, identity, projectedSecrets())
    }
    const indeterminateAfterWrite = async cause => {
      let observed = null
      try { observed = await read() } catch { /* the outcome stays unknown */ }
      const registered = observed?.kind === 'ok' ? observed.servers[identity] : null
      return {
        status: 'indeterminate',
        saved: action === 'remove' ? observed?.kind === 'ok' && !registered : Boolean(registered),
        removed: action === 'remove' && observed?.kind === 'ok' && !registered,
        generation: registered?.generation,
        incarnation: registered?.incarnation ?? null,
        registryRevision: observed?.revision ?? actualRevision,
        error: mcpDiagnostic(cause, { code: 'indeterminate' }),
        next: { action: 'reread-registry' },
      }
    }
    try {
      await owner('preflight')
      let current = await read()
      actualRevision = current.revision ?? 0
      const existing = currentServers(current)[identity]
      if (options.resolveExisting) normalized = await options.resolveExisting(existing, current)
      const expectedFingerprint = options.targetFingerprint ?? normalized.targetFingerprint ?? (existing ? fingerprintMcpEntry(existing) : null)
      // An absent registry has no raw revision while preview reports 0; compare the
      // same normalized value or the first UI Add/Test carrying expectedRevision 0 falsely conflicts.
      if (!options.batch && Number.isSafeInteger(request.expectedRevision) && (current.revision ?? 0) !== request.expectedRevision) return finish(revisionConflict(current), { beforeCommit: true, provenUncommitted: true })
      if (action === 'add' || action === 'installFromAgent') {
        if (existing) return finish({ status: 'conflict', saved: false, error: { code: 'name-conflict', message: `MCP identity "${identity}" already exists` } }, { beforeCommit: true, provenUncommitted: true })
      } else if (action === 'edit' || action === 'restart' || action === 'remove') {
        if (!existing) return finish({ status: 'conflict', saved: false, error: { code: 'identity-unregistered', message: `MCP identity "${identity}" is not registered` } }, { beforeCommit: true, provenUncommitted: true })
        if (expectedFingerprint && fingerprintMcpEntry(existing) !== expectedFingerprint) return finish(revisionConflict(current), { beforeCommit: true, provenUncommitted: true })
        if (action === 'edit' && (existing.client?.serverName ?? identity) !== (normalized.entry.client?.serverName ?? identity) && !request.confirmNamespaceChange) {
          return finish({ status: 'confirmation-required', saved: false, error: { code: 'namespace-change-requires-confirmation', message: 'Changing the public serverName requires distinct confirmation.' } }, { beforeCommit: true, provenUncommitted: true })
        }
      }
      const conflict = action === 'remove' ? null : namespaceConflict(current, normalized.entry)
      if (conflict) return finish({ status: 'conflict', saved: false, error: { code: 'name-conflict', message: conflict } }, { beforeCommit: true, provenUncommitted: true })
      const unsupported = ensureSupport(normalized)
      if (unsupported) return finish(unsupported, { beforeCommit: true, provenUncommitted: true })

      if (action !== 'remove' && action !== 'restart') {
        await owner('credentials')
        const staged = await stageMcpCredentials({ entry: normalized.entry, secretValues: normalized.secretValues, credentials, registry, generation: (existing?.generation ?? 0) + 1 })
        normalized.entry = staged.entry
        attempt = staged.attempt
      }
      if (options.requireProbe || action === 'test') {
        await owner('probe')
        const probe = await manager.probe(normalized.entry, { targetIdentity: identity })
        if (probe.status !== 'mounted') {
          return finish({ ...probe, saved: false, next: { action: 'edit-and-retry' } }, { beforeCommit: true, provenUncommitted: true })
        }
        if (action === 'test') return finish({ status: 'mounted', identity, saved: false, probe: true, discovery: probe.discovery, cleanup: probe.cleanup, next: { action: 'add-or-edit' } }, { beforeCommit: true, provenUncommitted: true })
      }

      if (action === 'remove') {
        current = await read()
        const latest = currentServers(current)[identity]
        if (!latest || fingerprintMcpEntry(latest) !== expectedFingerprint) return finish(revisionConflict(current), { beforeCommit: true, provenUncommitted: true })
        await owner('CAS')
        let written
        try { written = await registry.remove(identity, current.revision ?? 0) } catch (cause) {
          return finish(await indeterminateAfterWrite(cause), { provenUncommitted: false })
        }
        if (!committed(written)) return finish(revisionConflict(current), { beforeCommit: true, provenUncommitted: true })
        committedWrite = true
        actualRevision = written.revision
        await owner('mount')
        const removed = await manager.removeRuntime(identity, token)
        return finish({ ...removed, identity, saved: true, removed: removed.status === 'removed', defaultRemoved: Boolean(written.defaultRemoved), registryRevision: actualRevision }, { provenUncommitted: false })
      }

      current = await read()
      const latest = currentServers(current)[identity]
      if ((action === 'add' || action === 'installFromAgent') && latest) return finish({ status: 'conflict', saved: false, error: { code: 'name-conflict', message: `MCP identity "${identity}" was created during the operation` } }, { beforeCommit: true, provenUncommitted: true })
      if (['edit', 'restart'].includes(action) && (!latest || fingerprintMcpEntry(latest) !== expectedFingerprint)) return finish(revisionConflict(current), { beforeCommit: true, provenUncommitted: true })
      const latestConflict = action === 'restart' ? null : namespaceConflict(current, normalized.entry)
      if (latestConflict) return finish({ status: 'conflict', saved: false, error: { code: 'name-conflict', message: latestConflict } }, { beforeCommit: true, provenUncommitted: true })
      await owner('CAS')
      let written
      try {
        written = await registry.register(normalized.entry, current.revision ?? 0)
      } catch (cause) {
          return finish(await indeterminateAfterWrite(cause), { provenUncommitted: false })
      }
      if (!committed(written)) return finish(revisionConflict(current), { beforeCommit: true, provenUncommitted: true })
      committedWrite = true
      actualRevision = written.revision
      const afterCommit = await read()
      const registered = afterCommit.servers[identity]
      await owner('mount')
      const mounted = await manager.reconcileOne(identity, registered, token)
      const result = {
        ...mounted,
        identity,
        generation: registered.generation,
        incarnation: registered.incarnation ?? null,
        registryRevision: actualRevision,
        saved: true,
        succeeded: mounted.status === 'mounted',
        ...(normalized.legacyLiteralSecrets ? { warnings: ['legacy-literal-secrets-in-command-history'] } : {}),
        ...(action === 'installFromAgent' ? { next: { action: 'select-and-apply' } } : {}),
      }
      return finish(result, { provenUncommitted: false })
    } catch (cause) {
      const status = cause?.code === 'owner-changed' ? 'owner-changed' : cause?.status === 'unsupported' || cause?.code === 'unsupported' ? 'unsupported' : cause?.code === 'registry-unavailable' ? 'indeterminate' : cause?.code === 'credential-missing' || cause?.code === 'invalid-config' || cause?.code === 'credential-write-failed' ? 'validation-failed' : failedStatuses.has(cause?.status) ? cause.status : 'indeterminate'
      const result = failure(status, cause?.code ?? status, cause, { saved: committedWrite, registryRevision: actualRevision, next: { action: status === 'owner-changed' ? 'inspect-actual-state' : 'retry' } })
      return finish(result, { beforeCommit: !committedWrite, provenUncommitted: !committedWrite })
    }
  }

  async function execute(request = {}) {
    const action = request.action
    if (action === 'preview') return finalize('preview', await preview(request), null)
    if (action === 'setDefault') {
      try {
        const current = await read()
        if (Number.isSafeInteger(request.expectedRevision) && (current.revision ?? 0) !== request.expectedRevision) return finalize(action, revisionConflict(current), request.identity)
        await owner('CAS')
        const result = await registry.setDefault(request.identity, request.enabled === true, current.revision ?? 0)
        if (!committed(result)) return finalize(action, revisionConflict(current), request.identity)
        return finalize(action, { status: 'saved', identity: request.identity, saved: true, defaultEnabled: request.enabled === true, registryRevision: result.revision }, request.identity)
      } catch (cause) {
        return finalize(action, failure(cause?.code === 'owner-changed' ? 'owner-changed' : 'validation-failed', cause?.code ?? 'default-failed', cause), request.identity)
      }
    }
    if (action === 'recover') {
      const identity = typeof request.identity === 'string' ? request.identity : null
      try {
        if (typeof manager.recoverResidue !== 'function') return finalize(action, failure('unsupported', 'recover-unavailable', new Error('this MCP manager cannot recover residue')), identity)
        await owner('mount')
        const result = await manager.recoverResidue({ identity })
        return finalize(action, { ...result, saved: false, next: { action: result.status === 'recovered' ? 'none' : 'inspect-diagnostics' } }, identity)
      } catch (cause) {
        const status = cause?.code === 'owner-changed' ? 'owner-changed' : 'indeterminate'
        return finalize(action, failure(status, cause?.code ?? status, cause, { next: { action: 'inspect-actual-state' } }), identity)
      }
    }
    const unresolved = () => ({ entry: { identity: request.identity, client: { serverName: request.identity } }, secretValues: {}, hasSecrets: false, legacyLiteralSecrets: false })
    if (action === 'remove' || action === 'restart') {
      return mutateOne(action, request, unresolved(), {
        targetFingerprint: request.targetFingerprint,
        resolveExisting: existing => ({ entry: clone(existing), secretValues: {}, hasSecrets: hasMcpSecrets(existing), legacyLiteralSecrets: false }),
      })
    }
    if (!['add', 'edit', 'test', 'installFromAgent'].includes(action)) return finalize(action ?? 'unknown', failure('validation-failed', 'unknown-operation', new Error(`unsupported MCP operation ${action}`)), request.identity)
    const surface = request.surface ?? (request.refsOnly || action === 'installFromAgent' ? 'refs' : 'ui')
    if (action === 'edit' || (action === 'test' && request.mode === 'edit')) {
      return mutateOne(action, request, unresolved(), {
        targetFingerprint: request.targetFingerprint,
        liveTarget: true,
        resolveExisting: existing => {
          if (!existing) return unresolved()
          const normalized = normalizeMcpServer(editSource(existing, request.config ?? request.document ?? {}), { surface, identity: request.identity })
          normalized.entry.client.env = clone(existing.client?.env ?? {})
          if (existing.client?.headers) normalized.entry.client.headers = clone(existing.client.headers)
          normalized.entry.owner = clone(existing.owner)
          normalized.entry.configuredAt = existing.configuredAt
          normalized.entry.incarnation = existing.incarnation ?? null
          return normalized
        },
      })
    }
    const normalized = normalizeMcpServer(request.config ?? request.document ?? {}, { surface, identity: request.identity })
    if (action === 'test') return mutateOne(action, request, normalized, { targetFingerprint: request.targetFingerprint })
    if (action === 'installFromAgent') return mutateOne(action, request, normalized, { requireProbe: true })
    return mutateOne(action, request, normalized, { targetFingerprint: request.targetFingerprint })
  }

  async function executeBatch(request = {}) {
    const parsed = parseMcpDocument(request.document ?? request.config ?? request, { surface: request.surface ?? (request.refsOnly ? 'refs' : 'ui') })
    const planned = await preview({ ...request, action: 'preview' })
    const items = []
    let aborted = null
    for (let index = 0; index < parsed.entries.length; index += 1) {
      if (aborted) {
        items.push(resultForBatch({ status: 'not-attempted', identity: parsed.entries[index].entry.identity, saved: false, error: { code: 'batch-aborted', message: aborted } }))
        continue
      }
      const normalized = parsed.entries[index]
      const action = request.mode === 'edit' ? 'edit' : 'add'
      const result = await mutateOne(action, { ...request, identity: normalized.entry.identity, expectedRevision: undefined }, normalized, { batch: true, requireProbe: true, targetFingerprint: planned.targets[index]?.fingerprint })
      items.push(resultForBatch(result))
      if (['owner-changed', 'indeterminate'].includes(result.status) || result.error?.code === 'registry-unavailable') aborted = `batch aborted after ${normalized.entry.identity}: ${result.status}`
    }
    const succeeded = items.every(item => item.succeeded)
    return finalize('batch', { status: succeeded ? 'mounted' : 'partial', batch: true, atomic: false, succeeded, items }, null)
  }

  return {
    preview,
    execute,
    executeBatch,
    add: request => execute({ ...request, action: 'add' }),
    edit: request => execute({ ...request, action: 'edit' }),
    remove: request => execute({ ...request, action: 'remove' }),
    restart: request => execute({ ...request, action: 'restart' }),
    test: request => execute({ ...request, action: 'test' }),
    setDefault: request => execute({ ...request, action: 'setDefault' }),
    recover: request => execute({ ...request, action: 'recover' }),
    installFromAgent: request => execute({ ...request, action: 'installFromAgent', refsOnly: true, surface: 'refs' }),
  }
}
