// Binding self-heal (change edit-lock-binding-self-heal, design D1-D4):
// re-entrant per-agent setup across preset generations (D3), event-driven
// re-bind on `agent-preset/selected` (D1), lazy re-bind at the write guard and
// the service surface (D2/D2'), the fourfold failure record (D4) and
// concurrent-setup idempotency. Composition-level: the real plugin over a
// fixed fixture domain, driven through the same ctx events the host emits.
// Modeled on edit-lock-composition.test.js (fakeHost) and
// edit-lock-auto-resume.test.js; the agent scope registry here is STRICT — a
// second registration of the same tool name throws, like dsh-scope — so a
// re-setup that forgot to retire the previous generation's layer fails loudly.
import { test, expect } from './helpers.js'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { writeScopesFor, disposeWriteScope } from '../src/edit-lock/write-scopes.js'
import { fixtureRoot as managementRootFor, fixtureEndpoint as endpointFor, fixtureExclude as excludeFromGit } from './helpers/edit-lock-fixtures.js'
import assert from 'node:assert/strict'
import { createRemoteEditLockDomain } from '../src/edit-lock/remote.js'
import { registerBindingRuntime } from '../src/edit-lock/binding-attestation.js'
const apply = createEditLockPlugin({ resolveRoot: managementRootFor, endpoint: endpointFor, exclude: excludeFromGit })

const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture() {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-self-heal-')))
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  return { base, root, directory }
}

/** Host double. Options:
 *  - host: the shared host-root key for the host-lifetime write-scope store
 *    (two generations of one agent must share it, default: fresh per host);
 *  - agents: expose an agents registry ({ roots, get }) at ctx.get('agents');
 *  - presets: expose an agentPresets registry; `own(agent)` marks an agent as
 *    belonging to THIS mount (identity-compared service resolution). */
function fakeHost(root, { host: hostKey = {}, agents: withAgents = false, presets: withPresets = false } = {}) {
  const listeners = new Map()
  const provided = new Map()
  const agents = new Map()
  const ownAgents = new Set()
  const warns = []
  const emitted = []
  const sessionFailures = []
  const toolDefinitions = new Map()
  let command
  const ctx = {
    root: hostKey,
    fs: stubFs,
    logger: { warn(message) { warns.push(String(message)) } },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    emit(type, record) { emitted.push({ type, record }) },
    reflect: { provide(name, value) { provided.set(name, value) } },
    get(name) {
      if (name === 'commands') return { register(definition) { command = definition; return () => { command = undefined } } }
      if (name === 'agents') return withAgents ? { roots: () => [...agents.values()], get: id => agents.get(id) } : undefined
      if (name === 'weirSettings') return {
        get: section => (section === 'editLock' ? editLockSection : undefined),
        editLockEvidence: { recordMount: () => ({ recordSessionFailure: (id, reason) => sessionFailures.push([id, reason]), recordDomain() {}, installed() {}, disposing() {}, dispose() {}, failed() {} }) },
      }
      return provided.get(name)
    },
    tools: { get(name, agent) { return agent.visible.get(name) }, register(definition) { toolDefinitions.set(definition.name, definition); return () => toolDefinitions.delete(definition.name) } },
  }
  if (withPresets) {
    // Identity comparison, exactly like agentPresets.serviceFor in production:
    // only an agent of THIS mount resolves this exact service object.
    provided.set('agentPresets', {
      serviceFor: (agent, name) => (name === 'weirEditLock' && ownAgents.has(agent) ? provided.get('weirEditLock') : undefined),
    })
  }
  const stock = { write: { name: 'write', execute() {} }, edit: { name: 'edit', execute() {} } }
  function agent(id, { delegationDepth = 0 } = {}) {
    const visible = new Map(Object.entries(stock))
    const created = {
      id, visible, status: 'idle', injects: [],
      session: { header: { cwd: root, ...(delegationDepth > 0 ? { delegationDepth } : {}) } },
      inject(message) { created.injects.push(message) },
      followup(message) { created.injects.push(message) },
      ctx: { tools: {
        registrations: 0,
        restrict({ deny }) { for (const name of deny) if (visible.get(name) === stock[name]) visible.delete(name) },
        // Strict dsh-scope semantics: re-registering a live name in the agent's
        // own layer throws duplicate-registration.
        register(definition) {
          created.ctx.tools.registrations++
          if (visible.has(definition.name)) throw new Error(`duplicate registration of tool "${definition.name}"`)
          visible.set(definition.name, definition)
          return () => visible.delete(definition.name)
        },
      } },
    }
    agents.set(id, created)
    return created
  }
  const emit = async (name, ...args) => {
    let result
    for (const fn of listeners.get(name) ?? []) result = await fn(...args, async () => ({ kind: 'allow' }))
    return result
  }
  const own = candidate => { ownAgents.add(candidate); return candidate }
  let editLockSection
  return { ctx, provided, agent, own, emit, warns, emitted, sessionFailures, toolDefinitions, command: () => command, setEditLockSection(section) { editLockSection = section } }
}

function mount(host, root, directory) {
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  return { dispose, service: host.provided.get('weirEditLock') }
}

/** The domain start is the async tail of an otherwise synchronous setup. */
async function untilSettled(service, agent) {
  for (let i = 0; i < 200 && service.blocksContinuation(agent); i++) await new Promise(resolve => setTimeout(resolve, 10))
}

/** An own-scope stock writer the write-scope install cannot exclusively
 *  replace: installation registers, fails the exclusivity check and throws. */
function breakWriteScope(agent) {
  agent.visible.set('edit', { name: 'edit', execute() {} })
}

// --- D3 primitives: the host-lifetime write-scope store --------------------

