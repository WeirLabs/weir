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
    } else if (row?.name === '@deepseek-ai/dsh-mcp-client' && !(typeof row.id === 'string' && row.id.startsWith(MCP_GROUP_PREFIX))) {
      // Stock client rows OUTSIDE our groups: host-configured, ACP-mounted
      // or other presets' servers — listed, never closable (8.8).
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
    // The selection face is resolved LAZILY on every gate verdict: mount
    // order inside one apply batch is not contractual (sibling rows import
    // concurrently), so a face captured here can be a permanently-null
    // fallback that refuses every managed call. Late arrival must converge
    // exactly like the intent-gate route override (rc.2 lesson).
    const lifecycle = dependencies.lifecycle ?? {
      snapshotFor: sessionId => skillSelectionFor(ctx)?.lifecycle?.snapshotFor(sessionId) ?? null,
    }
    const gate = dependencies.gate ?? createMcpGate({ registry, lifecycle })
    const drain = dependencies.drain ?? createMcpDrain({ timeoutMs: config.drainTimeoutMs ?? 30_000 })
    // The loader store is the flat id → entry map of every activated row
    // (CITED 1.14 manager usage); options carry each row's name/config.
    // Loader extends EntryTree (CITED): entries() walks static rows AND
    // nested subtrees; the store holds runtime-created entries only.
    const defaultListRows = () => [...(loader?.entries?.() ?? [])].map(entry => ({
      id: entry?.options?.id ?? null,
      name: entry?.options?.name ?? null,
      config: entry?.options?.config ?? {},
    }))
    const listEntryIds = dependencies.listEntryIds ?? (() => defaultListRows().map(row => row.id).filter(Boolean))
    const listRows = dependencies.listRows ?? defaultListRows
    const onError = (reason, cause) => ctx.logger?.warn?.(`${reason}${cause ? `: ${message(cause)}` : ''}`)

    const loader = dependencies.loader ?? ctx.get?.('loader')
    // Readiness by the child client's fiber after loader.await() (1.14
    // must-fix): a group child resolves as '<group>-client' in the tree.
    const defaultFiberOf = async groupId => {
      // Readiness the 1.14 way: resolve the client entry, then AWAIT its own
      // fiber lifecycle — a group child whose connection never comes up or
      // whose activation errored surfaces HERE, not as a blind success.
      for (const candidate of [`${groupId}:${groupId}-client`, `${groupId}-client`]) {
        let entry = null
        try {
          entry = loader?.resolve?.(candidate)
        } catch { /* try the next shape */ }
        if (entry?.fiber) {
          try {
            if (typeof entry.fiber.await === 'function') await entry.fiber.await()
            return { state: 'running' }
          } catch (cause) {
            startErrors.push({ identity: null, reason: `fiber-await-failed:${groupId}:${message(cause)}` })
            return null
          }
        }
      }
      return null
    }
    const mount = dependencies.mount ?? createMcpMount({ loader, onError })
    const fiberOf = dependencies.fiberOf ?? defaultFiberOf
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
    try { ctx.reflect?.provide?.('weirMcpGate', gateFace) } catch { /* an older row already provides it */ }

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
        await mount.mount({ identity, generation, client: entry.client ?? entry.transport, fiberOf })
        // A fiber is not health: the stock client may carry an activation
        // error (bad import, failed connect). Surface it like the 1.14
        // entryState check instead of reporting a blind success.
        const clientEntry = loader?.store?.[`${groupId}-client`]
        if (clientEntry?.error) {
          throw new Error(`mcp client entry error for "${identity}": ${message(clientEntry.error)}`)
        }
      } catch (cause) {
        release()
        throw cause
      }
      return { groupId, release }
    }

    /** Startup: sweep residue, then mount every registered server. */
    async function start() {
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
        try {
          await mountOne(entry.identity, entry)
          mountedCount += 1
        } catch (cause) {
          startErrors.push({ identity: entry.identity, reason: message(cause) })
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

    /** Visible startup/mount errors (manager UI + probes). */
    const startErrors = []
    const face = {
      start,
      startErrors,
      adopt,
      gate: gateFace,
      drain,
      registry,
      list: () => partitionMcpRows(listRows(), mount.mounted, {}),
      publicNames,
      remove: identity => mount.unmount(identity, dependencies.unmountGuards),
    }
    try { ctx.reflect?.provide?.('weirMcpManager', face) } catch { /* older row */ }

    // Startup mounting is fire-and-forget (like the 6.1 preload): a slow or
    // failed start only costs one visible error per server, never a broken
    // preset row.
    void Promise.resolve()
      .then(() => face.start())
      .catch(cause => {
        startErrors.push({ identity: null, reason: `start-failed:${message(cause)}` })
        onError('mcp-manager-start-failed', cause)
      })

    // Fail closed on the dispose/reload window (8.5): managed calls are
    // refused because the gate has no initialized authority anymore.
    return () => {
      try { ctx.reflect?.provide?.('weirMcpGate', { admit: async () => false, enabledFor: () => false, drain }) } catch { /* best effort */ }
    }
  }
}

export const name = 'weir-mcp-manager'
export const inject = ['loader', 'tools', 'systemPrompt', 'mcpResources']
export const apply = createMcpManager()
export const __message = message // test seam
