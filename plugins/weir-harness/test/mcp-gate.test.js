// Tasks 8.2-8.6 of the session-capability-manager change: the facade gate
// verdicts, the tool wrapper's last-moment check, and the drain coordinator.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { createMcpGate } from '../src/capabilities/mcp-gate.js'
import { createMcpToolWrapper } from '../src/capabilities/mcp-admission.js'
import { createMcpFacade } from '../src/capabilities/mcp-facade.js'
import { createMcpDrain, createSessionDrainAdapter } from '../src/capabilities/mcp-drain.js'
import { createLifecycleSnapshots } from '../src/capabilities/lifecycle-snapshot.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const registryWith = servers => ({
  async read() { return { kind: 'ok', revision: 1, servers } },
})
const lifecycleWith = snapshots => ({
  snapshotFor: id => snapshots[id] ?? null,
})
const agentOf = id => ({ session: { id } })

test('gate: admitted only when registry generation matches AND the session accepted the server', async () => {
  const gate = createMcpGate({
    registry: registryWith({ docs: { identity: 'docs', generation: 3 } }),
    lifecycle: lifecycleWith({ s1: { state: 'ready', mcpServers: ['docs'] } }),
  })
  expect(await gate.admit(agentOf('s1'), 'docs', 3)).toBe(true)
  expect(await gate.admit(agentOf('s1'), 'docs', 2)).toBe(false)  // stale generation (pre-reconnect handle)
  expect(await gate.admit(agentOf('s1'), 'web', 1)).toBe(false)   // not in the session's accepted set
  expect(await gate.admit(agentOf('s2'), 'docs', 3)).toBe(false)  // no initialized snapshot (reload window)
})

test('gate: BLOCKED sessions refuse every managed call (6.4)', async () => {
  const gate = createMcpGate({
    registry: registryWith({ docs: { identity: 'docs', generation: 1 } }),
    lifecycle: lifecycleWith({ s1: { state: 'blocked', reason: 'corrupt' } }),
  })
  expect(await gate.admit(agentOf('s1'), 'docs', 1)).toBe(false)
  expect(gate.enabledFor(agentOf('s1'), 'docs')).toBe(false)
})

test('gate: instruction filtering follows only the accepted set', () => {
  const gate = createMcpGate({
    registry: registryWith({}),
    lifecycle: lifecycleWith({ s1: { state: 'ready', mcpServers: ['docs'] } }),
  })
  expect(gate.enabledFor(agentOf('s1'), 'docs')).toBe(true)
  expect(gate.enabledFor(agentOf('s1'), 'web')).toBe(false)
})

test('wrapper: the check runs at the head of execute and only then hands off', async () => {
  const order = []
  const wrapper = createMcpToolWrapper({
    identity: 'docs', generation: 1,
    admit: async () => { order.push('admit'); return true },
  })
  const wrapped = wrapper.wrap({ name: 'echo', execute: async () => { order.push('inner'); return 'ok' } })
  expect(await wrapped.execute({}, { agent: { session: { id: 's1' } } })).toBe('ok')
  expect(order).toEqual(['admit', 'inner'])
  const denied = createMcpToolWrapper({ identity: 'docs', generation: 1, admit: async () => false })
  const refused = denied.wrap({ name: 'echo', execute: async () => { order.push('should-not-run') } })
  await assert.rejects(refused.execute({}, {}), /admission refused/)
  expect(order).not.toContain('should-not-run')
})

test('facade: the production resource gate refuses with mcp-admission-refused when the verdict is false', async () => {
  // The PRODUCTION resource gate: mcpResources.register wraps the provider's
  // request path (mcp-facade.js) — the shape the stock client registers.
  let registered
  const facade = createMcpFacade({
    host: { mcpResources: { register: (server, provider) => { registered = provider } } },
    identity: 'docs', generation: 1,
    admit: async () => false,
    isEnabledFor: () => false,
  })
  let rpcs = 0
  facade.mcpResources.register('docs', { request: async () => { rpcs++; return 'body' } })
  await assert.rejects(
    registered.request({}, { agent: agentOf('s1') }),
    error => error?.code === 'mcp-admission-refused' && /resources are not enabled/.test(error.message),
  )
  expect(rpcs).toBe(0) // the refusal happens before any RPC reaches the provider

  // The same gate with a positive verdict hands the request through.
  let served
  const open = createMcpFacade({
    host: { mcpResources: { register: (server, provider) => { served = provider } } },
    identity: 'docs', generation: 1,
    admit: async () => true,
    isEnabledFor: () => true,
  })
  open.mcpResources.register('docs', { request: async () => 'body' })
  expect(await served.request({}, { agent: agentOf('s1') })).toBe('body')
})

