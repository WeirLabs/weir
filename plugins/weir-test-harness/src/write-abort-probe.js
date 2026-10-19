// Dev-only write-boundary abort probe. The first time a managed write to one
// named target genuinely lands, the agent's turn is cancelled as a user stop —
// after the underlying fs write returned, so the file really is on disk.
//
// It exists for the mid-batch lsp_rename case: a two-file rename whose second
// file is never dispatched because the turn ended after the first one landed.
// That is how the scenario pins "published file stays published, nothing is
// rolled back" without inventing a publication fence (edit-lock-rebuild D12
// deliberately dropped fences).
//
// Armed per boot via WEIR_IT_WRITE_ABORT_PROBE=1 plus WEIR_IT_WRITE_ABORT_TARGET
// (a path below <IT_ROOT>/ws); every other boot is untouched.
import { join } from 'node:path'

export function installWriteAbortProbe(ctx, tap) {
  if (process.env.WEIR_IT_WRITE_ABORT_PROBE !== '1') return
  const root = process.env.WEIR_IT_ROOT
  if (!root) throw new Error('write-abort probe requires WEIR_IT_ROOT')
  const targetPath = join(root, 'ws', process.env.WEIR_IT_WRITE_ABORT_TARGET ?? '')
  let agent
  let stopped = false
  ctx.on('agent/created', ({ agent: created }) => {
    if (created?.session?.header?.origin !== 'subagent') agent ??= created
  })
  const writeText = ctx.fs?.writeText
  if (typeof writeText !== 'function') throw new Error('write-abort probe requires the host filesystem writeText')
  ctx.fs.writeText = async function (target, ...rest) {
    const result = await writeText.call(this, target, ...rest)
    if (!stopped && agent && target?.targetKey === targetPath) {
      stopped = true
      tap({ kind: 'write-abort-stop', session: agent.id, status: agent.status })
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      tap({ kind: 'write-abort-stopped', session: agent.id })
    }
    return result
  }
  ctx.on('dispose', () => {
    ctx.fs.writeText = writeText
  })
}
