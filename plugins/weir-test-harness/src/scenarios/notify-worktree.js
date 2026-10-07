// Scenario: notify-worktree — the worktree decision-card notification end to
// end. A real worktree_land execution on a real landable lane raises the
// merge-approval card; the ask funnel's side-emit (`worktree/question`,
// tapped by the event-tap) reaches the REAL mounted weir-notify module,
// whose delivery path runs all the way to the platform notification command.
//
// Seam note (why the assertion sits here): headless has no browser page, so
// notify's web channel falls back to the system command, and that command
// cannot be injected through notify's apply (it builds its own notifier).
// The narrowest REAL seam is therefore PATH: a stub `osascript`/`notify-send`
// logs its argv, and the assert reads that log. Every module between the
// card and the command — funnel emit, cordis dispatch, notify classification,
// composition, coalescing, channel fallback, notifier — is production code.
// Sessions default to auto-clean since the auto-approve feature: this
// scenario pins the CARD behavior, so the mock first switches the session to
// manual through the real /worktree approve command (the probe drives
// commands.execute). The merge-approval card is then auto-answered by the
// user-questions stub (choosing the card's first option); the cleanup card
// that follows must NOT
// emit (whitelist), which the trace assertion pins. On win32 the platform
// command (powershell.exe) cannot be PATH-stubbed, so only the emit seam is
// asserted there — the command construction itself is unit-tested.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { assertContained, ensureWorkspaceRepo } from '../git-repo.js'

const id = 'notify-worktree'
const prompt = 'notify-worktree-probe'
const WS = join(IT_ROOT, 'ws')
const LANE = 'notify-lane-001'
const TITLE = 'Notify lane'
const LANE_PATH = join(WS, '.weir', 'worktrees', LANE)
const STUB_BIN = join(IT_ROOT, 'notify-stub-bin')
// The delivery log lives INSIDE the workspace (untracked; never overlapping
// the lane's changed paths) so the fixture recorder captures it for replay.
const DELIVERY_LOG = join(WS, 'notify-delivery.log')

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  // Child brain (lane writer): one real commit inside the lane so the host
  // check settles the lane as landable.
  const child = history.includes('NOTIFY_CHILD') && !history.includes(prompt)
  if (child && history.includes('NOTIFY_CHILD_DONE')) return textChunks('NOTIFY_CHILD_DONE: nothing else to do')
  if (child) {
    if (lastTool.includes('NOTIFY_CHILD_COMMITTED')) return textChunks('NOTIFY_CHILD_DONE')
    const command = process.platform === 'win32'
      ? 'Set-Content -Path notify-lane.txt -Value "lane work"; git add -A; git commit -m "lane work"; Write-Output NOTIFY_CHILD_COMMITTED'
      : 'echo lane work > notify-lane.txt && git add -A && git commit -m "lane work" && echo NOTIFY_CHILD_COMMITTED'
    return toolCallChunks(process.platform === 'win32' ? 'pwsh' : 'bash', { command, workdir: LANE_PATH, description: 'commit the lane work' })
  }
  // Parent brain: branch on the last tool result, never on role heuristics.
  // The feature default is auto-clean: this scenario pins the CARD behavior,
  // so the session switches itself to manual through the real command path
  // before any lane exists (the probe drives commands.execute — the same
  // lifecycle a user-typed /worktree approve manual records).
  if (!history.includes('done APPROVE_MANUAL')) return toolCallChunks('worktree_approve_probe', { op: 'approve', mode: 'manual', _marker: 'APPROVE_MANUAL' })
  // The probe result is the first non-empty tool turn, so the open gate must
  // not hide behind the lastTool fallback (it branches on history only).
  if (!history.includes(`lane ${LANE}: ready`) && !history.includes(`merged weir/${LANE} into main`)) return toolCallChunks('worktree_open', { title: TITLE })
  if (lastTool.includes(`merged weir/${LANE} into main`)) return textChunks('NOTIFY_PROBE_DONE')
  if (lastTool.includes(`[worktree] lane ${LANE} landable`)) return toolCallChunks('worktree_land', { lane: LANE })
  if (lastTool.includes(`lane ${LANE}: ready`)) {
    return toolCallChunks('delegate', {
      category: 'quick',
      worktree: LANE,
      prompt: 'NOTIFY_CHILD\nTASK: commit the lane work\nDELIVERABLE: a commit\nSCOPE: the lane\nVERIFY: done\nSTOP WHEN: done',
    })
  }
  if (lastTool !== '') return textChunks(`unhandled notify-worktree tool turn: ${lastTool.slice(0, 160)}`)
  if (history.includes(prompt)) return toolCallChunks('worktree_open', { title: TITLE })
  return textChunks('unhandled notify-worktree turn')
}

