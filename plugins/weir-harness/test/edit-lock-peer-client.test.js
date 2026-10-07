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
