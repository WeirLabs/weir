import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { fixtureRoot, fixtureEndpoint, fixtureExclude } from './helpers/edit-lock-fixtures.js'

const apply = createEditLockPlugin({ resolveRoot: fixtureRoot, endpoint: fixtureEndpoint, exclude: fixtureExclude })
const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture() {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-negotiation-regression-')))
  const ceiling = realpathSync.native(tmpdir()) + sep
  assert.ok(base.startsWith(ceiling) && base.split(sep).at(-1).startsWith('weir-negotiation-regression-'))
  // The fixture root is checked here and again immediately before cleanup.
  const root = join(base, 'work'), directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'unchanged')
  return { base, root, directory, file: { filePath: 'a.txt', cwd: root } }
}

async function removeFixture(base) {
  assert.equal(realpathSync.native(base), base)
  await rm(base, { recursive: true, force: true })
}

function fakeHost(root) {
  const listeners = new Map(), provided = new Map(), agents = new Map()
  const ctx = {
    fs: stubFs,
    logger: { warn() {} },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    reflect: { provide(name, value) { provided.set(name, value) } },
    get(name) { return name === 'agents' ? agents : name === 'commands' ? { register() { return () => {} } } : provided.get(name) },
    tools: { get(name, agent) { return agent.visible.get(name) }, register() { return () => {} } },
  }
  const agent = (id, status) => {
    const delivered = [], visible = new Map()
    const created = { id, status, delivered, visible, session: { header: { cwd: root } },
      inject(message) { delivered.push({ method: 'inject', message }) },
      followup(message) { delivered.push({ method: 'followup', message }) },
      ctx: { tools: { restrict() {}, register(definition) {
        visible.set(definition.name, definition)
        return () => visible.delete(definition.name)
      } } },
    }
    agents.set(id, created)
    return created
  }
  async function emit(name, payload) {
    for (const fn of listeners.get(name) ?? []) await fn(payload)
  }
  return { ctx, provided, agent, emit }
}

test('busy holder is injected without a wake; idle holder is woken to answer at a safe point', async t => {
  const { base, root, directory, file } = await fixture()
  const host = fakeHost(root)
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(async () => { await dispose(); await removeFixture(base) })
  const holder = host.agent('holder', 'busy'), requester = host.agent('requester', 'idle')
  await host.emit('agent/created', { agent: holder })
  await host.emit('agent/created', { agent: requester })
  const service = host.provided.get('weirEditLock')
  await service.acquire({ agent: holder }, file)
  const busy = await service.trySteal({ agent: requester }, file)
  assert.equal(busy.state, 'pending')
  assert.equal(holder.delivered.length, 1)
  assert.equal(holder.delivered[0].method, 'inject')
  assert.match(holder.delivered[0].message.content[0].text, new RegExp(busy.requestId))
  assert.equal(holder.visible.has('edit_lock_reply'), true)
  assert.equal((await service.reply({ agent: holder }, { requestId: busy.requestId, decision: 'keep' })).state, 'declined')
  assert.equal((await service.locks({ agent: holder }))[0].owner, 'holder')

  holder.status = 'idle'
  const idle = await service.trySteal({ agent: requester }, file)
  assert.equal(idle.state, 'pending')
  assert.deepEqual(holder.delivered.map(row => row.method), ['inject', 'followup'])
  assert.match(holder.delivered[1].message.content[0].text, new RegExp(idle.requestId))
  assert.equal((await service.reply({ agent: holder }, { requestId: idle.requestId, decision: 'keep' })).state, 'declined')
  assert.equal((await service.locks({ agent: holder }))[0].owner, 'holder')
})

test('throwing holder notification leaves request pending then times out without transfer', async t => {
  const { base, root, directory, file } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const holder = { id: 'holder' }, requester = { id: 'requester' }
  const notices = []
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, {
    negotiationTimeoutMs: 30,
    deliver(agent, text) {
      if (agent === holder) throw new Error('notification channel closed')
      notices.push(text)
    },
  })
  t.after(async () => { await lifecycle.close(); await removeFixture(base) })
  await lifecycle.start(holder)
  await lifecycle.start(requester)
  await lifecycle.service.acquire({ agent: holder }, file)
  const original = lifecycle.status(holder).locks[0]
  const request = await lifecycle.service.trySteal({ agent: requester }, file)
  assert.equal(request.state, 'pending')
  assert.deepEqual(lifecycle.service.pendingRequests({ agent: holder }).map(row => row.requestId), [request.requestId])
  await assert.rejects(lifecycle.service.acquire({ agent: requester }, file), /owned/)
  await delay(80)
  assert.deepEqual(lifecycle.service.pendingRequests({ agent: holder }), [])
  await assert.rejects(lifecycle.service.reply({ agent: holder }, { requestId: request.requestId, decision: 'release' }), /not pending/)
  assert.match(notices.at(-1), /expired.*ownership is unchanged/s)
  assert.match(notices.at(-1), /Edit Lock maintenance panel/)
  assert.deepEqual(lifecycle.status(holder).locks.map(({ owner, generation, status }) => ({ owner, generation, status })),
    [{ owner: original.owner, generation: original.generation, status: 'active' }])
  assert.deepEqual(lifecycle.status(requester).locks, [])
  await assert.rejects(lifecycle.service.acquire({ agent: requester }, file), /owned/)
  t.diagnostic(`failed delivery timeout: owner=${original.owner} generation=${original.generation}, requesterLocks=0`)
})

test('busy holder silence expires without taking its file or creating a requester lock', async t => {
  const { base, root, directory, file } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const holder = { id: 'holder', status: 'busy' }, requester = { id: 'requester' }
  const notices = []
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, {
    negotiationTimeoutMs: 30,
    deliver(agent, text, wake) { notices.push({ agent, text, wake }) },
  })
  t.after(async () => { await lifecycle.close(); await removeFixture(base) })
  await lifecycle.start(holder)
  await lifecycle.start(requester)
  await lifecycle.service.acquire({ agent: holder }, file)
  const before = lifecycle.status(holder).locks[0]
  const request = await lifecycle.service.trySteal({ agent: requester }, file)
  assert.equal(request.state, 'pending')
  assert.deepEqual(notices.map(row => row.agent), [holder])
  assert.equal(notices[0].wake, true) // The actual busy/idle choice is exercised through the plugin above.
  await delay(80)
  assert.match(notices.at(-1).text, /expired.*ownership is unchanged/s)
  assert.equal(notices.at(-1).agent, requester)
  await assert.rejects(lifecycle.service.reply({ agent: holder }, { requestId: request.requestId, decision: 'release' }), /not pending/)
  assert.deepEqual(lifecycle.status(holder).locks.map(({ owner, generation, status }) => ({ owner, generation, status })),
    [{ owner: before.owner, generation: before.generation, status: 'active' }])
  assert.deepEqual(lifecycle.status(requester).locks, [])
  await assert.rejects(lifecycle.service.acquire({ agent: requester }, file), /owned/)
  t.diagnostic(`busy silence timeout: owner=${before.owner} generation=${before.generation}, requesterLocks=0`)
})
