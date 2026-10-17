import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneCore } from '../src/worktree/lane-core.js'
import { createLaneWorkflows } from '../src/worktree/lane-workflows.js'
import { WORKTREE_CODES, WorktreeError } from '../src/worktree/errors.js'

// Focused unit pin for src/worktree/lane-workflows.js (change
// test-surface-pinning, task 3.2), previously zero direct test imports: the
// DECISION seams — the approval/confirmation cards, the auto-approve paths and
// the removal semantics — through their error faces and hint shapes. Mock git
// + injected ask/approveMode deps; the ledger is real. Exists alongside the
// facade suite (worktree-lanes.test.js via lanes.js), which stays untouched.

const BASE_TIME = 1_700_000_000_000

/**
 * A world with a real (empty-git) repository directory, a real ledger, and a
 * fully stubbed git surface. Mutable maps let a test flip facts mid-flow.
 */
function makeWorld(/** @type {any} */ [gitOverrides, depOverrides] = [{}, {}]) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'weir-lane-wf-')))
  const rootPath = join(dir, '.weir', 'worktrees')
  const clock = { t: BASE_TIME }
  const calls = { notify: [], audit: [], warn: [], timers: new Map(), cleared: [], ask: [], mergeNoFf: [], worktreeRemove: [], branchDelete: [] }
  let timerSeq = 0
  const git = {
    version: async () => [2, 43, 0],
    supported: () => true,
    repoOf: async () => ({ mainRoot: dir, commonDir: join(dir, '.git') }),
    worktreeList: async () => git._worktrees,
    _worktrees: /** @type {any[]} */ ([]),
    currentBranch: async (/** @type {string} */ cwd) => git._branches[cwd] ?? 'main',
    _branches: /** @type {Record<string, string>} */ ({}),
    tree: async (/** @type {string} */ path) => git._trees[path] ?? 'tree-1',
    _trees: /** @type {Record<string, string>} */ ({}),
    status: async () => git._status,
    _status: /** @type {any[]} */ ([]),
    aheadBehind: async () => ({ ahead: 1, behind: 0 }),
    branchExists: async () => git._branchExists,
    _branchExists: true,
    mergeTreeCheck: async () => git._mergeTreeCheck,
    _mergeTreeCheck: { clean: true, conflicts: [] },
    indexEmpty: async () => git._indexEmpty,
    _indexEmpty: true,
    changedFiles: async () => ['f1.js'],
    revParse: async () => 'commit-1',
    diffStat: async () => ({ files: 1, added: 2, removed: 0 }),
    commits: async () => [],
    mergeNoFf: async (/** @type {any} */ ...args) => { calls.mergeNoFf.push(args); return { ok: true, commit: 'abc1234deadbeef' } },
    diff: async () => 'diff-body',
    dirtyCounts: async () => git._dirty,
    _dirty: { modified: 0, untracked: 0 },
    worktreeRemove: async (/** @type {any} */ ...args) => { calls.worktreeRemove.push(args) },
    branchDelete: async (/** @type {any} */ ...args) => { calls.branchDelete.push(args) },
    unmergedCount: async () => 0,
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
    setTimer: (/** @type {() => void} */ handler, /** @type {number} */ delayMs) => {
      const id = `timer-${++timerSeq}`
      calls.timers.set(id, { handler, delayMs })
      return id
    },
    clearTimer: (/** @type {any} */ handle) => { calls.cleared.push(handle); calls.timers.delete(handle) },
    pid: 77777,
    logger: { warn: (/** @type {string} */ m) => calls.warn.push(m) },
    ...depOverrides,
  }
  const core = createLaneCore(deps)
  const workflows = createLaneWorkflows(core)
  const session = { id: 's-main', header: { cwd: dir } }
  const agent = { session }
  return {
    dir, rootPath, clock, calls, git, deps, core, workflows, session, agent,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Seed one lane into the world's ledger and register its (real) worktree dir. */
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
  world.git._branches[lanePath] = lane.branch
  world.git._trees[lanePath] = lane.landableTree ?? 'tree-1'
  return lane
}

function auditKinds(/** @type {any} */ calls) {
  return calls.audit.map((/** @type {any[]} */ [type, data]) => [type, data.event ?? data.outcome ?? null])
}

