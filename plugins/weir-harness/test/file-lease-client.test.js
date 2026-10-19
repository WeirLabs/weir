import { describe, expect, it } from './helpers.js'
import { createLeaseClient, isLeaseConflict } from '../src/file-lease/client.js'
import { defaultSocketPath } from '../src/lease-broker/server.js'

// Unit tests for the lease client's state machine, driven by a SCRIPTED
// in-process broker: no socket, no child process, no wall clock dependency. The
// real-IPC counterpart lives in file-lease-client-ipc.test.js.
//
// The four contracts these tests pin, and why each one is worth a test:
//
//  - D7: infrastructure failure degrades (write proceeds, one audit record) and a
//    real conflict never does. Everything else in this file is bookkeeping.
//  - D6: the replay ledger is maintained for release and replay only, and its
//    contents never decide a verdict.
//  - D2: a lease is held for the turn — `withLeases` never releases on the way out.
//  - D8: one connection, one `reqId` per request, exact correlation.

const SCOPE = '/work/project'
const OWNER = Object.freeze({ id: 'lineage-a', session: 'sess-a', label: 'orchestrator' })
const OTHER = Object.freeze({ id: 'lineage-b', session: 'sess-b', label: 'reviewer' })

/** @param {string} name */
function P(name) {
  return `${SCOPE}/${name}`
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {string} label
 * @param {number} [ms]
 */
async function waitFor(predicate, label, ms = 2_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(5)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * A dial failure shaped like the one Node throws (`ENOENT`, `ECONNREFUSED`).
 * @param {string} code
 */
function socketError(code) {
  return Object.assign(new Error(`${code}: fake dial failure`), { code })
}

/**
 * One fake connection: records every frame the client writes and lets the test
 * answer (or refuse to answer, or hang up) deterministically.
 * @param {(frame: any, connection: any) => any} answer
 */
function createFakeConnection(answer) {
  /** @type {any} */
  const connection = {
    /** @type {any[]} */
    frames: [],
    closed: false,
    /** @type {((chunk: string) => void)[]} */
    dataHandlers: [],
    /** @type {(() => void)[]} */
    closeHandlers: [],
    write(text) {
      if (connection.closed) throw new Error('write on a closed connection')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const frame = JSON.parse(line)
        connection.frames.push(frame)
        const reply = answer(frame, connection)
        if (reply === null || reply === undefined) continue
        const payload = { ...reply, reqId: frame.reqId }
        queueMicrotask(() => connection.push(payload))
      }
    },
    onData(handler) {
      connection.dataHandlers.push(handler)
    },
    onClose(handler) {
      connection.closeHandlers.push(handler)
    },
    /** Deliver one frame from the broker to the client. */
    push(frame) {
      if (connection.closed) return
      const text = `${JSON.stringify(frame)}\n`
      for (const handler of [...connection.dataHandlers]) handler(text)
    },
    /** Drop the connection (a daemon restart, or a card pulled). */
    reset() {
      if (connection.closed) return
      connection.closed = true
      for (const handler of connection.closeHandlers.splice(0)) handler()
    },
  }
  connection.close = connection.reset
  return connection
}

/**
 * A scripted broker: `answer` decides every reply (`null` = never answer), the
 * test can queue dial failures and bump the daemon's `startedAt` to simulate a
 * restart.
 */
function createFakeBroker() {
  /** @type {any[]} */
  const connections = []
  /** @type {Error[]} */
  const connectErrors = []
  let dialAttempts = 0
  let startedAt = 1_000
  /** @type {(frame: any, connection: any) => any} */
  let answer = (frame) => {
    if (frame.op === 'hello') return { ok: true, protocol: 1, daemonVersion: 'test', startedAt }
    if (frame.op === 'acquire') {
      return {
        ok: true,
        granted: frame.paths.map((path) => ({
          path,
          owner: { ...frame.owner },
          scope: frame.scope,
          acquiredAt: 1_000,
          expiresAt: Date.now() + 120_000,
          holdUntil: null,
        })),
      }
    }
    if (frame.op === 'hold') {
      return {
        ok: true,
        held: frame.paths.map((path) => ({
          path,
          expiresAt: Date.now() + 120_000,
          holdUntil: Date.now() + frame.minutes * 60_000,
        })),
      }
    }
    if (frame.op === 'release') return { ok: true, released: [...frame.paths], notOwned: [] }
    if (frame.op === 'status') return { ok: true, leases: [] }
    return { ok: true }
  }
  return {
    connections,
    connectErrors,
    get dialAttempts() {
      return dialAttempts
    },
    get last() {
      return connections[connections.length - 1]
    },
    /** @param {number} value */
    setStartedAt(value) {
      startedAt = value
    },
    /** @param {(frame: any, connection: any) => any} fn */
    setAnswer(fn) {
      answer = fn
    },
    /** @param {string} code @param {number} [times] */
    failNextDials(code, times = 1) {
      for (let index = 0; index < times; index += 1) connectErrors.push(/** @type {any} */ (socketError(code)))
    },
    async connect() {
      dialAttempts += 1
      const failure = connectErrors.shift()
      if (failure !== undefined) throw failure
      const connection = createFakeConnection((frame, live) => answer(frame, live))
      connections.push(connection)
      return connection
    },
  }
}

/**
 * Build a client bound to a fake broker, with every out-of-process dependency
 * replaced.
 * @param {ReturnType<typeof createFakeBroker>} broker
 * @param {{ audit?: (kind: string, detail: any) => void, spawnDaemon?: () => unknown, now?: () => number, timeoutMs?: number, connectRetryMs?: number, connectRetryBudgetMs?: number }} [overrides]
 */
function createClient(broker, overrides = {}) {
  return createLeaseClient({
    socketPath: '/fake/weir-editlockd.sock',
    connect: () => broker.connect(),
    spawnDaemon: () => null,
    timeoutMs: 200,
    connectRetryMs: 2,
    connectRetryBudgetMs: 10,
    ...overrides,
  })
}

/**
 * @param {any} client
 * @param {string[]} paths
 * @returns {Promise<'granted' | 'held' | string>} the rejection code, or 'granted'
 */
async function outcome(client, paths = [P('a')]) {
  try {
    await client.withLeases(OWNER, paths, SCOPE, () => {})
    return 'granted'
  } catch (error) {
    return error?.code ?? 'unknown'
  }
}

describe('file-lease client: endpoint', () => {
  it('reuses the daemon\u2019s own socket derivation instead of re-deriving it', () => {
    const live = createClient(createFakeBroker())
    // The fake client pins an explicit path, so the default is checked directly.
    const fallback = createLeaseClient({ protocol: 4 })
    expect(fallback.endpoint).toBe(defaultSocketPath({ protocol: 4 }))
    expect(fallback.endpoint).toContain('-v4')
    fallback.close()
    live.close()
  })
})

describe('file-lease client: degrade and proceed (D7)', () => {
  it('runs the write and audits exactly once per window when the arbiter stays silent', async () => {
    const broker = createFakeBroker()
    // Handshake only: every acquire hangs, which is what a wedged daemon looks like.
    broker.setAnswer((frame) => (frame.op === 'hello' ? { ok: true, protocol: 1, daemonVersion: 'test', startedAt: 1_000 } : null))
    /** @type {{ kind: string, detail: any }[]} */
    const audits = []
    let clock = 1_000_000
    const client = createClient(broker, {
      audit: (kind, detail) => audits.push({ kind, detail }),
      now: () => clock,
      timeoutMs: 15,
    })
    let ran = 0

    await client.withLeases(OWNER, [P('a')], SCOPE, () => {
      ran += 1
    })
    expect(ran).toBe(1)
    expect(audits).toHaveLength(1)
    expect(audits[0].kind).toBe('degraded')
    expect(audits[0].detail.code).toBe('transport')
    expect(audits[0].detail.session).toBe(OWNER.session)
    expect(audits[0].detail.paths).toBe(1)
    // One retry on a fresh connection, then it gave up: two dials, two acquires.
    expect(broker.connections).toHaveLength(2)
    expect(broker.connections[0].frames.filter((frame) => frame.op === 'acquire')).toHaveLength(1)

    // Inside the window: the write still proceeds, the audit stays at one record.
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {
      ran += 1
    })
    expect(ran).toBe(2)
    expect(audits).toHaveLength(1)

    // Past the window a new degrade is worth a new record.
    clock += 60_001
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {
      ran += 1
    })
    expect(ran).toBe(3)
    expect(audits).toHaveLength(2)
    client.close()
  })

  it('never degrades a real conflict: no retry, no audit, no write', async () => {
    const broker = createFakeBroker()
    broker.setAnswer((frame) => {
      if (frame.op === 'hello') return { ok: true, protocol: 1, daemonVersion: 'test', startedAt: 1_000 }
      if (frame.op === 'acquire') {
        return {
          ok: false,
          error: {
            code: 'held',
            conflicts: [{ path: P('a'), holder: { ...OTHER }, expiresAt: 1_000, holdUntil: null }],
          },
        }
      }
      return { ok: true }
    })
    /** @type {any[]} */
    const audits = []
    const client = createClient(broker, { audit: (kind, detail) => audits.push({ kind, detail }) })
    let ran = 0
    /** @type {any} */
    let caught = null
    try {
      await client.withLeases(OWNER, [P('a')], SCOPE, () => {
        ran += 1
      })
    } catch (error) {
      caught = error
    }
    expect(isLeaseConflict(caught)).toBe(true)
    expect(caught.conflicts).toHaveLength(1)
    expect(caught.conflicts[0].holder.id).toBe(OTHER.id)
    expect(ran).toBe(0)
    expect(audits).toHaveLength(0)
    // A conflict is final: exactly one acquire frame, exactly one connection.
    expect(broker.connections).toHaveLength(1)
    expect(broker.connections[0].frames.filter((frame) => frame.op === 'acquire')).toHaveLength(1)
    client.close()
  })

  it('keeps the conflict when the retry after a transport failure reports one', async () => {
    const broker = createFakeBroker()
    let acquireFrames = 0
    broker.setAnswer((frame) => {
      if (frame.op === 'hello') return { ok: true, protocol: 1, daemonVersion: 'test', startedAt: 1_000 }
      if (frame.op !== 'acquire') return { ok: true }
      acquireFrames += 1
      if (acquireFrames === 1) return null // transport failure
      return { ok: false, error: { code: 'held', conflicts: [{ path: P('a'), holder: { ...OTHER }, expiresAt: 1_000, holdUntil: null }] } }
    })
    /** @type {any[]} */
    const audits = []
    const client = createClient(broker, {
      audit: (kind, detail) => audits.push({ kind, detail }),
      timeoutMs: 15,
    })
    let ran = 0
    /** @type {any} */
    let caught = null
    try {
      await client.withLeases(OWNER, [P('a')], SCOPE, () => {
        ran += 1
      })
    } catch (error) {
      caught = error
    }
    expect(isLeaseConflict(caught)).toBe(true)
    expect(caught.conflicts).toHaveLength(1)
    expect(ran).toBe(0)
    expect(audits).toHaveLength(0)
    // The retry ran on a fresh connection: a dead socket is not reused.
    expect(broker.connections).toHaveLength(2)
    client.close()
  })
})

