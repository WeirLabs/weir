import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpOperations } from '../src/capabilities/mcp-operations.js'
import { createMcpRegistry } from '../src/capabilities/mcp-registry.js'
import { createMcpRuntime } from '../src/capabilities/mcp-runtime.js'
import { createMcpDrain } from '../src/capabilities/mcp-drain.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { fingerprintMcpEntry } from '../src/capabilities/mcp-config.js'

const secret = 'operation-canary-secret'
function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weir-mcp-ops-'))
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const registry = createMcpRegistry({ store })
  const runtime = createMcpRuntime()
  const drain = createMcpDrain()
  const values = new Map()
  const sets = []
  const unsets = []
  const calls = { probe: 0, mount: 0, remove: 0, begin: 0 }
  const audit = []
  const support = { credentials: true, ephemeral: true }
  const manager = {
    support: () => support,
    serverNameConflict: () => null,
    beginOperation(identity, phase) {
      calls.begin += 1
      const token = runtime.begin(identity, { phase })
      drain.closeAll(identity)
      return token
    },
    abortOperation(token) {
      const mounted = token.previous?.phase === 'mounted'
      const restored = runtime.restore(token)
      if (mounted && restored) drain.reopenAll(token.identity)
      return restored
    },
    async reconcileOne(identity, entry, token) {
      calls.mount += 1
      const status = typeof options.mountStatus === 'function' ? options.mountStatus(identity, entry, calls.mount) : options.mountStatus ?? 'mounted'
      if (status === 'mounted') {
        runtime.finish(token, 'mounted', { generation: entry.generation, incarnation: entry.incarnation ?? null })
        drain.reopenAll(identity)
        return { status: 'mounted', mount: { state: 'mounted', observedGeneration: entry.generation }, discovery: { toolCount: 1, toolNamesPreview: ['mcp__docs__echo'], truncated: false } }
      }
      runtime.finish(token, status === 'saved-degraded' ? 'saved-degraded' : status, { generation: entry.generation, incarnation: entry.incarnation ?? null })
      return { status, saved: true, error: { code: 'connection-refused', message: 'injected mount failure' } }
    },
    async probe(entry) {
      calls.probe += 1
      const status = options.probeStatus ?? 'mounted'
      return status === 'mounted'
        ? { status, discovery: { toolCount: 0, toolNamesPreview: [], truncated: false }, cleanup: { status: 'cleaned' } }
        : { status, error: { code: 'timeout', message: 'injected probe failure' } }
    },
    async removeRuntime(identity, token) {
      calls.remove += 1
      runtime.finish(token, 'unknown', { generation: null, incarnation: null })
      return { status: 'removed', identity, removed: true }
    },
  }
  const credentials = {
    async set(ref, value) { sets.push([ref, value]); values.set(ref, value) },
    async unset(ref) { unsets.push(ref); values.delete(ref) },
    async resolve(ref) { return values.has(ref) ? { value: values.get(ref) } : undefined },
  }
  const operations = createMcpOperations({ registry, manager, credentials, audit: (_session, type, data) => audit.push({ type, data }), assertOwner: options.assertOwner })
  return { root, store, registry, manager, runtime, drain, values, sets, unsets, calls, audit, support, operations }
}
const config = (identity, extras = {}) => ({ identity, label: identity, command: process.execPath, args: [], env: { TOKEN: secret }, ...extras })

test('preview is inert, bounded and secret-free; oversized/invalid batches have zero side effects', async () => {
  const f = fixture()
  const preview = await f.operations.preview({ document: { mcpServers: { docs: config('docs') } } })
  expect(preview.status).toBe('preview')
  expect(preview.plan).toHaveLength(1)
  expect(JSON.stringify(preview)).not.toContain(secret)
  expect(f.calls.probe).toBe(0)
  expect(f.calls.mount).toBe(0)
  expect(f.sets).toEqual([])
  expect((await f.registry.read()).kind).toBe('absent')
  await assert.rejects(f.operations.executeBatch({ document: { mcpServers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`s${i}`, { command: 'node' }])) } }), /between 1 and 32/)
  expect(f.sets).toEqual([])
  expect(f.calls.probe).toBe(0)
  expect((await f.registry.read()).kind).toBe('absent')
})

