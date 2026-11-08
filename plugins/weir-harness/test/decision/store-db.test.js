import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase, StoreBusy } from '../../src/decision/store/db.js'

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-db-'))
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return store
}

test('eight concurrent writers serialize without losing updates', async t => {
  const store = fixture(t)
  await Promise.all(Array.from({ length: 8 }, () => store.write(db => {
    db.prepare("INSERT INTO metrics_counters(bucket,value) VALUES('writes',1) ON CONFLICT(bucket) DO UPDATE SET value=value+1").run()
  })))
  assert.equal(store.db.prepare("SELECT value FROM metrics_counters WHERE bucket='writes'").get().value, 8)
})

test('nested transactions fail before mutating authoritative state', t => {
  const store = fixture(t)
  assert.throws(() => store.transaction(() => {
    store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('nested', 'no')
    store.transaction(() => {})
  }), error => error?.code === 'NESTED_TRANSACTION')
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='nested'").get(), undefined)
})

test('Promise-returning transaction rolls back with a typed error', async t => {
  const store = fixture(t)
  await assert.rejects(store.write(async db => {
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('async', 'no')
  }), error => error?.code === 'ASYNC_TRANSACTION')
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='async'").get(), undefined)
})

test('a second connection lock conflict maps to StoreBusy and preserves the first commit', t => {
  const store = fixture(t)
  const other = openDecisionDatabase(store.path)
  other.db.exec('PRAGMA busy_timeout=0')
  store.db.exec('BEGIN IMMEDIATE')
  store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('winner', 'yes')
  assert.throws(() => other.transaction(db => {
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('loser', 'no')
  }), error => error instanceof StoreBusy)
  store.db.exec('COMMIT')
  other.close()
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='winner'").get().value, 'yes')
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='loser'").get(), undefined)
})
