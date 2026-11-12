// Versioned, backup-first migrations for the Decision Agent SQLite store.
//
// A live SQLite database in WAL mode cannot be backed up with a raw file copy:
// committed pages may still live only in the -wal file. Every version step is
// therefore preceded by an explicit checkpoint plus `VACUUM INTO`, which writes
// one self-contained database file. A failed step rolls back the transaction and
// leaves the original database usable; older code refuses a newer
// `user_version` instead of half-reading it.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema.js'
import { DecisionStoreError } from './db.js'

/** @param {import('./db.js').DecisionDatabase} store */
export function migrateDecisionDatabase(store, options = {}) {
  const migrations = options.migrations ?? MIGRATIONS
  const current = Number(store.db.prepare('PRAGMA user_version').get().user_version)
  if (current > migrations.length) {
    throw new DecisionStoreError('SCHEMA_TOO_NEW', `decision.db user_version ${current} exceeds supported ${migrations.length}`)
  }
  // A database created by this very call holds nothing to roll back to, so the
  // first open of a fresh profile leaves no backup directory behind. Every later
  // step starts from a nonzero version and is backed up before it advances.
  const initial = current
  for (let version = current; version < migrations.length; version++) {
    if (initial > 0 && version > 0) createConsistentBackup(store, version)
    store.transaction(db => {
      for (const step of migrations[version]) {
        if (typeof step === 'function') step(db)
        else db.exec(step)
      }
      db.exec(`PRAGMA user_version=${version + 1}`)
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
        db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run('schema_version', String(version + 1))
      }
    })
  }
  const applied = Number(store.db.prepare('PRAGMA user_version').get().user_version)
  if (applied !== CURRENT_SCHEMA_VERSION && migrations === MIGRATIONS) {
    throw new DecisionStoreError('SCHEMA_MISMATCH', `expected schema ${CURRENT_SCHEMA_VERSION}, found ${applied}`)
  }
  return applied
}

/**
 * Write one consistent database file after an explicit WAL checkpoint.
 * The backup directory stays next to the live database so a rollback is local.
 * @param {import('./db.js').DecisionDatabase} store
 * @param {number} [version] the version being migrated away from
 */
export function createConsistentBackup(store, version) {
  const from = version ?? Number(store.db.prepare('PRAGMA user_version').get().user_version)
  const directory = join(dirname(store.path), 'backups')
  mkdirSync(directory, { recursive: true })
  const target = join(directory, `decision-v${from}-${Date.now()}.db`)
  const checkpoint = store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  if (Number(checkpoint?.busy ?? 0) !== 0) {
    throw new DecisionStoreError('BACKUP_FAILED', 'decision.db WAL checkpoint is blocked by another connection')
  }
  store.db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  if (!existsSync(target)) throw new DecisionStoreError('BACKUP_FAILED', `no backup was written at ${target}`)
  return target
}

/**
 * Restore a consistent backup over the live path, discarding the live WAL/SHM
 * sidecars first so a stale write-ahead log can never be replayed on top of the
 * restored file. Callers must have closed every connection to `dbPath`.
 * Restoring discards every write made after that backup.
 * @param {string} dbPath @param {string} backupPath
 */
export function restoreConsistentBackup(dbPath, backupPath) {
  if (!existsSync(backupPath)) throw new DecisionStoreError('BACKUP_NOT_FOUND', backupPath)
  for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
  copyFileSync(backupPath, dbPath)
  return dbPath
}
