import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, readFile, mkdir, writeFile, lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lookupOperation } from '../src/edit-lock/operation-history.js'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'

async function fixture(t) {
  const root = await realpath(tmpdir())
  const directory = await mkdtemp(join(root, 'orrery-operation-history-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), root)
    assert.ok(directory.startsWith(join(root, 'orrery-operation-history-')))
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

const digest = 'a'.repeat(64)
const binding = () => ({
  tool: 'write', filePath: 'nested/new.txt', cwd: '/workspace',
  requestDigest: digest, argsDigest: digest, payloadDigest: digest,
  target: { kind: 'create', ancestor: '/workspace', suffix: 'nested/new.txt', policy: { kind: 'createIfAbsent' } },
})
const prepared = () => ({
  sessionId: 'alice', operationId: 'op-1',
  origin: { executionEpoch: 1, managerIncarnation: 'manager-1' },
  binding: binding(), phase: 'prepared', fence: null, outcome: null, closeouts: [],
})
const image = () => ({
  version: 4, managerIncarnation: 'manager-1',
  sessions: [{ sessionId: 'alice', executionEpoch: 1, interrupted: false }],
  generations: [], locks: [], issuedRequests: [], recovery: [],
  // One retention row per known session, even before any batch exists.
  holds: [{ sessionId: 'alice', holding: false, holdUntil: null, holdCumulativeMs: 0 }],
  operations: [],
})
/** A session and its retention row are created together: the image keeps exactly
 * one row per known session. */
function addSession(state, sessionId, executionEpoch = 1, interrupted = false) {
  state.sessions.push({ sessionId, executionEpoch, interrupted })
  state.holds.push({ sessionId, holding: false, holdUntil: null, holdCumulativeMs: 0 })
  return state
}
async function record(store, state) {
  return store.record({ expectedRevision: store.snapshot().revision, nextState: state })
}

test('revision advance closes a live attempt without invoking or clearing its fence', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const state = image(); state.operations.push(prepared())
  await record(store, state)
  const target = join(directory, 'stale-write')
  const attempt = await store.beginPublication({ expectedRevision: store.snapshot().revision, nextState: publishing(state) },
    { sessionId: 'alice', operationId: 'op-1' }, () => writeFile(target, 'bad'))
  await record(store, store.snapshot().state)
  await assert.rejects(attempt.finishWithoutDispatch('cancelled-before-dispatch'), /stale/)
  assert.throws(() => attempt.invoke(), /closed/)
  assert.equal(store.snapshot().state.operations[0].phase, 'publishing')
  await assert.rejects(lstat(target), { code: 'ENOENT' })
  await store.close()
})

test('settlement persistence failure poisons the handle and permanently closes invocation', async t => {
  const directory = await fixture(t)
  let fail = false
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' }, {
    checkpoint(point) { if (fail && point === 'before:temp-open') throw new Error('settlement disk failure') },
  })
  const state = image(); state.operations.push(prepared())
  await record(store, state)
  const target = join(directory, 'failed-settlement-write')
  const attempt = await store.beginPublication({ expectedRevision: store.snapshot().revision, nextState: publishing(state) },
    { sessionId: 'alice', operationId: 'op-1' }, () => writeFile(target, 'bad'))
  fail = true
  await assert.rejects(attempt.finishWithoutDispatch('cancelled-before-dispatch'), e => e.code === 'EDIT_LOCK_STORE_PERSISTENCE' && e.cause?.message === 'settlement disk failure')
  assert.throws(() => store.snapshot(), /poisoned/)
  assert.throws(() => attempt.invoke(), /closed/)
  await assert.rejects(lstat(target), { code: 'ENOENT' })
  await store.close()
  const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.equal(recovered.snapshot().state.operations[0].phase, 'publishing')
  await recovered.close()
})
test('invocation burns cancellation proof even when original mutation throws synchronously', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const state = image(); state.operations.push(prepared())
  await record(store, state)
  const failure = new Error('native failure')
  const attempt = await store.beginPublication({ expectedRevision: store.snapshot().revision, nextState: publishing(state) },
    { sessionId: 'alice', operationId: 'op-1' }, () => { throw failure })
  assert.throws(() => attempt.invoke(), e => e === failure)
  await assert.rejects(attempt.finishWithoutDispatch('cancelled-before-dispatch'), /closed/)
  assert.throws(() => attempt.invoke(), /closed/)
  assert.equal(store.snapshot().state.operations[0].phase, 'publishing')
  assert.notEqual(store.snapshot().state.operations[0].fence, null)
  await store.close()
})
test('recovery cannot manufacture a live publication attempt from prepared history', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const state = image(); state.operations.push(prepared())
  await record(store, state); await store.close()
  const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  await assert.rejects(recovered.beginPublication({ expectedRevision: recovered.snapshot().revision, nextState: publishing(state) },
    { sessionId: 'alice', operationId: 'op-1' }, () => writeFile(join(directory, 'no-replay'), 'bad')), /live prepared/)
  assert.equal(recovered.snapshot().state.operations[0].phase, 'prepared')
  await recovered.close()
})
test('live publication attempt can close before invocation without allowing a late write', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const state = image(); state.operations.push(prepared())
  await record(store, state)
  const target = join(directory, 'never-created.txt')
  const attempt = await store.beginPublication({ expectedRevision: store.snapshot().revision, nextState: publishing(state) },
    { sessionId: 'alice', operationId: 'op-1' }, () => writeFile(target, 'forbidden', { flag: 'wx' }))
  await attempt.finishWithoutDispatch('cancelled-before-dispatch')
  assert.equal(store.snapshot().state.operations[0].phase, 'not-published')
  assert.equal(store.snapshot().state.operations[0].fence, null)
  assert.throws(() => attempt.invoke(), /closed/)
  await assert.rejects(attempt.finishWithoutDispatch('cancelled-before-dispatch'), /closed/)
  await assert.rejects(lstat(target), { code: 'ENOENT' })
  await store.close()
  const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.equal(recovered.snapshot().state.operations[0].outcome.reason, 'cancelled-before-dispatch')
  await recovered.close()
})
test('opaque filesystem version strings survive guarded update history and recovery unchanged', async t => {
  for (const version of ['', '\0provider-token']) {
    const directory = await fixture(t)
    const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
    const state = image()
    state.generations.push({ resourceId: '/workspace/file', generation: 1 })
    state.locks.push({ resourceId: '/workspace/file', owner: 'alice', generation: 1, status: 'active' })
    const op = prepared()
    op.binding.target = { kind: 'update', resourceId: '/workspace/file', generation: 1, policy: { kind: 'replaceIfVersion', version } }
    state.operations.push(op)
    await record(store, state)
    op.phase = 'publishing'
    op.fence = { kind: 'resource', resourceId: '/workspace/file' }
    await record(store, state)
    op.phase = 'updated'
    op.outcome = { kind: 'updated', resourceId: '/workspace/file', generation: 1, version }
    await record(store, state)
    await store.close()
    const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
    const historical = recovered.snapshot().state.operations[0]
    assert.equal(historical.binding.target.policy.version, version)
    assert.equal(historical.outcome.version, version)
    await recovered.close()
  }
})

