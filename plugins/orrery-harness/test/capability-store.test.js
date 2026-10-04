import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createNodeFs, instrumentFs } from '../src/capabilities/store/fs-adapter.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { resolveStoreRoot, unitLayout } from '../src/capabilities/store/paths.js'
import { decodeRecord, encodeRecord } from '../src/capabilities/store/record.js'
import { openCapabilityStore as openStore } from '../src/capabilities/store/store.js'

const openCapabilityStore = options => openStore({ liveness: createStubLiveness(), ...options })

async function fixture(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'orrery-capability-store-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'orrery-capability-store-')))
    await rm(root, { recursive: true, force: true })
  })
  return root
}

const SESSION = 'session-db6e88dc-669c-46d9-a7e7-ae7e98883320'
const unit = { kind: 'selection', sessionId: SESSION }
const unitDir = root => join(root, 'sessions', SESSION)
const recordPath = root => join(unitDir(root), 'selection.json')

const deadLock = (overrides = {}) => JSON.stringify({
  schemaVersion: 1, ownerToken: 'deadbeefdeadbeef', pid: process.pid, host: hostname(),
  startIdentity: { osStart: null, bootNonce: 'another-process' }, acquiredAt: 0, leaseUntil: 0, ...overrides,
})

test('store root resolves only from a valid profileContext', () => {
  assert.deepEqual(resolveStoreRoot({ home: '/h', name: 'desktop', dir: '/h/profiles/desktop' }),
    { supported: true, root: join('/h', 'orrery', 'profiles', 'desktop', 'capabilities') })
  assert.deepEqual(resolveStoreRoot(undefined), { supported: false, reason: 'profile-context-unavailable' })
  assert.deepEqual(resolveStoreRoot({ home: 'relative', name: 'desktop' }), { supported: false, reason: 'profile-context-invalid' })
  assert.deepEqual(resolveStoreRoot({ home: '/h', name: '../x' }), { supported: false, reason: 'profile-context-invalid' })
})

test('unit layout accepts real session ids and rejects traversal or dotted segments', () => {
  assert.deepEqual(unitLayout(unit), { key: `sessions/${SESSION}/selection`, segments: ['sessions', SESSION], name: 'selection' })
  assert.equal(unitLayout({ kind: 'preset', scope: 'workspace', workspaceKey: 'w1', presetId: 'p1' }).key, 'presets/workspace/w1/p1')
  assert.equal(unitLayout({ kind: 'mcp-registry' }).key, 'mcp/registry')
  for (const bad of ['..', '../x', 'a.b', '', 'a/b', '-x']) {
    assert.throws(() => unitLayout({ kind: 'selection', sessionId: bad }), TypeError)
  }
  assert.throws(() => unitLayout({ kind: 'preset', scope: 'other', presetId: 'p' }), TypeError)
})

test('record decoding fails closed on corrupt, unknown-schema and torn records', () => {
  const record = encodeRecord(3, { b: 1, a: [2] }, [])
  assert.equal(decodeRecord(JSON.stringify(record)).kind, 'ok')
  assert.deepEqual(decodeRecord('{'), { kind: 'corrupt' })
  assert.deepEqual(decodeRecord('[]'), { kind: 'corrupt' })
  assert.deepEqual(decodeRecord(JSON.stringify({ ...record, schemaVersion: 9 })), { kind: 'unknown-schema', schemaVersion: 9 })
  assert.deepEqual(decodeRecord(JSON.stringify({ ...record, payload: { a: [3], b: 1 } })), { kind: 'torn' })
  assert.deepEqual(decodeRecord(JSON.stringify({ ...record, revision: 0 })), { kind: 'corrupt' })
})

test('commit is compare-and-set on the unit revision and leaves no lock or temp behind', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin' })
  assert.deepEqual(await store.read(unit), { kind: 'absent', revision: 0 })
  const first = await store.commit(unit, 0, previous => ({ previous: previous ?? null, skills: ['a'] }))
  assert.deepEqual(first, { status: 'committed', revision: 1, payload: { previous: null, skills: ['a'] }, receipt: null })
  const bytes = await readFile(recordPath(root), 'utf8')
  assert.deepEqual(await store.commit(unit, 0, () => ({ skills: ['b'] })), { status: 'revision-conflict', revision: 1 })
  assert.equal(await readFile(recordPath(root), 'utf8'), bytes)
  const read = await store.read(unit)
  assert.equal(read.kind, 'ok')
  assert.deepEqual(read.payload, { previous: null, skills: ['a'] })
  assert.deepEqual(await readdir(unitDir(root)), ['selection.json'])
})

