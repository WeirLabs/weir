// Process-shared Edit Lock domains (change edit-lock-shared-domain-mounts,
// design D1–D4): one domain registry per host + effective domain
// configuration shared by every same-process preset mount, same-agent binding
// adoption in the lifecycle, and mount-independent managed-editor admission
// (shared claimed set, shared settled store, live-service currency proof).
//
// Three layers, pinned separately:
//  1. sharedDomainRegistryFor unit matrix (share/isolate/refcount/close).
//  2. Lifecycle adoption matrix (adopt active/stopped, session mismatch,
//     transferStart unchanged).
//  3. Composition-level dual mounts on ONE fake host: the preset-switch flow
//     end to end. The pre-existing dual-mount suites in
//     edit-lock-binding-self-heal.test.js model the cross-process shape with
//     TWO host keys (no sharing) and must keep passing unmodified.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDomainRegistry, sharedDomainRegistryFor } from '../src/edit-lock/domains.js'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { reservationPathFor } from '../src/edit-lock/reservation.js'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { fixtureRoot as managementRootFor, fixtureEndpoint as endpointFor, fixtureExclude as excludeFromGit } from './helpers/edit-lock-fixtures.js'

const apply = createEditLockPlugin({ resolveRoot: managementRootFor, endpoint: endpointFor, exclude: excludeFromGit })
const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture() {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-shared-domain-')))
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  return { base, root, directory }
}

/** The domain start is the async tail of an otherwise synchronous setup. */
async function untilSettled(service, agent) {
  for (let i = 0; i < 200 && service.blocksContinuation(agent); i++) await new Promise(resolve => setTimeout(resolve, 10))
}

// --- 1. sharedDomainRegistryFor unit matrix --------------------------------

/** Minimal registry double: only all() is consumed by release(). */
function fakeRegistry() {
  /** @type {Promise<{close: () => number}>[]} */
  const domains = []
  return {
    domains,
    open(domain) { domains.push(Promise.resolve(domain)) },
    all() { return [...domains] },
  }
}

test('sharedDomainRegistryFor: same host + discriminator shares registry and settled; factory runs once', () => {
  const host = {}
  let factories = 0
  const make = () => { factories++; return fakeRegistry() }
  const first = sharedDomainRegistryFor(host, 'fixed:a', make)
  const second = sharedDomainRegistryFor(host, 'fixed:a', make)
  expect(first.registry).toBe(second.registry)
  expect(first.settled).toBe(second.settled)
  expect(factories).toBe(1)
})

test('sharedDomainRegistryFor: a different discriminator or a different host never shares', () => {
  const hostA = {}, hostB = {}
  const first = sharedDomainRegistryFor(hostA, 'fixed:a', () => fakeRegistry())
  const otherConfig = sharedDomainRegistryFor(hostA, 'fixed:b', () => fakeRegistry())
  const otherHost = sharedDomainRegistryFor(hostB, 'fixed:a', () => fakeRegistry())
  expect(first.registry).not.toBe(otherConfig.registry)
  expect(first.registry).not.toBe(otherHost.registry)
  expect(first.settled).not.toBe(otherConfig.settled)
  expect(first.settled).not.toBe(otherHost.settled)
})

test('sharedDomainRegistryFor: only the last release closes every domain through the drain discipline', async () => {
  const host = {}
  const first = sharedDomainRegistryFor(host, '', () => fakeRegistry())
  const second = sharedDomainRegistryFor(host, '', () => fakeRegistry())
  let closes = 0
  const domain = () => ({ close: () => ++closes })
  first.registry.open(domain())
  first.registry.open(domain())

  await first.release()
  expect(closes).toBe(0) // a sibling mount still serves

  await second.release()
  expect(closes).toBe(2) // last release drained all domains exactly once
})

test('sharedDomainRegistryFor: release is idempotent (double dispose closes once)', async () => {
  const host = {}
  const handle = sharedDomainRegistryFor(host, '', () => fakeRegistry())
  let closes = 0
  handle.registry.open({ close: () => ++closes })
  await handle.release()
  await handle.release()
  expect(closes).toBe(1)
})