test('land refuses a non-landable lane with NOT_LANDABLE and the check next step', async () => {
  const world = makeWorld()
  try {
    await seedLane(world, 'l1', 'working')
    await assert.rejects(() => world.workflows.land(world.agent, 'l1'), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.NOT_LANDABLE)
      assert.match(error.message, /lane l1 is working.*only a checked, landable lane can be merged/)
      assert.deepEqual(error.next, { tool: 'worktree_check', args: { lane: 'l1' }, hint: 'no worker is bound; check the lane' })
      return true
    })
    assert.equal(world.calls.mergeNoFf.length, 0)
  } finally {
    world.cleanup()
  }
})

test('land refuses a stale conclusion and a moved base with their own recovery hints', async () => {
  const world = makeWorld()
  try {
    await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    // The lane changed AFTER refresh's reconciliation window but before land's
    // own tree check (a change visible AT refresh is invalidated to 'working'
    // by reconcile first — pinned by the NOT_LANDABLE test above).
    const lanePath = join(world.rootPath, 'l1')
    let treeReads = 0
    world.git.tree = async (/** @type {string} */ path) => (path === lanePath && ++treeReads > 1 ? 'tree-2' : 'tree-1')
    await assert.rejects(() => world.workflows.land(world.agent, 'l1'), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.STALE_LANDABLE)
      assert.match(error.message, /lane l1 changed after it was checked/)
      assert.deepEqual(error.next, { tool: 'worktree_check', args: { lane: 'l1' } })
      return true
    })

    const world2 = makeWorld()
    try {
      await seedLane(world2, 'l1', 'landable', { landableTree: 'tree-1' })
      world2.git._branches[world2.dir] = 'other' // the main worktree moved off the base
      await assert.rejects(() => world2.workflows.land(world2.agent, 'l1'), (/** @type {any} */ error) => {
        assert.equal(error.code, WORKTREE_CODES.BASE_MOVED)
        assert.match(error.message, /the main worktree is on other, not main/)
        assert.deepEqual(error.next, { waitFor: 'user', hint: 'the user checks out main in the main worktree' })
        return true
      })
    } finally {
      world2.cleanup()
    }
  } finally {
    world.cleanup()
  }
})

test('land refuses a staged main worktree and dirty-overlap with named paths', async () => {
  const world = makeWorld()
  try {
    await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    world.git._indexEmpty = false
    await assert.rejects(() => world.workflows.land(world.agent, 'l1'), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.MAIN_STAGED)
      assert.match(error.message, /staged changes; commit or unstage/)
      return true
    })
    world.git._indexEmpty = true
    world.git._status = [{ path: 'f1.js' }] // same path the lane changes
    await assert.rejects(() => world.workflows.land(world.agent, 'l1'), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.MAIN_DIRTY_OVERLAP)
      assert.match(error.message, /uncommitted changes in the main worktree touch lane files: f1\.js/)
      assert.deepEqual(error.data, { paths: ['f1.js'] })
      return true
    })
    assert.equal(world.calls.mergeNoFf.length, 0)
  } finally {
    world.cleanup()
  }
})

test('a conflicting merge precheck transitions the lane to conflicted instead of throwing', async () => {
  const world = makeWorld()
  try {
    const lane = await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    world.git._mergeTreeCheck = { clean: false, conflicts: ['src/a.js', 'src/b.js'] }
    const result = await world.workflows.land(world.agent, 'l1')
    assert.equal(result.state, 'conflicted')
    assert.match(result.summary, /not merged: 2 conflicting path\(s\)/)
    assert.deepEqual(result.conflicts, ['src/a.js', 'src/b.js'])
    const stored = world.core.laneOf(await world.core.repoFor(world.dir), lane.id)
    assert.equal(stored.state, 'conflicted')
    assert.match(stored.reason ?? '', /conflicts with main: src\/a\.js, src\/b\.js/)
    assert.equal(world.calls.mergeNoFf.length, 0)
  } finally {
    world.cleanup()
  }
})

