// Dev-only probe for the editlock-auto-resume scenarios: simulates the user
// pressing Stop once the scripted write has genuinely landed. The cancel runs
// after the underlying fs write returns — the editlock-stop-* family pins that
// an edit-lock operation, once dispatched, commits unconditionally — so the
// session ends durably interrupted with the target lock user-interrupted.
// Armed per process via ORRERY_IT_AUTO_RESUME_PROBE=1 (phase 1 boots only).
import { join } from 'node:path'

export function installAutoResumeProbe(ctx, tap) {
  // Both phases record the live editLock settings section the composition's
  // gate reads (the OFF counter-case exists to prove this value gates).
  if (process.env.ORRERY_IT_AUTO_RESUME) {
    ctx.on('agent/created', ({ agent: created }) => {
      if (created?.session?.header?.origin === 'subagent') return
      let section = null
      try { section = ctx.get?.('orrerySettings')?.get?.('editLock') ?? null } catch (error) { section = { error: String(error?.message ?? error) } }
      tap({ kind: 'auto-resume-settings', session: created.id, section })
    })
  }
  if (process.env.ORRERY_IT_AUTO_RESUME_PROBE !== '1') return
  const targetPath = join(process.env.ORRERY_IT_ROOT, 'ws', process.env.ORRERY_IT_AUTO_RESUME_TARGET ?? 'auto-resume-target.txt')
  let agent
  let stopped = false
  ctx.on('agent/created', ({ agent: created }) => {
    if (created?.session?.header?.origin !== 'subagent') agent ??= created
  })
  const writeText = ctx.fs?.writeText
  if (typeof writeText !== 'function') throw new Error('auto-resume probe requires the host filesystem writeText')
  ctx.fs.writeText = async function (target, ...rest) {
    const result = await writeText.call(this, target, ...rest)
    if (!stopped && agent && target?.targetKey === targetPath) {
      stopped = true
      tap({ kind: 'auto-resume-stop', session: agent.id, status: agent.status })
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      tap({ kind: 'auto-resume-stopped', session: agent.id })
    }
    return result
  }
  ctx.on('dispose', () => {
    ctx.fs.writeText = writeText
  })
}