test('sharedDomainRegistryFor: a throwing factory enters no count — the next mount is the only owner', async () => {
  const host = {}
  assert.throws(() => sharedDomainRegistryFor(host, '', () => { throw new Error('factory boom') }), /factory boom/)
  let closes = 0
  const handle = sharedDomainRegistryFor(host, '', () => fakeRegistry())
  handle.registry.open({ close: () => ++closes })
  await handle.release()
  expect(closes).toBe(1) // count was exactly one: the failed factory added nothing
})

test('sharedDomainRegistryFor: after the last release a new generation reopens fresh (registry and settled)', async () => {
  const host = {}
  let factories = 0
  const make = () => { factories++; return fakeRegistry() }
  const first = sharedDomainRegistryFor(host, '', make)
  await first.release()
  const second = sharedDomainRegistryFor(host, '', make)
  expect(factories).toBe(2)
  expect(second.registry).not.toBe(first.registry)
  expect(second.settled).not.toBe(first.settled)
  let closes = 0
  second.registry.open({ close: () => ++closes })
  await second.release()
  expect(closes).toBe(1)
})

test('sharedDomainRegistryFor: a close failure rejects the release with the reason and the entry is dropped', async () => {
  const host = {}
  let factories = 0
  const make = () => { factories++; return fakeRegistry() }
  const handle = sharedDomainRegistryFor(host, '', make)
  handle.registry.open({ close: () => { throw new Error('drain boom') } })
  await assert.rejects(handle.release(), /drain boom/)
  // The failed generation is gone: a later mount gets a fresh registry.
  const reopened = sharedDomainRegistryFor(host, '', make)
  expect(factories).toBe(2)
  expect(reopened.registry).not.toBe(handle.registry)
})

test('sharedDomainRegistryFor: two fixed configurations of one host drain independently', async () => {
  const host = {}
  const a = sharedDomainRegistryFor(host, 'fixed:a', () => fakeRegistry())
  const b = sharedDomainRegistryFor(host, 'fixed:b', () => fakeRegistry())
  let closesA = 0, closesB = 0
  a.registry.open({ close: () => ++closesA })
  b.registry.open({ close: () => ++closesB })
  await a.release()
  expect(closesA).toBe(1)
  expect(closesB).toBe(0)
  await b.release()
  expect(closesB).toBe(1)
})

// --- 2. Lifecycle same-agent adoption matrix --------------------------------

/** A lifecycle over a real runtime, with registration/revocation counters. */
async function countedLifecycle(directory, root) {
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const counts = { opens: 0, cancels: 0 }
  const lifecycle = createEditLockLifecycle({ ...runtime, control: { ...runtime.control,
    openSession(id) { counts.opens++; return runtime.control.openSession(id) },
    cancelSession(id) { counts.cancels++; return runtime.control.cancelSession(id) },
  } }, agent => agent.id)
  return { runtime, lifecycle, counts }
}

test('adoption: a second start of the same active agent returns the established result with zero registration side effects', async () => {
  const { root, directory } = await fixture()
  const { runtime, lifecycle, counts } = await countedLifecycle(directory, root)
  try {
    const agent = { id: 's' }
    assert.equal(await lifecycle.start(agent), 'active')
    await lifecycle.service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
    const epoch = lifecycle.status(agent).executionEpoch

    // The sibling mount's re-setup presents the SAME object: adopt, never re-register.
    assert.equal(await lifecycle.start(agent), 'active')
    assert.equal(counts.opens, 1)   // no second openSession
    assert.equal(counts.cancels, 0) // no revocation
    assert.equal(lifecycle.status(agent).state, 'active')
    assert.equal(lifecycle.status(agent).executionEpoch, epoch)
    assert.equal(lifecycle.status(agent).locks.length, 1)
    assert.equal(lifecycle.status(agent).locks[0].status, 'active')
  } finally { await lifecycle.close() }
})

