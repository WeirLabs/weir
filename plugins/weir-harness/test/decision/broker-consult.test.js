import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-consult-'))
  const workspace = realpathSync(dir)
  let output = { outcome: 'escalate', missing: ['New judgment'] }
  const config = { decisionAgentsEnabled: true }
  const audits = []
  let userAsks = 0
  const ctx = {
    llm: { stream: () => (async function * () {
      yield { type: 'text-delta', text: JSON.stringify(output) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
    sessionQuery: { traceSession: async id => ({ complete: true, root: { header: { id: 'root' } } }) },
    userQuestions: { ask: async () => { userAsks++; throw new Error('child must not ask') } },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => config, audit: (kind, value) => audits.push({ kind, value }) })
  await broker.start()
  const a = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  const b = await broker.profileUpsert({ workspaceKey: workspace, name: 'B' })
  await broker.setSelector('root', 'agent', a.agentId)
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const child = { id: 'child', session: { header: { id: 'child', parentSession: 'root', cwd: dir, delegationDepth: 1 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { broker, a, b, agent, child, workspace, audits, config, respond: value => { output = value }, userAsks: () => userAsks }
}

async function seed(broker, profile, workspace) {
  let source = (await broker.cases.createCase({ workspaceKey: workspace, rootSessionId: 'root', entry: 'consult', agentId: profile.agentId, request: { questions: [] }, scope: { workspaces: [workspace] }, idempotencyKey: `source-${profile.agentId}` })).case
  source = await broker.cases.transition({ caseId: source.caseId, expectedState: 'received', expectedRevision: source.revision, state: 'awaiting_user' })
  source = await broker.cases.transition({ caseId: source.caseId, expectedState: 'awaiting_user', expectedRevision: source.revision, state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers: [{ id: 'question', selected: ['B'] }] } })
  return broker.evidence.add({ agentId: profile.agentId, source: 'user_decision', locator: { kind: 'case', caseId: source.caseId }, scope: { workspaces: [workspace] } })
}

test('answered consultation includes evidence and pins; explicit Agent is one-shot and audited', async t => {
  const f = await fixture(t)
  const ref = await seed(f.broker, f.b, f.workspace)
  f.respond({ outcome: 'answer', claims: [{ text: 'Use B', evidenceIds: [ref.evidenceId] }], answers: [{ id: 'question', selected: ['B'] }] })
  const result = await f.broker.consult({ agent: f.agent, args: { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], agent_id: f.b.agentId, request_id: 'answer-1' } })
  assert.equal(result.outcome, 'answered')
  assert.deepEqual(result.answer, { id: 'question', selected: ['B'] })
  assert.deepEqual(result.evidence.map(item => item.evidenceId), [ref.evidenceId])
  assert.equal(result.pins.promptVersion, 'evaluator-contract/3')
  assert.equal(f.broker.cases.getCase(result.caseId).closing, 'answered')
  assert.deepEqual(f.broker.selector('root'), { mode: 'agent', agentId: f.a.agentId })
  assert.equal(f.broker.store.db.prepare('SELECT mode,chosen FROM route_decisions WHERE case_id=?').get(result.caseId).mode, 'explicit')
  assert.ok(f.audits.some(event => event.kind === 'case-open' && event.value.explicit === true))
})

test('returned consultation persists actionable details across idempotent rereads', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add the missing scope path.' })
  const args = { question: 'Which?', request_id: 'return-1' }
  const first = await f.broker.consult({ agent: f.agent, args })
  const second = await f.broker.consult({ agent: f.agent, args })
  assert.deepEqual(second, first)
  assert.equal(first.outcome, 'returned')
  assert.equal(first.code, 'MISSING_CONTEXT')
  assert.equal(first.hint, 'Add the missing scope path.')
  assert.equal(f.broker.cases.getCase(first.caseId).state, 'awaiting_revision')
  assert.equal(f.broker.attempts.forCase(first.caseId).length, 1)
})
test('a changed consultation revises awaiting_revision while an identical replay stays idempotent', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add the missing scope path.' })
  const initial = { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], request_id: 'revise-1' }
  const first = await f.broker.consult({ agent: f.agent, args: initial })
  await f.broker.consult({ agent: f.agent, args: initial })
  assert.equal(f.broker.attempts.forCase(first.caseId).length, 1)
  const ref = f.broker.evidence.candidates({ agentId: f.a.agentId, workspaceKey: f.workspace, scope: { workspaces: [f.workspace] } })[0]
  f.respond({ outcome: 'answer', claims: [{ text: 'Use B after revision', evidenceIds: [ref.evidenceId] }], answers: [{ id: 'question', selected: ['B'] }] })
  const revised = await f.broker.consult({ agent: f.agent, args: { ...initial, question: 'Which revised?' } })
  assert.equal(revised.outcome, 'answered')
  assert.equal(revised.caseId, first.caseId)
  assert.equal(f.broker.attempts.forCase(first.caseId).length, 2)
})
test('revision honors a new explicit Agent and records the new route', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add scope.' })
  const initial = { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], agent_id: f.a.agentId, request_id: 'revise-agent' }
  const first = await f.broker.consult({ agent: f.agent, args: initial })
  const ref = await f.broker.ensureProfileEvidence(f.b)
  f.respond({ outcome: 'answer', claims: [{ text: 'Use B after reassignment', evidenceIds: [ref.evidenceId] }], answers: [{ id: 'question', selected: ['B'] }] })
  const revised = await f.broker.consult({ agent: f.agent, args: { ...initial, question: 'Which revised?', agent_id: f.b.agentId } })
  assert.equal(revised.outcome, 'answered')
  assert.equal(f.broker.attempts.forCase(first.caseId).at(-1).agentId, f.b.agentId)
  const route = f.broker.store.db.prepare('SELECT mode,chosen FROM route_decisions WHERE case_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(first.caseId)
  assert.equal(route.mode, 'explicit')
  assert.equal(route.chosen, f.b.agentId)
})

