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
import { materializeMcpClientConfig } from '../src/capabilities/mcp-credentials.js'

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
      const status = typeof options.probeStatus === 'function' ? await options.probeStatus(entry, calls.probe) : options.probeStatus ?? 'mounted'
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
  return { root, store, registry, manager, runtime, drain, values, sets, unsets, calls, audit, support, credentials, operations }
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

test('absent registry accepts expectedRevision 0 so first Add and Test reach probe and mount', async () => {
  const f = fixture()
  const preview = await f.operations.preview({ document: { mcpServers: { docs: config('docs') } } })
  expect((await f.registry.read()).kind).toBe('absent')
  expect(preview.registryRevision).toBe(0)
  const tested = await f.operations.test({ identity: 'docs', expectedRevision: preview.registryRevision, config: config('docs') })
  expect(tested.status, JSON.stringify(tested)).toBe('mounted')
  expect(tested.probe).toBe(true)
  expect(tested.saved).toBe(false)
  expect(f.calls.probe).toBe(1)
  expect((await f.registry.read()).kind).toBe('absent')
  const added = await f.operations.add({ identity: 'docs', expectedRevision: preview.registryRevision, config: config('docs') })
  expect(added.status, JSON.stringify(added)).toBe('mounted')
  expect(added.saved).toBe(true)
  expect(added.registryRevision).toBe(1)
  expect((await f.registry.read()).servers.docs.generation).toBe(1)
})

test('absent registry accepts expectedRevision 0 for setDefault and reaches the unregistered validation', async () => {
  const f = fixture()
  const before = await f.registry.read()
  expect(before.kind).toBe('absent')
  const result = await f.operations.setDefault({ identity: 'docs', enabled: true, expectedRevision: 0 })
  expect(result.status, JSON.stringify(result)).toBe('validation-failed')
  expect(result.saved).toBe(false)
  expect(result.error.code).toBe('identity-unregistered')
  expect(JSON.stringify(await f.registry.read())).toBe(JSON.stringify(before))
})