describe('file-lease client: hold retention and replay (D6)', () => {
  it('replays retained holds when the daemon returns as a new incarnation', async () => {
    const broker = createFakeBroker()
    const client = createClient(broker)
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {})
    await client.hold([P('a')], 30)
    const first = broker.last
    // D2: the turn's leases are NOT released on the way out.
    expect(first.frames.map((frame) => frame.op)).toEqual(['hello', 'acquire', 'hold'])

    // Restart: the socket dies and the new process reports a different startedAt.
    broker.setStartedAt(2_000)
    first.reset()
    const status = await client.status()
    expect(status.ok).toBe(true)

    const second = broker.last
    expect(second).not.toBe(first)
    expect(second.frames.map((frame) => frame.op)).toEqual(['hello', 'acquire', 'hold', 'status'])
    const reacquired = second.frames.find((frame) => frame.op === 'acquire')
    expect(reacquired.paths).toEqual([P('a')])
    expect(reacquired.owner).toEqual({ ...OWNER })
    expect(reacquired.scope).toBe(SCOPE)
    const reheld = second.frames.find((frame) => frame.op === 'hold')
    // The replay re-establishes roughly the remaining retention (never shorter).
    expect(reheld.minutes).toBeGreaterThan(25)
    // The protocol's own bound, mirrored: a replay never asks for more than 60.
    expect(reheld.minutes <= 60).toBe(true)
    client.close()
  })

  it('replays nothing when the ledger is empty', async () => {
    const broker = createFakeBroker()
    const client = createClient(broker)
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {})
    const first = broker.last
    broker.setStartedAt(2_000)
    first.reset()
    await client.status()
    expect(broker.last.frames.map((frame) => frame.op)).toEqual(['hello', 'status'])
    client.close()
  })

  it('drops a replay whose lease somebody else now holds, without throwing', async () => {
    const broker = createFakeBroker()
    const client = createClient(broker)
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {})
    await client.hold([P('a')], 30)
    const first = broker.last

    broker.setStartedAt(2_000)
    broker.setAnswer((frame) => {
      if (frame.op === 'hello') return { ok: true, protocol: 1, daemonVersion: 'test', startedAt: 2_000 }
      if (frame.op === 'acquire') {
        return { ok: false, error: { code: 'held', conflicts: [{ path: P('a'), holder: { ...OTHER }, expiresAt: Date.now() + 60_000, holdUntil: null }] } }
      }
      if (frame.op === 'status') {
        return { ok: true, leases: [{ path: P('a'), owner: { ...OTHER }, scope: SCOPE, acquiredAt: 1, expiresAt: Date.now() + 60_000, holdUntil: null }] }
      }
      return { ok: true }
    })
    first.reset()
    const status = await client.status()
    expect(status.leases[0].owner.id).toBe(OTHER.id)

    const second = broker.last
    expect(second.frames.filter((frame) => frame.op === 'acquire')).toHaveLength(1)
    // The retention is gone after the failed replay: no `hold` for a lost lease.
    expect(second.frames.filter((frame) => frame.op === 'hold')).toHaveLength(0)
    // …and the entry is out of the ledger, so an explicit replay sends nothing.
    const settled = second.frames.length
    await client.replayHolds()
    expect(second.frames).toHaveLength(settled)
    client.close()
  })

  it('never lets the ledger decide ownership', async () => {
    const broker = createFakeBroker()
    let phase = 'grant'
    broker.setAnswer((frame) => {
      if (frame.op === 'hello') return { ok: true, protocol: 1, daemonVersion: 'test', startedAt: 1_000 }
      if (frame.op === 'acquire') {
        if (phase === 'grant') {
          return { ok: true, granted: [{ path: P('a'), owner: { ...OWNER }, scope: SCOPE, acquiredAt: 1_000, expiresAt: Date.now() + 120_000, holdUntil: null }] }
        }
        // The daemon says someone else won the path — the client's own ledger
        // saying "we hold /work/project/a" must not change the answer.
        return { ok: false, error: { code: 'held', conflicts: [{ path: P('a'), holder: { ...OTHER }, expiresAt: Date.now() + 60_000, holdUntil: null }] } }
      }
      return { ok: true }
    })
    const client = createClient(broker)
    expect(await outcome(client, [P('a')])).toBe('granted')
    phase = 'conflict'
    expect(await outcome(client, [P('a')])).toBe('held')
    client.close()
  })
})

