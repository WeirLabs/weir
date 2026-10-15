import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelBindingArbitration, createRemoteEditLockDomain, serveEditLockEndpoint } from '../src/edit-lock/remote.js'
import { bindingRefusal } from '../src/edit-lock/binding-guidance.js'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { fixtureEndpoint } from './helpers/edit-lock-fixtures.js'
import { localDomain } from '../src/edit-lock/domain.js'
import { registerBindingRuntime, createBindingAttester } from '../src/edit-lock/binding-attestation.js'

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
async function publisher(directory, root, attest) {
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const server = await serveEditLockEndpoint(lifecycle, fixtureEndpoint(directory), new WeakMap(), attest, agent => typeof agent.id === 'string')
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
      assert.match(error.message, /same process.*stale runtime incarnation.*edit-lock retry/)
      assert.doesNotMatch(error.message, /window/)
      assert.match(error.message, /Do NOT remove the publisher reservation/)
      assert.equal(error.message.split('Do NOT remove the publisher reservation').length - 1, 1)
      assert.ok(error.message.endsWith(`(publisher answered: session already bound: holder=same-process-unattestable; pid=${process.pid})`))
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

test('endpoint: a serving holder is told of the live edit and the retry moment, never a window hunt', async () => {
  const { root, directory } = await fixture()
  const { lifecycle, server } = await publisher(directory, root, () => 'serving')
  const remoteA = createRemoteEditLockDomain(fixtureEndpoint(directory), { onNotice() {} })
  const remoteB = createRemoteEditLockDomain(fixtureEndpoint(directory), { onNotice() {} })
  try {
    await remoteA.channelFor({ id: 'serving-session' })
    await assert.rejects(remoteB.channelFor({ id: 'serving-session' }), error => {
      // The mid-turn/live-holder copy (change edit-lock-binding-transfer):
      // what is happening and when to retry — no window hunt, no process
      // management, no publisher-reservation warning.
      assert.match(error.message, /being edited in another attachment right now/)
      assert.match(error.message, /Wait for that turn to finish.*\/edit-lock retry/)
      assert.doesNotMatch(error.message, /stale runtime incarnation|window|Do NOT remove the publisher reservation/)
      assert.ok(error.message.endsWith(`(publisher answered: session already bound: holder=serving; pid=${process.pid})`))
      return true
    })
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
      assert.match(error.message, /same process.*stale runtime incarnation/)
      assert.equal(error.message.split('Do NOT remove the publisher reservation').length - 1, 1)
      assert.ok(error.message.endsWith(`(publisher answered: session already bound: holder=same-process-unattestable; pid=${process.pid})`))
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
  // Two structured refusals (the earlier channel's death is still in flight),
  // then admission. The retry budget classifies on the structured field, never
  // on the text (change edit-lock-deepening): a real lifecycle refusal always
  // carries the minted bindingFailure.
  let starts = 0
  const lifecycle = {
    service: {},
    start: async () => { starts++; if (starts <= 2) throw bindingRefusal(process.pid, 'unknown'); return 'active' },
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

for (const source of ['superseded', 'serving', 'unknown', 'unavailable', 'wrong-caller']) {
  test(`local lifecycle attestation: ${source}`, async () => {
    const { root, directory } = await fixture()
    const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
    const old = { id: 's' }, current = { id: 's' }
    let serving = old
    const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, {
      servingRuntime() { if (source === 'unavailable') throw Error('registry unavailable'); return serving },
    })
    try {
      await lifecycle.start(old)
      await lifecycle.service.acquire({ agent: old }, { filePath: 'a.txt', cwd: root })
      serving = source === 'superseded' ? current : source === 'unknown' ? undefined : source === 'wrong-caller' ? { id: 's' } : old
      if (source === 'superseded') {
        assert.equal(await lifecycle.start(current), 'interrupted')
        assert.throws(() => lifecycle.status(old), /unknown lifecycle agent/)
        assert.equal(lifecycle.status(current).locks.length, 1)
        assert.equal(lifecycle.status(current).locks[0].generation, 1)
        assert.equal(lifecycle.status(current).locks[0].status, 'user-interrupted')
      } else {
        await assert.rejects(lifecycle.start(current), /session already bound/)
        assert.equal(lifecycle.status(old).state, 'active')
        assert.equal(lifecycle.status(old).locks.length, 1)
      }
    } finally { await lifecycle.close() }
  })
}

test('local claimant cannot attest away a remote channel proxy', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const proxy = { id: 's', remote: true }, serving = { id: 's' }
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { servingRuntime: () => serving })
  try {
    await lifecycle.start(proxy)
    await assert.rejects(lifecycle.start(serving), /session already bound/)
    assert.equal(lifecycle.status(proxy).state, 'active')
    assert.deepEqual(lifecycle.bindings(), [])
  } finally { await lifecycle.close() }
})

test('local reclaim failure retains entry and subsequent concurrent starts admit only once', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const old = { id: 's' }, current = { id: 's' }
  let serving = old, cancellations = 0
  const lifecycle = createEditLockLifecycle({ ...runtime, control: { ...runtime.control,
    cancelSession(id) { if (++cancellations === 1) return Promise.reject(Error('durable failure')); return runtime.control.cancelSession(id) },
  } }, agent => agent.id, { servingRuntime: () => serving })
  try {
    await lifecycle.start(old)
    serving = current
    await assert.rejects(lifecycle.start(current), /session already bound/)
    assert.equal(lifecycle.status(old).state, 'stopped')
    // Same-agent adoption (change edit-lock-shared-domain-mounts, design D2):
    // two concurrent starts of the SAME agent object now converge on the ONE
    // in-flight registration instead of the second failing 'already
    // registered'. Exactly one binding results: the reclaim of the failed old
    // holder completed once, the claimant bound once as interrupted.
    const results = await Promise.allSettled([lifecycle.start(current), lifecycle.start(current)])
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'])
    assert.deepEqual(results.map(result => result.value), ['interrupted', 'interrupted'])
    assert.equal(lifecycle.status(current).state, 'stopped')
    assert.throws(() => lifecycle.status(old), /unknown lifecycle agent/)
  } finally { await lifecycle.close() }
})

test('publisher-local startup reclaims an attested stale remote holder without releasing its locks', async () => {
  const { root, directory } = await fixture()
  const old = { id: 'cross-mode' }, current = { id: 'cross-mode' }
  let serving = old
  const { runtime, lifecycle, server } = await publisher(directory, root, createBindingAttester(() => serving))
  const remote = createRemoteEditLockDomain(fixtureEndpoint(directory), { onNotice() {}, onChannelOpen: registerBindingRuntime })
  const local = localDomain(lifecycle, server)
  try {
    await remote.channelFor(old)
    await remote.call(old, 'acquire', { filePath: 'a.txt', cwd: root })
    await assert.rejects(local.start(current), /session already bound/)
    serving = current
    assert.equal(await local.start(current), 'interrupted')
    const lock = runtime.control.status().locks[0]
    assert.equal(lock.owner, 'cross-mode')
    assert.equal(lock.generation, 1)
    assert.equal(lock.status, 'user-interrupted')
    await assert.rejects(remote.call(old, 'acquire', { filePath: 'a.txt', cwd: root }), /disconnected/)
    await assert.rejects(local.service.acquire({ agent: current }, { filePath: 'a.txt', cwd: root }), /stopped/)
    remote.drop(old)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await local.status(current)).locks.length, 1)
  } finally { remote.close(); await local.close() }
})

