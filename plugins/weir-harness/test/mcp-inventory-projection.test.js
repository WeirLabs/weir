// MCP Inventory Projection contracts (mcp-management-deepening 3.1–3.3).
// Exercise the independent read model, the REAL manager.list() → payload →
// shipped client model chain, and the legacy public partition adapter.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMcpInventoryProjection } from '../src/capabilities/mcp-inventory.js'
import { createMcpManager, hostRowHoldingReservation, partitionMcpRows } from '../src/capabilities/mcp-manager.js'
import { fingerprintMcpEntry, redactMcpEntry } from '../src/capabilities/mcp-config.js'
import { isMcpResidueId, MCP_GROUP_PREFIX } from '../src/capabilities/mcp-mount.js'
import { createMcpMountOwnership } from '../src/capabilities/mcp-mount-ownership.js'
import { buildListPayload } from '../src/capabilities/read-payloads.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

const { exports: clientModel } = await loadClientChunk('lib/client.capability-model.js')
const EMPTY_DISCOVERY = { toolCount: null, toolNamesPreview: [], truncated: false }
const MANAGED_KEYS = [
  'identity', 'label', 'serverName', 'transport', 'incarnation', 'generation',
  'defaultEnabled', 'state', 'statusSource', 'runtimePhase', 'discovery',
  'lastMount', 'lastTest', 'startErrors', 'liveReconnect', 'processExit',
  'stderr', 'readOnly', 'config', 'fingerprint',
]
const PAYLOAD_KEYS = ['skills', 'mcpServers', 'mcpWarnings', 'mcpUnavailable', 'mcpCapabilities', 'mcpRegistryRevision']
const fingerprintOf = entry => createHash('sha256').update(JSON.stringify(entry)).digest('hex')

function serverEntry(identity, { secret = false } = {}) {
  return {
    identity,
    label: identity === 'docs' ? 'Documentation' : identity,
    owner: { kind: 'global', key: 'installation' },
    incarnation: `inc-${identity}`,
    generation: 1,
    configuredAt: 123,
    transport: { kind: 'stdio', ref: 'cmd:node' },
    client: {
      transport: 'stdio', serverName: `${identity}-public`, command: 'node',
      args: secret ? ['--verbose', 'raw-arg-secret'] : [],
      cwd: '/workspace', env: secret ? { TOKEN: 'raw-env-secret' } : {},
    },
    ...(secret ? { secretRefs: { env: { TOKEN: { ref: 'ENV_TOKEN' } }, args: { 1: { ref: 'ARG_TOKEN' } } } } : {}),
  }
}

const hostRow = () => ({ id: 'host-row', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'host-public' } })
const residueRow = identity => ({ id: `weir-mcp-${identity}`, name: 'cordis:group' })

function projectionDependencies(overrides = {}) {
  return {
    isResidue: isMcpResidueId,
    groupPrefix: MCP_GROUP_PREFIX,
    holdsReservation: hostRowHoldingReservation,
    redactEntry: redactMcpEntry,
    fingerprintEntry: fingerprintMcpEntry,
    ...overrides,
  }
}

test('the independent projection joins registry, runtime, mount, receipts and Loader rows', async () => {
  const docs = { ...serverEntry('docs'), generation: 4 }
  const mounted = new Map([['docs', { groupId: 'weir-mcp-docs', generation: 4, state: 'mounted' }]])
  const lastMount = { time: 10, status: 'mounted', generation: 4 }
  const projection = createMcpInventoryProjection(projectionDependencies({
    registry: { read: async () => ({ kind: 'ok', revision: 7, servers: { docs }, enabled: ['docs'], warnings: ['registry-note'] }) },
    runtime: { snapshot: () => ({ phase: 'mounted', generation: 4, incarnation: 'inc-docs', operationId: 'op-1' }) },
    mounted,
    receipts: { mount: new Map([['docs', lastMount]]), test: new Map() },
    listRows: () => [residueRow('docs'), hostRow()],
    startErrors: [],
    discoveryFor: () => ({ toolCount: 1, toolNamesPreview: ['mcp__docs__echo'], truncated: false }),
    support: () => ({ credentials: false, ephemeral: true }),
  }))

  const listing = await projection.list()
  expect(listing).toEqual({
    managed: [{
      identity: 'docs', label: 'Documentation', serverName: 'docs-public', transport: 'stdio',
      incarnation: 'inc-docs', generation: 4, defaultEnabled: true, state: 'mounted',
      statusSource: 'registry-runtime-mount-readback', runtimePhase: 'mounted',
      discovery: { toolCount: 1, toolNamesPreview: ['mcp__docs__echo'], truncated: false },
      lastMount, lastTest: null, startErrors: [], liveReconnect: 'unknown', processExit: 'unknown',
      stderr: 'unknown', readOnly: false, config: docs, fingerprint: fingerprintOf(docs),
    }],
    unmanaged: [{ serverName: 'host-public', state: 'unmanaged', readOnly: true }],
    warnings: ['registry-note'], registryRevision: 7, capabilities: { credentials: false, ephemeral: true },
  })
})

