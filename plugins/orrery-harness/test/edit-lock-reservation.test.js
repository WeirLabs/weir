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
