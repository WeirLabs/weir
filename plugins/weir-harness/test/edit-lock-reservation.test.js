import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { reservePublisher } from '../src/edit-lock/reservation.js'

const moduleUrl = new URL('../src/edit-lock/reservation.js', import.meta.url).href
function child(directory) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import {reservePublisher} from ${JSON.stringify(moduleUrl)}; await reservePublisher(${JSON.stringify(directory)})`], {encoding:'utf8', timeout:5000})
}

test('exclusive reservation rejects another process and survives owner exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-reservation-'))
  const owner = await reservePublisher(directory)
  owner.assertExclusive()
  const denied = child(directory)
  assert.equal(denied.status, 1, denied.stderr)
  assert.match(denied.stderr, /EEXIST/)
  owner.releaseAfterQuiescence()
  assert.throws(() => owner.assertExclusive(), /released/)
  const acquired = child(directory)
  assert.equal(acquired.status, 0, acquired.stderr)
  // Process exit does not prove all old publication outcomes are resolved.
  await assert.rejects(reservePublisher(directory), /EEXIST/)
})

test('a runtime that fails to open releases its own reservation, so the same process can retry as publisher', async () => {
  const { openReservedEditLockRuntime } = await import('../src/edit-lock/reserved-runtime.js')
  const { writeFileSync, existsSync, mkdirSync } = await import('node:fs')
  const { reservationPathFor } = await import('../src/edit-lock/reservation.js')
  const base = mkdtempSync(join(tmpdir(), 'weir-reservation-open-'))
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

// --- P1 (openspec edit-lock-autonomous-recovery): owner doc + death-proof reclaim ---

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { parseOwnerDoc } from '../src/capabilities/store/lock.js'
import { reservationPathFor } from '../src/edit-lock/reservation.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
/** @param {number} pid @param {(owner: any) => 'alive'|'dead'|'unknown'} state */
function fakeLiveness(pid, state, osStart = `boot-${pid}`) {
  return {
    pid, host: 'spike-host',
    identity: async () => ({ osStart, bootNonce: `nonce-${pid}` }),
    state: async (/** @type {any} */ owner) => state(owner),
  }
}
/** A reservation exactly as a crash leaves it: directory + owner document,
 * no live holder anywhere. @param {string} directory @param {any} doc */
function strandReservation(directory, doc) {
  const path = reservationPathFor(directory)
  mkdirSync(path, { mode: 0o700 })
  writeFileSync(join(path, 'owner.json'), JSON.stringify(doc))
  return path
}
/** @param {any} over */
const staleDoc = over => ({ schemaVersion: 1, ownerToken: 'a'.repeat(24), pid: 111, host: 'spike-host',
  startIdentity: { osStart: 'boot-111', bootNonce: 'nonce-111' }, acquiredAt: 0, leaseUntil: 100, ...over })

test('owner document is published with the reservation and renewed while held', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-owner-doc-'))
  const clock = { t: 1000 }
  const held = await reservePublisher(directory, { liveness: fakeLiveness(222, () => 'alive'),
    leaseMs: 10_000, renewMs: 40, now: () => clock.t, token: () => 'b'.repeat(24) })
  const file = join(reservationPathFor(directory), 'owner.json')
  const first = parseOwnerDoc(readFileSync(file, 'utf8'))
  assert.equal(first.kind, 'ok')
  assert.deepEqual(first.kind === 'ok' && {
    ownerToken: first.value.ownerToken, pid: first.value.pid, host: first.value.host,
    acquiredAt: first.value.acquiredAt, leaseUntil: first.value.leaseUntil,
    startIdentity: first.value.startIdentity,
  }, { ownerToken: 'b'.repeat(24), pid: 222, host: 'spike-host', acquiredAt: 1000, leaseUntil: 11_000,
    startIdentity: { osStart: 'boot-222', bootNonce: 'nonce-222' } })
  clock.t = 5000
  await sleep(150)
  const renewed = parseOwnerDoc(readFileSync(file, 'utf8'))
  assert.equal(renewed.kind, 'ok')
  assert.equal(renewed.kind === 'ok' && renewed.value.leaseUntil, 15_000)
  assert.equal(held.owner().leaseUntil, 15_000)
  held.releaseAfterQuiescence()
  assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/)
})

test('absent, corrupt or unknown-schema owner document keeps the newcomer a client', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-owner-corrupt-'))
  const held = await reservePublisher(directory, { liveness: fakeLiveness(222, () => 'alive'), leaseMs: 10_000 })
  const file = join(reservationPathFor(directory), 'owner.json')
  for (const content of ['not json', JSON.stringify({ schemaVersion: 99 })]) {
    writeFileSync(file, content)
    await assert.rejects(reservePublisher(directory, { liveness: fakeLiveness(333, () => 'dead'), now: () => 10 ** 9 }), /EEXIST/)
  }
  rmSync(file)
  await assert.rejects(reservePublisher(directory, { liveness: fakeLiveness(333, () => 'dead'), now: () => 10 ** 9 }), /EEXIST/)
  held.assertExclusive()
  held.releaseAfterQuiescence()
})

test('timeout alone never justifies reclamation: expired lease with a live or unknown owner stays a client', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-no-steal-'))
  strandReservation(directory, staleDoc())
  for (const state of [() => /** @type {const} */ ('alive'), () => /** @type {const} */ ('unknown')]) {
    await assert.rejects(reservePublisher(directory, { liveness: fakeLiveness(333, state), now: () => 10 ** 9 }), /EEXIST/)
    assert.equal(parseOwnerDoc(readFileSync(join(reservationPathFor(directory), 'owner.json'), 'utf8')).kind, 'ok')
  }
  rmSync(reservationPathFor(directory), { recursive: true })
})

test('a dead owner with an expired lease is reclaimed through the serialized path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-reclaim-'))
  const stranded = strandReservation(directory, staleDoc())
  const held = await reservePublisher(directory, { liveness: fakeLiveness(333, () => 'dead'), now: () => 10 ** 9, leaseMs: 10_000 })
  held.assertExclusive()
  const current = parseOwnerDoc(readFileSync(join(stranded, 'owner.json'), 'utf8'))
  assert.equal(current.kind === 'ok' && current.value.pid, 333)
  // The old reservation was renamed aside, never deleted blindly.
  assert.ok(readdirSync(dirname(stranded)).some(entry => entry.includes('.publisher-reservation.stale.')))
  // The recovery lock was released after the reclaim.
  assert.ok(!readdirSync(dirname(stranded)).some(entry => entry.endsWith('.recover')))
  held.releaseAfterQuiescence()
})

test('pid reuse ABA: only the start identity decides (mismatch reclaims, match stays client)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-aba-'))
  // The liveness adapter answers what it would for a reused pid: a process
  // exists, but with a different OS start time (death proof) — reclaim.
  strandReservation(directory, staleDoc())
  const reclaimed = await reservePublisher(directory, { liveness: fakeLiveness(333, () => 'dead'), now: () => 10 ** 9, leaseMs: 10_000 })
  reclaimed.releaseAfterQuiescence()
  // Same pid, SAME start identity: the recorded owner is alive — never stolen.
  strandReservation(directory, staleDoc())
  await assert.rejects(reservePublisher(directory, { liveness: fakeLiveness(333, () => 'alive'), now: () => 10 ** 9 }), /EEXIST/)
  rmSync(reservationPathFor(directory), { recursive: true })
})

test('concurrent reclaimers converge on exactly one publisher', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-race-'))
  strandReservation(directory, staleDoc())
  const attempt = pid => reservePublisher(directory, { liveness: fakeLiveness(pid, () => 'dead'), now: () => 10 ** 9, leaseMs: 10_000 })
  const [first, second] = await Promise.allSettled([attempt(444), attempt(555)])
  const won = [first, second].filter(result => result.status === 'fulfilled')
  const lost = [first, second].filter(result => result.status === 'rejected')
  assert.equal(won.length, 1)
  assert.equal(lost.length, 1)
  const reasonText = String(/** @type {any} */ (lost[0]).reason)
  assert.ok(reasonText.includes('EEXIST'), reasonText)
  const winner = /** @type {any} */ (won[0]).value
  winner.releaseAfterQuiescence()
})

test('an interrupted recovery lock is retaken only when its own owner is also proven dead', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-recover-lock-'))
  const reservation = reservationPathFor(directory)
  // A reclaimer that is still alive (or whose lease runs) blocks the reclaim.
  strandReservation(directory, staleDoc())
  mkdirSync(`${reservation}.recover`, { mode: 0o700 })
  writeFileSync(join(`${reservation}.recover`, 'owner.json'), JSON.stringify(staleDoc({ ownerToken: 'c'.repeat(24), pid: 666, leaseUntil: 10 ** 10 })))
  await assert.rejects(reservePublisher(directory, { liveness: fakeLiveness(333, () => 'dead'), now: () => 10 ** 9 }), /EEXIST/)
  // A reclaimer that crashed before moving the reservation: expired lease and
  // dead, so the lock is retaken and the reclaim completes.
  writeFileSync(join(`${reservation}.recover`, 'owner.json'), JSON.stringify(staleDoc({ ownerToken: 'c'.repeat(24), pid: 666 })))
  const held = await reservePublisher(directory, { liveness: fakeLiveness(333, () => 'dead'), now: () => 10 ** 9, leaseMs: 10_000 })
  held.assertExclusive()
  held.releaseAfterQuiescence()
})

test('a renewal that cannot land fails exclusivity closed instead of masquerading as a live lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-renewal-failure-'))
  const held = await reservePublisher(directory, { liveness: fakeLiveness(222, () => 'alive'), leaseMs: 10_000, renewMs: 30 })
  // The reservation is replaced behind the holder's back (a legitimate reclaim).
  rmSync(reservationPathFor(directory), { recursive: true })
  mkdirSync(reservationPathFor(directory), { mode: 0o700 })
  await sleep(120)
  assert.throws(() => held.assertExclusive(), /renewal failed|replaced/)
  rmSync(reservationPathFor(directory), { recursive: true })
})

test('release semantics are unchanged: unexpected contents retain the reservation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weir-release-contents-'))
  const held = await reservePublisher(directory, { liveness: fakeLiveness(222, () => 'alive') })
  writeFileSync(join(reservationPathFor(directory), 'stray'), 'x')
  assert.throws(() => held.releaseAfterQuiescence(), /unexpected contents/)
  // The retained reservation kept its owner document: it stays reclaimable.
  assert.equal(parseOwnerDoc(readFileSync(join(reservationPathFor(directory), 'owner.json'), 'utf8')).kind, 'ok')
  rmSync(join(reservationPathFor(directory), 'stray'))
  held.releaseAfterQuiescence()
  assert.throws(() => held.assertExclusive(), /released/)
})
