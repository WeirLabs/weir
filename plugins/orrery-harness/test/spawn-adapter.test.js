// spawn-adapter: pins for the single spawn-assembly point and the unified
// guard core (design D2-D5). These tests drive the adapter directly with
// fakeDeps — no execute stack — so the assembly shape, the lane start shapes,
// the guard order contract, and both fail-closed teardown semantics each have
// one explicit pin. The full-stack lane behavior stays pinned by
// delegate.test.js (zero-change survival).
import { describe, expect, it } from './helpers.js'
import { oneShotLane, spawnGuardedChild, supervisedLane, supervisedToolFilter } from '../src/delegate/spawn-adapter.js'
import { SUPERVISION_CONTRACT } from '../src/delegate/group-coordinator.js'
import { CHILD_DENY_TOOLS, WORKER_CONTRACT } from '../src/shared/child-scope.js'

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
    parent: { id: 'parent-1' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** A live agent handle whose guard registrations are observable. */
function fakeAgentHandle() {
  const attached = []
  return {
    attached,
    ctx: { tools: { guard: (fn) => { attached.push(fn); return () => {} } } },
  }
}

function oneShotDeps(started, robash = enabledRobash) {
  const calls = []
  return {
    calls,
    deps: {
      subagents: {
        async start(name, request) {
          calls.push({ name, request })
          return started
        },
      },
      robash,
    },
  }
}

function supervisedDeps({ agents, robash = enabledRobash, childId = 'child-1' } = {}) {
  const specs = []
  return {
    specs,
    deps: {
      subagents: {
        async startContinuable(spec) {
          specs.push(spec)
          return { childId, messageId: 'msg-1' }
        },
      },
      robash,
      agents,
    },
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

describe('spawn-adapter request assembly', () => {
  it('omits agentOptions when undefined, always sets maxDepth: 1, and denies the orchestrator-only tools', async () => {
    const target = baseTarget()
    const assignment = assignmentOf(target)
    const started = { id: 'c1', localAgent: fakeAgentHandle(), dispose: async () => {} }
    const { calls, deps } = oneShotDeps(started)
    const returned = await spawnGuardedChild(assignment, oneShotLane(), deps)
    expect(returned).toBe(started)
    expect(calls).toHaveLength(1)
    const { name, request } = calls[0]
    expect(name).toBe('spawn')
    expect(request.label).toBe('child-label')
    expect(request.prompt).toBe(assignment.prompt)
    expect(request.parent).toBe(assignment.parent)
    expect(request.signal).toBe(assignment.signal)
    expect('agentOptions' in request).toBe(false)
    // The child tool catalog restriction (CHILD_DENY_TOOLS) applies at this
    // single assembly point even when the target carries no filter.
    expect(request.toolFilter).toEqual({ deny: [...CHILD_DENY_TOOLS] })
    expect(request.maxDepth).toBe(1)
    expect(request.persona).toBe('PERSONA' + WORKER_CONTRACT)
  })

  it('passes agentOptions through and leaves allow-list tool filters untouched', async () => {
    const agentOptions = { provider: 'deepseek', model: 'deepseek-chat' }
    const toolFilter = { allow: ['bash'] }
    const target = baseTarget({ agentOptions, toolFilter })
    const started = { id: 'c1', localAgent: fakeAgentHandle(), dispose: async () => {} }
    const { calls, deps } = oneShotDeps(started)
    await spawnGuardedChild(assignmentOf(target), oneShotLane(), deps)
    expect(calls[0].request.agentOptions).toEqual(agentOptions)
    expect(calls[0].request.toolFilter).toEqual(toolFilter)
    expect(calls[0].request.maxDepth).toBe(1)
  })

  it('defaults the label to target.label and honors an assignment override', async () => {
    const started = { id: 'c1', localAgent: fakeAgentHandle(), dispose: async () => {} }
    const { calls, deps } = oneShotDeps(started)
    await spawnGuardedChild(assignmentOf(baseTarget()), oneShotLane(), deps)
    await spawnGuardedChild(assignmentOf(baseTarget(), { label: 'child-label (escalated)' }), oneShotLane(), deps)
    expect(calls[0].request.label).toBe('child-label')
    expect(calls[1].request.label).toBe('child-label (escalated)')
  })
})

describe('spawn-adapter lane start shapes', () => {
  it('one-shot lane calls start("spawn", request) with label and signal inside the request', async () => {
    const started = { id: 'c1', localAgent: fakeAgentHandle(), dispose: async () => {} }
    const { calls, deps } = oneShotDeps(started)
    const assignment = assignmentOf(baseTarget())
    await spawnGuardedChild(assignment, oneShotLane(), deps)
    expect(calls[0].name).toBe('spawn')
    expect(calls[0].request.label).toBe('child-label')
    expect(calls[0].request.signal).toBe(assignment.signal)
  })

  it('supervised lane calls startContinuable with label/signal beside the request', async () => {
    const members = []
    const { specs, deps } = supervisedDeps({ agents: { get: () => fakeAgentHandle() } })
    const assignment = assignmentOf(baseTarget())
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    await spawnGuardedChild(assignment, lane, deps)
    expect(specs).toHaveLength(1)
    const spec = specs[0]
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('child-label')
    expect(spec.signal).toBe(assignment.signal)
    expect('label' in spec.request).toBe(false)
    expect('signal' in spec.request).toBe(false)
    expect(spec.request.prompt).toBe(assignment.prompt)
    expect(spec.request.parent).toBe(assignment.parent)
    expect(spec.request.maxDepth).toBe(1)
  })
})

describe('spawn-adapter supervised transforms', () => {
  it('always denies send_message and appends worker + status contracts to the persona (supervision last)', async () => {
    const members = []
    const { specs, deps } = supervisedDeps({ agents: { get: () => fakeAgentHandle() } })
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    await spawnGuardedChild(assignmentOf(baseTarget()), lane, deps)
    // The lane transform denies send_message; the assembly point then merges
    // the full orchestrator-only deny list on top.
    expect(specs[0].request.toolFilter.deny).toContain('send_message')
    for (const name of CHILD_DENY_TOOLS) expect(specs[0].request.toolFilter.deny).toContain(name)
    expect(specs[0].request.persona).toBe('PERSONA' + WORKER_CONTRACT + SUPERVISION_CONTRACT)
  })

  it('supervisedToolFilter merges deny lists and leaves allow lists unchanged', () => {
    expect(supervisedToolFilter(undefined)).toEqual({ deny: ['send_message'] })
    const allow = { allow: ['bash'] }
    expect(supervisedToolFilter(allow)).toBe(allow)
    expect(supervisedToolFilter({ deny: ['rm'] })).toEqual({ deny: ['rm', 'send_message'] })
    expect(supervisedToolFilter({ deny: ['send_message'] })).toEqual({ deny: ['send_message'] })
  })
})

describe('spawn-adapter child tool catalog restriction', () => {
  it('merges CHILD_DENY_TOOLS into a deny-only filter after the lane transform', async () => {
    const target = baseTarget({ toolFilter: { deny: ['rm'] } })
    const started = { id: 'c1', localAgent: fakeAgentHandle(), dispose: async () => {} }
    const { calls, deps } = oneShotDeps(started)
    await spawnGuardedChild(assignmentOf(target), oneShotLane(), deps)
    expect(calls[0].request.toolFilter.deny).toEqual(['rm', ...CHILD_DENY_TOOLS])
  })

  it('leaves an allow-list filter byte-identical (allow semantics untouched)', async () => {
    const toolFilter = { allow: ['bash', 'read'] }
    const target = baseTarget({ toolFilter })
    const started = { id: 'c1', localAgent: fakeAgentHandle(), dispose: async () => {} }
    const { calls, deps } = oneShotDeps(started)
    await spawnGuardedChild(assignmentOf(target), oneShotLane(), deps)
    expect(calls[0].request.toolFilter).toBe(toolFilter)
  })

  it('one-shot lane persona carries the worker contract verbatim', async () => {
    const started = { id: 'c1', localAgent: fakeAgentHandle(), dispose: async () => {} }
    const { calls, deps } = oneShotDeps(started)
    await spawnGuardedChild(assignmentOf(baseTarget()), oneShotLane(), deps)
    expect(calls[0].request.persona).toBe('PERSONA' + WORKER_CONTRACT)
  })

  it('intersects the deny list with deps.restrictableNames when provided', async () => {
    const target = baseTarget()
    const started = { id: 'c1', localAgent: fakeAgentHandle(), dispose: async () => {} }
    const { calls, deps } = oneShotDeps(started)
    // Headless-composition shape: only these orchestrator tools are registered.
    deps.restrictableNames = () => new Set(['bash', 'delegate', 'workflow'])
    await spawnGuardedChild(assignmentOf(target), oneShotLane(), deps)
    expect(calls[0].request.toolFilter).toEqual({ deny: ['delegate', 'workflow'] })
  })
})

describe('spawn-adapter guard handle paths', () => {
  it('one-shot lane attaches the guard to started.localAgent', async () => {
    const localAgent = fakeAgentHandle()
    const started = { id: 'c1', localAgent, dispose: async () => {} }
    const { deps } = oneShotDeps(started)
    await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), oneShotLane(), deps)
    expect(localAgent.attached).toHaveLength(1)
    expect(localAgent.attached[0]({ name: 'bash', arguments: { command: 'ls' } })).toBe(undefined)
    expect(localAgent.attached[0]({ name: 'bash', arguments: { command: 'rm x' } })).toMatch(/read-only agent/)
  })

  it('supervised lane attaches through agents.get(childId) and throws the verbatim error when missing', async () => {
    const members = []
    const { deps } = supervisedDeps({ agents: { get: () => undefined }, childId: 'child-9' })
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), lane, deps)
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toBe('delegate: read-only supervised member spawned but no live agent handle is available for "child-9"')
  })
})

