// The client half of the edit-lock lease protocol (design D6, D7, D8).
//
// The daemon in ../lease-broker/ is the ONLY arbiter: every verdict about who
// may write a file arrives over this socket, and nothing here re-derives one.
// What lives in this file:
//
//  - one lazily established connection per client, one `hello` handshake per
//    connection, one `reqId` per request (replies are matched by that id and by
//    nothing else);
//  - the in-memory lease ledger (`path -> {session, lineage, holdUntil}`). It is
//    used for exactly two things — knowing what a turn boundary must release and
//    what a reconnect must replay. It NEVER decides a conflict (D6): the moment
//    this file starts reasoning about ownership it becomes a second authority,
//    which is the failure mode this whole design exists to delete;
//  - degrade-and-proceed (D7). An unhealthy arbiter never blocks a write; a real
//    `held` conflict always does. The protocol's closed error vocabulary is what
//    keeps those two apart — no heuristics, no "is it probably fine".
//
// Deliberately absent: killing or restarting the daemon. The daemon is a cache
// with an idle window and a stale-socket recovery of its own, and a client that
// permanently gives up after one transport failure would turn a transient blip
// into a session-long loss of arbitration. Every later call re-tries the
// connection (and the spawn); only the audit is rate limited.
//
// Every external dependency is injected so a unit test can drive the state
// machine without a socket, a clock, or a child process.

import { isAbsolute } from 'node:path'
import { createConnection } from 'node:net'
import { PROTOCOL } from '../lease-broker/protocol.js'
import { defaultSocketPath } from '../lease-broker/server.js'
import { spawnDaemon as defaultSpawnDaemon } from './spawn.js'

/** Per-request deadline. A slow arbiter is an unhealthy arbiter (D7). */
const DEFAULT_TIMEOUT_MS = 2_000

/** Pause between connection attempts while a spawned daemon comes up. */
const DEFAULT_CONNECT_RETRY_MS = 50

/** Total budget for "spawn, then wait for the socket" before degrading. */
const DEFAULT_CONNECT_RETRY_BUDGET_MS = 1_500

/** Retention bound in minutes, mirrored from the protocol for replay math. */
const HOLD_MAX_MINUTES = 60

/** Infrastructure failure: connection, handshake, timeout, write, closed. */
export const TRANSPORT_CODE = 'transport'

/** Real conflict: someone else holds the path. Never degraded (D7). */
const CONFLICT_CODE = 'held'

/** Endpoint-absent errors: nobody is listening yet, so spawning may help. */
const ABSENT_ENDPOINT_CODES = new Set(['ENOENT', 'ECONNREFUSED'])

/**
 * Degraded-mode audit throttle: at most one record per process per window (D7).
 * Exported because the operator-facing contract names the number.
 */
export const DEGRADED_AUDIT_WINDOW_MS = 60_000

/**
 * @typedef {Error & {
 *   code: string,
 *   conflicts?: any[],
 *   paths?: string[],
 *   maxMinutes?: number,
 *   cause?: unknown,
 * }} LeaseFailure
 */

/**
 * @typedef {object} LeaseRecord
 * @property {string} session the session that last touched the lease (release scope)
 * @property {string} lineage the opaque `owner.id` this client acquired under
 * @property {number | null} holdUntil retention deadline in epoch ms, `null` when unretained
 */

/**
 * The transport contract the state machine speaks. `connect()` may resolve a
 * connection asynchronously and must reject with the underlying error (so
 * `ENOENT`/`ECONNREFUSED` can be recognised as "daemon not up yet").
 *
 * @typedef {object} LeaseConnection
 * @property {(text: string) => void} write may throw; every throw is a transport failure
 * @property {(handler: (chunk: string) => void) => void} onData newline-delimited frames
 * @property {(handler: () => void) => void} onClose called once when the connection is gone
 * @property {() => void} close idempotent
 */

/**
 * @typedef {object} LeaseClientOptions
 * @property {string} [socketPath] endpoint address; defaults to the daemon's own `defaultSocketPath({protocol})`
 * @property {number} [protocol] protocol major sent in the handshake
 * @property {number} [timeoutMs] per-request deadline
 * @property {() => number} [now] injected clock (epoch ms)
 * @property {(socketPath: string) => LeaseConnection | Promise<LeaseConnection>} [connect] dial the endpoint
 * @property {(() => unknown) | null} [spawnDaemon] called at most once per connection attempt; `null` disables spawning
 * @property {(kind: string, detail: Record<string, any>) => void} [audit] audit sink (`kind` is `'degraded'`)
 * @property {number} [connectRetryMs] pause between connection attempts after a spawn
 * @property {number} [connectRetryBudgetMs] total budget for connect attempts after a spawn
 * @property {number} [degradedAuditWindowMs] throttle window for the degraded audit record
 */

