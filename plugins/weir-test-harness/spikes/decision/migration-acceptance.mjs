// Dev-only acceptance spike: migration safety and immutable history for the
// Decision store v1 -> v2 change (OpenSpec task 7.4).
//
// It drives the REAL production migration/store/broker code — never a copy — and
// writes raw, reviewable evidence instead of only asserting:
//
//   node plugins/weir-test-harness/spikes/decision/migration-acceptance.mjs [evidenceRoot]
//
// Default evidence root:
//   <home>/Documents/Orrery/.weir/decision-cross-workspace-memory-7/migration
// Override with the first argument or WEIR_MIGRATION_EVIDENCE. Every database,
// row dump, hash, log and report it produces lives under that root; the user's
// real Decision store and the running App are never opened, copied or touched.
//
// The v1 fixture comes from the existing generator
// (plugins/weir-test-harness/spikes/decision/migration-fixture.mjs) invoked as a
// CLI child process, so this spike seeds nothing by hand and does not modify it.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { DecisionDatabase, openDecisionDatabase } from '../../../../plugins/weir-harness/src/decision/store/db.js'
import {
  createConsistentBackup, migrateDecisionDatabase, restoreConsistentBackup,
} from '../../../../plugins/weir-harness/src/decision/store/migrate.js'
import {
  CURRENT_SCHEMA_VERSION, MIGRATIONS, legacyOriginAlias,
} from '../../../../plugins/weir-harness/src/decision/store/schema.js'
import { DecisionProfiles } from '../../../../plugins/weir-harness/src/decision/store/profiles.js'
import { DecisionCases } from '../../../../plugins/weir-harness/src/decision/store/cases.js'
import { DecisionFeedback } from '../../../../plugins/weir-harness/src/decision/store/feedback.js'
import { DecisionEvidence } from '../../../../plugins/weir-harness/src/decision/store/evidence.js'
import { DecisionLearning } from '../../../../plugins/weir-harness/src/decision/store/learning.js'
import { DecisionBroker } from '../../../../plugins/weir-harness/src/decision/broker.js'
import { readL2Memory, readPublicL2Memory } from '../../../../plugins/weir-harness/src/decision/retrieval/memory.js'
import { planAutoRoute } from '../../../../plugins/weir-harness/src/decision/router.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../..')
const NODE = process.env.WEIR_IT_NODE ?? process.execPath
const FIXTURE_GENERATOR = join(HERE, 'migration-fixture.mjs')
const SELF = fileURLToPath(import.meta.url)

const EVIDENCE = resolve(
  process.argv[2] ?? process.env.WEIR_MIGRATION_EVIDENCE
  ?? join(homedir(), 'Documents', 'Orrery', '.weir', 'decision-cross-workspace-memory-7', 'migration'),
)
const ROOTS = join(EVIDENCE, 'roots')
const ARTIFACTS = join(EVIDENCE, 'artifacts')
const LOGS = join(EVIDENCE, 'logs')
const REAL_APP_DATA = join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness')
const GUARDED_PORTS = [9442, 9451, 53413]

const TABLES = [
  'meta', 'agent_profiles', 'agent_profile_revisions', 'cases', 'attempts', 'evidence', 'attempt_evidence',
  'feedback', 'corrections', 'route_decisions', 'selectors', 'memory_snapshots', 'learning_runs', 'metrics_counters',
]
/** Stable ordering key per table, used for every row dump and content hash. */
const TABLE_KEYS = {
  meta: 'key',
  agent_profiles: 'agent_id',
  agent_profile_revisions: 'agent_id,kind,revision',
  cases: 'case_id',
  attempts: 'attempt_id',
  evidence: 'evidence_id',
  attempt_evidence: 'attempt_id,ordinal',
  feedback: 'feedback_id',
  corrections: 'feedback_id',
  route_decisions: 'route_decision_id',
  selectors: 'root_session_id',
  memory_snapshots: 'snapshot_id',
  learning_runs: 'learning_run_id',
  metrics_counters: 'bucket',
}
/** Tables whose v1 rows must come through the migration byte-for-byte unchanged. */
const REWRITE_FORBIDDEN = ['cases', 'attempts', 'evidence', 'feedback', 'attempt_evidence', 'corrections', 'route_decisions', 'selectors', 'agent_profile_revisions', 'metrics_counters']
/** v1 tables that gained the additive namespace columns. */
const NAMESPACED_TABLES = ['learning_runs', 'memory_snapshots']
const ENVELOPE_TABLES = ['agent_profiles', 'cases', 'attempts', 'evidence', 'feedback', 'route_decisions', 'learning_runs', 'memory_snapshots']
const MODEL_ROUTE = { kind: 'inherited', provider: 'p', model: 'm' }
const EMPTY_REPLAY = { passed: true, metrics: { operationCount: 0, sourceCount: 0, activePrincipleCount: 0, retiredPrincipleCount: 0 } }
const DATA_LOSS_BOUNDARY = 'Restoring the consistent v1 backup after a successful v1->v2 migration discards EVERY write made after that migration — new private Cases/Attempts/Feedback, new workspace-zone Learning Runs/Snapshots, new public memory and new Agent Profiles — not only public data. Restored state is the pre-migration v1 database.'

// ---- isolation bookkeeping --------------------------------------------------
/** @type {{path:string,where:string}[]} */
const openedPaths = []
/** @type {{from:string,to:string,cleared:boolean}[]} */
const copyOps = []
/** @type {{where:string,version:number}[]} */
const beforeMigrationVersions = []
/** @type {{label:string,pid:number,exitCode:number}[]} */
const children = []
/** @type {{label:string,ok:boolean,assertions:object[],artifacts:object[],error:string|null,durationMs:number}[]} */
const results = []
const startedListeners = Object.fromEntries(GUARDED_PORTS.map(port => [port, listeners(port)]))
/** The user's real App data and Decision store roots; only their stat is ever read. */
const REAL_STORE_PATHS = {
  appData: REAL_APP_DATA,
  weir: join(REAL_APP_DATA, 'weir'),
  profiles: join(REAL_APP_DATA, 'weir', 'profiles'),
}
const realStoreStatBefore = Object.fromEntries(Object.entries(REAL_STORE_PATHS).map(([key, path]) => [key, statOf(path)]))

