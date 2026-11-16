import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

const ROUTER = 'router-contract/1'
const EVALUATOR = 'Decision evaluator contract'

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-auto-'))
  const workspace = realpathSync(dir)
  const config = {
    decisionAgentsEnabled: true,
    decisionAgentAutoAnswer: false,
    decisionAgentAnswerTimeoutMs: 1000,
    decisionAgentMaxOutputTokens: 1600,
    decisionAgentContextBudgetTokens: 24000,
    ...overrides,
  }
  const calls = []
  let routing = { contract: ROUTER, outcome: 'none', reason: 'No matching Agent' }
  let evaluation = { outcome: 'escalate', missing: ['A new judgment is required'] }
  const ctx = {
    llm: {
      stream(options) {
        calls.push(options)
        return (async function * () {
          const output = options.system.includes(ROUTER) ? routing : evaluation
          yield { type: 'text-delta', text: typeof output === 'string' ? output : JSON.stringify(output) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => config })
  await broker.start()
  await broker.setSelector('root', 'auto')
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  ctx.agents = { get: id => id === 'root' ? agent : undefined }
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return {
    broker, agent, workspace, config, calls,
    routeWith(value) { routing = value },
    respond(value) { evaluation = value },
  }
}

function hookRequest(id = 'q', text = `Choose ${id}?`) {
  return { questions: [{ id, question: text, options: [{ label: 'A' }, { label: 'B' }] }] }
}

function routeFor(f, caseId) {
  return f.broker.store.db.prepare('SELECT * FROM route_decisions WHERE case_id=?').get(caseId)
}

function attemptCount(f) {
  return f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n
}

function routerCalls(f) {
  return f.calls.filter(call => call.system.includes(ROUTER))
}

function evaluatorCalls(f) {
  return f.calls.filter(call => call.system.includes(EVALUATOR))
}

test('the answer switch off still routes and parks an owned authority pending that accumulates evidence', async t => {
  const f = await fixture(t)
  const only = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Only' })
  let evaluations = 0
  f.broker.evaluateCase = (...args) => { evaluations++; throw new Error('domain evaluation must not run') }
  const request = hookRequest('answer-off')
  const snapshot = structuredClone(request)

  const hooked = await f.broker.hook({ agent: f.agent, request })
  assert.equal(hooked.why, 'awaiting_user')
  const hookedCase = f.broker.cases.getCase(hooked.caseId)
  assert.equal(hookedCase.agentId, only.agentId)
  assert.equal(hookedCase.awaitingReason, 'authority')
  const hookedRoute = routeFor(f, hooked.caseId)
  assert.equal(hookedRoute.mode, 'auto')
  assert.equal(hookedRoute.chosen, only.agentId)
  assert.equal(hookedRoute.reason, 'deterministic:single_candidate')
  assert.deepEqual(request, snapshot)
  assert.equal(evaluations, 0)
  assert.equal(attemptCount(f), 0)
  assert.equal(f.calls.length, 0)

  const args = { question: 'Consult with the answer switch off?', request_id: 'answer-off' }
  const consulted = await f.broker.consult({ agent: f.agent, args })
  assert.deepEqual(consulted, { outcome: 'awaiting_user', caseId: consulted.caseId, state: 'awaiting_user', reason: 'authority' })
  assert.equal(f.broker.cases.getCase(consulted.caseId).agentId, only.agentId)
  assert.equal(routeFor(f, consulted.caseId).chosen, only.agentId)

  assert.deepEqual(await f.broker.hook({ agent: f.agent, request }), hooked)
  assert.deepEqual(await f.broker.consult({ agent: f.agent, args }), consulted)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 2)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n, 2)

  // The flywheel: the user's ruling on the owned pending writes user_decision evidence.
  const closed = await f.broker.decide({ caseId: hooked.caseId, answers: [{ id: 'answer-off', selected: ['A'] }] })
  assert.equal(closed.state, 'closed')
  assert.equal(closed.closing, 'escalated')
  const evidence = f.broker.store.db.prepare("SELECT * FROM evidence WHERE agent_id=? AND source='user_decision'").all(only.agentId)
  assert.equal(evidence.length, 1)
})

test('with the answer switch on the routed conclusion is evaluated and may be adopted', async t => {
  const f = await fixture(t, { decisionAgentAutoAnswer: true })
  const only = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Only' })
  const evidence = await f.broker.ensureProfileEvidence(only, f.workspace)
  f.respond({
    outcome: 'answer',
    claims: [{ text: 'The user-written preference supports A', evidenceIds: [evidence.evidenceId] }],
    answers: [{ id: 'answer-on', selected: ['A'] }],
  })
  const verdict = await f.broker.hook({ agent: f.agent, request: hookRequest('answer-on') })
  assert.equal(verdict.kind, 'answer')
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.closing, 'answered')
  assert.equal(current.agentId, only.agentId)
  assert.equal(current.attemptCount, 1)
  assert.equal(routeFor(f, verdict.caseId).reason, 'deterministic:single_candidate')
  assert.equal(attemptCount(f), 1)
})

test('the deterministic exclusion stays the only authority boundary for both entries', async t => {
  const f = await fixture(t)
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Only' })
  // Hook: intent exclusion bypasses the whole decision path.
  const intentHook = hookRequest('native-approval')
  intentHook.questions[0].intent = { kind: 'approval' }
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: intentHook }), { kind: 'pass', why: 'bypass' })
  // Hook: text exclusion also bypasses.
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: hookRequest('native-exec', 'Delete this file and run command?') }), { kind: 'pass', why: 'bypass' })
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 0)

  // Consult: the same characteristics park an authority Case before routing.
  for (const [requestId, text] of [['consult-approval', 'Approve this release?'], ['consult-delete', 'Delete this file after review?']]) {
    const result = await f.broker.consult({ agent: f.agent, args: { question: text, request_id: requestId } })
    assert.equal(result.outcome, 'awaiting_user')
    assert.equal(result.reason, 'authority')
    assert.equal(routeFor(f, result.caseId).mode, 'auto')
    assert.equal(routeFor(f, result.caseId).reason, 'admission:authority')
  }
  assert.equal(f.calls.length, 0)
  assert.equal(attemptCount(f), 0)
})

test('zero candidates route nowhere without a model call', async t => {
  const f = await fixture(t, { decisionAgentAutoAnswer: true })
  const none = await f.broker.consult({ agent: f.agent, args: { question: 'No candidate?', request_id: 'zero-candidates' } })
  assert.equal(none.outcome, 'awaiting_user')
  assert.equal(none.reason, 'no_route')
  assert.equal(routeFor(f, none.caseId).reason, 'none:no_candidates')
  assert.equal(f.calls.length, 0)
  assert.equal(attemptCount(f), 0)
})

test('a single eligible candidate is deterministic and the Hook still hands back the native question', async t => {
  const f = await fixture(t)
  const only = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Only' })
  const request = hookRequest('single-candidate')
  const snapshot = structuredClone(request)
  const verdict = await f.broker.hook({ agent: f.agent, request })
  const current = f.broker.cases.getCase(verdict.caseId)
  const route = routeFor(f, verdict.caseId)
  assert.equal(current.agentId, only.agentId)
  // No classifier ran and no derived class field was appended.
  assert.deepEqual(current.request, { entry: 'hook', questions: snapshot.questions })
  assert.equal(route.mode, 'auto')
  assert.equal(route.chosen, only.agentId)
  assert.equal(route.reason, 'deterministic:single_candidate')
  assert.deepEqual(request, snapshot)
  assert.equal(f.calls.length, 0)
  assert.equal(attemptCount(f), 0)
})

