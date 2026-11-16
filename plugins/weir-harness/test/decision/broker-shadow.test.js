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
    decisionAgentAutoAnswer: false,
    decisionAgentAnswerTimeoutMs: 1000,
    decisionAgentMaxOutputTokens: 1600,
    decisionAgentContextBudgetTokens: 24000,
  }
  const calls = []
  let routing
  let domain = { outcome: 'escalate', missing: ['A new judgment is required'] }
  const ctx = {
    llm: {
      stream(options) {
        calls.push(options)
        return (async function * () {
          const output = options.system.includes('router-contract/1') ? routing : domain
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
  ctx.agents = { get: id => id === 'root' ? agent : undefined }
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return {
    broker, agent, pinned, alternative, workspace, config, calls,
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

test('a new pinned Hook appends one non-authoritative Shadow after the real pinned route', async t => {
  const f = await fixture(t)
  const request = hookRequest('shadow-hook')
  const snapshot = structuredClone(request)
  const evidence = await f.broker.ensureProfileEvidence(f.pinned, f.workspace)
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
  // No classifier ran and no derived class field was appended.
  assert.equal(Object.hasOwn(current.request.questions[0], 'authorizationClass'), false)
  assert.equal(Object.hasOwn(current.request.questions[0], 'authorizationClassSource'), false)
  assert.deepEqual(request, snapshot)
  assert.deepEqual(routes.map(route => route.mode), ['pinned', 'auto_shadow'])
  assert.equal(routes[0].chosen, f.pinned.agentId)
  assert.equal(routes[1].chosen, f.alternative.agentId)
  assert.equal(f.broker.attempts.forCase(current.caseId).length, 1)
  assert.equal(f.broker.attempts.forCase(current.caseId)[0].agentId, f.pinned.agentId)
  // Exactly one model call: the Shadow verdict. The pinned route is deterministic.
  assert.equal(callsOf(f, 'router-contract/1').length, 1)
  assert.equal(f.calls.length, 2)
})

test('a non-explicit pinned consult observes Shadow without the answer switch', async t => {
  const f = await fixture(t)
  const args = { question: 'Choose for this consultation?', request_id: 'shadow-consult' }

  const result = await f.broker.consult({ agent: f.agent, args })
  const current = f.broker.cases.getCase(result.caseId)
  const routes = routesFor(f, result.caseId)

  assert.equal(result.outcome, 'awaiting_user')
  assert.equal(result.reason, 'consult_escalate')
  assert.equal(current.agentId, f.pinned.agentId)
  assert.equal(current.attemptCount, 1)
  assert.deepEqual(routes.map(route => route.mode), ['pinned', 'auto_shadow'])
  assert.equal(routes[1].chosen, f.alternative.agentId)
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
  assert.equal(callsOf(control, 'router-contract/1').length, 0)
})

test('Shadow routing and route-write failures never alter or retry the pinned outcome', async t => {
  const control = await fixture(t)
  control.config.decisionAgentAutoShadow = false
  const controlVerdict = await control.broker.hook({ agent: control.agent, request: hookRequest('failure-control') })
  const expected = realOutcome(control, controlVerdict)

  for (const failure of ['routing', 'write']) {
    const f = await fixture(t)
    if (failure === 'routing') f.routeWith('not-json')
    if (failure === 'write') {
      f.broker.store.db.exec(`CREATE TRIGGER reject_shadow BEFORE INSERT ON route_decisions WHEN NEW.mode='auto_shadow' BEGIN SELECT RAISE(ABORT,'forced shadow write failure'); END;`)
    }
    const request = hookRequest('failure-control')
    const verdict = await f.broker.hook({ agent: f.agent, request })
    assert.deepEqual(realOutcome(f, verdict), expected, failure)
    assert.equal(f.broker.attempts.forCase(verdict.caseId).length, 1, failure)
    // A Shadow sample is a single call: the invalid verdict earns no repair.
    assert.equal(callsOf(f, 'router-contract/1').length, 1, failure)
    const routes = routesFor(f, verdict.caseId)
    if (failure === 'write') assert.deepEqual(routes.map(route => route.mode), ['pinned'])
    else {
      assert.deepEqual(routes.map(route => route.mode), ['pinned', 'auto_shadow'])
      assert.equal(routes[1].chosen, null)
      assert.equal(routes[1].reason, 'failure:invalid_output')
    }
  }
})

test('a truncated Shadow sidecar stays single-shot while the pinned outcome is untouched', async t => {
  const f = await fixture(t)
  const original = f.broker.ctx.llm.stream
  f.broker.ctx.llm.stream = options => {
    if (!options.system.includes('router-contract/1')) return original(options)
    f.calls.push(options)
    return (async function * () {
      yield { type: 'text-delta', text: '{"contract":"router-contract/1"' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })()
  }
  const verdict = await f.broker.hook({ agent: f.agent, request: hookRequest('shadow-truncated') })
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.agentId, f.pinned.agentId)
  assert.equal(current.state, 'awaiting_user')
  assert.equal(current.attemptCount, 1)
  // The real Auto route would retry a truncated verdict; a diagnostic sample does not.
  assert.equal(callsOf(f, 'router-contract/1').length, 1)
  const routes = routesFor(f, verdict.caseId)
  assert.deepEqual(routes.map(route => route.mode), ['pinned', 'auto_shadow'])
  assert.equal(routes[1].reason, 'failure:truncated')
  assert.equal(routes[1].chosen, null)
  assert.equal(f.broker.attempts.forCase(current.caseId).length, 1)
})

test('Off, global-off, Active Auto, explicit, unavailable, and excluded requests never sample Shadow', async t => {
  const f = await fixture(t)
  await f.broker.setSelector('root', 'off')
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: hookRequest('off') }), { kind: 'pass', why: 'bypass' })
  f.config.decisionAgentsEnabled = false
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: hookRequest('global-off') }), { kind: 'pass', why: 'bypass' })

  f.config.decisionAgentsEnabled = true
  f.config.decisionAgentAutoAnswer = true
  await f.broker.setSelector('root', 'auto')
  const active = await f.broker.hook({ agent: f.agent, request: hookRequest('active-auto') })
  assert.deepEqual(routesFor(f, active.caseId).map(route => route.mode), ['auto'])

  await f.broker.setSelector('root', 'agent', f.pinned.agentId)
  const explicit = await f.broker.consult({ agent: f.agent, args: {
    question: 'Use only the explicit Agent?', agent_id: f.alternative.agentId, request_id: 'explicit-no-shadow',
  } })
  assert.deepEqual(routesFor(f, explicit.caseId).map(route => route.mode), ['explicit'])

  await f.broker.profileSetState(f.pinned.agentId, 'disabled')
  const unavailableHook = await f.broker.hook({ agent: f.agent, request: hookRequest('unavailable-hook') })
  assert.deepEqual(routesFor(f, unavailableHook.caseId).map(route => route.mode), ['none'])
  const unavailableConsult = await f.broker.consult({ agent: f.agent, args: { question: 'Pinned is unavailable?', request_id: 'unavailable-consult' } })
  assert.deepEqual(routesFor(f, unavailableConsult.caseId).map(route => route.mode), ['pinned'])

  await f.broker.profileSetState(f.pinned.agentId, 'enabled')
  const excludedHook = hookRequest('excluded-hook')
  excludedHook.questions[0].intent = { kind: 'approval' }
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: excludedHook }), { kind: 'pass', why: 'bypass' })
  // The deterministic exclusion is the only authority boundary: no class field.
  const excludedConsult = await f.broker.consult({ agent: f.agent, args: { question: 'Approve this native deployment?', request_id: 'excluded-consult' } })
  assert.deepEqual(routesFor(f, excludedConsult.caseId).map(route => route.mode), ['pinned'])

  f.broker.store.db.exec(`CREATE TRIGGER disable_pin_during_intake AFTER INSERT ON cases BEGIN UPDATE agent_profiles SET state='disabled' WHERE agent_id='${f.pinned.agentId}'; END;`)
  const stalePin = await f.broker.hook({ agent: f.agent, request: hookRequest('stale-pin-during-intake') })
  assert.deepEqual(routesFor(f, stalePin.caseId).map(route => route.mode), ['pinned'])

  assert.equal(f.broker.store.db.prepare("SELECT COUNT(*) AS n FROM route_decisions WHERE mode='auto_shadow'").get().n, 0)
  // Only the Active-Auto route itself reached the Router: exactly one call.
  assert.equal(callsOf(f, 'router-contract/1').length, 1)
})