// ---- small utilities --------------------------------------------------------
/** @param {Buffer|string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
/** @param {string} path */
function fileHash(path) {
  return sha256(readFileSync(path))
}
/** @param {string} path */
function statOf(path) {
  try {
    const stat = statSync(path)
    return { path, exists: true, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
  } catch { return { path, exists: false } }
}
/** @param {string} dbPath */
function sidecars(dbPath) {
  return ['-wal', '-shm'].map(suffix => {
    const path = `${dbPath}${suffix}`
    const stat = statOf(path)
    return { suffix, exists: stat.exists, size: stat.exists ? stat.size : null }
  })
}
/** Remove both WAL sidecars; a leftover -wal would replay an older state over the main file. */
function clearSidecars(dbPath) {
  for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
}
/**
 * Copy a WAL-mode database file. The sidecars are removed from the destination
 * before and after the copy (see blackboard key decision-fixture-stale-wal-replay).
 * @param {string} from @param {string} to
 */
function copyDatabase(from, to, where = 'copy') {
  mkdirSync(dirname(to), { recursive: true })
  clearSidecars(to)
  copyFileSync(from, to)
  clearSidecars(to)
  const cleared = sidecars(to).every(entry => entry.exists === false)
  copyOps.push({ from, to, cleared, where })
  return to
}
/** @param {string} path */
function rawOpen(path) {
  openedPaths.push({ path, where: 'read-only' })
  return new DatabaseSync(path, { readOnly: true })
}
/** @param {any} db @param {string} name */
function pragma(db, name) {
  return db.prepare(`PRAGMA ${name}`).get()
}
/** @param {any} db @param {string} table */
function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => ({
    name: row.name, type: row.type, notnull: row.notnull, dflt: row.dflt_value, pk: row.pk,
  }))
}
/** @param {any} db @param {string} table */
function columnNames(db, table) {
  return tableInfo(db, table).map(column => column.name)
}
/** @param {any} db @param {string} table */
function countOf(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
}
/** @param {any} db @param {string} table */
function rowsOf(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${TABLE_KEYS[table]}`).all()
}
/** @param {any} db */
function countsOf(db) {
  return Object.fromEntries(TABLES.filter(name => tableExists(db, name)).map(table => [table, countOf(db, table)]))
}
/** @param {any} db @param {string} table */
function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}
/** @param {any} db */
function contentHash(db) {
  const dump = Object.fromEntries(TABLES.filter(name => tableExists(db, name)).map(table => [table, rowsOf(db, table)]))
  return sha256(JSON.stringify(dump))
}
/** @param {any} db */
function schemaFingerprint(db) {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()
  return sha256(JSON.stringify(rows))
}
/** @param {any} db */
function indexNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(row => row.name)
}
/** @param {string} path */
function backupsOf(path) {
  const directory = join(dirname(path), 'backups')
  if (!existsSync(directory)) return []
  return readdirSync(directory).sort().map(name => {
    const backupPath = join(directory, name)
    const stat = statOf(backupPath)
    const handle = new DatabaseSync(backupPath, { readOnly: true })
    const info = {
      name,
      path: backupPath,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: fileHash(backupPath),
      userVersion: pragma(handle, 'user_version').user_version,
      integrity: pragma(handle, 'integrity_check').integrity_check,
      agentProfiles: tableExists(handle, 'agent_profiles') ? countOf(handle, 'agent_profiles') : null,
      hasWorkspaceKey: tableExists(handle, 'agent_profiles') && columnNames(handle, 'agent_profiles').includes('workspace_key'),
      journalMode: pragma(handle, 'journal_mode').journal_mode,
    }
    handle.close()
    return info
  })
}
/** @param {unknown} value */
function json(value) {
  return JSON.parse(JSON.stringify(value))
}
/** @param {{assert:Function,name:string,fn:Function}} ... */
async function throwsCode(fn) {
  try {
    await fn()
    return { threw: false, code: null, message: null }
  } catch (error) {
    return { threw: true, code: error?.code ?? String(error), message: error?.message ?? String(error) }
  }
}
/** @param {number} port */
function listeners(port) {
  const command = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof'
  try {
    return execFileSync(command, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (error) {
    // lsof exits 1 with no output when no socket matches.
    return error?.status === 1 ? '' : null
  }
}
/** @param {string[]} args @param {object} [options] */
function runChild(label, args, options = {}) {
  const started = Date.now()
  try {
    const stdout = execFileSync(args[0], args.slice(1), {
      cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000, ...options,
    })
    children.push({ label, pid: null, exitCode: 0, durationMs: Date.now() - started })
    return { exitCode: 0, stdout }
  } catch (error) {
    children.push({ label, pid: error?.pid ?? null, exitCode: error?.status ?? -1, durationMs: Date.now() - started })
    throw Object.assign(new Error(`${label} exited ${error?.status ?? 'unknown'}: ${String(error?.stderr ?? error?.message ?? error).slice(0, 4000)}`), {
      childStdout: String(error?.stdout ?? ''), childStderr: String(error?.stderr ?? ''),
    })
  }
}
/** @param {string} name @param {string} contents */
function writeLog(name, contents) {
  mkdirSync(LOGS, { recursive: true })
  writeFileSync(join(LOGS, name), contents.endsWith('\n') ? contents : `${contents}\n`)
}
/** @param {string} name @param {string} value */
function writeJsonLog(name, value) {
  writeLog(name, `${JSON.stringify(value, null, 2)}\n`)
}

// ---- check harness ----------------------------------------------------------
class CheckFailure extends Error {}

/**
 * Run one labeled acceptance check. Every assertion inside is recorded with its
 * name, so the report maps required behaviour to observed evidence instead of a
 * single boolean. A failed assertion stops that check but the remaining checks
 * still run in their own isolated roots.
 * @param {string} label @param {(context:{expect:Function,artifact:Function,record:any})=>Promise<void>} body
 */
async function runCheck(label, body) {
  const record = { label, ok: true, assertions: [], artifacts: [], error: null, durationMs: 0 }
  results.push(record)
  const expect = (name, condition, detail) => {
    const ok = Boolean(condition)
    record.assertions.push({ name, ok, ...(detail === undefined ? {} : { detail: json(detail) }) })
    if (!ok) {
      record.ok = false
      throw new CheckFailure(`${label} :: ${name}${detail === undefined ? '' : ` — ${JSON.stringify(json(detail))}`}`)
    }
  }
  const artifact = (name, path, extra = {}) => {
    const stat = statOf(path)
    const entry = { name, path, bytes: stat.exists ? stat.size : null, sha256: stat.exists ? fileHash(path) : null, ...extra }
    record.artifacts.push(entry)
    return entry
  }
  // Raw database copies live under artifacts/, copied with both sidecars cleared
  // so a reviewer opening one cannot replay a different run's WAL.
  const exportDatabase = (name, path, extra = {}) => {
    mkdirSync(ARTIFACTS, { recursive: true })
    const target = join(ARTIFACTS, name)
    copyDatabase(path, target, `export ${name}`)
    return artifact(name, target, { source: path, ...extra })
  }
  const started = Date.now()
  try {
    await body({ expect, artifact, exportDatabase, record })
  } catch (error) {
    record.ok = false
    record.error = error instanceof CheckFailure ? error.message : `${error?.stack ?? String(error)}`
  }
  // A failed run is kept as a diagnostic, never reported as a pass.
  if (!record.ok) {
    writeJsonLog(`failed-${label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.json`, record)
  }
  record.durationMs = Date.now() - started
  const suffix = record.ok
    ? ` — ${record.assertions.length} assertions in ${record.durationMs}ms`
    : ` — ${record.error}`
  console.log(`${record.ok ? 'PASS' : 'FAIL'} ${label}${suffix}`)
  return record
}

/** @param {string} where */
function rootOf(where) {
  const path = join(ROOTS, where)
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Remove every leftover WAL sidecar next to a database file under roots/. A
 * reviewer opening an evidence copy must not be able to replay another stage's
 * write-ahead log (blackboard key decision-fixture-stale-wal-replay).
 * @returns {{cleared:string[],remaining:string[],databases:string[]}}
 */
function clearRootsSidecars() {
  const databases = []
  const cleared = []
  /** @param {string} directory */
  const walk = directory => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.name.endsWith('.db')) continue
      databases.push(path)
      const present = sidecars(path).filter(sidecar => sidecar.exists).map(sidecar => `${path}${sidecar.suffix}`)
      if (present.length) {
        clearSidecars(path)
        cleared.push(...present)
      }
    }
  }
  walk(ROOTS)
  walk(ARTIFACTS)
  const remaining = databases.flatMap(path => sidecars(path).filter(sidecar => sidecar.exists).map(sidecar => `${path}${sidecar.suffix}`))
  return { cleared, remaining, databases }
}

// ---- canonical v1 source, produced by the existing fixture generator --------
const V1_SOURCE = join(ROOTS, 'v1', 'decision.db')
const FIXTURE_OUT = join(ROOTS, 'fixture')

async function check1_realV1Fixture() {
  return runCheck('1. real v1 fixture', async ({ expect, artifact, exportDatabase }) => {
    rmSync(FIXTURE_OUT, { recursive: true, force: true })
    mkdirSync(FIXTURE_OUT, { recursive: true })
    const run = runChild('migration-fixture.mjs', [NODE, FIXTURE_GENERATOR, FIXTURE_OUT])
    writeLog('fixture-generator.stdout.log', run.stdout)
    expect('fixture-generator-exit-0', run.exitCode === 0 && existsSync(join(FIXTURE_OUT, 'fixture-v1.db')),
      { exitCode: run.exitCode, fixture: join(FIXTURE_OUT, 'fixture-v1.db') })

    const generatorReport = JSON.parse(readFileSync(join(FIXTURE_OUT, 'fixture-report.json'), 'utf8'))
    writeLog('fixture-generator.report.json', JSON.stringify(generatorReport, null, 2))
    expect('fixture-generator-report',
      generatorReport.versions.copied?.version === 1 && generatorReport.rowCounts?.noRowLoss === true,
      { copied: generatorReport.versions, noRowLoss: generatorReport.rowCounts?.noRowLoss })

    // The canonical source is a copy with both sidecars cleared, so nothing of
    // the generator's own migrated run can be replayed over it.
    const fixtureV1 = join(FIXTURE_OUT, 'fixture-v1.db')
    const fixtureSidecars = sidecars(fixtureV1)
    expect('source-sidecars-cleared', fixtureSidecars.every(entry => entry.exists === false), fixtureSidecars)
    copyDatabase(fixtureV1, V1_SOURCE, 'c1:fixture -> canonical v1 source')
    // Read the sidecar state right after the copy: opening the file afterwards
    // (even read-only) is what creates a zero-frame -wal/-shm pair.
    const copiedSidecars = sidecars(V1_SOURCE)
    expect('no-stale-sidecars-on-source', copiedSidecars.every(entry => entry.exists === false), copiedSidecars)
    exportDatabase('fixture-v1-source.db', V1_SOURCE, { kind: 'genuine schema-v1 database' })

    const db = rawOpen(V1_SOURCE)
    try {
      expect('source-is-v1', pragma(db, 'user_version').user_version === 1, { userVersion: pragma(db, 'user_version').user_version })
      const profileColumns = columnNames(db, 'agent_profiles')
      expect('legacy-profiles-workspace-key-column',
        profileColumns.includes('workspace_key') && !profileColumns.includes('legacy_origin_alias'), profileColumns)
      const snapshotColumns = columnNames(db, 'memory_snapshots')
      const runColumns = columnNames(db, 'learning_runs')
      expect('legacy-memory-without-zone',
        !snapshotColumns.includes('zone') && !snapshotColumns.includes('namespace_workspace_key'), snapshotColumns)
      expect('legacy-runs-without-namespace',
        !runColumns.includes('zone') && !runColumns.includes('namespace_workspace_key'), runColumns)

      const attempts = rowsOf(db, 'attempts')
      const pins = attempts.map(row => JSON.parse(row.pins_json))
      expect('legacy-attempt-single-pin',
        attempts.length === 1 && JSON.stringify(pins[0]) === '{"memorySnapshotId":"ms_w1"}',
        { attempts: attempts.length, pins })
      expect('legacy-private-snapshot-exists',
        countOf(db, 'memory_snapshots') === 1 && countOf(db, 'learning_runs') === 1 && countOf(db, 'cases') === 1 && countOf(db, 'feedback') === 1,
        countsOf(db))
      const counts = countsOf(db)
      const hash = contentHash(db)
      const dumpPath = join(ARTIFACTS, 'fixture-v1-rows.json')
      mkdirSync(ARTIFACTS, { recursive: true })
      writeFileSync(dumpPath, `${JSON.stringify({ path: V1_SOURCE, userVersion: 1, counts, contentHash: hash, rows: Object.fromEntries(TABLES.map(table => [table, rowsOf(db, table)])) }, null, 2)}\n`)
      artifact('fixture-v1-rows.json', dumpPath)
      expect('row-counts-recorded',
        counts.agent_profiles === 4 && counts.cases === 1 && counts.attempts === 1 && counts.evidence === 1
        && counts.feedback === 1 && counts.learning_runs === 1 && counts.memory_snapshots === 1, counts)
      expect('content-hash-recorded', /^[a-f0-9]{64}$/.test(hash), { contentHash: hash })
      record1.hashes = { sha256: fileHash(V1_SOURCE), contentHash: hash }
      record1.counts = counts
    } finally {
      db.close()
      // Our own read connection created an empty sidecar pair; drop it so the
      // canonical source stays a bare v1 file for every later copy.
      clearSidecars(V1_SOURCE)
    }
    expect('source-remains-bare-v1-file', sidecars(V1_SOURCE).every(entry => entry.exists === false), sidecars(V1_SOURCE))
    beforeMigrationVersions.push({ where: 'c1:canonical v1 source', version: 1 })
  })
}
const record1 = { hashes: /** @type {any} */ (null), counts: /** @type {any} */ (null) }

/** @param {string} where @param {string} [source] */
function prepareV1Copy(where, source = V1_SOURCE) {
  if (!existsSync(source)) throw new CheckFailure(`v1 fixture unavailable at ${source} (check 1 failed)`)
  const dir = rootOf(where)
  const dbPath = join(dir, 'decision.db')
  copyDatabase(source, dbPath, `${where}:v1 -> working copy`)
  const db = rawOpen(dbPath)
  const version = pragma(db, 'user_version').user_version
  db.close()
  beforeMigrationVersions.push({ where, version })
  return { dir, dbPath, version }
}

// ---- 2. migration -----------------------------------------------------------
async function check2_migration() {
  return runCheck('2. migration v1 -> v2', async ({ expect, artifact, exportDatabase }) => {
    const { dbPath, version } = prepareV1Copy('c2')
    expect('copy-read-as-v1-before-migration', version === 1, { version })
    const beforeCounts = (() => { const db = rawOpen(dbPath); try { return countsOf(db) } finally { db.close() } })()

    openedPaths.push({ path: dbPath, where: 'c2:production openDecisionDatabase' })
    const store = openDecisionDatabase(dbPath)
    try {
      const userVersion = pragma(store.db, 'user_version').user_version
      const integrity = pragma(store.db, 'integrity_check').integrity_check
      expect('user-version-2', userVersion === CURRENT_SCHEMA_VERSION && userVersion === 2, { userVersion })
      expect('schema-version-matches-migration-count', CURRENT_SCHEMA_VERSION === MIGRATIONS.length,
        { schemaVersion: CURRENT_SCHEMA_VERSION, migrations: MIGRATIONS.length })
      expect('integrity-check-ok', integrity === 'ok', { integrity })

      // The checkpoint + VACUUM INTO backup sits at one exact expected path.
      const backups = backupsOf(dbPath)
      expect('backup-count-one', backups.length === 1, backups.map(backup => backup.name))
      const backup = backups[0]
      const expectedDirectory = join(dirname(dbPath), 'backups')
      expect('backup-exists-exact-path',
        backup?.path === join(expectedDirectory, backup.name) && /^decision-v1-\d+\.db$/.test(backup.name)
        && existsSync(backup.path),
        { expectedDirectory, actual: backup?.path, pattern: 'decision-v1-<epochMs>.db' })
      expect('backup-is-consistent-v1',
        backup.userVersion === 1 && backup.integrity === 'ok' && backup.agentProfiles === 4 && backup.hasWorkspaceKey,
        { name: backup.name, userVersion: backup.userVersion, integrity: backup.integrity, agentProfiles: backup.agentProfiles, hasWorkspaceKey: backup.hasWorkspaceKey })
      exportDatabase('c2-backup-v1.db', backup.path, { kind: 'consistent-backup (checkpoint + VACUUM INTO)' })

      const afterCounts = countsOf(store.db)
      expect('zero-row-loss', Object.entries(beforeCounts).every(([table, count]) => afterCounts[table] === count),
        { before: beforeCounts, after: afterCounts })

      const profiles = new DecisionProfiles(store)
      const list = profiles.listProfiles({ includeArchived: true })
      const byId = new Map(list.map(profile => [profile.agentId, profile]))
      expect('profiles-profile-global',
        list.length === 4 && !columnNames(store.db, 'agent_profiles').includes('workspace_key')
        && !JSON.stringify(list).includes('/repo/'),
        { agents: list.map(profile => profile.agentId).sort(), columns: columnNames(store.db, 'agent_profiles') })
      expect('profiles-nocase-unique-index',
        indexNames(store.db).includes('agent_profiles_name_unique')
        && /COLLATE NOCASE/.test(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_profiles_name_unique'").get().sql),
        { indexes: indexNames(store.db).filter(name => name.startsWith('agent_profiles')) })
      const rawDuplicate = throwsCodeSync(() => store.db.prepare(`INSERT INTO agent_profiles(
        agent_id,name,legacy_origin_alias,state,scope_json,user_desc_rev,generated_desc_rev,chain_json,
        schema_version,revision,created_at,updated_at) VALUES('ag_accept_dup','COPY-TONE',NULL,'enabled','{}',1,0,'{"chain":[]}',1,1,1,1)`).run())
      const apiDuplicate = await throwsCode(() => profiles.createProfile({ name: 'COPY-TONE' }))
      expect('profiles-create-duplicate-name-rejected',
        rawDuplicate.threw === true && /UNIQUE constraint failed/i.test(String(rawDuplicate.message))
        && apiDuplicate.code === 'PROFILE_NAME_TAKEN',
        { rawDuplicate, apiDuplicate })
      expect('profiles-duplicate-names-deterministic',
        byId.get('ag_one_w1').name === 'copy-tone'
        && byId.get('ag_one_w2').name === 'copy-tone · 3'
        && byId.get('ag_suffixed').name === 'copy-tone · 2'
        && byId.get('ag_archived').name === 'Retired',
        Object.fromEntries(list.map(profile => [profile.agentId, profile.name])))
      expect('profiles-no-auto-merge',
        new Set(list.map(profile => profile.agentId)).size === 4
        && new Set(list.map(profile => profile.name.toLowerCase())).size === 4,
        { identities: list.length, distinctNames: new Set(list.map(profile => profile.name.toLowerCase())).size })
      expect('profiles-legacy-origin-alias-only',
        list.every(profile => /^origin_[a-f0-9]{12}$/.test(profile.legacyOriginAlias ?? ''))
        && !('workspaceKey' in list[0])
        && byId.get('ag_one_w1').legacyOriginAlias === legacyOriginAlias('/repo/one')
        && byId.get('ag_one_w2').legacyOriginAlias === legacyOriginAlias('/repo/two'),
        Object.fromEntries(list.map(profile => [profile.agentId, profile.legacyOriginAlias])))

      // Learning runs and Snapshots inherited the legacy profile workspace as
      // their private namespace; the public zone starts empty.
      const runRows = store.db.prepare('SELECT agent_id,zone,namespace_workspace_key FROM learning_runs ORDER BY learning_run_id').all()
      const snapshotRows = store.db.prepare('SELECT agent_id,zone,namespace_workspace_key FROM memory_snapshots ORDER BY snapshot_id').all()
      const expected = { ag_one_w1: '/repo/one', ag_one_w2: '/repo/two' }
      expect('learning-namespace-private',
        runRows.length === 1 && snapshotRows.length === 1
        && runRows.every(row => row.zone === 'workspace' && row.namespace_workspace_key === expected[row.agent_id])
        && snapshotRows.every(row => row.zone === 'workspace' && row.namespace_workspace_key === expected[row.agent_id]),
        { runs: runRows, snapshots: snapshotRows })
      const learning = new DecisionLearning(store)
      const publicSnapshots = store.db.prepare("SELECT COUNT(*) AS n FROM memory_snapshots WHERE zone='public'").get().n
      const publicRuns = store.db.prepare("SELECT COUNT(*) AS n FROM learning_runs WHERE zone='public'").get().n
      expect('public-zone-empty',
        publicSnapshots === 0 && publicRuns === 0
        && learning.currentPublicSnapshot('ag_one_w1') === null
        && learning.currentSnapshot('ag_one_w1', '/repo/two') === null,
        { publicSnapshots, publicRuns })
      const envelopeVersions = Object.fromEntries(ENVELOPE_TABLES.map(table =>
        [table, store.db.prepare(`SELECT DISTINCT schema_version FROM ${table}`).all().map(row => row.schema_version)]))
      // Row envelopes stay at 1 while PRAGMA user_version is 2. A table with no
      // rows (route_decisions here) contributes no distinct version and is not a
      // contradiction: every persisted row envelope in this database is 1.
      expect('record-envelopes-stay-v1',
        Object.values(envelopeVersions).every(versions => versions.every(version => version === 1))
        && Object.entries(envelopeVersions).filter(([, versions]) => versions.length === 0).every(([table]) => countOf(store.db, table) === 0),
        envelopeVersions)

      record2.backup = backup.path
      record2.schemaFingerprint = schemaFingerprint(store.db)
      record2.contentHash = contentHash(store.db)
    } finally {
      store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      store.close()
    }
    exportDatabase('c2-migrated.db', dbPath, { kind: 'migrated v2 database' })
    const dumpPath = join(ARTIFACTS, 'c2-migrated-rows.json')
    writeFileSync(dumpPath, `${JSON.stringify({ path: dbPath, rows: Object.fromEntries(TABLES.map(table => [table, rowsOfDbFile(dbPath, table)])) }, null, 2)}\n`)
    artifact('c2-migrated-rows.json', dumpPath)
  })
}
const record2 = { migrated: '', backup: '', schemaFingerprint: '', contentHash: '' }

/** @param {() => any} fn */
function throwsCodeSync(fn) {
  try { fn(); return { threw: false, code: null, message: null } } catch (error) { return { threw: true, code: error?.code ?? String(error), message: error?.message ?? String(error) } }
}
/** @param {string} path @param {string} table */
function rowsOfDbFile(path, table) {
  const db = rawOpen(path)
  try { return rowsOf(db, table) } finally { db.close() }
}

// ---- 3. immutable history ---------------------------------------------------
async function check3_immutableHistory() {
  return runCheck('3. immutable history', async ({ expect, artifact, exportDatabase }) => {
    const { dbPath, version } = prepareV1Copy('c3')
    expect('copy-read-as-v1-before-migration', version === 1, { version })
    const store = openDecisionDatabase(dbPath)
    openedPaths.push({ path: dbPath, where: 'c3:production openDecisionDatabase' })
    try {
      const before = rawOpen(V1_SOURCE)
      try {
        // Column sets: rewritten-forbidden tables must be untouched; namespace
        // tables may only gain the two additive columns.
        for (const table of REWRITE_FORBIDDEN) {
          const beforeColumns = columnNames(before, table)
          const afterColumns = columnNames(store.db, table)
          expect(`${singular(table)}-columns-unchanged`,
            JSON.stringify(beforeColumns) === JSON.stringify(afterColumns),
            { before: beforeColumns, after: afterColumns })
        }
        for (const table of NAMESPACED_TABLES) {
          const beforeColumns = columnNames(before, table)
          const afterColumns = columnNames(store.db, table)
          expect(`${singular(table)}-v1-column-prefix-unchanged`,
            JSON.stringify(afterColumns.slice(0, beforeColumns.length)) === JSON.stringify(beforeColumns)
            && JSON.stringify(afterColumns.slice(beforeColumns.length)) === JSON.stringify(['zone', 'namespace_workspace_key']),
            { before: beforeColumns, after: afterColumns })
        }

        // Field-level comparison for every pre-existing column. The compared
        // field list is recorded so the claim is not a full-JSON shortcut.
        const fieldsCompared = {}
        for (const table of [...REWRITE_FORBIDDEN.filter(name => name !== 'attempt_evidence' && name !== 'corrections' && name !== 'route_decisions' && name !== 'selectors' && name !== 'agent_profile_revisions' && name !== 'metrics_counters'), ...NAMESPACED_TABLES]) {
          const columns = columnNames(before, table)
          fieldsCompared[table] = columns
          const beforeRows = rowsOf(before, table)
          const afterRows = rowsOf(store.db, table)
          const differences = compareRows(columns, beforeRows, afterRows)
          expect(`${singular(table)}-fields-identical`, beforeRows.length === afterRows.length && differences.length === 0,
            { comparedFields: columns, rows: beforeRows.length, differences: differences.slice(0, 5) })
        }
        for (const [table, columns] of Object.entries(fieldsCompared)) {
          const tableName = table === 'memory_snapshots' ? 'snapshot' : table === 'learning_runs' ? 'learning-run' : singular(table)
          // Already asserted above under the table-specific name; keep an explicit
          // record of exactly which fields were compared.
          record3.fieldsCompared[tableName] = columns
        }

        // agent_profiles is the one table with a documented rebuild: identity,
        // state, revisions, timestamps survive; the legacy workspace is dropped.
        const profileColumns = ['agent_id', 'state', 'user_desc_rev', 'generated_desc_rev', 'chain_json', 'archived_at', 'schema_version', 'revision', 'created_at', 'updated_at']
        const beforeProfiles = rowsOf(before, 'agent_profiles')
        const afterProfilesById = new Map(rowsOf(store.db, 'agent_profiles').map(row => [row.agent_id, row]))
        const profileDiffs = []
        for (const row of beforeProfiles) {
          const other = afterProfilesById.get(row.agent_id)
          if (!other) { profileDiffs.push({ agentId: row.agent_id, missing: true }); continue }
          const changed = profileColumns.filter(column => JSON.stringify(row[column]) !== JSON.stringify(other[column]))
          if (changed.length) profileDiffs.push({ agentId: row.agent_id, changed })
        }
        record3.profileFieldsCompared = profileColumns
        expect('profile-shared-fields-identical', profileDiffs.length === 0, { comparedFields: profileColumns, differences: profileDiffs })

        // New columns must be additive defaults only.
        const snapshotInfo = tableInfo(store.db, 'memory_snapshots')
        const runInfo = tableInfo(store.db, 'learning_runs')
        expect('new-columns-additive-defaults',
          snapshotInfo.find(column => column.name === 'zone')?.notnull === 1
          && snapshotInfo.find(column => column.name === 'zone')?.dflt === "'workspace'"
          && snapshotInfo.find(column => column.name === 'namespace_workspace_key')?.dflt === null
          && runInfo.find(column => column.name === 'zone')?.notnull === 1
          && runInfo.find(column => column.name === 'zone')?.dflt === "'workspace'"
          && store.db.prepare("SELECT COUNT(*) AS n FROM memory_snapshots WHERE zone<>'workspace'").get().n === 0
          && store.db.prepare("SELECT COUNT(*) AS n FROM learning_runs WHERE zone<>'workspace'").get().n === 0,
          { snapshotNew: snapshotInfo.filter(column => ['zone', 'namespace_workspace_key'].includes(column.name)), runNew: runInfo.filter(column => ['zone', 'namespace_workspace_key'].includes(column.name)) })

        // The legacy single pin still resolves to the same private Snapshot.
        const pins = JSON.parse(store.db.prepare("SELECT pins_json FROM attempts WHERE attempt_id='at_w1'").get().pins_json)
        const pinned = store.db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(pins.memorySnapshotId)
        const beforeSnapshot = before.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(pins.memorySnapshotId)
        const snapshotFields = columnNames(before, 'memory_snapshots')
        expect('legacy-pin-resolves-same-private-snapshot',
          pins.memorySnapshotId === 'ms_w1'
          && !('publicMemorySnapshotId' in pins)
          && pinned?.zone === 'workspace'
          && pinned?.namespace_workspace_key === '/repo/one'
          && snapshotFields.every(column => JSON.stringify(beforeSnapshot[column]) === JSON.stringify(pinned[column])),
          { pins, snapshotId: pinned?.snapshot_id, zone: pinned?.zone, namespaceWorkspaceKey: pinned?.namespace_workspace_key })

        // No row was rewritten while reading history: revisions are unchanged.
        const revisionDiffs = []
        for (const table of ['cases', 'attempts', 'evidence', 'feedback', 'learning_runs', 'memory_snapshots']) {
          const rows = rowsOf(store.db, table)
          for (const row of rows) {
            const beforeRow = before.prepare(`SELECT revision FROM ${table} WHERE ${TABLE_KEYS[table].split(',')[0]}=?`).get(row[TABLE_KEYS[table].split(',')[0]])
            if (!beforeRow || beforeRow.revision !== row.revision) revisionDiffs.push({ table, key: row[TABLE_KEYS[table].split(',')[0]], before: beforeRow?.revision, after: row.revision })
          }
        }
        expect('revisions-unchanged', revisionDiffs.length === 0, revisionDiffs.slice(0, 5))
        expect('no-row-rewritten',
          REWRITE_FORBIDDEN.every(table => JSON.stringify(rowsOf(before, table)) === JSON.stringify(rowsOf(store.db, table))),
          { checked: REWRITE_FORBIDDEN })
        record3.snapshotFieldsCompared = snapshotFields
      } finally { before.close() }
    } finally {
      store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      store.close()
    }
    exportDatabase('c3-migrated.db', dbPath, { kind: 'migrated v2 database used for the field comparison' })
  })
}
const record3 = { fieldsCompared: /** @type {Record<string,string[]>} */ ({}), profileFieldsCompared: [], snapshotFieldsCompared: [] }

/** @param {string} table */
function singular(table) {
  if (table === 'cases') return 'case'
  if (table === 'attempts') return 'attempt'
  if (table === 'evidence') return 'evidence'
  if (table === 'feedback') return 'feedback'
  if (table === 'memory_snapshots') return 'snapshot'
  if (table === 'learning_runs') return 'learning-run'
  return table.replace(/s$/, '')
}
/** @param {string[]} columns @param {any[]} beforeRows @param {any[]} afterRows */
function compareRows(columns, beforeRows, afterRows) {
  const differences = []
  for (let index = 0; index < Math.max(beforeRows.length, afterRows.length); index++) {
    const left = beforeRows[index]
    const right = afterRows[index]
    if (!left || !right) { differences.push({ index, missing: !left ? 'after' : 'before' }); continue }
    const changed = columns.filter(column => JSON.stringify(left[column]) !== JSON.stringify(right[column]))
    if (changed.length) differences.push({ index, changed })
  }
  return differences
}

// ---- 4. idempotence / repeat safety ----------------------------------------
async function check4_idempotence() {
  return runCheck('4. idempotence / repeat safety', async ({ expect, artifact, exportDatabase }) => {
    const { dbPath, version } = prepareV1Copy('c4')
    expect('copy-read-as-v1-before-migration', version === 1, { version })
    const first = openDecisionDatabase(dbPath)
    openedPaths.push({ path: dbPath, where: 'c4:first production open' })
    const stateA = {
      contentHash: contentHash(first.db),
      schemaFingerprint: schemaFingerprint(first.db),
      userVersion: pragma(first.db, 'user_version').user_version,
      integrity: pragma(first.db, 'integrity_check').integrity_check,
      counts: countsOf(first.db),
    }
    first.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    first.close()
    const backupsA = backupsOf(dbPath)

    // (a) the production migration entry point run a second time on the same file
    const second = new DecisionDatabase(dbPath)
    openedPaths.push({ path: dbPath, where: 'c4:second migrateDecisionDatabase' })
    try {
      const applied = migrateDecisionDatabase(second)
      expect('second-run-applies-nothing', applied === 2 && pragma(second.db, 'user_version').user_version === 2, { applied })
      expect('second-run-no-new-backup', JSON.stringify(backupsOf(dbPath)) === JSON.stringify(backupsA),
        { before: backupsA.map(backup => backup.name), after: backupsOf(dbPath).map(backup => backup.name) })
      expect('second-run-identical-content', contentHash(second.db) === stateA.contentHash,
        { before: stateA.contentHash, after: contentHash(second.db) })
      expect('second-run-schema-unchanged', schemaFingerprint(second.db) === stateA.schemaFingerprint,
        { before: stateA.schemaFingerprint, after: schemaFingerprint(second.db) })
      expect('second-run-user-version-2', pragma(second.db, 'user_version').user_version === 2 && stateA.userVersion === 2)
      expect('second-run-integrity-ok', pragma(second.db, 'integrity_check').integrity_check === 'ok')
      expect('backup-bytes-untouched',
        backupsOf(dbPath).length === 1 && backupsOf(dbPath)[0].sha256 === backupsA[0].sha256
        && backupsOf(dbPath)[0].mtimeMs === backupsA[0].mtimeMs,
        { backup: backupsOf(dbPath)[0] })
      expect('no-rebuild-table-left-behind',
        !tableExists(second.db, 'agent_profiles_v2')
        && !indexNames(second.db).some(name => name.includes('agent_profiles_v2')),
        { tables: second.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_profiles%'").all() })
      second.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    } finally { second.close() }

    // (b) a third run through a completely fresh store instance
    const third = openDecisionDatabase(dbPath)
    openedPaths.push({ path: dbPath, where: 'c4:third production open (fresh store instance)' })
    try {
      expect('third-run-fresh-store-identical',
        contentHash(third.db) === stateA.contentHash && JSON.stringify(countsOf(third.db)) === JSON.stringify(stateA.counts),
        { contentHash: contentHash(third.db), counts: countsOf(third.db) })
      expect('third-run-no-new-backup', backupsOf(dbPath).length === 1 && backupsOf(dbPath)[0].sha256 === backupsA[0].sha256,
        { backups: backupsOf(dbPath).map(backup => backup.name) })
      expect('third-run-user-version-2', pragma(third.db, 'user_version').user_version === 2)
      expect('third-run-integrity-ok', pragma(third.db, 'integrity_check').integrity_check === 'ok')
    } finally {
      third.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      third.close()
    }
    expect('third-run-schema-unchanged', (() => {
      const db = rawOpen(dbPath)
      try { return schemaFingerprint(db) === stateA.schemaFingerprint } finally { db.close() }
    })(), { schemaFingerprint: stateA.schemaFingerprint })
    record4.stateA = stateA
    exportDatabase('c4-migrated-after-repeat.db', dbPath, { kind: 'repeatedly migrated v2 database' })
  })
}
const record4 = { stateA: /** @type {any} */ (null) }

// ---- 5. WAL / SHM hygiene ---------------------------------------------------
async function check5_walShmHygiene() {
  return runCheck('5. WAL/SHM hygiene', async ({ expect, artifact, exportDatabase }) => {
    const dir = rootOf('c5')
    const stage = join(dir, 'stage', 'decision.db')
    copyDatabase(V1_SOURCE, stage, 'c5:stage copy')
    const stageDb = rawOpen(stage)
    const stageVersion = pragma(stageDb, 'user_version').user_version
    stageDb.close()
    beforeMigrationVersions.push({ where: 'c5:stage', version: stageVersion })
    expect('copy-read-as-v1-before-migration', stageVersion === 1, { version: stageVersion })

    const store = openDecisionDatabase(stage)
    openedPaths.push({ path: stage, where: 'c5:stage production open' })
    const hashOpen = contentHash(store.db)
    store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    store.close()
    expect('migrated-close-leaves-no-sidecars', sidecars(stage).every(entry => entry.exists === false), sidecars(stage))
    const reopened = rawOpen(stage)
    const hashReopened = contentHash(reopened)
    reopened.close()
    expect('post-close-reopen-state-identical', hashOpen === hashReopened, { hashOpen, hashReopened })

    // Known fixture trap: a leftover -wal/-shm pair from an older run is replayed
    // over a freshly copied main file. Reproduce it deliberately, then prove the
    // remedy (deleting BOTH sidecars) restores the copied state.
    const trap = join(dir, 'trap')
    const trapPath = join(trap, 'decision.db')
    copyDatabase(V1_SOURCE, trapPath, 'c5:trap base')
    const trapStore = openDecisionDatabase(trapPath)
    openedPaths.push({ path: trapPath, where: 'c5:trap production open' })
    await new DecisionProfiles(trapStore).createProfile({ name: 'Trap witness' })
    trapStore.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
    const trapSidecars = sidecars(trapPath)
    expect('trap-wal-has-frames', trapSidecars.find(entry => entry.suffix === '-wal')?.size > 0, trapSidecars)
    // Named .bin on purpose: a sidecar-looking file next to a database would be
    // replayed by SQLite if anyone copied it back.
    const staleWal = join(trap, 'trap-wal.bin')
    const staleShm = join(trap, 'trap-shm.bin')
    copyFileSync(`${trapPath}-wal`, staleWal)
    copyFileSync(`${trapPath}-shm`, staleShm)
    trapStore.close()

    copyFileSync(V1_SOURCE, trapPath)
    copyFileSync(staleWal, `${trapPath}-wal`)
    copyFileSync(staleShm, `${trapPath}-shm`)
    const replaying = new DatabaseSync(trapPath)
    const replayed = {
      userVersion: pragma(replaying, 'user_version').user_version,
      witness: replaying.prepare("SELECT agent_id FROM agent_profiles WHERE name='Trap witness'").get()?.agent_id ?? null,
      integrity: pragma(replaying, 'integrity_check').integrity_check,
    }
    replaying.close()
    expect('trap-reproduced', replayed.userVersion === 2 && Boolean(replayed.witness),
      { note: 'a stale sidecar pair replayed the earlier migrated state over a copied v1 file', replayed })
    // Keep the exact sidecar bytes that caused the replay as named evidence; they
    // are deliberately NOT stored as `<db>-wal`/`-shm`, so opening the trap
    // database later cannot replay them again.
    exportDatabase('trap-stale-wal.bin', staleWal, { kind: 'stale -wal that replayed the older state' })
    exportDatabase('trap-stale-shm.bin', staleShm, { kind: 'stale -shm that replayed the older state' })
    // The replay is checkpointed into the main file by that open, so the main
    // file must be restored from the pristine source before the remedy assertion.
    for (const suffix of ['-wal', '-shm']) rmSync(`${trapPath}${suffix}`, { force: true })
    copyFileSync(V1_SOURCE, trapPath)
    clearSidecars(trapPath)
    const remedied = rawOpen(trapPath)
    const remediedState = {
      userVersion: pragma(remedied, 'user_version').user_version,
      witness: remedied.prepare("SELECT agent_id FROM agent_profiles WHERE name='Trap witness'").get()?.agent_id ?? null,
    }
    remedied.close()
    expect('trap-remedy-clearing-sidecars', remediedState.userVersion === 1 && remediedState.witness === null,
      { note: 'clearing BOTH sidecars keeps the copied v1 state', remediedState })

    // Every copy this spike performs cleared both sidecars, and every destination
    // read back as v1 before production code migrated it.
    expect('every-copy-cleared-sidecars',
      copyOps.length >= 4 && copyOps.every(operation => operation.cleared),
      { copies: copyOps.length, unclean: copyOps.filter(operation => !operation.cleared) })
    expect('copy-read-as-v1-before-migration',
      beforeMigrationVersions.length >= 3 && beforeMigrationVersions.every(entry => entry.version === 1),
      beforeMigrationVersions)

    // The production consistent backup checkpoints (TRUNCATE) before VACUUM INTO,
    // so no committed frames stay behind in a -wal after a backup.
    const flowDir = join(dir, 'flow')
    const flowPath = join(flowDir, 'decision.db')
    copyDatabase(V1_SOURCE, flowPath, 'c5:flow base')
    const flow = openDecisionDatabase(flowPath)
    openedPaths.push({ path: flowPath, where: 'c5:flow production open' })
    await new DecisionProfiles(flow).createProfile({ name: 'Flow writer' })
    const walBefore = sidecars(flowPath).find(entry => entry.suffix === '-wal')
    const backupPath = createConsistentBackup(flow, 2)
    const walAfter = sidecars(flowPath).find(entry => entry.suffix === '-wal')
    expect('consistent-backup-checkpoints-wal', walBefore.size > 0 && walAfter.size === 0,
      { walBefore, walAfter, backupPath })
    const backupDb = rawOpen(backupPath)
    expect('backup-file-self-contained',
      pragma(backupDb, 'user_version').user_version === 2
      && pragma(backupDb, 'integrity_check').integrity_check === 'ok'
      && tableExists(backupDb, 'agent_profiles') && countOf(backupDb, 'agent_profiles') === 5,
      { userVersion: pragma(backupDb, 'user_version').user_version, integrity: pragma(backupDb, 'integrity_check').integrity_check })
    backupDb.close()
    flow.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    flow.close()
    exportDatabase('c5-consistent-backup-v2.db', backupPath, { kind: 'consistent backup of a v2 database' })
  })
}

// ---- 6. backup restore + documented data-loss boundary ----------------------
async function check6_restoreBoundary() {
  return runCheck('6. backup restore + data-loss boundary', async ({ expect, artifact, exportDatabase }) => {
    const { dir, dbPath, version } = prepareV1Copy('c6')
    expect('copy-read-as-v1-before-migration', version === 1, { version })
    const beforeCounts = (() => { const db = rawOpen(dbPath); try { return countsOf(db) } finally { db.close() } })()
    const store = openDecisionDatabase(dbPath)
    openedPaths.push({ path: dbPath, where: 'c6:migrated store before restore' })
    const backups = backupsOf(dbPath)
    const backupPath = backups[0]?.path
    const profiles = new DecisionProfiles(store)
    const cases = new DecisionCases(store)
    const feedback = new DecisionFeedback(store)
    let postProfile
    let postCase
    try {
      // Real writes made after the successful migration.
      postProfile = await profiles.createProfile({ name: 'Post-migration assistant' })
      const created = await cases.createCase({
        workspaceKey: '/repo/one', rootSessionId: 'root-after-migration', entry: 'hook',
        agentId: postProfile.agentId,
        request: { entry: 'hook', questions: [{ id: 'q', question: 'After migration?', options: [{ label: 'A' }] }] },
        scope: { workspaces: ['/repo/one'] }, idempotencyKey: 'post-migration-case',
      })
      postCase = created.case
      await feedback.append({ actor: { kind: 'user' }, caseId: postCase.caseId, kind: 'comment', payload: { text: 'post-migration note' } })
      const afterWrites = {
        profiles: countOf(store.db, 'agent_profiles'),
        cases: countOf(store.db, 'cases'),
        feedback: countOf(store.db, 'feedback'),
      }
      expect('post-migration-write-persisted',
        afterWrites.profiles === beforeCounts.agent_profiles + 1
        && afterWrites.cases === beforeCounts.cases + 1
        && afterWrites.feedback === beforeCounts.feedback + 1,
        { before: beforeCounts, after: afterWrites, agentId: postProfile.agentId, caseId: postCase.caseId })
      record6.writes = { agentId: postProfile.agentId, caseId: postCase.caseId }
      record6.backupPath = backupPath
      store.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
      // Simulate the leftover sidecars a crashed session can leave next to a live
      // database, so the restore's sidecar deletion is actually exercised.
      const staleDir = join(dir, 'stale')
      mkdirSync(staleDir, { recursive: true })
      copyFileSync(`${dbPath}-wal`, join(staleDir, 'pre-restore-wal.bin'))
      copyFileSync(`${dbPath}-shm`, join(staleDir, 'pre-restore-shm.bin'))
    } finally {
      store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      store.close()
    }
    writeLog('c6-post-migration-writes.log', JSON.stringify({ agentId: postProfile?.agentId, caseId: postCase?.caseId, boundary: DATA_LOSS_BOUNDARY }, null, 2))
    exportDatabase('c6-migrated-before-restore.db', dbPath, { kind: 'migrated database with post-migration writes', copyBeforeRestore: true })

    // The restore path needs every connection closed; put the stale sidecars back
    // first so restoreConsistentBackup has something to remove.
    copyFileSync(join(dir, 'stale', 'pre-restore-wal.bin'), `${dbPath}-wal`)
    copyFileSync(join(dir, 'stale', 'pre-restore-shm.bin'), `${dbPath}-shm`)
    artifact('c6-pre-restore-wal.bin', join(dir, 'stale', 'pre-restore-wal.bin'), { kind: 'stale -wal placed before restore' })
    artifact('c6-pre-restore-shm.bin', join(dir, 'stale', 'pre-restore-shm.bin'), { kind: 'stale -shm placed before restore' })
    expect('stale-sidecars-present-before-restore', sidecars(dbPath).every(entry => entry.exists), sidecars(dbPath))
    restoreConsistentBackup(dbPath, backupPath)
    expect('restore-clears-sidecars', sidecars(dbPath).every(entry => entry.exists === false), sidecars(dbPath))
    expect('restored-bytes-equal-backup', fileHash(dbPath) === fileHash(backupPath),
      { restored: fileHash(dbPath), backup: fileHash(backupPath) })

    const restored = rawOpen(dbPath)
    try {
      const restoredVersion = pragma(restored, 'user_version').user_version
      expect('restored-state-is-v1',
        restoredVersion === 1 && columnNames(restored, 'agent_profiles').includes('workspace_key'),
        { userVersion: restoredVersion, profileColumns: columnNames(restored, 'agent_profiles') })
      expect('restored-integrity-ok', pragma(restored, 'integrity_check').integrity_check === 'ok')
      const restoredCounts = countsOf(restored)
      expect('restored-legacy-rows-intact',
        JSON.stringify(restoredCounts) === JSON.stringify(beforeCounts)
        && JSON.stringify(JSON.parse(restored.prepare("SELECT pins_json FROM attempts WHERE attempt_id='at_w1'").get().pins_json)) === '{"memorySnapshotId":"ms_w1"}'
        && restored.prepare("SELECT COUNT(*) AS n FROM memory_snapshots WHERE snapshot_id='ms_w1'").get().n === 1,
        { before: beforeCounts, restored: restoredCounts })
      expect('post-migration-write-gone',
        restored.prepare("SELECT COUNT(*) AS n FROM agent_profiles WHERE name='Post-migration assistant'").get().n === 0
        && restored.prepare("SELECT COUNT(*) AS n FROM cases WHERE idempotency_key='post-migration-case'").get().n === 0
        && restored.prepare("SELECT COUNT(*) AS n FROM feedback WHERE payload_json LIKE '%post-migration note%'").get().n === 0,
        { agentId: record6.writes.agentId, caseId: record6.writes.caseId })
    } finally { restored.close() }
    exportDatabase('c6-restored-v1.db', dbPath, { kind: 'restored consistent backup (pre-migration v1 state)' })

    // Reopening the restored v1 database with production code re-runs the
    // migration; the discarded post-migration writes stay gone.
    const reopened = openDecisionDatabase(dbPath)
    openedPaths.push({ path: dbPath, where: 'c6:reopen restored v1 with production code' })
    try {
      expect('re-migration-from-restored-state-ok',
        pragma(reopened.db, 'user_version').user_version === 2
        && pragma(reopened.db, 'integrity_check').integrity_check === 'ok'
        && countOf(reopened.db, 'memory_snapshots') === beforeCounts.memory_snapshots
        && countOf(reopened.db, 'agent_profiles') === beforeCounts.agent_profiles
        && reopened.db.prepare("SELECT COUNT(*) AS n FROM cases WHERE idempotency_key='post-migration-case'").get().n === 0,
        { userVersion: pragma(reopened.db, 'user_version').user_version, backups: backupsOf(dbPath).map(backup => backup.name) })
      expect('documented-data-loss-boundary',
        backsUpAfterRestore(dbPath) === 2 && backupsOf(dbPath).every(backup => backup.userVersion === 1),
        { backups: backupsOf(dbPath).map(backup => ({ name: backup.name, userVersion: backup.userVersion })), boundary: DATA_LOSS_BOUNDARY })
    } finally {
      reopened.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      reopened.close()
    }
    record6.boundary = DATA_LOSS_BOUNDARY
    artifact('c6-backups-directory.json', writeJsonArtifact('c6-backups-directory.json', backupsOf(dbPath)))
  })
}
/** @param {string} dbPath */
function backsUpAfterRestore(dbPath) {
  return backupsOf(dbPath).length
}
/** @param {string} name @param {unknown} value */
function writeJsonArtifact(name, value) {
  mkdirSync(ARTIFACTS, { recursive: true })
  const path = join(ARTIFACTS, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}
const record6 = { writes: /** @type {any} */ ({}), backupPath: '', boundary: '' }

// ---- 7. archive / restart does not resurrect memory ------------------------
async function check7_archiveRestart() {
  return runCheck('7. archive / restart does not resurrect memory', async ({ expect, artifact, exportDatabase }) => {
    const dir = rootOf('c7')
    const workspaces = ['one', 'two'].map(name => {
      const path = join(dir, name)
      mkdirSync(path, { recursive: true })
      return realpathSync(path)
    })
    const [w1, w2] = workspaces
    const agents = {
      root1: { id: 'root1', session: { header: { id: 'root1', cwd: w1, delegationDepth: 0 } } },
      root2: { id: 'root2', session: { header: { id: 'root2', cwd: w2, delegationDepth: 0 } } },
    }
    const profileContext = { home: join(dir, 'home'), name: 'accept' }
    const config = () => ({ decisionAgentsEnabled: true, decisionAgentRetentionDays: 0 })
    const broker = new DecisionBroker({ profileContext, ctx: { agents: { get: id => agents[id] } }, config, now: () => 1000 })
    openedPaths.push({ path: join(dir, 'home'), where: 'c7:isolated broker profile home' })
    await broker.ensureStore()
    const dbPath = broker.databasePath()
    const evidence = new DecisionEvidence(broker.store)

    const profile = await broker.profileUpsert({
      // Legacy scope input: the retired class array is accepted and ignored, never echoed.
      name: 'Archive me', userDescription: 'Prefer A', scope: { authorizationClasses: ['A', 'B', 'C'] },
    })
    // A closed, validated answered Case gives the private zone a real source.
    const { case: created } = await broker.cases.createCase({
      workspaceKey: w1, rootSessionId: 'root1', entry: 'hook', agentId: profile.agentId,
      request: { entry: 'hook', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
      scope: { workspaces: [w1] }, idempotencyKey: 'archive-seed',
    })
    let current = await broker.cases.transition({ caseId: created.caseId, expectedState: 'received', expectedRevision: created.revision, state: 'evaluating' })
    const attempt = await broker.attempts.start({ caseId: current.caseId, agentId: profile.agentId, pins: {}, contextPackHash: 'archive-hash', packManifest: {} })
    await broker.attempts.finish(attempt.attemptId, { outcome: 'answer', citedEvidenceIds: [] })
    current = broker.cases.getCase(current.caseId)
    current = await broker.cases.transition({
      caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision,
      state: 'closed', closing: 'answered',
      decision: { kind: 'answer', attemptId: attempt.attemptId, answers: [{ id: 'q', selected: ['A'] }], decidedAt: 1000 },
    })
    await broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: current.caseId, attemptId: attempt.attemptId, kind: 'rating_up' })
    const sourceCase = broker.cases.getCase(current.caseId)

    const privateRun = await broker.learning.beginRun({
      agentId: profile.agentId, workspaceKey: w1, requestId: 'accept-private', startedAt: 2000,
      agentProfileRevision: profile.revision, modelRoute: MODEL_ROUTE,
    })
    const privateCandidate = await broker.learning.commitCandidate({
      learningRunId: privateRun.run.learningRunId, expectedRevision: privateRun.run.revision,
      operations: [{ op: 'add', principleId: 'pr_priv', text: 'Prefer A when asked', scope: { workspaces: [w1] }, sources: [sourceCase.caseId] }],
      replay: EMPTY_REPLAY,
      principles: [{ principleId: 'pr_priv', text: 'Prefer A when asked', scope: { workspaces: [w1] }, sources: [sourceCase.caseId], state: 'active' }],
    })
    const privatePublished = await broker.learning.publish(privateCandidate.snapshot.snapshotId, privateCandidate.snapshot.revision)
    expect('private-snapshot-published', privatePublished.snapshot?.state === 'published', privatePublished.error ?? privatePublished.run?.outcome)

    const publicRun = await broker.learning.beginPublicRun({
      agentId: profile.agentId, requestId: 'accept-public', startedAt: 3000,
      agentProfileRevision: profile.revision, modelRoute: MODEL_ROUTE,
    })
    const publicCandidate = await broker.learning.commitCandidate({
      learningRunId: publicRun.run.learningRunId, expectedRevision: publicRun.run.revision,
      operations: [{ op: 'add', principleId: 'pr_pub', text: 'Prefer option A when the question is ambiguous', scope: {}, sources: [sourceCase.caseId] }],
      replay: EMPTY_REPLAY,
      principles: [{ principleId: 'pr_pub', text: 'Prefer option A when the question is ambiguous', scope: {}, sources: [sourceCase.caseId], state: 'active' }],
    })
    const publicPublished = await broker.learning.publish(publicCandidate.snapshot.snapshotId, publicCandidate.snapshot.revision)
    expect('public-snapshot-published', publicPublished.snapshot?.state === 'published', publicPublished.error ?? publicPublished.run?.outcome)

    // Drafts left unpublished so the archived publish guard has something to block.
    const privateDraftRun = await broker.learning.beginRun({
      agentId: profile.agentId, workspaceKey: w1, requestId: 'accept-private-draft', startedAt: 4000,
      agentProfileRevision: profile.revision, modelRoute: MODEL_ROUTE,
    })
    const privateDraft = await broker.learning.commitCandidate({
      learningRunId: privateDraftRun.run.learningRunId, expectedRevision: privateDraftRun.run.revision,
      operations: [], replay: EMPTY_REPLAY, principles: [],
    })
    const publicDraftRun = await broker.learning.beginPublicRun({
      agentId: profile.agentId, requestId: 'accept-public-draft', startedAt: 5000,
      agentProfileRevision: profile.revision, modelRoute: MODEL_ROUTE,
    })
    const publicDraft = await broker.learning.commitCandidate({
      learningRunId: publicDraftRun.run.learningRunId, expectedRevision: publicDraftRun.run.revision,
      operations: [], replay: EMPTY_REPLAY, principles: [],
    })

    const l5 = broker.store.db.prepare("SELECT evidence_id FROM evidence WHERE agent_id=? AND status='active'").all(profile.agentId)
      .map(row => evidence.get(row.evidence_id))
    const privateRequest = { agentId: profile.agentId, workspaceKey: w1, scope: { workspaces: [w1] } }
    const enabledPrivate = readL2Memory(broker.store, privateRequest, l5, { agentState: 'enabled' })
    const enabledPublic = readPublicL2Memory(broker.store, { agentId: profile.agentId, scope: {} }, { agentState: 'enabled', evidence })
    expect('private-memory-populated-before-archive',
      enabledPrivate.status === 'populated' && enabledPrivate.items.some(item => item.principleId === 'pr_priv'),
      { status: enabledPrivate.status, items: enabledPrivate.items.map(item => item.principleId), exclusions: enabledPrivate.exclusions })
    expect('public-memory-populated-before-archive',
      enabledPublic.status === 'populated' && enabledPublic.items.some(item => item.principleId === 'pr_pub'),
      { status: enabledPublic.status, items: enabledPublic.items.map(item => item.principleId), exclusions: enabledPublic.exclusions })

    const historyTables = ['cases', 'attempts', 'evidence', 'feedback', 'corrections', 'memory_snapshots', 'learning_runs']
    const historyHash = () => {
      const dump = Object.fromEntries(historyTables.map(table => [table, rowsOf(broker.store.db, table)]))
      return sha256(JSON.stringify(dump))
    }
    const historyBeforeArchive = historyHash()
    const publicSnapshotsBefore = broker.store.db.prepare("SELECT snapshot_id,state,version FROM memory_snapshots WHERE zone='public' ORDER BY version").all()
    const privateSnapshotsBefore = broker.store.db.prepare("SELECT snapshot_id,state,version FROM memory_snapshots WHERE zone='workspace' ORDER BY version").all()

    // Archive through the production broker API.
    const archived = await broker.profileSetState(profile.agentId, 'archived')
    expect('archive-sets-state', archived.state === 'archived' && Number.isSafeInteger(archived.archivedAt), { state: archived.state, archivedAt: archived.archivedAt })
    expect('history-unchanged-by-archive', historyHash() === historyBeforeArchive,
      { before: historyBeforeArchive, after: historyHash() })

    const archivedPrivate = readL2Memory(broker.store, privateRequest, l5, { agentState: 'archived' })
    const archivedPublic = readPublicL2Memory(broker.store, { agentId: profile.agentId, scope: {} }, { agentState: 'archived', evidence })
    expect('archived-private-memory-unusable',
      archivedPrivate.status === 'empty' && archivedPrivate.snapshotId === null && archivedPrivate.items.length === 0,
      { status: archivedPrivate.status, snapshotId: archivedPrivate.snapshotId })
    expect('archived-public-memory-unusable',
      archivedPublic.status === 'empty' && archivedPublic.snapshotId === null && archivedPublic.items.length === 0,
      { status: archivedPublic.status, snapshotId: archivedPublic.snapshotId })

    const route = planAutoRoute({
      request: { entry: 'hook', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }] }] },
      scope: { workspaces: [w1] },
      profiles: broker.profiles.listProfiles({ includeArchived: true }),
    })
    expect('archived-not-in-auto-candidates',
      route.eligible.length === 0 && route.candidates.every(candidate => candidate.agentId !== profile.agentId),
      { eligible: route.eligible.map(candidate => candidate.agentId), candidates: route.candidates })

    // A route that still chooses the archived identity cannot start an attempt.
    const routed = await broker.cases.createCase({
      workspaceKey: w1, rootSessionId: 'root1', entry: 'hook',
      request: { entry: 'hook', questions: [{ id: 'q', question: 'Route after archive?', options: [{ label: 'A' }] }] },
      scope: { workspaces: [w1] }, idempotencyKey: 'archive-route',
    })
    const routedCase = await broker.cases.transitionWithRoute({
      caseId: routed.case.caseId, expectedState: 'received', expectedRevision: routed.case.revision,
      state: 'evaluating', agentId: profile.agentId,
    }, {
      mode: 'auto', caseId: routed.case.caseId, rootSessionId: 'root1', chosen: profile.agentId,
      candidates: [{ agentId: profile.agentId, enabled: true }], reason: 'deterministic:single_candidate',
    })
    expect('archived-cannot-be-auto-routed',
      routedCase.state === 'awaiting_user' && routedCase.awaitingReason === 'no_route' && routedCase.agentId === null
      && broker.store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE case_id=?").get(routed.case.caseId).n === 0,
      { state: routedCase.state, awaitingReason: routedCase.awaitingReason, agentId: routedCase.agentId })
    const selectAttempt = await throwsCode(() => broker.setSelector('root-new', 'agent', profile.agentId))
    expect('archived-not-selectable', selectAttempt.code === 'AGENT_UNAVAILABLE', selectAttempt)

    const privatePublish = await throwsCode(() => broker.snapshotPublish({
      sessionId: 'root1', snapshotId: privateDraft.snapshot.snapshotId, expectedRevision: privateDraft.snapshot.revision,
    }))
    const publicPublishBlocked = await throwsCode(() => broker.snapshotPublish({
      sessionId: 'root2', snapshotId: publicDraft.snapshot.snapshotId, expectedRevision: publicDraft.snapshot.revision,
    }))
    expect('archived-cannot-publish-private-draft', privatePublish.code === 'AGENT_UNAVAILABLE', privatePublish)
    expect('archived-cannot-publish-public-draft', publicPublishBlocked.code === 'AGENT_UNAVAILABLE', publicPublishBlocked)

    // History stays readable inside its own workspace only, and read-only.
    const history = await broker.memorySnapshot({ sessionId: 'root1', snapshotId: privatePublished.snapshot.snapshotId })
    const foreignRead = await throwsCode(() => broker.memorySnapshot({ sessionId: 'root2', snapshotId: privatePublished.snapshot.snapshotId }))
    expect('private-history-readable-only-in-own-workspace',
      history.snapshotId === privatePublished.snapshot.snapshotId && history.state === 'published'
      && history.zone === 'workspace' && history.namespaceWorkspaceKey === w1
      && foreignRead.code === 'OUT_OF_SCOPE',
      { snapshotId: history.snapshotId, state: history.state, foreignRead })

    const hashBeforeClose = historyHash()
    const backupsBeforeRestart = backupsOf(dbPath)
    broker.store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    await broker.flush()
    expect('closed-store-leaves-no-sidecars', sidecars(dbPath).every(entry => entry.exists === false), sidecars(dbPath))
    exportDatabase('c7-archived-before-restart.db', dbPath, { kind: 'v2 store with an archived assistant and both memory zones' })

    // Cold restart: a brand-new broker instance opens the same store.
    const restarted = new DecisionBroker({ profileContext, ctx: { agents: { get: id => agents[id] } }, config, now: () => 6000 })
    const status = await restarted.start()
    expect('cold-reopen-store-available', status.available === true && Boolean(restarted.store), status)
    exportDatabase('c7-archived-after-restart.db', dbPath, { kind: 'same store cold-reopened by a fresh broker' })
    try {
      const reopenedProfile = restarted.profiles.getProfile(profile.agentId)
      expect('cold-reopen-history-unchanged',
        historyHashOf(restarted.store.db, historyTables) === hashBeforeClose
        && reopenedProfile.state === 'archived'
        && pragma(restarted.store.db, 'user_version').user_version === 2
        && pragma(restarted.store.db, 'integrity_check').integrity_check === 'ok',
        { historyUnchanged: historyHashOf(restarted.store.db, historyTables) === hashBeforeClose, state: reopenedProfile.state })
      const publicAfter = restarted.store.db.prepare("SELECT snapshot_id,state,version FROM memory_snapshots WHERE zone='public' ORDER BY version").all()
      const privateAfter = restarted.store.db.prepare("SELECT snapshot_id,state,version FROM memory_snapshots WHERE zone='workspace' ORDER BY version").all()
      expect('cold-reopen-no-new-public-snapshot',
        JSON.stringify(publicAfter) === JSON.stringify(publicSnapshotsBefore)
        && JSON.stringify(privateAfter) === JSON.stringify(privateSnapshotsBefore)
        && publicAfter.every(row => row.state !== 'published' || publicSnapshotsBefore.some(before => before.snapshot_id === row.snapshot_id))
        && publicAfter.filter(row => row.state === 'published').length === 1,
        { publicBefore: publicSnapshotsBefore, publicAfter })
      const restartedEvidence = new DecisionEvidence(restarted.store)
      const restartedPrivate = readL2Memory(restarted.store, privateRequest, l5, { agentState: reopenedProfile.state })
      const restartedPublic = readPublicL2Memory(restarted.store, { agentId: profile.agentId, scope: {} }, { agentState: reopenedProfile.state, evidence: restartedEvidence })
      expect('cold-reopen-memory-still-unusable',
        restartedPrivate.status === 'empty' && restartedPublic.status === 'empty'
        && restarted.store.db.prepare("SELECT COUNT(*) AS n FROM learning_runs WHERE outcome='running'").get().n === 0,
        { private: restartedPrivate.status, public: restartedPublic.status })
      const restartedRoute = planAutoRoute({
        request: { entry: 'hook', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }] }] },
        scope: { workspaces: [w1] },
        profiles: restarted.profiles.listProfiles({ includeArchived: true }),
      })
      expect('cold-reopen-no-archived-candidates',
        restartedRoute.eligible.length === 0 && restartedRoute.candidates.every(candidate => candidate.agentId !== profile.agentId),
        { eligible: restartedRoute.eligible.map(candidate => candidate.agentId), candidates: restartedRoute.candidates })
    } finally {
      restarted.store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      await restarted.flush()
    }

    // Process-level cold open: a fresh OS process opens the same store with the
    // production module and reports the state it sees. No DSH boot and no port.
    const childScript = `
import { openDecisionDatabase } from ${JSON.stringify(pathToFileURL(join(REPO, 'plugins/weir-harness/src/decision/store/db.js')).href)}
const store = openDecisionDatabase(process.env.WEIR_ACCEPT_DB)
const state = {
  pid: process.pid,
  userVersion: store.db.prepare('PRAGMA user_version').get().user_version,
  integrity: store.db.prepare('PRAGMA integrity_check').get().integrity_check,
  profile: store.db.prepare('SELECT agent_id,state,archived_at FROM agent_profiles WHERE agent_id=?').get(process.env.WEIR_ACCEPT_AGENT),
  publicSnapshots: store.db.prepare("SELECT snapshot_id,state,version FROM memory_snapshots WHERE zone='public' ORDER BY version").all(),
  privateSnapshots: store.db.prepare("SELECT snapshot_id,state,version FROM memory_snapshots WHERE zone='workspace' ORDER BY version").all(),
  runningRuns: store.db.prepare("SELECT COUNT(*) AS n FROM learning_runs WHERE outcome='running'").get().n,
}
store.close()
process.stdout.write(JSON.stringify(state))
`
    const childRun = runChild('cold-open-process', [NODE, '--input-type=module', '-e', childScript], {
      env: { ...process.env, WEIR_ACCEPT_DB: dbPath, WEIR_ACCEPT_AGENT: profile.agentId },
    })
    writeLog('c7-process-cold-open.log', childRun.stdout)
    const childState = JSON.parse(childRun.stdout)
    expect('process-level-cold-open',
      childState.pid !== process.pid
      && childState.userVersion === 2 && childState.integrity === 'ok'
      && childState.profile?.state === 'archived'
      && childState.runningRuns === 0
      && JSON.stringify(childState.publicSnapshots) === JSON.stringify(publicSnapshotsBefore)
      && JSON.stringify(childState.privateSnapshots) === JSON.stringify(privateSnapshotsBefore),
      childState)
    expect('process-cold-open-no-new-backup', JSON.stringify(backupsOf(dbPath)) === JSON.stringify(backupsBeforeRestart),
      { backups: backupsOf(dbPath).map(backup => backup.name) })
    expect('no-public-snapshot-reappears',
      childState.publicSnapshots.filter(row => row.state === 'published').length === 1
      && childState.publicSnapshots.length === publicSnapshotsBefore.length
      && sidecars(dbPath).every(entry => entry.exists === false),
      { public: childState.publicSnapshots, sidecars: sidecars(dbPath) })
    record7.processColdOpen = true
  })
}
/** @param {any} db @param {string[]} tables */
function historyHashOf(db, tables) {
  return sha256(JSON.stringify(Object.fromEntries(tables.map(table => [table, rowsOf(db, table)]))))
}
const record7 = { processColdOpen: false }

// ---- 8. isolation ----------------------------------------------------------
async function check8_isolation() {
  return runCheck('8. isolation', async ({ expect, artifact, exportDatabase }) => {
    const insideReal = (path) => path === REAL_APP_DATA || path.startsWith(`${REAL_APP_DATA}${sep}`)
    expect('evidence-outside-app-data',
      !insideReal(EVIDENCE) && !insideReal(ROOTS) && !insideReal(ARTIFACTS) && EVIDENCE !== REPO,
      { evidence: EVIDENCE, repo: REPO, realAppData: REAL_APP_DATA })
    const openedReal = openedPaths.filter(entry => insideReal(entry.path))
    const openedOutsideEvidence = openedPaths.filter(entry => entry.path !== EVIDENCE && !entry.path.startsWith(`${EVIDENCE}${sep}`))
    expect('no-real-store-opened',
      openedReal.length === 0 && openedOutsideEvidence.length === 0 && openedPaths.length >= 5,
      { opened: openedPaths.length, real: openedReal, outsideEvidence: openedOutsideEvidence })
    const realStoreStatAfter = Object.fromEntries(Object.entries(REAL_STORE_PATHS).map(([key, path]) => [key, statOf(path)]))
    expect('real-store-untouched', JSON.stringify(realStoreStatAfter) === JSON.stringify(realStoreStatBefore),
      { note: 'only stat() was ever called on these paths; exists:false means the directory is absent in this environment', before: realStoreStatBefore, after: realStoreStatAfter })
    const listenerReport = {}
    let listenersChanged = false
    for (const port of GUARDED_PORTS) {
      const after = listeners(port)
      listenerReport[port] = { before: startedListeners[port], after }
      if (after !== null && startedListeners[port] !== null && after !== startedListeners[port]) listenersChanged = true
    }
    expect('no-listener-left', !listenersChanged, listenerReport)
    expect('gui-url-untouched', listeners(53413) === startedListeners[53413], { gui: listeners(53413) })
    expect('child-processes-exited',
      children.length >= 2 && children.every(child => child.exitCode === 0),
      { children })
    // Evidence hygiene: no database under roots/ may keep a sidecar next to it, so
    // opening any evidence copy cannot replay a different stage's write-ahead log.
    const swept = clearRootsSidecars()
    expect('roots-sidecars-cleared', swept.remaining.length === 0, swept)
    artifact('isolation.json', writeJsonArtifact('isolation.json', {
      evidenceRoot: EVIDENCE, repo: REPO, realAppData: REAL_APP_DATA,
      openedPaths, copyOps, children, listeners: listenerReport, realStorePaths: REAL_STORE_PATHS,
      realStoreStatBefore, realStoreStatAfter, sidecarSweep: swept,
    }))
  })
}

// ---- report ----------------------------------------------------------------
/**
 * Mapping from each required acceptance sub-check to the assertion names that
 * prove it. Rendered into REPORT.md and verified against the recorded
 * assertions, so the report cannot claim a check that never ran.
 */
const REQUIREMENTS = [
  {
    check: '1. real v1 fixture',
    items: [
      ['A genuine v1 database generated through the existing fixture generator as a CLI child process', ['fixture-generator-exit-0', 'fixture-generator-report']],
      ['Legacy shape: workspace-keyed profiles', ['legacy-profiles-workspace-key-column']],
      ['Existing Cases/Attempts/private Snapshots', ['legacy-private-snapshot-exists', 'legacy-memory-without-zone', 'legacy-runs-without-namespace']],
      ['An old Attempt carrying only pins.memorySnapshotId', ['legacy-attempt-single-pin']],
      ['PRAGMA user_version=1, row counts and a content hash recorded before migration', ['source-is-v1', 'row-counts-recorded', 'content-hash-recorded']],
    ],
  },
  {
    check: '2. migration v1 -> v2',
    items: [
      ['PRAGMA user_version=2', ['user-version-2']],
      ['The checkpoint + VACUUM INTO backup exists at the exact expected path', ['backup-exists-exact-path', 'backup-count-one', 'backup-is-consistent-v1']],
      ['PRAGMA integrity_check = ok', ['integrity-check-ok']],
      ['Zero row loss', ['zero-row-loss']],
      ['agent_profiles becomes profile-global with NOCASE-unique names', ['profiles-profile-global', 'profiles-nocase-unique-index', 'profiles-create-duplicate-name-rejected']],
      ['Duplicate legacy names stay distinct identities with deterministic names and no automatic merge', ['profiles-duplicate-names-deterministic', 'profiles-no-auto-merge', 'profiles-legacy-origin-alias-only']],
      ['Learning runs/snapshots get the correct zone + namespace_workspace_key', ['learning-namespace-private']],
      ['The public zone has zero snapshots', ['public-zone-empty']],
    ],
  },
  {
    check: '3. immutable history',
    items: [
      ['Old Attempt rows keep their bytes and semantics', ['attempt-columns-unchanged', 'attempt-fields-identical']],
      ['Case, Evidence and Feedback rows are not rewritten', ['case-columns-unchanged', 'case-fields-identical', 'evidence-columns-unchanged', 'evidence-fields-identical', 'feedback-columns-unchanged', 'feedback-fields-identical', 'no-row-rewritten']],
      ['Learning Run and Snapshot legacy fields are identical', ['learning-run-v1-column-prefix-unchanged', 'learning-run-fields-identical', 'snapshot-v1-column-prefix-unchanged', 'snapshot-fields-identical']],
      ['The legacy pins.memorySnapshotId still resolves to the SAME private Snapshot', ['legacy-pin-resolves-same-private-snapshot']],
      ['New columns are additive defaults only', ['new-columns-additive-defaults']],
      ['No Attempt/Answer/Feedback/Snapshot row was rewritten (revisions unchanged)', ['revisions-unchanged', 'profile-shared-fields-identical']],
      ['The compared fields are stated explicitly', ['attempt-fields-identical', 'case-fields-identical', 'evidence-fields-identical', 'feedback-fields-identical', 'learning-run-fields-identical', 'snapshot-fields-identical']],
    ],
  },
  {
    check: '4. idempotence / repeat safety',
    items: [
      ['A second production migration run applies nothing and creates no divergent migration', ['second-run-applies-nothing', 'second-run-schema-unchanged', 'no-rebuild-table-left-behind']],
      ['No duplicate backup is written or overwritten', ['second-run-no-new-backup', 'backup-bytes-untouched', 'third-run-no-new-backup']],
      ['Identical row counts and content hash', ['second-run-identical-content', 'third-run-fresh-store-identical']],
      ['user_version stays 2', ['second-run-user-version-2', 'third-run-user-version-2']],
      ['integrity_check stays ok', ['second-run-integrity-ok', 'third-run-integrity-ok']],
      ['A third run through a fresh store open is identical', ['third-run-fresh-store-identical', 'third-run-schema-unchanged']],
    ],
  },
  {
    check: '5. WAL/SHM hygiene',
    items: [
      ['Close leaves no stale -wal/-shm sidecar', ['migrated-close-leaves-no-sidecars']],
      ['State after close and reopen is identical', ['post-close-reopen-state-identical']],
      ['The known fixture trap is re-verified: a stale sidecar pair replays an older state', ['trap-wal-has-frames', 'trap-reproduced']],
      ['Clearing both sidecars avoids the replay', ['trap-remedy-clearing-sidecars']],
      ['Every copy in this flow clears both sidecars and reads back as v1 before migration', ['every-copy-cleared-sidecars', 'copy-read-as-v1-before-migration']],
      ['The production backup checkpoints the WAL before VACUUM INTO', ['consistent-backup-checkpoints-wal', 'backup-file-self-contained']],
    ],
  },
  {
    check: '6. backup restore + data-loss boundary',
    items: [
      ['A real post-migration write happens first', ['post-migration-write-persisted']],
      ['The production restore path is used with stale sidecars present', ['stale-sidecars-present-before-restore', 'restore-clears-sidecars', 'restored-bytes-equal-backup']],
      ['The restore yields the pre-migration v1 state with integrity_check=ok', ['restored-state-is-v1', 'restored-integrity-ok', 'restored-legacy-rows-intact']],
      ['The post-migration write is GONE', ['post-migration-write-gone']],
      ['The documented data-loss boundary is recorded explicitly', ['documented-data-loss-boundary']],
      ['Reopening the restored database re-migrates cleanly', ['re-migration-from-restored-state-ok']],
    ],
  },
  {
    check: '7. archive / restart does not resurrect memory',
    items: [
      ['An archived assistant has a private Snapshot and a public Snapshot', ['private-snapshot-published', 'public-snapshot-published', 'private-memory-populated-before-archive', 'public-memory-populated-before-archive']],
      ['Archiving uses the production store/broker API', ['archive-sets-state']],
      ['Archived identity does not participate in new candidates/attempts', ['archived-not-in-auto-candidates', 'archived-cannot-be-auto-routed', 'archived-not-selectable']],
      ['Its public and private namespaces no longer authorize memory', ['archived-private-memory-unusable', 'archived-public-memory-unusable']],
      ['History stays read-only and unchanged', ['history-unchanged-by-archive', 'private-history-readable-only-in-own-workspace', 'archived-cannot-publish-private-draft', 'archived-cannot-publish-public-draft']],
      ['A cold reopen (fresh store instance) keeps every property', ['closed-store-leaves-no-sidecars', 'cold-reopen-store-available', 'cold-reopen-history-unchanged', 'cold-reopen-memory-still-unusable', 'cold-reopen-no-archived-candidates']],
      ['No public snapshot reappears', ['cold-reopen-no-new-public-snapshot', 'no-public-snapshot-reappears']],
      ['A fresh OS process cold-open sees the same state', ['process-level-cold-open', 'process-cold-open-no-new-backup']],
    ],
  },
  {
    check: '8. isolation',
    items: [
      ['Everything runs under an isolated root outside the App data directory', ['evidence-outside-app-data', 'no-real-store-opened']],
      ['No evidence database keeps a replayable sidecar', ['roots-sidecars-cleared']],
      ['The user’s real Decision store is untouched', ['real-store-untouched']],
      ['No listener is left and the current GUI URL is untouched', ['no-listener-left', 'gui-url-untouched']],
      ['Every spawned process exited', ['child-processes-exited']],
    ],
  },
]

/** @param {{checks:object[],report:any}} input */
function renderMarkdown(input) {
  const lines = []
  lines.push('# Decision store v1 -> v2 migration acceptance (task 7.4)')
  lines.push('')
  lines.push(`Generated: ${input.report.generatedAt}  `)
  lines.push(`By: \`${input.report.generatedBy}\`  `)
  lines.push(`Lane commit: \`${input.report.lane.head}\`  `)
  lines.push(`Evidence root: \`${EVIDENCE}\`  `)
  lines.push(`Verdict: **${input.report.verdict}**`)
  lines.push('')
  lines.push('Every row below is produced by driving the real production modules (`store/migrate.js`,')
  lines.push('`store/schema.js`, `store/profiles.js`, `store/learning.js`, `store/cases.js`, `broker.js`,')
  lines.push('`retrieval/memory.js`, `router.js`). Raw databases, row dumps, hashes and child-process logs')
  lines.push('live under `artifacts/`, `roots/` and `logs/`.')
  lines.push('')
  lines.push('## Check results')
  lines.push('')
  lines.push('| # | Check | Result | Assertions | Evidence |')
  lines.push('|---|---|---|---|---|')
  for (const record of input.checks) {
    const evidence = record.artifacts.map(entry => `\`${entry.path.replace(`${EVIDENCE}/`, '')}\``).join('<br>') || '—'
    lines.push(`| ${record.label.split('.')[0]} | ${record.label.replace(/^\d+\.\s*/, '')} | ${record.ok ? 'PASS' : 'FAIL'} | ${record.assertions.length} | ${evidence} |`)
  }
  lines.push('')
  lines.push('## Required sub-check -> evidence mapping')
  lines.push('')
  for (const group of REQUIREMENTS) {
    const record = input.checks.find(value => value.label === group.check)
    lines.push(`### ${group.check} — ${record?.ok ? 'PASS' : 'FAIL'}`)
    lines.push('')
    if (record?.error) lines.push(`Failure: \`${record.error}\``)
    lines.push('')
    lines.push('| Required sub-check | Assertions | Observed |')
    lines.push('|---|---|---|')
    for (const [requirement, names] of group.items) {
      const observed = names.map(name => {
        const assertion = record?.assertions.find(value => value.name === name)
        return assertion ? `${name}=${assertion.ok ? 'ok' : 'FAILED'}` : `${name}=MISSING`
      })
      lines.push(`| ${requirement} | ${names.map(name => `\`${name}\``).join(', ')} | ${observed.join('<br>')} |`)
    }
    lines.push('')
  }
  lines.push('## Recorded values')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(input.report.observed, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('## Documented data-loss boundary')
  lines.push('')
  lines.push(input.report.dataLossBoundary.text)
  lines.push('')
  lines.push(`Evidence: restored database \`${input.report.dataLossBoundary.evidence.restoredDatabase}\`,`)
  lines.push(`backup \`${input.report.dataLossBoundary.evidence.backup}\`, log \`${input.report.dataLossBoundary.evidence.log}\`.`)
  lines.push('')
  lines.push('## Scope notes and assumptions')
  lines.push('')
  for (const note of input.report.notes) lines.push(`- ${note}`)
  lines.push('')
  return lines.join('\n')
}

