import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-auto-'))
  const workspace = realpathSync(dir)
  const config = {
    decisionAgentsEnabled: true,
    decisionAgentAutoAnswerClasses: ['A', 'B', 'C'],
    decisionAgentAnswerTimeoutMs: 1000,
    decisionAgentMaxOutputTokens: 1600,
    decisionAgentContextBudgetTokens: 24000,
  }
  const calls = []
  let classification = { contract: 'router-classification-contract/1', classes: [] }
  let classificationError
  let routing = { contract: 'router-contract/1', outcome: 'none', reason: 'No matching Agent' }
  const ctx = {
    llm: {
      stream(options) {
        calls.push(options)
        return (async function * () {
          let output
          if (options.system.includes('router-classification-contract/1')) {
            if (classificationError) throw classificationError
            output = classification
          } else if (options.system.includes('router-contract/1')) {
            output = routing
          } else {
            output = { outcome: 'escalate', missing: ['A new judgment is required'] }
          }
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
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return {
    broker, agent, workspace, config, calls,
    classifyWith(value) { classification = value },
    failClassification(error) { classificationError = error },
    routeWith(value) { routing = value },
  }
}

function hookRequest(id = 'q', text = `Choose ${id}?`) {
  return { questions: [{ id, question: text, options: [{ label: 'A' }, { label: 'B' }] }] }
}

function callsOf(f, contract) {
  return f.calls.filter(call => call.system.includes(contract))
}

function routeFor(f, caseId) {
  return f.broker.store.db.prepare('SELECT * FROM route_decisions WHERE case_id=?').get(caseId)
}

function attemptCount(f) {
  return f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n
}

test('empty Auto whitelist short-circuits both entries and settled replay stays idempotent', async t => {
  const f = await fixture(t)
  f.config.decisionAgentAutoAnswerClasses = []
  let profileReads = 0
  let evaluations = 0
  const listProfiles = f.broker.profiles.listProfiles.bind(f.broker.profiles)
  f.broker.profiles.listProfiles = (...args) => { profileReads++; return listProfiles(...args) }
  f.broker.evaluateCase = (...args) => { evaluations++; throw new Error('domain evaluation must not run') }
  const request = hookRequest('empty-whitelist')
  const snapshot = structuredClone(request)

  const hooked = await f.broker.hook({ agent: f.agent, request })
  assert.equal(hooked.why, 'awaiting_user')
  const hookedCase = f.broker.cases.getCase(hooked.caseId)
  assert.equal(hookedCase.agentId, null)
  assert.equal(hookedCase.awaitingReason, 'authority')
  assert.equal(routeFor(f, hooked.caseId).mode, 'auto')
  assert.equal(routeFor(f, hooked.caseId).reason, 'admission:authority')
  assert.deepEqual(request, snapshot)

  const args = { question: 'Consult with an empty whitelist?', request_id: 'empty-whitelist' }
  const consulted = await f.broker.consult({ agent: f.agent, args })
  assert.deepEqual(consulted, { outcome: 'awaiting_user', caseId: consulted.caseId, state: 'awaiting_user', reason: 'authority' })
  assert.equal(f.broker.cases.getCase(consulted.caseId).agentId, null)
  assert.equal(routeFor(f, consulted.caseId).reason, 'admission:authority')

  assert.deepEqual(await f.broker.hook({ agent: f.agent, request }), hooked)
  assert.deepEqual(await f.broker.consult({ agent: f.agent, args }), consulted)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 2)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n, 2)
  assert.equal(profileReads, 0)
  assert.equal(evaluations, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(attemptCount(f), 0)
})

test('supplied invalid classes fail closed and Hook exclusion precedes Case while consult authority follows it', async t => {
  const f = await fixture(t)
  const excludedHook = hookRequest('native-d')
  excludedHook.questions[0].authorizationClass = 'D'
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: excludedHook }), { kind: 'pass', why: 'bypass' })
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 0)

  const invalidHook = hookRequest('invalid-g')
  invalidHook.questions[0].authorizationClass = 'G'
  const hooked = await f.broker.hook({ agent: f.agent, request: invalidHook })
  assert.equal(f.broker.cases.getCase(hooked.caseId).awaitingReason, 'authority')
  assert.equal(routeFor(f, hooked.caseId).reason, 'admission:authority')

  for (const [requestId, authorization_class] of [['consult-d', 'D'], ['consult-g', 'G']]) {
    const result = await f.broker.consult({ agent: f.agent, args: { question: `Authority ${requestId}?`, authorization_class, request_id: requestId } })
    assert.equal(result.outcome, 'awaiting_user')
    assert.equal(result.reason, 'authority')
    assert.equal(routeFor(f, result.caseId).mode, 'auto')
    assert.equal(routeFor(f, result.caseId).reason, 'admission:authority')
  }
  assert.equal(f.calls.length, 0)
  assert.equal(attemptCount(f), 0)
})

