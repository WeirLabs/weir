import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import {
  createMcpMount,
  mcpGroupOptions,
  resolveEphemeralMcpTree,
  strictMcpClientConfig,
} from '../src/capabilities/mcp-mount.js'
import { mcpDiagnostic, sanitizeMcpPayload, MCP_DIAGNOSTIC_LIMIT } from '../src/capabilities/mcp-diagnostics.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function loaderFixture() {
  const entries = new Map()
  const created = []
  const removed = []
  const order = []
  const fixture = {
    entries, created, removed, order, profileWrites: 0,
    awaitError: null, awaitPromise: null, removeError: null, disposeDelay: null,
  }
  const add = (id, options = {}) => {
    const fiber = {
      uid: 1, state: 2,
      async dispose() {
        order.push(`dispose:${id}`)
        if (fixture.disposeDelay) await fixture.disposeDelay.promise
        fiber.uid = null
        fiber.state = 5
      },
      async await() { return fiber },
    }
    const entry = { id, options: { id, ...options }, fiber }
    entries.set(id, entry)
    return entry
  }
  const root = {
    async create(options) {
      order.push(`create:${options.id}`)
      created.push(options)
      add(options.id, options)
      for (const child of options.config ?? []) add(`${options.id}:${child.id}`, child)
      return options.id
    },
    async remove(id) {
      order.push(`remove:${id}`)
      if (fixture.removeError) throw fixture.removeError
      removed.push(id)
      for (const key of [...entries.keys()]) if (key === id || key.startsWith(`${id}:`)) entries.delete(key)
    },
  }
  const loader = {
    root,
    async create(options) { fixture.profileWrites += 1; return root.create(options) },
    async remove(id) { fixture.profileWrites += 1; return root.remove(id) },
    async await() { if (fixture.awaitError) throw fixture.awaitError; if (fixture.awaitPromise) await fixture.awaitPromise },
    resolve(id) {
      const direct = entries.get(id)
      if (direct) return direct
      const nested = [...entries.values()].find(entry => entry.id.endsWith(`:${id}`) || entry.options.id === id)
      if (!nested) throw new Error(`cannot resolve ${id}`)
      return nested
    },
    entries() { return entries.values() },
    store: {},
  }
  root.tree = loader
  fixture.loader = loader
  fixture.fiberOf = async groupId => loader.resolve(`${groupId}:${groupId}-client`).fiber
  fixture.add = add
  return fixture
}

const client = (serverName = 'docs') => ({ transport: 'stdio', serverName, command: process.execPath, args: [], failOnStartupError: false })
const mountedInput = (fixture, extras = {}) => ({ identity: 'docs', generation: 1, client: client(), fiberOf: fixture.fiberOf, ...extras })

test('ephemeral root group canary mounts facade/group with zero profile writes and preserves isolated scope', async () => {
  const fixture = loaderFixture()
  const resolved = resolveEphemeralMcpTree(fixture.loader)
  expect(resolved.kind).toBe('ok')
  const bridge = []
  const mount = createMcpMount({ loader: fixture.loader })
  await mount.mount(mountedInput(fixture, {
    secretBearing: true,
    secrets: ['canary-value'],
    beforeCreate: ({ ephemeral, groupId }) => bridge.push({ ephemeral, groupId, host: 'host-tools', preset: 'weir' }),
  }))
  expect(fixture.profileWrites).toBe(0)
  expect(bridge).toEqual([{ ephemeral: true, groupId: 'weir-mcp-docs', host: 'host-tools', preset: 'weir' }])
  const group = fixture.created[0]
  expect(group.isolate).toEqual({ tools: true, systemPrompt: true, mcpResources: true })
  expect(group.config[0].name).toBe('weir-harness/mcp-facade-plugin')
  expect(group.config[1].config.failOnStartupError).toBe(true)
  expect(JSON.stringify(group)).not.toContain('canary-value')
  await mount.unmount('docs')
  expect(fixture.profileWrites).toBe(0)
  expect(fixture.entries.size).toBe(0)
})

test('unsupported Loader shape rejects secret-bearing work before side effects; only secret-free legacy path may write through', async () => {
  const fixture = loaderFixture()
  const broken = { create: fixture.loader.create, remove: fixture.loader.remove, await: fixture.loader.await }
  expect(resolveEphemeralMcpTree(broken).kind).toBe('unsupported')
  let bridgeCalls = 0
  const mount = createMcpMount({ loader: broken, startupTimeoutMs: 5 })
  await assert.rejects(mount.mount(mountedInput(fixture, { secretBearing: true, beforeCreate: () => { bridgeCalls += 1 } })), error => error.status === 'unsupported')
  expect(bridgeCalls).toBe(0)
  expect(fixture.profileWrites).toBe(0)
  // Explicit legacy compatibility remains available only without secrets.
  await mount.mount(mountedInput(fixture, { fiberOf: async () => ({ state: 'running' }) }))
  expect(fixture.profileWrites).toBe(1)
})

