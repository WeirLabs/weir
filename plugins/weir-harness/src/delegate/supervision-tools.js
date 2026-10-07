// resume_agent / terminate_agent: the main agent's supervision tools
// (delegation depth 0 only). Same factory pattern as status-tool.js —
// createStatusTool(deps) — returning pure-object ToolDefinitions whose
// parameters stay object-rooted JSON Schemas (S12).

/**
 * When a rebuilt registry cannot find a named child but the DSH catalog shows
 * continuable children, the error must say so — never claim no children exist.
 * @param {Error} error
 * @param {object} coordinator
 * @returns {Error}
 */
export function withUntrackedHint(error, coordinator) {
  const untracked = coordinator?.snapshot().meta?.untracked
  if (Array.isArray(untracked) && untracked.length > 0 && /no supervised child/.test(String(error?.message ?? ''))) {
    return new Error(`${error.message} Note: ${untracked.length} untracked continuable child(ren) exist in the DSH catalog — supervision state may have been rebuilt with partial confidence.`)
  }
  return error
}

/**
 * Build the resume_agent tool definition.
 * @param {object} deps
 * @param {(parent: object) => Promise<object>} deps.coordinatorFor - coordinator registry for one parent agent
 */
export function createResumeTool({ coordinatorFor }) {
  return {
    name: 'resume_agent',
    description: `Resume a blocked supervised child of this session. Your resume context is delivered to the child, which resumes its agent loop; its status flips back to running. Use when the blocker is cleared and the task's direction is unchanged. When the direction changed substantially, terminate the blocked child with terminate_agent and delegate a fresh child instead.`,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name or id of the blocked supervised child.' },
        context: { type: 'string', description: 'Unblocking context delivered to the child (what changed, what to do next).' },
      },
      required: ['agent', 'context'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Resumed supervised child ${value.name} (${value.id}); status: ${value.status}. Its next terminal report will arrive as usual.` }],
    },
    async execute(args, exec) {
      const depth = exec.agent?.session?.header?.delegationDepth ?? 0
      if (depth >= 1) throw new Error('resume_agent: only the main agent may resume supervised children')
      if (typeof args.agent !== 'string' || args.agent.length === 0) throw new Error('resume_agent: agent must be a non-empty string')
      if (typeof args.context !== 'string' || args.context.trim().length === 0) throw new Error('resume_agent: context must be a non-empty string')
      const coordinator = await coordinatorFor(exec.agent)
      try {
        return await coordinator.resume(args.agent, args.context)
      } catch (error) {
        throw withUntrackedHint(error, coordinator)
      }
    },
  }
}

/**
 * Build the terminate_agent tool definition.
 * @param {object} deps
 * @param {(parent: object) => Promise<object>} deps.coordinatorFor - coordinator registry for one parent agent
 */
export function createTerminateTool({ coordinatorFor }) {
  return {
    name: 'terminate_agent',
    description: `Terminate a supervised child of this session. A running child is interrupted for real; a non-running child (blocked or settled) is only marked terminated as state bookkeeping. Terminated members count toward their group's completion. Only the main agent may terminate: children have no say over a task's existence.`,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name or id of the supervised child to terminate.' },
        reason: { type: 'string', description: 'Optional termination reason, recorded as the child\'s report.' },
      },
      required: ['agent'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Supervised child ${value.name} (${value.id}) is terminated${value.interrupted ? ' (interrupted while running)' : ' (state bookkeeping)'}.` }],
    },
    async execute(args, exec) {
      const depth = exec.agent?.session?.header?.delegationDepth ?? 0
      if (depth >= 1) throw new Error('terminate_agent: only the main agent may terminate supervised children')
      if (typeof args.agent !== 'string' || args.agent.length === 0) throw new Error('terminate_agent: agent must be a non-empty string')
      const coordinator = await coordinatorFor(exec.agent)
      try {
        return coordinator.terminate(args.agent, args.reason)
      } catch (error) {
        throw withUntrackedHint(error, coordinator)
      }
    },
  }
}