test('replay, retry, revise, reassign, and restart never add or compensate a Shadow', async t => {
  const f = await fixture(t)
  const request = hookRequest('shadow-lifecycle')
  const first = await f.broker.hook({ agent: f.agent, request })
  const replay = await f.broker.hook({ agent: f.agent, request })
  assert.deepEqual(replay, first)
  assert.equal(routesFor(f, first.caseId).filter(route => route.mode === 'auto_shadow').length, 1)
  assert.equal(callsOf(f, 'router-contract/1').length, 1)

  await f.broker.retry({ caseId: first.caseId })
  await f.broker.reassign({ caseId: first.caseId, agentId: f.alternative.agentId })
  assert.equal(routesFor(f, first.caseId).filter(route => route.mode === 'auto_shadow').length, 1)
  assert.equal(callsOf(f, 'router-contract/1').length, 1)

  f.respond({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add the missing context.' })
  const args = { question: 'Initial pinned consultation?', request_id: 'shadow-revision' }
  const initial = await f.broker.consult({ agent: f.agent, args })
  assert.deepEqual(await f.broker.consult({ agent: f.agent, args }), initial)
  f.respond({ outcome: 'escalate', missing: ['A revised judgment is required'] })
  await f.broker.consult({ agent: f.agent, args: { ...args, question: 'Actually revised consultation?' } })
  assert.equal(routesFor(f, initial.caseId).filter(route => route.mode === 'auto_shadow').length, 1)
  assert.equal(callsOf(f, 'router-contract/1').length, 2)

  const crashed = await fixture(t)
  const current = (await crashed.broker.cases.createCase({
    workspaceKey: crashed.workspace, rootSessionId: 'root', entry: 'hook', agentId: crashed.pinned.agentId,
    request: hookRequest('crash-after-pinned'), scope: { workspaces: [crashed.workspace] }, idempotencyKey: 'crash-after-pinned',
  })).case
  await crashed.broker.cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'pinned', chosen: crashed.pinned.agentId, reason: 'Pinned by user' })
  const path = crashed.broker.databasePath()
  await crashed.broker.flush()
  const restarted = new DecisionBroker({ profileContext: crashed.broker.profileContext, ctx: crashed.broker.ctx, config: () => crashed.config })
  t.after(async () => { await restarted.flush() })
  await restarted.open(path)
  assert.equal(restarted.cases.getCase(current.caseId).state, 'received')
  assert.equal(restarted.store.db.prepare("SELECT COUNT(*) AS n FROM route_decisions WHERE case_id=? AND mode='auto_shadow'").get(current.caseId).n, 0)
  assert.equal(callsOf(crashed, 'router-contract/1').length, 0)
})