test('the manual approval card declines when nobody can be asked', async () => {
  const world = makeWorld() // no ask dep
  try {
    await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    const result = await world.workflows.land(world.agent, 'l1')
    assert.equal(result.state, 'declined')
    assert.match(result.summary, /not merged: nobody could be asked for approval/)
    const repo = await world.core.repoFor(world.dir)
    const stored = world.core.laneOf(repo, 'l1')
    assert.deepEqual(stored.history.map((/** @type {any} */ h) => h.event), ['ask', 'decline'])
    assert.equal(stored.reason, 'no user-question answerer is available')
    assert.deepEqual(auditKinds(world.calls), [['ask', 'ask'], ['decline', 'decline']])
    assert.equal(world.calls.mergeNoFf.length, 0)
  } finally {
    world.cleanup()
  }
})

test('the manual approval card declines on dismissal, custom feedback, and not-now', async () => {
  for (const [label, ask, reason, summary] of /** @type {const} */ ([
    ['dismissed', async () => { throw Object.assign(new Error('nope'), { code: 'cancelled' }) },
      'approval not given (cancelled)', 'not merged: the approval card was dismissed or unavailable'],
    ['custom', async () => ({ answers: [{ id: 'merge', selected: [], custom: 'please split it' }] }),
      'the user replied instead of approving', 'not merged: the user did not approve'],
    ['not-now', async (/** @type {any} */ _agent, /** @type {any} */ questions) => ({ answers: [{ id: 'merge', selected: [questions[0].options[1].label] }] }),
      'the user chose not to merge now', 'not merged: the user did not approve'],
  ])) {
    const world = makeWorld([{}, { ask }])
    try {
      await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
      const result = await world.workflows.land(world.agent, 'l1')
      assert.equal(result.state, 'declined', label)
      assert.match(result.summary, new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), label)
      const stored = world.core.laneOf(await world.core.repoFor(world.dir), 'l1')
      assert.equal(stored.reason, reason, label)
      if (label === 'custom') {
        assert.equal(stored.decline?.feedback, 'please split it')
        assert.deepEqual(result.feedback, 'please split it')
      }
      assert.equal(world.calls.mergeNoFf.length, 0, label)
    } finally {
      world.cleanup()
    }
  }
})

test('an approved card merges and lands by the host; approval re-verification guards the window', async () => {
  const world = makeWorld([{}, {
    ask: async (/** @type {any} */ agent, /** @type {any} */ questions) => {
      world.calls.ask.push(questions)
      return { answers: [{ id: 'merge', selected: [questions[0].options[0].label] }] }
    },
  }])
  try {
    await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    const result = await world.workflows.land(world.agent, 'l1')
    assert.equal(result.state, 'landed')
    assert.match(result.summary, /merged weir\/l1 into main as abc1234/)
    assert.deepEqual(result.merge, { commit: 'abc1234deadbeef', stat: { files: 1, added: 2, removed: 0 } })
    assert.equal(result.diff, 'diff-body')
    assert.equal(world.calls.ask.length, 1)
    const landAudit = world.calls.audit.find((/** @type {any[]} */ [type]) => type === 'land')
    assert.deepEqual(landAudit[1].by, 'host')
    assert.equal(landAudit[1].auto, undefined) // no auto marker on the manual path
    const repo = await world.core.repoFor(world.dir)
    assert.equal(world.core.laneOf(repo, 'l1').land?.commit, 'abc1234deadbeef')
  } finally {
    world.cleanup()
  }

  // The card-open window: the lane changed while the user decided.
  const world2 = makeWorld([{}, {
    ask: async (/** @type {any} */ _agent, /** @type {any} */ questions) => {
      world2.git._trees[join(world2.rootPath, 'l1')] = 'tree-2'
      return { answers: [{ id: 'merge', selected: [questions[0].options[0].label] }] }
    },
  }])
  try {
    await seedLane(world2, 'l1', 'landable', { landableTree: 'tree-1' })
    await assert.rejects(() => world2.workflows.land(world2.agent, 'l1'), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.STALE_LANDABLE)
      assert.match(error.message, /changed while the approval card was open; nothing was merged/)
      return true
    })
    const stored = world2.core.laneOf(await world2.core.repoFor(world2.dir), 'l1')
    assert.equal(stored.state, 'declined')
    assert.equal(world2.calls.mergeNoFf.length, 0)
  } finally {
    world2.cleanup()
  }
})