test('multiple eligible candidates come from the whole profile and the selected Agent owns the domain Attempt', async t => {
  const f = await fixture(t, { decisionAgentAutoAnswer: true })
  const a = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'A' })
  const b = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'B' })
  const disabled = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Disabled' })
  await f.broker.profileSetState(disabled.agentId, 'disabled')
  const narrow = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Narrow', scope: { workspaces: [f.workspace], paths: ['src'] } })
  const archived = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Archived' })
  await f.broker.profileSetState(archived.agentId, 'archived')
  // A legacy class scope is inert: it neither filters nor rejects the candidate.
  const legacy = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Legacy classes', scope: { workspaces: [f.workspace], authorizationClasses: ['B'] } })
  // Identity is profile-global: an assistant created elsewhere is a real
  // candidate here, unlike archived/disabled/scope-rejected ones.
  const foreign = await f.broker.profileUpsert({ workspaceKey: '/other-workspace', name: 'Foreign' })
  f.routeWith({ contract: ROUTER, outcome: 'selected', agentId: b.agentId, reason: 'B owns this judgment' })

  const result = await f.broker.consult({ agent: f.agent, args: { question: 'Choose the current owner?', request_id: 'multiple-candidates' } })
  const current = f.broker.cases.getCase(result.caseId)
  const route = routeFor(f, result.caseId)
  const routerCalls = f.calls.filter(call => call.system.includes(ROUTER))
  assert.equal(routerCalls.length, 1)
  const pack = JSON.parse(routerCalls[0].messages[0].content[0].text)
  assert.deepEqual(pack.candidates.map(candidate => candidate.agentId), [a.agentId, b.agentId, foreign.agentId, legacy.agentId].sort())
  const stored = JSON.parse(route.candidates_json)
  assert.equal(stored.some(candidate => candidate.agentId === archived.agentId), false)
  assert.equal(stored.find(candidate => candidate.agentId === foreign.agentId).rejectedBecause, undefined)
  assert.equal(stored.find(candidate => candidate.agentId === legacy.agentId).rejectedBecause, undefined)
  // The Router pack carries identity metadata only: no workspace, memory or records.
  assert.deepEqual(Object.keys(pack.candidates[0]).sort(), ['agentId', 'name', 'scope', 'userDescription'])
  assert.deepEqual(Object.keys(pack.candidates[0].scope).sort(), [])
  assert.equal(stored.find(candidate => candidate.agentId === disabled.agentId).rejectedBecause, 'disabled')
  assert.equal(stored.find(candidate => candidate.agentId === narrow.agentId).rejectedBecause, 'scope')
  assert.equal(route.mode, 'auto')
  assert.equal(route.chosen, b.agentId)
  assert.equal(current.agentId, b.agentId)
  assert.equal(f.broker.attempts.forCase(result.caseId).length, 1)
  assert.equal(f.broker.attempts.forCase(result.caseId)[0].agentId, b.agentId)
  assert.equal(routerCalls.length, 1)
})

test('Auto route commit failure never enters domain evaluation', async t => {
  const f = await fixture(t)
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Only' })
  f.broker.cases.transitionWithRoute = async () => { throw new Error('route commit failed') }
  let evaluations = 0
  f.broker.evaluateCase = () => { evaluations++; throw new Error('domain evaluation must not run') }
  const request = hookRequest('commit-failure')
  await assert.rejects(f.broker.hook({ agent: f.agent, request }), /route commit failed/)
  const current = f.broker.cases.byIdempotencyKey(f.broker.store.db.prepare('SELECT idempotency_key FROM cases').get().idempotency_key)
  assert.equal(current.state, 'received')
  assert.equal(current.agentId, null)
  assert.equal(evaluations, 0)
  assert.equal(attemptCount(f), 0)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n, 0)
})

test('Auto revalidates a model-selected target after model return and before any Attempt', async t => {
  const f = await fixture(t)
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'A' })
  const selected = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'B' })
  f.routeWith({ contract: ROUTER, outcome: 'selected', agentId: selected.agentId, reason: 'Selected before disable' })
  const stream = f.broker.ctx.llm.stream
  f.broker.ctx.llm.stream = options => {
    if (!options.system.includes(ROUTER)) return stream(options)
    return (async function * () {
      await f.broker.profileSetState(selected.agentId, 'disabled')
      yield * stream(options)
    })()
  }
  let evaluations = 0
  f.broker.evaluateCase = () => { evaluations++; throw new Error('stale target must not evaluate') }
  const request = hookRequest('stale-selected-target')
  const snapshot = structuredClone(request)
  const verdict = await f.broker.hook({ agent: f.agent, request })
  const current = f.broker.cases.getCase(verdict.caseId)
  const route = routeFor(f, verdict.caseId)
  assert.equal(verdict.why, 'awaiting_user')
  assert.equal(current.state, 'awaiting_user')
  assert.equal(current.awaitingReason, 'no_route')
  assert.equal(current.agentId, null)
  assert.equal(route.chosen, null)
  assert.equal(route.reason, 'none:no_candidates')
  assert.equal(evaluations, 0)
  assert.equal(attemptCount(f), 0)
  assert.deepEqual(request, snapshot)
})

