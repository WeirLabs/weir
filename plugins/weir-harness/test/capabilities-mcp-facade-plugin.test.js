import test from 'node:test'
import assert from 'node:assert/strict'
import { createMcpFacade } from '../src/capabilities/mcp-facade.js'

// Entry-contract pin (change test-surface-pinning, tasks 5.1/5.2): the
// package export subpath ./mcp-facade-plugin is intended public surface
// (package.json exports; the loader references it by package name, never a
// deep path) whose external behavior had zero entry-level pins. Imported
// through the package entry on purpose — a broken exports mapping fails here.
// Internal facade semantics are pinned elsewhere (mcp-gate.test.js); this
// file pins the PLUGIN contract: the realm bridge registry and the
// fail-closed mount.
const { apply, name, mcpFacadeBridgeFor, registerMcpFacadeBridge } = await import('weir-harness/mcp-facade-plugin')

/** @param {any} [payload] */
function makePayload(payload = {}) {
  return {
    host: { tools: {}, systemPrompt: {}, mcpResources: {} },
    identity: 'srv-1',
    generation: 1,
    admit: async () => true,
    isEnabledFor: () => true,
    ...payload,
  }
}

/** A minimal cordis group-mount ctx with spies. */
function makeCtx(/** @type {string | null} */ groupId = null) {
  const calls = { warn: [], provide: [] }
  const ctx = {
    fiber: groupId ? { entry: { parent: { data: { id: groupId } } } } : undefined,
    logger: { warn: (/** @type {string} */ m) => calls.warn.push(m) },
    reflect: { provide: (/** @type {string} */ service, /** @type {any} */ value) => calls.provide.push([service, value]) },
  }
  return { ctx, calls }
}

test('the entry exports the stable plugin name and the bridge registry', () => {
  assert.equal(name, 'weir-mcp-facade')
  assert.equal(mcpFacadeBridgeFor('never-registered'), null)
  const payload = makePayload()
  const unregister = registerMcpFacadeBridge('g-1', payload)
  assert.equal(mcpFacadeBridgeFor('g-1'), payload)
  unregister()
  assert.equal(mcpFacadeBridgeFor('g-1'), null)
})

test('stale or repeated bridge release cannot delete a later owner after confirmed group reuse', () => {
  const stalePayload = makePayload({ identity: 'stale-owner' })
  const currentPayload = makePayload({ identity: 'current-owner' })
  const releaseStale = registerMcpFacadeBridge('g-reused', stalePayload)
  releaseStale()
  const releaseCurrent = registerMcpFacadeBridge('g-reused', currentPayload)
  try {
    releaseStale()
    releaseStale()
    assert.equal(mcpFacadeBridgeFor('g-reused'), currentPayload)
  } finally {
    releaseCurrent()
    releaseCurrent()
  }
  assert.equal(mcpFacadeBridgeFor('g-reused'), null)
})

test('apply without a bridge fails closed and visible: warn, provide nothing', () => {
  const { ctx, calls } = makeCtx('g-absent')
  apply(ctx)
  assert.equal(calls.provide.length, 0)
  assert.equal(calls.warn.length, 1)
  assert.match(calls.warn[0], /mounted without a realm bridge \(group g-absent\); this server stays unavailable/)
})

test('apply with a registered bridge provides the three realm-local services', () => {
  const unregister = registerMcpFacadeBridge('g-2', makePayload({ identity: 'bridged-srv' }))
  try {
    const { ctx, calls } = makeCtx('g-2')
    apply(ctx)
    assert.deepEqual(calls.provide.map(([service]) => service), ['tools', 'systemPrompt', 'mcpResources'])
    const [, tools] = calls.provide[0]
    for (const method of ['register', 'get', 'list', 'restrict']) assert.equal(typeof tools[method], 'function')
    const [, systemPrompt] = calls.provide[1]
    assert.equal(typeof systemPrompt.section, 'function')
    const [, mcpResources] = calls.provide[2]
    assert.equal(typeof mcpResources.register, 'function')
    assert.equal(calls.warn.length, 0)
  } finally {
    unregister()
  }
})