test('classifier unknown, D/E/F, unallowed, and mixed-batch classes become authority without candidate routing', async t => {
  const f = await fixture(t)
  for (const authorizationClass of ['unknown', 'D', 'E', 'F']) {
    const id = `classified-${authorizationClass}`
    const request = hookRequest(id)
    const snapshot = structuredClone(request)
    f.classifyWith({ contract: 'router-classification-contract/1', classes: [{ id, authorizationClass }] })
    const result = await f.broker.hook({ agent: f.agent, request })
    const current = f.broker.cases.getCase(result.caseId)
    assert.equal(current.awaitingReason, 'authority')
    assert.equal(current.request.questions[0].authorizationClass, authorizationClass)
    assert.equal(current.request.questions[0].authorizationClassSource, 'auto_classifier')
    assert.equal(routeFor(f, result.caseId).reason, 'admission:authority')
    assert.deepEqual(request, snapshot)
  }

  const mixed = {
    questions: [
      { ...hookRequest('mixed-provided').questions[0], authorizationClass: 'A' },
      ...hookRequest('mixed-missing').questions,
    ],
  }
  const mixedSnapshot = structuredClone(mixed)
  f.classifyWith({ contract: 'router-classification-contract/1', classes: [{ id: 'mixed-missing', authorizationClass: 'D' }] })
  const mixedResult = await f.broker.hook({ agent: f.agent, request: mixed })
  const mixedCase = f.broker.cases.getCase(mixedResult.caseId)
  assert.equal(mixedCase.awaitingReason, 'authority')
  assert.equal(mixedCase.request.questions[0].authorizationClassSource, undefined)
  assert.equal(mixedCase.request.questions[1].authorizationClassSource, 'auto_classifier')
  assert.deepEqual(mixed, mixedSnapshot)

  f.config.decisionAgentAutoAnswerClasses = ['A']
  const unallowed = hookRequest('unallowed-c')
  f.classifyWith({ contract: 'router-classification-contract/1', classes: [{ id: 'unallowed-c', authorizationClass: 'C' }] })
  const unallowedResult = await f.broker.hook({ agent: f.agent, request: unallowed })
  assert.equal(f.broker.cases.getCase(unallowedResult.caseId).awaitingReason, 'authority')
  assert.equal(callsOf(f, 'router-contract/1').length, 0)
  assert.equal(callsOf(f, 'router-classification-contract/1').length, 6)
  assert.equal(attemptCount(f), 0)
})

test('classifier invalid output and runtime errors persist no-route without domain Attempts', async t => {
  const f = await fixture(t)
  let evaluations = 0
  f.broker.evaluateCase = () => { evaluations++; throw new Error('domain evaluation must not run') }

  f.classifyWith('not-json')
  const invalid = await f.broker.hook({ agent: f.agent, request: hookRequest('invalid-classification') })
  assert.equal(f.broker.cases.getCase(invalid.caseId).awaitingReason, 'no_route')
  assert.equal(routeFor(f, invalid.caseId).reason, 'failure:invalid_output')

  f.failClassification(Object.assign(new Error('upstream failed'), { code: 'UPSTREAM_429' }))
  const failed = await f.broker.hook({ agent: f.agent, request: hookRequest('failed-classification') })
  assert.equal(f.broker.cases.getCase(failed.caseId).awaitingReason, 'no_route')
  assert.equal(routeFor(f, failed.caseId).reason, 'failure:model_error')
  assert.equal(evaluations, 0)
  assert.equal(attemptCount(f), 0)
})

test('zero candidates avoid models and one stock-Hook candidate uses classification then deterministic selection', async t => {
  const f = await fixture(t)
  const none = await f.broker.consult({ agent: f.agent, args: { question: 'No candidate?', authorization_class: 'A', request_id: 'zero-candidates' } })
  assert.equal(none.outcome, 'awaiting_user')
  assert.equal(none.reason, 'no_route')
  assert.equal(routeFor(f, none.caseId).reason, 'none:no_candidates')
  assert.equal(f.calls.length, 0)
  assert.equal(attemptCount(f), 0)

  const only = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Only' })
  const request = hookRequest('single-candidate')
  const snapshot = structuredClone(request)
  f.classifyWith({ contract: 'router-classification-contract/1', classes: [{ id: 'single-candidate', authorizationClass: 'A' }] })
  const selected = await f.broker.hook({ agent: f.agent, request })
  const current = f.broker.cases.getCase(selected.caseId)
  const route = routeFor(f, selected.caseId)
  assert.equal(current.agentId, only.agentId)
  assert.equal(current.request.questions[0].authorizationClass, 'A')
  assert.equal(current.request.questions[0].authorizationClassSource, 'auto_classifier')
  assert.equal(route.mode, 'auto')
  assert.equal(route.chosen, only.agentId)
  assert.equal(route.reason, 'deterministic:single_candidate')
  assert.deepEqual(request, snapshot)
  assert.equal(callsOf(f, 'router-classification-contract/1').length, 1)
  assert.equal(callsOf(f, 'router-contract/1').length, 0)
  assert.equal(attemptCount(f), 1)
})

