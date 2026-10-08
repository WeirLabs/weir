// Message-triggered stale-lock sweep (openspec edit-lock-stale-lock-sweep).
// Four layers, modeled on edit-lock-quarantine.test.js (manager over a real
// store), edit-lock-auto-resume.test.js (composition over a fixed fixture
// domain) and the peer/domain tests:
//   A. isMissingTarget — ENOENT-only classification over the real filesystem
//   B. createStaleSweepScheduler — single-flight, cooldown, dispose cancel
//   C. manager.releaseStale — execution-point conditional release semantics
//   D. composition — inbox trigger, audit, setting gate, cooldown, cancel
//   E. cross-process — client domain forwarding + publisher peer routing
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMissingTarget, createStaleSweepScheduler } from '../src/edit-lock/stale-sweep.js'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { remoteDomain } from '../src/edit-lock/domain.js'
import { createEditLockPeer, PEER_KINDS } from '../src/edit-lock/peer.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { fixtureRoot as managementRootFor, fixtureEndpoint as endpointFor, fixtureExclude as excludeFromGit } from './helpers/edit-lock-fixtures.js'

const apply = createEditLockPlugin({ resolveRoot: managementRootFor, endpoint: endpointFor, exclude: excludeFromGit })

// ---------- A. missing-target classification (real fs) ----------

test('A: only ENOENT marks a target missing — file, dangling symlink and ENOTDIR all skip', async (t) => {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-stale-detect-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const file = join(base, 'present.txt')
  await writeFile(file, 'x')
  assert.equal(isMissingTarget(file), false)
  assert.equal(isMissingTarget(join(base, 'gone.txt')), true)
  // A dangling symlink lstats successfully: NOT missing.
  const dangling = join(base, 'dangling')
  await symlink(join(base, 'no-such-target'), dangling)
  assert.equal(isMissingTarget(dangling), false)
  // ENOTDIR: a path whose parent component is a regular file is skipped, not stale.
  assert.equal(isMissingTarget(join(file, 'child')), false)
  // Empty/garbage input never classifies as missing.
  assert.equal(isMissingTarget(''), false)
  assert.equal(isMissingTarget(/** @type {any} */ (undefined)), false)
})

// ---------- B. scheduler ----------

function manualTimer() {
  /** @type {(() => void)[]} */
  const queue = []
  return {
    setTimer: (fn) => { queue.push(fn); return fn },
    clearTimer: (handle) => { const at = queue.indexOf(/** @type {any} */ (handle)); if (at !== -1) queue.splice(at, 1) },
    fire() { const fn = queue.shift(); if (fn) fn() },
    get pending() { return queue.length },
  }
}

test('B: single in-flight sweep per key plus cooldown; a failing job warns and still cools down', async () => {
  const timer = manualTimer()
  let clock = 1000
  const warns = []
  let runs = 0
  /** @type {(() => void) | undefined} */
  let release
  const scheduler = createStaleSweepScheduler({ cooldownMs: 60_000, now: () => clock, setTimer: timer.setTimer, clearTimer: timer.clearTimer, warn: (m) => warns.push(m) })
  const job = () => { runs++; return new Promise((resolve) => { release = resolve }) }
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

  assert.equal(scheduler.trigger('root', job), true)
  timer.fire()
  await flush()
  assert.equal(runs, 1)
  // In flight: further triggers schedule nothing.
  assert.equal(scheduler.trigger('root', job), false)
  assert.equal(timer.pending, 0)
  release?.()
  await flush()
  // Cooling down: nothing until the window passes.
  assert.equal(scheduler.trigger('root', job), false)
  clock += 60_001
  assert.equal(scheduler.trigger('root', job), true)
  timer.fire()
  await flush()
  assert.equal(runs, 2)
  release?.()
  await flush()
  assert.deepEqual(warns, [])

  // A rejected job warns once and still opens the cooldown window.
  clock += 60_001
  assert.equal(scheduler.trigger('root', () => Promise.reject(new Error('boom'))), true)
  timer.fire()
  await flush()
  assert.equal(warns.length, 1)
  assert.match(warns[0], /stale sweep failed: boom/)
  assert.equal(scheduler.trigger('root', job), false)
  scheduler.close()
})

