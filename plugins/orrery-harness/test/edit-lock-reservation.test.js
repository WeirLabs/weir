import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { reservePublisher } from '../src/edit-lock/reservation.js'

const moduleUrl = new URL('../src/edit-lock/reservation.js', import.meta.url).href
function child(directory) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import {reservePublisher} from ${JSON.stringify(moduleUrl)}; reservePublisher(${JSON.stringify(directory)})`], {encoding:'utf8', timeout:5000})
}

test('exclusive reservation rejects another process and survives owner exit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orrery-reservation-'))
  const owner = reservePublisher(directory)
  owner.assertExclusive()
  const denied = child(directory)
  assert.equal(denied.status, 1, denied.stderr)
  assert.match(denied.stderr, /EEXIST/)
  owner.releaseAfterQuiescence()
  assert.throws(() => owner.assertExclusive(), /released/)
  const acquired = child(directory)
  assert.equal(acquired.status, 0, acquired.stderr)
  // Process exit does not prove all old publication outcomes are resolved.
  assert.throws(() => reservePublisher(directory), /EEXIST/)
})

test('a runtime that fails to open releases its own reservation, so the same process can retry as publisher', async () => {
  const { openReservedEditLockRuntime } = await import('../src/edit-lock/reserved-runtime.js')
  const { writeFileSync, existsSync, mkdirSync } = await import('node:fs')
  const { reservationPathFor } = await import('../src/edit-lock/reservation.js')
  const base = mkdtempSync(join(tmpdir(), 'orrery-reservation-open-'))
  const directory = join(base, 'authority')
  mkdirSync(directory)
  // An unreadable authority image: recover must fail after the reservation is taken.
  writeFileSync(join(directory, 'snapshot.json'), 'not json')
  const open = () => openReservedEditLockRuntime({ directory, root: base, domainId: base, mode: 'recover', fs: {} })
  await assert.rejects(open())
  assert.equal(existsSync(reservationPathFor(directory)), false)
  // The incident: a second attempt used to hit its own stale reservation (EEXIST)
  // and fall back to a client of a publisher that never existed.
  await assert.rejects(open(), (error) => !/EEXIST/.test(String(error?.message)))
})
