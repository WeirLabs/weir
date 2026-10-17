import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneCore } from '../src/worktree/lane-core.js'
import { createLedger, LEDGER_FILE } from '../src/worktree/ledger.js'
import { WORKTREE_CODES, WorktreeError } from '../src/worktree/errors.js'

// Focused unit pin for src/worktree/lane-core.js (change test-surface-pinning,
// task 3.1), previously zero direct test imports. Injected deps replace git,
// notifications, audit, the clock and the timer scheduler; the LEDGER is real
// (atomic file writes are the substrate the transition/watch invariants live
// on). Pins TRANSITIONS legality under the ledger lock and the one-shot watch
// invariants (atomic hit collection, single delivery, silent restart pruning).
// commitBinding is deliberately NOT re-pinned here: worktree-commit.test.js
// covers it through the lanes.js facade.

const BASE_TIME = 1_700_000_000_000

/** @param {any} [overrides] */
function makeDeps(overrides = {}) {
  const clock = { t: BASE_TIME }
  const calls = { notify: [], audit: [], warn: [], timers: new Map(), cleared: [] }
  let timerSeq = 0
  const deps = {
    git: {
      worktreeList: async () => [],
      currentBranch: async () => 'main',
      status: async () => [],
      tree: async () => 'tree-1',
      aheadBehind: async () => ({ ahead: 1, behind: 0 }),
    },
    settings: () => ({ enabled: true, root: '.weir/worktrees', maxActive: 4, autoSetup: true }),
    shellRun: null,
    ask: null,
    notify: (/** @type {string} */ sessionId, /** @type {string} */ text) => calls.notify.push([sessionId, text]),
    audit: (/** @type {string} */ type, /** @type {any} */ data) => calls.audit.push([type, data]),
    modeOf: () => false,
    now: () => clock.t,
    setTimer: (/** @type {() => void} */ handler, /** @type {number} */ delayMs) => {
      const id = `timer-${++timerSeq}`
      calls.timers.set(id, { handler, delayMs })
      return id
    },
    clearTimer: (/** @type {any} */ handle) => { calls.cleared.push(handle); calls.timers.delete(handle) },
    pid: 77777,
    logger: { warn: (/** @type {string} */ m) => calls.warn.push(m) },
    ...overrides,
  }
  return { deps, calls, clock }
}

/** A repo object with a REAL ledger in a throwaway directory (no git plumbing). */
function makeRepoFixture(/** @type {() => number} */ now) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'weir-lane-core-')))
  const ledger = createLedger(dir, { now })
  const repo = { cwd: dir, mainRoot: dir, commonDir: dir, root: '.weir/worktrees', rootPath: dir, ledger, version: [2, 40, 0], unmanaged: [] }
  return { dir, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** @param {string} id @param {string} state @param {any} [extra] */
function laneRecord(id, state, extra = {}) {
  return {
    id, state, path: `/p/${id}`, branch: `lane-${id}`, base: { branch: 'main' },
    ownerSession: 'owner-1', boundChild: null, landableTree: null, baseMoved: false,
    check: { enabled: false, results: [] }, history: [], createdAt: BASE_TIME, updatedAt: BASE_TIME, reason: null,
    ...extra,
  }
}

/** @param {string} id @param {string} laneId @param {number} expiresAt @param {string[]} [states] */
function watchRecord(id, laneId, expiresAt, states = ['landable']) {
  return { id, laneId, sessionId: `sub-${id}`, states, createdAt: BASE_TIME, expiresAt }
}

/** Fire a captured timer handler and flush its fire-and-forget async work. */
async function fireTimer(/** @type {any} */ calls, /** @type {any} */ handle) {
  const entry = calls.timers.get(handle)
  assert.ok(entry, `timer ${handle} was armed`)
  entry.handler()
  // expireWatch's ledger update resolves within microtasks + macrotask turns.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

test('apply performs a legal transition under the ledger lock and audits it', async () => {
  const { deps, calls } = makeDeps()
  const { repo, cleanup } = makeRepoFixture(deps.now)
  try {
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [laneRecord('l1', 'ready')], watches: [] })
    const core = createLaneCore(deps)
    const lane = await core.apply(repo, 'l1', { type: 'bind' })
    assert.equal(lane.state, 'working')
    const stored = repo.ledger.read().lanes.find((/** @type {any} */ l) => l.id === 'l1')
    assert.equal(stored.state, 'working')
    assert.deepEqual(stored.history.at(-1), { from: 'ready', to: 'working', event: 'bind', at: BASE_TIME, by: 'host' })
    assert.deepEqual(calls.audit, [['bind', { lane: 'l1', from: 'ready', to: 'working', event: 'bind', reason: null, by: 'host' }]])
  } finally {
    cleanup()
  }
})

