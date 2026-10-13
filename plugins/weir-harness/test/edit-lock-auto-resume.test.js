// Message-driven auto-resume (design: a genuine user message to a stopped
// session resumes it and confirms its retained files before the new turn's
// first step). Composition-level: the real plugin over a fixed fixture domain,
// driven through the same ctx events the host emits. Modeled on
// edit-lock-composition.test.js (fakeHost) and edit-lock-admin-recovery.test.js
// (the revoked-authority fixture).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { recoverAuthority, recoveryConfirmation } from '../src/edit-lock/admin-recovery.js'
import { fixtureRoot as managementRootFor, fixtureEndpoint as endpointFor, fixtureExclude as excludeFromGit } from './helpers/edit-lock-fixtures.js'
const apply = createEditLockPlugin({ resolveRoot: managementRootFor, endpoint: endpointFor, exclude: excludeFromGit })
import { withSupervisedEditResume, settleDelegateEditLifecycle } from '../src/shared/delegate-edit-lifecycle.js'

const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture() {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-auto-resume-')))
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  await writeFile(join(root, 'b.txt'), 'b')
  return { base, root, directory }
}

function fakeHost(root) {
  const listeners = new Map()
  const provided = new Map()
  const agents = new Map()
  const warns = []
  let command
  // The live editLock settings section override; undefined = key absent (the
  // default-on case), { autoResume: false } = the user switched it off.
  let editLockSection
  const ctx = {
    fs: stubFs,
    logger: { warn(message) { warns.push(String(message)) } },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
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
    const created = { id, visible, session: { header: { cwd: root } }, ctx: { tools: {
      restrict({ deny }) { for (const name of deny) if (visible.get(name) === stock[name]) visible.delete(name) },
      register(definition) { visible.set(definition.name, definition); return () => visible.delete(definition.name) },
    } } }
    agents.set(id, created)
    return created
  }
  const emit = async (name, ...args) => {
    let result
    for (const fn of listeners.get(name) ?? []) result = await fn(...args, async () => ({ kind: 'allow' }))
    return result
  }
  return {
    ctx, provided, agent, emit, warns,
    command: () => command,
    setEditLockSection(section) { editLockSection = section },
    // The arming hook is the inbox intake (the durable user/message event only
    // lands mid-turn in the real runtime): the payload carries { agent, message }.
    userMessage: (agent) => emit('agent/inbox/inserted', { agent, message: { id: 'm-u', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } } }),
    injectedMessage: (agent) => emit('agent/inbox/inserted', { agent, message: { id: 'm-i', role: 'user', content: [{ type: 'text', text: 'injected' }], source: { kind: 'weir-todo-driver' } } }),
    preStep: (agent, turn, signal) => emit('agent/pre-step', { agent, turn, signal }),
  }
}

/** Mount the composition over the fixture and register one agent session. */
async function boot(host, root, directory, id = 's') {
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  const service = host.provided.get('weirEditLock')
  const agent = host.agent(id)
  await host.emit('agent/created', { agent })
  return { dispose, service, agent }
}

/** Stop the session the way the stock Stop button does: abort the turn signal. */
async function stopByUser(host, agent) {
  const control = new AbortController()
  await host.preStep(agent, undefined, control.signal)
  control.abort({ kind: 'user' })
}

