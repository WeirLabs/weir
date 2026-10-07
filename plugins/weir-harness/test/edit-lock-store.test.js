import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'

async function fixture(t) {
  const root = await realpath(tmpdir())
  const directory = await mkdtemp(join(root, 'weir-edit-lock-store-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), root)
    assert.ok(directory.startsWith(join(root, 'weir-edit-lock-store-')))
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

const emptyState = () => ({
  version: 4, managerIncarnation: null, sessions: [], generations: [],
  locks: [], issuedRequests: [], recovery: [], holds: [], operations: [],
})

const authorityImage = () => ({
  version: 4, managerIncarnation: 'historical-manager-1', operations: [],
  sessions: [{ sessionId: 'alice', executionEpoch: 2, interrupted: true }],
  generations: [{ resourceId: 'file:a', generation: 1 }],
  locks: [{ resourceId: 'file:a', owner: 'alice', generation: 1, status: 'user-interrupted' }],
  issuedRequests: [{ sessionId: 'alice', requestId: 'continue-1' }],
  recovery: [{ sessionId: 'alice', attempts: 1, elapsedMs: 100, pauseMs: 20 }],
  // One retention row per known session, even before any batch exists.
  holds: [{ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 }],
})

test('creates, records and recovers detached historical Edit Lock facts', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'workspace-a', mode: 'create' })
  assert.deepEqual(store.snapshot(), { revision: 0, state: emptyState() })
  const image = authorityImage()
  const pending = store.record({ expectedRevision: 0, nextState: image })
  image.sessions[0].executionEpoch = 999
  const committed = await pending
  assert.deepEqual(committed, { revision: 1, state: authorityImage() })
  committed.state.locks.length = 0
  store.snapshot().state.sessions.length = 0
  assert.deepEqual(store.snapshot(), { revision: 1, state: authorityImage() })
  await store.close()
  const recovered = await openEditLockStore({ directory, domainId: 'workspace-a', mode: 'recover' })
  assert.deepEqual(recovered.snapshot(), { revision: 1, state: authorityImage() })
  await recovered.close()
})


test('closed schema rejects malformed authority and references without poisoning writes', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const invalid = [
    s => { s.extra = true }, s => { delete s.recovery }, s => { s.version = 1 },
    s => { s.receipts = [{}] }, s => { s.managerIncarnation = null },
    s => { s.sessions[0].executionEpoch = 0 }, s => { s.sessions[0].executionEpoch = Number.MAX_SAFE_INTEGER + 1 },
    s => { s.sessions[0].interrupted = 'yes' }, s => { s.sessions[0].extra = 1 },
    s => { s.sessions.push({ ...s.sessions[0] }) }, s => { s.sessions = [] },
    s => { s.generations.push({ ...s.generations[0] }) }, s => { s.generations[0].generation = -1 },
    s => { s.locks.push({ ...s.locks[0] }) }, s => { s.locks[0].owner = 'unknown' },
    s => { s.locks[0].generation = 2 }, s => { s.locks[0].status = 'unknown' },
    s => { s.locks[0].status = 'active' }, s => { s.locks[0].status = 'abnormal' },
    s => { s.locks[0].reason = 'unexpected' }, s => { s.generations = [] },
    s => { s.issuedRequests.push({ ...s.issuedRequests[0] }) },
    s => { s.issuedRequests[0].sessionId = 'unknown' }, s => { s.issuedRequests[0].requestId = '' },
    s => { s.recovery.push({ ...s.recovery[0] }) }, s => { s.recovery[0].sessionId = 'unknown' },
    s => { s.recovery[0].attempts = 0.5 }, s => { s.recovery[0].elapsedMs = Infinity },
    s => { s.recovery[0].pauseMs = -1 }, s => { s.sessions = {} },
    s => { s.recovery[0].pauseMs = -0 },
  ]
  for (const mutate of invalid) {
    const state = authorityImage(); mutate(state)
    await assert.rejects(store.record({ expectedRevision: 0, nextState: state }), /invalid/)
    assert.equal(store.snapshot().revision, 0)
  }
  await store.record({ expectedRevision: 0, nextState: authorityImage() })
  await store.close()
})