test('writeScopesFor keys one store per host; disposeWriteScope is idempotent and swallows disposal failures (design D3)', () => {
  const hostA = {}, hostB = {}
  expect(writeScopesFor(hostA)).toBe(writeScopesFor(hostA))
  expect(writeScopesFor(hostA)).not.toBe(writeScopesFor(hostB))

  const scopes = writeScopesFor({})
  const agent = {}
  disposeWriteScope(scopes, agent) // no entry: a no-op, never a throw

  let disposals = 0
  scopes.set(agent, { owner: {}, dispose() { disposals++ } })
  disposeWriteScope(scopes, agent)
  expect(disposals).toBe(1)
  expect(scopes.get(agent)).toBeUndefined()
  disposeWriteScope(scopes, agent) // already forgotten: no second disposal
  expect(disposals).toBe(1)

  // A stale layer must never block re-installation: the failure is swallowed
  // and the entry is gone, so the next setup registers cleanly.
  scopes.set(agent, { owner: {}, dispose() { throw new Error('stale layer refuses to die') } })
  disposeWriteScope(scopes, agent)
  expect(scopes.get(agent)).toBeUndefined()
})

test('agent/disposed retires the host-lifetime write scope with the agent (design D3)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose } = mount(host, root, directory)
  t.after(() => dispose())
  const agent = host.agent('s')
  await host.emit('agent/created', { agent })
  expect(agent.visible.has('write')).toBe(true)

  await host.emit('agent/disposed', { agent })

  // The managed write lived on the agent's own scope layer, which dies with
  // the agent: the registration is retired here, not left to leak into a
  // future agent that reuses nothing but the host store.
  expect(agent.visible.has('write')).toBe(false)
  await dispose()
})

test('a second generation re-setup disposes the orphaned managed write before registering — no duplicate registration (design D3)', async (t) => {
  const { root, directory } = await fixture()
  const sharedHost = {}
  // Generation 1 binds the agent, then unmounts. Unmount deliberately leaves
  // the managed write in the agent's OWN scope layer (a preset rebind never
  // disposes own-layer registrations).
  const gen1 = fakeHost(root, { host: sharedHost })
  const first = mount(gen1, root, directory)
  t.after(() => first.dispose())
  const agent = gen1.agent('s')
  await gen1.emit('agent/created', { agent })
  const staleWrite = agent.visible.get('write')
  expect(staleWrite).toBeTruthy()
  expect(agent.ctx.tools.registrations).toBe(1)
  await first.dispose()
  expect(agent.visible.get('write')).toBe(staleWrite)

  // Generation 2 (the preset switch landed): the same agent is set up again
  // through the same host-lifetime store. The stale layer is retired FIRST,
  // so the strict scope registry sees no duplicate and the re-bind succeeds.
  const gen2 = fakeHost(root, { host: sharedHost })
  const second = mount(gen2, root, directory)
  t.after(() => second.dispose())
  await gen2.emit('agent/created', { agent })

  const managedWrite = agent.visible.get('write')
  expect(managedWrite).toBeTruthy()
  expect(managedWrite).not.toBe(staleWrite)
  expect(agent.ctx.tools.registrations).toBe(2) // exactly one install per generation
  expect(gen2.warns.filter(message => /scope failed|duplicate/.test(message))).toHaveLength(0)
  // The rebound domain is real: describe answers through the registry binding.
  // (The session itself restarts interrupted in the recovered authority —
  // continuation gating is the resume flow's business, not the re-bind's.)
  expect((await second.service.describe(agent)).root).toBe(root)
  expect((await gen2.emit('tools/pre-execute', { name: 'write', agent })).kind).toBe('allow')
  await second.dispose()
})

// --- D2: lazy re-bind at the pre-execute guard (four quadrants) -------------

test('guard quadrant (a): an own-preset root agent orphaned without a binding is lazy-bound and admitted (design D2)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root, { presets: true })
  const { dispose, service } = mount(host, root, directory)
  t.after(() => dispose())
  // Orphaned by a blank-window preset switch: created while no agent/created
  // reached this generation, so no binding exists when the first write arrives.
  const agent = host.own(host.agent('s'))

  const verdict = await host.emit('tools/pre-execute', { name: 'write', agent })

  expect(verdict.kind).toBe('allow')
  expect(agent.ctx.tools.registrations).toBe(1)
  expect(service.blocksContinuation(agent)).toBe(false)
  // The bind is real, not a one-shot admission: acquisition goes through the domain.
  expect((await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })).generation).toBe(1)
  // A later guarded call short-circuits on the existing binding: no re-setup.
  expect((await host.emit('tools/pre-execute', { name: 'write', agent })).kind).toBe('allow')
  expect(agent.ctx.tools.registrations).toBe(1)
  expect(host.warns).toHaveLength(0)
  await dispose()
})

test('guard quadrant (b): a failed lazy re-bind denies with reason and recovery, and never retries within the generation (design D2/D4)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root, { presets: true })
  const { dispose } = mount(host, root, directory)
  t.after(() => dispose())
  const broken = host.own(host.agent('broken'))
  breakWriteScope(broken)

  const first = await host.emit('tools/pre-execute', { name: 'write', agent: broken })

  expect(first.kind).toBe('deny')
  expect(first.reason).toContain('no Edit Lock domain')
  expect(first.reason).toContain('did not exclusively replace')
  expect(first.reason).toContain('Recovery: restart DeepSeek Harness or start a new conversation')

  // The recorded failure suppresses retries for the rest of this mount
  // generation: identical denial, and setup ran exactly once.
  const second = await host.emit('tools/pre-execute', { name: 'write', agent: broken })
  expect(second.kind).toBe('deny')
  expect(second.reason).toBe(first.reason)
  expect(broken.ctx.tools.registrations).toBe(1)
  expect(host.warns.filter(message => /edit lock scope failed/.test(message))).toHaveLength(1)
  await dispose()
})