test('Shadow stays non-authoritative and adds no retrieval, profile, Attempt, or learning effects', async t => {
  const f = await fixture(t)
  const profilesBefore = [f.pinned, f.alternative].map(profile => f.broker.profiles.getProfile(profile.agentId))
  let retrievals = 0
  let generatedDescriptionReads = 0
  const retrieve = f.broker.retriever.retrieve.bind(f.broker.retriever)
  f.broker.retriever.retrieve = (...args) => { retrievals++; return retrieve(...args) }
  const listProfiles = f.broker.profiles.listProfiles.bind(f.broker.profiles)
  f.broker.profiles.listProfiles = (...args) => listProfiles(...args).map(profile => {
    Object.defineProperty(profile, 'generatedDescription', { configurable: true, get() { generatedDescriptionReads++; throw new Error('Shadow must not read generatedDescription') } })
    return profile
  })

  const selected = await f.broker.hook({ agent: f.agent, request: hookRequest('shadow-normal') })
  assert.equal(routesFor(f, selected.caseId)[1].chosen, f.alternative.agentId)
  // A failing Shadow verdict is still just a suggestion: no repair, no retry.
  f.routeWith('not-json')
  const failed = await f.broker.hook({ agent: f.agent, request: hookRequest('shadow-invalid') })
  const failedCurrent = f.broker.cases.getCase(failed.caseId)
  const failedShadow = routesFor(f, failed.caseId).find(route => route.mode === 'auto_shadow')
  assert.equal(failedCurrent.agentId, f.pinned.agentId)
  assert.equal(failedCurrent.attemptCount, 1)
  assert.equal(failedCurrent.maxAttempts, 3)
  assert.equal(failedShadow.chosen, null)
  assert.equal(failedShadow.reason, 'failure:invalid_output')
  assert.equal(Object.hasOwn(failedCurrent.request.questions[0], 'authorizationClass'), false)

  assert.equal(retrievals, 2)
  assert.equal(generatedDescriptionReads, 0)
  assert.equal(callsOf(f, 'router-contract/1').length, 2)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 2)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 2)
  assert.equal(f.broker.store.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE source='user_decision'").get().n, 0)
  for (const table of ['feedback', 'corrections', 'learning_runs', 'memory_snapshots']) {
    assert.equal(f.broker.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table)
  }
  assert.deepEqual([f.pinned, f.alternative].map(profile => f.broker.profiles.getProfile(profile.agentId)), profilesBefore)
  assert.equal(f.broker.activeEvaluations, 0)
})

test('Shadow none and ambiguity remain suggestions with no real Case or Attempt changes', async t => {
  for (const outcome of ['none', 'ambiguous']) {
    const f = await fixture(t)
    f.routeWith(outcome === 'none'
      ? { contract: 'router-contract/1', outcome, reason: 'No candidate fits' }
      : { contract: 'router-contract/1', outcome, reason: 'Both candidates overlap', ambiguity: { candidates: [f.pinned.agentId, f.alternative.agentId], conflict: 'Both claim the decision' } })
    const verdict = await f.broker.hook({ agent: f.agent, request: hookRequest(`shadow-${outcome}`) })
    const current = f.broker.cases.getCase(verdict.caseId)
    const routes = routesFor(f, verdict.caseId)
    assert.equal(current.agentId, f.pinned.agentId)
    assert.equal(current.state, 'awaiting_user')
    assert.equal(current.attemptCount, 1)
    assert.deepEqual(routes.map(route => route.mode), ['pinned', 'auto_shadow'])
    assert.equal(routes[1].chosen, null)
    assert.equal(routes[1].reason, outcome === 'none' ? 'No candidate fits' : 'Both candidates overlap')
    assert.equal(routes[1].ambiguity_json === null, outcome === 'none')
    assert.equal(f.broker.attempts.forCase(current.caseId).length, 1)
  }
})
