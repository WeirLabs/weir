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

// ─── task 2.2: race/lifetime paths ─────────────────────────────────────────

test('setupAgentOnce prefers options.fixed.root over the session cwd', async () => {
  const { deps, calls } = makeDeps({ options: { fixed: { root: '/pinned/root' } } })
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await machine.setupAgent(agent)
  assert.deepEqual(calls.bind, [[agent, '/pinned/root']])
})

test('setupAgentOnce prefers options.fixed.root absent → falls back to the session cwd', async () => {
  const { deps, calls } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await machine.setupAgent(agent)
  assert.deepEqual(calls.bind, [[agent, '/cwd/agent-1']])
})

test('write-scope install failure denies only known guarded tools and records the account everywhere', async () => {
  const { deps, calls } = makeDeps({
    installWriteScope: () => { throw new Error('duplicate-registration') },
  })
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  const denied = []
  agent.ctx = { tools: { restrict: (/** @type {any} */ r) => denied.push(r.deny) } }
  await machine.setupAgent(agent)
  // Only the guarded tools the agent actually HAS are denied (hash_edit is
  // known to ctx.tools.get in makeDeps, write is not).
  assert.deepEqual(denied, [['hash_edit']])
  assert.equal(machine.startFailures.get(agent), 'duplicate-registration')
  assert.deepEqual(calls.recordFailure, [['session-agent-1', 'duplicate-registration']])
  assert.equal(calls.audit.length, 1)
  assert.equal(calls.audit[0][1].kind, 'setup-failed')
  assert.equal(calls.audit[0][1].reason, 'duplicate-registration')
  assert.match(calls.deliver[0], /Edit Lock is unavailable for this session \(duplicate-registration\)/)
  assert.equal(deps.settled.has(agent), false)
  assert.equal(machine.boundAgents.size, 0)
})

test('duplicate-binding failure records the publisher classification and the transferable notice stays calm', async () => {
  const { deps, calls } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  agent.domain.start = async () => {
    const error = /** @type {any} */ (new Error('session already bound'))
    error.bindingFailure = { code: 'binding-duplicate', holderKind: 'transferable', holderPid: 4242 }
    throw error
  }
  await machine.setupAgent(agent)
  assert.equal(machine.startFailures.get(agent), 'session already bound')
  assert.equal(machine.bindingFailures.get(agent)?.code, 'binding-duplicate')
  assert.equal(machine.bindingFailures.get(agent)?.holderKind, 'transferable')
  assert.match(calls.deliver[0], /inactive attachment of this same session; it transfers automatically/)
  assert.doesNotMatch(calls.deliver[0], /disabled/)
  assert.equal(deps.settled.has(agent), false)
})

test('duplicate-binding failure with a serving holder names the live edit and the retry moment', async () => {
  const { deps, calls } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  agent.domain.start = async () => {
    const error = /** @type {any} */ (new Error('session already bound'))
    error.bindingFailure = { code: 'binding-duplicate', holderKind: 'serving' }
    throw error
  }
  await machine.setupAgent(agent)
  assert.match(calls.deliver[0], /being edited in another attachment right now/)
  assert.match(calls.deliver[0], /\/edit-lock retry/)
})

