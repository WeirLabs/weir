import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from './helpers.js'
import { createLeaseClient } from '../src/file-lease/client.js'
import { spawnDaemon } from '../src/file-lease/spawn.js'

// Real-IPC tests: a REAL `weir-editlockd` child process on a REAL socket, driven
// by two independent clients, started through the production spawn helper.
//
// The unit suite (file-lease-client.test.js) already pins the state machine with
// a scripted transport. What only this file can prove:
//   - the frames this client writes are accepted by the real broker (field
//     discipline, handshake, per-connection identity);
//   - two connections of the same process really do arbitrate against each other;
//   - a retention survives a turn boundary (`releaseSession`) and a holder
//     disconnect (`releaseAll`) really does free the path;
//   - the spawn helper produces a working daemon, and the client re-spawns one
//     after it idles out (no permanent fuse);
//   - nothing is left behind: no listening endpoint, no socket file, no daemon.

const SCOPE = '/work/project'
const OWNER_A = Object.freeze({ id: 'lineage-a', session: 'sess-a', label: 'orchestrator' })
const OWNER_B = Object.freeze({ id: 'lineage-b', session: 'sess-b', label: 'reviewer' })
const TARGET = `${SCOPE}/src/a.js`

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * @param {() => boolean} predicate
 * @param {string} label
 * @param {number} [ms]
 */
async function waitFor(predicate, label, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * True when the endpoint refuses a dial — i.e. nobody is listening there.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
function dialFails(path) {
  return new Promise((resolve) => {
    const socket = connect({ path })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', (error) => {
      const code = /** @type {any} */ (error)?.code
      resolve(code === 'ENOENT' || code === 'ECONNREFUSED')
    })
  })
}

/**
 * Stand up a daemon on a private temporary socket and hand out clients bound to
 * it. Every client spawns through the production `spawnDaemon`, and the guard
 * below keeps that to one live child at a time — exactly what the D11 singleton
 * relies on inside a real process.
 * @param {{ after: (fn: () => void) => void }} t node:test context
 * @param {{ idleMs?: number }} [options]
 */
function startBroker(t, { idleMs = 1_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-file-lease-ipc-'))
  const socketPath = join(dir, 'broker.sock')
  /** @type {any} */
  let child = null
  /** @type {any[]} */
  const children = []
  /** @type {any[]} */
  const clients = []
  const env = {
    WEIR_EDITLOCKD_SOCKET: socketPath,
    WEIR_EDITLOCKD_IDLE_MS: String(idleMs),
    WEIR_EDITLOCKD_SWEEP_MS: '100',
  }
  /** @type {any[]} */
  const audits = []

  /** @returns {any} */
  function clientFor() {
    const client = createLeaseClient({
      socketPath,
      timeoutMs: 5_000,
      connectRetryMs: 25,
      connectRetryBudgetMs: 8_000,
      audit: (kind, detail) => audits.push({ kind, detail }),
      spawnDaemon: () => {
        // Only spawn when there is no live daemon: this is the "same process
        // reuses one arbiter" rule, expressed at the only place it matters.
        if (child === null || child.exitCode !== null) {
          child = spawnDaemon({ env })
          children.push(child)
        }
        return child
      },
    })
    clients.push(client)
    return client
  }

  /** @returns {void} */
  function closeClients() {
    for (const client of clients.splice(0)) client.close()
  }

  t.after(() => {
    closeClients()
    for (const spawned of children) {
      if (spawned !== null && spawned.exitCode === null) {
        try {
          spawned.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  return {
    dir,
    socketPath,
    audits,
    children,
    clientFor,
    closeClients,
    get daemon() {
      return child
    },
  }
}

/**
 * @param {any} client
 * @param {any} owner
 * @returns {Promise<'granted' | string>} `'granted'`, or the rejection's code
 */
async function acquireOutcome(client, owner) {
  try {
    await client.withLeases(owner, [TARGET], SCOPE, () => {})
    return 'granted'
  } catch (error) {
    return error?.code ?? 'unknown'
  }
}

describe('file-lease client over a real socket', () => {
  it('arbitrates two connections, keeps a hold across a turn end, and frees it on dispose', async (t) => {
    const broker = startBroker(t, { idleMs: 2_000 })
    const alice = broker.clientFor()
    const bob = broker.clientFor()
    expect(alice.endpoint).toBe(broker.socketPath)

    // The first writer takes the path for its turn…
    await alice.withLeases(OWNER_A, [TARGET], SCOPE, () => {})
    // …and a turn boundary does not release it (D2): no `release` on the way out.
    expect(await acquireOutcome(bob, OWNER_B)).toBe('held')

    // The holder is visible through the one read-only projection.
    const status = await bob.status({ path: TARGET })
    expect(status.leases).toHaveLength(1)
    expect(status.leases[0].owner.id).toBe(OWNER_A.id)
    expect(status.leases[0].session ?? status.leases[0].owner.session).toBe(OWNER_A.session)

    // A retention outlives the turn it was taken in: `turn/end` releases only the
    // unretained leases, so the path stays closed to everyone else.
    await alice.hold([TARGET], 30)
    await alice.releaseSession(OWNER_A.session)
    expect(await acquireOutcome(bob, OWNER_B)).toBe('held')

    // `agent/disposed` takes the retention with it; the other lineage may proceed.
    await alice.releaseAll(OWNER_A.session)
    let ran = 0
    await bob.withLeases(OWNER_B, [TARGET], SCOPE, () => {
      ran += 1
    })
    expect(ran).toBe(1)

    // Two independent connections, two independent clients, no degradation.
    expect(broker.audits).toEqual([])
    expect(broker.children).toHaveLength(1)
    broker.closeClients()
  })

  it('spawns a real daemon, survives its idle exit, and leaves no socket behind', async (t) => {
    const broker = startBroker(t, { idleMs: 300 })
    const first = broker.clientFor()
    await first.withLeases(OWNER_A, [TARGET], SCOPE, () => {})
    await first.hold([TARGET], 30)
    first.close()

    // The daemon is a cache with an idle window: it exits once nobody is connected.
    await waitFor(() => broker.daemon !== null && broker.daemon.exitCode !== null, 'first daemon idle exit')
    expect(broker.children).toHaveLength(1)
    // Nothing is listening on that endpoint any more.
    expect(await dialFails(broker.socketPath)).toBe(true)

    // The next call must NOT be blocked by the dead daemon: the client retries,
    // spawns a fresh one through the production helper, and arbitrates again.
    const second = broker.clientFor()
    let ran = 0
    await second.withLeases(OWNER_B, [TARGET], SCOPE, () => {
      ran += 1
    })
    expect(ran).toBe(1)
    expect(broker.children).toHaveLength(2)
    expect(await acquireOutcome(second, OWNER_B)).toBe('granted')

    second.close()
    await waitFor(() => broker.daemon !== null && broker.daemon.exitCode !== null, 'second daemon idle exit')

    // Residue: an idly-exited daemon takes its own socket file with it (uv unlinks
    // the path when the listening handle closes), so there is nothing left for the
    // next start to reclaim and nothing for the client to clean up. Only a
    // SIGKILLed daemon leaves the file behind, and that is the case the daemon's
    // own EADDRINUSE recovery handles.
    expect(readdirSync(broker.dir)).toEqual([])
    expect(existsSync(broker.socketPath)).toBe(false)
    expect(await dialFails(broker.socketPath)).toBe(true)
    // The client never kills the daemon: its own idle window ended it, at code 0.
    for (const spawned of broker.children) expect(spawned.exitCode).toBe(0)

    // Explicit cleanup last: the temporary directory itself goes away.
    rmSync(broker.dir, { recursive: true, force: true })
    expect(existsSync(broker.dir)).toBe(false)
  })
})
