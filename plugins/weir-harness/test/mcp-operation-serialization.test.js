// Review P1-2: overlapping same-identity MCP operations must never leave a
// server mounted but refusing calls. A real manager (runtime fence, drain,
// gate) and real operations run against a controllable Loader mount double.
import { test, expect } from './helpers.js'
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

function mountDouble() {
  const mounted = new Map()
  const events = []
  const gates = { probe: null, unmount: null }
  return {
    mounted, events, gates,
    async sweepResidue() { return [] },
    async mount(options) {
      events.push('mount')
      await options.beforeCreate?.()
      await options.readback?.()
      mounted.set(options.identity, { groupId: `weir-mcp-${options.identity}`, generation: options.generation, state: 'mounted' })
      return { status: 'mounted', discovery: { toolCount: 0, toolNamesPreview: [], truncated: false } }
    },
    async unmount(identity) {
      events.push('unmount')
      if (gates.unmount) await gates.unmount.promise
      mounted.delete(identity)
      return { status: 'cleaned', removed: true }
    },
    async probe() {
      events.push('probe-start')
      if (gates.probe) await gates.probe.promise
      events.push('probe-end')
      return { status: 'mounted', discovery: { toolCount: 0, toolNamesPreview: [], truncated: false }, cleanup: { status: 'cleaned' } }
    },
  }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weir-mcp-serial-'))
  const registry = createMcpRegistry({ store: openCapabilityStore({ root, platform: 'darwin' }), newIncarnation: () => null })
  await registry.register({
    identity: 'docs', label: 'docs', owner: { kind: 'global', key: 'installation' }, generation: 0, configuredAt: 0,
    transport: { kind: 'stdio', ref: 'cmd:node' },
    client: { transport: 'stdio', serverName: 'docs', command: process.execPath, args: [], env: {} },
  }, 0)
  const mount = mountDouble()
  const services = new Map()
  const lifecycle = { snapshotFor: () => ({ state: 'ready', mcpServers: ['docs'], mcpIncarnations: { docs: null } }) }
  createMcpManager({ registry, mount, lifecycle, listRows: () => [], listEntryIds: () => [] })({
    get: () => undefined, on() {}, reflect: { provide: (key, value) => services.set(key, value) }, logger: { warn() {} },
  }, {})
  const face = services.get('weirMcpManager')
  await face.start()
  const operations = createMcpOperations({ registry, manager: face, credentials: undefined })
  const agent = { session: { id: 's1' } }
  const admits = () => {
    const token = face.drain.enter('s1', 'docs', 'probe-call')
    if (token === null) return false
    face.drain.exit('s1', 'docs', token)
    return true
  }
  const healthy = () => face.runtime.snapshot('docs').phase === 'mounted' && face.gate.enabledFor(agent, 'docs') && admits()
  const row = async () => (await face.list()).managed[0]
  const request = async (extra = {}) => {
    const current = await registry.read()
    return { identity: 'docs', expectedRevision: current.revision, targetFingerprint: (await row()).fingerprint, ...extra }
  }
  return { registry, mount, face, operations, healthy, row, request }
}

test('Restart during an edit-mode Test waits for the Test and the server ends mounted and admitting', async () => {
  const f = await fixture()
  expect(f.healthy()).toBe(true)
  f.mount.gates.probe = deferred()
  const testing = f.operations.test({ ...(await f.request()), mode: 'edit', config: { label: 'docs' } })
  await until(() => f.mount.events.includes('probe-start'), 'the Test probe')
  const restarting = f.operations.restart(await f.request())
  await settle()
  // Serialized: the Restart has not touched the mount while the Test holds the identity.
  expect(f.mount.events.filter(event => event === 'mount')).toHaveLength(1)
  f.mount.gates.probe.resolve()
  const [tested, restarted] = await Promise.all([testing, restarting])
  expect(tested.status, JSON.stringify(tested)).toBe('mounted')
  expect(restarted.status, JSON.stringify(restarted)).toBe('mounted')
  expect(f.mount.events.indexOf('probe-end') < f.mount.events.lastIndexOf('unmount')).toBe(true)
  expect(f.healthy()).toBe(true)
  expect((await f.row()).state).toBe('mounted')
})

test('an edit-mode Test during a Restart cannot strand the remounted server closed', async () => {
  const f = await fixture()
  f.mount.gates.unmount = deferred()
  const restarting = f.operations.restart(await f.request())
  await until(() => f.mount.events.includes('unmount'), 'the Restart unmount')
  const testing = f.operations.test({ ...(await f.request()), mode: 'edit', config: { label: 'docs' } })
  await settle()
  expect(f.mount.events).not.toContain('probe-start')
  f.mount.gates.unmount.resolve()
  const [restarted, tested] = await Promise.all([restarting, testing])
  expect(restarted.status, JSON.stringify(restarted)).toBe('mounted')
  expect(tested.status, JSON.stringify(tested)).toBe('mounted')
  expect(f.healthy()).toBe(true)
  expect((await f.row()).state).toBe('mounted')
})

test('a superseded fence never reports mounted or reopens admission', async () => {
  const f = await fixture()
  const current = (await f.registry.read()).servers.docs
  const first = f.face.beginOperation('docs')
  const second = f.face.beginOperation('docs')
  const result = await f.face.reconcileOne('docs', current, first)
  expect(result.status).toBe('indeterminate')
  expect(result.error.code).toBe('operation-superseded')
  expect(f.face.drain.isClosed('s1', 'docs')).toBe(true)
  expect(f.face.runtime.snapshot('docs').operationId).toBe(second.operationId)
  expect((await f.face.reconcileOne('docs', current, second)).status).toBe('mounted')
  expect(f.healthy()).toBe(true)
})
