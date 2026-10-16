import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createNodeFs, instrumentFs } from '../src/capabilities/store/fs-adapter.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { createLockProtocol } from '../src/capabilities/store/lock.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
const SESSION = 'session-db6e88dc-669c-46d9-a7e7-ae7e98883320'
const unit = { kind: 'selection', sessionId: SESSION }
const unitDir = root => join(root, 'sessions', SESSION)

async function fixture(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-capability-race-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'weir-capability-race-')))
    await rm(root, { recursive: true, force: true })
  })
  return root
}


test('forced interleaving: a reclaimer that observed the dead owner aborts on recheck after another reclaimer won', async t => {
  const root = await fixture(t)
  const dir = unitDir(root)
  await mkdir(dir, { recursive: true })
  const lockPath = join(dir, 'selection.lock')
  await writeFile(lockPath, JSON.stringify({
    schemaVersion: 1, ownerToken: 'deadbeefdeadbeef', pid: process.pid, host: hostname(),
    startIdentity: { osStart: null, bootNonce: 'another-process' }, acquiredAt: 0, leaseUntil: 0,
  }))
  let paused
  const reachedRecover = new Promise(done => { paused = done })
  let resume
  const gate = new Promise(done => { resume = done })
  const lateOps = []
  const lateFs = instrumentFs(createNodeFs(), async (op, args, phase) => {
    if (phase !== 'before') return
    lateOps.push([op, ...args])
    if (op === 'createExclusive' && args[0].includes('selection.lock.recover.') && paused) {
      const signal = paused
      paused = null
      signal()
      await gate
    }
  })
  const liveness = createStubLiveness()
  const late = createLockProtocol({ fs: lateFs, liveness, deadlineMs: 50 })
  const winner = createLockProtocol({ fs: createNodeFs(), liveness })

  const lateResult = late.acquire(dir, 'selection')
  await reachedRecover
  const won = await winner.acquire(dir, 'selection')
  resume()
  const lost = await lateResult

  assert.equal(won.ok, true)
  assert.equal(won.reclaimed, true)
  assert.equal(won.stats.renames, 1)
  assert.deepEqual({ ok: lost.ok, reason: lost.reason }, { ok: false, reason: 'locked' })
  assert.equal(lost.stats.recheckAborts, 1)
  assert.equal(lost.stats.renames, 0)
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).ownerToken, won.token)
  const stale = (await readdir(dir)).filter(name => name.startsWith('selection.lock.stale.'))
  assert.equal(stale.length, 1)
  assert.equal(JSON.parse(await readFile(join(dir, stale[0]), 'utf8')).ownerToken, 'deadbeefdeadbeef')
  const touchedLive = lateOps.filter(([op, from]) => (op === 'unlink' || op === 'rename') && from === lockPath)
  assert.deepEqual(touchedLive, [])
  assert.equal(await winner.release(dir, 'selection', won.token), true)
})

// ---- capabilities-deepening D4 (4.3): sync × async mutual exclusion ---------
// The sync commit/read path (store.js commitSync/readSync over the shared
// paths/record/lock modules) must interlock with the async path: one unit,
// one lock, no torn records, no lost updates.

test('an async commit holding the unit lock fails a sync commit closed (locked), then they chain cleanly', async t => {
  const root = await fixture(t)
  const dir = unitDir(root)
  // Pause the async commit at the record rename — it holds the unit lock then.
  let resume
  const gate = new Promise(done => { resume = done })
  let paused
  const reached = new Promise(done => { paused = done })
  const fs = instrumentFs(createNodeFs(), async (op, args, phase) => {
    if (phase === 'before' && op === 'rename' && args[1].endsWith('selection.json') && paused) {
      const signal = paused
      paused = null
      signal()
      await gate
    }
  })
  const asyncStore = openCapabilityStore({ root, platform: 'darwin', fs, liveness: createStubLiveness() })
  const pending = asyncStore.commit(unit, 0, () => ({ writers: ['async'] }))
  await reached

  // While the async writer holds the lock, the sync commit fails closed —
  // it cannot wait (the listener path may not yield) and never corrupts.
  const syncStore = openCapabilityStore({ root, platform: 'darwin' })
  const refused = syncStore.commitSync(unit, 0, () => ({ writers: ['sync'] }))
  assert.equal(refused.status, 'locked')

  resume()
  const committed = await pending
  assert.equal(committed.status, 'committed')
  assert.equal((await asyncStore.read(unit)).revision, 1)

  // After the release the sync path commits on top of the async record.
  const chained = syncStore.commitSync(unit, 1, payload => ({ writers: [...(Array.isArray(payload?.writers) ? payload.writers : []), 'sync'] }))
  assert.equal(chained.status, 'committed')
  assert.equal(chained.revision, 2)
  const record = await asyncStore.read(unit)
  assert.equal(record.revision, 2)
  assert.deepEqual(record.payload, { writers: ['async', 'sync'] })
  assert.deepEqual(await readdir(dir), ['selection.json'])
})

test('cross-process: a sync-commit child and async-commit parent serialize on one unit without a lost update', async t => {
  const root = await fixture(t)
  const storeModule = fileURLToPath(new URL('../src/capabilities/store/store.js', import.meta.url))
  const childScript = `
    const { openCapabilityStore } = await import(${JSON.stringify(`file://${storeModule}`)})
    const store = openCapabilityStore({ root: process.env.WEIR_SYNC_RACE_ROOT, platform: 'darwin' })
    const unit = { kind: 'selection', sessionId: ${JSON.stringify(SESSION)} }
    let done = 0
    for (let i = 0; i < 5; i++) {
      for (;;) {
        const current = store.readSync(unit)
        const expected = current.kind === 'ok' ? current.revision : 0
        const result = store.commitSync(unit, expected, payload => ({ writers: [...(Array.isArray(payload?.writers) ? payload.writers : []), 'sync'] }))
        if (result.status === 'committed') { done++; break }
      }
    }
    console.log('SYNC_DONE', done)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    env: { ...process.env, WEIR_SYNC_RACE_ROOT: root },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let childOut = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { childOut += chunk })
  const childExited = new Promise(done => child.once('exit', code => done(code)))
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })

  const store = openCapabilityStore({ root, platform: 'darwin' })
  for (let i = 0; i < 5; i++) {
    for (;;) {
      const current = await store.read(unit)
      const expected = current.kind === 'ok' ? current.revision : 0
      const result = await store.commit(unit, expected, payload => ({ writers: [...(Array.isArray(payload?.writers) ? payload.writers : []), 'async'] }))
      if (result.status === 'committed') break
      // revision-conflict/locked: re-read and retry.
    }
  }
  assert.equal(await childExited, 0)
  assert.ok(childOut.includes('SYNC_DONE 5'), childOut)
  const record = await store.read(unit)
  assert.equal(record.kind, 'ok')
  // Every commit of both processes landed exactly once — serialized by the
  // shared file lock, never a lost update, never a torn record.
  assert.equal(record.revision, 10)
  assert.equal(record.payload.writers.length, 10)
  assert.deepEqual(await readdir(unitDir(root)), ['selection.json'])
})