test('guard quadrant (c): a foreign-preset agent is never lazy-bound — the stock refusal stands (design D2)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root, { presets: true })
  const { dispose } = mount(host, root, directory)
  t.after(() => dispose())
  // NOT marked own: the own-preset fence fails before any attempt is made.
  const foreign = host.agent('foreign')

  const verdict = await host.emit('tools/pre-execute', { name: 'write', agent: foreign })

  expect(verdict.kind).toBe('deny')
  expect(verdict.reason).toContain('not routed through Edit Lock')
  expect(foreign.ctx.tools.registrations).toBe(0)
  expect(foreign.visible.get('write')).toBeTruthy() // stock writers untouched
  expect(host.warns).toHaveLength(0)
  await dispose()
})

test('guard quadrant (d): a delegated sub-agent is never lazy-bound (design D2)', async (t) => {
  const { root, directory } = await fixture()
  // No preset registry: ownAgent is unconditionally true, so delegationDepth
  // is the only thing that can (and must) stop the lazy re-bind.
  const host = fakeHost(root)
  const { dispose } = mount(host, root, directory)
  t.after(() => dispose())
  const child = host.agent('child', { delegationDepth: 1 })

  const verdict = await host.emit('tools/pre-execute', { name: 'write', agent: child })

  expect(verdict.kind).toBe('deny')
  expect(verdict.reason).toContain('not routed through Edit Lock')
  expect(child.ctx.tools.registrations).toBe(0)
  expect(host.warns).toHaveLength(0)
  await dispose()
})

// --- D2': lazy re-bind on the service surface (domainFor) -------------------

test('service calls lazy-bind an unbound own agent once; a recorded failure reports reason and recovery (design D2)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service } = mount(host, root, directory)
  t.after(() => dispose())

  // A batch/read tool on an orphaned own agent triggers the same one-shot
  // re-setup the write guard would, then answers normally.
  const agent = host.agent('s')
  expect(await service.locks({ agent })).toEqual([])
  expect(agent.ctx.tools.registrations).toBe(1)
  expect(service.blocksContinuation(agent)).toBe(false)
  expect((await host.emit('tools/pre-execute', { name: 'write', agent })).kind).toBe('allow')
  expect(agent.ctx.tools.registrations).toBe(1)

  // An agent whose setup already failed this generation gets the recorded
  // reason and the recovery action from every service path — and no retry.
  const broken = host.agent('broken')
  breakWriteScope(broken)
  await host.emit('agent/created', { agent: broken })
  await expect(() => service.locks({ agent: broken })).rejects.toThrow(/no Edit Lock domain/)
  await expect(() => service.locks({ agent: broken })).rejects.toThrow(/did not exclusively replace/)
  await expect(() => service.locks({ agent: broken })).rejects.toThrow(/Recovery: restart DeepSeek Harness or start a new conversation/)
  expect(broken.ctx.tools.registrations).toBe(1)
  await dispose()
})

// --- D1: event-driven re-bind on agent-preset/selected ----------------------

test('agent-preset/selected re-binds an own root agent idempotently, ignores foreign agents, and returns undefined (design D1)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root, { agents: true, presets: true })
  const { dispose, service } = mount(host, root, directory)
  t.after(() => dispose())
  // Created under the previous generation: no agent/created reached this mount.
  const own = host.own(host.agent('own'))
  const foreign = host.agent('foreign')
  expect(service.blocksContinuation(own)).toBe(true)

  // Serial-bail discipline: the listener returns undefined, never a promise.
  const result = await host.emit('agent-preset/selected', 'own')
  expect(result).toBeUndefined()
  expect(own.ctx.tools.registrations).toBe(1)
  await untilSettled(service, own)
  expect(service.blocksContinuation(own)).toBe(false)

  // Repeated events are idempotent: the root binding short-circuits the
  // re-setup, so no second install, bind or domain start happens.
  await host.emit('agent-preset/selected', 'own')
  await host.emit('agent-preset/selected', 'own')
  expect(own.ctx.tools.registrations).toBe(1)
  expect((await host.emit('tools/pre-execute', { name: 'write', agent: own })).kind).toBe('allow')

  // A switch event for a foreign-preset session changes nothing at all.
  await host.emit('agent-preset/selected', 'foreign')
  expect(foreign.ctx.tools.registrations).toBe(0)
  expect(service.blocksContinuation(foreign)).toBe(true)
  await expect(() => service.describe(foreign)).rejects.toThrow(/no Edit Lock domain/)

  // Unknown or malformed session ids are ignored without a sound.
  await host.emit('agent-preset/selected', 'nobody')
  await host.emit('agent-preset/selected', { id: 'own' })
  expect(host.warns).toHaveLength(0)
  await dispose()
})

// --- D4: the fourfold failure record ----------------------------------------