test('partitionMcpRows remains an exact compatibility adapter, including its managed branch', () => {
  const partitioned = partitionMcpRows(
    [residueRow('docs'), residueRow('orphan'), hostRow(), { id: 'other', name: 'something/else' }],
    new Map([['docs', { groupId: 'weir-mcp-docs', generation: 2 }]]),
    { docs: { label: 'Registry Docs', generation: 4 }, orphan: { label: 'Orphan', generation: 9 } },
  )
  expect(partitioned).toEqual({
    managed: [
      { identity: 'docs', groupId: 'weir-mcp-docs', label: 'Registry Docs', generation: 2, state: 'mounted' },
      { identity: 'orphan', groupId: 'weir-mcp-orphan', label: 'Orphan', generation: 9, state: 'registered' },
    ],
    unmanaged: [{ serverName: 'host-public', state: 'unmanaged', readOnly: true }],
  })
  expect(partitionMcpRows([residueRow('legacy')], new Map(), {})).toEqual({
    managed: [{ identity: 'legacy', groupId: 'weir-mcp-legacy', label: 'legacy', generation: null, state: 'registered' }],
    unmanaged: [],
  })
})
test('same-identity actual groups join independently without foreign mounted facts or owner leakage', async () => {
  const ownership = createMcpMountOwnership()
  const first = ownership.claim('docs', { holder: {} })
  const second = ownership.claim('docs', { holder: {} })
  const rows = [first.groupId, second.groupId, 'weir-mcp-unknown~suffix'].map(id => ({ id, name: 'cordis:group' }))
  const mounted = new Map()
  const registry = { docs: { ...serverEntry('docs'), generation: 1 } }
  const compatible = partitionMcpRows(rows, mounted, registry, ownership)
  expect(compatible).toEqual({
    managed: [
      { identity: 'docs', groupId: first.groupId, label: 'Documentation', generation: 1, state: 'registered' },
      { identity: 'docs', groupId: second.groupId, label: 'Documentation', generation: 1, state: 'registered' },
    ],
    unmanaged: [],
  })
  const wire = JSON.stringify(compatible)
  expect(wire.includes(first.owner) || wire.includes(second.owner)).toBe(false)

  const projection = createMcpInventoryProjection(projectionDependencies({
    ownership,
    registry: { read: async () => ({ kind: 'ok', revision: 1, servers: registry, enabled: [], warnings: [] }) },
    runtime: { snapshot: () => ({ phase: 'mounted', generation: 1 }) },
    mounted,
    receipts: { mount: new Map(), test: new Map() },
    listRows: () => rows,
    startErrors: [],
    discoveryFor: () => ({ toolCount: 0, toolNamesPreview: [], truncated: false }),
    support: () => ({ credentials: false, ephemeral: true }),
  }))
  // A foreign live allocation plus a mounted runtime phase is not this
  // caller's mount record, so no mounted/discovery fact is fabricated.
  expect((await projection.list()).managed[0].state).toBe('registered')
  mounted.set('docs', { groupId: second.groupId, generation: 1, state: 'mounted' })
  expect((await projection.list()).managed[0].state).toBe('mounted')
  const exact = partitionMcpRows(rows, mounted, registry, ownership)
  expect(exact.managed.map(row => row.state)).toEqual(['registered', 'mounted'])
  expect(exact.managed.some(row => row.groupId.includes('unknown'))).toBe(false)
})

