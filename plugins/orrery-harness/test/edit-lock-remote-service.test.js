import test from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteEditLockService } from '../src/edit-lock/remote-service.js'

test('remote tools require exact registered agent and never fall back',async () => {
 const agent = {}
 let calls = 0
 let live = true
 const remote = createRemoteEditLockService({request:async () => {calls++; throw new Error('disconnected')},close() {}},agent,() => live)
 const exec = {agent,callId:'c',signal:new AbortController().signal}
 await assert.rejects(remote.service.publish({...exec,agent:{}},{}),/authenticated/)
 await assert.rejects(remote.service.publish(exec,{}),/disconnected/)
 live = false
 await assert.rejects(remote.service.publishBatch(exec,{}),/authenticated/)
 remote.close()
 live = true
 await assert.rejects(remote.service.publish(exec,{}),/authenticated/)
 assert.equal(calls,1)
})
