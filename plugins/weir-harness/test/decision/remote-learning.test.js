import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecisionRemoteService, decisionRemoteContribution } from '../../src/decision/remote.js'

const methods = ['learningStart', 'learningRun', 'snapshotPublish', 'snapshotReject', 'snapshotRollback', 'snapshotUpdate', 'memorySnapshot']
const mutationMethods = new Set(['learningStart', 'snapshotPublish', 'snapshotReject', 'snapshotRollback', 'snapshotUpdate'])

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

test('snapshotUpdate forwards the closed edit payload and derives session and workspace itself', async () => {
  const calls = []
  const broker = {
    status: () => ({ available: true }),
    sessionContext: async () => ({ rootSessionId: 'root-derived', workspaceKey: '/repo/derived' }),
    snapshotUpdate: async args => { calls.push(args); return { snapshotId: args.snapshotId, revision: 5 } },
  }
  const service = createDecisionRemoteService({ broker: () => broker })
  const result = await service.snapshotUpdate({
    sessionId: 'child', snapshotId: 'ms_one', expectedRevision: 4,
    edits: [{ principleId: 'pr_a', text: 'Chosen wording' }, { principleId: 'pr_b', remove: true }],
    // A caller-named workspace never survives the Host derivation.
    workspaceKey: '/forged',
  })
  assert.deepEqual(result, { ok: true, value: { snapshotId: 'ms_one', revision: 5 } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'root-derived')
  assert.equal(calls[0].workspaceKey, '/repo/derived')
  assert.equal(calls[0].snapshotId, 'ms_one')
  assert.equal(calls[0].expectedRevision, 4)
  assert.deepEqual(calls[0].edits, [{ principleId: 'pr_a', text: 'Chosen wording' }, { principleId: 'pr_b', remove: true }])
  const invocation = decisionRemoteContribution().invocations.find(row => row.method === 'snapshotUpdate')
  assert.ok(invocation)
  assert.deepEqual(invocation.parameters, [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }])
  assert.equal(invocation.scope, undefined)
})

test('snapshotUpdate keeps the closed error vocabulary of the learning mutations', async () => {
  const cases = [
    ['REVISION_CONFLICT', 409],
    ['CANDIDATE_ITEM_NOT_EDITABLE', 409],
    ['SNAPSHOT_STATE_CONFLICT', 409],
    ['UNKNOWN_FIELD', 400],
    ['OUT_OF_SCOPE', 403],
  ]
  for (const [code] of cases) {
    const service = createDecisionRemoteService({ broker: () => ({
      status: () => ({ available: true }),
      sessionContext: async () => ({ rootSessionId: 'root', workspaceKey: '/repo' }),
      snapshotUpdate: async () => { throw Object.assign(new Error(`${code}: detail`), { code }) },
    }) })
    const result = await service.snapshotUpdate({ sessionId: 'root', snapshotId: 'ms_one', expectedRevision: 1, edits: [] })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
    assert.equal(result.error.message, `${code}: detail`)
  }
})