test('stopped session + genuine user message: the next turn resumes and confirms retained locks before its first step', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  await stopByUser(host, agent)
  assert.equal(service.blocksContinuation(agent), true)
  assert.equal((await service.locks({ agent }))[0].status, 'user-interrupted')
  await assert.rejects(service.acquire({ agent }, { filePath: 'b.txt', cwd: root }), /was stopped/)

  // Two genuine messages: the boolean flag is consumed once (D6). The cancel
  // itself moved the epoch 1 → 2, so exactly one resume lands at 3; a second
  // attempt would have thrown and warned.
  await host.userMessage(agent)
  await host.userMessage(agent)
  await host.preStep(agent, {}, new AbortController().signal)

  assert.equal(service.blocksContinuation(agent), false)
  const status = (await service.describe(agent)).status
  assert.equal(status.state, 'active')
  assert.equal(status.executionEpoch, 3)
  assert.deepEqual(host.warns, [])
  // The retained lock went through the ordinary per-file confirmation (D3).
  const lock = (await service.locks({ agent }))[0]
  assert.equal(lock.resourceId, join(root, 'a.txt'))
  assert.equal(lock.status, 'active')
  // Editing works without any manual /edit-lock resume.
  assert.equal((await service.acquire({ agent }, { filePath: 'b.txt', cwd: root })).generation, 1)
  await dispose()
})

test('runtime-injected message (producer-tagged source) never triggers auto-resume', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  await stopByUser(host, agent)

  await host.injectedMessage(agent)
  await host.preStep(agent, {}, new AbortController().signal)

  assert.equal(service.blocksContinuation(agent), true)
  await assert.rejects(service.acquire({ agent }, { filePath: 'b.txt', cwd: root }), /was stopped/)
  assert.deepEqual(host.warns, [])
  await dispose()
})

test('editLock.autoResume === false keeps the manual path (setting read live, per message)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  host.setEditLockSection({ autoResume: false })
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  await stopByUser(host, agent)

  await host.userMessage(agent)
  await host.preStep(agent, {}, new AbortController().signal)

  assert.equal(service.blocksContinuation(agent), true)
  assert.equal((await service.locks({ agent }))[0].status, 'user-interrupted')
  assert.deepEqual(host.warns, [])
  // The manual Continue still works exactly as before.
  const resumed = await host.command().handler({ agent, rawInput: 'resume', commandId: 'c1' })
  assert.equal(resumed.kind, 'success', resumed.text)
  await dispose()
})

test('zero-lock stopped session auto-resumes too (the latch is session-level)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  await stopByUser(host, agent)
  assert.equal(service.blocksContinuation(agent), true)
  assert.equal((await service.locks({ agent })).length, 0)

  await host.userMessage(agent)
  await host.preStep(agent, {}, new AbortController().signal)

  assert.equal(service.blocksContinuation(agent), false)
  assert.deepEqual(host.warns, [])
  assert.equal((await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })).generation, 1)
  await dispose()
})

test('race with the manual Continue is idempotent in both directions; no crash, no warn', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  await stopByUser(host, agent)

  // Manual wins: the flag is consumed by the next pre-step, blocks() is already
  // false, no second resume is attempted.
  await host.userMessage(agent)
  assert.equal((await host.command().handler({ agent, rawInput: 'resume', commandId: 'c1' })).kind, 'success')
  assert.equal((await host.command().handler({ agent, rawInput: 'confirm --all', commandId: 'c2' })).kind, 'success')
  await host.preStep(agent, {}, new AbortController().signal)
  assert.equal(service.blocksContinuation(agent), false)
  assert.deepEqual(host.warns, [])

  // Auto wins: the manual resume afterwards loses with 'agent is not interrupted'.
  await stopByUser(host, agent)
  await host.userMessage(agent)
  await host.preStep(agent, {}, new AbortController().signal)
  assert.equal(service.blocksContinuation(agent), false)
  const lost = await host.command().handler({ agent, rawInput: 'resume', commandId: 'c3' })
  assert.equal(lost.kind, 'error')
  assert.match(lost.text, /not interrupted/)
  assert.deepEqual(host.warns, [])
  await dispose()
})

/** A revoked authority for session 's' (one ADMIN OVERRIDE over its unknown
 * operation), built exactly like edit-lock-admin-recovery.test.js. */
