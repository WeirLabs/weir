import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { apply, storeMode } from '../src/edit-lock/index.js'

const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'orrery-composition-')))
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  return { base, root, directory }
}

test('stop latches, restart starts interrupted, resume needs fresh request and per-file confirmation', async () => {
  const { root, directory } = await fixture()
  const open = mode => openEditLockRuntime({ directory, root, domainId: 'd', mode, fs: stubFs, assertExclusive() {} })
  const resource = join(root, 'a.txt')
  let runtime = await open('create')
  let lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const first = { id: 's' }
  assert.equal(await lifecycle.start(first), 'active')
  const status = runtime.control.status()
  await runtime.control.acquire({ managerIncarnation: status.managerIncarnation, sessionId: 's', executionEpoch: 1 }, resource)
  await lifecycle.stop(first)
  assert.equal(lifecycle.status(first).locks[0].status, 'user-interrupted')
  await lifecycle.dispose(first)
  const second = { id: 's' }
  assert.equal(await lifecycle.start(second), 'interrupted')
  await assert.rejects(lifecycle.confirm(second, resource), /authenticated/)
  const resumed = await lifecycle.resume(second, 'r1')
  assert.equal(resumed.state, 'active')
  assert.equal(resumed.locks[0].status, 'pending-confirmation')
  await assert.rejects(lifecycle.resume(second, 'r2'), /not interrupted/)
  await assert.rejects(lifecycle.confirm(second, join(root, 'other')), /no pending confirmation/)
  await lifecycle.confirm(second, resource)
  assert.equal(lifecycle.status(second).locks[0].status, 'active')
  await lifecycle.stop(second)
  await assert.rejects(lifecycle.resume(second, 'r1'), /already issued/)
  assert.equal(lifecycle.status(second).state, 'stopped')
  await lifecycle.close()

  // A new incarnation never re-arms a known session implicitly.
  runtime = await open('recover')
  lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const third = { id: 's' }
  assert.equal(await lifecycle.start(third), 'interrupted')
  assert.equal(lifecycle.status(third).locks[0].status, 'user-interrupted')
  assert.equal((await lifecycle.resume(third, 'r3')).locks[0].status, 'pending-confirmation')
  await lifecycle.close()
})

test('store mode refuses unknown authority content', async () => {
  const { base } = await fixture()
  const fresh = join(base, 'fresh')
  assert.equal(storeMode(fresh), 'create')
  await writeFile(join(fresh, 'stray'), 'x')
  assert.throws(() => storeMode(fresh), /no committed snapshot/)
})

function fakeHost(root) {
  const listeners = new Map()
  const provided = new Map()
  let command
  const ctx = {
    fs: stubFs,
    logger: { warn() {} },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    reflect: { provide(name, value) { provided.set(name, value) } },
    get(name) { return name === 'commands' ? { register(definition) { command = definition; return () => { command = undefined } } } : provided.get(name) },
    tools: { get(name, agent) { return agent.visible.get(name) } },
  }
  const stock = { write: { name: 'write', execute() {} }, edit: { name: 'edit', execute() {} } }
  function agent(id) {
    const visible = new Map(Object.entries(stock))
    return { id, visible, session: { header: { cwd: root } }, ctx: { tools: {
      restrict({ deny }) { for (const name of deny) if (visible.get(name) === stock[name]) visible.delete(name) },
      register(definition) { visible.set(definition.name, definition); return () => visible.delete(definition.name) },
    } } }
  }
  const emit = async (name, ...args) => {
    let result
    for (const fn of listeners.get(name) ?? []) result = await fn(...args, async () => ({ kind: 'allow' }))
    return result
  }
  return { ctx, listeners, provided, agent, emit, command: () => command }
}

test('disabled composition provides nothing and registers no listener', () => {
  const host = fakeHost('/unused')
  assert.equal(apply(host.ctx, {}), undefined)
  assert.equal(host.provided.size, 0)
  assert.equal(host.listeners.size, 0)
})

test('enabled composition guards unclaimed editors, latches stop and resumes only by command', async () => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  const service = host.provided.get('orreryEditLock')
  const agent = host.agent('s')
  await host.emit('agent/created', { agent })
  assert.equal(agent.visible.has('edit'), false)
  const write = agent.visible.get('write')
  assert.notEqual(write.name, undefined)
  assert.equal((await host.emit('tools/pre-execute', { name: 'write', agent })).kind, 'allow')
  agent.visible.set('hash_edit', { name: 'hash_edit', execute() {} })
  assert.equal((await host.emit('tools/pre-execute', { name: 'hash_edit', agent })).kind, 'deny')
  const claimed = { name: 'hash_edit', execute() {} }
  service.claim(claimed)
  // A registry copy keeps the claimed execute identity.
  agent.visible.set('hash_edit', { ...claimed })
  assert.equal((await host.emit('tools/pre-execute', { name: 'hash_edit', agent })).kind, 'allow')
  assert.equal(service.blocksContinuation(agent), false)

  const turn = new AbortController()
  await host.emit('agent/pre-step', { agent, signal: turn.signal })
  turn.abort({ kind: 'user' })
  assert.equal(service.blocksContinuation(agent), true)
  const status = await host.command().handler({ agent, rawInput: 'stop', commandId: 'c1' })
  assert.match(status.text, /durably revoked/)
  const resumed = await host.command().handler({ agent, rawInput: 'resume', commandId: 'c2' })
  assert.equal(resumed.kind, 'success', resumed.text)
  assert.equal(service.blocksContinuation(agent), false)
  assert.equal((await host.command().handler({ agent, rawInput: 'resume', commandId: 'c3' })).kind, 'error')
  dispose()
  assert.equal(host.command(), undefined)
})