test('delayed asynchronous disposal is the barrier before remove and same-name replacement', async () => {
  const fixture = loaderFixture()
  const mount = createMcpMount({ loader: fixture.loader })
  await mount.mount(mountedInput(fixture))
  fixture.disposeDelay = deferred()
  let settled = false
  const pending = mount.unmount('docs').then(result => { settled = true; return result })
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(settled).toBe(false)
  expect(fixture.removed).toEqual([])
  let replacementSettled = false
  const replacement = mount.mount(mountedInput(fixture, { generation: 2 })).then(result => { replacementSettled = true; return result })
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(replacementSettled).toBe(false)
  expect(fixture.created).toHaveLength(1)
  fixture.disposeDelay.resolve()
  expect((await pending).status).toBe('cleaned')
  assert.ok(fixture.order.indexOf('dispose:weir-mcp-docs:weir-mcp-docs-client') < fixture.order.indexOf('remove:weir-mcp-docs'))
  expect((await replacement).status).toBe('mounted')
  expect(mount.mounted.get('docs').generation).toBe(2)
})

test('remove rejection is cleanup-failed and blocks immediate same-name replacement', async () => {
  const fixture = loaderFixture()
  const mount = createMcpMount({ loader: fixture.loader })
  await mount.mount(mountedInput(fixture))
  fixture.removeError = new Error('injected remove rejection')
  const result = await mount.unmount('docs')
  expect(result.status).toBe('cleanup-failed')
  const creates = fixture.created.length
  await assert.rejects(mount.mount(mountedInput(fixture)), error => error.status === 'cleanup-failed')
  expect(fixture.created.length).toBe(creates)
})

test('startup timeout enters disposal and never reports fiber-ready success', async () => {
  const fixture = loaderFixture()
  fixture.awaitPromise = new Promise(() => {})
  const mount = createMcpMount({ loader: fixture.loader, startupTimeoutMs: 5, cleanupTimeoutMs: 20 })
  await assert.rejects(mount.mount(mountedInput(fixture)), error => error.status === 'mount-failed' && error.code === 'timeout' && error.cleanup.status === 'cleaned')
  expect(fixture.entries.size).toBe(0)
  expect(mount.mounted.has('docs')).toBe(false)
})

test('unconfirmed transport close is cleanup-unknown and blocks same-name replacement', async () => {
  const fixture = loaderFixture()
  const mount = createMcpMount({ loader: fixture.loader })
  await mount.mount(mountedInput(fixture))
  const result = await mount.unmount('docs', {}, { confirmClosed: async () => false })
  expect(result.status).toBe('cleanup-unknown')
  await assert.rejects(mount.mount(mountedInput(fixture)), error => error.status === 'cleanup-unknown')
})

test('strict config overrides non-strict legacy policy and probe always disables reconnect', () => {
  const managed = strictMcpClientConfig(client())
  expect(managed.failOnStartupError).toBe(true)
  expect(managed.reconnect).toBeUndefined()
  const probe = strictMcpClientConfig({ ...client(), reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } }, { probe: true })
  expect(probe.failOnStartupError).toBe(true)
  expect(probe.reconnect).toEqual({ enabled: false, initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 })
})

test('initial discovery failure is not mounted; zero-tool discovery is a valid strict success', async () => {
  const failure = loaderFixture()
  failure.awaitError = new Error('fiber became ready despite initial connection failure', { cause: new Error('ECONNREFUSED') })
  const failedMount = createMcpMount({ loader: failure.loader })
  await assert.rejects(failedMount.mount(mountedInput(failure)), error => error.status === 'mount-failed' && error.code === 'connection-refused')
  expect(failedMount.mounted.size).toBe(0)

  const empty = loaderFixture()
  const mount = createMcpMount({ loader: empty.loader })
  const result = await mount.mount(mountedInput(empty, { discovery: () => ({ toolCount: 0, toolNamesPreview: [], truncated: false }) }))
  expect(result.status).toBe('mounted')
  expect(result.discovery.toolCount).toBe(0)
})

