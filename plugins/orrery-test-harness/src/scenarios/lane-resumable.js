// Scenario: lane-resumable — a lane-bound continuable worker end to end
// (resumable-lane-workers): the continuable x worktree dispatch runs as the
// implicit supervised group lane:<laneId>; the worker reports STATUS: blocked
// and the lane STAYS working/bound (no host check — proven by the audit
// order); resume_agent continues it in place; the worker commits in the lane
// and reports completed; the terminal report settles the lane through the
// normal childSettled path and the host check concludes landable.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'
import { readJsonl } from '../jsonl.js'
import { assertContained, ensureWorkspaceRepo } from '../git-repo.js'

const id = 'lane-resumable'
const prompt = 'lane-resumable-probe'
const WS = join(IT_ROOT, 'ws')
const LANE = 'lane-resumable-001' // worktree_open({ title: 'Lane resumable' })
const LANE_PATH = join(WS, '.orrery', 'worktrees', LANE)
const BLOCKED_MARKER = 'lane worker needs the go-ahead'
const DONE_MARKER = 'lane worker committed and done'
const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  // The lane-bound worker (its history carries the assignment marker but never
  // the parent prompt). First turn: stand by blocked. After the resume context:
  // commit inside the lane (workdir is mandatory per the lane contract), then
  // report the terminal status.
  if (history.includes('LANE_RESUMABLE_WORKER') && !history.includes(prompt)) {
    if (history.includes('Your parent cleared your blocker')) {
      if (history.includes('LANE_WORKER_COMMITTED')) return textChunks(`STATUS: completed\nREPORT: ${DONE_MARKER}`)
      return toolCallChunks(SHELL, {
        command: 'echo lane-note > note.txt && git add note.txt && git commit -qm "lane note" && echo LANE_WORKER_COMMITTED',
        workdir: LANE_PATH,
        description: 'commit the lane note inside the lane',
      })
    }
    return textChunks(`STATUS: blocked\nREPORT: ${BLOCKED_MARKER}`)
  }
  // Parent: resumed — wait for the settle-triggered host check to conclude.
  if (history.includes('Resumed supervised child')) {
    const verdict = waitForMarker(history, `lane ${LANE} landable`)
    if (verdict.state === 'wait') return verdict.chunks
    if (verdict.state === 'advance') return textChunks('parent observed the landable lane after the resume')
    return textChunks('lane-resumable landable wait exhausted')
  }
  // Parent: the implicit group started — wait for the blocked settlement
  // notice (built-in channel), then resume the worker in place.
  if (history.includes('implicit supervised group')) {
    const verdict = waitForMarker(history, BLOCKED_MARKER)
    if (verdict.state === 'wait') return verdict.chunks
    if (verdict.state === 'advance') return toolCallChunks('resume_agent', { agent: 'worker', context: 'go-ahead granted' })
    return textChunks('lane-resumable blocked wait exhausted')
  }
  if (lastTool.includes(`lane ${LANE}: ready`)) {
    return toolCallChunks('delegate', {
      worktree: LANE,
      tasks: [{ category: 'quick', name: 'worker', mode: 'continuable', prompt: 'LANE_RESUMABLE_WORKER\nTASK: do the lane work\nDELIVERABLE: a committed note\nSCOPE: the lane\nVERIFY: done\nSTOP WHEN: done' }],
    })
  }
  if (lastTool !== '') return textChunks(`unhandled lane-resumable tool turn: ${lastTool.slice(0, 160)}`)
  if (history.includes(prompt)) return toolCallChunks('worktree_open', { title: 'Lane resumable' })
  return textChunks('unhandled lane-resumable turn')
}

function observe(obs) {
  const child = obs.transcript.includes('LANE_RESUMABLE_WORKER') && !obs.transcript.includes(prompt)
  return {
    laneResumableProbe: obs.transcript.includes(prompt),
    implicitGroupSeen: obs.transcript.includes('implicit supervised group'),
    workerBlockedSeen: obs.transcript.includes(BLOCKED_MARKER),
    resumeContextSeen: obs.transcript.includes('Your parent cleared your blocker'),
    workerCommittedSeen: obs.transcript.includes('LANE_WORKER_COMMITTED'),
    workerDoneSeen: obs.transcript.includes(DONE_MARKER),
    childSawLaneContract: child && obs.transcript.includes(`<lane id="${LANE}">`),
  }
}

