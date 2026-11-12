// Real v1 -> v2 migration fixture: legacy workspace-owned profiles, a published
// private Snapshot, and an active Learning Run survive the rebuild without row
// loss, re-keying, identity merging, or memory re-zoning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { restoreConsistentBackup } from '../../src/decision/store/migrate.js'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/decision/store/schema.js'
import { DecisionProfiles } from '../../src/decision/store/profiles.js'
import { DecisionLearning } from '../../src/decision/store/learning.js'

const W1 = '/repo/one'
const W2 = '/repo/two'
const CONTENT_HASH_PRINCIPLES = [{ principleId: 'pr_one', text: 'Prefer A', scope: { workspaces: [W1] }, sources: ['dc_one'], state: 'active' }]

/** @param {import('node:test').TestContext} t */
function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-v2-migration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Build a genuine schema-v1 database. Only `MIGRATIONS[0]` is applied, so the
 * rows below use the exact v1 column set — including `agent_profiles.workspace_key`.
 * @param {string} path
 */
function seedV1(path) {
  const store = openDecisionDatabase(path, { migrations: [MIGRATIONS[0]] })
  const db = store.db
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
  const profile = (agentId, workspaceKey, name, extra = {}) => {
    db.prepare(`INSERT INTO agent_profiles(
      agent_id,workspace_key,name,state,scope_json,user_desc_rev,chain_json,archived_at,
      schema_version,revision,created_at,updated_at
    ) VALUES(?,?,?,?,?,1,'{"chain":[]}',?,1,1,?,?)`).run(
      agentId, workspaceKey, name, extra.state ?? 'enabled',
      JSON.stringify({ workspaces: [workspaceKey], paths: ['src'], authorizationClasses: ['A', 'B', 'C'] }),
      extra.archivedAt ?? null, extra.createdAt ?? 1, extra.createdAt ?? 1,
    )
    db.prepare('INSERT INTO agent_profile_revisions(agent_id,kind,revision,text,created_at) VALUES(?,?,1,?,?)')
      .run(agentId, 'user', `Preference of ${name}`, extra.createdAt ?? 1)
  }
  profile('ag_one_w1', W1, 'copy-tone', { createdAt: 1 })
  profile('ag_one_w2', W2, 'copy-tone', { createdAt: 2 })
  profile('ag_suffixed', W2, 'copy-tone · 2', { createdAt: 3 })
  profile('ag_archived', W1, 'Retired', { state: 'archived', archivedAt: 9, createdAt: 4 })

  db.prepare(`INSERT INTO cases(
    case_id,workspace_key,root_session_id,origin_session_id,origin_kind,entry,agent_id,
    request_json,scope_json,idempotency_key,state,closing,attempt_count,max_attempts,
    feedback_state,needs_review,decision_json,closed_at,schema_version,revision,created_at,updated_at
  ) VALUES('dc_w1',?,?,?,?,?,?,?,?,?,?,?,1,3,'none',0,?,?,1,1,10,10)`).run(
    W1, 'root1', 'root1', 'root', 'hook', 'ag_one_w1',
    JSON.stringify({ entry: 'hook', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }] }] }),
    JSON.stringify({ workspaces: [W1] }), 'legacy-case',
    'closed', 'answered', JSON.stringify({ kind: 'answer', attemptId: 'at_w1', answers: [{ id: 'q', selected: ['A'] }] }), 10,
  )
  db.prepare(`INSERT INTO attempts(
    attempt_id,case_id,attempt_no,agent_id,outcome,cited_evidence_ids_json,pins_json,
    context_pack_hash,pack_manifest_json,started_at,ended_at,schema_version,revision,created_at,updated_at
  ) VALUES('at_w1','dc_w1',1,'ag_one_w1','answer','["ev_w1"]','{"memorySnapshotId":"ms_w1_public"}','legacy-hash','{"layerSizes":{"L5":1},"evidenceIds":["ev_w1"],"correctionIds":[],"omissions":[]}',10,11,1,1,10,11)`).run()
  db.prepare(`INSERT INTO evidence(
    evidence_id,agent_id,source,locator_json,excerpt,scope_json,status,schema_version,revision,created_at,updated_at
  ) VALUES('ev_w1','ag_one_w1','user_decision','{"kind":"case","caseId":"dc_w1"}','Legacy basis',?,'active',1,1,10,10)`).run(JSON.stringify({ workspaces: [W1] }))
  db.prepare(`INSERT INTO feedback(
    feedback_id,case_id,attempt_id,agent_id,actor,kind,payload_json,effect_json,schema_version,revision,created_at,updated_at
  ) VALUES('fb_w1','dc_w1','at_w1','ag_one_w1','user','rating_up','{}','{}',1,1,12,12)`).run()

  const frozen = (workspaceKey) => JSON.stringify({
    requestId: 'legacy-run', workspaceKey, startedAt: 20, agentProfileRevision: 1,
    caseIds: ['dc_w1'], feedbackIds: [], revisions: { dc_w1: 1 },
    feedbackDigest: '0'.repeat(64), parentSnapshotId: null, parentSnapshotRevision: null,
    promptVersion: 'consolidation-contract/1', modelRoute: { kind: 'inherited', provider: 'p', model: 'm' },
    inputHash: '1'.repeat(64),
  })
  db.prepare(`INSERT INTO learning_runs(
    learning_run_id,agent_id,trigger,input_frozen_json,operations_json,replay_json,outcome,
    schema_version,revision,created_at,updated_at
  ) VALUES('lr_w1','ag_one_w1','manual',?,'[]',NULL,'published',1,2,20,21)`).run(frozen(W1))
  db.prepare(`INSERT INTO memory_snapshots(
    snapshot_id,agent_id,version,parent_snapshot_id,state,principles_json,generated_description_json,
    learning_run_id,schema_version,revision,created_at,updated_at
  ) VALUES('ms_w1','ag_one_w1',1,NULL,'published',?,'{"revision":0,"text":""}','lr_w1',1,2,20,21)`)
    .run(JSON.stringify(CONTENT_HASH_PRINCIPLES))

  const counts = {}
  for (const table of ['agent_profiles', 'cases', 'attempts', 'evidence', 'feedback', 'learning_runs', 'memory_snapshots']) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  }
  const rows = {
    cases: JSON.stringify(db.prepare('SELECT * FROM cases ORDER BY case_id').all()),
    attempts: JSON.stringify(db.prepare('SELECT * FROM attempts ORDER BY attempt_id').all()),
    evidence: JSON.stringify(db.prepare('SELECT * FROM evidence ORDER BY evidence_id').all()),
    feedback: JSON.stringify(db.prepare('SELECT * FROM feedback ORDER BY feedback_id').all()),
    principles: JSON.stringify(CONTENT_HASH_PRINCIPLES),
  }
  store.close()
  return { counts, rows }
}