test('adoption: a stopped entry adopts without re-arming — business stays denied until a trusted resume', async () => {
  const { root, directory } = await fixture()
  const { runtime, lifecycle, counts } = await countedLifecycle(directory, root)
  try {
    const agent = { id: 's' }
    assert.equal(await lifecycle.start(agent), 'active')
    await lifecycle.service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
    await lifecycle.stop(agent)
    const epoch = lifecycle.status(agent).executionEpoch
    const cancels = counts.cancels

    // Adoption returns the established start result but changes nothing.
    assert.equal(await lifecycle.start(agent), 'active')
    assert.equal(counts.cancels, cancels) // no second revocation
    assert.equal(counts.opens, 1)
    assert.equal(lifecycle.status(agent).state, 'stopped')
    assert.equal(lifecycle.status(agent).executionEpoch, epoch)
    assert.equal(lifecycle.status(agent).locks[0].status, 'user-interrupted')
    await assert.rejects(lifecycle.service.acquire({ agent }, { filePath: 'a.txt', cwd: root }), /stopped/)

    // The trusted Continue path still restores editing exactly as before.
    const resumed = await lifecycle.resume(agent, 'command:test')
    assert.equal(resumed.state, 'active')
    assert.ok(resumed.executionEpoch > epoch)
  } finally { await lifecycle.close() }
})

test('adoption: an interrupted-start entry adopts as interrupted, without a second revocation', async () => {
  const { root, directory } = await fixture()
  const { runtime, lifecycle, counts } = await countedLifecycle(directory, root)
  try {
    // Make the session durably known first: a prior lifecycle bound and stopped it.
    await runtime.control.openSession('s')
    await runtime.control.cancelSession('s')
    const agent = { id: 's' }
    assert.equal(await lifecycle.start(agent), 'interrupted')
    const cancels = counts.cancels
    assert.equal(await lifecycle.start(agent), 'interrupted')
    assert.equal(counts.cancels, cancels)
    assert.equal(counts.opens, 0)
    assert.equal(lifecycle.status(agent).state, 'stopped')
  } finally { await lifecycle.close() }
})

test('adoption: session mismatch keeps the duplicate-registration refusal', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  let session = 's1'
  const lifecycle = createEditLockLifecycle(runtime, () => session)
  try {
    const agent = { id: 'reused' }
    assert.equal(await lifecycle.start(agent), 'active')
    // The host reused the SAME agent object for a different session: refuse.
    session = 's2'
    await assert.rejects(lifecycle.start(agent), /already registered/)
    // The original binding is untouched.
    session = 's1'
    assert.equal(lifecycle.status(agent).state, 'active')
  } finally { await lifecycle.close() }
})

test('adoption: transferStart keeps its same-object refusal even when the session matches', async () => {
  const { root, directory } = await fixture()
  const { lifecycle } = await countedLifecycle(directory, root)
  try {
    const agent = { id: 's' }
    assert.equal(await lifecycle.start(agent), 'active')
    await assert.rejects(lifecycle.transferStart(agent), /already registered/)
    assert.equal(lifecycle.status(agent).state, 'active')
  } finally { await lifecycle.close() }
})

// --- 3. Dual mounts on ONE fake host (the preset-switch shape) --------------

/** One process plane: one shared host key (the sharing shape), one agents
 * registry, one preset registry resolving each agent to its owning mount, one
 * audit capture. Modeled on transferPlane in edit-lock-binding-self-heal. */
