// Registration-lifecycle counterexamples for the capability remote (S27.5).
//
// The real registry keys ONE package record per package+face, binds a
// contribution's withdrawal to the calling fiber (a disposed fiber cannot
// create the effect at all: CordisError INACTIVE_EFFECT), and emits a
// `typert.local` change per committed/withdrawn endpoint. A fiber reload runs
// the new apply() while the previous incarnation's effects are still unwinding,
// so the new generation can lose the provision race AND the registration race
// and then watch the old incarnation withdraw the endpoints it skipped. The
// gateway refuses such a withdrawn strict definition before it ever reaches a
// service method (`hasSeen` + no live definition), so recovery has to live on
// the new generation's own fiber.
//
// This file runs that lifecycle on a registry that reproduces exactly those
// rules — face validation, package-face uniqueness, endpoint/id uniqueness,
// atomic batch commit, fiber-bound effects, synchronous change events — because
// this package may not import the real @deepseek-ai registry (red line 2) and
// the workspace has no DSH tree in node_modules. It is NOT a permissive mock:
// every rejection below is the real error shape. The real-registry + real-Cordis
// + real-gateway proof lives in the weir-test-harness probe
// (`capability_remote_probe` op `registration`), which drives the shipped row.
import { test, expect } from './helpers.js'
import {
  CAPABILITY_ENDPOINTS,
  CAPABILITY_MUTATION_METHODS,
  CAPABILITY_MUTATION_NAMESPACE,
  CAPABILITY_MUTATION_SERVICE_KEY,
  CAPABILITY_READ_METHODS,
  CAPABILITY_READ_NAMESPACE,
  CAPABILITY_READ_SERVICE_KEY,
  apply as remoteApply,
  capabilityContribution,
} from '../src/capabilities/capability-remote.js'

const READ_ENDPOINTS = CAPABILITY_READ_METHODS.map(method => `${CAPABILITY_READ_NAMESPACE}/${method}`)
const MUTATION_ENDPOINTS = CAPABILITY_MUTATION_METHODS.map(method => `${CAPABILITY_MUTATION_NAMESPACE}/${method}`)

/** Let every coalesced microtask (and a hostile extra turn) run. */
async function settle() {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

function inactiveEffect() {
  const error = new Error('cannot create effect on inactive context')
  error.code = 'INACTIVE_EFFECT'
  return error
}

/** The pre-fix shape: a read-only contribution under the same package+face. */
function legacyReadContribution() {
  return {
    package: 'weir-harness',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: CAPABILITY_READ_METHODS.map(method => ({
      id: `weir-harness.${CAPABILITY_READ_NAMESPACE}.${method}`,
      service: CAPABILITY_READ_SERVICE_KEY,
      namespace: CAPABILITY_READ_NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } }],
      result: { mode: 'src-json' },
    })),
  }
}

