// Per-identity Operation Coordination contracts (mcp-management-deepening 2.1/2.2).
// These tests use the real manager/runtime/drain/operations and the unchanged
// mutable manager face. Mount and registry controls only make overlap visible.
import { test, expect } from './helpers.js'
import { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpManager } from '../src/capabilities/mcp-manager.js'
import { createMcpOperations } from '../src/capabilities/mcp-operations.js'
import { createMcpRegistry } from '../src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}
const record = identity => ({
  identity, label: identity, owner: { kind: 'global', key: 'installation' }, generation: 0, configuredAt: 0,
  transport: { kind: 'stdio', ref: 'cmd:node' },
  client: { transport: 'stdio', serverName: identity, command: process.execPath, args: [], env: {} },
})

function mountDouble() {
  const mounted = new Map()
  const events = []
  const gates = { mount: null, probe: null, unmount: null }
  return {
    mounted, events, gates,
    async sweepResidue(ids) { return ids },
    async mount(options) {
      events.push(`mount-start:${options.identity}:${options.generation}`)
      if (gates.mount) await gates.mount.promise
      await options.beforeCreate?.()
      await options.readback?.()
      mounted.set(options.identity, { groupId: `weir-mcp-${options.identity}`, generation: options.generation, state: 'mounted' })
      events.push(`mount-end:${options.identity}:${options.generation}`)
      return { status: 'mounted', discovery: { toolCount: 0, toolNamesPreview: [], truncated: false } }
    },
    async unmount(identity) {
      events.push(`unmount:${identity}`)
      if (gates.unmount) await gates.unmount.promise
      mounted.delete(identity)
      return { status: 'cleaned', removed: true }
    },
    async probe(options) {
      const target = options.client?.serverName ?? 'probe'
      events.push(`probe-start:${target}`)
      if (gates.probe) await gates.probe.promise
      events.push(`probe-end:${target}`)
      return { status: 'mounted', discovery: { toolCount: 0, toolNamesPreview: [], truncated: false }, cleanup: { status: 'cleaned' } }
    },
  }
}

const activeFixtures = new Set()
async function cleanupFixtures() {
  for (const fixture of [...activeFixtures]) {
    for (const identity of [...fixture.face.mounted.keys()]) await fixture.face.removeRuntime(identity)
    fixture.dispose()
    activeFixtures.delete(fixture)
  }
}
afterEach(cleanupFixtures)
async function fixture() {
  await cleanupFixtures()
  const root = mkdtempSync(join(tmpdir(), 'weir-mcp-coordinator-'))
  const registry = createMcpRegistry({ store: openCapabilityStore({ root, platform: 'darwin' }), newIncarnation: () => null })
  let revision = 0
  for (const identity of ['docs', 'web']) revision = (await registry.register(record(identity), revision)).revision
  const mount = mountDouble()
  const services = new Map()
  const accepted = ['docs', 'web', 'adopted', 'fresh']
  const lifecycle = { snapshotFor: () => ({ state: 'ready', mcpServers: accepted, mcpIncarnations: Object.fromEntries(accepted.map(identity => [identity, null])) }) }
  const dispose = createMcpManager({ registry, mount, lifecycle, listRows: () => [], listEntryIds: () => [] })({
    get: () => undefined, on() {}, reflect: { provide: (key, value) => services.set(key, value) }, logger: { warn() {} },
  }, {})
  const face = services.get('weirMcpManager')
  await face.start()
  const fixture = { face, dispose }
  activeFixtures.add(fixture)
  const operations = createMcpOperations({ registry, manager: face, credentials: undefined })
  const agent = { session: { id: 's1' } }
  const healthy = identity => {
    if (face.runtime.snapshot(identity).phase !== 'mounted' || !face.gate.enabledFor(agent, identity)) return false
    const call = face.drain.enter('s1', identity, 'health-check')
    if (call === null) return false
    face.drain.exit('s1', identity, call)
    return true
  }
  const request = async (identity = 'docs', extra = {}) => {
    const current = await registry.read()
    const row = (await face.list()).managed.find(item => item.identity === identity)
    return { identity, expectedRevision: current.revision, targetFingerprint: row.fingerprint, ...extra }
  }
  return { registry, mount, face, operations, healthy, request }
}