function dualPlane(root, hostKey) {
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
    const warns = []
    const sessionFailures = []
    let command
    const host = {
      provided, toolDefinitions, warns, sessionFailures, command: () => command,
      ctx: {
        root: hostKey, // ONE host key: both mounts share the registry container.
        fs: stubFs,
        logger: { warn(message) { warns.push(String(message)) } },
        on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
        emit(type, record) { emitted.push({ type, record }) },
        reflect: { provide(name, value) { provided.set(name, value) } },
        get(name) {
          if (name === 'commands') return { register(definition) { command = definition; return () => { command = undefined } } }
          if (name === 'agents') return registry
          if (name === 'agentPresets') return presets
          if (name === 'weirSettings') return {
            get: () => undefined,
            editLockEvidence: { recordMount: () => ({ recordSessionFailure: (id, reason) => sessionFailures.push([id, reason]), recordDomain() {}, installed() {}, disposing() {}, dispose() {}, failed() {} }) },
          }
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
            // Strict dsh-scope semantics: re-registering a live name throws.
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
  const bindingAudits = () => emitted.filter(entry => entry.type === 'weir/edit-lock-maintenance'
    && ['binding-transfer', 'binding-auto-retry', 'setup-failed'].includes(entry.record?.data?.kind))
  return { agents, owners, emitted, registry, makeHost, bindingAudits }
}

test('preset switch between two same-process mounts is a no-op: shared domain, epoch continuity, mount-independent admission', async (t) => {
  const { root, directory } = await fixture()
  const plane = dualPlane(root, {})
  const hostA = plane.makeHost()
  const disposeA = apply(hostA.ctx, { enabled: true, root, authorityDirectory: directory })
  const hostB = plane.makeHost()
  const disposeB = apply(hostB.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(async () => { await disposeB(); await disposeA() })
  const serviceA = hostA.provided.get('weirEditLock')
  const serviceB = hostB.provided.get('weirEditLock')

  // Agent created under mount A.
  const agent = hostA.agent('s')
  plane.agents.set('s', agent)
  plane.owners.set(agent, hostA)
  await hostA.emit('agent/created', { agent })
  await untilSettled(serviceA, agent)
  assert.equal(serviceA.blocksContinuation(agent), false)

  // One shared domain: both mounts resolve it; B never became a client of A
  // (the pre-fix same-process client shape), and B's synchronous gates read
  // the binding A settled.
  assert.equal(serviceB.blocksContinuation(agent), false)
  assert.equal((await serviceA.describe(agent)).mode, 'publisher')
  assert.equal((await serviceB.describe(agent)).mode, 'publisher')

  await serviceA.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  assert.equal((await serviceA.describe(agent)).status.executionEpoch, 1)

  // The guard admits through EITHER mount before the switch (shared claimed set).
  assert.equal((await hostA.emit('tools/pre-execute', { name: 'write', agent })).kind, 'allow')
  assert.equal((await hostB.emit('tools/pre-execute', { name: 'write', agent })).kind, 'allow')

  // The switch: the preset registry resolves B now; both mounts hear the
  // unscoped event (A's own-preset fence skips it, B's setup short-circuits on
  // the shared root binding). Serial-bail discipline: undefined, never a promise.
  plane.owners.set(agent, hostB)
  assert.equal(await hostA.emit('agent-preset/selected', 's'), undefined)
  assert.equal(await hostB.emit('agent-preset/selected', 's'), undefined)
  await untilSettled(serviceB, agent)

  // No re-installation, no failure record, no notice, no binding audit.
  assert.equal(agent.ctx.tools.registrations, 1)
  assert.deepEqual(hostA.sessionFailures, [])
  assert.deepEqual(hostB.sessionFailures, [])
  assert.equal(agent.injects.length, 0)
  assert.deepEqual(hostA.warns, [])
  assert.deepEqual(hostB.warns, [])
  assert.deepEqual(plane.bindingAudits(), [])

  // Epoch continuity and status correctness from EITHER mount.
  assert.equal((await serviceB.describe(agent)).status.executionEpoch, 1)
  assert.equal((await serviceB.describe(agent)).status.state, 'active')
  assert.equal((await serviceB.describe(agent)).status.locks.length, 1)
  assert.equal((await serviceA.describe(agent)).status.executionEpoch, 1)

  // Managed write admitted through EITHER mount's guard after the switch, and
  // business calls through B's service publish over the existing binding.
  assert.equal((await hostB.emit('tools/pre-execute', { name: 'write', agent })).kind, 'allow')
  assert.equal((await hostA.emit('tools/pre-execute', { name: 'write', agent })).kind, 'allow')
  assert.ok(await serviceB.acquire({ agent }, { filePath: 'a.txt', cwd: root }))

  // Switch back to A: the same no-op assertions hold.
  plane.owners.set(agent, hostA)
  await hostA.emit('agent-preset/selected', 's')
  await hostB.emit('agent-preset/selected', 's')
  assert.equal((await serviceA.describe(agent)).status.executionEpoch, 1)
  assert.equal((await serviceA.describe(agent)).status.state, 'active')
  assert.equal((await hostA.emit('tools/pre-execute', { name: 'write', agent })).kind, 'allow')
  assert.equal((await hostB.emit('tools/pre-execute', { name: 'write', agent })).kind, 'allow')
  assert.equal(agent.ctx.tools.registrations, 1)
  assert.equal(agent.injects.length, 0)
  assert.deepEqual(plane.bindingAudits(), [])

  // Foreign preset (no Edit Lock of its own): no new binding is attempted and
  // the existing binding keeps serving the session's managed writes.
  const foreign = plane.makeHost() // never applied: resolves no weirEditLock
  plane.owners.set(agent, foreign)
  await hostA.emit('agent-preset/selected', 's')
  await hostB.emit('agent-preset/selected', 's')
  assert.equal(agent.ctx.tools.registrations, 1)
  assert.equal((await serviceA.describe(agent)).status.state, 'active')
  assert.equal((await serviceA.describe(agent)).status.executionEpoch, 1)
  assert.equal((await hostA.emit('tools/pre-execute', { name: 'write', agent })).kind, 'allow')
  assert.ok(await serviceA.acquire({ agent }, { filePath: 'a.txt', cwd: root }))
  assert.equal(agent.injects.length, 0)
  assert.deepEqual(plane.bindingAudits(), [])
})

test('a stopped session stays stopped across a preset switch; only the trusted Continue restores editing', async (t) => {
  const { root, directory } = await fixture()
  const plane = dualPlane(root, {})
  const hostA = plane.makeHost()
  const disposeA = apply(hostA.ctx, { enabled: true, root, authorityDirectory: directory })
  const hostB = plane.makeHost()
  const disposeB = apply(hostB.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(async () => { await disposeB(); await disposeA() })
  const serviceA = hostA.provided.get('weirEditLock')
  const serviceB = hostB.provided.get('weirEditLock')

  const agent = hostA.agent('s')
  plane.agents.set('s', agent)
  plane.owners.set(agent, hostA)
  await hostA.emit('agent/created', { agent })
  await untilSettled(serviceA, agent)
  await serviceA.acquire({ agent }, { filePath: 'a.txt', cwd: root })

  const stopped = await hostA.command().handler({ agent, rawInput: 'stop', commandId: 'stop-1' })
  assert.equal(stopped.kind, 'success')
  assert.equal((await serviceA.describe(agent)).status.state, 'stopped')
  const epoch = (await serviceA.describe(agent)).status.executionEpoch

  // The switch adopts the stopped entry without any state change.
  plane.owners.set(agent, hostB)
  await hostA.emit('agent-preset/selected', 's')
  await hostB.emit('agent-preset/selected', 's')
  assert.equal((await serviceB.describe(agent)).status.state, 'stopped')
  assert.equal((await serviceB.describe(agent)).status.executionEpoch, epoch)
  assert.equal(serviceB.blocksContinuation(agent), true)
  await assert.rejects(serviceB.acquire({ agent }, { filePath: 'a.txt', cwd: root }), /stopped/)
  assert.equal(agent.injects.length, 0)
  assert.deepEqual(plane.bindingAudits(), [])
  assert.deepEqual(hostB.sessionFailures, [])

  // The trusted Continue path works from the sibling mount exactly as before.
  const resumed = await hostB.command().handler({ agent, rawInput: 'resume', commandId: 'resume-1' })
  assert.equal(resumed.kind, 'success')
  const status = (await serviceB.describe(agent)).status
  assert.equal(status.state, 'active')
  assert.ok(status.executionEpoch > epoch)
  assert.ok(await serviceB.acquire({ agent }, { filePath: 'a.txt', cwd: root }))
})

test('an agent created under the sibling mount passes endpoint currency (live-service membership); a registry identity mismatch stays refused', async (t) => {
  const { root, directory } = await fixture()
  const plane = dualPlane(root, {})
  const hostA = plane.makeHost()
  const disposeA = apply(hostA.ctx, { enabled: true, root, authorityDirectory: directory })
  const hostB = plane.makeHost()
  const disposeB = apply(hostB.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(async () => { await disposeB(); await disposeA() })
  const serviceA = hostA.provided.get('weirEditLock')
  const serviceB = hostB.provided.get('weirEditLock')

  // The agent's FIRST setup runs under mount B: the shared endpoint (opened
  // by mount A's closure) must accept B's live service identity as current.
  const agent = hostB.agent('s')
  plane.agents.set('s', agent)
  plane.owners.set(agent, hostB)
  await hostB.emit('agent/created', { agent })
  await untilSettled(serviceB, agent)
  assert.equal(serviceB.blocksContinuation(agent), false)
  assert.equal((await serviceB.describe(agent)).status.state, 'active')
  assert.equal((await serviceA.describe(agent)).status.state, 'active')
  assert.deepEqual(hostB.sessionFailures, [])
  assert.ok(await serviceB.acquire({ agent }, { filePath: 'a.txt', cwd: root }))

  // The exact-identity half of the currency proof is unchanged: the agents
  // registry naming a DIFFERENT object for the session id refuses the start.
  const impostor = hostB.agent('ghost')
  plane.agents.set('ghost', hostA.agent('ghost'))
  plane.owners.set(impostor, hostB)
  await hostB.emit('agent/created', { agent: impostor })
  assert.equal(serviceB.blocksContinuation(impostor), true)
  assert.deepEqual(hostB.sessionFailures, [['ghost', 'local edit binding claimant is no longer current']])
  await assert.rejects(serviceB.describe(impostor), /no Edit Lock domain/)
})

test('the last sharing disposer closes the domain; a re-applied generation binds known sessions as interrupted', async (t) => {
  const { root, directory } = await fixture()
  const hostKey = {}
  const plane = dualPlane(root, hostKey)
  const hostA = plane.makeHost()
  const disposeA = apply(hostA.ctx, { enabled: true, root, authorityDirectory: directory })
  const hostB = plane.makeHost()
  const disposeB = apply(hostB.ctx, { enabled: true, root, authorityDirectory: directory })
  const serviceA = hostA.provided.get('weirEditLock')
  const serviceB = hostB.provided.get('weirEditLock')

  const agent = hostA.agent('s')
  plane.agents.set('s', agent)
  plane.owners.set(agent, hostA)
  await hostA.emit('agent/created', { agent })
  await untilSettled(serviceA, agent)
  await serviceA.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  const reservation = reservationPathFor(directory)

  // One of two sharing mounts disposes: the domain stays open and keeps serving.
  await disposeA()
  assert.equal(existsSync(reservation), true)
  assert.equal((await serviceB.describe(agent)).status.state, 'active')
  assert.ok(await serviceB.acquire({ agent }, { filePath: 'a.txt', cwd: root }))

  // The last disposer closes all domains through the unload discipline:
  // sessions revoked, reservation drained and released.
  await disposeB()
  assert.equal(existsSync(reservation), false)

  // Bundle re-apply: a new generation over the same host reopens fresh and the
  // known session binds as interrupted (the existing restart semantics) — the
  // stale settled entry of the closed generation is not mistaken for a binding.
  const hostD = plane.makeHost()
  const disposeD = apply(hostD.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(() => disposeD())
  const serviceD = hostD.provided.get('weirEditLock')
  plane.owners.set(agent, hostD)
  await hostD.emit('agent/created', { agent })
  await untilSettled(serviceD, agent)
  assert.equal(serviceD.blocksContinuation(agent), true)
  assert.equal(agent.ctx.tools.registrations, 2) // the stale layer was retired first
  const status = (await serviceD.describe(agent)).status
  assert.equal(status.state, 'stopped')
  assert.equal(status.locks[0]?.status, 'user-interrupted')
  // The trusted resume path ends the interruption, as after any restart.
  const resumed = await hostD.command().handler({ agent, rawInput: 'resume', commandId: 'resume-reapply' })
  assert.equal(resumed.kind, 'success')
  assert.equal((await serviceD.describe(agent)).status.state, 'active')
})

test('mounts with different fixed configurations on one host never share: each drains its own domain independently', async (t) => {
  const a = await fixture()
  const b = await fixture()
  const plane = dualPlane(a.root, {})
  const hostA = plane.makeHost()
  const disposeA = apply(hostA.ctx, { enabled: true, root: a.root, authorityDirectory: a.directory })
  const hostB = plane.makeHost()
  const disposeB = apply(hostB.ctx, { enabled: true, root: b.root, authorityDirectory: b.directory })
  t.after(async () => { await disposeB(); await disposeA() })
  const serviceA = hostA.provided.get('weirEditLock')
  const serviceB = hostB.provided.get('weirEditLock')

  const agentA = hostA.agent('sa')
  plane.agents.set('sa', agentA)
  plane.owners.set(agentA, hostA)
  await hostA.emit('agent/created', { agent: agentA })
  await untilSettled(serviceA, agentA)
  const agentB = hostB.agent('sb')
  plane.agents.set('sb', agentB)
  plane.owners.set(agentB, hostB)
  await hostB.emit('agent/created', { agent: agentB })
  await untilSettled(serviceB, agentB)

  // Distinct fixed roots resolve to distinct registries: each mount is the
  // publisher of its own authority, and draining one leaves the other serving.
  assert.equal((await serviceA.describe(agentA)).mode, 'publisher')
  assert.equal((await serviceB.describe(agentB)).mode, 'publisher')
  assert.notEqual((await serviceA.describe(agentA)).root, (await serviceB.describe(agentB)).root)
  await disposeA()
  assert.equal(existsSync(reservationPathFor(a.directory)), false)
  assert.equal(existsSync(reservationPathFor(b.directory)), true)
  assert.equal((await serviceB.describe(agentB)).status.state, 'active')
  await disposeB()
  t.after(() => {})
  assert.equal(existsSync(reservationPathFor(b.directory)), false)
})

/** An authority whose previous incarnation (registered with a dead pid)
 * crashed mid-publication: one unknown operation fencing a.txt. Mirrors the
 * crashedAuthority fixture of edit-lock-recovery-notice.test.js. */
const DEAD_PID = 40_000_000
async function crashedAuthority(root, directory) {
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  const manager = createEditLockManager({ store, managerIncarnation: 'crashed-incarnation',
    processIdentity: { pid: DEAD_PID, host: hostname(), osStart: null, bootNonce: 'crashed-boot' } })
  const execution = await manager.openSession('crashed-session')
  const target = join(root, 'a.txt')
  const token = await manager.acquire(execution, target)
  const ready = await manager.prepare(execution, {
    operationId: 'crashed-op', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
  }, { validate() {}, publish: async () => { throw new Error('writer outcome lost') }, identify: () => target })
  await assert.rejects(manager.commit(ready.submission), /writer outcome lost/)
  await store.close()
}

test('the automatic-recovery summary drains from the shared queue through the sibling mount that hears the first turn', async (t) => {
  const { root, directory } = await fixture()
  await crashedAuthority(root, directory)
  const plane = dualPlane(root, {})
  // Mount A applies first: the shared registry and its open closure belong to
  // A, so the recovery summary queues against A's audit/deliver closures.
  const hostA = plane.makeHost()
  const disposeA = apply(hostA.ctx, { enabled: true, root, authorityDirectory: directory })
  const hostB = plane.makeHost()
  const disposeB = apply(hostB.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(async () => { await disposeB(); await disposeA() })
  const serviceB = hostB.provided.get('weirEditLock')

  // The first post-recovery session belongs to the sibling mount B: the
  // notice queued at domain open must still reach it (design D3), exactly once.
  const agent = hostB.agent('s')
  plane.agents.set('s', agent)
  plane.owners.set(agent, hostB)
  await hostB.emit('agent/created', { agent })
  await untilSettled(serviceB, agent)
  assert.equal(serviceB.blocksContinuation(agent), false)

  await hostB.emit('agent/pre-step', { agent, turn: {}, signal: new AbortController().signal })
  assert.equal(agent.injects.length, 1)
  assert.match(agent.injects[0].content[0].text, /unresolved publication/)

  // The next turn (either mount) does not re-deliver; the durable audit
  // landed exactly once through the opening mount's closure.
  await hostB.emit('agent/pre-step', { agent, turn: {}, signal: new AbortController().signal })
  assert.equal(agent.injects.length, 1)
  const recoveryAudits = plane.emitted.filter(entry => entry.type === 'weir/edit-lock-maintenance' && entry.record?.data?.kind === 'automatic-recovery')
  assert.equal(recoveryAudits.length, 1)
  assert.equal(recoveryAudits[0].record.data.root, root)
})
