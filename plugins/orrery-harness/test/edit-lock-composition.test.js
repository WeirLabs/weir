import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, realpath, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { apply, storeMode } from '../src/edit-lock/index.js'
import { managementRootFor, excludeFromGit } from '../src/edit-lock/domains.js'
import { createRecoveryDriver } from '../src/edit-lock/recovery.js'
import { createRemoteEditLockDomain, endpointFor, serveEditLockEndpoint } from '../src/edit-lock/remote.js'

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
  assert.equal((await tools.locks({ agent: alice }))[0].generation, 1)
  await lifecycle.stop(alice)
  // Stopped: acquisition is refused with the reason, observation still works.
  await assert.rejects(tools.acquire({ agent: alice }, request), /was stopped/)
  assert.equal((await tools.locks({ agent: alice }))[0].mine, true)
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
  await assert.rejects(tools.reply({ agent: bob }, { requestId: back.requestId, decision: 'release' }), /was stopped/)
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

test('remote channel opens a session, EOF revokes it, and reconnect starts interrupted', async () => {
  const { base, root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const endpoint = endpointFor(directory)
  await writeFile(join(base, 'not-a-socket'), '')
  await assert.rejects(serveEditLockEndpoint(lifecycle, join(base, 'not-a-socket'), new WeakMap()), /unexpected node/)
  const server = await serveEditLockEndpoint(lifecycle, endpoint, new WeakMap())
  const remote = createRemoteEditLockDomain(endpoint, { onNotice() {} })
  const agent = { id: 'remote-s' }
  assert.equal((await remote.channelFor(agent)).state, 'active')
  assert.equal((await remote.call(agent, 'acquire', { filePath: 'a.txt', cwd: root })).generation, 1)
  try {
    remote.drop(agent)
    // Reconnect immediately: never "already bound", always interrupted.
    assert.equal((await remote.channelFor(agent)).state, 'interrupted')
    assert.equal(runtime.control.status().locks[0].status, 'user-interrupted')
    await assert.rejects(remote.call(agent, 'acquire', { filePath: 'a.txt', cwd: root }), /was stopped/)
  } finally {
    remote.close()
    await server.close()
    await lifecycle.close()
  }
})

test('session cwd domain: git root, in-tree authority excluded via info/exclude, nested sessions share', async () => {
  const { base } = await fixture()
  const repo = join(base, 'repo')
  await mkdir(join(repo, 'pkg'), { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  await writeFile(join(repo, 'pkg', 'a.txt'), 'a')
  assert.equal(managementRootFor(join(repo, 'pkg')), repo)
  const host = fakeHost(repo)
  const dispose = apply(host.ctx, { enabled: true })
  const outer = host.agent('outer'), inner = host.agent('inner')
  inner.session.header.cwd = join(repo, 'pkg')
  await host.emit('agent/created', { agent: outer })
  await host.emit('agent/created', { agent: inner })
  const service = host.provided.get('orreryEditLock')
  assert.equal((await service.describe(inner)).root, repo)
  assert.match(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8'), /\/\.orrery\/edit-lock\//)
  excludeFromGit(repo)
  assert.equal((await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).match(/Orrery Edit Lock/g).length, 1)
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).includes('.orrery'), false)
  await service.acquire({ agent: outer }, { filePath: 'pkg/a.txt', cwd: repo })
  await assert.rejects(service.acquire({ agent: inner }, { filePath: 'a.txt', cwd: join(repo, 'pkg') }), /owned/)
  await assert.rejects(service.acquire({ agent: outer }, { filePath: '.orrery/edit-lock/snapshot.json', cwd: repo }), /not editable/)
  dispose()
  await new Promise(resolve => setTimeout(resolve, 100))
})

test('cleanup-only recovery: abnormal on provider error, business denied, budgets durable and bounded', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const agent = { id: 's' }
  await lifecycle.start(agent)
  const file = { filePath: 'a.txt', cwd: root }
  assert.deepEqual(await lifecycle.classifyAbnormal(agent, 'provider-error'), [])
  assert.equal(lifecycle.status(agent).state, 'active')
  await lifecycle.service.acquire({ agent }, file)
  await lifecycle.classifyAbnormal(agent, 'provider-error')
  assert.equal(lifecycle.status(agent).state, 'recovering')
  assert.equal(lifecycle.status(agent).locks[0].status, 'abnormal')
  await assert.rejects(lifecycle.service.publish({ agent, callId: 'c', signal: new AbortController().signal }, {}), /cleanup-only/)
  await assert.rejects(lifecycle.service.acquire({ agent }, file), /cleanup-only/)
  await assert.rejects(lifecycle.pause(agent, 16), /15 minutes/)
  await lifecycle.pause(agent, 15)
  await lifecycle.pause(agent, 15)
  await assert.rejects(lifecycle.pause(agent, 1), /cumulative pause budget/)
  await lifecycle.chargeRecovery(agent, { attempts: 1, elapsedMs: 1000 })
  assert.deepEqual(lifecycle.recoveryUsage(agent), { sessionId: 's', attempts: 1, elapsedMs: 1000, pauseMs: 30 * 60_000 })
  // Resume needs a human, keeps abnormal; release still works during recovery.
  const resumed = await lifecycle.resume(agent, 'r')
  assert.equal(resumed.locks[0].status, 'abnormal')
  await lifecycle.service.release({ agent }, file)
  await lifecycle.close()
  // Restart never refunds the budget.
  const again = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'recover', fs: stubFs, assertExclusive() {} })
  assert.equal(again.control.recoveryUsage('s').pauseMs, 30 * 60_000)
  await again.close()
})