test('v3 history upgrades losslessly, stays fenced, and writes only v4', async t => {
  const directory = await fixture(t)
  const { admitMutation } = await import('../src/edit-lock/admission.js')
  const state = image()
  state.version = 3
  const op = prepared()
  op.phase = 'unknown'; op.outcome = { kind: 'unknown' }
  op.fence = { kind: 'subtree', ancestor: '/workspace', basis: 'observed-ancestor' }
  op.closeouts = [{ kind: 'abandoned-unknown', assertionId: 'legacy-assertion' }]
  state.operations.push(op)
  const payload = { version: 3, domainId: 'd', revision: 19, state }
  const bytes = canonical({ payload, checksum: createHash('sha256').update(canonical(payload)).digest('hex') })
  const file = join(directory, 'snapshot.json')
  await writeFile(file, bytes)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.deepEqual(store.snapshot(), { revision: 19, state: { ...state, version: 4 } })
  assert.equal(await readFile(file, 'utf8'), bytes, 'opening alone does not rewrite history')
  assert.throws(() => admitMutation(store.snapshot().state.operations, { kind: 'resource', resourceId: '/workspace/new' }), /unresolved publication fence/)
  await record(store, store.snapshot().state)
  await store.close()
  const disk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(disk.payload.version, 4)
  assert.deepEqual(disk.payload.state.operations, state.operations)
  const reopened = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.deepEqual(reopened.snapshot().state.operations, state.operations)
  await reopened.close()
})

test('legacy envelopes cannot smuggle bound closeouts and future versions fail closed', async t => {
  const directory = await fixture(t)
  const state = image()
  const op = prepared()
  op.phase = 'unknown'; op.outcome = { kind: 'unknown' }
  op.fence = { kind: 'subtree', ancestor: '/workspace', basis: 'observed-ancestor' }
  op.closeouts = [{ kind: 'abandoned-unknown', assertionId: 'forged', binding: {} }]
  state.operations.push(op)
  for (const version of [2, 3, 5]) {
    const legacy = { ...state, version }
    if (version === 2) delete legacy.holds
    const payload = { version, domainId: 'd', revision: 1, state: legacy }
    const bytes = canonical({ payload, checksum: createHash('sha256').update(canonical(payload)).digest('hex') })
    await writeFile(join(directory, 'snapshot.json'), bytes)
    await assert.rejects(openEditLockStore({ directory, domainId: 'd', mode: 'recover' }), version === 5 ? /supported: 2, 3, 4/ : /schema keys/)
    assert.equal(await readFile(join(directory, 'snapshot.json'), 'utf8'), bytes)
  }
})
test('v4 operations and retention live in the same atomic snapshot and prepared creates own nothing', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  assert.equal(store.snapshot().state.version, 4)
  assert.deepEqual(store.snapshot().state.operations, [])
  const state = image()
  state.operations.push(prepared(), { ...prepared(), operationId: 'op-2' })
  await record(store, state)
  await store.close()
  const disk = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'))
  assert.equal(disk.payload.version, 4)
  assert.equal(disk.payload.state.operations.length, 2)
  const reopened = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.deepEqual(reopened.snapshot().state, state)
  assert.deepEqual(reopened.snapshot().state.locks, [])
  await reopened.close()
})

