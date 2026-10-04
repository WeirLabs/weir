import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createNodeFs, instrumentFs } from '../src/capabilities/store/fs-adapter.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { createLockProtocol } from '../src/capabilities/store/lock.js'
const SESSION = 'session-db6e88dc-669c-46d9-a7e7-ae7e98883320'
const unit = { kind: 'selection', sessionId: SESSION }
const unitDir = root => join(root, 'sessions', SESSION)

async function fixture(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'orrery-capability-race-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'orrery-capability-race-')))
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
