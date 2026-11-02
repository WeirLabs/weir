// Per-mount Lifecycle Feed contract (mcp-management-deepening tasks 1.2/1.3).
// The owner is the unique token whose lazy manager accessor returns the calling
// manager face. Mount order, feed count and process-wide selection faces are not
// ownership evidence.
import { test, expect } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLifecycleFeedRegistry, lifecycleFeedRegistry } from '../src/capabilities/lifecycle-feed.js'
import { createLifecycleSnapshots, INHERITED_ORIGIN } from '../src/capabilities/lifecycle-snapshot.js'
import { preloadLifecycleSnapshots } from '../src/capabilities/lifecycle-preload.js'
import { createMcpGate } from '../src/capabilities/mcp-gate.js'
import { createMcpManager } from '../src/capabilities/mcp-manager.js'
import { createMcpRuntime } from '../src/capabilities/mcp-runtime.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'

function mountedRevision(tag) {
  return {
    tag,
    manager: null,
    lifecycle: {
      snapshotFor: sessionId => ({ state: 'ready', revision: 0, sessionId, mcpServers: [tag] }),
    },
  }
}

test('two distinct mounted revisions resolve their own lifecycle in either mount order', () => {
  for (const order of [['weir', 'weir-creative'], ['weir-creative', 'weir']]) {
    const registry = createLifecycleFeedRegistry()
    const revisions = Object.fromEntries(order.map(tag => [tag, mountedRevision(tag)]))
    const releases = order.map(tag => registry.register({
      lifecycle: revisions[tag].lifecycle,
      manager: () => revisions[tag].manager,
    }))
    try {
      // Selection may mount before its manager. Resolution is deliberately lazy.
      expect(registry.lifecycleFor(revisions[order[0]].manager)).toBeNull()
      revisions.weir.manager = { face: 'weir-manager' }
      revisions['weir-creative'].manager = { face: 'creative-manager' }
      for (const tag of order) {
        const lifecycle = registry.lifecycleFor(revisions[tag].manager)
        expect(lifecycle).toBe(revisions[tag].lifecycle)
        expect(lifecycle.snapshotFor(`${tag}-session`).mcpServers).toEqual([tag])
      }
    } finally {
      for (const release of releases.reverse()) release()
    }
  }
})

test('missing or ambiguous ownership fails closed without a sole-feed or mount-order fallback', () => {
  const registry = createLifecycleFeedRegistry()
  const first = mountedRevision('first')
  const second = mountedRevision('second')
  first.manager = { face: 'first' }
  second.manager = { face: 'second' }
  const foreign = { face: 'foreign' }
  const releaseFirst = registry.register({ lifecycle: first.lifecycle, manager: () => first.manager })
  try {
    expect(registry.lifecycleFor(foreign)).toBeNull()
    expect(registry.lifecycleFor(null)).toBeNull()
    const releaseAmbiguous = registry.register({ lifecycle: second.lifecycle, manager: () => first.manager })
    try {
      expect(registry.lifecycleFor(first.manager)).toBeNull()
      expect(registry.lifecycleFor(second.manager)).toBeNull()
    } finally { releaseAmbiguous() }
    expect(registry.lifecycleFor(first.manager)).toBe(first.lifecycle)
  } finally { releaseFirst() }
  expect(registry.lifecycleFor(first.manager)).toBeNull()
})

test('token disposal is idempotent and out-of-order disposal preserves siblings and replacements', () => {
  const registry = createLifecycleFeedRegistry()
  const oldRevision = mountedRevision('old')
  const sibling = mountedRevision('sibling')
  const replacement = mountedRevision('replacement')
  oldRevision.manager = sibling.manager = replacement.manager = null
  oldRevision.manager = { face: 'old' }
  sibling.manager = { face: 'sibling' }
  replacement.manager = oldRevision.manager
  const releaseOld = registry.register({ lifecycle: oldRevision.lifecycle, manager: () => oldRevision.manager })
  const releaseSibling = registry.register({ lifecycle: sibling.lifecycle, manager: () => sibling.manager })
  const releaseReplacement = registry.register({ lifecycle: replacement.lifecycle, manager: () => replacement.manager })

  expect(registry.lifecycleFor(oldRevision.manager)).toBeNull()
  releaseOld()
  releaseOld()
  expect(registry.lifecycleFor(oldRevision.manager)).toBe(replacement.lifecycle)
  expect(registry.lifecycleFor(sibling.manager)).toBe(sibling.lifecycle)
  releaseSibling()
  expect(registry.lifecycleFor(oldRevision.manager)).toBe(replacement.lifecycle)
  releaseReplacement()
  releaseSibling()
  expect(registry.lifecycleFor(oldRevision.manager)).toBeNull()
})

test('manager arrival and accessor recovery are observed on every adjudication', () => {
  const registry = createLifecycleFeedRegistry()
  const revision = mountedRevision('late')
  let available = false
  let calls = 0
  const manager = { face: 'late-manager' }
  const release = registry.register({
    lifecycle: revision.lifecycle,
    manager: () => {
      calls += 1
      if (!available) throw new Error('manager is not mounted yet')
      return manager
    },
  })
  try {
    expect(registry.lifecycleFor(manager)).toBeNull()
    available = true
    expect(registry.lifecycleFor(manager)).toBe(revision.lifecycle)
    expect(registry.lifecycleFor(manager)).toBe(revision.lifecycle)
    expect(calls).toBe(3)
  } finally { release() }
})