test('binding retry of a revoked owner binds an interrupted replacement (repair path), never authority', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  await runtime.control.openSession('revoked')
  const lifecycle = createEditLockLifecycle({ ...runtime, control: { ...runtime.control,
    status() { const state = runtime.control.status(); return { ...state, sessions: state.sessions.map(s => ({ ...s, revoked: true })) } },
  } }, agent => agent.id)
  try {
    // A revoked session is startable: it binds as interrupted and only the
    // trusted resume path (receipt + epoch advance) ends the revocation.
    const agent = { id: 'revoked' }
    assert.equal(await localDomain(lifecycle, undefined).retryStart(agent), 'interrupted')
    assert.equal(lifecycle.bindings()[0].sessionId, 'revoked')
    // Binding alone grants nothing: business ingress stays denied while stopped.
    await assert.rejects(lifecycle.service.acquire({ agent }, { filePath: 'a.txt', cwd: root }), /stopped/)
  } finally { await lifecycle.close() }
})

for (const prior of ['remote', 'already-forgotten']) test(`supersession during final local start removes cleanup authority (${prior})`, async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const old = { id: 's' }, claimant = { id: 's' }, successor = { id: 's' }
  let serving = old, cancels = 0
  const entered = Promise.withResolvers(), barrier = Promise.withResolvers()
  const lifecycle = createEditLockLifecycle({ ...runtime, control: { ...runtime.control,
    async cancelSession(id) {
      const result = await runtime.control.cancelSession(id)
      if (++cancels === 2) { entered.resolve(); await barrier.promise }
      return result
    },
  } }, agent => agent.id, { servingRuntime: () => serving })
  const server = await serveEditLockEndpoint(lifecycle, fixtureEndpoint(directory), new WeakMap(), createBindingAttester(() => serving), agent => serving === agent)
  const local = localDomain(lifecycle, server)
  const remote = createRemoteEditLockDomain(fixtureEndpoint(directory), { onNotice() {}, onChannelOpen: registerBindingRuntime })
  try {
    if (prior === 'remote') {
      await remote.channelFor(old)
      await remote.call(old, 'acquire', { filePath: 'a.txt', cwd: root })
    } else {
      await lifecycle.start(old)
      await lifecycle.service.acquire({ agent: old }, { filePath: 'a.txt', cwd: root })
      await lifecycle.forget(old)
    }
    serving = claimant
    const start = local.start(claimant)
    await entered.promise
    serving = successor
    barrier.resolve()
    await assert.rejects(start, /no longer current/)
    await assert.rejects(local.service.release({ agent: claimant }, { filePath: 'a.txt', cwd: root }), /authenticated/)
    assert.equal(runtime.control.status().locks[0].generation, 1)
    assert.equal(await local.start(successor), 'interrupted')
    assert.equal((await local.status(successor)).locks.length, 1)
  } finally { barrier.resolve(); remote.close(); await local.close() }
})