test('multiple eligible candidates come from the whole profile and the selected Agent owns the domain Attempt', async t => {
  const f = await fixture(t)
  const a = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'A' })
  const b = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'B' })
  const disabled = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Disabled' })
  await f.broker.profileSetState(disabled.agentId, 'disabled')
  const narrow = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Narrow', scope: { workspaces: [f.workspace], paths: ['src'], authorizationClasses: ['A'] } })
  const wrongClass = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Wrong class', scope: { workspaces: [f.workspace], authorizationClasses: ['B'] } })
  const archived = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Archived' })
  await f.broker.profileSetState(archived.agentId, 'archived')
  // Identity is profile-global: an assistant created elsewhere is a real
  // candidate here, unlike archived/disabled/scope-rejected ones.
  const foreign = await f.broker.profileUpsert({ workspaceKey: '/other-workspace', name: 'Foreign' })
  f.routeWith({ contract: 'router-contract/1', outcome: 'selected', agentId: b.agentId, reason: 'B owns this judgment' })

  const result = await f.broker.consult({ agent: f.agent, args: { question: 'Choose the current owner?', authorization_class: 'A', request_id: 'multiple-candidates' } })
  const current = f.broker.cases.getCase(result.caseId)
  const route = routeFor(f, result.caseId)
  const routerCalls = callsOf(f, 'router-contract/1')
  assert.equal(routerCalls.length, 1)
  const pack = JSON.parse(routerCalls[0].messages[0].content[0].text)
  assert.deepEqual(pack.candidates.map(candidate => candidate.agentId), [a.agentId, b.agentId, foreign.agentId].sort())
  const stored = JSON.parse(route.candidates_json)
  assert.equal(stored.some(candidate => candidate.agentId === archived.agentId), false)
  assert.equal(stored.find(candidate => candidate.agentId === foreign.agentId).rejectedBecause, undefined)
  // The Router pack carries identity metadata only: no workspace, memory or records.
  assert.deepEqual(Object.keys(pack.candidates[0]).sort(), ['agentId', 'name', 'scope', 'userDescription'])
  assert.deepEqual(Object.keys(pack.candidates[0].scope).sort(), ['authorizationClasses'])
  assert.equal(stored.find(candidate => candidate.agentId === disabled.agentId).rejectedBecause, 'disabled')
  assert.equal(stored.find(candidate => candidate.agentId === narrow.agentId).rejectedBecause, 'scope')
  assert.equal(stored.find(candidate => candidate.agentId === wrongClass.agentId).rejectedBecause, 'authorization')
  assert.equal(route.mode, 'auto')
  assert.equal(route.chosen, b.agentId)
  assert.equal(current.agentId, b.agentId)
  assert.equal(f.broker.attempts.forCase(result.caseId).length, 1)
  assert.equal(f.broker.attempts.forCase(result.caseId)[0].agentId, b.agentId)
  assert.equal(callsOf(f, 'router-classification-contract/1').length, 0)
})