async function managerFixture({
  entries = [serverEntry('docs', { secret: true }), serverEntry('degraded')],
  current = null,
  rows = [residueRow('docs'), residueRow('degraded'), residueRow('orphan'), hostRow()],
  failures = new Set(['degraded']),
  failProbe = false,
} = {}) {
  const state = {
    current: current ?? {
      kind: 'ok', revision: 41, servers: Object.fromEntries(entries.map(entry => [entry.identity, entry])),
      enabled: ['docs'], warnings: [{ code: 'default-missing', identity: 'missing' }],
    },
    rows,
  }
  const calls = {
    registryReads: 0, registryWrites: [], listRows: 0,
    mount: [], unmount: [], probe: [], sweep: [], processPrepare: 0,
    credentialReads: 0, credentialWrites: 0,
    agentReads: 0, agentResume: 0, agentWake: 0, sessionAppend: 0, toolRestricts: 0,
    lifecycleReads: 0, inventoryReads: 0, selectionReads: 0, selectionWrites: 0,
    loggerWarnings: 0,
  }
  const mounted = new Map()
  const mount = {
    mounted, failProbe,
    async sweepResidue() { calls.sweep.push('sweep'); return [] },
    async mount(options) {
      calls.mount.push(options.identity)
      if (failures.has(options.identity)) {
        throw new Error(`connection refused; Authorization: Bearer diagnostic-secret; ${'x'.repeat(9000)}`)
      }
      await options.readback?.()
      mounted.set(options.identity, { groupId: `weir-mcp-${options.identity}`, generation: options.generation, state: 'mounted' })
      return { status: 'mounted', discovery: await options.discovery?.() }
    },
    async unmount(identity) { calls.unmount.push(identity); mounted.delete(identity); return { status: 'cleaned' } },
    async probe(options) {
      calls.probe.push(options.client?.serverName ?? 'unknown')
      if (mount.failProbe) throw new Error('probe Authorization: Bearer probe-secret')
      return { status: 'mounted', discovery: { toolCount: 0, toolNamesPreview: [], truncated: false }, cleanup: { status: 'cleaned' } }
    },
  }
  const registry = {
    async read() { calls.registryReads += 1; return state.current },
    async register() { calls.registryWrites.push('register'); throw new Error('inventory wrote registry') },
    async remove() { calls.registryWrites.push('remove'); throw new Error('inventory wrote registry') },
    async rename() { calls.registryWrites.push('rename'); throw new Error('inventory wrote registry') },
    async setDefault() { calls.registryWrites.push('setDefault'); throw new Error('inventory wrote registry') },
    async setDefaults() { calls.registryWrites.push('setDefaults'); throw new Error('inventory wrote registry') },
  }
  const session = {
    id: 'session-1',
    append() { calls.sessionAppend += 1; throw new Error('inventory appended a session event') },
  }
  const agent = {
    id: 'session-1', session,
    resume() { calls.agentResume += 1; throw new Error('inventory resumed an agent') },
    wake() { calls.agentWake += 1; throw new Error('inventory woke an agent') },
    followup() { calls.agentWake += 1; throw new Error('inventory woke an agent') },
    steer() { calls.agentWake += 1; throw new Error('inventory woke an agent') },
    ctx: { tools: { restrict() { calls.toolRestricts += 1; throw new Error('inventory changed tool visibility') } } },
  }
  const agents = {
    list() { calls.agentReads += 1; return [agent] },
    get() { calls.agentReads += 1; return agent },
  }
  const credentials = {
    async resolve() { calls.credentialReads += 1; return 'resolved-secret' },
    async set() { calls.credentialWrites += 1; throw new Error('inventory wrote credentials') },
  }
  const services = new Map()
  const dispose = createMcpManager({
    registry, mount, agents, credentials,
    processAdapter: { async prepare(client) { calls.processPrepare += 1; return { client, execution: null } } },
    lifecycle: { snapshotFor() { calls.lifecycleReads += 1; return null } },
    gate: { admit: async () => false, permit: async () => null, assertPermit: () => false, enabledFor: () => false },
    listRows: () => { calls.listRows += 1; return state.rows },
    listEntryIds: () => state.rows.map(row => row.id).filter(Boolean),
  })({
    get: () => undefined,
    on() {},
    reflect: { provide: (key, value) => services.set(key, value) },
    logger: { warn() { calls.loggerWarnings += 1 } },
  }, {})
  const face = services.get('weirMcpManager')
  await face.start()
  await Promise.resolve()

  const read = async () => {
    const payload = await buildListPayload({
      inventory: async () => { calls.inventoryReads += 1; return { candidates: [], complete: true } },
      provider: {
        async list() { calls.selectionReads += 1; return { candidates: [], complete: true } },
        async apply() { calls.selectionWrites += 1; throw new Error('inventory wrote selection') },
        async write() { calls.selectionWrites += 1; throw new Error('inventory wrote selection') },
      },
      mcpManager: face,
    }, { scope: { session } })
    return { payload, partition: clientModel.partitionManagerListing(payload) }
  }
  const reset = () => {
    for (const [key, value] of Object.entries(calls)) {
      if (Array.isArray(value)) value.length = 0
      else calls[key] = 0
    }
  }
  return { state, calls, mount, registry, face, read, reset, dispose }
}

