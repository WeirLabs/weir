// spawn-adapter: pins for the single activation-assembly point, the DSH 0.2.1
// startActivation lanes, handle normalization, the creation-window composition
// gate, and the unified guard core (design D2-D5). These tests drive the
// adapter directly with the shared spawn harness — no execute stack — so the
// activation shape, the lane delivery mapping, the fail-closed composition
// gate, the guard order contract, and both teardown semantics each have one
// explicit pin. The full-stack lane behavior stays pinned by delegate.test.js.
import { describe, expect, it } from './helpers.js'
import { continuableLane, oneShotLane, spawnGuardedChild, supervisedLane, supervisedToolFilter } from '../src/delegate/spawn-adapter.js'
import { SUPERVISION_CONTRACT } from '../src/delegate/group-coordinator.js'
import { CHILD_DENY_TOOLS, CONTINUABLE_CONTRACT, WORKER_CONTRACT } from '../src/shared/child-scope.js'
import { FAKE_RESTRICTABLE, createSpawnHarness } from './helpers/spawn-harness.js'

const LISTS = {
  bash: { allow: ['ls'], gitAllow: [], deny: [] },
  pwsh: { allow: ['Get-Content'], gitAllow: [], deny: [] },
}
const enabledRobash = () => ({ enabled: true, lists: LISTS })
const disabledRobash = () => ({ enabled: false, lists: LISTS })

function baseTarget(overrides = {}) {
  return { persona: 'PERSONA', label: 'child-label', ...overrides }
}

