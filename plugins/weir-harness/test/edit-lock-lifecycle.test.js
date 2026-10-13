import test from 'node:test'
import assert from 'node:assert/strict'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'

test('stop during registration closes admission and waits for durable revocation', async () => {
  let registered, revoked
  const opened = new Promise(resolve => {registered = resolve})
  const cancellation = new Promise(resolve => {revoked = resolve})
  let cancels = 0
  const runtime = {control:{status:() => ({managerIncarnation:'m',sessions:[],locks:[]}),openSession:() => opened, cancelSession:() => {cancels++; return cancellation}},requests:{},close:async () => { assert.equal(acknowledged, true) }}
  const agent = {}
  const lifecycle = createEditLockLifecycle(runtime, candidate => candidate === agent ? 's' : undefined)
  const start = lifecycle.start(agent)
  const rejected = assert.rejects(start, /stopped during registration/)
  const stopped = lifecycle.stop(agent)
  let acknowledged = false
  void stopped.then(() => {acknowledged = true})
  await assert.rejects(lifecycle.service.publish({agent}, {}), /was stopped/)
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

test('resume of an administratively revoked session repairs it: receipt, epoch advance, repair audit', async () => {
  const calls = []
  const repairs = []
  const session = { sessionId: 's', executionEpoch: 19, interrupted: true, revoked: true }
  const runtime = { control: {
    status: () => ({ managerIncarnation: 'm', sessions: [{ ...session }], locks: [] }),
    openSession: async () => { throw new Error('must not register a known session') },
    cancelSession: () => Promise.resolve({ sessionId: 's', executionEpoch: 19, managerIncarnation: 'm' }),
    issueExecutionReceipt: (execution, requestId) => { calls.push(['receipt', execution.executionEpoch, requestId]); return Promise.resolve({}) },
    resume: (execution, requestId) => {
      calls.push(['resume', execution.executionEpoch, requestId])
      session.executionEpoch += 1; session.interrupted = false; session.revoked = false
      return Promise.resolve({ managerIncarnation: 'm', sessionId: 's', executionEpoch: session.executionEpoch })
    },
    recoveryUsage: () => ({ sessionId: 's', attempts: 0, elapsedMs: 0, pauseMs: 0 }),
    settlement: () => ({ held: false, expired: false }),
  }, requests: {}, close: async () => {} }
  const agent = {}
  const lifecycle = createEditLockLifecycle(runtime, candidate => candidate === agent ? 's' : undefined,
    { onRevocationRepair: info => repairs.push(info) })
  // A durably known session starts interrupted, revoked flag included.
  assert.equal(await lifecycle.start(agent), 'interrupted')
  assert.equal(lifecycle.status(agent).revoked, true)
  const status = await lifecycle.resume(agent, 'r1')
  assert.deepEqual(calls, [['receipt', 19, 'r1'], ['resume', 19, 'r1']])
  assert.equal(status.state, 'active')
  assert.equal(status.revoked, false)
  assert.equal(status.executionEpoch, 20)
  assert.deepEqual(repairs, [{ owner: 's', fromEpoch: 19, toEpoch: 20, trigger: 'manual' }])
  await lifecycle.close()
})
