// Task 8.2/8.4/8.5/8.8/8.9 of the session-capability-manager change: the MCP
// manager row. It owns the registry-backed runtime mounts, the shared
// (agent, server) drain, the realm-visible gate the facades consume, the
// creation-time schema hiding, the managed/unmanaged listing and the
// explicit adopt flow. Host-configured, ACP-mounted and other presets'
// servers are UNMANAGED: listed, never given a close switch, never counted
// as closed (8.8).
import { openCapabilityStore } from './store/store.js'
import { createMcpRegistry } from './mcp-registry.js'
import { createMcpGate } from './mcp-gate.js'
import { createMcpDrain } from './mcp-drain.js'
import { createMcpMount, mcpGroupOptions, isMcpResidueId, detectMcpNameAmbiguity, MCP_GROUP_PREFIX } from './mcp-mount.js'
import { registerMcpFacadeBridge } from './mcp-facade-plugin.js'
import { skillSelectionFor } from './skill-selection-plugin.js'

const message = error => (error instanceof Error ? error.message : String(error))

/**
 * Managed vs unmanaged rows in a flat entry listing (8.8). A row is managed
 * when its group id carries our prefix; stock dsh-mcp-client rows anywhere
 * else are unmanaged.
 * @param {Array<{ id?: string, name?: string, config?: { serverName?: string } }>} rows
 * @param {Map<string, { groupId: string, generation: number }>} mounted
 * @param {Record<string, { label?: string, generation: number }>} registryServers
 */
export function partitionMcpRows(rows, mounted, registryServers) {
  const managed = []
  const unmanaged = []
  for (const row of rows) {
    if (typeof row?.id === 'string' && isMcpResidueId(row.id)) {
      const identity = row.id.slice(MCP_GROUP_PREFIX.length)
      const registry = registryServers[identity]
      managed.push({ identity, groupId: row.id, label: registry?.label ?? identity, generation: mounted.get(identity)?.generation ?? registry?.generation ?? null, state: mounted.has(identity) ? 'mounted' : 'registered' })
    } else if (row?.name === '@deepseek-ai/dsh-mcp-client') {
      unmanaged.push({ serverName: row.config?.serverName ?? row.id ?? 'unknown', state: 'unmanaged' })
    }
  }
  return { managed, unmanaged }
}

/**
 * The adopt-conflict decision (8.9): a same-named host row holds the
 * first-come serverName reservation, so mounting is ineffective until the
 * user disables it (1.14 S5a/S5b) — surface a conflict, never a success.
 * @param {Array<{ id?: string, name?: string, config?: { serverName?: string } }>} rows
 * @param {string} serverName
 */
export function hostRowHoldingReservation(rows, serverName) {
  return rows.find(row => row?.name === '@deepseek-ai/dsh-mcp-client' && row.config?.serverName === serverName
    && !(typeof row.id === 'string' && row.id.startsWith(MCP_GROUP_PREFIX))) ?? null
}