async function revokedAuthority(root) {
  const directory = join(root, '.weir', 'edit-lock')
  await mkdir(directory, { recursive: true })
  const target = join(root, 'a.txt')
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  const manager = createEditLockManager({ store, managerIncarnation: 'historic' })
  const execution = await manager.openSession('s')
  const token = await manager.acquire(execution, target)
  const request = { operationId: 'unknown-op', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
  const ready = await manager.prepare(execution, request, { validate() {}, publish: async () => { throw new Error('unknown writer outcome') }, identify: () => target })
  await assert.rejects(manager.commit(ready.submission), /unknown writer outcome/)
  await manager.cancel(execution)
  const before = store.snapshot()
  await manager.close(); await store.close()
  const input = { root, recoveryId: `admin-auto-resume-${crypto.randomUUID()}`, expectedRevision: before.revision, owner: 's',
    operationIds: ['unknown-op'], reason: 'Operator accepts residual late writer risk', acceptLateWriterRisk: true }
  input.confirmation = recoveryConfirmation(input)
  await recoverAuthority(input)
  return directory
}

test('a revoked session is repaired by a genuine user message: silent resume, empty confirmation, audited', async (t) => {
  const { root } = await fixture()
  const directory = await revokedAuthority(root)
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  assert.equal(service.blocksContinuation(agent), true)
  const revoked = (await service.describe(agent)).status
  assert.equal(revoked.revoked, true)
  const revokedEpoch = revoked.executionEpoch
  const ledgerBefore = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8')).payload.state.adminRecoveries

  await host.userMessage(agent)
  await host.preStep(agent, {}, new AbortController().signal)

  // One genuine message silently repairs: the resume commits, the epoch
  // advances past the revokedEpoch, and zero retained locks confirm the empty
  // set — no revoked branch in auto-resume, the ordinary path suffices.
  assert.equal(service.blocksContinuation(agent), false)
  assert.deepEqual(host.warns, [])
  const status = (await service.describe(agent)).status
  assert.equal(status.state, 'active')
  assert.equal(status.revoked, false)
  assert.equal(status.executionEpoch, revokedEpoch + 1)
  assert.equal(status.locks.length, 0)
  assert.equal((await service.acquire({ agent }, { filePath: 'b.txt', cwd: root })).generation, 1)
  // The ledger record is preserved byte-identically; the repair is audited
  // through the shared maintenance channel, never the session log.
  const after = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8')).payload.state
  assert.deepEqual(after.adminRecoveries, ledgerBefore)
  const mirror = await readFile(join(root, '.weir', 'audit.jsonl'), 'utf8')
  assert.match(mirror, /"kind":"revocation-repaired"/)
  assert.match(mirror, /"trigger":"auto"/)
  await dispose()
})

test('an injected message never repairs a revoked session', async (t) => {
  const { root } = await fixture()
  const directory = await revokedAuthority(root)
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  await host.injectedMessage(agent)
  await host.preStep(agent, {}, new AbortController().signal)
  assert.equal(service.blocksContinuation(agent), true)
  assert.equal((await service.describe(agent)).status.revoked, true)
  assert.deepEqual(host.warns, [])
  await dispose()
})

test('an explicit supervised Continue repairs a revoked session (manual trigger); a re-created agent inherits the repair', async (t) => {
  const { root } = await fixture()
  const directory = await revokedAuthority(root)
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  assert.equal(service.blocksContinuation(agent), true)
  await withSupervisedEditResume(agent, agent.id, async () => {
    assert.equal(service.blocksContinuation(agent), false)
  })
  assert.equal((await service.describe(agent)).status.revoked, false)
  const mirror = await readFile(join(root, '.weir', 'audit.jsonl'), 'utf8')
  assert.match(mirror, /"kind":"revocation-repaired"/)
  assert.match(mirror, /"trigger":"manual"/)
  // A re-created agent of the repaired session is an ordinary interrupted
  // session: not revoked, resumable through the ordinary trusted path.
  await host.emit('agent/disposed', { agent })
  await settleDelegateEditLifecycle(agent, agent.id)
  const replacement = host.agent(agent.id)
  await host.emit('agent/created', { agent: replacement })
  const restarted = (await service.describe(replacement)).status
  assert.equal(restarted.revoked, false)
  assert.equal(restarted.state, 'stopped')
  await withSupervisedEditResume(replacement, replacement.id, async () => {})
  assert.equal((await service.describe(replacement)).status.state, 'active')
  await dispose()
})
for (const interruption of ['user', 'restart']) test(`explicit supervised resume restores ${interruption} interruption without confirming files`, async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const first = await boot(host, root, directory)
  await first.service.acquire({ agent: first.agent }, { filePath: 'a.txt', cwd: root })
  let current = first
  if (interruption === 'restart') {
    await first.dispose()
    current = await boot(host, root, directory)
  } else await stopByUser(host, first.agent)
  t.after(() => current.dispose())
  const { agent, service } = current
  await host.injectedMessage(agent)
  await host.preStep(agent, {}, new AbortController().signal)
  assert.equal(service.blocksContinuation(agent), true)
  await withSupervisedEditResume(agent, agent.id, async () => {
    assert.equal(service.blocksContinuation(agent), false)
    assert.equal((await service.describe(agent)).status.locks[0].status, 'pending-confirmation')
  })
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  assert.equal((await service.describe(agent)).status.locks[0].status, 'active')
})

