import { describe, expect, it } from './helpers.js'
import { createBroker } from '../src/lease-broker/state.js'

// Kernel contract tests for the in-memory lease broker. No sockets, no clocks:
// the injected clock makes every validity boundary exact, and an event sink
// records what the transport would have been asked to deliver.
//
// These assertions are the arbitration contract itself (design D2/D4/D5/D6 and
// specs/file-lease-broker/spec.md): all-or-nothing acquisition, adoption and
// sliding validity, bounded retention that only extends, the four negotiation
// outcomes, and disconnect-equals-release.

const SCOPE = '/work/project'
const OWNER_A = Object.freeze({ id: 'lineage-a', session: 'sess-a', label: 'A' })
const OWNER_B = Object.freeze({ id: 'lineage-b', session: 'sess-b', label: 'B' })
const OWNER_C = Object.freeze({ id: 'lineage-c', session: 'sess-c', label: 'C' })
const TTL_MS = 120_000
const START = 1_000_000

/** Path inside the fake project scope. @param {string} name */
function P(name) {
  return `${SCOPE}/${name}`
}

/**
 * Kernel under test plus the clock and event log it was built with.
 * @param {object} [overrides]
 */
function harness(overrides = {}) {
  const clock = { now: START }
  /** @type {{ connectionId: string, event: string, requestId?: string, path?: string, state?: string, from?: any, expiresAt?: number }[]} */
  const events = []
  const broker = createBroker({
    now: () => clock.now,
    onEvent: (connectionId, event) => events.push({ connectionId, ...event }),
    ...overrides,
  })
  for (const connectionId of ['c1', 'c2', 'c3']) broker.connect(connectionId)
  return {
    broker,
    events,
    now: () => clock.now,
    /** @param {number} ms */
    advance: (ms) => {
      clock.now += ms
    },
  }
}