test('userApproved (the /worktree land command) bypasses the card and lands by the user', async () => {
  const ask = async () => { throw new Error('ask must not be called') }
  const world = makeWorld([{}, { ask }])
  try {
    await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    const result = await world.workflows.land(world.agent, 'l1', { userApproved: true })
    assert.equal(result.state, 'landed')
    const landAudit = world.calls.audit.find((/** @type {any[]} */ [type]) => type === 'land')
    assert.equal(landAudit[1].by, 'user')
  } finally {
    world.cleanup()
  }
})

test('auto-approve auto-clean merges without any card and runs the auto cleanup (never forced)', async () => {
  const ask = async () => { throw new Error('ask must not be called') }
  const world = makeWorld([{}, { ask, approveModeOf: () => 'auto-clean' }])
  try {
    await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    const result = await world.workflows.land(world.agent, 'l1')
    // The result carries the LANDED lane; the cleanup outcome rides the extra.
    assert.equal(result.state, 'landed')
    assert.equal(result.cleanup?.state, 'cleaned')
    assert.match(result.summary, /merged weir\/l1 into main as abc1234; auto cleanup \(mode all\): removed .*; deleted weir\/l1/)
    const landAudit = world.calls.audit.find((/** @type {any[]} */ [type]) => type === 'land')
    assert.equal(landAudit[1].auto, true)
    assert.equal(landAudit[1].approveMode, 'auto-clean')
    // Auto removal never passes force to git.
    assert.equal(world.calls.worktreeRemove.length, 1)
    assert.deepEqual(world.calls.worktreeRemove[0][2], { force: false })
    assert.equal(world.calls.branchDelete.length, 1)
    // The transition's own audit (kind 'cleanup') precedes the workflow's
    // cleanup audit — pick the workflow's by its mode key.
    const cleanupAudit = world.calls.audit.find((/** @type {any[]} */ [type, data]) => type === 'cleanup' && data.mode === 'all')
    assert.equal(cleanupAudit[1].auto, true)
    assert.equal(cleanupAudit[1].forced, undefined)
  } finally {
    world.cleanup()
  }
})

test('auto-approve auto-keep keeps the branch (mode worktree)', async () => {
  const world = makeWorld([{}, { approveModeOf: () => 'auto-keep' }])
  try {
    await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    const result = await world.workflows.land(world.agent, 'l1')
    assert.equal(result.state, 'landed')
    assert.equal(result.cleanup?.state, 'cleaned')
    const storedLane = world.core.laneOf(await world.core.repoFor(world.dir), 'l1')
    assert.equal(storedLane.state, 'cleaned')
    assert.match(result.summary, /auto cleanup \(mode worktree\): removed /)
    assert.equal(world.calls.worktreeRemove.length, 1)
    assert.equal(world.calls.branchDelete.length, 0) // the branch is kept
  } finally {
    world.cleanup()
  }
})

test('a blocked auto cleanup keeps the lane landed and reports the typed force retry', async () => {
  const world = makeWorld([{
    worktreeRemove: async () => { throw new WorktreeError(WORKTREE_CODES.REMOVE_BLOCKED, 'git refused') },
  }, { approveModeOf: () => 'auto-clean' }])
  try {
    await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    const result = await world.workflows.land(world.agent, 'l1')
    assert.equal(result.state, 'landed') // merged, but not cleaned
    assert.match(result.summary, /auto cleanup blocked: REMOVE_BLOCKED: removal blocked: git refused/)
    assert.match(result.cleanup?.error ?? '', /removal blocked: git refused to remove the worktree/)
    assert.match(result.cleanup?.next?.hint ?? '', /\/worktree clean l1 all --force/)
    const stored = world.core.laneOf(await world.core.repoFor(world.dir), 'l1')
    assert.equal(stored.state, 'landed')
    assert.match(stored.cleanup?.blocked ?? '', /removal blocked/)
  } finally {
    world.cleanup()
  }
})