test('B: keys are independent and close() cancels only undispatched work', async () => {
  const timer = manualTimer()
  const scheduler = createStaleSweepScheduler({ cooldownMs: 60_000, now: () => 0, setTimer: timer.setTimer, clearTimer: timer.clearTimer })
  let a = 0, b = 0
  assert.equal(scheduler.trigger('root-a', () => { a++ }), true)
  assert.equal(scheduler.trigger('root-b', () => { b++ }), true)
  assert.equal(timer.pending, 2)
  scheduler.close()
  assert.equal(timer.pending, 0)
  timer.fire()
  assert.equal(a, 0)
  assert.equal(b, 0)
  assert.equal(scheduler.trigger('root-a', () => { a++ }), false)
  assert.equal(a, 0)
})

test('B: expired-cooldown entries are reclaimed on the next pass and close() empties the registry', async () => {
  const timer = manualTimer()
  let clock = 1000
  const scheduler = createStaleSweepScheduler({ cooldownMs: 60_000, now: () => clock, setTimer: timer.setTimer, clearTimer: timer.clearTimer })
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

  assert.equal(scheduler.trigger('root-a', () => {}), true)
  assert.equal(scheduler.size, 1)
  timer.fire()
  await flush()
  // root-a is cooling; a different key's pass does not reclaim it yet.
  assert.equal(scheduler.trigger('root-b', () => {}), true)
  assert.equal(scheduler.size, 2)
  timer.fire()
  await flush()
  // Both cooldown windows lapse; the next schedule pass reclaims both entries.
  clock += 60_001
  assert.equal(scheduler.trigger('root-c', () => {}), true)
  assert.equal(scheduler.size, 1)
  // A reclaimed key starts fresh: it arms again at once.
  assert.equal(scheduler.trigger('root-a', () => {}), true)
  assert.equal(scheduler.size, 2)
  scheduler.close()
  assert.equal(scheduler.size, 0)
})

// ---------- C. manager.releaseStale ----------

async function managerFixture(run) {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-stale-mgr-')))
  const directory = join(base, 'authority')
  const work = join(base, 'w')
  await mkdir(directory)
  await mkdir(work)
  const store = await openEditLockStore({ directory, domainId: base, mode: 'create' })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'm' })
    await run({ store, manager, work })
  } finally {
    await store.close()
    await rm(base, { recursive: true, force: true })
  }
}

/** @param {any} manager @param {string} resourceId */
function observe(manager, resourceId) {
  const status = manager.status()
  const lock = status.locks.find(/** @param {any} l */ l => l.resourceId === resourceId)
  const session = status.sessions.find(/** @param {any} s */ s => s.sessionId === lock.owner)
  return { resourceId, owner: lock.owner, generation: lock.generation, executionEpoch: session.executionEpoch, status: lock.status }
}
/** @param {any} manager @param {string} sessionId */
function holdRow(manager, sessionId) {
  return manager.status().holds.find(/** @param {any} h */ h => h.sessionId === sessionId)
}

test('C: an interrupted owner\'s missing-target lock is released; the generation tombstone and the zeroed holds row remain', async () => {
  await managerFixture(async ({ store, manager, work }) => {
    const target = join(work, 'gone.txt')
    await writeFile(target, 'x')
    const execution = await manager.openSession('dead')
    await manager.acquire(execution, target)
    await manager.cancelSession('dead')
    await rm(target)
    const observed = observe(manager, target)
    assert.equal(observed.status, 'user-interrupted')

    const result = await manager.releaseStale([observed], isMissingTarget)
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.released, [{ resourceId: target, owner: 'dead', generation: 1 }])
    assert.equal(manager.status().locks.length, 0)
    // Ordinary release semantics: the generation tombstone survives and the
    // owner's holds row is zeroed (last lock gone), never deleted.
    const state = store.snapshot().state
    assert.deepEqual(state.generations.find(/** @param {any} g */ g => g.resourceId === target), { resourceId: target, generation: 1 })
    assert.deepEqual(holdRow(manager, 'dead'), { sessionId: 'dead', holding: false, holdUntil: null, holdCumulativeMs: 0 })
  })
})