test('REAL manager.list → payload → shipped client preserves mixed rows and public facts', async () => {
  const f = await managerFixture({ failProbe: true })
  const docs = f.state.current.servers.docs
  const degradedEntry = f.state.current.servers.degraded
  const probe = await f.face.probe(degradedEntry)
  expect(probe.status).toBe('probe-failed')
  f.face.publicNames.set('mcp__docs__echo', { identity: 'docs', generation: 1 })
  f.face.publicNames.set('mcp__docs__read', { identity: 'docs', generation: 1 })

  const listing = await f.face.list()
  expect(Object.keys(listing)).toEqual(['managed', 'unmanaged', 'warnings', 'registryRevision', 'capabilities'])
  expect(listing.managed.map(row => row.identity)).toEqual(['docs', 'degraded'])
  expect(listing.unmanaged).toEqual([{ serverName: 'host-public', state: 'unmanaged', readOnly: true }])
  expect(listing.warnings).toEqual([{ code: 'default-missing', identity: 'missing' }])
  expect(listing.registryRevision).toBe(41)
  expect(listing.capabilities).toEqual({ credentials: true, ephemeral: false })

  const mounted = listing.managed[0]
  expect(Object.keys(mounted)).toEqual(MANAGED_KEYS)
  const { lastMount: mountedReceipt, ...mountedPublic } = mounted
  expect(mountedPublic).toEqual({
    identity: 'docs', label: 'Documentation', serverName: 'docs-public', transport: 'stdio',
    incarnation: 'inc-docs', generation: 1, defaultEnabled: true, state: 'mounted',
    statusSource: 'registry-runtime-mount-readback', runtimePhase: 'mounted',
    discovery: { toolCount: 2, toolNamesPreview: ['mcp__docs__echo', 'mcp__docs__read'], truncated: false },
    lastTest: null, startErrors: [], liveReconnect: 'unknown', processExit: 'unknown', stderr: 'unknown',
    readOnly: false,
    config: {
      ...docs,
      client: { ...docs.client, args: ['--verbose', '[redacted]'], env: { TOKEN: '[redacted]' } },
    },
    fingerprint: fingerprintOf(docs),
  })
  const { time: mountedTime, ...mountedReceiptPublic } = mountedReceipt
  expect(Number.isSafeInteger(mountedTime)).toBe(true)
  expect(mountedReceiptPublic).toEqual({
    status: 'mounted', generation: 1, discovery: { toolCount: 0, toolNamesPreview: [], truncated: false },
  })

  const degraded = listing.managed[1]
  expect(Object.keys(degraded)).toEqual(MANAGED_KEYS)
  const { lastMount, lastTest, startErrors, ...degradedPublic } = degraded
  expect(degradedPublic).toEqual({
    identity: 'degraded', label: 'degraded', serverName: 'degraded-public', transport: 'stdio',
    incarnation: 'inc-degraded', generation: 1, defaultEnabled: false, state: 'degraded',
    statusSource: 'registry-runtime', runtimePhase: 'saved-degraded', discovery: EMPTY_DISCOVERY,
    liveReconnect: 'unknown', processExit: 'unknown', stderr: 'unknown', readOnly: false,
    config: degradedEntry, fingerprint: fingerprintOf(degradedEntry),
  })
  expect(Object.keys(lastMount)).toEqual(['time', 'status', 'diagnostic'])
  expect(lastMount.status).toBe('saved-degraded')
  expect(lastMount.diagnostic.code).toBe('connection-refused')
  expect(lastMount.diagnostic.recovery).toEqual({ action: 'retry' })
  assert.ok(Buffer.byteLength(JSON.stringify(lastMount.diagnostic)) <= 8192)
  expect(startErrors).toEqual([{ reason: lastMount.diagnostic.message }])
  expect(Object.keys(lastTest)).toEqual(['time', 'status', 'diagnostic'])
  expect(lastTest.status).toBe('probe-failed')
  expect(lastTest.diagnostic.code).toBe('probe-failed')
  expect(lastTest.diagnostic.recovery).toEqual({ action: 'retry' })

  const { payload, partition } = await f.read()
  expect(Object.keys(payload)).toEqual(PAYLOAD_KEYS)
  expect(payload.skills).toEqual([])
  expect(payload.mcpServers).toEqual([mounted, degraded, { serverName: 'host-public', state: 'unmanaged', readOnly: true }])
  expect(payload.mcpWarnings).toEqual([{ code: 'default-missing', identity: 'missing' }])
  expect(payload.mcpUnavailable).toBeNull()
  expect(payload.mcpCapabilities).toEqual({ credentials: true, ephemeral: false })
  expect(payload.mcpRegistryRevision).toBe(41)
  expect(partition.mcpManaged.map(row => row.state)).toEqual(['mounted', 'degraded'])
  expect(partition.mcpUnmanaged).toEqual([{ serverName: 'host-public', state: 'unmanaged', readOnly: true }])
  expect(clientModel.mcpStateOf(partition.mcpManaged[0])).toBe('mounted')
  expect(clientModel.mcpStateOf(partition.mcpManaged[1])).toBe('degraded')
  const editor = clientModel.mcpEditorFromServer(partition.mcpManaged[0], payload.mcpRegistryRevision)
  expect(editor.registryRevision).toBe(41)
  expect(editor.targetFingerprint).toBe(fingerprintOf(docs))
  expect(editor.envRows).toEqual([{ key: 'TOKEN', action: 'keep', source: 'ref', ref: 'ENV_TOKEN', prefix: '', value: '', configured: true }])

  const wire = JSON.stringify(payload)
  for (const canary of ['raw-env-secret', 'raw-arg-secret', 'diagnostic-secret', 'probe-secret', 'resolved-secret']) {
    expect(wire).not.toContain(canary)
  }
  f.dispose()
})

