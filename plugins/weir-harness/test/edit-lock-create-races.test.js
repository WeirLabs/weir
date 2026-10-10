import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { createPublisher } from '../src/edit-lock/publisher.js'
import { createResourceIdentity } from '../src/edit-lock/resource-identity.js'

const version = bytes => createHash('sha256').update(bytes).digest('hex')

function barrier() {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  return { entered: entered.promise, release: () => gate.resolve(),
    async wait() { entered.resolve(); await gate.promise } }
}

// Component tests: the real publisher, FIFO manager and durable store, with a
// real-file host FS adapter. This is not installed-runtime/dual-GUI evidence.
async function fixture(t, { beforeWrite, afterWrite, checkpoint } = {}) {
  const parent = realpathSync.native(tmpdir())
  const root = await mkdtemp(join(parent, 'weir-create-races-'))
  const original = await lstat(root)
  const directory = join(root, '.authority')
  await mkdir(directory)
  const store = await openEditLockStore({ directory, domainId: 'creation-races', mode: 'create' }, { checkpoint })
  const manager = createEditLockManager({ store, managerIncarnation: 'creation-manager' })
  const calls = []
  const publisher = createPublisher({ manager, root, excluded: [directory], fs: {
    resolve: async (path, { cwd }) => ({ path: resolve(cwd, path) }),
    async writeText(target, content, guard, signal) {
      calls.push({ path: target.path, content, guard })
      await beforeWrite?.()
      signal.throwIfAborted()
      if (guard.kind === 'createIfAbsent') {
        await mkdir(dirname(target.path), { recursive: true })
        await writeFile(target.path, content, { flag: 'wx' })
      } else {
        assert.equal(guard.kind, 'replaceIfVersion')
        assert.equal(version(await readFile(target.path)), guard.version, 'original version guard')
        await writeFile(target.path, content)
      }
      await afterWrite?.()
      return { version: version(content) }
    },
  } })
  // One ordered teardown: never remove the authority tree before draining it.
  t.after(async () => {
    await manager.drain()
    await manager.close()
    await store.close()
    assert.equal(realpathSync.native(root), root)
    assert.equal(dirname(root), parent)
    const current = await lstat(root)
    assert.equal(current.dev, original.dev)
    assert.equal(current.ino, original.ino)
    await rm(root, { recursive: true })
  })
  const alice = await manager.openSession('alice'), bob = await manager.openSession('bob')
  const request = (operationId, filePath = 'target', content = 'creator bytes\n') => ({
    operationId, tool: 'write', filePath, cwd: root, args: { filePath, content }, content,
    expected: { kind: 'createIfAbsent' }, effectivePolicy: { mode: 'workspace-write', workspaceRoot: root },
  })
  const prepare = (execution, input) => publisher.prepare(execution, input, new AbortController().signal)
  const disk = () => readFile(join(directory, 'snapshot.json'))
  return { root, store, manager, publisher, calls, alice, bob, request, prepare, disk }
}

