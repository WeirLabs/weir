import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-shadow-'))
  const workspace = realpathSync(dir)
  const config = {
    decisionAgentsEnabled: true,
    decisionAgentAutoShadow: true,
    decisionAgentAutoAnswerClasses: [],
    decisionAgentAnswerTimeoutMs: 1000,
    decisionAgentMaxOutputTokens: 1600,
    decisionAgentContextBudgetTokens: 24000,
  }
  const calls = []
  let classificationClass = 'A'
  let routing
  let domain = { outcome: 'escalate', missing: ['A new judgment is required'] }
  const ctx = {
    llm: {
      stream(options) {
        calls.push(options)
        return (async function * () {
          let output
          if (options.system.includes('router-classification-contract/1')) {
            const pack = JSON.parse(options.messages[0].content[0].text)
            output = {
              contract: 'router-classification-contract/1',
              classes: pack.questions.map(question => ({ id: question.id, authorizationClass: classificationClass })),
            }
          } else if (options.system.includes('router-contract/1')) {
            output = routing
          } else {
            output = domain
          }
          yield { type: 'text-delta', text: typeof output === 'string' ? output : JSON.stringify(output) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => config })
  await broker.start()
  const pinned = await broker.profileUpsert({ workspaceKey: workspace, name: 'Pinned' })
  const alternative = await broker.profileUpsert({ workspaceKey: workspace, name: 'Alternative' })
  routing = { contract: 'router-contract/1', outcome: 'selected', agentId: alternative.agentId, reason: 'Alternative is the shadow suggestion' }
  await broker.setSelector('root', 'agent', pinned.agentId)
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return {
    broker, agent, pinned, alternative, workspace, config, calls,
    classifyAs(value) { classificationClass = value },
    routeWith(value) { routing = value },
    respond(value) { domain = value },
  }
}

function hookRequest(id = 'q') {
  return { questions: [{ id, question: 'Choose a direction?', options: [{ label: 'A' }, { label: 'B' }] }], wait: { callId: id } }
}

function routesFor(f, caseId) {
  return f.broker.store.db.prepare('SELECT * FROM route_decisions WHERE case_id=? ORDER BY rowid').all(caseId)
}

function callsOf(f, contract) {
  return f.calls.filter(call => call.system.includes(contract))
}

test('a new classless pinned Hook appends one non-authoritative Shadow after the real pinned route', async t => {
  const f = await fixture(t)
  const request = hookRequest('shadow-hook')
  const snapshot = structuredClone(request)
  const evidence = await f.broker.ensureProfileEvidence(f.pinned)
  f.respond({ outcome: 'answer', claims: [{ text: 'The pinned evidence supports A', evidenceIds: [evidence.evidenceId] }], answers: [{ id: 'shadow-hook', selected: ['A'] }] })

  const verdict = await f.broker.hook({ agent: f.agent, request })
  const current = f.broker.cases.getCase(verdict.caseId)
  const routes = routesFor(f, verdict.caseId)

  assert.equal(verdict.kind, 'answer')
  assert.deepEqual(verdict.answer, { answers: [{ id: 'shadow-hook', selected: ['A'] }] })
  assert.equal(current.agentId, f.pinned.agentId)
  assert.equal(current.state, 'closed')
  assert.equal(current.closing, 'answered')
  assert.equal(current.attemptCount, 1)
  assert.equal(current.request.questions[0].authorizationClass, undefined)
  assert.equal(current.request.questions[0].authorizationClassSource, undefined)
  assert.deepEqual(request, snapshot)
  assert.deepEqual(routes.map(route => route.mode), ['pinned', 'auto_shadow'])
  assert.equal(routes[0].chosen, f.pinned.agentId)
  assert.equal(routes[1].chosen, f.alternative.agentId)
  assert.equal(f.broker.attempts.forCase(current.caseId).length, 1)
  assert.equal(f.broker.attempts.forCase(current.caseId)[0].agentId, f.pinned.agentId)
  assert.equal(callsOf(f, 'router-classification-contract/1').length, 1)
  assert.equal(callsOf(f, 'router-contract/1').length, 1)
})

test('a non-explicit pinned consult observes Shadow without the Active whitelist', async t => {
  const f = await fixture(t)
  const args = { question: 'Choose for this consultation?', authorization_class: 'A', request_id: 'shadow-consult' }

  const result = await f.broker.consult({ agent: f.agent, args })
  const current = f.broker.cases.getCase(result.caseId)
  const routes = routesFor(f, result.caseId)

  assert.equal(result.outcome, 'awaiting_user')
  assert.equal(result.reason, 'consult_escalate')
  assert.equal(current.agentId, f.pinned.agentId)
  assert.equal(current.attemptCount, 1)
  assert.deepEqual(routes.map(route => route.mode), ['pinned', 'auto_shadow'])
  assert.equal(routes[1].chosen, f.alternative.agentId)
  assert.equal(callsOf(f, 'router-classification-contract/1').length, 0)
  assert.equal(callsOf(f, 'router-contract/1').length, 1)
})

function realOutcome(f, verdict) {
  const current = f.broker.cases.getCase(verdict.caseId)
  const agentRole = agentId => agentId === f.pinned.agentId ? 'pinned' : agentId === f.alternative.agentId ? 'alternative' : agentId
  const scope = value => ({ ...value, workspaces: value.workspaces.map(() => 'workspace') })
  return {
    verdict: { kind: verdict.kind, why: verdict.why, answer: verdict.answer },
    current: {
      agentId: agentRole(current.agentId), state: current.state, closing: current.closing,
      awaitingReason: current.awaitingReason, attemptCount: current.attemptCount,
      request: current.request, scope: scope(current.scope), decision: current.decision,
      feedbackState: current.feedbackState, needsReview: current.needsReview,
    },
    attempts: f.broker.attempts.forCase(current.caseId).map(attempt => ({
      attemptNo: attempt.attemptNo, agentId: agentRole(attempt.agentId), outcome: attempt.outcome,
      reasonCode: attempt.reasonCode, hint: attempt.hint, error: attempt.error,
      claims: attempt.claims, citedEvidenceIds: attempt.citedEvidenceIds,
    })),
    evidence: f.broker.store.db.prepare('SELECT agent_id,source,locator_json,scope_json,status FROM evidence ORDER BY rowid').all().map(row => ({
      ...row, agent_id: agentRole(row.agent_id), scope_json: JSON.stringify(scope(JSON.parse(row.scope_json))),
    })),
    feedback: f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,
  }
}

test('Shadow=false and Shadow=true have identical real pinned outcomes and domain history', async t => {
  const control = await fixture(t)
  control.config.decisionAgentAutoShadow = false
  const observed = await fixture(t)
  const controlVerdict = await control.broker.hook({ agent: control.agent, request: hookRequest('control') })
  const observedVerdict = await observed.broker.hook({ agent: observed.agent, request: hookRequest('control') })

  assert.deepEqual(realOutcome(observed, observedVerdict), realOutcome(control, controlVerdict))
  assert.deepEqual(routesFor(control, controlVerdict.caseId).map(route => route.mode), ['pinned'])
  assert.deepEqual(routesFor(observed, observedVerdict.caseId).map(route => route.mode), ['pinned', 'auto_shadow'])
  assert.equal(callsOf(control, 'router-classification-contract/1').length, 0)
  assert.equal(callsOf(control, 'router-contract/1').length, 0)
})

test('Shadow classification, routing, and route-write failures never alter or retry the pinned outcome', async t => {
  const control = await fixture(t)
  control.config.decisionAgentAutoShadow = false
  const controlVerdict = await control.broker.hook({ agent: control.agent, request: hookRequest('failure-control') })
  const expected = realOutcome(control, controlVerdict)

  for (const failure of ['classification', 'routing', 'write']) {
    const f = await fixture(t)
    if (failure === 'classification') f.classifyAs('not-a-class')
    if (failure === 'routing') f.routeWith('not-json')
    if (failure === 'write') {
      f.broker.store.db.exec(`CREATE TRIGGER reject_shadow BEFORE INSERT ON route_decisions WHEN NEW.mode='auto_shadow' BEGIN SELECT RAISE(ABORT,'forced shadow write failure'); END;`)
    }
    const request = hookRequest('failure-control')
    const verdict = await f.broker.hook({ agent: f.agent, request })
    assert.deepEqual(realOutcome(f, verdict), expected, failure)
    assert.equal(f.broker.attempts.forCase(verdict.caseId).length, 1, failure)
    assert.equal(callsOf(f, 'router-classification-contract/1').length, 1, failure)
    assert.equal(callsOf(f, 'router-contract/1').length, failure === 'classification' ? 0 : 1, failure)
    const routes = routesFor(f, verdict.caseId)
    if (failure === 'write') assert.deepEqual(routes.map(route => route.mode), ['pinned'])
    else {
      assert.deepEqual(routes.map(route => route.mode), ['pinned', 'auto_shadow'])
      assert.equal(routes[1].chosen, null)
      assert.equal(routes[1].reason, 'failure:invalid_output')
    }
  }
})
