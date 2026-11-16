import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { openDecisionDatabase } from '../../src/decision/store/db.js'

const ROUTER = 'router-contract/1'
const EVALUATOR = 'evaluator-contract/3'

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve: value => resolve(value) }
}

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-auto-flight-'))
  const workspace = realpathSync(dir)
  const config = {
    decisionAgentsEnabled: true,
    decisionAgentAutoAnswer: true,
    decisionAgentAnswerTimeoutMs: 1000,
    decisionAgentMaxOutputTokens: 1600,
    decisionAgentContextBudgetTokens: 24000,
    ...overrides,
  }
  const calls = []
  const holds = new Map()
  let routing = { contract: ROUTER, outcome: 'none', reason: 'No matching Agent' }
  let evaluation = { outcome: 'escalate', missing: ['A new judgment is required'] }
  const ctx = {
    llm: {
      stream(options) {
        calls.push(options)
        return (async function * () {
          const contract = options.system.includes(ROUTER) ? ROUTER : EVALUATOR
          const held = holds.get(contract)
          if (held) {
            holds.delete(contract)
            held.started.resolve(options)
            await held.release.promise
          }
          const output = contract === ROUTER ? routing : evaluation
          yield { type: 'text-delta', text: typeof output === 'string' ? output : JSON.stringify(output) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    fs: {
      resolve: value => ({ displayPath: value }),
      contains: () => true,
      stat: async () => ({ type: 'file', version: 1 }),
      readText: async () => 'Current evidence contents',
    },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => config })
  await broker.start()
  await broker.setSelector('root', 'auto')
  const makeAgent = id => ({ id, session: { header: { id, cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } })
  const agent = makeAgent('root')
  ctx.agents = { get: id => id === 'root' ? agent : undefined }
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return {
    broker, agent, makeAgent, workspace, config, calls,
    routeWith(value) { routing = value },
    evaluateWith(value) { evaluation = value },
    hold(contract) {
      const release = deferred()
      const started = deferred()
      holds.set(contract, { release, started })
      return { release: () => release.resolve(), started: started.promise }
    },
    /** Two eligible assistants plus a scripted Router selection of the first. */
    async twoCandidates() {
      const fixed = await broker.profileUpsert({ workspaceKey: workspace, name: 'Fixed' })
      await broker.profileUpsert({ workspaceKey: workspace, name: 'Other' })
      routing = { contract: ROUTER, outcome: 'selected', agentId: fixed.agentId, reason: 'Fixed owns this decision' }
      return fixed
    },
  }
}

function hookRequest(callId = 'call', text = 'Choose a direction?') {
  return {
    questions: [{ id: 'q', question: text, options: [{ label: 'A' }, { label: 'B' }] }],
    wait: { callId },
  }
}

function callsOf(f, contract) {
  return f.calls.filter(call => call.system.includes(contract))
}

function counts(f, caseId) {
  return {
    cases: f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n,
    routes: f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions WHERE case_id=?').get(caseId).n,
    attempts: f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE case_id=?').get(caseId).n,
  }
}

async function drainMicrotasks() {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

test('before-commit same-key Hook and consult deliveries join one Auto flight', async t => {
  const hookedFixture = await fixture(t)
  await hookedFixture.twoCandidates()
  const hookGate = hookedFixture.hold(ROUTER)
  const request = hookRequest('join-hook')
  const firstHook = hookedFixture.broker.hook({ agent: hookedFixture.agent, request })
  let replaySettled = false
  const replayedHook = hookedFixture.broker.hook({ agent: hookedFixture.agent, request }).then(value => { replaySettled = true; return value })
  await hookGate.started
  await drainMicrotasks()
  const replaySettledBeforeCommit = replaySettled
  hookGate.release()
  const [hooked, replayed] = await Promise.all([firstHook, replayedHook])
  assert.equal(replaySettledBeforeCommit, false, 'a received intake must not be handed to native next before route commit')
  assert.deepEqual(replayed, hooked)
  assert.equal(hooked.why, 'awaiting_user')
  assert.deepEqual(counts(hookedFixture, hooked.caseId), { cases: 1, routes: 1, attempts: 1 })
  assert.equal(callsOf(hookedFixture, ROUTER).length, 1)

  const consultedFixture = await fixture(t)
  await consultedFixture.twoCandidates()
  const consultGate = consultedFixture.hold(ROUTER)
  const args = { question: 'Join this consultation?', request_id: 'join-consult' }
  let publishes = 0
  const publish = consultedFixture.broker.publishConsult.bind(consultedFixture.broker)
  consultedFixture.broker.publishConsult = current => { publishes++; publish(current) }
  const firstConsult = consultedFixture.broker.consult({ agent: consultedFixture.agent, args })
  let consultReplaySettled = false
  const replayedConsult = consultedFixture.broker.consult({ agent: consultedFixture.agent, args }).then(value => { consultReplaySettled = true; return value })
  await consultGate.started
  await drainMicrotasks()
  const consultReplaySettledBeforeCommit = consultReplaySettled
  const publishesBeforeCommit = publishes
  consultGate.release()
  const [consulted, consultReplay] = await Promise.all([firstConsult, replayedConsult])
  assert.equal(consultReplaySettledBeforeCommit, false, 'a received consultation must not publish or return awaiting_user before route commit')
  assert.equal(publishesBeforeCommit, 0)
  assert.deepEqual(consultReplay, consulted)
  assert.equal(consulted.outcome, 'awaiting_user')
  assert.equal(publishes, 1)
  assert.deepEqual(counts(consultedFixture, consulted.caseId), { cases: 1, routes: 1, attempts: 1 })
  assert.equal(callsOf(consultedFixture, ROUTER).length, 1)
  assert.equal(consultedFixture.broker.autoFlights.size, 0)
  assert.equal(consultedFixture.broker.routingControllers.size, 0)
  assert.equal(consultedFixture.broker.routingJobs.size, 0)
})

test('selector-change consult joins its existing Auto flight before pinned dispatch', async t => {
  const f = await fixture(t)
  const selected = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Fixed' })
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Other' })
  f.routeWith({ contract: ROUTER, outcome: 'selected', agentId: selected.agentId, reason: 'Fixed owns this decision' })
  const gate = f.hold(ROUTER)
  const args = { question: 'Join after selector change?', request_id: 'selector-change-consult' }
  let publishes = 0
  const publish = f.broker.publishConsult.bind(f.broker)
  f.broker.publishConsult = current => { publishes++; publish(current) }
  let firstSettled = false
  let replaySettled = false
  const first = f.broker.consult({ agent: f.agent, args }).then(value => { firstSettled = true; return value })
  await gate.started
  await f.broker.setSelector('root', 'agent', selected.agentId)
  const replay = f.broker.consult({ agent: f.agent, args }).then(value => { replaySettled = true; return value })
  await drainMicrotasks()
  const before = { firstSettled, replaySettled, publishes, flights: f.broker.autoFlights.size }
  gate.release()
  const [consulted, replayed] = await Promise.all([first, replay])

  assert.deepEqual(before, { firstSettled: false, replaySettled: false, publishes: 0, flights: 1 })
  assert.deepEqual(replayed, consulted)
  assert.equal(publishes, 1)
  assert.deepEqual(counts(f, consulted.caseId), { cases: 1, routes: 1, attempts: 1 })
  assert.equal(callsOf(f, ROUTER).length, 1)
  assert.equal(f.broker.autoFlights.size, 0)
})

test('selector-change Hook joins its existing Auto flight before pinned dispatch', async t => {
  const f = await fixture(t)
  const selected = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Fixed' })
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Other' })
  f.routeWith({ contract: ROUTER, outcome: 'selected', agentId: selected.agentId, reason: 'Fixed owns this decision' })
  const gate = f.hold(ROUTER)
  const request = hookRequest('selector-change-hook')
  let firstSettled = false
  let replaySettled = false
  const first = f.broker.hook({ agent: f.agent, request }).then(value => { firstSettled = true; return value })
  await gate.started
  await f.broker.setSelector('root', 'agent', selected.agentId)
  const replay = f.broker.hook({ agent: f.agent, request }).then(value => { replaySettled = true; return value })
  await drainMicrotasks()
  const before = { firstSettled, replaySettled, flights: f.broker.autoFlights.size }
  gate.release()
  const [hooked, replayed] = await Promise.all([first, replay])

  assert.deepEqual(before, { firstSettled: false, replaySettled: false, flights: 1 })
  assert.deepEqual(replayed, hooked)
  assert.equal(hooked.why, 'awaiting_user')
  assert.deepEqual(counts(f, hooked.caseId), { cases: 1, routes: 1, attempts: 1 })
  assert.equal(callsOf(f, ROUTER).length, 1)
  assert.equal(f.broker.autoFlights.size, 0)
})

test('post-flight Auto replay is idempotent while caller changes are real revisions', async t => {
  const changes = [
    ['question', args => ({ ...args, question: 'Changed question?' })],
    ['options', args => ({ ...args, options: [{ label: 'C' }] })],
    ['context', args => ({ ...args, context: 'Changed task context' })],
    ['evidence', args => ({ ...args, evidence: [{ path: 'notes.md', excerpt_hint: 'evidence' }] })],
    ['scope', (args, f) => ({ ...args, scope: { workspaces: [f.workspace], paths: ['src'] } })],
    ['header', args => ({ ...args, header: 'Changed header' })],
  ]
  for (const [label, change] of changes) {
    const f = await fixture(t)
    const selected = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Fixed' })
    f.evaluateWith({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Revise the request' })
    const args = { question: `Original ${label}?`, options: [{ label: 'A' }, { label: 'B' }], request_id: `revision-${label}` }
    const first = await f.broker.consult({ agent: f.agent, args })
    assert.equal(first.outcome, 'returned', label)
    assert.equal(f.broker.autoFlights.size, 0, label)
    const replay = await f.broker.consult({ agent: f.agent, args })
    assert.deepEqual(replay, first, label)
    assert.deepEqual(counts(f, first.caseId), { cases: 1, routes: 1, attempts: 1 }, label)

    const revised = await f.broker.consult({ agent: f.agent, args: change(args, f) })
    assert.equal(revised.caseId, first.caseId, label)
    assert.equal(revised.outcome, 'returned', label)
    assert.deepEqual(counts(f, first.caseId), { cases: 1, routes: 1, attempts: 2 }, label)
    assert.equal(f.broker.cases.getCase(first.caseId).agentId, selected.agentId, label)
    // One candidate and revisions need no Router call at all.
    assert.equal(callsOf(f, ROUTER).length, 0, `${label}: no Router call for a single candidate`)
  }

  // A legacy `authorization_class` argument is inert: adding or removing it
  // changes nothing, so the replay stays byte-identical with no new Attempt.
  const legacy = await fixture(t)
  await legacy.broker.profileUpsert({ workspaceKey: legacy.workspace, name: 'Fixed' })
  legacy.evaluateWith({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Revise the request' })
  const initial = { question: 'Legacy caller class?', authorization_class: 'A', request_id: 'legacy-caller-class' }
  const first = await legacy.broker.consult({ agent: legacy.agent, args: initial })
  const replay = await legacy.broker.consult({ agent: legacy.agent, args: initial })
  assert.deepEqual(replay, first)
  const { authorization_class, ...classless } = initial
  assert.deepEqual(await legacy.broker.consult({ agent: legacy.agent, args: classless }), first)
  assert.deepEqual(counts(legacy, first.caseId), { cases: 1, routes: 1, attempts: 1 })
  assert.equal(legacy.broker.cases.getCase(first.caseId).request.questions[0].authorizationClass, undefined)
  assert.equal(callsOf(legacy, ROUTER).length, 0)
})

test('Auto revision and retry keep the established Agent despite selector and Router changes', async t => {
  const f = await fixture(t)
  const a = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'A' })
  const b = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'B' })
  f.routeWith({ contract: ROUTER, outcome: 'selected', agentId: a.agentId, reason: 'A owns the initial Case' })
  f.evaluateWith({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Revise the request' })
  const initial = { question: 'Initial Auto judgment?', request_id: 'fixed-auto-agent' }
  const first = await f.broker.consult({ agent: f.agent, args: initial })
  assert.equal(f.broker.cases.getCase(first.caseId).agentId, a.agentId)

  await f.broker.setSelector('root', 'agent', b.agentId)
  f.routeWith({ contract: ROUTER, outcome: 'selected', agentId: b.agentId, reason: 'B must only affect new requests' })
  const revised = await f.broker.consult({ agent: f.agent, args: { ...initial, question: 'Revised Auto judgment?' } })
  assert.equal(revised.caseId, first.caseId)
  assert.equal(f.broker.cases.getCase(first.caseId).agentId, a.agentId)
  assert.equal(f.broker.attempts.forCase(first.caseId).at(-1).agentId, a.agentId)
  assert.equal(counts(f, first.caseId).routes, 1)
  assert.equal(callsOf(f, ROUTER).length, 1)

  f.evaluateWith({ outcome: 'escalate', missing: ['A user decision is required'] })
  await f.broker.consult({ agent: f.agent, args: { ...initial, question: 'Revise once more before retry?' } })
  await f.broker.retry({ caseId: first.caseId })
  assert.equal(f.broker.cases.getCase(first.caseId).agentId, a.agentId)
  assert.equal(f.broker.attempts.forCase(first.caseId).at(-1).agentId, a.agentId)
  assert.equal(counts(f, first.caseId).routes, 1)
  assert.equal(callsOf(f, ROUTER).length, 1)
})

const AUTO_REVISION_DENIALS = [
  ['approval', { question: 'Revised request: approve this deployment?' }],
  ['high-risk', { question: 'Revised request: execute this irreversible operation?' }],
  ['execution', { question: 'Revised request: edit this file with execution authority?' }],
]

for (const [label, denial] of AUTO_REVISION_DENIALS) {
  test(`Auto revision rejects ${label} authority before changing the Case or starting an Attempt`, async t => {
    const f = await fixture(t)
    const selected = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Fixed' })
    f.evaluateWith({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Revise the request' })
    const initial = { question: 'Initial safe content?', options: [{ label: 'A' }, { label: 'B' }], request_id: `revision-denial-${label}` }
    const first = await f.broker.consult({ agent: f.agent, args: initial })
    const before = f.broker.cases.getCase(first.caseId)
    const revised = { ...initial, question: denial.question }

    await assert.rejects(f.broker.consult({ agent: f.agent, args: revised }), error => error.code === 'AUTHORITY')
    assert.deepEqual(f.broker.cases.getCase(first.caseId), before)
    assert.deepEqual(counts(f, first.caseId), { cases: 1, routes: 1, attempts: 1 })
    assert.equal(before.agentId, selected.agentId)
    assert.equal(callsOf(f, ROUTER).length, 0)
  })
}

test('the answer switch gates the revision too, not only the first Auto answer', async t => {
  const f = await fixture(t)
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Fixed' })
  f.evaluateWith({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Revise the request' })
  const initial = { question: 'Original content?', options: [{ label: 'A' }], request_id: 'switch-gated-revision' }
  const first = await f.broker.consult({ agent: f.agent, args: initial })
  const before = f.broker.cases.getCase(first.caseId)
  // The switch is the single answer permission: turning it off blocks a revised
  // Auto evaluation exactly like it blocks the first one.
  f.config.decisionAgentAutoAnswer = false
  await assert.rejects(
    f.broker.consult({ agent: f.agent, args: { ...initial, question: 'Different content?' } }),
    error => error.code === 'AUTHORITY',
  )
  assert.deepEqual(f.broker.cases.getCase(first.caseId), before)
  assert.deepEqual(counts(f, first.caseId), { cases: 1, routes: 1, attempts: 1 })
  assert.equal(callsOf(f, ROUTER).length, 0)
})

test('one Auto permit is held through routing and evaluation, then released for later work', async t => {
  const f = await fixture(t, { decisionAgentMaxConcurrentAttempts: 1 })
  const selected = await f.twoCandidates()
  await f.broker.setSelector('routing-root', 'agent', selected.agentId)
  await f.broker.setSelector('evaluation-root', 'agent', selected.agentId)
  const routingGate = f.hold(ROUTER)
  const automatic = f.broker.hook({ agent: f.agent, request: hookRequest('held-slot') })
  await routingGate.started
  const routingSlotCount = f.broker.activeEvaluations

  const duringRouting = await f.broker.hook({ agent: f.makeAgent('routing-root'), request: hookRequest('blocked-during-routing') })
  const casesDuringRouting = f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n
  const evaluationGate = f.hold(EVALUATOR)
  routingGate.release()
  await evaluationGate.started
  const evaluationSlotCount = f.broker.activeEvaluations

  const duringEvaluation = await f.broker.hook({ agent: f.makeAgent('evaluation-root'), request: hookRequest('blocked-during-evaluation') })
  const casesDuringEvaluation = f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n
  evaluationGate.release()
  const verdict = await automatic
  assert.equal(verdict.why, 'awaiting_user')
  assert.equal(f.broker.activeEvaluations, 0)
  assert.equal(f.broker.autoFlights.size, 0)
  assert.equal(f.broker.routingJobs.size, 0)

  const afterRouting = await f.broker.hook({ agent: f.makeAgent('routing-root'), request: hookRequest('blocked-during-routing') })
  const afterEvaluation = await f.broker.hook({ agent: f.makeAgent('evaluation-root'), request: hookRequest('blocked-during-evaluation') })
  assert.equal(routingSlotCount, 1)
  assert.deepEqual(duringRouting, { kind: 'pass', why: 'bypass' })
  assert.equal(casesDuringRouting, 1)
  assert.equal(evaluationSlotCount, 1, 'the routing permit must be passed to domain evaluation')
  assert.deepEqual(duringEvaluation, { kind: 'pass', why: 'bypass' })
  assert.equal(casesDuringEvaluation, 1)
  assert.equal(afterRouting.why, 'awaiting_user')
  assert.equal(afterEvaluation.why, 'awaiting_user')
  assert.equal(f.broker.activeEvaluations, 0)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 3)
})

test('caller abort and Case cancellation abort routing without a late route or Attempt', async t => {
  const abortedFixture = await fixture(t)
  await abortedFixture.twoCandidates()
  const abortGate = abortedFixture.hold(ROUTER)
  const controller = new AbortController()
  const consulting = abortedFixture.broker.consult({ agent: abortedFixture.agent, args: { question: 'Abort routing?', request_id: 'abort-routing' }, signal: controller.signal })
  const options = await abortGate.started
  controller.abort(new Error('caller cancelled'))
  abortGate.release()
  const consulted = await consulting
  assert.equal(consulted.outcome, 'awaiting_user')
  assert.equal(consulted.reason, 'no_route')
  assert.equal(options.signal.aborted, true)
  assert.equal(abortedFixture.broker.store.db.prepare('SELECT reason FROM route_decisions WHERE case_id=?').get(consulted.caseId).reason, 'failure:aborted')
  assert.equal(counts(abortedFixture, consulted.caseId).attempts, 0)
  assert.equal(abortedFixture.broker.activeEvaluations, 0)
  assert.equal(abortedFixture.broker.routingControllers.size, 0)

  const cancelledFixture = await fixture(t)
  await cancelledFixture.twoCandidates()
  const cancelGate = cancelledFixture.hold(ROUTER)
  const hooked = cancelledFixture.broker.hook({ agent: cancelledFixture.agent, request: hookRequest('cancel-routing') })
  const hookOptions = await cancelGate.started
  const caseId = cancelledFixture.broker.store.db.prepare('SELECT case_id FROM cases').get().case_id
  const cancelled = await cancelledFixture.broker.cancel({ caseId })
  assert.equal(cancelled.closing, 'cancelled')
  cancelGate.release()
  const verdict = await hooked.catch(error => error)
  assert.equal(hookOptions.signal.aborted, true)
  assert.deepEqual(verdict, { kind: 'pass', caseId, why: 'cancelled' })
  assert.deepEqual(counts(cancelledFixture, caseId), { cases: 1, routes: 0, attempts: 0 })
  assert.equal(cancelledFixture.broker.activeEvaluations, 0)
})

test('flush aborts and awaits routing before store close, with no late writes', async t => {
  const f = await fixture(t)
  await f.twoCandidates()
  const gate = f.hold(ROUTER)
  let settled = false
  const consulting = f.broker.consult({ agent: f.agent, args: { question: 'Flush routing?', request_id: 'flush-routing' } })
    .then(value => { settled = true; return value }, error => { settled = true; throw error })
  const options = await gate.started
  const path = f.broker.store.path
  await f.broker.flush()
  if (!settled) {
    gate.release()
    await consulting.catch(() => {})
  }
  assert.equal(settled, true, 'flush must await the aborted routing flight')
  const result = await consulting
  assert.equal(result.outcome, 'awaiting_user')
  assert.equal(result.reason, 'no_route')
  assert.equal(options.signal.aborted, true)
  gate.release()
  await drainMicrotasks()

  const store = openDecisionDatabase(path)
  try {
    const current = store.db.prepare('SELECT state,awaiting_reason,agent_id FROM cases').get()
    assert.deepEqual({ ...current }, { state: 'awaiting_user', awaiting_reason: 'no_route', agent_id: null })
    assert.equal(store.db.prepare('SELECT reason FROM route_decisions').get().reason, 'failure:aborted')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n, 1)
  } finally {
    store.close()
  }
  assert.equal(f.broker.autoFlights.size, 0)
  assert.equal(f.broker.routingControllers.size, 0)
  assert.equal(f.broker.routingJobs.size, 0)
  assert.equal(f.broker.activeEvaluations, 0)
})

test('post-failure replay never fabricates a persisted Auto waiting state', async t => {
  const hookedFixture = await fixture(t)
  await hookedFixture.twoCandidates()
  const hookCommit = hookedFixture.broker.cases.transitionWithRoute.bind(hookedFixture.broker.cases)
  let failHookCommit = true
  hookedFixture.broker.cases.transitionWithRoute = async (...args) => {
    if (failHookCommit) throw new Error('Hook route store failed')
    return hookCommit(...args)
  }
  const request = hookRequest('failed-commit-replay')
  await assert.rejects(hookedFixture.broker.hook({ agent: hookedFixture.agent, request }), /Hook route store failed/)
  failHookCommit = false
  assert.deepEqual(await hookedFixture.broker.hook({ agent: hookedFixture.agent, request }), { kind: 'pass', why: 'bypass' })
  assert.equal(callsOf(hookedFixture, ROUTER).length, 1)
  assert.equal(hookedFixture.broker.store.db.prepare('SELECT state FROM cases').get().state, 'received')
  assert.equal(hookedFixture.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n, 0)
  assert.equal(hookedFixture.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0)

  const consultedFixture = await fixture(t)
  await consultedFixture.twoCandidates()
  const consultCommit = consultedFixture.broker.cases.transitionWithRoute.bind(consultedFixture.broker.cases)
  let failConsultCommit = true
  consultedFixture.broker.cases.transitionWithRoute = async (...args) => {
    if (failConsultCommit) throw new Error('consult route store failed')
    return consultCommit(...args)
  }
  const args = { question: 'Do not fake a waiting Case?', request_id: 'failed-commit-replay' }
  await assert.rejects(consultedFixture.broker.consult({ agent: consultedFixture.agent, args }), /consult route store failed/)
  failConsultCommit = false
  await assert.rejects(consultedFixture.broker.consult({ agent: consultedFixture.agent, args }), error => error.code === 'DECISION_UNAVAILABLE')
  assert.equal(consultedFixture.broker.store.db.prepare('SELECT state FROM cases').get().state, 'received')
  assert.equal(consultedFixture.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n, 0)
  assert.equal(consultedFixture.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0)
})
