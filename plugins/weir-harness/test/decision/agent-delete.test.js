// Assistant permanent delete (OpenSpec decision-agent-delete): a single
// transaction cascades every record the assistant owns, guarded by the
// previewed case count, audited on success, and refused without writes when
// the counts went stale or the assistant is unknown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { createDecisionRemoteService, DECISION_REMOTE_METHODS } from '../../src/decision/remote.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-delete-'))
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
  const broker = new DecisionBroker({
    profileContext: { home: dir, name: 'test' }, ctx,
    config: () => ({ decisionAgentsEnabled: true, decisionAgentAutoAnswerClasses: ['A', 'B', 'C'] }),
    audit: (kind, value) => audits.push({ kind, value }),
  })
  await broker.start()
  const a = await broker.profileUpsert({ workspaceKey: workspace, name: 'Delete me' })
  await broker.setSelector('root', 'agent', a.agentId)
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  async function open(callId) {
    const verdict = await broker.hook({ agent, request: { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }] }], wait: { callId } } })
    return broker.cases.getCase(verdict.caseId)
  }
  const count = (sql, id) => broker.store.db.prepare(sql).get(id)?.n ?? 0
  const counts = agentId => ({
    cases: count('SELECT COUNT(*) n FROM cases WHERE agent_id=?', agentId),
    attempts: count('SELECT COUNT(*) n FROM attempts WHERE agent_id=?', agentId),
    evidence: count('SELECT COUNT(*) n FROM evidence WHERE agent_id=?', agentId),
    feedback: count('SELECT COUNT(*) n FROM feedback WHERE agent_id=?', agentId),
    corrections: count('SELECT COUNT(*) n FROM corrections WHERE agent_id=?', agentId),
    attemptEvidence: count('SELECT COUNT(*) n FROM attempt_evidence WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE agent_id=?)', agentId),
    routeDecisions: count('SELECT COUNT(*) n FROM route_decisions WHERE case_id IN (SELECT case_id FROM cases WHERE agent_id=?)', agentId),
    learningRuns: count('SELECT COUNT(*) n FROM learning_runs WHERE agent_id=?', agentId),
    snapshots: count('SELECT COUNT(*) n FROM memory_snapshots WHERE agent_id=?', agentId),
    revisions: count('SELECT COUNT(*) n FROM agent_profile_revisions WHERE agent_id=?', agentId),
    profiles: count('SELECT COUNT(*) n FROM agent_profiles WHERE agent_id=?', agentId),
  })
  return { broker, agent, a, workspace, audits, open, counts }
}

test('preview reports the real per-family counts and delete cascades in one audited transaction', async t => {
  const f = await fixture(t)
  const current = await f.open('delete-cascade')
  await f.broker.decide({ caseId: current.caseId, answers: [{ id: 'q', selected: ['A'] }] })
  await f.broker.feedback({ caseId: current.caseId, verb: 'comment', payload: { text: 'noted' } })
  // One learning run plus one public-zone snapshot round out the families.
  f.broker.store.db.prepare(`INSERT INTO learning_runs(learning_run_id,agent_id,trigger,input_frozen_json,operations_json,outcome,zone,namespace_workspace_key,created_at,updated_at)
    VALUES('lr_del',?,'manual','{}','[]','published','workspace',?,1,1)`).run(f.a.agentId, f.workspace)
  f.broker.store.db.prepare(`INSERT INTO memory_snapshots(snapshot_id,agent_id,version,state,principles_json,generated_description_json,zone,namespace_workspace_key,created_at,updated_at)
    VALUES('ms_del',?,1,'published','[]','{}','public',NULL,1,1)`).run(f.a.agentId)

  const preview = await f.broker.profileDeletePreview({ agentId: f.a.agentId })
  assert.equal(preview.name, 'Delete me')
  assert.equal(preview.counts.cases, 1)
  assert.equal(preview.counts.attempts >= 1, true)
  assert.equal(preview.counts.evidence >= 1, true)
  assert.equal(preview.counts.feedback, 1)
  assert.equal(preview.counts.learningRuns, 1)
  assert.equal(preview.counts.snapshots, 1)

  const result = await f.broker.profileDelete({ agentId: f.a.agentId, expectedCases: 1 })
  assert.equal(result.agentId, f.a.agentId)
  const left = f.counts(f.a.agentId)
  for (const [family, value] of Object.entries(left)) assert.equal(value, 0, family)
  const audit = f.audits.find(event => event.kind === 'agent-profile' && event.value.action === 'delete')
  assert.ok(audit)
  assert.equal(audit.value.agentId, f.a.agentId)
  assert.equal(audit.value.name, 'Delete me')
  assert.equal(audit.value.counts.cases, 1)
  assert.equal(await f.broker.profileDeletePreview({ agentId: f.a.agentId }), null)
})

