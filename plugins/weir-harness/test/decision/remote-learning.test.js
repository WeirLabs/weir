import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecisionRemoteService, decisionRemoteContribution } from '../../src/decision/remote.js'

const methods = ['learningStart', 'learningRun', 'snapshotPublish', 'snapshotReject', 'snapshotRollback', 'memorySnapshot']
const mutationMethods = new Set(['learningStart', 'snapshotPublish', 'snapshotReject', 'snapshotRollback'])

for (const method of methods) {
  test(`${method} is a bare-args RPC with session authorization and intact P3 parameters`, async () => {
    const calls = []
    const broker = {
      status: () => ({ available: true }),
      sessionContext: async sessionId => ({ rootSessionId: `root-for-${sessionId}`, workspaceKey: '/repo' }),
      [method]: async args => { calls.push(args); return { method } },
    }
    const service = createDecisionRemoteService({ broker: () => broker })
    assert.equal(typeof service[method], 'function')
    const args = {
      sessionId: 'child', agentId: 'agent-a', requestId: 'req-client',
      learningRunId: 'lr_one', snapshotId: 'ms_one', expectedRevision: 4,
    }
    const result = await service[method](args)
    assert.deepEqual(result, { ok: true, value: { method } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].requestId, 'req-client')
    assert.equal(calls[0].expectedRevision, 4)
    if (mutationMethods.has(method)) {
      assert.equal(calls[0].sessionId, 'root-for-child')
      assert.equal(calls[0].workspaceKey, '/repo')
    } else {
      assert.equal(calls[0].sessionId, 'child')
    }
    const invocation = decisionRemoteContribution().invocations.find(row => row.method === method)
    assert.deepEqual(invocation.parameters, [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }])
    assert.equal(invocation.scope, undefined)
  })
}