test('lookup keys history by session and ID before current authority, rejecting changed bindings', async t => {
  const { lookupOperation } = await import('../src/edit-lock/operation-history.js')
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const state = image()
  state.operations.push(prepared())
  await record(store, state)
  state.sessions[0].executionEpoch = 8
  state.sessions[0].interrupted = true
  state.managerIncarnation = 'manager-2'
  await record(store, state)
  const query = { sessionId: 'alice', operationId: 'op-1', binding: binding() }
  assert.deepEqual(lookupOperation(store.snapshot().state, query), prepared())
  assert.equal(lookupOperation(store.snapshot().state, { ...query, sessionId: 'bob' }), null)
  const changes = [
    b => { b.filePath = './nested/new.txt' }, b => { b.cwd = '/elsewhere' },
    b => { b.tool = 'hash_edit' }, b => { b.requestDigest = 'b'.repeat(64) },
    b => { b.argsDigest = 'b'.repeat(64) }, b => { b.payloadDigest = 'b'.repeat(64) },
    b => { b.target.ancestor = '/other' }, b => { b.target.suffix = 'other.txt' },
    b => { b.target.policy.kind = 'replaceIfVersion' },
    b => { b.target = { kind: 'update', resourceId: '/workspace/new.txt', generation: 1, policy: { kind: 'replaceIfVersion', version: 'v1' } } },
  ]
  for (const change of changes) {
    const altered = binding(); change(altered)
    assert.throws(() => lookupOperation(state, { ...query, binding: altered }), /ID_REUSE/)
    const next = structuredClone(state); next.operations[0].binding = altered
    await assert.rejects(record(store, next))
  }
  const removed = structuredClone(state); removed.operations = []
  await assert.rejects(record(store, removed), /history/)
  const origin = structuredClone(state); origin.operations[0].origin.executionEpoch = 8
  await assert.rejects(record(store, origin), /origin/)
  const detached = lookupOperation(state, query); detached.origin.executionEpoch = 99
  assert.equal(lookupOperation(state, query).origin.executionEpoch, 1)
  await store.close()
})

const createFence = () => ({ kind: 'subtree', ancestor: '/workspace', basis: 'observed-ancestor' })
function publishing(state) {
  const next = structuredClone(state)
  next.operations[0].phase = 'publishing'
  next.operations[0].fence = createFence()
  return next
}
function created(state) {
  const next = structuredClone(state)
  const outcome = { kind: 'created', resourceId: '/workspace/nested/new.txt', generation: 1, version: 'v2' }
  Object.assign(next.operations[0], { phase: 'created', outcome })
  next.generations = [{ resourceId: outcome.resourceId, generation: 1 }]
  next.locks = [{ resourceId: outcome.resourceId, owner: 'alice', generation: 1, status: 'active' }]
  return next
}

test('raw records enforce durable publishing then atomic ownership/outcome, surviving later release', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const state = image(); state.operations.push(prepared())
  await record(store, state)
  await assert.rejects(record(store, created(publishing(state))))
  const started = publishing(state)
  await record(store, started)
  await store.close()
  const reopened = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.equal(reopened.snapshot().state.operations[0].phase, 'publishing')
  for (const alter of [
    s => { s.locks = [] }, s => { s.locks[0].generation = 2 },
    s => { s.operations[0].outcome.version = null }, s => { s.operations[0].outcome.extra = 'receipt' },
    s => { s.operations[0].fence = null },
  ]) {
    const invalid = created(started); alter(invalid)
    await assert.rejects(record(reopened, invalid))
  }
  const success = created(started)
  await record(reopened, success)
  const released = structuredClone(success); released.locks = []
  released.sessions[0].executionEpoch = 4; released.managerIncarnation = 'manager-2'
  await record(reopened, released)
  for (const alter of [
    s => { s.operations[0].outcome.version = 'v3' },
    s => { s.operations[0].phase = 'prepared'; s.operations[0].outcome = null; s.operations[0].fence = null },
    s => { s.operations = [] },
  ]) {
    const invalid = structuredClone(released); alter(invalid)
    await assert.rejects(record(reopened, invalid))
  }
  await reopened.close()
  const final = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.deepEqual(final.snapshot().state.operations, success.operations)
  assert.deepEqual(final.snapshot().state.locks, [])
  await final.close()
})