test('a failed write-scope install leaves the fourfold record — panel state, evidence, notice, audit — and keeps the warn (design D4)', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root)
  const { dispose, service } = mount(host, root, directory)
  t.after(() => dispose())
  const broken = host.agent('broken')
  breakWriteScope(broken)

  await host.emit('agent/created', { agent: broken })

  // 1. Panel state: the recorded startFailures reason surfaces on every
  //    service path instead of a reasonless "starting".
  await expect(() => service.describe(broken)).rejects.toThrow(/no Edit Lock domain/)
  await expect(() => service.describe(broken)).rejects.toThrow(/did not exclusively replace/)
  // 2. Maintenance evidence for the settings maintenance panel.
  expect(host.sessionFailures).toEqual([['broken', 'edit lock scope did not exclusively replace stock writers']])
  // 3. In-session notice with the recovery action.
  expect(broken.injects).toHaveLength(1)
  expect(broken.injects[0].content[0].text).toContain('Edit Lock is unavailable for this session')
  expect(broken.injects[0].content[0].text).toContain('the failed edit must not be retried')
  expect(broken.injects[0].content[0].text).toContain('not repaired automatically')
  // 4. Cold-safe audit: the cordis event and its JSONL mirror.
  const records = host.emitted.filter(entry => entry.type === 'weir/edit-lock-maintenance')
  expect(records).toHaveLength(1)
  expect(records[0].record.data).toEqual({ kind: 'setup-failed', sessionId: 'broken', reason: 'edit lock scope did not exclusively replace stock writers' })
  const mirror = await readFile(join(root, '.weir', 'audit.jsonl'), 'utf8')
  expect(mirror).toContain('"kind":"setup-failed"')
  // The warn stays as the host ring-buffer copy.
  expect(host.warns.filter(message => /edit lock scope failed; edit tools denied/.test(message))).toHaveLength(1)
  await dispose()
})

// --- Concurrent setup idempotency -------------------------------------------

test('concurrent setup entry points share one in-flight setup: the write scope installs exactly once', async (t) => {
  const { root, directory } = await fixture()
  const host = fakeHost(root, { agents: true })
  const { dispose, service } = mount(host, root, directory)
  t.after(() => dispose())
  const agent = host.agent('s')

  // Creation (twice), a preset switch and a guarded write race one another;
  // every path funnels into the same per-agent setup.
  const [, , , verdict] = await Promise.all([
    host.emit('agent/created', { agent }),
    host.emit('agent/created', { agent }),
    host.emit('agent-preset/selected', 's'),
    host.emit('tools/pre-execute', { name: 'write', agent }),
  ])

  expect(agent.ctx.tools.registrations).toBe(1)
  expect(verdict.kind).toBe('allow')
  expect(service.blocksContinuation(agent)).toBe(false)
  expect(host.warns).toHaveLength(0)
  expect((await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })).generation).toBe(1)
  await dispose()
})

test('explicit retry recovers the original failed Agent without reinstalling writers or resuming authority', async () => {
  const { root, directory } = await fixture()
  const host = fakeHost(root, { agents: true, presets: true })
  const { dispose, service } = mount(host, root, directory)
  let token, unregister = () => {}
  const remote = createRemoteEditLockDomain(endpointFor(directory), { onNotice() {}, onChannelOpen(nonce) { token = nonce; return () => unregister() } })
  try {
    const other = host.own(host.agent('other'))
    await host.emit('agent/created', { agent: other })
    const old = { id: 's' }
    await remote.channelFor(old)
    await remote.call(old, 'acquire', { filePath: 'a.txt', cwd: root })
    const agent = host.own(host.agent('s'))
    await host.emit('agent/created', { agent })
    assert.equal(service.blocksContinuation(agent), true)
    const diagnostic = await host.toolDefinitions.get('edit_lock_status').execute({}, { agent })
    assert.equal(diagnostic.state, 'unavailable')
    assert.equal(diagnostic.bindingFailure.code, 'binding-duplicate')
    assert.equal(diagnostic.bindingFailure.retryable, true)
    assert.match(diagnostic.message, /edit-lock retry/)
    assert.equal(diagnostic.locks, undefined)
    await assert.rejects(service.acquire({ agent }, { filePath: 'a.txt', cwd: root }), /retried automatically when the user next sends a message/)
    const writer = agent.visible.get('write')
    const retry = () => host.command().handler({ agent, rawInput: 'retry', commandId: crypto.randomUUID() })
    assert.equal((await retry()).kind, 'error')
    const presets = host.provided.get('agentPresets'), serviceFor = presets.serviceFor
    presets.serviceFor = () => undefined
    assert.match((await retry()).text, /current live Agent/)
    assert.equal((await remote.call(old, 'status')).state, 'active')
    presets.serviceFor = serviceFor
    unregister = registerBindingRuntime(token, old, old.id)
    const replies = await Promise.all([retry(), retry()])
    assert.deepEqual(replies.map(reply => reply.kind), ['success', 'success'], JSON.stringify(replies))
    assert.equal(agent.visible.get('write'), writer)
    assert.equal(agent.ctx.tools.registrations, 1)
    const actual = await service.describe(agent)
    assert.equal(actual.status.state, 'stopped')
    assert.equal(actual.status.locks[0].generation, 1)
    await assert.rejects(service.acquire({ agent }, { filePath: 'a.txt', cwd: root }), /stopped/)
    assert.equal(service.blocksContinuation(agent), true)
  } finally { remote.close(); await dispose() }
})

test('retry never joins an unrelated initial setup without a classified binding failure', async () => {
  const { root, directory } = await fixture()
  const host = fakeHost(root, { agents: true })
  const { dispose } = mount(host, root, directory)
  try {
    const agent = host.agent('s')
    const initial = host.emit('agent/created', { agent })
    const result = await host.command().handler({ agent, rawInput: 'retry', commandId: 'no-failure' })
    await initial
    assert.equal(result.kind, 'error')
    assert.match(result.text, /not eligible/)
  } finally { await dispose() }
})

