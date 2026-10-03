// Worktree mode guard for MAIN agents: while the session's projected mode is
// on, file writes are refused and the shell is read-only (the same whitelist
// the read-only children use). Evaluated per call — toggling the mode never
// re-registers anything. Children are not affected: they are either lane
// workers (with their own lane guard) or read-only already.
import { checkBashCommand } from './robash-guard.js'
import { checkPwshCommand } from './robash-guard-pwsh.js'
import { decideModeCall } from '../worktree/guard.js'

/**
 * @param {any} ctx - delegate plugin ctx (agent/created events)
 * @param {{ lanes: () => any, robash: () => { enabled: boolean, lists: { bash: any, pwsh: any } } }} deps
 * @returns {() => void} dispose
 */
export function attachWorktreeModeGuard(ctx, deps) {
  /** @type {Map<string, () => void>} */
  const attached = new Map()
  const offCreated = ctx.on?.('agent/created', (/** @type {any} */ { agent }) => {
    if (!agent?.ctx?.tools?.guard || attached.has(agent.id)) return
    if ((agent.session?.header?.delegationDepth ?? 0) !== 0) return
    const dispose = agent.ctx.tools.guard((/** @type {any} */ execution) => {
      // Guards apply along the scope chain: judge only this agent's own calls.
      if (execution.agent && execution.agent !== agent) return undefined
      const lanes = deps.lanes()
      if (!lanes?.modeOf?.(agent.session)) return undefined
      const lists = deps.robash().lists
      return decideModeCall(execution, (command, shell) => (shell === 'pwsh' ? checkPwshCommand(command, lists.pwsh) : checkBashCommand(command, lists.bash)))
    })
    attached.set(agent.id, dispose)
  })
  const offDisposed = ctx.on?.('agent/disposed', (/** @type {any} */ { agent }) => {
    attached.get(agent?.id)?.()
    attached.delete(agent?.id)
  })
  return () => {
    offCreated?.()
    offDisposed?.()
    for (const dispose of attached.values()) dispose?.()
    attached.clear()
  }
}
