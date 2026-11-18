// Fork provenance capture. The current host records no source on an ordinary
// fork (SessionHeader.parentSession is gone and no replacement field exists),
// so the fork call itself is intercepted and the (child, source) pair is
// consumed exactly once by resolveDurableRoot, before the child board is
// materialized. These tests drive the real durable storage against a temp
// profile home and a fake Session Controller shaped like the host's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBlackboardStorage } from '../../src/blackboard/storage.js'
import { createDurableBlackboard, resolveDurableRoot, installForkProvenance } from '../../src/blackboard/durable.js'

const SOURCE = 'session-source'
const CHILD = 'session-child'
const entry = (holder, key) => ({ holderId: holder, key, entryType: 'contract', summary: `Summary for ${key}.`, content: `Body of ${key}`, ttlMs: 60000 })

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'weir-bb-fork-')))
  const cwd = join(home, 'workspace')
  // Real host headers: an ordinary fork is depth-zero, seeded, and carries NO
  // parentSession. The legacy shape (parentSession, not seeded) is covered below.
  const session = async (id, header = {}) => {
    const dir = join(home, 'sessions', 'workspace', id)
    await fs.mkdir(dir, { recursive: true })
    const log = join(dir, 'session.v4.jsonl')
    await fs.writeFile(log, JSON.stringify({ type: 'session', version: 4, id, cwd, ...header }) + '\n')
    return { dir, log, side: log + '_bb' }
  }
  await session(SOURCE)
  const storage = createBlackboardStorage({ home })
  const kernel = createDurableBlackboard({ storage })
  kernel.bind(SOURCE, cwd)
  const runtime = { storage, kernel, flushed: new WeakSet() }
  t.after(async () => {
    await kernel.clearRuntime(SOURCE)
    await kernel.clearRuntime(CHILD).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  })
  return { home, cwd, storage, kernel, runtime, session }
}

/**
 * A Session Controller shaped like the host's: `fork(request)` delegates to
 * `agents.create({ sessionId, meta: { cwd, isSeeded } })` and the host passes no
 * source field. `resolveChildOf` maps a requested source to the child id it
 * creates, so concurrency tests can interleave two forks.
 */
function fakeHost({ resolveChildOf = () => CHILD, onCreate = undefined } = {}) {
  const created = []
  const agents = {
    async create(options, ...rest) {
      created.push(options)
      if (onCreate) await onCreate(options)
      return { sessionId: options.sessionId }
    },
  }
  const controller = {
    async fork(request, ...rest) {
      const sessionId = resolveChildOf(request?.sessionId)
      return agents.create({ sessionId, meta: { cwd: '/workspace', isSeeded: true }, rest })
    },
  }
  return {
    agents,
    controller,
    created,
    scope: { sessionController: controller, agents },
    ctx(warnings = []) {
      return {
        inject(deps, callback) { return callback(this.scope ?? { sessionController: controller, agents }) },
        get: () => undefined,
        logger: { warn: message => warnings.push(String(message)) },
        scope: { sessionController: controller, agents },
      }
    },
  }
}

/**
 * The same host, exposed the way the real one is: through cordis traceable
 * service proxies. `createShadowMethod` hands out `new Proxy(value, { apply })`
 * on EVERY read of a service's own function property, so two reads of
 * `agents.create` are never the same object — identity comparison across reads
 * cannot work — while assignments land on the underlying target. `unwrap` peels
 * those shadows back to the function the host actually holds: that, not a proxy,
 * is what a restore assertion has to compare.
 */