test('retry cannot carry a failed-binding user message into a later injected wake', async () => {
  const { root, directory } = await fixture()
  const host = fakeHost(root, { agents: true, presets: true })
  const { dispose, service } = mount(host, root, directory)
  let nonce, unregister = () => {}
  const remote = createRemoteEditLockDomain(endpointFor(directory), { onNotice() {}, onChannelOpen(token) { nonce = token; return () => unregister() } })
  try {
    const publisherAgent = host.own(host.agent('publisher'))
    await host.emit('agent/created', { agent: publisherAgent })
    const old = { id: 's' }
    await remote.channelFor(old)
    await remote.call(old, 'acquire', { filePath: 'a.txt', cwd: root })
    const agent = host.own(host.agent('s'))
    await host.emit('agent/created', { agent })
    assert.equal(service.blocksContinuation(agent), true)
    await host.emit('agent/inbox/inserted', { agent, message: { id: 'u-before', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } } })
    await host.emit('agent/pre-step', { agent, turn: {}, signal: new AbortController().signal })
    await host.emit('session/event', { id: 's' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    unregister = registerBindingRuntime(nonce, old, old.id)
    const retried = await host.command().handler({ agent, rawInput: 'retry', commandId: 'retry-after-failed-turn' })
    assert.equal(retried.kind, 'success', retried.text)
    const before = (await service.describe(agent)).status
    assert.equal(before.state, 'stopped')
    await host.emit('agent/inbox/inserted', { agent, message: { id: 'injected', role: 'user', content: [{ type: 'text', text: 'background' }], source: { kind: 'weir-todo-driver' } } })
    await host.emit('agent/pre-step', { agent, turn: {}, signal: new AbortController().signal })
    const after = (await service.describe(agent)).status
    assert.equal(after.state, 'stopped')
    assert.equal(after.executionEpoch, before.executionEpoch)
    assert.equal(after.locks[0].status, 'user-interrupted')
    await host.emit('agent/inbox/inserted', { agent, message: { id: 'u-after', role: 'user', content: [{ type: 'text', text: 'continue now' }], source: { kind: 'user' } } })
    await host.emit('agent/pre-step', { agent, turn: {}, signal: new AbortController().signal })
    assert.equal((await service.describe(agent)).status.state, 'active')
  } finally { remote.close(); await dispose() }
})

// --- D5: message-driven binding self-heal ------------------------------------
// A genuine user message arms ONE bounded retry of a recorded duplicate-binding
// failure; the next turn's first pre-step awaits the trusted retryBinding path
// (same attestation guards, same in-flight join). On success the same turn
// continues into auto-resume; on a safe refusal the turn proceeds denied and
// the recorded cause stays.

const userMessage = (host, agent, id = crypto.randomUUID()) =>
  host.emit('agent/inbox/inserted', { agent, message: { id, role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } } })
const injectedMessage = (host, agent, id = crypto.randomUUID()) =>
  host.emit('agent/inbox/inserted', { agent, message: { id, role: 'user', content: [{ type: 'text', text: 'background' }], source: { kind: 'weir-todo-driver' } } })

/** A duplicate-binding failure for session 's': a remote channel proxy holds
 * the session while the local agent is created. Returns the handles the retry
 * attestation needs. */
async function duplicateBindingFixture(t, { autoResume } = {}) {
  const { root, directory } = await fixture()
  const host = fakeHost(root, { agents: true, presets: true })
  if (autoResume !== undefined) host.setEditLockSection({ autoResume })
  const { dispose, service } = mount(host, root, directory)
  let token, unregister = () => {}
  const remote = createRemoteEditLockDomain(endpointFor(directory), { onNotice() {}, onChannelOpen(nonce) { token = nonce; return () => unregister() } })
  t.after(async () => { remote.close(); await dispose() })
  const other = host.own(host.agent('other'))
  await host.emit('agent/created', { agent: other })
  const old = { id: 's' }
  await remote.channelFor(old)
  await remote.call(old, 'acquire', { filePath: 'a.txt', cwd: root })
  const agent = host.own(host.agent('s'))
  await host.emit('agent/created', { agent })
  assert.equal(service.blocksContinuation(agent), true)
  assert.equal(host.sessionFailures.length, 1)
  return { host, service, root, remote, old, agent, attest: () => { unregister = registerBindingRuntime(token, old, old.id) } }
}

test('a genuine user message retries the binding and resumes in the same turn, audited', async (t) => {
  const { host, service, root, remote, old, agent, attest } = await duplicateBindingFixture(t)
  await assert.rejects(service.acquire({ agent }, { filePath: 'a.txt', cwd: root }), /retried automatically when the user next sends a message/)

  // The holder evidence changes (the old holder becomes attestable-stale); the
  // next genuine message repairs without any manual /edit-lock retry.
  attest()
  await userMessage(host, agent)
  await host.emit('agent/pre-step', { agent, turn: {}, signal: new AbortController().signal })

  assert.equal(service.blocksContinuation(agent), false)
  const status = (await service.describe(agent)).status
  assert.equal(status.state, 'active')
  // The rebound session confirmed its retained lock through the ordinary
  // auto-resume replay: one message completed reconnect + restore.
  assert.equal(status.locks[0].status, 'active')
  assert.equal((await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })).generation, 1)
  await assert.rejects(remote.call(old, 'status'), /disconnected/)
  const audits = host.emitted.filter(entry => entry.type === 'weir/edit-lock-maintenance' && entry.record?.data?.kind === 'binding-auto-retry')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].record.data.sessionId, 's')
  assert.equal(audits[0].record.data.code, 'binding-duplicate')
  assert.equal(audits[0].record.data.result, 'recovered')
  const mirror = await readFile(join(root, '.weir', 'audit.jsonl'), 'utf8')
  expect(mirror).toContain('"kind":"binding-auto-retry"')
})

