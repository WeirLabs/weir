// The delegate tool: category-routed and curated-agent delegation over the
// subagents spawn provider. Pure-object ToolDefinition (no defineTool import —
// @deepseek-ai packages do not resolve from a linked bundle).
import { parseEscalation } from './escalate.js'
import { oneShotLane, spawnGuardedChild, supervisedLane } from './spawn-adapter.js'
import { contentText } from '../shared/content-text.js'

export const DELEGATE_TOOL_NAME = 'delegate'
export const BATCH_LIMIT = 16

export const DELEGATE_DESCRIPTION = `Delegate work to a specialist child agent. Spawn one child or fan out a batch.

Each call item MUST provide exactly one of category or agent (never both, never neither):
- category: routed through the category registry; the child's model comes from the category's resolved chain. The category lane has no default — a category name must always be supplied. Available categories and their routing guidance are listed in the injected prompt section "orchestrator:delegate-targets".
- agent: a curated read-only specialist by name: finder (codebase search), scholar (docs/OSS research), advisor (architecture advice).

NEVER pass model together with category: category-routed children take their model from the registry. model is honored for agent spawns only.

Options: run_in_background (return a job id immediately; the completion arrives as a compact notice and you pull the report with job_output), load_skills (skill bodies prepended to the child's prompt), name (stable handle), task_summary (one-line label), group (supervised group: all items of THIS call form one group whose members run as supervised continuable children; groups never accept later insertion; when every member settles you receive ONE group-settled signal — each member's terminal report arrives individually in that member's settlement notice).

Supervised children report a binary terminal status (completed or blocked). A member's terminal report reaches you in its settlement notice; resume a blocked member with resume_agent (attach unblocking context) or terminate it with terminate_agent. Terminate a blocked child and delegate a fresh one when the task's direction changed substantially.

Batch form: tasks (1-16 items) shares top-level options; an item-level run_in_background must agree with the top level.

Every child prompt MUST be self-contained and start with TASK: <imperative>, then name DELIVERABLE, SCOPE, VERIFY, and STOP WHEN. Prompts are executable assignments, not context handoffs: include only what the child needs.

Children cannot delegate further. Curated agents are read-only and never write files; their bash access is guarded by a fail-closed read-only whitelist.`

/**
 * @typedef {object} DelegateDeps
 * @property {(target: { category?: string, agent?: string, model?: string }, parentRoute?: { provider?: string, model?: string }) => Promise<{
 *   persona: string, agentOptions?: object, toolFilter?: { allow?: string[], deny?: string[] },
 *   label: string, categoryName?: string, readOnly?: boolean }>} resolveTarget
 * @property {(skillName: string) => Promise<string>} loadSkill
 * @property {object} subagents - ctx.subagents
 * @property {object | undefined} jobs - ctx.jobs when mounted
 * @property {() => { enabled: boolean, lists: { bash: { allow: string[], gitAllow: string[], deny: string[] }, pwsh: { allow: string[], gitAllow: string[], deny: string[] } } }} robash - live resolver for the read-only shell guard config (bash + pwsh list sets); resolved per delegation so a settings commit is visible to the next spawn
 * @property {(parentAgent: object) => object} coordinatorFor - supervised group coordinator for one parent agent
 * @property {object | undefined} agents - ctx.agents (live agent lookup by child id)
 */

/**
 * Build the delegate tool definition.
 * @param {DelegateDeps} deps
 */
export function createDelegateTool(deps) {
  return {
    name: DELEGATE_TOOL_NAME,
    description: DELEGATE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The delegation prompt (single form).' },
        tasks: {
          type: 'array',
          description: 'Batch form: 1-16 delegation items.',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string' },
              category: { type: 'string' },
              agent: { type: 'string' },
              load_skills: { type: 'array', items: { type: 'string' } },
              name: { type: 'string' },
              task_summary: { type: 'string' },
            },
            required: ['prompt'],
          },
        },
        category: { type: 'string', description: 'Category route (single form).' },
        agent: { type: 'string', description: 'Curated agent name (single form).' },
        model: { type: 'string', description: 'Explicit model override (agent spawns only).' },
        run_in_background: { type: 'boolean', description: 'Return a job id immediately instead of waiting.' },
        load_skills: { type: 'array', items: { type: 'string' }, description: 'Skills to prepend to the child prompt.' },
        name: { type: 'string', description: 'Stable handle for the child.' },
        task_summary: { type: 'string', description: 'One-line label (<=80 chars) for the UI.' },
        group: { type: 'string', description: 'Supervised group name: every item of this call joins the group (no later insertion); a one-line group-settled signal arrives when all members settle.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderDelegateResult(value) }],
    },
    async execute(args, exec) {
      const items = normalizeItems(args)
      const background = Boolean(args.run_in_background)

      // Depth guard: workers spawned by a preset child composition must not delegate.
      const depth = exec.agent?.session?.header?.delegationDepth ?? 0
      if (depth >= 1) {
        throw new Error('delegate: delegation depth limit reached — category workers and curated agents cannot delegate')
      }

      // Supervised group lane: all items of this call form one supervised group.
      if (typeof args.group === 'string' && args.group.length > 0) {
        if (background) throw new Error('delegate: group and run_in_background cannot be combined (supervised groups are continuable children)')
        return spawnSupervisedGroup(args.group, items, args, deps, exec)
      }

      const outcomes = []
      if (background) {
        for (const item of items) {
          outcomes.push(await spawnBackground(item, args, deps, exec))
        }
        return { background: true, jobs: outcomes }
      }
      for (const item of items) {
        outcomes.push(await spawnForeground(item, args, deps, exec))
      }
      return { background: false, results: outcomes }
    },
  }
}

