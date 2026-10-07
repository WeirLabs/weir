// Session blackboard remote tests (design D8): the pinned wire contract the
// parallel panel lane builds against — list/read/apply/write/remove shapes,
// the acting-session identity, the shared arbitration kernel (a panel user
// never bypasses the write-token protocol), the typed failures, the
// hand-written typert contribution, and the inert host apply when typert is
// absent. Real kernel, injected bridge — no runtime.
import { describe, expect, it } from '../helpers.js'
import { createBlackboardKernel } from '../../src/blackboard/kernel.js'
import {
  BLACKBOARD_REMOTE_METHODS,
  BLACKBOARD_REMOTE_NAMESPACE,
  BLACKBOARD_REMOTE_SERVICE_KEY,
  BlackboardRemoteError,
  apply as remoteApply,
  blackboardRemoteContribution,
  createBlackboardRemoteService,
} from '../../src/blackboard/remote.js'

const TTL = 60_000
const AGENT = { id: 'root-session', session: { id: 'root-session', header: { delegationDepth: 0 } } }

/** A bridge over one real kernel whose boardOf/ttlMs mimic the plugin faces. */
function makeBridge({ ttlMs = () => TTL } = {}) {
  const kernel = createBlackboardKernel()
  return {
    kernel,
    faces: {
      kernel,
      boardOf: (agent) => (agent?.session?.header?.delegationDepth ?? 0) === 0 ? agent.id : agent.session?.header?.parentSession,
      ttlMs,
    },
  }
}

const SUMMARY = 'the fact; took two searches; re-verify: ls packages'
const ENTRY = { key: 'probe.key', entryType: 'map', summary: SUMMARY, content: 'full content' }

function serviceOf(bridge) {
  return createBlackboardRemoteService({ bridge: () => bridge.faces })
}

describe('remote list/read (pinned wire shapes, zero content at the aggregate layer)', () => {
  it('list returns exactly the pinned entry fields, filtered by type and query', () => {
    const bridge = makeBridge()
    bridge.kernel.write('root-session', { holderId: 'root-session', ...ENTRY, ttlMs: TTL })
    bridge.kernel.write('root-session', { holderId: 'root-session', key: 'dead.key', entryType: 'deadend', summary: 'nope', content: 'x', ttlMs: TTL })
    const service = serviceOf(bridge)
    const listed = service.list(AGENT, {})
    expect(Object.keys(listed)).toEqual(['entries'])
    expect(listed.entries).toHaveLength(2)
    const row = listed.entries.find((entry) => entry.key === 'probe.key')
    expect(Object.keys(row).sort()).toEqual(['entryType', 'key', 'readCount', 'subscribeCount', 'summary', 'updatedAt'])
    expect(row.summary).toEqual(SUMMARY)
    expect(row.entryType).toBe('map')
    expect('content' in row).toBe(false)
    const typed = service.list(AGENT, { type: 'deadend' })
    expect(typed.entries.map((entry) => entry.key)).toEqual(['dead.key'])
    const queried = service.list(AGENT, { query: 'the fact' })
    expect(queried.entries.map((entry) => entry.key)).toEqual(['probe.key'])
  })

  it('read returns content per found key and treats unknown keys as values', () => {
    const bridge = makeBridge()
    bridge.kernel.write('root-session', { holderId: 'root-session', ...ENTRY, ttlMs: TTL })
    const service = serviceOf(bridge)
    const result = service.read(AGENT, { keys: ['probe.key', 'ghost'] })
    expect(Object.keys(result)).toEqual(['entries'])
    expect(result.entries).toHaveLength(1)
    const row = result.entries[0]
    expect(row.content).toBe('full content')
    expect(row.summary).toEqual(SUMMARY)
    expect(typeof row.updatedAt).toBe('number')
    // Audit reads through the remote NEVER count — only the agent tool's
    // reads are usage evidence (a user inspecting an entry is auditing).
    expect(bridge.kernel.entriesOf('root-session')[0].readCount).toBe(0)
  })

  it('reads are session-scoped: a child agent resolves its root board', () => {
    const bridge = makeBridge()
    bridge.kernel.write('root-session', { holderId: 'root-session', ...ENTRY, ttlMs: TTL })
    const child = { id: 'child', session: { id: 'child', header: { delegationDepth: 1, parentSession: 'root-session' } } }
    expect(serviceOf(bridge).list(child, {}).entries).toHaveLength(1)
  })
})