test('isClosed flipping mid-binding forgets the domain and records the mount change', async () => {
  const { deps, calls, flags } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  agent.domain.start = async () => { flags.closed = true }
  await machine.setupAgent(agent)
  assert.equal(agent.domain.forgets, 1)
  assert.equal(machine.startFailures.get(agent), 'Edit Lock mount changed during binding')
  assert.equal(deps.settled.has(agent), false)
  assert.equal(machine.boundAgents.size, 0)
  assert.match(calls.deliver[0], /could not start this session's edit domain/)
})

test('concurrent setupAgent callers share one in-flight setup task', async () => {
  const { deps, calls } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  /** @type {() => void} */
  let release = () => {}
  let startCalls = 0
  agent.domain.start = () => { startCalls += 1; return new Promise((resolve) => { release = resolve }) }
  const first = machine.setupAgent(agent)
  const second = machine.setupAgent(agent)
  assert.equal(first, second)
  assert.equal(machine.setupInFlight.has(agent), true)
  // Let the setup reach the deferred domain.start before releasing it: the
  // call happens on a microtask after setupAgent returns synchronously.
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await first
  assert.equal(calls.installScope.length, 1)
  assert.equal(startCalls, 1)
  // The shared task removes itself from the in-flight map once settled.
  assert.equal(machine.setupInFlight.has(agent), false)
  assert.equal(machine.boundAgents.get(agent.id), agent)
})

test('setupAgent short-circuits for settled and already-rooted agents', async () => {
  const { deps, calls } = makeDeps()
  const machine = createBindingMachine(deps)
  const settledAgent = makeAgent('settled')
  deps.settled.set(settledAgent, {})
  await machine.setupAgent(settledAgent)
  const rootedAgent = makeAgent('rooted')
  deps.registry.roots.set(rootedAgent, '/elsewhere')
  await machine.setupAgent(rootedAgent)
  assert.equal(calls.bind.length, 0)
  assert.equal(calls.installScope.length, 0)
})

/** Bind an agent into the recorded duplicate-failure state retryBinding gates on. */
async function agentWithDuplicateFailure(/** @type {any} */ deps, /** @type {any} */ machine, /** @type {any} */ agent, /** @type {string} */ holderKind = 'transferable') {
  agent.domain.start = async () => {
    const error = /** @type {any} */ (new Error('session already bound'))
    error.bindingFailure = { code: 'binding-duplicate', holderKind, holderPid: 4242 }
    throw error
  }
  await machine.setupAgent(agent)
  // The failure path keeps the root binding while withholding the domain.
  agent.domain.starts = []
  agent.domain.start = async (/** @type {any} */ a) => { agent.domain.starts.push(['start', a]) }
}

test('retryBinding refuses ineligible callers before any domain work', async () => {
  // Function deps are captured by the destructure at creation, so the
  // ownership flip rides a flag the captured closure reads (the same reason
  // the composition wires ownAgent late-bound).
  let own = true
  const { deps, flags } = makeDeps({ ownAgent: () => own })
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await agentWithDuplicateFailure(deps, machine, agent)

  flags.closed = true
  await assert.rejects(() => machine.retryBinding(agent), /current live Agent/)
  flags.closed = false

  own = false
  await assert.rejects(() => machine.retryBinding(agent), /current live Agent/)
  own = true

  // Never-rooted agent: not eligible.
  await assert.rejects(() => machine.retryBinding(makeAgent('stranger')), /not eligible for binding retry/)

  // Rooted but successfully bound (no recorded duplicate): not eligible.
  const healthy = makeAgent('healthy')
  await machine.setupAgent(healthy)
  await assert.rejects(() => machine.retryBinding(healthy), /not eligible for binding retry/)

  // Disposed agent: refused even with the recorded duplicate.
  const gone = makeAgent('gone')
  await agentWithDuplicateFailure(deps, machine, gone)
  await machine.disposeAgent(gone)
  await assert.rejects(() => machine.retryBinding(gone), /current live Agent/)
})

test('retryBinding stays fail-closed and audited when the registry cannot attest the holder', async () => {
  const { deps, calls } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await agentWithDuplicateFailure(deps, machine, agent)
  calls.audit.length = 0
  // servingRuntime names no live agent → unattestable.
  await assert.rejects(() => machine.retryBinding(agent), /registry is unavailable or names no live agent/)
  const refusal = calls.audit.find(([, data]) => data.kind === 'binding-transfer' && data.result === 'refused')
  assert.ok(refusal)
  assert.equal(refusal[1].reason, 'registry-unattestable')
  assert.equal(refusal[1].code, 'binding-duplicate')
  // The recorded cause stays; a later retry remains possible.
  assert.equal(machine.bindingFailures.get(agent)?.code, 'binding-duplicate')
})

test('retryBinding transfers to an idle same-session holder and audits the transfer', async () => {
  const { deps, calls } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await agentWithDuplicateFailure(deps, machine, agent)
  const holder = makeAgent('holder')
  deps.serving.set(agent.id, holder)
  deps.pendingAutoResume.set(agent, true)
  calls.audit.length = 0
  const message = await machine.retryBinding(agent, 'command')
  assert.match(message, /Edit Lock connection recovered/)
  assert.deepEqual(agent.domain.starts, [['transferStart', agent]])
  const transfer = calls.audit.find(([, data]) => data.kind === 'binding-transfer' && data.result === 'transferred')
  assert.ok(transfer)
  assert.equal(transfer[1].holder, 'transferable')
  assert.equal(deps.settled.get(agent), agent.domain)
  assert.equal(machine.boundAgents.get(agent.id), agent)
  // A successful retry clears an armed auto-resume (deps table, retry semantics).
  assert.equal(deps.pendingAutoResume.has(agent), false)
  // A fresh bind does NOT replay delegate resumes on the retry path.
  assert.equal(machine.startFailures.has(agent), false)
  assert.equal(machine.bindingFailures.has(agent), false)
})

test('retryBinding superseded rebind via message audits the established auto-retry shape', async () => {
  const { deps, calls } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await agentWithDuplicateFailure(deps, machine, agent)
  deps.serving.set(agent.id, agent)
  calls.audit.length = 0
  await machine.retryBinding(agent, 'message')
  assert.deepEqual(agent.domain.starts, [['retryStart', agent]])
  const recovery = calls.audit.find(([, data]) => data.kind === 'binding-auto-retry')
  assert.ok(recovery)
  assert.deepEqual([recovery[1].result, recovery[1].code], ['recovered', 'binding-duplicate'])
  assert.equal(calls.audit.some(([, data]) => data.kind === 'binding-transfer' && data.result === 'transferred'), false)
})

test('retryBinding audits the refusal with the holder class when the attempt fails again', async () => {
  const { deps, calls } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await agentWithDuplicateFailure(deps, machine, agent, 'serving')
  deps.serving.set(agent.id, agent)
  agent.domain.retryStart = async () => {
    const error = /** @type {any} */ (new Error('still held'))
    error.bindingFailure = { code: 'binding-duplicate', holderKind: 'serving' }
    throw error
  }
  calls.audit.length = 0
  await assert.rejects(() => machine.retryBinding(agent), /still held/)
  const refusal = calls.audit.find(([, data]) => data.kind === 'binding-transfer' && data.result === 'refused')
  assert.ok(refusal)
  assert.equal(refusal[1].reason, 'serving')
  assert.equal(deps.settled.has(agent), false)
})

test('disposeAgent retires scope/reply/expiry synchronously and awaits the durable classification before domain disposal', async () => {
  const { deps } = makeDeps()
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await machine.setupAgent(agent)

  const replyDisposed = []
  deps.replyTools.set(agent, { dispose: () => replyDisposed.push(agent), stale: false })
  const timer = {}
  deps.expiry.set(agent, { timer })
  const cleared = []
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.clearTimeout = (/** @type {any} */ handle) => { cleared.push(handle) }
  /** @type {() => void} */
  let releaseClassification = () => {}
  deps.turnClassifications.set(agent, new Promise((resolve) => { releaseClassification = resolve }))
  try {
    const first = machine.disposeAgent(agent)
    const second = machine.disposeAgent(agent)
    // Idempotent: the in-flight disposal task is returned to repeat callers.
    assert.equal(first, second)
    // Synchronous cleanup happened before the classification settled.
    assert.equal(machine.disposedAgents.has(agent), true)
    assert.equal(machine.boundAgents.size, 0)
    assert.equal(deps.writeScopes.has(agent), false)
    assert.equal(agent.scopeDisposed, 1)
    assert.deepEqual(replyDisposed, [agent])
    assert.equal(deps.replyTools.has(agent), false)
    assert.deepEqual(cleared, [timer])
    assert.equal(deps.expiry.has(agent), false)
    assert.equal(agent.settleCalls, 1)
    assert.equal(deps.settled.has(agent), false)
    // The authority disposal waits for the durable turn classification.
    assert.equal(agent.domain.disposes, 0)
    releaseClassification()
    await first
    assert.equal(agent.domain.disposes, 1)
  } finally {
    globalThis.clearTimeout = originalClearTimeout
  }
  // The disposition record stays joinable after synchronous cleanup.
  await machine.dispositions.get(agent.id).promise
})

test('dispositions tracks the latest incarnation by session id across re-binds', async () => {
  const { deps } = makeDeps()
  const machine = createBindingMachine(deps)
  const first = makeAgent('same')
  await machine.setupAgent(first)
  const firstRecord = machine.dispositions.get(first.id)
  await machine.disposeAgent(first)
  await firstRecord.promise
  // Synchronous cleanup did not remove the joinable record.
  assert.equal(machine.dispositions.get(first.id), firstRecord)

  const second = makeAgent('same')
  await machine.setupAgent(second)
  const secondRecord = machine.dispositions.get(second.id)
  assert.notEqual(secondRecord, firstRecord)
  assert.equal(machine.agentDispositions.get(first), firstRecord)
  assert.equal(machine.agentDispositions.get(second), secondRecord)
  assert.equal(machine.boundAgents.get('same'), second)
})

test('startupFailure gates on live identity and marks an in-flight retry', async () => {
  let own = true
  const { deps, flags } = makeDeps({ ownAgent: () => own })
  const machine = createBindingMachine(deps)
  const agent = makeAgent()
  await agentWithDuplicateFailure(deps, machine, agent, 'serving')

  // Registry unattestable: the recorded failure stays hidden.
  assert.equal(machine.startupFailure(agent), null)
  // Registry names ANOTHER live local agent: the recorded duplicate is this
  // agent's honest panel state.
  deps.serving.set(agent.id, makeAgent('holder'))
  const dual = machine.startupFailure(agent)
  assert.equal(dual?.state, 'unavailable')
  assert.equal(dual?.reason, 'session already bound')
  assert.deepEqual(dual?.bindingFailure, { code: 'binding-duplicate', holderKind: 'serving', holderPid: 4242, inFlight: false })
  // Registry names THIS agent: the ordinary diagnostic.
  deps.serving.set(agent.id, agent)
  assert.equal(machine.startupFailure(agent)?.bindingFailure?.inFlight, false)

  // A retry in flight flips the bindingFailure's inFlight flag.
  /** @type {() => void} */
  let release = () => {}
  agent.domain.retryStart = () => new Promise((resolve) => { release = resolve })
  const retry = machine.retryBinding(agent)
  assert.equal(machine.setupInFlight.has(agent), true)
  // Let the retry reach the deferred retryStart before probing/releasing.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(machine.startupFailure(agent)?.bindingFailure?.inFlight, true)
  release()
  await retry
  assert.equal(machine.startupFailure(agent), null) // settled agents have no diagnostic

  // Mount flags and ownership gate the diagnostic even with a recorded failure.
  const failed = makeAgent('failed')
  await agentWithDuplicateFailure(deps, machine, failed)
  deps.serving.set(failed.id, failed)
  flags.closed = true
  assert.equal(machine.startupFailure(failed), null)
  flags.closed = false
  own = false
  assert.equal(machine.startupFailure(failed), null)
  own = true
  await machine.disposeAgent(failed)
  assert.equal(machine.startupFailure(failed), null)
  // An agent with no recorded failure has nothing to surface.
  assert.equal(machine.startupFailure(makeAgent('clean')), null)
})
