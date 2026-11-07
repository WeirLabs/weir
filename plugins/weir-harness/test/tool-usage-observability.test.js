import test from 'node:test'
import assert from 'node:assert/strict'
import { mountToolUsageObservability } from '../src/capabilities/tool-usage-observability.js'
import { AUDIT_TYPES, AUDIT_SUBTYPES } from '../src/shared/audit.js'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'

function fixture(audit, root) {
  const listeners = new Map()
  const records = []
  const ctx = {
    ...(root ? { root } : {}),
    on(name, listener) {
      const current = listeners.get(name) ?? []
      current.push(listener)
      listeners.set(name, current)
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener))
      }
    },
  }
  const sink = audit ?? ((session, type, data) => records.push({ session, type, data }))
  const dispose = mountToolUsageObservability({ ctx, audit: sink })
  const emit = (name, ...args) => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
  }
  return { ctx, listeners, records, dispose, emit }
}

function automaticDisposalFixture() {
  const listeners = new Map()
  const records = []
  const audit = (session, type, data) => records.push({ session, type, data })
  const createContext = (root) => {
    const owned = new Set()
    const ctx = {
      ...(root ? { root } : {}),
      on(name, listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener])
        let active = true
        const off = () => {
          if (!active) return
          active = false
          owned.delete(off)
          listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener))
        }
        owned.add(off)
        return off
      },
    }
    return {
      ctx,
      disposeListeners() {
        for (const off of [...owned]) off()
      },
    }
  }
  const root = createContext()
  const lease = scope => mountToolUsageObservability({ ctx: scope.ctx, audit })
  const mount = scope => {
    const disposeLease = lease(scope)
    let active = true
    return () => {
      if (!active) return
      active = false
      scope.disposeListeners()
      disposeLease()
    }
  }
  const emitEvent = seq => {
    const session = { id: `automatic-${seq}`, header: {} }
    for (const listener of [...(listeners.get('session/event') ?? [])]) listener(session, {
      type: 'request/header', seq,
      data: { header: { config: {}, tools: [] } },
    })
    for (const listener of [...(listeners.get('tools/result') ?? [])]) listener({
      name: 'echo', callId: `call-${seq}`, agent: { id: session.id, session },
    }, { isError: false })
  }
  const counts = seq => ({
    requests: records.filter(record => record.type === `${AUDIT_TYPES.toolUsage}/request` && record.data.seq === seq).length,
    results: records.filter(record => record.type === `${AUDIT_TYPES.toolUsage}/result` && record.data.callId === `call-${seq}`).length,
  })
  return { records, listeners, root, createContext, lease, mount, emitEvent, counts }
}

test('request headers audit mixed tool counts and serialized UTF-8 bytes without schema content', () => {
  const { records, emit } = fixture()
  const immediateText = '{"name":"echo","description":"immediate-description-secret","parameters":{"type":"object"}}'
  const deferredText = '{"name":"加载","description":"deferred-description-secret🙂","parameters":{"type":"object","properties":{"token":{"description":"parameter-secret"}}},"deferLoading":true}'
  const immediate = JSON.parse(immediateText)
  const deferred = JSON.parse(deferredText)
  const session = { id: 's1', header: {} }
  emit('session/event', session, {
    type: 'request/header', seq: 17,
    data: { header: {
      config: { provider: 'deepseek', model: 'deepseek-chat', prompt: 'prompt-secret' },
      tools: [immediate, deferred],
    } },
  })

  assert.deepEqual(AUDIT_SUBTYPES.toolUsage, ['request', 'result'])
  assert.equal(records.length, 1)
  assert.equal(records[0].session, session)
  assert.equal(records[0].type, `${AUDIT_TYPES.toolUsage}/request`)
  assert.deepEqual(records[0].data, {
    seq: 17, provider: 'deepseek', model: 'deepseek-chat',
    schemaCount: 2, deferredCount: 1,
    schemaBytes: Buffer.byteLength(immediateText) + Buffer.byteLength(deferredText),
    deferredSchemaBytes: Buffer.byteLength(deferredText),
  })
  const wire = JSON.stringify(records)
  for (const secret of ['immediate-description-secret', 'deferred-description-secret', 'parameter-secret', 'prompt-secret']) {
    assert.equal(wire.includes(secret), false)
  }
})