describe('remote apply/write/remove (the panel shares the agents\' arbitration kernel)', () => {
  it('apply grants an opaque token with an expiry; write then consumes it and reports the revision', () => {
    const bridge = makeBridge()
    const service = serviceOf(bridge)
    const acquired = service.apply(AGENT, { key: 'probe.key' })
    expect(acquired.acquired).toBe(true)
    expect(typeof acquired.token).toBe('string')
    expect(acquired.token.length).toBeGreaterThan(0)
    expect(typeof acquired.expiresAt).toBe('number')
    const written = service.write(AGENT, ENTRY)
    expect(written).toEqual({ ok: true, revision: 1 })
    // One-shot: the same session needs a fresh apply for the next mutation.
    const again = service.write(AGENT, { ...ENTRY, content: 'v2' })
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/acquire it first/)
  })

  it('apply on a key another agent holds fails and auto-subscribes (pinned contended shape)', () => {
    const bridge = makeBridge()
    const service = serviceOf(bridge)
    service.apply(AGENT, { key: 'probe.key' })
    // A delegated child of the same conversation shares the root board.
    const other = { id: 'other-child', session: { id: 'other-child', header: { delegationDepth: 1, parentSession: 'root-session' } } }
    const contended = service.apply(other, { key: 'probe.key' })
    expect(contended).toEqual({ acquired: false, holder: 'root-session', subscribed: true })
    // The subscription is real: the holder's write release carries the waiter.
    const released = []
    bridge.kernel.onRelease((event) => released.push(event))
    service.write(AGENT, ENTRY)
    expect(released).toHaveLength(1)
    expect(released[0].subscriberIds).toEqual(['other-child'])
  })

  it('write without authority and remove of a missing key fold into the pinned error shape', () => {
    const bridge = makeBridge()
    const service = serviceOf(bridge)
    expect(service.write(AGENT, ENTRY).ok).toBe(true)
    const removed = service.remove(AGENT, { key: 'ghost' })
    expect(removed).toEqual({ ok: false, error: 'blackboard key "ghost" does not exist' })
    // The create consumed the token: the same session needs a fresh apply first.
    const noAuthority = service.remove(AGENT, { key: 'probe.key' })
    expect(noAuthority.ok).toBe(false)
    expect(noAuthority.error).toMatch(/not held by this session/)
  })

  it('remove requires a live apply first and reports ok on success', () => {
    const bridge = makeBridge()
    const service = serviceOf(bridge)
    service.write(AGENT, ENTRY)
    const blocked = service.remove(AGENT, { key: 'probe.key' })
    expect(blocked.ok).toBe(false)
    service.apply(AGENT, { key: 'probe.key' })
    expect(service.remove(AGENT, { key: 'probe.key' })).toEqual({ ok: true })
    expect(bridge.kernel.list('root-session')).toEqual([])
  })

  it('a bad entryType or summary surfaces as the pinned error shape, never a throw', () => {
    const bridge = makeBridge()
    const service = serviceOf(bridge)
    const badType = service.write(AGENT, { ...ENTRY, entryType: 'banana' })
    expect(badType.ok).toBe(false)
    expect(badType.error).toMatch(/entryType must be one of/)
    const dogma = service.write(AGENT, { ...ENTRY, summary: '  ' })
    expect(dogma.ok).toBe(false)
    expect(dogma.error).toMatch(/summary/)
  })

  it('apply uses the bridge TTL live (settings parity with the agent tools)', () => {
    const bridge = makeBridge({ ttlMs: () => 2 * 60_000 })
    const service = serviceOf(bridge)
    const before = Date.now()
    const acquired = service.apply(AGENT, { key: 'probe.key' })
    expect(acquired.expiresAt).toBeGreaterThanOrEqual(before + 2 * 60_000)
  })
})