test('C: an owner that resumed and confirmed between scan and execution is skipped (same generation, changed epoch/status)', async () => {
  await managerFixture(async ({ store, manager, work }) => {
    const target = join(work, 'resumed.txt')
    await writeFile(target, 'x')
    const execution = await manager.openSession('s')
    await manager.acquire(execution, target)
    await rm(target)
    const observed = observe(manager, target)
    // The owner is stopped, then a genuine Continue runs resume + confirm.
    const stopped = await manager.cancel(execution)
    const receipt = await manager.issueExecutionReceipt(stopped, 'continue')
    const resumed = await manager.resume(stopped, 'continue', receipt)
    await manager.confirm(resumed, target)

    const before = store.snapshot()
    const result = await manager.releaseStale([observed], isMissingTarget)
    assert.deepEqual(result.released, [])
    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0].reason, /changed before execution/)
    // A skip persists nothing: no revision, no tombstone change.
    assert.deepEqual(store.snapshot(), before)
    assert.equal(manager.status().locks[0].status, 'active')
  })
})

test('C: a generation bump between scan and execution is skipped', async () => {
  await managerFixture(async ({ manager, work }) => {
    const target = join(work, 'bumped.txt')
    await writeFile(target, 'x')
    const execution = await manager.openSession('s')
    const token = await manager.acquire(execution, target)
    await rm(target)
    const observed = observe(manager, target)
    await manager.release(token)
    const again = await manager.acquire(execution, target)
    assert.equal(again.generation, 2)

    const result = await manager.releaseStale([observed], isMissingTarget)
    assert.deepEqual(result.released, [])
    assert.match(result.skipped[0].reason, /changed before execution/)
    assert.equal(manager.status().locks[0].generation, 2)
  })
})

test('C: a target recreated between scan and execution is skipped', async () => {
  await managerFixture(async ({ manager, work }) => {
    const target = join(work, 'recreated.txt')
    await writeFile(target, 'x')
    const execution = await manager.openSession('s')
    await manager.acquire(execution, target)
    await rm(target)
    const observed = observe(manager, target)
    await writeFile(target, 'back')

    const result = await manager.releaseStale([observed], isMissingTarget)
    assert.deepEqual(result.released, [])
    assert.match(result.skipped[0].reason, /target exists again/)
    assert.equal(manager.status().locks.length, 1)
  })
})

test('C: holding locks with missing targets release; the last release zeroes the holds row', async () => {
  await managerFixture(async ({ manager, work }) => {
    const one = join(work, 'one.txt')
    const two = join(work, 'two.txt')
    await writeFile(one, '1')
    await writeFile(two, '2')
    const execution = await manager.openSession('holder')
    await manager.acquire(execution, one)
    await manager.acquire(execution, two)
    await manager.hold('holder', 600_000, { now: 1000, singleMaxMs: 1_800_000, cumulativeMaxMs: 7_200_000 })
    assert.equal(holdRow(manager, 'holder').holding, true)
    assert.ok(holdRow(manager, 'holder').holdCumulativeMs > 0)
    await rm(one)
    await rm(two)

    const result = await manager.releaseStale([observe(manager, one), observe(manager, two)], isMissingTarget)
    assert.equal(result.released.length, 2)
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(holdRow(manager, 'holder'), { sessionId: 'holder', holding: false, holdUntil: null, holdCumulativeMs: 0 })
  })
})

test('C: ownership required by an unresolved update is refused by ordinary fence admission (a skip), unrelated stale rows still release', async () => {
  await managerFixture(async ({ manager, work }) => {
    const fenced = join(work, 'fenced.txt')
    const free = join(work, 'free.txt')
    await writeFile(fenced, 'x')
    await writeFile(free, 'y')
    const child = await manager.openSession('child')
    const parent = await manager.openSession('parent')
    const token = await manager.acquire(child, fenced)
    await manager.acquire(parent, free)
    // An invoked writer failure leaves an unknown update fenced on the child lock.
    const request = { operationId: 'op-unknown', tool: 'write', filePath: fenced, cwd: work, args: {}, content: 'late',
      effectivePolicy: { mode: 'workspace-write' },
      target: { kind: 'update', resourceId: fenced, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
    const ready = await manager.prepare(child, request, { validate() {}, publish: async () => { throw new Error('writer outcome unknown') }, identify: () => fenced })
    await assert.rejects(manager.commit(ready.submission), /writer outcome unknown/)
    await rm(fenced)
    await rm(free)

    const result = await manager.releaseStale([observe(manager, fenced), observe(manager, free)], isMissingTarget)
    assert.deepEqual(result.released, [{ resourceId: free, owner: 'parent', generation: 1 }])
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].row.resourceId, fenced)
    assert.match(result.skipped[0].reason, /fence/)
    assert.deepEqual(result.failed, [])  // fence refusal is a quiet skip, never a failure
    assert.equal(manager.status().locks.length, 1)
    assert.equal(manager.status().locks[0].resourceId, fenced)
  })
})

