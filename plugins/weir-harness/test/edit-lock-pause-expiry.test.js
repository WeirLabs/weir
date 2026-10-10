import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { localDomain } from '../src/edit-lock/domain.js'
import { createRecoveryDriver } from '../src/edit-lock/recovery.js'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'

const MINUTE = 60_000
const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }

async function fixture() {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-pause-expiry-')))
  const ceiling = realpathSync.native(tmpdir()) + sep
  assert.ok(base.startsWith(ceiling) && base.split(sep).at(-1).startsWith('weir-pause-expiry-'))
  const root = join(base, 'work'), directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'unchanged')
  const open = mode => openEditLockRuntime({ directory, root, domainId: 'd', mode, fs: stubFs, assertExclusive() {} })
  return { base, root, directory, open, file: { filePath: 'a.txt', cwd: root } }
}

function clockedDriver(domain) {
  let now = 1_000_000
  const timers = [], followups = [], notices = [], reads = []
  const observed = { ...domain, async status(agent) { reads.push(now); return domain.status(agent) } }
  const driver = createRecoveryDriver({ domainFor: () => observed,
    followup: (_agent, text) => followups.push(text), notify: (_agent, text) => notices.push(text),
    now: () => now,
    setTimer(fn, ms) { const timer = { at: now + ms, ms, fn, cancelled: false, fired: false }; timers.push(timer); return timer },
    clearTimer(timer) { timer.cancelled = true },
  })
  async function advance(ms) {
    now += ms
    for (const timer of timers.filter(item => !item.cancelled && !item.fired && item.at <= now)) {
      timer.fired = true
      timer.fn()
    }
  }
  async function until(condition) {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.ok(condition(), 'timer-triggered recovery did not settle')
  }
  return { driver, advance, until, timers, followups, notices, reads, current: () => now }
}

test('15-minute expiry re-checks abnormal ownership without release or extension; 30-minute budget survives restart', async t => {
  const { base, open, file } = await fixture()
  const runtime = await open('create')
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  /** @type {ReturnType<typeof createEditLockLifecycle> | undefined} */
  let resumed
  t.after(async () => { if (resumed) await resumed.close(); await lifecycle.close(); assert.equal(realpathSync.native(base), base); await rm(base, { recursive: true, force: true }) })
  const domain = localDomain(lifecycle)
  const holder = { id: 'holder' }, requester = { id: 'requester' }
  await lifecycle.start(holder)
  await lifecycle.start(requester)
  await lifecycle.service.acquire({ agent: holder }, file)
  const original = lifecycle.status(holder).locks[0]
  const clock = clockedDriver(domain)
  await clock.driver.onTurnEnd(holder, { kind: 'error', error: { code: 'provider_error', message: 'unavailable' } })
  assert.equal(lifecycle.status(holder).state, 'recovering')
  assert.equal(lifecycle.status(holder).locks[0].status, 'abnormal')
  assert.equal(clock.timers[0].ms, 15_000)
  await assert.rejects(clock.driver.pause(holder, 16), /15 minutes/)
  assert.equal(lifecycle.recoveryUsage(holder).pauseMs, 0)
  const first = await clock.driver.pause(holder, 15)
  assert.deepEqual(first, { pausedMs: 15 * MINUTE, cumulativePauseMs: 15 * MINUTE })
  assert.equal(clock.timers[0].cancelled, true)
  assert.deepEqual(clock.driver.state(holder), { pausedUntil: clock.current() + 15 * MINUTE })
  await clock.advance(15 * MINUTE - 1)
  assert.equal(clock.reads.length, 0)
  assert.deepEqual(lifecycle.status(holder).locks.map(({ owner, generation, status }) => ({ owner, generation, status })),
    [{ owner: original.owner, generation: original.generation, status: 'abnormal' }])
  await clock.advance(1)
  await clock.until(() => clock.followups.length === 1)
  assert.equal(clock.reads.length, 1)
  assert.match(clock.followups[0], /cleanup-only recovery \(attempt 1 of 3\)/)
  assert.equal(clock.driver.state(holder).pausedUntil, null)
  assert.deepEqual(lifecycle.recoveryUsage(holder), { sessionId: 'holder', attempts: 1, elapsedMs: 0, pauseMs: 15 * MINUTE })
  await assert.rejects(lifecycle.service.acquire({ agent: requester }, file), /owned/)

  const second = await clock.driver.pause(holder, 15)
  assert.deepEqual(second, { pausedMs: 15 * MINUTE, cumulativePauseMs: 30 * MINUTE })
  await assert.rejects(clock.driver.pause(holder, 1), /cumulative pause budget exhausted/)
  assert.equal(clock.driver.state(holder).pausedUntil, clock.current() + 15 * MINUTE)
  await clock.advance(15 * MINUTE)
  await clock.until(() => clock.followups.length === 2)
  assert.equal(clock.reads.length, 2)
  assert.equal(clock.driver.state(holder).pausedUntil, null)
  assert.deepEqual(lifecycle.recoveryUsage(holder), { sessionId: 'holder', attempts: 2, elapsedMs: 0, pauseMs: 30 * MINUTE })
  assert.deepEqual(lifecycle.status(holder).locks.map(({ owner, generation, status }) => ({ owner, generation, status })),
    [{ owner: original.owner, generation: original.generation, status: 'abnormal' }])
  assert.deepEqual(lifecycle.status(requester).locks, [])
  await assert.rejects(lifecycle.service.acquire({ agent: requester }, file), /owned/)
  clock.driver.close()
  await lifecycle.close()

  const restored = await open('recover')
  resumed = createEditLockLifecycle(restored, agent => agent.id)
  const sameSession = { id: 'holder' }
  assert.equal(await resumed.start(sameSession), 'interrupted')
  assert.equal(resumed.recoveryUsage(sameSession).pauseMs, 30 * MINUTE)
  assert.equal(resumed.status(sameSession).locks[0].generation, original.generation)
  await resumed.resume(sameSession, 'human-continue')
  await resumed.classifyAbnormal(sameSession, 'provider-error')
  assert.equal(resumed.status(sameSession).state, 'recovering')
  await assert.rejects(resumed.pause(sameSession, 1), /cumulative pause budget exhausted/)
  t.diagnostic(`two expiry rechecks: owner=${original.owner} generation=${original.generation}, pauseBudget=30m, restart refused extra minute`)
})

test('expiry re-checks an explicitly released abnormal lock and ends recovery without a new turn', async t => {
  const { base, open, file } = await fixture()
  const runtime = await open('create')
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  t.after(async () => { await lifecycle.close(); assert.equal(realpathSync.native(base), base); await rm(base, { recursive: true, force: true }) })
  const agent = { id: 'holder' }
  await lifecycle.start(agent)
  await lifecycle.service.acquire({ agent }, file)
  const clock = clockedDriver(localDomain(lifecycle))
  await clock.driver.onTurnEnd(agent, { kind: 'error' })
  await clock.driver.pause(agent, 1)
  assert.equal(lifecycle.status(agent).locks.length, 1)
  await lifecycle.service.release({ agent }, file) // An explicit owner action, not pause expiry.
  await clock.advance(MINUTE)
  await clock.until(() => clock.notices.some(text => /cleanup complete/.test(text)))
  assert.equal(clock.reads.length, 1)
  assert.equal(clock.followups.length, 0)
  assert.equal(clock.driver.state(agent), null)
  assert.equal(lifecycle.recoveryUsage(agent).pauseMs, MINUTE)
  clock.driver.close()
})
