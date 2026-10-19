// Socket transport for the lease broker daemon: framing, handshake, process
// lifetime. No business rules live here — every verdict comes from the kernel
// in ./state.js, and this file only decodes frames, routes them, and writes
// replies and events back.
//
// Wire shape: newline-delimited JSON, one frame per line, in both directions.
// Requests carry `op`; replies carry `ok` plus either the result fields or
// `error: {code, ...details}` and always echo the client's `reqId` when it sent
// one. Unsolicited events carry `event` ('request' | 'settled').
//
// Process lifetime (design D1/D8): the daemon is a cache, so it is allowed to
// die. It exits after `idleMs` with no connected client, and stays alive as
// long as any client is connected. A new connection cancels the countdown.

import { createConnection, createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { homedir as osHomedir, tmpdir as osTmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PROTOCOL, validateFrame } from './protocol.js'

/** Idle window before a client-less daemon exits. */
export const DEFAULT_IDLE_MS = 60_000
/** Period of the memory-reclaiming sweep. */
export const DEFAULT_SWEEP_MS = 30_000

/**
 * Default endpoint address for this protocol major.
 *
 * POSIX: `<tmpdir>/weir-editlockd-<uid>-v<protocol>.sock` — per user, so two
 * users on one machine never share an arbiter.
 * win32: `\\.\pipe\weir-editlockd-<sha256(homedir)[0..12]>-v<protocol>` — the
 * pipe namespace is machine-global, so the home directory is folded into the
 * name instead of the uid.
 *
 * The protocol major is part of the address: two majors never arbitrate against
 * each other, and the older one simply idles out.
 *
 * @param {object} [options]
 * @param {string} [options.platform] default `process.platform`
 * @param {number} [options.protocol] default `PROTOCOL`
 * @param {string} [options.tmpdir] default `os.tmpdir()`
 * @param {string} [options.homedir] default `os.homedir()`
 * @param {number | string} [options.uid] default `process.getuid()`
 * @returns {string}
 */
export function defaultSocketPath({ platform = process.platform, protocol = PROTOCOL, tmpdir, homedir, uid } = {}) {
  if (platform === 'win32') {
    const home = homedir ?? osHomedir()
    const digest = createHash('sha256').update(home).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\weir-editlockd-${digest}-v${protocol}`
  }
  const dir = tmpdir ?? osTmpdir()
  const user = uid ?? (typeof process.getuid === 'function' ? process.getuid() : 'unknown')
  return join(dir, `weir-editlockd-${user}-v${protocol}.sock`)
}

/**
 * @typedef {object} LeaseBroker
 * @property {(connectionId: string) => void} connect
 * @property {(connectionId: string) => void} disconnect
 * @property {(input: any) => any} acquire
 * @property {(input: any) => any} release
 * @property {(input: any) => any} hold
 * @property {(filter?: any) => any} status
 * @property {(input: any) => any} request
 * @property {(input: any) => any} reply
 * @property {() => any} sweep
 */

/** Transport-level dispatch: request op → kernel call. Deliberately thin and
 * untyped — the kernel is the only place that decides anything. */
const HANDLERS = {
  acquire: (broker, connectionId, value) =>
    broker.acquire({ connectionId, owner: value.owner, scope: value.scope, paths: value.paths, ttlMs: value.ttlMs }),
  release: (broker, connectionId, value) => broker.release({ connectionId, owner: value.owner, paths: value.paths }),
  hold: (broker, connectionId, value) =>
    broker.hold({ connectionId, owner: value.owner, paths: value.paths, minutes: value.minutes }),
  status: (broker, connectionId, value) => broker.status({ scope: value.scope, session: value.session, path: value.path }),
  request: (broker, connectionId, value) => broker.request({ connectionId, from: value.from, path: value.path }),
  reply: (broker, connectionId, value) =>
    broker.reply({ connectionId, owner: value.owner, requestId: value.requestId, decision: value.decision }),
}

/**
 * Map a kernel verdict onto the wire: `{ok:true, ...fields}` or
 * `{ok:false, error:{code, ...details}}`, plus the echoed `reqId`.
 * @param {any} result
 * @param {string | undefined} reqId
 */
function toWire(result, reqId) {
  /** @type {Record<string, any>} */
  const out = {}
  if (reqId) out.reqId = reqId
  if (result.ok) {
    out.ok = true
    for (const [key, value] of Object.entries(result)) if (key !== 'ok') out[key] = value
    return out
  }
  /** @type {Record<string, any>} */
  const error = { code: result.code }
  for (const [key, value] of Object.entries(result)) if (key !== 'ok' && key !== 'code') error[key] = value
  out.ok = false
  out.error = error
  return out
}

/** @param {any} error */
function errorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
}

/**
 * Start listening.
 *
 * @param {object} options
 * @param {string} options.socketPath endpoint address (`defaultSocketPath()` by default at the entry)
 * @param {LeaseBroker} options.broker arbitration kernel from `createBroker()`
 * @param {number} [options.protocol] this instance's protocol major
 * @param {string} [options.daemonVersion] reported by the handshake
 * @param {number} [options.idleMs] exit after this long with no connected client
 * @param {number} [options.sweepMs] period of `broker.sweep()`
 * @returns {Promise<{ address: string, close: () => Promise<void>, send: (connectionId: string, event: any) => boolean }>}
 */
export async function startServer({
  socketPath,
  broker,
  protocol = PROTOCOL,
  daemonVersion = '0.0.0',
  idleMs = DEFAULT_IDLE_MS,
  sweepMs = DEFAULT_SWEEP_MS,
}) {
  const startedAt = Date.now()
  /** @type {Map<string, import('node:net').Socket>} */
  const clients = new Map()
  let nextConnectionId = 0
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idleTimer = null
  let closed = false
  /** @type {((error: any) => void) | null} */
  let bindFailure = null

  /**
   * @param {import('node:net').Socket} socket
   * @param {any} payload
   */
  function writeFrame(socket, payload) {
    if (!socket || socket.destroyed) return false
    try {
      socket.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch {
      return false
    }
  }

  /** Push one event to one connection; unknown connections are a silent drop. */
  function send(connectionId, event) {
    const socket = clients.get(connectionId)
    if (!socket) return false
    return writeFrame(socket, event)
  }

  function cancelIdle() {
    if (idleTimer === null) return
    clearTimeout(idleTimer)
    idleTimer = null
  }

  function scheduleIdle() {
    if (closed || idleTimer !== null || clients.size > 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      void close()
    }, idleMs > 0 ? idleMs : 0)
  }

  async function close() {
    if (closed) return
    closed = true
    cancelIdle()
    if (sweepTimer !== null) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    for (const socket of clients.values()) {
      try {
        socket.destroy()
      } catch {
        // Already gone; nothing to release here — the kernel drop happens in
        // the connection's own cleanup.
      }
    }
    clients.clear()
    await new Promise((resolve) => {
      try {
        server.close(() => resolve(undefined))
      } catch {
        resolve(undefined)
      }
    })
  }

  /**
   * Handle one decoded line for one connection.
   * @param {import('node:net').Socket} socket
   * @param {any} state
   * @param {string} line
   */
  function handleLine(socket, state, line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      writeFrame(socket, toWire({ ok: false, code: 'bad-request' }, undefined))
      return
    }
    const rawReqId = frame && typeof frame.reqId === 'string' && frame.reqId.length > 0 ? frame.reqId : undefined
    const parsed = validateFrame(frame)
    if (!state.greeted) {
      // The first frame must be a hello. Anything else — including a frame that
      // would have failed validation for a different reason — is bad-request:
      // no other op has a defined meaning before the handshake.
      if (!parsed.ok || parsed.op !== 'hello') {
        writeFrame(socket, toWire({ ok: false, code: 'bad-request' }, rawReqId))
        return
      }
      const hello = /** @type {import('./protocol.js').HelloFrame} */ (parsed.value)
      if (hello.protocol !== protocol) {
        // Different major: answer, then drop the connection. No compatibility
        // negotiation exists by design (D8) — the client starts/uses its own
        // endpoint for its own major.
        writeFrame(socket, toWire({ ok: false, code: 'protocol-mismatch', supported: [protocol] }, hello.reqId))
        state.closing = true
        socket.end()
        return
      }
      state.greeted = true
      writeFrame(socket, toWire({ ok: true, protocol, daemonVersion, startedAt }, hello.reqId))
      return
    }
    if (!parsed.ok) {
      writeFrame(socket, toWire({ ok: false, code: parsed.code }, rawReqId))
      return
    }
    if (parsed.op === 'hello') {
      // Already greeted: a second handshake is a malformed frame.
      writeFrame(socket, toWire({ ok: false, code: 'bad-request' }, rawReqId))
      return
    }
    const handler = HANDLERS[/** @type {keyof typeof HANDLERS} */ (parsed.op)]
    let result
    try {
      result = handler(broker, state.connectionId, parsed.value)
    } catch {
      // Unexpected kernel fault: report `internal` rather than killing the
      // connection (the closed vocabulary exists for exactly this case).
      result = { ok: false, code: 'internal' }
    }
    writeFrame(socket, toWire(result, /** @type {any} */ (parsed.value).reqId))
  }

  /**
   * Wire one accepted socket: framing, handshake state, cleanup.
   * @param {import('node:net').Socket} socket
   */
  function handleConnection(socket) {
    const connectionId = `c${++nextConnectionId}`
    clients.set(connectionId, socket)
    cancelIdle()
    broker.connect(connectionId)
    socket.setEncoding('utf8')
    const state = { connectionId, greeted: false, closing: false }
    let buffered = ''
    let cleaned = false

    function cleanup() {
      if (cleaned) return
      cleaned = true
      clients.delete(connectionId)
      try {
        broker.disconnect(connectionId)
      } catch {
        // The kernel is pure; a fault here must not keep the daemon alive.
      }
      scheduleIdle()
    }

    socket.on('data', (chunk) => {
      if (state.closing) return
      buffered += chunk
      let index = buffered.indexOf('\n')
      while (index >= 0) {
        const line = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        if (line.trim() !== '') handleLine(socket, state, line)
        if (state.closing) {
          buffered = ''
          return
        }
        index = buffered.indexOf('\n')
      }
    })
    socket.on('error', cleanup)
    socket.on('close', cleanup)
  }

  const server = createServer({ allowHalfOpen: false }, (socket) => handleConnection(socket))
  // One permanent error listener: while binding it rejects the listen promise;
  // afterwards it keeps a per-connection fault from crashing the daemon.
  server.on('error', (error) => {
    if (bindFailure === null) return
    const fail = bindFailure
    bindFailure = null
    fail(error)
  })

  /** @type {ReturnType<typeof setInterval> | null} */
  let sweepTimer = sweepMs > 0
    ? setInterval(() => {
        try {
          broker.sweep()
        } catch {
          // Memory reclamation is not a correctness source; never die for it.
        }
      }, sweepMs)
    : null

  /** @returns {Promise<void>} */
  function bind() {
    return new Promise((resolve, reject) => {
      bindFailure = reject
      server.listen({ path: socketPath }, () => {
        bindFailure = null
        resolve(undefined)
      })
    })
  }

  /**
   * POSIX leaves the socket file behind when the daemon dies. `EADDRINUSE` on a
   * path nobody listens on means exactly that, so probe it: a live peer is a
   * hard error (never silently take over an arbiter), a refused connect means
   * the file is stale and may be unlinked before a single retry.
   * @returns {Promise<void>}
   */
  function recoverStaleSocket() {
    return new Promise((resolve, reject) => {
      const probe = createConnection({ path: socketPath })
      let settled = false
      /** @param {() => void} finish */
      const once = (finish) => {
        if (settled) return
        settled = true
        try {
          probe.destroy()
        } catch {
          // Probe already gone.
        }
        finish()
      }
      probe.once('connect', () =>
        once(() => reject(new Error(`another lease broker is already listening on ${socketPath}`))),
      )
      probe.once('error', (error) => {
        const code = errorCode(error)
        if (code !== 'ECONNREFUSED' && code !== 'ENOENT') {
          once(() => reject(error))
          return
        }
        once(() => {
          try {
            unlinkSync(socketPath)
            resolve(undefined)
          } catch (unlinkError) {
            // `ENOENT` here means a concurrent instance cleaned up first.
            if (errorCode(unlinkError) === 'ENOENT') resolve(undefined)
            else reject(unlinkError)
          }
        })
      })
    })
  }

  try {
    await bind()
  } catch (error) {
    if (errorCode(error) !== 'EADDRINUSE') throw error
    await recoverStaleSocket()
    await bind()
  }

  // A broker nobody ever connects to is just as useless as one that lost its
  // last client: both idle out on the same clock.
  scheduleIdle()

  return { address: socketPath, close, send }
}