test('C: a duplicated sweep answer is idempotent — already-released rows skip, never error', async () => {
  await managerFixture(async ({ manager, work }) => {
    const target = join(work, 'dup.txt')
    await writeFile(target, 'x')
    const execution = await manager.openSession('s')
    await manager.acquire(execution, target)
    await rm(target)
    const observed = observe(manager, target)

    const first = await manager.releaseStale([observed], isMissingTarget)
    assert.equal(first.released.length, 1)
    // The IPC answer was lost and the same observation arrives again.
    const second = await manager.releaseStale([observed], isMissingTarget)
    assert.deepEqual(second.released, [])
    assert.equal(second.skipped.length, 1)
    assert.match(second.skipped[0].reason, /already released/)
    assert.equal(manager.status().locks.length, 0)
  })
})

test('C: a persistence failure surfaces as a failure, never a skip — and poisons the manager', async () => {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-stale-mgr-')))
  const directory = join(base, 'authority')
  const work = join(base, 'w')
  await mkdir(directory)
  await mkdir(work)
  const realStore = await openEditLockStore({ directory, domainId: base, mode: 'create' })
  let failWrites = false
  const store = /** @type {any} */ ({
    snapshot: () => realStore.snapshot(),
    record: (/** @type {any} */ input) => (failWrites ? Promise.reject(new Error('disk full')) : realStore.record(input)),
    close: () => realStore.close(),
  })
  try {
    const manager = createEditLockManager({ store, managerIncarnation: 'm' })
    const target = join(work, 'gone.txt')
    await writeFile(target, 'x')
    const execution = await manager.openSession('s')
    await manager.acquire(execution, target)
    await rm(target)
    const observed = observe(manager, target)

    failWrites = true
    const result = await manager.releaseStale([observed], isMissingTarget)
    assert.deepEqual(result.released, [])
    assert.deepEqual(result.skipped, [])  // a persistence failure is NOT counted as a skip
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].row.resourceId, target)
    assert.match(result.failed[0].reason, /persistence|poisoned/)
    // Fail-closed: nothing persisted, and the poisoned manager refuses further work.
    assert.throws(() => manager.status(), /poisoned/)
  } finally {
    failWrites = false
    await realStore.close()
    await rm(base, { recursive: true, force: true })
  }
})

// ---------- D. composition ----------

const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture() {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-stale-comp-')))
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  await writeFile(join(root, 'b.txt'), 'b')
  return { base, root, directory }
}