test('fresh add-mode Test is probe-only and bypasses the named identity queue and fence', async () => {
  const f = await fixture()
  const entered = deferred()
  const hold = deferred()
  const blocker = f.face.serialize('fresh', async () => { entered.resolve(); await hold.promise })
  await entered.promise
  const before = f.face.runtime.snapshot('fresh')
  try {
    const testing = f.operations.test({ identity: 'fresh', config: { identity: 'fresh', command: process.execPath, args: [] } })
    await until(() => f.mount.events.includes('probe-start:fresh'), 'the unqueued fresh probe')
    expect(f.face.runtime.snapshot('fresh')).toEqual(before)
    expect(f.face.drain.isClosed('s1', 'fresh')).toBe(false)
    const result = await testing
    expect(result.status).toBe('mounted')
    expect(result.saved).toBe(false)
    expect(result.probe).toBe(true)
    expect((await f.registry.read()).servers.fresh).toBeUndefined()
  } finally {
    hold.resolve()
    await blocker
  }
})

test('a delayed identity does not block another identity through the shared operations face', async () => {
  const f = await fixture()
  const entered = deferred()
  const hold = deferred()
  const blocker = f.face.serialize('docs', async () => { entered.resolve(); await hold.promise })
  await entered.promise
  const docsMounts = f.mount.events.filter(event => event.startsWith('mount-start:docs:')).length
  try {
    const docs = f.operations.restart(await f.request('docs', { expectedRevision: undefined }))
    const web = f.operations.restart(await f.request('web', { expectedRevision: undefined }))
    await until(() => f.mount.events.includes('mount-end:web:2'), 'the independent web restart')
    expect((await web).status).toBe('mounted')
    expect(f.mount.events.filter(event => event.startsWith('mount-start:docs:')).length).toBe(docsMounts)
    hold.resolve()
    expect((await docs).status).toBe('mounted')
    expect(f.healthy('docs')).toBe(true)
    expect(f.healthy('web')).toBe(true)
    await blocker
  } finally {
    hold.resolve()
    await blocker
  }
})

test('a rejected queue task and a CAS rejection do not poison later work or admission', async () => {
  const f = await fixture()
  await assert.rejects(f.face.serialize('docs', async () => { throw new Error('injected rejected task') }), /injected rejected task/)
  const conflicted = await f.operations.edit({ ...(await f.request()), expectedRevision: 0, config: { label: 'stale' } })
  expect(conflicted.status).toBe('revision-conflict')
  expect(f.healthy('docs')).toBe(true)
  const restarted = await f.operations.restart(await f.request())
  expect(restarted.status, JSON.stringify(restarted)).toBe('mounted')
  expect(f.healthy('docs')).toBe(true)
})

test('every fenced operations entry point closes admission before its first registry read', async () => {
  for (const action of ['add', 'edit', 'restart', 'remove', 'test']) {
    const f = await fixture()
    const read = f.registry.read.bind(f.registry)
    let observed = null
    f.registry.read = async () => {
      const identity = action === 'add' ? 'fresh' : 'docs'
      observed ??= { phase: f.face.runtime.snapshot(identity).phase, closed: f.face.drain.isClosed('s1', identity) }
      return read()
    }
    const result = action === 'add'
      ? await f.operations.add({ identity: 'fresh', config: { identity: 'fresh', command: process.execPath, args: [] } })
      : action === 'edit'
        ? await f.operations.edit({ identity: 'docs', config: { label: 'Edited' } })
        : action === 'restart'
          ? await f.operations.restart({ identity: 'docs' })
          : action === 'remove'
            ? await f.operations.remove({ identity: 'docs' })
            : await f.operations.test({ identity: 'docs', mode: 'edit', config: { label: 'Edited Test' } })
    expect(result.status, `${action}: ${JSON.stringify(result)}`).toBe(action === 'remove' ? 'removed' : 'mounted')
    expect(observed, action).toEqual({ phase: action === 'remove' ? 'removing' : 'replacing', closed: true })
  }
})

