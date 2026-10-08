import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditLockPeer } from './peer.js'
import { serveEditLockPeer } from './peer-transport.js'
import { createEditLockPeerClient } from './peer-client.js'

/** Deterministic per-user endpoint for one canonical authority directory. On
 * POSIX hosts the OS temp directory is user-private and the endpoint is a
 * domain-socket file; on Windows it is a named pipe (a kernel object with no
 * filesystem node, so there is no stale-node sweep and no 100-byte path
 * budget — only the 256-char pipe-name limit) whose name carries no
 * backslashes beyond the \\.\pipe\ prefix (verified on Node v24). Any
 * same-user process that can reach the endpoint is inside the cooperative
 * trust boundary, not attested.
 * @param {string} directory @param {string} [platform] */
export function endpointFor(directory, platform = process.platform) {
  const authority = realpathSync.native(directory)
  const hash = createHash('sha256').update(authority).digest('hex').slice(0, 24)
  if (platform === 'win32') return `\\\\.\\pipe\\weir-edit-lock-${hash}`
  const path = join(tmpdir(), `weir-edit-lock-${hash}.sock`)
  if (Buffer.byteLength(path) > 100) throw new Error(`edit lock endpoint path too long: ${path}`)
  return path
}

/** True for Windows named-pipe endpoints: no filesystem node exists, so the
 * stale-socket sweep and the close-time unlink are POSIX-only concerns.
 * @param {string} endpoint */
const namedPipe = endpoint => endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('\\\\?\\pipe\\')

/** Channel-open arbitration for one endpoint (duplicate-binding recovery,
 * design D1/D2/D4). One sessionId has at most one registered channel at any
 * moment:
 *
 * - a prior binding whose socket is PROVEN dead (synchronous state bits only:
 *   `destroyed`, `closed` or `errored` — never an active probe) is reclaimed
 *   through the SAME disconnect path a processed EOF takes (revoke + forget;
 *   no lock is ever released), then the new open proceeds;
 * - a prior binding that is alive — or whose state is in any way unclear — is
 *   refused, fail-closed, and is never disconnected;
 * - with no prior channel binding, a refusal from `lifecycle.start` itself
 *   (a local agent or another mount generation holds the session) passes
 *   through untouched: a local binding can never be preempted from here.
 *
 * Opens of one sessionId are serialized through a per-session promise queue,
 * because the reclaim-check-register sequence awaits; different sessionIds
 * stay fully concurrent. Exported for the unit tests; production wiring is
 * the endpoint below. */
export function createChannelBindingArbitration() {
  /** @typedef {{destroyed?: boolean, closed?: boolean, errored?: unknown}} ChannelSocket */
  /** @typedef {{disconnect: () => Promise<unknown>}} ChannelPeer */
  /** @type {Map<string, {socket: ChannelSocket, peer: ChannelPeer}>} */
  const bound = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const opening = new Map()
  /** @param {string} sessionId
   * @param {ChannelSocket} socket the NEW connection's socket
   * @param {() => Promise<{peer: ChannelPeer}>} bind establish the channel
   * (create the peer and start the lifecycle); its result is returned verbatim
   * @returns {Promise<any>} */
  function open(sessionId, socket, bind) {
    const queued = opening.get(sessionId) ?? Promise.resolve()
    const run = queued.then(step, step)
    opening.set(sessionId, run)
    const settled = () => { if (opening.get(sessionId) === run) opening.delete(sessionId) }
    run.then(settled, settled)
    return run
    async function step() {
      const prior = bound.get(sessionId)
      if (prior) {
        const dead = prior.socket.destroyed === true || prior.socket.closed === true || prior.socket.errored != null
        if (!dead) throw new Error('session already bound')
        try { await prior.peer.disconnect() } catch {
          // Reclaim outcome unknown: stay fail-closed and KEEP the mapping, so
          // the next open retries the reclaim instead of wedging behind a
          // lifecycle-level refusal.
          throw new Error('session already bound')
        }
        if (bound.get(sessionId) === prior) bound.delete(sessionId)
      }
      const established = await bind()
      // Registered even when this socket already died during registration: the
      // transport's own close handling still revokes it, and the next open
      // reclaims the entry — a lost EOF can never wedge the session again.
      bound.set(sessionId, { socket, peer: established.peer })
      return established
    }
  }
  /** Index hygiene on transport close: drop the entry only while it still
   * names THIS connection's socket — a reclaimed binding must never be removed
   * by the late close of the dead socket it replaced. Revocation itself runs
   * on the transport's own disconnect path, not here.
   * @param {string} sessionId @param {ChannelSocket} socket */
  function release(sessionId, socket) {
    const prior = bound.get(sessionId)
    if (prior && prior.socket === socket) bound.delete(sessionId)
  }
  return Object.freeze({ open, release })
}

