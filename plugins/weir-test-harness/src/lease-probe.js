// Driver-side client of the `weir-editlockd` lease wire protocol.
//
// The integration driver is the SECOND owner in the lease scenarios (design of
// filelease-turn-release): a headless boot is one process = one broker
// connection, so a genuinely foreign owner has to come from the driver itself.
// This module is that owner — and, for the turn probe, the read-only reader of
// the arbiter's table.
//
// Plain Node only (`node:net` + newline-delimited JSON), on purpose: the test
// harness is its own package and must not import product source. The frame
// grammar below is the one documented in `docs/features/edit-lock-protocol.md`
// (and pinned to the implementation by the product's own protocol-doc test):
//
//   →  {"op":"hello","protocol":1,"reqId":"p1"}\n
//   ←  {"ok":true,"protocol":1,"daemonVersion":"…","startedAt":…,"reqId":"p1"}\n
//   →  {"op":"acquire","owner":{"id","session","label"},"scope":"…","paths":[…],"reqId":"p2"}\n
//   ←  {"ok":false,"error":{"code":"held","conflicts":[{"path","holder","expiresAt","holdUntil"}]},"reqId":"p2"}\n
//
// Two deliberate differences from the product client, both driver-shaped:
//   - protocol refusals (`ok:false`) are RETURNED, not thrown: a scenario wants
//     to assert the refusal (code, holder label), so turning it into an
//     exception would only force a try/catch around the interesting value;
//   - transport failures reject with `error.code === 'transport'`, and the
//     caller decides whether that is a retry (boot not up yet) or a fact.
//
// The protocol major is a literal here rather than an import: when the product
// bumps it, this client's handshake is refused loudly (`protocol-mismatch`)
// instead of silently speaking a stale dialect.

import { createConnection } from 'node:net'

/** The protocol major this client speaks (edit-lock protocol doc, `PROTOCOL`). */
export const PROTOCOL_MAJOR = 1

/** Per-request deadline; the product client's own timeout is the same order. */
const DEFAULT_TIMEOUT_MS = 2_000

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Accept the two shapes a caller naturally has: a lineage string or an owner
 * record. The broker requires all three owner fields (protocol: `owner` is
 * exactly `{id, session, label}`), so a string expands to the same value in
 * every slot — the broker never interprets them (D8).
 * @param {string | { id?: unknown, session?: unknown, label?: unknown }} owner
 * @returns {{ id: string, session: string, label: string }}
 */
function normalizeOwner(owner) {
  if (typeof owner === 'string') {
    if (!isNonEmptyString(owner)) throw new TypeError('lease owner string must be non-empty')
    return { id: owner, session: owner, label: owner }
  }
  const id = owner?.id
  if (!isNonEmptyString(id)) throw new TypeError('lease owner requires a non-empty id (the lineage)')
  const session = isNonEmptyString(owner?.session) ? owner.session : id
  const label = isNonEmptyString(owner?.label) ? owner.label : session
  return { id, session, label }
}

/**
 * @param {unknown} paths
 * @returns {string[]} de-duplicated, as the protocol's all-or-nothing batch
 */
function normalizePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('lease paths must be a non-empty array')
  /** @type {string[]} */
  const out = []
  for (const path of paths) {
    if (!isNonEmptyString(path)) throw new TypeError('lease paths must be non-empty strings')
    if (!out.includes(path)) out.push(path)
  }
  return out
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  // Deliberately NOT unref'd: these waits only exist because the driver is
  // waiting for a real event (a boot, a daemon, a file), and an unref'd timer
  // would let Node drain the event loop and exit mid-wait — observed as an
  // "unsettled top-level await" with no output at all.
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Poll a synchronous or asynchronous predicate until it is truthy.
 *
 * Unlike `retryUntil`, a thrown error is a real failure here: "does this file
 * exist yet" has no expected failure mode, so swallowing one would hide the
 * bug the scenario is about.
 * @template T
 * @param {() => T | Promise<T>} probe
 * @param {{ timeoutMs?: number, stepMs?: number }} [options]
 * @returns {Promise<Awaited<T> | null>} the first truthy value, or null at the deadline
 */
