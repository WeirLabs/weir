// Disposable P0-S3 probe. Mounted only in the lane-local temporary Desktop profile.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

export const name = 'weir-decision-s3-sqlite-host-spike'

const OUT = process.env.WEIR_DECISION_SPIKE_ROOT
const PHASE = process.env.WEIR_DECISION_SPIKE_PHASE
const CURRENT_VERSION = 2

function writeJson(name, value) {
  if (!OUT) throw new Error('WEIR_DECISION_SPIKE_ROOT is required')
  writeFileSync(join(OUT, name), JSON.stringify(value, null, 2) + '\n')
}

function rows(db) {
  return db.prepare('SELECT id, value FROM spike_records ORDER BY id').all()
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function rawError(error) {
  return {
    name: error?.name ?? null,
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    errcode: error?.errcode ?? null,
    errstr: error?.errstr ?? null,
  }
}

function openAt(path) {
  const db = new DatabaseSync(path)
  return { db, journal: db.prepare('PRAGMA journal_mode=WAL').get(), busy: db.prepare('PRAGMA busy_timeout=100').get() }
}

function createSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS spike_records (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
}

function mainPhase(ctx) {
  const profile = ctx.get('profileContext')
  if (!profile?.home || !profile?.name) throw new Error(`profileContext unavailable: ${JSON.stringify(profile)}`)
  const decisions = resolve(profile.home, 'weir', 'profiles', profile.name, 'decisions')
  mkdirSync(join(decisions, 'backups'), { recursive: true })
  const dbPath = join(decisions, 'decision.db')
  const { db, journal, busy } = openAt(dbPath)
  createSchema(db)
  db.prepare('INSERT OR REPLACE INTO spike_records(id,value) VALUES (?,?)').run('committed-main', 'visible')
  const versionBefore = db.prepare('PRAGMA user_version').get()
  db.exec('PRAGMA user_version=1')
  const versionAfter = db.prepare('PRAGMA user_version').get()
  writeJson('env.json', {
    spike: 'S3',
    phase: 'main',
    hostKind: 'dsh-desktop-host/runProfile',
    hostEntry: process.argv[1],
    processArgv: process.argv,
    pid: process.pid,
    execPath: process.execPath,
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    versions: { electron: process.versions.electron, node: process.versions.node },
    profileContext: { home: profile.home, name: profile.name },
    expectedRoot: join(profile.home, 'weir', 'profiles', profile.name, 'decisions'),
    databasePath: dbPath,
    databaseInsideProfilePrivateRoot: dirname(dbPath) === decisions,
    databaseExists: existsSync(dbPath),
    nodeSqlite: { databaseSync: typeof DatabaseSync === 'function' },
    journalMode: journal,
    busyTimeout: busy,
    userVersionBefore: versionBefore,
    userVersionAfter: versionAfter,
    pass: dirname(dbPath) === decisions && existsSync(dbPath) && journal?.journal_mode === 'wal' && Number(busy?.timeout) === 100 && Number(versionAfter?.user_version) === 1,
  })

  // A real second connection must fail while the first holds BEGIN IMMEDIATE.
  const second = new DatabaseSync(dbPath)
  second.prepare('PRAGMA busy_timeout=50').get()
  db.exec('BEGIN IMMEDIATE')
  db.prepare('INSERT INTO spike_records(id,value) VALUES (?,?)').run('busy-uncommitted', 'must-not-leak')
  let busyError = null
  const busyStarted = performance.now()
  try {
    second.prepare('INSERT INTO spike_records(id,value) VALUES (?,?)').run('second-writer', 'must-not-write')
  } catch (error) {
    busyError = rawError(error)
  }
  const busyWaitMs = performance.now() - busyStarted
  db.exec('ROLLBACK')
  const secondRowsBeforeClose = rows(second)
  second.close()
  const sqliteBusy = busyError && (busyError.errcode === 5 || /database is locked/i.test(busyError.message))
  writeJson('busy.json', {
    spike: 'S3', databasePath: dbPath, secondConnection: true, beginImmediateHeld: true,
    error: busyError, sqliteBusyCode: sqliteBusy ? 'SQLITE_BUSY' : null, busyWaitMs,
    uncommittedVisibleAfterRollback: secondRowsBeforeClose.some(row => row.id === 'busy-uncommitted'),
    secondWriterVisible: secondRowsBeforeClose.some(row => row.id === 'second-writer'),
    committedRows: secondRowsBeforeClose,
    pass: Boolean(sqliteBusy) && !secondRowsBeforeClose.some(row => ['busy-uncommitted', 'second-writer'].includes(row.id)),
  })

  // Measure committed transactions before the unsupported-version fixture.
  const durations = []
  for (let index = 0; index < 5; index++) {
    const started = performance.now()
    db.exec('BEGIN IMMEDIATE')
    db.prepare('INSERT INTO spike_records(id,value) VALUES (?,?)').run(`timing-${index}`, String(index))
    db.exec('COMMIT')
    durations.push(performance.now() - started)
  }
  writeJson('timing.json', {
    spike: 'S3', databasePath: dbPath, samplesMs: durations, typicalTransactionMs: durations[0],
    maxTransactionMs: Math.max(...durations), designReviewThresholdMs: 50,
    requiresDesignReview: durations[0] > 50,
    pass: durations.every(value => Number.isFinite(value) && value >= 0),
  })

  // A closed, consistent v1 database is copied before the v1 -> v2 migration.
  db.close()
  const backupPath = join(decisions, 'backups', 'decision-v1-spike.db')
  copyFileSync(dbPath, backupPath)
  const backup = new DatabaseSync(backupPath, { readOnly: true })
  const backupVersion = backup.prepare('PRAGMA user_version').get()
  const backupRows = rows(backup)
  backup.close()
  const migrated = new DatabaseSync(dbPath)
  const from = Number(migrated.prepare('PRAGMA user_version').get().user_version)
  migrated.exec('BEGIN IMMEDIATE')
  migrated.exec(`PRAGMA user_version=${CURRENT_VERSION}`)
  migrated.exec('COMMIT')
  const to = Number(migrated.prepare('PRAGMA user_version').get().user_version)

  // Higher versions reject before migration; record and schema bytes stay unchanged.
  const preHighRows = rows(migrated)
  const preHighSchema = migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='spike_records'").get()?.sql
  migrated.exec('PRAGMA user_version=99')
  migrated.close()
  const unsupported = new DatabaseSync(dbPath)
  const observedHigh = Number(unsupported.prepare('PRAGMA user_version').get().user_version)
  let highError = null
  try {
    if (observedHigh > CURRENT_VERSION) throw Object.assign(new Error(`unsupported decision.db user_version ${observedHigh}`), { code: 'UNSUPPORTED_USER_VERSION' })
  } catch (error) {
    highError = rawError(error)
  }
  const postHighRows = rows(unsupported)
  const postHighSchema = unsupported.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='spike_records'").get()?.sql
  const preservedVersion = Number(unsupported.prepare('PRAGMA user_version').get().user_version)
  unsupported.close()
  const unchanged = digest(preHighRows) === digest(postHighRows) && preHighSchema === postHighSchema && preservedVersion === 99
  writeJson('migrate.json', {
    spike: 'S3', databasePath: dbPath, backupPath, backupExists: existsSync(backupPath),
    backupVersion, backupRows, migration: { from, to },
    highVersion: { observed: observedHigh, error: highError, preservedVersion },
    dataDigestBeforeReject: digest(preHighRows), dataDigestAfterReject: digest(postHighRows),
    schemaBeforeReject: preHighSchema, schemaAfterReject: postHighSchema, originalDataUnchanged: unchanged,
    pass: existsSync(backupPath) && Number(backupVersion?.user_version) === 1 && from === 1 && to === CURRENT_VERSION && highError?.code === 'UNSUPPORTED_USER_VERSION' && unchanged,
  })

  // Hold an uncommitted transaction open until the external driver SIGKILLs this host.
  const crashPath = join(decisions, 'crash.db')
  const crash = new DatabaseSync(crashPath)
  crash.prepare('PRAGMA journal_mode=WAL').get()
  createSchema(crash)
  crash.prepare('INSERT INTO spike_records(id,value) VALUES (?,?)').run('before-crash', 'committed')
  crash.exec('BEGIN IMMEDIATE')
  crash.prepare('INSERT INTO spike_records(id,value) VALUES (?,?)').run('uncommitted-crash', 'must-not-survive')
  writeJson('crash-ready.json', { pid: process.pid, crashPath, transactionOpen: true, committedRow: 'before-crash', uncommittedRow: 'uncommitted-crash' })
}

function recoveryPhase(ctx) {
  const profile = ctx.get('profileContext')
  const ready = JSON.parse(readFileSync(join(OUT, 'crash-ready.json'), 'utf8'))
  const crash = new DatabaseSync(ready.crashPath, { readOnly: true })
  const integrity = crash.prepare('PRAGMA integrity_check').get()
  const recoveredRows = rows(crash)
  crash.close()
  const main = new DatabaseSync(join(profile.home, 'weir', 'profiles', profile.name, 'decisions', 'decision.db'), { readOnly: true })
  const mainIntegrity = main.prepare('PRAGMA integrity_check').get()
  main.close()
  writeJson('crash.json', {
    spike: 'S3', phase: 'recovery', recoveryPid: process.pid, killedPid: ready.pid,
    crashPath: ready.crashPath, integrityCheck: integrity, mainIntegrityCheck: mainIntegrity,
    rowsAfterKill: recoveredRows,
    committedVisible: recoveredRows.some(row => row.id === 'before-crash'),
    uncommittedVisible: recoveredRows.some(row => row.id === 'uncommitted-crash'),
    pass: integrity?.integrity_check === 'ok' && mainIntegrity?.integrity_check === 'ok' && recoveredRows.some(row => row.id === 'before-crash') && !recoveredRows.some(row => row.id === 'uncommitted-crash'),
  })
  writeJson('recovery-done.json', { pid: process.pid, complete: true })
}

export function apply(ctx) {
  const task = PHASE === 'main' ? mainPhase : PHASE === 'recovery' ? recoveryPhase : null
  if (!task) throw new Error(`unknown WEIR_DECISION_SPIKE_PHASE ${PHASE}`)
  try {
    task(ctx)
  } catch (error) {
    writeJson('fatal.json', { phase: PHASE, error: rawError(error), stack: error?.stack ?? null })
    throw error
  }
}