/**
 * @param {string} code
 * @param {string} message
 * @param {{ conflicts?: any[], paths?: string[], maxMinutes?: number, cause?: unknown }} [detail]
 * @returns {LeaseFailure}
 */
function leaseError(code, message, detail = {}) {
  /** @type {LeaseFailure} */
  const error = /** @type {LeaseFailure} */ (new Error(message))
  error.code = code
  if (Array.isArray(detail.conflicts)) error.conflicts = detail.conflicts
  if (Array.isArray(detail.paths)) error.paths = detail.paths
  if (typeof detail.maxMinutes === 'number') error.maxMinutes = detail.maxMinutes
  if (detail.cause !== undefined) error.cause = detail.cause
  return error
}

/**
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {LeaseFailure}
 */
function transportError(message, cause) {
  return leaseError(TRANSPORT_CODE, message, { cause })
}

/**
 * True for a real conflict — the only refusal that may stop a write.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isLeaseConflict(error) {
  return !!error && typeof error === 'object' && /** @type {any} */ (error).code === CONFLICT_CODE
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorCode(error) {
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
  return typeof code === 'string' ? code : 'internal'
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Default dialer: a plain newline-JSON socket from `node:net`.
 * @param {string} socketPath
 * @returns {Promise<LeaseConnection>}
 */
function defaultConnect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    socket.setEncoding('utf8')
    let connected = false
    let settled = false
    socket.once('connect', () => {
      connected = true
      settled = true
      socket.setNoDelay(true)
      // A lease connection is process state (design D11), not a pending task: it
      // must never keep an otherwise-finished Node process alive. Without this
      // an idle client pins the event loop, so a headless CLI turn that ended
      // normally only dies when its caller times out (observed as a hung
      // integration boot), and a graceful host shutdown would wait forever.
      // `unref` is part of Node's net.Socket but not modelled by the hand-written
      // node contracts this bundle compiles against (`types: []`), and the
      // connection is an injectable stub in tests — hence the guarded call.
      const timer = /** @type {{ unref?: () => void }} */ (/** @type {unknown} */ (socket))
      if (typeof timer.unref === 'function') timer.unref()
      resolve(wrapSocket(socket))
    })
    socket.once('error', (error) => {
      // Pre-connect: the dial failed and the caller decides whether to spawn and
      // re-try. Post-connect: the wrapper's own listener turns it into a close.
      if (connected || settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // Already gone.
      }
      reject(error)
    })
    socket.on('close', () => {
      if (connected || settled) return
      settled = true
      reject(leaseError(TRANSPORT_CODE, `lease broker closed the connection during dial to ${socketPath}`))
    })
  })
}

/**
 * Narrow a Node socket to the `LeaseConnection` contract, making the close
 * notification exactly-once (Node may emit both `error` and `close`).
 * @param {import('node:net').Socket} socket
 * @returns {LeaseConnection}
 */
function wrapSocket(socket) {
  let released = false
  /** @type {(() => void)[]} */
  const listeners = []
  const notify = () => {
    if (released) return
    released = true
    for (const listener of listeners.splice(0)) {
      try {
        listener()
      } catch {
        // A transport listener must never break the client's own bookkeeping.
      }
    }
  }
  socket.on('error', () => {
    try {
      socket.destroy()
    } catch {
      // Already gone.
    }
    notify()
  })
  socket.on('close', notify)
  return {
    write(text) {
      socket.write(text)
    },
    onData(handler) {
      socket.on('data', handler)
    },
    onClose(handler) {
      if (released) {
        // Registered too late: report asynchronously so the caller's state
        // machine cannot re-enter mid-registration.
        queueMicrotask(() => {
          try {
            handler()
          } catch {
            // Same rule as notify().
          }
        })
        return
      }
      listeners.push(handler)
    },
    close() {
      notify()
      try {
        socket.destroy()
      } catch {
        // Already gone.
      }
    },
  }
}

/**
 * Create one lease client.
 *
 * A process shares ONE client (design D8/D11): one connection carries every
 * lease of this process, so two preset mounts must never each create their own.
 * The factory exists so tests and the wiring can build independent instances.
 *
 * @param {LeaseClientOptions} [options]
 */
