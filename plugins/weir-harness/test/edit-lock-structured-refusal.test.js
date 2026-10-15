// Structured binding refusal, end to end (change edit-lock-deepening, tasks
// 2.1-2.2): the bindingFailure structure crosses the wire as an additive field
// beside the display text — including the lifecycle.start refusal path, which
// previously reached the client as text only (remote.js rethrow →
// peer-transport stringification). Guidance and the retry-budget
// classification read the fields; no regex re-parses prose any more.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { createConnection } from 'node:net'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asBindingFailure, bindingFailure, bindingGuidance, bindingRefusal } from '../src/edit-lock/binding-guidance.js'
import { serveEditLockPeer } from '../src/edit-lock/peer-transport.js'
import { createEditLockPeerClient } from '../src/edit-lock/peer-client.js'
import { createRemoteEditLockDomain, serveEditLockEndpoint } from '../src/edit-lock/remote.js'
import { fixtureEndpoint } from './helpers/edit-lock-fixtures.js'

function duplexPair() {
  let left, right
  left = new Duplex({ read() {}, write(bytes, _encoding, done) { right.push(bytes); done() } })
  right = new Duplex({ read() {}, write(bytes, _encoding, done) { left.push(bytes); done() } })
  return [left, right]
}

test('the wire error frame carries the structured refusal beside the text, field-identical', async () => {
  const [left, right] = duplexPair()
  const minted = bindingFailure(4242, 'serving')
  const server = serveEditLockPeer(right, {
    receive: async () => { throw Object.assign(new Error('session already bound: holder=serving; pid=4242'), { bindingFailure: minted }) },
    disconnect: async () => {},
  })
  const client = createEditLockPeerClient(left)
  await assert.rejects(client.request('publish', 'c1', {}, new AbortController().signal), error => {
    assert.equal(error.message, 'session already bound: holder=serving; pid=4242')
    assert.deepEqual(error.bindingFailure, minted)
    return true
  })
  await server.close()
})

test('a plain error crosses as text only — no structure is invented', async () => {
  const [left, right] = duplexPair()
  const server = serveEditLockPeer(right, {
    receive: async () => { throw new Error('edit lifecycle closed') },
    disconnect: async () => {},
  })
  const client = createEditLockPeerClient(left)
  await assert.rejects(client.request('publish', 'c1', {}, new AbortController().signal), error => {
    assert.equal(error.message, 'edit lifecycle closed')
    assert.equal(error.bindingFailure, undefined)
    return true
  })
  await server.close()
})

test('a malformed structured field is dropped on receipt; the text still crosses', async () => {
  const [left, right] = duplexPair()
  const server = serveEditLockPeer(right, {
    receive: async () => { throw Object.assign(new Error('session already bound'), { bindingFailure: { code: 'binding-duplicate', holderKind: 'junk' } }) },
    disconnect: async () => {},
  })
  const client = createEditLockPeerClient(left)
  await assert.rejects(client.request('publish', 'c1', {}, new AbortController().signal), error => {
    assert.equal(error.message, 'session already bound')
    assert.equal(error.bindingFailure, undefined)
    return true
  })
  await server.close()
})

async function fixture() {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-structured-refusal-')))
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  return { base, root, directory }
}

test('lifecycle.start refusal crosses the endpoint rethrow path structured when the client never opted in', async () => {
  const { directory } = await fixture()
  const endpoint = fixtureEndpoint(directory)
  // The publisher-side refusal mints the structure; the client below sends no
  // `bindingFailures` opt-in, so the endpoint RETHROWS (remote.js) and the
  // transport's error frame is the only channel.
  const lifecycle = {
    service: {},
    start: async () => { throw bindingRefusal(process.pid, 'serving') },
    forget: async () => {},
  }
  const server = await serveEditLockEndpoint(/** @type {any} */ (lifecycle), endpoint, new WeakMap())
  const socket = createConnection(endpoint)
  const client = createEditLockPeerClient(socket)
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    await assert.rejects(
      client.request('open', 'open', { sessionId: 's', nonce: 'n', pid: process.pid }, new AbortController().signal),
      error => {
        assert.equal(error.message, `session already bound: holder=serving; pid=${process.pid}`)
        assert.deepEqual(error.bindingFailure, { code: 'binding-duplicate', retryable: true, holderKind: 'serving', holderPid: process.pid })
        return true
      },
    )
  } finally {
    client.close()
    await server.close()
  }
})

test('the opted-in open response carries the validated structure and the display reason', async () => {
  const { directory } = await fixture()
  const endpoint = fixtureEndpoint(directory)
  const lifecycle = {
    service: {},
    start: async () => { throw bindingRefusal(process.pid, 'unknown') },
    forget: async () => {},
  }
  const server = await serveEditLockEndpoint(/** @type {any} */ (lifecycle), endpoint, new WeakMap())
  const socket = createConnection(endpoint)
  const client = createEditLockPeerClient(socket)
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const opened = await client.request('open', 'open', { sessionId: 's', nonce: 'n', pid: process.pid, bindingFailures: true }, new AbortController().signal)
    assert.equal(opened.state, 'unavailable')
    assert.equal(opened.reason, `session already bound: holder=same-process-unattestable; pid=${process.pid}`)
    assert.deepEqual(opened.bindingFailure, { code: 'binding-duplicate', retryable: true, holderKind: 'unknown', holderPid: process.pid })
  } finally {
    client.close()
    await server.close()
  }
})

test('channelFor retries the budget on the structured field, and a text-only refusal is never retried', async () => {
  const { directory } = await fixture()
  await mkdir(join(directory, 'a'))
  await mkdir(join(directory, 'b'))
  // A structured refusal that heals inside the window still binds (the
  // classification read the field, not the message text).
  let starts = 0
  const healing = {
    service: {},
    start: async () => { starts++; if (starts <= 2) throw bindingRefusal(process.pid, 'unknown'); return 'active' },
    forget: async () => {},
  }
  const serverA = await serveEditLockEndpoint(/** @type {any} */ (healing), fixtureEndpoint(join(directory, 'a')), new WeakMap())
  const remoteA = createRemoteEditLockDomain(fixtureEndpoint(join(directory, 'a')), { onNotice() {} })
  try {
    assert.equal((await remoteA.channelFor({ id: 's' })).state, 'active')
    assert.equal(starts, 3)
  } finally {
    remoteA.close()
    await serverA.close()
  }
  // A legacy text-only refusal (no structure — what a pre-structure publisher
  // or a hand-rolled error looks like) is NOT classified as a duplicate: no
  // retry, and the final error reports honestly with the unknown-holder
  // guidance.
  let legacyStarts = 0
  const legacy = {
    service: {},
    start: async () => { legacyStarts++; throw new Error('session already bound') },
    forget: async () => {},
  }
  const serverB = await serveEditLockEndpoint(/** @type {any} */ (legacy), fixtureEndpoint(join(directory, 'b')), new WeakMap())
  const remoteB = createRemoteEditLockDomain(fixtureEndpoint(join(directory, 'b')), { onNotice() {} })
  try {
    await assert.rejects(remoteB.channelFor({ id: 's' }), error => {
      assert.match(error.message, /edit lock duplicate session binding/)
      assert.match(error.message, /publisher answered: session already bound/)
      assert.match(error.message, /holder cannot be attested/)
      assert.equal(error.bindingFailure, undefined)
      return true
    })
    assert.equal(legacyStarts, 1)
  } finally {
    remoteB.close()
    await serverB.close()
  }
})

test('guidance renders from the structured fields only (asBindingFailure gate)', () => {
  // Round-trip discipline: the minted shape validates and renders its class;
  // a text lookalike without the structure renders unknown.
  assert.match(bindingGuidance('s', asBindingFailure(bindingFailure(7, 'serving-idle'))), /inactive attachment of this same session/)
  assert.match(bindingGuidance('s', asBindingFailure(bindingFailure(7, 'serving'))), /being edited in another attachment right now/)
  assert.match(bindingGuidance('s', asBindingFailure(bindingFailure(undefined, 'unknown'))), /holder cannot be attested/)
  assert.equal(asBindingFailure({ code: 'binding-duplicate', retryable: true, holderKind: 'serving', holderPid: 7, extra: 1 }), undefined)
  assert.equal(asBindingFailure({ code: 'binding-duplicate', retryable: true, holderKind: 'serving', holderPid: -1 }), undefined)
  assert.equal(asBindingFailure('session already bound: holder=serving; pid=7'), undefined)
})
