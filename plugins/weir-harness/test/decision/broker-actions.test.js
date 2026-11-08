import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-actions-'))
  const workspace = realpathSync(dir)
  const audits = []
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const ctx = {
    agents: { get: id => id === 'root' ? agent : undefined },
    llm: { stream: () => (async function * () {
      yield { type: 'text-delta', text: JSON.stringify({ outcome: 'escalate', missing: ['New judgment'] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: true }), audit: (kind, value) => audits.push({ kind, value }) })
  await broker.start()
  const a = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  const b = await broker.profileUpsert({ workspaceKey: workspace, name: 'B' })
  await broker.setSelector('root', 'agent', a.agentId)
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  async function open(callId) {
    const request = { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], wait: { callId } }
    const verdict = await broker.hook({ agent, request })
    return { verdict, request, current: broker.cases.getCase(verdict.caseId) }
  }
  return { broker, agent, a, b, workspace, audits, open }
}

test('decide closes escalated with authoritative answers and reusable evidence', async t => {
  const f = await fixture(t)
  const { current } = await f.open('decide')
  const decision = [{ id: 'q', selected: ['B'] }]
  const closed = await f.broker.decide({ caseId: current.caseId, answers: decision })
  assert.equal(closed.closing, 'escalated')
  assert.deepEqual(closed.decision.answers, decision)
  assert.ok(f.broker.evidence.candidates({ agentId: f.a.agentId, workspaceKey: f.workspace, scope: { workspaces: [f.workspace] } }).some(ref => ref.locator.caseId === current.caseId))
  assert.ok(f.audits.some(event => event.kind === 'outcome' && event.value.caseId === current.caseId))
})
test('user decision closure and reusable evidence roll back together on evidence failure', async t => {
  const f = await fixture(t)
  const { current } = await f.open('decide-atomic')
  f.broker.store.db.exec(`CREATE TRIGGER reject_user_decision_evidence BEFORE INSERT ON evidence WHEN NEW.source='user_decision' BEGIN SELECT RAISE(ABORT,'forced evidence failure'); END;`)
  await assert.rejects(f.broker.decide({ caseId: current.caseId, answers: [{ id: 'q', selected: ['B'] }] }))
  const after = f.broker.cases.getCase(current.caseId)
  assert.equal(after.state, 'awaiting_user')
  assert.equal(after.decision, null)
  assert.equal(f.broker.store.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE source='user_decision' AND json_extract(locator_json,'$.caseId')=?").get(current.caseId).n, 0)
})

test('reassign uses only an enabled target, records route and evaluates a new Attempt', async t => {
  const f = await fixture(t)
  const { current } = await f.open('reassign')
  await f.broker.profileSetState(f.b.agentId, 'disabled')
  await assert.rejects(f.broker.reassign({ caseId: current.caseId, agentId: f.b.agentId }), error => error.code === 'AGENT_UNAVAILABLE')
  assert.equal(f.broker.cases.getCase(current.caseId).agentId, f.a.agentId)
  assert.ok(f.audits.some(event => event.kind === 'outcome' && event.value.action === 'boundary-reject' && event.value.agentId === f.b.agentId))
  await f.broker.profileSetState(f.b.agentId, 'enabled')
  const result = await f.broker.reassign({ caseId: current.caseId, agentId: f.b.agentId })
  const reassigned = f.broker.cases.getCase(current.caseId)
  assert.equal(reassigned.agentId, f.b.agentId)
  assert.equal(reassigned.attemptCount, 2)
  assert.equal(result.why, 'awaiting_user')
  assert.equal(f.broker.store.db.prepare("SELECT mode FROM route_decisions WHERE case_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(current.caseId).mode, 'manual_reassign')
})

test('cancel interrupts an in-flight Attempt and duplicate delivery never revives it', async t => {
  const f = await fixture(t)
  const { current, request } = await f.open('cancel')
  // Add a second open Attempt through the real awaiting_user -> evaluating guard.
  const evaluating = await f.broker.mutate({ caseId: current.caseId, action: 'retry' })
  await f.broker.attempts.start({ caseId: current.caseId, agentId: f.a.agentId, pins: {}, contextPackHash: 'cancel', packManifest: {} })
  const cancelled = await f.broker.cancel({ caseId: current.caseId })
  assert.equal(cancelled.closing, 'cancelled')
  assert.equal(f.broker.attempts.forCase(current.caseId).at(-1).error.kind, 'interrupted')
  const attempts = f.broker.attempts.forCase(current.caseId).length
  const replay = await f.broker.hook({ agent: f.agent, request })
  assert.equal(replay.why, 'cancelled')
  assert.equal(f.broker.attempts.forCase(current.caseId).length, attempts)
  assert.equal(evaluating.state, 'evaluating')
})

test('explicit retry adds exactly one Attempt; idempotent transport adds none', async t => {
  const f = await fixture(t)
  const { current, request } = await f.open('retry')
  const firstCount = current.attemptCount
  await f.broker.retry({ caseId: current.caseId })
  assert.equal(f.broker.cases.getCase(current.caseId).attemptCount, firstCount + 1)
  const afterRetry = f.broker.cases.getCase(current.caseId).attemptCount
  const replay = await f.broker.hook({ agent: f.agent, request })
  assert.equal(replay.why, 'awaiting_user')
  assert.equal(f.broker.cases.getCase(current.caseId).attemptCount, afterRetry)
})

test('feedback and correction are user-only append-only Broker mutations', async t => {
  const f = await fixture(t)
  const { current } = await f.open('feedback')
  const closed = await f.broker.decide({ caseId: current.caseId, answers: [{ id: 'q', selected: ['A'] }] })
  const before = JSON.stringify(closed.decision)
  await f.broker.feedback({ caseId: current.caseId, verb: 'rating_down' })
  assert.equal(f.broker.cases.getCase(current.caseId).feedbackState, 'disputed')
  await f.broker.feedback({ caseId: current.caseId, verb: 'undo_rating_down' })
  await f.broker.feedback({ caseId: current.caseId, verb: 'comment', payload: { text: 'nuance' } })
  const correction = await f.broker.correction({ caseId: current.caseId, direction: 'Use B', scope: { workspaces: [f.workspace] }, supersedes: [current.caseId] })
  assert.equal(correction.correction, true)
  assert.equal(f.broker.feedbackStore.activeCorrections(f.a.agentId, f.workspace)[0].direction, 'Use B')
  assert.equal(JSON.stringify(f.broker.cases.getCase(current.caseId).decision), before)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE case_id=?').get(current.caseId).n, 4)
  assert.ok(f.audits.filter(event => event.kind === 'feedback').length >= 4)
})
test('explicit retry authorizes exactly one recovery Attempt at exhaustion', async t => {
  const f = await fixture(t)
  let { current } = await f.open('retry-exhausted')
  f.broker.store.db.prepare('UPDATE cases SET max_attempts=attempt_count WHERE case_id=?').run(current.caseId)
  current = f.broker.cases.getCase(current.caseId)
  assert.equal(current.attemptCount, current.maxAttempts)
  await f.broker.retry({ caseId: current.caseId })
  const recovered = f.broker.cases.getCase(current.caseId)
  assert.equal(recovered.attemptCount, current.attemptCount + 1)
  assert.equal(recovered.state, 'awaiting_user')
})

test('reassignment at exhaustion evaluates once instead of stranding evaluating', async t => {
  const f = await fixture(t)
  let { current } = await f.open('reassign-exhausted')
  f.broker.store.db.prepare('UPDATE cases SET max_attempts=attempt_count WHERE case_id=?').run(current.caseId)
  current = f.broker.cases.getCase(current.caseId)
  await f.broker.reassign({ caseId: current.caseId, agentId: f.b.agentId })
  const recovered = f.broker.cases.getCase(current.caseId)
  assert.equal(recovered.agentId, f.b.agentId)
  assert.equal(recovered.attemptCount, current.attemptCount + 1)
  assert.equal(recovered.state, 'awaiting_user')
})

test('retry rejects a disabled or archived pinned Agent before changing state', async t => {
  const f = await fixture(t)
  const { current } = await f.open('retry-disabled')
  await f.broker.profileSetState(f.a.agentId, 'disabled')
  await assert.rejects(f.broker.retry({ caseId: current.caseId }), error => error.code === 'AGENT_UNAVAILABLE')
  const after = f.broker.cases.getCase(current.caseId)
  assert.equal(after.state, 'awaiting_user')
  assert.equal(after.attemptCount, current.attemptCount)
  assert.ok(f.audits.some(event => event.kind === 'outcome' && event.value.action === 'boundary-reject' && event.value.caseId === current.caseId && event.value.agentId === f.a.agentId))
})