// --- Binding transfer to the driving agent (change edit-lock-binding-transfer) ---
// Holder-liveness vocabulary pinned here: the DSH agent `status` getter reports
// exactly 'idle' | 'running' (idle covers the idle and maintenance phases).
// Only 'idle' proves the holder is not mid-turn; a missing, non-string or
// throwing read is undeterminable and NEVER admits a transfer.

test('transferStart: an idle registry-named local holder transfers; the lock stays interrupted, never released', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const holder = { id: 's', status: 'idle' }, claimant = { id: 's' }
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { servingRuntime: () => holder })
  try {
    await lifecycle.start(holder)
    await lifecycle.service.acquire({ agent: holder }, { filePath: 'a.txt', cwd: root })
    assert.equal(await lifecycle.transferStart(claimant), 'interrupted')
    assert.throws(() => lifecycle.status(holder), /unknown lifecycle agent/)
    assert.equal(lifecycle.status(claimant).state, 'stopped')
    assert.equal(lifecycle.status(claimant).locks.length, 1)
    assert.equal(lifecycle.status(claimant).locks[0].generation, 1)
    assert.equal(lifecycle.status(claimant).locks[0].status, 'user-interrupted')
    // Binding alone grants nothing: business ingress stays denied until the
    // trusted resume path runs.
    await assert.rejects(lifecycle.service.acquire({ agent: claimant }, { filePath: 'a.txt', cwd: root }), /stopped/)
  } finally { await lifecycle.close() }
})