/** Normalize single/batch call forms into a validated item list. */
export function normalizeItems(args) {
  if (args.prompt !== undefined && args.tasks !== undefined) {
    throw new Error('delegate: provide either prompt (single) or tasks (batch), not both')
  }
  const rawItems = args.tasks !== undefined ? args.tasks : [{ ...args }]
  if (!Array.isArray(rawItems)) throw new Error('delegate: tasks must be an array')
  if (rawItems.length === 0) throw new Error('delegate: tasks must not be empty')
  if (rawItems.length > BATCH_LIMIT) throw new Error(`delegate: tasks is capped at ${BATCH_LIMIT} items`)
  return rawItems.map((item, index) => {
    const merged = { ...stripUndefined(args), ...stripUndefined(item) }
    if (typeof merged.prompt !== 'string' || merged.prompt.trim().length === 0) {
      throw new Error(`delegate: item ${index + 1} needs a non-empty prompt`)
    }
    const hasCategory = typeof merged.category === 'string' && merged.category.length > 0
    const hasAgent = typeof merged.agent === 'string' && merged.agent.length > 0
    if (hasCategory === hasAgent) {
      throw new Error(`delegate: item ${index + 1} must provide exactly one of category or agent`)
    }
    if (hasCategory && typeof merged.model === 'string') {
      throw new Error(`delegate: item ${index + 1} must not combine model with category`)
    }
    return merged
  })
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}

/** Build the child's prompt blocks: skills first, then the assignment. */
async function buildPrompt(item, deps) {
  const blocks = []
  for (const skillName of item.load_skills ?? []) {
    const body = await deps.loadSkill(skillName)
    blocks.push({ type: 'text', text: `<skill name="${skillName}">\n${body}\n</skill>` })
  }
  blocks.push({ type: 'text', text: item.prompt })
  return blocks
}

async function spawnForeground(item, args, deps, exec) {
  const target = await deps.resolveTarget(item, parentRouteOf(exec))
  const prompt = await buildPrompt(item, deps)
  const started = await spawnGuardedChild({ target, prompt, parent: exec.agent, signal: exec.signal }, oneShotLane(), deps)
  const result = await withEscalation(started, item, deps, exec)
  return {
    label: target.label,
    id: result.id,
    status: result.status,
    ...(result.escalated ? { escalated: result.escalated } : {}),
    text: result.text,
  }
}

async function spawnBackground(item, args, deps, exec) {
  const target = await deps.resolveTarget(item, parentRouteOf(exec))
  if (!deps.jobs) throw new Error('delegate: background jobs are unavailable in this composition')
  const prompt = await buildPrompt(item, deps)
  const parent = exec.agent
  const parentSignal = exec.signal
  const jobId = deps.jobs.start({
    kind: 'subagent',
    label: target.label,
    owner: parent.id,
    run(handle) {
      const abort = new AbortController()
      if (parentSignal) parentSignal.addEventListener('abort', () => abort.abort(), { once: true })
      const done = (async () => {
        try {
          const started = await spawnGuardedChild({ target, prompt, parent, signal: abort.signal }, oneShotLane(), deps)
          handle.updateProgress(`${target.label}: running`)
          const result = await withEscalation(started, item, deps, { agent: parent, signal: abort.signal })
          return {
            status: 'completed',
            result: result.text,
            detail: result.escalated ? `escalated to ${result.escalated}` : undefined,
          }
        } catch (error) {
          if (abort.signal.aborted) return { status: 'killed', detail: 'cancelled' }
          return { status: 'failed', detail: String(error?.message ?? error) }
        }
      })()
      return {
        cancel() {
          abort.abort()
        },
        done,
      }
    },
  })
  return { job_id: jobId, label: target.label }
}

