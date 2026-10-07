// Scenario: worktree-auto-approve — the per-session Worktree auto-approve
// modes end to end. The probe drives the REAL /worktree approve command
// (commands.execute → command/run + command/done session events, the same
// lifecycle a user-typed switch records), so the orreryWorktree projection
// folds the override exactly like production. Then two real lanes land
// card-free:
//   - auto-clean: worktree_land skips the merge-approval AND the cleanup
//     card, merges after the usual prechecks, and cleans with mode `all`
//     (worktree removed, branch deleted; lane `cleaned`);
//   - auto-keep: same skip, cleanup with mode `worktree` (branch kept).
// The zero-card claim is pinned on the event-tap: the ask funnel's
// `worktree/question` side-emit must never fire in an auto land. The
// user-questions stub is mounted anyway, so a wrongly raised card would be
// answered and the trace assertion (not a hang) reports the regression.
// The invalid switch is rejected listing the three modes with the mode
// unchanged; every successful switch echoes the effective mode and its
// source (global default or session override).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { readJsonl } from '../jsonl.js'
import { assertContained, ensureWorkspaceRepo } from '../git-repo.js'

const id = 'worktree-auto-approve'
const prompt = 'worktree-auto-approve-probe'
const WS = join(IT_ROOT, 'ws')
const LANE_CLEAN = 'auto-clean-lane-001' // worktree_open({ title: 'Auto clean lane' })
const LANE_KEEP = 'auto-keep-lane-002' // worktree_open({ title: 'Auto keep lane' })
const CLEAN_PATH = join(WS, '.orrery', 'worktrees', LANE_CLEAN)
const KEEP_PATH = join(WS, '.orrery', 'worktrees', LANE_KEEP)

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  // Child brain (lane writer): one real commit inside its lane so the host
  // check settles the lane as landable. Lane 2's prompt carries the KEEP
  // marker, lane 1's does not; the parent's history leaks both markers into
  // lane 2's context, so the child picks its own marker to stay apart.
  const child = history.includes('AUTO_APPROVE_CHILD') && !history.includes(prompt)
  if (child) {
    const keep = history.includes('AUTO_APPROVE_KEEP_CHILD')
    const done = keep ? 'AUTO_APPROVE_KEEP_CHILD_DONE' : 'AUTO_APPROVE_CLEAN_CHILD_DONE'
    const committed = keep ? 'AUTO_APPROVE_KEEP_CHILD_COMMITTED' : 'AUTO_APPROVE_CLEAN_CHILD_COMMITTED'
    if (history.includes(done)) return textChunks(`${done}: nothing else to do`)
    if (lastTool.includes(committed)) return textChunks(done)
    const file = keep ? 'keep-lane.txt' : 'clean-lane.txt'
    const command = process.platform === 'win32'
      ? `Set-Content -Path ${file} -Value "lane work"; git add -A; git commit -m "lane work"; Write-Output ${committed}`
      : `echo lane work > ${file} && git add -A && git commit -m "lane work" && echo ${committed}`
    return toolCallChunks(process.platform === 'win32' ? 'pwsh' : 'bash', { command, workdir: keep ? KEEP_PATH : CLEAN_PATH, description: 'commit the lane work' })
  }
  // Parent brain. Phase 1 — the /worktree approve command path: an invalid
  // value is rejected with the three modes listed (the mode stays unset),
  // then auto-clean is switched on through the real commands service and
  // re-read from the folded projection on a later turn.
  if (!history.includes('done invalid')) return toolCallChunks('worktree_approve_probe', { op: 'invalid', _marker: 'invalid' })
  if (!history.includes('done view-null')) return toolCallChunks('worktree_approve_probe', { op: 'view', _marker: 'view-null' })
  if (!history.includes('done switch-clean')) return toolCallChunks('worktree_approve_probe', { op: 'approve', mode: 'auto-clean', _marker: 'switch-clean' })
  if (!history.includes('done view-clean')) return toolCallChunks('worktree_approve_probe', { op: 'view', _marker: 'view-clean' })
  // Phase 2 — lane 1 under auto-clean: open, bind a writer, land card-free.
  if (!history.includes(`lane ${LANE_CLEAN}: ready`) && !history.includes(`merged orrery/${LANE_CLEAN} into main`)) {
    return toolCallChunks('worktree_open', { title: 'Auto clean lane' })
  }
  if (history.includes(`lane ${LANE_CLEAN}: ready`) && !history.includes('AUTO_APPROVE_CHILD')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      worktree: LANE_CLEAN,
      prompt: 'AUTO_APPROVE_CHILD\nTASK: commit the lane work\nDELIVERABLE: a commit\nSCOPE: the lane\nVERIFY: done\nSTOP WHEN: done',
    })
  }
  if (lastTool.includes(`[worktree] lane ${LANE_CLEAN} landable`) && !history.includes(`merged orrery/${LANE_CLEAN} into main`)) {
    return toolCallChunks('worktree_land', { lane: LANE_CLEAN })
  }
  // Phase 3 — switch to auto-keep through the same command path, then lane 2.
  if (history.includes(`merged orrery/${LANE_CLEAN} into main`) && !history.includes('done switch-keep')) {
    return toolCallChunks('worktree_approve_probe', { op: 'approve', mode: 'auto-keep', _marker: 'switch-keep' })
  }
  if (history.includes('done switch-keep') && !history.includes('done view-keep')) return toolCallChunks('worktree_approve_probe', { op: 'view', _marker: 'view-keep' })
  if (history.includes('done view-keep') && !history.includes(`lane ${LANE_KEEP}: ready`)) {
    return toolCallChunks('worktree_open', { title: 'Auto keep lane' })
  }
  if (history.includes(`lane ${LANE_KEEP}: ready`) && !history.includes('AUTO_APPROVE_KEEP_CHILD')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      worktree: LANE_KEEP,
      prompt: 'AUTO_APPROVE_CHILD\nAUTO_APPROVE_KEEP_CHILD\nTASK: commit the lane work\nDELIVERABLE: a commit\nSCOPE: the lane\nVERIFY: done\nSTOP WHEN: done',
    })
  }
  if (lastTool.includes(`[worktree] lane ${LANE_KEEP} landable`) && !history.includes(`merged orrery/${LANE_KEEP} into main`)) {
    return toolCallChunks('worktree_land', { lane: LANE_KEEP })
  }
  if (history.includes(`merged orrery/${LANE_KEEP} into main`)) return textChunks('WORKTREE_AUTO_APPROVE_DONE')
  if (lastTool !== '') return textChunks(`unhandled worktree-auto-approve turn: ${lastTool.slice(0, 160)}`)
  if (history.includes(prompt)) return toolCallChunks('worktree_approve_probe', { op: 'invalid', _marker: 'invalid' })
  return textChunks('unhandled worktree-auto-approve turn')
}