test('retains monotonic epochs, generation history, request tombstones and charged recovery', async t => {
  const store = await openEditLockStore({ directory: await fixture(t), domainId: 'd', mode: 'create' })
  await store.record({ expectedRevision: 0, nextState: authorityImage() })
  for (const mutate of [
    s => { s.sessions[0].executionEpoch = 1 },
    s => { s.sessions[0].interrupted = false; s.locks[0].status = 'pending-confirmation' },
    s => { s.sessions = []; s.locks = []; s.issuedRequests = []; s.recovery = []; s.holds = [] },
    s => { s.locks = []; s.generations = [] }, s => { s.issuedRequests = [] },
    s => { s.recovery = [] }, s => { s.recovery[0].attempts = 0 },
    s => { s.recovery[0].elapsedMs = 99 }, s => { s.recovery[0].pauseMs = 19 },
  ]) {
    const state = authorityImage(); mutate(state)
    await assert.rejects(store.record({ expectedRevision: 1, nextState: state }), /invalid/)
  }
  const released = authorityImage(); released.locks = []
  // The batch ends with its last lock: the row stays and returns to zero.
  released.holds = [{ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 }]
  await store.record({ expectedRevision: 1, nextState: released })
  await assert.rejects(store.record({ expectedRevision: 2, nextState: authorityImage() }), /generation/)
  const reacquired = authorityImage()
  reacquired.generations[0].generation = reacquired.locks[0].generation = 2
  await store.record({ expectedRevision: 2, nextState: reacquired })
  const replacement = structuredClone(reacquired)
  replacement.sessions.push({ sessionId: 'bob', executionEpoch: 1, interrupted: true })
  replacement.holds.push({ sessionId: 'bob', holding: false, holdUntil: null, holdCumulativeMs: 0 })
  replacement.locks[0].owner = 'bob'
  await assert.rejects(store.record({ expectedRevision: 3, nextState: replacement }), /generation/)
  replacement.generations[0].generation = replacement.locks[0].generation = 3
  await store.record({ expectedRevision: 3, nextState: replacement })
  const rewind = structuredClone(replacement)
  rewind.locks = []; rewind.generations[0].generation = 2
  rewind.holds = rewind.holds.map(held => ({ sessionId: held.sessionId, holding: false, holdUntil: null, holdCumulativeMs: 0 }))
  await assert.rejects(store.record({ expectedRevision: 4, nextState: rewind }), /generation/)
  await store.close()
})


test('create refuses absent, nonempty or aliased directories and recover never initializes', async t => {
  const { mkdir, writeFile, symlink, readFile } = await import('node:fs/promises')
  const directory = await fixture(t)
  const opts = { directory, domainId: 'd', mode: 'create' }
  await assert.rejects(openEditLockStore({ ...opts, mode: 'other' }), /invalid/)
  await assert.rejects(openEditLockStore({ ...opts, domainId: '' }), /invalid/)
  await assert.rejects(openEditLockStore({ ...opts, mode: 'recover' }))
  await assert.rejects(openEditLockStore({ ...opts, directory: join(directory, 'absent') }))
  await writeFile(join(directory, 'unrelated'), 'untouched')
  await assert.rejects(openEditLockStore(opts), /empty/)
  assert.equal(await readFile(join(directory, 'unrelated'), 'utf8'), 'untouched')
  await mkdir(join(directory, 'dedicated'))
  await symlink(join(directory, 'dedicated'), join(directory, 'alias'))
  await assert.rejects(openEditLockStore({ ...opts, directory: join(directory, 'alias') }), /directory/)
  const store = await openEditLockStore({ ...opts, directory: join(directory, 'dedicated') })
  await store.close()
  await assert.rejects(openEditLockStore({ ...opts, directory: join(directory, 'dedicated') }), /empty/)
})