/** Same workspace ritual as the worktree/zombie-lane scenarios (shared WS, own lane id). */
function resetWorkspace() {
  const git = (...args) => execFileSync('git', args, { cwd: WS, stdio: 'ignore' })
  ensureWorkspaceRepo(WS)
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: WS, stdio: 'ignore' })
    for (const entry of execFileSync('git', ['branch', '--list', 'orrery/*', '--format=%(refname:short)'], { cwd: WS, encoding: 'utf8' }).split('\n').filter(Boolean)) {
      execFileSync('git', ['branch', '-D', entry], { cwd: WS, stdio: 'ignore' })
    }
  } catch {
    // no lanes yet
  }
  rmSync(join(WS, '.orrery', 'worktrees'), { recursive: true, force: true })
  assertContained(WS)
  git('add', '-A')
  git('commit', '-qm', 'fixture', '--allow-empty')
}

async function run(ctx) {
  resetWorkspace()
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const outcome = await ctx.spawnHeadless(['orrery-it', prompt], ctx.scenarioEnv(id, trace))
  return { scenario: id, trace, ...outcome }
}

function assert(view) {
  // Replay-safe: every path is resolved against the VIEW's workspace.
  const ledgerFile = join(view.ws, '.orrery', 'worktrees', 'lanes.json')
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null
  const lane = ledger?.lanes?.find((entry) => entry.id === LANE)
  // Shared audit log (suite run): key the worker by this scenario's unique
  // report text, never by record order.
  const audit = readJsonl(join(view.ws, '.orrery', 'audit.jsonl'))
  const blockedIdx = audit.findIndex((record) => record?.type === 'orrery/supervision/settle' && record?.data?.status === 'blocked' && record?.data?.report === BLOCKED_MARKER)
  const childId = blockedIdx >= 0 ? audit[blockedIdx]?.data?.childId : null
  const completedIdx = audit.findIndex((record) => record?.type === 'orrery/supervision/settle' && record?.data?.status === 'completed' && record?.data?.childId === childId)
  const checkedIdxs = audit.flatMap((record, index) => (record?.type === 'orrery/worktree/checked' && record?.data?.lane === LANE ? [index] : []))

  view.check('the lane settled landable and unbound after the terminal report', lane?.state === 'landable' && lane?.boundChild === null, JSON.stringify(lane))
  view.check('the lane-bound continuable dispatch rendered as the implicit supervised group', view.requests.some((r) => r.implicitGroupSeen), JSON.stringify(view.requests.map((r) => r.implicitGroupSeen)))
  view.check('the worker received the lane contract', view.requests.some((r) => r.childSawLaneContract), '')
  view.check('the blocked report reached the parent through the built-in settlement notice', view.requests.some((r) => r.workerBlockedSeen), '')
  view.check('the resume context reached the blocked worker', view.requests.some((r) => r.resumeContextSeen), '')
  view.check('the worker committed inside the lane and reported completed', view.requests.some((r) => r.workerCommittedSeen) && view.requests.some((r) => r.workerDoneSeen), '')
  view.check(
    'the blocked report triggered NO host check: every checked audit follows the completed settle',
    blockedIdx >= 0 && completedIdx > blockedIdx && checkedIdxs.length >= 1 && checkedIdxs.every((index) => index > completedIdx),
    JSON.stringify({ blockedIdx, completedIdx, checkedIdxs }),
  )
  view.check(
    'the resume fact is audited',
    childId != null && audit.some((record) => record?.type === 'orrery/supervision/resume' && record?.data?.childId === childId),
    JSON.stringify(childId),
  )
  view.check('parent observed the landable lane after the resume', view.stdout.includes('parent observed the landable lane after the resume'), view.stdout.slice(-400))
  view.check('headless run exited cleanly', view.code === 0 || view.code === null, `code=${view.code} stderr=${view.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert }
