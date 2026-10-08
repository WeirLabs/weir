import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLiveness, psStartTime, windowsStartTime } from '../src/capabilities/store/liveness.js'
import { digestOf } from '../src/capabilities/store/record.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'

const WORKER = fileURLToPath(new URL('./helpers/capability-store-worker.js', import.meta.url))
const SESSION = 'session-db6e88dc-669c-46d9-a7e7-ae7e98883320'
const unit = { kind: 'selection', sessionId: SESSION }
const unitDir = root => join(root, 'sessions', SESSION)

// Probe both executables: some sandboxes allow Node but deny system ps.
// Only capability failures skip; assertions and worker failures still fail.
function probe(command, args) {
  return new Promise(resolve => {
    try {
      execFile(command, args, { timeout: 5000 }, error => resolve(error
        ? `${command}: ${error.code ?? error.message}` : null))
    } catch (error) {
      resolve(`${command}: ${error.code ?? error.message}`)
    }
  })
}
// The liveness start-time probe is platform-routed (ps on POSIX,
// powershell.exe on win32); probe the command this host actually uses.
const unavailable = await probe(process.execPath, ['-e', 'process.exit(0)']) ??
  (process.platform === 'win32'
    ? await probe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).StartTime.ToFileTimeUtc()'])
    : await probe('ps', ['-o', 'lstart=', '-p', String(process.pid)]))
const test = (name, body) => nodeTest(name, { timeout: 30_000 }, async t => {
  if (unavailable) return t.skip(`real process capability unavailable: ${unavailable}`)
  await body(t)
})

test('real start-time probe and liveness identity observe this process', async () => {
  const startTime = process.platform === 'win32' ? windowsStartTime : psStartTime
  const start = await startTime(process.pid)
  assert.equal(typeof start, 'string')
  assert.ok(start.length > 0)
  const liveness = createLiveness()
  const identity = await liveness.identity()
  assert.equal(identity.osStart, start)
  assert.equal(await liveness.state({ pid: process.pid, host: liveness.host, startIdentity: identity }), 'alive')
})

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

function worker(t, args) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(args)], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = []
  let buffer = ''
  let notify = () => {}
  child.stdout.setEncoding('utf8')
  child.stdin.on('error', error => {
    // A peer that departed before a late write landed (see send): its broken
    // pipe is not an observation failure. Any other stdin error stays loud.
    if (error?.code !== 'EPIPE') throw error
  })
  child.stdout.on('data', chunk => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      lines.push(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
    }
    notify()
  })
  let gone = false
  let spawnError
  const exited = new Promise(done => {
    child.once('error', error => { spawnError = error; gone = true; notify(); done({ code: null, signal: null }) })
    child.once('exit', (code, signal) => { gone = true; notify(); done({ code, signal }) })
  })
  t.after(() => { if (!gone) child.kill('SIGKILL') })
  /** Resolve with the first line matching `predicate`; reject if the child exits first. */
  const line = predicate => new Promise((done, fail) => {
    const check = () => {
      const found = lines.find(predicate)
      if (found !== undefined) done(found)
      else if (gone) fail(spawnError ?? new Error(`worker exited before the expected line; saw ${JSON.stringify(lines)}`))
      else notify = check
    }
    check()
  })
  const send = (/** @type {string} */ word) => {
    try {
      child.stdin.write(`${word}\n`)
    } catch (error) {
      // The peer may legitimately depart before a late RELEASE arrives: the
      // losing reclaimer reports its result and exits right away, so its pipe
      // is broken (EPIPE) when the parent writes. The write is not the
      // observation — every send is followed by a strict line() wait or an
      // exit-code assertion — so a write to a departed child is a no-op, and
      // a child gone before GO still fails loudly at its next line() wait.
      if (error?.code !== 'EPIPE') throw error
    }
  }
  return { child, line, exited, send }
}

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