function fakeHost(root, { sweepSetTimeout } = {}) {
  const listeners = new Map()
  const provided = new Map()
  const agents = new Map()
  const warns = []
  const emitted = []
  let command
  let editLockSection
  const ctx = {
    fs: stubFs,
    // Optional manual timer for the sweep scheduler (dispose-race tests).
    ...(sweepSetTimeout ? { setTimeout: sweepSetTimeout } : {}),
    logger: { warn(message) { warns.push(String(message)) } },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    emit(name, record) { emitted.push({ name, record }) },
    reflect: { provide(name, value) { provided.set(name, value) } },
    get(name) {
      if (name === 'commands') return { register(definition) { command = definition; return () => { command = undefined } } }
      if (name === 'agents') return agents
      if (name === 'weirSettings') return { get: (section) => (section === 'editLock' ? editLockSection : undefined) }
      return provided.get(name)
    },
    tools: { get(name, agent) { return agent.visible.get(name) }, register() { return () => {} } },
  }
  const stock = { write: { name: 'write', execute() {} }, edit: { name: 'edit', execute() {} } }
  function agent(id) {
    const visible = new Map(Object.entries(stock))
    const created = { id, visible, injected: [], followedUp: [], session: { header: { cwd: root } }, ctx: { tools: {
      restrict({ deny }) { for (const name of deny) if (visible.get(name) === stock[name]) visible.delete(name) },
      register(definition) { visible.set(definition.name, definition); return () => visible.delete(definition.name) },
    } },
    inject(message) { created.injected.push(message) },
    followup(message) { created.followedUp.push(message) } }
    agents.set(id, created)
    return created
  }
  const emit = async (name, ...args) => {
    let result
    for (const fn of listeners.get(name) ?? []) result = await fn(...args, async () => ({ kind: 'allow' }))
    return result
  }
  return {
    ctx, provided, agent, emit, warns, emitted,
    command: () => command,
    setEditLockSection(section) { editLockSection = section },
    userMessage: (agent) => emit('agent/inbox/inserted', { agent, message: { id: 'm-u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }),
    injectedMessage: (agent) => emit('agent/inbox/inserted', { agent, message: { id: 'm-i', role: 'user', content: [{ type: 'text', text: 'injected' }], source: { kind: 'weir-todo-driver' } } }),
    preStep: (agent, turn, signal) => emit('agent/pre-step', { agent, turn, signal }),
  }
}

async function boot(host, root, directory) {
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  const service = host.provided.get('weirEditLock')
  return { dispose, service }
}

async function createAgent(host, id) {
  const agent = host.agent(id)
  await host.emit('agent/created', { agent })
  return agent
}

/** Stop the session the way the stock Stop button does: abort the turn signal. */
async function stopByUser(host, agent) {
  const control = new AbortController()
  await host.preStep(agent, undefined, control.signal)
  control.abort({ kind: 'user' })
}

/** Time-bounded poll: robust under full-suite event-loop load (the sweep is
 * a detached timer + real fs IO, so an iteration budget can expire first). */
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}

/** Dead session analog: owns the target, stopped by the user, target deleted. */
async function deadOwnerLock(host, service, root, id, name) {
  const dead = await createAgent(host, id)
  await service.acquire({ agent: dead }, { filePath: name, cwd: root })
  await stopByUser(host, dead)
  await rm(join(root, name))
  return dead
}

test('D: a genuine user message silently sweeps a dead session\'s missing-target lock, audits it, and never touches the conversation', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service } = await boot(host, root, directory)
  t.after(() => dispose())
  const dead = await deadOwnerLock(host, service, root, 's-dead', 'a.txt')
  const live = await createAgent(host, 's-live')
  assert.equal((await service.locks({ agent: live })).length, 1)

  await host.userMessage(live)
  assert.equal(await waitFor(async () => (await service.locks({ agent: live })).length === 0), true, 'sweep released the stale lock')

  // Publisher-side audit: cordis emit + JSONL mirror anchored at the management root.
  const events = host.emitted.filter((e) => e.name === 'weir/edit-lock-maintenance' && e.record?.data?.kind === 'stale-sweep')
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].record.data, {
    kind: 'stale-sweep', root, trigger: 's-live', owner: 's-dead', resourceId: join(root, 'a.txt'), generation: 1,
  })
  const mirror = (await readFile(join(root, '.weir', 'audit.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(mirror.filter((row) => row.type === 'weir/edit-lock-maintenance' && row.data?.kind === 'stale-sweep').length, 1)
  // Silent: no inject/followup on either session, no warns.
  assert.deepEqual(live.injected, [])
  assert.deepEqual(live.followedUp, [])
  assert.deepEqual(dead.injected, [])
  assert.deepEqual(host.warns, [])
  await dispose()
})

test('D: a runtime-injected message never schedules a sweep', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service } = await boot(host, root, directory)
  t.after(() => dispose())
  await deadOwnerLock(host, service, root, 's-dead', 'a.txt')
  const live = await createAgent(host, 's-live')

  await host.injectedMessage(live)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal((await service.locks({ agent: live })).length, 1)
  assert.equal(host.emitted.filter((e) => e.name === 'weir/edit-lock-maintenance').length, 0)
  assert.deepEqual(host.warns, [])
  await dispose()
})

test('D: editLock.staleSweep === false schedules nothing (setting read per message)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  host.setEditLockSection({ staleSweep: false })
  const { dispose, service } = await boot(host, root, directory)
  t.after(() => dispose())
  await deadOwnerLock(host, service, root, 's-dead', 'a.txt')
  const live = await createAgent(host, 's-live')

  await host.userMessage(live)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal((await service.locks({ agent: live })).length, 1)
  assert.equal(host.emitted.filter((e) => e.name === 'weir/edit-lock-maintenance').length, 0)
  assert.deepEqual(host.warns, [])
  await dispose()
})