function observe(obs) {
  const history = obs?.transcript ?? ''
  return {
    invalidRejected: /done invalid:.*"commandKind":"error"/.test(history)
      && /done invalid:.*valid modes: manual, auto-keep, auto-clean/.test(history)
      && /done invalid:.*"foldedApprove":null/.test(history),
    switchCleanOk: /done switch-clean:.*"commandKind":"success"/.test(history)
      && /done switch-clean:.*Auto-approve mode: auto-clean \(matches the global default; the session now keeps this mode even if the global setting changes\)/.test(history)
      && /done switch-clean:.*"foldedApprove":"auto-clean"/.test(history),
    viewCleanOk: /done view-clean:.*"foldedApprove":"auto-clean"/.test(history),
    switchKeepOk: /done switch-keep:.*"commandKind":"success"/.test(history)
      && /done switch-keep:.*Auto-approve mode: auto-keep \(session override; the global default remains auto-clean\)/.test(history),
    viewKeepOk: /done view-keep:.*"foldedApprove":"auto-keep"/.test(history),
    cleanLaneLanded: history.includes(`merged orrery/${LANE_CLEAN} into main`),
    keepLaneLanded: history.includes(`merged orrery/${LANE_KEEP} into main`),
  }
}

/** Same workspace ritual as the worktree scenario (shared WS, own lane ids). */
async function run(ctx) {
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
  // Belt and braces: never stage/commit anywhere but the WS repo itself.
  assertContained(WS)
  git('add', '-A')
  git('commit', '-qm', 'fixture', '--allow-empty')
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const outcome = await ctx.spawnHeadless(['orrery-it', prompt], ctx.scenarioEnv(id, trace, { ORRERY_IT_WORKTREE_AUTO_APPROVE: '1' }))
  return { scenario: id, trace, ...outcome }
}