for (const [label, holder] of [
  ['mid-turn (running)', { id: 's', status: 'running' }],
  ['undeterminable (no status)', { id: 's' }],
  ['undeterminable (non-string status)', { id: 's', status: null }],
  ['undeterminable (throwing status getter)', { id: 's', get status() { throw new Error('gone') } }],
]) {
  test(`transferStart: a ${label} holder is never preempted`, async () => {
    const { root, directory } = await fixture()
    const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
    const claimant = { id: 's' }
    const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { servingRuntime: () => holder })
    try {
      await lifecycle.start(holder)
      await lifecycle.service.acquire({ agent: holder }, { filePath: 'a.txt', cwd: root })
      await assert.rejects(lifecycle.transferStart(claimant), error => {
        assert.match(error.message, /session already bound: holder=serving/)
        assert.equal(error.bindingFailure?.holderKind, 'serving')
        return true
      })
      // The holder and its lock are completely untouched.
      assert.equal(lifecycle.status(holder).state, 'active')
      assert.equal(lifecycle.status(holder).locks[0].status, 'active')
    } finally { await lifecycle.close() }
  })
}

for (const [label, serving] of [
  ['registry names no one', undefined],
  ['registry names a third agent', { id: 's', status: 'idle' }],
]) {
  test(`transferStart: ${label} — the holder is unattestable and stays`, async () => {
    const { root, directory } = await fixture()
    const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
    const holder = { id: 's', status: 'idle' }, claimant = { id: 's' }
    const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { servingRuntime: () => serving })
    try {
      await lifecycle.start(holder)
      // A local holder whose attestation is unknown classifies as
      // same-process-unattestable (never the transferable class).
      await assert.rejects(lifecycle.transferStart(claimant), error => {
        assert.match(error.message, /session already bound: holder=same-process-unattestable/)
        assert.equal(error.bindingFailure?.holderKind, 'unknown')
        return true
      })
      assert.equal(lifecycle.status(holder).state, 'active')
    } finally { await lifecycle.close() }
  })
}

test('transferStart: a throwing registry and a remote proxy holder both stay fail-closed', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const proxy = { id: 's', remote: true }, claimant = { id: 's' }
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { servingRuntime: () => { throw new Error('registry down') } })
  try {
    await lifecycle.start(proxy)
    // The remote-proxy ban is absolute for the transfer admission as well.
    await assert.rejects(lifecycle.transferStart(claimant), /session already bound/)
    assert.equal(lifecycle.status(proxy).state, 'active')
  } finally { await lifecycle.close() }
})

test('transferStart: without a prior binding it is an ordinary start; a local idle holder classifies refusals as transferable', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const holder = { id: 's', status: 'idle' }, claimant = { id: 's' }, other = { id: 'other' }
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { servingRuntime: id => (id === 's' ? holder : undefined) })
  try {
    // No prior binding: the transfer entry binds directly.
    assert.equal(await lifecycle.transferStart(other), 'active')
    // Passive start() still refuses the idle holder — but with the
    // transferable classification and its calm guidance, no reservation warning.
    await lifecycle.start(holder)
    await assert.rejects(lifecycle.start(claimant), error => {
      assert.match(error.message, /session already bound: holder=serving-idle/)
      assert.match(error.message, /inactive attachment of this same session/)
      assert.match(error.message, /attaches here automatically when you next send a message/)
      assert.doesNotMatch(error.message, /Do NOT remove the publisher reservation|window/)
      assert.equal(error.bindingFailure?.code, 'binding-duplicate')
      assert.equal(error.bindingFailure?.holderKind, 'transferable')
      assert.equal(error.bindingFailure?.retryable, true)
      return true
    })
  } finally { await lifecycle.close() }
})