describe('spawn-adapter disabled snapshot', () => {
  it('skips the guard attach in both lanes without throwing', async () => {
    // one-shot lane
    const localAgent = fakeAgentHandle()
    const started = { id: 'c1', localAgent, dispose: async () => {} }
    const oneShot = oneShotDeps(started, disabledRobash)
    const returned = await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), oneShotLane(), oneShot.deps)
    expect(returned).toBe(started)
    expect(localAgent.attached).toHaveLength(0)

    // supervised lane: no attach, but the member is still registered
    const handle = fakeAgentHandle()
    const members = []
    const supervised = supervisedDeps({ agents: { get: () => handle }, robash: disabledRobash })
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), lane, supervised.deps)
    expect(handle.attached).toHaveLength(0)
    expect(members).toHaveLength(1)
  })

  it('still throws the missing-handle error when the snapshot is disabled (handle resolution precedes the disabled check)', async () => {
    const members = []
    const { deps } = supervisedDeps({ agents: { get: () => undefined }, robash: disabledRobash, childId: 'child-7' })
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), lane, deps)
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toBe('delegate: read-only supervised member spawned but no live agent handle is available for "child-7"')
  })
})

describe('spawn-adapter guard failure teardown', () => {
  it('one-shot lane disposes the child and throws the wrapped error', async () => {
    let disposed = 0
    const started = {
      id: 'c1',
      localAgent: { ctx: { tools: { guard: () => { throw new Error('no tools service') } } } },
      dispose: async () => { disposed += 1 },
    }
    const { deps } = oneShotDeps(started)
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), oneShotLane(), deps)
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toBe('delegate: failed to attach the read-only bash guard — no tools service')
    expect(disposed).toBe(1)
  })

  it('supervised lane rethrows the original error untouched (no dispose on continuable handles)', async () => {
    const boom = new Error('guard boom')
    const handle = { ctx: { tools: { guard: () => { throw boom } } } }
    const members = []
    const { deps } = supervisedDeps({ agents: { get: () => handle } })
    const lane = supervisedLane({ coordinator: fakeCoordinator(), groupName: 'scan', members })
    let caught
    try {
      await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), lane, deps)
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
    const handle = { ctx: { tools: { guard: () => { log.push('guard-attach'); return () => {} } } } }
    const members = []
    const { deps } = supervisedDeps({ agents: { get: () => handle } })
    const lane = supervisedLane({ coordinator: fakeCoordinator(log), groupName: 'scan', members })
    await spawnGuardedChild(assignmentOf(baseTarget({ readOnly: true })), lane, deps)
    expect(log).toEqual(['register', 'guard-attach'])
  })
})
