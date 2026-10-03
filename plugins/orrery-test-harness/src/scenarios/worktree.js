// Scenario: worktree — the lane pipeline end to end on a real repository:
// worktree_open creates a lane (local exclude, branch, worktree), delegate
// binds a writer with worktree=<lane>, the lane guard refuses a shell call
// without the lane workdir, and when the writer settles without committing
// the host check reports `no-commits` with the next step in the result.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'worktree'
const prompt = 'worktree-probe'
const WS = join(IT_ROOT, 'ws')
const LANE = 'it-lane-001'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  // Child brain (lane writer): the assignment marker plus the lane contract.
  // The parent's own history carries the marker inside its delegate call, so
  // the child is told apart by the absence of the parent prompt.
  const child = history.includes('WORKTREE_CHILD') && !history.includes(prompt)
  if (child && history.includes('WORKTREE_CHILD_DONE')) return textChunks('WORKTREE_CHILD_DONE: nothing else to do')
  if (child) {
    if (lastTool.includes('WORKTREE_CHILD_ATTEMPTED')) return textChunks('WORKTREE_CHILD_DONE')
    return toolCallChunks(process.platform === 'win32' ? 'pwsh' : 'bash', { command: 'git status', description: 'status without the lane workdir — WORKTREE_CHILD_ATTEMPTED' })
  }
  // Parent brain: branch on the last tool result, never on role heuristics.
  if (lastTool.includes(`lane ${LANE}: ready`)) {
    return toolCallChunks('delegate', {
      category: 'quick',
      worktree: LANE,
      prompt: 'WORKTREE_CHILD\nTASK: inspect the lane\nDELIVERABLE: a note\nSCOPE: the lane\nVERIFY: done\nSTOP WHEN: done',
    })
  }
  if (lastTool.includes('[worktree] lane')) return textChunks('parent saw the lane check: no-commits')
  if (lastTool !== '') return textChunks(`unhandled worktree tool turn: ${lastTool.slice(0, 160)}`)
  if (history.includes(prompt)) return toolCallChunks('worktree_open', { title: 'IT lane' })
  return textChunks('unhandled worktree turn')
}

function observe(obs) {
  const child = obs.transcript.includes('WORKTREE_CHILD') && !obs.transcript.includes(prompt)
  return {
    worktreeChild: child,
    childSawLaneContract: child && obs.transcript.includes(`<lane id="${LANE}">`),
    childGuardRefusal: child && obs.transcript.includes('must pass workdir'),
  }
}

/**
 * The workspace must be a git repository for this scenario. `setup()` recreates
 * the workspace for the whole run, so a repository from an earlier run may
 * still exist: only a missing one is initialized (its content is committed).
 */
async function run(ctx) {
  const git = (...args) => execFileSync('git', args, { cwd: WS, stdio: 'ignore' })
  const isRepo = () => {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: WS, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  if (!isRepo()) {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'it@example.com')
    git('config', 'user.name', 'IT')
  }
  // A workspace reused from an earlier run keeps that run's lanes: prune the
  // worktrees and start from an empty ledger so the lane ids are deterministic.
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: WS, stdio: 'ignore' })
    for (const entry of execFileSync('git', ['branch', '--list', 'orrery/*', '--format=%(refname:short)'], { cwd: WS, encoding: 'utf8' }).split('\n').filter(Boolean)) {
      execFileSync('git', ['branch', '-D', entry], { cwd: WS, stdio: 'ignore' })
    }
  } catch {
    // no lanes yet
  }
  rmSync(join(WS, '.orrery', 'worktrees'), { recursive: true, force: true })
  git('add', '-A')
  git('commit', '-qm', 'fixture', '--allow-empty')
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const outcome = await ctx.spawnHeadless(['orrery-it', prompt], ctx.scenarioEnv(id, trace))
  return { scenario: id, trace, ...outcome }
}

function assert(view) {
  // Replay-safe: every path is resolved against the VIEW's workspace, which is
  // the recorded fixture directory when the assertion runs from a trace.
  const ledgerFile = join(view.ws, '.orrery', 'worktrees', 'lanes.json')
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null
  const lane = ledger?.lanes?.find((entry) => entry.id === LANE)
  const lanePath = lane?.path ?? join(view.ws, '.orrery', 'worktrees', LANE)
  // Live runs read the repository's exclude; recorded fixtures store it flattened.
  const excludeFile = [join(view.ws, '.git', 'info', 'exclude'), join(view.ws, 'git-info-exclude')].find((file) => existsSync(file)) ?? ''
  const exclude = excludeFile ? readFileSync(excludeFile, 'utf8') : ''
  view.check('worktree_open created the lane in the ledger', Boolean(lane), JSON.stringify(ledger))
  view.check('the lane exists on its own branch', lane?.branch === `orrery/${LANE}` && typeof lane?.path === 'string', JSON.stringify(lane))
  view.check('the lane root is ignored locally through info/exclude', exclude.includes('/.orrery/worktrees/'), exclude)
  view.check('the bound child received the lane contract', view.requests.some((r) => r.childSawLaneContract))
  view.check('the lane guard refused a shell call without the lane workdir', view.requests.some((r) => r.childGuardRefusal))
  view.check('the host check settled the lane as no-commits', lane?.state === 'no-commits', lane?.state)
  view.check('the parent saw the lane check in the delegate result', view.stdout.includes('parent saw the lane check: no-commits'), view.stdout.slice(-400))
  view.check('headless run exited cleanly', view.code === 0 || view.code === null, `code=${view.code} stderr=${view.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert }
