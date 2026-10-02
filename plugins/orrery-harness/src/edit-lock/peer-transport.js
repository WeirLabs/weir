import { canonicalRequestData } from './request-data.js'

/** Attach ONLY an authenticated, host-owned byte stream. Never accepts public
 * sockets or chooses a session from message fields. Length-prefixed JSON, 8 MiB
 * maximum; transport loss revokes the fixed peer and never elects a publisher.
 * @param {import('node:stream').Duplex} stream
 * @param {{receive: (input: unknown) => Promise<unknown>, disconnect: () => Promise<unknown>}} peer */
export function serveEditLockPeer(stream, peer) {
  const maxBytes = 8 * 1024 * 1024
  let buffer = Buffer.alloc(0)
  let ended = false
  /** @type {Promise<unknown> | undefined} */
  let closing
  function close() {
    if (closing) return closing
    ended = true
    stream.pause()
    stream.destroy()
    const disconnecting = Promise.resolve(peer.disconnect())
    closing = disconnecting
    // Event callbacks cannot propagate an async rejection. Keep the original
    // rejected promise available to the owner, which MUST await close().
    void disconnecting.catch(() => {})
    return disconnecting
  }
  /** @param {unknown} response */
  function send(response) {
    if (ended) return
    const bytes = Buffer.from(canonicalRequestData(response))
    if (bytes.length > maxBytes || stream.writableLength + bytes.length + 4 > 2 * maxBytes) {
      close()
      return
    }
    const header = Buffer.alloc(4)
    header.writeUInt32BE(bytes.length)
    stream.write(Buffer.concat([header, bytes]), error => { if (error) close() })
  }
  /** @param {Buffer} chunk */
  function receive(chunk) {
    if (ended) return
    // Bound allocation before concatenation; a cooperating client sends one
    // bounded frame at a time. Oversized coalesced batches fail closed too.
    if (!Buffer.isBuffer(chunk) || buffer.length + chunk.length > maxBytes + 4) { close(); return }
    buffer = Buffer.concat([buffer, chunk])
    while (!ended && buffer.length >= 4) {
      const size = buffer.readUInt32BE(0)
      if (size === 0 || size > maxBytes) { close(); return }
      if (buffer.length < size + 4) return
      let request
      try { request = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(buffer.subarray(4, size + 4))) }
      catch { close(); return }
      buffer = buffer.subarray(size + 4)
      if (typeof request?.callId !== 'string' || request.callId.length > 512) { close(); return }
      const callId = request.callId
      void peer.receive(request).then(
        outcome => { try { send({callId, ok:true, outcome:outcome ?? null}) } catch { close() } },
        error => { try { send({callId, ok:false, error:String(error?.message ?? error).slice(0,4096)}) } catch { close() } },
      )
    }
  }
  stream.on('data', receive)
  stream.once('end', close)
  stream.once('error', close)
  stream.once('close', close)
  return Object.freeze({close,
    /** Server-initiated notice frame; carries text/counters, never authority.
     * @param {unknown} event */
    notify(event) { try { send({event}) } catch { close() } },
  })
}