test('probe success and failure remove every test-owned row and bridge without registry/selection writes', async () => {
  const fixture = loaderFixture()
  const registry = { servers: {}, selection: ['docs'] }
  const before = JSON.stringify(registry)
  const bridges = new Map()
  const mount = createMcpMount({ loader: fixture.loader })
  const result = await mount.probe({
    client: client('ignored-probe-name'), secretBearing: true, fiberOf: fixture.fiberOf,
    beforeCreate: ({ groupId }) => bridges.set(groupId, { tools: ['mcp__probe__echo'] }),
    discovery: ({ groupId }) => ({ toolCount: bridges.get(groupId).tools.length, toolNamesPreview: bridges.get(groupId).tools, truncated: false }),
    afterCleanup: ({ groupId }) => bridges.delete(groupId),
  })
  expect(result.status).toBe('mounted')
  expect(result.discovery.toolCount).toBe(1)
  expect(result.cleanup.status).toBe('cleaned')
  expect(result.probe).toBe(true)
  expect(result.groupId).toMatch(/^weir-mcp-probe-/)
  expect(result.cleanup.removed).toBe(true)
  expect(fixture.entries.size).toBe(0)
  expect(bridges.size).toBe(0)
  expect(JSON.stringify(registry)).toBe(before)

  const failure = loaderFixture()
  failure.awaitError = new Error('initial HTTP 401', { cause: new Error('Authorization: Bearer super-secret') })
  const failed = createMcpMount({ loader: failure.loader })
  await assert.rejects(failed.probe({ client: client(), fiberOf: failure.fiberOf, secrets: ['super-secret'] }), error => {
    expect(error.status).toBe('probe-failed')
    expect(error.code).toBe('http-unauthorized')
    expect(JSON.stringify(error.diagnostic)).not.toContain('super-secret')
    return true
  })
  expect(failure.entries.size).toBe(0)
  expect(JSON.stringify(registry)).toBe(before)
})

test('diagnostics redact bounded cause chains, sensitive URLs, bearer/JWT, authorization, env assignments and known secrets', () => {
  const secret = 'canary-token-value'
  const error = new Error(`outer https://user:pass@example.test/mcp?token=${secret} Authorization: Bearer ${secret}`, {
    cause: new Error(`TOKEN=${secret} eyJaaa.bbb.ccc`, { cause: new Error('inner') }),
  })
  const diagnostic = mcpDiagnostic(error, { secrets: [secret] })
  const wire = JSON.stringify(sanitizeMcpPayload({ diagnostic, nested: [error.message] }, [secret]))
  for (const forbidden of [secret, 'user:pass', 'Bearer canary', 'TOKEN=canary', 'eyJaaa.bbb.ccc']) expect(wire).not.toContain(forbidden)
  expect(diagnostic.causes).toHaveLength(3)
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) <= MCP_DIAGNOSTIC_LIMIT)
  const giant = mcpDiagnostic(new Error(`x${'a'.repeat(20000)}`), { secrets: [] })
  assert.ok(Buffer.byteLength(JSON.stringify(giant)) <= MCP_DIAGNOSTIC_LIMIT)
})
test('failed first-mount cleanup persists its state and blocks any second same-name create', async () => {
  const fixture = loaderFixture()
  fixture.awaitError = new Error('injected startup failure')
  fixture.removeError = new Error('injected cleanup failure')
  const mount = createMcpMount({ loader: fixture.loader })
  await assert.rejects(mount.mount(mountedInput(fixture)), error => error.status === 'cleanup-failed')
  const creates = fixture.created.length
  await assert.rejects(mount.mount(mountedInput(fixture, { generation: 2 })), error => error.status === 'cleanup-failed')
  expect(fixture.created.length).toBe(creates)
  expect(mount.mounted.get('docs')?.state).toBe('cleanup-failed')
})

test('residue sweep derives identity and clears stale mounted facts even when Loader rows are already gone', async () => {
  const fixture = loaderFixture()
  const mount = createMcpMount({ loader: fixture.loader })
  await mount.mount(mountedInput(fixture))
  expect(await mount.sweepResidue(['weir-mcp-docs'])).toEqual(['weir-mcp-docs'])
  expect(mount.mounted.has('docs')).toBe(false)
  mount.mounted.set('docs', { groupId: 'weir-mcp-docs', generation: 1, state: 'mounted' })
  expect(fixture.entries.size).toBe(0)
  await mount.sweepResidue(['weir-mcp-docs'])
  expect(mount.mounted.has('docs')).toBe(false)
})