/** @param {string} command */
function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
  } catch { return 'unknown' }
}

/** @param {string[]} args */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
  } catch { return 'unknown' }
}

function writeReports() {
  const mappingGaps = []
  for (const group of REQUIREMENTS) {
    const record = results.find(value => value.label === group.check)
    if (!record) { mappingGaps.push({ check: group.check, missing: 'check did not run' }); continue }
    const names = new Set(record.assertions.map(assertion => assertion.name))
    for (const [, asserted] of group.items) {
      for (const name of asserted) if (!names.has(name)) mappingGaps.push({ check: group.check, missing: name })
    }
  }
  const ok = results.length === REQUIREMENTS.length && results.every(record => record.ok) && mappingGaps.length === 0
  const headlessDir = join(dirname(EVIDENCE), 'headless')
  const headlessFiles = existsSync(headlessDir) ? readdirSync(headlessDir) : []
  const report = {
    schema: 'decision-migration-acceptance/1',
    notes: [
      'Only the v1 fixture is shared with the existing generator; every migration, backup, restore, archive and memory read goes through production code (no reimplementation, no product-code edits).',
      'The fixture workspace keys are synthetic (`/repo/one`, `/repo/two`) because the generator owns them; the archive/restart check uses its own isolated v2 store with real workspace directories.',
      'A direct SQL insert is used only as a negative control that the NOCASE-unique profile index really rejects a duplicate name; the positive path asserts the production PROFILE_NAME_TAKEN contract.',
      `Process-level restart: a real fresh OS process cold-opens the same store (\`logs/c7-process-cold-open.log\`). A full DSH headless boot/restart belongs to task 7.2: at the time of this run \`${headlessDir}\` contained ${headlessFiles.length} file(s), so it is not cited as pre-existing evidence here. This spike starts no DSH process and binds no port.`,
      `Isolation: nothing outside \`${EVIDENCE}\` was opened; the App data directory (${REAL_APP_DATA}) does not exist in this environment and was only ever stat()ed, before and after.`,
    ],
    generatedAt: new Date().toISOString(),
    generatedBy: 'plugins/weir-test-harness/spikes/decision/migration-acceptance.mjs',
    verdict: ok ? 'PASS' : 'FAIL',
    evidenceRoot: EVIDENCE,
    lane: { repo: REPO, head: gitHead(), branch: process.env.WEIR_LANE_BRANCH ?? git(['rev-parse', '--abbrev-ref', 'HEAD']) },
    toolchain: { node: process.version, execPath: process.execPath, schemaVersion: CURRENT_SCHEMA_VERSION },
    fixture: { generator: FIXTURE_GENERATOR, source: V1_SOURCE, generatorOutput: FIXTURE_OUT, ...record1 },
    checks: results,
    mappingGaps,
    observed: {
      schemaFingerprintAfterFirstMigration: record2.schemaFingerprint,
      contentHashAfterFirstMigration: record2.contentHash,
      repeatRunState: record4.stateA,
      immutableHistory: {
        fieldsComparedForRewriteForbiddenTablesAndNamespaces: record3.fieldsCompared,
        profileSharedFieldsCompared: record3.profileFieldsCompared,
        snapshotV1FieldsCompared: record3.snapshotFieldsCompared,
      },
      archiveRestart: { processLevelColdOpen: record7.processColdOpen, postMigrationWrites: record6.writes },
    },
    dataLossBoundary: {
      text: DATA_LOSS_BOUNDARY,
      scope: 'all writes after a successful v1->v2 migration, private and public',
      evidence: {
        restoredDatabase: join(ARTIFACTS, 'c6-restored-v1.db'),
        backup: record6.backupPath,
        log: join(LOGS, 'c6-post-migration-writes.log'),
      },
    },
    isolation: {
      realAppData: REAL_APP_DATA,
      guardedPorts: GUARDED_PORTS,
      openedPaths,
      copyOps,
      children,
      listenersBefore: startedListeners,
      listenersAfter: Object.fromEntries(GUARDED_PORTS.map(port => [port, listeners(port)])),
    },
    headlessEvidence: {
      directory: headlessDir,
      files: headlessFiles,
      cited: false,
      reason: 'task 7.2 owns the full DSH headless boot/restart evidence; this directory had no files when this spike ran, so process-level restart is proved here by a fresh OS process cold-opening the store instead',
    },
    readme: 'REPORT.md maps every required sub-check to its assertions; COMMANDS.md lists the reproduction commands.',
  }
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(join(EVIDENCE, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeJsonLog('checks.json', results.map(record => ({
    label: record.label, ok: record.ok, assertions: record.assertions, artifacts: record.artifacts,
    error: record.error, durationMs: record.durationMs,
  })))
  writeLog('checks.log', results.map(record => `${record.ok ? 'PASS' : 'FAIL'} ${record.label} — ${record.ok ? `${record.assertions.length} assertions` : record.error}`).join('\n'))
  writeFileSync(join(EVIDENCE, 'REPORT.md'), renderMarkdown({ checks: results, report }))
  writeFileSync(join(EVIDENCE, 'COMMANDS.md'), commandsMarkdown())
  return report
}

function commandsMarkdown() {
  const lines = []
  lines.push('# Reproduction commands')
  lines.push('')
  lines.push('Lane worktree root:')
  lines.push('')
  lines.push('```bash')
  lines.push(`cd ${REPO}`)
  lines.push('```')
  lines.push('')
  lines.push('Acceptance spike (regenerates the v1 fixture, then writes every artifact under the evidence root):')
  lines.push('')
  lines.push('```bash')
  lines.push(`NODE=${NODE}`)
  lines.push(`$NODE plugins/weir-test-harness/spikes/decision/migration-acceptance.mjs ${EVIDENCE}`)
  lines.push('```')
  lines.push('')
  lines.push('The v1 fixture alone can also be regenerated with the existing generator (unchanged by this spike):')
  lines.push('')
  lines.push('```bash')
  lines.push(`$NODE plugins/weir-test-harness/spikes/decision/migration-fixture.mjs ${join(ROOTS, 'fixture')}`)
  lines.push('```')
  lines.push('')
  lines.push('Where the evidence lands: `REPORT.md` (sub-check to assertion map), `report.json` (machine readable),')
  lines.push('`DIAGNOSTICS.md` (iterative/failed runs), `artifacts/` (database copies, row dumps, hashes),')
  lines.push('`roots/` (isolated working databases), `logs/` (child processes, cold open, existing tests).')
  lines.push('')
  lines.push('Existing migration tests (must pass unchanged):')
  lines.push('')
  lines.push('```bash')
  lines.push('$NODE --test plugins/weir-harness/test/decision/migration-v2.test.js plugins/weir-harness/test/decision/store-migrate.test.js')
  lines.push('```')
  lines.push('')
  lines.push('Read a produced database without touching the App:')
  lines.push('')
  lines.push('```bash')
  lines.push(`$NODE --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('${join(ARTIFACTS, 'c2-migrated.db')}', { readOnly: true }); console.log(db.prepare('PRAGMA user_version').get(), db.prepare('PRAGMA integrity_check').get()); db.close()"`)
  lines.push('```')
  lines.push('')
  lines.push(`Evidence root: \`${EVIDENCE}\`. Isolated roots: \`${ROOTS}\`. Logs: \`${LOGS}\`.`)
  lines.push('')
  return lines.join('\n')
}

// ---- main ------------------------------------------------------------------
async function main() {
  if (EVIDENCE === REAL_APP_DATA || EVIDENCE.startsWith(`${REAL_APP_DATA}${sep}`)) {
    throw new Error(`refusing to write evidence inside the DSH App data directory: ${EVIDENCE}`)
  }
  if (process.env.WEIR_MIGRATION_ACCEPTANCE_CHILD === '1') throw new Error('refusing to run as its own child')
  mkdirSync(EVIDENCE, { recursive: true })
  mkdirSync(ROOTS, { recursive: true })
  mkdirSync(ARTIFACTS, { recursive: true })
  mkdirSync(LOGS, { recursive: true })
  writeLog('run.log', [
    `started ${new Date().toISOString()}`,
    `node ${process.version} (${process.execPath})`,
    `repo ${REPO}`,
    `evidence ${EVIDENCE}`,
    `fixture generator ${FIXTURE_GENERATOR}`,
    `spike ${SELF}`,
    `argv ${JSON.stringify(process.argv.slice(2))}`,
    `pid ${process.pid}`,
  ].join('\n'))
  console.log(`evidence root ${EVIDENCE}`)

  await check1_realV1Fixture()
  await check2_migration()
  await check3_immutableHistory()
  await check4_idempotence()
  await check5_walShmHygiene()
  await check6_restoreBoundary()
  await check7_archiveRestart()
  await check8_isolation()

  const report = writeReports()
  const failed = results.filter(record => !record.ok)
  console.log('')
  console.log(`report ${join(EVIDENCE, 'report.json')}`)
  console.log(`REPORT.md ${join(EVIDENCE, 'REPORT.md')}`)
  console.log(`COMMANDS.md ${join(EVIDENCE, 'COMMANDS.md')}`)
  console.log(`verdict ${report.verdict} (${results.length - failed.length}/${results.length} checks passed)`)
  writeLog('run.log', `finished ${new Date().toISOString()} verdict=${report.verdict}`)
  return failed.length === 0 ? 0 : 1
}

main().then(code => { process.exitCode = code }).catch(error => {
  console.error(error?.stack ?? String(error))
  process.exitCode = 2
})