test('only undispatched preparation can become not-published; unknown closeout appends without clearing fence', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const state = image(); state.operations.push(prepared())
  await record(store, state)
  const cancelled = structuredClone(state)
  Object.assign(cancelled.operations[0], { phase: 'not-published', outcome: { kind: 'not-published', reason: 'cancelled-before-dispatch' } })
  await record(store, cancelled)
  await assert.rejects(record(store, state))
  const second = structuredClone(cancelled); second.operations.push({ ...prepared(), operationId: 'op-2' })
  await record(store, second)
  const started = structuredClone(second)
  Object.assign(started.operations[1], { phase: 'publishing', fence: createFence() })
  await record(store, started)
  const falseNegative = structuredClone(started)
  Object.assign(falseNegative.operations[1], { phase: 'not-published', fence: null, outcome: { kind: 'not-published', reason: 'cancelled-before-dispatch' } })
  await assert.rejects(record(store, falseNegative))
  const unknown = structuredClone(started)
  Object.assign(unknown.operations[1], { phase: 'unknown', outcome: { kind: 'unknown' } })
  await record(store, unknown)
  const closed = structuredClone(unknown)
  closed.operations[1].closeouts.push({ kind: 'abandoned-unknown', assertionId: 'historical-review-1' })
  await record(store, closed)
  for (const alter of [
    s => { s.operations[1].closeouts = [] },
    s => { s.operations[1].closeouts[0].assertionId = 'rewrite' },
    s => { s.operations[1].fence = null },
    s => { s.operations[1].outcome = { kind: 'not-published', reason: 'cancelled-before-dispatch' }; s.operations[1].phase = 'not-published' },
    s => { s.operations[1].closeouts.push({ kind: 'abandoned-unknown', publisherDead: true, humanApproved: true }) },
  ]) {
    const invalid = structuredClone(closed); alter(invalid)
    await assert.rejects(record(store, invalid))
  }
  await store.close()
  const reopened = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  assert.deepEqual(reopened.snapshot().state.operations, closed.operations)
  await reopened.close()
})

function updateImage() {
  const state = image()
  state.generations = [{ resourceId: '/workspace/existing.txt', generation: 1 }]
  state.locks = [{ resourceId: '/workspace/existing.txt', owner: 'alice', generation: 1, status: 'active' }]
  const op = prepared()
  op.binding.tool = 'hash_edit'
  op.binding.target = { kind: 'update', resourceId: '/workspace/existing.txt', generation: 1, policy: { kind: 'replaceIfVersion', version: 'v1' } }
  state.operations.push(op)
  return state
}

test('unresolved update ownership cannot be released, transferred or re-generated even after closeout', async t => {
  const store = await openEditLockStore({ directory: await fixture(t), domainId: 'd', mode: 'create' })
  const state = updateImage(); await record(store, state)
  state.operations[0].phase = 'publishing'
  state.operations[0].fence = { kind: 'resource', resourceId: '/workspace/existing.txt' }
  await record(store, state)
  for (const phase of ['publishing', 'unknown']) {
    if (phase === 'unknown') {
      Object.assign(state.operations[0], { phase, outcome: { kind: 'unknown' }, closeouts: [{ kind: 'abandoned-unknown', assertionId: 'historical-1' }] })
      await record(store, state)
    }
    for (const alter of [
      s => { s.locks = [] },
      s => { s.generations[0].generation = 2; s.locks[0].generation = 2 },
      s => { addSession(s, 'bob'); s.locks[0].owner = 'bob'; s.locks[0].generation = 2; s.generations[0].generation = 2 },
    ]) {
      const invalid = structuredClone(state); alter(invalid)
      await assert.rejects(record(store, invalid), /retained/)
    }
    state.managerIncarnation = 'manager-2'; state.sessions[0].executionEpoch++
    await record(store, state)
  }
  await store.close()
})

test('late success retains cancellation classification and never rearms the session', async t => {
  for (const channel of ['create', 'update']) {
    const directory = await fixture(t)
    const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
    let state = channel === 'create' ? image() : updateImage()
    if (channel === 'create') state.operations.push(prepared())
    await record(store, state)
    state = publishing(state)
    if (channel === 'update') state.operations[0].fence = { kind: 'resource', resourceId: '/workspace/existing.txt' }
    await record(store, state)
    state.sessions[0] = { sessionId: 'alice', executionEpoch: 2, interrupted: true }
    if (channel === 'update') Object.assign(state.locks[0], { status: 'abnormal', reason: 'publication unresolved' })
    await record(store, state)
    const success = channel === 'create' ? created(state) : structuredClone(state)
    if (channel === 'update') Object.assign(success.operations[0], { phase: 'updated', outcome: { kind: 'updated', resourceId: '/workspace/existing.txt', generation: 1, version: 'v2' } })
    success.locks[0].status = channel === 'create' ? 'user-interrupted' : 'abnormal'
    const rearmed = structuredClone(success)
    rearmed.sessions[0] = { sessionId: 'alice', executionEpoch: 3, interrupted: false }
    rearmed.locks[0].status = 'active'; delete rearmed.locks[0].reason
    await assert.rejects(record(store, rearmed), /rearm|classification/)
    await record(store, success)
    assert.equal(store.snapshot().state.sessions[0].interrupted, true)
    assert.equal(store.snapshot().state.sessions[0].executionEpoch, 2)
    await store.close()
  }
})

