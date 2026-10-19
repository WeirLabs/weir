import { describe, expect, it } from './helpers.js'
import { buildLeaseView } from '../src/file-lease/view.js'
import { createFileLeasePlugin } from '../src/file-lease/plugin.js'

// The read-only ownership view (edit-lock rebuild task 3.7, design D13).
//
// Two contracts are pinned here, and both are user-facing:
//
//  1. the SHAPE of the view — three arbiter values, a mine/others split by
//     lineage, short path names only, and provably no lifecycle field (no
//     epoch, generation, reservation, recovery, operation or fence). Those
//     concepts were deleted with the durable authority; a view that carried
//     them would grow a story the system no longer has.
//  2. the ENDPOINT — one POST route, a `{ sessionId }` body, the `{ ok, value }`
//     envelope, a degraded answer (never a lie) when the arbiter cannot be
//     read, and duplicate-registration tolerance that is exactly one message
//     wide because several preset mounts share one process.

const AT = 1_700_000_000_000
const CWD = '/work/project'

/** A lease exactly as the arbiter's `status` reply shapes it. */
function leaseOf(path, owner, extra = {}) {
  return { path, owner, scope: CWD, acquiredAt: AT - 30_000, expiresAt: AT + 90_000, holdUntil: null, ...extra }
}

const MINE = Object.freeze({ id: 'lineage-a', session: 'sess-a', label: 'orchestrator' })
const OTHER = Object.freeze({ id: 'lineage-b', session: 'sess-b', label: 'reviewer' })

