// `/worktree` — the user's deterministic lane controls. Same service, same
// state machine, same error codes as the tools; a user-issued land is the
// approval itself. GUI buttons run these exact command lines, so every
// mutation the user makes is on the session record.
import { WorktreeError } from './errors.js'
import { renderBoard, renderNext } from './prompts.js'

export const WORKTREE_COMMAND = 'worktree'
export const COMMAND_USAGE = '[--json] | on | off | init [show|write <json>] | setup <lane> [--skip] | check <lane> | land <lane> | clean <lane> worktree|all|keep | abandon <lane> [keep|worktree|all] | reconcile [--rebuild]'

/**
 * @param {any} service
 * @param {{ modeAvailable: (session: any) => Promise<string | null> }} deps - resolves to a refusal reason when Worktree mode cannot be turned on
 */
export function createWorktreeCommand(service, deps) {
  /** @param {unknown} error */
  const failure = (error) => ({
    kind: 'error',
    text: error instanceof WorktreeError
      ? `${error.message}${error.next ? `\nnext: ${renderNext(error.next)}` : ''}`
      : `worktree: ${/** @type {any} */ (error)?.message ?? error}`,
  })
  const ok = (/** @type {string} */ text) => ({ kind: 'success', text })
  const describe = (/** @type {any} */ value) => `lane ${value.lane}: ${value.state} — ${value.summary}\nnext: ${renderNext(value.next ?? null)}`

  return {
    name: WORKTREE_COMMAND,
    description: 'Worktree lanes: board, Worktree mode on/off, repository config, and lane actions (setup, check, land, clean, abandon, reconcile).',
    input: { hint: COMMAND_USAGE },
    /** @param {any} invocation */
    async handler(invocation) {
      const agent = invocation?.agent
      if (!agent) return { kind: 'error', text: 'worktree: requires an owning agent session' }
      const session = agent.session
      const words = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      const [verb = '', lane, extra] = words
      try {
        switch (verb) {
          case '':
          case '--json': {
            const view = await service.view(session)
            if (verb === '--json') return ok(JSON.stringify(view))
            if (!view.available) return ok(`Worktree lanes unavailable: ${view.error?.message ?? 'unknown reason'}`)
            return ok(renderBoard({ lanes: view.lanes, mode: view.mode }) || 'No worktree lanes in this repository.')
          }
          case 'on': {
            const refusal = await deps.modeAvailable(session)
            if (refusal) return { kind: 'error', text: `Worktree mode unavailable: ${refusal}` }
            return ok('Worktree mode ON for this session: the main agent no longer edits files; changes go through lanes.')
          }
          case 'off':
            return ok('Worktree mode OFF for this session. Existing lanes keep their state.')
          case 'init': {
            if (lane === 'write') {
              const json = String(invocation.rawInput ?? '').trim().replace(/^init\s+write\s+/, '')
              const written = await service.writeConfig(session, JSON.parse(json))
              return ok(`wrote ${written.file}: ${written.config.check.length} verification command(s)${written.config.setup ? `, setup "${written.config.setup}"` : ''}`)
            }
            const info = await service.initSuggestions(session)
            return ok(JSON.stringify(info))
          }
          case 'setup':
            return ok(describe(await service.setup(session, required(lane), { skip: extra === '--skip' })))
          case 'check':
            return ok(describe(await service.check(session, required(lane))))
          case 'land': {
            const value = await service.land(agent, required(lane), { userApproved: true })
            if (value.state === 'landed') void service.askCleanup(agent, value.lane).catch(() => {})
            return ok(describe(value))
          }
          case 'clean': {
            if (!['keep', 'worktree', 'all'].includes(extra ?? '')) return { kind: 'error', text: 'Usage: /worktree clean <lane> keep|worktree|all' }
            return ok(describe(await service.cleanup(session, required(lane), /** @type {any} */ (extra), { by: 'user' })))
          }
          case 'abandon': {
            const mode = extra && ['keep', 'worktree', 'all'].includes(extra) ? /** @type {any} */ (extra) : undefined
            return ok(describe(await service.abandon(agent, required(lane), { mode })))
          }
          case 'reconcile': {
            const outcome = await service.reconcile(session, { rebuild: lane === '--rebuild' })
            return ok(outcome.rebuilt ? `ledger rebuilt from git: ${outcome.rebuilt.join(', ') || '(no lanes)'}` : `reconciled; unmanaged worktrees: ${outcome.unmanaged.join(', ') || 'none'}`)
          }
          default:
            return { kind: 'error', text: `Usage: /worktree ${COMMAND_USAGE}` }
        }
      } catch (error) {
        return failure(error)
      }
    },
  }
}

/** @param {string | undefined} lane */
function required(lane) {
  if (!lane) throw new Error('a lane id is required')
  return lane
}
