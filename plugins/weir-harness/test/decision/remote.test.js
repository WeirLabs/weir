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
  assert.deepEqual(calls.find(call => call[0] === 'setSelector')[1], ['child', 'agent', 'ag', '/repo'])
  assert.deepEqual(calls.find(call => call[0] === 'profileSetState')[1], ['ag', 'disabled', '/repo'])
  assert.equal(calls.find(call => call[0] === 'decide')[1][0].workspaceKey, '/repo')
  assert.equal(calls.find(call => call[0] === 'profileUpsert')[1][0].workspaceKey, '/repo')
})

test('Broker errors become bounded envelopes without stacks; disabled stays unavailable', async () => {
  const error = new Error('bad input')
  error.code = 'BAD_INPUT'
  const broker = { status: () => ({ available: true }), record: async () => { throw error } }
  const service = createDecisionRemoteService({ broker: () => broker })
  const result = await service.record({ caseId: 'dc' })
  assert.deepEqual(result, { ok: false, error: { code: 'BAD_INPUT', message: 'bad input' } })
  assert.equal(JSON.stringify(result).includes('stack'), false)

  const disabled = createDecisionRemoteService({ broker: () => ({ status: () => ({ available: false, reason: 'disabled' }) }) })
  assert.deepEqual(await disabled.overview({ sessionId: 'root' }), { ok: false, error: { code: 'DECISION_UNAVAILABLE', message: 'disabled' } })
  const unavailable = createDecisionRemoteService({ broker: () => broker, ensureRegistered: () => false })
  assert.equal((await unavailable.overview({})).error.code, 'CHANNEL_UNAVAILABLE')
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
  const settings = { enabled: false, answerTimeoutMs: 10, maxAttemptsPerCase: 2, contextBudgetTokens: 1000, maxOutputTokens: 100, maxConcurrentAttempts: 1, chains: { ag: [] }, retentionDays: 0, storePath: '' }
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
  await dispose()
  assert.equal(broker.store, undefined)
})
