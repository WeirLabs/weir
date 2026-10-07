import { canonicalRequestData } from './request-data.js'
import { PEER_KINDS } from './peer.js'

/** Client for a pre-authenticated, single-session host channel. A disconnect or
 * abort rejects with UNKNOWN, not not-published; never retry under a new callId.
 * @param {import('node:stream').Duplex} stream
 * @param {{onEvent?: (event: any) => void, onClose?: () => void}} [hooks] */
export function createEditLockPeerClient(stream, hooks = {}) {
  const maxBytes = 8 * 1024 * 1024
  /** @type {Map<string, {resolve:(value:any)=>void, reject:(error:Error)=>void, cleanup:()=>void}>} */
  const pending = new Map()
  let buffer = Buffer.alloc(0)
  let closed = false
  function close() {
    if (closed) return
    closed = true
    stream.destroy()
    for (const entry of pending.values()) {
      entry.cleanup()
      entry.reject(new Error('edit publication outcome UNKNOWN: channel closed; inspect original call history'))
    }
    pending.clear()
    try { hooks.onClose?.() } catch { /* observer failure cannot reopen */ }
  }
  /** @param {Buffer} chunk */
  function receive(chunk) {
    if (closed) return
    if (!Buffer.isBuffer(chunk) || buffer.length + chunk.length > maxBytes + 4) { close(); return }
    buffer = Buffer.concat([buffer, chunk])
    while (!closed && buffer.length >= 4) {
      const size = buffer.readUInt32BE(0)
      if (size === 0 || size > maxBytes) { close(); return }
      if (buffer.length < size + 4) return
      let message
      try { message = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(buffer.subarray(4,size+4))) }
      catch { close(); return }
      buffer = buffer.subarray(size+4)
      if (message && typeof message === 'object' && Object.keys(message).join(',') === 'event') {
        try { hooks.onEvent?.(message.event) } catch { /* notices never imply consent */ }
        continue
      }
      if (!message || typeof message.callId !== 'string' || typeof message.ok !== 'boolean'
        || Object.keys(message).sort().join(',') !== (message.ok ? 'callId,ok,outcome' : 'callId,error,ok')
        || (!message.ok && typeof message.error !== 'string')) { close(); return }
      const entry = pending.get(message.callId)
      if (!entry) { close(); return }
      pending.delete(message.callId)
      entry.cleanup()
      if (message.ok) entry.resolve(message.outcome)
      else entry.reject(new Error(message.error))
    }
  }
  stream.on('data', receive)
  stream.once('end', close)
  stream.once('error', close)
  stream.once('close', close)
  return Object.freeze({
    /** Cancellation closes the entire session channel (conservative revocation).
     * Local rejection is NOT a manager revocation acknowledgment.
     * @param {string} kind @param {string} callId @param {unknown} request @param {AbortSignal} signal */
    request(kind, callId, request, signal) {
      if (closed || signal.aborted) return Promise.reject(new Error('edit peer unavailable before dispatch'))
      if (!(kind === 'open' || PEER_KINDS.includes(kind)) || typeof callId !== 'string' || !callId.trim() || callId.length > 512) return Promise.reject(new Error('invalid edit peer call'))
      if (pending.has(callId) || pending.size >= 32) return Promise.reject(new Error('edit peer call admission rejected'))
      const bytes = Buffer.from(canonicalRequestData({kind,callId,request}))
      if (bytes.length > maxBytes || stream.writableLength + bytes.length + 4 > 2*maxBytes) return Promise.reject(new Error('edit peer frame admission rejected'))
      const header = Buffer.alloc(4)
      header.writeUInt32BE(bytes.length)
      return new Promise((resolve,reject) => {
        pending.set(callId, {resolve,reject,cleanup:() => signal.removeEventListener('abort',close)})
        signal.addEventListener('abort',close,{once:true})
        if (signal.aborted) { close(); return }
        try { stream.write(Buffer.concat([header,bytes]), error => {if (error) close()}) }
        catch { close() }
      })
    },
    close,
  })
}
