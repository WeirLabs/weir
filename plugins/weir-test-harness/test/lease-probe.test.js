// Contract tests for the driver-side lease broker client (src/lease-probe.js).
//
// The client is the integration driver's SECOND owner and the turn probe's
// reader, so its framing has to be exactly the documented wire protocol:
// newline-delimited JSON, one `hello` per connection before any other op,
// `reqId` correlation, and refusals returned as frames rather than thrown (a
// scenario asserts on the refusal). A fake broker over a real unix socket pins
// that without a headless boot.
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_MAJOR, connectLeaseBroker, pollUntil, retryUntil } from '../src/lease-probe.js'

// Every socket path in this file is short: unix `sun_path` is bounded, and the
// lane root is long enough to blow the budget if folded into a file name.
const DIR = mkdtempSync(join(tmpdir(), 'weir-lp-'))
after(() => rmSync(DIR, { recursive: true, force: true }))
let socketSeq = 0

/**
 * A scripted broker: answers `hello`, then replies per the table below. Every
 * received frame is recorded so tests can assert frame grammar and order.
 * @param {(frame: any, socket: import('node:net').Socket) => any} reply
 */
function fakeBroker(reply) {
  const received = []
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const frame = JSON.parse(line)
        received.push(frame)
        const out = reply(frame, socket)
        if (out !== undefined) socket.write(`${JSON.stringify(out)}\n`)
        index = buffer.indexOf('\n')
      }
    })
  })
  const socketPath = join(DIR, `b${++socketSeq}.sock`)
  return new Promise((resolve) => {
    server.listen({ path: socketPath }, () => {
      resolve({
        socketPath,
        received,
        close: () => new Promise((done) => server.close(() => done(undefined))),
      })
    })
  })
}

const HELLO_OK = { ok: true, protocol: PROTOCOL_MAJOR, daemonVersion: 'test', startedAt: 1234 }
const withReq = (frame, body) => ({ ...body, reqId: frame.reqId })

describe('connectLeaseBroker handshake', () => {
  it('greets before any other op and reuses one connection', async () => {
    const broker = await fakeBroker((frame) => {
      if (frame.op === 'hello') return withReq(frame, HELLO_OK)
      if (frame.op === 'status') return withReq(frame, { ok: true, leases: [] })
      return withReq(frame, { ok: false, error: { code: 'bad-request' } })
    })
    const client = connectLeaseBroker(broker.socketPath, { timeoutMs: 1_000 })
    try {
      const greeting = await client.hello()
      assert.equal(greeting.ok, true)
      assert.equal(greeting.startedAt, 1234)
      const status = await client.status()
      assert.deepEqual(status.leases, [])
      assert.deepEqual(broker.received.map((frame) => frame.op), ['hello', 'status'])
      // Every frame carries the protocol's correlation token.
      for (const frame of broker.received) assert.equal(typeof frame.reqId, 'string')
    } finally {
      client.close()
      await broker.close()
    }
  })

  it('reports a refused handshake as a transport failure, not a silent success', async () => {
    const broker = await fakeBroker((frame) => withReq(frame, { ok: false, error: { code: 'protocol-mismatch' } }))
    const client = connectLeaseBroker(broker.socketPath, { timeoutMs: 1_000 })
    try {
      await assert.rejects(() => client.hello(), /refused the handshake \(protocol-mismatch\)/)
    } finally {
      client.close()
      await broker.close()
    }
  })

  it('rejects with code `transport` when the endpoint does not exist', async () => {
    const client = connectLeaseBroker(join(DIR, 'absent.sock'), { timeoutMs: 500 })
    try {
      await assert.rejects(() => client.status(), (error) => error.code === 'transport')
    } finally {
      client.close()
    }
  })
})

describe('connectLeaseBroker requests', () => {
  it('returns a `held` refusal frame with its holder instead of throwing', async () => {
    const conflict = { path: '/ws/target.txt', holder: { id: 'L', session: 'S', label: 'Holder' }, expiresAt: 9, holdUntil: null }
    const broker = await fakeBroker((frame) => {
      if (frame.op === 'hello') return withReq(frame, HELLO_OK)
      if (frame.op === 'acquire') return withReq(frame, { ok: false, error: { code: 'held', conflicts: [conflict] } })
      return withReq(frame, { ok: false, error: { code: 'bad-request' } })
    })
    const client = connectLeaseBroker(broker.socketPath, { timeoutMs: 1_000 })
    try {
      await client.hello()
      const reply = await client.acquire({ id: 'other', session: 'other-s', label: 'Other' }, ['/ws/target.txt'], '/ws')
      assert.equal(reply.ok, false)
      assert.equal(reply.error.code, 'held')
      assert.equal(reply.error.conflicts[0].holder.label, 'Holder')
      const acquire = broker.received.find((frame) => frame.op === 'acquire')
      assert.deepEqual(acquire.owner, { id: 'other', session: 'other-s', label: 'Other' })
      assert.equal(acquire.scope, '/ws')
      assert.deepEqual(acquire.paths, ['/ws/target.txt'])
    } finally {
      client.close()
      await broker.close()
    }
  })

  it('expands a lineage string into the three owner fields the protocol requires', async () => {
    const broker = await fakeBroker((frame) => {
      if (frame.op === 'hello') return withReq(frame, HELLO_OK)
      return withReq(frame, { ok: true, released: frame.paths })
    })
    const client = connectLeaseBroker(broker.socketPath, { timeoutMs: 1_000 })
    try {
      await client.hello()
      const reply = await client.release('lineage-1', ['/ws/a.txt'])
      assert.equal(reply.ok, true)
      assert.deepEqual(broker.received[1].owner, { id: 'lineage-1', session: 'lineage-1', label: 'lineage-1' })
    } finally {
      client.close()
      await broker.close()
    }
  })

  it('forwards only the three status filters the frame grammar allows', async () => {
    const broker = await fakeBroker((frame) => {
      if (frame.op === 'hello') return withReq(frame, HELLO_OK)
      return withReq(frame, { ok: true, leases: [] })
    })
    const client = connectLeaseBroker(broker.socketPath, { timeoutMs: 1_000 })
    try {
      await client.hello()
      await client.status({ scope: '/ws', session: 's1', path: '/ws/a.txt', extraneous: 'dropped' })
      const status = broker.received[1]
      assert.deepEqual(Object.keys(status).sort(), ['op', 'path', 'reqId', 'scope', 'session'])
    } finally {
      client.close()
      await broker.close()
    }
  })

  it('assembles frames split across chunks and rejects an unanswered request by deadline', async () => {
    const broker = await fakeBroker((frame, socket) => {
      if (frame.op === 'hello') {
        // The handshake reply is written in two fragments: the client must
        // buffer partial lines instead of dropping them.
        const line = `${JSON.stringify(withReq(frame, HELLO_OK))}\n`
        socket.write(line.slice(0, 10))
        setTimeout(() => socket.write(line.slice(10)), 10)
        return undefined
      }
      // `status` is never answered: the per-request deadline must fire.
      return undefined
    })
    const client = connectLeaseBroker(broker.socketPath, { timeoutMs: 200 })
    try {
      const greeting = await client.hello()
      assert.equal(greeting.ok, true)
      await assert.rejects(() => client.status(), (error) => error.code === 'transport' && /did not answer status/.test(error.message))
    } finally {
      client.close()
      await broker.close()
    }
  })
})

describe('driver wait helpers', () => {
  it('pollUntil returns the first truthy value and null at the deadline', async () => {
    let calls = 0
    const value = await pollUntil(() => (++calls >= 3 ? 'ready' : null), { timeoutMs: 1_000, stepMs: 5 })
    assert.equal(value, 'ready')
    assert.equal(calls, 3)
    assert.equal(await pollUntil(() => null, { timeoutMs: 40, stepMs: 10 }), null)
  })

  it('retryUntil carries the last failure so a scenario can report why the arbiter never came up', async () => {
    let attempts = 0
    const outcome = await retryUntil(() => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error(`boot ${attempts}`), { code: 'ENOENT' })
      return 'up'
    }, { timeoutMs: 1_000, stepMs: 5 })
    assert.deepEqual(outcome, { ok: true, value: 'up' })
    const failed = await retryUntil(() => {
      throw Object.assign(new Error('still absent'), { code: 'ENOENT' })
    }, { timeoutMs: 30, stepMs: 10 })
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'ENOENT')
  })
})
