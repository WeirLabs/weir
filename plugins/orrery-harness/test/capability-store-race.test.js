import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeFs, instrumentFs } from '../src/capabilities/store/fs-adapter.js'
import { createLiveness } from '../src/capabilities/store/liveness.js'
import { createLockProtocol } from '../src/capabilities/store/lock.js'
import { digestOf } from '../src/capabilities/store/record.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'

const WORKER = fileURLToPath(new URL('./helpers/capability-store-worker.js', import.meta.url))
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

function worker(t, args) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(args)], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = []
  let buffer = ''
  let notify = () => {}
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      lines.push(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
    }
    notify()
  })
  const exited = new Promise(done => child.once('exit', (code, signal) => { notify(); done({ code, signal }) }))
  let gone = false
  void exited.then(() => { gone = true })
  t.after(() => { if (!gone) child.kill('SIGKILL') })
  /** Resolve with the first line matching `predicate`; reject if the child exits first. */
  const line = predicate => new Promise((done, fail) => {
    const check = () => {
      const found = lines.find(predicate)
      if (found !== undefined) done(found)
      else if (gone) fail(new Error(`worker exited before the expected line; saw ${JSON.stringify(lines)}`))
      else notify = check
    }
    check()
  })
  const send = (/** @type {string} */ word) => { child.stdin.write(`${word}\n`) }
  return { child, line, exited, send }
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
  const liveness = createLiveness()
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

test('two processes committing one expected revision: exactly one wins and only its receipt persists', async t => {
  const root = await fixture(t)
  for (let round = 0; round < 4; round++) {
    const expected = round
    const ids = [`a${round}`, `b${round}`]
    const workers = ids.map(id => worker(t, { role: 'commit', root, unit, expected, id }))
    await Promise.all(workers.map(w => w.line(text => text === 'READY')))
    for (const w of workers) w.send('GO')
    const results = await Promise.all(workers.map(w => w.line(text => text.startsWith('{')).then(JSON.parse)))
    await Promise.all(workers.map(w => w.exited))
    const statuses = results.map(r => r.status).sort()
    assert.deepEqual(statuses, ['committed', 'revision-conflict'], `round ${round}`)
    const winner = results.find(r => r.status === 'committed').id
    const record = await openCapabilityStore({ root, platform: 'darwin' }).read(unit)
    assert.equal(record.revision, round + 1)
    assert.deepEqual(record.payload, { writer: winner })
    assert.equal(record.receipts.filter(r => ids.includes(r.requestId)).map(r => r.requestId).join(), winner)
  }
  assert.deepEqual(await readdir(unitDir(root)), ['selection.json'])
})

for (const point of ['after-lock-create', 'after-write-temp', 'after-fsync', 'after-rename', 'after-dir-fsync', 'after-release']) {
  test(`SIGKILL ${point}: the record is old or new, never torn, and the next writer recovers`, async t => {
    const root = await fixture(t)
    const crash = worker(t, { role: 'crash', root, unit, expected: 0, point, leaseMs: 200 })
    await crash.line(text => text === `AT ${point}`)
    crash.child.kill('SIGKILL')
    assert.equal((await crash.exited).signal, 'SIGKILL')

    const store = openCapabilityStore({ root, platform: 'darwin' })
    const survived = await store.read(unit)
    const landed = ['after-rename', 'after-dir-fsync', 'after-release'].includes(point)
    if (landed) {
      assert.equal(survived.kind, 'ok')
      assert.deepEqual({ revision: survived.revision, payload: survived.payload }, { revision: 1, payload: { writer: 'crash', point } })
    } else {
      assert.deepEqual(survived, { kind: 'absent', revision: 0 })
    }
    const next = await store.commit(unit, survived.revision, () => ({ writer: 'next' }))
    assert.equal(next.status, 'committed')
    assert.equal(next.revision, survived.revision + 1)
    assert.deepEqual(await readdir(unitDir(root)), ['selection.json'])
  })
}

