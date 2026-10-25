// Tasks 8.4/8.8/8.9 of the session-capability-manager change: managed vs
// unmanaged partitioning, adopt-flow conflict semantics, creation-time
// schema hiding, and drain engine adapter A/B isolation.
import { test, expect } from './helpers.js'
import { partitionMcpRows, hostRowHoldingReservation, createMcpManager } from '../src/capabilities/mcp-manager.js'
import { createMcpDrain, createSessionDrainAdapter } from '../src/capabilities/mcp-drain.js'

test('8.8 partition: our groups are managed, stock client rows elsewhere are unmanaged', () => {
  const rows = [
    { id: 'weir-mcp-docs', name: 'cordis:group' },
    { id: 'host-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'web' } },
    { id: 'include', name: 'something/else' },
  ]
  const { managed, unmanaged } = partitionMcpRows(rows, new Map([['docs', { groupId: 'weir-mcp-docs', generation: 2 }]]), {})
  expect(managed).toEqual([{ identity: 'docs', groupId: 'weir-mcp-docs', label: 'docs', generation: 2, state: 'mounted' }])
  expect(unmanaged).toEqual([{ serverName: 'web', state: 'unmanaged' }])
})

test('8.9 adopt conflict: a same-named host row holds the reservation and is never called a success', () => {
  const rows = [{ id: 'host-row', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'gamma' } }]
  expect(hostRowHoldingReservation(rows, 'gamma')?.id).toBe('host-row')
  expect(hostRowHoldingReservation(rows, 'other')).toBeNull()
  // Our own groups never count as reservation holders.
  const ours = [{ id: 'weir-mcp-gamma', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'gamma' } }]
  expect(hostRowHoldingReservation(ours, 'gamma')).toBeNull()
})

test('8.4 creation-time schema hiding denies only the public names of non-accepted servers', () => {
  const restricted = []
  const listeners = new Map()
  const services = new Map()
  const manager = createMcpManager({
    gate: {
      admit: async () => true,
      enabledFor: (_agent, identity) => identity === 'docs',
    },
    listEntryIds: () => [],
    listRows: () => [],
    store: { read: async () => ({ kind: 'absent' }), commit: async () => ({ status: 'committed' }) },
  })
  const ctx = {
    get: () => undefined,
    on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    reflect: { provide: (name, face) => services.set(name, face) },
    logger: { warn: () => {} },
  }
  manager(ctx, {})
  const face = services.get('weirMcpManager')
  // Two facade registrations reach the manager's public-name map.
  face.publicNames.set('mcp__docs__echo', 'docs')
  face.publicNames.set('mcp__web__search', 'web')
  const agent = {
    session: { id: 's1' },
    ctx: { tools: { restrict(input) { restricted.push(input) } } },
  }
  for (const listener of listeners.get('agent/created')) listener({ agent })
  // The creation-time snapshot denies only the non-accepted server's name.
  expect(restricted).toEqual([{ deny: ['mcp__web__search'] }])
})

test('8.6 engine seam: a removal in session A never closes session B (8.5 A/B isolation)', async () => {
  const drain = createMcpDrain({ timeoutMs: 10, now: () => 0 })
  // The new seam: one adapter shared by the engine across sessions; the
  // session id arrives at begin() (the manager drain's enter/exit stay the
  // only in-flight registration points, via mcp-admission at handoff).
  const adapter = createSessionDrainAdapter(() => drain)
  expect(drain.enter('sess-a', 'docs', 'a-call')).not.toBeNull()
  expect(drain.enter('sess-b', 'docs', 'b-call')).not.toBeNull()
  const handle = adapter.begin(['docs'], 'sess-a')
  // A's gate is closed; B's gate stays open even while A drains.
  expect(drain.enter('sess-a', 'docs', 'a-late')).toBeNull()
  expect(drain.enter('sess-b', 'docs', 'b-late')).not.toBeNull()
  expect(handle.snapshot()).toEqual([{ server: 'docs', state: 'draining', inFlight: 1 }])
  // A rejected Apply reopens ONLY A's gate.
  handle.abort()
  expect(drain.enter('sess-a', 'docs', 'a-reopened')).not.toBeNull()
  expect(drain.isClosed('sess-b', 'docs')).toBe(false)
})

test('8.6 engine seam: a composition without a manager drain reports the empty truth', () => {
  const adapter = createSessionDrainAdapter(() => undefined)
  const handle = adapter.begin(['docs'], 'sess-a')
  expect(handle.snapshot()).toEqual([{ server: 'docs', state: 'settled', inFlight: 0 }])
  handle.abort() // a no-op that must not throw
})
