// Registry-backed managed MCP runtime. Startup and targeted add/edit/restart/
// remove/probe share reconcileOne(); siblings are never used as replacement
// collateral. Status joins only prove registry/runtime/mount/readback facts.
import { openCapabilityStore } from './store/store.js'
import { createMcpRegistry } from './mcp-registry.js'
import { createMcpGate } from './mcp-gate.js'
import { createMcpDrain } from './mcp-drain.js'
import { createMcpMount, mcpGroupOptions, isMcpResidueId, detectMcpNameAmbiguity, MCP_GROUP_PREFIX, resolveEphemeralMcpTree } from './mcp-mount.js'
import { registerMcpFacadeBridge } from './mcp-facade-plugin.js'
import { skillSelectionFor } from './skill-selection-plugin.js'
import { createMcpRuntime, createMcpIdentityLock } from './mcp-runtime.js'
import { materializeMcpClientConfig } from './mcp-credentials.js'
import { hasMcpSecrets, redactMcpEntry, fingerprintMcpEntry } from './mcp-config.js'
import { createMcpProcessAdapter } from './mcp-process.js'
import { mcpDiagnostic, sanitizeMcpText } from './mcp-diagnostics.js'

const message = error => (error instanceof Error ? error.message : String(error))
const now = () => Date.now()

export function partitionMcpRows(rows, mounted, registryServers) {
  const managed = []
  const unmanaged = []
  for (const row of rows) {
    if (typeof row?.id === 'string' && isMcpResidueId(row.id)) {
      const identity = row.id.slice(MCP_GROUP_PREFIX.length)
      const registry = registryServers[identity]
      managed.push({ identity, groupId: row.id, label: registry?.label ?? identity, generation: mounted.get(identity)?.generation ?? registry?.generation ?? null, state: mounted.has(identity) ? 'mounted' : 'registered' })
    } else if (row?.name === '@deepseek-ai/dsh-mcp-client' && !(typeof row.id === 'string' && row.id.startsWith(MCP_GROUP_PREFIX))) {
      unmanaged.push({ serverName: row.config?.serverName ?? row.id ?? 'unknown', state: 'unmanaged', readOnly: true })
    }
  }
  return { managed, unmanaged }
}

export function hostRowHoldingReservation(rows, serverName) {
  return rows.find(row => row?.name === '@deepseek-ai/dsh-mcp-client' && row.config?.serverName === serverName
    && !(typeof row.id === 'string' && row.id.startsWith(MCP_GROUP_PREFIX))) ?? null
}