export function createLeaseClient({
  socketPath,
  protocol = PROTOCOL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  connect = defaultConnect,
  spawnDaemon = defaultSpawnDaemon,
  audit = () => {},
  connectRetryMs = DEFAULT_CONNECT_RETRY_MS,
  connectRetryBudgetMs = DEFAULT_CONNECT_RETRY_BUDGET_MS,
  degradedAuditWindowMs = DEGRADED_AUDIT_WINDOW_MS,
} = {}) {
  const endpoint = typeof socketPath === 'string' && socketPath.length > 0 ? socketPath : defaultSocketPath({ protocol })

  /** @type {LeaseConnection | null} */
  let connection = null
  let greeted = false
  /** @type {Promise<LeaseConnection> | null} */
  let connecting = null
  let closed = false
  /** @type {number | undefined} */
  let startedAt
  /** A connection reset means the daemon may have restarted with an empty table (D6). */
  let replayPending = false
  /** A new incarnation was detected; the next request (or `replayHolds`) replays first. */
  let replayQueued = false
  /** @type {Promise<{ replayed: number, dropped: number }> | null} */
  let replaying = null
  /** @type {number | null} */
  let lastDegradedAt = null
  /** @type {string | undefined} */
  let lastScope
  /**
   * The push events the CURRENT handshake advertised. Empty until a handshake
   * answers and after the connection is gone, so "not advertised" and "not
   * connected" both read as unsupported: a caller must never wait for an event
   * this incarnation cannot send.
   * @type {Set<string>}
   */
  let eventCapabilities = new Set()

  /**
   * The replay ledger. `path -> {session, lineage, holdUntil}` — nothing more.
   * In particular there is no `owner`-decides-anything field here, by design.
   * @type {Map<string, LeaseRecord>}
   */
  const ledger = new Map()
  /** `lineage -> label`, presentation only; the broker never compares it. @type {Map<string, string>} */
  const labels = new Map()
  /** @type {Set<(event: any) => void>} */
  const eventHandlers = new Set()
  /** Connection-reset lifecycle listeners (D5). Separate from the wire events
   * above on purpose: a reset is a property of THIS client's transport, not a
   * fact the broker can send. @type {Set<() => void>} */
  const resetHandlers = new Set()
  /**
   * @type {Map<string, {
   *   resolve: (reply: any) => void,
   *   reject: (error: any) => void,
   *   timer: ReturnType<typeof setTimeout>,
   * }>}
   */
  const waiters = new Map()
  let requestSeq = 0

  // ---------------------------------------------------------------------
  // Transport: connection lifecycle, framing, correlation
  // ---------------------------------------------------------------------

  /** @returns {string} a correlation token unique to this client */
  function nextReqId() {
    requestSeq += 1
    return `c${requestSeq}`
  }

  /**
   * @param {LeaseConnection} target
   * @param {Record<string, any>} frame
   * @returns {Promise<any>}
   */
  function sendFrame(target, frame) {
    return new Promise((resolve, reject) => {
      const reqId = nextReqId()
      const timer = setTimeout(() => {
        waiters.delete(reqId)
        reject(transportError(`lease broker did not answer ${String(frame.op)} within ${timeoutMs}ms`))
      }, timeoutMs)
      waiters.set(reqId, { resolve, reject, timer })
      try {
        // `reqId` is written last so a caller-supplied payload cannot collide.
        target.write(`${JSON.stringify({ ...frame, reqId })}\n`)
      } catch (error) {
        clearTimeout(timer)
        waiters.delete(reqId)
        reject(transportError(`lease broker write failed at ${endpoint}`, error))
      }
    })
  }

  /**
   * @param {LeaseConnection} target
   * @param {string} op
   * @param {Record<string, any>} [payload]
   * @returns {Promise<any>}
   */
  async function exchange(target, op, payload = {}) {
    const reply = await sendFrame(target, { op, ...payload })
    if (reply !== null && typeof reply === 'object' && reply.ok === true) return reply
    const detail = reply !== null && typeof reply === 'object' && reply.error !== null && typeof reply.error === 'object' ? reply.error : {}
    const code = typeof detail.code === 'string' ? detail.code : 'internal'
    throw leaseError(code, `lease broker refused ${op}: ${code}`, detail)
  }

  /** @param {any} frame */
  function dispatchEvent(frame) {
    for (const handler of [...eventHandlers]) {
      try {
        handler(frame)
      } catch {
        // A listener is a consumer; it must never be able to break the transport.
      }
    }
  }

  /**
   * Tell every listener that the current connection is gone.
   *
   * Deliberately separate from wire events: a broker that is SIGKILLed cannot
   * announce that it died, so a client that only listened to `EVENTS` would
   * wait forever. Called exactly once per connection (the socket wrapper makes
   * its close notification once-only) and never for an intentional `close()`.
   */
  function notifyReset() {
    for (const handler of [...resetHandlers]) {
      try {
        handler()
      } catch {
        // A listener is a consumer; it must never break the transport.
      }
    }
  }

  /** @param {string} line */
  function handleFrame(line) {
    /** @type {any} */
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      // An undecodable line cannot be matched to anything; the waiter's own
      // deadline is what reports it.
      return
    }
    if (frame === null || typeof frame !== 'object') return
    if (typeof frame.event === 'string') {
      dispatchEvent(frame)
      return
    }
    const reqId = typeof frame.reqId === 'string' ? frame.reqId : undefined
    if (reqId === undefined) return
    const waiter = waiters.get(reqId)
    // Correlation is exact: a reply nobody is waiting for is dropped. The
    // alternative — handing it to the next waiter in line — would let one
    // request satisfy another and silently mis-report ownership.
    if (waiter === undefined) return
    waiters.delete(reqId)
    clearTimeout(waiter.timer)
    waiter.resolve(frame)
  }

  /**
   * @param {any} error
   */
  function failWaiters(error) {
    for (const [reqId, waiter] of [...waiters]) {
      waiters.delete(reqId)
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  /**
   * The ONE connection-invalidation outlet (D5).
   *
   * A connection ends in three ways — the socket closed under us, we dropped it
   * to retry, or the client is closing — and all three must leave the same state
   * behind: no current connection, no handshake, no advertised capabilities, no
   * waiter still believing an answer is coming, and exactly one reset
   * notification for the connection that just went away.
   *
   * Only the CURRENT target may do that. A stale target — a handshake that lost
   * a race, or a socket already replaced by a retry — is a no-op: its late close
   * must not clear the live connection's state or notify a second time.
   *
   * @param {LeaseConnection | null} target
   * @param {boolean} [closing] true for an intentional client close: the ledger is
   *   already gone, so nothing is queued for replay
   * @returns {boolean} whether this target was the current connection
   */
  function invalidateConnection(target, closing = false) {
    if (target === null || connection !== target) return false
    connection = null
    greeted = false
    // The advertised capabilities belonged to that connection.
    eventCapabilities = new Set()
    // D6: a reset connection means the daemon may have died and come back with
    // an empty table, so retained leases have to be replayed on the next dial.
    if (!closing && ledger.size > 0) replayPending = true
    failWaiters(transportError(closing ? 'lease client closed' : 'lease broker connection closed'))
    // D5: a reset is a terminal state for anything waiting on this connection,
    // and the only moment a vanished broker can be reported at all.
    notifyReset()
    return true
  }

  /** @param {LeaseConnection} target */
  function handleDisconnect(target) {
    invalidateConnection(target)
  }

  /**
   * @param {LeaseConnection} target
   * @returns {boolean} whether this target was the current connection
   */
  function dropConnection(target) {
    // Invalidate first: closing the socket reports its close synchronously, and
    // that report must find nothing left to invalidate (exactly-once reset).
    const invalidated = invalidateConnection(target)
    try {
      target.close()
    } catch {
      // Already gone.
    }
    return invalidated
  }

  /** @returns {Promise<{ connection: LeaseConnection | null, error: any }>} */
  async function attemptConnect() {
    try {
      return { connection: await connect(endpoint), error: null }
    } catch (error) {
      return { connection: null, error }
    }
  }

  /** @param {unknown} error @returns {boolean} */
  function isAbsentEndpoint(error) {
    const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
    return typeof code === 'string' && ABSENT_ENDPOINT_CODES.has(code)
  }

  function spawnOnce() {
    if (typeof spawnDaemon !== 'function') return
    try {
      spawnDaemon()
    } catch {
      // Spawning is best effort — a `null` daemon degrades, it never refuses.
    }
  }

  /**
   * Dial the daemon, spawning it once when the endpoint is simply not there.
   *
   * Spawning is per attempt, not per process: after a failure this client must
   * be able to start the daemon again on the next call, because "the daemon is
   * gone" is a transient condition, not a decision to stop arbitrating.
   *
   * @returns {Promise<LeaseConnection>}
   */
  async function openConnection() {
    const first = await attemptConnect()
    if (first.connection !== null) return first.connection
    if (!isAbsentEndpoint(first.error)) {
      throw transportError(`lease broker is unreachable at ${endpoint}`, first.error)
    }
    spawnOnce()
    const deadline = now() + connectRetryBudgetMs
    // A frozen or absent clock must not turn this into an endless loop: the
    // attempt count is what actually bounds the wait.
    const maxAttempts = Math.max(1, Math.ceil(connectRetryBudgetMs / Math.max(1, connectRetryMs))) + 2
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (now() >= deadline) break
      await delay(connectRetryMs)
      const retry = await attemptConnect()
      if (retry.connection !== null) return retry.connection
      if (!isAbsentEndpoint(retry.error)) {
        throw transportError(`lease broker is unreachable at ${endpoint}`, retry.error)
      }
    }
    throw transportError(`lease broker did not come up at ${endpoint} within ${connectRetryBudgetMs}ms`)
  }

  /**
   * Establish the connection and complete the handshake, replaying retained
   * leases when the daemon turns out to be a different incarnation (D6).
   * @returns {Promise<LeaseConnection>}
   */
  async function establish() {
    const fresh = await openConnection()
    const previousStartedAt = startedAt
    connection = fresh
    greeted = false
    let buffered = ''
    fresh.onData((chunk) => {
      buffered += chunk
      let index = buffered.indexOf('\n')
      while (index >= 0) {
        const line = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        if (line.trim() !== '') handleFrame(line)
        index = buffered.indexOf('\n')
      }
    })
    fresh.onClose(() => handleDisconnect(fresh))
    /** @type {any} */
    let hello
    try {
      hello = await sendFrame(fresh, { op: 'hello', protocol })
    } catch (error) {
      dropConnection(fresh)
      throw transportError(`lease broker handshake failed at ${endpoint}`, error)
    }
    if (hello.ok !== true) {
      // A protocol mismatch is infrastructure, not a conflict: the write goes
      // through and the audit records why (D7). Nobody is asked to fix anything.
      const code = typeof hello.error?.code === 'string' ? hello.error.code : 'unknown'
      dropConnection(fresh)
      throw transportError(`lease broker refused the handshake (${code})`)
    }
    greeted = true
    // The handshake is the ONLY source of the push-event list, and an older
    // broker simply does not carry the field: empty means "not advertised".
    eventCapabilities = new Set(
      Array.isArray(hello.events) ? hello.events.filter((entry) => typeof entry === 'string' && entry.length > 0) : [],
    )
    const reported = typeof hello.startedAt === 'number' ? hello.startedAt : previousStartedAt
    startedAt = reported
    const restarted = replayPending || (previousStartedAt !== undefined && previousStartedAt !== reported)
    replayPending = false
    // Arm the replay instead of running it here: the connection is usable, but
    // replaying from inside `establish` would re-enter the request path. The next
    // request flushes it (or `replayHolds()` does, without replaying twice).
    if (restarted && ledger.size > 0) replayQueued = true
    return fresh
  }

  /** @returns {Promise<LeaseConnection>} */
  function ensureConnection() {
    if (closed) return Promise.reject(transportError('lease client is closed'))
    if (connection !== null && greeted) return Promise.resolve(connection)
    if (connecting !== null) return connecting
    /** @type {Promise<LeaseConnection>} */
    const attempt = establish().finally(() => {
      if (connecting === attempt) connecting = null
    })
    connecting = attempt
    return attempt
  }

  /**
   * Send one protocol request on a live connection.
   * @param {string} op
   * @param {Record<string, any>} [payload]
   * @returns {Promise<any>}
   */
  async function request(op, payload = {}) {
    if (typeof op !== 'string' || op.length === 0) throw new TypeError('lease request requires an operation name')
    const target = await ensureConnection()
    if (replayQueued) {
      // Flush before the caller's own frame so an observe-after-reconnect call
      // reports the world the replay has already restored.
      replayQueued = false
      await runReplay()
    }
    return await exchange(target, op, payload)
  }

  // ---------------------------------------------------------------------
  // Ledger: what we hold, what a turn boundary releases, what a reconnect replays
  // ---------------------------------------------------------------------

  /**
   * @param {any} owner
   * @returns {{ id: string, session: string, label: string }}
   */
  function normalizeOwner(owner) {
    const rawId = typeof owner === 'string' ? owner : owner?.id
    const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined
    if (id === undefined) throw new TypeError('lease owner requires a non-empty id (the lineage)')
    const session = typeof owner?.session === 'string' && owner.session.length > 0 ? owner.session : id
    const label = typeof owner?.label === 'string' && owner.label.length > 0 ? owner.label : session
    return { id, session, label }
  }

  /**
   * Normalise and validate the path batch. A relative path is a wiring bug, and
   * the broker would only answer `invalid-path`, which this client would have to
   * degrade — so it is refused loudly here instead of silently losing
   * arbitration for every write of that tool.
   * @param {unknown} paths
   * @returns {string[]}
   */
  function normalizePaths(paths) {
    if (!Array.isArray(paths)) throw new TypeError('lease paths must be an array')
    /** @type {string[]} */
    const out = []
    for (const path of paths) {
      if (typeof path !== 'string' || path.length === 0) throw new TypeError('lease paths must be non-empty strings')
      if (path.includes('\u0000')) throw new TypeError('lease paths may not contain NUL bytes')
      if (!isAbsolute(path)) throw new TypeError(`lease paths must be absolute: ${path}`)
      if (!out.includes(path)) out.push(path)
    }
    return out
  }

  /** @param {unknown} scope @returns {string} */
  function requireScope(scope) {
    if (typeof scope !== 'string' || scope.length === 0) {
      throw new TypeError('lease scope must be a non-empty string (the project root)')
    }
    return scope
  }

  /**
   * @param {string} lineage
   * @param {string} session
   * @returns {{ id: string, session: string, label: string }}
   */
  function ownerOf(lineage, session) {
    return { id: lineage, session, label: labels.get(lineage) ?? session }
  }

  /**
   * The owner to speak as for paths this client already holds. `hold` extends
   * ownership, so an owner can only be inferred from something already owned; a
   * batch we hold nothing of is refused locally as `not-owned` (a closed-vocabulary
   * code) instead of sending a frame the broker would reject anyway.
   * @param {string[]} paths
   * @returns {{ id: string, session: string, label: string }}
   */
  function ownerForPaths(paths) {
    for (const path of paths) {
      const record = ledger.get(path)
      if (record !== undefined) return ownerOf(record.lineage, record.session)
    }
    throw leaseError('not-owned', 'this client holds none of the requested paths, so there is no owner to extend', {
      paths,
    })
  }

  /**
   * Record a granted batch. Only the fields the ledger exists for are kept: who
   * to release as, and whether a retention must be replayed.
   * @param {any[]} granted
   * @param {{ id: string, session: string, label: string }} owner
   * @param {string} scope
   */
  function remember(granted, owner, scope) {
    lastScope = scope
    labels.set(owner.id, owner.label)
    for (const lease of granted) {
      const path = typeof lease?.path === 'string' ? lease.path : undefined
      if (path === undefined) continue
      ledger.set(path, {
        session: owner.session,
        lineage: owner.id,
        holdUntil: typeof lease.holdUntil === 'number' ? lease.holdUntil : null,
      })
    }
  }

  /**
   * Record a successful retention.
   * @param {any} reply
   * @param {{ id: string, session: string, label: string }} owner
   */
  function applyHold(reply, owner) {
    const held = Array.isArray(reply?.held) ? reply.held : []
    labels.set(owner.id, owner.label)
    for (const entry of held) {
      const path = typeof entry?.path === 'string' ? entry.path : undefined
      if (path === undefined) continue
      const holdUntil = typeof entry.holdUntil === 'number' ? entry.holdUntil : null
      ledger.set(path, { session: owner.session, lineage: owner.id, holdUntil })
    }
  }

  // ---------------------------------------------------------------------
  // Arbitration-facing operations
  // ---------------------------------------------------------------------

  /**
   * Acquire a batch up front (the explicit `edit_lock_acquire` form of what every
   * managed write does implicitly).
   * @param {any} owner
   * @param {string[]} paths
   * @param {string} scope
   * @returns {Promise<any>}
   */
  async function acquire(owner, paths, scope) {
    const holder = normalizeOwner(owner)
    const list = normalizePaths(paths)
    const leaseScope = requireScope(scope)
    const reply = await request('acquire', { owner: holder, scope: leaseScope, paths: list })
    if (Array.isArray(reply.granted)) remember(reply.granted, holder, leaseScope)
    return reply
  }

  /**
   * Attempt the batch again on a brand-new connection (the single retry D7
   * allows). Returns `false` when the retry failed too; a real conflict is
   * rethrown, because conflicts are never degraded.
   * @param {{ id: string, session: string, label: string }} owner
   * @param {string[]} paths
   * @param {string} scope
   * @returns {Promise<boolean>}
   */
  async function retryAcquire(owner, paths, scope) {
    const stale = connection
    if (stale !== null) dropConnection(stale)
    try {
      await acquire(owner, paths, scope)
      return true
    } catch (error) {
      if (isLeaseConflict(error)) throw error
      const broken = connection
      if (broken !== null) dropConnection(broken)
      return false
    }
  }

  /**
   * Acquire the batch, or run the write anyway (D7).
   *
   * One retry on a fresh connection at most; when that fails too, a single audit
   * record explains the silent loss of mutual exclusion and `fn` proceeds with no
   * lease. A real conflict is rethrown on every path — including out of the retry.
   *
   * @param {{ id: string, session: string, label: string }} owner
   * @param {string[]} paths
   * @param {string} scope
   * @returns {Promise<void>}
   */
  async function acquireOrDegrade(owner, paths, scope) {
    try {
      await acquire(owner, paths, scope)
      return
    } catch (error) {
      if (isLeaseConflict(error)) throw error
      if (await retryAcquire(owner, paths, scope)) return
      auditDegraded({
        code: errorCode(error),
        session: owner.session,
        lineage: owner.id,
        scope,
        paths: paths.length,
      })
    }
  }

  /**
   * Hold the leases for `owner` for the duration of `fn` (design D2): the leases
   * are acquired once and NOT released in a `finally` — ownership lasts until the
   * turn ends (`releaseSession`) or the process does (`releaseAll`/connection
   * close). `fn` runs exactly once on every path that is not a real conflict.
   *
   * @template T
   * @param {any} owner `{id, session, label}` (or a bare lineage id)
   * @param {string[]} paths absolute paths
   * @param {string} scope opaque project root, used only for `status` filtering
   * @param {() => T | Promise<T>} fn the managed operation
   * @returns {Promise<T>}
   */
  async function withLeases(owner, paths, scope, fn) {
    if (typeof fn !== 'function') throw new TypeError('withLeases requires a callback')
    const holder = normalizeOwner(owner)
    const list = normalizePaths(paths)
    const leaseScope = requireScope(scope)
    if (list.length > 0) await acquireOrDegrade(holder, list, leaseScope)
    return await fn()
  }

  /**
   * Extend the leases for `paths` (only ever later, ≤ 60 minutes; the broker
   * owns that rule). The owner is inferred from the ledger when omitted, which is
   * the only legitimate case: `hold` applies to something already held.
   * @param {string[]} paths
   * @param {number} minutes
   * @param {any} [owner]
   * @returns {Promise<any>}
   */
  async function hold(paths, minutes, owner) {
    const list = normalizePaths(paths)
    const holder = owner === undefined ? ownerForPaths(list) : normalizeOwner(owner)
    const reply = await request('hold', { owner: holder, paths: list, minutes })
    applyHold(reply, holder)
    return reply
  }

  /**
   * Read-only projection. Filters stack; only the protocol's three filter keys
   * are forwarded (the frame grammar rejects extras).
   * @param {{ scope?: string, session?: string, path?: string }} [filter]
   * @returns {Promise<any>}
   */
  function status(filter = {}) {
    /** @type {Record<string, string>} */
    const payload = {}
    if (typeof filter?.scope === 'string' && filter.scope.length > 0) payload.scope = filter.scope
    if (typeof filter?.session === 'string' && filter.session.length > 0) payload.session = filter.session
    if (typeof filter?.path === 'string' && filter.path.length > 0) payload.path = filter.path
    return request('status', payload)
  }

  /**
   * Read-only connection health for the status surface (design D13).
   *
   * `ok` means the handshake stands right now, so a `status` read reaches the
   * arbiter; `degraded` means this process HAS been arbitrated before but the
   * connection is gone at this instant (the next write would degrade and
   * proceed, D7); `unavailable` means it was never reached in this process.
   *
   * Reporting only: it opens nothing, closes nothing and retries nothing, so a
   * reader can never change an arbitration verdict by looking.
   *
   * @returns {'ok' | 'degraded' | 'unavailable'}
   */
  function connectionState() {
    if (closed) return 'unavailable'
    if (connection !== null && greeted) return 'ok'
    // `startedAt` is set by the first successful handshake and never cleared:
    // its presence is exactly "this process once had an arbiter".
    return startedAt === undefined ? 'unavailable' : 'degraded'
  }

  /**
   * Ask the holder of `path` to hand it over (negotiation, D4).
   * @param {string} path
   * @param {any} from the requesting owner
   * @returns {Promise<any>}
   */
  function requestTransfer(path, from) {
    if (typeof path !== 'string' || path.length === 0) throw new TypeError('requestTransfer requires a path')
    return request('request', { from: normalizeOwner(from), path })
  }

  /**
   * Answer a pending transfer request as the holder.
   * @param {{ requestId: string, owner: any, decision: 'release' | 'keep' }} input
   * @returns {Promise<any>}
   */
  function reply(input) {
    const requestId = input?.requestId
    if (typeof requestId !== 'string' || requestId.length === 0) throw new TypeError('reply requires a requestId')
    const decision = input?.decision
    if (decision !== 'release' && decision !== 'keep') throw new TypeError("reply decision must be 'release' or 'keep'")
    return request('reply', { owner: normalizeOwner(input?.owner), requestId, decision })
  }

  // ---------------------------------------------------------------------
  // Release and replay
  // ---------------------------------------------------------------------

  /**
   * Release everything this session holds EXCEPT retentions (design D10): the
   * `turn/end` rule. A failure is swallowed — turn-boundary release is an
   * optimisation, and the daemon's disconnect rule plus the TTL already cover it.
   * @param {string} session
   * @returns {Promise<{ released: string[] }>}
   */
  async function releaseSession(session) {
    return await releaseMatching((record) => record.session === session && record.holdUntil === null)
  }

  /**
   * Release everything this session holds, retentions included (design D10): the
   * `agent/disposed` rule — a disposed agent never comes back.
   * @param {string} session
   * @returns {Promise<{ released: string[] }>}
   */
  async function releaseAll(session) {
    return await releaseMatching((record) => record.session === session)
  }

  /**
   * @param {(record: LeaseRecord) => boolean} match
   * @returns {Promise<{ released: string[] }>}
   */
  async function releaseMatching(match) {
    /** @type {Map<string, { session: string, paths: string[] }>} */
    const groups = new Map()
    for (const [path, record] of [...ledger]) {
      if (!match(record)) continue
      // The intent is "stop holding this", and a failed frame cannot undo the
      // intent: the entry goes, whatever the transport does next.
      ledger.delete(path)
      const group = groups.get(record.lineage) ?? { session: record.session, paths: [] }
      group.session = record.session
      group.paths.push(path)
      groups.set(record.lineage, group)
    }
    /** @type {string[]} */
    const released = []
    for (const [lineage, group] of groups) {
      try {
        const response = await request('release', { owner: ownerOf(lineage, group.session), paths: group.paths })
        if (Array.isArray(response.released)) released.push(...response.released)
      } catch {
        // See above: never throw at a turn boundary, never keep state to retry.
      }
    }
    return { released }
  }

  /**
   * Replay every still-valid retention (`holdUntil > now`) so a daemon restart
   * does not silently drop a hold. An entry somebody else now owns is removed
   * without an error: the next write sees an ordinary conflict (D6).
   * @returns {Promise<{ replayed: number, dropped: number }>}
   */
  async function replayHolds() {
    await ensureConnection()
    // An explicit replay satisfies a queued one: never send the same retention
    // twice just because a reconnect happened to arm it.
    replayQueued = false
    return await runReplay()
  }

  /**
   * @returns {Promise<{ replayed: number, dropped: number }>}
   */
  function runReplay() {
    if (replaying !== null) return replaying
    /** @type {Promise<{ replayed: number, dropped: number }>} */
    const attempt = replayOnce().finally(() => {
      if (replaying === attempt) replaying = null
    })
    replaying = attempt
    return attempt
  }

  /**
   * @returns {Promise<{ replayed: number, dropped: number }>}
   */
  async function replayOnce() {
    let replayed = 0
    let dropped = 0
    const at = now()
    for (const [path, record] of [...ledger]) {
      if (record.holdUntil === null || record.holdUntil <= at) continue
      const owner = ownerOf(record.lineage, record.session)
      const scope = lastScope
      try {
        // Re-acquire first: after a daemon restart the table is empty, so a bare
        // `hold` would be `not-owned`. The pair is idempotent by protocol.
        await acquire(owner, [path], requireScope(scope))
        const response = await request('hold', { owner, paths: [path], minutes: holdMinutes(record.holdUntil - at) })
        applyHold(response, owner)
        replayed += 1
      } catch (error) {
        if (errorCode(error) === TRANSPORT_CODE) {
          // The connection died again: keep the rest for the next reconnect
          // rather than forgetting a retention nobody has seen fail.
          break
        }
        ledger.delete(path)
        dropped += 1
      }
    }
    return { replayed, dropped }
  }

  /**
   * Remaining retention as `hold` minutes, clamped to the protocol's closed
   * interval `(0, 60]` and rounded UP so a replay never shortens a hold.
   * @param {number} remainingMs
   * @returns {number}
   */
  function holdMinutes(remainingMs) {
    const minutes = Math.ceil((remainingMs / 60_000) * 1000) / 1000
    return Math.min(HOLD_MAX_MINUTES, Math.max(0.001, minutes))
  }

  // ---------------------------------------------------------------------
  // Degrade accounting, push events, shutdown
  // ---------------------------------------------------------------------

  /**
   * Record one degraded write. Rate limited per process (D7) so a broken daemon
   * cannot flood the audit log, and never allowed to throw.
   * @param {Record<string, any>} detail
   */
  function auditDegraded(detail) {
    const at = now()
    if (lastDegradedAt !== null && at - lastDegradedAt < degradedAuditWindowMs) return
    lastDegradedAt = at
    try {
      audit('degraded', { ...detail, at })
    } catch {
      // Audit is log-only; it must never break a write.
    }
  }

  /**
   * Subscribe to broker-pushed `request` / `settled` / `released` events.
   * @param {(event: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  function onEvent(handler) {
    if (typeof handler !== 'function') throw new TypeError('onEvent requires a handler')
    eventHandlers.add(handler)
    return () => {
      eventHandlers.delete(handler)
    }
  }

  /**
   * Subscribe to connection resets (D5). A reset means the current connection
   * is gone, so anything that was waiting on a push from it is over — there is
   * nothing to replay and no fact to infer about ownership.
   * @param {() => void} handler
   * @returns {() => void} unsubscribe
   */
  function onReset(handler) {
    if (typeof handler !== 'function') throw new TypeError('onReset requires a handler')
    resetHandlers.add(handler)
    return () => {
      resetHandlers.delete(handler)
    }
  }

  /**
   * Read-only capability query: did the CURRENT handshake advertise this push
   * event? An older broker, a closed client and a dropped connection all answer
   * `false` — the caller must report the capability as unavailable instead of
   * waiting for an event that cannot arrive.
   * @param {string} name
   * @returns {boolean}
   */
  function supportsEvent(name) {
    return typeof name === 'string' && eventCapabilities.has(name)
  }

  /**
   * Close the connection. The daemon keeps running: it is shared with every other
   * client on this machine, and its own idle window is what ends it.
   */
  function close() {
    if (closed) return
    closed = true
    ledger.clear()
    const target = connection
    if (target === null) {
      failWaiters(transportError('lease client closed'))
      return
    }
    // An intentional close ends the current connection like any other loss, so
    // a subscription waiting on it is told the truth instead of waiting forever.
    invalidateConnection(target, true)
    try {
      target.close()
    } catch {
      // Already gone.
    }
  }

  return Object.freeze({
    endpoint,
    request,
    acquire,
    withLeases,
    hold,
    status,
    connectionState,
    requestTransfer,
    reply,
    releaseSession,
    releaseAll,
    replayHolds,
    onEvent,
    onReset,
    supportsEvent,
    close,
  })
}
