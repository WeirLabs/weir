// Multi-mount status view (fix-edit-lock-view-multi-mount, design D1-D4): two
// preset mounts of Edit Lock share one process-wide view route. The surviving
// handler routes every live agent to its owning mount's describe; a later
// mount's duplicate route registration is skipped instead of aborting the
// mount; and an owning mount's binding failure is answered with its reason —
// never a reasonless "starting".
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { fixtureRoot as managementRootFor, fixtureEndpoint as endpointFor, fixtureExclude as excludeFromGit } from './helpers/edit-lock-fixtures.js'

const apply = createEditLockPlugin({ resolveRoot: managementRootFor, endpoint: endpointFor, exclude: excludeFromGit })

const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture(name) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `weir-multi-mount-${name}-`)))
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  return { base, root, directory }
}

/** The process-wide plane both mounts share: one connection whose exact-route
 * refusal matches dsh-client-connection verbatim, one agent registry, one
 * preset registry resolving each agent to its owning mount's service. */
function sharedPlane() {
  const agents = new Map()
  const owners = new Map()
  const routes = new Map()
  const connection = { fetch: { register(/** @type {any} */ definition) {
    if (routes.has(definition.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(definition.path)} is already registered`)
    routes.set(definition.path, definition)
    return () => { if (routes.get(definition.path) === definition) routes.delete(definition.path) }
  } } }
  const presets = {
    serviceFor(/** @type {any} */ agent, /** @type {string} */ name) {
      if (name !== 'weirEditLock') return undefined
      return owners.get(agent)?.provided.get('weirEditLock')
    },
  }
  return { agents, owners, routes, connection, presets,
    registry: { get: (/** @type {string} */ id) => agents.get(id), roots: () => [...agents.values()] } }
}

/** Host double for ONE mount, wired to the shared plane; `injected` records
 * what each connection-inject callback returned, so a callback that aborts
 * mid-mount (no disposer reached) is observable. */
function mountHost(/** @type {string} */ root, /** @type {any} */ shared) {
  const listeners = new Map()
  const provided = new Map()
  /** @type {any[]} */
  const injected = []
  /** @type {any} */
  let command
  const ctx = {
    fs: stubFs,
    logger: { warn() {} },
    on(/** @type {string} */ name, /** @type {any} */ fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    reflect: { provide(/** @type {string} */ name, /** @type {any} */ value) { provided.set(name, value) } },
    inject(/** @type {string[]} */ names, /** @type {any} */ callback) {
      if (!names.includes('connection')) return undefined
      const done = callback({ connection: shared.connection })
      injected.push(done)
      return done
    },
    get(/** @type {string} */ name) {
      if (name === 'commands') return { register(/** @type {any} */ definition) { command = definition; return () => { command = undefined } } }
      if (name === 'agents') return shared.registry
      if (name === 'agentPresets') return shared.presets
      return provided.get(name)
    },
    tools: { get(/** @type {string} */ name, /** @type {any} */ agent) { return agent.visible.get(name) }, register() { return () => {} } },
  }
  const stock = { write: { name: 'write', execute() {} }, edit: { name: 'edit', execute() {} } }
  function agent(/** @type {string} */ id) {
    const visible = new Map(Object.entries(stock))
    return { id, visible, session: { header: { cwd: root } }, ctx: { tools: {
      restrict(/** @type {any} */ { deny } = {}) { for (const name of deny) if (visible.get(name) === stock[name]) visible.delete(name) },
      register(/** @type {any} */ definition) { visible.set(definition.name, definition); return () => visible.delete(definition.name) },
    } } }
  }
  const emit = async (/** @type {string} */ name, /** @type {any[]} */ ...args) => {
    let result
    for (const fn of listeners.get(name) ?? []) result = await fn(...args, async () => ({ kind: 'allow' }))
    return result
  }
  return { ctx, provided, agent, emit, injected, command: () => command }
}

/** Mount both presets over one shared plane; A registers the routes first. */
async function twoMounts() {
  const a = await fixture('a')
  const b = await fixture('b')
  const shared = sharedPlane()
  const hostA = mountHost(a.root, shared)
  const hostB = mountHost(b.root, shared)
  const disposeA = apply(hostA.ctx, { enabled: true, root: a.root, authorityDirectory: a.directory })
  const disposeB = apply(hostB.ctx, { enabled: true, root: b.root, authorityDirectory: b.directory })
  const read = async (/** @type {string} */ sessionId) => (await shared.routes.get('/api/weir-edit-lock/view').fetch({ json: async () => ({ sessionId }) })).json()
  return { a, b, shared, hostA, hostB, disposeA, disposeB, read }
}

test('the first mount\'s route answers for the second mount\'s session with its true state', async () => {
  const { b, shared, hostA, hostB, disposeA, disposeB, read } = await twoMounts()
  // The later mount's inject callback completed (disposer returned) despite
  // its duplicate registrations being refused, and both routes exist once.
  assert.equal(typeof disposeB, 'function')
  assert.equal(hostB.injected.length > 0 && hostB.injected.every(done => typeof done === 'function'), true)
  assert.equal(typeof shared.routes.get('/api/weir-edit-lock/view')?.fetch, 'function')
  assert.equal(typeof shared.routes.get('/api/weir-edit-lock/maintenance/recover-online')?.fetch, 'function')

  const agentA = hostA.agent('session-a')
  const agentB = hostB.agent('session-b')
  shared.agents.set('session-a', agentA)
  shared.agents.set('session-b', agentB)
  shared.owners.set(agentA, hostA)
  shared.owners.set(agentB, hostB)
  await hostA.emit('agent/created', { agent: agentA })
  await hostB.emit('agent/created', { agent: agentB })
  const serviceA = hostA.provided.get('weirEditLock')
  const serviceB = hostB.provided.get('weirEditLock')
  for (let i = 0; i < 200 && (serviceA.blocksContinuation(agentA) || serviceB.blocksContinuation(agentB)); i++) await new Promise(resolve => setTimeout(resolve, 10))

  // A's own session answers through the same route (owning mount = A).
  assert.equal((await read('session-a')).value.state, 'idle')
  // The regression: B's session used to get unavailable(null) — the panel's
  // permanent "starting". Now A's handler routes to B's own describe.
  await serviceB.acquire({ agent: agentB }, { filePath: 'a.txt', cwd: b.root })
  const answer = (await read('session-b')).value
  assert.equal(answer.state, 'editing')
  assert.deepEqual(answer.files.map((/** @type {any} */ file) => [file.name, file.mine]), [['a.txt', true]])
  assert.equal(answer.technical.sessionId, 'session-b')
  assert.equal(answer.technical.root, b.root)

  // The late mount's dispose never unregisters the first mount's routes.
  disposeB()
  assert.equal(shared.routes.has('/api/weir-edit-lock/view'), true)
  disposeA()
  assert.equal(shared.routes.has('/api/weir-edit-lock/view'), false)
})

test('an owning mount whose binding failed answers unavailable with the reason, not a reasonless "starting"', async () => {
  const { shared, hostB, disposeA, disposeB, read } = await twoMounts()
  // A sub-agent of B's preset: B owns it (serviceFor resolves B's mount) but
  // never binds it, so B's describe refuses with the stock reason.
  const child = hostB.agent('child-b')
  child.session.header.delegationDepth = 1
  shared.agents.set('child-b', child)
  shared.owners.set(child, hostB)
  const answer = (await read('child-b')).value
  assert.equal(answer.state, 'unavailable')
  assert.match(answer.reason, /no Edit Lock domain/)
  disposeA()
  disposeB()
})

test('without a preset registry the endpoint keeps the mount-local resolution', async () => {
  const { root, directory } = await fixture('local')
  const shared = sharedPlane()
  const host = mountHost(root, shared)
  // No agentPresets in this composition (the integration harness shape).
  const get = host.ctx.get
  host.ctx.get = (/** @type {string} */ name) => (name === 'agentPresets' ? undefined : get(name))
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  const agent = host.agent('s')
  shared.agents.set('s', agent)
  await host.emit('agent/created', { agent })
  const service = host.provided.get('weirEditLock')
  // The domain start is the async tail of the creation setup; wait for it.
  for (let i = 0; i < 200 && service.blocksContinuation(agent); i++) await new Promise(resolve => setTimeout(resolve, 10))
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  const answer = await (await shared.routes.get('/api/weir-edit-lock/view').fetch({ json: async () => ({ sessionId: 's' }) })).json()
  assert.equal(answer.value.state, 'editing')
  dispose()
})

test('a throwing preset registry falls back to the mount-local resolution', async () => {
  const { root, directory } = await fixture('throwing')
  const shared = sharedPlane()
  const host = mountHost(root, shared)
  const get = host.ctx.get
  host.ctx.get = (/** @type {string} */ name) => (name === 'agentPresets' ? { serviceFor() { throw new Error('preset unloaded') } } : get(name))
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  const agent = host.agent('s')
  shared.agents.set('s', agent)
  await host.emit('agent/created', { agent })
  const service = host.provided.get('weirEditLock')
  // The domain start is the async tail of the creation setup; wait for it.
  for (let i = 0; i < 200 && service.blocksContinuation(agent); i++) await new Promise(resolve => setTimeout(resolve, 10))
  await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })
  const answer = await (await shared.routes.get('/api/weir-edit-lock/view').fetch({ json: async () => ({ sessionId: 's' }) })).json()
  assert.equal(answer.value.state, 'editing')
  dispose()
})

test('only the exact duplicate-route refusal is skipped; any other registration error aborts the mount', async () => {
  const { root, directory } = await fixture('strict')
  for (const message of ['connection: boom', 'already registered']) {
    const shared = sharedPlane()
    shared.connection.fetch.register = () => { throw new Error(message) }
    const host = mountHost(root, shared)
    assert.throws(() => apply(host.ctx, { enabled: true, root, authorityDirectory: directory }), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})
