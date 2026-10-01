import test from 'node:test'
import assert from 'node:assert/strict'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'

test('stop during registration closes admission and waits for durable revocation', async () => {
  let registered, revoked
  const opened = new Promise(resolve => {registered = resolve})
  const cancellation = new Promise(resolve => {revoked = resolve})
  let cancels = 0
  const runtime = {control:{openSession:() => opened, cancelSession:() => {cancels++; return cancellation}},requests:{},close:async () => { assert.equal(acknowledged, true) }}
  const agent = {}
  const lifecycle = createEditLockLifecycle(runtime, candidate => candidate === agent ? 's' : undefined)
  const start = lifecycle.start(agent)
  const rejected = assert.rejects(start, /stopped during registration/)
  const stopped = lifecycle.stop(agent)
  let acknowledged = false
  void stopped.then(() => {acknowledged = true})
  await assert.rejects(lifecycle.service.publish({agent}, {}), /authenticated/)
  registered({sessionId:'s',executionEpoch:1,managerIncarnation:'m'})
  await Promise.resolve()
  assert.equal(acknowledged, false)
  revoked()
  await rejected
  await stopped
  assert.equal(cancels, 1)
  await assert.rejects(lifecycle.start(agent), /already registered/)
  await lifecycle.close()
  await assert.rejects(lifecycle.start({}), /closed/)
})