export async function pollUntil(probe, { timeoutMs = 10_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline) return null
    await sleep(stepMs)
  }
}

/**
 * Retry a failing attempt until it succeeds or the deadline passes.
 *
 * This exists for one shape: the daemon is spawned by the booted product on its
 * first managed write, so before that write the driver's connect is expected to
 * fail (`ENOENT`). Retrying is not error hiding — the returned facts carry the
 * last transport error so a scenario can assert that the arbiter never came up.
 * @template T
 * @param {() => T | Promise<T>} attempt
 * @param {{ timeoutMs?: number, stepMs?: number }} [options]
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: any }>}
 */
export async function retryUntil(attempt, { timeoutMs = 10_000, stepMs = 50 } = {}) {
  /** @type {any} */
  let lastError = null
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      return { ok: true, value: await attempt() }
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) return { ok: false, error: lastError }
    await sleep(stepMs)
  }
}

/**
 * One lazy broker connection: dial on first use, keep it open, then answer
 * newline-framed requests one `reqId` at a time.
 *
 * The connection is unref'd so a driver that forgets `close()` still exits; an
 * explicit `close()` is the normal path.
 *
 * @param {string} socketPath endpoint address (or a win32 pipe name)
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{
 *   endpoint: string,
 *   open: () => Promise<void>,
 *   connected: () => boolean,
 *   hello: () => Promise<any>,
 *   acquire: (owner: any, paths: string[], scope?: string) => Promise<any>,
 *   status: (filter?: { scope?: string, session?: string, path?: string }) => Promise<any>,
 *   release: (owner: any, paths: string[]) => Promise<any>,
 *   close: () => void,
 * }}
 */
