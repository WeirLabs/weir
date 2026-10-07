// Barrier-synchronized reclaim child for the multi-process takeover race test
// (edit-lock-reservation-takeover-race.test.js). Not a test itself: the
// parent spawns one process per contender and orchestrates the exact
// interleaving through barrier files. Exit 0 = became publisher, exit 2 =
// failed closed as a client (EEXIST), exit 1 = unexpected error.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reservePublisher } from '../../src/edit-lock/reservation.js'

const [directory, barriers, role, selfPid] = process.argv.slice(2)
const pid = Number(selfPid)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(name) {
  const file = join(barriers, name)
  const deadline = Date.now() + 20_000
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout waiting for ${name}`)
    await sleep(5)
  }
}
const signal = name => writeFileSync(join(barriers, `${role}-${name}`), String(process.pid))

/** @param {string} point */
async function checkpoint(point) {
  signal(point)
  await waitFor(`go-${role}-${point}`)
}

try {
  await reservePublisher(directory, {
    liveness: {
      pid, host: 'takeover-race-host',
      identity: async () => ({ osStart: `boot-${pid}`, bootNonce: `nonce-${pid}` }),
      state: async owner => (owner.pid === pid ? 'alive' : 'dead'),
    },
    now: () => 10 ** 9,
    leaseMs: 10_000,
    renewMs: 60_000,
    token: () => role.repeat(24),
    testing: { checkpoint },
  })
  signal('publisher')
  process.exit(0)
} catch (error) {
  if (/** @type {{ code?: string }} */ (error)?.code === 'EEXIST' || String(error).includes('EEXIST')) {
    signal('client')
    process.exit(2)
  }
  console.error(error)
  process.exit(1)
}