test('bare manager denies by default and a late selection feed admits only while owned', async () => {
  const runtime = createMcpRuntime()
  const token = runtime.begin('docs', { generation: 1, incarnation: 'inc-docs', operationId: 'op-docs' })
  runtime.finish(token, 'mounted', { generation: 1, incarnation: 'inc-docs' })
  const services = new Map()
  const ctx = {
    get: () => undefined,
    on: () => {},
    reflect: { provide: (name, value) => services.set(name, value) },
    logger: { warn() {} },
  }
  const dispose = createMcpManager({
    runtime,
    registry: { read: async () => ({ kind: 'absent', revision: 0 }) },
    store: { read: async () => ({ kind: 'absent', revision: 0 }) },
    mount: {
      mounted: new Map([['docs', { generation: 1, state: 'mounted' }]]),
      sweepResidue: async () => [],
    },
    agents: { list: () => [], get: () => null },
    listRows: () => [],
    listEntryIds: () => [],
  })(ctx, {})
  const face = services.get('weirMcpManager')
  const agent = { session: { id: 'bare-session' } }
  let release = null
  try {
    // Runtime and incarnation are otherwise admissible: only lifecycle ownership
    // is absent. A bare manager must not borrow a process-wide/sole selection.
    expect(face.gate.enabledFor(agent, 'docs')).toBe(false)
    release = lifecycleFeedRegistry.register({
      lifecycle: {
        snapshotFor: sessionId => ({
          state: 'ready', sessionId, revision: 0,
          mcpServers: ['docs'], mcpIncarnations: { docs: 'inc-docs' },
        }),
      },
      manager: () => face,
    })
    expect(face.gate.enabledFor(agent, 'docs')).toBe(true)
    release()
    release = null
    expect(face.gate.enabledFor(agent, 'docs')).toBe(false)
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    release?.()
    dispose()
  }
})

test('owning lifecycle keeps accepted-before-inherited preload and inherited-only cold reads distinct', async () => {
  const rootA = mkdtempSync(join(tmpdir(), 'weir-feed-owner-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'weir-feed-owner-b-'))
  const storeA = openCapabilityStore({ root: rootA, platform: 'darwin' })
  const storeB = openCapabilityStore({ root: rootB, platform: 'darwin' })
  const sessionId = 'shared-cold-session'
  const incarnation = identity => `inc-${identity}`
  const payload = identities => ({
    skills: [], mcpServers: identities,
    mcpIncarnations: Object.fromEntries(identities.map(identity => [identity, incarnation(identity)])),
  })
  await storeA.commit({ kind: 'selection', sessionId }, 0, () => payload(['accepted-a']))
  await storeA.commit({ kind: 'inherited', sessionId }, 0, () => ({
    ...payload(['inherited-a']), origin: INHERITED_ORIGIN, capturedAt: 10,
    parent: { sessionId: 'parent-a', revision: 4 },
  }))
  await storeB.commit({ kind: 'inherited', sessionId }, 0, () => ({
    ...payload(['inherited-b']), origin: INHERITED_ORIGIN, capturedAt: 20,
    parent: { sessionId: 'parent-b', revision: 5 },
  }))

  const identities = ['accepted-a', 'inherited-a', 'inherited-b']
  const servers = Object.fromEntries(identities.map(identity => [identity, {
    identity, generation: 1, incarnation: incarnation(identity),
  }]))
  const registry = { read: async () => ({ kind: 'ok', revision: 1, enabled: identities, servers }) }
  const lifecycleA = createLifecycleSnapshots({ root: rootA, platform: 'darwin' })
  const lifecycleB = createLifecycleSnapshots({ root: rootB, platform: 'darwin' })
  const feed = createLifecycleFeedRegistry()
  const managerA = { face: 'a' }
  const managerB = { face: 'b' }
  const releaseA = feed.register({ lifecycle: lifecycleA, manager: () => managerA })
  const releaseB = feed.register({ lifecycle: lifecycleB, manager: () => managerB })
  const gateFor = manager => createMcpGate({
    registry,
    lifecycle: { snapshotFor: id => feed.lifecycleFor(manager)?.snapshotFor(id) ?? null },
    registrationFor: identity => servers[identity] ?? null,
  })
  const gateA = gateFor(managerA)
  const gateB = gateFor(managerB)
  const agent = { session: { id: sessionId } }
  try {
    // A uses the real async preload seam; B deliberately remains cold and must
    // restore its inherited unit through snapshotFor on the first gate read.
    expect((await preloadLifecycleSnapshots({ lifecycle: lifecycleA, store: storeA })).loaded).toBe(1)
    expect(lifecycleB.peek(sessionId)).toBeNull()

    expect(await gateA.admit(agent, 'accepted-a', 1)).toBe(true)
    expect(await gateA.admit(agent, 'inherited-a', 1)).toBe(false)
    expect(await gateB.admit(agent, 'inherited-b', 1)).toBe(true)
    expect(await gateB.admit(agent, 'accepted-a', 1)).toBe(false)

    const accepted = lifecycleA.snapshotFor(sessionId)
    const inherited = lifecycleB.snapshotFor(sessionId)
    expect(accepted?.mcpServers).toEqual(['accepted-a'])
    expect(accepted?.captured).toBeNull()
    expect(inherited?.mcpServers).toEqual(['inherited-b'])
    expect(inherited?.captured?.parentSessionId).toBe('parent-b')
  } finally {
    releaseA()
    releaseB()
  }
})