test('cleanup validates mode and lane state and keeps keep idempotent', async () => {
  const world = makeWorld()
  try {
    await seedLane(world, 'l1', 'working')
    await assert.rejects(() => world.workflows.cleanup(world.session, 'l1', /** @type {any} */ ('burn')), /cleanup mode must be keep, worktree, or all/)
    await assert.rejects(() => world.workflows.cleanup(world.session, 'l1', 'all'), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.ILLEGAL_TRANSITION)
      assert.match(error.message, /lane l1 is working; cleanup applies to merged \(or abandoned\) lanes/)
      assert.ok(error.next)
      return true
    })
    const repo = await world.core.repoFor(world.dir)
    await world.core.apply(repo, 'l1', { type: 'checked', to: 'landable', patch: { landableTree: 'tree-1' } })
    await world.core.apply(repo, 'l1', { type: 'land' })
    const kept = await world.workflows.cleanup(world.session, 'l1', 'keep')
    assert.equal(kept.state, 'kept')
    assert.match(kept.summary, /^kept /)
    const again = await world.workflows.cleanup(world.session, 'l1', 'keep')
    assert.match(again.summary, /nothing to do: the worktree is already kept/)
    assert.equal(again.state, 'kept')
  } finally {
    world.cleanup()
  }
})

test('force reaches git only from an explicit user choice, never from an auto path', async () => {
  // User-typed --force.
  const world = makeWorld()
  try {
    await seedLane(world, 'l1', 'landed', { land: { commit: 'abc1234deadbeef', at: BASE_TIME, by: 'user', stat: null } })
    await world.workflows.cleanup(world.session, 'l1', 'worktree', { force: true })
    assert.deepEqual(world.calls.worktreeRemove[0][2], { force: true })
    const audit = world.calls.audit.find((/** @type {any[]} */ [type, data]) => type === 'cleanup' && data.mode === 'worktree')
    assert.equal(audit[1].forced, true)
  } finally {
    world.cleanup()
  }
  // The same force flag on an auto path is stripped.
  const auto = makeWorld()
  try {
    await seedLane(auto, 'l1', 'landed', { land: { commit: 'abc1234deadbeef', at: BASE_TIME, by: 'host', stat: null } })
    await auto.workflows.cleanup(auto.session, 'l1', 'worktree', { by: 'host', auto: true, approveMode: 'auto-clean', force: true })
    assert.deepEqual(auto.calls.worktreeRemove[0][2], { force: false })
    const audit = auto.calls.audit.find((/** @type {any[]} */ [type, data]) => type === 'cleanup' && data.mode === 'worktree')
    assert.equal(audit[1].auto, true)
    assert.equal(audit[1].forced, undefined)
  } finally {
    auto.cleanup()
  }
})

test('a blocked removal records the reason on the lane and names the dirty counts and force retry', async () => {
  const world = makeWorld([{
    worktreeRemove: async () => { throw new WorktreeError(WORKTREE_CODES.REMOVE_BLOCKED, 'git refused') },
  }])
  try {
    await seedLane(world, 'l1', 'landed', { land: { commit: 'abc1234deadbeef', at: BASE_TIME, by: 'user', stat: null } })
    world.git._dirty = { modified: 2, untracked: 1 }
    await assert.rejects(() => world.workflows.cleanup(world.session, 'l1', 'worktree'), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.REMOVE_BLOCKED)
      assert.match(error.message, /removal blocked: the worktree contains modified or untracked files \(2 modified, 1 untracked\)/)
      // The reason names the probe's dirty counts, never the raw git output.
      assert.doesNotMatch(error.message, /git refused/)
      assert.match(error.next?.hint ?? '', /the user retries with the explicit force override: \/worktree clean l1 worktree --force/)
      return true
    })
    const stored = world.core.laneOf(await world.core.repoFor(world.dir), 'l1')
    assert.equal(stored.state, 'landed') // unchanged: retryable
    assert.match(stored.cleanup?.blocked ?? '', /2 modified, 1 untracked/)
  } finally {
    world.cleanup()
  }
})

