// Scenario: editlock-cold-view — the Edit Lock status view is cold-read safe.
// Three boots share ONE pinned authority:
//   1. seed boot: writes the target, then the probe cancels the turn (user
//      Stop) so the session ends durably interrupted with the lock retained;
//   2. cold-read boot: a FRESH session asks the view endpoint about the seeded
//      session (no live agent for it in this process — the GUI's restored-
//      session shape) through the capturing-connection probe. The first panel
//      read must show the TRUE stopped view (cold marker, retained lock,
//      auto-resume gate), never "Edit Lock is starting";
//   3. resume boot: adopts the seeded session and sends a genuine user
//      message — auto-resume restores the binding and editing works.
// Assert-replay discipline: every fact the assert reads travels INSIDE the
// two traces (owner rows, target content, final requestId/epoch), so the
// fixture needs no workspace file copies.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { parseJsonlLines } from '../jsonl.js'
import { textOf } from '../message-text.js'

const id = 'editlock-cold-view'
const targetName = 'cold-view-target.txt'
const targetPath = () => join(IT_ROOT, 'ws', targetName)
const snapshotPath = () => join(IT_ROOT, 'ws', '.orrery', 'edit-lock-cold-view', 'snapshot.json')
// ORRERY_IT_STOP_BOUNDARY pins a PRIVATE authority (.orrery/edit-lock-cold-view,
// the crash-recovery pattern: the stop probe's boundary hooks never fire for an
// unknown mode) — no shared-authority contamination with the other families.
const env = { ORRERY_IT_EDIT_LOCK: '1', ORRERY_IT_STOP_BOUNDARY: 'cold-view', ORRERY_IT_EDIT_LOCK_COLD: '1', ORRERY_IT_AUTO_RESUME_TARGET: targetName }

/** The committed image, or null when no authority exists yet. */
function imageState() {
  if (!existsSync(snapshotPath())) return null
  return JSON.parse(readFileSync(snapshotPath(), 'utf8'))?.payload?.state ?? null
}
/** The seeded session's recorded rows (nothing else's). */
function ownerState(sessionId) {
  const state = imageState()
  return state && sessionId && {
    session: state.sessions?.find((session) => session.sessionId === sessionId) ?? null,
    locks: state.locks?.filter((lock) => lock.owner === sessionId).map((lock) => ({ resourceId: lock.resourceId, status: lock.status })),
  }
}
/** Post-resume facts: the auto requestId count and the session's execution epoch. */
function finalFacts(sessionId) {
  const state = imageState()
  return state && sessionId && {
    autoRequestIds: state.issuedRequests?.filter((row) => row.sessionId === sessionId && typeof row.requestId === 'string' && row.requestId.startsWith('auto:user-message:')).length ?? 0,
    epoch: state.sessions?.find((session) => session.sessionId === sessionId)?.executionEpoch ?? null,
  }
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const messages = options.messages ?? []
  // The cold-read boot needs no tools: the probe's endpoint call is the payload.
  if (history.includes(`${id}-read`)) return textChunks('cold read boot done')
  const phase3 = history.includes(`${id}-resume`)
  const marker = phase3 ? `${id}-resume` : `${id}-phase1`
  const markerAt = messages.findLastIndex((message) => message.role === 'user' && textOf(message).includes(marker))
  const phaseMessages = markerAt === -1 ? [] : messages.slice(markerAt + 1)
  const toolResults = phaseMessages.filter((message) => message.role === 'tool').length
  if (phase3) {
    // The message itself resumed the session (auto-resume): read back, then
    // overwrite, then release — no /edit-lock resume exists headlessly.
    if (toolResults === 0) return toolCallChunks('read', { file_path: targetPath() })
    if (toolResults === 1) return toolCallChunks('write', { file_path: targetPath(), content: 'phase3\n' })
    if (toolResults === 2) return toolCallChunks('edit_lock_release', { file_path: targetPath() })
    return textChunks('cold view resume editing restored')
  }
  // Seed boot: create the target; the probe cancels the turn once it lands.
  if (toolResults === 0) return toolCallChunks('write', { file_path: targetPath(), content: 'phase1\n' })
  return textChunks('phase-1 trailing')
}