for (const point of ['after-generation-file', 'after-generation-fsync', 'after-write-temp', 'after-rename', 'after-dir-fsync']) {
  test(`SIGKILL publishing ${point}: another process sees the whole old or whole new generation`, async t => {
    const root = await fixture(t)
    const dir = join(root, 'distribution', 'global')
    const scope = { kind: 'distribution', scope: 'global' }
    const files = id => ({ 'SKILL.md': `body ${id}`, 'b.txt': `b ${id}` })
    const store = openCapabilityStore({ root, platform: 'darwin' })
    assert.equal((await store.publishPointer('global', { expectedRevision: 0, generationId: 'g1', files: files('g1') })).status, 'committed')
    const landed = point === 'after-rename' || point === 'after-dir-fsync'
    const expectedId = landed ? 'g2' : 'g1'
    const observe = async () => {
      const active = await store.read(scope)
      assert.equal(active.kind, 'ok')
      assert.deepEqual(
        { revision: active.revision, generationId: active.payload.generationId, provenance: active.payload.provenance },
        { revision: landed ? 2 : 1, generationId: expectedId, provenance: landed ? { writer: 'g2' } : null })
      const visible = Object.fromEntries(await Promise.all(Object.keys(active.payload.manifest)
        .map(async name => [name, await readFile(join(dir, 'generations', expectedId, name), 'utf8')])))
      assert.deepEqual(visible, files(expectedId))
      assert.deepEqual(active.payload.manifest, Object.fromEntries(Object.entries(visible).map(([name, text]) => [name, digestOf(text)])))
      return active
    }

    const crash = worker(t, { role: 'publish-crash', root, expected: 1, id: 'g2', point, leaseMs: 200 })
    await crash.line(text => text === `AT ${point}`)
    await observe()
    crash.child.kill('SIGKILL')
    assert.equal((await crash.exited).signal, 'SIGKILL')
    const survived = await observe()

    const next = await store.publishPointer('global', { expectedRevision: survived.revision, generationId: 'g3', files: files('g3') })
    assert.equal(next.status, 'committed')
    assert.equal((await store.read(scope)).payload.generationId, 'g3')
    assert.deepEqual((await readdir(dir)).sort(), ['active.json', 'generations'])
  })
}

test('two reclaimer processes racing for a SIGKILLed holder lock: one new owner, one rename, no live lock removed', async t => {
  const metrics = []
  for (let round = 0; round < 5; round++) {
    const root = await fixture(t)
    const dir = unitDir(root)
    const holder = worker(t, { role: 'crash', root, unit, expected: 0, point: 'after-lock-create', leaseMs: 100 })
    await holder.line(text => text === 'AT after-lock-create')
    holder.child.kill('SIGKILL')
    assert.equal((await holder.exited).signal, 'SIGKILL')
    const deadToken = JSON.parse(await readFile(join(dir, 'selection.lock'), 'utf8')).ownerToken
    await new Promise(done => setTimeout(done, 150))

    const racers = ['r1', 'r2'].map(id => worker(t, { role: 'reclaim', dir, id, deadlineMs: 400 }))
    await Promise.all(racers.map(w => w.line(text => text === 'READY')))
    for (const w of racers) w.send('GO')
    const results = await Promise.all(racers.map(w => w.line(text => text.startsWith('{')).then(JSON.parse)))
    const owners = results.filter(r => r.ok)
    const renames = results.reduce((sum, r) => sum + r.stats.renames, 0)
    const liveRemovals = results.reduce((sum, r) => sum + r.lockOps.filter(op => op === 'unlink').length + Math.max(0, r.lockOps.filter(op => op === 'rename').length - r.stats.renames), 0)
    assert.equal(owners.length, 1, `round ${round}: ${JSON.stringify(results)}`)
    assert.equal(renames, 1, `round ${round}`)
    assert.equal(liveRemovals, 0, `round ${round}`)
    assert.equal(JSON.parse(await readFile(join(dir, 'selection.lock'), 'utf8')).ownerToken, owners[0].token)
    const stale = (await readdir(dir)).filter(name => name.startsWith('selection.lock.stale.'))
    assert.equal(stale.length, 1)
    assert.equal(JSON.parse(await readFile(join(dir, stale[0]), 'utf8')).ownerToken, deadToken)
    for (const w of racers) w.send('RELEASE')
    const exits = await Promise.all(racers.map(w => w.exited))
    assert.deepEqual(exits.map(e => e.code), [0, 0])
    metrics.push({ round, newOwners: owners.length, deadLockRenames: renames, liveLockRemovals: liveRemovals, recheckAborts: results.reduce((sum, r) => sum + r.stats.recheckAborts, 0), loserReason: results.find(r => !r.ok).reason, exitCodes: exits.map(e => e.code) })
  }
  t.diagnostic(`reclaim race metrics ${JSON.stringify(metrics)}`)
})