function proxyHost({ resolveChildOf = () => CHILD, onCreate = undefined } = {}) {
  const created = []
  const target = {
    async create(options, ...rest) {
      created.push(options)
      if (onCreate) await onCreate(options)
      return { sessionId: options.sessionId }
    },
  }
  const shadows = new WeakMap()
  const shadow = value => {
    const wrapped = new Proxy(value, { apply: (fn, thisArg, args) => Reflect.apply(fn, thisArg, args) })
    shadows.set(wrapped, value)
    return wrapped
  }
  const unwrap = value => { while (shadows.has(value)) value = shadows.get(value); return value }
  const agents = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver)
      // Only the service's own function properties get shadowed, as in the host;
      // Function.prototype members must stay callable, not wrapped.
      return typeof property === 'string' && typeof value === 'function' && Object.prototype.hasOwnProperty.call(object, property) ? shadow(value) : value
    },
    set(object, property, value) { object[property] = value; return true },
  })
  const controller = {
    async fork(request, ...rest) {
      const sessionId = resolveChildOf(request?.sessionId)
      return agents.create({ sessionId, meta: { cwd: '/workspace', isSeeded: true }, rest })
    },
  }
  return {
    agents,
    target,
    controller,
    created,
    unwrap,
    ctx(warnings = []) {
      return {
        inject: (deps, callback) => callback({ sessionController: controller, agents }),
        get: () => undefined,
        logger: { warn: message => warnings.push(String(message)) },
      }
    },
  }
}

/**
 * The host's other, harder shape: a cordis Service. Its methods live on the
 * prototype, and every read goes through the traceable proxy's get trap, which
 * wraps ANY function property — own or inherited — in `new Proxy(value, { apply })`
 * (createShadowMethod). Assignments create an own property on the instance, as
 * the real service proxy's set trap does, and `delete` exposes the prototype
 * method again. Every shadow counts one apply layer, so the base method observes
 * how many proxies the call crossed: that is what exposes a window which writes
 * the displaced shadow back into the slot instead of deleting its own property.
 */