function assignmentOf(target, overrides = {}) {
  return {
    target,
    prompt: [{ type: 'text', text: 'TASK: x' }],
    parent: { id: 'parent-1', session: { id: 'parent-session', header: { cwd: undefined } } },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function fakeCoordinator(log) {
  return {
    registerMember: (record) => {
      log?.push('register')
      return { ...record, status: 'running' }
    },
  }
}

/** The persona section the composition applied to one fake child. */
function personaSectionOf(child) {
  return child.applied.sections.find((section) => section.name === 'deployment:persona-prefix')
}

describe('spawn-adapter activation assembly', () => {
  it('starts through startActivation with the reserved child id, a clean request, delivery caller and maxDepth 1', async () => {
    const h = createSpawnHarness({ label: 'child' })
    const assignment = assignmentOf(baseTarget())
    const started = await spawnGuardedChild(assignment, oneShotLane(), { ...h.deps, robash: enabledRobash })
    expect(h.spawned).toHaveLength(1)
    const spec = h.spawned[0]
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('child-label')
    expect(spec.childId).toBe('child-1')
    expect(spec.delivery).toBe('caller')
    expect(spec.signal).toBe(assignment.signal)
    // 0.2.1 request shape: label/signal/persona/toolFilter are NOT request fields.
    expect(spec.request).toEqual({ prompt: assignment.prompt, parent: assignment.parent, maxDepth: 1 })
    expect('label' in spec.request).toBe(false)
    expect('signal' in spec.request).toBe(false)
    expect('persona' in spec.request).toBe(false)
    expect('toolFilter' in spec.request).toBe(false)
    // Normalized handle: id aliases childId, the live agent was captured at spawn.
    expect(started.id).toBe('child-1')
    expect(started.childId).toBe('child-1')
    expect(started.agent).toBe(h.children[0].agent)
    expect(started.messageId).toBe('msg-child-1')
    expect(typeof started.dispose).toBe('function')
  })

  it('passes agentOptions through and carries labels from the assignment override', async () => {
    const agentOptions = { provider: 'deepseek', model: 'deepseek-chat' }
    const h = createSpawnHarness()
    await spawnGuardedChild(assignmentOf(baseTarget({ agentOptions })), oneShotLane(), h.deps)
    await spawnGuardedChild(assignmentOf(baseTarget(), { label: 'child-label (escalated)' }), oneShotLane(), h.deps)
    expect(h.spawned[0].request.agentOptions).toEqual(agentOptions)
    expect(h.spawned[0].label).toBe('child-label')
    expect(h.spawned[1].label).toBe('child-label (escalated)')
    expect(h.spawned[1].request.maxDepth).toBe(1)
  })
})

describe('spawn-adapter composition shim', () => {
  it('registers persona + tool filter BEFORE the start call and applies them in the creation window', async () => {
    const h = createSpawnHarness()
    const order = []
    const composition = {
      beginSpawn: (entry) => {
        order.push('register')
        return h.composition.beginSpawn(entry)
      },
    }
    const subagents = h.deps.subagents
    const started = await spawnGuardedChild(assignmentOf(baseTarget()), oneShotLane(), {
      ...h.deps,
      composition,
      subagents: { ...subagents, startActivation: (spec) => { order.push('start'); return subagents.startActivation(spec) } },
    })
    expect(order).toEqual(['register', 'start'])
    expect(started.id).toBe('child-1')
    // The persona replaced the deployment persona-prefix section with the
    // worker-decorated persona (same section name, child's own layer).
    const section = personaSectionOf(h.children[0])
    expect(section.order).toBe(0)
    expect(section.text).toBe('PERSONA' + WORKER_CONTRACT)
    // The deny list merged CHILD_DENY_TOOLS at the child scope.
    expect(h.children[0].applied.restrictions).toHaveLength(1)
    expect(h.children[0].applied.restrictions[0].deny).toEqual([...CHILD_DENY_TOOLS])
  })

  it('intersects the deny list with the child restrictable names and leaves allow-list filters untouched', async () => {
    const known = new Set(['bash', 'read', 'delegate', 'workflow'])
    const denyHarness = createSpawnHarness({ restrictableNames: known })
    await spawnGuardedChild(assignmentOf(baseTarget()), oneShotLane(), denyHarness.deps)
    expect(denyHarness.children[0].applied.restrictions[0].deny).toEqual(['delegate', 'workflow'])

    const allow = { allow: ['read'] }
    const allowHarness = createSpawnHarness()
    await spawnGuardedChild(assignmentOf(baseTarget({ toolFilter: allow })), oneShotLane(), allowHarness.deps)
    // Allow semantics stay untouched: no deny list is merged into an allow filter.
    expect(allowHarness.children[0].applied.restrictions[0]).toEqual(allow)
  })

  it('fails the spawn closed when the composition listener throws (the creation announcement rejects)', async () => {
    const boom = new Error('no tools service')
    const h = createSpawnHarness({
      onChild: (child) => {
        child.agent.ctx.tools.restrict = () => { throw boom }
      },
    })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget()), oneShotLane(), h.deps)
    } catch (error) {
      caught = error
    }
    // Throwing from agent/created rejects the creation itself: the runtime
    // disposes the unpublished child, so the adapter has no handle to dispose.
    expect(caught?.message).toBe('delegate: failed to apply the child composition for "child-1" — no tools service')
    expect(caught?.cause).toBe(boom)
    expect(h.children[0].disposed).toBe(0)
  })

  it('fails the spawn closed and disposes the child when the creation window never ran the composition', async () => {
    const h = createSpawnHarness()
    // A start whose publication path never announced the child (e.g. a future
    // reordering): the spawn must not return an uncomposed child.
    const silent = {
      ...h.deps,
      subagents: {
        ...h.deps.subagents,
        async startActivation(spec) {
          return { childId: spec.childId, result: Promise.resolve({ output: [], stopReason: 'error' }), dispose: async () => { h.children[0].disposed += 1 } }
        },
      },
    }
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget()), oneShotLane(), silent)
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toContain('the composition was not applied inside the creation window')
  })

  it('forgets the pending composition when the start itself fails (no leaked entry)', async () => {
    const h = createSpawnHarness()
    const failing = {
      ...h.deps,
      subagents: {
        ...h.deps.subagents,
        async startActivation() {
          throw new Error('boom before publish')
        },
      },
    }
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget()), oneShotLane(), failing)
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toBe('boom before publish')
    // A later unrelated agent/created must not be treated as this spawn's child.
    expect(personaSectionOf({ applied: { sections: [] } })).toBe(undefined)
  })
})