test('concurrent in-process commits on one revision accept exactly one', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.commit(unit, 0, () => ({ writer: i }))))
  assert.equal(results.filter(r => r.status === 'committed').length, 1)
  assert.equal(results.filter(r => r.status === 'revision-conflict').length, 19)
  assert.equal((await store.read(unit)).revision, 1)
})

test('requestId replays the original receipt and rejects a reused id with another payload', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin', now: () => 1000 })
  const accepted = await store.commit(unit, 0, () => ({ skills: ['a'] }), { requestId: 'r1', requestDigest: 'd1' })
  assert.equal(accepted.status, 'committed')
  const receipt = { requestId: 'r1', requestDigest: 'd1', revision: 1, acceptedAt: 1000 }
  assert.deepEqual(accepted.receipt, receipt)
  assert.deepEqual(await store.commit(unit, 0, () => ({ skills: ['a'] }), { requestId: 'r1', requestDigest: 'd1' }),
    { status: 'duplicate', revision: 1, receipt })
  assert.deepEqual(await store.commit(unit, 1, () => ({ skills: ['z'] }), { requestId: 'r1', requestDigest: 'd2' }),
    { status: 'request-conflict', receipt })
  assert.equal((await store.read(unit)).revision, 1)
  await assert.rejects(store.commit(unit, 1, () => ({}), { requestId: 'r2' }), TypeError)
  const second = await store.commit(unit, 1, () => ({ skills: [] }), { requestId: 'r2', requestDigest: 'd3' })
  assert.equal(second.status, 'committed')
  const read = await store.read(unit)
  assert.deepEqual(read.receipts.map(r => r.requestId), ['r1', 'r2'])
})

test('unreadable records fail closed and are never overwritten', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin' })
  await mkdir(unitDir(root), { recursive: true })
  for (const [text, kind] of [['not json', 'corrupt'], [JSON.stringify({ schemaVersion: 99, revision: 4 }), 'unknown-schema'],
    [JSON.stringify({ ...encodeRecord(1, { a: 1 }, []), payload: { a: 2 } }), 'torn']]) {
    await writeFile(recordPath(root), text)
    assert.equal((await store.read(unit)).kind, kind)
    assert.deepEqual(await store.commit(unit, 0, () => ({ fresh: true })), { status: 'unreadable', kind })
    assert.equal(await readFile(recordPath(root), 'utf8'), text)
  }
})

test('unsupported platforms and a missing profileContext perform zero writes', async t => {
  const root = await fixture(t)
  const win = openCapabilityStore({ root, platform: 'win32' })
  assert.deepEqual(win.support, { supported: false, reason: 'platform-unsupported:win32' })
  assert.deepEqual(await win.read(unit), { kind: 'unsupported', reason: 'platform-unsupported:win32' })
  assert.deepEqual(await win.commit(unit, 0, () => ({})), { status: 'unsupported', reason: 'platform-unsupported:win32' })
  assert.deepEqual(await win.publishPointer('global', { expectedRevision: 0, generationId: 'g1', files: { a: 'x' } }),
    { status: 'unsupported', reason: 'platform-unsupported:win32' })
  assert.deepEqual(await readdir(root), [])
  const orphan = openCapabilityStore({ platform: 'darwin' })
  assert.deepEqual(await orphan.commit(unit, 0, () => ({})), { status: 'unsupported', reason: 'profile-context-unavailable' })
  const located = openCapabilityStore({ platform: 'darwin', profileContext: { home: root, name: 'it' } })
  assert.equal((await located.commit(unit, 0, () => ({ ok: true }))).status, 'committed')
  assert.deepEqual(await readdir(join(root, 'orrery', 'profiles', 'it', 'capabilities', 'sessions')), [SESSION])
})