export function createMcpManager(dependencies = {}) {
  return (ctx, config = {}) => {
    const profileContext = ctx.get?.('profileContext')
    const store = dependencies.store ?? openCapabilityStore({ profileContext })
    const registry = dependencies.registry ?? createMcpRegistry({ store })
    const selection = skillSelectionFor(ctx)
    const lifecycle = dependencies.lifecycle ?? selection?.lifecycle ?? { snapshotFor: () => null }
    const gate = dependencies.gate ?? createMcpGate({ registry, lifecycle })
    const drain = dependencies.drain ?? createMcpDrain({ timeoutMs: config.drainTimeoutMs ?? 30_000 })
    const listEntryIds = dependencies.listEntryIds ?? (() => [])
    const listRows = dependencies.listRows ?? (() => [])
    const onError = (reason, cause) => ctx.logger?.warn?.(`${reason}${cause ? `: ${message(cause)}` : ''}`)

    const loader = dependencies.loader ?? ctx.get?.('loader')
    const mount = dependencies.mount ?? createMcpMount({ loader, onError })
    /** publicName → identity, fed by facade registrations (creation-time schema hiding + managed listing). */
    const publicNames = new Map()

    const host = {
      tools: dependencies.hostTools ?? ctx.get?.('tools'),
      systemPrompt: dependencies.hostSystemPrompt ?? ctx.get?.('systemPrompt'),
      mcpResources: dependencies.hostMcpResources ?? ctx.get?.('mcpResources'),
    }

    /** The realm-visible gate face (8.2): facades consume it from inside their groups. */
    const gateFace = {
      admit: (agent, identity, generation) => gate.admit(agent, identity, generation),
      enabledFor: (agent, identity) => gate.enabledFor(agent, identity),
      drain,
    }
    try { ctx.reflect?.provide?.('orreryMcpGate', gateFace) } catch { /* an older row already provides it */ }

    async function mountOne(identity, entry) {
      const generation = entry.generation
      const groupId = `${MCP_GROUP_PREFIX}${identity}`
      const release = registerMcpFacadeBridge(groupId, {
        host,
        identity,
        generation,
        admit: agent => gate.admit(agent, identity, generation),
        isEnabledFor: agent => gate.enabledFor(agent, identity),
        drain,
        onRegister: name => publicNames.set(name, identity),
        onError,
      })
      try {
        await mount.mount({ identity, generation, client: entry.client ?? entry.transport, fiberOf: dependencies.fiberOf })
      } catch (cause) {
        release()
        throw cause
      }
      return { groupId, release }
    }

    /** Startup: sweep residue, then mount every registered server. */
    async function start() {
      await mount.sweepResidue(listEntryIds())
      const current = await registry.read()
      if (current.kind !== 'ok') return { mounted: 0, skipped: current.kind }
      const ambiguity = detectMcpNameAmbiguity(Object.values(current.servers))
      if (ambiguity.kind === 'conflict') {
        onError(`mcp-name-ambiguity: ${ambiguity.conflicts.map(c => c.reason).join('; ')}`)
        return { mounted: 0, ambiguity }
      }
      let mountedCount = 0
      for (const entry of Object.values(current.servers)) {
        try {
          await mountOne(entry.identity, entry)
          mountedCount += 1
        } catch (cause) {
          onError(`mcp-mount-failed:${entry.identity}`, cause)
        }
      }
      return { mounted: mountedCount }
    }

    /**
     * Explicit adopt flow (8.9): never an automatic takeover. The identity is
     * registered first; a same-named host row still holding the reservation
     * makes the outcome a visible conflict (the user disables the host row,
     * then the managed client mounts), never a claimed success.
     */
    async function adopt(entry) {
      const current = await registry.read()
      const revision = current.kind === 'ok' ? current.revision : 0
      const registered = await registry.register(entry, revision)
      if (registered.status !== 'committed') return { status: 'registry-failed', result: registered.status }
      const holder = hostRowHoldingReservation(listRows(), entry.transport?.serverName ?? entry.identity)
      if (holder) {
        return {
          status: 'conflict',
          reason: `host row "${holder.id ?? entry.identity}" still holds the serverName reservation — disable it in the host configuration; the managed client mounts afterwards. Until then the server stays unmanaged.`,
        }
      }
      try {
        await mountOne(entry.identity, (await registry.read()).servers[entry.identity])
        return { status: 'mounted' }
      } catch (cause) {
        return { status: 'mount-failed', reason: message(cause) }
      }
    }

    /** Creation-time schema hiding (8.4③): per-agent deny of public names whose server is not accepted. */
    function agentCreated(payload) {
      const agent = payload?.agent
      if (publicNames.size === 0) return
      const deny = [...publicNames.entries()].filter(([, identity]) => !gate.enabledFor(agent, identity)).map(([name]) => name)
      if (deny.length > 0) {
        try { agent?.ctx?.tools?.restrict?.({ deny }) } catch (cause) { onError('mcp-schema-restrict-failed', cause) }
      }
    }
    ctx.on?.('agent/created', payload => { agentCreated(payload) })

    const face = {
      start,
      adopt,
      gate: gateFace,
      drain,
      registry,
      list: () => partitionMcpRows(listRows(), mount.mounted, {}),
      publicNames,
      remove: identity => mount.unmount(identity, dependencies.unmountGuards),
    }
    try { ctx.reflect?.provide?.('orreryMcpManager', face) } catch { /* older row */ }

    return {
      dispose() {
        // Fail closed on the dispose/reload window (8.5): managed calls are
        // refused because the gate has no initialized authority anymore.
        try { ctx.reflect?.provide?.('orreryMcpGate', { admit: async () => false, enabledFor: () => false, drain }) } catch { /* best effort */ }
      },
    }
  }
}

export const name = 'orrery-mcp-manager'
export const inject = ['loader']
export const apply = createMcpManager()
export const __message = message // test seam
