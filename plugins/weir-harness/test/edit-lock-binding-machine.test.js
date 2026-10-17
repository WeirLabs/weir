import test from 'node:test'
import assert from 'node:assert/strict'
import { createBindingMachine } from '../src/edit-lock/binding-machine.js'

// Focused unit pin for the per-agent binding state machine (change
// test-surface-pinning, tasks 2.1/2.2). The machine's injectable dependency
// surface is enumerated by its module-header lifetime table and the deps
// destructure block; every dep below is a minimal spy/stub in that shape.
// Mount-generation flags (isClosed/platformFailure) arrive as getters and are
// backed by mutable fields here so tests can flip them mid-flight.

/** @param {any} [overrides] */
function makeDeps(overrides = {}) {
  const calls = { bind: [], restrict: [], audit: [], deliver: [], recordFailure: [], clearFailure: [], installScope: [], warn: [] }
  const flags = { closed: false, platform: null }
  const deps = {
    ctx: {
      tools: { get: (/** @type {string} */ name) => (name === 'hash_edit' ? {} : undefined) },
      logger: { warn: (/** @type {string} */ m) => calls.warn.push(m) },
    },
    sessionOf: (/** @type {any} */ agent) => agent?.session?.id,
    GUARDED_TOOLS: ['hash_edit', 'write'],
    options: {},
    registry: {
      roots: new Map(),
      rootOf(/** @type {any} */ agent) { return this.roots.get(agent) },
      bind(/** @type {any} */ agent, /** @type {any} */ root) { calls.bind.push([agent, root]); this.roots.set(agent, root) },
    },
    settled: new WeakMap(),
    writeScopes: new WeakMap(),
    domainOf: async (/** @type {any} */ agent) => agent.domain,
    servingRuntime: (/** @type {string} */ id) => deps.serving.get(id),
    ownAgent: () => true,
    installWriteScope: (/** @type {any} */ agent) => { calls.installScope.push(agent); return { owner: {}, dispose: () => { agent.scopeDisposed = (agent.scopeDisposed ?? 0) + 1 } } },
    evidence: {
      recordSessionFailure: (/** @type {any} */ s, /** @type {any} */ r) => calls.recordFailure.push([s, r]),
      clearSessionFailure: (/** @type {any} */ s) => calls.clearFailure.push(s),
    },
    audit: (/** @type {any} */ session, /** @type {any} */ type, /** @type {any} */ data, /** @type {any} */ options) => calls.audit.push([type, data, options]),
    deliverLocal: (/** @type {any} */ agent, /** @type {string} */ text) => calls.deliver.push(text),
    pendingAutoResume: new WeakMap(),
    delegateResumes: new Map(),
    turnClassifications: new WeakMap(),
    replyTools: new WeakMap(),
    expiry: new WeakMap(),
    settle: { settled: (/** @type {any} */ agent) => { agent.settleCalls = (agent.settleCalls ?? 0) + 1 } },
    isClosed: () => flags.closed,
    platformFailure: () => flags.platform,
    serving: new Map(),
    ...overrides,
  }
  return { deps, calls, flags }
}

/** @param {string} [id] */
function makeAgent(id = 'agent-1') {
  return {
    id,
    session: { id: `session-${id}`, header: { cwd: `/cwd/${id}` } },
    ctx: {},
    domain: {
      starts: [], forgets: 0, disposes: 0,
      async start(/** @type {any} */ a) { this.starts.push(['start', a]) },
      async retryStart(/** @type {any} */ a) { this.starts.push(['retryStart', a]) },
      async transferStart(/** @type {any} */ a) { this.starts.push(['transferStart', a]) },
      async forget() { this.forgets += 1 },
      async dispose() { this.disposes += 1 },
    },
  }
}

test('createBindingMachine return surface is exactly the documented container+entry set', () => {
  const { deps } = makeDeps()
  const machine = createBindingMachine(deps)
  assert.deepEqual(Object.keys(machine).sort(), [
    'agentDispositions', 'bindingFailures', 'boundAgents', 'disposedAgents',
    'dispositions', 'disposeAgent', 'retryBinding', 'setupAgent',
    'setupInFlight', 'startFailures', 'startupFailure',
  ].sort())
  assert.ok(machine.disposedAgents instanceof WeakSet)
  assert.ok(machine.startFailures instanceof WeakMap)
  assert.ok(machine.bindingFailures instanceof WeakMap)
  assert.ok(machine.setupInFlight instanceof WeakMap)
  assert.ok(machine.boundAgents instanceof Map)
  assert.ok(machine.dispositions instanceof Map)
  assert.ok(machine.agentDispositions instanceof WeakMap)
  for (const fn of ['setupAgent', 'retryBinding', 'disposeAgent', 'startupFailure']) {
    assert.equal(typeof machine[fn], 'function')
  }
})

test('machine-owned containers are per-machine even when deps are shared', () => {
  const { deps } = makeDeps()
  const a = createBindingMachine(deps)
  const b = createBindingMachine(deps)
  assert.notEqual(a.disposedAgents, b.disposedAgents)
  assert.notEqual(a.bindingFailures, b.bindingFailures)
  assert.notEqual(a.boundAgents, b.boundAgents)
  assert.notEqual(a.dispositions, b.dispositions)
  const agent = makeAgent()
  a.startFailures.set(agent, 'x')
  assert.equal(b.startFailures.has(agent), false)
})

test('setupAgent reads isClosed lazily: a closed mount is a no-op, reopening proceeds', async () => {
  const { deps, calls, flags } = makeDeps()
  flags.closed = true
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await machine.setupAgent(agent)
  assert.equal(calls.bind.length, 0)
  assert.equal(calls.installScope.length, 0)
  assert.equal(agent.domain.starts.length, 0)
  assert.equal(machine.boundAgents.size, 0)
  // Flip the mount flag after creation: the getter is re-read per entry point.
  flags.closed = false
  await machine.setupAgent(agent)
  assert.equal(calls.bind.length, 1)
  assert.equal(agent.domain.starts.length, 1)
  assert.equal(machine.boundAgents.get(agent.id), agent)
})

test('setupAgent reads platformFailure lazily: preflight failure blocks, recovery proceeds', async () => {
  const { deps, calls, flags } = makeDeps()
  flags.platform = new Error('preflight failed')
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await machine.setupAgent(agent)
  assert.equal(calls.bind.length, 0)
  assert.equal(agent.domain.starts.length, 0)
  flags.platform = null
  await machine.setupAgent(agent)
  assert.equal(agent.domain.starts.length, 1)
})

test('startupFailure surfaces the platform failure first and clears with it', async () => {
  const { deps, flags } = makeDeps()
  flags.platform = new Error('mount preflight broken')
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  assert.deepEqual(machine.startupFailure(agent), { state: 'unavailable', reason: 'mount preflight broken', bindingFailure: null })
  flags.platform = null
  // No recorded start failure for this agent: nothing to surface.
  assert.equal(machine.startupFailure(agent), null)
})

test('successful setup writes into the injected settled/writeScopes instances, not private copies', async () => {
  const { deps } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await machine.setupAgent(agent)
  // The injected containers ARE the machine's working state (dep resolution).
  assert.equal(deps.settled.get(agent), agent.domain)
  assert.ok(deps.writeScopes.has(agent))
  // Injected pendingAutoResume is untouched by a non-retry setup (retry-only clearing).
  deps.pendingAutoResume.set(agent, true)
  const second = makeAgent('agent-2')
  deps.pendingAutoResume.set(second, true)
  await machine.setupAgent(second)
  assert.equal(deps.pendingAutoResume.has(second), true)
})