test('schema v2 migrates workspace-owned profiles and private memory without row loss', t => {
  const dir = root(t)
  const path = join(dir, 'decision.db')
  const seeded = seedV1(path)

  const store = openDecisionDatabase(path)
  const profiles = new DecisionProfiles(store)
  const learning = new DecisionLearning(store)
  t.after(() => store.close())

  assert.equal(CURRENT_SCHEMA_VERSION, 2)
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')

  // Exactly one consistent backup of the v1 database, before any migration write.
  const backups = readdirSync(join(dir, 'backups'))
  assert.equal(backups.length, 1)
  assert.match(backups[0], /^decision-v1-/)
  const backup = new DatabaseSync(join(dir, 'backups', backups[0]))
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1)
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM agent_profiles').get().n, 4)
  assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  backup.close()

  // No row loss, no cross-Agent re-keying.
  for (const [table, count] of Object.entries(seeded.counts)) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, count, table)
  }
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM cases ORDER BY case_id').all()), seeded.rows.cases)
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM attempts ORDER BY attempt_id').all()), seeded.rows.attempts)
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM evidence ORDER BY evidence_id').all()), seeded.rows.evidence)
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM feedback ORDER BY feedback_id').all()), seeded.rows.feedback)

  // Every identity survives separately: no automatic merge on a shared name.
  const list = profiles.listProfiles({ includeArchived: true })
  assert.deepEqual(list.map(profile => profile.agentId).sort(), ['ag_archived', 'ag_one_w1', 'ag_one_w2', 'ag_suffixed'])
  const byId = new Map(list.map(profile => [profile.agentId, profile]))
  assert.equal(byId.get('ag_one_w1').name, 'copy-tone')
  assert.equal(byId.get('ag_one_w2').name, 'copy-tone · 3')
  assert.equal(byId.get('ag_suffixed').name, 'copy-tone · 2')
  assert.equal(byId.get('ag_archived').state, 'archived')
  assert.ok(byId.get('ag_archived').archivedAt)

  // The legacy workspace is only an opaque origin alias.
  for (const profile of list) {
    assert.equal('workspaceKey' in profile, false)
    assert.match(profile.legacyOriginAlias, /^origin_[a-f0-9]{12}$/)
    assert.notEqual(profile.legacyOriginAlias, W1)
    assert.equal(JSON.stringify(profile).includes('/repo/'), false)
  }
  assert.equal(byId.get('ag_one_w1').legacyOriginAlias, byId.get('ag_one_w1').legacyOriginAlias.toLowerCase())

  // Scope JSON is normalized: the legacy workspace array is gone, hints kept.
  for (const profile of list) {
    assert.deepEqual(profile.scope, { paths: ['src'], authorizationClasses: ['A', 'B', 'C'] })
    assert.equal('workspaces' in profile.scope, false)
  }

  // Private memory inherits its workspace; the public zone starts empty.
  const snapshot = learning.currentSnapshot('ag_one_w1', W1)
  assert.equal(snapshot.snapshotId, 'ms_w1')
  assert.equal(snapshot.zone, 'workspace')
  assert.equal(snapshot.namespaceWorkspaceKey, W1)
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.state, 'published')
  assert.deepEqual(snapshot.principles, CONTENT_HASH_PRINCIPLES)
  assert.equal(learning.currentSnapshot('ag_one_w1', W2), null)
  assert.equal(learning.currentSnapshot('ag_one_w1', null, 'public'), null)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM memory_snapshots WHERE zone='public'").get().n, 0)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM learning_runs WHERE zone='public'").get().n, 0)
  const run = learning.getRunById('lr_w1')
  assert.equal(run.zone, 'workspace')
  assert.equal(run.namespaceWorkspaceKey, W1)
  assert.equal(run.outcome, 'published')

  // Record envelopes stay at v1: the database version changed, row shapes did not.
  for (const table of ['agent_profiles', 'cases', 'attempts', 'evidence', 'feedback', 'learning_runs', 'memory_snapshots']) {
    const distinct = store.db.prepare(`SELECT DISTINCT schema_version FROM ${table}`).all().map(row => row.schema_version)
    assert.deepEqual(distinct, [1], table)
  }
  // An old Attempt keeps its legacy single pin: no public pin is invented.
  const pins = JSON.parse(store.db.prepare("SELECT pins_json FROM attempts WHERE attempt_id='at_w1'").get().pins_json)
  assert.deepEqual(pins, { memorySnapshotId: 'ms_w1_public' })
  assert.equal('publicMemorySnapshotId' in pins, false)
})