for (const state of ['active', 'stopped', 'abnormal']) test(`delegate terminal settlement preserves dispose semantics for ${state}`, async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  if (state === 'stopped') await stopByUser(host, agent)
  if (state === 'abnormal') await host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'NETWORK', message: 'provider unavailable' } } } })
  await host.emit('agent/disposed', { agent })
  await settleDelegateEditLifecycle(agent, agent.id)
  await host.emit('agent/disposed', { agent })
  const other = host.agent('other')
  await host.emit('agent/created', { agent: other })
  const locks = await service.locks({ agent: other })
  if (state === 'active') {
    assert.deepEqual(locks, [])
    await service.acquire({ agent: other }, { filePath: 'a.txt', cwd: root })
  } else {
    assert.equal(locks.length, 1)
    assert.equal(locks[0].status, state === 'stopped' ? 'user-interrupted' : 'abnormal')
  }
})

test('LlmFailure is abnormal, not user Stop; teardown and cold registration are independent interruption sources', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  await host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'NETWORK', message: 'provider unavailable' } } } })
  for (let attempt = 0; attempt < 100 && (await service.describe(agent)).status.state === 'active'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const status = (await service.describe(agent)).status
  assert.equal(status.state, 'recovering')
  assert.equal(status.interrupted, false)
  assert.equal(status.locks[0].status, 'abnormal')
  await host.emit('agent/disposed', { agent })
  await settleDelegateEditLifecycle(agent, agent.id)
  const replacement = host.agent(agent.id)
  await host.emit('agent/created', { agent: replacement })
  assert.equal((await service.describe(replacement)).status.state, 'stopped')
  await withSupervisedEditResume(replacement, replacement.id, async () => {})
  assert.equal((await service.describe(replacement)).status.state, 'active')
})

test('explicit supervised resume covers cold activation only inside its delivery window', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent: parent } = await boot(host, root, directory, 'parent')
  t.after(() => dispose())
  const child = host.agent('cold-child')
  await host.emit('agent/created', { agent: child })
  await service.acquire({ agent: child }, { filePath: 'a.txt', cwd: root })
  await stopByUser(host, child)
  await host.emit('agent/disposed', { agent: child })
  await settleDelegateEditLifecycle(parent, child.id)
  let replacement
  await withSupervisedEditResume(parent, child.id, async () => {
    replacement = host.agent(child.id)
    await host.emit('agent/created', { agent: replacement })
    assert.equal((await service.describe(replacement)).status.state, 'active')
    assert.equal((await service.describe(replacement)).status.locks[0].status, 'pending-confirmation')
  })
  await host.emit('agent/disposed', { agent: replacement ?? child })
  await settleDelegateEditLifecycle(parent, child.id)
  const later = host.agent(child.id)
  await host.emit('agent/created', { agent: later })
  assert.equal((await service.describe(later)).status.state, 'stopped')
})