test('real inventory carries deferLoading as configuration metadata without changing selection', async () => {
  const docs = { ...serverEntry('docs'), deferLoading: true }
  const f = await managerFixture({ entries: [docs], rows: [residueRow('docs')], failures: new Set() })
  const { payload, partition } = await f.read()
  const row = partition.mcpManaged[0]
  expect(row.config.deferLoading).toBe(true)
  expect(Object.hasOwn(row, 'deferLoading')).toBe(false)
  expect(clientModel.mcpEditorFromServer(row, payload.mcpRegistryRevision).deferLoading).toBe(true)
  expect(f.calls.selectionWrites).toBe(0)
  f.dispose()
})

test('strict generation/runtime/mount evidence alone controls mounted and discovery', async () => {
  const f = await managerFixture({ entries: [serverEntry('docs')], rows: [residueRow('docs')], failures: new Set() })
  f.face.publicNames.set('mcp__docs__echo', { identity: 'docs', generation: 1 })
  const mountedRecord = { groupId: 'weir-mcp-docs', generation: 1, state: 'mounted' }
  const runtimeRecord = (phase, generation) => ({ phase, generation, incarnation: 'inc-docs', operationId: `op-${phase}-${generation}` })
  const scenarios = [
    { name: 'strict readback', runtime: runtimeRecord('mounted', 1), mount: mountedRecord, state: 'mounted', source: 'registry-runtime-mount-readback', discovery: { toolCount: 1, toolNamesPreview: ['mcp__docs__echo'], truncated: false } },
    { name: 'registry presence only', runtime: runtimeRecord('unknown', null), mount: null, state: 'registered', source: 'registry-runtime', discovery: EMPTY_DISCOVERY },
    { name: 'runtime generation mismatch', runtime: runtimeRecord('mounted', 0), mount: mountedRecord, state: 'registered', source: 'registry-runtime', discovery: EMPTY_DISCOVERY },
    { name: 'mount evidence absent', runtime: runtimeRecord('mounted', 1), mount: null, state: 'registered', source: 'registry-runtime', discovery: EMPTY_DISCOVERY },
    { name: 'mount generation mismatch', runtime: runtimeRecord('mounted', 1), mount: { ...mountedRecord, generation: 2 }, state: 'registered', source: 'registry-runtime', discovery: EMPTY_DISCOVERY },
    { name: 'saved degraded', runtime: runtimeRecord('saved-degraded', 1), mount: mountedRecord, state: 'degraded', source: 'registry-runtime', discovery: EMPTY_DISCOVERY },
  ]
  for (const scenario of scenarios) {
    f.face.runtime.states.set('docs', scenario.runtime)
    if (scenario.mount) f.mount.mounted.set('docs', scenario.mount)
    else f.mount.mounted.delete('docs')
    const row = (await f.face.list()).managed[0]
    expect({
      state: row.state, statusSource: row.statusSource,
      runtimePhase: row.runtimePhase, discovery: row.discovery,
      liveReconnect: row.liveReconnect, processExit: row.processExit, stderr: row.stderr,
    }, scenario.name).toEqual({
      state: scenario.state, statusSource: scenario.source,
      runtimePhase: scenario.runtime.phase, discovery: scenario.discovery,
      liveReconnect: 'unknown', processExit: 'unknown', stderr: 'unknown',
    })
  }
  f.dispose()
})