test('D: the per-domain cooldown coalesces — a second message inside the window schedules nothing', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service } = await boot(host, root, directory)
  t.after(() => dispose())
  await deadOwnerLock(host, service, root, 's-dead', 'a.txt')
  const live = await createAgent(host, 's-live')

  await host.userMessage(live)
  assert.equal(await waitFor(async () => (await service.locks({ agent: live })).length === 0), true, 'first sweep released the stale lock')
  // A SECOND stale lock appears after the first sweep completed.
  await deadOwnerLock(host, service, root, 's-third', 'b.txt')
  assert.equal((await service.locks({ agent: live })).length, 1)

  // Within the 60s cooldown the message schedules nothing: the lock remains.
  await host.userMessage(live)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal((await service.locks({ agent: live })).length, 1)
  assert.equal(host.emitted.filter((e) => e.record?.data?.kind === 'stale-sweep').length, 1)
  assert.deepEqual(host.warns, [])
  await dispose()
})

test('D: an agent disposed before dispatch cancels its undispatched sweep', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service } = await boot(host, root, directory)
  t.after(() => dispose())
  await deadOwnerLock(host, service, root, 's-dead', 'a.txt')
  const live = await createAgent(host, 's-live')

  await host.userMessage(live)
  await host.emit('agent/disposed', { agent: live })
  await new Promise((resolve) => setTimeout(resolve, 100))

  // The disposed messenger's sweep never dispatched; the stale lock remains.
  assert.equal(host.emitted.filter((e) => e.record?.data?.kind === 'stale-sweep').length, 0)
  assert.deepEqual(host.warns, [])
  await dispose()
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'))
  assert.equal(snapshot.payload.state.locks.length, 1)
})

test('D: plugin unmount before dispatch cancels undispatched sweeps', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service } = await boot(host, root, directory)
  await deadOwnerLock(host, service, root, 's-dead', 'a.txt')
  const live = await createAgent(host, 's-live')

  await host.userMessage(live)
  await dispose()
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(host.emitted.filter((e) => e.record?.data?.kind === 'stale-sweep').length, 0)
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'))
  assert.equal(snapshot.payload.state.locks.length, 1)
})

test('D: a dispose landing while the domain-open fulfillment is pending cancels the sweep', async (t) => {
  const { root, directory } = await fixture()
  // Manual sweep timer: dispatch is synchronous with fire(), so the test can
  // dispose the agent in the exact window between the job's pre-submission
  // checks and the forRoot(...).then fulfillment callback.
  const queue = []
  const sweepTimer = {
    setTimer: (/** @type {() => void} */ fn) => { queue.push(fn); return fn },
    fire: () => { const fn = queue.shift(); if (fn) fn() },
  }
  const host = fakeHost(root, { sweepSetTimeout: sweepTimer.setTimer })
  const { dispose, service } = await boot(host, root, directory)
  t.after(() => dispose())
  await deadOwnerLock(host, service, root, 's-dead', 'a.txt')
  const live = await createAgent(host, 's-live')

  await host.userMessage(live)
  assert.equal(queue.length, 1)
  sweepTimer.fire()
  // The job ran (pre-submission checks passed) and queued its fulfillment
  // callback behind this continuation; the dispose listener body is
  // synchronous, so the dispose lands BEFORE the fulfillment runs.
  await Promise.resolve()
  await host.emit('agent/disposed', { agent: live })
  await new Promise((resolve) => setTimeout(resolve, 100))

  // The fulfillment re-check saw the dispose: no scan, no release, no audit.
  assert.equal(host.emitted.filter((e) => e.record?.data?.kind === 'stale-sweep').length, 0)
  assert.deepEqual(host.warns, [])
  await dispose()
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'))
  assert.equal(snapshot.payload.state.locks.length, 1)
})

// ---------- E. cross-process ----------

test('E: the client domain forwards the sweep trigger as a staleSweep channel call', async () => {
  const calls = []
  const remote = { call(agent, kind, request) { calls.push({ agent, kind, request }); return Promise.resolve({ released: [], skipped: [] }) } }
  const domain = remoteDomain(remote)
  const agent = { id: 'client-session' }
  await domain.sweepStale(agent, 'client-session')
  assert.deepEqual(calls, [{ agent, kind: 'staleSweep', request: { trigger: 'client-session' } }])
})

