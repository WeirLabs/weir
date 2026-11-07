import test from 'node:test'
import assert from 'node:assert/strict'
import { mountToolUsageObservability } from '../src/capabilities/tool-usage-observability.js'
import { AUDIT_TYPES, AUDIT_SUBTYPES } from '../src/shared/audit.js'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'

function fixture(audit) {
  const listeners = new Map()
  const records = []
  const ctx = {
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

test('the existing capability composition root mounts cold-safe request and result observers', () => {
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
    createSkillSelectionPlugin({
      readSelection: async () => [],
      inventory: async () => ({ complete: true, candidates: [] }),
      office: async () => ({ complete: true, candidates: [] }),
      lifecycle: { agentCreated() {}, snapshotFor() { return null } },
    })(ctx, { readPresetId: 'weir' })
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
  } finally {
    for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose()
  }
})
