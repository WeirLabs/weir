// Worktree mode guard for MAIN agents: while the session's projected mode is
// on, file writes are refused and the shell is read-only (the same whitelist
// the read-only children use, plus the lane-inspection queries). Evaluated per
// call — toggling the mode never re-registers anything. Children are not
// affected: they are either lane workers (with their own lane guard) or
// read-only already.
//
// Attachment is belt and braces, because the delegate plugin can mount AFTER
// the first main agent of a preset was created (the first Orrery session
// after a restart mounts the preset for that very agent, so its
// `agent/created` event is already past — observed in desktop acceptance):
//   1. one guard on the plugin's own tool scope, which every agent of the
//      preset inherits through its scope chain;
//   2. a per-agent guard for every main agent that already exists at mount;
//   3. a per-agent guard for every main agent created later.
// Duplicate verdicts are harmless (guards only refuse).
import { checkBashCommand } from './robash-guard.js'
import { checkPwshCommand } from './robash-guard-pwsh.js'
import { decideModeCall } from '../worktree/guard.js'

/**
 * @param {any} ctx - delegate plugin ctx (tools, agents, agent events)
 * @param {{ lanes: () => any, robash: () => { enabled: boolean, lists: { bash: any, pwsh: any } } }} deps
 * @returns {() => void} dispose
 */
export function attachWorktreeModeGuard(ctx, deps) {
  /** @param {any} execution @param {any} [owner] - the agent a per-agent guard was attached to */
  const decide = (execution, owner) => {
    const agent = execution?.agent ?? owner
    if (!agent) return undefined
    // Per-agent guards apply along the scope chain: judge only the owner's own calls.
    if (owner && execution?.agent && execution.agent !== owner) return undefined
    if ((agent.session?.header?.delegationDepth ?? 0) !== 0) return undefined
    const lanes = deps.lanes()
    if (!lanes?.modeOf?.(agent.session)) return undefined
    const lists = deps.robash().lists
    return decideModeCall(execution, (command, shell) => (shell === 'pwsh' ? checkPwshCommand(command, lists.pwsh) : checkBashCommand(command, lists.bash)))
  }

  /** @type {Array<() => void>} */
  const disposers = []
  const scopeGuard = ctx.tools?.guard?.((/** @type {any} */ execution) => decide(execution))
  if (typeof scopeGuard === 'function') disposers.push(scopeGuard)

  /** @type {Map<string, () => void>} */
  const attached = new Map()
  /** @param {any} agent */
  const attach = (agent) => {
    if (!agent?.ctx?.tools?.guard || attached.has(agent.id)) return
    if ((agent.session?.header?.delegationDepth ?? 0) !== 0) return
    attached.set(agent.id, agent.ctx.tools.guard((/** @type {any} */ execution) => decide(execution, agent)))
  }
  try {
    for (const agent of ctx.get?.('agents')?.roots?.() ?? []) attach(agent)
  } catch {
    // no agent registry in this composition: the scope guard still applies
  }
  const offCreated = ctx.on?.('agent/created', (/** @type {any} */ { agent }) => attach(agent))
  const offDisposed = ctx.on?.('agent/disposed', (/** @type {any} */ { agent }) => {
    attached.get(agent?.id)?.()
    attached.delete(agent?.id)
  })
  return () => {
    offCreated?.()
    offDisposed?.()
    for (const dispose of attached.values()) dispose?.()
    attached.clear()
    for (const dispose of disposers) dispose()
  }
}