describe('file-lease client: release rules (D10)', () => {
  it('releases a finished turn, keeps retentions, and releaseAll takes both', async () => {
    const broker = createFakeBroker()
    const client = createClient(broker)
    await client.withLeases(OWNER, [P('a'), P('b')], SCOPE, () => {})
    await client.hold([P('a')], 30)
    const connection = broker.last
    const releases = () => connection.frames.filter((frame) => frame.op === 'release')

    // Another session's turn ending touches nothing we hold.
    await client.releaseSession(OTHER.session)
    expect(releases()).toHaveLength(0)

    // `turn/end`: the unretained lease goes, the retention stays.
    await client.releaseSession(OWNER.session)
    expect(releases()).toHaveLength(1)
    expect(releases()[0].paths).toEqual([P('b')])
    expect(releases()[0].owner).toEqual({ ...OWNER })

    // `agent/disposed`: everything goes, retentions included.
    await client.releaseAll(OWNER.session)
    expect(releases()).toHaveLength(2)
    expect(releases()[1].paths).toEqual([P('a')])
    client.close()
  })

  it('does not throw at a turn boundary when the release frame cannot be sent', async () => {
    const broker = createFakeBroker()
    const client = createClient(broker)
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {})
    broker.last.reset()
    broker.failNextDials('ECONNREFUSED', 10)
    // Release is an optimisation: a broken transport must not fail a turn.
    const result = await client.releaseAll(OWNER.session)
    expect(result.released).toEqual([])
    client.close()
  })
})

