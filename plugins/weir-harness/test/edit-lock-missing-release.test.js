import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, symlink, chmod, readFile } from 'node:fs/promises'
import { realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { createEditLockHost } from '../src/edit-lock/host.js'

async function fixture(t) {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'weir-missing-release-')))
  const root = join(base, 'work'), directory = join(base, 'authority')
  await mkdir(root); await mkdir(directory)
  const target = join(root, 'a.txt')
  await writeFile(target, 'a')
  const runtime = await openEditLockRuntime({ root, directory, domainId: root, mode: 'create', assertExclusive() {},
    fs: { async resolve(path) { return path }, async writeText(path, content) { await writeFile(path, content); return { version: 'v2' } } } })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const owner = { id: 'owner' }, other = { id: 'other' }
  await lifecycle.start(owner); await lifecycle.start(other)
  t.after(() => lifecycle.close())
  const request = { filePath: target, cwd: root }
  await lifecycle.service.acquire({ agent: owner }, request)
  return { root, target, runtime, lifecycle, owner, other, request }
}

test('missing-target owner release succeeds; no record and foreign residue explicitly refuse', async t => {
  const { root, target, runtime, lifecycle, owner, other, request } = await fixture(t)
  await rename(target, join(root, 'moved.txt'))
  await assert.rejects(lifecycle.service.release({ agent: other }, request), /lock not owned by this session/)
  assert.equal(runtime.control.status().locks.length, 1)
  await assert.rejects(lifecycle.service.release({ agent: owner }, { filePath: 'absent.txt', cwd: root }), /lock not owned by this session/)
  assert.throws(() => runtime.requests.resource(target, root), /existing regular file/)
  assert.equal((await lifecycle.service.release({ agent: owner }, request)).released, true)
  assert.deepEqual(runtime.control.status().locks, [])
})

test('stopped owner may subtract missing residue without restoring authority', async t => {
  const { root, target, lifecycle, owner, request } = await fixture(t)
  await lifecycle.stop(owner)
  await rename(target, join(root, 'moved.txt'))
  await lifecycle.service.release({ agent: owner }, request)
  assert.equal(lifecycle.status(owner).state, 'stopped')
  assert.deepEqual(lifecycle.status(owner).locks, [])
})

test('missing-target release preserves unresolved publication fence admission', async t => {
  const { root, target, runtime, lifecycle, owner, request } = await fixture(t)
  const status = runtime.control.status()
  const execution = { sessionId: owner.id, executionEpoch: status.sessions.find(s => s.sessionId === owner.id).executionEpoch, managerIncarnation: status.managerIncarnation }
  const lock = status.locks[0]
  const prepared = await runtime.control.prepare(execution, { ...request, operationId: 'uncertain', tool: 'write', args: {}, content: 'b', effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation: lock.generation, policy: { kind: 'replaceIfVersion', version: 'a' } } },
  { validate() {}, async publish() { throw new Error('publication outcome unknown') }, identify() { return target } })
  await assert.rejects(runtime.control.commit(prepared.submission), /publication outcome unknown/)
  await rename(target, join(root, 'moved.txt'))
  await assert.rejects(lifecycle.service.release({ agent: owner }, request), /Edit Lock release refused:.*unresolved/i)
  assert.equal(runtime.control.status().locks.length, 1)
})

test('host release never adopts a newer owner execution epoch', async t => {
  const { root, target, runtime, owner, request } = await fixture(t)
  const status = runtime.control.status()
  const host = createEditLockHost(runtime, agent => agent === owner)
  host.attach(owner, { sessionId: owner.id, executionEpoch: status.sessions.find(s => s.sessionId === owner.id).executionEpoch, managerIncarnation: status.managerIncarnation })
  await rename(target, join(root, 'moved.txt'))
  await runtime.control.cancelSession(owner.id)
  await assert.rejects(host.release({ agent: owner }, request), /release refused:.*changed before execution/)
  assert.equal(runtime.control.status().locks.length, 1)
})

test('missing initially, replacement appears before FIFO probe: refuse and retain lock', async t => {
  const { root, target, runtime, lifecycle, owner, request } = await fixture(t)
  await rename(target, join(root, 'moved.txt'))
  const releasing = lifecycle.service.release({ agent: owner }, request)
  // No await: the observation already ran, but the manager FIFO has not.
  writeFileSync(target, 'replacement')
  await assert.rejects(releasing, /release refused:.*(topology changed|exists again)/)
  assert.equal(runtime.control.status().locks.length, 1)
  assert.equal(await readFile(target, 'utf8'), 'replacement')
})

test('dangling symlink replacement refuses instead of releasing stored literal key', async t => {
  const { root, target, runtime, lifecycle, owner, request } = await fixture(t)
  await rename(target, join(root, 'moved.txt'))
  await symlink(join(root, 'absent'), target)
  await assert.rejects(lifecycle.service.release({ agent: owner }, request))
  assert.equal(runtime.control.status().locks.length, 1)
})

for (const ambiguity of ['symlink', 'non-directory', 'permission']) {
  test(`missing release refuses ${ambiguity} ancestor ambiguity`, async t => {
    const { root, runtime, lifecycle, owner } = await fixture(t)
    const parent = join(root, 'nested'), moved = join(root, 'nested-moved')
    await mkdir(parent)
    const target = join(parent, 'locked.txt'), request = { filePath: target, cwd: root }
    await writeFile(target, 'locked')
    await lifecycle.service.acquire({ agent: owner }, request)
    await rename(target, join(root, 'saved.txt'))
    if (ambiguity === 'permission') {
      if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('requires POSIX permission enforcement')
      await chmod(parent, 0)
      t.after(() => chmod(parent, 0o700))
    } else {
      await rename(parent, moved)
      if (ambiguity === 'symlink') await symlink(moved, parent)
      else await writeFile(parent, 'not a directory')
    }
    await assert.rejects(lifecycle.service.release({ agent: owner }, request))
    assert.ok(runtime.control.status().locks.some(lock => lock.resourceId === target))
  })
}

test('existing release and publish/create retain their ordinary behavior', async t => {
  const { root, target, runtime, lifecycle, owner, request } = await fixture(t)
  await lifecycle.service.release({ agent: owner }, request)
  assert.deepEqual(runtime.control.status().locks, [])
  const publish = (filePath, expected, callId) => lifecycle.service.publish(
    { agent: owner, callId, signal: new AbortController().signal },
    { tool: 'write', filePath, cwd: root, args: {}, content: 'published', expected, effectivePolicy: { mode: 'workspace-write' } })
  await publish(target, { kind: 'replaceIfVersion', version: 'v1' }, 'update')
  assert.equal(await readFile(target, 'utf8'), 'published')
  const created = join(root, 'new.txt')
  await assert.rejects(publish(created, { kind: 'replaceIfVersion', version: 'v1' }, 'bad-create'), /creation requires explicit write intent/)
  await publish(created, { kind: 'createIfAbsent' }, 'create')
  assert.equal(await readFile(created, 'utf8'), 'published')
  assert.ok(runtime.control.status().locks.some(lock => lock.resourceId === created))
})
