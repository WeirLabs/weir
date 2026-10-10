import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { createRemoteEditLockDomain, serveEditLockEndpoint } from '../src/edit-lock/remote.js'
import { registerBindingRuntime, createBindingAttester } from '../src/edit-lock/binding-attestation.js'
import { localDomain } from '../src/edit-lock/domain.js'
import { fixtureEndpoint } from './helpers/edit-lock-fixtures.js'
import { parseSnapshot } from '../src/edit-lock/snapshot.js'

async function fixture(control = value => value) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-cross-mode-')))
  const directory = join(root, 'authority')
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'original')
  await writeFile(join(root, 'b.txt'), 'other')
  const runtime = await openEditLockRuntime({ root, directory, domainId: root, mode: 'create', assertExclusive() {}, fs: { async resolve() { throw Error('unused') }, async writeText() { throw Error('unused') } } })
  const old = { id: 's' }, current = { id: 's' }, other = { id: 'other' }
  let serving = old
  const lifecycle = createEditLockLifecycle({ ...runtime, control: control(runtime.control) }, agent => agent.id, { servingRuntime: () => serving })
  const server = await serveEditLockEndpoint(lifecycle, fixtureEndpoint(directory), new WeakMap(), createBindingAttester(() => serving), agent => serving === agent)
  const local = localDomain(lifecycle, server)
  const remote = createRemoteEditLockDomain(fixtureEndpoint(directory), { onNotice() {}, onChannelOpen: registerBindingRuntime })
  await remote.channelFor(old)
  await remote.call(old, 'acquire', { filePath: 'a.txt', cwd: root })
  return { root, directory, runtime, lifecycle, old, current, other, local, remote,
    stale() { serving = current }, async close() { remote.close(); await local.close() } }
}

test('rebind retains unknown fence, operation history, generation and both budgets', async () => {
  const f = await fixture()
  try {
    const execution = { managerIncarnation: f.runtime.control.status().managerIncarnation, sessionId: 's', executionEpoch: 1 }
    await f.remote.call(f.old, 'hold', { ms: 1000, singleMaxMs: 2000, cumulativeMaxMs: 5000 })
    await f.remote.call(f.old, 'chargeRecovery', { attempts: 1, elapsedMs: 2000, pauseMs: 3000 })
    const resourceId = join(f.root, 'a.txt')
    const prepared = await f.runtime.control.prepare(execution, {
      operationId: 'unknown', tool: 'write', filePath: resourceId, cwd: f.root, args: {}, content: 'uncertain', effectivePolicy: { mode: 'workspace-write' },
      target: { kind: 'update', resourceId, generation: 1, policy: { kind: 'replaceIfVersion', version: 'v1' } },
    }, { validate() {}, identify: () => resourceId, async publish() { throw Error('unknown publication') } })
    await assert.rejects(f.runtime.control.commit(prepared.submission), /unknown publication/)
    const before = parseSnapshot(await readFile(join(f.directory, 'snapshot.json')), f.root)
    const history = f.runtime.control.history('s', 'unknown')
    f.stale()
    assert.equal(await f.local.retryStart(f.current), 'interrupted')
    const after = parseSnapshot(await readFile(join(f.directory, 'snapshot.json')), f.root)
    assert.deepEqual(f.runtime.control.history('s', 'unknown'), history)
    assert.equal(f.runtime.control.status().locks[0].generation, 1)
    const status = await f.local.status(f.current)
    assert.equal(status.retention.holdCumulativeMs, 1000)
    assert.equal(status.recovery.attempts, 1)
    assert.equal(status.recovery.elapsedMs, 2000)
    assert.equal(status.recovery.pauseMs, 3000)
    assert.equal(before.state.operations.length, 1)
    assert.equal(before.state.operations[0].phase, 'unknown')
    assert.deepEqual(after.state.operations, before.state.operations)
    await f.lifecycle.start(f.other)
    await assert.rejects(f.lifecycle.service.acquire({ agent: f.other }, { filePath: 'a.txt', cwd: f.root }), /unresolved publication fence/)
    await f.lifecycle.service.acquire({ agent: f.other }, { filePath: 'b.txt', cwd: f.root })
  } finally { await f.close() }
})

test('pending and failed durable revoke never admit a local replacement; old peer stays sealed', async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  let fail = true
  const f = await fixture(control => ({ ...control, async cancelSession(id) {
    if (id === 's' && fail) { entered.resolve(); await gate.promise; throw Error('durability unavailable') }
    return control.cancelSession(id)
  } }))
  try {
    f.stale()
    let admitted = false
    const pending = f.local.start(f.current).then(() => { admitted = true })
    const denied = assert.rejects(pending, /durable revocation was not acknowledged/)
    await entered.promise
    assert.equal(admitted, false)
    await assert.rejects(f.remote.call(f.old, 'release', { filePath: 'a.txt', cwd: f.root }), /disconnected/)
    await f.lifecycle.start(f.other)
    await f.lifecycle.service.acquire({ agent: f.other }, { filePath: 'b.txt', cwd: f.root })
    gate.resolve()
    await denied
    assert.equal(f.runtime.control.status().locks.find(lock => lock.owner === 's').generation, 1)
    fail = false
    assert.equal(await f.local.retryStart(f.current), 'interrupted')
  } finally { fail = false; gate.resolve(); await f.close() }
})

test('poisoned authority rejects retry before touching the original holder', async () => {
  let poisoned = false
  const f = await fixture(control => ({ ...control, status() {
    if (poisoned) throw Error('edit lock manager poisoned')
    return control.status()
  } }))
  try {
    f.stale(); poisoned = true
    await assert.rejects(f.local.retryStart(f.current), /poisoned/)
    poisoned = false
    assert.equal((await f.remote.call(f.old, 'locks')).length, 1)
    assert.equal((await f.remote.call(f.old, 'status')).state, 'active')
  } finally { poisoned = false; await f.close() }
})
