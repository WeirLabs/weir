import test from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { serveEditLockPeer } from '../src/edit-lock/peer-transport.js'

test('transport rejects oversized frames before parsing and revokes once', async () => {
  let revocations = 0
  let calls = 0
  const stream = new Duplex({read() {}, write(_chunk,_encoding,done) {done()}})
  const server = serveEditLockPeer(stream, {receive:async () => {calls++},disconnect:async () => {revocations++}})
  const header = Buffer.alloc(4)
  header.writeUInt32BE(8 * 1024 * 1024 + 1)
  stream.emit('data', header)
  await server.close()
  assert.equal(calls,0)
  assert.equal(revocations,1)
  assert.equal(stream.destroyed,true)
})