test('revision rejects an Agent disabled after the original return without a new Attempt', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add scope.' })
  const initial = { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], request_id: 'revise-disabled' }
  const first = await f.broker.consult({ agent: f.agent, args: initial })
  await f.broker.profileSetState(f.a.agentId, 'disabled')
  await assert.rejects(f.broker.consult({ agent: f.agent, args: { ...initial, question: 'Which revised?' } }), error => error.code === 'AGENT_UNAVAILABLE')
  assert.equal(f.broker.cases.getCase(first.caseId).state, 'awaiting_revision')
  assert.equal(f.broker.attempts.forCase(first.caseId).length, 1)
  assert.ok(f.audits.some(event => event.kind === 'outcome' && event.value.action === 'boundary-reject' && event.value.caseId === first.caseId && event.value.agentId === f.a.agentId))
})

test('a decided consultation reread returns the authoritative user answer and evidence', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'escalate', missing: ['Choose a direction'] })
  const args = { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], request_id: 'decided-reread' }
  const waiting = await f.broker.consult({ agent: f.agent, args })
  await f.broker.decide({ caseId: waiting.caseId, answers: [{ id: 'question', selected: ['B'] }] })
  const result = await f.broker.consult({ agent: f.agent, args })
  assert.equal(result.outcome, 'answered')
  assert.equal(result.userDecided, true)
  assert.deepEqual(result.answer, { id: 'question', selected: ['B'] })
  assert.ok(result.evidence.some(ref => ref.locator.caseId === waiting.caseId))
})

test('delegated escalation lands in the root inbox without asking from the child', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'escalate', missing: ['Choose a new direction'] })
  const result = await f.broker.consult({ agent: f.child, args: { question: 'New product judgment?', request_id: 'child-1' } })
  assert.equal(result.outcome, 'awaiting_user')
  const current = f.broker.cases.getCase(result.caseId)
  assert.equal(current.rootSessionId, 'root')
  assert.equal(current.originSessionId, 'child')
  assert.equal(current.originKind, 'delegated')
  assert.ok(f.broker.query.inbox({ sessionId: 'root' }).some(item => item.caseId === result.caseId))
  assert.equal(f.userAsks(), 0)
})

test('Off, globally disabled and explicit unavailable Agent fail before creating a Case', async t => {
  const f = await fixture(t)
  await f.broker.setSelector('root', 'off')
  const before = f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n
  await assert.rejects(f.broker.consult({ agent: f.agent, args: { question: 'Q', agent_id: f.b.agentId } }), error => error.code === 'DECISION_OFF')
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, before)

  await f.broker.setSelector('root', 'agent', f.a.agentId)
  await f.broker.profileSetState(f.b.agentId, 'disabled')
  await assert.rejects(f.broker.consult({ agent: f.agent, args: { question: 'Q', agent_id: f.b.agentId } }), error => error.code === 'AGENT_UNAVAILABLE')
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, before)
  const foreign = await f.broker.profileUpsert({ workspaceKey: '/other', name: 'Foreign' })
  await assert.rejects(f.broker.consult({ agent: f.agent, args: { question: 'Q', agent_id: foreign.agentId } }), error => error.code === 'AGENT_UNAVAILABLE')
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, before)
  assert.ok(f.audits.some(event => event.kind === 'outcome' && event.value.action === 'boundary-reject' && event.value.agentId === foreign.agentId))

  f.config.decisionAgentsEnabled = false
  await assert.rejects(f.broker.consult({ agent: f.agent, args: { question: 'Q' } }), error => error.code === 'DECISION_OFF')
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, before)
})
