import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-batch-'))
  const workspace = realpathSync(dir)
  let output
  let streamCalls = 0
  const ctx = { llm: { stream: () => {
    streamCalls++
    return (async function * () {
      yield { type: 'text-delta', text: JSON.stringify(output()) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  } } }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: true }) })
  await broker.start()
  const profile = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  await broker.setSelector('root', 'agent', profile.agentId)
  let source = (await broker.cases.createCase({ workspaceKey: workspace, rootSessionId: 'root', entry: 'consult', agentId: profile.agentId, request: { questions: [] }, scope: { workspaces: [workspace] }, idempotencyKey: 'source' })).case
  source = await broker.cases.transition({ caseId: source.caseId, expectedState: 'received', expectedRevision: source.revision, state: 'awaiting_user' })
  source = await broker.cases.transition({ caseId: source.caseId, expectedState: 'awaiting_user', expectedRevision: source.revision, state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers: [{ id: 'q', selected: ['A'] }] } })
  const ref = await broker.evidence.add({ agentId: profile.agentId, source: 'user_decision', locator: { kind: 'case', caseId: source.caseId }, scope: { workspaces: [workspace] } })
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const request = { questions: [
    { id: 'q1', question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: 'Second?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
    { id: 'q3', question: 'Third?', options: [{ label: 'A' }, { label: 'B' }] },
  ] }
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { broker, profile, agent, request, ref, respond: value => { output = () => value }, calls: () => streamCalls }
}

test('three passing questions return one complete ordered batch in one evaluation', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'answer', claims: [{ text: 'All choices are supported', evidenceIds: [f.ref.evidenceId] }], answers: [
    { id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['A', 'B'] }, { id: 'q3', selected: ['B'] },
  ] })
  const verdict = await f.broker.hook({ agent: f.agent, request: f.request })
  assert.equal(verdict.kind, 'answer')
  assert.deepEqual(verdict.answer.answers.map(answer => answer.id), ['q1', 'q2', 'q3'])
  assert.deepEqual(verdict.answer.answers[1].selected, ['A', 'B'])
  assert.equal(f.calls(), 1)
})

test('one incomplete question sends the original whole batch to next with suggestions only', async t => {
  const f = await fixture(t)
  f.respond({ outcome: 'answer', claims: [{ text: 'First and third are supported', evidenceIds: [f.ref.evidenceId] }], answers: [
    { id: 'q1', selected: ['A'] }, { id: 'q3', selected: ['B'] },
  ] })
  const verdict = await f.broker.hook({ agent: f.agent, request: f.request })
  assert.equal(verdict.why, 'awaiting_user')
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.awaitingReason, 'partial_batch')
  assert.deepEqual(current.escalation.perQuestion.map(item => item.outcome), ['answer', 'return', 'answer'])
  assert.equal(current.escalation.perQuestion[1].id, 'q2')
  assert.equal(current.decision, null)
  let received
  const next = async original => { received = original; return { answers: original.questions.map(question => ({ id: question.id, selected: ['A'] })) } }
  const native = await next(f.request)
  assert.equal(received, f.request)
  assert.equal(native.answers.length, 3)
  assert.equal(f.broker.cases.getCase(verdict.caseId).decision, null)
})

test('an approval item poisons the whole batch before Case creation', async t => {
  const f = await fixture(t)
  const request = { questions: [f.request.questions[0], { ...f.request.questions[1], intent: { kind: 'approval' } }, f.request.questions[2]] }
  const verdict = await f.broker.hook({ agent: f.agent, request })
  assert.deepEqual(verdict, { kind: 'pass', why: 'bypass' })
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 1) // Only the seeded authority Case.
  assert.equal(f.calls(), 0)
})