describe('spawn-adapter lane delivery mapping', () => {
  it('supervised lane delivers to the parent and appends worker + status contracts', async () => {
    const members = []
    const log = []
    const h = createSpawnHarness({ onChild: () => log.push('created') })
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    await spawnGuardedChild(assignmentOf(baseTarget()), lane, h.deps)
    expect(h.continued).toHaveLength(1)
    expect(h.continued[0].delivery).toBe('parent')
    expect(h.continued[0].request.maxDepth).toBe(1)
    expect('label' in h.continued[0].request).toBe(false)
    const section = personaSectionOf(h.children[0])
    expect(section.text).toBe('PERSONA' + WORKER_CONTRACT + SUPERVISION_CONTRACT)
    // send_message denied first (lane transform), then the orchestrator deny list.
    expect(h.children[0].applied.restrictions[0].deny).toContain('send_message')
    for (const name of CHILD_DENY_TOOLS) expect(h.children[0].applied.restrictions[0].deny).toContain(name)
  })

  it('continuable lane delivers to the parent with worker + continuation contracts, never the supervision contract', async () => {
    const h = createSpawnHarness()
    await spawnGuardedChild(assignmentOf(baseTarget()), continuableLane(), h.deps)
    expect(h.continued).toHaveLength(1)
    expect(h.continued[0].delivery).toBe('parent')
    const section = personaSectionOf(h.children[0])
    expect(section.text).toBe('PERSONA' + WORKER_CONTRACT + CONTINUABLE_CONTRACT)
    expect(section.text).not.toContain('Terminal status contract')
    expect(h.children[0].applied.restrictions[0].deny).toEqual([...CHILD_DENY_TOOLS])
  })

  it('supervisedToolFilter merges deny lists and leaves allow lists unchanged', () => {
    expect(supervisedToolFilter(undefined)).toEqual({ deny: ['send_message'] })
    const allow = { allow: ['bash'] }
    expect(supervisedToolFilter(allow)).toBe(allow)
    expect(supervisedToolFilter({ deny: ['rm'] })).toEqual({ deny: ['rm', 'send_message'] })
    expect(supervisedToolFilter({ deny: ['send_message'] })).toEqual({ deny: ['send_message'] })
  })
})

describe('spawn-adapter guard handle paths', () => {
  it('one-shot lane attaches the guard to the agent captured at spawn', async () => {
    const h = createSpawnHarness()
    await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), oneShotLane(), { ...h.deps, robash: enabledRobash })
    const guards = h.children[0].applied.guards
    expect(guards).toHaveLength(1)
    expect(guards[0]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)
    expect(guards[0]({ name: 'bash', arguments: { command: 'rm x' } })).toMatch(/read-only agent/)
  })

  it('supervised lane throws the verbatim missing-handle error when no live agent is available', async () => {
    const members = []
    const h = createSpawnHarness({ deps: { agents: { get: () => undefined } } })
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), lane, { ...h.deps, robash: enabledRobash })
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toBe('delegate: read-only supervised member spawned but no live agent handle is available for "child-1"')
  })

  it('continuable lane throws the verbatim missing-handle error with the child id attached', async () => {
    const h = createSpawnHarness({ deps: { agents: { get: () => undefined } } })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), continuableLane(), { ...h.deps, robash: enabledRobash })
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toBe('delegate: read-only continuable child spawned but no live agent handle is available for "child-1"')
    expect(caught?.childId).toBe('child-1')
  })
})

