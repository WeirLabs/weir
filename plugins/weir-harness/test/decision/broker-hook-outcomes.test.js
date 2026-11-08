import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-hook-outcome-'))
  const workspace = realpathSync(dir)
  let responder = () => ({ outcome: 'escalate', missing: ['New judgment'] })
  let finishKind = 'stop'
  const ctx = { llm: { stream: () => (async function * () {
    if (finishKind === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM' } } }
      return
    }
    yield { type: 'text-delta', text: JSON.stringify(responder()) }
    yield { type: 'finish', reason: { kind: finishKind } }
  })() } }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: true, ...config }) })
  await broker.start()
  const profile = await broker.profileUpsert({ workspaceKey: workspace, name: 'A', userDescription: 'Prefer concise copy' })
  await broker.setSelector('root', 'agent', profile.agentId)
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const request = { questions: [{ id: 'q', question: 'Which title?', options: [{ label: 'A' }, { label: 'B' }] }] }
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { broker, profile, agent, request, workspace, respond: value => { responder = () => value }, finish: kind => { finishKind = kind } }
}

async function seedUserDecision({ broker, profile, workspace }) {
  let source = (await broker.cases.createCase({ workspaceKey: workspace, rootSessionId: 'root', entry: 'consult', agentId: profile.agentId, request: { questions: [] }, scope: { workspaces: [workspace] }, idempotencyKey: 'source' })).case
  source = await broker.cases.transition({ caseId: source.caseId, expectedState: 'received', expectedRevision: source.revision, state: 'awaiting_user' })
  source = await broker.cases.transition({ caseId: source.caseId, expectedState: 'awaiting_user', expectedRevision: source.revision, state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers: [{ id: 'q', selected: ['A'] }] } })
  return broker.evidence.add({ agentId: profile.agentId, source: 'user_decision', locator: { kind: 'case', caseId: source.caseId }, scope: { workspaces: [workspace] } })
}

test('answer closes answered and returns the complete original-shape batch', async t => {
  const f = await fixture(t)
  const ref = await seedUserDecision(f)
  f.respond({ outcome: 'answer', claims: [{ text: 'Use A', evidenceIds: [ref.evidenceId] }], answers: [{ id: 'q', selected: ['A'] }] })
  const verdict = await f.broker.hook({ agent: f.agent, request: f.request })
  assert.equal(verdict.kind, 'answer')
  assert.deepEqual(verdict.answer, { answers: [{ id: 'q', selected: ['A'] }] })
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.state, 'closed')
  assert.equal(current.closing, 'answered')
})

test('full return awaits revision and native next answer is not a user_decision', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add the missing product scope.' })
  const verdict = await f.broker.hook({ agent: f.agent, request: f.request })
  assert.equal(verdict.why, 'awaiting_revision')
  const answer = { answers: [{ id: 'q', selected: ['B'] }] }
  const next = async () => {
    assert.equal(f.broker.cases.getCase(verdict.caseId).state, 'awaiting_revision')
    return answer
  }
  const native = await next()
  assert.deepEqual(native, answer)
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.decision, null)
  assert.equal(current.state, 'awaiting_revision')
})

test('escalation persists awaiting_user before next and captures its exact answer', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'escalate', missing: ['Choose the new product direction'] })
  const verdict = await f.broker.hook({ agent: f.agent, request: f.request })
  const answer = { answers: [{ id: 'q', selected: ['B'] }] }
  const next = async () => {
    assert.equal(f.broker.cases.getCase(verdict.caseId).state, 'awaiting_user')
    return answer
  }
  const native = await next()
  await f.broker.hookUserAnswer({ caseId: verdict.caseId, answer: native })
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.state, 'closed')
  assert.equal(current.closing, 'escalated')
  assert.equal(current.decision.kind, 'user_decision')
  assert.deepEqual(current.decision.answers, answer.answers)
  const refs = f.broker.evidence.candidates({ agentId: f.profile.agentId, workspaceKey: f.workspace, scope: { workspaces: [f.workspace] } })
  assert.ok(refs.some(ref => ref.source === 'user_decision' && ref.locator.caseId === current.caseId))
})

test('next failure closes cancelled without answer; aborted evaluator also cannot answer', async t => {
  const f = await fixture(t)
  const verdict = await f.broker.hook({ agent: f.agent, request: f.request })
  const failure = new Error('native cancelled')
  await assert.rejects(async () => { throw failure }, error => error === failure)
  await f.broker.hookUserAborted({ caseId: verdict.caseId })
  const cancelled = f.broker.cases.getCase(verdict.caseId)
  assert.equal(cancelled.closing, 'cancelled')
  assert.equal(cancelled.decision.kind, 'cancelled')
  assert.equal(cancelled.decision.answers, undefined)

  const abortedFixture = await fixture(t)
  abortedFixture.finish('aborted')
  const aborted = await abortedFixture.broker.hook({ agent: abortedFixture.agent, request: abortedFixture.request })
  assert.equal(aborted.why, 'cancelled')
  assert.equal(abortedFixture.broker.cases.getCase(aborted.caseId).closing, 'cancelled')
  assert.equal(abortedFixture.broker.cases.getCase(aborted.caseId).decision.answers, undefined)
})

test('runtime failure exhaustion is awaiting_user before native fallback', async t => {
  const f = await fixture(t, { decisionAgentMaxAttemptsPerCase: 1 })
  f.finish('error')
  const verdict = await f.broker.hook({ agent: f.agent, request: f.request })
  assert.equal(verdict.why, 'awaiting_user')
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.awaitingReason, 'exhausted')
  assert.equal(current.attemptCount, 1)
  assert.equal(f.broker.attempts.forCase(current.caseId)[0].error.kind, 'model_error')
})