test('drain: closing the gate rejects new calls, in-flight calls finish, timeout reports in-flight', async () => {
  let now = 0
  const waits = []
  const drain = createMcpDrain({ timeoutMs: 100, now: () => now, sleep: async ms => { waits.push(ms); now += ms } })
  const token = drain.enter('a1', 'docs', 'slow-call')
  expect(drain.snapshot('a1', 'docs')).toEqual({ server: 'docs', state: 'draining', inFlight: 1 })
  drain.close('a1', 'docs')
  expect(drain.enter('a1', 'docs', 'late-call')).toBeNull() // queued/stale-schema calls rejected at the fence
  const pending = drain.drain('a1', 'docs')
  drain.exit('a1', 'docs', token)
  expect(await pending).toEqual({ drained: true, waitedMs: 50 })
  // A call that never finishes (a different pair, never closed): only
  // "still in flight" is reported, never a forced cancellation.
  drain.enter('a2', 'docs', 'stuck-call')
  const timedOut = await drain.drain('a2', 'docs')
  expect(timedOut.drained).toBe(false)
  expect(timedOut.inFlight).toBe(1)
  expect(timedOut.calls).toEqual(['stuck-call'])
})

test('8.6 wiring: a removal through the engine seam closes the session gate; the wrapper rejects before any RPC (mcp-gate-closed)', async () => {
  // The production chain (capabilities-deepening D3): the engine's drain seam
  // adapter over the manager's (agent, server)-keyed drain — the same drain
  // the tool wrapper's admission enters at handoff.
  const drain = createMcpDrain()
  const adapter = createSessionDrainAdapter(() => drain)
  const wrapper = createMcpToolWrapper({ identity: 'docs', generation: 1, admit: async () => true, drain })
  let rpcs = 0
  const wrapped = wrapper.wrap({ name: 'echo', execute: async () => { rpcs++; return 'ok' } })
  const agentA = { session: { id: 'sess-a' } }
  const agentB = { session: { id: 'sess-b' } }

  // Before any removal the call enters and hands off.
  expect(await wrapped.execute({}, { agent: agentA })).toBe('ok')
  expect(rpcs).toBe(1)

  // The Apply's step-4 seam call: close session A's gate for 'docs'.
  const handle = adapter.begin(['docs'], 'sess-a')
  await assert.rejects(
    wrapped.execute({}, { agent: agentA }),
    error => error?.code === 'mcp-gate-closed' && /draining for this agent/.test(error.message),
  )
  expect(rpcs).toBe(1) // ZERO RPC reached the process
  // Session B's gate is untouched (8.5 A/B isolation).
  expect(await wrapped.execute({}, { agent: agentB })).toBe('ok')
  expect(rpcs).toBe(2)

  // The Apply failed: abort() reopens exactly session A's gate.
  handle.abort()
  expect(await wrapped.execute({}, { agent: agentA })).toBe('ok')
  expect(rpcs).toBe(3)
})

test('8.6 wiring: a removal through the engine seam closes the session gate for facade RESOURCE requests too (mcp-gate-closed)', async () => {
  // The same drain seam the tool path enters at handoff must also fence the
  // facade's gated resource request: between drain.begin and the post-commit
  // snapshot publication the admit verdict still reads the PRE-Apply snapshot,
  // so without the drain the request is served by the old provider.
  const drain = createMcpDrain()
  const adapter = createSessionDrainAdapter(() => drain)
  let registered
  const facade = createMcpFacade({
    host: { mcpResources: { register: (server, provider) => { registered = provider } } },
    identity: 'docs', generation: 1,
    admit: async () => true, // mid-Apply the stale snapshot still admits — the drain is the fence
    isEnabledFor: () => true,
    drain,
  })
  let rpcs = 0
  facade.mcpResources.register('docs', { request: async () => { rpcs++; return 'body' } })
  const agentA = { session: { id: 'sess-a' } }
  const agentB = { session: { id: 'sess-b' } }

  // Before any removal the request enters and hands off.
  expect(await registered.request({}, { agent: agentA })).toBe('body')
  expect(rpcs).toBe(1)

  // The Apply's step-4 seam call: close session A's gate for 'docs'.
  const handle = adapter.begin(['docs'], 'sess-a')
  await assert.rejects(
    registered.request({}, { agent: agentA }),
    error => error?.code === 'mcp-gate-closed' && /draining for this agent/.test(error.message),
  )
  expect(rpcs).toBe(1) // ZERO RPC reached the provider
  // Session B's gate is untouched (8.5 A/B isolation).
  expect(await registered.request({}, { agent: agentB })).toBe('body')
  expect(rpcs).toBe(2)

  // The Apply failed: abort() reopens exactly session A's gate.
  handle.abort()
  expect(await registered.request({}, { agent: agentA })).toBe('body')
  expect(rpcs).toBe(3)
})