test('Auto ambiguity, invalid output, and timeout persist fail-closed outcomes without partial Attempts', async t => {
  const ambiguousFixture = await fixture(t, { decisionAgentAutoAnswer: true })
  const a = await ambiguousFixture.broker.profileUpsert({ workspaceKey: ambiguousFixture.workspace, name: 'A' })
  const b = await ambiguousFixture.broker.profileUpsert({ workspaceKey: ambiguousFixture.workspace, name: 'B' })
  ambiguousFixture.routeWith({
    contract: ROUTER, outcome: 'ambiguous', reason: 'Both scopes overlap',
    ambiguity: { candidates: [a.agentId, b.agentId], conflict: 'Both claim the same product decision' },
  })
  const ambiguous = await ambiguousFixture.broker.hook({ agent: ambiguousFixture.agent, request: hookRequest('ambiguous-a') })
  const ambiguousCase = ambiguousFixture.broker.cases.getCase(ambiguous.caseId)
  assert.equal(ambiguous.kind, 'pass')
  assert.equal(ambiguous.why, 'awaiting_user')
  assert.equal(ambiguousCase.awaitingReason, 'route_ambiguous')
  assert.equal(ambiguousCase.agentId, null)
  assert.equal(routeFor(ambiguousFixture, ambiguous.caseId).reason, 'Both scopes overlap')
  assert.equal(attemptCount(ambiguousFixture), 0)

  const invalidFixture = await fixture(t, { decisionAgentAutoAnswer: true })
  await invalidFixture.broker.profileUpsert({ workspaceKey: invalidFixture.workspace, name: 'A' })
  await invalidFixture.broker.profileUpsert({ workspaceKey: invalidFixture.workspace, name: 'B' })
  invalidFixture.routeWith({ contract: ROUTER, outcome: 'selected', agentId: 'not-a-candidate', reason: 'Unknown Agent' })
  const invalid = await invalidFixture.broker.consult({ agent: invalidFixture.agent, args: { question: 'Reject an unknown route?', request_id: 'invalid-route-output' } })
  assert.equal(invalid.outcome, 'awaiting_user')
  assert.equal(invalid.reason, 'no_route')
  assert.equal(routeFor(invalidFixture, invalid.caseId).reason, 'failure:invalid_output')
  // An out-of-set Agent is repaired once, then fails closed.
  assert.equal(routerCalls(invalidFixture).length, 2)
  assert.equal(invalidFixture.broker.cases.getCase(invalid.caseId).agentId, null)
  assert.equal(attemptCount(invalidFixture), 0)

  const timeoutFixture = await fixture(t, { decisionAgentAutoAnswer: true })
  await timeoutFixture.broker.profileUpsert({ workspaceKey: timeoutFixture.workspace, name: 'A' })
  await timeoutFixture.broker.profileUpsert({ workspaceKey: timeoutFixture.workspace, name: 'B' })
  timeoutFixture.config.decisionAgentAnswerTimeoutMs = 5
  const stream = timeoutFixture.broker.ctx.llm.stream
  timeoutFixture.broker.ctx.llm.stream = options => options.system.includes(ROUTER)
    ? (async function * () { await new Promise(() => {}) })()
    : stream(options)
  const timedOut = await timeoutFixture.broker.consult({ agent: timeoutFixture.agent, args: { question: 'Bound a Router timeout?', request_id: 'route-timeout' } })
  assert.equal(timedOut.outcome, 'awaiting_user')
  assert.equal(timedOut.reason, 'no_route')
  assert.equal(routeFor(timeoutFixture, timedOut.caseId).reason, 'failure:timeout')
  assert.equal(attemptCount(timeoutFixture), 0)
})