test('a still-serving holder safely refuses the message-driven retry; the turn proceeds, the cause stays, once per turn', async (t) => {
  const { host, service, root, agent } = await duplicateBindingFixture(t)
  const noticesBefore = agent.injects.length

  // Two pre-steps in ONE turn consume the armed flag exactly once.
  await userMessage(host, agent)
  const turn = {}
  await host.emit('agent/pre-step', { agent, turn, signal: new AbortController().signal })
  await host.emit('agent/pre-step', { agent, turn, signal: new AbortController().signal })
  assert.equal(service.blocksContinuation(agent), true)
  assert.equal(agent.injects.length, noticesBefore + 1) // one retried failure notice
  const diagnostic = await host.toolDefinitions.get('edit_lock_status').execute({}, { agent })
  assert.equal(diagnostic.bindingFailure.code, 'binding-duplicate')
  assert.equal(host.emitted.filter(entry => entry.record?.data?.kind === 'binding-auto-retry').length, 0)
  // Audit-everything (change edit-lock-binding-transfer): the refusal is no
  // longer swallowed — exactly one binding-transfer refusal audit per consumed
  // armed retry, carrying the holder class.
  const refusals = host.emitted.filter(entry => entry.record?.data?.kind === 'binding-transfer')
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].record.data.result, 'refused')
  assert.equal(refusals[0].record.data.reason, 'unknown')
  assert.equal(refusals[0].record.data.sessionId, 's')

  // The NEXT genuine message arms exactly one retry again (bounded per turn).
  await userMessage(host, agent)
  await host.emit('agent/pre-step', { agent, turn: {}, signal: new AbortController().signal })
  assert.equal(agent.injects.length, noticesBefore + 2)
  assert.equal(service.blocksContinuation(agent), true)
  assert.equal(host.emitted.filter(entry => entry.record?.data?.kind === 'binding-transfer' && entry.record?.data?.result === 'refused').length, 2)
  await assert.rejects(service.acquire({ agent }, { filePath: 'a.txt', cwd: root }), /binding is unavailable/)
})

test('injected messages and a disabled setting never arm the binding retry', async (t) => {
  const armed = await duplicateBindingFixture(t)
  // Injected message: no retry, no notice, failure record unchanged.
  await injectedMessage(armed.host, armed.agent)
  await armed.host.emit('agent/pre-step', { agent: armed.agent, turn: {}, signal: new AbortController().signal })
  assert.equal(armed.agent.injects.length, 1) // only the original failure notice
  assert.equal(armed.service.blocksContinuation(armed.agent), true)

  const off = await duplicateBindingFixture(t, { autoResume: false })
  off.attest()
  await userMessage(off.host, off.agent)
  await off.host.emit('agent/pre-step', { agent: off.agent, turn: {}, signal: new AbortController().signal })
  assert.equal(off.service.blocksContinuation(off.agent), true)
  assert.equal(off.agent.injects.length, 1)
  assert.equal(off.host.emitted.filter(entry => entry.record?.data?.kind === 'binding-auto-retry').length, 0)
  // The manual fallback remains available with the setting off.
  const retried = await off.host.command().handler({ agent: off.agent, rawInput: 'retry', commandId: 'manual-after-off' })
  assert.equal(retried.kind, 'success', retried.text)
  assert.equal((await off.service.describe(off.agent)).status.state, 'stopped')
})

// --- Driving-ingress binding transfer (change edit-lock-binding-transfer) ----
// The production dual-agent shape: two mount generations over ONE authority —
// the first publishes and holds the ghost's LOCAL binding; the second (the
// user-driven claimant's mount) is its client. The shared plane carries one
// agents registry (pinned to the ghost), one preset registry and one audit
// capture, exactly the single-process incident anatomy.

/** @param {string} root */
function transferPlane(root) {
  const agents = new Map()
  const owners = new Map()
  const emitted = []
  const stock = { write: { name: 'write', execute() {} }, edit: { name: 'edit', execute() {} } }
  const registry = { get: id => agents.get(id), roots: () => [...agents.values()] }
  const presets = { serviceFor: (agent, name) => (name === 'weirEditLock' ? owners.get(agent)?.provided.get('weirEditLock') : undefined) }
  function makeHost() {
    const listeners = new Map()
    const provided = new Map()
    const toolDefinitions = new Map()
    let command
    const host = {
      provided, toolDefinitions, command: () => command,
      ctx: {
        fs: stubFs,
        logger: { warn() {} },
        on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
        emit(type, record) { emitted.push({ type, record }) },
        reflect: { provide(name, value) { provided.set(name, value) } },
        get(name) {
          if (name === 'commands') return { register(definition) { command = definition; return () => { command = undefined } } }
          if (name === 'agents') return registry
          if (name === 'agentPresets') return presets
          return provided.get(name)
        },
        tools: { get(name, agent) { return agent.visible.get(name) }, register(definition) { toolDefinitions.set(definition.name, definition); return () => toolDefinitions.delete(definition.name) } },
      },
      agent(id) {
        const visible = new Map(Object.entries(stock))
        const created = {
          id, visible, status: 'idle', injects: [],
          session: { header: { cwd: root } },
          inject(message) { created.injects.push(message) },
          followup(message) { created.injects.push(message) },
          ctx: { tools: {
            registrations: 0,
            restrict({ deny }) { for (const name of deny) if (visible.get(name) === stock[name]) visible.delete(name) },
            register(definition) {
              created.ctx.tools.registrations++
              if (visible.has(definition.name)) throw new Error(`duplicate registration of tool "${definition.name}"`)
              visible.set(definition.name, definition)
              return () => visible.delete(definition.name)
            },
          } },
        }
        return created
      },
      async emit(name, ...args) {
        let result
        for (const fn of listeners.get(name) ?? []) result = await fn(...args, async () => ({ kind: 'allow' }))
        return result
      },
    }
    return host
  }
  return { agents, owners, emitted, registry, makeHost }
}

