// Per-mount Lifecycle Feed contract (mcp-management-deepening tasks 1.2/1.3).
// The owner is the unique token whose lazy manager accessor returns the calling
// manager face. Mount order, feed count and process-wide selection faces are not
// ownership evidence.
import { test, expect } from './helpers.js'
import { createLifecycleFeedRegistry } from '../src/capabilities/lifecycle-feed.js'

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
