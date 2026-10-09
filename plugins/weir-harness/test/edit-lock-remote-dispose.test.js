// remoteDomain.dispose acknowledgement contract (openspec
// edit-lock-delegate-lifecycle-hygiene, R1 prerequisite).
//
// The client domain's disposal is the acknowledgement a terminal child handoff
// waits on: the publisher's response proves this agent's locks were released.
// The channel drop is only the transport-level fallback (EOF also revokes).
// These three tests pin that split:
//   A. a rejecting `dispose` call: the channel is dropped exactly once AND the
//      original failure reaches the awaiting caller (no false success)
//   B. a resolving `dispose` call: the drop still happens and the method
//      resolves with the publisher's acknowledgement
//   C. neither branch leaks into other client methods (no bypass): the remote
//      host receives exactly the two calls it declares, and remoteDomain
//      touches no other member of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localDomain, remoteDomain } from '../src/edit-lock/domain.js'

/** A minimal remote host double that records every interaction. */
function remoteDouble(call) {
  const calls = []
  const remote = {
    call(agent, kind, request) { calls.push({ op: 'call', agent, kind, request }); return call(agent, kind, request) },
    drop(agent) { calls.push({ op: 'drop', agent }) },
  }
  return { remote: /** @type {any} */ (remote), calls }
}

test('A: a rejected dispose call still drops the channel once and rejects with the original failure', async () => {
  const failure = new Error('publisher unavailable')
  const { remote, calls } = remoteDouble(() => Promise.reject(failure))
  const domain = remoteDomain(remote)
  const agent = { id: 'child-session' }

  await assert.rejects(domain.dispose(agent), (error) => {
    // The caller must see the real transport failure, not a wrapped or
    // substituted one: the Terminal handoff reports exactly this.
    assert.equal(error, failure)
    return true
  })
  assert.deepEqual(calls, [
    { op: 'call', agent, kind: 'dispose', request: undefined },
    { op: 'drop', agent },
  ])
  // The channel is dropped before the rejection is observable, so a caller
  // that retried or re-awaited would not double-drop.
  assert.equal(calls.filter(entry => entry.op === 'drop').length, 1)
})

test('B: a successful dispose drops the channel and resolves', async () => {
  const acknowledgement = { disposed: true }
  const { remote, calls } = remoteDouble(() => Promise.resolve(acknowledgement))
  const domain = remoteDomain(remote)
  const agent = { id: 'child-session' }

  // Preserved success semantics: the pre-fix signature resolved undefined, and
  // the awaiting caller still gets an answered disposition.
  assert.equal(await domain.dispose(agent), undefined)
  assert.deepEqual(calls, [
    { op: 'call', agent, kind: 'dispose', request: undefined },
    { op: 'drop', agent },
  ])
})

test('C: dispose stays on the two declared remote methods — no bypass of the acknowledgement', async () => {
  const touched = []
  const remote = new Proxy(/** @type {any} */ ({}), {
    get(_target, property) {
      touched.push(String(property))
      if (property === 'call') return () => Promise.reject(new Error('publisher unavailable'))
      if (property === 'drop') return () => {}
      throw new Error(`remoteDomain.dispose reached undeclared method ${String(property)}`)
    },
  })
  const domain = remoteDomain(remote)

  await assert.rejects(domain.dispose({ id: 'child-session' }), /publisher unavailable/)
  // A path that bridged a failed acknowledgement by opening a fresh channel or
  // rewriting local channel state would surface here as extra members.
  assert.deepEqual(touched, ['call', 'drop'])
})

test('D: the publisher-local dispose is untouched — it forwards straight to the lifecycle', async () => {
  const disposed = []
  const lifecycle = /** @type {any} */ ({ dispose: (agent) => { disposed.push(agent); return 'local-ack' } })
  const domain = localDomain(lifecycle, undefined)
  const agent = { id: 'local-session' }

  assert.equal(await domain.dispose(agent), 'local-ack')
  assert.deepEqual(disposed, [agent])
})