/** Ghost bound on the publisher mount + claimant refused on the client mount.
 * The registry stays pinned to the ghost — the defect being repaired. */
async function transferFixture(t, { holderStatus = 'idle' } = {}) {
  const { root, directory } = await fixture()
  const plane = transferPlane(root)
  const hostPub = plane.makeHost()
  const disposePub = apply(hostPub.ctx, { enabled: true, root, authorityDirectory: directory })
  const hostCli = plane.makeHost()
  const disposeCli = apply(hostCli.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(async () => { await disposeCli(); await disposePub() })

  const ghost = hostPub.agent('s')
  ghost.status = holderStatus
  plane.agents.set('s', ghost)
  plane.owners.set(ghost, hostPub)
  await hostPub.emit('agent/created', { agent: ghost })
  const servicePub = hostPub.provided.get('weirEditLock')
  await untilSettled(servicePub, ghost)
  await servicePub.acquire({ agent: ghost }, { filePath: 'a.txt', cwd: root })

  // The claimant's mount is the publisher's client; its creation bind is
  // refused while the registry keeps naming the ghost.
  const claimant = hostCli.agent('s')
  plane.owners.set(claimant, hostCli)
  await hostCli.emit('agent/created', { agent: claimant })
  const serviceCli = hostCli.provided.get('weirEditLock')
  assert.equal(serviceCli.blocksContinuation(claimant), true)
  const transferAudits = () => plane.emitted.filter(entry => entry.type === 'weir/edit-lock-maintenance' && entry.record?.data?.kind === 'binding-transfer')
  return { plane, hostPub, hostCli, ghost, claimant, servicePub, serviceCli, root, transferAudits }
}

test('transfer: one genuine message transfers from the idle same-process holder and resumes in the same turn, audited', async (t) => {
  const { hostCli, ghost, claimant, servicePub, serviceCli, root, transferAudits } = await transferFixture(t)

  // Creation-time refusal is the calm transferable announcement — no alarm,
  // no raw holder classification, no reservation warning.
  assert.equal(claimant.injects.length, 1)
  const notice = claimant.injects[0].content[0].text
  assert.match(notice, /inactive attachment of this same session/)
  assert.match(notice, /transfers automatically when you send a message/)
  assert.doesNotMatch(notice, /temporarily unavailable|pid=|holder=|Do NOT remove/)
  // The read-only status names the transferable class despite the registry
  // pointing at the ghost (relaxed panel eligibility).
  const diagnostic = await hostCli.toolDefinitions.get('edit_lock_status').execute({}, { agent: claimant })
  assert.equal(diagnostic.state, 'unavailable')
  assert.equal(diagnostic.bindingFailure.holderKind, 'transferable')
  assert.match(diagnostic.message, /inactive attachment of this same session/)
  // The ghost's binding is undisturbed until a driving ingress fires.
  assert.equal((await servicePub.describe(ghost)).status.state, 'active')
  assert.equal(transferAudits().length, 0)

  await userMessage(hostCli, claimant)
  await hostCli.emit('agent/pre-step', { agent: claimant, turn: {}, signal: new AbortController().signal })

  assert.equal(serviceCli.blocksContinuation(claimant), false)
  const status = (await serviceCli.describe(claimant)).status
  assert.equal(status.state, 'active')
  // The retained lock was confirmed by the same-turn auto-resume replay.
  assert.equal(status.locks.length, 1)
  assert.equal(status.locks[0].status, 'active')
  // The ghost's binding is gone; the claimant can edit immediately.
  assert.equal(servicePub.blocksContinuation(ghost), true)
  assert.equal((await hostCli.emit('tools/pre-execute', { name: 'write', agent: claimant })).kind, 'allow')
  assert.equal((await serviceCli.acquire({ agent: claimant }, { filePath: 'a.txt', cwd: root })).generation, 1)
  const audits = transferAudits()
  assert.equal(audits.length, 1)
  assert.equal(audits[0].record.data.result, 'transferred')
  assert.equal(audits[0].record.data.sessionId, 's')
  assert.equal(audits[0].record.data.holder, 'transferable')
})

test('transfer: a mid-turn holder refuses honestly, recovers on the next idle window; injected messages never transfer', async (t) => {
  const { hostCli, ghost, claimant, servicePub, serviceCli, transferAudits } = await transferFixture(t, { holderStatus: 'running' })

  // The mid-turn refusal names the live edit and the retry moment.
  const notice = claimant.injects[0].content[0].text
  assert.match(notice, /being edited in another attachment right now/)
  assert.match(notice, /edit-lock retry/)
  assert.doesNotMatch(notice, /pid=|holder=/)

  // An injected message arms nothing (spec: injected messages never transfer).
  await injectedMessage(hostCli, claimant)
  await hostCli.emit('agent/pre-step', { agent: claimant, turn: {}, signal: new AbortController().signal })
  assert.equal(serviceCli.blocksContinuation(claimant), true)
  assert.equal(transferAudits().length, 0)

  // A genuine message runs exactly one refused transfer, audited with its class.
  await userMessage(hostCli, claimant)
  await hostCli.emit('agent/pre-step', { agent: claimant, turn: {}, signal: new AbortController().signal })
  assert.equal(serviceCli.blocksContinuation(claimant), true)
  assert.equal((await servicePub.describe(ghost)).status.state, 'active')
  let audits = transferAudits()
  assert.equal(audits.length, 1)
  assert.equal(audits[0].record.data.result, 'refused')
  assert.equal(audits[0].record.data.reason, 'serving')
  // The re-recorded failure now carries the mid-turn class.
  const diagnostic = await hostCli.toolDefinitions.get('edit_lock_status').execute({}, { agent: claimant })
  assert.equal(diagnostic.bindingFailure.holderKind, 'serving')

  // The holder's turn ends; the next genuine message transfers.
  ghost.status = 'idle'
  await userMessage(hostCli, claimant)
  await hostCli.emit('agent/pre-step', { agent: claimant, turn: {}, signal: new AbortController().signal })
  assert.equal(serviceCli.blocksContinuation(claimant), false)
  assert.equal((await serviceCli.describe(claimant)).status.state, 'active')
  audits = transferAudits()
  assert.equal(audits.length, 2)
  assert.equal(audits[1].record.data.result, 'transferred')
})

test('transfer gate: an unavailable or empty registry refuses without touching the holder', async (t) => {
  const { plane, hostCli, ghost, claimant, servicePub, serviceCli, transferAudits } = await transferFixture(t)

  for (const breakdown of [
    () => { plane.registry.get = () => { throw new Error('registry down') } },
    () => { plane.registry.get = () => undefined },
  ]) {
    breakdown()
    await userMessage(hostCli, claimant)
    await hostCli.emit('agent/pre-step', { agent: claimant, turn: {}, signal: new AbortController().signal })
    assert.equal(serviceCli.blocksContinuation(claimant), true)
  }
  // Both breakdowns audited as unattestable; the holder was never approached.
  const audits = transferAudits()
  assert.equal(audits.length, 2)
  assert.ok(audits.every(entry => entry.record.data.result === 'refused' && entry.record.data.reason === 'registry-unattestable'))
  assert.equal((await servicePub.describe(ghost)).status.state, 'active')

  // Evidence healed: the registry names the idle ghost again, and the next
  // genuine message completes the transfer.
  plane.registry.get = id => plane.agents.get(id)
  await userMessage(hostCli, claimant)
  await hostCli.emit('agent/pre-step', { agent: claimant, turn: {}, signal: new AbortController().signal })
  assert.equal(serviceCli.blocksContinuation(claimant), false)
  assert.equal(transferAudits().length, 3)
  assert.equal(transferAudits()[2].record.data.result, 'transferred')
})

test('transfer gate: explicit /edit-lock retry transfers from an idle holder without arming auto-resume', async (t) => {
  const { hostCli, claimant, serviceCli, transferAudits } = await transferFixture(t)

  const retried = await hostCli.command().handler({ agent: claimant, rawInput: 'retry', commandId: 'manual-transfer' })
  assert.equal(retried.kind, 'success', retried.text)
  // Bound as interrupted — never authority; no auto-resume was armed by the
  // command path, and the audits carry the transfer.
  assert.equal((await serviceCli.describe(claimant)).status.state, 'stopped')
  assert.equal(transferAudits().length, 1)
  assert.equal(transferAudits()[0].record.data.result, 'transferred')
  // The ordinary trusted recovery completes with the next genuine message.
  await userMessage(hostCli, claimant)
  await hostCli.emit('agent/pre-step', { agent: claimant, turn: {}, signal: new AbortController().signal })
  assert.equal((await serviceCli.describe(claimant)).status.state, 'active')
})

test('transfer gate: the write-guard lazy re-bind is a driving transfer ingress, once per generation', async (t) => {
  const { root, directory } = await fixture()
  const plane = transferPlane(root)
  const hostPub = plane.makeHost()
  const disposePub = apply(hostPub.ctx, { enabled: true, root, authorityDirectory: directory })
  const hostCli = plane.makeHost()
  const disposeCli = apply(hostCli.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(async () => { await disposeCli(); await disposePub() })
  const ghost = hostPub.agent('s')
  plane.agents.set('s', ghost)
  plane.owners.set(ghost, hostPub)
  await hostPub.emit('agent/created', { agent: ghost })
  const servicePub = hostPub.provided.get('weirEditLock')
  await untilSettled(servicePub, ghost)

  // The claimant never saw a setup pass (no agent/created): the first guarded
  // write triggers the lazy re-bind, which records the duplicate failure and
  // then runs ONE transfer-capable retry in the same admission.
  const claimant = hostCli.agent('s')
  plane.owners.set(claimant, hostCli)
  const verdict = await hostCli.emit('tools/pre-execute', { name: 'write', agent: claimant })
  assert.equal(verdict.kind, 'allow')
  const serviceCli = hostCli.provided.get('weirEditLock')
  const audits = plane.emitted.filter(entry => entry.record?.data?.kind === 'binding-transfer')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].record.data.result, 'transferred')
  // Transferred as interrupted, never authority: the lifecycle still denies
  // the business write until the trusted resume path runs.
  assert.equal((await serviceCli.describe(claimant)).status.state, 'stopped')
  await assert.rejects(serviceCli.acquire({ agent: claimant }, { filePath: 'a.txt', cwd: root }), /stopped/)
  // A second guarded call short-circuits on the settled binding — no repeated
  // transfer attempts this generation.
  assert.equal((await hostCli.emit('tools/pre-execute', { name: 'write', agent: claimant })).kind, 'allow')
  assert.equal(plane.emitted.filter(entry => entry.record?.data?.kind === 'binding-transfer').length, 1)
  // The genuine message that follows completes the recovery in-turn.
  await userMessage(hostCli, claimant)
  await hostCli.emit('agent/pre-step', { agent: claimant, turn: {}, signal: new AbortController().signal })
  assert.equal((await serviceCli.describe(claimant)).status.state, 'active')
})