test('recovery driver schedules bounded cleanup turns and hands over on exhaustion', async () => {
  let clock = 0
  const timers = []
  const followups = [], notices = []
  const usage = { attempts: 0, elapsedMs: 0, pauseMs: 0 }
  const status = { state: 'recovering', locks: [{ resourceId: '/w/a', status: 'abnormal', reason: 'provider-error' }] }
  const domain = {
    classifyAbnormal: async () => ['/w/a'],
    status: async () => status,
    recoveryUsage: async () => ({ ...usage }),
    chargeRecovery: async (_agent, delta) => { usage.attempts += delta.attempts ?? 0; usage.elapsedMs += delta.elapsedMs ?? 0; return { ...usage } },
    pause: async () => ({ pausedMs: 60_000, cumulativePauseMs: 60_000 }),
  }
  const driver = createRecoveryDriver({ domainFor: () => domain, followup: (_a, text) => followups.push(text), notify: (_a, text) => notices.push(text),
    now: () => clock, setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t }, clearTimer: t => { t.cancelled = true } })
  const agent = {}
  const fire = async () => { const t = timers.filter(x => !x.cancelled && !x.fired).at(-1); t.fired = true; clock += t.ms; await t.fn(); await new Promise(r => setImmediate(r)) }
  await driver.onTurnEnd(agent, { kind: 'completed' })
  assert.equal(timers.length, 0)
  await driver.onTurnEnd(agent, { kind: 'error' })
  assert.equal(timers.at(-1).ms, 15_000)
  await fire()
  assert.match(followups.at(-1), /attempt 1 of 3/)
  await driver.onTurnEnd(agent, { kind: 'completed' })
  assert.equal(timers.at(-1).ms, 30_000)
  await fire()
  await driver.onTurnEnd(agent, { kind: 'completed' })
  await fire()
  assert.equal(followups.length, 3)
  await driver.onTurnEnd(agent, { kind: 'completed' })
  await fire()
  assert.equal(followups.length, 3)
  assert.match(notices.at(-1), /automatic cleanup stopped/)
  assert.equal(driver.state(agent), null)
})

test('stopped session is told why; status and release keep working; clean dispose releases, crash retains', async () => {
  const { root, directory } = await fixture()
  await writeFile(join(root, 'b.txt'), 'b')
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const tools = lifecycle.service
  const a = { id: 'a' }
  await lifecycle.start(a)
  await tools.acquire({ agent: a }, { filePath: 'a.txt', cwd: root })
  await tools.acquire({ agent: a }, { filePath: 'b.txt', cwd: root })
  await lifecycle.stop(a)
  await assert.rejects(tools.acquire({ agent: a }, { filePath: 'a.txt', cwd: root }), /was stopped.*\/edit-lock resume/)
  await assert.rejects(tools.publish({ agent: a, callId: 'c', signal: new AbortController().signal }, {}), /was stopped/)
  assert.equal((await tools.locks({ agent: a })).length, 2)
  await tools.release({ agent: a }, { filePath: 'a.txt', cwd: root })
  // A stopped agent ending keeps its retained lock for a human.
  await lifecycle.dispose(a)
  assert.deepEqual(runtime.control.status().locks.map(lock => [lock.resourceId.endsWith('b.txt'), lock.status]), [[true, 'user-interrupted']])
  // An active agent ending normally releases its active locks.
  const child = { id: 'child' }
  await lifecycle.start(child)
  await tools.acquire({ agent: child }, { filePath: 'a.txt', cwd: root })
  await lifecycle.dispose(child)
  assert.equal(runtime.control.status().locks.some(lock => lock.owner === 'child'), false)
  // Connection loss (forget) never releases.
  const remote = { id: 'remote' }
  await lifecycle.start(remote)
  await tools.acquire({ agent: remote }, { filePath: 'a.txt', cwd: root })
  await lifecycle.forget(remote)
  assert.equal(runtime.control.status().locks.find(lock => lock.owner === 'remote').status, 'user-interrupted')
  await lifecycle.close()
})