describe('file-lease client: correlation and connection hygiene (D8)', () => {
  it('gives every request its own reqId and drops a reply nobody is waiting for', async () => {
    const broker = createFakeBroker()
    broker.setAnswer((frame) => (frame.op === 'hello' ? { ok: true, protocol: 1, daemonVersion: 'test', startedAt: 1_000 } : null))
    const client = createClient(broker, { timeoutMs: 500 })
    const first = client.request('status')
    const second = client.request('status')
    const connection = broker.last
    await waitFor(() => connection.frames.filter((frame) => frame.op === 'status').length === 2, 'two status frames')
    const statuses = connection.frames.filter((frame) => frame.op === 'status')
    expect(statuses[0].reqId).not.toBe(statuses[1].reqId)
    expect(typeof statuses[0].reqId).toBe('string')

    // A reply carrying a token nobody owns settles nothing at all.
    let firstSettled = false
    void first.then(() => {
      firstSettled = true
    })
    connection.push({ reqId: 'not-a-request', ok: true, leases: ['bogus'] })
    await delay(10)
    expect(firstSettled).toBe(false)

    // Replies may arrive out of order; each request gets its own answer.
    connection.push({ reqId: statuses[1].reqId, ok: true, leases: ['second'] })
    expect((await second).leases).toEqual(['second'])
    expect(firstSettled).toBe(false)
    connection.push({ reqId: statuses[0].reqId, ok: true, leases: ['first'] })
    expect((await first).leases).toEqual(['first'])
    client.close()
  })

  it('shares one connection and one handshake across concurrent callers', async () => {
    const broker = createFakeBroker()
    const client = createClient(broker)
    await Promise.all([
      client.withLeases(OWNER, [P('a')], SCOPE, () => {}),
      client.withLeases(OTHER, [P('b')], SCOPE, () => {}),
    ])
    // One connection per process (D8): a second caller joins the first dial
    // instead of opening its own — two connections would arbitrate against
    // each other even inside this one process.
    expect(broker.dialAttempts).toBe(1)
    expect(broker.connections).toHaveLength(1)
    const frames = broker.connections[0].frames
    expect(frames.filter((frame) => frame.op === 'hello')).toHaveLength(1)
    const acquired = frames.filter((frame) => frame.op === 'acquire')
    expect(acquired).toHaveLength(2)
    expect(acquired[0].reqId).not.toBe(acquired[1].reqId)
    expect(acquired[0].owner.id).toBe(OWNER.id)
    expect(acquired[1].owner.id).toBe(OTHER.id)
    client.close()
  })

  it('close() fails a pending request with transport and leaves the daemon alone', async () => {
    const broker = createFakeBroker()
    broker.setAnswer((frame) => (frame.op === 'hello' ? { ok: true, protocol: 1, daemonVersion: 'test', startedAt: 1_000 } : null))
    let spawns = 0
    const client = createClient(broker, {
      spawnDaemon: () => {
        spawns += 1
      },
      timeoutMs: 5_000,
    })
    const pending = client.request('status')
    await waitFor(() => broker.last !== undefined && broker.last.frames.length > 0, 'handshake')
    client.close()
    /** @type {any} */
    let caught = null
    try {
      await pending
    } catch (error) {
      caught = error
    }
    expect(caught?.code).toBe('transport')
    // Closing a client is not a request to stop the shared daemon.
    expect(spawns).toBe(0)

    let afterClose = null
    try {
      await client.request('status')
    } catch (error) {
      afterClose = error
    }
    expect(afterClose?.code).toBe('transport')
    client.close() // idempotent
  })
})