test('holder sweeps only this unit\'s orphan temps, candidates and stale locks', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin' })
  await mkdir(unitDir(root), { recursive: true })
  const orphans = ['selection.0123abcd.tmp', 'selection.lock.0123abcd.cand', 'selection.lock.recover.0123abcd.cand', 'selection.lock.stale.0123abcd']
  for (const name of [...orphans, 'content.0123abcd.tmp']) await writeFile(join(unitDir(root), name), 'x')
  assert.equal((await store.commit(unit, 0, () => ({}))).status, 'committed')
  assert.deepEqual((await readdir(unitDir(root))).sort(), ['content.0123abcd.tmp', 'selection.json'])
})

test('a live lock makes commit fail with locked and writes nothing', async t => {
  const root = await fixture(t)
  const holder = openCapabilityStore({ root, platform: 'darwin' })
  assert.equal((await holder.commit(unit, 0, () => ({ v: 1 }))).status, 'committed')
  await writeFile(join(unitDir(root), 'selection.lock'), deadLock({ startIdentity: { osStart: null, bootNonce: 'x' }, pid: 1, leaseUntil: Date.now() + 60_000 }))
  const bytes = await readFile(recordPath(root), 'utf8')
  const store = openCapabilityStore({ root, platform: 'darwin', deadlineMs: 30 })
  assert.deepEqual(await store.commit(unit, 1, () => ({ v: 2 })), { status: 'locked', reason: 'locked' })
  assert.equal(await readFile(recordPath(root), 'utf8'), bytes)
})

test('a dead expired lock is reclaimed; unknown owners and unreadable locks are not', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin', deadlineMs: 30 })
  const lockPath = join(unitDir(root), 'selection.lock')
  await mkdir(unitDir(root), { recursive: true })
  await writeFile(lockPath, deadLock())
  assert.equal((await store.commit(unit, 0, () => ({ v: 1 }))).status, 'committed')
  assert.deepEqual(await readdir(unitDir(root)), ['selection.json'])
  for (const [text, reason] of [[deadLock({ host: 'another-host' }), 'owner-unknown'], ['', 'lock-unreadable'],
    [JSON.stringify({ schemaVersion: 7 }), 'lock-unknown-schema']]) {
    await writeFile(lockPath, text)
    assert.deepEqual(await store.commit(unit, 1, () => ({ v: 2 })), { status: 'locked', reason })
    assert.equal(await readFile(lockPath, 'utf8'), text)
  }
  assert.equal((await store.read(unit)).revision, 1)
})

test('an expired lease with a live owner is not reclaimed', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin', deadlineMs: 30 })
  await mkdir(unitDir(root), { recursive: true })
  // leaseUntil: 0 (expired) but the owner identity is THIS live process.
  const own = JSON.parse(deadLock())
  own.startIdentity = await createStubLiveness().identity()
  await writeFile(join(unitDir(root), 'selection.lock'), JSON.stringify(own))
  assert.deepEqual(await store.commit(unit, 0, () => ({ v: 1 })), { status: 'locked', reason: 'locked' })
  assert.equal(JSON.parse(await readFile(join(unitDir(root), 'selection.lock'), 'utf8')).ownerToken, own.ownerToken)
  assert.equal((await store.read(unit)).kind, 'absent')
})

test('an interrupted reclamation needs manual recovery, which re-checks what was shown', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin', deadlineMs: 30 })
  await mkdir(unitDir(root), { recursive: true })
  await writeFile(join(unitDir(root), 'selection.lock'), deadLock())
  await writeFile(join(unitDir(root), 'selection.lock.recover'), deadLock({ ownerToken: 'feedfacefeedface' }))
  assert.deepEqual(await store.commit(unit, 0, () => ({})), { status: 'locked', reason: 'recover-interrupted' })
  const shown = await store.inspect(unit)
  assert.equal(shown.recover.ownerToken, 'feedfacefeedface')
  assert.equal(shown.recover.owner, 'dead')
  assert.equal(await store.clear(unit, 'recover', 'cafebabecafebabe'), 'changed')
  assert.equal(await store.clear(unit, 'recover', 'feedfacefeedface'), 'cleared')
  assert.equal((await store.commit(unit, 0, () => ({ v: 1 }))).status, 'committed')
  assert.deepEqual(await readdir(unitDir(root)), ['selection.json'])
})

