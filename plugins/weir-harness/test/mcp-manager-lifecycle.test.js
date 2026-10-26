import { test, expect } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpManager } from '../src/capabilities/mcp-manager.js'
import { createMcpRegistry } from '../src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { mcpFacadeBridgeFor } from '../src/capabilities/mcp-facade-plugin.js'

const entry = (identity, incarnation = null) => ({ identity, label: identity, owner: { kind: 'global', key: 'installation' }, generation: 0, configuredAt: 0, transport: { kind: 'stdio', ref: 'cmd:node' }, client: { transport: 'stdio', serverName: identity, command: process.execPath, args: [], env: {} }, ...(incarnation ? { incarnation } : {}) })
function mountFixture() {
  const mounted = new Map()
  const calls = []
  const state = { failMount: false, wrongGeneration: false, delay: null }
  const mount = {
    mounted, calls, state,
    async sweepResidue() { return [] },
    async mount(options) {
      calls.push(['mount', options.identity, options.generation])
      if (state.failMount) throw new Error('injected strict startup failure')
      await options.beforeCreate?.({ groupId: options.groupId ?? `weir-mcp-${options.identity}`, identity: options.identity, generation: options.generation })
      const bridge = mcpFacadeBridgeFor(`weir-mcp-${options.identity}`)
      bridge?.onRegister?.(`mcp__${options.identity}__echo`)
      await options.readback?.()
      const generation = state.wrongGeneration ? options.generation + 1 : options.generation
      mounted.set(options.identity, { groupId: `weir-mcp-${options.identity}`, generation, state: 'mounted' })
      return { status: 'mounted', groupId: `weir-mcp-${options.identity}`, generation: options.generation, discovery: options.discovery ? await options.discovery() : { toolCount: 0, toolNamesPreview: [], truncated: false } }
    },
    async unmount(identity) {
      calls.push(['unmount', identity])
      if (state.delay) await state.delay
      mounted.delete(identity)
      return { status: 'cleaned', removed: true }
    },
    async probe(options) {
      calls.push(['probe', options.identity])
      const identity = 'probe-1'
      await options.beforeCreate?.({ groupId: 'weir-mcp-probe-1', identity, generation: 0 })
      const discovery = await options.discovery?.({ identity, generation: 0 })
      await options.afterCleanup?.({ groupId: 'weir-mcp-probe-1', identity, generation: 0 })
      return { status: 'mounted', discovery, cleanup: { status: 'cleaned' } }
    },
  }
  return mount
}
async function fixture({ entries = ['docs', 'web'], mount = mountFixture(), mountStatus } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weir-mcp-manager-life-'))
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const registry = createMcpRegistry({ store, newIncarnation: () => null })
  let revision = 0
  for (const identity of entries) {
    const result = await registry.register(entry(identity), revision)
    revision = result.revision
  }
  const listeners = new Map()
  const services = new Map()
  const lifecycle = { snapshotFor: () => ({ state: 'ready', mcpServers: ['docs', 'web'], mcpIncarnations: Object.fromEntries(entries.map(identity => [identity, null])) }) }
  const manager = createMcpManager({ registry, mount, lifecycle, listRows: () => [], listEntryIds: () => [] })
  const ctx = {
    get: () => undefined,
    on(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]) },
    reflect: { provide: (key, value) => services.set(key, value) },
    logger: { warn() {} },
  }
  manager(ctx, {})
  const face = services.get('weirMcpManager')
  await face.start()
  return { root, store, registry, mount, listeners, services, face, lifecycle }
}

test('startup and targeted reconcile share strict readback; siblings never remount', async () => {
  const f = await fixture()
  expect(f.face.list).toBeTruthy()
  const initial = await f.face.list()
  expect(initial.managed.map(row => row.state)).toEqual(['mounted', 'mounted'])
  const docsBefore = f.mount.mounted.get('docs').generation
  const webBefore = f.mount.mounted.get('web').generation
  const current = await f.registry.read()
  await f.registry.register(current.servers.docs, current.revision)
  const updated = (await f.registry.read()).servers.docs
  const result = await f.face.reconcileOne('docs', updated)
  expect(result.status).toBe('mounted')
  expect(result.mount.observedGeneration).toBe(docsBefore + 1)
  expect(f.mount.mounted.get('web').generation).toBe(webBefore)
  expect(f.mount.calls.filter(call => call[0] === 'mount' && call[1] === 'web')).toHaveLength(1)
  expect(f.mount.mounted.get('docs').generation).toBe(docsBefore + 1)
})