describe('lease broker kernel: acquisition', () => {
  it('refuses the whole batch when one path is held by another owner', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a'), P('b')] })
    const result = broker.acquire({
      connectionId: 'c2',
      owner: OWNER_B,
      scope: SCOPE,
      paths: [P('a'), P('c')],
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('held')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].path).toBe(P('a'))
    expect(result.conflicts[0].holder).toEqual({ ...OWNER_A })
    expect(result.conflicts[0].expiresAt).toBe(START + TTL_MS)
    expect(result.conflicts[0].holdUntil).toBeNull()
    // Nothing of the refused batch was granted: only the first owner holds rows.
    expect(broker.status().leases.map((lease) => lease.path)).toEqual([P('a'), P('b')])
    expect(broker.status({ session: 'sess-b' }).leases).toHaveLength(0)
  })

  it('evaluates paths in sorted order and grants them sorted', () => {
    const { broker } = harness()
    const result = broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('c'), P('a'), P('b')] })
    expect(result.ok).toBe(true)
    expect(result.granted.map((lease) => lease.path)).toEqual([P('a'), P('b'), P('c')])
  })

  it('adopts and refreshes a lease of the same owner on the same connection', () => {
    const { broker, advance } = harness()
    const first = broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    expect(first.ok).toBe(true)
    advance(30_000)
    const again = broker.acquire({ connectionId: 'c1', owner: { ...OWNER_A, session: 'sess-a2' }, scope: SCOPE, paths: [P('a')] })
    expect(again.ok).toBe(true)
    expect(again.granted).toHaveLength(1)
    expect(again.granted[0].acquiredAt).toBe(START)
    expect(again.granted[0].expiresAt).toBe(START + 30_000 + TTL_MS)
    // The latest touch of the lineage wins for delivery/display fields.
    expect(again.granted[0].owner.session).toBe('sess-a2')
  })

  it('adoption keeps holdUntil and honours a per-request ttl', () => {
    const { broker, advance } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 10 })
    const heldUntil = START + 600_000
    advance(5_000)
    const again = broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')], ttlMs: 30_000 })
    expect(again.granted[0].holdUntil).toBe(heldUntil)
    expect(again.granted[0].expiresAt).toBe(START + 5_000 + 30_000)
  })

  it('hands a lapsed lease to any other owner without negotiation', () => {
    const { broker, advance } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    advance(TTL_MS - 1)
    expect(broker.status().leases).toHaveLength(1)
    advance(1)
    // Lapsed rows are not reported and do not block: they are free.
    expect(broker.status().leases).toHaveLength(0)
    const taken = broker.acquire({ connectionId: 'c2', owner: OWNER_B, scope: SCOPE, paths: [P('a')] })
    expect(taken.ok).toBe(true)
    expect(broker.status().leases[0].owner.id).toBe('lineage-b')
  })

  it('treats the same owner id on another connection as a foreign holder', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const result = broker.acquire({ connectionId: 'c2', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('held')
    expect(result.conflicts[0].holder.id).toBe('lineage-a')
    expect(broker.status().leases[0].acquiredAt).toBe(START)
  })

  it('reports nothing to release for paths it does not own', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const result = broker.release({ connectionId: 'c2', owner: OWNER_B, paths: [P('a'), P('b')] })
    expect(result.ok).toBe(true)
    expect(result.released).toEqual([])
    expect(result.notOwned).toEqual([P('a'), P('b')])
    expect(broker.status().leases).toHaveLength(1)
  })

  it('is idempotent: releasing twice only reports notOwned for the second', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const first = broker.release({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')] })
    const second = broker.release({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')] })
    expect(first.released).toEqual([P('a')])
    expect(second.released).toEqual([])
    expect(second.notOwned).toEqual([P('a')])
  })
})

describe('lease broker kernel: retention', () => {
  it('keeps a path reserved past the ttl but not past holdUntil', () => {
    const { broker, advance } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const hold = broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 5 })
    expect(hold.ok).toBe(true)
    expect(hold.held[0].holdUntil).toBe(START + 300_000)
    advance(TTL_MS + 60_000)
    // Retention outlives the sliding validity, so the path is still refused.
    const refused = broker.acquire({ connectionId: 'c2', owner: OWNER_B, scope: SCOPE, paths: [P('a')] })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('held')
    advance(300_000)
    const granted = broker.acquire({ connectionId: 'c2', owner: OWNER_B, scope: SCOPE, paths: [P('a')] })
    expect(granted.ok).toBe(true)
  })

  it('never shortens a retention deadline that is already later', () => {
    const { broker, advance } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 10 })
    advance(60_000)
    const shorter = broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 3 })
    expect(shorter.ok).toBe(true)
    expect(shorter.held[0].holdUntil).toBe(START + 600_000)
    advance(60_000)
    const later = broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 30 })
    expect(later.held[0].holdUntil).toBe(START + 120_000 + 1_800_000)
  })

  it('refuses retention beyond the fixed bound and leaves the deadline unchanged', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const refused = broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 61 })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('limit')
    expect(refused.maxMinutes).toBe(60)
    expect(broker.status().leases[0].holdUntil).toBeNull()
  })

  it('refuses retention for a path this owner does not hold, as a whole batch', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a'), P('b')] })
    const refused = broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a'), P('c')], minutes: 5 })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('not-owned')
    expect(refused.paths).toEqual([P('c')])
    // All-or-nothing: the owned path did not get the deadline either.
    expect(broker.status().leases.every((lease) => lease.holdUntil === null)).toBe(true)
    // A different owner (or another connection of the same lineage) is refused too.
    expect(broker.hold({ connectionId: 'c2', owner: OWNER_B, paths: [P('a')], minutes: 5 }).code).toBe('not-owned')
    expect(broker.hold({ connectionId: 'c2', owner: OWNER_A, paths: [P('a')], minutes: 5 }).code).toBe('not-owned')
  })

  it('cannot extend a retention on a lease that already lapsed', () => {
    const { broker, advance } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    advance(TTL_MS)
    const refused = broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 5 })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('not-owned')
    expect(refused.paths).toEqual([P('a')])
  })

  it('rejects a non-positive retention request at the kernel boundary', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    expect(broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 0 }).code).toBe('bad-request')
    expect(broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: Number.NaN }).code).toBe('bad-request')
  })
})