test('direct reconcileOne and remove calls join the face queue unless a slot token is supplied', async () => {
  for (const action of ['reconcile', 'remove']) {
    const f = await fixture()
    const current = (await f.registry.read()).servers.docs
    const entered = deferred()
    const hold = deferred()
    const blocker = f.face.serialize('docs', async () => { entered.resolve(); await hold.promise })
    await entered.promise
    try {
      const pending = action === 'reconcile' ? f.face.reconcileOne('docs', current) : f.face.remove('docs')
      await settle()
      expect(f.mount.events).not.toContain('unmount:docs')
      hold.resolve()
      const result = await pending
      expect(result.status, `${action}: ${JSON.stringify(result)}`).toBe(action === 'remove' ? 'removed' : 'mounted')
      expect(f.mount.events).toContain('unmount:docs')
      await blocker
    } finally {
      hold.resolve()
      await blocker
    }
  }
})

test('adoption CAS rejection restores admission and permits a later adoption', async () => {
  const f = await fixture()
  const register = f.registry.register.bind(f.registry)
  let reject = true
  f.registry.register = async (entry, revision) => {
    if (entry.identity === 'adopted' && reject) { reject = false; return { status: 'revision-conflict', revision } }
    return register(entry, revision)
  }
  const rejected = await f.face.adopt(record('adopted'))
  expect(rejected).toEqual({ status: 'registry-failed', result: 'revision-conflict' })
  expect(f.face.runtime.snapshot('adopted').phase).toBe('unknown')
  const adopted = await f.face.adopt(record('adopted'))
  expect(adopted.status, JSON.stringify(adopted)).toBe('mounted')
  expect(f.healthy('adopted')).toBe(true)
})

test('adoption closes admission synchronously before its first registry read', async () => {
  const f = await fixture()
  const read = f.registry.read.bind(f.registry)
  const observed = []
  f.registry.read = async () => {
    observed.push({ phase: f.face.runtime.snapshot('adopted').phase, closed: f.face.drain.isClosed('s1', 'adopted') })
    return read()
  }
  const result = await f.face.adopt(record('adopted'))
  expect(result.status, JSON.stringify(result)).toBe('mounted')
  expect(observed.length).toBeGreaterThan(0)
  expect(observed[0]).toEqual({ phase: 'replacing', closed: true })
})

test('a selected recovery closes admission before rereading its identity inside the queue slot', async () => {
  const f = await fixture()
  f.face.mounted.delete('docs')
  const read = f.registry.read.bind(f.registry)
  const observed = []
  f.registry.read = async () => {
    observed.push({ phase: f.face.runtime.snapshot('docs').phase, closed: f.face.drain.isClosed('s1', 'docs') })
    return read()
  }
  const result = await f.face.recoverResidue({ identity: 'docs' })
  expect(result.status, JSON.stringify(result)).toBe('recovered')
  expect(observed.length).toBeGreaterThan(1)
  // The first read selects candidates; the second is the per-identity slot reread.
  expect(observed[1]).toEqual({ phase: 'replacing', closed: true })
  expect(f.healthy('docs')).toBe(true)
})

test('adoption and a queued edit share one order and the edit commits after adoption', async () => {
  const f = await fixture()
  const register = f.registry.register.bind(f.registry)
  const entered = deferred()
  const hold = deferred()
  f.registry.register = async (entry, revision) => {
    if (entry.identity === 'adopted' && entry.generation === 0) {
      f.mount.events.push('adopt-register-start')
      entered.resolve()
      await hold.promise
      f.mount.events.push('adopt-register-end')
    }
    return register(entry, revision)
  }
  const adopting = f.face.adopt(record('adopted'))
  await entered.promise
  const editing = f.operations.edit({ identity: 'adopted', config: { label: 'Edited after adoption' } })
  await settle()
  expect(f.mount.events).not.toContain('mount-start:adopted:2')
  hold.resolve()
  const [adopted, edited] = await Promise.all([adopting, editing])
  expect(adopted.status, JSON.stringify(adopted)).toBe('mounted')
  expect(edited.status, JSON.stringify(edited)).toBe('mounted')
  expect(edited.generation).toBe(2)
  const current = (await f.registry.read()).servers.adopted
  expect(current.label).toBe('Edited after adoption')
  expect(current.generation).toBe(2)
  expect(f.mount.events.indexOf('adopt-register-end') < f.mount.events.indexOf('mount-start:adopted:2')).toBe(true)
  expect(f.healthy('adopted')).toBe(true)
})