test('a truncated Auto sidecar retries once, then fails closed with its reason and output tokens on record', async t => {
  const retried = await fixture(t, { decisionAgentAutoAnswer: true })
  await retried.broker.profileUpsert({ workspaceKey: retried.workspace, name: 'A' })
  await retried.broker.profileUpsert({ workspaceKey: retried.workspace, name: 'B' })
  const retriedCalls = []
  retried.broker.ctx.llm.stream = options => {
    retriedCalls.push(options)
    return (async function * () {
      if (retriedCalls.length === 1) {
        yield { type: 'text-delta', text: `{"contract":"${ROUTER}","outcome":"none"` }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'text-delta', text: JSON.stringify({ contract: ROUTER, outcome: 'none', reason: 'No match' }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  const recovered = await retried.broker.hook({ agent: retried.agent, request: hookRequest('truncated-retry') })
  assert.equal(retried.broker.cases.getCase(recovered.caseId).awaitingReason, 'no_route')
  assert.equal(routeFor(retried, recovered.caseId).reason, 'No match')
  // The truncated verdict retried once with the doubled sidecar budget, never
  // the 1600-token Attempt budget.
  assert.deepEqual(retriedCalls.map(call => call.maxTokens), [4096, 8192])
  assert.equal(attemptCount(retried), 0)

  const failed = await fixture(t, { decisionAgentAutoAnswer: true })
  await failed.broker.profileUpsert({ workspaceKey: failed.workspace, name: 'A' })
  await failed.broker.profileUpsert({ workspaceKey: failed.workspace, name: 'B' })
  const audited = []
  failed.broker.audit = (kind, value) => audited.push({ kind, value })
  const truncatedCalls = []
  failed.broker.ctx.llm.stream = options => {
    truncatedCalls.push(options)
    return (async function * () {
      yield { type: 'usage', usage: { outputTokens: 4096 } }
      yield { type: 'text-delta', text: `{"contract":"${ROUTER}","outcome":"none"` }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })()
  }
  const result = await failed.broker.hook({ agent: failed.agent, request: hookRequest('twice-truncated') })
  assert.equal(result.why, 'awaiting_user')
  const current = failed.broker.cases.getCase(result.caseId)
  assert.equal(current.awaitingReason, 'no_route')
  assert.equal(current.agentId, null)
  assert.equal(routeFor(failed, result.caseId).reason, 'failure:truncated')
  assert.deepEqual(truncatedCalls.map(call => call.maxTokens), [4096, 8192])
  assert.equal(attemptCount(failed), 0)
  // The bounded audit record carries the root session, the finish reason, the
  // closed invalid sub-reason and the output count — never a question body.
  const failureAudit = audited.filter(event => event.kind === 'case-open' && event.value.outcome === 'no_route')
  assert.deepEqual(failureAudit.map(event => event.value), [
    {
      caseId: result.caseId, rootSessionId: 'root', entry: 'hook', outcome: 'no_route',
      reason: 'failure:truncated', invalidCode: 'truncated', outputTokens: 4096,
    },
  ])
})

test('an unusable Router verdict earns exactly one repair, then fails closed with its invalidCode', async t => {
  const f = await fixture(t, { decisionAgentAutoAnswer: true })
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'A' })
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'B' })
  const audited = []
  f.broker.audit = (kind, value) => audited.push({ kind, value })
  const replies = [
    'I would route this to the first assistant.',
    '{"contract":"router-contract/1","outcome":"selected","agentId":"ag_not_a_candidate","reason":"Unknown"}',
  ]
  const calls = []
  f.broker.ctx.llm.stream = options => {
    calls.push(options)
    const reply = replies[calls.length - 1]
    if (!reply) throw new Error('unexpected Router call')
    return (async function * () {
      yield { type: 'usage', usage: { outputTokens: 120 } }
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  const result = await f.broker.hook({ agent: f.agent, request: hookRequest('repaired-verdict') })
  assert.equal(result.why, 'awaiting_user')
  assert.equal(calls.length, 2)
  // The repair is the same pack plus one explicit verdict-JSON-only instruction.
  assert.equal(calls[1].messages.length, calls[0].messages.length + 1)
  assert.match(calls[1].messages.at(-1).content[0].text, /^Return only the verdict JSON object\./)
  assert.deepEqual(calls.map(call => call.maxTokens), [4096, 4096])
  assert.equal(f.broker.cases.getCase(result.caseId).awaitingReason, 'no_route')
  assert.equal(routeFor(f, result.caseId).reason, 'failure:invalid_output')
  const failureAudit = audited.filter(event => event.kind === 'case-open' && event.value.outcome === 'no_route')
  assert.deepEqual(failureAudit.map(event => event.value), [
    {
      caseId: result.caseId, rootSessionId: 'root', entry: 'hook', outcome: 'no_route',
      reason: 'failure:invalid_output', invalidCode: 'unknown_agent', outputTokens: 120,
    },
  ])
  assert.equal(attemptCount(f), 0)
})

test('Auto consult commit failure stays an explicit storage failure without recovery or an Attempt', async t => {
  const f = await fixture(t)
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Only' })
  f.broker.cases.transitionWithRoute = async () => { throw new Error('consult route commit failed') }
  let evaluations = 0
  let recoveries = 0
  f.broker.evaluateCase = () => { evaluations++; throw new Error('domain evaluation must not run') }
  f.broker.recoverUnexpected = () => { recoveries++; throw new Error('route failures must not enter domain recovery') }
  const args = { question: 'Persist the route before evaluation?', request_id: 'consult-commit-failure' }
  await assert.rejects(f.broker.consult({ agent: f.agent, args }), /consult route commit failed/)
  const current = f.broker.cases.byIdempotencyKey('consult:root:consult-commit-failure')
  assert.equal(current.state, 'received')
  assert.equal(current.agentId, null)
  assert.equal(evaluations, 0)
  assert.equal(recoveries, 0)
  assert.equal(attemptCount(f), 0)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n, 0)
})