describe('lease broker kernel: negotiation', () => {
  it('transfers on release and moves the lease to the requester connection', () => {
    const { broker, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    expect(requested.ok).toBe(true)
    expect(requested.state).toBe('pending')
    expect(requested.holder).toEqual({ ...OWNER_A })
    expect(requested.expiresAt).toBe(START + 120_000)
    // The request event goes to the holder connection only.
    expect(events).toEqual([
      { connectionId: 'c1', event: 'request', requestId: requested.requestId, path: P('a'), from: { ...OWNER_B }, expiresAt: START + 120_000 },
    ])

    const reply = broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'release' })
    expect(reply.ok).toBe(true)
    expect(reply.state).toBe('transferred')
    const lease = broker.status().leases[0]
    expect(lease.owner).toEqual({ ...OWNER_B })
    expect(lease.acquiredAt).toBe(START)
    expect(lease.expiresAt).toBe(START + TTL_MS)
    expect(lease.holdUntil).toBeNull()
    expect(events.at(-1)).toEqual({ connectionId: 'c2', event: 'settled', requestId: requested.requestId, path: P('a'), state: 'transferred' })
    // The requester now owns it through its own connection.
    expect(broker.release({ connectionId: 'c2', owner: OWNER_B, paths: [P('a')] }).released).toEqual([P('a')])
  })

  it('clears a retention on transfer', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 30 })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'release' })
    expect(broker.status().leases[0].holdUntil).toBeNull()
  })

  it('declines on keep and leaves ownership unchanged', () => {
    const { broker, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    const reply = broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'keep' })
    expect(reply.ok).toBe(true)
    expect(reply.state).toBe('declined')
    expect(broker.status().leases[0].owner.id).toBe('lineage-a')
    expect(events.at(-1).state).toBe('declined')
    expect(events.at(-1).connectionId).toBe('c2')
  })

  it('expires a silent request and tells the requester', () => {
    // A window shorter than the ttl isolates "the request elapsed while the
    // lease is still perfectly valid".
    const { broker, advance, events } = harness({ requestWindowMs: 30_000 })
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    advance(30_000)
    const swept = broker.sweep()
    expect(swept.droppedRequests).toBe(1)
    expect(events.at(-1)).toEqual({ connectionId: 'c2', event: 'settled', requestId: requested.requestId, path: P('a'), state: 'expired' })
    // Ownership unchanged; a late reply is refused as expired.
    expect(broker.status().leases[0].owner.id).toBe('lineage-a')
    const late = broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'release' })
    expect(late.ok).toBe(false)
    expect(late.code).toBe('expired')
  })

  it('refuses a reply as stale when the lease vanished first', () => {
    const { broker, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    broker.release({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')] })
    const reply = broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'release' })
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('stale')
    expect(events.at(-1).state).toBe('expired')
    expect(broker.status().leases).toHaveLength(0)
  })

  it('refuses a reply as stale when ownership changed hands first', () => {
    // Ownership changes hands inside the request window: a short ttl lapses the
    // lease while the requester's request is still pending.
    const { broker, advance, events } = harness({ ttlMs: 60_000 })
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    advance(60_000)
    broker.acquire({ connectionId: 'c3', owner: OWNER_C, scope: SCOPE, paths: [P('a')] })
    const reply = broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'release' })
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('stale')
    expect(events.at(-1).state).toBe('expired')
    expect(broker.status().leases[0].owner.id).toBe('lineage-c')
  })

  it('refuses a reply from anyone but the holder and keeps the request pending', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    const stranger = broker.reply({ connectionId: 'c2', owner: OWNER_B, requestId: requested.requestId, decision: 'release' })
    expect(stranger.ok).toBe(false)
    expect(stranger.code).toBe('not-holder')
    const wrongConnection = broker.reply({ connectionId: 'c3', owner: OWNER_A, requestId: requested.requestId, decision: 'keep' })
    expect(wrongConnection.code).toBe('not-holder')
    // Still pending: the real holder can answer it.
    const accepted = broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'keep' })
    expect(accepted.ok).toBe(true)
    expect(accepted.state).toBe('declined')
  })

  it('reports free and self instead of creating a request', () => {
    const { broker, events } = harness()
    expect(broker.request({ connectionId: 'c2', from: OWNER_B, path: P('missing') })).toEqual({ ok: false, code: 'free' })
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    expect(broker.request({ connectionId: 'c2', from: OWNER_A, path: P('a') })).toEqual({ ok: false, code: 'self' })
    expect(events).toHaveLength(0)
  })

  it('reuses one pending request per requester and path', () => {
    const { broker, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const first = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    const second = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    expect(second.requestId).toBe(first.requestId)
    expect(second.expiresAt).toBe(first.expiresAt)
    expect(events.filter((event) => event.event === 'request')).toHaveLength(1)
    // A different requester is a different mailbox entry.
    const other = broker.request({ connectionId: 'c3', from: OWNER_C, path: P('a') })
    expect(other.requestId).not.toBe(first.requestId)
  })

  it('re-addresses a pending request when the holder changed hands', () => {
    const { broker, advance, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const first = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    advance(TTL_MS)
    broker.acquire({ connectionId: 'c3', owner: OWNER_C, scope: SCOPE, paths: [P('a')] })
    const second = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    expect(second.requestId).not.toBe(first.requestId)
    expect(second.holder.id).toBe('lineage-c')
    expect(events.filter((event) => event.event === 'request').at(-1).connectionId).toBe('c3')
    const accepted = broker.reply({ connectionId: 'c3', owner: OWNER_C, requestId: second.requestId, decision: 'release' })
    expect(accepted.state).toBe('transferred')
  })

  it('refuses an unknown request id as expired', () => {
    const { broker } = harness()
    const reply = broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: 'req-does-not-exist', decision: 'keep' })
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('expired')
  })
})