function serviceHost({ resolveChildOf = () => CHILD, onCreate = undefined } = {}) {
  const created = []
  // Shadow layers active at the moment the base create runs.
  const depth = { current: 0, atBase: [] }
  const shadows = new WeakMap()
  const shadow = value => {
    const wrapped = new Proxy(value, {
      apply(fn, thisArg, args) {
        depth.current += 1
        try { return Reflect.apply(fn, thisArg, args) } finally { depth.current -= 1 }
      },
    })
    shadows.set(wrapped, value)
    return wrapped
  }
  const unwrap = value => { while (shadows.has(value)) value = shadows.get(value); return value }
  const service = proto => {
    const instance = Object.create(proto)
    return new Proxy(instance, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver)
        if (typeof property !== 'string' || typeof value !== 'function') return value
        return shadow(value)
      },
      set(object, property, value) { object[property] = value; return true },
    })
  }
  const agentsProto = {
    async create(options, ...rest) {
      depth.atBase.push(depth.current)
      created.push(options)
      if (onCreate) await onCreate(options)
      return { sessionId: options.sessionId }
    },
  }
  const controllerProto = {
    async fork(request, ...rest) {
      const sessionId = resolveChildOf(request?.sessionId)
      return agents.create({ sessionId, meta: { cwd: '/workspace', isSeeded: true }, rest })
    },
  }
  const agents = service(agentsProto)
  const controller = service(controllerProto)
  return {
    agents,
    controller,
    agentsProto,
    controllerProto,
    created,
    depth,
    unwrap,
    ctx(warnings = []) {
      return {
        inject: (deps, callback) => callback({ sessionController: controller, agents }),
        get: () => undefined,
        logger: { warn: message => warnings.push(String(message)) },
      }
    },
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('a captured fork seeds from its source before the child board materializes', async t => {
  const f = await fixture(t)
  await f.kernel.write(SOURCE, entry(SOURCE, 'knowledge'))
  // A second holder's apply fails and auto-subscribes: that is where the
  // subscribe count (which the snapshot must carry) comes from.
  await f.kernel.apply(SOURCE, { holderId: SOURCE, key: 'knowledge', ttlMs: 60000 })
  await f.kernel.apply(SOURCE, { holderId: 'subscriber', key: 'knowledge', ttlMs: 60000 })
  await f.kernel.read(SOURCE, ['knowledge'])
  await f.kernel.markPromoted(SOURCE, { key: 'knowledge', destination: 'runtime-map' })
  await f.session(CHILD, { isSeeded: true })

  const host = fakeHost()
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  t.after(dispose)

  const result = await host.controller.fork({ sessionId: SOURCE })
  assert.equal(result.sessionId, CHILD)
  assert.deepEqual([...f.runtime.forkSources], [[CHILD, SOURCE]])
  // The host's fork call passed no source of its own.
  assert.deepEqual(Object.keys(host.created[0].meta).sort(), ['cwd', 'isSeeded'])

  const root = await resolveDurableRoot({ get: () => undefined }, { id: CHILD }, f.runtime)
  assert.equal(root, CHILD)
  const rows = await f.kernel.entriesOf(CHILD)
  assert.deepEqual(rows.map(row => row.key), ['knowledge'])
  assert.equal(rows[0].content, 'Body of knowledge')
  assert.equal(rows[0].readCount, 1)
  assert.equal(rows[0].subscribeCount, 1)
  assert.equal(rows[0].promoted.destination, 'runtime-map')
  // Volatile authority never crosses the fork.
  assert.deepEqual(await f.kernel.tokensOf(CHILD), [])
  assert.deepEqual(await f.kernel.subscriptionsOf(CHILD), [])
  // The capture is one-shot.
  assert.equal(f.runtime.forkSources.size, 0)
  // The source board is untouched.
  assert.deepEqual((await f.kernel.entriesOf(SOURCE)).map(row => row.key), ['knowledge'])
})

test('concurrent forks keep their own sources', async t => {
  const f = await fixture(t)
  const SOURCE_B = 'session-source-b'
  await f.session(SOURCE_B)
  await f.session('session-child-a', { isSeeded: true })
  await f.session('session-child-b', { isSeeded: true })
  await f.kernel.write(SOURCE, entry(SOURCE, 'from-a'))
  await f.kernel.write(SOURCE_B, entry(SOURCE_B, 'from-b'))

  const children = new Map([[SOURCE, 'session-child-a'], [SOURCE_B, 'session-child-b']])
  // Yield inside create so both fork calls are genuinely in flight together.
  const host = fakeHost({ resolveChildOf: sourceId => children.get(sourceId), onCreate: tick })
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  t.after(dispose)

  await Promise.all([host.controller.fork({ sessionId: SOURCE }), host.controller.fork({ sessionId: SOURCE_B })])
  assert.equal(f.runtime.forkSources.get('session-child-a'), SOURCE)
  assert.equal(f.runtime.forkSources.get('session-child-b'), SOURCE_B)

  await resolveDurableRoot({ get: () => undefined }, { id: 'session-child-a' }, f.runtime)
  await resolveDurableRoot({ get: () => undefined }, { id: 'session-child-b' }, f.runtime)
  assert.deepEqual((await f.kernel.entriesOf('session-child-a')).map(row => row.key), ['from-a'])
  assert.deepEqual((await f.kernel.entriesOf('session-child-b')).map(row => row.key), ['from-b'])
})

test('the capture is consumed once and a drifted fork board is never re-seeded', async t => {
  const f = await fixture(t)
  await f.kernel.write(SOURCE, entry(SOURCE, 'knowledge'))
  await f.session(CHILD, { isSeeded: true })
  const host = fakeHost()
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  t.after(dispose)
  await host.controller.fork({ sessionId: SOURCE })
  await resolveDurableRoot({ get: () => undefined }, { id: CHILD }, f.runtime)
  await f.kernel.write(SOURCE, entry(SOURCE, 'later-source-entry'))
  assert.deepEqual((await f.kernel.entriesOf(CHILD)).map(row => row.key), ['knowledge'])
  // A second resolution finds no capture and the sidecar already exists.
  await resolveDurableRoot({ get: () => undefined }, { id: CHILD }, f.runtime)
  assert.deepEqual((await f.kernel.entriesOf(CHILD)).map(row => row.key), ['knowledge'])
  assert.equal(f.runtime.forkSources.size, 0)
})

test('an already materialized empty board is not overwritten', async t => {
  const f = await fixture(t)
  await f.kernel.write(SOURCE, entry(SOURCE, 'knowledge'))
  await f.session(CHILD, { isSeeded: true })
  // The host's agent/created hook can materialize the child board first.
  f.kernel.bind(CHILD, f.cwd)
  await f.kernel.ensure(CHILD)
  const host = fakeHost()
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  t.after(dispose)
  await host.controller.fork({ sessionId: SOURCE })
  await resolveDurableRoot({ get: () => undefined }, { id: CHILD }, f.runtime)
  assert.deepEqual(await f.kernel.entriesOf(CHILD), [])
})

test('the legacy parentSession header still seeds', async t => {
  const f = await fixture(t)
  await f.kernel.write(SOURCE, entry(SOURCE, 'legacy-entry'))
  // Old logs and old hosts still record the source in the header.
  await f.session(CHILD, { parentSession: SOURCE })
  const root = await resolveDurableRoot({ get: () => undefined }, { id: CHILD }, f.runtime)
  assert.equal(root, CHILD)
  assert.deepEqual((await f.kernel.entriesOf(CHILD)).map(row => row.key), ['legacy-entry'])
})

test('a non-seeded child never seeds from a stale capture', async t => {
  const f = await fixture(t)
  await f.kernel.write(SOURCE, entry(SOURCE, 'knowledge'))
  await f.session(CHILD) // no isSeeded: this is an ordinary new session
  const host = fakeHost()
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  t.after(dispose)
  await host.controller.fork({ sessionId: SOURCE })
  await resolveDurableRoot({ get: () => undefined }, { id: CHILD }, f.runtime)
  assert.deepEqual(await f.kernel.entriesOf(CHILD), [])
  assert.equal(f.runtime.forkSources.size, 0)
})

test('a composition without the Session Controller degrades quietly', async t => {
  const f = await fixture(t)
  const warnings = []
  // inject fires with an empty scope: the optional pair never arrived.
  const ctx = { inject: (deps, callback) => callback({}), get: () => undefined, logger: { warn: message => warnings.push(String(message)) } }
  const dispose = installForkProvenance(ctx, f.runtime)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /fork provenance unavailable/)
  dispose()
  dispose() // idempotent
  // A context without inject at all must not throw either.
  installForkProvenance({ get: () => undefined }, f.runtime)()
})