describe('file-lease view: the read-only ownership projection', () => {
  it('reports exactly the three arbiter states, and never presents an unknown one as healthy', () => {
    for (const state of ['ok', 'degraded', 'unavailable']) {
      expect(buildLeaseView({ leases: [], arbiter: state, now: AT }).arbiter, `${state} round-trips`).toBe(state)
    }
    for (const unknown of [undefined, null, '', 'OK', 'starting', 1, {}]) {
      expect(buildLeaseView({ leases: [], arbiter: unknown, now: AT }).arbiter, `unknown arbiter ${String(unknown)}`).toBe('unavailable')
    }
    expect(buildLeaseView().schemaVersion).toBe(1)
  })

  it('splits claims by lineage: another session of the same lineage is still mine', () => {
    const view = buildLeaseView({
      leases: [
        leaseOf('/work/project/a.txt', MINE),
        // The same lineage through a second attachment (D9): one owner, so it
        // belongs to "this session" even though the session id differs.
        leaseOf('/work/project/b.txt', { ...MINE, session: 'sess-a-child' }),
        leaseOf('/work/project/c.txt', OTHER),
      ],
      mineLineage: MINE.id,
      cwd: CWD,
      arbiter: 'ok',
      now: AT,
    })
    expect(view.mine.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt'])
    expect(view.others.map((entry) => entry.path)).toEqual(['c.txt'])
    // Nothing is mine without a lineage to compare against (a cold session).
    expect(buildLeaseView({ leases: [leaseOf('/work/project/a.txt', MINE)], cwd: CWD, arbiter: 'ok', now: AT }).mine).toEqual([])
  })

  it('renders short names only: relative inside the cwd, basename outside it', () => {
    const view = buildLeaseView({
      leases: [
        leaseOf('/work/project/src/deep/a.js', MINE),
        leaseOf('/elsewhere/other/b.js', MINE),
        leaseOf('/work/project/c.js', OTHER),
      ],
      mineLineage: MINE.id,
      cwd: CWD,
      arbiter: 'ok',
      now: AT,
    })
    // Ordered by the short name the user reads, not by the snapshot's order.
    expect(view.mine.map((entry) => entry.path)).toEqual(['b.js', 'src/deep/a.js'])
    expect(view.others.map((entry) => entry.path)).toEqual(['c.js'])
    for (const entry of [...view.mine, ...view.others]) {
      expect(entry.path.startsWith('/'), `path ${entry.path} is never absolute`).toBe(false)
      // The absolute path lives in its own field, for a technical layer only.
      expect(entry.pathFull.startsWith('/'), `pathFull ${entry.pathFull}`).toBe(true)
    }
    // No cwd at all: bare basenames, still never absolute.
    const bare = buildLeaseView({ leases: [leaseOf('/work/project/src/deep/a.js', MINE)], mineLineage: MINE.id, arbiter: 'ok', now: AT })
    expect(bare.mine[0].path).toBe('a.js')
    expect(bare.mine[0].pathFull).toBe('/work/project/src/deep/a.js')
  })

  it('carries no lifecycle vocabulary at all — no epoch, generation, reservation, recovery, operation or fence', () => {
    const view = buildLeaseView({
      leases: [
        leaseOf('/work/project/a.txt', MINE, { holdUntil: AT + 600_000, generation: 7, epoch: 3 }),
        leaseOf('/work/project/b.txt', OTHER, { reservation: {}, recovery: { attempts: 2 }, operation: 'write', fence: 'x' }),
      ],
      mineLineage: MINE.id,
      cwd: CWD,
      arbiter: 'ok',
      now: AT,
      // Even a caller padding the input cannot smuggle them through.
      generation: 9,
      epoch: 4,
      recovery: {},
      operation: 'write',
      fence: 'abc',
    })
    const forbidden = ['epoch', 'generation', 'reservation', 'recovery', 'operation', 'fence']
    /** @type {string[]} */
    const keys = []
    const walk = (node) => {
      if (Array.isArray(node)) { for (const item of node) walk(item); return }
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) { keys.push(key); walk(value) }
    }
    walk(view)
    for (const key of forbidden) expect(keys.includes(key), `no ${key} key anywhere`).toBe(false)
    const serialized = JSON.stringify(view).toLowerCase()
    for (const word of forbidden) expect(serialized.includes(word), `no ${word} in the payload`).toBe(false)
    // The exact allow-lists of both sections, so an extra field cannot appear
    // unnoticed (the panel is a fixed surface, not an open-ended dump).
    expect(Object.keys(view.mine[0]).sort()).toEqual(['heldSince', 'holdUntil', 'label', 'path', 'pathFull'])
    expect(Object.keys(view.others[0]).sort()).toEqual(['expiresAt', 'holdUntil', 'holder', 'path', 'pathFull'])
    expect(Object.keys(view.others[0].holder).sort()).toEqual(['label', 'session'])
    expect(Object.keys(view).sort()).toEqual(['arbiter', 'mine', 'others', 'schemaVersion'])
  })

  it('treats a lapsed row as not-ownership, and keeps a retention alive past expiresAt', () => {
    const view = buildLeaseView({
      leases: [
        leaseOf('/work/project/gone.txt', MINE, { expiresAt: AT - 1 }),
        leaseOf('/work/project/exactly-now.txt', MINE, { expiresAt: AT }),
        leaseOf('/work/project/retained.txt', MINE, { expiresAt: AT - 1, holdUntil: AT + 60_000 }),
        leaseOf('/work/project/lapsed-hold.txt', MINE, { expiresAt: AT + 60_000, holdUntil: AT - 1 }),
      ],
      mineLineage: MINE.id,
      cwd: CWD,
      arbiter: 'ok',
      now: AT,
    })
    expect(view.mine.map((entry) => entry.path)).toEqual(['lapsed-hold.txt', 'retained.txt'])
  })

  it('reports when a claim started, its retention, and the other holder — and nothing else', () => {
    const view = buildLeaseView({
      leases: [
        leaseOf('/work/project/a.txt', MINE, { acquiredAt: AT - 5_000, holdUntil: AT + 120_000 }),
        leaseOf('/work/project/b.txt', OTHER, { acquiredAt: AT - 7_000, expiresAt: AT + 30_000 }),
      ],
      mineLineage: MINE.id,
      cwd: CWD,
      arbiter: 'ok',
      now: AT,
    })
    expect(view.mine).toEqual([{ path: 'a.txt', pathFull: '/work/project/a.txt', label: 'orchestrator', heldSince: AT - 5_000, holdUntil: AT + 120_000 }])
    expect(view.others).toEqual([{ path: 'b.txt', pathFull: '/work/project/b.txt', holder: { label: 'reviewer', session: 'sess-b' }, expiresAt: AT + 30_000, holdUntil: null }])
  })

  it('orders deterministically regardless of the snapshot order', () => {
    const paths = ['/work/project/z.txt', '/work/project/a.txt', '/work/project/m/n.txt']
    const forward = buildLeaseView({ leases: paths.map((path) => leaseOf(path, MINE)), mineLineage: MINE.id, cwd: CWD, arbiter: 'ok', now: AT })
    const backward = buildLeaseView({ leases: [...paths].reverse().map((path) => leaseOf(path, MINE)), mineLineage: MINE.id, cwd: CWD, arbiter: 'ok', now: AT })
    expect(forward.mine.map((entry) => entry.pathFull)).toEqual(['/work/project/a.txt', '/work/project/m/n.txt', '/work/project/z.txt'])
    expect(backward.mine).toEqual(forward.mine)
  })

  it('survives a partial snapshot instead of throwing into the endpoint', () => {
    const view = buildLeaseView({
      leases: [null, 42, {}, { path: '' }, leaseOf('/work/project/ok.txt', OTHER)],
      mineLineage: MINE.id,
      cwd: CWD,
      arbiter: 'ok',
      now: AT,
    })
    expect(view.others.map((entry) => entry.path)).toEqual(['ok.txt'])
    expect(buildLeaseView({ leases: 'nope', arbiter: 'ok', now: AT }).mine).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The endpoint: one read-only POST route registered by the preset row.
// ---------------------------------------------------------------------------

/** One process-wide plane: agents, and the connection's exact-route registry. */
function createPlane() {
  const agents = new Map()
  const routes = new Map()
  const connection = {
    fetch: {
      register(/** @type {any} */ definition) {
        if (routes.has(definition.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(definition.path)} is already registered`)
        routes.set(definition.path, definition)
        return () => { if (routes.get(definition.path) === definition) routes.delete(definition.path) }
      },
    },
  }
  return { agents, routes, connection }
}

/** A fake lease client: it records reads and cannot mutate anything. */
function createFakeClient({ leases = [], state = 'ok', failStatus = false } = {}) {
  /** @type {any[]} */
  const calls = []
  return {
    calls,
    async status(/** @type {any} */ filter) {
      calls.push({ op: 'status', filter })
      if (failStatus) throw Object.assign(new Error('broker is down'), { code: 'transport' })
      return { ok: true, leases }
    },
    connectionState() {
      calls.push({ op: 'connectionState' })
      return state
    },
    onEvent() {
      return () => {}
    },
  }
}

function createCtx(/** @type {any} */ plane) {
  return {
    get(/** @type {string} */ key) {
      if (key === 'agents') return { get: (/** @type {string} */ id) => plane.agents.get(id) }
      return undefined
    },
    inject(/** @type {string[]} */ names, /** @type {any} */ callback) {
      if (!Array.isArray(names) || !names.includes('connection')) return undefined
      return callback({ connection: plane.connection })
    },
    on() {
      return () => {}
    },
    tools: {
      get() {
        return undefined
      },
      register() {
        return () => {}
      },
    },
    logger: { warn() {} },
  }
}

/** One live session in the plane, rooted at CWD. */
function addAgent(/** @type {any} */ plane, id) {
  const agent = { id, status: 'idle', session: { id, header: { id, cwd: CWD, delegationDepth: 0 } } }
  plane.agents.set(id, agent)
  return agent
}

const VIEW_PATH = '/api/weir-edit-lock/view'
const request = (/** @type {any} */ body) => ({ json: async () => body })
const rejecting = () => ({ json: async () => { throw new Error('not json') } })

describe('file-lease view endpoint', () => {
  it('registers ONE buffered POST route and answers with the { ok, value } envelope', async () => {
    const plane = createPlane()
    addAgent(plane, 'sess-a')
    // A root session is its own lineage (D9), so the claim owner id IS sess-a.
    const client = createFakeClient({ leases: [leaseOf('/work/project/a.txt', { ...MINE, id: 'sess-a' }), leaseOf('/work/project/b.txt', OTHER)] })
    const dispose = createFileLeasePlugin({ client, now: () => AT }).apply(createCtx(plane), { enabled: true })
    const route = plane.routes.get(VIEW_PATH)
    expect(route.path).toBe(VIEW_PATH)
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')
    const response = await route.fetch(request({ sessionId: 'sess-a' }))
    expect(response.status).toBe(200)
    const answer = await response.json()
    expect(answer.ok).toBe(true)
    expect(answer.value.schemaVersion).toBe(1)
    expect(answer.value.arbiter).toBe('ok')
    expect(answer.value.mine.map((entry) => entry.path)).toEqual(['a.txt'])
    expect(answer.value.others.map((entry) => entry.path)).toEqual(['b.txt'])
    // The read is scoped to the session's own project, exactly like the
    // model-facing status tool, and it is a READ: nothing else is called.
    expect(client.calls.filter((call) => call.op === 'status')[0].filter).toEqual({ scope: CWD })
    expect(client.calls.map((call) => call.op).filter((op) => op !== 'status' && op !== 'connectionState')).toEqual([])
    dispose()
    expect(plane.routes.has(VIEW_PATH)).toBe(false)
  })

  it('rejects a body without a session id, and a body that is not JSON', async () => {
    const plane = createPlane()
    const client = createFakeClient()
    createFileLeasePlugin({ client, now: () => AT }).apply(createCtx(plane), { enabled: true })
    const route = plane.routes.get(VIEW_PATH)
    for (const body of [{}, { sessionId: '' }, { sessionId: 7 }, null]) {
      const response = await route.fetch(request(body))
      expect(response.status, `status for ${JSON.stringify(body)}`).toBe(400)
      const answer = await response.json()
      expect(answer.ok).toBe(false)
      expect(answer.error.code).toBe('weir-edit-lock/invalid')
    }
    const undecodable = await route.fetch(rejecting())
    expect(undecodable.status).toBe(400)
    expect(client.calls).toEqual([])
  })

  it('answers the degraded state when the arbiter cannot be read, instead of claiming "nothing held"', async () => {
    const plane = createPlane()
    addAgent(plane, 'sess-a')
    const client = createFakeClient({ state: 'degraded', failStatus: true })
    createFileLeasePlugin({ client, now: () => AT }).apply(createCtx(plane), { enabled: true })
    const answer = await (await plane.routes.get(VIEW_PATH).fetch(request({ sessionId: 'sess-a' }))).json()
    expect(answer.ok).toBe(true)
    expect(answer.value.arbiter).toBe('degraded')
    expect(answer.value.mine).toEqual([])
  })

  it('reports the client connection state without touching it', async () => {
    const plane = createPlane()
    addAgent(plane, 'sess-a')
    const client = createFakeClient({ state: 'unavailable' })
    createFileLeasePlugin({ client, now: () => AT }).apply(createCtx(plane), { enabled: true })
    const answer = await (await plane.routes.get(VIEW_PATH).fetch(request({ sessionId: 'sess-a' }))).json()
    expect(answer.value.arbiter).toBe('unavailable')
  })

  it('answers a cold session (no live agent) as its own lineage with basenames', async () => {
    const plane = createPlane()
    const client = createFakeClient({ leases: [leaseOf('/work/project/deep/a.txt', { ...MINE, id: 'cold-session' })] })
    createFileLeasePlugin({ client, now: () => AT }).apply(createCtx(plane), { enabled: true })
    const answer = await (await plane.routes.get(VIEW_PATH).fetch(request({ sessionId: 'cold-session' }))).json()
    expect(answer.value.mine.map((entry) => entry.path)).toEqual(['a.txt'])
    // No cwd to scope by: the read is unfiltered rather than wrong.
    expect(client.calls.filter((call) => call.op === 'status')[0].filter).toEqual({})
  })

  it('tolerates ONLY the exact duplicate-route refusal: two mounts, one surviving route', async () => {
    const plane = createPlane()
    addAgent(plane, 'sess-a')
    const client = createFakeClient()
    const ctx = createCtx(plane)
    const disposeFirst = createFileLeasePlugin({ client, now: () => AT }).apply(ctx, { enabled: true })
    expect(plane.routes.has(VIEW_PATH)).toBe(true)
    // The second preset mount must not abort mid-inject when the process-wide
    // route is already taken (D11).
    const disposeSecond = createFileLeasePlugin({ client, now: () => AT }).apply(ctx, { enabled: true })
    expect(plane.routes.has(VIEW_PATH)).toBe(true)
    disposeSecond()
    // The second mount never owned the route, so its unmount leaves it alone.
    expect(plane.routes.has(VIEW_PATH)).toBe(true)
    disposeFirst()
    expect(plane.routes.has(VIEW_PATH)).toBe(false)
  })

  it('does not swallow any other registration error', () => {
    const plane = createPlane()
    plane.connection.fetch.register = () => {
      throw new Error('connection: boom')
    }
    const ctx = createCtx(plane)
    expect(() => createFileLeasePlugin({ client: createFakeClient(), now: () => AT }).apply(ctx, { enabled: true })).toThrow(/connection: boom/)
  })
})