function assert(view) {
  const ledgerFile = join(view.ws, '.orrery', 'worktrees', 'lanes.json')
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null
  const laneClean = ledger?.lanes?.find((entry) => entry.id === LANE_CLEAN)
  const laneKeep = ledger?.lanes?.find((entry) => entry.id === LANE_KEEP)
  const questions = view.records.filter((record) => record.kind === 'worktree-question')
  // The audit log is SHARED with every earlier scenario in the suite run, so
  // every lookup is keyed by this scenario's own lane ids.
  const audit = readJsonl(join(view.ws, '.orrery', 'audit.jsonl'))
  const auditFor = (laneId, kind, extra = {}) => audit.find(
    (record) => record?.type === `orrery/worktree/${kind}`
      && record?.data?.lane === laneId
      && Object.entries(extra).every(([key, value]) => record?.data?.[key] === value),
  )

  view.check('the invalid switch was rejected listing the three modes (mode unchanged)', view.requests.some((record) => record.invalidRejected), JSON.stringify(view.requests.filter((record) => record.lastTool?.includes('done invalid'))))
  view.check('the auto-clean switch echoed the effective mode and folded into the projection', view.requests.some((record) => record.switchCleanOk) && view.requests.some((record) => record.viewCleanOk), '')
  view.check('the auto-keep switch echoed a session override and folded into the projection', view.requests.some((record) => record.switchKeepOk) && view.requests.some((record) => record.viewKeepOk), '')
  view.check('no decision card was asked: zero worktree/question events across both auto lands', questions.length === 0, JSON.stringify(questions))
  view.check('the auto-clean land merged without a card', view.requests.some((record) => record.cleanLaneLanded), '')
  view.check(
    'lane 1 was cleaned with mode all (worktree removed, branch deleted)',
    laneClean?.state === 'cleaned' && laneClean?.cleanup?.mode === 'all' && laneClean?.cleanup?.by === 'host' && typeof laneClean?.land?.commit === 'string',
    JSON.stringify(laneClean),
  )
  view.check(
    'lane 2 was cleaned with mode worktree (branch kept)',
    laneKeep?.state === 'cleaned' && laneKeep?.cleanup?.mode === 'worktree' && laneKeep?.cleanup?.by === 'host' && typeof laneKeep?.land?.commit === 'string',
    JSON.stringify(laneKeep),
  )
  view.check(
    'both lane worktrees are gone from disk',
    !existsSync(join(view.ws, '.orrery', 'worktrees', LANE_CLEAN)) && !existsSync(join(view.ws, '.orrery', 'worktrees', LANE_KEEP)),
    '',
  )
  view.check(
    'the auto-clean land and cleanup audits carry the auto marker',
    Boolean(auditFor(LANE_CLEAN, 'land', { auto: true, approveMode: 'auto-clean' })) && Boolean(auditFor(LANE_CLEAN, 'cleanup', { auto: true, approveMode: 'auto-clean', mode: 'all' })),
    JSON.stringify(audit.filter((record) => record?.type === 'orrery/worktree/land' || record?.type === 'orrery/worktree/cleanup')),
  )
  view.check(
    'the auto-keep land and cleanup audits carry the auto marker',
    Boolean(auditFor(LANE_KEEP, 'land', { auto: true, approveMode: 'auto-keep' })) && Boolean(auditFor(LANE_KEEP, 'cleanup', { auto: true, approveMode: 'auto-keep', mode: 'worktree' })),
    '',
  )
  // Live-only git facts (replay fixtures hold no repository): the merged
  // branch was deleted for lane 1 and kept for lane 2.
  if (existsSync(join(view.ws, '.git'))) {
    const branches = execFileSync('git', ['branch', '--list', 'orrery/*', '--format=%(refname:short)'], { cwd: view.ws, encoding: 'utf8' }).split('\n').filter(Boolean)
    view.check('auto-clean deleted the lane branch', !branches.includes(`orrery/${LANE_CLEAN}`), branches.join(', '))
    view.check('auto-keep kept the lane branch', branches.includes(`orrery/${LANE_KEEP}`), branches.join(', '))
  }
  view.check('the parent finished after both auto lands', view.stdout.includes('WORKTREE_AUTO_APPROVE_DONE'), view.stdout.slice(-400))
  view.check('headless run exited cleanly', view.code === 0 || view.code === null, `code=${view.code} stderr=${view.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert }
