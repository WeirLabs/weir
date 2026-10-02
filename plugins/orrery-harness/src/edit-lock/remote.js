import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditLockPeer } from './peer.js'
import { serveEditLockPeer } from './peer-transport.js'
import { createEditLockPeerClient } from './peer-client.js'

/** Deterministic per-user endpoint for one canonical authority directory. The
 * OS temp directory is user-private on supported hosts; any same-user process
 * that can reach it is inside the cooperative trust boundary, not attested.
 * @param {string} directory */
export function endpointFor(directory) {
  const authority = realpathSync.native(directory)
  const path = join(tmpdir(), `orrery-edit-lock-${createHash('sha256').update(authority).digest('hex').slice(0, 24)}.sock`)
  if (Buffer.byteLength(path) > 100) throw new Error(`edit lock endpoint path too long: ${path}`)
  return path
}

/** Publisher side: one session channel per connection. The first frame must be
 * `open {sessionId}`; the channel agent is fixed afterwards and EOF revokes it.
 * Call only while holding the publisher reservation (stale socket removal).
 * @param {ReturnType<typeof import('./lifecycle.js').createEditLockLifecycle>} lifecycle
 * @param {string} endpoint
 * @param {WeakMap<object, (event: unknown) => void>} sinks remote agent → notice sink */
export async function serveEditLockEndpoint(lifecycle, endpoint, sinks) {
  try {
    if (!lstatSync(endpoint).isSocket()) throw new Error(`unexpected node at edit lock endpoint ${endpoint}`)
    unlinkSync(endpoint)
  } catch (error) { if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error }
  /** @type {Set<{close: () => Promise<unknown>}>} */
  const channels = new Set()
  let closed = false
  const server = createServer(socket => {
    if (closed) { socket.destroy(); return }
    /** @type {ReturnType<typeof createEditLockPeer> | undefined} */
    let inner
    const router = {
      /** @param {any} message */
      async receive(message) {
        if (inner) return inner.receive(message)
        const sessionId = message?.request?.sessionId
        if (message?.kind !== 'open' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('channel must open a session first')
        const agent = Object.freeze({ id: sessionId, remote: true })
        sinks.set(agent, event => transport.notify(event))
        inner = createEditLockPeer(lifecycle, agent)
        return { state: await lifecycle.start(agent) }
      },
      disconnect() { return inner ? inner.disconnect() : Promise.resolve() },
    }
    const transport = serveEditLockPeer(socket, router)
    channels.add(transport)
    socket.once('close', () => channels.delete(transport))
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
      try { unlinkSync(endpoint) } catch { /* already gone */ }
      const errors = results.filter(result => result.status === 'rejected').map(result => /** @type {any} */ (result).reason)
      if (errors.length) throw new AggregateError(errors, 'edit lock endpoint revocation failed')
    },
  })
}

/** Client side for a host whose publisher reservation is held elsewhere. Each
 * agent gets its own session channel; a closed channel is never silently
 * replaced mid-call. Outcomes of interrupted calls are UNKNOWN by contract.
 * @param {string} endpoint
 * @param {{onNotice: (agent: object, event: any) => void}} hooks */
export function createRemoteEditLockDomain(endpoint, hooks) {
  /** @typedef {{client: ReturnType<typeof createEditLockPeerClient>, state: string, closed: boolean, ready: Promise<void>}} Channel */
  /** @type {WeakMap<object, Channel>} */
  const channels = new WeakMap()
  /** @type {Set<Channel>} */
  const all = new Set()
  const never = new AbortController().signal
  let closed = false
  /** The publisher may not yet have processed an earlier channel's EOF; only
   * channel establishment is retried, never a call.
   * @param {any} agent @returns {Promise<Channel>} */
  async function channelFor(agent) {
    for (let attempt = 0; ; attempt++) {
      try { return await openChannel(agent) } catch (error) {
        if (attempt >= 20 || !/session already bound/.test(String(/** @type {any} */ (error)?.message))) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
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
    channel.ready = (async () => {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      const opened = await channel.client.request('open', 'open', { sessionId: agent.id }, never)
      if (!channel.closed) channel.state = opened.state
    })()
    try { await channel.ready } catch (error) {
      channel.client.close()
      throw new Error(`edit lock publisher unreachable at ${endpoint}: ${/** @type {any} */ (error)?.message ?? error}`)
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
