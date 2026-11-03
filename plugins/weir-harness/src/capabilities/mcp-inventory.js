// The one read-only MCP Inventory Projection. Registry/runtime/mount/receipt and
// Loader facts are joined here; probing, mutation, credential resolution, agent
// visibility and every other operation remain with their existing owners.
// Pure dependencies keep this module independently testable and typechecked.
import { resolveMcpGroupIdentity } from './mcp-mount-ownership.js'

/**
 * Classify Loader rows once and retain the facts needed by both public views.
 * Every actual group remains a separate fact; same-identity groups never
 * overwrite each other in an identity-keyed Map.
 *
 * @param {any[]} rows
 * @param {Map<string, any>} mounted
 * @param {Record<string, any>} registryServers
 * @param {{ isResidue: (id: string) => boolean, groupPrefix: string, ownership?: any }} options
 */
function joinLoaderRows(rows, mounted, registryServers, { isResidue, groupPrefix, ownership = null }) {
  const managed = []
  const unmanaged = []
  for (const row of rows) {
    if (typeof row?.id === 'string' && isResidue(row.id)) {
      const resolved = resolveMcpGroupIdentity({ groupId: row.id, mounted, ownership, row })
      // Unresolved generated suffixes are conservative residue, not evidence
      // from which a logical registry identity or mount health may be invented.
      if (!resolved) continue
      managed.push({
        identity: resolved.identity,
        groupId: row.id,
        registry: registryServers[resolved.identity],
        isMounted: resolved.mount != null,
        mount: resolved.mount,
        source: resolved.source,
        allocation: resolved.allocation,
      })
    } else if (row?.name === '@deepseek-ai/dsh-mcp-client' && !(typeof row.id === 'string' && row.id.startsWith(groupPrefix))) {
      unmanaged.push({ serverName: row.config?.serverName ?? row.id ?? 'unknown', state: 'unmanaged', readOnly: true })
    }
  }
  return { managed, unmanaged }
}

/**
 * Internal implementation behind mcp-manager.js's exported partitionMcpRows.
 * Its field selection is the historical compatibility contract; production
 * manager.list() uses the same Loader join and the full projection below.
 *
 * @param {any[]} rows
 * @param {Map<string, any>} mounted
 * @param {Record<string, any>} registryServers
 * @param {{ isResidue: (id: string) => boolean, groupPrefix: string, ownership?: any }} options
 */
export function partitionMcpInventory(rows, mounted, registryServers, options) {
  const joined = joinLoaderRows(rows, mounted, registryServers, options)
  return {
    managed: joined.managed.map(fact => ({
      identity: fact.identity,
      groupId: fact.groupId,
      label: fact.registry?.label ?? fact.identity,
      generation: fact.mount?.generation ?? fact.registry?.generation ?? null,
      state: fact.isMounted ? 'mounted' : 'registered',
    })),
    unmanaged: joined.unmanaged,
  }
}

/**
 * @param {{
 *   registry: { read: () => Promise<any> },
 *   runtime: { snapshot: (identity: string) => any },
 *   mounted: Map<string, any>,
 *   receipts: { mount: Map<string, any>, test: Map<string, any> },
 *   listRows: () => any[],
 *   startErrors: Array<{ identity: string | null, reason: string }>,
 *   discoveryFor: (identity: string, generation: any) => any,
 *   support: () => any,
 *   isResidue: (id: string) => boolean,
 *   groupPrefix: string,
 *   ownership?: any,
 *   holdsReservation: (rows: any[], serverName: any) => any,
 *   redactEntry: (entry: any) => any,
 *   fingerprintEntry: (entry: any) => string,
 * }} dependencies
 */
export function createMcpInventoryProjection(dependencies) {
  const {
    registry, runtime, mounted, receipts, listRows, startErrors,
    discoveryFor, support, isResidue, groupPrefix, ownership = null, holdsReservation,
    redactEntry, fingerprintEntry,
  } = dependencies

  async function list() {
    const current = await registry.read()
    const rows = listRows()
    const registryServers = current.kind === 'ok' ? current.servers : {}
    const loader = joinLoaderRows(rows, mounted, registryServers, { isResidue, groupPrefix, ownership })
    if (current.kind === 'absent') {
      return { managed: [], unmanaged: loader.unmanaged, warnings: [], registryRevision: 0, capabilities: support() }
    }
    if (current.kind !== 'ok') {
      return { managed: [], unmanaged: loader.unmanaged, unavailable: { status: current.kind }, registryRevision: current.revision ?? 0, capabilities: support() }
    }

    // Registry authority starts the full view. Join every actual Loader group,
    // then select only this manager's exact own mount as mounted evidence.
    const loaderByIdentity = new Map()
    for (const fact of loader.managed) {
      const facts = loaderByIdentity.get(fact.identity) ?? []
      facts.push(fact)
      loaderByIdentity.set(fact.identity, facts)
    }
    const defaults = new Set(current.enabled)
    const managed = Object.values(current.servers).map(entry => {
      const phase = runtime.snapshot(entry.identity)
      const facts = loaderByIdentity.get(entry.identity) ?? []
      const ownMount = mounted.get(entry.identity) ?? null
      const ownLoaderFact = ownMount ? facts.find(fact => fact.groupId === ownMount.groupId) : null
      // Some supported bare/test compositions expose no Loader listing. Keep
      // their existing mount readback, but never let a different actual group
      // satisfy this manager's strict mount evidence.
      const mountedRecord = ownMount && (facts.length === 0 || ownLoaderFact) ? ownMount : null
      const isMounted = phase.phase === 'mounted' && phase.generation === entry.generation && mountedRecord?.generation === entry.generation
      const holder = holdsReservation(rows, entry.client?.serverName ?? entry.identity)
      const state = holder ? 'conflict' : isMounted ? 'mounted' : phase.phase === 'saved-degraded' ? 'degraded' : ['cleanup-failed', 'cleanup-unknown'].includes(phase.phase) ? phase.phase : 'registered'
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
        statusSource: isMounted ? 'registry-runtime-mount-readback' : holder ? 'serverName-reservation' : 'registry-runtime',
        runtimePhase: phase.phase,
        discovery: isMounted ? discovery : { toolCount: null, toolNamesPreview: [], truncated: false },
        lastMount: receipts.mount.get(entry.identity) ?? null,
        lastTest: receipts.test.get(entry.identity) ?? null,
        startErrors: startErrors.filter(error => error.identity === entry.identity).map(error => ({ reason: error.reason })),
        liveReconnect: 'unknown',
        processExit: 'unknown',
        stderr: 'unknown',
        readOnly: false,
        config: redactEntry(entry),
        fingerprint: fingerprintEntry(entry),
      }
    })
    return { managed, unmanaged: loader.unmanaged, warnings: current.warnings, registryRevision: current.revision, capabilities: support() }
  }

  return { list }
}
