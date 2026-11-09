import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionAttempts } from '../../src/decision/store/attempts.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionEvidence } from '../../src/decision/store/evidence.js'
import { DecisionFeedback } from '../../src/decision/store/feedback.js'
import { DecisionProfiles } from '../../src/decision/store/profiles.js'
import { DecisionQuery } from '../../src/decision/store/query.js'
import { CURRENT_SCHEMA_VERSION, EXPECTED_TABLES } from '../../src/decision/store/schema.js'

const LEGACY_ROOT = 'legacy-off'

function schemaHash(db) {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function historyHash(db) {
  const hash = createHash('sha256')
  for (const table of EXPECTED_TABLES.filter(name => name !== 'selectors')) {
    hash.update(table).update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
  }
  return hash.digest('hex')
}

async function seedLegacyV1(path) {
  const store = openDecisionDatabase(path)
  let clock = 1_000
  const now = () => ++clock
  const profiles = new DecisionProfiles(store, { now })
  const cases = new DecisionCases(store, { now })
  const attempts = new DecisionAttempts(store, { now })
  const evidence = new DecisionEvidence(store, { now })
  const feedback = new DecisionFeedback(store, { now })
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'Legacy Agent' })
  let current = (await cases.createCase({
    workspaceKey: '/repo', rootSessionId: LEGACY_ROOT, originSessionId: LEGACY_ROOT, originKind: 'root', entry: 'hook',
    agentId: profile.agentId, request: { entry: 'hook', questions: [{ id: 'q', question: 'Legacy question', options: [{ label: 'A' }, { label: 'B' }] }] },
    scope: { workspaces: ['/repo'], authorizationClasses: ['A'] }, idempotencyKey: 'legacy-v1', maxAttempts: 3,
  })).case
  current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  let attempt = await attempts.start({ caseId: current.caseId, agentId: profile.agentId, pins: {}, contextPackHash: 'legacy-hash', packManifest: {} })
  attempt = await attempts.finish(attempt.attemptId, { outcome: 'answer', claims: [{ text: 'A', evidenceIds: [] }] })
  current = cases.getCase(current.caseId)
  current = await cases.transition({
    caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'closed', closing: 'answered',
    decision: { kind: 'answer', attemptId: attempt.attemptId, answers: [{ id: 'q', selected: ['A'] }] },
  })
  const ref = await evidence.add({ agentId: profile.agentId, source: 'agent_record', locator: { kind: 'case', caseId: current.caseId }, scope: current.scope })
  await evidence.attach(attempt.attemptId, [ref.evidenceId])
  await feedback.append({ actor: { kind: 'user' }, caseId: current.caseId, attemptId: attempt.attemptId, kind: 'comment', payload: { text: 'Legacy feedback' } })
  await cases.recordRoute({ caseId: current.caseId, rootSessionId: LEGACY_ROOT, mode: 'pinned', candidates: [{ agentId: profile.agentId, enabled: true }], chosen: profile.agentId, reason: 'Legacy pinned route' })
  await profiles.setSelector(LEGACY_ROOT, { mode: 'agent', agentId: profile.agentId })
  await store.write(db => { db.prepare('DELETE FROM selectors WHERE root_session_id=?').run(LEGACY_ROOT) })
  const snapshot = {
    schemaHash: schemaHash(store.db), historyHash: historyHash(store.db),
    tables: store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
    caseId: current.caseId, attemptId: attempt.attemptId, evidenceId: ref.evidenceId, agentId: profile.agentId,
  }
  store.close()
  return snapshot
}

