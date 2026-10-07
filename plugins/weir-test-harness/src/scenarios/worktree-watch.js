// Scenario: worktree-watch — the lane subscription end to end on a real
// repository: worktree_open creates a lane, worktree_watch subscribes the
// parent to its conclusion states, a bound writer settles with no commits so
// the host check moves the lane to no-commits and the watch fires exactly one
// notification to the SUBSCRIBER; a manual re-check into the same target state
// fires nothing more (one-shot), and the ledger holds no watches afterwards.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { assertContained, ensureWorkspaceRepo } from '../git-repo.js'

const id = 'worktree-watch'
const prompt = 'worktree-watch-probe'
const WS = join(IT_ROOT, 'ws')
const LANE = 'watch-lane-001'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  // Child brain (lane writer): settle immediately with no commits → the host
  // check lands the lane on no-commits, which is the watched target state.
  const child = history.includes('WATCH_CHILD') && !history.includes(prompt)
  if (child) return textChunks('WATCH_CHILD_DONE')
  const sawHit = history.includes('[worktree] watch hit')
  // After the hit: one manual re-check into the SAME target state — a one-shot
  // watch stays silent — then finish. (The check-result line is the only tool
  // output with this exact `lane <id>: no-commits —` shape; the delegate
  // result's notice reads `[worktree] lane <id> no-commits →`.)
  if (sawHit && lastTool.includes(`lane ${LANE}: no-commits —`)) return textChunks('WATCH_PROBE_DONE')
  if (sawHit) return toolCallChunks('worktree_check', { lane: LANE })
  // Before the hit: open → watch → delegate → harmless reads until the hit
  // notification is steered into the turn (the turn must stay alive for it).
  // The watch result also starts with `lane <id>: ready` — match it first
  // (its `watching for` marker) or the brain re-subscribes forever.
  if (lastTool.includes('watching for no-commits, landable')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      worktree: LANE,
      prompt: 'WATCH_CHILD\nTASK: inspect the lane\nDELIVERABLE: a note\nSCOPE: the lane\nVERIFY: done\nSTOP WHEN: done',
    })
  }
  if (lastTool.includes(`lane ${LANE}: ready`)) return toolCallChunks('worktree_watch', { lane: LANE, states: ['no-commits', 'landable'] })
  if (lastTool !== '') return toolCallChunks(process.platform === 'win32' ? 'pwsh' : 'bash', { command: 'true', description: 'wait for the watch hit' })
  if (history.includes(prompt)) return toolCallChunks('worktree_open', { title: 'Watch lane' })
  return textChunks('unhandled worktree-watch turn')
}

function observe(obs) {
  return {
    watchHits: (obs.transcript.match(/\[worktree\] watch hit/g) ?? []).length,
  }
}

/** Same workspace ritual as the worktree scenario (shared WS, own lane ids). */
async function run(ctx) {
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
  rmSync(join(WS, '.weir', 'worktrees'), { recursive: true, force: true })
  // Belt and braces: never stage/commit anywhere but the WS repo itself.
  assertContained(WS)
  git('add', '-A')
  git('commit', '-qm', 'fixture', '--allow-empty')
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const outcome = await ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, trace))
  return { scenario: id, trace, ...outcome }
}

function assert(view) {
  const ledgerFile = join(view.ws, '.weir', 'worktrees', 'lanes.json')
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null
  const lane = ledger?.lanes?.find((entry) => entry.id === LANE)
  const watchHits = Math.max(0, ...view.requests.map((request) => request.watchHits ?? 0))
  view.check('worktree_open created the watched lane', lane?.branch === `weir/${LANE}`, JSON.stringify(ledger))
  view.check('the lane settled on the watched state no-commits', lane?.state === 'no-commits', lane?.state)
  view.check('the one-shot watch fired exactly once across the whole run', watchHits === 1, `watchHits=${watchHits}`)
  view.check('the consumed watch left the ledger empty', Array.isArray(ledger?.watches) && ledger.watches.length === 0, JSON.stringify(ledger?.watches))
  view.check('the parent finished after the post-hit re-check stayed silent', view.stdout.includes('WATCH_PROBE_DONE'), view.stdout.slice(-400))
  view.check('headless run exited cleanly', view.code === 0 || view.code === null, `code=${view.code} stderr=${view.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert }
