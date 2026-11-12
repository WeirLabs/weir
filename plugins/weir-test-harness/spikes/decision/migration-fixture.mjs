// Migration fixture generator for the cross-workspace memory change.
//
// Produces durable, reviewable artifacts (not assertions — those live in
// test/decision/migration-v2.test.js): it seeds a genuine schema-v1 database
// with legacy workspace-owned rows, migrates it with the production code, and
// records a before/after report plus both database files.
//
//   node plugins/weir-test-harness/spikes/decision/migration-fixture.mjs [outDir]
//
// Default output: <repo>/.weir/decision-cross-workspace-memory/migration
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openDecisionDatabase } from '../../../../plugins/weir-harness/src/decision/store/db.js'
import { MIGRATIONS } from '../../../../plugins/weir-harness/src/decision/store/schema.js'
import { DecisionProfiles } from '../../../../plugins/weir-harness/src/decision/store/profiles.js'
import { DecisionLearning } from '../../../../plugins/weir-harness/src/decision/store/learning.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../..')
const OUT = process.argv[2] ? resolve(process.argv[2]) : join(REPO, '.weir', 'decision-cross-workspace-memory', 'migration')
const V1 = join(OUT, 'fixture-v1.db')
const MIGRATED = join(OUT, 'fixture-v1-migrated.db')
const REPORT = join(OUT, 'fixture-report.json')
const BACKUPS = join(OUT, 'backups')
const W1 = '/repo/one'
const W2 = '/repo/two'
const PRINCIPLES = [{ principleId: 'pr_one', text: 'Prefer A', scope: { workspaces: [W1] }, sources: ['dc_one'], state: 'active' }]
const TABLES = ['agent_profiles', 'agent_profile_revisions', 'cases', 'attempts', 'evidence', 'feedback', 'corrections', 'route_decisions', 'selectors', 'learning_runs', 'memory_snapshots']
// Only these carry a record envelope; the join/side tables never did.
const ENVELOPE_TABLES = ['agent_profiles', 'cases', 'attempts', 'evidence', 'feedback', 'route_decisions', 'learning_runs', 'memory_snapshots']

// Every file is removed, including the WAL/SHM sidecars of a previous run: a
// stale -wal would be replayed over a freshly copied main file and quietly hand
// back the earlier migrated state.
for (const path of [V1, MIGRATED]) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
}
rmSync(BACKUPS, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ---- 1. a real v1 database with legacy workspace-owned rows -----------------
const seed = openDecisionDatabase(V1, { migrations: [MIGRATIONS[0]] })
const db = seed.db
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
  JSON.stringify({ workspaces: [W1] }), 'legacy-case', 'closed', 'answered',
  JSON.stringify({ kind: 'answer', attemptId: 'at_w1', answers: [{ id: 'q', selected: ['A'] }] }), 10,
)
db.prepare(`INSERT INTO attempts(
  attempt_id,case_id,attempt_no,agent_id,outcome,cited_evidence_ids_json,pins_json,
  context_pack_hash,pack_manifest_json,started_at,ended_at,schema_version,revision,created_at,updated_at
) VALUES('at_w1','dc_w1',1,'ag_one_w1','answer','["ev_w1"]','{"memorySnapshotId":"ms_w1"}','legacy-hash',
  '{"layerSizes":{"L5":1},"evidenceIds":["ev_w1"],"correctionIds":[],"omissions":[]}',10,11,1,1,10,11)`).run()
db.prepare(`INSERT INTO evidence(
  evidence_id,agent_id,source,locator_json,excerpt,scope_json,status,schema_version,revision,created_at,updated_at
) VALUES('ev_w1','ag_one_w1','user_decision','{"kind":"case","caseId":"dc_w1"}','Legacy basis',?,'active',1,1,10,10)`)
  .run(JSON.stringify({ workspaces: [W1] }))
