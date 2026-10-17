// durable-pending-notice (D1/D2/D4/D5): the pending model-facing capability
// notice is a durable capability-store unit, not a process Map. Every test here
// drives the notifier over a REAL store root and stands a FRESH module instance
// (a restarted host process) beside it — the guarantee is "the obligation
// outlives the process that queued it", so a same-instance round trip proves
// nothing.
//
// The pins are RED on the pre-change code: there is no durable queue, so
// `queueSync`/`pending`/`clearDelivered` do not exist and nothing reaches disk.
import { test, expect, storePlatformSkip } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { AUDIT_TYPES, createAudit } from '../src/shared/audit.js'
import { createSelectionNotifier } from '../src/capabilities/selection-notify.js'

const skip = storePlatformSkip
const SESSION = 'session-9b1d4f7a-1111-4c2d-8e3f-000000000001'
const OTHER = 'session-9b1d4f7a-2222-4c2d-8e3f-000000000002'
const NEVER = 'session-9b1d4f7a-3333-4c2d-8e3f-000000000003'
const unit = { kind: 'notice', sessionId: SESSION }
const noticePath = root => join(root, 'sessions', SESSION, 'notice.json')

/**
 * One store root plus two independent views of it: `notifier()` is this
 * process, `restart()` is the next host process (a fresh store handle AND a
 * fresh module instance over the same files).
 */
async function fixture(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-notice-durable-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'weir-notice-durable-')))
    await rm(root, { recursive: true, force: true })
  })
  const store = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  const emitted = []
  const audit = createAudit({ emit: (type, record) => emitted.push({ type, record }) })
  const open = () => openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  return {
    root,
    store,
    emitted,
    audit,
    notifier: () => createSelectionNotifier({ store, audit }),
    restart: () => createSelectionNotifier({ store: open(), audit }),
    open,
  }
}

const noticeAudits = emitted => emitted.filter(entry => entry.type === `weir/${AUDIT_TYPES.capabilityNotice}`)
  .map(entry => entry.record.data)

test('2.1 a queued delta is durable: a fresh module instance over the same root reports the obligation', { skip }, async t => {
  const { store, notifier, restart } = await fixture(t)
  notifier().queueSync(SESSION, { added: ['alpha', 'beta'], removed: [] })

  // The record itself: a normal store unit under sessions/<id>/notice.json.
  const record = await store.read(unit)
  expect(record.kind).toBe('ok')
  expect(record.payload).toEqual({ added: ['alpha', 'beta'], removed: [] })

  // The restart guarantee: nothing but the file carries the obligation.
  const restarted = restart()
  expect(await restarted.pending(SESSION)).toEqual({ added: ['alpha', 'beta'], removed: [], revision: 1 })
  expect(restarted.has(SESSION)).toBe(true)
  // A session that never applied owes nothing — an absent unit is not an error.
  expect(await restarted.pending(NEVER)).toBeNull()
  expect(restarted.has(NEVER)).toBe(false)
})

test('2.2 coalescing holds against the durable pending, including across a restart', { skip }, async t => {
  const { notifier, restart } = await fixture(t)
  notifier().queueSync(SESSION, { added: ['x', 'y'], removed: [] })
  // A restarted process continues the same obligation instead of starting over.
  const restarted = restart()
  restarted.queueSync(SESSION, { added: [], removed: ['x'] })
  // x was added then removed before the next request: net zero, out of both sets.
  expect(await restarted.pending(SESSION)).toEqual({ added: ['y'], removed: [], revision: 2 })
  // Re-queueing the same delta is a no-op — no new revision, no double announce.
  restarted.queueSync(SESSION, { added: ['y'], removed: [] })
  expect(await restarted.pending(SESSION)).toEqual({ added: ['y'], removed: [], revision: 2 })
  // The last name nets out too: nothing is owed any more.
  restarted.queueSync(SESSION, { added: [], removed: ['y'] })
  expect(await restarted.pending(SESSION)).toBeNull()
  expect(restarted.has(SESSION)).toBe(false)
  // Sessions are independent units.
  restarted.queueSync(OTHER, { added: ['other'], removed: [] })
  expect(await restarted.pending(OTHER)).toEqual({ added: ['other'], removed: [], revision: 1 })
})

test('2.3 clear-on-delivery: the obligation outlives an unsent notice and is subtracted once delivered', { skip }, async t => {
  const { store, notifier, restart } = await fixture(t)
  const n = notifier()
  n.queueSync(SESSION, { added: ['a'], removed: ['b'] })
  // Reading is not delivering: the obligation is still there afterwards.
  const pending = await n.pending(SESSION)
  expect(pending.added).toEqual(['a'])
  expect(await n.pending(SESSION)).toEqual({ added: ['a'], removed: ['b'], revision: 1 })

  const cleared = await n.clearDelivered(SESSION, pending)
  expect(cleared.status).toBe('cleared')
  // A fresh process sees no obligation, and neither does the local mirror.
  expect(await restart().pending(SESSION)).toBeNull()
  expect(n.has(SESSION)).toBe(false)
  expect(await n.pending(SESSION)).toBeNull()
  // The cleared unit keeps NO names (the payload is emptied, not deleted).
  expect((await store.read(unit)).payload).toEqual({ added: [], removed: [] })
  // A clear over an empty unit, or over a unit that never existed, is a no-op.
  const revision = (await store.read(unit)).revision
  expect((await n.clearDelivered(SESSION, { added: [], removed: [] })).status).toBe('empty')
  expect((await store.read(unit)).revision).toBe(revision)
  expect((await n.clearDelivered(NEVER, { added: [], removed: [] })).status).toBe('absent')
  expect((await store.read({ kind: 'notice', sessionId: NEVER })).kind).toBe('absent')
})