test('apply refuses an illegal transition and leaves the ledger byte-identical', async () => {
  const { deps, calls } = makeDeps()
  const { dir, repo, cleanup } = makeRepoFixture(deps.now)
  try {
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [laneRecord('l1', 'ready')], watches: [] })
    const before = readFileSync(join(dir, LEDGER_FILE), 'utf8')
    const core = createLaneCore(deps)
    await assert.rejects(() => core.apply(repo, 'l1', { type: 'land' }), (/** @type {any} */ error) => {
      assert.ok(error instanceof WorktreeError)
      assert.equal(error.code, WORKTREE_CODES.ILLEGAL_TRANSITION)
      assert.match(error.message, /lane l1 is ready; "land" is only valid from landable, declined, conflicted, awaiting-approval/)
      return true
    })
    assert.equal(readFileSync(join(dir, LEDGER_FILE), 'utf8'), before)
    assert.equal(calls.audit.length, 0)
  } finally {
    cleanup()
  }
})

test('apply refuses an unknown event and an out-of-targets checked outcome', async () => {
  const { deps } = makeDeps()
  const { repo, cleanup } = makeRepoFixture(deps.now)
  try {
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [laneRecord('l1', 'working')], watches: [] })
    const core = createLaneCore(deps)
    await assert.rejects(() => core.apply(repo, 'l1', { type: 'explode' }), /unknown lane event "explode"/)
    await assert.rejects(() => core.apply(repo, 'l1', { type: 'checked', to: 'landed' }), /"checked" needs a target among dirty, no-commits, branch-moved, landable, checking/)
    // The same event with a legal target succeeds and records the reason.
    const lane = await core.apply(repo, 'l1', { type: 'checked', to: 'dirty', reason: '3 uncommitted path(s)' })
    assert.equal(lane.state, 'dirty')
    assert.equal(lane.reason, '3 uncommitted path(s)')
  } finally {
    cleanup()
  }
})

test('apply runs the caller check inside the lock against the pre-transition record', async () => {
  const { deps, calls } = makeDeps()
  const { repo, cleanup } = makeRepoFixture(deps.now)
  try {
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [laneRecord('l1', 'ready')], watches: [] })
    const core = createLaneCore(deps)
    /** @type {string[]} */
    const seen = []
    await assert.rejects(
      () => core.apply(repo, 'l1', { type: 'bind' }, (/** @type {any} */ lane) => {
        seen.push(lane.state)
        throw new WorktreeError(WORKTREE_CODES.LANE_NOT_DISPATCHABLE, 'refused by the caller')
      }),
      /refused by the caller/,
    )
    assert.deepEqual(seen, ['ready'])
    assert.equal(repo.ledger.read().lanes[0].state, 'ready')
    assert.equal(calls.audit.length, 0)
  } finally {
    cleanup()
  }
})

test('laneOf refuses an unknown lane id with UNKNOWN_LANE', async () => {
  const { deps } = makeDeps()
  const { repo, cleanup } = makeRepoFixture(deps.now)
  try {
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [laneRecord('l1', 'ready')], watches: [] })
    const core = createLaneCore(deps)
    assert.throws(() => core.laneOf(repo, 'nope'), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.UNKNOWN_LANE)
      return true
    })
    await assert.rejects(() => core.apply(repo, 'nope', { type: 'bind' }), /no lane "nope"/)
  } finally {
    cleanup()
  }
})

test('a one-shot watch hit is consumed in the same atomic write as the transition', async () => {
  const { deps, calls, clock } = makeDeps()
  const { repo, cleanup } = makeRepoFixture(deps.now)
  try {
    const watch = watchRecord('w1', 'l1', clock.t + 60_000)
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [laneRecord('l1', 'checking')], watches: [watch] })
    const core = createLaneCore(deps)
    core.armWatch(repo, watch)
    assert.equal(calls.timers.size, 1)
    const [handle] = [...calls.timers.keys()]

    const lane = await core.apply(repo, 'l1', { type: 'check-pass' })
    assert.equal(lane.state, 'landable')
    // The watch is gone from the ledger in the same write — a concurrent
    // instance collecting after this point sees nothing.
    assert.equal(repo.ledger.read().watches.length, 0)
    assert.equal(calls.notify.length, 1)
    assert.equal(calls.notify[0][0], 'sub-w1')
    assert.match(calls.notify[0][1], /watch hit: lane l1 reached landable/)
    // The expiry timer for the consumed watch is disarmed.
    assert.deepEqual(calls.cleared, [handle])
    assert.equal(calls.timers.size, 0)

    // One-shot: re-entering the watched state later does not notify again.
    await core.apply(repo, 'l1', { type: 'invalidate' })
    await core.apply(repo, 'l1', { type: 'checked', to: 'checking' })
    await core.apply(repo, 'l1', { type: 'check-pass' })
    assert.equal(repo.ledger.read().lanes[0].state, 'landable')
    assert.equal(calls.notify.length, 1)
  } finally {
    cleanup()
  }
})

