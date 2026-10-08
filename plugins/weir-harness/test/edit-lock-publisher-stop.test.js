import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { createPublisher } from '../src/edit-lock/publisher.js'
import { createEditLockHost } from '../src/edit-lock/host.js'

async function fixture(backend) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'publisher-stop-')))
  const directory = join(root, '.authority')
  await mkdir(directory)
  await writeFile(join(root, 'target'), 'before')
  await writeFile(join(root, 'unrelated'), 'before')
  const calls = []
  const runtime = await openEditLockRuntime({ root, directory, domainId: 'test', mode: 'create', assertExclusive() {}, fs: {
    resolve: async path => ({ path }),
    async writeText(...args) {
      calls.push(args)
      await backend?.(...args)
      args[3].throwIfAborted()
      if (args[2].version !== 'v1') throw new Error('stale version')
      await writeFile(args[0].path, args[1])
      return { version: 'v2' }
    },
  } })
  const execution = await runtime.control.openSession('alice')
  const request = (operationId = 'one', name = 'target') => ({ operationId, tool: 'write', filePath: join(root, name), cwd: root,
    args: { content: 'after' }, content: 'after', expected: { kind: 'replaceIfVersion', version: 'v1' },
    effectivePolicy: { mode: 'workspace-write', workspaceRoot: root } })
  return { root, runtime, execution, request, calls }
}

test('Stop joins invoked update with private signal, retains interruption and never replays', async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  const f = await fixture(async () => { entered.resolve(); await gate.promise })
  const controller = new AbortController()
  try {
    const request = f.request()
    const ready = await f.runtime.requests.prepare(f.execution, request, controller.signal)
    const committing = f.runtime.requests.commit(ready.submission)
    await entered.promise
    controller.abort()
    assert.equal(controller.signal.aborted, true)
    const denied = assert.rejects(f.runtime.requests.prepare(f.execution, f.request('followup'), new AbortController().signal), /stale epoch/)
    gate.resolve()
    assert.equal((await committing).phase, 'updated')
    await denied
    await f.runtime.control.drain()
    assert.equal(await readFile(join(f.root, 'target'), 'utf8'), 'after')
    assert.equal(f.runtime.control.status().locks[0].status, 'user-interrupted')
    assert.equal(f.runtime.control.status().sessions[0].interrupted, true)
    assert.equal((await f.runtime.requests.prepare(f.execution, request, controller.signal)).kind, 'history')
    assert.equal((await f.runtime.requests.commit(ready.submission)).phase, 'updated')
    assert.equal(f.calls.length, 1)
    assert.notEqual(f.calls[0][3], controller.signal)
    assert.equal(f.calls[0][3].aborted, false)
    assert.deepEqual(f.calls[0][0], { path: request.filePath })
    assert.equal(f.calls[0][1], request.content)
    assert.deepEqual(f.calls[0][2], request.expected)
    assert.deepEqual(f.calls[0][4], request.effectivePolicy)
  } finally { gate.resolve(); await f.runtime.close() }
})

test('preaborted and prepared-then-stopped updates never dispatch', async () => {
  for (const early of [true, false]) {
    const f = await fixture()
    const controller = new AbortController()
    try {
      if (early) {
        controller.abort()
        await assert.rejects(f.runtime.requests.prepare(f.execution, f.request(), controller.signal), /aborted/)
      } else {
        const ready = await f.runtime.requests.prepare(f.execution, f.request(), controller.signal)
        controller.abort()
        await assert.rejects(f.runtime.requests.commit(ready.submission), /active|cancelled|aborted/)
        assert.equal(f.runtime.control.history('alice', 'one').phase, 'not-published')
      }
      assert.equal(f.calls.length, 0)
      assert.equal(await readFile(join(f.root, 'target'), 'utf8'), 'before')
    } finally { await f.runtime.close() }
  }
})

test('runtime close waits for the stopped invoked backend without timeout', async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  const f = await fixture(async () => { entered.resolve(); await gate.promise })
  const controller = new AbortController()
  const ready = await f.runtime.requests.prepare(f.execution, f.request(), controller.signal)
  const committing = f.runtime.requests.commit(ready.submission)
  await entered.promise
  controller.abort()
  let closed = false
  const closing = f.runtime.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  gate.resolve()
  assert.equal((await committing).phase, 'updated')
  await closing
  assert.equal(closed, true)
})

test('backend rejection remains unknown; another authenticated live session updates unrelated existing file', async () => {
  const f = await fixture()
  try {
    const other = await f.runtime.control.openSession('bob')
    const request = f.request()
    request.expected.version = 'stale'
    const ready = await f.runtime.requests.prepare(f.execution, request, new AbortController().signal)
    await assert.rejects(f.runtime.requests.commit(ready.submission), /stale version/)
    assert.equal(f.runtime.control.history('alice', 'one').phase, 'unknown')
    assert.equal((await f.runtime.requests.prepare(f.execution, request, new AbortController().signal)).kind, 'history')
    await assert.rejects(f.runtime.requests.prepare(other, f.request('blocked'), new AbortController().signal), /fence|owned/)
    const agent = {}
    const host = createEditLockHost(f.runtime, candidate => candidate === agent)
    host.attach(agent, other)
    const result = await host.publish({ agent, callId: 'other', signal: new AbortController().signal }, f.request('other', 'unrelated'))
    assert.equal(result.kind, 'updated')
    assert.equal(await readFile(join(f.root, 'target'), 'utf8'), 'before')
    assert.equal(await readFile(join(f.root, 'unrelated'), 'utf8'), 'after')
    assert.equal(f.calls.length, 2)
  } finally { await f.runtime.close() }
})


test('Stop during durable publishing intent is revalidated before zero backend invocations', async () => {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'publisher-intent-')))
  const directory = join(root, '.authority')
  await mkdir(directory)
  const store = await openEditLockStore({ directory, domainId: 'test', mode: 'create' })
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  const wrapped = { ...store, async beginPublication(...args) {
    const attempt = await store.beginPublication(...args)
    entered.resolve()
    await gate.promise
    return attempt
  } }
  const manager = createEditLockManager({ store: wrapped, managerIncarnation: 'm' })
  let calls = 0
  const publisher = createPublisher({ manager, root, fs: {
    resolve: async path => ({ path }), writeText: async () => { calls++; throw new Error('must not dispatch') },
  } })
  const execution = await manager.openSession('alice')
  const controller = new AbortController()
  try {
    const ready = await publisher.prepare(execution, { operationId: 'intent', tool: 'write', filePath: join(root, 'new'), cwd: root,
      args: {}, content: 'after', expected: { kind: 'createIfAbsent' }, effectivePolicy: { mode: 'workspace-write' } }, controller.signal)
    const rejected = assert.rejects(publisher.commit(ready.submission), /active|cancelled|aborted/)
    await entered.promise
    controller.abort()
    gate.resolve()
    await rejected
    await manager.drain()
    assert.equal(calls, 0)
    assert.equal(manager.history('alice', 'intent').phase, 'not-published')
    assert.equal(manager.history('alice', 'intent').outcome.reason, 'cancelled-before-dispatch')
  } finally { gate.resolve(); await store.close() }
})