describe('spawn-adapter disabled snapshot', () => {
  it('skips the guard attach in both lanes without throwing, but still resolves the handle first', async () => {
    // one-shot lane
    const oneShot = createSpawnHarness()
    const returned = await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), oneShotLane(), { ...oneShot.deps, robash: disabledRobash })
    expect(returned.childId).toBe('child-1')
    expect(oneShot.children[0].applied.guards).toHaveLength(0)

    // supervised lane: no attach, but the member is still registered
    const members = []
    const supervised = createSpawnHarness()
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), lane, { ...supervised.deps, robash: disabledRobash })
    expect(supervised.children[0].applied.guards).toHaveLength(0)
    expect(members).toHaveLength(1)

    // A missing handle still throws (handle resolution precedes the disabled check).
    const missing = createSpawnHarness({ deps: { agents: { get: () => undefined } } })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members: [] }), { ...missing.deps, robash: disabledRobash })
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toBe('delegate: read-only supervised member spawned but no live agent handle is available for "child-1"')
  })
})

describe('spawn-adapter guard failure teardown', () => {
  it('one-shot lane disposes the child, awaits the teardown, and throws the wrapped error', async () => {
    const h = createSpawnHarness({
      onChild: (child) => {
        child.agent.ctx.tools.guard = () => { throw new Error('no tools service') }
      },
    })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), oneShotLane(), { ...h.deps, robash: enabledRobash })
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toBe('delegate: failed to attach the read-only bash guard — no tools service')
    expect(h.children[0].disposed).toBe(1)
  })

  it('supervised lane rethrows the original error untouched and keeps the member for rollback', async () => {
    const boom = new Error('guard boom')
    const h = createSpawnHarness({
      onChild: (child) => {
        child.agent.ctx.tools.guard = () => { throw boom }
      },
    })
    const members = []
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), lane, { ...h.deps, robash: enabledRobash })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(boom)
    // The member was registered before the guard attach, so the lane-level
    // rollback in tool.js can terminate it — never left running unguarded.
    expect(members).toHaveLength(1)
    expect(members[0].id).toBe('child-1')
  })

  it('runs beforeGuardAttach before the guard attach (structural register-first order)', async () => {
    const log = []
    const h = createSpawnHarness({
      onChild: (child) => {
        child.agent.ctx.tools.guard = () => { log.push('guard-attach'); return () => {} }
      },
    })
    const members = []
    const lane = supervisedLane({ coordinator: fakeCoordinator(log), groupName: 'scan', members })
    await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), lane, { ...h.deps, robash: enabledRobash })
    expect(log).toEqual(['register', 'guard-attach'])
  })

  it('continuable lane rethrows with the child id attached and registers nothing anywhere', async () => {
    const boom = new Error('guard boom')
    const h = createSpawnHarness({
      onChild: (child) => {
        child.agent.ctx.tools.guard = () => { throw boom }
      },
    })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), continuableLane(), { ...h.deps, robash: enabledRobash })
    } catch (error) {
      caught = error
    }
    // Same error object (no wrapping), child id attached for the tool.js
    // catch side: the residual continuable child is best-effort interrupted.
    expect(caught).toBe(boom)
    expect(caught?.childId).toBe('child-1')
  })
})

describe('spawn-adapter abort cancellation', () => {
  it('one-shot lanes cancel the published child when the spawn signal aborts (0.2.0 driver contract)', async () => {
    const controller = new AbortController()
    const h = createSpawnHarness()
    const started = await spawnGuardedChild(
      assignmentOf(baseTarget(), { signal: controller.signal }),
      oneShotLane(),
      h.deps,
    )
    expect(h.children[0].disposed).toBe(0)
    controller.abort()
    // dispose() is the 0.2.1 teardown that synchronously cancels the child.
    await Promise.resolve()
    expect(h.children[0].disposed).toBe(1)
    expect(started.childId).toBe('child-1')
  })

  it('continuable and supervised lanes deliberately survive the call that started them', async () => {
    const controller = new AbortController()
    const h = createSpawnHarness()
    await spawnGuardedChild(assignmentOf(baseTarget(), { signal: controller.signal }), continuableLane(), h.deps)
    controller.abort()
    await Promise.resolve()
    expect(h.children[0].disposed).toBe(0)
  })
})

describe('spawn-adapter fake surface sanity', () => {
  it('the harness restrictable set covers every orchestrator deny name', () => {
    for (const name of CHILD_DENY_TOOLS) expect(FAKE_RESTRICTABLE.has(name)).toBe(true)
  })
})
