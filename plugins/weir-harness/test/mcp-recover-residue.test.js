// Review P2 (b): residue recovery is reachable from the shared MCP operations
// (UI mutation remote), the /capabilities mcp-recover verb and the panel.
import { test, expect, storePlatformSkip, pinHermeticHostRoots } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpManager } from '../src/capabilities/mcp-manager.js'
import { createMcpOperations } from '../src/capabilities/mcp-operations.js'
import { createMcpRegistry } from '../src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'

const record = identity => ({
  identity, label: identity, owner: { kind: 'global', key: 'installation' }, generation: 0, configuredAt: 0,
  transport: { kind: 'stdio', ref: 'cmd:node' },
  client: { transport: 'stdio', serverName: identity, command: process.execPath, args: [], env: {} },
})

async function fixture(store) {
  const registry = createMcpRegistry({ store, newIncarnation: () => null })
  let revision = 0
  for (const identity of ['docs', 'web']) revision = (await registry.register(record(identity), revision)).revision
  const mounted = new Map()
  const events = []
  const loaderRows = new Set()
  let failDocs = true
  const mount = {
    mounted,
    async sweepResidue(ids) {
      const swept = ids.filter(id => loaderRows.has(id))
      for (const id of swept) { events.push(['sweep', id]); loaderRows.delete(id) }
      return swept
    },
    async mount(options) {
      events.push(['mount', options.identity])
      if (options.identity === 'docs' && failDocs) {
        failDocs = false
        mounted.set('docs', { groupId: 'weir-mcp-docs', generation: options.generation, state: 'cleanup-failed' })
        loaderRows.add('weir-mcp-docs')
        throw Object.assign(new Error('injected disposal rejection'), { status: 'cleanup-failed' })
      }
      await options.readback?.()
      mounted.set(options.identity, { groupId: `weir-mcp-${options.identity}`, generation: options.generation, state: 'mounted' })
      loaderRows.add(`weir-mcp-${options.identity}`)
      return { status: 'mounted', discovery: { toolCount: 0, toolNamesPreview: [], truncated: false } }
    },
    async unmount(identity) {
      events.push(['unmount', identity])
      mounted.delete(identity)
      loaderRows.delete(`weir-mcp-${identity}`)
      return { status: 'cleaned', removed: true }
    },
    async probe() { return { status: 'mounted', discovery: { toolCount: 0, toolNamesPreview: [], truncated: false }, cleanup: { status: 'cleaned' } } },
  }
  const services = new Map()
  const lifecycle = { snapshotFor: () => ({ state: 'ready', mcpServers: ['docs', 'web'], mcpIncarnations: { docs: null, web: null } }) }
  createMcpManager({ registry, mount, lifecycle, listRows: () => [], listEntryIds: () => [...loaderRows] })({
    get: () => undefined, on() {}, reflect: { provide: (key, value) => services.set(key, value) }, logger: { warn() {} },
  }, {})
  const face = services.get('weirMcpManager')
  await face.start()
  // An orphan Loader row whose registration is gone appears after startup.
  loaderRows.add('weir-mcp-ghost')
  return { registry, face, events, loaderRows }
}

const state = async (face, identity) => (await face.list()).managed.find(row => row.identity === identity)?.state

test('the shared recover operation sweeps residue and strictly remounts without touching healthy servers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weir-mcp-recover-'))
  const f = await fixture(openCapabilityStore({ root, platform: 'darwin' }))
  expect(await state(f.face, 'docs')).toBe('cleanup-failed')
  expect(await state(f.face, 'web')).toBe('mounted')
  const operations = createMcpOperations({ registry: f.registry, manager: f.face, credentials: undefined })
  const result = await operations.recover({})
  expect(result.status, JSON.stringify(result)).toBe('recovered')
  expect(result.results.map(item => [item.identity, item.status]).sort()).toEqual([['docs', 'mounted'], ['ghost', 'removed']])
  expect(f.loaderRows.has('weir-mcp-ghost')).toBe(false)
  expect(await state(f.face, 'docs')).toBe('mounted')
  expect(f.events.filter(([kind, identity]) => kind !== 'sweep' && identity === 'web')).toEqual([['mount', 'web']])
  // Scoped and idempotent: a healthy identity is left alone.
  const again = await operations.recover({ identity: 'docs' })
  expect(again.status).toBe('recovered')
  expect(again.results).toEqual([])
})

test('/capabilities mcp-recover reaches the manager recovery with and without an identity', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-mcp-recover-cmd-'))
    const f = await fixture(openCapabilityStore({ profileContext: { home: root, name: 'it' }, platform: 'darwin' }))
    const registered = []
    const ctx = {
      skills: { registerProvider: create => create({ invalidate() {} }), layers: { global: { providers: new Map() } } },
      on() {}, effect(fn) { fn(); return () => {} }, emit() {}, logger: { warn() {} },
      get(name) {
        if (name === 'profileContext') return { home: root, name: 'it' }
        if (name === 'commands') return { register(command) { registered.push(command); return () => {} } }
        if (name === 'weirMcpManager') return f.face
        return undefined
      },
    }
    createSkillSelectionPlugin()(ctx, { readPresetId: 'weir', machineId: 'weir-it-machine', includeDefaultRoots: false, customSkillDirs: [], dshHome: root })
    const command = registered.find(entry => entry.name === 'capabilities')
    const agent = { id: 's1', session: { id: 's1', header: { cwd: root } } }
    const scoped = await command.handler({ agent, rawInput: 'mcp-recover {"identity":"docs"}' })
    expect(scoped.kind, scoped.text).toBe('success')
    expect(JSON.parse(scoped.text).results.map(item => item.identity)).toEqual(['docs'])
    expect(await state(f.face, 'docs')).toBe('mounted')
    const all = await command.handler({ agent, rawInput: 'mcp-recover' })
    expect(all.kind, all.text).toBe('success')
    expect(JSON.parse(all.text).results.map(item => [item.identity, item.status])).toEqual([['ghost', 'removed']])
    const help = await command.handler({ agent, rawInput: 'unknown' })
    expect(help.text).toContain('mcp-recover')
  } finally { host.restore() }
})
