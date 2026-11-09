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

test('multiple eligible candidates come only from the current workspace and selected Agent owns the domain Attempt', async t => {
  const f = await fixture(t)
  const a = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'A' })
  const b = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'B' })
  const disabled = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Disabled' })
  await f.broker.profileSetState(disabled.agentId, 'disabled')
  const narrow = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Narrow', scope: { workspaces: [f.workspace], paths: ['src'], authorizationClasses: ['A'] } })
  const wrongClass = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Wrong class', scope: { workspaces: [f.workspace], authorizationClasses: ['B'] } })
  const archived = await f.broker.profileUpsert({ workspaceKey: f.workspace, name: 'Archived' })
  await f.broker.profileSetState(archived.agentId, 'archived')
  const foreign = await f.broker.profileUpsert({ workspaceKey: '/other-workspace', name: 'Foreign' })
  f.routeWith({ contract: 'router-contract/1', outcome: 'selected', agentId: b.agentId, reason: 'B owns this judgment' })

  const result = await f.broker.consult({ agent: f.agent, args: { question: 'Choose the current owner?', authorization_class: 'A', request_id: 'multiple-candidates' } })
  const current = f.broker.cases.getCase(result.caseId)
  const route = routeFor(f, result.caseId)
  const routerCalls = callsOf(f, 'router-contract/1')
  assert.equal(routerCalls.length, 1)
  const pack = JSON.parse(routerCalls[0].messages[0].content[0].text)
  assert.deepEqual(pack.candidates.map(candidate => candidate.agentId), [a.agentId, b.agentId].sort())
  const stored = JSON.parse(route.candidates_json)
  assert.equal(stored.some(candidate => [foreign.agentId, archived.agentId].includes(candidate.agentId)), false)
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