test('reopening a migrated database neither migrates again nor rewrites history', t => {
  const dir = root(t)
  const path = join(dir, 'decision.db')
  seedV1(path)
  const first = openDecisionDatabase(path)
  const before = JSON.stringify(first.db.prepare('SELECT * FROM memory_snapshots ORDER BY snapshot_id').all())
  first.close()
  const second = openDecisionDatabase(path)
  t.after(() => second.close())
  assert.equal(second.db.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(readdirSync(join(dir, 'backups')).length, 1)
  assert.equal(JSON.stringify(second.db.prepare('SELECT * FROM memory_snapshots ORDER BY snapshot_id').all()), before)
})

test('older code refuses a version 2 database instead of half-reading it', t => {
  const dir = root(t)
  const path = join(dir, 'decision.db')
  seedV1(path)
  openDecisionDatabase(path).close()
  assert.throws(
    () => openDecisionDatabase(path, { migrations: [MIGRATIONS[0]] }),
    error => error?.code === 'SCHEMA_TOO_NEW',
  )
  const check = new DatabaseSync(path)
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 1)
  check.close()
})

test('a broken v2 migration rolls back and leaves the original database usable', t => {
  const dir = root(t)
  const path = join(dir, 'decision.db')
  const seeded = seedV1(path)
  const broken = [...MIGRATIONS[1], 'INVALID SQL']
  assert.throws(() => openDecisionDatabase(path, { migrations: [MIGRATIONS[0], broken] }), /SQLITE_ERROR|syntax error/)
  const check = new DatabaseSync(path)
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1)
  assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM agent_profiles').get().n, seeded.counts.agent_profiles)
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='agent_profiles_v2'").get(), undefined)
  check.close()
})