test('add/edit/restart/default/remove share strict outcomes, blank-keep refs and selection independence', async () => {
  const f = fixture()
  await f.store.commit({ kind: 'selection', sessionId: 's1' }, 0, () => ({ skills: [], mcpServers: ['other'], origin: 'apply' }))
  const added = await f.operations.add({ identity: 'docs', config: config('docs') })
  expect(added.status, JSON.stringify(added)).toBe('mounted')
  expect(added.saved).toBe(true)
  expect(added.generation).toBe(1)
  expect(added.incarnation).toBeTruthy()
  expect(JSON.stringify(added)).not.toContain(secret)
  let current = await f.registry.read()
  expect(current.servers.docs.client.env.TOKEN).toBeUndefined()
  expect(current.servers.docs.secretRefs.env.TOKEN.ref).toMatch(/^WEIR_MCP_/)
  expect(f.values.get(current.servers.docs.secretRefs.env.TOKEN.ref)).toBe(secret)
  const originalRef = current.servers.docs.secretRefs.env.TOKEN.ref
  const originalIncarnation = current.servers.docs.incarnation
  await f.operations.setDefault({ identity: 'docs', enabled: true, expectedRevision: current.revision })

  const edited = await f.operations.edit({ identity: 'docs', expectedRevision: (await f.registry.read()).revision, config: { label: 'Renamed', secretValues: { env: { TOKEN: '' } } } })
  expect(edited.status).toBe('mounted')
  expect(edited.generation).toBe(2)
  expect(edited.incarnation).toBe(originalIncarnation)
  current = await f.registry.read()
  expect(current.servers.docs.label).toBe('Renamed')
  expect(current.servers.docs.secretRefs.env.TOKEN.ref).toBe(originalRef)
  expect(current.enabled).toEqual(['docs'])

  const restarted = await f.operations.restart({ identity: 'docs', expectedRevision: current.revision })
  expect(restarted.status).toBe('mounted')
  expect(restarted.generation).toBe(3)
  expect(restarted.incarnation).toBe(originalIncarnation)
  current = await f.registry.read()
  expect(current.servers.docs.secretRefs.env.TOKEN.ref).toBe(originalRef)
  expect(current.enabled).toEqual(['docs'])
  const removed = await f.operations.remove({ identity: 'docs', expectedRevision: current.revision })
  expect(removed.status).toBe('removed')
  expect(removed.defaultRemoved).toBe(true)
  expect((await f.registry.read()).enabled).toEqual([])
  expect((await f.store.read({ kind: 'selection', sessionId: 's1' })).payload.mcpServers).toEqual(['other'])
  expect(JSON.stringify(f.audit)).not.toContain(secret)
  expect(f.audit.every(entry => entry.type === 'capability-mcp')).toBe(true)
})

test('saved-degraded is failed with saved:true, never mounted success', async () => {
  const f = fixture({ mountStatus: 'saved-degraded' })
  const result = await f.operations.add({ identity: 'docs', config: config('docs') })
  expect(result.status).toBe('saved-degraded')
  expect(result.saved).toBe(true)
  expect(result.succeeded).toBe(false)
  expect(f.runtime.snapshot('docs').phase).toBe('saved-degraded')
  expect(f.runtime.enabledFor('docs')).toBe(false)
  expect((await f.registry.read()).servers.docs.generation).toBe(1)
})

test('probe is uncommitted and compensates; AI requires a successful probe before CAS and never enables defaults/selection', async () => {
  const f = fixture()
  const tested = await f.operations.test({ identity: 'docs', config: config('docs') })
  expect(tested.status).toBe('mounted')
  expect(tested.saved).toBe(false)
  expect(tested.probe).toBe(true)
  expect((await f.registry.read()).kind).toBe('absent')
  expect(f.unsets.length).toBeGreaterThan(0)

  const installed = await f.operations.installFromAgent({ identity: 'agent-docs', config: { identity: 'agent-docs', command: process.execPath, args: [], env: { TOKEN: { ref: 'USER_TOKEN' } } } })
  expect(installed.status).toBe('mounted')
  expect(installed.next).toEqual({ action: 'select-and-apply' })
  expect(tested.discovery.toolCount).toBe(0)
  expect(installed.discovery.toolCount).toBe(1) // response reports the managed mount's actual discovery, not the earlier probe
  expect((await f.registry.read()).enabled).toEqual([])
  expect(f.calls.probe).toBe(2)
  await assert.rejects(f.operations.installFromAgent({ identity: 'bad', config: { identity: 'bad', command: 'node', env: { TOKEN: 'literal-not-allowed' } } }), /literal secrets/)
})