test('absent and corrupt registries stay distinct through payload and client partition', async () => {
  const f = await managerFixture({ current: { kind: 'absent' }, entries: [], rows: [residueRow('orphan'), hostRow()] })
  const capabilities = { credentials: true, ephemeral: false }
  const unmanaged = [{ serverName: 'host-public', state: 'unmanaged', readOnly: true }]
  expect(await f.face.list()).toEqual({ managed: [], unmanaged, warnings: [], registryRevision: 0, capabilities })
  let { payload, partition } = await f.read()
  expect(Object.keys(payload)).toEqual(PAYLOAD_KEYS)
  expect(payload).toEqual({
    skills: [], mcpServers: unmanaged, mcpWarnings: [], mcpUnavailable: null,
    mcpCapabilities: capabilities, mcpRegistryRevision: 0,
  })
  expect(partition).toEqual({ skills: [], mcpManaged: [], mcpUnmanaged: unmanaged })

  f.state.current = { kind: 'corrupt' }
  expect(await f.face.list()).toEqual({
    managed: [], unmanaged, unavailable: { status: 'corrupt' }, registryRevision: 0, capabilities,
  })
  ;({ payload, partition } = await f.read())
  expect(payload).toEqual({
    skills: [], mcpServers: unmanaged, mcpWarnings: [], mcpUnavailable: { status: 'corrupt' },
    mcpCapabilities: capabilities, mcpRegistryRevision: 0,
  })
  expect(partition).toEqual({ skills: [], mcpManaged: [], mcpUnmanaged: unmanaged })
  f.dispose()
})

test('repeated real inventory reads do no probe, wake, append, mutation or convergence work', async () => {
  const f = await managerFixture()
  f.face.publicNames.set('mcp__docs__echo', { identity: 'docs', generation: 1 })
  f.reset()
  const before = {
    registry: JSON.stringify(f.state.current),
    runtime: JSON.stringify([...f.face.runtime.states]),
    mounted: JSON.stringify([...f.mount.mounted]),
    publicNames: JSON.stringify([...f.face.publicNames]),
    startErrors: JSON.stringify(f.face.startErrors),
  }

  const first = await f.read()
  const second = await f.read()
  expect(second.payload).toEqual(first.payload)
  expect(second.partition).toEqual(first.partition)
  expect(f.calls).toEqual({
    registryReads: 2, registryWrites: [], listRows: 2,
    mount: [], unmount: [], probe: [], sweep: [], processPrepare: 0,
    credentialReads: 0, credentialWrites: 0,
    agentReads: 0, agentResume: 0, agentWake: 0, sessionAppend: 0, toolRestricts: 0,
    lifecycleReads: 0, inventoryReads: 2, selectionReads: 2, selectionWrites: 0,
    loggerWarnings: 0,
  })
  expect({
    registry: JSON.stringify(f.state.current),
    runtime: JSON.stringify([...f.face.runtime.states]),
    mounted: JSON.stringify([...f.mount.mounted]),
    publicNames: JSON.stringify([...f.face.publicNames]),
    startErrors: JSON.stringify(f.face.startErrors),
  }).toEqual(before)
  f.dispose()
})
