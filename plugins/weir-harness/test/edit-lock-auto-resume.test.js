// Message-driven auto-resume (design: a genuine user message to a stopped
// session resumes it and confirms its retained files before the new turn's
// first step). Composition-level: the real plugin over a fixed fixture domain,
// driven through the same ctx events the host emits. Modeled on
// edit-lock-composition.test.js (fakeHost) and edit-lock-admin-recovery.test.js
// (the revoked-authority fixture).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { recoverAuthority, recoveryConfirmation } from '../src/edit-lock/admin-recovery.js'
import { fixtureRoot as managementRootFor, fixtureEndpoint as endpointFor, fixtureExclude as excludeFromGit } from './helpers/edit-lock-fixtures.js'
const apply = createEditLockPlugin({ resolveRoot: managementRootFor, endpoint: endpointFor, exclude: excludeFromGit })

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

test('a revoked session stays terminal: auto-resume fails warn-only and edits stay denied', async (t) => {
  const { root } = await fixture()
  // Revocation exists only as an administrative recovery over an interrupted
  // owner with unknown-history operations; build that authority first, then
  // mount the composition over it (modeled on edit-lock-admin-recovery.test.js).
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
  const input = { root, recoveryId: 'admin-auto-resume-test', expectedRevision: before.revision, owner: 's',
    operationIds: ['unknown-op'], reason: 'Operator accepts residual late writer risk', acceptLateWriterRisk: true }
  input.confirmation = recoveryConfirmation(input)
  await recoverAuthority(input)

  const host = fakeHost(root)
  const { dispose, service, agent } = await boot(host, root, directory)
  t.after(() => dispose())
  assert.equal(service.blocksContinuation(agent), true)

  await host.userMessage(agent)
  await host.preStep(agent, {}, new AbortController().signal)

  assert.equal(service.blocksContinuation(agent), true)
  assert.equal((await service.describe(agent)).status.revoked, true)
  assert.equal(host.warns.length, 1)
  assert.match(host.warns[0], /auto-resume failed/)
  assert.match(host.warns[0], /permanently revoked/)
  await assert.rejects(service.acquire({ agent }, { filePath: 'b.txt', cwd: root }), /was stopped/)
  await dispose()
})
