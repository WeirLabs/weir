import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, createConnection } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerBindingRuntime, bindingRuntime, createBindingAttester } from '../src/edit-lock/binding-attestation.js'
import { createChannelBindingArbitration, createRemoteEditLockDomain, serveEditLockEndpoint } from '../src/edit-lock/remote.js'
import { serveEditLockPeer } from '../src/edit-lock/peer-transport.js'
import { createEditLockPeerClient } from '../src/edit-lock/peer-client.js'
import { createEditLockPeer } from '../src/edit-lock/peer.js'

const socket = () => ({ destroyed: false, closed: false })
const bind = () => Promise.resolve({ peer: { disconnect: async () => {} } })

test('registry identities, duplicate rejection, pruning and unknown evidence', () => {
  const nonce = randomUUID(), agent = {}, replacement = {}
  let serving = agent
  const remove = registerBindingRuntime(nonce, agent, 's')
  try {
    assert.equal(bindingRuntime(nonce).agent, agent)
    assert.throws(() => registerBindingRuntime(nonce, replacement, 's'), /duplicate/)
    const attest = createBindingAttester(() => serving)
    assert.equal(attest('s', nonce), 'serving')
    assert.equal(attest('other', nonce), 'unknown')
    serving = replacement
    assert.equal(attest('s', nonce), 'stale')
    serving = undefined
    assert.equal(attest('s', nonce), 'stale')
    assert.equal(createBindingAttester(() => { throw Error('unavailable') })('s', nonce), 'unknown')
  } finally { remove() }
  remove()
  assert.equal(bindingRuntime(nonce), undefined)
  assert.equal(createBindingAttester(() => undefined)('s', nonce), 'unknown')
})

for (const [name, verdict, token, reclaim, calls] of [
  ['serving', 'serving', { nonce: 'n', pid: process.pid }, false, 1],
  ['superseded', 'stale', { nonce: 'n', pid: process.pid }, true, 1],
  ['orphaned', 'stale', { nonce: 'n', pid: process.pid }, true, 1],
  ['cross-process', 'stale', { nonce: 'n', pid: process.pid + 1 }, false, 0],
  ['no-token', 'stale', {}, false, 0],
  ['no-nonce', 'stale', { pid: process.pid }, false, 0],
  ['unknown', 'unknown', { nonce: 'n', pid: process.pid }, false, 1],
  ['throwing', 'throw', { nonce: 'n', pid: process.pid }, false, 1],
]) test(`arbitration attestation: ${name}`, async () => {
  let attestations = 0, disconnects = 0
  const arbitration = createChannelBindingArbitration((id, nonce) => {
    attestations++
    assert.equal(id, 's'); assert.equal(nonce, 'n')
    if (verdict === 'throw') throw Error('lookup failed')
    return verdict
  })
  await arbitration.open('s', socket(), async () => ({ peer: { async disconnect() { disconnects++ } } }), token)
  if (reclaim) await arbitration.open('s', socket(), bind)
  else await assert.rejects(arbitration.open('s', socket(), bind), /session already bound/)
  assert.equal(disconnects, reclaim ? 1 : 0)
  assert.equal(attestations, calls)
})

test('attested reclaim failure retains mapping and retries disconnect', async () => {
  let calls = 0
  const arbitration = createChannelBindingArbitration(() => 'stale')
  await arbitration.open('s', socket(), async () => ({ peer: { async disconnect() { if (++calls === 1) throw Error('failed') } } }), { nonce: 'n', pid: process.pid })
  await assert.rejects(arbitration.open('s', socket(), bind), /session already bound/)
  await arbitration.open('s', socket(), bind)
  assert.equal(calls, 2)
})

test('open wire adds unique per-channel token; drop and close prune registrations', async () => {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\weir-token-${randomUUID()}` : join(tmpdir(), `weir-token-${randomUUID()}.sock`)
  const messages = []
  const server = createServer(stream => serveEditLockPeer(stream, {
    async receive(message) { messages.push(message); return { state: 'active' } },
    async disconnect() {},
  }))
  await new Promise(resolve => server.listen(endpoint, resolve))
  const remote = createRemoteEditLockDomain(endpoint, { onNotice() {}, onChannelOpen: registerBindingRuntime })
  const first = { id: 's' }, second = { id: 't' }
  try {
    await remote.channelFor(first)
    await remote.channelFor(second)
    for (const message of messages) {
      assert.deepEqual(Object.keys(message).sort(), ['callId', 'kind', 'request'])
      assert.equal(message.kind, 'open')
      assert.deepEqual(Object.keys(message.request).sort(), ['nonce', 'pid', 'sessionId'])
      assert.equal(message.request.pid, process.pid)
      assert.equal(typeof message.request.nonce, 'string')
      assert.equal(bindingRuntime(message.request.nonce).sessionId, message.request.sessionId)
    }
    assert.notEqual(messages[0].request.nonce, messages[1].request.nonce)
    remote.drop(first)
    assert.equal(bindingRuntime(messages[0].request.nonce), undefined)
  } finally {
    remote.close()
    await new Promise(resolve => server.close(resolve))
  }
  assert.equal(bindingRuntime(messages[1].request.nonce), undefined)
})

test('old-client open without token succeeds and is never attested away', async () => {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\weir-skew-${randomUUID()}` : join(tmpdir(), `weir-skew-${randomUUID()}.sock`)
  let starts = 0, attestations = 0
  const server = await serveEditLockEndpoint({ async start() { starts++; return 'active' }, async forget() {} }, endpoint, new WeakMap(), () => { attestations++; return 'stale' })
  const client = createEditLockPeerClient(createConnection(endpoint))
  const remote = createRemoteEditLockDomain(endpoint, { onNotice() {} })
  try {
    assert.deepEqual(await client.request('open', 'open', { sessionId: 'old' }, new AbortController().signal), { state: 'active' })
    assert.deepEqual(server.bindings(), [{ sessionId: 'old', present: true, holderPid: null, attestable: false, attestation: 'unknown' }])
    await assert.rejects(remote.channelFor({ id: 'old' }), /holder cannot be attested/)
    assert.equal(starts, 1)
    assert.equal(attestations, 0)
  } finally { client.close(); remote.close(); await server.close() }
})

test('production peer retries failed revocation but never reopens its ingress', async () => {
  let calls = 0
  const peer = createEditLockPeer({ async forget() { if (++calls === 1) throw Error('durable failure') } }, {})
  await assert.rejects(peer.disconnect(), /durable failure/)
  await assert.rejects(peer.receive({}), /disconnected/)
  await peer.disconnect()
  await peer.disconnect()
  assert.equal(calls, 2)
})
