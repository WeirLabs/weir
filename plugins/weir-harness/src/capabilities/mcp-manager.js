// Registry-backed managed MCP runtime. Startup and targeted add/edit/restart/
// remove/probe share reconcileOne(); siblings are never used as replacement
// collateral. Status joins only prove registry/runtime/mount/readback facts.
import { openCapabilityStore } from './store/store.js'
import { createMcpRegistry } from './mcp-registry.js'
import { createMcpGate } from './mcp-gate.js'
import { createMcpDrain } from './mcp-drain.js'
import { createMcpMount, mcpGroupOptions, isMcpResidueId, detectMcpNameAmbiguity, MCP_GROUP_PREFIX, resolveEphemeralMcpTree, resolveScopedMcpTree } from './mcp-mount.js'
import { registerMcpFacadeBridge } from './mcp-facade-plugin.js'
import { mcpMountOwnership } from './mcp-mount-ownership.js'
import { lifecycleFeedRegistry } from './lifecycle-feed.js'
import { createMcpRuntime } from './mcp-runtime.js'
import { createMcpOperationCoordinator } from './mcp-operation-coordinator.js'
import { createMcpInventoryProjection, partitionMcpInventory } from './mcp-inventory.js'
import { materializeMcpClientConfig } from './mcp-credentials.js'
import { hasMcpSecrets, redactMcpEntry, fingerprintMcpEntry } from './mcp-config.js'
import { createMcpProcessAdapter } from './mcp-process.js'
import { mcpDiagnostic, sanitizeMcpText } from './mcp-diagnostics.js'

const message = error => (error instanceof Error ? error.message : String(error))
const now = () => Date.now()

