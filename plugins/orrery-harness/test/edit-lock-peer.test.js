import test from 'node:test'
import assert from 'node:assert/strict'
import { createEditLockPeer } from '../src/edit-lock/peer.js'

test('peer fixes agent identity and seals admission on disconnect before acknowledgement', async () => {
  const agent = {}
  let stopped = false
  let finish
  const ack = new Promise(resolve => {finish = resolve})
  const lifecycle = {service:{publish:async exec => {assert.equal(exec.agent,agent); return 'ok'}},stop: value => {assert.equal(value,agent); stopped = true; return ack}}
  const peer = createEditLockPeer(lifecycle,agent)
  await assert.rejects(peer.receive({kind:'publish',callId:'c',request:{},agent:'forged'}), /invalid/)
  assert.equal(await peer.receive({kind:'publish',callId:'c',request:{}}),'ok')
  const closing = peer.disconnect()
  assert.equal(stopped,true)
  await assert.rejects(peer.receive({kind:'publish',callId:'d',request:{}}), /disconnected/)
  assert.equal(peer.disconnect(),closing)
  finish()
  await closing
})