test('a wrong mounted generation is saved-degraded and never opens admission', async () => {
  const mount = mountFixture()
  mount.state.wrongGeneration = true
  const f = await fixture({ entries: ['docs'], mount })
  const row = (await f.face.list()).managed[0]
  expect(row.state).toBe('degraded')
  expect(row.discovery.toolCount).toBeNull()
  expect(row.lastMount.status).toBe('saved-degraded')
  expect(row.startErrors.length).toBeGreaterThan(0)
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(false)
})

test('generation-owned public names are cleaned precisely and schema/prompt checks follow runtime phase', async () => {
  const f = await fixture({ entries: ['docs'] })
  expect(f.face.publicNames.get('mcp__docs__echo').generation).toBe(1)
  // A newer generation's fact exists before the old bridge finishes cleanup.
  f.face.publicNames.set('mcp__docs__echo', { identity: 'docs', generation: 2 })
  const current = await f.registry.read()
  await f.registry.register(current.servers.docs, current.revision)
  const token = f.face.beginOperation('docs')
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(false)
  const restricted = []
  for (const listener of f.listeners.get('agent/created')) listener({ agent: { session: { id: 's1' }, ctx: { tools: { restrict: value => restricted.push(value) } } } })
  expect(restricted).toEqual([{ deny: ['mcp__docs__echo'] }])
  const result = await f.face.reconcileOne('docs', (await f.registry.read()).servers.docs, token)
  expect(result.status).toBe('mounted')
  expect(f.face.publicNames.get('mcp__docs__echo').generation).toBe(2)
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(true)
  await f.face.removeRuntime('docs')
  expect(f.face.publicNames.size).toBe(0)
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(false)
})

test('pre-commit restoration cannot overwrite a later operation; failed mount stays closed and sibling facts survive', async () => {
  const f = await fixture({ entries: ['docs', 'web'] })
  const first = f.face.beginOperation('docs')
  const second = f.face.beginOperation('docs')
  expect(f.face.abortOperation(first)).toBe(false)
  expect(f.face.runtime.snapshot('docs').operationId).toBe(second.operationId)
  f.mount.state.failMount = true
  const result = await f.face.reconcileOne('docs', (await f.registry.read()).servers.docs, second)
  expect(result.status).toBe('saved-degraded')
  expect(f.face.runtime.snapshot('docs').phase).toBe('saved-degraded')
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(false)
  expect(f.face.publicNames.has('mcp__web__echo')).toBe(true)
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'web')).toBe(true)
})

test('probe cleans bridge/public facts and changes no registry or selection', async () => {
  const f = await fixture({ entries: ['docs'] })
  const beforeRegistry = JSON.stringify(await f.registry.read())
  await f.store.commit({ kind: 'selection', sessionId: 's1' }, 0, () => ({ skills: [], mcpServers: ['docs'] }))
  const result = await f.face.probe((await f.registry.read()).servers.docs)
  expect(result.status).toBe('mounted')
  expect(result.discovery.toolCount).toBe(0)
  expect(f.face.publicNames.has('mcp__probe-1__echo')).toBe(false)
  expect(JSON.stringify(await f.registry.read())).toBe(beforeRegistry)
  expect((await f.store.read({ kind: 'selection', sessionId: 's1' })).payload.mcpServers).toEqual(['docs'])
})

test('an absent registry is a healthy empty inventory with support facts, not an unavailable warning', async () => {
  const f = await fixture({ entries: [] })
  const listing = await f.face.list()
  expect(listing.managed).toEqual([])
  expect(listing.unavailable).toBeUndefined()
  expect(listing.registryRevision).toBe(0)
  expect(listing.warnings).toEqual([])
  expect(listing.capabilities).toEqual({ credentials: false, ephemeral: false })
})