export function partitionMcpRows(rows, mounted, registryServers, ownership = mcpMountOwnership) {
  return partitionMcpInventory(rows, mounted, registryServers, { isResidue: isMcpResidueId, groupPrefix: MCP_GROUP_PREFIX, ownership })
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
    let defaultLifecycleActive = true
    const lifecycle = dependencies.lifecycle ?? {
      snapshotFor(sessionId) {
        if (!defaultLifecycleActive) return null
        const owningLifecycle = lifecycleFeedRegistry.lifecycleFor(face)
        return owningLifecycle?.snapshotFor?.(sessionId) ?? null
      },
    }
    const runtime = dependencies.runtime ?? createMcpRuntime()
    const drain = dependencies.drain ?? createMcpDrain({ timeoutMs: config.drainTimeoutMs ?? 30_000 })
    const coordinator = createMcpOperationCoordinator({ runtime, drain, transition: transitionRuntime })
    const { serialize, beginOperation, finishOperation, abortOperation } = coordinator
    const gate = dependencies.gate ?? createMcpGate({ registry, lifecycle, runtime, registrationFor: runtime.registrationFor })
    const loader = dependencies.loader ?? ctx.get?.('loader')
    const ownership = dependencies.ownership ?? mcpMountOwnership
    const defaultHostRows = () => [...(loader?.entries?.() ?? [])].map(entry => ({ id: entry?.options?.id ?? entry?.id ?? null, name: entry?.options?.name ?? null, config: entry?.options?.config ?? {} }))
    const startErrors = []
    /** A strict mount of this identity supersedes its earlier start/mount failures. */
    const clearStartErrors = identity => {
      for (let index = startErrors.length - 1; index >= 0; index -= 1) if (startErrors[index].identity === identity) startErrors.splice(index, 1)
    }
    const onError = (reason, cause) => ctx.logger?.warn?.(sanitizeMcpText(`${reason}${cause ? `: ${message(cause)}` : ''}`))
    const owningTree = ctx.fiber?.entry?.parent?.tree ?? null
    const scopedTree = owningTree ? resolveScopedMcpTree(owningTree) : undefined
    const defaultFiberOf = async (groupId, context = {}) => {
      const tree = context.tree ?? mount.treeForGroup?.(groupId)
      const resolve = tree?.resolve ?? (id => loader?.resolve?.(id))
      for (const candidate of [`${groupId}:${groupId}-client`, `${groupId}-client`]) {
        let entry = null
        try { entry = resolve?.(candidate) } catch { /* next shape */ }
        if (entry?.fiber) {
          await entry.fiber.await()
          return { state: 'running' }
        }
      }
      return null
    }
    const mount = dependencies.mount ?? createMcpMount({
      loader, onError, ownership,
      startupTimeoutMs: config.startupTimeoutMs ?? 15_000,
      cleanupTimeoutMs: config.cleanupTimeoutMs ?? 15_000,
      ...(scopedTree !== undefined ? { ephemeralTree: scopedTree } : {}),
    })
    const fiberOf = dependencies.fiberOf ?? defaultFiberOf
    const listRows = dependencies.listRows ?? (() => [...defaultHostRows(), ...(mount.listRows?.() ?? [])])
    const listEntryIds = dependencies.listEntryIds ?? (() => listRows().map(row => row.id).filter(Boolean))
    const processAdapter = dependencies.processAdapter ?? createMcpProcessAdapter({ subprocess: dependencies.subprocess ?? ctx.get?.('subprocess') })
    const credentialsFor = () => dependencies.credentials ?? ctx.get?.('credentials')
    const support = () => {
      const credentials = credentialsFor()
      return { credentials: typeof credentials?.set === 'function' && typeof credentials?.resolve === 'function', ephemeral: scopedTree?.kind === 'ok' || resolveEphemeralMcpTree(loader).kind === 'ok' }
    }
    const publicNames = new Map() // publicName → { identity, generation }
    const publicOwnerAttempts = new WeakMap() // plain public owner object → internal bridge attempt
    const bridges = new Map() // groupId → { identity, generation, release }
    const receipts = { mount: new Map(), test: new Map() }
    const host = {
      tools: dependencies.hostTools ?? ctx.get?.('tools'),
      systemPrompt: dependencies.hostSystemPrompt ?? ctx.get?.('systemPrompt'),
      mcpResources: dependencies.hostMcpResources ?? ctx.get?.('mcpResources'),
    }
    const agentsService = dependencies.agents ?? ctx.get?.('agents')
    const seenAgents = new Set() // compatibility fallback; actual agent objects, never session ids
    const restrictions = new Map() // agent → Map(publicName → { owner, dispose })

    const identityOf = owner => typeof owner === 'string' ? owner : owner?.identity
    const attemptOf = owner => owner && (typeof owner === 'object' || typeof owner === 'function') ? publicOwnerAttempts.get(owner) : null
    const sameOwner = (owner, identity, generation, attempt = null) => {
      const same = typeof owner === 'string'
        ? owner === identity // legacy test facts carried no generation
        : owner?.identity === identity && owner?.generation === generation
      return same && (!attempt || attemptOf(owner) === attempt)
    }
    const isAgent = agent => (typeof agent === 'object' && agent !== null) || typeof agent === 'function'
    function rememberAgent(agent) {
      if (!isAgent(agent)) return null
      seenAgents.add(agent)
      return agent
    }
    function liveAgents() {
      if (typeof agentsService?.list !== 'function') return [...seenAgents]
      const listed = agentsService.list()
      if (!Array.isArray(listed)) throw new TypeError('agents.list() must return an array')
      for (const agent of listed) rememberAgent(agent)
      return listed
    }

    /**
     * Reconcile only actual differences. Every held entry owns exactly one
     * independent deny disposer; absent public names never reach restrict().
     */
    function reconcileAgent(agent, matches = () => true, added = null) {
      if (!isAgent(agent)) return
      let held = restrictions.get(agent)
      const names = new Set()
      for (const [name, owner] of publicNames) if (matches(name, owner)) names.add(name)
      for (const [name, record] of held ?? []) if (matches(name, record.owner)) names.add(name)
      let failure = null
      for (const name of names) {
        try {
          const present = publicNames.has(name)
          const owner = publicNames.get(name)
          const existing = held?.get(name)
          const definition = attemptOf(owner)?.definitions?.get(name)
          let foreignDefinition = false
          if (owningTree && definition && (!existing || existing.owner !== owner) && typeof host.tools?.get === 'function') {
            try { foreignDefinition = host.tools.get(name, agent) !== definition } catch { /* fail closed through the normal gate deny */ }
          }
          const shouldDeny = present && !foreignDefinition && !gate.enabledFor(agent, identityOf(owner))
          if (shouldDeny && !existing) {
            const restrict = agent?.ctx?.tools?.restrict
            if (typeof restrict !== 'function') throw new Error(`cannot restrict MCP tool "${name}" without agent tools`)
            const disposer = restrict.call(agent.ctx.tools, { deny: [name] })
            if (!held) {
              held = new Map()
              restrictions.set(agent, held)
            }
            const record = { owner, dispose: typeof disposer === 'function' ? disposer : null }
            held.set(name, record)
            added?.push({ agent, name, record })
          } else if (!shouldDeny && existing) {
            existing.dispose?.()
            held.delete(name)
          } else if (shouldDeny && existing) {
            // A replacement may reuse the public name. Keep the exact deny and
            // update only its ownership metadata; never dispose/recreate it.
            existing.owner = owner
          }
        } catch (cause) {
          failure ??= cause
        }
      }
      if (held?.size === 0) restrictions.delete(agent)
      if (failure) throw failure
    }

    function reconcileAgents(matches, added = null) {
      let failure = null
      for (const agent of liveAgents()) {
        try { reconcileAgent(agent, matches, added) } catch (cause) { failure ??= cause }
      }
      if (failure) throw failure
    }
    const syncName = (name, added = null) => reconcileAgents(candidate => candidate === name, added)
    const syncIdentity = identity => reconcileAgents((_name, owner) => identityOf(owner) === identity)

    function syncSession(sessionId) {
      let agent
      if (typeof agentsService?.get === 'function') agent = agentsService.get(sessionId)
      else agent = [...seenAgents].find(candidate => candidate?.session?.id === sessionId)
      if (rememberAgent(agent)) reconcileAgent(agent)
    }

    function registerPublicName(name, identity, generation, captureRollback, attempt = null, definition = null) {
      const hadPrevious = publicNames.has(name)
      const previous = publicNames.get(name)
      const attempted = { identity, generation }
      // Preserve the public {identity,generation} shape while binding exact
      // attempt identity for same-generation concurrent/stale cleanup.
      if (attempt) publicOwnerAttempts.set(attempted, attempt)
      if (attempt && definition) attempt.definitions.set(name, definition)
      const previousDenies = []
      for (const [agent, held] of restrictions) {
        const record = held.get(name)
        if (record) previousDenies.push({ agent, record, owner: record.owner })
      }
      const added = []
      publicNames.set(name, attempted)
      captureRollback?.(() => {
        // Object identity distinguishes attempts even within one generation.
        // A newer owner must never be overwritten by a stale Host rollback.
        if (publicNames.get(name) !== attempted) return
        let failure = null
        const fail = cause => {
          failure ??= cause
          onError(`mcp-schema-rollback-failed:${name}`, cause)
        }
        if (hadPrevious) publicNames.set(name, previous)
        else publicNames.delete(name)

        // Recreate denies removed by the failed sync before reusing surviving
        // records, then dispose only denies introduced by this attempt.
        for (const { agent, owner } of previousDenies) {
          if (restrictions.get(agent)?.has(name)) continue
          try {
            const restrict = agent?.ctx?.tools?.restrict
            if (typeof restrict !== 'function') throw new Error(`cannot restrict MCP tool "${name}" without agent tools`)
            const disposer = restrict.call(agent.ctx.tools, { deny: [name] })
            let held = restrictions.get(agent)
            if (!held) {
              held = new Map()
              restrictions.set(agent, held)
            }
            held.set(name, { owner, dispose: typeof disposer === 'function' ? disposer : null })
          } catch (cause) { fail(cause) }
        }
        for (const { agent, record, owner } of previousDenies) {
          if (restrictions.get(agent)?.get(name) === record) record.owner = owner
        }
        for (const { agent, record } of added.reverse()) {
          const held = restrictions.get(agent)
          if (held?.get(name) !== record) continue
          try {
            record.dispose?.()
            if (held.get(name) === record) held.delete(name)
            if (held.size === 0) restrictions.delete(agent)
          } catch (cause) { fail(cause) }
        }
        if (failure) throw failure
      })
      // Until confirmed Host disposal, retain the attempted owner and every
      // partial deny. The facade invokes only this transaction's rollback.
      syncName(name, added)
    }

    function unregisterPublicName(name, identity, generation, attempt = null) {
      if (!sameOwner(publicNames.get(name), identity, generation, attempt)) return false
      publicNames.delete(name)
      try { syncName(name) } catch (cause) { onError(`mcp-schema-cleanup-failed:${name}`, cause) }
      return true
    }

    function disposeAgentRestrictions(agent, { onlyAbsent = false } = {}) {
      const held = restrictions.get(agent)
      if (!held) return
      for (const [name, record] of held) {
        if (onlyAbsent && publicNames.has(name)) continue
        try {
          record.dispose?.()
          held.delete(name)
        } catch (cause) {
          // Cleanup is fail-closed: an unconfirmed disposer stays owned here.
          onError(`mcp-schema-dispose-failed:${name}`, cause)
        }
      }
      if (held.size === 0) restrictions.delete(agent)
    }

    function releaseBridge(groupId, expected) {
      const bridge = bridges.get(groupId)
      if (!bridge || !expected || bridge !== expected) return false
      bridges.delete(groupId)
      for (const [name, owner] of [...publicNames]) {
        if (sameOwner(owner, bridge.identity, bridge.generation, bridge)) unregisterPublicName(name, bridge.identity, bridge.generation, bridge)
      }
      bridge.release()
      bridge.definitions.clear()
      return true
    }
    function registerBridge(groupId, identity, generation, owner = null) {
      if (bridges.has(groupId)) throw Object.assign(new Error(`MCP manager group ${groupId} already has a bridge`), { code: 'duplicate-mcp-facade-owner' })
      const record = { groupId, identity, generation, owner, release: null, definitions: new Map() }
      const release = registerMcpFacadeBridge(groupId, {
        host, identity, generation,
        admit: agent => gate.permit(agent, identity, generation),
        assertPermit: gate.assertPermit,
        isEnabledFor: agent => gate.enabledFor(agent, identity),
        drain,
        onRegister: (name, captureRollback, definition) => registerPublicName(name, identity, generation, captureRollback, record, definition),
        onUnregister: name => unregisterPublicName(name, identity, generation, record),
        onError,
      }, owner ?? record)
      record.release = release
      bridges.set(groupId, record)
      return record
    }
    function discoveryFor(identity, generation, attempt = null) {
      const currentGroup = mount.mounted.get(identity)?.groupId ?? null
      const names = [...publicNames.entries()].filter(([, owner]) => {
        if (owner.identity !== identity || owner.generation !== generation) return false
        if (attempt) return attemptOf(owner) === attempt
        return !attemptOf(owner) || attemptOf(owner).groupId === currentGroup
      }).map(([name]) => name).sort()
      return { toolCount: names.length, toolNamesPreview: names.slice(0, 20), truncated: names.length > 20 }
    }

    /** Every manager-owned runtime mutation converges visibility after the actual state change. */
    function transitionRuntime(identity, change) {
      const before = runtime.snapshot(identity)
      const result = change()
      const after = runtime.snapshot(identity)
      const changed = before.phase !== after.phase || before.generation !== after.generation
        || (before.incarnation ?? null) !== (after.incarnation ?? null) || before.operationId !== after.operationId
      if (changed) {
        try { syncIdentity(identity) } catch (cause) { onError(`mcp-visibility-sync-failed:${identity}`, cause) }
      }
      return result
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

    function reconcileOne(identity, entry, suppliedToken = null) {
      if (suppliedToken !== null) return reconcileFenced(identity, entry, suppliedToken)
      return serialize(identity, () => reconcileFenced(identity, entry, beginOperation(identity)))
    }
    async function reconcileFenced(identity, entry, token) {
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
          const previousMount = mount.mounted.get(identity)
          const previousBridge = bridges.get(previousMount.groupId) ?? null
          const afterCleanup = () => releaseBridge(previousMount.groupId, previousBridge)
          const removed = await mount.unmount(identity, {}, { afterCleanup })
          if (removed.status !== 'cleaned') {
            finishOperation(token, removed.status, { generation: entry.generation, incarnation: entry.incarnation ?? null })
            return { status: removed.status, identity, cleanup: removed, saved: true }
          }
          // Legacy mount doubles do not consume context; exact compare-delete
          // makes this compatibility fallback harmless for the real mount.
          afterCleanup()
        }
        const prepared = await prepare(entry)
        let attempt = null
        const result = await mount.mount({
          identity,
          generation: entry.generation,
          client: prepared.client,
          secrets: prepared.secrets,
          secretBearing: prepared.secretBearing,
          execution: prepared.execution,
          fiberOf,
          beforeCreate: (context = {}) => {
            attempt = registerBridge(context.groupId ?? `${MCP_GROUP_PREFIX}${identity}`, identity, entry.generation, context.owner ?? null)
          },
          afterCleanup: (context = {}) => {
            if (attempt) releaseBridge(context.groupId ?? attempt.groupId, attempt)
          },
          discovery: () => discoveryFor(identity, entry.generation, attempt),
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
        if (!finishOperation(token, 'mounted', { generation: entry.generation, incarnation: entry.incarnation ?? null })) {
          const diagnostic = mcpDiagnostic(new Error(`MCP operation on ${identity} was superseded before it could report mounted`), { code: 'operation-superseded', action: 'reread-registry' })
          receipts.mount.set(identity, { time: now(), status: 'indeterminate', diagnostic })
          return { status: 'indeterminate', identity, generation: entry.generation, incarnation: entry.incarnation ?? null, saved: true, error: diagnostic, mount: { state: 'superseded', observedGeneration: observed.generation }, next: { action: 'reread-registry' } }
        }
        clearStartErrors(identity)
        const receipt = { time: now(), status: 'mounted', generation: entry.generation, discovery: result.discovery }
        receipts.mount.set(identity, receipt)
        return { status: 'mounted', identity, generation: entry.generation, incarnation: entry.incarnation ?? null, mount: { state: 'mounted', observedGeneration: observed.generation }, discovery: result.discovery, execution: result.execution ?? null }
      } catch (cause) {
        const cleanupStatus = ['cleanup-failed', 'cleanup-unknown'].includes(cause?.status) ? cause.status : null
        const status = cleanupStatus ?? (cause?.code === 'unsupported' ? 'unsupported' : 'saved-degraded')
        finishOperation(token, cleanupStatus ?? 'saved-degraded', { generation: entry.generation, incarnation: entry.incarnation ?? null })
        const diagnostic = mcpDiagnostic(cause, { code: cause?.code, action: cleanupStatus ? 'recover-residue' : 'retry' })
        receipts.mount.set(identity, { time: now(), status, diagnostic })
        startErrors.push({ identity, reason: diagnostic.message })
        onError(`mcp-mount-${status}:${identity}`, cause)
        return { status, identity, generation: entry.generation, incarnation: entry.incarnation ?? null, saved: true, error: diagnostic, mount: { state: cleanupStatus ?? 'degraded' }, next: { action: cleanupStatus ? 'recover-residue' : 'retry-or-edit' } }
      }
    }

    function removeRuntime(identity, suppliedToken = null) {
      if (suppliedToken !== null) return removeRuntimeFenced(identity, suppliedToken)
      return serialize(identity, () => removeRuntimeFenced(identity, beginOperation(identity, 'removing')))
    }
    async function removeRuntimeFenced(identity, token) {
      try {
        await waitForDrain(identity)
        const mountedRecord = mount.mounted.get(identity) ?? null
        const groupId = mountedRecord?.groupId ?? null
        const bridge = groupId ? bridges.get(groupId) ?? null : null
        const afterCleanup = () => { if (groupId) releaseBridge(groupId, bridge) }
        const cleanup = await mount.unmount(identity, {}, { afterCleanup })
        if (cleanup.status !== 'cleaned') {
          finishOperation(token, cleanup.status)
          return { status: cleanup.status, identity, cleanup, error: cleanup.diagnostic, next: { action: 'recover-residue' } }
        }
        afterCleanup()
        finishOperation(token, 'unknown', { generation: null, incarnation: null })
        return { status: 'removed', identity, removed: true }
      } catch (cause) {
        const status = cause?.code === 'cleanup-timeout' ? 'cleanup-unknown' : 'cleanup-failed'
        finishOperation(token, status)
        return { status, identity, error: mcpDiagnostic(cause, { code: status, action: 'recover-residue' }), next: { action: 'recover-residue' } }
      }
    }

    async function probe(entry, { targetIdentity = entry.identity } = {}) {
      let attempt = null
      try {
        const prepared = await prepare(entry)
        const result = await mount.probe({
          identity: undefined,
          generation: 0,
          client: prepared.client,
          secretBearing: prepared.secretBearing,
          secrets: prepared.secrets,
          fiberOf,
          beforeCreate: (context = {}) => {
            attempt = registerBridge(context.groupId ?? `${MCP_GROUP_PREFIX}probe`, context.identity ?? 'probe', context.generation ?? 0, context.owner ?? null)
          },
          afterCleanup: (context = {}) => {
            if (attempt) releaseBridge(context.groupId ?? attempt.groupId, attempt)
          },
          discovery: context => discoveryFor(context?.identity ?? attempt?.identity ?? 'probe', context?.generation ?? 0, attempt),
        })
        const outcome = { status: result.status, identity: targetIdentity, discovery: result.discovery, cleanup: result.cleanup }
        // Receipts share one shape with lastMount: the row reads `diagnostic`.
        receipts.test.set(targetIdentity, { time: now(), status: outcome.status, discovery: outcome.discovery, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) })
        return outcome
      } catch (cause) {
        const status = ['cleanup-failed', 'cleanup-unknown'].includes(cause?.status) ? cause.status : 'probe-failed'
        const outcome = { status, identity: targetIdentity, error: mcpDiagnostic(cause, { code: cause?.code ?? status }), cleanup: cause?.cleanup }
        receipts.test.set(targetIdentity, { time: now(), status, diagnostic: outcome.error })
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
        const result = await reconcileOne(entry.identity, entry)
        if (result.status === 'mounted') mountedCount += 1
        else if (result.status !== 'saved-degraded') startErrors.push({ identity: entry.identity, reason: result.status })
      }
      return { mounted: mountedCount }

    }
    const healthy = (identity, state = runtime.snapshot(identity)) => state?.phase === 'mounted' && mount.mounted.has(identity)
      && (mount.mounted.get(identity)?.state ?? 'mounted') === 'mounted'

    async function sweepRecoveryGroups(groupIds) {
      const expected = new Map(groupIds.map(groupId => [groupId, bridges.get(groupId) ?? null]))
      const afterCleanup = ({ groupId }) => {
        const bridge = expected.get(groupId)
        if (bridge) releaseBridge(groupId, bridge)
      }
      if (typeof mount.sweepResidueDetailed === 'function') {
        return mount.sweepResidueDetailed(groupIds, { afterCleanup })
      }
      const swept = await mount.sweepResidue(groupIds)
      for (const groupId of swept) afterCleanup({ groupId })
      return { swept, blocked: groupIds.filter(id => !swept.includes(id)), foreign: [], unresolved: [] }
    }

    function residueIdentity(groupId) {
      if (typeof mount.identityForGroup === 'function') return mount.identityForGroup(groupId)?.identity ?? null
      return isMcpResidueId(groupId) ? groupId.slice(MCP_GROUP_PREFIX.length) : null
    }

    function residueGroups(identity) {
      const listed = listEntryIds().filter(isMcpResidueId).filter(groupId => residueIdentity(groupId) === identity)
      for (const [groupId, bridge] of bridges) if (bridge.identity === identity) listed.push(groupId)
      return [...new Set(listed)]
    }

    /** Recover one identity inside its queue slot using exact actual group IDs. */
    function recoverOne(identity, assertOwner) {
      return serialize(identity, async () => {
        // Ownership can still reject a queued no-op without touching admission.
        // Once recovery is fenced, the fence precedes its identity reread.
        if (assertOwner) await assertOwner('recover-cleanup')
        const token = beginOperation(identity)
        let terminal = false
        try {
          const current = await registry.read()
          if (current.kind !== 'ok' && current.kind !== 'absent') {
            terminal = true
            abortOperation(token)
            return { status: 'unavailable', identity, skipped: current.kind }
          }
          const entry = current.kind === 'ok' ? current.servers[identity] ?? null : null
          if (entry && healthy(identity, token.previous)) {
            terminal = true
            abortOperation(token)
            return { status: 'mounted', identity, generation: entry.generation, alreadyHealthy: true }
          }
          const groups = residueGroups(identity)
          if (!entry) {
            // Only own or synchronously claimed inactive residue is swept. A
            // foreign active group is retained and never reported as removed.
            const detail = groups.length > 0 ? await sweepRecoveryGroups(groups) : { swept: [], blocked: [], foreign: [], unresolved: [] }
            const cleaned = detail.blocked.length === 0 && detail.unresolved.length === 0 && detail.foreign.length === 0
            terminal = true
            finishOperation(token, cleaned ? 'unknown' : 'cleanup-failed', { generation: null, incarnation: null })
            return cleaned
              ? { status: 'removed', identity, swept: groups.length > 0 }
              : { status: 'cleanup-failed', identity, error: mcpDiagnostic(new Error(`residue Loader group(s) for ${identity} could not be safely removed`), { code: 'cleanup-failed', action: 'recover-residue' }), next: { action: 'recover-residue' } }
          }
          // A tracked failed mount is unmounted by reconcileOne using its actual
          // ID. Only untracked groups are residue candidates here; foreign active
          // groups are skipped and do not become this manager's mount evidence.
          if (!mount.mounted.has(identity) && groups.length > 0) {
            const detail = await sweepRecoveryGroups(groups)
            if (detail.blocked.length > 0 || detail.unresolved.length > 0) {
              terminal = true
              finishOperation(token, 'cleanup-failed', { generation: entry.generation, incarnation: entry.incarnation ?? null })
              const diagnostic = mcpDiagnostic(new Error(`owned residue Loader group(s) for ${identity} could not be removed`), { code: 'cleanup-failed', action: 'recover-residue' })
              receipts.mount.set(identity, { time: now(), status: 'cleanup-failed', diagnostic })
              return { status: 'cleanup-failed', identity, generation: entry.generation, saved: true, error: diagnostic, next: { action: 'recover-residue' } }
            }
          }
          if (assertOwner) {
            try { await assertOwner('mount') } catch (cause) {
              terminal = true
              finishOperation(token, 'unknown', { generation: entry.generation, incarnation: entry.incarnation ?? null })
              throw cause
            }
          }
          terminal = true // reconcileFenced owns every transition from here.
          return reconcileOne(identity, entry, token)
        } catch (cause) {
          if (!terminal) abortOperation(token)
          throw cause
        }
      })
    }

    /**
     * Residue recovery (user-triggered via the capabilities command verb
     * mcp-recover, the mcp mutation action 'recover' and the panel's Recover
     * row action). Healthy mounted identities are never touched; every other
     * registered identity is strictly remounted and every orphan residue row is
     * removed. `identity` scopes the work to one server. The optional owner
     * callback runs inside every queue slot before cleanup and before remount.
     */
    async function recoverResidue({ identity = null, assertOwner = null } = {}) {
      const current = await registry.read()
      if (current.kind !== 'ok' && current.kind !== 'absent') return { status: 'unavailable', skipped: current.kind, results: [] }
      const servers = current.kind === 'ok' ? current.servers : {}
      const orphans = listEntryIds().filter(isMcpResidueId).map(residueIdentity).filter(id => id && !servers[id])
      let candidates = [...new Set([...Object.keys(servers).filter(id => !healthy(id)), ...orphans])]
      if (identity !== null) candidates = candidates.filter(id => id === identity)
      const results = []
      for (const id of candidates) {
        try { results.push(await recoverOne(id, assertOwner)) } catch (cause) {
          if (!assertOwner || cause?.code !== 'owner-changed') throw cause
          const recovered = results.filter(result => result.status === 'mounted' || result.status === 'removed').length
          return {
            status: 'owner-changed', recovered, results,
            error: mcpDiagnostic(cause, { code: 'owner-changed', action: 'inspect-actual-state' }),
            next: { action: 'inspect-actual-state' },
          }
        }
      }
      const recovered = results.filter(result => result.status === 'mounted' || result.status === 'removed').length
      return { status: recovered === results.length ? 'recovered' : 'recovery-incomplete', recovered, results }
    }

    async function adopt(entry) {
      const holder = hostRowHoldingReservation(listRows(), entry.client?.serverName ?? entry.transport?.serverName ?? entry.identity)
      if (holder) return { status: 'conflict', reason: `host row "${holder.id ?? entry.identity}" still holds the serverName reservation — disable it in the host configuration; the managed client mounts afterwards. Until then the server stays unmanaged.` }
      return serialize(entry.identity, async () => {
        const token = beginOperation(entry.identity)
        try {
          const current = await registry.read()
          const revision = current.kind === 'ok' ? current.revision : 0
          const registered = await registry.register(entry, revision)
          if (registered.status !== 'committed') { abortOperation(token); return { status: 'registry-failed', result: registered.status } }
          const latest = await registry.read()
          return reconcileOne(entry.identity, latest.servers[entry.identity], token)
        } catch (cause) {
          abortOperation(token)
          throw cause
        }
      })
    }

    function agentCreated(payload) {
      const agent = rememberAgent(payload?.agent)
      if (!agent) return
      // Creation remains non-throwing for visibility failures; admission is an
      // independent hard gate. Registration itself uses the throwing path so
      // its facade transaction can roll back.
      try { reconcileAgent(agent) } catch (cause) { onError('mcp-schema-restrict-failed', cause) }
    }
    function agentDisposed(payload) {
      const agent = payload?.agent
      if (!isAgent(agent)) return
      // Object identity is load-bearing: a delayed disposal from an old
      // incarnation must never clean the replacement agent of the same session.
      seenAgents.delete(agent)
      disposeAgentRestrictions(agent)
    }
    ctx.on?.('agent/created', payload => { agentCreated(payload) })
    ctx.on?.('agent/disposed', payload => { agentDisposed(payload) })

    const inventory = createMcpInventoryProjection({
      registry, runtime, mounted: mount.mounted, receipts, listRows, startErrors,
      discoveryFor, support, isResidue: isMcpResidueId, groupPrefix: MCP_GROUP_PREFIX, ownership,
      holdsReservation: hostRowHoldingReservation,
      redactEntry: redactMcpEntry, fingerprintEntry: fingerprintMcpEntry,
    })
    const list = () => inventory.list()

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
      list, syncSession,
      publicNames,
      mounted: mount.mounted,
      beginOperation, abortOperation, reconcileOne, removeRuntime, probe,
      remove: identity => removeRuntime(identity),
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
    // Bootstrap only after face publication so revision-local agent ownership
    // can resolve the exact manager rather than observing an empty service.
    if (typeof agentsService?.list === 'function') {
      try { liveAgents() } catch (cause) { onError('mcp-agent-bootstrap-failed', cause) }
    }
    void Promise.resolve().then(() => face.start()).catch(cause => {
      startErrors.push({ identity: null, reason: `start-failed:${message(cause)}` })
      onError('mcp-manager-start-failed', cause)
    })
    return () => {
      defaultLifecycleActive = false
      try { ctx.reflect?.provide?.('weirMcpGate', { admit: async () => false, permit: async () => null, assertPermit: () => false, enabledFor: () => false, drain }) } catch { /* best effort */ }
      // Child-group disposal normally unregisters tools first. If any public
      // fact remains, unregistration was not confirmed: KEEP its deny instead
      // of exposing a still-registered tool during manager teardown.
      for (const agent of [...restrictions.keys()]) disposeAgentRestrictions(agent, { onlyAbsent: true })
    }
  }
}

export const name = 'weir-mcp-manager'
export const inject = ['loader', 'tools', 'systemPrompt', 'mcpResources', 'agents']
export const apply = createMcpManager()
export const __message = message
