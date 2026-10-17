import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneCore } from '../src/worktree/lane-core.js'
import { createLaneViews } from '../src/worktree/lane-views.js'
import { WORKTREE_CODES } from '../src/worktree/errors.js'

// Focused unit pin for src/worktree/lane-views.js (change test-surface-pinning,
// task 3.2), previously zero direct test imports: the READ-ONLY view seam —
// actionsFor's per-state enable/disable reasons, view()'s availability faces
// and row shape, the cold-read overrides, board/summaryOf caching semantics.
// Mock git + real ledger; the facade suite (worktree-lanes.test.js) is
// untouched.

const BASE_TIME = 1_700_000_000_000

function makeWorld(/** @type {any} */ [gitOverrides, depOverrides] = [{}, {}]) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'weir-lane-views-')))
  const rootPath = join(dir, '.weir', 'worktrees')
  const clock = { t: BASE_TIME }
  const calls = { notify: [], audit: [], diff: [] }
  const git = {
    version: async () => [2, 43, 0],
    supported: () => true,
    repoOf: async () => ({ mainRoot: dir, commonDir: join(dir, '.git') }),
    worktreeList: async () => git._worktrees,
    _worktrees: /** @type {any[]} */ ([]),
    currentBranch: async () => 'main',
    tree: async () => 'tree-1',
    branchExists: async () => true,
    aheadBehind: async () => ({ ahead: 3, behind: 1 }),
    diffStat: async () => ({ files: 2, added: 10, removed: 4 }),
    diff: async (/** @type {any} */ ...args) => { calls.diff.push(args); return 'diff-body' },
    ...gitOverrides,
  }
  const deps = {
    git,
    settings: () => ({ enabled: true, root: '.weir/worktrees', maxActive: 4, autoSetup: true }),
    shellRun: null,
    ask: null,
    notify: (/** @type {string} */ sessionId, /** @type {string} */ text) => calls.notify.push([sessionId, text]),
    audit: (/** @type {string} */ type, /** @type {any} */ data) => calls.audit.push([type, data]),
    modeOf: () => false,
    now: () => clock.t,
    pid: 77777,
    logger: { warn: () => {} },
    ...depOverrides,
  }
  const core = createLaneCore(deps)
  const views = createLaneViews(core)
  const session = { id: 's-main', header: { cwd: dir } }
  return { dir, rootPath, clock, calls, git, deps, core, views, session, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Seed one lane (with a real worktree dir) and return the stored record. */
async function seedLane(/** @type {any} */ world, /** @type {string} */ id, /** @type {string} */ state, /** @type {any} */ extra = {}) {
  const repo = await world.core.repoFor(world.session.header.cwd)
  const lanePath = join(world.rootPath, id)
  mkdirSync(lanePath, { recursive: true })
  const lane = {
    id, title: `title ${id}`, path: lanePath, branch: `weir/${id}`, base: { branch: 'main', commit: 'commit-1' },
    scope: [], state, ownerSession: world.session.id, boundChild: null, baseMoved: false,
    landableTree: null, setup: { status: 'none' }, check: null, land: null, cleanup: null,
    reason: null, createdAt: BASE_TIME, updatedAt: BASE_TIME, history: [], ...extra,
  }
  const ledger = repo.ledger.read()
  await repo.ledger.replace({ ...ledger, lanes: [...ledger.lanes, lane] })
  world.git._worktrees.push({ path: lanePath, branch: lane.branch })
  return lane
}

test('actionsFor derives the per-state enable matrix with refusal reasons', async () => {
  const world = makeWorld()
  try {
    const { actionsFor } = world.views
    const lane = (/** @type {string} */ state, /** @type {any} */ extra = {}) => ({ id: 'l1', state, path: '/p/l1', branch: 'weir/l1', base: { branch: 'main' }, boundChild: null, ...extra })

    const preparing = actionsFor(lane('preparing'))
    assert.deepEqual(preparing.diff, { enabled: false, reason: 'setup is still running' })
    assert.deepEqual(preparing.check, { enabled: false, reason: 'not available while preparing' })
    assert.deepEqual(preparing.land, { enabled: false, reason: 'only a landable lane can be merged (now preparing)' })
    assert.deepEqual(preparing.setup, { enabled: false, reason: 'setup only reruns after a failure' })
    assert.deepEqual(preparing.abandon, { enabled: true })
    assert.deepEqual(preparing.copyPath, { enabled: true })

    const bound = actionsFor(lane('working', { boundChild: 'child-1' }))
    assert.deepEqual(bound.check, { enabled: false, reason: 'a worker is running in this lane' })
    assert.deepEqual(bound.abandon, { enabled: false, reason: 'a worker is running in this lane' })

    const moved = actionsFor(lane('landable', { baseMoved: true }))
    assert.deepEqual(moved.land, { enabled: false, reason: 'the main worktree is not on main' })
    assert.deepEqual(actionsFor(lane('landable')).land, { enabled: true })
    assert.deepEqual(actionsFor(lane('conflicted')).land, { enabled: true })

    assert.deepEqual(actionsFor(lane('setup-failed')).setup, { enabled: true })
    assert.deepEqual(actionsFor(lane('landed')).clean, { enabled: true })
    assert.deepEqual(actionsFor(lane('landed')).abandon, { enabled: false, reason: 'already landed' })
    assert.deepEqual(actionsFor(lane('kept')).clean, { enabled: true })

    const cleaned = actionsFor(lane('cleaned'))
    assert.deepEqual(cleaned.clean, { enabled: false, reason: 'cleanup applies after merging' })
    assert.deepEqual(cleaned.copyPath, { enabled: false, reason: 'the worktree was removed' })
    assert.deepEqual(cleaned.abandon, { enabled: false, reason: 'already cleaned' })

    // An abandoned lane whose cleanup kept the worktree still exists on disk.
    const abandonedKept = actionsFor(lane('abandoned', { cleanup: { mode: 'keep' } }))
    assert.deepEqual(abandonedKept.copyPath, { enabled: true })
    assert.deepEqual(abandonedKept.clean, { enabled: true })
    const abandonedRemoved = actionsFor(lane('abandoned', { cleanup: { mode: 'all' } }))
    assert.deepEqual(abandonedRemoved.copyPath, { enabled: false, reason: 'the worktree was removed' })
    assert.deepEqual(abandonedRemoved.clean, { enabled: false, reason: 'cleanup applies after merging' })
  } finally {
    world.cleanup()
  }
})

test('view reports unavailability with the typed error face and honors cold-read overrides', async () => {
  const world = makeWorld()
  try {
    // No working directory: NOT_A_REPO from cwdOf.
    const noCwd = await world.views.view({ id: 's-x' })
    assert.equal(noCwd.available, false)
    assert.equal(noCwd.error.code, WORKTREE_CODES.NOT_A_REPO)
    assert.equal(noCwd.mode, false)
    assert.equal(noCwd.approveMode, 'manual') // approveModeOf absent → fail-safe manual

    // Cold-read overrides replace the live projection/settings reads.
    const cold = await world.views.view({ id: 's-x' }, { mode: true, approve: 'auto-keep', approveSource: 'session' })
    assert.equal(cold.available, false)
    assert.equal(cold.mode, true)
    assert.equal(cold.approveMode, 'auto-keep')
    assert.equal(cold.approveModeSource, 'session')

    // A non-WorktreeError failure degrades to code ERROR with the message.
    const broken = makeWorld([{ version: async () => { throw new Error('git exploded') } }])
    try {
      const face = await broken.views.view(broken.session)
      assert.equal(face.available, false)
      assert.deepEqual(face.error, { code: 'ERROR', message: 'git exploded' })
    } finally {
      broken.cleanup()
    }

    // Disabled feature: WORKTREE_DISABLED.
    const disabled = makeWorld([{}, { settings: () => ({ enabled: false, root: '.weir/worktrees', maxActive: 4, autoSetup: true }) }])
    try {
      const face = await disabled.views.view(disabled.session)
      assert.equal(face.available, false)
      assert.equal(face.error.code, WORKTREE_CODES.WORKTREE_DISABLED)
    } finally {
      disabled.cleanup()
    }
  } finally {
    world.cleanup()
  }
})

test('view renders lane rows newest-first with counts, watches, actions and the repo block', async () => {
  const world = makeWorld([{}, { modeOf: () => true, approveModeOf: () => 'auto-clean', approveModeSourceOf: () => 'session' }])
  try {
    const history = Array.from({ length: 15 }, (_, index) => ({ from: 'ready', to: 'working', event: 'bind', at: BASE_TIME + index, by: 'host' }))
    await seedLane(world, 'l1', 'working', { history })
    await seedLane(world, 'l2', 'landable', { landableTree: 'tree-1', ownerSession: 's-other' })
    const repo = await world.core.repoFor(world.dir)
    await repo.ledger.update((/** @type {any} */ ledger) => {
      ledger.watches.push({ id: 'w1', laneId: 'l1', sessionId: 's-sub', states: ['landable'], createdAt: BASE_TIME, expiresAt: BASE_TIME + 60_000 })
      return { ledger }
    })
    const result = await world.views.view(world.session)
    assert.equal(result.available, true)
    assert.equal(result.mode, true)
    assert.equal(result.approveMode, 'auto-clean')
    assert.equal(result.approveModeSource, 'session')
    assert.deepEqual(result.ownedBySession, ['l1'])
    // Newest first.
    assert.deepEqual(result.lanes.map((/** @type {any} */ lane) => lane.id), ['l2', 'l1'])
    const [l2, l1] = result.lanes
    assert.equal(l2.ahead, 3)
    assert.equal(l2.behind, 1)
    assert.deepEqual(l2.stat, { files: 2, added: 10, removed: 4 })
    assert.equal(l2.exists, true)
    assert.equal(l2.transient, false)
    assert.deepEqual(l2.actions.land, { enabled: true })
    assert.equal(l1.transient, true)
    assert.equal(l1.watchCount, 1)
    assert.deepEqual(l1.watchStates, ['landable'])
    // History is capped at the latest 12 entries.
    assert.equal(l1.history.length, 12)
    assert.equal(l1.history[0].at, BASE_TIME + 3)
    assert.deepEqual(l1.next, { tool: 'worktree_check', args: { lane: 'l1' }, hint: 'no worker is bound; check the lane' })
    assert.equal(result.repo.branch, 'main')
    assert.equal(result.repo.gitVersion, '2.43.0')
    assert.equal(result.repo.verification.enabled, false)
    assert.deepEqual(result.repo.verification.commands, [])
    assert.deepEqual(result.unmanaged, [])
  } finally {
    world.cleanup()
  }
})

test('view cold-read overrides win over the live reads on the available path', async () => {
  const world = makeWorld([{}, { modeOf: () => true, approveModeOf: () => 'auto-clean' }])
  try {
    await seedLane(world, 'l1', 'working')
    const result = await world.views.view(world.session, { mode: false, approve: 'manual', approveSource: 'global' })
    assert.equal(result.available, true)
    assert.equal(result.mode, false)
    assert.equal(result.approveMode, 'manual')
    assert.equal(result.approveModeSource, 'global')
  } finally {
    world.cleanup()
  }
})

test('view declines an orphan approval card during the read path reconciliation', async () => {
  const world = makeWorld()
  try {
    // awaiting-approval with a dead asking pid: refresh (reused by the read
    // path) declines the orphan card instead of leaving it waiting forever.
    await seedLane(world, 'l1', 'awaiting-approval', { asking: { pid: 999983, at: BASE_TIME } })
    const result = await world.views.view(world.session)
    const [lane] = result.lanes
    assert.equal(lane.state, 'declined')
    assert.match(lane.reason ?? '', /the approval card was closed before an answer/)
    assert.deepEqual(world.calls.audit.map((/** @type {any[]} */ [type, data]) => [type, data.event]), [['decline', 'decline']])
  } finally {
    world.cleanup()
  }
})

test('view tolerates a throwing projection reader (safeMode fails closed)', async () => {
  const world = makeWorld([{}, { modeOf: () => { throw new Error('projection gone') } }])
  try {
    // safeMode is internal to the views module; its fail-closed behavior is
    // observable through the view face.
    const face = await world.views.view({ id: 's-x' })
    assert.equal(face.mode, false)
    const broken = makeWorld([{}, { modeOf: () => true }])
    try {
      const modal = await broken.views.view({ id: 's-x' })
      assert.equal(modal.mode, true)
    } finally {
      broken.cleanup()
    }
  } finally {
    world.cleanup()
  }
})

test('board is empty until the repo resolves, then renders the ledger', async () => {
  const world = makeWorld()
  try {
    // Sync board before any resolution: empty string (mode off).
    assert.equal(world.views.board(world.session), '')
    await seedLane(world, 'l1', 'working')
    const board = world.views.board(world.session)
    assert.match(board, /^Worktree lanes:/)
    assert.match(board, /- l1 · working · next: worktree_check/)
    // Mode on with an unresolved repo still renders the header.
    const modal = makeWorld([{}, { modeOf: () => true }])
    try {
      const empty = modal.views.board(modal.session)
      assert.match(empty, /Worktree mode ON/)
      assert.match(empty, /\(no active lanes\)/)
    } finally {
      modal.cleanup()
    }
  } finally {
    world.cleanup()
  }
})

test('summaryOf is null until the repo resolves, then counts the session lanes', async () => {
  const world = makeWorld()
  try {
    assert.equal(world.views.summaryOf(world.session), null)
    await seedLane(world, 'l1', 'working')
    await seedLane(world, 'l2', 'awaiting-approval', { asking: { pid: 77777, at: BASE_TIME } })
    await seedLane(world, 'l3', 'landed', {})
    await seedLane(world, 'l4', 'working', { ownerSession: 's-other' })
    // The card for l2 is open in THIS process, so refresh keeps it waiting.
    world.core.asking.add('l2')
    await world.views.view(world.session) // resolves + refreshes the repo
    assert.deepEqual(world.views.summaryOf(world.session), { active: 2, awaiting: 1 })
  } finally {
    world.cleanup()
  }
})

test('diffOf diffs the merge commit for landed lanes and the base range otherwise', async () => {
  const world = makeWorld()
  try {
    await seedLane(world, 'l1', 'working')
    await seedLane(world, 'l2', 'landed', { land: { commit: 'abc1234', at: BASE_TIME, by: 'user', stat: null } })
    assert.equal(await world.views.diffOf(world.session, 'l1'), 'diff-body')
    assert.deepEqual(world.calls.diff[0], [world.dir, 'main', 'weir/l1'])
    assert.equal(await world.views.diffOf(world.session, 'l2'), 'diff-body')
    assert.deepEqual(world.calls.diff[1], [world.dir, 'abc1234^1', 'abc1234'])
  } finally {
    world.cleanup()
  }
})
