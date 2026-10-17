// durable-pending-notice (task 4.1): the notice unit is an ordinary capability
// store unit — its own file, its own revision, its own lock — under
// sessions/<sessionId>/notice.json. The pins live here (the notice unit's own
// store-level suite) rather than in capability-store.test.js, which is outside
// this lane's minted write scope; capability-store.test.js already pins the
// shared layout/decode contract and stays green unmodified.
import { test, expect, storePlatformSkip } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { unitLayout } from '../src/capabilities/store/paths.js'
import { RECORD_SCHEMA_VERSION } from '../src/capabilities/store/record.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'

const SESSION = 'session-4c7e1a90-5555-4b6c-9d2e-000000000004'
const notice = { kind: 'notice', sessionId: SESSION }
const selection = { kind: 'selection', sessionId: SESSION }

async function fixture(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-notice-store-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'weir-notice-store-')))
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('the notice unit lays out as sessions/<sessionId>/notice.json', () => {
  expect(unitLayout(notice)).toEqual({ key: `sessions/${SESSION}/notice`, segments: ['sessions', SESSION], name: 'notice' })
  // Same segment discipline as every other session unit: no traversal, no dots.
  for (const bad of ['..', '../x', 'a.b', '', 'a/b', '-x']) {
    assert.throws(() => unitLayout({ kind: 'notice', sessionId: bad }), TypeError)
  }
})

test('the notice unit is an independent record beside the selection unit, on the shared envelope', { skip: storePlatformSkip }, async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  assert.deepEqual(await store.read(notice), { kind: 'absent', revision: 0 })
  assert.equal(store.commitSync(selection, 0, () => ({ skills: [], mcpServers: [], origin: 'apply' })).revision, 1)
  assert.equal(store.commitSync(notice, 0, () => ({ added: ['alpha'], removed: [] })).revision, 1)
  // Two files, two revisions: notice bookkeeping never bumps the accepted
  // selection record (its revision is the client's CAS token).
  expect((await readdir(join(root, 'sessions', SESSION))).sort()).toEqual(['notice.json', 'selection.json'])
  assert.equal((await store.read(selection)).revision, 1)
  const record = await store.read(notice)
  expect(record.kind).toBe('ok')
  expect(record.revision).toBe(1)
  expect(record.payload).toEqual({ added: ['alpha'], removed: [] })
  // Same record envelope, unchanged schema version, payload opaque to the store.
  expect(RECORD_SCHEMA_VERSION).toBe(1)
  // The per-unit CAS is independent: the notice unit's stale revision conflicts.
  assert.equal(store.commitSync(notice, 0, () => ({ added: [], removed: [] })).status, 'revision-conflict')
})

test('a damaged notice record fails closed instead of being repaired', { skip: storePlatformSkip }, async t => {
  const root = await fixture(t)
  const store = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  assert.equal(store.commitSync(notice, 0, () => ({ added: ['alpha'], removed: [] })).status, 'committed')
  await writeFile(join(root, 'sessions', SESSION, 'notice.json'), '{')
  assert.deepEqual(await store.read(notice), { kind: 'corrupt' })
  assert.deepEqual(store.readSync(notice), { kind: 'corrupt' })
  assert.deepEqual(store.commitSync(notice, 0, () => ({ added: [], removed: [] })), { status: 'unreadable', kind: 'corrupt' })
})