test('endpoint: a retry open transfers from an idle local holder; ordinary and refused opens never do', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const holder = { id: 's', status: 'idle' }
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { servingRuntime: () => holder })
  const server = await serveEditLockEndpoint(lifecycle, fixtureEndpoint(directory), new WeakMap())
  const remote = createRemoteEditLockDomain(fixtureEndpoint(directory), { onNotice() {} })
  try {
    await lifecycle.start(holder)
    await lifecycle.service.acquire({ agent: holder }, { filePath: 'a.txt', cwd: root })

    // A passive (non-retry) open is refused with the transferable class.
    await assert.rejects(remote.channelFor({ id: 's' }), error => {
      assert.equal(error.bindingFailure?.holderKind, 'transferable')
      assert.match(error.message, /inactive attachment of this same session/)
      assert.doesNotMatch(error.message, /Do NOT remove the publisher reservation/)
      return true
    })
    assert.equal(lifecycle.status(holder).state, 'active')

    // The retry open — the wire form of a trusted driving ingress — transfers.
    const claimant = { id: 's' }
    assert.equal((await remote.channelFor(claimant, true)).state, 'interrupted')
    assert.throws(() => lifecycle.status(holder), /unknown lifecycle agent/)
    assert.equal(runtime.control.status().locks[0].status, 'user-interrupted')
    // The transferred channel denies edits until the trusted resume runs.
    await assert.rejects(remote.call(claimant, 'acquire', { filePath: 'a.txt', cwd: root }), /stopped/)
  } finally {
    remote.close()
    await server.close()
    await lifecycle.close()
  }
})

test('endpoint: a retry open never preempts a mid-turn local holder', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const holder = { id: 's', status: 'running' }
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { servingRuntime: () => holder })
  const server = await serveEditLockEndpoint(lifecycle, fixtureEndpoint(directory), new WeakMap())
  const remote = createRemoteEditLockDomain(fixtureEndpoint(directory), { onNotice() {} })
  try {
    await lifecycle.start(holder)
    await assert.rejects(remote.channelFor({ id: 's' }, true), error => {
      assert.equal(error.bindingFailure?.holderKind, 'serving')
      assert.match(error.message, /being edited in another attachment right now/)
      return true
    })
    assert.equal(lifecycle.status(holder).state, 'active')
  } finally {
    remote.close()
    await server.close()
    await lifecycle.close()
  }
})

test('endpoint: startLocal transfer threads the admission and the relaxed currency proof', async () => {
  const { root, directory } = await fixture()
  const runtime = await openEditLockRuntime({ directory, root, domainId: 'd', mode: 'create', fs: stubFs, assertExclusive() {} })
  const holder = { id: 's', status: 'idle' }, claimant = { id: 's' }
  let serving = holder
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { servingRuntime: () => serving })
  // The production currency proof (index.js): a transfer claimant is never the
  // registry's serving agent; its liveness proof is the live root listing.
  const roots = [holder, claimant]
  const server = await serveEditLockEndpoint(lifecycle, fixtureEndpoint(directory), new WeakMap(), undefined,
    (agent, requireProof, transfer) => (transfer === true ? roots.includes(agent) : serving === agent))
  const local = localDomain(lifecycle, server)
  try {
    await lifecycle.start(holder)
    await lifecycle.service.acquire({ agent: holder }, { filePath: 'a.txt', cwd: root })
    // The ordinary local retry dies at the currency gate while the registry
    // names the holder (the claimant is not the serving runtime)…
    await assert.rejects(local.retryStart(claimant), /no longer current/)
    // …and the explicit transfer entry takes the binding over.
    assert.equal(await local.transferStart(claimant), 'interrupted')
    assert.equal(lifecycle.status(claimant).locks[0].status, 'user-interrupted')
  } finally { await local.close() }
})
