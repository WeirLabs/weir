// Versioned, backup-first migrations for the Decision Agent SQLite store.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema.js'
import { DecisionStoreError } from './db.js'

/** @param {import('./db.js').DecisionDatabase} store @param {{ migrations?: readonly (readonly string[])[] }} [options] */
export function migrateDecisionDatabase(store, options = {}) {
  const migrations = options.migrations ?? MIGRATIONS
  const current = Number(store.db.prepare('PRAGMA user_version').get().user_version)
  if (current > migrations.length) {
    throw new DecisionStoreError('SCHEMA_TOO_NEW', `decision.db user_version ${current} exceeds supported ${migrations.length}`)
  }
  for (let version = current; version < migrations.length; version++) {
    if (version > 0) backup(store.path, version)
    store.transaction(db => {
      for (const statement of migrations[version]) db.exec(statement)
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

/** @param {string} path @param {number} version */
function backup(path, version) {
  const directory = join(dirname(path), 'backups')
  mkdirSync(directory, { recursive: true })
  copyFileSync(path, join(directory, `decision-v${version}-${Date.now()}.db`))
}
