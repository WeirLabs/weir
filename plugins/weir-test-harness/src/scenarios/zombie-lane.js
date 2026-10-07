// Scenario: zombie-lane — stale lane-binding reclamation end to end
// (worktree-zombie-lane-reclamation). Three boots on one workspace:
//   phase 1 (session A): worktree_open + a supervised lane worker that settles
//     healthily — leaving a REAL settle fact in the audit log;
//   phase 2 (session A adopted in a fresh process): a hand-crafted zombie lane
//     bound to that settled child is freed by the hydrate re-emission alone
//     (D3, root cause) — no abandon call involved;
//   phase 3 (a NEW session, owner process long gone): lane A re-zombified with
//     the real settle fact is released by worktree_abandon's liveness
//     reconciliation (D1), and a second zombie with NO terminal evidence only
//     moves after the user force-reclaims on the disputed card (D4).
// The zombie ledger rows are hand-crafted exactly like the investigation's
// pinned fixture (investigate-zombie-lane-binding 1.2); every signal under
// test — settle facts, re-emission, reconciliation, cards, audits — is the
// real product path.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'
import { parseJsonlLines, readJsonl } from '../jsonl.js'
import { assertContained, ensureWorkspaceRepo } from '../git-repo.js'

const id = 'zombie-lane'
const prompt = 'zombie-lane-probe'
const REHYDRATE_PROMPT = 'zombie-rehydrate-probe'
const ABANDON_PROMPT = 'zombie-abandon-probe'
const WS = join(IT_ROOT, 'ws')
const LANE_A = 'zombie-evidence-001' // worktree_open({ title: 'Zombie evidence' })
const LANE_C = 'zombie-rehydrate-002' // hand-crafted: freed by hydrate re-emission
const LANE_B = 'zombie-forced-003' // hand-crafted: no evidence, force-reclaim only
const FAKE_CHILD = 'child-ffffffff-dead-dead-dead-ffffffffffff'
const DEAD_OWNER = 'session-eeeeeeee-dead-dead-dead-eeeeeeeeeeee'
const LANE_ROOT = join(WS, '.weir', 'worktrees')
const LEDGER = join(LANE_ROOT, 'lanes.json')
const AUDIT = join(WS, '.weir', 'audit.jsonl')

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  // Phase 3 (fresh session): abandon the evidence zombie, then the disputed one.
  if (history.includes(ABANDON_PROMPT)) {
    if (lastTool.includes(`lane ${LANE_B}: abandoned`)) return textChunks('ZOMBIE_PROBE_DONE')
    if (lastTool.includes(`lane ${LANE_A}: abandoned`)) return toolCallChunks('worktree_abandon', { lane: LANE_B })
    if (lastTool === '') return toolCallChunks('worktree_abandon', { lane: LANE_A })
    return textChunks(`unhandled zombie-abandon turn: ${lastTool.slice(0, 160)}`)
  }
  // Phase 2 (adopted session A): one registry read drives the rebuild; the
  // recovered settlement then frees lane C and notifies this (live) owner.
  if (history.includes(REHYDRATE_PROMPT)) {
    if (history.includes(`[worktree] lane ${LANE_C}`)) return textChunks('phase2 observed the recovered lane settlement')
    // The adopted log's phase-1 tool results make lastTool non-empty, so the
    // status call is gated on its own result marker, never on lastTool.
    if (!history.includes('Supervised registry of this session')) return toolCallChunks('supervised_status', {})
    const verdict = waitForMarker(history, `[worktree] lane ${LANE_C}`)
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('phase2 settlement wait exhausted')
  }
  // Phase 1 child (supervised lane worker): report and settle.
  if (history.includes('ZOMBIE_WORKER') && !history.includes(prompt)) {
    return textChunks('STATUS: completed\nREPORT: zombie evidence worker done')
  }
  // Phase 1 parent: open the lane, bind the worker, wait for the healthy settle.
  if (lastTool.includes(`lane ${LANE_A}: ready`)) {
    return toolCallChunks('delegate', {
      group: 'zombie-group',
      worktree: LANE_A,
      tasks: [{ category: 'quick', name: 'worker', prompt: 'ZOMBIE_WORKER\nTASK: idle lane work\nDELIVERABLE: a status report\nSCOPE: the lane\nVERIFY: done\nSTOP WHEN: done' }],
    })
  }
  if (lastTool.includes('Supervised group')) {
    const verdict = waitForMarker(history, ['zombie evidence worker done', `[worktree] lane ${LANE_A}`])
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('phase1 healthy-settle wait exhausted')
  }
  if (history.includes(`[worktree] lane ${LANE_A}`)) return textChunks('phase1 observed the healthy settle')
  if (lastTool !== '') return textChunks(`unhandled zombie-lane turn: ${lastTool.slice(0, 160)}`)
  if (history.includes(prompt)) return toolCallChunks('worktree_open', { title: 'Zombie evidence' })
  return textChunks('unhandled zombie-lane turn')
}

