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
  let evaluation = { outcome: 'escalate', missing: ['New judgment'] }
  const ctx = {
    agents: { get: id => id === 'root' ? agent : undefined },
    llm: { stream: () => (async function * () {
      yield { type: 'text-delta', text: JSON.stringify(evaluation) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
  }
  const config = { decisionAgentsEnabled: true, decisionAgentAutoAnswer: true }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => config, audit: (kind, value) => audits.push({ kind, value }) })
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
  return { broker, agent, a, b, workspace, audits, config, open, respond: value => { evaluation = value } }
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

test('reassign rolls back Case ownership and state when the manual route write fails', async t => {
  const f = await fixture(t)
  const { current } = await f.open('reassign-atomic')
  f.broker.store.db.exec(`CREATE TRIGGER reject_manual_reassign BEFORE INSERT ON route_decisions WHEN NEW.mode='manual_reassign' BEGIN SELECT RAISE(ABORT,'forced manual route failure'); END;`)

  await assert.rejects(f.broker.reassign({ caseId: current.caseId, agentId: f.b.agentId }), /forced manual route failure/)
  assert.deepEqual(f.broker.cases.getCase(current.caseId), current)
  assert.deepEqual(f.broker.store.db.prepare('SELECT mode,chosen FROM route_decisions WHERE case_id=? ORDER BY rowid').all(current.caseId).map(row => ({ ...row })), [{ mode: 'pinned', chosen: f.a.agentId }])
  assert.equal(f.broker.attempts.forCase(current.caseId).length, 1)
})

test('unowned reassignment derives from no authoritative choice and appends an immutable target label', async t => {
  const f = await fixture(t)
  await f.broker.setSelector('root', 'auto')
  const waiting = await f.broker.consult({ agent: f.agent, args: { question: 'Choose a route?', request_id: 'unowned-reassign' } })
  assert.equal(waiting.outcome, 'awaiting_user')
  assert.equal(f.broker.cases.getCase(waiting.caseId).agentId, null)
  const before = f.broker.store.db.prepare('SELECT mode,chosen,reason FROM route_decisions WHERE case_id=? ORDER BY rowid').all(waiting.caseId).map(row => ({ ...row }))
  const authorityBefore = before.filter(route => ['pinned', 'explicit', 'auto', 'manual_reassign'].includes(route.mode) && route.chosen)
  assert.equal(authorityBefore.at(-1)?.chosen ?? null, null)

  await f.broker.reassign({ caseId: waiting.caseId, agentId: f.b.agentId })
  const current = f.broker.cases.getCase(waiting.caseId)
  const after = f.broker.store.db.prepare('SELECT mode,chosen,reason FROM route_decisions WHERE case_id=? ORDER BY rowid').all(waiting.caseId).map(row => ({ ...row }))
  assert.deepEqual(after.slice(0, before.length), before)
  assert.deepEqual(after.map(route => route.mode), ['auto', 'manual_reassign'])
  assert.equal(after.at(-1).chosen, f.b.agentId)
  assert.equal(current.agentId, f.b.agentId)
  assert.equal(current.attemptCount, 1)
  assert.deepEqual(f.broker.attempts.forCase(current.caseId).map(attempt => attempt.agentId), [f.b.agentId])
  assert.equal(f.broker.store.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE source='user_decision' AND json_extract(locator_json,'$.caseId')=?").get(current.caseId).n, 0)
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

test('unowned Auto Cases answer and cancel safely but reject retry without side effects', async t => {
  const f = await fixture(t)
  async function openUnowned(key) {
    let current = (await f.broker.cases.createCase({
      workspaceKey: f.workspace, rootSessionId: 'root', entry: 'hook', agentId: null,
      request: { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
      scope: { workspaces: [f.workspace] }, idempotencyKey: key,
    })).case
    await f.broker.cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'auto', reason: 'none:no_candidates' })
    current = await f.broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'no_route' })
    return current
  }

  const answered = await openUnowned('unowned-answer')
  const closed = await f.broker.decide({ caseId: answered.caseId, answers: [{ id: 'q', selected: ['A'] }] })
  assert.equal(closed.closing, 'escalated')
  assert.equal(closed.agentId, null)
  assert.deepEqual(closed.decision.answers, [{ id: 'q', selected: ['A'] }])
  assert.equal(f.broker.store.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE json_extract(locator_json,'$.caseId')=?").get(answered.caseId).n, 0)

  const waitingToCancel = await openUnowned('unowned-cancel')
  const cancelled = await f.broker.cancel({ caseId: waitingToCancel.caseId })
  assert.equal(cancelled.closing, 'cancelled')
  assert.equal(cancelled.agentId, null)
  assert.equal(f.broker.attempts.forCase(cancelled.caseId).length, 0)

  const waitingToRetry = await openUnowned('unowned-retry')
  await assert.rejects(f.broker.retry({ caseId: waitingToRetry.caseId }), error => error.code === 'AGENT_UNAVAILABLE')
  assert.deepEqual(f.broker.cases.getCase(waitingToRetry.caseId), waitingToRetry)
  assert.equal(f.broker.attempts.forCase(waitingToRetry.caseId).length, 0)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 0)
})

async function seedAutoWaiting(f, key, question = {}) {
  const request = {
    entry: 'consult',
    questions: [{
      id: 'question', question: `Auto recovery ${key}?`, options: [{ label: 'A' }, { label: 'B' }],
      ...question,
    }],
  }
  let current = (await f.broker.cases.createCase({
    workspaceKey: f.workspace, rootSessionId: 'root', entry: 'consult', agentId: f.a.agentId,
    request, scope: { workspaces: [f.workspace] }, idempotencyKey: `auto-recovery-${key}`,
  })).case
  await f.broker.cases.recordRoute({
    caseId: current.caseId, rootSessionId: 'root', mode: 'auto', candidates: [{ agentId: f.a.agentId, enabled: true }],
    chosen: f.a.agentId, reason: 'deterministic:single_candidate',
  })
  current = await f.broker.cases.transition({
    caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision,
    state: 'awaiting_user', awaitingReason: 'consult_escalate',
  })
  return current
}

const AUTO_RECOVERY_DENIALS = [
  ['approval', { intent: { kind: 'approval' } }],
  ['plan-review', { intent: { kind: 'plan-review' } }],
  ['high-risk', { question: 'Approve this irreversible high-risk operation?' }],
  ['execution', { question: 'Edit this file with execution authority?' }],
]

for (const action of ['retry', 'reassign']) {
  for (const [label, denial] of AUTO_RECOVERY_DENIALS) {
    test(`Auto ${action} rejects ${label} authority before changing the Case or starting an Attempt`, async t => {
      const f = await fixture(t)
      const current = await seedAutoWaiting(f, `${action}-${label}`, denial)
      const before = f.broker.cases.getCase(current.caseId)
      const pending = action === 'retry'
        ? f.broker.retry({ caseId: current.caseId })
        : f.broker.reassign({ caseId: current.caseId, agentId: f.b.agentId })

      await assert.rejects(pending, error => error.code === 'AUTHORITY')
      assert.deepEqual(f.broker.cases.getCase(current.caseId), before)
      assert.equal(f.broker.attempts.forCase(current.caseId).length, 0)
      assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions WHERE case_id=?').get(current.caseId).n, 1)
    })
  }
}

test('narrowed expertise hints cannot be bypassed by an Auto route on retry', async t => {
  const f = await fixture(t)
  const current = await seedAutoWaiting(f, 'gate-scope-metadata')
  // The retried profile now demands a `src` path prefix the request scope does
  // not carry: its own profile evidence no longer covers the request either, so
  // the Attempt fails closed instead of answering through the old Auto route.
  await f.broker.profileUpsert({
    agentId: f.a.agentId, workspaceKey: f.workspace,
    scope: { workspaces: [f.workspace], paths: ['src'] },
  })
  f.respond({
    outcome: 'answer', claims: [{ text: 'This answer must still respect the narrowed scope', evidenceIds: ['ev_never_in_pack'] }],
    answers: [{ id: 'question', selected: ['A'] }],
  })

  await f.broker.retry({ caseId: current.caseId })
  const attempts = f.broker.attempts.forCase(current.caseId)
  assert.equal(attempts.length, current.maxAttempts)
  assert.equal(attempts.every(attempt => attempt.outcome === 'failed'), true)
  const settled = f.broker.cases.getCase(current.caseId)
  assert.equal(settled.awaitingReason, 'exhausted')
  assert.equal(settled.decision, null)
})

test('domain G6 receives persisted approval intent instead of an empty default', async t => {
  const f = await fixture(t)
  const request = {
    entry: 'consult',
    questions: [{ id: 'question', question: 'Choose under persisted approval intent?', options: [{ label: 'A' }], intent: { kind: 'approval' } }],
  }
  let current = (await f.broker.cases.createCase({
    workspaceKey: f.workspace, rootSessionId: 'root', entry: 'consult', agentId: f.a.agentId,
    request, scope: { workspaces: [f.workspace] }, idempotencyKey: 'pinned-gate-intent-metadata',
  })).case
  await f.broker.cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'pinned', chosen: f.a.agentId, reason: 'Pinned gate fixture' })
  current = await f.broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'consult_escalate' })
  const ref = await f.broker.ensureProfileEvidence(f.a, f.workspace)
  f.respond({
    outcome: 'answer', claims: [{ text: 'This answer must still pass through G6', evidenceIds: [ref.evidenceId] }],
    answers: [{ id: 'question', selected: ['A'] }],
  })

  await f.broker.retry({ caseId: current.caseId })
  const attempt = f.broker.attempts.forCase(current.caseId).at(-1)
  assert.equal(attempt.gates.g2, true)
  assert.equal(attempt.gates.g6, false)
  assert.equal(f.broker.cases.getCase(current.caseId).awaitingReason, 'consult_escalate')
})