test('gate: a cold fork admits exactly the inherited managed set (no accepted record)', async () => {
  // The fork was created by a depth-0 capture; the process then restarted, so
  // the gate's lifecycle has no memory snapshot and must read the durable
  // inherited unit — the same effective set the Skill catalog reports.
  const root = mkdtempSync(join(tmpdir(), 'weir-gate-fork-'))
  const store = openCapabilityStore({ root, platform: 'darwin' })
  await store.commit({ kind: 'selection', sessionId: 'fork-source' }, 0, () => ({ skills: [], mcpServers: ['docs'] }))
  createLifecycleSnapshots({ root, platform: 'darwin' }).agentCreated({
    agent: { session: { id: 'fork-cold', header: { delegationDepth: 0, parentSession: 'fork-source' } } },
  })
  const cold = createLifecycleSnapshots({ root, platform: 'darwin' })
  const gate = createMcpGate({
    registry: registryWith({ docs: { identity: 'docs', generation: 1 }, web: { identity: 'web', generation: 1 } }),
    lifecycle: cold,
  })
  expect(gate.enabledFor(agentOf('fork-cold'), 'docs')).toBe(true)
  expect(await gate.admit(agentOf('fork-cold'), 'docs', 1)).toBe(true)
  // Nothing was inherited beyond the source's accepted set.
  expect(gate.enabledFor(agentOf('fork-cold'), 'web')).toBe(false)
  expect(await gate.admit(agentOf('fork-cold'), 'web', 1)).toBe(false)
  const inherited = await store.read({ kind: 'inherited', sessionId: 'fork-cold' })
  expect(inherited.payload.mcpServers).toEqual(['docs'])
})

test('gate: a fork of an inherited source still admits the same set (consecutive fork)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weir-gate-fork2-'))
  await openCapabilityStore({ root, platform: 'darwin' })
    .commit({ kind: 'selection', sessionId: 'root-source' }, 0, () => ({ skills: [], mcpServers: ['docs', 'web'] }))
  const writer = createLifecycleSnapshots({ root, platform: 'darwin' })
  writer.agentCreated({ agent: { session: { id: 'fork-1', header: { delegationDepth: 0, parentSession: 'root-source' } } } })
  writer.agentCreated({ agent: { session: { id: 'fork-2', header: { delegationDepth: 0, parentSession: 'fork-1' } } } })
  const cold = createLifecycleSnapshots({ root, platform: 'darwin' })
  const gate = createMcpGate({
    registry: registryWith({ docs: { identity: 'docs', generation: 1 }, web: { identity: 'web', generation: 1 } }),
    lifecycle: cold,
  })
  expect(gate.enabledFor(agentOf('fork-2'), 'docs')).toBe(true)
  expect(gate.enabledFor(agentOf('fork-2'), 'web')).toBe(true)
})

// --- Capability gate re-review (d4ce98a follow-up) ---------------------------
// A memory-BLOCKED depth-0 fork is a definitive fail-closed verdict, never the
// creation race: it must not borrow the ready parent's managed-MCP visibility.
// The creation-race fallback itself stays: an ABSENT own snapshot (the capture
// listener has not run yet) may use the parent's accepted set for VISIBILITY,
// while admission still refuses a session with no initialized snapshot.

test('gate: a BLOCKED depth-0 fork never borrows the ready parent; an ABSENT own snapshot keeps the creation-race fallback', async () => {
  const registry = registryWith({ docs: { identity: 'docs', generation: 1 } })
  const parent = { state: 'ready', mcpServers: ['docs'] }
  const blockedAgent = { session: { id: 'fork-blocked', header: { delegationDepth: 0, parentSession: 'parent' } } }
  const racingAgent = { session: { id: 'fork-racing', header: { delegationDepth: 0, parentSession: 'parent' } } }
  const gate = createMcpGate({
    registry,
    lifecycle: lifecycleWith({
      parent,
      'fork-blocked': { state: 'blocked', reason: 'unreadable' },
    }),
  })
  // BLOCKED own + READY parent: the parent's accepted set is NOT this fork's
  // set — neither visibility nor admission may leak through the fallback.
  expect(gate.enabledFor(blockedAgent, 'docs')).toBe(false)
  expect(await gate.admit(blockedAgent, 'docs', 1)).toBe(false)
  // Control: the OWN snapshot is simply absent (the creation-time capture
  // listener races creation), so the parent's set stands in for visibility —
  // admission still refuses a session with no initialized snapshot.
  expect(gate.enabledFor(racingAgent, 'docs')).toBe(true)
  expect(await gate.admit(racingAgent, 'docs', 1)).toBe(false)
  // A BLOCKED parent grants nothing either.
  const blockedParent = createMcpGate({
    registry,
    lifecycle: lifecycleWith({ parent: { state: 'blocked', reason: 'unreadable' } }),
  })
  expect(blockedParent.enabledFor(racingAgent, 'docs')).toBe(false)
})