function observe(obs) {
  return {
    zombieAbandonProbe: obs.transcript.includes(ABANDON_PROMPT),
    zombieWorkerSeen: obs.transcript.includes('ZOMBIE_WORKER'),
  }
}

/** Same workspace ritual as the worktree scenario (shared WS, own lane ids). */
function resetWorkspace() {
  const git = (...args) => execFileSync('git', args, { cwd: WS, stdio: 'ignore' })
  ensureWorkspaceRepo(WS)
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: WS, stdio: 'ignore' })
    for (const entry of execFileSync('git', ['branch', '--list', 'weir/*', '--format=%(refname:short)'], { cwd: WS, encoding: 'utf8' }).split('\n').filter(Boolean)) {
      execFileSync('git', ['branch', '-D', entry], { cwd: WS, stdio: 'ignore' })
    }
  } catch {
    // no lanes yet
  }
  rmSync(LANE_ROOT, { recursive: true, force: true })
  assertContained(WS)
  git('add', '-A')
  git('commit', '-qm', 'fixture', '--allow-empty')
}

/** Real worktree + branch for a hand-crafted zombie lane (runChecks needs both). */
function makeLaneWorktree(laneId) {
  const path = join(LANE_ROOT, laneId)
  execFileSync('git', ['worktree', 'add', '-b', `weir/${laneId}`, path, 'main'], { cwd: WS, stdio: 'ignore' })
  return path
}

/** Write one zombie ledger row (state=working, bound, owner) — the pinned 064 shape. */
function zombify(laneId, { child, owner, create = false }) {
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'))
  const now = Date.now()
  const base = { branch: 'main', commit: execFileSync('git', ['rev-parse', 'main'], { cwd: WS, encoding: 'utf8' }).trim() }
  const existing = ledger.lanes.find((entry) => entry.id === laneId)
  if (existing) {
    Object.assign(existing, { state: 'working', boundChild: child, ownerSession: owner, landableTree: null, check: null, reason: null, updatedAt: now })
  } else if (create) {
    ledger.lanes.push({
      id: laneId, title: laneId, state: 'working',
      path: makeLaneWorktree(laneId), branch: `weir/${laneId}`,
      base, ownerSession: owner, boundChild: child,
      scope: [], setup: { status: 'none' }, landableTree: null, reason: null,
      createdAt: now - 86400000, updatedAt: now - 86400000,
      history: [{ from: 'ready', to: 'working', event: 'bind', at: now - 86400000, by: 'host' }],
    })
    ledger.seq = Math.max(ledger.seq ?? 0, Number(/-(\d+)$/.exec(laneId)?.[1] ?? 0))
  }
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2))
}

/**
 * Three-boot runner override. ctx is supplied by the driver:
 *   - ctx.spawnHeadless(args, env) → Promise<{ code, stdout, stderr }>
 *   - ctx.scenarioEnv(scenarioId, trace, extra?) → the WEIR_IT_* env for one boot
 */