test('the panel view is read-only and structured; the panel acts only through /edit-lock commands', async () => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  /** @type {any} */
  let endpoint
  const agents = new Map()
  host.ctx.inject = (names, callback) => {
    if (names.includes('connection')) callback({ connection: { fetch: { register(definition) { endpoint = definition; return () => { endpoint = undefined } } } } })
  }
  const get = host.ctx.get
  host.ctx.get = (name) => (name === 'agents' ? agents : get(name))
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  const service = host.provided.get('orreryEditLock')
  const agent = host.agent('s')
  agents.set('s', agent)
  await host.emit('agent/created', { agent })
  const read = async (body = { sessionId: 's' }) => (await endpoint.fetch({ json: async () => body })).json()

  assert.equal(endpoint.path, '/api/orrery-edit-lock/view')
  assert.equal((await read({})).ok, false)
  assert.equal((await read({ sessionId: 'nobody' })).value.state, 'unavailable')
  assert.equal((await read()).value.state, 'idle')

  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  let view = (await read()).value
  assert.equal(view.state, 'editing')
  assert.deepEqual(view.files.map((file) => [file.name, file.mine, file.action]), [['a.txt', true, 'release']])
  assert.equal(view.technical.sessionId, 's')

  // Reading never changes ownership.
  await read(); await read()
  assert.equal((await read()).value.files.length, 1)

  // A reservation is visible as its own state.
  await service.hold({ agent }, 10 * 60_000)
  view = (await read()).value
  assert.equal(view.state, 'holding')
  assert.equal(view.hold.remainingMinutes, 10)

  // The panel's row action is an ordinary, recorded command.
  const released = await host.command().handler({ agent, rawInput: `release ${join(root, 'a.txt')}`, commandId: 'c1' })
  assert.equal(released.kind, 'success', released.text)
  assert.equal((await read()).value.state, 'idle')
  dispose()
  assert.equal(endpoint, undefined)
})

test('a refused edit names the owner and the next step instead of a bare "resource owned"', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const alice = { id: 'alice' }, bob = { id: 'bob' }
  await lifecycle.start(alice); await lifecycle.start(bob)
  const file = { filePath: 'a.txt', cwd: root }
  await lifecycle.service.acquire({ agent: alice }, file)
  await assert.rejects(lifecycle.service.acquire({ agent: bob }, file), (error) => {
    assert.match(error.message, /^resource owned: this file is being edited by session alice\./)
    assert.match(error.message, /edit_lock_try_steal/)
    return true
  })
  // The decision itself is unchanged: alice still owns the file.
  assert.equal(lifecycle.status(alice).locks.length, 1)
  await lifecycle.close()
})

test('expiry release honours the idle flag from the host running the agent, and re-checks expiry inside the transaction', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  // A publisher-side channel agent: no status of its own.
  const channel = Object.freeze({ id: 'remote' })
  await lifecycle.start(channel)
  await lifecycle.service.acquire({ agent: channel }, { filePath: 'a.txt', cwd: root })
  await lifecycle.hold(channel, 60_000, { singleMaxMs: 60_000, cumulativeMaxMs: 120_000 })
  // Not expired yet: even an idle report releases nothing.
  assert.deepEqual((await lifecycle.settleExpired(channel, false, true)).released, [])
  // Expired inside the kernel's view, but the transaction re-check still guards:
  const sessionId = 'remote'
  assert.deepEqual(await runtime.control.releaseActive(sessionId, Date.now(), true), [])
  // Busy by the client's report: deferred, never released mid-turn.
  assert.equal((await lifecycle.settleExpired(channel, false, false)).deferred, true)
  // Once truly expired and idle, the ordinary release path frees the file.
  assert.equal((await runtime.control.releaseActive(sessionId, Date.now() + 61_000, true)).length, 1)
  assert.equal(lifecycle.status(channel).locks.length, 0)
  await lifecycle.close()
})

test('/edit-lock hold uses the minutes the user typed', async () => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  const service = host.provided.get('orreryEditLock')
  const agent = host.agent('s')
  await host.emit('agent/created', { agent })
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  const held = await host.command().handler({ agent, rawInput: ' hold 5', commandId: 'h1' })
  assert.equal(held.kind, 'success', held.text)
  assert.match(held.text, /5 of 120 minutes/)
  const refused = await host.command().handler({ agent, rawInput: ' hold 45', commandId: 'h2' })
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /limited to 30 minutes/)
  dispose()
})