describe('file-lease client: self-healing connection (D7, no permanent fuse)', () => {
  it('spawns at most once per attempt and retries the dial until the daemon is up', async () => {
    const broker = createFakeBroker()
    broker.failNextDials('ENOENT', 2)
    let spawns = 0
    const client = createClient(broker, {
      spawnDaemon: () => {
        spawns += 1
      },
      timeoutMs: 200,
    })
    let ran = 0
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {
      ran += 1
    })
    expect(ran).toBe(1)
    expect(spawns).toBe(1)
    expect(broker.dialAttempts).toBe(3)
    expect(broker.last.frames.filter((frame) => frame.op === 'acquire')).toHaveLength(1)
    client.close()
  })

  it('re-tries connect and spawn on the next call after degrading', async () => {
    const broker = createFakeBroker()
    broker.failNextDials('ECONNREFUSED', 64)
    let spawns = 0
    const client = createClient(broker, {
      spawnDaemon: () => {
        spawns += 1
      },
      timeoutMs: 100,
      connectRetryMs: 2,
      connectRetryBudgetMs: 8,
    })
    let ran = 0
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {
      ran += 1
    })
    // Degraded, not fused: the write went through and a spike of dial attempts
    // happened (one spawn per attempt, then bounded retries).
    expect(ran).toBe(1)
    expect(spawns).toBe(2)
    const attemptsWhileDown = broker.dialAttempts
    expect(attemptsWhileDown).toBeGreaterThan(2)

    // The very next call must try again — including the spawn — and succeed.
    broker.connectErrors.length = 0
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {
      ran += 1
    })
    expect(ran).toBe(2)
    expect(broker.dialAttempts).toBeGreaterThan(attemptsWhileDown)
    expect(spawns).toBe(2)
    expect(broker.last.frames.filter((frame) => frame.op === 'acquire')).toHaveLength(1)
    client.close()
  })
})