// TEST ONLY: faithful ordering with real files, not ctx.fs/manager integration.
// Each child owns its dedicated tree; no concurrent outsiders or alias claims.
async function publisherDriver({ directory, root, channel, stop, retry = false }) {
  const fs = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { createHash } = await import('node:crypto')
  const { openEditLockStore } = await import('../src/edit-lock/store.js')
  const { lookupOperation } = await import('../src/edit-lock/operation-history.js')
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const barrier = point => {
    if (point === stop) process.kill(process.pid, 'SIGKILL')
  }
  let committingOutcome = false
  const store = await openEditLockStore({ directory, domainId: 'driver', mode: 'recover' }, {
    checkpoint(point) { if (committingOutcome && point === 'after:rename') barrier('outcome-renamed') },
  })
  const path = join(root, 'nested', 'target.txt')
  const payload = 'published bytes\n'
  const args = channel === 'create' ? { filePath: 'nested/target.txt', content: payload } : { filePath: 'nested/target.txt', old: 'original\n', replacement: payload }
  const target = channel === 'create'
    ? { kind: 'create', ancestor: root, suffix: 'nested/target.txt', policy: { kind: 'createIfAbsent' } }
    : { kind: 'update', resourceId: path, generation: 1, policy: { kind: 'replaceIfVersion', version: sha('original\n') } }
  const binding = { tool: channel === 'create' ? 'write' : 'hash_edit', filePath: args.filePath, cwd: root,
    requestDigest: sha(JSON.stringify([channel, args, target])), argsDigest: sha(JSON.stringify(args)), payloadDigest: sha(payload), target }
  const query = { sessionId: 'alice', operationId: 'driver-op', binding }
  const historical = lookupOperation(store.snapshot().state, query)
  if (historical) {
    if (!retry) throw new Error('unexpected existing history')
    process.stdout.write(JSON.stringify(historical))
    await store.close(); return
  }
  if (retry) throw new Error('missing history')
  let state = store.snapshot().state
  const save = async () => { await store.record({ expectedRevision: store.snapshot().revision, nextState: state }) }
  state.operations.push({ ...query, origin: { executionEpoch: 1, managerIncarnation: 'manager-1' }, phase: 'prepared', fence: null, outcome: null, closeouts: [] })
  await save()
  barrier('prepared')
  const op = state.operations[0]
  op.phase = 'publishing'
  op.fence = channel === 'create' ? { kind: 'subtree', ancestor: root, basis: 'observed-ancestor' } : { kind: 'resource', resourceId: path }
  await save()
  barrier('publishing')
  if (channel === 'create') {
    // A preexisting node conflicts BEFORE directory materialization.
    try { await fs.lstat(path); throw new Error('target exists') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await fs.mkdir(dirname(path), { recursive: true })
    barrier('directories')
    const file = await fs.open(path, 'wx')
    try { await file.writeFile(payload); await file.sync() } finally { await file.close() }
  } else {
    if (sha(await fs.readFile(path)) !== target.policy.version) throw new Error('version conflict')
    const file = await fs.open(path, 'r+')
    try { await file.writeFile(payload); await file.truncate(Buffer.byteLength(payload)); await file.sync() } finally { await file.close() }
  }
  const dir = await fs.open(dirname(path), 'r')
  try { await dir.sync() } finally { await dir.close() }
  barrier('published')
  const resourceId = await fs.realpath(path)
  op.phase = channel === 'create' ? 'created' : 'updated'
  op.outcome = { kind: op.phase, resourceId, generation: 1, version: sha(await fs.readFile(path)) }
  if (channel === 'create') {
    state.generations.push({ resourceId, generation: 1 })
    state.locks.push({ resourceId, owner: 'alice', generation: 1, status: 'active' })
  }
  committingOutcome = true
  await save()
  barrier('outcome')
  await store.close()
}

function runDriver(options) {
  // Resolve relative imports from this test's directory, not the repository root.
  const script = `(${publisherDriver.toString()})(${JSON.stringify(options)}).catch(e => { console.error(e); process.exitCode = 1 })`
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: dirname(new URL(import.meta.url).pathname), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b })
    child.stderr.on('data', b => { stderr += b })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }))
  })
}

for (const channel of ['create', 'update']) {
  for (const stop of ['prepared', 'publishing', ...(channel === 'create' ? ['directories'] : []), 'published', 'outcome-renamed', 'outcome']) {
    test(`real ${channel} publication SIGKILL at ${stop} recovers history without replay`, async t => {
      const root = await fixture(t), directory = join(root, 'history'), targetRoot = join(root, 'targets')
      await mkdir(directory); await mkdir(targetRoot)
      const target = join(targetRoot, 'nested', 'target.txt')
      const state = image()
      if (channel === 'update') {
        await mkdir(dirname(target)); await writeFile(target, 'original\n')
        state.generations.push({ resourceId: target, generation: 1 })
        state.locks.push({ resourceId: target, owner: 'alice', generation: 1, status: 'active' })
      }
      const store = await openEditLockStore({ directory, domainId: 'driver', mode: 'create' })
      await record(store, state); await store.close()
      const options = { directory, root: targetRoot, channel, stop }
      const killed = await runDriver(options)
      assert.equal(killed.signal, 'SIGKILL', killed.stderr)
      const recovered = await openEditLockStore({ directory, domainId: 'driver', mode: 'recover' })
      const op = recovered.snapshot().state.operations[0]
      const completed = ['outcome-renamed', 'outcome'].includes(stop)
      assert.equal(op.phase, completed ? (channel === 'create' ? 'created' : 'updated') : stop === 'prepared' ? 'prepared' : 'publishing')
      assert.equal(op.fence === null, stop === 'prepared')
      const hasBytes = ['published', 'outcome-renamed', 'outcome'].includes(stop)
      if (hasBytes || channel === 'update') assert.equal(await readFile(target, 'utf8'), hasBytes ? 'published bytes\n' : 'original\n')
      else await assert.rejects(lstat(target), { code: 'ENOENT' })
      if (channel === 'create' && ['prepared', 'publishing'].includes(stop)) await assert.rejects(lstat(dirname(target)), { code: 'ENOENT' })
      assert.equal(recovered.snapshot().state.locks.length, completed || channel === 'update' ? 1 : 0)
      await recovered.close()
      // Remove any chance of byte-equality inference: a later outsider change is
      // returned as original history, not overwritten or treated as new success.
      if (hasBytes) await writeFile(target, 'later independent bytes\n')
      const snapshotBytes = await readFile(join(directory, 'snapshot.json'))
      const retry = await runDriver({ ...options, stop: null, retry: true })
      assert.equal(retry.code, 0, retry.stderr)
      assert.deepEqual(JSON.parse(retry.stdout), op)
      assert.deepEqual(await readFile(join(directory, 'snapshot.json')), snapshotBytes)
      if (hasBytes) assert.equal(await readFile(target, 'utf8'), 'later independent bytes\n')
    })
  }
}