test('cleanup appends the Edit Lock residue warning when the probe sees residue', async () => {
  const world = makeWorld([{}, { authorityResidue: () => ({ operations: 1, locks: 2 }) }])
  try {
    await seedLane(world, 'l1', 'landed', { land: { commit: 'abc1234deadbeef', at: BASE_TIME, by: 'user', stat: null } })
    const result = await world.workflows.cleanup(world.session, 'l1', 'all')
    assert.equal(result.state, 'cleaned')
    assert.match(result.summary, /warning: the lane's session left 1 unresolved Edit Lock operation\(s\) and 2 Edit Lock lock\(s\) in the management authority/)
  } finally {
    world.cleanup()
  }
})

test('abandon refuses a finished lane and a typed-mode abandon on a bound lane', async () => {
  const world = makeWorld([{}, {
    bindingLiveness: async () => ({ childAlive: true, ownerAlive: true, terminalEvidence: null }),
  }])
  try {
    await seedLane(world, 'l1', 'landed')
    await assert.rejects(() => world.workflows.abandon(world.agent, 'l1'), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.ILLEGAL_TRANSITION)
      assert.match(error.message, /lane l1 is already landed/)
      return true
    })
    const repo = await world.core.repoFor(world.dir)
    await repo.ledger.update((/** @type {any} */ ledger) => {
      ledger.lanes[0] = { ...ledger.lanes[0], state: 'working', boundChild: 'child-9' }
      return { ledger }
    })
    await assert.rejects(() => world.workflows.abandon(world.agent, 'l1', { mode: 'all' }), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.LANE_BUSY)
      assert.match(error.message, /lane l1 has a running worker; stop it first/)
      assert.match(error.message, /binding reconciliation: the bound worker is still live; call worktree_abandon without a mode and use the card's force-reclaim/)
      return true
    })
  } finally {
    world.cleanup()
  }
})

test('the disputed-binding card cancel leaves the lane bound and untouched', async () => {
  const world = makeWorld([{}, {
    bindingLiveness: async () => ({ childAlive: true, ownerAlive: true, terminalEvidence: null }),
    ask: async (/** @type {any} */ _agent, /** @type {any} */ questions) => ({ answers: [{ id: 'abandon', selected: [questions[0].options[1].label] }] }), // cancel
  }])
  try {
    await seedLane(world, 'l1', 'working', { boundChild: 'child-9' })
    const result = await world.workflows.abandon(world.agent, 'l1')
    assert.match(result.summary, /not abandoned: the user cancelled/)
    const stored = world.core.laneOf(await world.core.repoFor(world.dir), 'l1')
    assert.equal(stored.state, 'working')
    assert.equal(stored.boundChild, 'child-9')
    assert.equal(world.calls.audit.filter((/** @type {any[]} */ [type]) => type === 'abandon').length, 0)
  } finally {
    world.cleanup()
  }
})

test('auto-approve abandon maps the mode, skips the card and never forces', async () => {
  const ask = async () => { throw new Error('ask must not be called') }
  const world = makeWorld([{}, { ask, approveModeOf: () => 'auto-clean' }])
  try {
    await seedLane(world, 'l1', 'working')
    const result = await world.workflows.abandon(world.agent, 'l1')
    assert.equal(result.state, 'abandoned')
    assert.match(result.summary, /abandoned; removed .*; deleted weir\/l1/)
    const abandonAudit = world.calls.audit.find((/** @type {any[]} */ [type]) => type === 'abandon')
    assert.equal(abandonAudit[1].auto, true)
    assert.equal(abandonAudit[1].approveMode, 'auto-clean')
    assert.equal(abandonAudit[1].by, 'host')
    assert.match(abandonAudit[1].reason ?? '', /abandoned automatically \(auto-clean mode\)/)
    assert.deepEqual(world.calls.worktreeRemove[0][2], { force: false })
  } finally {
    world.cleanup()
  }
})

test('prepareBind refuses a second writer with LANE_BUSY and names the bound child', async () => {
  const world = makeWorld([{}, {
    bindingLiveness: async () => ({ childAlive: true, ownerAlive: true, terminalEvidence: null }),
  }])
  try {
    await seedLane(world, 'l1', 'working', { boundChild: 'child-9' })
    await assert.rejects(() => world.workflows.prepareBind(world.session, 'l1', { readOnly: false }), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.LANE_BUSY)
      assert.match(error.message, /lane l1 already has a bound worker \(child-9\)/)
      return true
    })
    // A read-only investigator leaves the state alone and gets a no-op commit.
    const lane = await seedLane(world, 'l2', 'landable', { landableTree: 'tree-1' })
    const bound = await world.workflows.prepareBind(world.session, 'l2', { readOnly: true })
    assert.equal(bound.spec.readOnly, true)
    assert.equal(bound.spec.laneId, 'l2')
    assert.match(bound.contract, /<lane id="l2">/)
    await bound.commit('child-10')
    await bound.rollback()
    assert.equal(world.core.laneOf(await world.core.repoFor(world.dir), 'l2').state, 'landable')
    // ...but a finished lane is not dispatchable even read-only.
    await seedLane(world, 'l3', 'cleaned')
    await assert.rejects(() => world.workflows.prepareBind(world.session, 'l3', { readOnly: true }), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.LANE_NOT_DISPATCHABLE)
      assert.match(error.message, /lane l3 is cleaned/)
      return true
    })
    assert.ok(lane)
  } finally {
    world.cleanup()
  }
})