test('disposal restores the host methods and stops capturing', async t => {
  const f = await fixture(t)
  const host = fakeHost()
  const originalCreate = host.agents.create
  const originalFork = host.controller.fork
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  assert.notEqual(host.controller.fork, originalFork)
  await host.controller.fork({ sessionId: SOURCE })
  assert.equal(f.runtime.forkSources.get(CHILD), SOURCE)
  dispose()
  assert.equal(host.controller.fork, originalFork)
  assert.equal(host.agents.create, originalCreate)
  f.runtime.forkSources.clear()
  await host.controller.fork({ sessionId: SOURCE })
  assert.equal(f.runtime.forkSources.size, 0)
  // A second disposal is a no-op.
  dispose()
  assert.equal(host.controller.fork, originalFork)
})

test('two mounts share one capture and only the last disposal restores it', async t => {
  const f = await fixture(t)
  const host = fakeHost()
  const originalFork = host.controller.fork
  const first = installForkProvenance(host.ctx(), f.runtime)
  const installed = host.controller.fork
  const second = installForkProvenance(host.ctx(), f.runtime)
  assert.equal(host.controller.fork, installed)
  first()
  assert.equal(host.controller.fork, installed)
  await host.controller.fork({ sessionId: SOURCE })
  assert.equal(f.runtime.forkSources.get(CHILD), SOURCE)
  second()
  assert.equal(host.controller.fork, originalFork)
})

test('a failing create inside the fork keeps the host error and restores the patch', async t => {
  const f = await fixture(t)
  const host = fakeHost({ onCreate: async () => { throw new Error('host create failed') } })
  const originalCreate = host.agents.create
  const warnings = []
  const dispose = installForkProvenance(host.ctx(warnings), f.runtime)
  t.after(dispose)
  await assert.rejects(host.controller.fork({ sessionId: SOURCE }), /host create failed/)
  assert.equal(host.agents.create, originalCreate)
})