describe('lease broker kernel: connections', () => {
  it('releases every lease of a closed connection immediately', () => {
    const { broker } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a'), P('b')] })
    broker.acquire({ connectionId: 'c2', owner: OWNER_B, scope: SCOPE, paths: [P('c')] })
    broker.disconnect('c1')
    expect(broker.status().leases.map((lease) => lease.path)).toEqual([P('c')])
    // No expiry wait needed: the paths are acquirable at once.
    expect(broker.acquire({ connectionId: 'c3', owner: OWNER_C, scope: SCOPE, paths: [P('a'), P('b')] }).ok).toBe(true)
  })

  it('settles requests of a vanished holder as expired', () => {
    const { broker, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    broker.disconnect('c1')
    expect(events.at(-1)).toEqual({ connectionId: 'c2', event: 'settled', requestId: requested.requestId, path: P('a'), state: 'expired' })
    expect(broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'release' }).code).toBe('expired')
  })

  it('drops a pending request when the requester goes away, silently', () => {
    const { broker, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    const before = events.length
    broker.disconnect('c2')
    expect(events).toHaveLength(before)
    expect(broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'release' }).code).toBe('expired')
    expect(broker.status().leases[0].owner.id).toBe('lineage-a')
  })

  it('drops events for unregistered connections and survives a throwing sink', () => {
    const delivered = []
    const silent = createBroker({ now: () => START, onEvent: (connectionId, event) => delivered.push({ connectionId, event }) })
    silent.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = silent.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    expect(requested.ok).toBe(true)
    expect(delivered).toHaveLength(0)

    const hostile = createBroker({
      now: () => START,
      onEvent: () => {
        throw new Error('transport exploded')
      },
    })
    hostile.connect('c1')
    hostile.connect('c2')
    hostile.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const result = hostile.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    expect(result.ok).toBe(true)
    expect(hostile.status().leases).toHaveLength(1)
  })
})