// Independent fixture encoder for deliberately corrupt/on-disk recovery inputs.
function encode(payload) {
  const text = value => Array.isArray(value) ? `[${value.map(text).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${text(value[k])}`).join(',')}}`
      : JSON.stringify(value)
  return text({ payload, checksum: createHash('sha256').update(text(payload)).digest('hex') })
}

test('recovery rejects noncanonical, duplicate, corrupt, incompatible and unsafe snapshots without temp promotion', async t => {
  const { writeFile, readFile, symlink, mkdir } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const directory = await fixture(t)
  const options = { directory, domainId: 'd', mode: 'recover' }
  const store = await openEditLockStore({ ...options, mode: 'create' }); await store.close()
  const target = join(directory, 'snapshot.json')
  const original = await readFile(target, 'utf8')
  const payload = JSON.parse(original).payload
  for (const bytes of [
    original + '\n', original.replace('"checksum":', '"extra":1,"checksum":'),
    original.replace('"revision":0', '"revision":0,"revision":0'),
    original.replace('"revision":0', '"revision":1'), original.slice(0, -4),
    encode({ ...payload, version: 1 }), encode({ ...payload, version: 99 }), encode({ ...payload, domainId: 'other' }),
    encode({ ...payload, state: { ...emptyState(), version: 1 } }),
    encode({ ...payload, revision: -1 }), encode({ ...payload, state: { ...emptyState(), receipts: [] } }),
  ]) {
    await writeFile(target, bytes)
    await writeFile(join(directory, '.snapshot-valid.tmp'), original)
    await assert.rejects(openEditLockStore(options))
    assert.equal(await readFile(target, 'utf8'), bytes)
  }
  for (const kind of ['symlink', 'directory', 'fifo', 'missing']) {
    const dir = await fixture(t)
    const path = join(dir, 'snapshot.json')
    await writeFile(join(dir, '.snapshot-valid.tmp'), original)
    if (kind === 'symlink') await symlink(target, path)
    if (kind === 'directory') await mkdir(path)
    if (kind === 'fifo') execFileSync('mkfifo', [path])
    await assert.rejects(openEditLockStore({ ...options, directory: dir }))
  }
  await writeFile(target, original)
  const recovered = await openEditLockStore(options)
  assert.deepEqual(recovered.snapshot(), { revision: 0, state: emptyState() })
  await recovered.close()
})


test('every persistence failure poisons queued/future writes; actual rename is never rolled back', async t => {
  const steps = ['temp-open', 'write', 'file-sync', 'file-close', 'rename', 'directory-open', 'directory-sync', 'directory-close']
  for (const step of steps) for (const when of ['before', 'after']) {
    await t.test(`${when}:${step}`, async t => {
      const directory = await fixture(t)
      let armed = false
      const events = []
      const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' }, {
        checkpoint(point) {
          if (!armed) return
          events.push(point)
          if (point === `${when}:${step}`) throw new Error('injected disk failure')
        },
      })
      armed = true
      const first = store.record({ expectedRevision: 0, nextState: authorityImage() })
      const queued = store.record({ expectedRevision: 1, nextState: authorityImage() })
      const outcomes = await Promise.allSettled([first, queued])
      assert.equal(outcomes[0].status, 'rejected')
      assert.equal(outcomes[1].status, 'rejected')
      const renamed = steps.indexOf(step) > steps.indexOf('rename') || (step === 'rename' && when === 'after')
      assert.equal(outcomes[0].reason.code, 'EDIT_LOCK_STORE_PERSISTENCE')
      assert.equal(outcomes[0].reason.commitStatus, renamed ? 'uncertain' : 'not-renamed')
      const count = events.length
      await assert.rejects(store.record({ expectedRevision: 0, nextState: emptyState() }), /poisoned/)
      assert.equal(events.length, count)
      assert.throws(() => store.snapshot(), /poisoned/)
      await store.close()
      const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
      assert.deepEqual(recovered.snapshot(), renamed ? { revision: 1, state: authorityImage() } : { revision: 0, state: emptyState() })
      await recovered.close()
    })
  }
})


test('queue CAS is per handle, close drains admitted work, and validation never poisons', async t => {
  const directory = await fixture(t)
  let armed = false
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const events = []
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' }, {
    async checkpoint(point) {
      if (!armed) return
      events.push(point)
      if (point === 'before:rename') { entered.resolve(); await release.promise }
    },
  })
  await assert.rejects(store.record({ expectedRevision: -1, nextState: emptyState() }), /invalid/)
  await assert.rejects(store.record({ expectedRevision: 0, nextState: emptyState(), extra: true }), /invalid/)
  armed = true
  const first = store.record({ expectedRevision: 0, nextState: authorityImage() })
  const stale = store.record({ expectedRevision: 0, nextState: authorityImage() })
  const next = store.record({ expectedRevision: 1, nextState: authorityImage() })
  const outcomes = Promise.allSettled([first, stale, next])
  await entered.promise
  let drained = false
  const closing = store.close().then(() => { drained = true })
  await assert.rejects(store.record({ expectedRevision: 2, nextState: authorityImage() }), /closed/)
  assert.equal(drained, false)
  assert.equal(store.snapshot().revision, 0)
  release.resolve()
  const result = await outcomes
  assert.deepEqual(result.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled'])
  assert.match(result[1].reason.message, /revision conflict/)
  await closing; await store.close()
  assert.equal(store.snapshot().revision, 2)
  const sequence = ['temp-open', 'write', 'file-sync', 'file-close', 'rename', 'directory-open', 'directory-sync', 'directory-close'].flatMap(s => [`before:${s}`, `after:${s}`])
  assert.deepEqual(events, [...sequence, ...sequence])
})


test('rejects lossy JavaScript inputs rather than sanitizing them into valid authority', async t => {
  const store = await openEditLockStore({ directory: await fixture(t), domainId: 'd', mode: 'create' })
  for (const mutate of [
    s => Object.defineProperty(s, 'receipts', { value: [] }),
    s => { s[Symbol('capability')] = {} },
    s => Object.setPrototypeOf(s, { inherited: true }),
    s => Object.defineProperty(s, 'sessions', { get() { return [] }, enumerable: true }),
    s => { s.sessions.extra = 'hidden by JSON' },
    s => { s.sessions.length = 1 },
  ]) {
    const state = emptyState(); mutate(state)
    await assert.rejects(store.record({ expectedRevision: 0, nextState: state }), /invalid/)
  }
  await store.record({ expectedRevision: 0, nextState: authorityImage() })
  await store.close()
})


test('retained abnormal reasons cannot be silently cleared within one ownership generation', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const abnormal = authorityImage()
  abnormal.locks[0].status = 'abnormal'; abnormal.locks[0].reason = 'incomplete publication'
  await store.record({ expectedRevision: 0, nextState: abnormal })
  await assert.rejects(store.record({ expectedRevision: 1, nextState: authorityImage() }), /abnormal/)
  const released = authorityImage(); released.locks = []
  // The batch ends with its last lock: the row stays and returns to zero.
  released.holds = [{ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 }]
  await store.record({ expectedRevision: 1, nextState: released })
  await store.close()
  const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.deepEqual(recovered.snapshot(), { revision: 2, state: released })
  assert.equal(recovered.snapshot().state.sessions[0].interrupted, true)
  await assert.rejects(recovered.record({ expectedRevision: 2, nextState: authorityImage() }), /generation/)
  await recovered.close()
})

test('revision exhaustion rejects without writing or poisoning the recovered image', async t => {
  const { writeFile, readFile } = await import('node:fs/promises')
  const directory = await fixture(t)
  const bytes = encode({ version: 4, domainId: 'd', revision: Number.MAX_SAFE_INTEGER, state: emptyState() })
  await writeFile(join(directory, 'snapshot.json'), bytes)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  await assert.rejects(store.record({ expectedRevision: Number.MAX_SAFE_INTEGER, nextState: emptyState() }), /overflow/)
  assert.equal(store.snapshot().revision, Number.MAX_SAFE_INTEGER)
  assert.equal(await readFile(join(directory, 'snapshot.json'), 'utf8'), bytes)
  await store.close()
})


test('SIGKILL at real persistence barriers leaves only complete old/new committed images', async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  for (const point of ['after:write', 'after:file-sync', 'before:rename', 'after:rename', 'after:directory-sync', 'after:directory-close']) {
    await t.test(point, { timeout: 10000 }, async t => {
      const directory = await fixture(t)
      const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' }); await store.close()
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { openEditLockStore } from ${JSON.stringify(new URL('../src/edit-lock/store.js', import.meta.url).href)};
        const store = await openEditLockStore({ directory: ${JSON.stringify(directory)}, domainId: 'd', mode: 'recover' }, {
          async checkpoint(point) {
            if (point === ${JSON.stringify(point)}) {
              await new Promise(resolve => process.send('barrier', resolve));
              await new Promise(() => {});
            }
          }
        });
        await store.record({ expectedRevision: 0, nextState: ${JSON.stringify(authorityImage())} });
        process.send('unexpected-ack');
      `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
      let stderr = ''
      child.stderr.on('data', data => { stderr += data })
      const exited = once(child, 'exit')
      const message = once(child, 'message')
      const observed = await Promise.race([message, exited.then(status => { throw new Error(`child exited before barrier: ${status}: ${stderr}`) })])
      assert.equal(observed[0], 'barrier')
      child.kill('SIGKILL')
      assert.deepEqual(await exited, [null, 'SIGKILL'])
      const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
      const renamed = ['after:rename', 'after:directory-sync', 'after:directory-close'].includes(point)
      assert.deepEqual(recovered.snapshot(), renamed ? { revision: 1, state: authorityImage() } : { revision: 0, state: emptyState() })
      await recovered.close()
    })
  }
})

test('retention allowance never shrinks inside a batch and returns to zero only when the batch ends', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const held = authorityImage()
  held.holds = [{ sessionId: 'alice', holding: true, holdUntil: 2_000_000, holdCumulativeMs: 600_000 }]
  await store.record({ expectedRevision: 0, nextState: held })
  // Still holding a lock: the allowance may not be refunded.
  const refunded = structuredClone(held)
  refunded.holds[0] = { sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 }
  await assert.rejects(store.record({ expectedRevision: 1, nextState: refunded }), /retention history/)
  // Last lock released: the batch is over and the row returns to zero.
  refunded.locks = []
  await store.record({ expectedRevision: 1, nextState: refunded })
  assert.equal(store.snapshot().state.holds[0].holdCumulativeMs, 0)
  await store.close()
})

test('a version 2 image recovers losslessly as version 4 with an empty retention row per session', async t => {
  const { writeFile } = await import('node:fs/promises')
  const directory = await fixture(t)
  const { holds: _holds, ...v3 } = authorityImage()
  const v2 = { ...v3, version: 2 }
  await writeFile(join(directory, 'snapshot.json'), encode({ version: 2, domainId: 'd', revision: 7, state: v2 }))
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  const recovered = store.snapshot()
  assert.equal(recovered.revision, 7)
  assert.equal(recovered.state.version, 4)
  assert.deepEqual(recovered.state.holds, [{ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 }])
  assert.deepEqual(recovered.state.locks, v2.locks)
  assert.deepEqual(recovered.state.recovery, v2.recovery)
  // The next record writes version 4 to disk.
  await store.record({ expectedRevision: 7, nextState: recovered.state })
  await store.close()
  const reopened = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.equal(reopened.snapshot().state.version, 4)
  await reopened.close()
})

test('v3 ownership, budgets and request history upgrade unchanged and envelope versions must agree', async t => {
  const { writeFile, readFile } = await import('node:fs/promises')
  const directory = await fixture(t)
  const state = { ...authorityImage(), version: 3 }
  state.holds[0] = { sessionId: 'alice', holding: true, holdUntil: 9000, holdCumulativeMs: 500 }
  const file = join(directory, 'snapshot.json')
  const bytes = encode({ version: 3, domainId: 'd', revision: 8, state })
  await writeFile(file, bytes)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.deepEqual(store.snapshot(), { revision: 8, state: { ...state, version: 4 } })
  assert.equal(await readFile(file, 'utf8'), bytes)
  await store.close()
  await writeFile(file, encode({ version: 3, domainId: 'd', revision: 8, state: { ...state, version: 4 } }))
  await assert.rejects(openEditLockStore({ directory, domainId: 'd', mode: 'recover' }), /version mismatch/)
})

test('a version 2 image that already claims a holds table, or fails its checksum, is refused', async t => {
  const { writeFile } = await import('node:fs/promises')
  const directory = await fixture(t)
  await writeFile(join(directory, 'snapshot.json'), encode({ version: 2, domainId: 'd', revision: 1, state: { ...authorityImage(), version: 2 } }))
  await assert.rejects(openEditLockStore({ directory, domainId: 'd', mode: 'recover' }), /v2 image/)
})
