// QA-only lost-ack fault: installed before the Edit Lock publisher captures
// fs.writeText.bind(fs). Only the second target of this scenario is affected.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'weir-it-edit-lock-unknown-probe'
export const inject = ['fs']
export function apply(ctx) {
  if (process.env.WEIR_IT_LSP_UNCERTAIN !== '1' || process.env.WEIR_IT_SCENARIO !== 'editlock-lsp-uncertain') return
  const root = process.env.WEIR_IT_ROOT
  if (!root) throw new Error('QA lost-ack probe requires WEIR_IT_ROOT')
  const targetPath = join(root, 'ws', 'editlock-lsp-uncertain', 'probe-other.ts')
  const trace = process.env.WEIR_IT_TRACE
  const original = ctx.fs.writeText
  if (typeof original !== 'function') throw new Error('QA lost-ack probe requires fs.writeText')
  let dispatched = false
  ctx.fs.writeText = async function (target, content, expected, signal, policy) {
    if (!dispatched && target?.targetKey === targetPath &&
        expected?.kind === 'replaceIfVersion' &&
        content === 'import { uncertainProbe } from "./probe"\r\nexport const useIt = uncertainProbe + 1\r\n' &&
        policy?.mode !== 'read-only') {
      dispatched = true
      // Do not fabricate a write result: wait until the real backend finishes.
      await original.call(this, target, content, expected, signal, policy)
      appendFileSync(trace, JSON.stringify({ kind: 'editlock-lsp-uncertain-fault', target: targetPath,
        backendCompleted: true, expected: expected.kind }) + '\n')
      throw new Error('QA_LOST_SECOND_WRITE_ACK_AFTER_BACKEND_COMPLETION')
    }
    return original.call(this, target, content, expected, signal, policy)
  }
  ctx.on('dispose', () => { ctx.fs.writeText = original })
}