describe('lease broker kernel: status and sweep', () => {
  it('returns copies, filters that stack, and never lapsed rows', () => {
    const { broker, advance } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    broker.acquire({ connectionId: 'c2', owner: OWNER_B, scope: '/work/other', paths: [P('b')] })
    expect(broker.status().leases).toHaveLength(2)
    expect(broker.status({ scope: SCOPE }).leases).toHaveLength(1)
    expect(broker.status({ session: 'sess-b' }).leases.map((lease) => lease.path)).toEqual([P('b')])
    expect(broker.status({ session: 'sess-b', path: P('a') }).leases).toHaveLength(0)
    expect(broker.status({ path: P('a') }).leases[0].owner.id).toBe('lineage-a')

    const snapshot = broker.status().leases
    snapshot[0].owner.id = 'mutated'
    snapshot[0].expiresAt = 0
    expect(broker.status().leases.find((lease) => lease.path === snapshot[0].path).owner.id).not.toBe('mutated')

    advance(TTL_MS)
    expect(broker.status().leases).toHaveLength(0)
  })

  it('reclaims lapsed leases and elapsed requests', () => {
    const { broker, advance } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a'), P('b')] })
    broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    expect(broker.sweep()).toEqual({ droppedLeases: 0, droppedRequests: 0 })
    advance(TTL_MS)
    expect(broker.sweep()).toEqual({ droppedLeases: 2, droppedRequests: 1 })
    expect(broker.sweep()).toEqual({ droppedLeases: 0, droppedRequests: 0 })
  })

  it('does not mutate the table through mutate-after-grant aliasing', () => {
    const { broker } = harness()
    const granted = broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    granted.granted[0].owner.id = 'mutated'
    expect(broker.status().leases[0].owner.id).toBe('lineage-a')
  })
})