test('a watch on other states survives an unrelated transition', async () => {
  const { deps, calls, clock } = makeDeps()
  const { repo, cleanup } = makeRepoFixture(deps.now)
  try {
    const watch = watchRecord('w1', 'l1', clock.t + 60_000, ['abandoned'])
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [laneRecord('l1', 'checking')], watches: [watch] })
    const core = createLaneCore(deps)
    await core.apply(repo, 'l1', { type: 'check-pass' })
    assert.deepEqual(repo.ledger.read().watches, [watch])
    assert.equal(calls.notify.length, 0)
  } finally {
    cleanup()
  }
})

test('watch expiry delivers exactly once across service instances (ledger-lock arbitration)', async () => {
  const clock = { t: BASE_TIME }
  const shared = makeDeps({ now: () => clock.t })
  const second = makeDeps({ now: () => clock.t })
  const { repo, cleanup } = makeRepoFixture(() => clock.t)
  try {
    const watch = watchRecord('w1', 'l1', clock.t + 60_000)
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [laneRecord('l1', 'checking')], watches: [watch] })
    const coreA = createLaneCore(shared.deps)
    const coreB = createLaneCore(second.deps)
    coreA.armWatch(repo, watch)
    coreB.armWatch(repo, watch)
    const [handleA] = [...shared.calls.timers.keys()]
    const [handleB] = [...second.calls.timers.keys()]
    assert.equal(shared.calls.timers.get(handleA).delayMs, 60_000)
    assert.equal(second.calls.timers.get(handleB).delayMs, 60_000)

    clock.t += 60_000 // the deadline arrives; both instances' timers fire
    await fireTimer(shared.calls, handleA)
    assert.equal(repo.ledger.read().watches.length, 0)
    assert.equal(shared.calls.notify.length, 1)
    assert.match(shared.calls.notify[0][1], /watch expired: lane l1 did not reach landable within the watch timeout/)
    assert.deepEqual(shared.calls.audit.map(([type, data]) => [type, data.outcome]), [['watch', 'expired']])

    // The loser of the lock sees the record already gone: no second delivery.
    await fireTimer(second.calls, handleB)
    assert.equal(second.calls.notify.length, 0)
    assert.equal(second.calls.audit.length, 0)
    assert.equal(shared.calls.notify.length, 1)
  } finally {
    cleanup()
  }
})

test('the expiry re-check inside the lock ignores a timer that fired before the deadline', async () => {
  const { deps, calls, clock } = makeDeps()
  const { repo, cleanup } = makeRepoFixture(deps.now)
  try {
    const watch = watchRecord('w1', 'l1', clock.t + 60_000)
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [laneRecord('l1', 'checking')], watches: [watch] })
    const core = createLaneCore(deps)
    core.armWatch(repo, watch)
    const [handle] = [...calls.timers.keys()]
    // Clock NOT advanced: the in-lock re-check (expiresAt > at) refuses removal.
    await fireTimer(calls, handle)
    assert.deepEqual(repo.ledger.read().watches, [watch])
    assert.equal(calls.notify.length, 0)
    assert.equal(calls.audit.length, 0)
  } finally {
    cleanup()
  }
})

test('armWatch is idempotent per watch and never arms an already-expired entry', async () => {
  const { deps, calls, clock } = makeDeps()
  const { repo, cleanup } = makeRepoFixture(deps.now)
  try {
    const core = createLaneCore(deps)
    const live = watchRecord('w1', 'l1', clock.t + 60_000)
    core.armWatch(repo, live)
    core.armWatch(repo, live)
    assert.equal(calls.timers.size, 1)
    core.armWatch(repo, watchRecord('w2', 'l1', clock.t - 1))
    assert.equal(calls.timers.size, 1)
  } finally {
    cleanup()
  }
})

test('refresh prunes host-down expired watches silently and arms live ones', async () => {
  const { deps, calls, clock } = makeDeps()
  const { repo, cleanup } = makeRepoFixture(deps.now)
  try {
    const expired = watchRecord('w-old', 'l1', clock.t - 1_000)
    const live = watchRecord('w-live', 'l1', clock.t + 60_000)
    await repo.ledger.replace({ schemaVersion: 1, seq: 0, lanes: [], watches: [expired, live] })
    const core = createLaneCore(deps)
    const outcome = await core.refresh(repo)
    assert.equal(outcome.mainBranch, 'main')
    // Expired-while-down: removed and audited as pruned, NEVER delivered.
    assert.deepEqual(repo.ledger.read().watches, [live])
    assert.deepEqual(calls.audit.map(([type, data]) => [type, data.outcome]), [['watch', 'pruned']])
    assert.equal(calls.notify.length, 0)
    // The live watch got this instance's expiry timer.
    assert.equal(calls.timers.size, 1)
    const [, entry] = [...calls.timers.entries()][0]
    assert.equal(entry.delayMs, 60_000)
  } finally {
    cleanup()
  }
})