test('gate + facade: a BLOCKED fork omits MCP instructions while a creation-race child still sees the parent set', async () => {
  // Real lifecycle store (the blackboard re-review probe): the BLOCKED marker
  // and the ready parent coexist in memory, which is exactly the state the
  // review reproduced. The facade's per-prompt section is the instruction-facing
  // surface that consumed the leaked verdict.
  const lifecycle = createLifecycleSnapshots({ root: mkdtempSync(join(tmpdir(), 'weir-gate-blocked-')), platform: 'darwin' })
  lifecycle.publish('parent', { revision: 1, skills: [], mcpServers: ['docs'] })
  lifecycle.markBlocked('fork-blocked', 'unreadable')
  const gate = createMcpGate({ registry: registryWith({ docs: { identity: 'docs', generation: 1 } }), lifecycle })
  let section
  const facade = createMcpFacade({
    host: { systemPrompt: { section: definition => (section = definition) } },
    identity: 'docs',
    generation: 1,
    admit: agent => gate.admit(agent, 'docs', 1),
    isEnabledFor: agent => gate.enabledFor(agent, 'docs'),
  })
  facade.systemPrompt.section({ render: () => 'DOCS INSTRUCTIONS' })
  const blocked = { session: { id: 'fork-blocked', header: { delegationDepth: 0, parentSession: 'parent' } } }
  const racing = { session: { id: 'fork-racing', header: { delegationDepth: 0, parentSession: 'parent' } } }

  expect(lifecycle.snapshotFor('fork-blocked')?.state).toBe('blocked')
  expect(gate.enabledFor(blocked, 'docs')).toBe(false)
  expect(await gate.admit(blocked, 'docs', 1)).toBe(false)
  expect(await section.render(blocked)).toBe('')

  // The creation race is the ONLY case the parent fallback serves.
  expect(lifecycle.snapshotFor('fork-racing')).toBeNull()
  expect(gate.enabledFor(racing, 'docs')).toBe(true)
  expect(await gate.admit(racing, 'docs', 1)).toBe(false)
  expect(await section.render(racing)).toBe('DOCS INSTRUCTIONS')
})

test('facade: live registration sync follows Host registration and Host removal precedes generation cleanup', () => {
  const order = []
  const facade = createMcpFacade({
    host: { tools: { register() {
      order.push('host-register')
      return () => { order.push('host-unregister') }
    } } },
    identity: 'docs', generation: 1,
    admit: async () => true,
    isEnabledFor: () => true,
    onRegister: name => { order.push(`owner-register:${name}`) },
    onUnregister: name => { order.push(`owner-unregister:${name}`) },
  })
  const dispose = facade.tools.register({ name: 'mcp__docs__echo', execute: async () => {} })
  expect(order).toEqual(['host-register', 'owner-register:mcp__docs__echo'])
  dispose()
  dispose()
  expect(order).toEqual([
    'host-register', 'owner-register:mcp__docs__echo',
    'host-unregister', 'owner-unregister:mcp__docs__echo',
  ])
})

test('facade: a synchronous visibility failure rolls back Host registration before surfacing the error', () => {
  const registered = new Set()
  const order = []
  const facade = createMcpFacade({
    host: { tools: { register(definition) {
      registered.add(definition.name)
      order.push('host-register')
      return () => {
        registered.delete(definition.name)
        order.push('host-rollback')
      }
    } } },
    identity: 'docs', generation: 1,
    admit: async () => true,
    isEnabledFor: () => true,
    onRegister() { order.push('owner-sync-failed'); throw new Error('injected visibility sync failure') },
  })
  assert.throws(
    () => facade.tools.register({ name: 'mcp__docs__echo', execute: async () => {} }),
    /injected visibility sync failure/,
  )
  expect(order).toEqual(['host-register', 'owner-sync-failed', 'host-rollback'])
  expect([...registered]).toEqual([])
})

test('facade: failed Host removal retains owner cleanup for a safe retry', () => {
  let failRemoval = true
  let hostAttempts = 0
  let ownerCleanups = 0
  const facade = createMcpFacade({
    host: { tools: { register() {
      return () => {
        hostAttempts++
        if (failRemoval) throw new Error('injected Host removal failure')
      }
    } } },
    identity: 'docs', generation: 1,
    admit: async () => true,
    isEnabledFor: () => true,
    onUnregister() { ownerCleanups++ },
  })
  const dispose = facade.tools.register({ name: 'mcp__docs__echo', execute: async () => {} })
  assert.throws(dispose, /injected Host removal failure/)
  expect(ownerCleanups).toBe(0)
  failRemoval = false
  dispose()
  dispose()
  expect(hostAttempts).toBe(2)
  expect(ownerCleanups).toBe(1)
})