for (const cold of [false, true]) test(`failed supervised delivery revokes restored authority (${cold ? 'cold' : 'live'})`, async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent: parent } = await boot(host, root, directory, 'parent')
  t.after(dispose)
  let child = host.agent('child')
  await host.emit('agent/created', { agent: child })
  await service.acquire({ agent: child }, { filePath: 'a.txt', cwd: root })
  await stopByUser(host, child)
  if (cold) {
    await host.emit('agent/disposed', { agent: child })
    await settleDelegateEditLifecycle(parent, child.id)
  }
  await assert.rejects(withSupervisedEditResume(parent, child.id, async () => {
    if (cold) {
      child = host.agent(child.id)
      await host.emit('agent/created', { agent: child })
    }
    assert.equal(service.blocksContinuation(child), false)
    throw new Error('delivery rejected')
  }), /delivery rejected/)
  assert.equal(service.blocksContinuation(child), true)
  assert.equal((await service.describe(child)).status.interrupted, true)
  await assert.rejects(service.acquire({ agent: child }, { filePath: 'b.txt', cwd: root }), /was stopped/)
  await host.injectedMessage(child)
  await host.preStep(child, {}, new AbortController().signal)
  assert.equal(service.blocksContinuation(child), true)
  // The failed attempt must also clear the transient delivery window.
  await withSupervisedEditResume(parent, child.id, async () => {})
  assert.equal((await service.describe(child)).status.locks[0].status, 'pending-confirmation')
})

for (const end of ['completed', 'error', 'aborted']) test(`subagent/end uses child id and preserves ${end} classification`, async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent: child } = await boot(host, root, directory, 'child')
  t.after(dispose)
  const parent = host.agent('parent')
  await host.emit('agent/created', { agent: parent })
  await service.acquire({ agent: child }, { filePath: 'a.txt', cwd: root })
  await service.acquire({ agent: parent }, { filePath: 'b.txt', cwd: root })
  if (end === 'aborted') await stopByUser(host, child)
  // Dispatch classification and terminal notification in the same tick: the
  // emit event does not await asynchronous listeners in the real host.
  const classification = host.emit('session/event', { id: child.id }, {
    type: 'turn/end', data: { reason: end === 'error'
      ? { kind: 'error', error: { code: 'NETWORK', message: 'offline' } }
      : end === 'aborted' ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' } },
  })
  await host.emit('subagent/end', { id: child.id, runId: parent.id, stopReason: end })
  await classification
  const before = await service.locks({ agent: parent })
  await host.emit('agent/disposed', { agent: child })
  await host.emit('agent/disposed', { agent: child })
  assert.deepEqual(await service.locks({ agent: parent }), before)
  assert.equal(before.find(lock => lock.owner === parent.id).status, 'active')
  if (end === 'completed') {
    assert.equal(before.some(lock => lock.owner === child.id), false)
    await service.acquire({ agent: parent }, { filePath: 'a.txt', cwd: root })
  } else assert.equal(before.find(lock => lock.owner === child.id).status, end === 'error' ? 'abnormal' : 'user-interrupted')
})

test('a continuable nonterminal turn and unknown terminal notification do not dispose its domain', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(dispose)
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  await host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
  await host.emit('subagent/end', { id: agent.id, stopReason: undefined })
  assert.equal(service.blocksContinuation(agent), false)
  assert.equal((await service.locks({ agent }))[0].status, 'active')
  await service.acquire({ agent }, { filePath: 'b.txt', cwd: root })
})
