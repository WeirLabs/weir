// Tasks 8.2-8.6 of the session-capability-manager change: the facade gate
// verdicts, the tool wrapper's last-moment check, and the drain coordinator.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { createMcpGate } from '../src/capabilities/mcp-gate.js'
import { createMcpToolWrapper } from '../src/capabilities/mcp-admission.js'
import { createMcpDrain } from '../src/capabilities/mcp-drain.js'

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
