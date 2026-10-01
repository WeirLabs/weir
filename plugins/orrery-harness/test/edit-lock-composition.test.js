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

test('owner tools acquire, release and confirm by acquisition without stealing', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const alice = { id: 'alice' }, bob = { id: 'bob' }
  await lifecycle.start(alice); await lifecycle.start(bob)
  const tools = lifecycle.service
  const request = { filePath: 'a.txt', cwd: root }
  assert.equal((await tools.acquire({ agent: alice }, request)).generation, 1)
  await assert.rejects(tools.acquire({ agent: bob }, request), /owned/)
  await assert.rejects(tools.release({ agent: bob }, request), /not owned/)
  await assert.rejects(tools.acquire({ agent: alice }, { filePath: 'missing.txt', cwd: root }), /existing regular file/)
  await assert.rejects(tools.acquire({ agent: alice }, { filePath: '../outside', cwd: root }), /./)
  assert.equal((await tools.locks({ agent: bob }))[0].mine, false)
  await lifecycle.stop(alice)
  await assert.rejects(tools.release({ agent: alice }, request), /authenticated/)
  await lifecycle.resume(alice, 'r')
  assert.equal(lifecycle.status(alice).locks[0].status, 'pending-confirmation')
  await tools.acquire({ agent: alice }, request)
  assert.equal(lifecycle.status(alice).locks[0].status, 'active')
  await tools.release({ agent: alice }, request)
  assert.equal((await tools.acquire({ agent: bob }, request)).generation, 2)
  await lifecycle.close()
})

test('try_steal negotiation transfers only on a current holder reply', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const notices = []
  const pending = new Map()
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, {
    deliver: (agent, text) => notices.push([agent.id, text]),
    onPending: (agent, count) => pending.set(agent.id, count),
    negotiationTimeoutMs: 40,
  })
  const alice = { id: 'alice' }, bob = { id: 'bob' }
  await lifecycle.start(alice); await lifecycle.start(bob)
  const tools = lifecycle.service
  const file = { filePath: 'a.txt', cwd: root }
  await assert.rejects(tools.trySteal({ agent: bob }, file), /acquire it instead/)
  await tools.acquire({ agent: alice }, file)
  const first = await tools.trySteal({ agent: bob }, file)
  assert.equal(first.state, 'pending')
  assert.equal(pending.get('alice'), 1)
  assert.match(notices.at(-1)[1], /requests ownership/)
  await assert.rejects(tools.reply({ agent: bob }, { requestId: first.requestId, decision: 'release' }), /bound holder/)
  assert.equal((await tools.reply({ agent: alice }, { requestId: first.requestId, decision: 'keep' })).state, 'declined')
  assert.equal(pending.get('alice'), 0)
  await assert.rejects(tools.reply({ agent: alice }, { requestId: first.requestId, decision: 'release' }), /not pending/)
  // Silence expires and keeps ownership.
  const silent = await tools.trySteal({ agent: bob }, file)
  await new Promise(resolve => setTimeout(resolve, 60))
  await assert.rejects(tools.reply({ agent: alice }, { requestId: silent.requestId, decision: 'release' }), /not pending/)
  assert.equal(lifecycle.status(alice).locks.length, 1)
  assert.match(notices.find(([id, text]) => id === 'bob' && /expired/.test(text))[1], /unchanged/)
  // A generation change makes earlier consent stale.
  const stale = await tools.trySteal({ agent: bob }, file)
  await tools.release({ agent: alice }, file)
  await tools.acquire({ agent: alice }, file)
  await assert.rejects(tools.reply({ agent: alice }, { requestId: stale.requestId, decision: 'release' }), /ownership changed/)
  const granted = await tools.trySteal({ agent: bob }, file)
  assert.equal((await tools.reply({ agent: alice }, { requestId: granted.requestId, decision: 'release' })).state, 'transferred')
  assert.equal(lifecycle.status(bob).locks[0].generation, 3)
  assert.equal(lifecycle.status(alice).locks.length, 0)
  // A stopped holder cannot answer, and the request is never delivered to it.
  const back = await tools.trySteal({ agent: alice }, file)
  await lifecycle.stop(bob)
  await assert.rejects(tools.reply({ agent: bob }, { requestId: back.requestId, decision: 'release' }), /authenticated/)
  assert.equal(lifecycle.status(bob).locks[0].status, 'user-interrupted')
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
    tools: { get(name, agent) { return agent.visible.get(name) }, register() { return () => {} } },
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