test('a consistent backup restores over a live WAL database and clears stale sidecars', t => {
  const dir = root(t)
  const path = join(dir, 'decision.db')
  seedV1(path)
  const migrated = openDecisionDatabase(path)
  // Writes made after the successful migration: restoring the backup discards them.
  migrated.db.prepare("INSERT INTO selectors(root_session_id,mode,agent_id,revision,updated_at) VALUES('post-migration','auto',NULL,1,1)").run()
  migrated.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
  assert.ok(existsSync(`${path}-wal`), 'the live database is in WAL mode')
  migrated.close()

  const backupPath = join(dir, 'backups', readdirSync(join(dir, 'backups'))[0])
  restoreConsistentBackup(path, backupPath)
  assert.equal(existsSync(`${path}-wal`), false)
  assert.equal(existsSync(`${path}-shm`), false)

  const restored = openDecisionDatabase(path)
  t.after(() => restored.close())
  assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM selectors WHERE root_session_id='post-migration'").get().n, 0)
  assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 1)
  assert.deepEqual(new DecisionProfiles(restored).listProfiles({ includeArchived: true }).map(profile => profile.agentId).sort(), ['ag_archived', 'ag_one_w1', 'ag_one_w2', 'ag_suffixed'])
})

test('schema v2 enforces per-namespace version and active-run exclusivity despite NULL semantics', t => {
  const dir = root(t)
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  t.after(() => store.close())
  const learning = new DecisionLearning(store)
  const insertRun = (id, agentId, zone, namespace, outcome) => store.db.prepare(`INSERT INTO learning_runs(
    learning_run_id,agent_id,zone,namespace_workspace_key,trigger,input_frozen_json,operations_json,replay_json,outcome,
    schema_version,revision,created_at,updated_at
  ) VALUES(?,?,?,?,'manual','{}','[]',NULL,?,1,1,1,1)`).run(id, agentId, zone, namespace, outcome)

  // The public zone (NULL namespace) still allows only one active run per Agent.
  insertRun('lr_public_a', 'ag_a', 'public', null, 'running')
  assert.throws(() => insertRun('lr_public_b', 'ag_a', 'public', null, 'candidate'), /UNIQUE|constraint/)
  insertRun('lr_public_other_agent', 'ag_b', 'public', null, 'running')

  // Private zones are independent per workspace, and public never blocks private.
  insertRun('lr_w1', 'ag_a', 'workspace', W1, 'running')
  insertRun('lr_w2', 'ag_a', 'workspace', W2, 'running')
  assert.throws(() => insertRun('lr_w1_dup', 'ag_a', 'workspace', W1, 'candidate'), /UNIQUE|constraint/)

  // A settled public run frees the slot again.
  store.db.prepare("UPDATE learning_runs SET outcome='published' WHERE learning_run_id='lr_public_a'").run()
  insertRun('lr_public_c', 'ag_a', 'public', null, 'running')

  const insertSnapshot = (id, agentId, zone, namespace, version) => store.db.prepare(`INSERT INTO memory_snapshots(
    snapshot_id,agent_id,zone,namespace_workspace_key,version,parent_snapshot_id,state,principles_json,
    generated_description_json,learning_run_id,schema_version,revision,created_at,updated_at
  ) VALUES(?,?,?,?,?,NULL,'published','[]','{"revision":0,"text":""}','lr_x',1,1,1,1)`).run(id, agentId, zone, namespace, version)
  insertSnapshot('ms_w1_v1', 'ag_a', 'workspace', W1, 1)
  insertSnapshot('ms_w2_v1', 'ag_a', 'workspace', W2, 1)
  insertSnapshot('ms_public_v1', 'ag_a', 'public', null, 1)
  assert.throws(() => insertSnapshot('ms_public_v1_dup', 'ag_a', 'public', null, 1), /UNIQUE|constraint/)
  assert.throws(() => insertSnapshot('ms_w1_v1_dup', 'ag_a', 'workspace', W1, 1), /UNIQUE|constraint/)

  // A namespace row that contradicts its zone is rejected on read.
  store.db.prepare("UPDATE memory_snapshots SET namespace_workspace_key=? WHERE snapshot_id='ms_public_v1'").run(W2)
  assert.throws(() => learning.getSnapshotById('ms_public_v1'), error => error.code === 'INVALID_NAMESPACE')
})