async function raceCreators(t, spellings, first = 'alice', semantics = null) {
  const gate = barrier()
  const f = await fixture(t, { beforeWrite: () => gate.wait() })
  try {
    if (semantics) {
      const probe = join(f.root, 'volume-probe')
      await mkdir(probe)
      await writeFile(join(probe, spellings[0]), 'probe', { flag: 'wx' })
      const stored = await lstat(join(probe, spellings[0]))
      let alias
      try { alias = await lstat(join(probe, spellings[1])) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (!alias || alias.dev !== stored.dev || alias.ino !== stored.ino) {
        t.skip(`fixture volume does not provide ${semantics} alias semantics`)
        return
      }
      t.diagnostic(`fixture volume confirms ${semantics} aliases share dev/ino`)
    }
    const identity = createResourceIdentity()
    const absent = spellings.map(path => identity.resolve(path, { cwd: f.root }))
    for (const observation of absent) {
      assert.equal(observation.kind, 'missing')
      assert.equal(observation.ancestor, f.root)
      assert.equal(Object.hasOwn(observation, 'resourceId'), false, 'missing spellings are not lock keys')
    }
    const [a, b] = await Promise.all([
      f.prepare(f.alice, f.request('alice-create', spellings[0], 'alice bytes\n')),
      f.prepare(f.bob, f.request('bob-create', spellings[1], 'bob bytes\n')),
    ])
    assert.equal(a.kind, 'ready'); assert.equal(b.kind, 'ready')
    assert.deepEqual(f.store.snapshot().state.locks, [])
    assert.deepEqual(f.store.snapshot().state.generations, [])
    const winner = first === 'alice' ? a : b, loser = first === 'alice' ? b : a
    const winning = f.publisher.commit(winner.submission)
    const losing = assert.rejects(f.publisher.commit(loser.submission), /topology changed/)
    await gate.entered
    // Both commits are outstanding while the first native call is suspended.
    assert.equal(f.calls.length, 1)
    assert.equal(f.manager.history(first, `${first}-create`).phase, 'publishing')
    const other = first === 'alice' ? 'bob' : 'alice'
    assert.equal(f.manager.history(other, `${other}-create`).phase, 'prepared')
    assert.deepEqual(f.store.snapshot().state.generations, [])
    await assert.rejects(lstat(join(f.root, spellings[0])), { code: 'ENOENT' })
    gate.release()
    const created = await winning
    await losing
    const resourceId = realpathSync.native(join(f.root, spellings[0]))
    assert.equal(created.phase, 'created')
    assert.deepEqual(created.outcome, { kind: 'created', resourceId, generation: 1, version: version(`${first} bytes\n`) })
    assert.deepEqual(f.store.snapshot().state.generations, [{ resourceId, generation: 1 }])
    assert.deepEqual(f.manager.status().locks, [{ resourceId, owner: first, generation: 1, status: 'active' }])
    const rejected = f.manager.history(other, `${other}-create`)
    assert.equal(rejected.phase, 'not-published')
    assert.deepEqual(rejected.outcome, { kind: 'not-published', reason: 'rejected-before-dispatch' })
    assert.equal(rejected.fence, null)
    for (const path of spellings) {
      assert.equal(await readFile(join(f.root, path), 'utf8'), `${first} bytes\n`)
      assert.equal(identity.resolve(path, { cwd: f.root }).resourceId, resourceId)
    }
    for (const observation of absent) assert.throws(() => identity.revalidate(observation), /topology changed/)
    assert.equal(f.calls.length, 1, 'loser must never reach the native writer')
    const bytes = await f.disk(), snapshot = f.store.snapshot()
    assert.deepEqual(await f.publisher.commit(loser.submission), rejected)
    assert.deepEqual(await f.publisher.commit(winner.submission), created)
    assert.deepEqual(f.store.snapshot(), snapshot)
    assert.deepEqual(await f.disk(), bytes)
    assert.equal(f.calls.length, 1, 'terminal retries must not replay')
  } finally { gate.release() }
}

for (const first of ['alice', 'bob']) {
  test(`two prepared creators race for one canonical resource: ${first} dispatches first`, { timeout: 10000 }, async t => {
    await raceCreators(t, ['target', './target'], first)
  })
}

for (const [semantics, spellings] of [
  ['case-insensitive', ['CaseTarget', 'casetarget']],
  ['NFC/NFD-equivalent', ['caf\u00e9', 'cafe\u0301']],
]) {
  test(`concurrent creators through ${semantics} aliases cannot obtain two generations`, { timeout: 10000 }, async t => {
    await raceCreators(t, spellings, 'alice', semantics)
  })
}

test('old creator release cannot remove a contender generation or replay its creation', { timeout: 10000 }, async t => {
  const gate = barrier()
  let releasing = false
  const f = await fixture(t, { checkpoint: point => {
    if (releasing && point === 'before:rename') { releasing = false; return gate.wait() }
  } })
  try {
    const input = f.request('original-create')
    const ready = await f.prepare(f.alice, input)
    const created = await f.publisher.commit(ready.submission)
    const { resourceId, generation } = created.outcome
    assert.equal(generation, 1)
    const old = { ...f.alice, resourceId, generation }
    const observed = f.publisher.releaseResource('target', f.root)
    releasing = true
    const release = f.publisher.release(old, observed.observation)
    await gate.entered
    // The release is not durable yet: contender and delayed duplicate release
    // arrive while generation 1 is still installed, not after sequential awaits.
    assert.equal(f.manager.status().locks[0].generation, 1)
    const acquiring = f.manager.acquire(f.bob, f.publisher.resource('./target', f.root))
    const staleRelease = assert.rejects(f.publisher.release(old, observed.observation), /stale ownership/)
    gate.release()
    await release
    const successor = await acquiring
    await staleRelease
    assert.equal(successor.generation, 2)
    assert.deepEqual(f.manager.status().locks, [{ resourceId, owner: 'bob', generation: 2, status: 'active' }])
    assert.deepEqual(f.store.snapshot().state.generations, [{ resourceId, generation: 2 }])
    assert.equal(await readFile(resourceId, 'utf8'), 'creator bytes\n')
    assert.throws(() => f.manager.checkWrite(old), /stale ownership/)
    assert.deepEqual(f.manager.checkWrite(successor), { allowed: true })

    const snapshot = f.store.snapshot(), bytes = await f.disk()
    await assert.rejects(f.publisher.release(old, observed.observation), /stale ownership/)
    const history = await f.prepare(f.alice, input)
    assert.equal(history.kind, 'history')
    assert.deepEqual(history.operation, created)
    assert.deepEqual(await f.publisher.commit(ready.submission), created)
    assert.deepEqual(f.store.snapshot(), snapshot)
    assert.deepEqual(await f.disk(), bytes)
    assert.equal(f.calls.length, 1)

    const update = { ...f.request('successor-update', 'target', 'successor bytes\n'),
      expected: { kind: 'replaceIfVersion', version: created.outcome.version } }
    const next = await f.prepare(f.bob, update)
    const updated = await f.publisher.commit(next.submission)
    assert.equal(updated.phase, 'updated')
    assert.equal(updated.outcome.generation, 2)
    assert.equal(await readFile(resourceId, 'utf8'), 'successor bytes\n')
    assert.deepEqual(f.manager.history('alice', 'original-create'), created)
    assert.deepEqual(f.store.snapshot().state.generations, [{ resourceId, generation: 2 }])
  } finally { gate.release() }
})

for (const wroteBytes of [false, true]) {
  test(`new operation IDs cannot bypass unknown creation fence (${wroteBytes ? 'bytes published' : 'no bytes'})`, async t => {
    const fail = () => { throw new Error('host completion lost') }
    const f = await fixture(t, wroteBytes ? { afterWrite: fail } : { beforeWrite: fail })
    const input = f.request('uncertain-create')
    const first = await f.prepare(f.alice, input)
    const pending = await f.prepare(f.bob, f.request('prepared-contender'))
    await assert.rejects(f.publisher.commit(first.submission), /host completion lost/)
    const unknown = f.manager.history('alice', input.operationId)
    assert.equal(unknown.phase, 'unknown')
    assert.deepEqual(unknown.outcome, { kind: 'unknown' })
    assert.deepEqual(unknown.fence, { kind: 'subtree', ancestor: f.root, basis: 'observed-ancestor' })
    // A contender prepared before the failure must be re-admitted at commit.
    await assert.rejects(f.publisher.commit(pending.submission), /unresolved publication fence/)
    assert.equal(f.manager.history('bob', 'prepared-contender').phase, 'not-published')
    const snapshot = f.store.snapshot(), bytes = await f.disk()
    for (const execution of [f.alice, f.bob]) {
      const retry = { ...input, operationId: `new-id-${execution.sessionId}` }
      if (wroteBytes) retry.expected = { kind: 'replaceIfVersion', version: version(input.content) }
      await assert.rejects(f.prepare(execution, retry), /unresolved publication fence/)
      await assert.rejects(f.prepare(execution, f.request(`sibling-${execution.sessionId}`, 'sibling')), /unresolved publication fence/)
      assert.equal(f.manager.history(execution.sessionId, retry.operationId), null)
      assert.equal(f.manager.history(execution.sessionId, `sibling-${execution.sessionId}`), null)
    }
    const historical = await f.prepare(f.alice, input)
    assert.equal(historical.kind, 'history')
    assert.deepEqual(historical.operation, unknown)
    assert.deepEqual(await f.publisher.commit(first.submission), unknown)
    assert.deepEqual(f.store.snapshot(), snapshot)
    assert.deepEqual(await f.disk(), bytes)
    assert.deepEqual(snapshot.state.generations, [], 'uncertain bytes grant no generation')
    assert.deepEqual(f.manager.status().locks, [])
    assert.equal(f.calls.length, 1, 'neither new IDs nor historical retries dispatch')
    if (wroteBytes) assert.equal(await readFile(join(f.root, 'target'), 'utf8'), 'creator bytes\n')
    else await assert.rejects(lstat(join(f.root, 'target')), { code: 'ENOENT' })
    await assert.rejects(lstat(join(f.root, 'sibling')), { code: 'ENOENT' })
  })
}

for (const released of [false, true]) {
  test(`createIfAbsent rejects the same owner's ${released ? 'released' : 'still-owned'} existing creation`, async t => {
    const f = await fixture(t)
    const original = f.request('create-once')
    const ready = await f.prepare(f.alice, original)
    const created = await f.publisher.commit(ready.submission)
    const { resourceId, generation } = created.outcome
    assert.equal(generation, 1)
    if (released) {
      const observed = f.publisher.releaseResource('target', f.root)
      await f.publisher.release({ ...f.alice, resourceId, generation }, observed.observation)
    }
    const snapshot = f.store.snapshot(), bytes = await f.disk()
    // Even identical payload bytes and the original creator are not evidence of
    // a new creation. A new ID cannot convert createIfAbsent into an update.
    for (const content of [original.content, 'forbidden replacement\n']) {
      const input = f.request(`fresh-${version(content)}`, './target', content)
      await assert.rejects(f.prepare(f.alice, input), /existing resource requires original version guard/)
      assert.equal(f.manager.history('alice', input.operationId), null)
      assert.equal(await readFile(resourceId, 'utf8'), 'creator bytes\n')
      assert.deepEqual(f.store.snapshot(), snapshot)
      assert.deepEqual(await f.disk(), bytes)
    }
    assert.deepEqual(snapshot.state.generations, [{ resourceId, generation: 1 }])
    assert.deepEqual(f.manager.status().locks, released ? [] : [{ resourceId, owner: 'alice', generation: 1, status: 'active' }])
    const historical = await f.prepare(f.alice, original)
    assert.equal(historical.kind, 'history')
    assert.deepEqual(historical.operation, created)
    assert.deepEqual(f.store.snapshot(), snapshot, 'historical success does not reacquire released ownership')
    assert.deepEqual(await f.disk(), bytes)
    assert.equal(f.calls.length, 1)
  })
}
