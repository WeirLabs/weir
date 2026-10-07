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
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { writeScopesFor, disposeWriteScope } from '../src/edit-lock/write-scopes.js'
import { fixtureRoot as managementRootFor, fixtureEndpoint as endpointFor, fixtureExclude as excludeFromGit } from './helpers/edit-lock-fixtures.js'
const apply = createEditLockPlugin({ resolveRoot: managementRootFor, endpoint: endpointFor, exclude: excludeFromGit })

const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'weir-self-heal-')))
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
        get: () => undefined,
        editLockEvidence: { recordMount: () => ({ recordSessionFailure: (id, reason) => sessionFailures.push([id, reason]), recordDomain() {}, installed() {}, disposing() {}, dispose() {}, failed() {} }) },
      }
      return provided.get(name)
    },
    tools: { get(name, agent) { return agent.visible.get(name) }, register() { return () => {} } },
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
  return { ctx, provided, agent, own, emit, warns, emitted, sessionFailures, command: () => command }
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
  expect(broken.injects[0].content[0].text).toContain('Recovery: restart DeepSeek Harness or start a new conversation')
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
