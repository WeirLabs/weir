// The one read-only MCP Inventory Projection. Registry/runtime/mount/receipt and
// Loader facts are joined here; probing, mutation, credential resolution, agent
// visibility and every other operation remain with their existing owners.
// Pure dependencies keep this module independently testable and typechecked.

/**
 * Classify Loader rows once and retain the facts needed by both public views.
 * The legacy partition is a view over this join, not another inventory join.
 *
 * @param {any[]} rows
 * @param {Map<string, any>} mounted
 * @param {Record<string, any>} registryServers
 * @param {{ isResidue: (id: string) => boolean, groupPrefix: string }} options
 */
function joinLoaderRows(rows, mounted, registryServers, { isResidue, groupPrefix }) {
  const managed = []
  const unmanaged = []
  for (const row of rows) {
    if (typeof row?.id === 'string' && isResidue(row.id)) {
      const identity = row.id.slice(groupPrefix.length)
      managed.push({
        identity,
        groupId: row.id,
        registry: registryServers[identity],
        isMounted: mounted.has(identity),
        mount: mounted.get(identity),
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
 * @param {{ isResidue: (id: string) => boolean, groupPrefix: string }} options
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
 *   holdsReservation: (rows: any[], serverName: any) => any,
 *   redactEntry: (entry: any) => any,
 *   fingerprintEntry: (entry: any) => string,
 * }} dependencies
 */
export function createMcpInventoryProjection(dependencies) {
  const {
    registry, runtime, mounted, receipts, listRows, startErrors,
    discoveryFor, support, isResidue, groupPrefix, holdsReservation,
    redactEntry, fingerprintEntry,
  } = dependencies

  async function list() {
    const current = await registry.read()
    const rows = listRows()
    const registryServers = current.kind === 'ok' ? current.servers : {}
    const loader = joinLoaderRows(rows, mounted, registryServers, { isResidue, groupPrefix })
    if (current.kind === 'absent') {
      return { managed: [], unmanaged: loader.unmanaged, warnings: [], registryRevision: 0, capabilities: support() }
    }
    if (current.kind !== 'ok') {
      return { managed: [], unmanaged: loader.unmanaged, unavailable: { status: current.kind }, registryRevision: current.revision ?? 0, capabilities: support() }
    }

    // The full view starts from registry authority, while consuming the same
    // managed Loader join as the compatibility view. Registry-only entries stay
    // visible and orphan Loader residue never becomes a fabricated registry row.
    const loaderByIdentity = new Map(loader.managed.map(fact => [fact.identity, fact]))
    const defaults = new Set(current.enabled)
    const managed = Object.values(current.servers).map(entry => {
      const phase = runtime.snapshot(entry.identity)
      const loaderFact = loaderByIdentity.get(entry.identity)
      const mountedRecord = loaderFact ? loaderFact.mount : mounted.get(entry.identity)
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