test('legacy v1 history opens read-only while only fresh or explicit actions append Auto rows', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-legacy-v1-'))
  const path = join(dir, 'decision.db')
  let broker
  let cold
  t.after(async () => {
    await broker?.flush()
    await cold?.flush()
    rmSync(dir, { recursive: true, force: true })
  })
  const seeded = await seedLegacyV1(path)
  assert.equal(CURRENT_SCHEMA_VERSION, 1)

  const legacy = openDecisionDatabase(path)
  assert.equal(legacy.db.prepare('PRAGMA user_version').get().user_version, 1)
  assert.deepEqual(legacy.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), seeded.tables)
  assert.equal(schemaHash(legacy.db), seeded.schemaHash)
  assert.equal(historyHash(legacy.db), seeded.historyHash)
  assert.deepEqual(new DecisionProfiles(legacy).selector(LEGACY_ROOT), { mode: 'off' })
  const detail = new DecisionQuery(legacy).record({ caseId: seeded.caseId, sessionId: LEGACY_ROOT })
  assert.equal(detail.case.caseId, seeded.caseId)
  assert.deepEqual(detail.attempts.map(row => row.attemptId), [seeded.attemptId])
  assert.deepEqual(detail.attempts[0].evidence.map(row => row.evidenceId), [seeded.evidenceId])
  assert.deepEqual(detail.feedback.map(row => row.kind), ['comment'])
  assert.deepEqual(detail.routeDecisions.map(row => row.mode), ['pinned'])
  legacy.close()

  const config = {
    decisionAgentsEnabled: true, decisionAgentSelectorDefault: 'auto', decisionAgentRetentionDays: 0,
    decisionAgentAutoAnswerClasses: [], decisionAgentAutoShadow: false,
  }
  broker = new DecisionBroker({ config: () => ({ ...config, decisionAgentStorePath: dir }) })
  await broker.start()
  assert.deepEqual(broker.status(), { available: true, enabled: true })
  const agent = id => ({ id, session: { header: { id, cwd: dir, delegationDepth: 0 } } })
  assert.deepEqual(await broker.initializeSelectorDefault({ agent: agent(LEGACY_ROOT), source: 'resume' }), { mode: 'off' })
  assert.equal(broker.store.db.prepare('SELECT 1 FROM selectors WHERE root_session_id=?').get(LEGACY_ROOT), undefined)
  assert.equal(schemaHash(broker.store.db), seeded.schemaHash)
  assert.equal(historyHash(broker.store.db), seeded.historyHash)
  assert.equal(existsSync(join(dir, 'backups')), false)

  await broker.initializeSelectorDefault({ agent: agent('fresh-auto'), source: 'startup' })
  await broker.setSelector('explicit-auto', 'auto')
  await broker.setSelector('explicit-off', 'off')
  assert.deepEqual(broker.store.db.prepare('SELECT root_session_id,mode,agent_id FROM selectors ORDER BY root_session_id').all().map(row => ({ ...row })), [
    { root_session_id: 'explicit-auto', mode: 'auto', agent_id: null },
    { root_session_id: 'explicit-off', mode: 'off', agent_id: null },
    { root_session_id: 'fresh-auto', mode: 'auto', agent_id: null },
  ])
  assert.equal(historyHash(broker.store.db), seeded.historyHash)
  assert.equal(schemaHash(broker.store.db), seeded.schemaHash)
  assert.equal(broker.store.db.prepare('PRAGMA user_version').get().user_version, 1)
  await broker.flush()

  cold = new DecisionBroker({ config: () => ({ ...config, decisionAgentStorePath: dir }) })
  await cold.start()
  assert.deepEqual(cold.selector(LEGACY_ROOT), { mode: 'off' })
  assert.deepEqual(cold.selector('fresh-auto'), { mode: 'auto' })
  assert.deepEqual(cold.selector('explicit-auto'), { mode: 'auto' })
  assert.deepEqual(cold.selector('explicit-off'), { mode: 'off' })
  assert.equal(cold.store.db.prepare('PRAGMA user_version').get().user_version, 1)
  assert.equal(historyHash(cold.store.db), seeded.historyHash)
  assert.equal(schemaHash(cold.store.db), seeded.schemaHash)
  assert.equal(existsSync(join(dir, 'backups')), false)
})