test('E: the publisher peer routes staleSweep to the lifecycle with the channel session as trigger', async () => {
  const seen = []
  const lifecycle = { sweepStale: async (trigger) => { seen.push(trigger); return { released: [], skipped: [] } } }
  const agent = Object.freeze({ id: 'remote-session', remote: true })
  const peer = createEditLockPeer(/** @type {any} */ (lifecycle), agent)
  const result = await peer.receive({ kind: 'staleSweep', callId: 'c1', request: {} })
  assert.deepEqual(seen, ['remote-session'])
  assert.deepEqual(result, { released: [], skipped: [] })
  assert.equal(PEER_KINDS.includes('staleSweep'), true)
})

// ---------- F. lifecycle coalescing + failure surfacing (publisher-authoritative) ----------

/** Minimal runtime double for sweep tests: one lock row with a genuinely
 * missing target (ENOENT) and a scripted releaseStale. */
function sweepRuntime(lock, releaseStale) {
  return /** @type {any} */ ({
    control: {
      status: () => ({ managerIncarnation: 'm', sessions: [{ sessionId: lock.owner, executionEpoch: 7 }], locks: [lock] }),
      releaseStale,
    },
    requests: {},
    close: async () => {},
  })
}

test('F: concurrent local and as-if-peer triggers share ONE scan; the cooldown answers without scanning', async (t) => {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-stale-life-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const missing = join(base, 'gone.txt')  // never created: ENOENT
  let clock = 5000
  let scans = 0
  let releaseCalls = 0
  /** @type {(() => void) | undefined} */
  let open
  const lock = { resourceId: missing, owner: 'dead', generation: 3, status: 'user-interrupted' }
  const runtime = sweepRuntime(lock, (/** @type {any[]} */ observed) => {
    releaseCalls++
    return new Promise((resolve) => { open = () => resolve({ released: [], skipped: observed.map((row) => ({ row, reason: 'stale row target exists again' })), failed: [] }) })
  })
  const rawStatus = runtime.control.status
  runtime.control.status = () => { scans++; return rawStatus() }
  const lifecycle = createEditLockLifecycle(runtime, () => undefined, { sweepCooldownMs: 60_000, sweepNow: () => clock })

  // A local trigger and an as-if-peer trigger landing together run one scan.
  const local = lifecycle.sweepStale('local-session')
  const peer = lifecycle.sweepStale('peer-session')
  assert.equal(scans, 1)
  assert.equal(releaseCalls, 1)
  open?.()
  const [first, joined] = await Promise.all([local, peer])
  assert.equal(joined, first)  // the in-flight trigger JOINED: same result, no extra scan

  // Inside the cooldown window a trigger is answered without scanning.
  const cooled = await lifecycle.sweepStale('another-peer')
  assert.equal(cooled.coalesced, 'cooldown')
  assert.deepEqual([cooled.released, cooled.skipped, cooled.failed], [[], [], []])
  assert.equal(scans, 1)

  // After the window the next trigger scans again.
  clock += 60_001
  const again = lifecycle.sweepStale(null)
  assert.equal(scans, 2)
  assert.equal(releaseCalls, 2)
  open?.()
  await again
  await lifecycle.close()
})

test('F: each failure earns exactly one bounded warning; skips stay quiet; releases still audit', async (t) => {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-stale-life-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const missing = join(base, 'gone.txt')
  const warns = []
  const audits = []
  const lock = { resourceId: missing, owner: 'dead', generation: 1, status: 'active' }
  const runtime = sweepRuntime(lock, async (/** @type {any[]} */ observed) => ({
    released: [{ resourceId: missing, owner: 'dead', generation: 1 }],
    skipped: [{ row: observed[0], reason: 'unresolved publication fence: retained-ownership' }],
    failed: [{ row: observed[0], reason: 'manager persistence or installation failed; poisoned' }],
  }))
  const lifecycle = createEditLockLifecycle(runtime, () => undefined, {
    warn: (/** @type {string} */ message) => warns.push(String(message)),
    onStaleRelease: (/** @type {any} */ row, /** @type {any} */ trigger) => audits.push({ row, trigger }),
  })
  const result = await lifecycle.sweepStale('trigger-session')
  assert.equal(result.failed.length, 1)
  assert.equal(result.skipped.length, 1)
  assert.equal(warns.length, 1)  // exactly one bounded warning, for the failure only
  assert.match(warns[0], /stale sweep/)
  assert.match(warns[0], /poisoned/)
  assert.match(warns[0], /gone\.txt/)
  assert.deepEqual(audits.map((entry) => [entry.row.resourceId, entry.trigger]), [[missing, 'trigger-session']])
  await lifecycle.close()
})