function foreignContribution(packageName, method = 'probe') {
  return {
    package: packageName,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [{ id: `${packageName}.${packageName}/${method}`, service: 'typert', namespace: packageName, method, invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' } }],
  }
}

/**
 * Registry double reproducing the rules this module depends on. `warnings`
 * collects the plugin's logger output, `attempts` records every register call
 * (accepted or rejected) so a retry storm is observable, and `batches` records
 * committed endpoint lists so atomicity is observable.
 */
function createRegistry() {
  const registry = {
    counter: 0,
    packages: new Map(),
    endpoints: new Map(),
    invocationIds: new Map(),
    seen: new Set(),
    listeners: new Set(),
    services: new Map(),
    warnings: [],
    attempts: [],
    batches: [],
    live() { return CAPABILITY_ENDPOINTS.filter(endpoint => registry.endpoints.has(endpoint)) },
    weirAttempts() { return registry.attempts.filter(attempt => attempt.endpoints.some(endpoint => CAPABILITY_ENDPOINTS.includes(endpoint))) },
    weirBatches() { return registry.batches.filter(batch => batch.some(endpoint => CAPABILITY_ENDPOINTS.includes(endpoint))) },
    packageFace() { return registry.packages.has('weir-harness#host') },
    listenerCount() { return registry.listeners.size },
    rejected(reason) { return registry.attempts.filter(attempt => attempt.rejected === reason).length },
    emit(change) { for (const listener of [...registry.listeners]) listener(change) },
    validate(contribution) {
      if (typeof contribution?.package !== 'string' || contribution.package.length === 0 || contribution.package.includes('#')) throw new TypeError('typert: invalid package name — must be nonempty and contain no "#"')
      if (contribution.face !== 'host' && contribution.face !== 'client') throw new Error(`typert: invalid face ${JSON.stringify(contribution.face)} — expected "host" or "client"`)
      const key = `${contribution.package}#${contribution.face}`
      if (registry.packages.has(key)) throw new Error(`typert: package face "${key}" is already registered`)
      const endpoints = new Set()
      const ids = new Set()
      for (const invocation of contribution.invocations) {
        const endpoint = `${invocation.namespace}/${invocation.method}`
        if (endpoints.has(endpoint) || registry.endpoints.has(endpoint)) throw new Error(`typert: local endpoint "${endpoint}" is already registered`)
        if (ids.has(invocation.id) || registry.invocationIds.has(invocation.id)) throw new Error(`typert: local invocation id "${invocation.id}" is already registered`)
        endpoints.add(endpoint)
        ids.add(invocation.id)
      }
      return { key, package: contribution.package, face: contribution.face }
    },
    register(contribution, fiber) {
      const attempt = { endpoints: contribution.invocations.map(invocation => `${invocation.namespace}/${invocation.method}`) }
      registry.attempts.push(attempt)
      try {
        const record = registry.validate(contribution)
        // The registry creates its commit/withdraw effect on the CALLING fiber:
        // a detached fiber rejects the whole batch (Cordis's final barrier).
        fiber.effect(() => {
          const owner = {}
          registry.packages.set(record.key, record)
          for (const invocation of contribution.invocations) {
            const endpoint = `${invocation.namespace}/${invocation.method}`
            registry.endpoints.set(endpoint, { invocation, owner })
            registry.invocationIds.set(invocation.id, { invocation, owner })
            registry.seen.add(endpoint)
          }
          registry.batches.push(attempt.endpoints)
          for (const endpoint of attempt.endpoints) registry.emit({ kind: 'local', key: endpoint })
          return () => {
            if (registry.packages.get(record.key) === record) registry.packages.delete(record.key)
            const withdrawn = []
            for (const invocation of contribution.invocations) {
              const endpoint = `${invocation.namespace}/${invocation.method}`
              if (registry.endpoints.get(endpoint)?.owner !== owner) continue
              registry.endpoints.delete(endpoint)
              if (registry.invocationIds.get(invocation.id)?.owner === owner) registry.invocationIds.delete(invocation.id)
              withdrawn.push(endpoint)
            }
            for (const endpoint of withdrawn) registry.emit({ kind: 'local', key: endpoint })
          }
        }, 'typert-register')
        attempt.accepted = true
      } catch (cause) {
        attempt.rejected = cause?.code === 'INACTIVE_EFFECT' ? 'INACTIVE_EFFECT' : 'registry'
        attempt.message = cause instanceof Error ? cause.message : String(cause)
        throw cause
      }
      return attempt
    },
  }
  return registry
}

/**
 * Minimal Cordis fiber. Effects are created in order, a detached fiber
 * (`uid === null`) rejects effect creation with INACTIVE_EFFECT, and disposal
 * orders can model the real unwind: the registration withdrawal can fire while
 * the subscription is still attached, and the disposal latch can land after the
 * queued microtasks.
 */
function createFiber(registry, name) {
  const effects = []
  let detachedLatch
  const fiber = {
    name,
    uid: ++registry.counter,
    logger: { warn: text => registry.warnings.push(text) },
    get(key) {
      if (key === 'typert') {
        return {
          register: contribution => registry.register(contribution, fiber),
          local: {
            get: endpoint => registry.endpoints.get(endpoint)?.invocation,
            hasSeen: endpoint => registry.seen.has(endpoint),
            subscribe: listener => fiber.effect(() => {
              registry.listeners.add(listener)
              return () => registry.listeners.delete(listener)
            }, 'typert-subscription'),
          },
        }
      }
      if (key === 'sessionQuery') return registry.sessionQuery
      return registry.services.get(key)?.value
    },
    effect(execute, label) {
      if (fiber.uid === null) throw inactiveEffect()
      const dispose = execute()
      if (typeof dispose === 'function') effects.push({ run: dispose, label })
      return () => {}
    },
    emit() {},
    root: {
      reflect: {
        provide(key, value) {
          // A host-root provide lives on the ROOT fiber: it is never released
          // by this fiber's disposal and a second provide is refused.
          if (registry.services.has(key)) throw new Error(`service "${key}" has been registered at <root>`)
          const record = { value, fiber }
          registry.services.set(key, record)
          return () => { if (registry.services.get(key) === record) registry.services.delete(key) }
        },
      },
    },
    /** Take one registry-service slot exactly like the shipped apply does. */
    provideService(key, value) {
      return fiber.root.reflect.provide(key, value)
    },
    /** Full disposal; `listenerLast` lets the withdrawal fire while the listener is still attached. */
    dispose(options = {}) {
      fiber.uid = null
      const pending = effects.splice(0)
      const latch = pending[0]
      const rest = pending.slice(1)
      if (options.listenerLast === true && options.latchLast === true) {
        for (const entry of rest.filter(entry => entry.label !== 'typert-subscription')) entry.run()
        latch?.run()
        for (const entry of rest.filter(entry => entry.label === 'typert-subscription')) entry.run()
        return
      }
      for (const entry of [...pending].reverse()) entry.run()
    },
    /** Cordis unload: uid clears first, the withdrawal fires while the listener is attached, latch still pending. */
    detach() {
      fiber.uid = null
      const pending = effects.splice(0)
      detachedLatch = pending[0]
      for (const entry of pending.slice(1).filter(entry => entry.label === 'typert-register')) entry.run()
      for (const entry of pending.slice(1).filter(entry => entry.label === 'typert-subscription')) entry.run()
    },
    finishDetach() {
      detachedLatch?.run()
      detachedLatch = undefined
    },
  }
  return fiber
}

/** The legacy generation: services provided, only the five read endpoints registered. */
function mountLegacy(registry) {
  const fiber = createFiber(registry, 'legacy-generation')
  fiber.provideService(CAPABILITY_READ_SERVICE_KEY, Object.freeze({ legacy: true, typertRemote: Object.freeze({ service: null, serviceKey: CAPABILITY_READ_SERVICE_KEY, namespace: CAPABILITY_READ_NAMESPACE }) }))
  fiber.provideService(CAPABILITY_MUTATION_SERVICE_KEY, Object.freeze({ legacy: true, typertRemote: Object.freeze({ service: null, serviceKey: CAPABILITY_MUTATION_SERVICE_KEY, namespace: CAPABILITY_MUTATION_NAMESPACE }) }))
  const fiberTypert = fiber.get('typert')
  fiberTypert.register(legacyReadContribution())
  return fiber
}

test('a legacy read-only registration is recovered as all seven endpoints after the old generation disposes', async () => {
  const registry = createRegistry()
  const legacy = mountLegacy(registry)
  expect(registry.live()).toEqual(READ_ENDPOINTS)
  expect(registry.packageFace()).toBe(true)

  // The new generation applies while the legacy package face is still live: its
  // registration is rejected (one attempt, one warning) and it keeps a listener.
  const product = createFiber(registry, 'product-generation')
  remoteApply(product)
  expect(registry.live()).toEqual(READ_ENDPOINTS)
  expect(registry.weirBatches()).toHaveLength(1)
  expect(registry.listenerCount()).toBe(1)
  expect(registry.warnings.filter(text => text.includes('registration failed'))).toHaveLength(1)

  // Old generation disposal withdraws the whole legacy batch; the survivor's
  // own listener restores every endpoint, atomically.
  legacy.dispose()
  await settle()
  expect(registry.live()).toEqual(CAPABILITY_ENDPOINTS)
  expect(registry.packageFace()).toBe(true)
  expect(registry.weirBatches()).toHaveLength(2)
  expect(registry.weirBatches().at(-1)).toEqual(CAPABILITY_ENDPOINTS)
  // No endpoint was ever committed alone: every recovered batch is the whole set.
  for (const batch of registry.weirBatches().slice(1)) expect(batch).toEqual(CAPABILITY_ENDPOINTS)
  // The survivor is the live listener; the disposed generation left none behind.
  expect(registry.listenerCount()).toBe(1)
  product.dispose()
  await settle()
})

test('disposing the sole generation withdraws the package and every endpoint, and nothing resurrects them', async () => {
  const registry = createRegistry()
  const survivor = createFiber(registry, 'sole-generation')
  remoteApply(survivor)
  expect(registry.live()).toEqual(CAPABILITY_ENDPOINTS)
  expect(registry.listenerCount()).toBe(1)
  const attemptsAfterMount = registry.weirAttempts().length

  // Harshest unwind: the withdrawal fires BEFORE the listener is removed.
  survivor.dispose({ listenerLast: true, latchLast: true })
  await settle()
  expect(registry.live()).toEqual([])
  expect(registry.packageFace()).toBe(false)
  expect(registry.listenerCount()).toBe(0)

  // Hostile unrelated registry traffic after the withdrawal: no surviving
  // listener may react, and the disposed fiber may never re-register.
  const stranger = createFiber(registry, 'stranger')
  stranger.get('typert').register(foreignContribution('foreign-package'))
  await settle()
  stranger.get('typert').register(foreignContribution('second-foreign-package'))
  await settle()
  expect(registry.live()).toEqual([])
  expect(registry.packageFace()).toBe(false)
  expect(registry.weirAttempts()).toHaveLength(attemptsAfterMount)
  expect(registry.rejected('INACTIVE_EFFECT')).toBe(0)
})

for (const listenerOutlivesWithdrawal of [true, false]) {
  test(`the survivor recovers whatever the listener order (${listenerOutlivesWithdrawal ? 'old listener outlives the withdrawal' : 'old listener removed first'})`, async () => {
    const registry = createRegistry()
    // Previous incarnation: the same shipped apply, so it owns all seven
    // endpoints AND its own listener — the old generation that must not consume
    // the survivor's retry.
    const previous = createFiber(registry, 'previous-incarnation')
    remoteApply(previous)
    expect(registry.live()).toEqual(CAPABILITY_ENDPOINTS)

    // Overlapping reload: the survivor applies while the previous incarnation is
    // still live, so it neither provides nor registers — it only subscribes.
    const survivor = createFiber(registry, 'survivor')
    remoteApply(survivor)
    expect(registry.weirAttempts()).toHaveLength(1)
    expect(registry.listenerCount()).toBe(2)

    // Unrelated registry traffic while the endpoints are still complete must not
    // swallow anything (the survivor's retry must stay available).
    const stranger = createFiber(registry, 'stranger')
    stranger.get('typert').register(foreignContribution('unrelated-package'))
    await settle()
    expect(registry.listenerCount()).toBe(2)

    // The previous incarnation unwinds: its withdrawal is observed by BOTH
    // listeners (old one first, it subscribed first). Per-fiber retry state is
    // what keeps the survivor's retry from being consumed by the dead one.
    previous.dispose({ listenerLast: listenerOutlivesWithdrawal, latchLast: listenerOutlivesWithdrawal })
    await settle()
    expect(registry.live()).toEqual(CAPABILITY_ENDPOINTS)
    expect(registry.weirBatches().at(-1)).toEqual(CAPABILITY_ENDPOINTS)
    expect(registry.listenerCount()).toBe(1)
    // The dead generation's retry never committed a batch: exactly one recovery
    // batch (the previous incarnation's original one, plus the survivor's).
    expect(registry.weirBatches()).toHaveLength(2)
    survivor.dispose()
    await settle()
    expect(registry.live()).toEqual([])
  })
}

test('a retry queued before disposal is rejected by the detached fiber and recreates nothing', async () => {
  const registry = createRegistry()
  const legacy = mountLegacy(registry)
  const product = createFiber(registry, 'product-generation')
  remoteApply(product)
  expect(registry.live()).toEqual(READ_ENDPOINTS)
  const attemptsAfterMount = registry.weirAttempts().length

  // The old generation withdraws: the survivor's listener queues its retry. The
  // retry would SUCCEED on a live fiber (the endpoints are gone, the package
  // face is free), which is exactly the hostile case: the fiber is detached in
  // the same turn, before the queued microtask runs.
  legacy.dispose()
  product.detach()
  await settle()
  // The queued retry DID run and was rejected by the detached fiber (Cordis's
  // final barrier): no warning, no commit, no resurrection.
  expect(registry.rejected('INACTIVE_EFFECT')).toBe(1)
  expect(registry.live()).toEqual([])
  expect(registry.packageFace()).toBe(false)
  expect(registry.warnings.filter(text => text.includes('registration failed'))).toHaveLength(1)
  product.finishDetach()
  await settle()
  // Later unrelated changes cannot reach the finished latch either.
  const stranger = createFiber(registry, 'stranger')
  stranger.get('typert').register(foreignContribution('unrelated-package'))
  await settle()
  expect(registry.live()).toEqual([])
  expect(registry.weirAttempts()).toHaveLength(attemptsAfterMount + 1)
})

test('a burst of changes while the endpoints stay incomplete is one attempt and one warning', async () => {
  const registry = createRegistry()
  const legacy = mountLegacy(registry)
  const product = createFiber(registry, 'product-generation')
  remoteApply(product)
  const attemptsAfterMount = registry.attempts.length
  const stranger = createFiber(registry, 'stranger')
  for (let index = 0; index < 5; index += 1) stranger.get('typert').register(foreignContribution(`burst-${index}-package`))
  // Five changes, each observed while the package face is still taken: the
  // listener coalesces them into a bounded number of attempts, and the warning
  // latch keeps the log to one line. (The apply-time attempt was the first.)
  await settle()
  expect(registry.weirAttempts().length <= attemptsAfterMount + 2).toBe(true)
  expect(registry.warnings.filter(text => text.includes('registration failed'))).toHaveLength(1)
  legacy.dispose()
  await settle()
  expect(registry.live()).toEqual(CAPABILITY_ENDPOINTS)
  product.dispose()
  await settle()
})

test('the contribution is the only batch the registry can key for this package+face', () => {
  const registry = createRegistry()
  const fiber = createFiber(registry, 'shape-generation')
  const typert = fiber.get('typert')
  typert.register(capabilityContribution())
  expect(registry.live()).toEqual(CAPABILITY_ENDPOINTS)
  // A second registration of the same package face is refused as a whole: no
  // partial endpoint set can be added on top of a live generation.
  const rejection = (() => { try { typert.register(capabilityContribution()); return null } catch (error) { return error } })()
  expect(rejection instanceof Error).toBe(true)
  expect(rejection.message).toContain('already registered')
  expect(registry.live()).toEqual(CAPABILITY_ENDPOINTS)
})