test('created outcome cannot adopt existing ownership or escape its recorded subtree', async t => {
  const store = await openEditLockStore({ directory: await fixture(t), domainId: 'd', mode: 'create' })
  const state = image(); state.operations.push(prepared())
  state.generations = [{ resourceId: '/workspace/nested/new.txt', generation: 1 }]
  state.locks = [{ resourceId: '/workspace/nested/new.txt', owner: 'alice', generation: 1, status: 'active' }]
  await record(store, state)
  const started = publishing(state); await record(store, started)
  await assert.rejects(record(store, created(started)), /new ownership/)
  const escaped = created(started)
  escaped.operations[0].outcome.resourceId = '/elsewhere/new.txt'
  escaped.generations.push({ resourceId: '/elsewhere/new.txt', generation: 1 })
  escaped.locks = [{ resourceId: '/elsewhere/new.txt', owner: 'alice', generation: 1, status: 'active' }]
  await assert.rejects(record(store, escaped), /containment/)
  await store.close()
})

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}

test('closed operation schema rejects malformed raw input and checksum-valid malformed recovery without writes', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  const state = image(); state.operations.push(prepared()); await record(store, state)
  const file = join(directory, 'snapshot.json'), original = await readFile(file)
  const malformed = [
    s => { s.operations[0].binding.extra = true },
    s => { s.operations[0].origin.extra = true },
    s => { s.operations[0].binding.requestDigest = 'not-a-digest' },
    s => { s.operations[0].binding.cwd = 'relative' },
    s => { s.operations[0].binding.target.resourceId = '/invented' },
    s => { s.operations[0].binding.target.suffix = '../escape' },
    s => { s.operations[0].binding.target.policy.extra = true },
    s => { s.operations[0].binding.tool = 'hash_edit' },
    s => { s.operations[0].phase = 'success' },
    s => { s.operations[0].outcome = { kind: 'created' } },
    s => { s.operations.push(structuredClone(s.operations[0])) },
    s => { s.operations[0].phase = 'publishing'; s.operations[0].fence = { kind: 'subtree', ancestor: '/other', basis: 'observed-ancestor' } },
    s => { s.operations[0].phase = 'publishing'; s.operations[0].fence = { ...createFence(), expiresAt: 1 } },
  ]
  for (const alter of malformed) {
    const invalid = structuredClone(state); alter(invalid)
    await assert.rejects(record(store, invalid))
    assert.deepEqual(await readFile(file), original)
  }
  await store.close()
  for (const alter of malformed) {
    const payload = JSON.parse(original).payload; alter(payload.state)
    const bytes = canonical({ payload, checksum: createHash('sha256').update(canonical(payload)).digest('hex') })
    await writeFile(file, bytes)
    await assert.rejects(openEditLockStore({ directory, domainId: 'd', mode: 'recover' }))
    assert.equal(await readFile(file, 'utf8'), bytes)
  }
})

test('same payload from different original edit arguments is ID_REUSE, not a duplicate', async t => {
  const state = updateImage(), store = await openEditLockStore({ directory: await fixture(t), domainId: 'd', mode: 'create' })
  await record(store, state)
  const query = structuredClone(state.operations[0])
  query.binding.argsDigest = createHash('sha256').update('different anchors; same resulting bytes').digest('hex')
  assert.equal(query.binding.payloadDigest, state.operations[0].binding.payloadDigest)
  assert.throws(() => lookupOperation(store.snapshot().state, query), /ID_REUSE/)
  for (const change of [b => { b.target.generation = 2 }, b => { b.target.policy.version = 'v2' }, b => { b.target.resourceId = '/other' }]) {
    const changed = structuredClone(state.operations[0]); change(changed.binding)
    assert.throws(() => lookupOperation(store.snapshot().state, changed), /ID_REUSE/)
  }
  await store.close()
})