test('Auto route commit failure never enters domain evaluation', async t => {
  const f = await fixture(t)
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Only' })
  f.classifyWith({ contract: 'router-classification-contract/1', classes: [{ id: 'commit-failure', authorizationClass: 'A' }] })
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
  f.routeWith({ contract: 'router-contract/1', outcome: 'selected', agentId: selected.agentId, reason: 'Selected before disable' })
  const stream = f.broker.ctx.llm.stream
  f.broker.ctx.llm.stream = options => {
    if (!options.system.includes('router-contract/1')) return stream(options)
    return (async function * () {
      await f.broker.profileSetState(selected.agentId, 'disabled')
      yield * stream(options)
    })()
  }
  let evaluations = 0
  f.broker.evaluateCase = () => { evaluations++; throw new Error('stale target must not evaluate') }
  const request = hookRequest('stale-selected-target')
  request.questions[0].authorizationClass = 'A'
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
  const ambiguousFixture = await fixture(t)
  const a = await ambiguousFixture.broker.profileUpsert({ workspaceKey: ambiguousFixture.workspace, name: 'A' })
  const b = await ambiguousFixture.broker.profileUpsert({ workspaceKey: ambiguousFixture.workspace, name: 'B' })
  ambiguousFixture.routeWith({
    contract: 'router-contract/1', outcome: 'ambiguous', reason: 'Both scopes overlap',
    ambiguity: { candidates: [a.agentId, b.agentId], conflict: 'Both claim the same product decision' },
  })
  const batch = {
    questions: [
      { ...hookRequest('ambiguous-a').questions[0], authorizationClass: 'A' },
      { ...hookRequest('ambiguous-b').questions[0], authorizationClass: 'A' },
    ],
  }
  const ambiguous = await ambiguousFixture.broker.hook({ agent: ambiguousFixture.agent, request: batch })
  const ambiguousCase = ambiguousFixture.broker.cases.getCase(ambiguous.caseId)
  assert.equal(ambiguous.kind, 'pass')
  assert.equal(ambiguous.why, 'awaiting_user')
  assert.equal(ambiguousCase.awaitingReason, 'route_ambiguous')
  assert.equal(ambiguousCase.agentId, null)
  assert.equal(routeFor(ambiguousFixture, ambiguous.caseId).reason, 'Both scopes overlap')
  assert.equal(attemptCount(ambiguousFixture), 0)

  const invalidFixture = await fixture(t)
  await invalidFixture.broker.profileUpsert({ workspaceKey: invalidFixture.workspace, name: 'A' })
  await invalidFixture.broker.profileUpsert({ workspaceKey: invalidFixture.workspace, name: 'B' })
  invalidFixture.routeWith({ contract: 'router-contract/1', outcome: 'selected', agentId: 'not-a-candidate', reason: 'Unknown Agent' })
  const invalid = await invalidFixture.broker.consult({ agent: invalidFixture.agent, args: { question: 'Reject an unknown route?', authorization_class: 'A', request_id: 'invalid-route-output' } })
  assert.equal(invalid.outcome, 'awaiting_user')
  assert.equal(invalid.reason, 'no_route')
  assert.equal(routeFor(invalidFixture, invalid.caseId).reason, 'failure:invalid_output')
  assert.equal(invalidFixture.broker.cases.getCase(invalid.caseId).agentId, null)
  assert.equal(attemptCount(invalidFixture), 0)

  const timeoutFixture = await fixture(t)
  await timeoutFixture.broker.profileUpsert({ workspaceKey: timeoutFixture.workspace, name: 'A' })
  await timeoutFixture.broker.profileUpsert({ workspaceKey: timeoutFixture.workspace, name: 'B' })
  timeoutFixture.config.decisionAgentAnswerTimeoutMs = 5
  const stream = timeoutFixture.broker.ctx.llm.stream
  timeoutFixture.broker.ctx.llm.stream = options => options.system.includes('router-contract/1')
    ? (async function * () { await new Promise(() => {}) })()
    : stream(options)
  const timedOut = await timeoutFixture.broker.consult({ agent: timeoutFixture.agent, args: { question: 'Bound a Router timeout?', authorization_class: 'A', request_id: 'route-timeout' } })
  assert.equal(timedOut.outcome, 'awaiting_user')
  assert.equal(timedOut.reason, 'no_route')
  assert.equal(routeFor(timeoutFixture, timedOut.caseId).reason, 'failure:timeout')
  assert.equal(attemptCount(timeoutFixture), 0)
})

test('Auto consult commit failure stays an explicit storage failure without recovery or an Attempt', async t => {
  const f = await fixture(t)
  await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Only' })
  f.broker.cases.transitionWithRoute = async () => { throw new Error('consult route commit failed') }
  let evaluations = 0
  let recoveries = 0
  f.broker.evaluateCase = () => { evaluations++; throw new Error('domain evaluation must not run') }
  f.broker.recoverUnexpected = () => { recoveries++; throw new Error('route failures must not enter domain recovery') }
  const args = { question: 'Persist the route before evaluation?', authorization_class: 'A', request_id: 'consult-commit-failure' }
  await assert.rejects(f.broker.consult({ agent: f.agent, args }), /consult route commit failed/)
  const current = f.broker.cases.byIdempotencyKey('consult:root:consult-commit-failure')
  assert.equal(current.state, 'received')
  assert.equal(current.agentId, null)
  assert.equal(evaluations, 0)
  assert.equal(recoveries, 0)
  assert.equal(attemptCount(f), 0)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n, 0)
})
