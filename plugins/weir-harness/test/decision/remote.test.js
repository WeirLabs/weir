import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecisionRemoteService, decisionRemoteContribution, DECISION_REMOTE_METHODS, DECISION_REMOTE_NAMESPACE, DECISION_REMOTE_SERVICE_KEY } from '../../src/decision/remote.js'
import { apply as applyRemote } from '../../src/decision/remote-plugin.js'
import { apply as applyBroker, decisionBrokerConfig } from '../../src/decision/broker-plugin.js'

test('contribution covers the exact read/action surface with bare src-json args only', () => {
  const contribution = decisionRemoteContribution()
  assert.equal(contribution.package, 'weir-decision')
  assert.equal(contribution.face, 'host')
  assert.deepEqual(contribution.schemas, [])
  assert.deepEqual(contribution.invocations.map(row => row.method), [...DECISION_REMOTE_METHODS])
  for (const invocation of contribution.invocations) {
    assert.deepEqual(invocation.parameters, [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }])
    assert.equal(invocation.scope, undefined)
    assert.equal(JSON.stringify(invocation).includes('lookup'), false)
  }
})

test('every remote method reaches the Broker and wraps its value', async () => {
  const calls = []
  const broker = { status: () => ({ available: true }), sessionContext: async id => ({ rootSessionId: id, workspaceKey: '/repo' }) }
  for (const method of DECISION_REMOTE_METHODS) {
    broker[method] = async (...args) => { calls.push([method, args]); return { method } }
  }
  broker.setSelector = async (...args) => { calls.push(['setSelector', args]); return { mode: 'agent' } }
  broker.profileSetState = async (...args) => { calls.push(['profileSetState', args]); return { state: 'disabled' } }
  const service = createDecisionRemoteService({ broker: () => broker })
  for (const method of DECISION_REMOTE_METHODS) {
    const result = await service[method]({ sessionId: 'child', agentId: 'ag', mode: 'agent', state: 'disabled' })
    assert.equal(result.ok, true)
  }
  assert.deepEqual(calls.map(call => call[0]), [...DECISION_REMOTE_METHODS])
  // Identity calls never receive a caller-named workspace; record-level calls
  // still receive the authenticated root workspace.
  assert.deepEqual(calls.find(call => call[0] === 'setSelector')[1], ['child', 'agent', 'ag'])
  assert.deepEqual(calls.find(call => call[0] === 'profileSetState')[1], ['ag', 'disabled'])
  assert.equal(calls.find(call => call[0] === 'decide')[1][0].workspaceKey, '/repo')
  assert.deepEqual(calls.find(call => call[0] === 'profileUpsert')[1], [{ sessionId: 'child', agentId: 'ag', mode: 'agent', state: 'disabled' }])
})

test('Broker errors become bounded envelopes without stacks', async () => {
  const error = new Error('bad input')
  error.code = 'BAD_INPUT'
  const broker = { status: () => ({ available: true }), record: async () => { throw error } }
  const service = createDecisionRemoteService({ broker: () => broker })
  const result = await service.record({ caseId: 'dc' })
  assert.deepEqual(result, { ok: false, error: { code: 'BAD_INPUT', message: 'bad input' } })
  assert.equal(JSON.stringify(result).includes('stack'), false)

  const unavailable = createDecisionRemoteService({ broker: () => broker, ensureRegistered: () => false })
  assert.equal((await unavailable.overview({})).error.code, 'CHANNEL_UNAVAILABLE')
})