test('historical fence assertions are scoped, immutable and have no expiry or runtime clearing seam', async t => {
  for (const fence of [createFence(), { kind: 'subtree', ancestor: '/', basis: 'conservative-ancestor' }, { kind: 'domain', basis: 'containment-unproved' }]) {
    const directory = await fixture(t), store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
    let state = image(); state.operations.push(prepared()); await record(store, state)
    state = publishing(state); state.operations[0].fence = fence; await record(store, state)
    Object.assign(state.operations[0], { phase: 'unknown', outcome: { kind: 'unknown' } }); await record(store, state)
    state.sessions[0].executionEpoch++; state.managerIncarnation = 'manager-2'
    state.operations.push({ ...prepared(), operationId: 'new-id', origin: { executionEpoch: 2, managerIncarnation: 'manager-2' } })
    await record(store, state)
    assert.deepEqual(store.snapshot().state.operations[0].fence, fence)
    assert.equal(store.clearFence, undefined)
    await store.close()
  }
})

for (const checkpoint of ['before:rename', 'after:rename', 'after:directory-sync']) {
  test(`outcome snapshot IO failure at ${checkpoint} is not target failure or rollback`, async t => {
    const directory = await fixture(t), targetRoot = await fixture(t)
    let fail = false
    const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' }, { checkpoint(point) { if (fail && point === checkpoint) throw new Error('injected IO boundary') } })
    let state = image(); const op = prepared()
    op.binding.cwd = targetRoot; op.binding.target.ancestor = targetRoot
    state.operations.push(op); await record(store, state)
    state = publishing(state); state.operations[0].fence.ancestor = targetRoot; await record(store, state)
    const target = join(targetRoot, 'nested', 'new.txt')
    await mkdir(dirname(target)); await writeFile(target, 'published', { flag: 'wx' })
    state = created(state)
    state.operations[0].outcome.resourceId = target; state.locks[0].resourceId = target; state.generations[0].resourceId = target
    fail = true
    await assert.rejects(record(store, state), { code: 'EDIT_LOCK_STORE_PERSISTENCE', commitStatus: checkpoint === 'before:rename' ? 'not-renamed' : 'uncertain' })
    assert.throws(() => store.snapshot(), /poisoned/)
    await store.close()
    assert.equal(await readFile(target, 'utf8'), 'published')
    const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
    assert.equal(recovered.snapshot().state.operations[0].phase, checkpoint === 'before:rename' ? 'publishing' : 'created')
    await recovered.close()
  })
}

test('real target failure after dispatch leaves publishing fenced, never not-published', async t => {
  const root = await fixture(t), directory = join(root, 'history'), targetRoot = join(root, 'targets')
  await mkdir(directory); await mkdir(targetRoot); await mkdir(join(targetRoot, 'nested'))
  const target = join(targetRoot, 'nested', 'target.txt'); await writeFile(target, 'preexisting')
  const store = await openEditLockStore({ directory, domainId: 'driver', mode: 'create' })
  await record(store, image()); await store.close()
  const failed = await runDriver({ directory, root: targetRoot, channel: 'create', stop: null })
  assert.equal(failed.code, 1); assert.match(failed.stderr, /target exists/)
  assert.equal(await readFile(target, 'utf8'), 'preexisting')
  const recovered = await openEditLockStore({ directory, domainId: 'driver', mode: 'recover' })
  assert.equal(recovered.snapshot().state.operations[0].phase, 'publishing')
  assert.deepEqual(recovered.snapshot().state.locks, [])
  await recovered.close()
})

test('cancellation and unknown settlement cannot rearm an interrupted execution', async t => {
  for (const phase of ['not-published', 'unknown']) {
    const store = await openEditLockStore({ directory: await fixture(t), domainId: 'd', mode: 'create' })
    let state = image(); state.operations.push(prepared()); await record(store, state)
    if (phase === 'unknown') { state = publishing(state); await record(store, state) }
    state.sessions[0] = { sessionId: 'alice', executionEpoch: 2, interrupted: true }; await record(store, state)
    const settled = structuredClone(state)
    settled.operations[0].phase = phase
    settled.operations[0].outcome = phase === 'unknown' ? { kind: 'unknown' } : { kind: 'not-published', reason: 'cancelled-before-dispatch' }
    const rearmed = structuredClone(settled)
    rearmed.sessions[0] = { sessionId: 'alice', executionEpoch: 3, interrupted: false }
    await assert.rejects(record(store, rearmed), /rearm/)
    await record(store, settled)
    await store.close()
  }
})


test('raw batch cannot credit two created outcomes to one new resource ownership', async t => {
  const directory = await fixture(t), targetRoot = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  t.after(() => store.close())
  const state = image()
  for (const operationId of ['first', 'second']) {
    const op = { ...prepared(), operationId }
    op.binding.cwd = targetRoot
    op.binding.target.ancestor = targetRoot
    state.operations.push(op)
  }
  await record(store, state)
  for (const op of state.operations) Object.assign(op, { phase: 'publishing', fence: { ...createFence(), ancestor: targetRoot } })
  await record(store, state)
  const before = store.snapshot(), file = join(directory, 'snapshot.json')
  const bytes = await readFile(file)
  const target = join(targetRoot, 'nested', 'new.txt')
  await mkdir(dirname(target))
  await writeFile(target, 'one creation', { flag: 'wx' })
  await assert.rejects(writeFile(target, 'one creation', { flag: 'wx' }), { code: 'EEXIST' })
  const resourceId = await realpath(target)
  // Historical fixture assertions, not authenticated publisher receipts.
  for (const op of state.operations) Object.assign(op, {
    phase: 'created', outcome: { kind: 'created', resourceId, generation: 1, version: 'v1' },
  })
  state.generations.push({ resourceId, generation: 1 })
  state.locks.push({ resourceId, generation: 1, owner: 'alice', status: 'active' })
  await assert.rejects(record(store, state), /created resource attribution/)
  assert.deepEqual(store.snapshot(), before)
  assert.deepEqual(await readFile(file), bytes)
  assert.equal(await readFile(target, 'utf8'), 'one creation')
  await store.close()
  const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  t.after(() => recovered.close())
  assert.deepEqual(recovered.snapshot(), before)
})