test('tool results audit success and stable error codes without arguments, result content or raw errors', () => {
  const { records, emit } = fixture()
  const session = { id: 's1', header: {} }
  const agent = { id: 's1', session }
  emit('tools/result', {
    name: 'mcp__docs__echo', callId: 'call-ok', agent,
    arguments: { token: 'argument-secret' },
  }, {
    isError: false, value: { text: 'result-secret' },
    content: [{ type: 'text', text: 'result-secret' }],
  })
  emit('tools/result', {
    name: 'mcp__docs__fail', callId: 'call-error', agent,
    arguments: { token: 'error-argument-secret' },
  }, {
    isError: true,
    error: { message: 'raw-error-secret', info: { name: 'McpError', code: 'MCP_UNAVAILABLE', reason: 'error-reason-secret' } },
    content: [{ type: 'text', text: 'error-result-secret' }],
  })

  assert.equal(records.length, 2)
  assert.deepEqual(records.map(record => record.data), [
    { name: 'mcp__docs__echo', isError: false, callId: 'call-ok' },
    { name: 'mcp__docs__fail', isError: true, code: 'MCP_UNAVAILABLE', callId: 'call-error' },
  ])
  assert.equal(records.every(record => record.session === session && record.type === `${AUDIT_TYPES.toolUsage}/result`), true)
  const wire = JSON.stringify(records)
  for (const secret of ['argument-secret', 'result-secret', 'error-argument-secret', 'raw-error-secret', 'error-reason-secret', 'error-result-secret']) {
    assert.equal(wire.includes(secret), false)
  }
})

test('empty tool arrays produce zero facts while omitted tools and unrelated events stay silent', () => {
  const { records, emit } = fixture()
  const session = { id: 's-empty', header: {} }
  emit('session/event', session, { type: 'request/header', seq: 20, data: { header: { config: {}, tools: [] } } })
  assert.deepEqual(records.map(record => record.data), [{
    seq: 20, schemaCount: 0, deferredCount: 0, schemaBytes: 0, deferredSchemaBytes: 0,
  }])
  emit('session/event', session, { type: 'request/header', seq: 21, data: { header: { config: {} } } })
  emit('session/event', session, { type: 'turn/start', seq: 22, data: { turn: 1 } })
  assert.equal(records.length, 1)
})

test('audit failures and disposal never alter tool outcomes or continue observation', () => {
  const { records, emit, dispose, listeners } = fixture(() => { throw new Error('audit-secret-failure') })
  const result = Object.freeze({ isError: false, value: 'unchanged-result', content: [] })
  const exec = { name: 'echo', callId: 'call-1', arguments: { secret: 'argument-secret' }, agent: { id: 's1' } }
  assert.doesNotThrow(() => emit('tools/result', exec, result))
  assert.equal(result.value, 'unchanged-result')
  assert.doesNotThrow(() => emit('session/event', { id: 's1' }, {
    type: 'request/header', seq: 1,
    data: { header: { config: {}, tools: [{ name: 'echo', description: 'secret', parameters: {} }] } },
  }))
  assert.equal(records.length, 0)
  dispose()
  dispose()
  assert.equal(listeners.get('tools/result').length, 0)
  assert.equal(listeners.get('session/event').length, 0)
  assert.doesNotThrow(() => emit('tools/result', exec, result))
})

for (const order of [[0, 1], [1, 0]]) {
  test(`automatic child-fiber disposal preserves the surviving lease through unmount order ${order.join('-')}`, () => {
    const fixture = automaticDisposalFixture()
    const scopes = [fixture.createContext(fixture.root.ctx), fixture.createContext(fixture.root.ctx)]
    const unmounts = scopes.map(scope => fixture.mount(scope))

    fixture.emitEvent(1)
    assert.deepEqual(fixture.counts(1), { requests: 1, results: 1 })
    assert.equal(fixture.listeners.get('session/event').length, 1)
    assert.equal(fixture.listeners.get('tools/result').length, 1)

    unmounts[order[0]]()
    fixture.emitEvent(2)
    assert.deepEqual(fixture.counts(2), { requests: 1, results: 1 })
    assert.equal(fixture.records.length, 4)
    assert.equal(fixture.listeners.get('session/event').length, 1)
    assert.equal(fixture.listeners.get('tools/result').length, 1)

    unmounts[order[1]]()
    unmounts[order[1]]()
    fixture.emitEvent(3)
    assert.deepEqual(fixture.counts(3), { requests: 0, results: 0 })
    assert.equal(fixture.records.length, 4)
    assert.equal(fixture.listeners.get('session/event').length, 0)
    assert.equal(fixture.listeners.get('tools/result').length, 0)

    const remount = fixture.mount(fixture.createContext(fixture.root.ctx))
    fixture.emitEvent(4)
    assert.deepEqual(fixture.counts(4), { requests: 1, results: 1 })
    assert.equal(fixture.records.length, 6)
    remount()
    remount()
    fixture.emitEvent(5)
    assert.deepEqual(fixture.counts(5), { requests: 0, results: 0 })
    assert.equal(fixture.records.length, 6)
    assert.equal(fixture.listeners.get('session/event').length, 0)
    assert.equal(fixture.listeners.get('tools/result').length, 0)
    assert.deepEqual(fixture.records.map(record => record.data.seq ?? record.data.callId), [1, 'call-1', 2, 'call-2', 4, 'call-4'])
  })
}