test('2.4 a lost clear race subtracts only the delivered names and leaves the concurrent delta pending', { skip }, async t => {
  const { notifier, restart } = await fixture(t)
  const n = notifier()
  n.queueSync(SESSION, { added: ['alpha'], removed: [] })
  // The delivery read: revision 1, alpha owed.
  const delivered = await n.pending(SESSION)
  expect(delivered.revision).toBe(1)
  // Between the read and the clear CAS, another Apply merges its delta.
  const concurrent = restart()
  concurrent.queueSync(SESSION, { added: ['beta'], removed: [] })
  expect(await concurrent.pending(SESSION)).toEqual({ added: ['alpha', 'beta'], removed: [], revision: 2 })

  // The clear CASes on the revision it read (1): it loses once, re-reads, and
  // subtracts exactly the names it injected.
  const cleared = await n.clearDelivered(SESSION, delivered, { revision: delivered.revision })
  expect(cleared.status).toBe('cleared')
  expect(await restart().pending(SESSION)).toEqual({ added: ['beta'], removed: [], revision: 3 })
})

test('2.4b a second consecutive clear conflict leaves the obligation intact (a repeat, never a loss)', { skip }, async t => {
  const { store, notifier } = await fixture(t)
  notifier().queueSync(SESSION, { added: ['beta'], removed: [] })
  // A store whose CAS can never win: both the attempt and its one retry conflict.
  let attempts = 0
  const contested = { ...store, commit: async () => { attempts += 1; return { status: 'revision-conflict', revision: 99 } } }
  const stuck = createSelectionNotifier({ store: contested })
  const result = await stuck.clearDelivered(SESSION, { added: ['beta'], removed: [] })
  expect(result.status).toBe('revision-conflict')
  // Bounded: one attempt plus exactly one retry, then it gives up.
  expect(attempts).toBe(2)
  // Nothing was lost: the obligation is still on disk for the next boundary.
  expect((await store.read(unit)).payload).toEqual({ added: ['beta'], removed: [] })
  expect(await notifier().pending(SESSION)).toEqual({ added: ['beta'], removed: [], revision: 1 })
})

test('2.5 fail-closed: a locked unit throws on queue, a corrupt unit is never rewritten or turned into a notice', { skip }, async t => {
  const { root, store, emitted, notifier } = await fixture(t)
  await mkdir(join(root, 'sessions', SESSION), { recursive: true })
  // A live sync lock (the holder exists, so the lock is not reclaimable).
  await writeFile(join(root, 'sessions', SESSION, 'notice.lock'), JSON.stringify({
    schemaVersion: 1, ownerToken: 'feedfacefeedface', pid: process.pid, host: hostname(),
    startIdentity: { osStart: null, bootNonce: 'sync-capture' }, acquiredAt: Date.now(), leaseUntil: Date.now() + 60_000,
  }))
  // The queue write FAILS LOUDLY so the engine can degrade the response; it must
  // never be mistaken for a successful queue.
  assert.throws(() => notifier().queueSync(SESSION, { added: ['alpha'], removed: [] }), /locked/)
  expect(noticeAudits(emitted).at(-1).outcome).toBe('queue-failed')
  expect(noticeAudits(emitted).at(-1).status).toBe('locked')
  // A delivery attempt against the locked unit delivers nothing, deletes nothing.
  expect(notifier().has(SESSION)).toBe(false)
  expect(await notifier().pending(SESSION)).toBeNull()
  await rm(join(root, 'sessions', SESSION, 'notice.lock'))

  // A torn/corrupt record: never rewritten, never fabricated into a notice.
  await writeFile(noticePath(root), '{')
  const messages = []
  expect(await notifier().deliver(SESSION, messages)).toBe('unreadable')
  expect(messages).toHaveLength(0)
  expect(await readFile(noticePath(root), 'utf8')).toBe('{')
  assert.throws(() => notifier().queueSync(SESSION, { added: ['alpha'], removed: [] }), /corrupt/)
  expect(await readFile(noticePath(root), 'utf8')).toBe('{')
  expect(noticeAudits(emitted).at(-1).outcome).toBe('queue-failed')
  expect(noticeAudits(emitted).at(-1).status).toBe('corrupt')

  // An unsupported store has no durable queue — and no silent in-memory fallback.
  const unsupported = createSelectionNotifier({ store: openCapabilityStore({ root, platform: 'freebsd', liveness: createStubLiveness() }) })
  assert.throws(() => unsupported.queueSync(SESSION, { added: ['alpha'], removed: [] }), /unsupported/)
  expect(unsupported.has(SESSION)).toBe(false)
  expect(await unsupported.pending(SESSION)).toBeNull()
  void store
})