async function run({ spawnHeadless, scenarioEnv }) {
  // The seed and cold-read boots append to the SAME main trace (sequential
  // boots); the resume boot owns trace2 (run-view's requests2).
  const trace = join(IT_ROOT, `trace-${id}.jsonl`)
  const trace2 = join(IT_ROOT, `trace-${id}-resume.jsonl`)
  const seed = await spawnHeadless(['orrery-it', '--json', `${id}-phase1`], scenarioEnv(id, trace, { ...env, ORRERY_IT_AUTO_RESUME_PROBE: '1' }))
  const sessionId = parseJsonlLines(seed.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
  appendFileSync(trace, JSON.stringify({ kind: 'cold-view-phase1-exit', code: seed.code, sessionId, owner: ownerState(sessionId) }) + '\n')
  const readBoot = sessionId
    ? await spawnHeadless(['orrery-it', `${id}-read`], scenarioEnv(id, trace, { ...env, ORRERY_IT_COLD_VIEW_SESSION: sessionId }))
    : { code: 1, stdout: '', stderr: 'no session id from the seed boot' }
  appendFileSync(trace, JSON.stringify({ kind: 'cold-view-phase2-exit', code: readBoot.code, owner: ownerState(sessionId) }) + '\n')
  const resume = sessionId
    ? await spawnHeadless(['orrery-it', '--session-id', sessionId, `${id}-resume`], scenarioEnv(id, trace2, env))
    : readBoot
  appendFileSync(trace, JSON.stringify({
    kind: 'cold-view-phase3-exit', code: resume.code,
    target: existsSync(targetPath()) ? readFileSync(targetPath(), 'utf8') : null,
    final: finalFacts(sessionId),
  }) + '\n')
  return { scenario: id, trace, trace2, sessionId, code: resume.code, stdout: resume.stdout, stderr: `${seed.stderr}\n${readBoot.stderr}\n${resume.stderr}` }
}

function assert(run) {
  const json = (value) => JSON.stringify(value)
  const phase1Exit = run.records.find((r) => r.kind === 'cold-view-phase1-exit')
  const phase2Exit = run.records.find((r) => r.kind === 'cold-view-phase2-exit')
  const phase3Exit = run.records.find((r) => r.kind === 'cold-view-phase3-exit')
  const text2 = run.requests2.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`).join('\n')

  // ---- seed boot: durably interrupted, lock retained ----
  run.check('seed session id captured', typeof run.sessionId === 'string' && run.sessionId.length > 0, json(run.sessionId))
  run.check('seed probe stopped the turn (user abort)', run.records.some((r) => r.kind === 'auto-resume-stopped' && r.session === run.sessionId) && phase1Exit?.code === 1, json(phase1Exit))
  run.check('seed ended interrupted with the lock retained', phase1Exit?.owner?.session?.interrupted === true && phase1Exit?.owner?.locks?.some((lock) => lock.status === 'user-interrupted') === true, json(phase1Exit?.owner))

  // ---- cold-read boot: the first panel read shows the TRUE stopped view ----
  const coldView = run.records.find((r) => r.kind === 'cold-view' && r.session === run.sessionId)
  run.check('the cold-read boot asked the view endpoint about the restored session', coldView !== undefined && coldView.error === undefined, json(coldView?.error ?? 'no cold-view record'))
  const value = coldView?.view?.ok === true ? coldView.view.value : null
  run.check('the endpoint answered ok', value !== null, json(coldView?.view))
  // The regression: the old chain answered { state: 'unavailable', reason: null }
  // here, which the panel renders as "Edit Lock is starting" — forever.
  run.check('first read is the true stopped view, never starting', value?.state === 'stopped' && value?.reason == null, json({ state: value?.state, reason: value?.reason }))
  run.check('the view carries the cold marker and the auto-resume gate', value?.cold === true && value?.autoResume === true, json({ cold: value?.cold, autoResume: value?.autoResume }))
  run.check('the retained lock is listed as the session\'s own', value?.files?.some((file) => file.name === targetName && file.mine === true && file.status === 'user-interrupted') === true, json(value?.files))
  // Read-only: the seeded session's recorded rows survived the whole cold-read
  // boot untouched (the boot's own session may add its rows; S's may not move).
  run.check('the cold read mutated nothing about the restored session', json(phase1Exit?.owner) === json(phase2Exit?.owner), json({ before: phase1Exit?.owner, after: phase2Exit?.owner }))
  run.check('cold-read boot exited cleanly', phase2Exit?.code === 0 || phase2Exit?.code === null, json(phase2Exit?.code))

  // ---- resume boot: a genuine message restores the binding ----
  run.check('a genuine user message arrived in the stopped session', run.records2.some((r) => r.kind === 'session-event' && r.type === 'user/message' && r.source === 'user' && r.session === run.sessionId), json(run.records2.filter((r) => r.type === 'user/message')))
  run.check('edit lock owner tools advertised in the resume boot', run.requests2.some((r) => r.editLockToolsSeen), json(run.requests2.map((r) => r.toolNames ?? [])))
  run.check('editing works after the message (auto-resume)', phase3Exit?.target === 'phase3\n', json(phase3Exit?.target))
  run.check('no edit was denied in the resume boot', !text2.includes('was stopped'), text2.slice(-800))
  run.check('the retained lock was confirmed and released inside the flow', text2.includes('Released'), text2.slice(-800))
  run.check('resume used a fresh server-minted auto requestId', (phase3Exit?.final?.autoRequestIds ?? 0) >= 1, json(phase3Exit?.final))
  run.check('the resume minted a new execution epoch', (phase3Exit?.final?.epoch ?? 0) >= 3, json(phase3Exit?.final))
  run.check('resume boot exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt: `${id}-phase1`, env, decide, observe: (obs) => ({ editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire') }), run, assert }