for (const order of [[0, 1], [1, 0]]) {
  test(`dual-mounted observers emit one request and result fact per event through disposal order ${order.join('-')}`, () => {
    const fixture = automaticDisposalFixture()
    const scopes = [fixture.createContext(fixture.root.ctx), fixture.createContext(fixture.root.ctx)]
    const disposers = scopes.map(scope => fixture.lease(scope))

    fixture.emitEvent(1)
    assert.equal(fixture.records.length, 2)
    assert.deepEqual(fixture.counts(1), { requests: 1, results: 1 })
    assert.equal(fixture.listeners.get('session/event').length, 1)
    assert.equal(fixture.listeners.get('tools/result').length, 1)

    disposers[order[0]]()
    fixture.emitEvent(2)
    assert.equal(fixture.records.length, 4)
    assert.deepEqual(fixture.counts(2), { requests: 1, results: 1 })
    assert.equal(fixture.listeners.get('session/event').length, 1)
    assert.equal(fixture.listeners.get('tools/result').length, 1)

    disposers[order[1]]()
    disposers[order[1]]()
    fixture.emitEvent(3)
    assert.equal(fixture.records.length, 4)
    assert.deepEqual(fixture.counts(3), { requests: 0, results: 0 })
    assert.equal(fixture.listeners.get('session/event').length, 0)
    assert.equal(fixture.listeners.get('tools/result').length, 0)
    assert.deepEqual(fixture.records.map(record => record.data.seq ?? record.data.callId), [1, 'call-1', 2, 'call-2'])
  })
}

test('the existing weir and weir-creative composition wiring shares cold-safe request and result observers', () => {
  const listeners = new Map()
  const emitted = []
  const effects = []
  const ctx = {
    skills: { registerProvider(create) { create({ invalidate() {} }) } },
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener))
    },
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    emit(type, record) { emitted.push({ type, record }) },
    get() { return undefined },
    logger: { warn() {}, debug() {} },
  }
  try {
    const dependencies = {
      readSelection: async () => [],
      inventory: async () => ({ complete: true, candidates: [] }),
      office: async () => ({ complete: true, candidates: [] }),
      lifecycle: { agentCreated() {}, snapshotFor() { return null } },
    }
    createSkillSelectionPlugin(dependencies)(ctx, { readPresetId: 'weir' })
    createSkillSelectionPlugin(dependencies)(ctx, { readPresetId: 'weir-creative' })
    assert.equal(listeners.get('session/event')?.length, 1)
    assert.equal(listeners.get('tools/result')?.length, 1)
    const session = { id: 'root-mounted', header: {} }
    for (const listener of listeners.get('session/event')) listener(session, {
      type: 'request/header', seq: 33,
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, tools: [] } },
    })
    const request = emitted.find(entry => entry.type === 'weir/tool-usage/request')
    assert.equal(request.record.session, 'root-mounted')
    assert.deepEqual(request.record.data, {
      seq: 33, provider: 'deepseek', model: 'deepseek-chat',
      schemaCount: 0, deferredCount: 0, schemaBytes: 0, deferredSchemaBytes: 0,
    })
    assert.equal(emitted.filter(entry => entry.type === 'weir/tool-usage/request').length, 1)
    for (const listener of listeners.get('tools/result')) listener({
      name: 'echo', callId: 'root-call', agent: { id: session.id, session },
    }, { isError: false })
    assert.equal(emitted.filter(entry => entry.type === 'weir/tool-usage/result').length, 1)
  } finally {
    for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose()
  }
})