/** Publisher side: one session channel per connection. The first frame must be
 * `open {sessionId}`; the channel agent is fixed afterwards and EOF revokes it.
 * Call only while holding the publisher reservation (stale socket removal).
 * @param {ReturnType<typeof import('./lifecycle.js').createEditLockLifecycle>} lifecycle
 * @param {string} endpoint
 * @param {WeakMap<object, (event: unknown) => void>} sinks remote agent → notice sink */
export async function serveEditLockEndpoint(lifecycle, endpoint, sinks) {
  if (!namedPipe(endpoint)) {
    try {
      if (!lstatSync(endpoint).isSocket()) throw new Error(`unexpected node at edit lock endpoint ${endpoint}`)
      unlinkSync(endpoint)
    } catch (error) { if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error }
  }
  /** @type {Set<{close: () => Promise<unknown>}>} */
  const channels = new Set()
  let closed = false
  const arbitration = createChannelBindingArbitration()
  const server = createServer(socket => {
    if (closed) { socket.destroy(); return }
    /** @type {ReturnType<typeof createEditLockPeer> | undefined} */
    let inner
    /** @type {string | undefined} */
    let openedSessionId
    const router = {
      /** @param {any} message */
      async receive(message) {
        if (inner) return inner.receive(message)
        const sessionId = message?.request?.sessionId
        if (message?.kind !== 'open' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('channel must open a session first')
        openedSessionId = sessionId
        const opened = await arbitration.open(sessionId, socket, async () => {
          const agent = Object.freeze({ id: sessionId, remote: true })
          sinks.set(agent, event => transport.notify(event))
          inner = createEditLockPeer(lifecycle, agent)
          const state = await lifecycle.start(agent)
          return { peer: inner, state }
        })
        return { state: opened.state }
      },
      disconnect() { return inner ? inner.disconnect() : Promise.resolve() },
    }
    const transport = serveEditLockPeer(socket, router)
    channels.add(transport)
    socket.once('close', () => {
      channels.delete(transport)
      if (openedSessionId !== undefined) arbitration.release(openedSessionId, socket)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, () => { server.off('error', reject); resolve(undefined) })
  })
  return Object.freeze({
    /** Seal admission, then revoke every channel; await before lifecycle.close. */
    async close() {
      closed = true
      await new Promise(resolve => server.close(() => resolve(undefined)))
      const results = await Promise.allSettled([...channels].map(channel => channel.close()))
      if (!namedPipe(endpoint)) {
        try { unlinkSync(endpoint) } catch { /* already gone */ }
      }
      const errors = results.filter(result => result.status === 'rejected').map(result => /** @type {any} */ (result).reason)
      if (errors.length) throw new AggregateError(errors, 'edit lock endpoint revocation failed')
    },
  })
}

/** Client side for a host whose publisher reservation is held elsewhere. Each
 * agent gets its own session channel; a closed channel is never silently
 * replaced mid-call. Outcomes of interrupted calls are UNKNOWN by contract.
 * @param {string} endpoint
 * @param {{onNotice: (agent: object, event: any) => void, unreachableHint?: string}} hooks */
export function createRemoteEditLockDomain(endpoint, hooks) {
  /** @typedef {{client: ReturnType<typeof createEditLockPeerClient>, state: string, closed: boolean, ready: Promise<void>}} Channel */
  /** @type {WeakMap<object, Channel>} */
  const channels = new WeakMap()
  /** @type {Set<Channel>} */
  const all = new Set()
  const never = new AbortController().signal
  let closed = false
  /** Failure classes are split by WHERE the open failed, never by guessing at
   * message text (design D3): a transport that never came up — or an open
   * request that never got an answer — is an unreachable publisher and carries
   * the reservation hint; an open the publisher answered and refused is a live
   * publisher rejecting the binding, surfaced with its own guidance after the
   * duplicate-binding retry budget runs out. Only that answered refusal is
   * retried: the publisher may not yet have processed (or even seen) the
   * earlier channel's death. Never a call.
   * @param {any} agent @returns {Promise<Channel>} */
  async function channelFor(agent) {
    for (let attempt = 0; ; attempt++) {
      try { return await openChannel(agent) } catch (error) {
        if (/** @type {any} */ (error)?.answeredRefusal !== true) throw error
        if (/session already bound/.test(String(/** @type {any} */ (error)?.message)) && attempt < 20) {
          await new Promise(resolve => setTimeout(resolve, 50))
          continue
        }
        const reason = String(/** @type {any} */ (error)?.message ?? error)
        throw new Error(`edit lock duplicate session binding: session ${agent.id} is already active in the DeepSeek Harness window that publishes this project. Use the session in that window, close it there, or quit that Harness process. Do NOT remove the publisher reservation (.weir/.edit-lock.publisher-reservation) while that process is alive — the reservation belongs to it, and removing it would split the edit authority. (publisher answered: ${reason})`)
      }
    }
  }
  /** @param {any} agent @returns {Promise<Channel>} */
  async function openChannel(agent) {
    if (closed) throw new Error('edit lock client closed')
    const existing = channels.get(agent)
    if (existing && !existing.closed) { await existing.ready; return existing }
    const socket = createConnection(endpoint)
    /** @type {Channel} */
    const channel = /** @type {any} */ ({ state: 'starting', closed: false })
    channel.client = createEditLockPeerClient(socket, {
      onEvent: event => hooks.onNotice(agent, event),
      onClose: () => { channel.closed = true; channel.state = 'stopped'; all.delete(channel) },
    })
    channels.set(agent, channel)
    all.add(channel)
    /** The publisher genuinely did not answer. @param {unknown} cause */
    const unreachable = cause => new Error(`edit lock publisher unreachable at ${endpoint}: ${/** @type {any} */ (cause)?.message ?? cause}${hooks.unreachableHint ? `. ${hooks.unreachableHint}` : ''}`)
    channel.ready = (async () => {
      try {
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve)
          socket.once('error', reject)
        })
      } catch (error) {
        // The transport never came up: the publisher process is not answering.
        throw unreachable(error)
      }
      let opened
      try {
        opened = await channel.client.request('open', 'open', { sessionId: agent.id }, never)
      } catch (error) {
        const message = String(/** @type {any} */ (error)?.message ?? error)
        // No answer ever arrived — the channel died mid-open or the request
        // was never dispatched: the same failure class as a connect error.
        if (message.startsWith('edit publication outcome UNKNOWN:') || message.startsWith('edit peer unavailable')) throw unreachable(error)
        // The publisher answered and refused the open. channelFor owns the
        // retry budget and the final message for answered refusals.
        throw Object.assign(error instanceof Error ? error : new Error(message), { answeredRefusal: true })
      }
      if (!channel.closed) channel.state = opened.state
    })()
    try { await channel.ready } catch (error) {
      channel.client.close()
      throw error
    }
    return channel
  }
  /** @param {object} agent @param {string} kind @param {unknown} [request] @param {AbortSignal} [signal] @param {string} [callId] */
  async function call(agent, kind, request, signal, callId) {
    const channel = await channelFor(agent)
    return channel.client.request(kind, callId ?? `${kind}:${randomUUID()}`, request ?? {}, signal ?? never)
  }
  return Object.freeze({
    channelFor,
    call,
    /** @param {object} agent */
    state(agent) { const channel = channels.get(agent); return channel && !channel.closed ? channel.state : 'stopped' },
    /** @param {object} agent @param {string} state */
    setState(agent, state) { const channel = channels.get(agent); if (channel && !channel.closed) channel.state = state },
    /** Conservative local revocation: the publisher revokes on EOF.
     * @param {object} agent */
    drop(agent) { channels.get(agent)?.client.close() },
    close() { closed = true; for (const channel of [...all]) channel.client.close() },
  })
}