function observe(obs) {
  return {
    // The merge result line reached the parent's context (land succeeded).
    notifyMergeSeen: obs.transcript.includes(`merged weir/${LANE} into main`),
    approveManualOk: /done APPROVE_MANUAL:.*"commandKind":"success"/.test(obs.transcript)
      && /done APPROVE_MANUAL:.*Auto-approve mode: manual \(session override; the global default remains auto-clean\)/.test(obs.transcript),
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
  // The notification platform command, stubbed on PATH (win32 excluded: its
  // command is powershell.exe, which a shell script cannot impersonate).
  const pathOverlay = {}
  if (process.platform !== 'win32') {
    mkdirSync(STUB_BIN, { recursive: true })
    rmSync(DELIVERY_LOG, { force: true })
    const stub = `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(DELIVERY_LOG)}\ndone\n`
    for (const command of ['osascript', 'notify-send']) {
      writeFileSync(join(STUB_BIN, command), stub)
      chmodSync(join(STUB_BIN, command), 0o755)
    }
    pathOverlay.PATH = `${STUB_BIN}${delimiter}${process.env.PATH ?? ''}`
  }
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const outcome = await ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, trace, { WEIR_IT_NOTIFY_WORKTREE: '1', ...pathOverlay }))
  return { scenario: id, trace, ...outcome }
}

function assert(view) {
  // Replay-safe: ledger and delivery log resolve against the VIEW's workspace.
  const ledgerFile = join(view.ws, '.weir', 'worktrees', 'lanes.json')
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null
  const lane = ledger?.lanes?.find((entry) => entry.id === LANE)
  const taps = view.records.filter((record) => record.kind === 'worktree-question')
  view.check('the lane merged through the auto-approved card and was kept afterwards', lane?.state === 'kept' && typeof lane?.land?.commit === 'string', JSON.stringify(lane))
  view.check('the session switched itself to manual before the land (session override echo)', view.requests.some((record) => record.approveManualOk), JSON.stringify(view.requests.filter((record) => record.lastTool?.includes('done APPROVE_MANUAL'))))
  view.check(
    'the ask funnel emitted worktree/question exactly once, for the merge-approval card',
    taps.length === 1 && taps[0]?.question === `Merge lane "${TITLE}" into main?` && typeof taps[0]?.session === 'string',
    JSON.stringify(taps),
  )
  view.check('the cleanup card stayed silent (whitelist)', !taps.some((record) => record.question?.includes('What should happen')), JSON.stringify(taps))
  if (process.platform !== 'win32') {
    const deliveryFile = join(view.ws, 'notify-delivery.log')
    const delivery = existsSync(deliveryFile) ? readFileSync(deliveryFile, 'utf8') : ''
    const lines = delivery.split(/\r?\n/)
    view.check('the mounted notify module delivered "Question for you" to the platform command', lines.includes('Question for you'), delivery.slice(-400))
    view.check('the delivered body carries the merge question text', lines.some((line) => line.includes(`Merge lane "${TITLE}" into main?`)), delivery.slice(-400))
  }
  view.check('the parent finished after the merge', view.stdout.includes('NOTIFY_PROBE_DONE'), view.stdout.slice(-400))
  view.check('headless run exited cleanly', view.code === 0 || view.code === null, `code=${view.code} stderr=${view.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert }
