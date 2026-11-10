import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t, { enabled = true, reader } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-stock-request-'))
  const workspace = realpathSync(dir)
  const calls = []
  const reads = []
  const ctx = {
    llm: {
      stream(options) {
        calls.push(options)
        return (async function * () {
          let output
          if (options.system.includes('router-classification-contract/1')) {
            const pack = JSON.parse(options.messages[0].content[0].text)
            output = { contract: 'router-classification-contract/1', classes: pack.questions.map(question => ({ id: question.id, authorizationClass: 'A' })) }
          } else if (options.system.includes('router-contract/1')) {
            output = { contract: 'router-contract/1', outcome: 'none', reason: 'No matching Agent' }
          } else {
            output = { outcome: 'escalate', missing: ['A new judgment is required'] }
          }
          yield { type: 'text-delta', text: JSON.stringify(output) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    sessionQuery: {
      ...(reader ? { readSession: async id => { reads.push(id); return reader(id) } } : {}),
    },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: enabled, decisionAgentAutoAnswerClasses: ['A', 'B', 'C'] }) })
  await broker.start()
  if (enabled) await broker.setSelector('root', 'auto')
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, broker, agent, calls, reads }
}

function questions(id = 'stock-q') {
  return [{ id, question: 'Choose the ordinary next step?', options: [{ label: 'First' }, { label: 'Second' }] }]
}

function requestFor(callId, liveQuestions = questions(), agent, timed = true) {
  return { questions: liveQuestions, ...(agent ? { agent } : {}), wait: { callId, ...(timed ? { timed: true } : {}) } }
}

function toolCall(callId, args, name = 'ask_user_question') {
  return { type: 'tool/call', data: { callId, name, arguments: typeof args === 'string' ? args : JSON.stringify({ questions: args }) } }
}

function snapshot(sessionId, events) {
  return { session: { id: sessionId }, inheritedEventCount: 0, events }
}

function counts(broker) {
  return {
    cases: broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n,
    routes: broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n,
    attempts: broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,
  }
}

for (const kind of ['plan-review', 'approval']) {
  for (const [shape, timed] of [['timed', true], ['blocking timeout=-1', false]]) {
    test(`stock ${shape} ${kind} intent survives normalized Hook metadata loss and bypasses before all Decision work`, async t => {
      const callId = `stock-${shape.replaceAll(/[^a-z0-9]+/g, '-')}-${kind}`
      const liveQuestions = questions(callId)
      const rawQuestions = liveQuestions.map(question => ({
        ...question,
        detail: 'Raw authority detail omitted by the stock Hook normalization',
        intent: { kind, ...(kind === 'plan-review' ? { approve: 'First' } : { approve: 'First', reject: 'Second' }) },
      }))
      assert.equal(liveQuestions[0].intent, undefined)
      assert.equal(liveQuestions[0].detail, undefined)
      const f = await fixture(t, { reader: async id => snapshot(id, [toolCall(callId, rawQuestions)]) })
      const request = requestFor(callId, liveQuestions, f.agent, timed)
      assert.equal(request.wait.timed === undefined, !timed)

      const verdict = await f.broker.hook({ agent: f.agent, request })

      assert.deepEqual(verdict, { kind: 'pass', why: 'bypass' })
      assert.deepEqual(f.reads, ['root'])
      assert.deepEqual(counts(f.broker), { cases: 0, routes: 0, attempts: 0 })
      assert.equal(f.calls.length, 0)
    })
  }
}

const malformedControls = [
  ['missing current call', async id => snapshot(id, [])],
  ['duplicate current call ids', async id => snapshot(id, [toolCall('stock-call', questions()), toolCall('stock-call', questions())])],
  ['wrong tool name', async id => snapshot(id, [toolCall('stock-call', questions(), 'decision_consult')])],
  ['wrong snapshot session', async () => snapshot('other-root', [toolCall('stock-call', questions())])],
  ['mismatched question id', async id => snapshot(id, [toolCall('stock-call', questions('other-q'))])],
  ['mismatched question text', async id => snapshot(id, [
    toolCall('stock-call', [{ ...questions()[0], question: 'A different current question?' }]),
  ])],
  ['duplicate raw question ids', async id => snapshot(id, [toolCall('stock-call', [questions()[0], questions()[0]])])],
  ['malformed raw JSON', async id => snapshot(id, [toolCall('stock-call', '{not-json')])],
  ['malformed raw question batch', async id => snapshot(id, [{ type: 'tool/call', data: { callId: 'stock-call', name: 'ask_user_question', arguments: '{"questions":{}}' } }])],
  ['unreadable snapshot', async () => undefined],
  ['read failure', async () => { throw new Error('session log unavailable') }],
]

for (const [label, reader] of malformedControls) {
  test(`stock Hook ${label} fails closed to native without Auto or persistence`, async t => {
    const f = await fixture(t, { reader })
    const verdict = await f.broker.hook({ agent: f.agent, request: requestFor('stock-call', questions(), f.agent) })
    assert.deepEqual(verdict, { kind: 'pass', why: 'bypass' })
    assert.deepEqual(f.reads, ['root'])
    assert.deepEqual(counts(f.broker), { cases: 0, routes: 0, attempts: 0 })
    assert.equal(f.calls.length, 0)
  })
}

test('blocking Host stock calls fail closed on missing evidence and read failure', async t => {
  for (const [label, reader] of [
    ['missing', async id => snapshot(id, [])],
    ['read-failure', async () => { throw new Error('session log unavailable') }],
  ]) {
    const f = await fixture(t, { reader })
    const request = requestFor(`blocking-${label}`, questions(), f.agent, false)
    assert.equal(request.wait.timed, undefined)
    assert.deepEqual(await f.broker.hook({ agent: f.agent, request }), { kind: 'pass', why: 'bypass' })
    assert.deepEqual(f.reads, ['root'])
    assert.deepEqual(counts(f.broker), { cases: 0, routes: 0, attempts: 0 })
    assert.equal(f.calls.length, 0)
  }
})

test('stock Hook with no usable reader fails closed instead of trusting normalized metadata', async t => {
  const f = await fixture(t)
  const verdict = await f.broker.hook({ agent: f.agent, request: requestFor('stock-call', questions(), f.agent) })
  assert.deepEqual(verdict, { kind: 'pass', why: 'bypass' })
  assert.deepEqual(counts(f.broker), { cases: 0, routes: 0, attempts: 0 })
  assert.equal(f.calls.length, 0)
})

test('a valid ordinary stock call remains classless Auto and does not persist raw authority metadata', async t => {
  const liveQuestions = questions('ordinary-stock')
  const rawQuestions = [{ ...liveQuestions[0], detail: 'Raw detail is not copied into the Case', intent: { kind: 'custom' } }]
  const f = await fixture(t, { reader: async id => snapshot(id, [toolCall('ordinary-call', rawQuestions)]) })
  const request = requestFor('ordinary-call', liveQuestions, f.agent)
  const before = structuredClone({ questions: request.questions, wait: request.wait })

  const verdict = await f.broker.hook({ agent: f.agent, request })

  assert.equal(verdict.why, 'awaiting_user')
  assert.equal(verdict.caseId !== undefined, true)
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.awaitingReason, 'no_route')
  assert.deepEqual(current.request, { entry: 'hook', questions: [{ ...liveQuestions[0], authorizationClass: 'A', authorizationClassSource: 'auto_classifier' }] })
  assert.equal(current.request.questions[0].authorizationClass, 'A')
  assert.equal(current.request.questions[0].authorizationClassSource, 'auto_classifier')
  assert.equal(current.request.questions[0].detail, undefined)
  assert.equal(current.request.questions[0].intent, undefined)
  assert.deepEqual({ questions: request.questions, wait: request.wait }, before)
  assert.deepEqual(f.reads, ['root'])
  assert.equal(f.calls.filter(call => call.system.includes('router-classification-contract/1')).length, 1)
  assert.equal(f.calls.filter(call => call.system.includes('router-contract/1')).length, 0)
  assert.deepEqual(counts(f.broker), { cases: 1, routes: 1, attempts: 0 })
})

test('an untimed direct Broker call without Host request.agent retains legacy Auto without a session read', async t => {
  const f = await fixture(t, { reader: async () => { throw new Error('must not read direct Broker fixtures') } })
  const request = { questions: questions('direct-broker'), wait: { callId: 'direct-broker' } }
  const verdict = await f.broker.hook({ agent: f.agent, request })
  assert.equal(verdict.why, 'awaiting_user')
  assert.deepEqual(f.reads, [])
  assert.deepEqual(counts(f.broker), { cases: 1, routes: 1, attempts: 0 })
  assert.equal(f.calls.filter(call => call.system.includes('router-classification-contract/1')).length, 1)
})

test('direct exclusions and Off bypass without session reads or Decision artifacts', async t => {
  const f = await fixture(t, { reader: async () => { throw new Error('must not read') } })
  const direct = requestFor('direct', questions(), f.agent)
  direct.questions[0].intent = { kind: 'plan-review', approve: 'First' }
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: direct }), { kind: 'pass', why: 'bypass' })
  await f.broker.setSelector('root', 'off')
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: requestFor('off', questions(), f.agent) }), { kind: 'pass', why: 'bypass' })
  assert.deepEqual(f.reads, [])
  assert.deepEqual(counts(f.broker), { cases: 0, routes: 0, attempts: 0 })
  assert.equal(f.calls.length, 0)
})

test('global-off remains zero-read and does not initialize the Decision database', async t => {
  const f = await fixture(t, { enabled: false, reader: async () => { throw new Error('must not read') } })
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: requestFor('global-off', questions(), f.agent) }), { kind: 'pass', why: 'bypass' })
  assert.deepEqual(f.reads, [])
  assert.equal(f.broker.store, undefined)
  assert.equal(existsSync(join(f.dir, 'weir', 'profiles', 'test', 'decisions')), false)
  assert.equal(f.calls.length, 0)
})