test('manual recovery refuses to clear a lock whose owner is alive', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin' })
  await mkdir(unitDir(root), { recursive: true })
  const own = JSON.parse(deadLock())
  own.startIdentity = await createStubLiveness().identity()
  await writeFile(join(unitDir(root), 'selection.lock'), JSON.stringify(own))
  assert.equal(await store.clear(unit, 'lock', own.ownerToken), 'owner-alive')
  assert.equal(JSON.parse(await readFile(join(unitDir(root), 'selection.lock'), 'utf8')).ownerToken, own.ownerToken)
})

test('a failed rename keeps the old record; an uncertain dir fsync re-reads and accepts', async t => {
  const root = await fixture(t)
  let fault = null
  const fs = instrumentFs(createNodeFs(), (op, args, phase) => {
    if (phase === 'before' && fault && fault.op === op && (fault.match?.(args) ?? true)) {
      const code = fault.code
      fault = null
      throw Object.assign(new Error(`injected ${code}`), { code })
    }
  })
  const store = openCapabilityStore({ root, platform: 'darwin', fs })
  assert.equal((await store.commit(unit, 0, () => ({ v: 1 }))).status, 'committed')
  const bytes = await readFile(recordPath(root), 'utf8')
  fault = { op: 'rename', code: 'EIO', match: args => args[1] === recordPath(root) }
  assert.equal((await store.commit(unit, 1, () => ({ v: 2 }))).status, 'write-failed')
  assert.equal(await readFile(recordPath(root), 'utf8'), bytes)
  fault = { op: 'rename', code: 'EXDEV', match: args => args[1] === recordPath(root) }
  assert.deepEqual(await store.commit(unit, 1, () => ({ v: 2 })), { status: 'unsupported', reason: 'cross-device' })
  assert.equal(await readFile(recordPath(root), 'utf8'), bytes)
  assert.deepEqual(await readdir(unitDir(root)), ['selection.json'])
  fault = { op: 'fsyncDir', code: 'EIO' }
  const uncertain = await store.commit(unit, 1, () => ({ v: 2 }))
  assert.equal(uncertain.status, 'committed')
  assert.deepEqual((await store.read(unit)).payload, { v: 2 })
  assert.equal((await store.commit(unit, 2, () => ({ v: 3 }))).status, 'committed')
})

test('publishPointer writes the generation under the lock and switches active.json atomically', async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const dir = join(root, 'distribution', 'global')
  const first = await store.publishPointer('global', { expectedRevision: 0, generationId: 'g1', files: { 'SKILL.md': 'body', 'b.txt': 'b' }, provenance: { from: 'test' }, requestId: 'p1', requestDigest: 'x' })
  assert.equal(first.status, 'committed')
  assert.equal(await readFile(join(dir, 'generations', 'g1', 'SKILL.md'), 'utf8'), 'body')
  const active = await store.read({ kind: 'distribution', scope: 'global' })
  assert.equal(active.payload.generationId, 'g1')
  assert.deepEqual(Object.keys(active.payload.manifest), ['SKILL.md', 'b.txt'])
  assert.deepEqual(active.payload.provenance, { from: 'test' })
  assert.deepEqual(active.receipts.map(r => r.requestId), ['p1'])
  assert.deepEqual(await store.publishPointer('global', { expectedRevision: 0, generationId: 'g2', files: { a: 'a' } }), { status: 'revision-conflict', revision: 1 })
  assert.deepEqual(await readdir(join(dir, 'generations')), ['g1'])
  assert.deepEqual(await store.publishPointer('global', { expectedRevision: 1, generationId: 'g1', files: { a: 'a' } }), { status: 'generation-exists' })
  assert.equal((await store.read({ kind: 'distribution', scope: 'global' })).revision, 1)
  assert.throws(() => store.publishPointer('global', { expectedRevision: 1, generationId: 'g.3', files: {} }), TypeError)
  assert.throws(() => store.publishPointer('global', { expectedRevision: 1, generationId: 'g3', files: { '../x': 'a' } }), TypeError)
})