test('recovery queued behind an edit rereads the committed generation and does not overwrite it', async () => {
  const f = await fixture()
  f.mount.gates.unmount = deferred()
  const editing = f.operations.edit({ ...(await f.request()), config: { label: 'Edited before recovery' } })
  await until(() => f.mount.events.includes('unmount:docs'), 'the edit unmount')
  const recovering = f.face.recoverResidue({ identity: 'docs' })
  await settle()
  expect(f.mount.events.filter(event => event.startsWith('mount-start:docs:')).length).toBe(1)
  f.mount.gates.unmount.resolve()
  const [edited, recovered] = await Promise.all([editing, recovering])
  expect(edited.status, JSON.stringify(edited)).toBe('mounted')
  expect(recovered.status, JSON.stringify(recovered)).toBe('recovered')
  expect(recovered.results).toEqual([{ status: 'mounted', identity: 'docs', generation: 2, alreadyHealthy: true }])
  expect((await f.registry.read()).servers.docs.label).toBe('Edited before recovery')
  expect(f.mount.events.filter(event => event.startsWith('mount-start:docs:')).length).toBe(2)
  expect(f.healthy('docs')).toBe(true)
})

test('recovery and a queued restart share one mount order and finish admitting', async () => {
  const f = await fixture()
  f.face.mounted.delete('docs')
  f.mount.gates.mount = deferred()
  const recovering = f.face.recoverResidue({ identity: 'docs' })
  await until(() => f.mount.events.includes('mount-start:docs:1'), 'the recovery mount')
  const restarting = f.operations.restart(await f.request())
  await settle()
  expect(f.mount.events).not.toContain('unmount:docs')
  f.mount.gates.mount.resolve()
  const [recovered, restarted] = await Promise.all([recovering, restarting])
  expect(recovered.status, JSON.stringify(recovered)).toBe('recovered')
  expect(restarted.status, JSON.stringify(restarted)).toBe('mounted')
  expect(restarted.generation).toBe(2)
  expect(f.mount.events.indexOf('mount-end:docs:1') < f.mount.events.indexOf('unmount:docs')).toBe(true)
  expect(f.healthy('docs')).toBe(true)
})

test('the mutable plain manager face routes queued operations through a monkey-patched reconcileOne', async () => {
  const f = await fixture()
  expect(Object.getPrototypeOf(f.face)).toBe(Object.prototype)
  for (const name of ['beginOperation', 'abortOperation', 'reconcileOne', 'serialize']) expect(typeof f.face[name]).toBe('function')
  expect(Object.getOwnPropertyDescriptor(f.face, 'reconcileOne').writable).toBe(true)
  const entered = deferred()
  const hold = deferred()
  const blocker = f.face.serialize('docs', async () => { entered.resolve(); await hold.promise })
  await entered.promise
  const original = f.face.reconcileOne
  const calls = []
  f.face.reconcileOne = async (...args) => { calls.push(args); return original(...args) }
  try {
    const restarting = f.operations.restart(await f.request())
    await settle()
    expect(calls).toHaveLength(0)
    hold.resolve()
    const result = await restarting
    expect(result.status, JSON.stringify(result)).toBe('mounted')
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('docs')
    expect(calls[0][2].operationId).toBe(result.mount ? f.face.runtime.snapshot('docs').operationId : null)
  } finally {
    hold.resolve()
    f.face.reconcileOne = original
    await blocker
  }
})