test('global off permits only overview and fails every other remote method closed', async () => {
  const calls = []
  const broker = {
    status: () => ({ available: false, enabled: false, reason: 'disabled' }),
    overview: async () => ({ status: broker.status(), selector: { mode: 'off' }, agents: [] }),
  }
  for (const method of DECISION_REMOTE_METHODS.filter(method => method !== 'overview')) {
    broker[method] = async () => { calls.push(method); return { unexpected: true } }
  }
  const service = createDecisionRemoteService({ broker: () => broker })
  assert.deepEqual(await service.overview({ sessionId: 'root' }), {
    ok: true,
    value: { status: { available: false, enabled: false, reason: 'disabled' }, selector: { mode: 'off' }, agents: [] },
  })
  for (const method of DECISION_REMOTE_METHODS.filter(method => method !== 'overview')) {
    assert.deepEqual(await service[method]({ sessionId: 'root' }), {
      ok: false, error: { code: 'DECISION_UNAVAILABLE', message: 'disabled' },
    }, method)
  }
  assert.deepEqual(calls, [])
})

test('overview remains unavailable for non-disabled Broker failures', async () => {
  let called = false
  const broker = {
    status: () => ({ available: false, enabled: true, reason: 'store_open_failed' }),
    overview: async () => { called = true; return {} },
  }
  const service = createDecisionRemoteService({ broker: () => broker })
  assert.deepEqual(await service.overview({ sessionId: 'root' }), {
    ok: false, error: { code: 'DECISION_UNAVAILABLE', message: 'store_open_failed' },
  })
  assert.equal(called, false)
})

test('remote apply is idempotent and self-heals missing endpoints', () => {
  const endpoints = new Set()
  let registrations = 0
  const typert = {
    local: { get: endpoint => endpoints.has(endpoint) ? {} : undefined },
    register: contribution => {
      registrations++
      for (const invocation of contribution.invocations) endpoints.add(`${invocation.namespace}/${invocation.method}`)
    },
  }
  const provided = []
  const broker = { status: () => ({ available: true }) }
  const ctx = {
    get: name => name === 'typert' ? typert : name === DECISION_REMOTE_SERVICE_KEY ? provided[0] : name === 'weirDecisionBroker' ? broker : undefined,
    root: { reflect: { provide: (key, service) => { provided[0] = service; provided.push(key) } } },
    logger: { warn: () => {} },
  }
  const first = applyRemote(ctx)
  assert.ok(first)
  assert.equal(registrations, 1)
  applyRemote(ctx)
  assert.equal(registrations, 1)
  endpoints.clear()
  first.overview({ sessionId: 'root' })
  assert.equal(registrations, 2)
})

