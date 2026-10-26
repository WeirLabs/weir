import { test, expect } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpRegistry } from '../src/capabilities/mcp-registry.js'
import { createMcpGate, mcpIncarnationMatches } from '../src/capabilities/mcp-gate.js'
import { createLifecycleSnapshots } from '../src/capabilities/lifecycle-snapshot.js'
import { createApplyEngine } from '../src/capabilities/apply-engine.js'
import { resolveInitialSelection } from '../src/capabilities/initial-selection.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'

const entry = (incarnation = null) => ({ identity: 'docs', label: 'Docs', owner: { kind: 'global', key: 'installation' }, generation: 0, configuredAt: 0, transport: { kind: 'stdio', ref: 'cmd:node' }, client: { transport: 'stdio', serverName: 'docs', command: 'node' }, ...(incarnation ? { incarnation } : {}) })
const agent = { session: { id: 's1' } }

test('remove/re-add denies old snapshots until Apply; edit/restart needs no reauthorization', async () => {
  const incarnations = ['inc-a', 'inc-b']
  let index = 0
  const registry = createMcpRegistry({ store: openCapabilityStore({ root: mkdtempSync(join(tmpdir(), 'weir-inc-gate-')), platform: 'darwin' }), newIncarnation: () => incarnations[index++] })
  await registry.register(entry(), 0)
  let current = await registry.read()
  const lifecycle = { snapshotFor: () => ({ state: 'ready', mcpServers: ['docs'], mcpIncarnations: { docs: 'inc-a' } }) }
  const gate = createMcpGate({ registry, lifecycle })
  expect(await gate.admit(agent, 'docs', 1)).toBe(true)
  await registry.register(current.servers.docs, current.revision) // edit/restart: same incarnation, next generation
  current = await registry.read()
  expect(current.servers.docs.incarnation).toBe('inc-a')
  expect(await gate.admit(agent, 'docs', 2)).toBe(true)
  expect(await gate.admit(agent, 'docs', 1)).toBe(false)
  await registry.remove('docs', current.revision)
  current = await registry.read()
  await registry.register(entry(), current.revision)
  current = await registry.read()
  expect(current.servers.docs.incarnation).toBe('inc-b')
  expect(await gate.admit(agent, 'docs', 1)).toBe(false)
  const reapplied = createMcpGate({ registry, lifecycle: { snapshotFor: () => ({ state: 'ready', mcpServers: ['docs'], mcpIncarnations: { docs: 'inc-b' } }) } })
  expect(await reapplied.admit(agent, 'docs', 1)).toBe(true)
})

test('legacy compatibility requires both sides legacy; explicit null mapping also binds a legacy entry', async () => {
  const registry = { read: async () => ({ kind: 'ok', servers: { docs: { generation: 1, incarnation: null } } }) }
  const legacy = createMcpGate({ registry, lifecycle: { snapshotFor: () => ({ state: 'ready', mcpServers: ['docs'] }) } })
  expect(await legacy.admit(agent, 'docs', 1)).toBe(true)
  const mapped = createMcpGate({ registry, lifecycle: { snapshotFor: () => ({ state: 'ready', mcpServers: ['docs'], mcpIncarnations: { docs: null } }) } })
  expect(await mapped.admit(agent, 'docs', 1)).toBe(true)
  expect(mcpIncarnationMatches({ mcpServers: ['docs'] }, 'docs', { incarnation: 'new' })).toBe(false)
  expect(mcpIncarnationMatches({ mcpServers: ['docs'], mcpIncarnations: {} }, 'docs', { incarnation: null })).toBe(false)
  expect(mcpIncarnationMatches({ mcpServers: ['docs'], mcpIncarnations: { docs: 'new' } }, 'docs', { incarnation: 'new' })).toBe(true)
})

test('Apply validates registered MCP identities, stores incarnations, and post-preparation Remove never admits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weir-inc-apply-'))
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const registry = createMcpRegistry({ store, newIncarnation: () => 'inc-apply' })
  await registry.register(entry(), 0)
  const published = []
  const engine = createApplyEngine({
    store, mcpRegistry: registry,
    locateSession: () => ({ sessionId: 's1', cwd: root }),
    inventory: async () => ({ complete: true, candidates: [] }),
    provider: { acceptSelection: () => ({ accepted: true }) },
    publishSnapshot: (sessionId, snapshot) => published.push({ sessionId, snapshot }),
  })
  const request = (requestId, mcpServers, expectedRevision = 0) => ({ requestId, expectedRevision, selection: { skills: [], mcpServers }, unresolved: [] })
  const rejected = await engine.apply({}, request('ghost-apply', ['ghost']))
  expect(rejected).toEqual({ status: 'rejected', reason: 'unregistered-mcp', step: 2, missing: ['ghost'] })
  expect((await store.read({ kind: 'selection', sessionId: 's1' })).kind).toBe('absent')
  const applied = await engine.apply({}, request('docs-apply', ['docs']))
  expect(applied.status).toBe('applied')
  expect(applied.effective.mcpIncarnations).toEqual({ docs: 'inc-apply' })
  const record = await store.read({ kind: 'selection', sessionId: 's1' })
  expect(record.payload.mcpIncarnations).toEqual({ docs: 'inc-apply' })
  expect(published[0].snapshot.mcpIncarnations).toEqual({ docs: 'inc-apply' })
  const lifecycle = { snapshotFor: () => ({ state: 'ready', ...published[0].snapshot }) }
  const gate = createMcpGate({ registry, lifecycle })
  const current = await registry.read()
  await registry.remove('docs', current.revision)
  expect(await gate.admit(agent, 'docs', 1)).toBe(false) // committed-but-missing is possible; admission is impossible
})

test('revision-0 and inherited/cold snapshots carry only current identity incarnations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weir-inc-life-'))
  const initial = resolveInitialSelection({ defaultsRecord: { kind: 'absent' }, enabledMcpIdentities: ['docs'], mcpIncarnations: { docs: 'inc-a' } })
  expect(initial.selection.mcpIncarnations).toEqual({ docs: 'inc-a' })
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  lifecycle.publish('parent', { revision: 0, skills: [], mcpServers: initial.selection.mcpServers, mcpIncarnations: initial.selection.mcpIncarnations, captured: null })
  lifecycle.captureInherited('child', 'parent')
  const cold = createLifecycleSnapshots({ root, platform: 'darwin' })
  const snapshot = cold.snapshotFor('child')
  expect(snapshot.mcpServers).toEqual(['docs'])
  expect(snapshot.mcpIncarnations).toEqual({ docs: 'inc-a' })
  const inherited = await openCapabilityStore({ root, platform: 'darwin' }).read({ kind: 'inherited', sessionId: 'child' })
  expect(inherited.payload.mcpIncarnations).toEqual({ docs: 'inc-a' })
})