async function run(ctx) {
  resetWorkspace()
  const trace1 = join(ctx.IT_ROOT, 'trace-zombie-lane.jsonl')
  const p1 = await ctx.spawnHeadless(['weir-it', '--json', prompt], ctx.scenarioEnv(id, trace1))
  const sessionA = parseJsonlLines(p1.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
  // The audit log is SHARED with every earlier scenario in the suite run, so
  // the worker is keyed by this scenario's unique report text, not by order.
  const childId = readJsonl(AUDIT).find((record) => record?.type === 'weir/supervision/settle' && record?.session === sessionA && record?.data?.report === 'zombie evidence worker done')?.data?.childId ?? null

  // Phase 2: lane C zombie (bound to the REALLY settled child, owner session A)
  // is freed by the restart rebuild's settlement re-emission alone.
  let p2 = null
  const trace2 = join(ctx.IT_ROOT, 'trace-zombie-lane-phase2.jsonl')
  if (sessionA && childId) {
    zombify(LANE_C, { child: childId, owner: sessionA, create: true })
    p2 = await ctx.spawnHeadless(['weir-it', '--session-id', sessionA, REHYDRATE_PROMPT], ctx.scenarioEnv(id, trace2))
  }

  // Phase 3: lane A re-zombified with the same real settle fact (owner process
  // gone), lane B with a child that never existed (no evidence anywhere).
  let p3 = null
  const trace3 = join(ctx.IT_ROOT, 'trace-zombie-lane-phase3.jsonl')
  if (sessionA && childId) {
    zombify(LANE_A, { child: childId, owner: sessionA })
    zombify(LANE_B, { child: FAKE_CHILD, owner: DEAD_OWNER, create: true })
    p3 = await ctx.spawnHeadless(['weir-it', ABANDON_PROMPT], ctx.scenarioEnv(id, trace3, { WEIR_IT_ZOMBIE_LANE: '1' }))
  }
  const last = p3 ?? p2 ?? p1
  return { scenario: id, trace: trace3, trace2, sessionId: sessionA, childId, code: last.code, stdout: last.stdout, stderr: last.stderr, phase1: p1, phase2: p2 }
}

function assert(view) {
  const ledger = existsSync(join(view.ws, '.weir', 'worktrees', 'lanes.json')) ? JSON.parse(readFileSync(join(view.ws, '.weir', 'worktrees', 'lanes.json'), 'utf8')) : null
  const laneA = ledger?.lanes?.find((entry) => entry.id === LANE_A)
  const laneB = ledger?.lanes?.find((entry) => entry.id === LANE_B)
  const laneC = ledger?.lanes?.find((entry) => entry.id === LANE_C)
  const audit = readJsonl(join(view.ws, '.weir', 'audit.jsonl'))
  // Shared audit log (suite run and recorded fixture alike): key the worker
  // by this scenario's unique report text, never by record order.
  const childId = audit.find((record) => record?.type === 'weir/supervision/settle' && record?.data?.report === 'zombie evidence worker done')?.data?.childId ?? null
  const reconciles = audit.filter((record) => record?.type === 'weir/worktree/reconcile-binding')
  const forLane = (laneId) => reconciles.find((record) => record?.data?.lane === laneId)

  view.check('phase 1 bound and settled a real supervised lane worker', typeof view.sessionId === 'string' && typeof childId === 'string', `session=${view.sessionId} child=${childId}`)
  view.check('phase 2 hydrate re-emission freed the zombie lane with no abandon call', laneC?.boundChild === null && laneC?.state === 'no-commits', JSON.stringify(laneC))
  view.check(
    'phase 2 audit carries the re-emitted settle fact (recovered)',
    audit.some((record) => record?.type === 'weir/supervision/settle' && record?.data?.recovered === true && record?.data?.childId === childId),
    JSON.stringify(audit.filter((record) => record?.type === 'weir/supervision/settle').map((record) => record?.data)),
  )
  view.check('phase 3 abandon released the evidence zombie', laneA?.state === 'abandoned' && laneA?.boundChild === null, JSON.stringify(laneA))
  view.check(
    'lane A reconciliation was audited with its terminal evidence (not forced)',
    forLane(LANE_A)?.data?.forced === false && forLane(LANE_A)?.data?.child === childId && forLane(LANE_A)?.data?.evidence?.source === 'audit',
    JSON.stringify(forLane(LANE_A)),
  )
  view.check('phase 3 force-reclaim released the disputed zombie', laneB?.state === 'abandoned' && laneB?.boundChild === null, JSON.stringify(laneB))
  view.check(
    'lane B force-reclaim was audited as a forced user decision',
    forLane(LANE_B)?.data?.forced === true && forLane(LANE_B)?.data?.child === FAKE_CHILD,
    JSON.stringify(forLane(LANE_B)),
  )
  view.check('phase 3 finished after both abandons', view.stdout.includes('ZOMBIE_PROBE_DONE'), view.stdout.slice(-400))
  view.check('headless run exited cleanly', view.code === 0 || view.code === null, `code=${view.code} stderr=${view.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert }
