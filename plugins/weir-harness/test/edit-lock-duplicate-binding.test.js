import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelBindingArbitration, createRemoteEditLockDomain, serveEditLockEndpoint } from '../src/edit-lock/remote.js'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { fixtureEndpoint } from './helpers/edit-lock-fixtures.js'

const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture() {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-dup-binding-')))
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  return { base, root, directory }
}

/** A publisher stack over a real endpoint: runtime + lifecycle + server. */
async function publisher(directory, root) {
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const server = await serveEditLockEndpoint(lifecycle, fixtureEndpoint(directory), new WeakMap())
  return { runtime, lifecycle, server }
}

function fakeSocket() { return { destroyed: false, closed: false, errored: null } }
const silentPeer = () => ({ disconnect: async () => {} })

test('duplicate channel binding: a proven-dead prior channel is reclaimed through disconnect before the rebind', async () => {
  for (const kill of [
    /** @param {any} socket */ socket => { socket.destroyed = true },
    /** @param {any} socket */ socket => { socket.closed = true },
    /** @param {any} socket */ socket => { socket.errored = new Error('connection reset') },
  ]) {
    const arbitration = createChannelBindingArbitration()
    const disconnected = []
    const socketA = fakeSocket()
    const peerA = { disconnect: async () => { disconnected.push('A') } }
    const first = await arbitration.open('s', socketA, async () => ({ peer: peerA, state: 'active' }))
    assert.equal(first.state, 'active')
    // The old channel's EOF was never processed; the socket state alone proves it dead.
    kill(socketA)
    const second = await arbitration.open('s', fakeSocket(), async () => ({ peer: silentPeer(), state: 'interrupted' }))
    assert.equal(second.state, 'interrupted')
    assert.deepEqual(disconnected, ['A'])
  }
})

test('duplicate channel binding: a live prior channel is refused, never disconnected, and a failed reclaim stays refused', async () => {
  const arbitration = createChannelBindingArbitration()
  const disconnected = []
  const socketA = fakeSocket()
  let reclaimFails = true
  const peerA = { disconnect: async () => { disconnected.push('A'); if (reclaimFails) throw new Error('revocation lost') } }
  await arbitration.open('s', socketA, async () => ({ peer: peerA, state: 'active' }))

  // Alive: refused before bind runs; the prior binding is untouched.
  let bindCalls = 0
  const intruder = async () => { bindCalls++; return { peer: silentPeer(), state: 'active' } }
  await assert.rejects(arbitration.open('s', fakeSocket(), intruder), /session already bound/)
  assert.equal(bindCalls, 0)
  assert.deepEqual(disconnected, [])
  // Index hygiene never drops a live binding for a foreign socket.
  arbitration.release('s', fakeSocket())
  await assert.rejects(arbitration.open('s', fakeSocket(), intruder), /session already bound/)
  assert.equal(bindCalls, 0)

  // Dead but the reclaim itself fails: fail-closed refusal with the mapping
  // kept, so the next open retries the reclaim — which then succeeds.
  socketA.destroyed = true
  await assert.rejects(arbitration.open('s', fakeSocket(), intruder), /session already bound/)
  assert.equal(bindCalls, 0)
  assert.deepEqual(disconnected, ['A'])
  reclaimFails = false
  const rebound = await arbitration.open('s', fakeSocket(), intruder)
  assert.equal(rebound.state, 'active')
  assert.deepEqual(disconnected, ['A', 'A'])
  assert.equal(bindCalls, 1)
})

test('duplicate channel binding: a lifecycle-level refusal (local holder) passes through and no reclaim is attempted', async () => {
  const arbitration = createChannelBindingArbitration()
  // No channel binding is registered: the refusal comes from bind() itself,
  // exactly like lifecycle.start refusing for a publisher-local agent.
  await assert.rejects(
    arbitration.open('s', fakeSocket(), async () => { throw new Error('session already bound') }),
    /session already bound/,
  )
  // The failed open registered nothing: the next bind is admitted directly.
  const opened = await arbitration.open('s', fakeSocket(), async () => ({ peer: silentPeer(), state: 'active' }))
  assert.equal(opened.state, 'active')
})

test('duplicate channel binding: concurrent opens of one session are serialized; at most one binds', async () => {
  const arbitration = createChannelBindingArbitration()
  /** @type {() => void} */
  let releaseGate = () => {}
  const gate = new Promise(resolve => { releaseGate = resolve })
  let bindBCalls = 0
  const first = arbitration.open('s', fakeSocket(), async () => { await gate; return { peer: silentPeer(), state: 'active' } })
  const second = arbitration.open('s', fakeSocket(), async () => { bindBCalls++; return { peer: silentPeer(), state: 'active' } })
  // A different session is never held up by the serialized one.
  const other = arbitration.open('other', fakeSocket(), async () => ({ peer: silentPeer(), state: 'active' }))
  assert.equal((await other).state, 'active')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(bindBCalls, 0)
  releaseGate()
  assert.equal((await first).state, 'active')
  await assert.rejects(second, /session already bound/)
  assert.equal(bindBCalls, 0)
})

test('endpoint: a dropped channel rebinds as interrupted and keeps its interrupted locks', async () => {
  const { root, directory } = await fixture()
  const { runtime, lifecycle, server } = await publisher(directory, root)
  const endpoint = fixtureEndpoint(directory)
  const remoteA = createRemoteEditLockDomain(endpoint, { onNotice() {} })
  const remoteB = createRemoteEditLockDomain(endpoint, { onNotice() {} })
  try {
    const agentA = { id: 'shared-session' }
    assert.equal((await remoteA.channelFor(agentA)).state, 'active')
    assert.equal((await remoteA.call(agentA, 'acquire', { filePath: 'a.txt', cwd: root })).generation, 1)
    // The client end is gone; the publisher revokes on EOF (or the next open reclaims).
    remoteA.drop(agentA)
    const agentB = { id: 'shared-session' }
    assert.equal((await remoteB.channelFor(agentB)).state, 'interrupted')
    assert.equal(runtime.control.status().locks[0].status, 'user-interrupted')
    await assert.rejects(remoteB.call(agentB, 'acquire', { filePath: 'a.txt', cwd: root }), /was stopped/)
  } finally {
    remoteA.close()
    remoteB.close()
    await server.close()
    await lifecycle.close()
  }
})

test('endpoint: a live channel is refused and keeps its locks; the refused client gets the duplicate-binding guidance', async () => {
  const { root, directory } = await fixture()
  const { runtime, lifecycle, server } = await publisher(directory, root)
  const endpoint = fixtureEndpoint(directory)
  const remoteA = createRemoteEditLockDomain(endpoint, { onNotice() {} })
  const remoteB = createRemoteEditLockDomain(endpoint, { onNotice() {}, unreachableHint: 'UNREACHABLE-HINT' })
  try {
    const agentA = { id: 'shared-session' }
    assert.equal((await remoteA.channelFor(agentA)).state, 'active')
    assert.equal((await remoteA.call(agentA, 'acquire', { filePath: 'a.txt', cwd: root })).generation, 1)

    await assert.rejects(remoteB.channelFor({ id: 'shared-session' }), error => {
      assert.match(error.message, /edit lock duplicate session binding/)
      assert.match(error.message, /shared-session/)
      assert.match(error.message, /Use the session in that window, close it there, or quit that Harness process/)
      assert.match(error.message, /Do NOT remove the publisher reservation/)
      assert.doesNotMatch(error.message, /unreachable/)
      assert.doesNotMatch(error.message, /UNREACHABLE-HINT/)
      return true
    })

    // The refused process never disturbed the live binding.
    assert.equal(remoteA.state(agentA), 'active')
    assert.equal((await remoteA.call(agentA, 'locks')).length, 1)
    assert.equal(runtime.control.status().locks[0].status, 'active')
  } finally {
    remoteA.close()
    remoteB.close()
    await server.close()
    await lifecycle.close()
  }
})