test('watch hits immediately on a concluded lane and never stores the watch', async () => {
  const world = makeWorld()
  try {
    await seedLane(world, 'l1', 'landable', { landableTree: 'tree-1' })
    const result = await world.workflows.watch(world.session, { lane: 'l1', states: ['landable'] })
    assert.match(result.summary, /already landable; the watch fired immediately and was not stored/)
    assert.equal(result.hit, 'landable')
    assert.equal(world.calls.notify.length, 1)
    assert.match(world.calls.notify[0][1], /watch hit: lane l1 reached landable/)
    const repo = await world.core.repoFor(world.dir)
    assert.equal(repo.ledger.read().watches.length, 0)
    assert.deepEqual(auditKinds(world.calls), [['watch', 'hit-immediate']])
  } finally {
    world.cleanup()
  }
})

test('watch subscribes atomically on a live lane and re-subscribing replaces+disarms', async () => {
  const world = makeWorld()
  try {
    await seedLane(world, 'l1', 'working')
    const result = await world.workflows.watch(world.session, { lane: 'l1', states: ['landable', 'abandoned'] })
    assert.match(result.summary, /^watching for landable, abandoned until \d{4}-/)
    assert.equal(result.watch.lane, 'l1')
    assert.equal(result.watch.expiresAt, BASE_TIME + 360 * 60_000)
    const repo = await world.core.repoFor(world.dir)
    const [stored] = repo.ledger.read().watches
    assert.equal(stored.sessionId, 's-main')
    assert.equal(world.calls.timers.size, 1)
    const [[firstHandle, firstTimer]] = [...world.calls.timers.entries()]
    assert.equal(firstTimer.delayMs, 360 * 60_000)
    const subscribed = world.calls.audit.find((/** @type {any[]} */ [type]) => type === 'watch')
    assert.equal(subscribed[1].outcome, 'subscribed')
    assert.equal(subscribed[1].replaced, null)

    const again = await world.workflows.watch(world.session, { lane: 'l1', states: ['landed'] })
    assert.equal(again.watch.states.join(','), 'landed')
    const watches = repo.ledger.read().watches
    assert.equal(watches.length, 1)
    assert.notEqual(watches[0].id, stored.id)
    // The replaced watch's timer was disarmed.
    assert.deepEqual(world.calls.cleared, [firstHandle])
    const replacedAudit = world.calls.audit.filter((/** @type {any[]} */ [type]) => type === 'watch').at(-1)
    assert.equal(replacedAudit[1].replaced, stored.id)
    assert.ok(firstHandle)
  } finally {
    world.cleanup()
  }
})

test('watch refuses unwatchable states, unknown lanes and anonymous sessions', async () => {
  const world = makeWorld()
  try {
    await seedLane(world, 'l1', 'working')
    await assert.rejects(() => world.workflows.watch(world.session, { lane: 'l1', states: ['working'] }), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.UNWATCHABLE_STATE)
      assert.match(error.message, /cannot watch "working": only conclusion states are watchable/)
      assert.ok(Array.isArray(error.data?.watchable))
      return true
    })
    await assert.rejects(() => world.workflows.watch(world.session, { lane: 'l1', states: [] }), /states must name at least one conclusion state/)
    await assert.rejects(() => world.workflows.watch(world.session, { lane: 'nope', states: ['landable'] }), (/** @type {any} */ error) => {
      assert.equal(error.code, WORKTREE_CODES.UNKNOWN_LANE)
      return true
    })
    await assert.rejects(() => world.workflows.watch({ header: { cwd: world.dir } }, { lane: 'l1', states: ['landable'] }), /the subscribing session has no id/)
  } finally {
    world.cleanup()
  }
})
