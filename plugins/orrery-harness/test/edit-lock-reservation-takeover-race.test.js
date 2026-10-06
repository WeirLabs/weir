import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reservePublisher, reservationPathFor } from '../src/edit-lock/reservation.js'
import { parseOwnerDoc } from '../src/capabilities/store/lock.js'

// Regression for the P1 review finding on the crash-self-heal reclaim path:
// two processes observe the SAME abandoned recovery lock; one takes it over
// and is paused by the OS immediately before renaming the main reservation
// aside. The second process must NOT be able to act on its stale observation
// — rename the first process's LIVE recovery lock aside, publish its own
// reservation, and thereby hand the first process a live publisher's
// reservation to rename. Recovery-lock ownership must stay genuinely
// exclusive for the whole takeover → replacement → cleanup sequence.

const childScript = fileURLToPath(new URL('./helpers/reservation-reclaim-child.js', import.meta.url))
// Unref'd: a losing Promise.race branch must never hold the event loop open.
const sleep = ms => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/** A reservation exactly as a crash leaves it: directory + owner document,
 * no live holder anywhere. @param {string} directory @param {any} doc */
function strand(directory, doc) {
  const path = reservationPathFor(directory)
  mkdirSync(path, { mode: 0o700 })
  writeFileSync(join(path, 'owner.json'), JSON.stringify(doc))
  return path
}
/** @param {any} over */
const deadDoc = over => ({ schemaVersion: 1, ownerToken: 'd'.repeat(24), pid: 111, host: 'takeover-race-host',
  startIdentity: { osStart: 'boot-111', bootNonce: 'nonce-111' }, acquiredAt: 0, leaseUntil: 100, ...over })

/** @param {string} file */
async function waitFor(file, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${file}`)
    await sleep(5)
  }
}

/** The crash-shaped starting point: a stranded dead publisher reservation
 * plus the abandoned recovery lock of an interrupted earlier reclaim that
 * never moved the reservation. @param {string} base */
function crashSite(base) {
  const directory = join(base, 'authority')
  mkdirSync(directory)
  const reservation = strand(directory, deadDoc({ ownerToken: 'd'.repeat(24), pid: 111 }))
  mkdirSync(`${reservation}.recover`, { mode: 0o700 })
  writeFileSync(join(`${reservation}.recover`, 'owner.json'), JSON.stringify(deadDoc({ ownerToken: 'e'.repeat(24), pid: 666 })))
  return { directory, reservation }
}

/** @param {string} directory @param {'a'|'b'} role @param {number} pid */
const attempt = (directory, role, pid, checkpoint) => reservePublisher(directory, {
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

test('multi-process: a concurrent takeover cannot reclaim a live publisher mid-takeover', async () => {
  const base = mkdtempSync(join(tmpdir(), 'orrery-takeover-race-'))
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = []
  try {
    const { directory, reservation } = crashSite(base)
    const barriers = join(base, 'barriers')
    mkdirSync(barriers)
    /** @param {'a'|'b'} role */
    const run = role => {
      const child = spawn(process.execPath, [childScript, directory, barriers, role, role === 'a' ? '444' : '555'],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
      children.push(child)
      return { exit: new Promise(resolve => child.on('exit', code => resolve({ code, output }))) }
    }
    const a = run('a')
    const b = run('b')

    // Both processes observe the SAME abandoned recovery lock (and pass its
    // death proof) before either is allowed to act on the observation.
    await waitFor(join(barriers, 'a-takeover-observed'))
    await waitFor(join(barriers, 'b-takeover-observed'))
    // A takes the recovery lock over, publishes its owner document into it,
    // and is paused by the OS immediately before renaming the main
    // reservation aside — the exact interleaving from the finding.
    writeFileSync(join(barriers, 'go-a-takeover-observed'), '')
    await waitFor(join(barriers, 'a-before-reservation-rename'))
    // B resumes with its stale observation. It must fail closed as a client;
    // reaching the reservation rename means it renamed A's LIVE recovery
    // lock aside and serialized nothing.
    writeFileSync(join(barriers, 'go-b-takeover-observed'), '')
    const steal = await Promise.race([
      waitFor(join(barriers, 'b-before-reservation-rename')).then(() => true),
      waitFor(join(barriers, 'b-client')).then(() => false),
    ])
    // A resumes and completes the reclaim it alone serialized. (If B stole,
    // let the split-brain play out so the assertions below fail on evidence.)
    writeFileSync(join(barriers, 'go-a-before-reservation-rename'), '')
    if (steal) writeFileSync(join(barriers, 'go-b-before-reservation-rename'), '')
    const [exitA, exitB] = await Promise.all([a.exit, b.exit])

    assert.equal(steal, false, 'second process reached the reservation rename while A held the recovery lock')
    assert.equal(exitA.code, 0, exitA.output)
    assert.equal(exitB.code, 2, exitB.output)
    assert.ok(existsSync(join(barriers, 'a-publisher')))
    assert.ok(existsSync(join(barriers, 'b-client')))
    // The reservation names exactly A; the abandoned recovery lock was moved
    // aside exactly once (by A) and the serialization lock was cleaned up.
    const owner = parseOwnerDoc(readFileSync(join(reservation, 'owner.json'), 'utf8'))
    assert.equal(owner.kind, 'ok')
    assert.equal(owner.kind === 'ok' && owner.value.ownerToken, 'a'.repeat(24))
    const siblings = readdirSync(dirname(reservation))
    assert.equal(siblings.filter(entry => entry.endsWith('.recover')).length, 0)
    assert.equal(siblings.filter(entry => entry.includes('.recover.stale.')).length, 1)
    assert.equal(siblings.filter(entry => entry.includes('.publisher-reservation.stale.')).length, 1)
  } finally {
    for (const child of children) child.kill('SIGKILL')
    rmSync(base, { recursive: true, force: true })
  }
})

test('in-process: a stale recovery-lock observation loses the takeover instead of stealing it', async () => {
  const base = mkdtempSync(join(tmpdir(), 'orrery-takeover-race-ip-'))
  try {
    const { directory, reservation } = crashSite(base)
    // Promise gates on the same checkpoints the multi-process test uses;
    // both contenders run in THIS process with distinct fake pids.
    /** @type {string[]} */
    const seen = []
    /** @type {Map<string, () => void>} */
    const gates = new Map()
    /** @param {string} name @returns {Promise<void>} */
    const gate = name => new Promise(resolve => gates.set(`${name}`, () => resolve()))
    /** @param {string} name */
    const open = name => {
      const release = gates.get(name)
      assert.ok(release, `gate ${name} was never armed`)
      release()
    }
    /** @param {string} role @param {string} point */
    const park = async (role, point) => {
      seen.push(`${role}:${point}`)
      await gate(`${role}:${point}`)
    }
    /** @param {() => boolean} condition */
    const waitUntil = async condition => {
      const deadline = Date.now() + 30_000
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timeout; progress so far: ${seen.join(', ')}`)
        await sleep(1)
      }
    }

    const a = attempt(directory, 'a', 444, point => park('a', point))
    /** @type {{ ok: boolean, value?: any, error?: any }|null} */
    let bSettled = null
    const b = attempt(directory, 'b', 555, point => park('b', point))
    const bTracked = b.then(
      value => { bSettled = { ok: true, value } },
      error => { bSettled = { ok: false, error } })

    await waitUntil(() => seen.includes('a:takeover-observed') && seen.includes('b:takeover-observed'))
    open('a:takeover-observed')
    await waitUntil(() => seen.includes('a:before-reservation-rename'))
    open('b:takeover-observed')
    await waitUntil(() => bSettled !== null || seen.includes('b:before-reservation-rename'))

    if (bSettled === null) {
      // The steal: B reached the reservation rename while A held the lock.
      open('b:before-reservation-rename')
      await bTracked
      open('a:before-reservation-rename')
      await a.then(() => {}, () => {}) // drain either outcome
      assert.fail('stale observation renamed a LIVE recovery lock aside and reached the reservation rename')
    }
    assert.equal(bSettled.ok, false, 'B must fail closed, never publish')
    assert.match(String(/** @type {any} */ (bSettled).error), /EEXIST/)
    open('a:before-reservation-rename')
    const held = await a
    held.assertExclusive()
    const owner = parseOwnerDoc(readFileSync(join(reservation, 'owner.json'), 'utf8'))
    assert.equal(owner.kind === 'ok' && owner.value.ownerToken, 'a'.repeat(24))
    const siblings = readdirSync(dirname(reservation))
    assert.equal(siblings.filter(entry => entry.endsWith('.recover')).length, 0)
    assert.equal(siblings.filter(entry => entry.includes('.recover.stale.')).length, 1)
    held.releaseAfterQuiescence()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
