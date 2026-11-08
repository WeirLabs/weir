import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t, mode = 'escalate') {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-turn-'))
  const workspace = realpathSync(dir)
  const audits = []
  const followups = []
  let started = 0
  let allStarted
  const startedPromise = new Promise(resolve => { allStarted = resolve })
  const agent = {
    id: 'root',
    session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) },
    followup: async message => { followups.push(message); if (mode === 'delivery-error') throw new Error('offline') },
  }
  const ctx = {
    agents: { get: id => id === 'root' ? agent : undefined },
    llm: { stream: options => (async function * () {
      if (mode === 'concurrency') {
        started++
        if (started === 4) allStarted()
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      const output = mode === 'return'
        ? { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add scope' }
        : { outcome: 'escalate', missing: ['New judgment'] }
      yield { type: 'text-delta', text: JSON.stringify(output) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: true, decisionAgentMaxConcurrentAttempts: 4 }), audit: (kind, value) => audits.push({ kind, value }) })
  await broker.start()
  const profile = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  await broker.setSelector('root', 'agent', profile.agentId)
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { broker, profile, agent, workspace, audits, followups, startedPromise }
}

async function returnedCase(broker, profile, workspace, originSessionId, key) {
  let current = (await broker.cases.createCase({ workspaceKey: workspace, rootSessionId: 'root', originSessionId, entry: 'consult', agentId: profile.agentId, request: { questions: [] }, scope: { workspaces: [workspace] }, idempotencyKey: key })).case
  current = await broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  const attempt = await broker.attempts.start({ caseId: current.caseId, agentId: profile.agentId, pins: {}, contextPackHash: key, packManifest: {} })
  await broker.attempts.finish(attempt.attemptId, { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add scope' })
  current = broker.cases.getCase(current.caseId)
  return broker.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_revision' })
}

test('turn-stopping closes only the current origin awaiting_revision Cases', async t => {
  const f = await fixture(t, 'return')
  const own = await returnedCase(f.broker, f.profile, f.workspace, 'root', 'own')
  const other = await returnedCase(f.broker, f.profile, f.workspace, 'other', 'other')
  const result = await f.broker.turnStopping({ agent: f.agent })
  assert.deepEqual(result, { closed: 1 })
  assert.equal(f.broker.cases.getCase(own.caseId).closing, 'returned')
  assert.equal(f.broker.cases.getCase(own.caseId).decision.code, 'MISSING_CONTEXT')
  assert.equal(f.broker.cases.getCase(other.caseId).state, 'awaiting_revision')
})

test('consult decision delivers exactly one UserMessage; Hook decision does not deliver', async t => {
  const f = await fixture(t)
  const consulted = await f.broker.consult({ agent: f.agent, args: { question: 'New judgment?', request_id: 'deliver' } })
  await f.broker.decide({ caseId: consulted.caseId, answers: [{ id: 'question', selected: ['A'] }] })
  assert.equal(f.followups.length, 1)
  assert.equal(f.followups[0].role, 'user')
  assert.equal(f.followups[0].source.kind, 'weir-decision')
  assert.ok(f.followups[0].id)
  assert.ok(f.followups[0].content[0].text.includes(consulted.caseId))

  const hooked = await f.broker.hook({ agent: f.agent, request: { questions: [{ id: 'q', question: 'New judgment?' }], wait: { callId: 'hook-no-delivery' } } })
  await f.broker.decide({ caseId: hooked.caseId, answers: [{ id: 'q', selected: ['A'] }] })
  assert.equal(f.followups.length, 1)
})

test('delivery failure preserves the authoritative closing and writes audit', async t => {
  const f = await fixture(t, 'delivery-error')
  const consulted = await f.broker.consult({ agent: f.agent, args: { question: 'New judgment?', request_id: 'delivery-error' } })
  const closed = await f.broker.decide({ caseId: consulted.caseId, answers: [{ id: 'question', selected: ['A'] }] })
  assert.equal(closed.closing, 'escalated')
  assert.equal(f.broker.cases.getCase(closed.caseId).decision.kind, 'user_decision')
  assert.ok(f.audits.some(event => event.kind === 'deliver' && event.value.ok === false))
})

test('four in-flight Attempts saturate the limit; fifth Hook bypasses without a Case', async t => {
  const f = await fixture(t, 'concurrency')
  const pending = []
  for (let index = 0; index < 4; index++) {
    pending.push(f.broker.hook({ agent: f.agent, request: { questions: [{ id: `q${index}`, question: 'New judgment?' }], wait: { callId: `slot-${index}` } } }))
  }
  await f.startedPromise
  assert.equal(f.broker.activeEvaluations, 4)
  const fifth = await f.broker.hook({ agent: f.agent, request: { questions: [{ id: 'q5', question: 'New judgment?' }], wait: { callId: 'slot-5' } } })
  assert.deepEqual(fifth, { kind: 'pass', why: 'bypass' })
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 4)

  const ids = f.broker.store.db.prepare('SELECT case_id FROM cases').all().map(row => row.case_id)
  for (const caseId of ids) await f.broker.cancel({ caseId })
  const verdicts = await Promise.all(pending)
  assert.ok(verdicts.every(verdict => verdict.why === 'cancelled'))
  assert.equal(f.broker.activeEvaluations, 0)
  assert.equal(f.broker.evaluationJobs.size, 0)
  assert.equal(f.broker.store.db.prepare("SELECT COUNT(*) AS n FROM cases WHERE closing='answered'").get().n, 0)
})
