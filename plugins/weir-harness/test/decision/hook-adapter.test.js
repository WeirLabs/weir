import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDecisionHooks } from '../../src/decision/hook.js'

function setup(broker) {
  const listeners = {}
  const options = []
  const ctx = {
    on: (name, fn, option) => { listeners[name] = fn; options.push({ name, option }) },
    get: name => name === 'weirDecisionBroker' ? broker : undefined,
  }
  applyDecisionHooks(ctx)
  return { listeners, options }
}

const root = { id: 'root', session: { header: { delegationDepth: 0 } } }
const request = { agent: root, questions: [] }

test('Hook registers prepend and fail-open paths never touch broker writes', async () => {
  const writes = []
  const broker = {
    status: () => ({ available: false }), hook: () => writes.push('hook'),
    hookUserAnswer: () => writes.push('answer'), hookUserAborted: () => writes.push('abort'),
  }
  const { listeners, options } = setup(broker)
  assert.equal(options.find(item => item.name === 'user-questions/request').option.prepend, true)
  let nextCalls = 0
  const next = async () => { nextCalls++; return { answers: [] } }
  await listeners['user-questions/request'](request, next)
  await listeners['user-questions/request']({ ...request, agent: { ...root, session: { header: { delegationDepth: 1 } } } }, next)
  await listeners['user-questions/request']({ ...request, agent: undefined }, next)
  assert.equal(nextCalls, 3)
  assert.deepEqual(writes, [])

  const missing = setup(undefined)
  await missing.listeners['user-questions/request'](request, next)
  assert.equal(nextCalls, 4)
})

test('answer returns directly; return and escalation call next with exact backfill rules', async () => {
  const writes = []
  const broker = {
    status: () => ({ available: true }),
    hook: async (_input) => broker.verdict,
    hookUserAnswer: async input => writes.push(input),
    hookUserAborted: async () => writes.push('abort'),
    verdict: { kind: 'answer', answer: { answers: [{ id: 'q', selected: ['A'] }] } },
  }
  const { listeners } = setup(broker)
  let nextCalls = 0
  const next = async () => { nextCalls++; return { answers: [{ id: 'q', selected: ['B'] }] } }
  const answer = await listeners['user-questions/request'](request, next)
  assert.deepEqual(answer, broker.verdict.answer)
  assert.equal(nextCalls, 0)

  broker.verdict = { kind: 'pass', caseId: 'dc_return', why: 'awaiting_revision' }
  await listeners['user-questions/request'](request, next)
  assert.equal(nextCalls, 1)
  assert.deepEqual(writes, [])

  broker.verdict = { kind: 'pass', caseId: 'dc_escalate', why: 'awaiting_user' }
  const native = await listeners['user-questions/request'](request, next)
  assert.deepEqual(native.answers, [{ id: 'q', selected: ['B'] }])
  assert.deepEqual(writes, [{ caseId: 'dc_escalate', answer: native }])
})

test('next failure is rethrown after cancellation; evaluator cancellation uses a fresh abort Error', async () => {
  const writes = []
  const broker = {
    status: () => ({ available: true }), hook: async () => broker.verdict,
    hookUserAborted: async input => writes.push(input),
    verdict: { kind: 'pass', caseId: 'dc_1', why: 'awaiting_user' },
  }
  const { listeners } = setup(broker)
  const original = new Error('native abort')
  await assert.rejects(listeners['user-questions/request'](request, async () => { throw original }), error => error === original)
  assert.deepEqual(writes, [{ caseId: 'dc_1' }])

  broker.verdict = { kind: 'pass', caseId: 'dc_2', why: 'cancelled' }
  await assert.rejects(listeners['user-questions/request'](request, async () => ({ answers: [] })), error => error.message === 'Decision Hook aborted' && error.name !== 'UserQuestionError')
})

test('turn-stopping passes only the current agent to Broker cleanup', async () => {
  const calls = []
  const broker = { status: () => ({ available: true }), turnStopping: async input => calls.push(input) }
  const { listeners } = setup(broker)
  await listeners['agent/turn-stopping']({ agent: root })
  assert.deepEqual(calls, [{ agent: root }])
})
