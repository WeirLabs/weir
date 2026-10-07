import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCallContexts } from '../src/edit-lock/call-context.js'

test('captures trusted call data and rejects copied or foreign capabilities', () => {
  const contexts = createCallContexts()
  const signal = new AbortController().signal
  const execution = { sessionId: 'alice', executionEpoch: 1, managerIncarnation: 'manager' }
  const policy = { mode: 'workspace-write', writableRoots: ['/work'] }
  const call = contexts.bind(execution, { signal, cwd: '/work', effectivePolicy: policy, callId: 'call' }, () => {})
  execution.executionEpoch = 2; policy.writableRoots.push('/other')
  const captured = contexts.inspect(call)
  assert.equal(captured.execution.executionEpoch, 1)
  assert.deepEqual(captured.effectivePolicy.writableRoots, ['/work'])
  assert.ok(Object.isFrozen(captured.execution))
  assert.throws(() => contexts.inspect({ ...call }), /unknown call/)
  assert.throws(() => createCallContexts().inspect(call), /unknown call/)
})

test('latches an already-aborted or later-aborted call before returning control', () => {
  for (const early of [false, true]) {
    const contexts = createCallContexts()
    const abort = new AbortController()
    if (early) abort.abort()
    let notified = 0
    const call = contexts.bind({ sessionId: 'alice', executionEpoch: 1, managerIncarnation: 'm' },
      { signal: abort.signal, cwd: '/work', effectivePolicy: { mode: 'read-only' }, callId: 'c' }, () => { notified++ })
    if (!early) abort.abort()
    assert.equal(notified, 1)
    assert.equal(contexts.inspect(call).signal.aborted, true)
    assert.throws(() => contexts.requireLive(call), /aborted/)
    contexts.close(call)
    assert.throws(() => contexts.inspect(call), /closed/)
  }
})

test('closing a call disconnects delayed abort from subsequent executions', () => {
  const contexts = createCallContexts()
  const abort = new AbortController()
  let notified = 0
  const call = contexts.bind({ sessionId: 'alice', executionEpoch: 1, managerIncarnation: 'm' },
    { signal: abort.signal, cwd: '/work', effectivePolicy: {}, callId: 'c' }, () => { notified++ })
  contexts.close(call)
  abort.abort()
  assert.equal(notified, 0)
})
