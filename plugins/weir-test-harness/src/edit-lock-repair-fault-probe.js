// Dev-only lost-ack fault for the editlock-revoked-repair scenario: one named
// target per boot publishes through the REAL backend and then loses the ack,
// so the edit-lock commit durably records the operation as phase 'unknown' —
// the unresolved history an administrative recovery (online adminRecoverOnline)
// must bind before the owner can be revoked. Armed per boot via
// WEIR_IT_REVOKED_REPAIR_KILL=<target filename under <root>/ws>; unset boots
// are untouched. Same lost-ack shape as edit-lock-unknown-probe.js, but armed
// from the shared event tap (mounted before edit-lock captures fs.writeText).
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function installRepairFaultProbe(ctx, tap) {
  const targetName = process.env.WEIR_IT_REVOKED_REPAIR_KILL
  if (!targetName) return
  const root = process.env.WEIR_IT_ROOT
  if (!root) throw new Error('repair fault probe requires WEIR_IT_ROOT')
  const targetPath = join(root, 'ws', targetName)
  const trace = process.env.WEIR_IT_TRACE
  const original = ctx.fs?.writeText
  if (typeof original !== 'function') throw new Error('repair fault probe requires fs.writeText')
  let dispatched = false
  ctx.fs.writeText = async function (target, content, expected, signal, policy) {
    if (!dispatched && target?.targetKey === targetPath && policy?.mode !== 'read-only') {
      dispatched = true
      // Never fabricate a write result: the real backend completes first, then
      // the ack is lost — the commit can only record an unknown outcome.
      await original.call(this, target, content, expected, signal, policy)
      appendFileSync(trace, JSON.stringify({ kind: 'revoked-repair-fault', target: targetPath, backendCompleted: true }) + '\n')
      throw new Error('QA_LOST_WRITE_ACK_AFTER_BACKEND_COMPLETION')
    }
    return original.call(this, target, content, expected, signal, policy)
  }
  ctx.on('dispose', () => { ctx.fs.writeText = original })
}
