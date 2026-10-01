import test from 'node:test'
import assert from 'node:assert/strict'
import { createEditLockHost } from '../src/edit-lock/host.js'

test('host authenticates object identity and seals admission before cancellation acknowledgement', async () => {
  const agent = {}
  const execution = {managerIncarnation: 'm', sessionId: 's', executionEpoch: 1}
  const cancelled = []
  let preparations = 0
  const runtime = {
    control: { cancelSession(id) { cancelled.push(id); return Promise.resolve() } },
    requests: { async prepare() { preparations++; return {kind: 'history', operation: {phase:'updated', outcome:{version:'v2'}}} } },
    async close() {},
  }
  const host = createEditLockHost(runtime, candidate => candidate === agent)
  assert.throws(() => host.attach({}, execution), /unregistered/)
  host.attach(agent, execution)
  const exec = {agent, callId:'c', signal:new AbortController().signal}
  const request = {tool:'hash_edit', filePath:'/work/a', cwd:'/work', effectivePolicy:{mode:'workspace-write'}, content:'a', args:{}, expected:{kind:'replaceIfVersion',version:'v1'}}
  assert.equal((await host.publish(exec, request)).version, 'v2')
  const cancellation = host.detach(agent)
  await assert.rejects(host.publish(exec, request), /authenticated/)
  await cancellation
  assert.deepEqual(cancelled, ['s'])
  assert.equal(preparations, 1)
  await host.close()
  assert.throws(() => host.attach(agent, execution), /closed/)
})

test('batch success releases only temporary locks; unknown failure retains and reports', async () => {
  for (const fail of [false, true]) {
    const agent = {}
    const released = []
    const history = new Map()
    let count = 0
    const temporary = [{resourceId:'/work/b'}]
    const runtime = {
      control: { history: (_session, id) => history.get(id), releaseMany: async tokens => released.push(...tokens) },
      requests: {
        acquireBatch: async () => ({temporary, ordered:[{resourceId:'/work/a'}, ...temporary]}),
        prepare: async (_execution, request) => {
          assert.equal(request.batchOwnership.resourceId, request.filePath)
          count++
          const operation = {phase: fail && count === 2 ? 'unknown' : 'updated', outcome:{version:'v2'}}
          history.set(request.operationId, operation)
          return {kind:'history', operation}
        },
      },
      async close() {},
    }
    const host = createEditLockHost(runtime, candidate => candidate === agent)
    host.attach(agent, {sessionId:'s', managerIncarnation:'m', executionEpoch:1})
    const action = host.publishBatch({agent, callId:'batch', signal:new AbortController().signal}, {
      cwd:'/work', effectivePolicy:{mode:'workspace-write'}, args:{new_name:'b'},
      plans:[{filePath:'/work/a',content:'a',version:'v1'},{filePath:'/work/b',content:'b',version:'v1'}],
    })
    if (fail) {
      await assert.rejects(action, error => /filesAlreadyWritten: \["\/work\/a"\]/.test(error.message) && /filesUncertain: \["\/work\/b"\]/.test(error.message))
      assert.deepEqual(released, [])
    } else {
      assert.deepEqual((await action).written, ['/work/a','/work/b'])
      assert.deepEqual(released, temporary)
    }
    await host.close()
  }
})