test('two consecutive forks on a proxy host both capture and never recurse', async t => {
  const f = await fixture(t)
  const SOURCE_B = 'session-source-b'
  const SECOND = 'session-child-2'
  await f.session(SOURCE_B)
  await f.session(CHILD, { isSeeded: true })
  await f.session(SECOND, { isSeeded: true })
  // Two ordinary forks in a row: the second one used to displace the first one's
  // wrapper and blow the stack synchronously.
  const children = [CHILD, SECOND]
  let child = 0
  const host = proxyHost({ resolveChildOf: () => children[child++] })
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  t.after(dispose)

  assert.equal((await host.controller.fork({ sessionId: SOURCE })).sessionId, CHILD)
  assert.equal((await host.controller.fork({ sessionId: SOURCE_B })).sessionId, SECOND)
  assert.equal(f.runtime.forkSources.get(CHILD), SOURCE)
  assert.equal(f.runtime.forkSources.get(SECOND), SOURCE_B)
  assert.notEqual(f.runtime.forkSources.get(CHILD), f.runtime.forkSources.get(SECOND))
  // The host still creates Sessions directly after both fork windows closed.
  assert.equal((await host.agents.create({ sessionId: 'session-post-fork' })).sessionId, 'session-post-fork')
  assert.equal(host.created.at(-1).sessionId, 'session-post-fork')
})

test('every proxy-host fork restores the create it displaced', async t => {
  const f = await fixture(t)
  const SOURCE_B = 'session-source-b'
  const SECOND = 'session-child-2'
  await f.session(SOURCE_B)
  await f.session(CHILD, { isSeeded: true })
  await f.session(SECOND, { isSeeded: true })
  const children = [CHILD, SECOND]
  let child = 0
  const host = proxyHost({ resolveChildOf: () => children[child++] })
  const originalCreate = host.target.create
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  t.after(dispose)

  await host.controller.fork({ sessionId: SOURCE })
  assert.equal(host.unwrap(host.target.create), originalCreate)
  await host.controller.fork({ sessionId: SOURCE_B })
  assert.equal(host.unwrap(host.target.create), originalCreate)
})

test('three forks on a service host keep the patched create layer flat', async t => {
  const f = await fixture(t)
  const sources = ['session-source-a', 'session-source-b', 'session-source-c']
  const children = ['session-child-a', 'session-child-b', 'session-child-c']
  const childOf = new Map(sources.map((source, index) => [source, children[index]]))
  for (const source of sources.slice(1)) await f.session(source)
  for (const child of children) await f.session(child, { isSeeded: true })

  const host = serviceHost({ resolveChildOf: sourceId => childOf.get(sourceId) })
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  t.after(dispose)

  for (const source of sources) assert.equal((await host.controller.fork({ sessionId: source })).sessionId, childOf.get(source))
  for (const source of sources) assert.equal(f.runtime.forkSources.get(childOf.get(source)), source)

  // The base create sees one apply layer per shadow proxy the call crossed. A
  // window that writes the displaced shadow back into the slot adds a layer per
  // fork (4, 5, 6 …); restoring by own-ness keeps it flat (4, 4, 4).
  const depths = host.depth.atBase
  assert.equal(depths.length, 3)
  assert.ok(depths[0] > 0, `the fixture must shadow method reads, got depth ${depths[0]}`)
  assert.deepEqual(depths, depths.map(() => depths[0]), 'the fork patch must not gain an apply layer per fork')
})

test('dispose unships both service patches and stops capturing', async t => {
  const f = await fixture(t)
  const host = serviceHost()
  const dispose = installForkProvenance(host.ctx(), f.runtime)
  t.after(dispose)

  assert.equal((await host.controller.fork({ sessionId: SOURCE })).sessionId, CHILD)
  assert.equal(f.runtime.forkSources.get(CHILD), SOURCE)

  dispose()
  f.runtime.forkSources.clear()
  assert.equal((await host.controller.fork({ sessionId: SOURCE })).sessionId, CHILD)

  // Both patches were own properties laid over prototype methods. Unship deletes
  // them — from the own-ness captured at install, never from an identity
  // comparison against a shadow the host hands out fresh on every read.
  const after = {
    recaptured: f.runtime.forkSources.size,
    forkOwn: Object.hasOwn(host.controller, 'fork'),
    createOwn: Object.hasOwn(host.agents, 'create'),
  }
  assert.deepEqual(after, { recaptured: 0, forkOwn: false, createOwn: false }, 'dispose must delete the own properties it installed and stop capturing')
  // What the host's own calls reach afterwards is its own prototype methods.
  assert.equal(host.unwrap(host.controller.fork), host.controllerProto.fork)
  assert.equal(host.unwrap(host.agents.create), host.agentsProto.create)
})