test('apply falls back to a config-carried payload and to config.group', () => {
  const { ctx, calls } = makeCtx(null)
  apply(ctx, makePayload({ identity: 'config-srv' }))
  assert.deepEqual(calls.provide.map(([service]) => service), ['tools', 'systemPrompt', 'mcpResources'])

  // config.group resolves the bridge when the fiber shape is absent.
  const unregister = registerMcpFacadeBridge('g-3', makePayload())
  try {
    const viaConfig = makeCtx(null)
    apply(viaConfig.ctx, { group: 'g-3' })
    assert.equal(viaConfig.calls.provide.length, 3)
  } finally {
    unregister()
  }
})

test('duplicate registration rejects instead of overwriting the current owner', () => {
  const current = makePayload({ identity: 'current' })
  const release = registerMcpFacadeBridge('g-duplicate', current, 'current-owner')
  try {
    assert.throws(() => registerMcpFacadeBridge('g-duplicate', makePayload({ identity: 'intruder' }), 'other-owner'), error => error.code === 'duplicate-mcp-facade-owner')
    assert.equal(mcpFacadeBridgeFor('g-duplicate'), current)
  } finally { release() }
})

test('removing the bridge closes the mount again', () => {
  const unregister = registerMcpFacadeBridge('g-4', makePayload())
  unregister()
  const { ctx, calls } = makeCtx('g-4')
  apply(ctx)
  assert.equal(calls.provide.length, 0)
  assert.equal(calls.warn.length, 1)
})

test('facade adds deferLoading after admission wrapping without changing register or execute semantics', async () => {
  const registered = []
  const callbacks = []
  const order = []
  let admitted = true
  let rpcs = 0
  const facade = createMcpFacade({
    host: { tools: { register(definition) {
      registered.push(definition)
      return () => callbacks.push(['host-unregister', definition.name])
    } } },
    identity: 'docs', generation: 7, deferLoading: true,
    admit: async () => { order.push('admit'); return admitted },
    isEnabledFor: () => true,
    drain: {
      enter() { order.push('enter'); return 11 },
      exit(_agentId, _identity, token) { order.push(`exit:${token}`) },
    },
    onRegister: (name, _captureRollback, definition) => callbacks.push(['register', name, definition]),
    onUnregister: name => callbacks.push(['unregister', name]),
  })
  const source = {
    name: 'mcp__docs__echo', description: 'Echo', parameters: { type: 'object', properties: {} },
    async execute() { order.push('rpc'); rpcs += 1; return 'ok' },
  }
  const unregister = facade.tools.register(source)
  const definition = registered[0]
  assert.equal(definition.deferLoading, true)
  assert.notEqual(definition.execute, source.execute)
  assert.equal(callbacks[0][2], definition)
  assert.equal(await definition.execute({}, { agent: { id: 's1' } }), 'ok')
  assert.deepEqual(order, ['admit', 'enter', 'rpc', 'exit:11'])

  admitted = false
  await assert.rejects(definition.execute({}, { agent: { id: 's1' } }), error => error?.code === 'mcp-admission-refused')
  assert.equal(rpcs, 1)
  unregister()
  assert.deepEqual(callbacks.slice(-2), [['host-unregister', source.name], ['unregister', source.name]])

  facade.tools.register({ ...source, name: 'mcp__docs__after_reconnect' })
  assert.equal(registered[1].deferLoading, true)
  for (const deferLoading of [undefined, false]) {
    let unmarked
    const plain = createMcpFacade({
      host: { tools: { register(value) { unmarked = value; return () => {} } } },
      identity: 'docs', generation: 7, deferLoading,
      admit: async () => true, isEnabledFor: () => true,
    })
    plain.tools.register(source)
    assert.equal(Object.hasOwn(unmarked, 'deferLoading'), false)
  }
})