/** Await one child, honoring the one-level ESCALATE contract. */
async function withEscalation(started, item, deps, exec) {
  const first = await started.result
  const text = contentText(first.output)
  const escalation = parseEscalation(text)
  if (!escalation) {
    return { id: started.id, status: first.stopReason, text }
  }
  const escalatedItem = {
    ...item,
    category: escalation.target,
    agent: undefined,
    prompt: `${item.prompt}\n\n<escalation_findings>\n${escalation.findings}\n</escalation_findings>`,
  }
  const target = await deps.resolveTarget(escalatedItem, parentRouteOf(exec))
  const prompt = await buildPrompt(escalatedItem, deps)
  const respawned = await spawnGuardedChild({ target, prompt, parent: exec.agent, signal: exec.signal, label: `${target.label} (escalated)` }, oneShotLane(), deps)
  const second = await respawned.result
  return {
    id: respawned.id,
    status: second.stopReason,
    text: contentText(second.output),
    escalated: escalation.target,
  }
}

/** Supervised group lane: resolve every member first, then spawn as continuable supervised children. */
async function spawnSupervisedGroup(groupName, items, args, deps, exec) {
  const coordinator = await deps.coordinatorFor(exec.agent)
  coordinator.assertGroupAvailable(groupName)

  // Phase 1: resolve every member (pure — no side effects) so a bad item
  // fails before any child is spawned and no live unsealed group remains.
  const plans = []
  for (const item of items) {
    const target = await deps.resolveTarget(item, parentRouteOf(exec))
    const prompt = await buildPrompt(item, deps)
    plans.push({ target, prompt, parent: exec.agent, signal: exec.signal })
  }

  const members = []
  const lane = supervisedLane({ coordinator, groupName, members })
  try {
    for (const plan of plans) {
      // Each plan is a spawn assignment: the adapter assembles the request,
      // spawns, registers the member (before the guard attach), and attaches
      // the read-only guard — fail-closed, so a throw lands in the rollback.
      await spawnGuardedChild(plan, lane, deps)
    }
  } catch (error) {
    // Roll back partially spawned members and free the group name.
    for (const { id } of members) {
      try {
        // terminate() already interrupts running children — no second interrupt.
        coordinator.terminate(id, `Supervised spawn aborted: ${String(error?.message ?? error)}`)
      } catch {
        // best-effort rollback
      }
    }
    try {
      coordinator.releaseGroup(groupName)
    } catch {
      // best-effort: a failed release leaves an unsealed group whose members
      // are all terminated — releaseGroup semantics keep the name reusable
    }
    throw error
  }
  coordinator.sealGroup(groupName)
  return {
    supervised: true,
    group: groupName,
    members: members.map(({ id, name }) => ({ id, name })),
  }
}

// supervisedToolFilter moved to spawn-adapter.js (it is the supervised lane's
// toolFilter transform); re-exported in place so existing imports keep working —
// the named import in test/delegate.test.js is the migration canary.
export { supervisedToolFilter } from './spawn-adapter.js'

/** The calling agent's current route, when the session has one. */
function parentRouteOf(exec) {
  try {
    const context = exec.agent?.session?.requestContext?.()
    return context ? { provider: context.provider, model: context.model } : undefined
  } catch {
    return undefined
  }
}

/** Model-facing rendering of the delegate result value. */
function renderDelegateResult(value) {
  if (!value || typeof value !== 'object') return String(value)
  if (value.supervised) {
    const lines = value.members.map((member) => `- ${member.name} (${member.id})`)
    return `Supervised group "${value.group}" started with ${value.members.length} member(s); they now run as supervised continuable children:\n${lines.join('\n')}\n\nEach member will report a terminal status (completed/blocked); each member's report reaches you in that member's settlement notice. A one-line group-settled signal arrives when every member settles.`
  }
  if (value.background) {
    const lines = value.jobs.map((job) => `- ${job.job_id}: ${job.label}`)
    return `Delegated in the background. Completion arrives as a compact notice; pull the report with job_output(job_id).\n${lines.join('\n')}`
  }
  return value.results
    .map((result) => {
      const escalation = result.escalated ? ` (escalated to ${result.escalated})` : ''
      return `## ${result.label}${escalation} — ${result.status}\n\n${result.text}`
    })
    .join('\n\n---\n\n')
}