describe('remote typed failures and the contribution', () => {
  it('an unmounted bridge is the explicit bridge-absent error', () => {
    const service = createBlackboardRemoteService({ bridge: () => null })
    for (const [method, args] of [['list', {}], ['read', { keys: [] }], ['apply', { key: 'k' }]]) {
      let caught
      try { service[method](AGENT, args) } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(BlackboardRemoteError)
      expect(caught.code).toBe('bridge-absent')
    }
    expect(service.write(AGENT, ENTRY).ok).toBe(false)
    expect(service.remove(AGENT, { key: 'k' }).ok).toBe(false)
  })

  it('an agent without a usable session identity is the explicit unknown-session error', () => {
    const bridge = makeBridge()
    let caught
    try { serviceOf(bridge).list({ id: '' }, {}) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(BlackboardRemoteError)
    expect(caught.code).toBe('unknown-session')
  })

  it('requestPromotion asks the bridge face and markPromoted marks through the shared kernel', () => {
    const bridge = makeBridge()
    const requested = []
    const faces = { ...bridge.faces, requestPromotion: (agent) => { requested.push(agent); return { requested: true, channel: 'steer' } } }
    const service = createBlackboardRemoteService({ bridge: () => faces })
    expect(service.requestPromotion(AGENT, {})).toEqual({ ok: true })
    expect(requested).toEqual([AGENT])
    // A bridge without the face (an older blackboard plugin) folds the explicit error.
    expect(createBlackboardRemoteService({ bridge: () => bridge.faces }).requestPromotion(AGENT, {})).toEqual({ ok: false, error: 'the blackboard bridge does not offer promotion requests' })
    // markPromoted: fresh mark, already-promoted report, missing-key error.
    bridge.kernel.write('root-session', { holderId: 'root-session', ...ENTRY, ttlMs: TTL })
    expect(service.markPromoted(AGENT, { key: 'probe.key', destination: 'docs/spikes.md' })).toEqual({ ok: true, destination: 'docs/spikes.md' })
    expect(service.markPromoted(AGENT, { key: 'probe.key', destination: 'runtime-map' })).toEqual({ ok: true, destination: 'docs/spikes.md', alreadyPromoted: true })
    expect(service.markPromoted(AGENT, { key: 'ghost', destination: 'docs/spikes.md' })).toEqual({ ok: false, error: 'blackboard key "ghost" does not exist' })
  })

  it('a promoted entry refuses apply with the explicit promoted shape; write/remove fold the promoted error', () => {
    const bridge = makeBridge()
    const service = serviceOf(bridge)
    bridge.kernel.write('root-session', { holderId: 'root-session', ...ENTRY, ttlMs: TTL })
    bridge.kernel.markPromoted('root-session', { key: 'probe.key', destination: 'agents-pointer' })
    expect(service.apply(AGENT, { key: 'probe.key' })).toEqual({ acquired: false, promoted: true, destination: 'agents-pointer' })
    const written = service.write(AGENT, { ...ENTRY, content: 'v2' })
    expect(written.ok).toBe(false)
    expect(written.error).toMatch(/promoted \(agents-pointer\) and read-only/)
    const removed = service.remove(AGENT, { key: 'probe.key' })
    expect(removed.ok).toBe(false)
    expect(removed.error).toMatch(/promoted \(agents-pointer\) and read-only/)
    // The list wire row carries the promoted marker.
    const row = service.list(AGENT, {}).entries[0]
    expect(row.promoted.destination).toBe('agents-pointer')
    expect(typeof row.promoted.at).toBe('number')
  })

  it('a failing ensureRegistered gate blocks every call before any face resolves', () => {
    const bridge = makeBridge()
    const service = createBlackboardRemoteService({ bridge: () => bridge.faces, ensureRegistered: () => false })
    let caught
    try { service.list(AGENT, {}) } catch (error) { caught = error }
    expect(caught.code).toBe('channel-unavailable')
  })

  it('the hand-written contribution pins the wire contract: namespace, seven methods, agent lookup + args', () => {
    const contribution = blackboardRemoteContribution()
    expect(contribution.package).toBe('orrery-blackboard')
    expect(contribution.face).toBe('host')
    expect(contribution.invocations.map((invocation) => invocation.method)).toEqual(BLACKBOARD_REMOTE_METHODS)
    for (const invocation of contribution.invocations) {
      expect(invocation.namespace).toBe(BLACKBOARD_REMOTE_NAMESPACE)
      expect(invocation.service).toBe(BLACKBOARD_REMOTE_SERVICE_KEY)
      expect(invocation.invocation).toEqual({ kind: 'direct' })
      expect(invocation.scope).toEqual({ context: 'agent', wire: 'agentId' })
      expect(invocation.parameters).toEqual([
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: { mode: 'src-json' } },
        { name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } },
      ])
      expect(invocation.result).toEqual({ mode: 'src-json' })
    }
  })
})

describe('host-layer apply (inert without typert, bound + registered with it)', () => {
  it('stays inert with a warning when typert is missing or lacks register', () => {
    const warnings = []
    remoteApply({ get: () => { throw new Error('no typert service') }, logger: { warn: (text) => warnings.push(text) }, root: { reflect: { provide() {} } } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/typert service lookup failed/)
    const missing = []
    remoteApply({ get: () => ({}), logger: { warn: (text) => missing.push(text) }, root: { reflect: { provide() {} } } })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatch(/typert service is unavailable/)
  })

  it('provides the frozen typertRemote binding on the host root and registers the contribution', () => {
    const registrations = []
    const provided = new Map()
    const typert = {
      register: (contribution) => { registrations.push(contribution) },
      local: { get: () => undefined },
    }
    remoteApply({ get: (name) => (name === 'typert' ? typert : undefined), logger: { warn() {} }, root: { reflect: { provide: (key, service) => provided.set(key, service) } } })
    expect(registrations).toHaveLength(1)
    const service = provided.get(BLACKBOARD_REMOTE_SERVICE_KEY)
    expect(service).toBeTruthy()
    expect(Object.isFrozen(service)).toBe(true)
    expect(service.typertRemote.namespace).toBe(BLACKBOARD_REMOTE_NAMESPACE)
    expect(service.typertRemote.serviceKey).toBe(BLACKBOARD_REMOTE_SERVICE_KEY)
    expect(service.typertRemote.service).toBe(service)
  })

  it('a registration that throws but leaves the endpoints live is success, not a warning', () => {
    const warnings = []
    const typert = {
      register: () => { throw new Error('duplicate package face') },
      local: { get: (endpoint) => (endpoint === `${BLACKBOARD_REMOTE_NAMESPACE}/list` ? {} : undefined) },
    }
    remoteApply({ get: () => typert, logger: { warn: (text) => warnings.push(text) }, root: { reflect: { provide() {} } } })
    expect(warnings).toHaveLength(0)
  })
})
