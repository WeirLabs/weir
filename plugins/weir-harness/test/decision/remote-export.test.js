// Decision data export: the remote whitelist and the caller-field drop
// (OpenSpec decision-data-export task 2.2).
//
// `exportData` is a closed remote method that forwards exactly one caller value —
// its session. A caller-named workspace, Agent, path or content is dropped
// before the Broker sees it, so an export can never widen its own scope.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DECISION_REMOTE_METHODS, createDecisionRemoteService } from '../../src/decision/remote.js'

function stubBroker(overrides = {}) {
  const calls = []
  const broker = {
    status: () => ({ available: true, enabled: true }),
    sessionContext: async sessionId => {
      calls.push(['sessionContext', sessionId])
      return { rootSessionId: 'root-derived', workspaceKey: '/derived/workspace' }
    },
    exportData: async input => {
      calls.push(['exportData', input])
      return { file: '/store/exports/decision-export-origin_abc-1000-deadbeef.json', bytes: 12, sha256: 'f'.repeat(64), counts: { cases: 0 }, exportedAt: 1000 }
    },
    ...overrides,
  }
  const remote = createDecisionRemoteService({ broker: () => broker })
  return { remote, calls }
}

test('exportData is part of the closed remote method whitelist', () => {
  assert.ok(DECISION_REMOTE_METHODS.includes('exportData'))
  assert.equal(new Set(DECISION_REMOTE_METHODS).size, DECISION_REMOTE_METHODS.length, 'no duplicate method')
})

test('an export call forwards only the caller session and drops every other field', async () => {
  const { remote, calls } = stubBroker()
  const result = await remote.exportData({
    sessionId: 'child-session',
    workspaceKey: '/caller/named/workspace',
    agentId: 'ag_caller_named',
    path: '/caller/named/target.json',
    file: 'overwrite-me.json',
    content: 'CALLER-CONTENT',
    scope: { workspaces: ['/caller/named/workspace'] },
    exportedAt: 1,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.counts, { cases: 0 })
  const exportCall = calls.find(call => call[0] === 'exportData')
  assert.deepEqual(exportCall[1], { sessionId: 'root-derived' }, 'only the Host-derived root session reaches the Broker')
  assert.deepEqual(calls.find(call => call[0] === 'sessionContext'), ['sessionContext', 'child-session'])
})

test('the export remote surface reports closed failure codes unchanged', async () => {
  const failing = stubBroker({
    exportData: async () => {
      const error = new Error('EXPORT_TOO_LARGE: 40000000 bytes exceeds 33554432')
      // @ts-ignore - DecisionContractError shape
      error.code = 'EXPORT_TOO_LARGE'
      throw error
    },
  })
  const result = await failing.remote.exportData({ sessionId: 'root' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'EXPORT_TOO_LARGE')
})

test('a disabled or unavailable Broker fails the export closed before any call', async () => {
  const disabled = stubBroker({ status: () => ({ available: false, enabled: false, reason: 'disabled' }) })
  const first = await disabled.remote.exportData({ sessionId: 'root' })
  assert.equal(first.ok, false)
  assert.equal(first.error.code, 'DECISION_UNAVAILABLE')
  assert.equal(disabled.calls.length, 0, 'no context lookup happens for an unavailable surface')

  const unavailable = stubBroker({ status: () => ({ available: false, enabled: true, reason: 'store_open_failed' }) })
  const second = await unavailable.remote.exportData({ sessionId: 'root' })
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'DECISION_UNAVAILABLE')
  assert.equal(unavailable.calls.length, 0)
})