test('failed AI probe does not register or select the server', async () => {
  const f = fixture({ probeStatus: 'probe-failed' })
  const result = await f.operations.installFromAgent({ identity: 'docs', config: { identity: 'docs', command: 'node', env: { TOKEN: { ref: 'USER_TOKEN' } } } })
  expect(result.status).toBe('probe-failed')
  expect(result.saved).toBe(false)
  expect((await f.registry.read()).kind).toBe('absent')
  expect(f.calls.mount).toBe(0)
})

test('batch uses each current revision, continues after saved-degraded and reports non-atomic outcomes', async () => {
  const f = fixture({ mountStatus: identity => identity === 'bad' ? 'saved-degraded' : 'mounted' })
  const result = await f.operations.executeBatch({ document: { mcpServers: { first: config('first'), bad: config('bad'), last: config('last') } } })
  expect(result.status).toBe('partial')
  expect(result.atomic).toBe(false)
  expect(result.succeeded).toBe(false)
  expect(result.items.map(item => item.status)).toEqual(['mounted', 'saved-degraded', 'mounted'])
  expect(result.items[1].failed).toBe(true)
  expect(result.items[1].saved).toBe(true)
  expect(result.items[2].succeeded).toBe(true)
  const current = await f.registry.read()
  expect(current.revision).toBe(3)
  expect(current.servers.last.generation).toBe(1)
})

test('batch owner abort marks only remaining entries not-attempted', async () => {
  let ownerCalls = 0
  const f = fixture({ assertOwner: async () => { ownerCalls += 1; if (ownerCalls > 5) throw new Error('preset changed') } })
  const result = await f.operations.executeBatch({ document: { mcpServers: { first: config('first'), second: config('second'), third: config('third') } } })
  expect(result.items[0].status).toBe('mounted')
  expect(result.items[1].status).toBe('owner-changed')
  expect(result.items[2].status).toBe('not-attempted')
  expect(result.items[2].notAttempted).toBe(true)
  expect((await f.registry.read()).servers.third).toBeUndefined()
})

test('stale revision and external target fingerprint conflicts do not write or probe', async () => {
  const f = fixture()
  const added = await f.operations.add({ identity: 'docs', config: config('docs') })
  expect(added.status).toBe('mounted')
  const before = await f.registry.read()
  const stale = await f.operations.edit({ identity: 'docs', expectedRevision: 0, config: { label: 'stale' } })
  expect(stale.status).toBe('revision-conflict')
  const external = await f.operations.edit({ identity: 'docs', targetFingerprint: '0'.repeat(64), config: { label: 'external' } })
  expect(external.status).toBe('revision-conflict')
  expect(f.calls.probe).toBe(0)
  expect(JSON.stringify(await f.registry.read())).toBe(JSON.stringify(before))
})

test('lost post-write response is indeterminate with actual saved facts and retained refs', async () => {
  const f = fixture()
  const original = f.registry.register
  f.registry.register = async (...args) => { const result = await original(...args); throw new Error('lost registry response') }
  const result = await f.operations.add({ identity: 'docs', config: config('docs') })
  expect(result.status).toBe('indeterminate')
  expect(result.saved).toBe(true)
  expect(result.generation).toBe(1)
  expect(result.registryRevision).toBe(1)
  expect(f.unsets).toEqual([])
  expect((await f.registry.read()).servers.docs.generation).toBe(1)
})

test('unsupported ephemeral support rejects secret work before credential or registry writes', async () => {
  const f = fixture()
  f.support.ephemeral = false
  const result = await f.operations.add({ identity: 'docs', config: config('docs') })
  expect(result.status).toBe('unsupported')
  expect(result.saved).toBe(false)
  expect(f.sets).toEqual([])
  expect(f.calls.probe).toBe(0)
  expect((await f.registry.read()).kind).toBe('absent')
})
