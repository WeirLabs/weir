// Scripted /worktree approve driver for the integration harness (worktree
// auto-approve modes). Executes the REAL command path through the commands
// service — the same lifecycle a user-typed switch records (command/run +
// command/done session events, which the orreryWorktree projection folds) —
// then reads the folded projection cell back so the scenario can assert the
// switch landed without guessing at timing. The `view` op reads without
// mutating, pinning the cross-turn durability of the override. Dev-only;
// enabled per-scenario through ORRERY_IT_WORKTREE_AUTO_APPROVE /
// ORRERY_IT_NOTIFY_WORKTREE in cordis.patch.yml.
const name = 'orrery-it-worktree-approve-probe'
const inject = ['tools']

const PROJECTION_KEY = 'orreryWorktree'
const APPROVE_MODES = Object.freeze(['manual', 'auto-keep', 'auto-clean'])

const compact = (report) => JSON.stringify(report).slice(0, 560)

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  /** The folded orreryWorktree state for a session (null when unreadable). */
  const foldOf = (session) => {
    try {
      return ctx.get('sessionProjections')?.stateOf?.(session, PROJECTION_KEY) ?? null
    } catch {
      return null
    }
  }
  ctx.tools.register({
    name: 'worktree_approve_probe',
    description: 'Integration probe: run a /worktree approve command through the real commands service (invalid value rejection included) and read back the folded session auto-approve override.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['invalid', 'approve', 'view'] },
        mode: { type: 'string', enum: [...APPROVE_MODES] },
        _marker: { type: 'string' },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `WORKTREE_APPROVE_PROBE done ${args?._marker ?? value?.op ?? 'op'}:${compact(value)}` }],
    },
    async execute(args, exec) {
      const report = { completed: false, op: args?.op ?? null }
      try {
        const commands = ctx.get('commands')
        if (!commands) throw new Error('commands service unavailable from the probe ctx')
        const session = exec.agent?.session
        if (args.op === 'view') {
          report.foldedApprove = foldOf(session)?.approve ?? null
          report.completed = true
          return report
        }
        const line = args.op === 'invalid' ? '/worktree approve sometimes' : `/worktree approve ${args.mode}`
        const settled = await commands.execute(exec.agent, line, [], exec.signal ?? new AbortController().signal)
        const value = settled?.result !== undefined ? settled.result : settled
        report.commandKind = value?.kind ?? null
        report.commandText = typeof value?.text === 'string' ? value.text : null
        report.foldedApprove = foldOf(session)?.approve ?? null
        report.completed = true
        return report
      } catch (cause) {
        report.error = cause instanceof Error ? cause.message : String(cause)
        return report
      }
    },
  })
}

export { name, inject, apply }
