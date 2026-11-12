import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDecisionDatabase, DecisionDatabase } from '../../src/decision/store/db.js'
import { migrateDecisionDatabase } from '../../src/decision/store/migrate.js'
import { CURRENT_SCHEMA_VERSION, EXPECTED_TABLES } from '../../src/decision/store/schema.js'

/** @param {import('node:test').TestContext} t */
function root(t) {
  const path = mkdtempSync(join(tmpdir(), 'weir-decision-migrate-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('fresh database creates all authoritative tables and indexes', t => {
  const dir = root(t)
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
  for (const table of EXPECTED_TABLES) assert.ok(tables.includes(table), table)
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION)
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  store.close()
})

test('higher schema version is rejected without changing data', t => {
  const dir = root(t)
  const path = join(dir, 'decision.db')
  const raw = new DatabaseSync(path)
  raw.exec('CREATE TABLE retained(id TEXT)')
  raw.prepare('INSERT INTO retained VALUES(?)').run('keep')
  raw.exec('PRAGMA user_version=99')
  raw.close()
  assert.throws(() => openDecisionDatabase(path), error => error?.code === 'SCHEMA_TOO_NEW')
  const check = new DatabaseSync(path)
  assert.equal(check.prepare('SELECT * FROM retained').get().id, 'keep')
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99)
  check.close()
})

test('nonzero migration writes a consistent backup before advancing', t => {
  const dir = root(t)
  const path = join(dir, 'decision.db')
  const store = new DecisionDatabase(path)
  const migrations = [
    ['CREATE TABLE one(id TEXT)'],
    ['CREATE TABLE two(id TEXT)'],
  ]
  migrateDecisionDatabase(store, { migrations })
  store.close()
  // A freshly created database leaves nothing to roll back to.
  assert.equal(existsSync(join(dir, 'backups')), false)
  const reopened = new DecisionDatabase(path)
  migrateDecisionDatabase(reopened, { migrations: [...migrations, ['CREATE TABLE three(id TEXT)']] })
  const backups = readdirSync(join(dir, 'backups'))
  assert.equal(backups.length, 1)
  assert.match(backups[0], /^decision-v2-/)
  // The backup is a consistent, independently openable database, not a raw copy
  // of a live WAL file.
  const restored = new DatabaseSync(join(dir, 'backups', backups[0]))
  assert.equal(restored.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(restored.prepare("SELECT name FROM sqlite_master WHERE name='three'").get(), undefined)
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  restored.close()
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 3)
  reopened.close()
})

test('failed migration rolls back and does not advance user_version', t => {
  const dir = root(t)
  const path = join(dir, 'decision.db')
  assert.throws(() => openDecisionDatabase(path, {
    migrations: [
      ['CREATE TABLE committed_step(id TEXT)'],
      ['CREATE TABLE rolled_back(id TEXT)', 'INVALID SQL'],
    ],
  }), /SQLITE_ERROR|syntax error/)
  const raw = new DatabaseSync(path)
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1)
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='rolled_back'").get(), undefined)
  raw.close()
})