export function createMcpManager(dependencies = {}) {
  return (ctx, config = {}) => {
    const profileContext = ctx.get?.('profileContext')
    const store = dependencies.store ?? openCapabilityStore({ profileContext })
    const registry = dependencies.registry ?? createMcpRegistry({ store })
    const lifecycle = dependencies.lifecycle ?? {
      snapshotFor: sessionId => skillSelectionFor(ctx)?.lifecycle?.snapshotFor(sessionId) ?? null,
    }
    const runtime = dependencies.runtime ?? createMcpRuntime()
    // Every runtime.begin path runs inside this per-identity queue (design D6).
    const serialize = createMcpIdentityLock()
    const drain = dependencies.drain ?? createMcpDrain({ timeoutMs: config.drainTimeoutMs ?? 30_000 })
    const gate = dependencies.gate ?? createMcpGate({ registry, lifecycle, runtime, registrationFor: runtime.registrationFor })
    const loader = dependencies.loader ?? ctx.get?.('loader')
    const defaultListRows = () => [...(loader?.entries?.() ?? [])].map(entry => ({ id: entry?.options?.id ?? entry?.id ?? null, name: entry?.options?.name ?? null, config: entry?.options?.config ?? {} }))
    const listEntryIds = dependencies.listEntryIds ?? (() => defaultListRows().map(row => row.id).filter(Boolean))
    const listRows = dependencies.listRows ?? defaultListRows
    const startErrors = []
    /** A strict mount of this identity supersedes its earlier start/mount failures. */
    const clearStartErrors = identity => {
      for (let index = startErrors.length - 1; index >= 0; index -= 1) if (startErrors[index].identity === identity) startErrors.splice(index, 1)
    }
    const onError = (reason, cause) => ctx.logger?.warn?.(sanitizeMcpText(`${reason}${cause ? `: ${message(cause)}` : ''}`))
    const defaultFiberOf = async groupId => {
      for (const candidate of [`${groupId}:${groupId}-client`, `${groupId}-client`]) {
        let entry = null
        try { entry = loader?.resolve?.(candidate) } catch { /* next shape */ }
        if (entry?.fiber) {
          await entry.fiber.await()
          return { state: 'running' }
        }
      }
      return null
    }
    const mount = dependencies.mount ?? createMcpMount({ loader, onError, startupTimeoutMs: config.startupTimeoutMs ?? 15_000, cleanupTimeoutMs: config.cleanupTimeoutMs ?? 15_000 })
    const fiberOf = dependencies.fiberOf ?? defaultFiberOf
    const processAdapter = dependencies.processAdapter ?? createMcpProcessAdapter({ subprocess: dependencies.subprocess ?? ctx.get?.('subprocess') })
    const credentialsFor = () => dependencies.credentials ?? ctx.get?.('credentials')
    const support = () => {
      const credentials = credentialsFor()
      return { credentials: typeof credentials?.set === 'function' && typeof credentials?.resolve === 'function', ephemeral: resolveEphemeralMcpTree(loader).kind === 'ok' }
    }
    const publicNames = new Map() // publicName → { identity, generation }
    const bridges = new Map() // groupId → { identity, generation, release }
    const receipts = { mount: new Map(), test: new Map() }
    const host = {
      tools: dependencies.hostTools ?? ctx.get?.('tools'),
      systemPrompt: dependencies.hostSystemPrompt ?? ctx.get?.('systemPrompt'),
      mcpResources: dependencies.hostMcpResources ?? ctx.get?.('mcpResources'),
    }

    function releaseBridge(groupId) {
      const bridge = bridges.get(groupId)
      if (!bridge) return
      bridges.delete(groupId)
      for (const [name, owner] of publicNames) {
        if (owner.identity === bridge.identity && owner.generation === bridge.generation) publicNames.delete(name)
      }
      bridge.release()
    }
    function registerBridge(groupId, identity, generation) {
      const release = registerMcpFacadeBridge(groupId, {
        host, identity, generation,
        admit: agent => gate.permit(agent, identity, generation),
        assertPermit: gate.assertPermit,
        isEnabledFor: agent => gate.enabledFor(agent, identity),
        drain,
        onRegister: name => publicNames.set(name, { identity, generation }),
        onError,
      })
      bridges.set(groupId, { identity, generation, release })
    }
    function discoveryFor(identity, generation) {
      const names = [...publicNames.entries()].filter(([, owner]) => owner.identity === identity && owner.generation === generation).map(([name]) => name).sort()
      return { toolCount: names.length, toolNamesPreview: names.slice(0, 20), truncated: names.length > 20 }
    }

    function beginOperation(identity, phase = 'replacing', details = {}) {
      const token = runtime.begin(identity, { phase, ...details })
      drain.closeAll(identity)
      return token
    }
    function abortOperation(token) {
      const previousPhase = token.previous?.phase
      const restored = runtime.restore(token)
      if (restored && previousPhase === 'mounted') drain.reopenAll(token.identity)
      return restored
    }
    async function waitForDrain(identity) {
      const result = await drain.drainAll(identity)
      if (!result.drained) {
        const error = new Error(`MCP server "${identity}" still has ${result.inFlight} admitted call(s); replacement cannot prove quiescence`)
        error.code = 'cleanup-unknown'
        throw error
      }
    }

    async function prepare(entry) {
      const credentials = credentialsFor()
      const secretBearing = hasMcpSecrets(entry)
      if (Object.keys(entry?.secretRefs ?? {}).length > 0 && typeof credentials?.resolve !== 'function') {
        const error = new Error('secret-bearing MCP materialization requires DSH credentials')
        error.code = 'unsupported'
        throw error
      }
      const materialized = await materializeMcpClientConfig(entry, credentials)
      const prepared = await processAdapter.prepare(materialized.client)
      return { ...prepared, secrets: materialized.resolvedSecrets, secretBearing }
    }

    /** Resolve only non-secret execution metadata for an exact confirmation card. */
    async function describeExecution(entry) {
      if (entry?.client?.transport !== 'stdio') return null
      const secretArgs = new Set(Object.keys(entry?.secretRefs?.args ?? {}).map(Number))
      const client = {
        ...entry.client,
        args: (entry.client.args ?? []).map((value, index) => secretArgs.has(index) ? '' : value),
        env: {},
      }
      return (await processAdapter.prepare(client)).execution
    }

    async function reconcileOne(identity, entry, suppliedToken = null) {
      const token = suppliedToken ?? beginOperation(identity)
      try {
        const current = await registry.read()
        const registered = current.kind === 'ok' ? current.servers[identity] : null
        if (!registered || registered.generation !== entry.generation || (registered.incarnation ?? null) !== (entry.incarnation ?? null)) {
          const error = new Error(`MCP registry/mount readback rejected ${identity} generation ${entry.generation}`)
          error.code = 'generation-readback-failed'
          throw error
        }
        await waitForDrain(identity)
        if (mount.mounted.has(identity)) {
          const removed = await mount.unmount(identity)
          if (removed.status !== 'cleaned') {
            runtime.finish(token, removed.status, { generation: entry.generation, incarnation: entry.incarnation ?? null })
            return { status: removed.status, identity, cleanup: removed, saved: true }
          }
          releaseBridge(`${MCP_GROUP_PREFIX}${identity}`)
        }
        const prepared = await prepare(entry)
        const groupId = `${MCP_GROUP_PREFIX}${identity}`
        const result = await mount.mount({
          identity,
          generation: entry.generation,
          client: prepared.client,
          secrets: prepared.secrets,
          secretBearing: prepared.secretBearing,
          execution: prepared.execution,
          fiberOf,
          beforeCreate: () => registerBridge(groupId, identity, entry.generation),
          afterCleanup: () => releaseBridge(groupId),
          discovery: () => discoveryFor(identity, entry.generation),
          readback: async () => {
            const readback = await registry.read()
            const actual = readback.kind === 'ok' ? readback.servers[identity] : null
            if (!actual || actual.generation !== entry.generation || (actual.incarnation ?? null) !== (entry.incarnation ?? null)) throw new Error('registry generation/incarnation changed during mount')
          },
        })
        const observed = mount.mounted.get(identity)
        if (!observed || observed.generation !== entry.generation) throw new Error('mounted generation readback failed')
        // Only the fence owner may report mounted and reopen admission: a
        // superseded token means another operation now owns this identity.
        if (!runtime.finish(token, 'mounted', { generation: entry.generation, incarnation: entry.incarnation ?? null })) {
          const diagnostic = mcpDiagnostic(new Error(`MCP operation on ${identity} was superseded before it could report mounted`), { code: 'operation-superseded', action: 'reread-registry' })
          receipts.mount.set(identity, { time: now(), status: 'indeterminate', diagnostic })
          return { status: 'indeterminate', identity, generation: entry.generation, incarnation: entry.incarnation ?? null, saved: true, error: diagnostic, mount: { state: 'superseded', observedGeneration: observed.generation }, next: { action: 'reread-registry' } }
        }
        drain.reopenAll(identity)
        clearStartErrors(identity)
        const receipt = { time: now(), status: 'mounted', generation: entry.generation, discovery: result.discovery }
        receipts.mount.set(identity, receipt)
        return { status: 'mounted', identity, generation: entry.generation, incarnation: entry.incarnation ?? null, mount: { state: 'mounted', observedGeneration: observed.generation }, discovery: result.discovery, execution: result.execution ?? null }
      } catch (cause) {
        const cleanupStatus = ['cleanup-failed', 'cleanup-unknown'].includes(cause?.status) ? cause.status : null
        const status = cleanupStatus ?? (cause?.code === 'unsupported' ? 'unsupported' : 'saved-degraded')
        runtime.finish(token, cleanupStatus ?? 'saved-degraded', { generation: entry.generation, incarnation: entry.incarnation ?? null })
        const diagnostic = mcpDiagnostic(cause, { code: cause?.code, action: cleanupStatus ? 'recover-residue' : 'retry' })
        receipts.mount.set(identity, { time: now(), status, diagnostic })
        startErrors.push({ identity, reason: diagnostic.message })
        onError(`mcp-mount-${status}:${identity}`, cause)
        return { status, identity, generation: entry.generation, incarnation: entry.incarnation ?? null, saved: true, error: diagnostic, mount: { state: cleanupStatus ?? 'degraded' }, next: { action: cleanupStatus ? 'recover-residue' : 'retry-or-edit' } }
      }
    }

    async function removeRuntime(identity, suppliedToken = null) {
      const token = suppliedToken ?? beginOperation(identity, 'removing')
      try {
        await waitForDrain(identity)
        const cleanup = await mount.unmount(identity)
        if (cleanup.status !== 'cleaned') {
          runtime.finish(token, cleanup.status)
          return { status: cleanup.status, identity, cleanup, error: cleanup.diagnostic, next: { action: 'recover-residue' } }
        }
        releaseBridge(`${MCP_GROUP_PREFIX}${identity}`)
        runtime.finish(token, 'unknown', { generation: null, incarnation: null })
        return { status: 'removed', identity, removed: true }
      } catch (cause) {
        const status = cause?.code === 'cleanup-timeout' ? 'cleanup-unknown' : 'cleanup-failed'
        runtime.finish(token, status)
        return { status, identity, error: mcpDiagnostic(cause, { code: status, action: 'recover-residue' }), next: { action: 'recover-residue' } }
      }
    }

    async function probe(entry, { targetIdentity = entry.identity } = {}) {
      try {
        const prepared = await prepare(entry)
        const result = await mount.probe({
          identity: undefined,
          generation: 0,
          client: prepared.client,
          secretBearing: prepared.secretBearing,
          secrets: prepared.secrets,
          fiberOf,
          beforeCreate: ({ groupId, identity, generation }) => registerBridge(groupId, identity, generation),
          afterCleanup: ({ groupId }) => releaseBridge(groupId),
          discovery: ({ identity, generation }) => discoveryFor(identity, generation),
        })
        const outcome = { status: result.status, identity: targetIdentity, discovery: result.discovery, cleanup: result.cleanup }
        receipts.test.set(targetIdentity, { time: now(), status: outcome.status, discovery: outcome.discovery })
        return outcome
      } catch (cause) {
        const status = ['cleanup-failed', 'cleanup-unknown'].includes(cause?.status) ? cause.status : 'probe-failed'
        const outcome = { status, identity: targetIdentity, error: mcpDiagnostic(cause, { code: cause?.code ?? status }), cleanup: cause?.cleanup }
        receipts.test.set(targetIdentity, { time: now(), status, error: outcome.error })
        return outcome
      }
    }

    let started = false
    async function start() {
      if (started) return { mounted: mount.mounted.size, alreadyStarted: true }
      started = true
      const swept = await mount.sweepResidue(listEntryIds())
      const current = await registry.read()
      if (current.kind !== 'ok') {
        startErrors.push({ identity: null, reason: `registry-${current.kind}`, swept: swept.length })
        return { mounted: 0, skipped: current.kind }
      }
      const ambiguity = detectMcpNameAmbiguity(Object.values(current.servers))
      if (ambiguity.kind === 'conflict') {
        onError(`mcp-name-ambiguity: ${ambiguity.conflicts.map(c => c.reason).join('; ')}`)
        return { mounted: 0, ambiguity }
      }
      let mountedCount = 0
      for (const entry of Object.values(current.servers)) {
        const result = await serialize(entry.identity, () => reconcileOne(entry.identity, entry))
        if (result.status === 'mounted') mountedCount += 1
        else if (result.status !== 'saved-degraded') startErrors.push({ identity: entry.identity, reason: result.status })
      }
      return { mounted: mountedCount }

    }
    const healthy = identity => runtime.snapshot(identity).phase === 'mounted' && mount.mounted.has(identity)
      && (mount.mounted.get(identity)?.state ?? 'mounted') === 'mounted'

    /** Recover one identity inside its queue slot: sweep untracked residue, then strictly remount. */
    function recoverOne(identity) {
      return serialize(identity, async () => {
        // Re-read inside the slot: an earlier queued operation may have
        // remounted, edited or removed this identity meanwhile.
        const current = await registry.read()
        if (current.kind !== 'ok' && current.kind !== 'absent') return { status: 'unavailable', identity, skipped: current.kind }
        const entry = current.kind === 'ok' ? current.servers[identity] ?? null : null
        if (entry && healthy(identity)) return { status: 'mounted', identity, generation: entry.generation, alreadyHealthy: true }
        const groupId = `${MCP_GROUP_PREFIX}${identity}`
        const residuePresent = listEntryIds().includes(groupId)
        if (!entry) {
          // Orphan residue of an identity that is no longer registered.
          const swept = residuePresent ? await mount.sweepResidue([groupId]) : []
          const cleaned = !residuePresent || swept.includes(groupId)
          if (cleaned) releaseBridge(groupId)
          return cleaned
            ? { status: 'removed', identity, swept: residuePresent }
            : { status: 'cleanup-failed', identity, error: mcpDiagnostic(new Error(`residue Loader row ${groupId} could not be removed`), { code: 'cleanup-failed', action: 'recover-residue' }), next: { action: 'recover-residue' } }
        }
        const token = beginOperation(identity)
        // A tracked failed mount record is retried by reconcileOne's unmount; a
        // Loader row the mount map no longer tracks is swept first, or the
        // same-name replacement could never be created.
        if (!mount.mounted.has(identity) && residuePresent) {
          const swept = await mount.sweepResidue([groupId])
          if (!swept.includes(groupId)) {
            runtime.finish(token, 'cleanup-failed', { generation: entry.generation, incarnation: entry.incarnation ?? null })
            const diagnostic = mcpDiagnostic(new Error(`residue Loader row ${groupId} could not be removed`), { code: 'cleanup-failed', action: 'recover-residue' })
            receipts.mount.set(identity, { time: now(), status: 'cleanup-failed', diagnostic })
            return { status: 'cleanup-failed', identity, generation: entry.generation, saved: true, error: diagnostic, next: { action: 'recover-residue' } }
          }
          releaseBridge(groupId)
        }
        return reconcileOne(identity, entry, token)
      })
    }

    /**
     * Residue recovery (user-triggered via the capabilities command verb
     * mcp-recover, the mcp mutation action 'recover' and the panel's Recover
     * row action). Healthy mounted identities are never touched; every other
     * registered identity is strictly remounted and every orphan residue row is
     * removed. `identity` scopes the work to one server.
     */
    async function recoverResidue({ identity = null } = {}) {
      const current = await registry.read()
      if (current.kind !== 'ok' && current.kind !== 'absent') return { status: 'unavailable', skipped: current.kind, results: [] }
      const servers = current.kind === 'ok' ? current.servers : {}
      const orphans = listEntryIds().filter(isMcpResidueId).map(id => id.slice(MCP_GROUP_PREFIX.length)).filter(id => !servers[id])
      let candidates = [...new Set([...Object.keys(servers).filter(id => !healthy(id)), ...orphans])]
      if (identity !== null) candidates = candidates.filter(id => id === identity)
      const results = []
      for (const id of candidates) results.push(await recoverOne(id))
      const recovered = results.filter(result => result.status === 'mounted' || result.status === 'removed').length
      return { status: recovered === results.length ? 'recovered' : 'recovery-incomplete', recovered, results }
    }

    async function adopt(entry) {
      const holder = hostRowHoldingReservation(listRows(), entry.client?.serverName ?? entry.transport?.serverName ?? entry.identity)
      if (holder) return { status: 'conflict', reason: `host row "${holder.id ?? entry.identity}" still holds the serverName reservation — disable it in the host configuration; the managed client mounts afterwards. Until then the server stays unmanaged.` }
      return serialize(entry.identity, async () => {
        const current = await registry.read()
        const revision = current.kind === 'ok' ? current.revision : 0
        const token = beginOperation(entry.identity)
        const registered = await registry.register(entry, revision)
        if (registered.status !== 'committed') { abortOperation(token); return { status: 'registry-failed', result: registered.status } }
        const latest = await registry.read()
        return reconcileOne(entry.identity, latest.servers[entry.identity], token)
      })
    }

    function agentCreated(payload) {
      const agent = payload?.agent
      if (publicNames.size === 0) return
      const deny = [...publicNames.entries()].filter(([, owner]) => !gate.enabledFor(agent, typeof owner === 'string' ? owner : owner.identity)).map(([name]) => name)
      if (deny.length > 0) {
        try { agent?.ctx?.tools?.restrict?.({ deny }) } catch (cause) { onError('mcp-schema-restrict-failed', cause) }
      }
    }
    ctx.on?.('agent/created', payload => { agentCreated(payload) })

    async function list() {
      const current = await registry.read()
      const rows = listRows()
      const partitioned = partitionMcpRows(rows, mount.mounted, current.kind === 'ok' ? current.servers : {})
      if (current.kind === 'absent') return { managed: [], unmanaged: partitioned.unmanaged, warnings: [], registryRevision: 0, capabilities: support() }
      if (current.kind !== 'ok') return { managed: [], unmanaged: partitioned.unmanaged, unavailable: { status: current.kind }, registryRevision: current.revision ?? 0, capabilities: support() }
      const defaults = new Set(current.enabled)
      const managed = Object.values(current.servers).map(entry => {
        const phase = runtime.snapshot(entry.identity)
        const mountedRecord = mount.mounted.get(entry.identity)
        const mounted = phase.phase === 'mounted' && phase.generation === entry.generation && mountedRecord?.generation === entry.generation
        const holder = hostRowHoldingReservation(rows, entry.client?.serverName ?? entry.identity)
        const state = holder ? 'conflict' : mounted ? 'mounted' : phase.phase === 'saved-degraded' ? 'degraded' : ['cleanup-failed', 'cleanup-unknown'].includes(phase.phase) ? phase.phase : 'registered'
        const discovery = discoveryFor(entry.identity, entry.generation)
        return {
          identity: entry.identity,
          label: entry.label,
          serverName: entry.client?.serverName ?? entry.identity,
          transport: entry.transport?.kind ?? entry.client?.transport ?? 'unknown',
          incarnation: entry.incarnation ?? null,
          generation: entry.generation,
          defaultEnabled: defaults.has(entry.identity),
          state,
          statusSource: mounted ? 'registry-runtime-mount-readback' : holder ? 'serverName-reservation' : 'registry-runtime',
          runtimePhase: phase.phase,
          discovery: mounted ? discovery : { toolCount: null, toolNamesPreview: [], truncated: false },
          lastMount: receipts.mount.get(entry.identity) ?? null,
          lastTest: receipts.test.get(entry.identity) ?? null,
          startErrors: startErrors.filter(error => error.identity === entry.identity).map(error => ({ reason: error.reason })),
          liveReconnect: 'unknown',
          processExit: 'unknown',
          stderr: 'unknown',
          readOnly: false,
          config: redactMcpEntry(entry),
          fingerprint: fingerprintMcpEntry(entry),
        }
      })
      return { managed, unmanaged: partitioned.unmanaged, warnings: current.warnings, registryRevision: current.revision, capabilities: support() }
    }

    const gateFace = {
      admit: (agent, identity, generation) => gate.admit(agent, identity, generation),
      permit: (agent, identity, generation) => gate.permit(agent, identity, generation),
      assertPermit: gate.assertPermit,
      enabledFor: (agent, identity) => gate.enabledFor(agent, identity),
      drain,
    }
    try { ctx.reflect?.provide?.('weirMcpGate', gateFace) } catch { /* older row */ }
    const face = {
      start, startErrors, adopt, gate: gateFace, drain, registry, runtime,
      recoverResidue,
      list,
      publicNames,
      mounted: mount.mounted,
      beginOperation, abortOperation, reconcileOne, removeRuntime, probe,
      remove: identity => serialize(identity, () => removeRuntime(identity)),
      /** Run one same-identity operation after every earlier one settled. */
      serialize,
      support,
      serverNameConflict: (serverName, identity) => {
        const holder = hostRowHoldingReservation(listRows(), serverName)
        return holder ? `host row "${holder.id ?? identity}" already reserves serverName "${serverName}"` : null
      },
      prepare, describeExecution,
      mcpGroupOptions,
    }
    try { ctx.reflect?.provide?.('weirMcpManager', face) } catch { /* older row */ }
    void Promise.resolve().then(() => face.start()).catch(cause => {
      startErrors.push({ identity: null, reason: `start-failed:${message(cause)}` })
      onError('mcp-manager-start-failed', cause)
    })
    return () => {
      try { ctx.reflect?.provide?.('weirMcpGate', { admit: async () => false, permit: async () => null, assertPermit: () => false, enabledFor: () => false, drain }) } catch { /* best effort */ }
    }
  }
}

export const name = 'weir-mcp-manager'
export const inject = ['loader', 'tools', 'systemPrompt', 'mcpResources']
export const apply = createMcpManager()
export const __message = message
