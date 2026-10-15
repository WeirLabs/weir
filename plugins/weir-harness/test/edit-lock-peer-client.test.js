import test from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { createEditLockPeerClient } from '../src/edit-lock/peer-client.js'
import { serveEditLockPeer } from '../src/edit-lock/peer-transport.js'

test('framed client receives outcome and abort never invents not-published', async () => {
  let left, right
  left = new Duplex({read() {},write(bytes,_encoding,done) {right.push(bytes); done()}})
  right = new Duplex({read() {},write(bytes,_encoding,done) {left.push(bytes); done()}})
  let revoke = 0
  const server = serveEditLockPeer(right,{receive:async request => request.callId === 'done' ? {kind:'created'} : new Promise(() => {}),disconnect:async () => {revoke++}})
  const client = createEditLockPeerClient(left)
  assert.deepEqual(await client.request('publish','done',{},new AbortController().signal),{kind:'created'})
  const abort = new AbortController()
  const pending = client.request('publish','uncertain',{},abort.signal)
  abort.abort()
  await assert.rejects(pending,/UNKNOWN/)
  await assert.rejects(client.request('publish','retry',{},new AbortController().signal),/unavailable/)
  await server.close()
  assert.equal(revoke,1)
})

// Ported pins from the deleted phantom remote-service.js (change
// edit-lock-deepening, task 4.1): its two unique behavior pins — per-channel
// authorization (one channel serves exactly its own bound call namespace; a
// foreign frame is never answered on it) and absolute sealing after close —
// mapped onto the real production client surface (the publisher side's fixed
// per-channel agent identity is pinned in edit-lock-peer.test.js).

test('a frame for a foreign callId closes the channel rather than answering across it', async () => {
  let left, right
  left = new Duplex({read() {},write(bytes,_encoding,done) {right.push(bytes); done()}})
  right = new Duplex({read() {},write(bytes,_encoding,done) {left.push(bytes); done()}})
  let revoke = 0
  const server = serveEditLockPeer(right,{receive:async () => new Promise(() => {}),disconnect:async () => {revoke++}})
  const client = createEditLockPeerClient(left)
  const pending = client.request('publish','mine',{},new AbortController().signal)
  // A response naming a callId this channel never issued: cross-channel
  // pollution fails closed — the channel dies, the genuine call goes UNKNOWN,
  // and nothing is admitted afterwards.
  const payload = Buffer.from('{"callId":"foreign","ok":true,"outcome":null}')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length)
  left.push(Buffer.concat([header, payload]))
  await assert.rejects(pending,/UNKNOWN/)
  await assert.rejects(client.request('publish','after',{},new AbortController().signal),/unavailable/)
  await server.close()
  assert.equal(revoke,1)
})

test('close seals the client absolutely: requests refuse, no bytes leave, close is idempotent', async () => {
  let left, right
  const written = []
  left = new Duplex({read() {},write(bytes,_encoding,done) {written.push(bytes); right.push(bytes); done()}})
  right = new Duplex({read() {},write(bytes,_encoding,done) {left.push(bytes); done()}})
  const server = serveEditLockPeer(right,{receive:async request => request.callId,disconnect:async () => {}})
  let closes = 0
  const client = createEditLockPeerClient(left, { onClose: () => { closes++ } })
  assert.equal(await client.request('locks','live',{},new AbortController().signal),'live')
  const seen = written.length
  client.close()
  client.close()
  await assert.rejects(client.request('publish','sealed',{},new AbortController().signal),/unavailable/)
  assert.equal(written.length,seen) // not one byte after close
  assert.equal(closes,1)
  await server.close()
})