describe('file-lease client: passthrough surface (D8 field discipline)', () => {
  it('forwards only the fields the frame grammar allows', async () => {
    const broker = createFakeBroker()
    const client = createClient(broker)
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {})
    const connection = broker.last
    await client.hold([P('a')], 30)
    // A filter key the protocol does not know would be `bad-request` on the wire —
    // and therefore a degrade. The client forwards the closed set only.
    await client.status({ path: P('a'), bogus: 'ignored' })
    await client.requestTransfer(P('a'), OTHER)
    await client.reply({ requestId: 'req-1', owner: OWNER, decision: 'keep' })

    /** @param {string} op */
    const lastFrame = (op) => connection.frames.filter((frame) => frame.op === op).at(-1)
    expect(Object.keys(lastFrame('hold')).sort()).toEqual(['minutes', 'op', 'owner', 'paths', 'reqId'])
    expect(lastFrame('hold').owner).toEqual({ ...OWNER })
    expect(Object.keys(lastFrame('status')).sort()).toEqual(['op', 'path', 'reqId'])
    expect(lastFrame('request').from).toEqual({ ...OTHER })
    expect(lastFrame('request').path).toBe(P('a'))
    expect(Object.keys(lastFrame('reply')).sort()).toEqual(['decision', 'op', 'owner', 'reqId', 'requestId'])
    expect(lastFrame('reply').decision).toBe('keep')
    client.close()
  })

  it('infers the hold owner from the ledger and refuses a batch it does not hold', async () => {
    const broker = createFakeBroker()
    const client = createClient(broker)
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {})
    await client.hold([P('a')], 30)
    const connection = broker.last
    // `hold` extends something already owned, so the ledger is the owner source.
    expect(connection.frames.filter((frame) => frame.op === 'hold').at(-1).owner).toEqual({ ...OWNER })

    const framesBefore = connection.frames.length
    /** @type {any} */
    let caught = null
    try {
      await client.hold([P('never-held')], 30)
    } catch (error) {
      caught = error
    }
    expect(caught?.code).toBe('not-owned')
    // Refused locally: no frame reached the broker.
    expect(connection.frames).toHaveLength(framesBefore)
    client.close()
  })

  it('delivers pushed negotiation events to subscribers only', async () => {
    const broker = createFakeBroker()
    const client = createClient(broker)
    await client.withLeases(OWNER, [P('a')], SCOPE, () => {})
    const connection = broker.last
    /** @type {any[]} */
    const seen = []
    const off = client.onEvent((event) => seen.push(event))
    connection.push({ event: 'request', requestId: 'req-1', path: P('a'), from: { ...OTHER }, expiresAt: 1 })
    connection.push({ event: 'settled', requestId: 'req-1', path: P('a'), state: 'declined' })
    await delay(5)
    expect(seen.map((event) => event.event)).toEqual(['request', 'settled'])
    expect(seen[0].from.id).toBe(OTHER.id)
    expect(seen[1].state).toBe('declined')
    off()
    connection.push({ event: 'settled', requestId: 'req-2', path: P('a'), state: 'expired' })
    await delay(5)
    expect(seen).toHaveLength(2)
    client.close()
  })
})
