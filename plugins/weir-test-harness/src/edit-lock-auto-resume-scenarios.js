// Scenario family: editlock-auto-resume[-off] — message-driven auto-resume of a
// stopped Edit Lock session (design D1–D6). Two boots share ONE session id
// (rehydrate pattern): phase 1 writes the target and the probe cancels the turn
// (user Stop) so the session ends durably interrupted with the lock retained;
// phase 2 adopts the same session and sends a genuine user message — nothing
// else. With the gate ON (default) the message itself resumes the session and
// confirms the retained lock before the first step, so the scripted read →
// write → release flow succeeds with no /edit-lock resume anywhere (a headless
// profile has no command path at all). With the gate OFF the same write is
// denied and the session stays stopped. Each mode owns a private authority
// directory and target file so the two scenarios never contaminate each other.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from './mock-kit.js'
import { parseJsonlLines } from './jsonl.js'
import { textOf } from './message-text.js'

export const autoResumeScenarios = ['on', 'off'].map((mode) => {
  const id = mode === 'on' ? 'editlock-auto-resume' : 'editlock-auto-resume-off'
  const targetName = mode === 'on' ? 'auto-resume-target.txt' : 'auto-resume-target-off.txt'
  const authorityName = mode === 'on' ? 'edit-lock-auto-resume' : 'edit-lock-auto-resume-off'
  const targetPath = () => join(IT_ROOT, 'ws', targetName)

  function snapshotState() {
    const path = join(IT_ROOT, 'ws', '.weir', authorityName, 'snapshot.json')
    if (!existsSync(path)) return null
    const state = JSON.parse(readFileSync(path, 'utf8'))?.payload?.state ?? null
    return state && {
      sessions: state.sessions?.map((session) => ({ sessionId: session.sessionId, interrupted: session.interrupted, revoked: session.revoked === true, epoch: session.executionEpoch })),
      locks: state.locks?.map((lock) => ({ resourceId: lock.resourceId, owner: lock.owner, status: lock.status })),
      issuedRequests: state.issuedRequests,
    }
  }

  function decide(options, obs) {
    const history = obs?.transcript ?? transcript(options)
    const messages = options.messages ?? []
    // An adopted session carries phase 1's messages too: count only the tool
    // results of the CURRENT phase (after its prompt message).
    const phase2 = history.includes(`${id}-resume`)
    const marker = phase2 ? `${id}-resume` : `${id}-phase1`
    const markerAt = messages.findLastIndex((message) => message.role === 'user' && textOf(message).includes(marker))
    const phaseMessages = markerAt === -1 ? [] : messages.slice(markerAt + 1)
    const toolResults = phaseMessages.filter((message) => message.role === 'tool').length
    // Phase 2 (same session, adopted by a fresh process): read the target back,
    // then overwrite it. ON: both succeed; release ends the batch cleanly.
    // OFF: the write is denied ('was stopped') and the turn just ends.
    if (phase2) {
      if (toolResults === 0) return toolCallChunks('read', { file_path: targetPath() })
      if (toolResults === 1) return toolCallChunks('write', { file_path: targetPath(), content: 'phase2\n' })
      if (mode === 'on' && toolResults === 2) return toolCallChunks('edit_lock_release', { file_path: targetPath() })
      return textChunks(mode === 'on' ? 'auto-resume editing restored' : 'auto-resume-off stayed stopped')
    }
    // Phase 1: create the target; the probe cancels the turn once it lands.
    if (toolResults === 0) return toolCallChunks('write', { file_path: targetPath(), content: 'phase1\n' })
    return textChunks('phase-1 trailing')
  }

  return {
    id,
    prompt: `${id}-phase1`,
    env: { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_AUTO_RESUME: mode, WEIR_IT_AUTO_RESUME_TARGET: targetName },
    decide,
    observe(obs) { return { editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire') } },
    async run({ spawnHeadless, scenarioEnv }) {
      const trace = join(IT_ROOT, `trace-${id}.jsonl`)
      // The probe is armed for the phase-1 boot only; phase 2 must not stop again.
      const phase1 = await spawnHeadless(['weir-it', '--json', `${id}-phase1`], scenarioEnv(id, trace, { ...this.env, WEIR_IT_AUTO_RESUME_PROBE: '1' }))
      const sessionId = parseJsonlLines(phase1.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
      appendFileSync(trace, JSON.stringify({ kind: 'auto-resume-phase1-exit', code: phase1.code, sessionId }) + '\n')
      appendFileSync(trace, JSON.stringify({ kind: 'auto-resume-phase1-snapshot', state: snapshotState() }) + '\n')
      if (!sessionId) return { scenario: id, trace, code: phase1.code, stdout: phase1.stdout, stderr: phase1.stderr, sessionId }
      const trace2 = join(IT_ROOT, `trace-${id}-resume.jsonl`)
      const phase2 = await spawnHeadless(['weir-it', '--session-id', sessionId, `${id}-resume`], scenarioEnv(id, trace2, this.env))
      appendFileSync(trace, JSON.stringify({ kind: 'auto-resume-phase2-exit', code: phase2.code }) + '\n')
      appendFileSync(trace, JSON.stringify({ kind: 'auto-resume-phase2-snapshot', state: snapshotState() }) + '\n')
      return { scenario: id, trace, trace2, sessionId, code: phase2.code, stdout: phase2.stdout, stderr: `${phase1.stderr}\n${phase2.stderr}` }
    },
    assert(run) {
      const target = join(run.ws, targetName)
      const phase1Exit = run.records.find((r) => r.kind === 'auto-resume-phase1-exit')
      const phase1Snapshot = run.records.find((r) => r.kind === 'auto-resume-phase1-snapshot')?.state
      const phase2Snapshot = run.records.find((r) => r.kind === 'auto-resume-phase2-snapshot')?.state
      const text2 = run.requests2.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`).join('\n')
      run.check('phase 1 session id captured', typeof run.sessionId === 'string' && run.sessionId.length > 0, JSON.stringify(run.sessionId))
      run.check('phase 1 probe stopped the turn (user abort)', run.records.some((r) => r.kind === 'auto-resume-stopped' && r.session === run.sessionId) && phase1Exit?.code === 1, JSON.stringify(phase1Exit))
      run.check('phase 1 ended interrupted with the lock retained', phase1Snapshot?.sessions?.some((s) => s.sessionId === run.sessionId && s.interrupted === true) === true && phase1Snapshot?.locks?.some((lock) => lock.owner === run.sessionId && lock.status === 'user-interrupted') === true, JSON.stringify(phase1Snapshot))
      // The phase-2 prompt is a genuine user message in the same session (the
      // event tap records the source kind) — the only possible resume trigger.
      run.check('a genuine user message arrived in the stopped session', run.records2.some((r) => r.kind === 'session-event' && r.type === 'user/message' && r.source === 'user' && r.session === run.sessionId), JSON.stringify(run.records2.filter((r) => r.type === 'user/message')))
      if (mode === 'on') {
        run.check('edit lock owner tools advertised in phase 2', run.requests2.some((r) => r.editLockToolsSeen), JSON.stringify(run.requests2.map((r) => r.toolNames ?? [])))
        // No manual resume exists headlessly: the write landing at all IS the
        // proof that the message-driven resume + confirm-all ran first.
        run.check('editing works without any manual /edit-lock resume', existsSync(target) && readFileSync(target, 'utf8') === 'phase2\n', existsSync(target) ? readFileSync(target, 'utf8') : 'missing')
        run.check('no edit was denied in phase 2', !text2.includes('was stopped'), text2.slice(-800))
        run.check('the retained lock was confirmed and released inside the flow', text2.includes('Released'), text2.slice(-800))
        run.check('resume used a fresh server-minted auto requestId', phase2Snapshot?.issuedRequests?.some((r) => r.sessionId === run.sessionId && typeof r.requestId === 'string' && r.requestId.startsWith('auto:user-message:')) === true, JSON.stringify(phase2Snapshot?.issuedRequests))
        // A session is always durably interrupted after its process exits (the
        // pinned "restart starts interrupted" design), so the observable proof
        // is the epoch the resume minted: cancel → 2, resume → 3 (dispose → 4).
        run.check('the auto-resume minted a new execution epoch', (phase2Snapshot?.sessions?.find((s) => s.sessionId === run.sessionId)?.epoch ?? 0) >= 3, JSON.stringify(phase2Snapshot?.sessions))
      } else {
        run.check('gate off: the write is denied and the target is unchanged', existsSync(target) && readFileSync(target, 'utf8') === 'phase1\n' && text2.includes('was stopped'), `${existsSync(target) ? readFileSync(target, 'utf8') : 'missing'} :: ${text2.slice(-800)}`)
        run.check('gate off: the session stays durably interrupted', phase2Snapshot?.sessions?.some((s) => s.sessionId === run.sessionId && s.interrupted === true) === true && phase2Snapshot?.locks?.some((lock) => lock.owner === run.sessionId && lock.status === 'user-interrupted') === true, JSON.stringify(phase2Snapshot))
        run.check('gate off: no auto requestId was issued', phase2Snapshot?.issuedRequests?.some((r) => typeof r.requestId === 'string' && r.requestId.startsWith('auto:user-message:')) !== true, JSON.stringify(phase2Snapshot?.issuedRequests))
      }
      run.check('phase 2 exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
    },
  }
})
