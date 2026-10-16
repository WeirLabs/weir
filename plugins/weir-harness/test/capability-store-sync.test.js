// capabilities-deepening D4 (task 4.1): the store's synchronous commit/read
// path is one implementation with the async path (shared paths/record/lock
// modules, same record schema and CAS semantics). These tests pin the
// interop in both directions — an async write is readable synchronously and
// vice versa, byte-identical receipts included — plus the sync path's own
// fail-closed edges (CAS conflict, unreadable record, unsupported platform,
// no residue).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'

const SESSION = 'session-db6e88dc-669c-46d9-a7e7-ae7e98883320'
const unit = { kind: 'selection', sessionId: SESSION }
const unitDir = root => join(root, 'sessions', SESSION)

async function fixture(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-capability-sync-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'weir-capability-sync-')))
    await rm(root, { recursive: true, force: true })
  })
  return root
}

const openStore = options => openCapabilityStore({ liveness: createStubLiveness(), platform: 'darwin', ...options })

test('async commit → sync read: same revision, payload and receipts', async t => {
  const root = await fixture(t)
  const store = openStore({ root, now: () => 1000 })
  const committed = await store.commit(unit, 0, () => ({ skills: ['a'] }), { requestId: 'r1', requestDigest: 'd1' })
  assert.equal(committed.status, 'committed')

  const read = store.readSync(unit)
  assert.equal(read.kind, 'ok')
  assert.equal(read.revision, 1)
  assert.deepEqual(read.payload, { skills: ['a'] })
  assert.deepEqual(read.receipts, [{ requestId: 'r1', requestDigest: 'd1', revision: 1, acceptedAt: 1000 }])
})

test('sync commit → async read: same revision and same receipt; the async path replays the sync receipt', async t => {
  const root = await fixture(t)
  const store = openStore({ root, now: () => 2000 })
  const committed = store.commitSync(unit, 0, () => ({ skills: ['s'] }), { requestId: 'rs', requestDigest: 'ds' })
  assert.equal(committed.status, 'committed')
  assert.equal(committed.revision, 1)
  assert.deepEqual(committed.receipt, { requestId: 'rs', requestDigest: 'ds', revision: 1, acceptedAt: 2000 })

  const read = await store.read(unit)
  assert.equal(read.kind, 'ok')
  assert.equal(read.revision, 1)
  assert.deepEqual(read.payload, { skills: ['s'] })
  assert.deepEqual(read.receipts, [{ requestId: 'rs', requestDigest: 'ds', revision: 1, acceptedAt: 2000 }])

  // The async transact dedupes the sync-written receipt, and a changed digest
  // under the same request id conflicts — one rule, both directions.
  const replay = await store.commit(unit, 1, () => ({ skills: ['other'] }), { requestId: 'rs', requestDigest: 'ds' })
  assert.equal(replay.status, 'duplicate')
  assert.equal(replay.revision, 1)
  const conflicted = store.commitSync(unit, 1, () => ({ skills: ['other'] }), { requestId: 'rs', requestDigest: 'changed' })
  assert.equal(conflicted.status, 'request-conflict')
  assert.equal((await store.read(unit)).revision, 1)
})

test('sync CAS: a stale expected revision conflicts with zero writes', async t => {
  const root = await fixture(t)
  const store = openStore({ root })
  const first = store.commitSync(unit, 0, () => ({ writer: 'first' }))
  assert.equal(first.status, 'committed')
  const bytes = await readFile(join(unitDir(root), 'selection.json'), 'utf8')

  const stale = store.commitSync(unit, 0, () => ({ writer: 'second' }))
  assert.equal(stale.status, 'revision-conflict')
  assert.equal(stale.revision, 1)
  assert.equal(await readFile(join(unitDir(root), 'selection.json'), 'utf8'), bytes)
  assert.equal(store.readSync(unit).payload.writer, 'first')
})

test('sync commit on an unreadable record fails closed and never overwrites', async t => {
  const root = await fixture(t)
  const store = openStore({ root })
  await mkdir(unitDir(root), { recursive: true })
  await writeFile(join(unitDir(root), 'selection.json'), '{corrupt', 'utf8')
  const result = store.commitSync(unit, 0, () => ({ fresh: true }))
  assert.equal(result.status, 'unreadable')
  assert.equal(result.kind, 'corrupt')
  assert.equal(await readFile(join(unitDir(root), 'selection.json'), 'utf8'), '{corrupt')
})

test('sync commit leaves no lock or temp behind', async t => {
  const root = await fixture(t)
  const store = openStore({ root })
  assert.equal(store.commitSync(unit, 0, () => ({ skills: [] })).status, 'committed')
  assert.equal(store.commitSync(unit, 1, () => ({ skills: ['b'] })).status, 'committed')
  assert.deepEqual(await readdir(unitDir(root)), ['selection.json'])
})

test('unsupported platform: the sync paths report unsupported and write nothing', async t => {
  const root = await fixture(t)
  const store = openStore({ root, platform: 'freebsd' })
  assert.deepEqual(store.readSync(unit), { kind: 'unsupported', reason: 'platform-unsupported:freebsd' })
  assert.equal(store.commitSync(unit, 0, () => ({ skills: [] })).status, 'unsupported')
  assert.deepEqual(store.commitSync(unit, 0, () => ({ skills: [] })).reason, 'platform-unsupported:freebsd')
  await assert.rejects(readdir(unitDir(root)), /ENOENT/)
})

test('sync commit requires a digest with a requestId (same contract as transact)', async t => {
  const root = await fixture(t)
  const store = openStore({ root })
  assert.throws(() => store.commitSync(unit, 0, () => ({}), { requestId: 'r1' }), TypeError)
})