describe('lease broker kernel: release facts', () => {
  /** Release broadcasts recorded by the harness sink, in delivery order. @param {{ connectionId: string, event: string, path?: string, reason?: string }[]} events */
  function released(events) {
    return events.filter((event) => event.event === 'released')
  }

  it('announces an explicit release once, to every connection, after the row is gone', () => {
    const clock = { now: START }
    /** @type {{ connectionId: string, path: string, rowStillThere: boolean }[]} */
    const seen = []
    const broker = createBroker({
      now: () => clock.now,
      onEvent: (connectionId, event) => {
        if (event.event !== 'released') return
        // Queried from INSIDE the sink: the lease must already be gone, so the
        // broadcast can never be observed as ownership that still exists.
        seen.push({ connectionId, path: event.path, rowStillThere: broker.status({ path: event.path }).leases.length > 0 })
      },
    })
    for (const connectionId of ['c1', 'c2', 'c3']) broker.connect(connectionId)
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const result = broker.release({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')] })

    expect(result).toEqual({ ok: true, released: [P('a')], notOwned: [] })
    expect(seen).toEqual([
      { connectionId: 'c1', path: P('a'), rowStillThere: false },
      { connectionId: 'c2', path: P('a'), rowStillThere: false },
      { connectionId: 'c3', path: P('a'), rowStillThere: false },
    ])
  })

  it('carries the released reason and stays silent for a no-op release', () => {
    const { broker, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })

    broker.release({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')] })
    expect(released(events).map((event) => event.reason)).toEqual(['released', 'released', 'released'])

    // The same release again changes no lease: the existing notOwned answer is
    // returned and nothing is announced.
    const repeat = broker.release({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')] })
    expect(repeat).toEqual({ ok: true, released: [], notOwned: [P('a')] })
    expect(released(events)).toHaveLength(3)
  })

  it('announces an explicit release of an already-lapsed row as released', () => {
    // A lapsed row is free by the clock but still belongs to its owner until
    // removed: the owner's release is what removes it, so it is announced.
    const { broker, advance, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    advance(TTL_MS)
    const result = broker.release({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')] })
    expect(result.released).toEqual([P('a')])
    expect(released(events).map((event) => event.reason)).toEqual(['released', 'released', 'released'])
  })

  it('announces each lease a departed holder owned, once, and not to the departed connection', () => {
    const { broker, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a'), P('b')] })
    broker.disconnect('c1')

    expect(released(events)).toEqual([
      { connectionId: 'c2', event: 'released', path: P('a'), reason: 'disconnected' },
      { connectionId: 'c3', event: 'released', path: P('a'), reason: 'disconnected' },
      { connectionId: 'c2', event: 'released', path: P('b'), reason: 'disconnected' },
      { connectionId: 'c3', event: 'released', path: P('b'), reason: 'disconnected' },
    ])
    // No expiry wait: the freed paths are acquirable at once and the departed
    // connection's own row is gone from the table.
    expect(broker.acquire({ connectionId: 'c2', owner: OWNER_B, scope: SCOPE, paths: [P('a')] }).ok).toBe(true)
  })

  it('announces an expired lease when status observes it, and the later sweep adds nothing', () => {
    const { broker, advance, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    advance(TTL_MS)

    expect(broker.status({ path: P('a') }).leases).toEqual([])
    expect(released(events).map((event) => ({ reason: event.reason, path: event.path }))).toEqual([
      { reason: 'expired', path: P('a') },
      { reason: 'expired', path: P('a') },
      { reason: 'expired', path: P('a') },
    ])

    // The record is gone, so the reclaiming sweep has nothing left to announce.
    expect(broker.sweep()).toEqual({ droppedLeases: 0, droppedRequests: 0 })
    expect(released(events)).toHaveLength(3)
  })

  it('announces an expired record before granting the path to a new owner', () => {
    const { broker, advance, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    advance(TTL_MS)

    const taken = broker.acquire({ connectionId: 'c2', owner: OWNER_B, scope: SCOPE, paths: [P('a')] })
    expect(taken.ok).toBe(true)
    expect(released(events)).toHaveLength(3)
    expect(released(events)[0]).toEqual({ connectionId: 'c1', event: 'released', path: P('a'), reason: 'expired' })
  })

  it('announces expiry observed by request, reply and hold', () => {
    const first = harness()
    first.broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    first.advance(TTL_MS)
    expect(first.broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })).toEqual({ ok: false, code: 'free' })
    expect(released(first.events).map((event) => event.reason)).toEqual(['expired', 'expired', 'expired'])

    // A short ttl inside the still-open request window: the lease lapses, the
    // request does not, so the answer is the lease-shaped `stale`.
    const second = harness({ ttlMs: 60_000 })
    second.broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = second.broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    second.advance(60_000)
    expect(second.broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'release' }).code).toBe('stale')
    expect(released(second.events).map((event) => event.reason)).toEqual(['expired', 'expired', 'expired'])

    const third = harness()
    third.broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    third.advance(TTL_MS)
    expect(third.broker.hold({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')], minutes: 5 })).toEqual({ ok: false, code: 'not-owned', paths: [P('a')] })
    expect(released(third.events).map((event) => event.reason)).toEqual(['expired', 'expired', 'expired'])
  })

  it('announces expiries reclaimed by a sweep without duplicates', () => {
    const { broker, advance, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a'), P('b')] })
    advance(TTL_MS)
    expect(broker.sweep()).toEqual({ droppedLeases: 2, droppedRequests: 0 })
    expect(broker.sweep()).toEqual({ droppedLeases: 0, droppedRequests: 0 })
    expect(released(events)).toHaveLength(6)
    for (const event of released(events)) expect(event.reason).toBe('expired')
  })

  it('stays silent for an atomic transfer: the path never becomes unowned', () => {
    const { broker, events } = harness()
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const requested = broker.request({ connectionId: 'c2', from: OWNER_B, path: P('a') })
    const transfer = broker.reply({ connectionId: 'c1', owner: OWNER_A, requestId: requested.requestId, decision: 'release' })
    expect(transfer.state).toBe('transferred')
    expect(broker.status().leases[0].owner.id).toBe('lineage-b')
    expect(released(events)).toHaveLength(0)
  })

  it('skips only the failing sink: a throwing receiver cannot hide the fact from the others', () => {
    /** @type {{ connectionId: string, path: string }[]} */
    const seen = []
    const broker = createBroker({
      now: () => START,
      onEvent: (connectionId, event) => {
        if (event.event !== 'released') return
        if (connectionId === 'c2') throw new Error('this receiver is broken')
        seen.push({ connectionId, path: event.path })
      },
    })
    for (const connectionId of ['c1', 'c2', 'c3']) broker.connect(connectionId)
    broker.acquire({ connectionId: 'c1', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    const result = broker.release({ connectionId: 'c1', owner: OWNER_A, paths: [P('a')] })

    expect(result.released).toEqual([P('a')])
    expect(seen).toEqual([
      { connectionId: 'c1', path: P('a') },
      { connectionId: 'c3', path: P('a') },
    ])
    // Still usable afterwards: the fault was transport-shaped, not arbitration.
    expect(broker.acquire({ connectionId: 'c3', owner: OWNER_C, scope: SCOPE, paths: [P('a')] }).ok).toBe(true)
  })
})