export function connectLeaseBroker(socketPath, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isNonEmptyString(socketPath)) throw new TypeError('connectLeaseBroker requires a socket path')
  /** @type {import('node:net').Socket | null} */
  let socket = null
  /** @type {Promise<void> | null} */
  let dialing = null
  let closed = false
  let buffered = ''
  let sequence = 0
  /** @type {Map<string, { resolve: (frame: any) => void, reject: (error: any) => void, timer: any }>} */
  const waiters = new Map()
  /** The handshake reply of the CURRENT connection (null until greeted). @type {{ protocol?: number, daemonVersion?: string, startedAt?: number } | null} */
  let greeting = null

  /** @param {string} message @param {unknown} [cause] */
  function transportError(message, cause) {
    /** @type {any} */
    const error = new Error(message)
    error.code = 'transport'
    if (cause !== undefined) error.cause = cause
    return error
  }

  /** @param {any} error */
  function failWaiters(error) {
    for (const [reqId, waiter] of [...waiters]) {
      waiters.delete(reqId)
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  /** @param {string} line */
  function handleLine(line) {
    if (line.trim() === '') return
    /** @type {any} */
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      // An undecodable line cannot be correlated with anything; the waiter's
      // own deadline is what reports it.
      return
    }
    if (frame === null || typeof frame !== 'object') return
    const reqId = typeof frame.reqId === 'string' ? frame.reqId : undefined
    if (reqId === undefined) return
    const waiter = waiters.get(reqId)
    if (waiter === undefined) return
    waiters.delete(reqId)
    clearTimeout(waiter.timer)
    waiter.resolve(frame)
  }

  function dropSocket() {
    const current = socket
    socket = null
    greeting = null
    buffered = ''
    if (current === null) return
    try {
      current.destroy()
    } catch {
      // Already gone.
    }
    failWaiters(transportError(`lease broker connection closed (${socketPath})`))
  }

  /** @returns {Promise<void>} */
  function dial() {
    return new Promise((resolve, reject) => {
      const candidate = createConnection({ path: socketPath })
      candidate.setEncoding('utf8')
      let settled = false
      candidate.once('connect', () => {
        if (settled) return
        settled = true
        candidate.setNoDelay(true)
        candidate.unref?.()
        socket = candidate
        resolve()
      })
      candidate.once('error', (error) => {
        if (settled) return
        settled = true
        try {
          candidate.destroy()
        } catch {
          // Already gone.
        }
        reject(transportError(`lease broker is unreachable at ${socketPath}`, error))
      })
      candidate.on('data', (chunk) => {
        buffered += chunk
        let index = buffered.indexOf('\n')
        while (index >= 0) {
          const line = buffered.slice(0, index)
          buffered = buffered.slice(index + 1)
          handleLine(line)
          index = buffered.indexOf('\n')
        }
      })
      candidate.on('close', () => {
        if (socket === candidate) dropSocket()
      })
    })
  }

  /** @returns {Promise<void>} */
  async function open() {
    if (closed) throw transportError('lease probe is closed')
    if (socket !== null) return
    if (dialing !== null) return await dialing
    const attempt = dial().finally(() => {
      if (dialing === attempt) dialing = null
    })
    dialing = attempt
    return await attempt
  }

  /**
   * @param {string} op
   * @param {Record<string, any>} payload
   * @returns {Promise<any>} the raw reply frame
   */
  /**
   * Send one frame and await the reply correlated by `reqId`.
   * @param {Record<string, any>} frame
   * @returns {Promise<any>} the raw reply frame
   */
  async function sendFrame(frame) {
    const target = socket
    if (target === null) throw transportError(`lease broker is not connected (${socketPath})`)
    sequence += 1
    const reqId = `p${sequence}`
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(reqId)
        reject(transportError(`lease broker did not answer ${String(frame.op)} within ${timeoutMs}ms`))
      }, timeoutMs)
      waiters.set(reqId, { resolve, reject, timer })
      try {
        target.write(`${JSON.stringify({ ...frame, reqId })}\n`)
      } catch (error) {
        waiters.delete(reqId)
        clearTimeout(timer)
        reject(transportError(`lease broker write failed at ${socketPath}`, error))
      }
    })
  }

  /**
   * Complete the handshake on the current connection. The broker drops a
   * connection whose first frame is not a valid `hello`, so this must run
   * exactly once per dial, before any other op.
   * @returns {Promise<any>}
   */
  async function greet() {
    if (greeting !== null) return greeting
    const reply = await sendFrame({ op: 'hello', protocol: PROTOCOL_MAJOR })
    if (reply?.ok !== true) {
      const code = typeof reply?.error?.code === 'string' ? reply.error.code : 'unknown'
      throw transportError(`lease broker refused the handshake (${code})`)
    }
    greeting = reply
    return reply
  }

  /** @returns {Promise<void>} */
  async function open() {
    if (closed) throw transportError('lease probe is closed')
    if (socket !== null) {
      await greet()
      return
    }
    if (dialing !== null) {
      await dialing
      await greet()
      return
    }
    const attempt = dial().finally(() => {
      if (dialing === attempt) dialing = null
    })
    dialing = attempt
    await attempt
    try {
      await greet()
    } catch (error) {
      dropSocket()
      throw error
    }
  }

  /**
   * @param {string} op
   * @param {Record<string, any>} payload
   * @returns {Promise<any>} the raw reply frame
   */
  async function request(op, payload) {
    await open()
    return await sendFrame({ op, ...payload })
  }

  /** @param {Record<string, unknown>} filter */
  function statusFilterOf(filter) {
    /** @type {Record<string, string>} */
    const payload = {}
    for (const key of ['scope', 'session', 'path']) {
      const value = filter?.[key]
      if (isNonEmptyString(value)) payload[key] = value
    }
    return payload
  }

  return Object.freeze({
    endpoint: socketPath,
    open,
    connected: () => socket !== null,
    hello: async () => {
      await open()
      return greeting
    },
    acquire: (owner, paths, scope) =>
      request('acquire', {
        owner: normalizeOwner(owner),
        scope: isNonEmptyString(scope) ? scope : process.cwd(),
        paths: normalizePaths(paths),
      }),
    status: (filter = {}) => request('status', statusFilterOf(filter)),
    release: (owner, paths) => request('release', { owner: normalizeOwner(owner), paths: normalizePaths(paths) }),
    close() {
      if (closed) return
      closed = true
      dropSocket()
    },
  })
}
