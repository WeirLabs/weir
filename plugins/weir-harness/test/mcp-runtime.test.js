import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { createMcpRuntime } from '../src/capabilities/mcp-runtime.js'
import { createMcpGate } from '../src/capabilities/mcp-gate.js'
import { createMcpDrain } from '../src/capabilities/mcp-drain.js'
import { createMcpToolWrapper } from '../src/capabilities/mcp-admission.js'

const agent = { id: 'agent-1', session: { id: 'session-1' } }
const lifecycle = { snapshotFor: () => ({ state: 'ready', mcpServers: ['docs'], mcpIncarnations: { docs: 'inc-a' } }) }
const deferred = () => {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}
function fixture() {
  const runtime = createMcpRuntime()
  const drain = createMcpDrain({ timeoutMs: 20 })
  const token = runtime.begin('docs', { generation: 1, incarnation: 'inc-a', operationId: 'op-1' })
  runtime.finish(token, 'mounted', { generation: 1, incarnation: 'inc-a' })
  const registry = { entry: { identity: 'docs', generation: 1, incarnation: 'inc-a' }, async read() { return { kind: 'ok', revision: 1, servers: { docs: this.entry } } } }
  const gate = createMcpGate({ registry, lifecycle, runtime, registrationFor: runtime.registrationFor })
  return { runtime, drain, registry, gate }
}

test('every pre-read phase closes old/new generations and drain entry before CAS, unmount and readiness', async () => {
  const { runtime, drain, gate, registry } = fixture()
  for (const phase of ['pre-CAS', 'post-CAS/pre-unmount', 'post-unmount/pre-ready']) {
    const operation = runtime.begin('docs', { phase: 'replacing', generation: 2, incarnation: 'inc-a', operationId: phase })
    drain.closeAll('docs')
    registry.entry = { identity: 'docs', generation: 2, incarnation: 'inc-a' }
    expect(await gate.permit(agent, 'docs', 1)).toBeNull()
    expect(await gate.permit(agent, 'docs', 2)).toBeNull()
    expect(drain.enter('session-1', 'docs', phase)).toBeNull()
    expect(runtime.enabledFor('docs')).toBe(false)
    runtime.restore(operation)
    drain.reopenAll('docs')
    registry.entry = { identity: 'docs', generation: 1, incarnation: 'inc-a' }
  }
  expect(await gate.permit(agent, 'docs', 1)).not.toBeNull()
})

test('registry read completes after replacement begins: permit is revoked before handoff', async () => {
  const { runtime, gate, registry } = fixture()
  const waiting = deferred()
  registry.read = async function () { await waiting.promise; return { kind: 'ok', revision: 1, servers: { docs: this.entry } } }
  const pending = gate.permit(agent, 'docs', 1)
  runtime.begin('docs', { phase: 'replacing', generation: 2, incarnation: 'inc-a', operationId: 'op-2' })
  waiting.resolve()
  expect(await pending).toBeNull()
})

test('a permit issued before replacement fails the final synchronous handoff check with zero server activity', async () => {
  const { runtime, gate } = fixture()
  const permit = await gate.permit(agent, 'docs', 1)
  expect(permit.operationId).toBe('op-1')
  runtime.begin('docs', { phase: 'replacing', generation: 2, incarnation: 'inc-a', operationId: 'op-2' })
  expect(runtime.assertPermit(permit)).toBe(false)
  let calls = 0
  const wrapper = createMcpToolWrapper({ identity: 'docs', generation: 1, admit: async () => permit, assertPermit: runtime.assertPermit })
  const wrapped = wrapper.wrap({ name: 'echo', execute: async () => { calls += 1 } })
  await assert.rejects(wrapped.execute({}, { agent }), /admission refused/)
  expect(calls).toBe(0)
})

test('only the final mounted transition reopens the intended generation and incarnation', async () => {
  const { runtime, gate, registry } = fixture()
  const operation = runtime.begin('docs', { generation: 2, incarnation: 'inc-a', operationId: 'op-2' })
  registry.entry = { identity: 'docs', generation: 2, incarnation: 'inc-a' }
  expect(await gate.permit(agent, 'docs', 2)).toBeNull()
  runtime.finish(operation, 'mounted', { generation: 2, incarnation: 'inc-a' })
  const permit = await gate.permit(agent, 'docs', 2)
  expect(permit.operationId).toBe('op-2')
  expect(runtime.assertPermit(permit)).toBe(true)
  expect(await gate.permit(agent, 'docs', 1)).toBeNull()
  expect(gate.enabledFor(agent, 'docs')).toBe(true)
})

test('mount failure stays saved-degraded and closed; pre-commit restore cannot overwrite a later operation', async () => {
  const { runtime, gate, registry } = fixture()
  const failed = runtime.begin('docs', { generation: 2, incarnation: 'inc-a', operationId: 'op-2' })
  registry.entry = { identity: 'docs', generation: 2, incarnation: 'inc-a' }
  runtime.finish(failed, 'saved-degraded', { generation: 2, incarnation: 'inc-a' })
  expect(runtime.snapshot('docs').phase).toBe('saved-degraded')
  expect(await gate.permit(agent, 'docs', 1)).toBeNull()
  expect(await gate.permit(agent, 'docs', 2)).toBeNull()

  const first = runtime.begin('docs', { operationId: 'op-3' })
  const second = runtime.begin('docs', { operationId: 'op-4' })
  expect(runtime.restore(first)).toBe(false)
  expect(runtime.snapshot('docs').operationId).toBe('op-4')
  expect(runtime.restore(second)).toBe(true)
  expect(runtime.snapshot('docs').phase).not.toBe('mounted')
})

test('identity-wide drain rejects new entry but an already handed-off call finishes under the running-operation boundary', async () => {
  const { runtime, drain } = fixture()
  const token = drain.enter('session-1', 'docs', 'already-handed-off')
  expect(token).not.toBeNull()
  runtime.begin('docs', { phase: 'replacing', operationId: 'op-2' })
  drain.closeAll('docs')
  expect(drain.enter('session-1', 'docs', 'late')).toBeNull()
  const draining = drain.drainAll('docs')
  drain.exit('session-1', 'docs', token)
  expect((await draining).drained).toBe(true)
  drain.reopenAll('docs')
  expect(drain.enter('session-1', 'docs', 'new-after-ready')).not.toBeNull()
})
