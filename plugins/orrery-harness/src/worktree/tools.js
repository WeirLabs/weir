// The five model-facing lane tools. Pure-object ToolDefinitions with
// object-rooted schemas (S12); every result carries `next`, every refusal
// carries its stable code and the recovery step. Successful root calls
// persist `meta.worktree` for the conversation views and the session
// projection (tool/result meta is the only durable channel a plugin has).
import { WorktreeError } from './errors.js'
import { renderNext } from './prompts.js'

/** @param {any} service */
export function createWorktreeTools(service) {
  /** Map a lane error to a model-facing error that names the next step. @param {unknown} error */
  const rethrow = (error) => {
    if (error instanceof WorktreeError) {
      throw new Error(`${error.message}${error.next ? `\nnext: ${renderNext(error.next)}` : ''}${error.data ? `\n${JSON.stringify(error.data)}` : ''}`)
    }
    throw error
  }
  /** @param {any} exec */
  const mainOnly = (exec, tool) => {
    if ((exec.agent?.session?.header?.delegationDepth ?? 0) >= 1) {
      throw new Error(`MAIN_AGENT_ONLY: ${tool} needs the user's decision; only the main agent may call it. Report the lane state in your final result instead`)
    }
  }
  const render = (/** @type {any} */ _args, /** @type {any} */ value) => [{ type: 'text', text: renderResult(value) }]
  /** @param {string} tool */
  const meta = (tool) => (/** @type {any} */ _args, /** @type {any} */ value) => ({
    worktree: {
      tool,
      lane: value.lane,
      state: value.state,
      summary: value.summary,
      next: value.next ?? null,
      ...(value.from ? { from: value.from } : {}),
      ...(value.merge ? { merge: value.merge } : {}),
      ...(value.conflicts ? { conflicts: value.conflicts } : {}),
      ...(value.check ? { check: value.check } : {}),
      ...(typeof value.diff === 'string' && value.diff ? { diff: value.diff } : {}),
      ...(value.cleanup ? { cleanup: value.cleanup } : {}),
      ...(value.watch ? { watch: value.watch } : {}),
      ...(value.hit ? { hit: value.hit } : {}),
    },
  })
  const laneParam = { lane: { type: 'string', description: 'Lane id (e.g. fix-login-001).' } }

  return [
    {
      name: 'worktree_open',
      description: 'Open a worktree lane: an isolated git worktree on its own branch inside the repository (the host derives the id, branch, path, and base; dependency setup runs automatically). Returns the lane id and the next step — usually delegate(worktree=<lane>).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title of the lane work (becomes the lane id slug).' },
          scope: { type: 'array', items: { type: 'string' }, description: 'Optional path globs (repository-relative) the lane may write. Parallel lanes with overlapping scopes are refused.' },
        },
        required: ['title'],
      },
      output: { schema: { type: 'object' }, render, presentationMeta: meta('worktree_open') },
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        mainOnly(exec, 'worktree_open')
        return service.open(exec.agent.session, args).catch(rethrow)
      },
    },
    {
      name: 'worktree_check',
      description: 'Re-run the lane check by hand (mandatory preconditions, plus the repository\'s verification commands when configured). Normally unnecessary: the host checks a lane automatically when its bound worker settles.',
      parameters: {
        type: 'object',
        properties: { ...laneParam, verification_only: { type: 'boolean', description: 'Only meaningful when verification is configured; fails with VERIFICATION_DISABLED otherwise.' } },
        required: ['lane'],
      },
      output: { schema: { type: 'object' }, render, presentationMeta: meta('worktree_check') },
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        mainOnly(exec, 'worktree_check')
        const before = (await service.view(exec.agent.session)).lanes?.find((/** @type {any} */ lane) => lane.id === args.lane)?.state
        const value = await service.check(exec.agent.session, args.lane, { verificationOnly: args.verification_only === true }).catch(rethrow)
        return { ...value, from: before }
      },
    },
    {
      name: 'worktree_land',
      description: 'Ask the user to approve merging a landable lane into its base branch (--no-ff). The host prechecks conflicts and the main worktree first; only the user\'s explicit approval merges. After a merge the user chooses the cleanup.',
      parameters: { type: 'object', properties: laneParam, required: ['lane'] },
      output: { schema: { type: 'object' }, render, presentationMeta: meta('worktree_land') },
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        mainOnly(exec, 'worktree_land')
        const value = await service.land(exec.agent, args.lane, { signal: exec.signal }).catch(rethrow)
        if (value.state !== 'landed') return value
        const cleanup = await service.askCleanup(exec.agent, args.lane, exec.signal).catch((/** @type {any} */ error) => ({ error: String(error?.message ?? error) }))
        return { ...value, ...(cleanup ? { cleanup: cleanup.error ? { error: cleanup.error } : { state: cleanup.state, summary: cleanup.summary } } : {}), next: cleanup && !cleanup.error ? cleanup.next : value.next }
      },
    },
    {
      name: 'worktree_cleanup',
      description: 'Apply the cleanup the USER chose for a merged lane: keep (leave it), worktree (remove the worktree, keep the branch), or all (remove the worktree and delete the merged branch). Never choose for the user.',
      parameters: {
        type: 'object',
        properties: { ...laneParam, mode: { type: 'string', enum: ['keep', 'worktree', 'all'], description: 'The user\'s choice.' } },
        required: ['lane', 'mode'],
      },
      output: { schema: { type: 'object' }, render, presentationMeta: meta('worktree_cleanup') },
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        mainOnly(exec, 'worktree_cleanup')
        return service.cleanup(exec.agent.session, args.lane, args.mode, { by: 'agent' }).catch(rethrow)
      },
    },
    {
      name: 'worktree_abandon',
      description: 'Ask the user to confirm abandoning a lane and choose what to remove (the card states how many unmerged commits would be lost).',
      parameters: { type: 'object', properties: laneParam, required: ['lane'] },
      output: { schema: { type: 'object' }, render, presentationMeta: meta('worktree_abandon') },
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        mainOnly(exec, 'worktree_abandon')
        return service.abandon(exec.agent, args.lane, { signal: exec.signal }).catch(rethrow)
      },
    },
    {
      name: 'worktree_watch',
      description: 'Subscribe this session to conclusion states of any lane in this repository — including lanes another session opened (the notification goes to YOU, not the lane owner). When the lane reaches one of the states you get exactly one notification and the watch is removed (one-shot); if no state is reached in time, one expiry notice arrives instead. Re-subscribing the same lane replaces the old watch. Transient states (preparing/working/checking/awaiting-approval) are refused with UNWATCHABLE_STATE.',
      parameters: {
        type: 'object',
        properties: {
          ...laneParam,
          states: { type: 'array', items: { type: 'string' }, description: 'Conclusion states to watch (e.g. ["landable", "abandoned"]). The lifetime comes from the worktreeWatchTimeoutMinutes setting (default 6 hours) — there is deliberately no timeout parameter.' },
        },
        required: ['lane', 'states'],
      },
      output: { schema: { type: 'object' }, render, presentationMeta: meta('worktree_watch') },
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        mainOnly(exec, 'worktree_watch')
        return service.watch(exec.agent.session, args).catch(rethrow)
      },
    },
  ]
}

/** Model-facing rendering of a lane tool result. @param {any} value */
export function renderResult(value) {
  if (!value || typeof value !== 'object') return String(value)
  const lines = [`lane ${value.lane}: ${value.state}${value.from && value.from !== value.state ? ` (was ${value.from})` : ''} — ${value.summary}`]
  if (value.conflicts?.length) lines.push(`conflicting paths: ${value.conflicts.join(', ')}`)
  if (value.feedback) lines.push(`user feedback: ${value.feedback}`)
  if (value.merge?.commit) lines.push(`merge commit: ${value.merge.commit}`)
  if (value.cleanup?.summary) lines.push(`cleanup: ${value.cleanup.state} — ${value.cleanup.summary}`)
  if (value.cleanup?.error) lines.push(`cleanup failed: ${value.cleanup.error}`)
  lines.push(`next: ${renderNext(value.next ?? null)}`)
  return lines.join('\n')
}