test('distinct created resources can settle together and old successes survive release and recreation', async t => {
  const directory = await fixture(t)
  const store = await openEditLockStore({ directory, domainId: 'd', mode: 'create' })
  t.after(() => store.close())
  const state = image()
  for (const name of ['first', 'second']) {
    const op = { ...prepared(), operationId: name }
    op.binding.filePath = op.binding.target.suffix = `${name}.txt`
    state.operations.push(op)
  }
  await record(store, state)
  for (const op of state.operations) Object.assign(op, { phase: 'publishing', fence: createFence() })
  await record(store, state)
  for (const op of state.operations) {
    const resourceId = `/workspace/${op.operationId}.txt`
    Object.assign(op, { phase: 'created', outcome: { kind: 'created', resourceId, generation: 1, version: 'v1' } })
    state.generations.push({ resourceId, generation: 1 })
    state.locks.push({ resourceId, generation: 1, owner: 'alice', status: 'active' })
  }
  await record(store, state)
  const history = structuredClone(state.operations)
  state.locks = []
  await record(store, state)
  addSession(state, 'bob')
  const recreated = { ...prepared(), sessionId: 'bob', operationId: 'recreated', binding: structuredClone(history[0].binding) }
  state.operations.push(recreated)
  await record(store, state)
  Object.assign(recreated, { phase: 'publishing', fence: createFence() })
  await record(store, state)
  const resourceId = '/workspace/first.txt'
  Object.assign(recreated, { phase: 'created', outcome: { kind: 'created', resourceId, generation: 2, version: 'v2' } })
  state.generations[0].generation = 2
  state.locks.push({ resourceId, generation: 2, owner: 'bob', status: 'active' })
  await record(store, state)
  await store.close()
  const recovered = await openEditLockStore({ directory, domainId: 'd', mode: 'recover' })
  t.after(() => recovered.close())
  assert.deepEqual(recovered.snapshot().state, state)
  assert.deepEqual(recovered.snapshot().state.operations.slice(0, 2), history)
})


for (const channel of ['create', 'update']) {
  for (const corruption of ['missing tombstone', 'future outcome generation']) {
    test(`recovery rejects ${channel} success with ${corruption} without rewriting bytes`, async t => {
      const directory = await fixture(t)
      const options = { directory, domainId: 'd', mode: 'recover' }
      const store = await openEditLockStore({ ...options, mode: 'create' })
      t.after(() => store.close())
      let state = channel === 'create' ? image() : updateImage()
      if (channel === 'create') state.operations.push(prepared())
      await record(store, state)
      state = publishing(state)
      if (channel === 'update') state.operations[0].fence = { kind: 'resource', resourceId: '/workspace/existing.txt' }
      await record(store, state)
      if (channel === 'create') state = created(state)
      else Object.assign(state.operations[0], { phase: 'updated', outcome: { kind: 'updated', resourceId: '/workspace/existing.txt', generation: 1, version: 'v2' } })
      await record(store, state)
      const history = structuredClone(state.operations)
      state.locks = []
      await record(store, state)
      await store.close()
      const released = await openEditLockStore(options)
      t.after(() => released.close())
      assert.deepEqual(released.snapshot().state.operations, history)
      assert.deepEqual(released.snapshot().state.locks, [])
      // A later owner/generation must not invalidate historical success.
      addSession(state, 'bob')
      state.generations[0].generation = 2
      state.locks.push({ resourceId: history[0].outcome.resourceId, generation: 2, owner: 'bob', status: 'active' })
      await record(released, state)
      await released.close()
      const reowned = await openEditLockStore(options)
      t.after(() => reowned.close())
      assert.deepEqual(reowned.snapshot().state.operations, history)
      state.locks = []
      await record(reowned, state)
      await reowned.close()
      const file = join(directory, 'snapshot.json')
      const payload = JSON.parse(await readFile(file, 'utf8')).payload
      if (corruption === 'missing tombstone') payload.state.generations = []
      else {
        payload.state.operations[0].outcome.generation = 99
        // Keep update binding consistent, so only the lifetime reference is bad.
        if (channel === 'update') payload.state.operations[0].binding.target.generation = 99
      }
      const bytes = canonical({ payload, checksum: createHash('sha256').update(canonical(payload)).digest('hex') })
      await writeFile(file, bytes)
      await assert.rejects(async () => {
        const unexpected = await openEditLockStore(options)
        await unexpected.close()
      }, /success generation history/)
      assert.equal(await readFile(file, 'utf8'), bytes)
    })
  }
}