test('stale case count refuses the delete without writing anything', async t => {
  const f = await fixture(t)
  const first = await f.open('stale-guard')
  await f.broker.decide({ caseId: first.caseId, answers: [{ id: 'q', selected: ['A'] }] })
  const preview = await f.broker.profileDeletePreview({ agentId: f.a.agentId })
  await f.open('stale-guard-2')
  await assert.rejects(
    f.broker.profileDelete({ agentId: f.a.agentId, expectedCases: preview.counts.cases }),
    error => error?.code === 'DELETE_COUNTS_STALE',
  )
  const left = f.counts(f.a.agentId)
  assert.equal(left.cases, 2)
  assert.equal(left.profiles, 1)
})

test('unknown assistant and selector preservation follow the contract', async t => {
  const f = await fixture(t)
  await assert.rejects(f.broker.profileDelete({ agentId: 'ag_missing', expectedCases: 0 }), error => error?.code === 'AGENT_NOT_FOUND')
  assert.equal(await f.broker.profileDeletePreview({ agentId: 'ag_missing' }), null)
  // A root session pinned to the deleted assistant keeps its selector row.
  await f.broker.setSelector('root', 'agent', f.a.agentId)
  await f.broker.profileDelete({ agentId: f.a.agentId, expectedCases: 0 })
  const selector = f.broker.store.db.prepare('SELECT mode,agent_id FROM selectors WHERE root_session_id=?').get('root')
  assert.equal(selector.mode, 'agent')
  assert.equal(selector.agent_id, f.a.agentId)
})

test('a mid-cascade failure rolls the whole transaction back', async t => {
  const f = await fixture(t)
  const current = await f.open('rollback')
  await f.broker.decide({ caseId: current.caseId, answers: [{ id: 'q', selected: ['A'] }] })
  await f.broker.feedback({ caseId: current.caseId, verb: 'comment', payload: { text: 'keep me' } })
  f.broker.store.db.exec(`CREATE TRIGGER reject_delete_feedback BEFORE DELETE ON feedback BEGIN SELECT RAISE(ABORT,'forced cascade failure'); END;`)
  await assert.rejects(f.broker.profileDelete({ agentId: f.a.agentId, expectedCases: 1 }))
  const left = f.counts(f.a.agentId)
  assert.equal(left.cases, 1)
  assert.equal(left.profiles, 1)
  assert.equal(f.audits.some(event => event.kind === 'agent-profile' && event.value.action === 'delete'), false)
})

test('remote exposes both delete methods as bare-args calls with server-derived semantics', async () => {
  for (const method of ['profileDeletePreview', 'profileDelete']) assert.equal(DECISION_REMOTE_METHODS.includes(method), true, method)
  const calls = []
  const broker = {
    status: () => ({ available: true }),
    sessionContext: async sessionId => ({ rootSessionId: `root-of-${sessionId}`, workspaceKey: '/ws' }),
    profileDeletePreview: async input => { calls.push(['preview', input]); return null },
    profileDelete: async input => { calls.push(['delete', input]); return { agentId: input.agentId, counts: {} } },
  }
  const remote = createDecisionRemoteService({ broker: () => broker })
  await remote.profileDeletePreview({ agentId: 'ag_x', workspaceKey: '/forged' })
  await remote.profileDelete({ agentId: 'ag_x', expectedCases: 2, sessionId: 's1', workspaceKey: '/forged' })
  assert.deepEqual(calls, [
    ['preview', { agentId: 'ag_x' }],
    ['delete', { agentId: 'ag_x', expectedCases: 2 }],
  ])
})
