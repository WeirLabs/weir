import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from './helpers.js'
import { defaultSocketPath } from '../src/lease-broker/server.js'

// End-to-end transport tests: a REAL `weir-editlockd` process on a REAL socket.
//
// Everything here exercises the parts a kernel test cannot: framing, the
// handshake gate, per-connection identity, disconnect-equals-release, event
// delivery to the right connection, and the two process-lifetime rules (idle
// self-exit, and never exit while a client is connected). Each daemon gets its
// own temporary socket, its own idle window and its own process.

const ENTRY = fileURLToPath(new URL('../src/lease-broker/entry.js', import.meta.url))
const SCOPE = '/work/project'
const OWNER_A = Object.freeze({ id: 'lineage-a', session: 'sess-a', label: 'A' })
const OWNER_B = Object.freeze({ id: 'lineage-b', session: 'sess-b', label: 'B' })

/** @param {string} name */
function P(name) {
  return `${SCOPE}/${name}`
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Await one promise with a deadline so a hung daemon fails the test instead of
 * hanging the suite.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, label) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {() => Promise<boolean>} predicate
 * @param {string} label
 * @param {number} [ms]
 */
async function waitFor(predicate, label, ms = 4_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Spawn the daemon and wait until it reports its listening line.
 * @param {{ after: (fn: () => void) => void }} t node:test context (cleanup hook)
 * @param {{ idleMs?: number, sweepMs?: number, env?: Record<string, string>, dir?: string, socketPath?: string }} [options]
 */
function startDaemon(t, { idleMs = 5_000, sweepMs = 100, env = {}, dir: givenDir, socketPath: givenSocket } = {}) {
  const owned = givenDir === undefined && givenSocket === undefined
  const dir = givenDir ?? (givenSocket === undefined ? mkdtempSync(join(tmpdir(), 'weir-lease-broker-')) : dirname(givenSocket))
  const socketPath = givenSocket ?? join(dir, 'broker.sock')
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      WEIR_EDITLOCKD_SOCKET: socketPath,
      WEIR_EDITLOCKD_IDLE_MS: String(idleMs),
      WEIR_EDITLOCKD_SWEEP_MS: String(sweepMs),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon never reported listening; stderr: ${stderr}`)), 8_000)
    child.stderr.on('data', () => {
      if (!stderr.includes(' listening on ')) return
      clearTimeout(timer)
      resolve(undefined)
    })
    void exited.then(({ code, signal }) => {
      clearTimeout(timer)
      reject(new Error(`daemon exited before listening (code=${code}, signal=${signal}); stderr: ${stderr}`))
    })
  })
  t.after(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    if (owned) rmSync(dir, { recursive: true, force: true })
  })
  return { child, socketPath, dir, ready, exited, stderr: () => stderr }
}

/**
 * Minimal newline-JSON client: replies, unsolicited events, raw writes.
 * @param {string} socketPath
 */
function createClient(socketPath) {
  const socket = connect({ path: socketPath })
  socket.setEncoding('utf8')
  /** @type {any[]} */
  const replies = []
  /** @type {any[]} */
  const events = []
  /** @type {{ resolve: (frame: any) => void, reject: (error: Error) => void }[]} */
  const waiters = []
  let buffered = ''
  let closeError = null
  const closed = new Promise((resolve) => {
    socket.on('close', () => {
      closeError = new Error('connection closed')
      for (const waiter of waiters.splice(0)) waiter.reject(closeError)
      resolve(undefined)
    })
  })
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buffered += chunk
    let index = buffered.indexOf('\n')
    while (index >= 0) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      if (line.trim() !== '') {
        const frame = JSON.parse(line)
        if (frame.event) events.push(frame)
        else {
          const waiter = waiters.shift()
          if (waiter) waiter.resolve(frame)
          else replies.push(frame)
        }
      }
      index = buffered.indexOf('\n')
    }
  })
  /** @param {number} [ms] */
  function nextReply(ms = 4_000) {
    const queued = replies.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (closeError) return Promise.reject(closeError)
    return new Promise((resolve, reject) => {
      /** @type {{ resolve: (frame: any) => void, reject: (error: Error) => void }} */
      const entry = {
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      const timer = setTimeout(() => {
        const at = waiters.indexOf(entry)
        if (at >= 0) waiters.splice(at, 1)
        reject(new Error('timed out waiting for a reply'))
      }, ms)
      waiters.push(entry)
    })
  }
  /** @param {any} frame */
  async function request(frame, ms) {
    const reply = nextReply(ms)
    socket.write(`${JSON.stringify(frame)}\n`)
    return await reply
  }
  /** @param {string} line */
  async function sendRaw(line, ms) {
    const reply = nextReply(ms)
    socket.write(line)
    return await reply
  }
  /** @param {(frame: any) => boolean} match */
  async function nextEvent(match, ms = 4_000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const index = events.findIndex(match)
      if (index >= 0) return events.splice(index, 1)[0]
      await delay(10)
    }
    throw new Error('timed out waiting for an event')
  }
  return {
    events,
    request,
    sendRaw,
    nextEvent,
    nextReply,
    close() {
      socket.end()
      return closed
    },
    closed,
  }
}

/**
 * Connect and greet.
 * @param {{ after: (fn: () => void) => void }} t
 * @param {string} socketPath
 * @param {string} [reqId]
 */
async function greet(t, socketPath, reqId = 'hello-1') {
  const client = createClient(socketPath)
  t.after(() => {
    void client.close()
  })
  const hello = await client.request({ op: 'hello', protocol: 1, reqId })
  expect(hello.ok, `handshake failed: ${JSON.stringify(hello)}`).toBe(true)
  return client
}

describe('lease broker endpoint address', () => {
  it('names the per-user socket after the protocol major on POSIX', () => {
    const path = defaultSocketPath({ platform: 'darwin', protocol: 3, tmpdir: '/var/folders/tmp', uid: 501 })
    expect(path).toBe('/var/folders/tmp/weir-editlockd-501-v3.sock')
    // A different major means a different endpoint: majors never arbitrate
    // against each other.
    expect(defaultSocketPath({ platform: 'linux', protocol: 1, tmpdir: '/tmp', uid: 501 })).toBe('/tmp/weir-editlockd-501-v1.sock')
  })

  it('folds the home directory hash into the win32 pipe name', () => {
    const path = defaultSocketPath({ platform: 'win32', protocol: 1, homedir: 'C:\\Users\\ada' })
    const digest = createHash('sha256').update('C:\\Users\\ada').digest('hex').slice(0, 12)
    expect(path).toBe(`\\\\.\\pipe\\weir-editlockd-${digest}-v1`)
    expect(path).not.toContain('C:\\Users')
  })
})

describe('lease broker server: request/response over a real socket', () => {
  it('handshakes, acquires, reports, releases, and echoes reqId', async (t) => {
    const daemon = startDaemon(t)
    await daemon.ready
    const client = await greet(t, daemon.socketPath, 'h-1')

    const hello = await client.request({ op: 'hello', protocol: 1, reqId: 'h-2' })
    // A second handshake on the same connection is a malformed frame.
    expect(hello.ok).toBe(false)
    expect(hello.error.code).toBe('bad-request')

    const acquired = await client.request({
      op: 'acquire',
      reqId: 'a-1',
      owner: OWNER_A,
      scope: SCOPE,
      paths: [P('b'), P('a')],
    })
    expect(acquired.ok).toBe(true)
    expect(acquired.reqId).toBe('a-1')
    expect(acquired.granted.map((lease) => lease.path)).toEqual([P('a'), P('b')])

    const status = await client.request({ op: 'status', reqId: 's-1' })
    expect(status.ok).toBe(true)
    expect(status.reqId).toBe('s-1')
    expect(status.leases.map((lease) => lease.path)).toEqual([P('a'), P('b')])

    const released = await client.request({ op: 'release', reqId: 'r-1', owner: OWNER_A, paths: [P('a'), P('b')] })
    expect(released.released).toEqual([P('a'), P('b')])
    expect(released.notOwned).toEqual([])

    // A frame without `reqId` gets a reply without one.
    const after = await client.request({ op: 'status' })
    expect(after.leases).toEqual([])
    expect(after.reqId).toBeUndefined()
  })

  it('carries the handshake result and rejects a bad first frame', async (t) => {
    const daemon = startDaemon(t)
    await daemon.ready
    const client = createClient(daemon.socketPath)
    t.after(() => {
      void client.close()
    })

    // The first frame must be hello — anything else is refused, connection intact.
    const refused = await client.request({ op: 'status', reqId: 'early-1' })
    expect(refused.ok).toBe(false)
    expect(refused.error.code).toBe('bad-request')
    expect(refused.reqId).toBe('early-1')

    const malformed = await client.sendRaw('{not json}\n')
    expect(malformed.ok).toBe(false)
    expect(malformed.error.code).toBe('bad-request')

    const hello = await client.request({ op: 'hello', protocol: 1 })
    expect(hello.ok).toBe(true)
    expect(hello.protocol).toBe(1)
    expect(hello.startedAt).toBeGreaterThan(0)
    // The reported version is this package's manifest version, and the startup
    // line on stderr names both the version and the endpoint.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(hello.daemonVersion).toBe(manifest.version)
    expect(daemon.stderr()).toContain(`weir-editlockd ${manifest.version} listening on ${daemon.socketPath}`)

    // Field discipline: one extra field is a bad request, not a tolerated extra.
    const extra = await client.request({ op: 'status', bogus: true })
    expect(extra.ok).toBe(false)
    expect(extra.error.code).toBe('bad-request')

    const relative = await client.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: ['relative.txt'] })
    expect(relative.ok).toBe(false)
    expect(relative.error.code).toBe('invalid-path')
  })

  it('refuses a different protocol major and closes the connection', async (t) => {
    const daemon = startDaemon(t)
    await daemon.ready
    const client = createClient(daemon.socketPath)
    t.after(() => {
      void client.close()
    })
    const mismatch = await client.request({ op: 'hello', protocol: 99, reqId: 'h-99' })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.error.code).toBe('protocol-mismatch')
    expect(mismatch.error.supported).toEqual([1])
    await withTimeout(client.closed, 4_000, 'connection closed after protocol mismatch')
    expect(daemon.child.exitCode).toBeNull()
  })
})

describe('lease broker server: connection ownership', () => {
  it('releases every lease when the holding connection goes away', async (t) => {
    const daemon = startDaemon(t)
    await daemon.ready
    const holder = await greet(t, daemon.socketPath)
    const observer = await greet(t, daemon.socketPath)

    const acquired = await holder.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a'), P('b')] })
    expect(acquired.ok).toBe(true)
    expect((await observer.request({ op: 'status' })).leases).toHaveLength(2)

    await holder.close()
    // No expiry wait: the table is empty as soon as the close is processed.
    await waitFor(async () => (await observer.request({ op: 'status' })).leases.length === 0, 'lease release on disconnect')

    const reacquired = await observer.request({ op: 'acquire', owner: OWNER_B, scope: SCOPE, paths: [P('a')] })
    expect(reacquired.ok).toBe(true)
  })

  it('refuses a second connection using the same owner identifier', async (t) => {
    const daemon = startDaemon(t)
    await daemon.ready
    const first = await greet(t, daemon.socketPath)
    const second = await greet(t, daemon.socketPath)
    expect((await first.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })).ok).toBe(true)
    const blocked = await second.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    expect(blocked.ok).toBe(false)
    expect(blocked.error.code).toBe('held')
    expect(blocked.error.conflicts[0].holder).toEqual({ ...OWNER_A })
  })

  it('delivers negotiation events to the right connection and transfers ownership', async (t) => {
    const daemon = startDaemon(t)
    await daemon.ready
    const alice = await greet(t, daemon.socketPath)
    const bob = await greet(t, daemon.socketPath)

    expect((await alice.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })).ok).toBe(true)
    const pending = await bob.request({ op: 'request', from: OWNER_B, path: P('a') })
    expect(pending.ok).toBe(true)
    expect(pending.state).toBe('pending')
    expect(pending.holder.id).toBe('lineage-a')

    // `request` goes to the holder connection only.
    const requestEvent = await alice.nextEvent((frame) => frame.event === 'request')
    expect(requestEvent.requestId).toBe(pending.requestId)
    expect(requestEvent.path).toBe(P('a'))
    expect(requestEvent.from).toEqual({ ...OWNER_B })
    expect(alice.events).toHaveLength(0)

    const reply = await alice.request({ op: 'reply', owner: OWNER_A, requestId: pending.requestId, decision: 'release' })
    expect(reply.ok).toBe(true)
    expect(reply.state).toBe('transferred')

    // `settled` goes to the requester connection only.
    const settled = await bob.nextEvent((frame) => frame.event === 'settled')
    expect(settled.requestId).toBe(pending.requestId)
    expect(settled.state).toBe('transferred')

    // Ownership moved with the connection: Bob can release it, Alice cannot.
    expect((await bob.request({ op: 'release', owner: OWNER_B, paths: [P('a')] })).released).toEqual([P('a')])
    expect((await alice.request({ op: 'release', owner: OWNER_A, paths: [P('a')] })).notOwned).toEqual([P('a')])
  })
})

describe('lease broker server: release facts', () => {
  it('advertises the supported push events in the handshake, inside major 1', async (t) => {
    const daemon = startDaemon(t)
    await daemon.ready
    const client = createClient(daemon.socketPath)
    t.after(() => {
      void client.close()
    })
    const hello = await client.request({ op: 'hello', protocol: 1, reqId: 'h-1' })
    expect(hello.ok).toBe(true)
    expect(hello.protocol).toBe(1)
    // The advertisement is the only way a client learns the capability, and an
    // older client that does not read it keeps every pre-existing operation.
    expect(hello.events).toEqual(['request', 'settled', 'released'])
  })

  it('broadcasts one released event per removed lease to every connected client', async (t) => {
    const daemon = startDaemon(t)
    await daemon.ready
    const holder = await greet(t, daemon.socketPath, 'h-holder')
    const watcher = await greet(t, daemon.socketPath, 'h-watcher')
    const bystander = await greet(t, daemon.socketPath, 'h-bystander')

    expect((await holder.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a'), P('b')] })).ok).toBe(true)
    const released = await holder.request({ op: 'release', reqId: 'r-1', owner: OWNER_A, paths: [P('a'), P('b')] })
    expect(released.released).toEqual([P('a'), P('b')])

    for (const client of [holder, watcher, bystander]) {
      const first = await client.nextEvent((frame) => frame.event === 'released')
      const second = await client.nextEvent((frame) => frame.event === 'released')
      expect(first).toEqual({ event: 'released', path: P('a'), reason: 'released' })
      expect(second).toEqual({ event: 'released', path: P('b'), reason: 'released' })
    }
  })

  it('broadcasts disconnected when a holder connection closes, and nothing for an atomic transfer', async (t) => {
    const daemon = startDaemon(t)
    await daemon.ready
    const alice = await greet(t, daemon.socketPath)
    const bob = await greet(t, daemon.socketPath)

    expect((await alice.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a'), P('b')] })).ok).toBe(true)

    // Atomic transfer first: ownership moves inside one verdict, so the path is
    // never unowned and no release fact is broadcast.
    const pending = await bob.request({ op: 'request', from: OWNER_B, path: P('a') })
    await alice.request({ op: 'reply', owner: OWNER_A, requestId: pending.requestId, decision: 'release' })
    expect((await bob.request({ op: 'status' })).leases.map((lease) => lease.path)).toEqual([P('a'), P('b')])

    await alice.close()
    await waitFor(async () => (await bob.request({ op: 'status' })).leases.map((lease) => lease.path).join(',') === P('a'), 'holding connection leaves the table')

    // Only P('b') was still Alice's: the transferred P('a') produced nothing.
    const event = await bob.nextEvent((frame) => frame.event === 'released')
    expect(event).toEqual({ event: 'released', path: P('b'), reason: 'disconnected' })
    expect(bob.events.filter((frame) => frame.event === 'released')).toEqual([])
  })
})

describe('lease broker server: process lifetime', () => {
  it('exits on its own after the idle window with no client', async (t) => {
    const daemon = startDaemon(t, { idleMs: 250 })
    await daemon.ready
    const client = await greet(t, daemon.socketPath)
    expect((await client.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })).ok).toBe(true)
    await client.close()
    const { code } = await withTimeout(daemon.exited, 8_000, 'idle self-exit')
    expect(code).toBe(0)
  })

  it('never exits while a client is connected, and keeps its leases', async (t) => {
    const daemon = startDaemon(t, { idleMs: 250 })
    await daemon.ready
    const client = await greet(t, daemon.socketPath)
    expect((await client.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })).ok).toBe(true)

    // Several idle windows pass; the connection is the only thing keeping it up.
    await delay(900)
    expect(daemon.child.exitCode).toBeNull()
    expect((await client.request({ op: 'status' })).leases).toHaveLength(1)

    await client.close()
    const { code } = await withTimeout(daemon.exited, 8_000, 'exit after the last client left')
    expect(code).toBe(0)
  })

  it('shuts down on SIGTERM with exit code 0', async (t) => {
    // The idle window is far away: the exit can only come from the signal.
    const daemon = startDaemon(t, { idleMs: 60_000 })
    await daemon.ready
    const client = await greet(t, daemon.socketPath)
    expect((await client.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })).ok).toBe(true)

    daemon.child.kill('SIGTERM')
    const { code, signal } = await withTimeout(daemon.exited, 8_000, 'SIGTERM shutdown')
    expect(code).toBe(0)
    expect(signal).toBeNull()
    // Shutdown drops the clients rather than leaving half-open sockets behind.
    await withTimeout(client.closed, 4_000, 'client connection closed on shutdown')
  })

  it('reclaims the socket file left behind by a killed daemon', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'weir-lease-broker-stale-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const socketPath = join(dir, 'broker.sock')

    const first = startDaemon(t, { socketPath, idleMs: 5_000 })
    await first.ready
    const client = await greet(t, first.socketPath)
    await client.request({ op: 'acquire', owner: OWNER_A, scope: SCOPE, paths: [P('a')] })
    first.child.kill('SIGKILL')
    await withTimeout(first.exited, 4_000, 'first daemon killed')
    // SIGKILL leaves the socket file: this is exactly the POSIX case the
    // EADDRINUSE → refused-connect → unlink → retry path exists for.
    expect(existsSync(socketPath)).toBe(true)

    const second = startDaemon(t, { socketPath, idleMs: 5_000 })
    await second.ready
    const fresh = createClient(socketPath)
    t.after(() => {
      void fresh.close()
    })
    const hello = await fresh.request({ op: 'hello', protocol: 1 })
    expect(hello.ok).toBe(true)
    // A fresh daemon means an empty table: the kill was equivalent to all
    // leases expiring at once.
    expect((await fresh.request({ op: 'status' })).leases).toEqual([])
  })
})
