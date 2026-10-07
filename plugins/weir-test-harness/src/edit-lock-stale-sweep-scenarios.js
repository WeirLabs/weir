// Scenario family: editlock-stale-sweep[-off] — the message-triggered
// stale-lock sweep. Phase 1 boots a session that writes the target (managed
// create → lock) and the auto-resume probe cancels the turn (user Stop), so
// the session ends durably interrupted with the lock retained. The driver
// then DELETES the target — a shell/external removal, outside the lock's
// protection. Phase 2 is a FRESH session in the same domain: its genuine
// user prompt is the only possible sweep trigger. ON (default): the sweep
// silently releases the dead session's lock (ordinary release, generation
// tombstone kept), audits it through weir/edit-lock-maintenance, and never
// injects into the conversation; phase 2's scripted edit_lock_status polls
// observe the lock going away. OFF: the same message schedules nothing and
// the stale lock remains. Each mode owns a private authority directory and
// target file so the two scenarios never contaminate each other.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from './mock-kit.js'
import { parseJsonlLines } from './jsonl.js'

export const staleSweepScenarios = ['on', 'off'].map((mode) => {
  const id = mode === 'on' ? 'editlock-stale-sweep' : 'editlock-stale-sweep-off'
  const boundary = mode === 'on' ? 'stale-sweep' : 'stale-sweep-off'
  const targetName = mode === 'on' ? 'stale-sweep-target.txt' : 'stale-sweep-target-off.txt'
  const targetPath = () => join(IT_ROOT, 'ws', targetName)
  const auditPath = () => join(IT_ROOT, 'ws', '.weir', 'audit.jsonl')

  function snapshotState() {
    const path = join(IT_ROOT, 'ws', '.weir', `edit-lock-${boundary}`, 'snapshot.json')
    if (!existsSync(path)) return null
    const state = JSON.parse(readFileSync(path, 'utf8'))?.payload?.state ?? null
    return state && {
      sessions: state.sessions?.map((session) => ({ sessionId: session.sessionId, interrupted: session.interrupted, epoch: session.executionEpoch })),
      locks: state.locks?.map((lock) => ({ resourceId: lock.resourceId, owner: lock.owner, status: lock.status, generation: lock.generation })),
      generations: state.generations,
    }
  }

  function decide(options, obs) {
    const history = obs?.transcript ?? transcript(options)
    const messages = options.messages ?? []
    // Phase 2: poll edit_lock_status until the sweep lands (ON) or the poll
    // budget runs out (OFF) — a deterministic wait for the detached sweep.
    if (history.includes(`${id}-sweep`)) {
      const last = messages.at(-1)
      if (last?.role !== 'tool') return toolCallChunks('edit_lock_status', {})
      const status = lastOfRole(options, 'tool')
      if (status.includes('No Edit Lock ownership is held')) return textChunks('stale lock swept')
      const polls = messages.filter((message) => message.role === 'tool').length
      if (polls >= 8) return textChunks('stale lock still present after 8 polls')
      return toolCallChunks('edit_lock_status', {})
    }
    // Phase 1: create the target; the probe cancels the turn once it lands.
    if (history.includes(`${id}-phase1`)) {
      if (messages.filter((message) => message.role === 'tool').length === 0) {
        return toolCallChunks('write', { file_path: targetPath(), content: 'phase1\n' })
      }
      return textChunks('phase-1 trailing')
    }
    return textChunks('unhandled stale-sweep turn')
  }

  return {
    id,
    prompt: `${id}-phase1`,
    env: {
      WEIR_IT_EDIT_LOCK: '1',
      // The stop-boundary pin gives this family a private fixed root and
      // authority directory (ws/.weir/edit-lock-<boundary>); the boundary's
      // own stop probe stays inert because the mode matches no cancel branch.
      WEIR_IT_STOP_BOUNDARY: boundary,
      WEIR_IT_AUTO_RESUME_TARGET: targetName,
      WEIR_IT_STALE_SWEEP: mode,
    },
    decide,
    observe(obs) { return { editLockToolsSeen: obs.toolNames.includes('edit_lock_status') } },
    async run({ spawnHeadless, scenarioEnv }) {
      const trace = join(IT_ROOT, `trace-${id}.jsonl`)
      // The cancel probe is armed for the phase-1 boot only.
      const phase1 = await spawnHeadless(['weir-it', '--json', `${id}-phase1`], scenarioEnv(id, trace, { ...this.env, WEIR_IT_AUTO_RESUME_PROBE: '1' }))
      const sessionId = parseJsonlLines(phase1.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
      appendFileSync(trace, JSON.stringify({ kind: 'stale-sweep-phase1-exit', code: phase1.code, sessionId }) + '\n')
      appendFileSync(trace, JSON.stringify({ kind: 'stale-sweep-phase1-snapshot', state: snapshotState() }) + '\n')
      if (!sessionId) return { scenario: id, trace, code: phase1.code, stdout: phase1.stdout, stderr: phase1.stderr, sessionId }
      // The target disappears outside the lock's protection (shell/external).
      rmSync(targetPath(), { force: true })
      appendFileSync(trace, JSON.stringify({ kind: 'stale-sweep-target-deleted', target: targetName }) + '\n')
      const trace2 = join(IT_ROOT, `trace-${id}-sweep.jsonl`)
      // Phase 2 is a FRESH session in the same domain; its prompt is the only
      // possible sweep trigger.
      const phase2 = await spawnHeadless(['weir-it', '--json', `${id}-sweep`], scenarioEnv(id, trace2, this.env))
      appendFileSync(trace, JSON.stringify({ kind: 'stale-sweep-phase2-exit', code: phase2.code }) + '\n')
      appendFileSync(trace, JSON.stringify({ kind: 'stale-sweep-phase2-snapshot', state: snapshotState() }) + '\n')
      return { scenario: id, trace, trace2, sessionId, code: phase2.code, stdout: phase2.stdout, stderr: `${phase1.stderr}\n${phase2.stderr}` }
    },
    assert(run) {
      const target = join(run.ws, targetName)
      const phase1Exit = run.records.find((r) => r.kind === 'stale-sweep-phase1-exit')
      const phase1Snapshot = run.records.find((r) => r.kind === 'stale-sweep-phase1-snapshot')?.state
      const phase2Snapshot = run.records.find((r) => r.kind === 'stale-sweep-phase2-snapshot')?.state
      const userMessages2 = run.records2.filter((r) => r.kind === 'session-event' && r.type === 'user/message')
      const phase2Session = userMessages2.find((r) => r.source === 'user')?.session ?? null
      const text2 = run.requests2.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`).join('\n')
      const audits2 = run.records2.filter((r) => r.kind === 'session-event' && r.type === 'weir/edit-lock-maintenance' && r.data?.kind === 'stale-sweep')
      const mirrorRows = existsSync(join(run.ws, '.weir', 'audit.jsonl'))
        ? readFileSync(join(run.ws, '.weir', 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
        : []
      // The mirror file is shared with the sibling variant (one ws per IT
      // root): only this variant's target counts.
      const mirrorSweeps = mirrorRows.filter((row) => row.type === 'weir/edit-lock-maintenance' && row.data?.kind === 'stale-sweep' && row.data?.resourceId?.endsWith(targetName))

      run.check('phase 1 session id captured', typeof run.sessionId === 'string' && run.sessionId.length > 0, JSON.stringify(run.sessionId))
      run.check('phase 1 probe stopped the turn (user abort)', run.records.some((r) => r.kind === 'auto-resume-stopped' && r.session === run.sessionId) && phase1Exit?.code === 1, JSON.stringify(phase1Exit))
      run.check('phase 1 ended interrupted with the lock retained', phase1Snapshot?.sessions?.some((s) => s.sessionId === run.sessionId && s.interrupted === true) === true && phase1Snapshot?.locks?.some((lock) => lock.owner === run.sessionId && lock.status === 'user-interrupted' && lock.resourceId.endsWith(targetName)) === true, JSON.stringify(phase1Snapshot))
      run.check('the target was deleted outside the lock between boots', run.records.some((r) => r.kind === 'stale-sweep-target-deleted') && !existsSync(target), existsSync(target) ? 'still present' : 'deleted')
      // Host-authored reminders (agent-instructions, runtime-context,
      // skill-catalog, repeat-tool-reminder) are not plugin injection: the
      // sweep's silence means no WEIR producer-tagged message at all.
      run.check('a fresh session sent exactly one genuine user message and no weir message was injected', userMessages2.filter((r) => r.source === 'user').length === 1 && !userMessages2.some((r) => typeof r.source === 'string' && r.source.startsWith('weir')) && typeof phase2Session === 'string' && phase2Session !== run.sessionId, JSON.stringify(userMessages2.map((r) => ({ source: r.source, text: r.text?.slice(0, 60) }))))
      if (mode === 'on') {
        run.check('the dead session\'s missing-target lock was silently released', text2.includes('No Edit Lock ownership is held') && !text2.includes('still present after 8 polls'), text2.slice(-800))
        run.check('the release left an ordinary generation tombstone and no lock row', phase2Snapshot?.locks?.length === 0 && phase2Snapshot?.generations?.some((g) => g.resourceId.endsWith(targetName) && g.generation === 1) === true, JSON.stringify(phase2Snapshot))
        run.check('publisher-side audit carries domain, trigger, owner, resourceId and generation', audits2.length === 1 && audits2[0].data?.trigger === phase2Session && audits2[0].data?.owner === run.sessionId && typeof audits2[0].data?.root === 'string' && audits2[0].data.root.length > 0 && audits2[0].data?.resourceId?.endsWith(targetName) === true && audits2[0].data?.generation === 1, JSON.stringify(audits2))
        run.check('the audit JSONL mirror anchored at the management root holds the sweep record', mirrorSweeps.length === 1 && mirrorSweeps[0].data?.owner === run.sessionId && mirrorSweeps[0].data?.resourceId?.endsWith(targetName) === true, JSON.stringify(mirrorSweeps))
      } else {
        run.check('gate off: the stale lock was never swept', !text2.includes('No Edit Lock ownership is held') && text2.includes(`owner=${run.sessionId}`), text2.slice(-800))
        run.check('gate off: the lock is still retained after phase 2', phase2Snapshot?.locks?.some((lock) => lock.owner === run.sessionId && lock.resourceId.endsWith(targetName)) === true, JSON.stringify(phase2Snapshot))
        run.check('gate off: no stale-sweep audit was emitted or mirrored', audits2.length === 0 && mirrorSweeps.length === 0, JSON.stringify({ audits2, mirrorSweeps }))
      }
      run.check('phase 2 exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
    },
  }
})