test('endpoint: a publisher-local session binding is never preempted by a remote open', async () => {
  const { root, directory } = await fixture()
  const { lifecycle, server } = await publisher(directory, root)
  const remote = createRemoteEditLockDomain(fixtureEndpoint(directory), { onNotice() {}, unreachableHint: 'UNREACHABLE-HINT' })
  try {
    const local = { id: 'held-locally' }
    assert.equal(await lifecycle.start(local), 'active')
    await lifecycle.service.acquire({ agent: local }, { filePath: 'a.txt', cwd: root })

    await assert.rejects(remote.channelFor({ id: 'held-locally' }), error => {
      assert.match(error.message, /edit lock duplicate session binding/)
      assert.match(error.message, /held-locally/)
      assert.doesNotMatch(error.message, /unreachable/)
      assert.doesNotMatch(error.message, /UNREACHABLE-HINT/)
      return true
    })

    // The local binding and its lock are completely untouched.
    assert.equal(lifecycle.status(local).state, 'active')
    assert.equal(lifecycle.status(local).locks.length, 1)
    assert.equal(lifecycle.status(local).locks[0].status, 'active')
  } finally {
    remote.close()
    await server.close()
    await lifecycle.close()
  }
})

test('client failure split: a connect failure keeps the unreachable report with the reservation hint', async () => {
  const { directory } = await fixture()
  const endpoint = fixtureEndpoint(directory) // nobody is listening
  const remote = createRemoteEditLockDomain(endpoint, { onNotice() {}, unreachableHint: 'UNREACHABLE-HINT' })
  try {
    await assert.rejects(remote.channelFor({ id: 's' }), error => {
      assert.match(error.message, /edit lock publisher unreachable at /)
      assert.match(error.message, /UNREACHABLE-HINT/)
      assert.doesNotMatch(error.message, /duplicate session binding/)
      return true
    })
  } finally {
    remote.close()
  }
})

test('client failure split: an open request that dies unanswered keeps the unreachable report with the hint', async () => {
  const { directory } = await fixture()
  const endpoint = fixtureEndpoint(directory)
  // Accept the transport, then destroy it the moment the open frame arrives —
  // the request never gets an answer.
  const server = createServer(socket => { socket.once('data', () => socket.destroy()) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.off('error', reject); resolve(undefined) }) })
  const remote = createRemoteEditLockDomain(endpoint, { onNotice() {}, unreachableHint: 'UNREACHABLE-HINT' })
  try {
    await assert.rejects(remote.channelFor({ id: 's' }), error => {
      assert.match(error.message, /edit lock publisher unreachable at /)
      assert.match(error.message, /UNREACHABLE-HINT/)
      assert.doesNotMatch(error.message, /duplicate session binding/)
      return true
    })
  } finally {
    remote.close()
    await new Promise(resolve => server.close(() => resolve(undefined)))
  }
})

test('client failure split: an answered duplicate refusal that heals inside the retry window still binds', async () => {
  const { directory } = await fixture()
  const endpoint = fixtureEndpoint(directory)
  // Two refusals (the earlier channel's death is still in flight), then admission.
  let starts = 0
  const lifecycle = {
    service: {},
    start: async () => { starts++; if (starts <= 2) throw new Error('session already bound'); return 'active' },
    forget: async () => {},
  }
  const server = await serveEditLockEndpoint(/** @type {any} */ (lifecycle), endpoint, new WeakMap())
  const remote = createRemoteEditLockDomain(endpoint, { onNotice() {}, unreachableHint: 'UNREACHABLE-HINT' })
  try {
    assert.equal((await remote.channelFor({ id: 's' })).state, 'active')
    assert.equal(starts, 3)
  } finally {
    remote.close()
    await server.close()
  }
})

test('client failure split: a non-duplicate answered refusal is not retried and still reports the live publisher', async () => {
  const { directory } = await fixture()
  const endpoint = fixtureEndpoint(directory)
  let starts = 0
  const lifecycle = {
    service: {},
    start: async () => { starts++; throw new Error('edit lifecycle closed') },
    forget: async () => {},
  }
  const server = await serveEditLockEndpoint(/** @type {any} */ (lifecycle), endpoint, new WeakMap())
  const remote = createRemoteEditLockDomain(endpoint, { onNotice() {}, unreachableHint: 'UNREACHABLE-HINT' })
  const began = Date.now()
  try {
    await assert.rejects(remote.channelFor({ id: 's' }), error => {
      assert.match(error.message, /edit lock duplicate session binding/)
      assert.match(error.message, /publisher answered: edit lifecycle closed/)
      assert.doesNotMatch(error.message, /UNREACHABLE-HINT/)
      return true
    })
    assert.equal(starts, 1)
    assert.equal(Date.now() - began < 1000, true)
  } finally {
    remote.close()
    await server.close()
  }
})