test('a committed registry still rejects a stale expectedRevision without writing or probing', async () => {
  const f = fixture()
  const first = await f.operations.add({ identity: 'docs', expectedRevision: 0, config: config('docs') })
  expect(first.status, JSON.stringify(first)).toBe('mounted')
  const before = await f.registry.read()
  expect(before.revision).toBe(1)
  const stale = await f.operations.test({ identity: 'other', expectedRevision: 0, config: config('other') })
  expect(stale.status).toBe('revision-conflict')
  expect(stale.saved).toBe(false)
  expect(stale.registryRevision).toBe(before.revision)
  expect(f.calls.probe).toBe(0)
  const staleDefault = await f.operations.setDefault({ identity: 'docs', enabled: true, expectedRevision: 0 })
  expect(staleDefault.status, JSON.stringify(staleDefault)).toBe('revision-conflict')
  expect(staleDefault.registryRevision).toBe(before.revision)
  const staleDefaultNonzero = await f.operations.setDefault({ identity: 'docs', enabled: true, expectedRevision: 5 })
  expect(staleDefaultNonzero.status, JSON.stringify(staleDefaultNonzero)).toBe('revision-conflict')
  expect((await f.registry.read()).enabled).toEqual([])
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
test('credential backend causes cannot leak known secrets through operation payloads or audit', async () => {
  const f = fixture()
  const known = 's3cr3t-do-not-leak'
  f.credentials.set = async () => { throw new Error(`credential backend rejected ${known}`) }
  const result = await f.operations.add({ identity: 'docs', config: config('docs', { env: { TOKEN: known } }) })
  expect(result.status).toBe('validation-failed')
  expect(result.error.causes.length).toBeGreaterThan(1)
  expect(JSON.stringify({ result, audit: f.audit })).not.toContain(known)
})
test('identical external attempt IDs never share refs or let loser compensation unset a winner', async () => {
  let markFirstStaged, markBothStaged, releaseWinner
  const firstStaged = new Promise(resolve => { markFirstStaged = resolve })
  const bothStaged = new Promise(resolve => { markBothStaged = resolve })
  const winnerProbe = new Promise(resolve => { releaseWinner = resolve })
  const f = fixture({ probeStatus: async (_entry, call) => {
    if (call === 1) { await bothStaged; return 'probe-failed' }
    await winnerProbe
    return 'mounted'
  } })
  const originalSet = f.credentials.set
  f.credentials.set = async (...args) => {
    await originalSet(...args)
    if (f.sets.length === 1) markFirstStaged()
    if (f.sets.length === 2) markBothStaged()
  }
  const loser = f.operations.test({ identity: 'docs', config: config('docs'), attemptId: 'deadbeef' })
  await firstStaged
  const winner = f.operations.test({ identity: 'docs', config: config('docs'), attemptId: 'deadbeef' })
  try {
    await bothStaged
    expect((await loser).status).toBe('probe-failed')
    const [loserRef, winnerRef] = f.sets.map(([ref]) => ref)
    expect(winnerRef).not.toBe(loserRef)
    expect(f.values.get(winnerRef)).toBe(secret)
  } finally {
    releaseWinner()
    await winner
  }
})
test('new-value secret prefixes survive parsing, staging and replacement with the existing prefix preserved', async () => {
  const f = fixture()
  const added = await f.operations.add({ identity: 'docs', config: {
    identity: 'docs', command: process.execPath, args: [''], env: {},
    secretValues: {
      env: { TOKEN: { action: 'replace', value: 'old-token', prefix: 'Bearer ' } },
      args: { 0: { action: 'replace', value: 'next-token', prefix: 'Bearer ' } },
    },
  } })
  expect(added.status, JSON.stringify(added)).toBe('mounted')
  let registered = (await f.registry.read()).servers.docs
  expect(registered.secretRefs.env.TOKEN.prefix).toBe('Bearer ')
  expect(registered.secretRefs.args[0].prefix).toBe('Bearer ')
  const edited = await f.operations.edit({ identity: 'docs', expectedRevision: (await f.registry.read()).revision, config: {
    secretValues: { env: { TOKEN: { action: 'replace', value: 'next-token' } } },
  } })
  expect(edited.status, JSON.stringify(edited)).toBe('mounted')
  registered = (await f.registry.read()).servers.docs
  const effective = await materializeMcpClientConfig(registered, f.credentials)
  expect(effective.client.env.TOKEN).toBe('Bearer next-token')
  expect(effective.client.args[0]).toBe('Bearer next-token')
})
test('restart and remove revalidate the target fingerprint against the immediate pre-CAS read', async () => {
  for (const action of ['restart', 'remove']) {
    const f = fixture()
    await f.operations.add({ identity: 'docs', config: config('docs') })
    const before = await f.registry.read()
    const originalRead = f.registry.read
    const originalRegister = f.registry.register
    const originalRemove = f.registry.remove
    let reads = 0
    let writes = 0
    f.registry.read = async () => {
      reads += 1
      if (reads === 2) {
        const latest = await originalRead()
        await originalRegister({ ...latest.servers.docs, label: 'external-edit' }, latest.revision)
      }
      return originalRead()
    }
    f.registry.register = async (...args) => { writes += 1; return originalRegister(...args) }
    f.registry.remove = async (...args) => { writes += 1; return originalRemove(...args) }
    const result = await f.operations[action]({
      identity: 'docs', expectedRevision: before.revision, targetFingerprint: fingerprintMcpEntry(before.servers.docs),
    })
    expect(result.status, `${action}: ${JSON.stringify(result)}`).toBe('revision-conflict')
    expect(writes, `${action} must not overwrite the external edit`).toBe(0)
    const after = await originalRead()
    expect(after.servers.docs.label).toBe('external-edit')
    expect(after.servers.docs.generation).toBe(2)
  }
})
test('ownership flips during the add and approved-AI pre-CAS reads prevent every registry write', async () => {
  for (const action of ['add', 'installFromAgent']) {
    let owned = true
    const f = fixture({ assertOwner: async () => { if (!owned) throw new Error('preset changed') } })
    const originalRead = f.registry.read
    const originalRegister = f.registry.register
    let reads = 0
    let writes = 0
    f.registry.read = async () => {
      const current = await originalRead()
      reads += 1
      if (reads === 2) owned = false
      return current
    }
    f.registry.register = async (...args) => { writes += 1; return originalRegister(...args) }
    const result = action === 'add'
      ? await f.operations.add({ identity: 'docs', config: config('docs') })
      : await f.operations.installFromAgent({ identity: 'docs', config: { identity: 'docs', command: 'node', env: { TOKEN: { ref: 'USER_TOKEN' } } } })
    expect(result.status, `${action}: ${JSON.stringify(result)}`).toBe('owner-changed')
    expect(result.saved).toBe(false)
    expect(writes, `${action} wrote after ownership was lost`).toBe(0)
    expect((await originalRead()).kind).toBe('absent')
  }
})

test('ownership flip during the remove pre-CAS read leaves the registration intact', async () => {
  let owned = true
  const f = fixture({ assertOwner: async () => { if (!owned) throw new Error('preset changed') } })
  await f.operations.add({ identity: 'docs', config: config('docs') })
  const originalRead = f.registry.read
  const originalRemove = f.registry.remove
  let reads = 0
  let writes = 0
  f.registry.read = async () => {
    const current = await originalRead()
    reads += 1
    if (reads === 2) owned = false
    return current
  }
  f.registry.remove = async (...args) => { writes += 1; return originalRemove(...args) }
  const result = await f.operations.remove({ identity: 'docs' })
  expect(result.status, JSON.stringify(result)).toBe('owner-changed')
  expect(result.saved).toBe(false)
  expect(writes).toBe(0)
  expect((await originalRead()).servers.docs).toBeTruthy()
})

test('ownership flip during the setDefault read prevents the defaults write', async () => {
  let owned = true
  const f = fixture({ assertOwner: async () => { if (!owned) throw new Error('preset changed') } })
  await f.operations.add({ identity: 'docs', config: config('docs') })
  const originalRead = f.registry.read
  const originalSetDefault = f.registry.setDefault
  let reads = 0
  let writes = 0
  f.registry.read = async () => {
    const current = await originalRead()
    reads += 1
    if (reads === 1) owned = false
    return current
  }
  f.registry.setDefault = async (...args) => { writes += 1; return originalSetDefault(...args) }
  const result = await f.operations.setDefault({ identity: 'docs', enabled: true })
  expect(result.status, JSON.stringify(result)).toBe('owner-changed')
  expect(result.saved).toBe(false)
  expect(writes).toBe(0)
  expect((await originalRead()).enabled).toEqual([])
})
test('batch stages and probes every item before CAS and continues after a probe failure', async () => {
  const f = fixture({ probeStatus: entry => {
    const ref = entry.secretRefs?.env?.TOKEN?.ref
    if (!ref || f.values.get(ref) !== secret) throw new Error('probe ran before credential staging')
    return entry.identity === 'bad' ? 'probe-failed' : 'mounted'
  } })
  const result = await f.operations.executeBatch({ document: { mcpServers: { first: config('first'), bad: config('bad'), last: config('last') } } })
  expect(result.status, JSON.stringify(result)).toBe('partial')
  expect(result.items.map(item => item.status)).toEqual(['mounted', 'probe-failed', 'mounted'])
  expect(f.calls.probe).toBe(3)
  expect(f.calls.mount).toBe(2)
  expect(f.sets).toHaveLength(3)
  const current = await f.registry.read()
  expect(current.servers.bad).toBeUndefined()
  expect(Object.keys(current.servers)).toEqual(['first', 'last'])
  expect(current.revision).toBe(2)
})
test('cleanup diagnostics retain attempt-secret metadata without serializing that metadata', async () => {
  const f = fixture({ probeStatus: 'probe-failed' })
  f.credentials.unset = async () => { throw new Error(`credential cleanup rejected ${secret}`) }
  const result = await f.operations.test({ identity: 'docs', config: config('docs') })
  expect(result.status).toBe('cleanup-failed')
  expect(JSON.stringify({ result, audit: f.audit })).not.toContain(secret)
})