test('Broker plugin maps settings, provides one service and flushes on dispose', async t => {
  const home = mkdtempSync(join(tmpdir(), 'weir-decision-plugin-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const settings = { enabled: false, answerTimeoutMs: 10, maxAttemptsPerCase: 2, contextBudgetTokens: 1000, maxOutputTokens: 100, maxConcurrentAttempts: 1, chains: { ag: [] }, retentionDays: 0, storePath: '', selectorDefault: 'auto', autoShadow: true, autoAnswerClasses: ['A', 'B'] }
  const provided = []
  let dispose
  const ctx = {
    get: name => name === 'profileContext' ? { home, name: 'test' } : name === 'weirSettings' ? { get: () => settings } : undefined,
    reflect: { provide: (key, value) => provided.push({ key, value }) },
    effect: fn => { dispose = fn() },
    emit: () => {},
  }
  const broker = applyBroker(ctx)
  assert.equal(provided[0].key, 'weirDecisionBroker')
  assert.equal(provided[0].value, broker)
  assert.equal(broker.status().enabled, false)
  const config = decisionBrokerConfig(ctx)
  assert.equal(config.decisionAgentAnswerTimeoutMs, 10)
  assert.deepEqual(config.decisionAgentChains, { ag: [] })
  assert.equal(config.decisionAgentSelectorDefault, 'auto')
  assert.equal(config.decisionAgentAutoShadow, true)
  assert.deepEqual(config.decisionAgentAutoAnswerClasses, ['A', 'B'])
  await dispose()
  assert.equal(broker.store, undefined)
})

test('Broker Auto settings default conservatively and malformed stored values fail closed', () => {
  const withSection = (section) => ({
    get: name => name === 'weirSettings' ? { get: () => section } : undefined,
  })
  assert.deepEqual(
    (({ decisionAgentSelectorDefault, decisionAgentAutoShadow, decisionAgentAutoAnswerClasses }) => ({ decisionAgentSelectorDefault, decisionAgentAutoShadow, decisionAgentAutoAnswerClasses }))(decisionBrokerConfig(withSection(undefined))),
    { decisionAgentSelectorDefault: 'off', decisionAgentAutoShadow: false, decisionAgentAutoAnswerClasses: [] },
  )
  for (const selectorDefault of ['agent', 'AUTO', true, null, {}]) {
    assert.equal(decisionBrokerConfig(withSection({ selectorDefault })).decisionAgentSelectorDefault, 'off')
  }
  for (const autoShadow of [1, 'true', null, {}]) {
    assert.equal(decisionBrokerConfig(withSection({ autoShadow })).decisionAgentAutoShadow, false)
  }
  assert.deepEqual(decisionBrokerConfig(withSection({ autoAnswerClasses: '["A","A","C"]' })).decisionAgentAutoAnswerClasses, ['A', 'C'])
  for (const autoAnswerClasses of ['not-json', '{}', '["A","D"]', '["A",1]', ['A', 'D'], ['A', 1], null, {}]) {
    assert.deepEqual(decisionBrokerConfig(withSection({ autoAnswerClasses })).decisionAgentAutoAnswerClasses, [])
  }
})

test('waitForToolCall keeps bare JSON args and forwards RPC cancellation to the Broker', async () => {
  const invocation = decisionRemoteContribution().invocations.find(row => row.method === 'waitForToolCall')
  assert.ok(invocation)
  assert.equal(invocation.mode, undefined)
  assert.deepEqual(invocation.parameters, [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }])
  assert.deepEqual(invocation.cancellation, { parameter: 'signal' })

  const controller = new AbortController()
  const calls = []
  const broker = {
    status: () => ({ available: true }),
    waitForToolCall: async (args, signal) => { calls.push([args, signal]); return { caseId: 'dc-wait', revision: 4, state: 'awaiting_user' } },
  }
  const service = createDecisionRemoteService({ broker: () => broker })
  const result = await service.waitForToolCall({ sessionId: 'child', toolCallId: 'call' }, controller.signal)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { caseId: 'dc-wait', revision: 4, state: 'awaiting_user' })
  assert.deepEqual(calls, [[{ sessionId: 'child', toolCallId: 'call' }, controller.signal]])
})

test('routingReview is one authorized bare-args remote with contribution parity and explicit parameter errors', async () => {
  assert.equal(DECISION_REMOTE_METHODS.filter(method => method === 'routingReview').length, 1)
  const invocation = decisionRemoteContribution().invocations.find(row => row.method === 'routingReview')
  assert.ok(invocation)
  assert.equal(invocation.cancellation, undefined)
  assert.deepEqual(invocation.parameters, [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }])

  const contexts = []
  const calls = []
  const broker = {
    status: () => ({ available: true }),
    sessionContext: async sessionId => {
      contexts.push(sessionId)
      return { rootSessionId: 'root', workspaceKey: '/repo' }
    },
    routingReview: async args => {
      if (args.window === 'invalid') {
        const error = new Error('invalid routing window')
        error.code = 'INVALID_ROUTING_WINDOW'
        throw error
      }
      calls.push(args)
      return { window: args.window, summary: { agreement: 0 }, items: [], nextCursor: null }
    },
  }
  const service = createDecisionRemoteService({ broker: () => broker })
  const result = await service.routingReview({ sessionId: 'child', workspaceKey: '/spoof', window: '7d', cursor: 'cursor' })
  assert.deepEqual(result, { ok: true, value: { window: '7d', summary: { agreement: 0 }, items: [], nextCursor: null } })
  assert.deepEqual(contexts, ['child'])
  assert.deepEqual(calls, [{ sessionId: 'root', workspaceKey: '/repo', window: '7d', cursor: 'cursor' }])
  const invalid = await service.routingReview({ sessionId: 'child', window: 'invalid' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'INVALID_ROUTING_WINDOW')
})