db.prepare(`INSERT INTO feedback(
  feedback_id,case_id,attempt_id,agent_id,actor,kind,payload_json,effect_json,schema_version,revision,created_at,updated_at
) VALUES('fb_w1','dc_w1','at_w1','ag_one_w1','user','rating_up','{}','{}',1,1,12,12)`).run()
db.prepare(`INSERT INTO learning_runs(
  learning_run_id,agent_id,trigger,input_frozen_json,operations_json,replay_json,outcome,
  schema_version,revision,created_at,updated_at
) VALUES('lr_w1','ag_one_w1','manual',?,'[]',NULL,'published',1,2,20,21)`).run(JSON.stringify({
  requestId: 'legacy-run', workspaceKey: W1, startedAt: 20, agentProfileRevision: 1,
  caseIds: ['dc_w1'], feedbackIds: [], revisions: { dc_w1: 1 },
  feedbackDigest: '0'.repeat(64), parentSnapshotId: null, parentSnapshotRevision: null,
  promptVersion: 'consolidation-contract/1', modelRoute: { kind: 'inherited', provider: 'p', model: 'm' },
  inputHash: '1'.repeat(64),
}))
db.prepare(`INSERT INTO memory_snapshots(
  snapshot_id,agent_id,version,parent_snapshot_id,state,principles_json,generated_description_json,
  learning_run_id,schema_version,revision,created_at,updated_at
) VALUES('ms_w1','ag_one_w1',1,NULL,'published',?,'{"revision":0,"text":""}','lr_w1',1,2,20,21)`)
  .run(JSON.stringify(PRINCIPLES))

const countOf = (handle, table) => handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
const rowsOf = (handle, table, key) => JSON.stringify(handle.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all())
const before = Object.fromEntries(TABLES.map(table => [table, countOf(db, table)]))
const beforeRows = {
  cases: rowsOf(db, 'cases', 'case_id'),
  attempts: rowsOf(db, 'attempts', 'attempt_id'),
  evidence: rowsOf(db, 'evidence', 'evidence_id'),
  feedback: rowsOf(db, 'feedback', 'feedback_id'),
}
const beforeVersion = db.prepare('PRAGMA user_version').get().user_version
// A WAL-mode database must be checkpointed before a byte copy, or the copied
// file carries none of the committed pages.
db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
seed.close()
for (const suffix of ['-wal', '-shm']) rmSync(`${V1}${suffix}`, { force: true })
copyFileSync(V1, MIGRATED)
for (const suffix of ['-wal', '-shm']) rmSync(`${MIGRATED}${suffix}`, { force: true })

// ---- 2. migrate with the production code ------------------------------------
const copied = new DatabaseSync(MIGRATED, { readOnly: true })
const copiedVersion = copied.prepare('PRAGMA user_version').get().user_version
const copiedSnapshots = copied.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n
copied.close()
const migrated = openDecisionDatabase(MIGRATED)
const profiles = new DecisionProfiles(migrated)
const learning = new DecisionLearning(migrated)
const after = Object.fromEntries(TABLES.map(table => [table, countOf(migrated.db, table)]))
const snapshots = learning.listSnapshots('ag_one_w1').map(snapshot => ({
  snapshotId: snapshot.snapshotId, version: snapshot.version, state: snapshot.state,
  zone: snapshot.zone, namespaceWorkspaceKey: snapshot.namespaceWorkspaceKey,
  contentHash: snapshot.contentHash, principleIds: snapshot.principles.map(principle => principle.principleId),
}))
const run = learning.getRunById('lr_w1')
const currentPrivate = learning.currentSnapshot('ag_one_w1', W1)
const listed = profiles.listProfiles({ includeArchived: true }).map(value => ({
  agentId: value.agentId, name: value.name, state: value.state, scope: value.scope,
  legacyOriginAlias: value.legacyOriginAlias, hasWorkspaceKeyField: Object.hasOwn(value, 'workspaceKey'),
}))
const backups = (existsSync(BACKUPS) ? readdirSync(BACKUPS) : []).map(name => {
  const handle = new DatabaseSync(join(BACKUPS, name))
  const userVersion = handle.prepare('PRAGMA user_version').get().user_version
  const agentProfiles = handle.prepare('SELECT COUNT(*) AS n FROM agent_profiles').get().n
  handle.close()
  return { name, userVersion, agentProfiles }
})
let oldCodeError = null
try { openDecisionDatabase(MIGRATED, { migrations: [MIGRATIONS[0]] }).close() } catch (error) { oldCodeError = error?.code ?? String(error) }

const report = {
  generatedAt: new Date().toISOString(),
  generatedBy: 'plugins/weir-test-harness/spikes/decision/migration-fixture.mjs',
  fixture: { v1: V1, migrated: MIGRATED },
  versions: { before: beforeVersion, copied: { version: copiedVersion, snapshots: copiedSnapshots }, after: migrated.db.prepare('PRAGMA user_version').get().user_version, oldCodeOnV2: oldCodeError },
  integrityCheck: migrated.db.prepare('PRAGMA integrity_check').get().integrity_check,
  rowCounts: { before, after, noRowLoss: TABLES.every(table => before[table] === after[table]) },
  recordBytesUnchanged: {
    cases: beforeRows.cases === rowsOf(migrated.db, 'cases', 'case_id'),
    attempts: beforeRows.attempts === rowsOf(migrated.db, 'attempts', 'attempt_id'),
    evidence: beforeRows.evidence === rowsOf(migrated.db, 'evidence', 'evidence_id'),
    feedback: beforeRows.feedback === rowsOf(migrated.db, 'feedback', 'feedback_id'),
  },
  envelopeVersions: Object.fromEntries(ENVELOPE_TABLES.map(table => [table,
    migrated.db.prepare(`SELECT DISTINCT schema_version FROM ${table}`).all().map(row => row.schema_version)])),
  profilesAfterMigration: listed,
  privateMemory: {
    snapshots,
    currentPrivateSnapshot: currentPrivate?.snapshotId ?? null,
    currentOtherWorkspace: learning.currentSnapshot('ag_one_w1', W2)?.snapshotId ?? null,
    run: { learningRunId: run.learningRunId, outcome: run.outcome, zone: run.zone, namespaceWorkspaceKey: run.namespaceWorkspaceKey },
    principlesBeforeAfterEqual: JSON.stringify(currentPrivate?.principles) === JSON.stringify(PRINCIPLES),
  },
  publicZone: {
    publishedSnapshots: migrated.db.prepare("SELECT COUNT(*) AS n FROM memory_snapshots WHERE zone='public'").get().n,
    learningRuns: migrated.db.prepare("SELECT COUNT(*) AS n FROM learning_runs WHERE zone='public'").get().n,
    currentPublicSnapshot: learning.currentSnapshot('ag_one_w1', null, 'public'),
  },
  attemptPins: JSON.parse(migrated.db.prepare("SELECT pins_json FROM attempts WHERE attempt_id='at_w1'").get().pins_json),
  attemptPinSnapshot: (() => {
    const pins = JSON.parse(migrated.db.prepare("SELECT pins_json FROM attempts WHERE attempt_id='at_w1'").get().pins_json)
    return pins.memorySnapshotId ? migrated.db.prepare('SELECT snapshot_id,zone,namespace_workspace_key FROM memory_snapshots WHERE snapshot_id=?').get(pins.memorySnapshotId) : null
  })(),
  backups,
}
migrated.close()
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`)
console.log(`wrote ${REPORT}`)
console.log(JSON.stringify({
  versions: report.versions, integrityCheck: report.integrityCheck,
  noRowLoss: report.rowCounts.noRowLoss, recordBytesUnchanged: report.recordBytesUnchanged,
  envelopeVersions: report.envelopeVersions, publicZone: report.publicZone, backups,
}, null, 2))
