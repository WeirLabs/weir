// Tasks 8.2-8.6 of the session-capability-manager change: the facade gate
// verdicts, the tool wrapper's last-moment check, and the drain coordinator.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { createMcpGate } from '../src/capabilities/mcp-gate.js'
import { createMcpToolWrapper } from '../src/capabilities/mcp-admission.js'
import { createMcpFacade } from '../src/capabilities/mcp-facade.js'
import { createMcpDrain, createSessionDrainAdapter } from '../src/capabilities/mcp-drain.js'

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

test('wrapper: resource operations are gated by the same verdict', async () => {
  const wrapper = createMcpToolWrapper({ identity: 'docs', generation: 1, admit: async () => false })
  const provider = wrapper.wrapResourceProvider({ list: async () => ['r1'], read: async () => 'body' })
  await assert.rejects(provider.list({}, {}), /resources are not enabled/)
  await assert.rejects(provider.read({}, {}), /resources are not enabled/)
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
