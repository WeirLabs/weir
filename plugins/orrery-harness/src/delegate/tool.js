// The delegate tool: category-routed and curated-agent delegation over the
// subagents spawn provider. Pure-object ToolDefinition (no defineTool import —
// @deepseek-ai packages do not resolve from a linked bundle).
import { parseEscalation } from './escalate.js'

export const DELEGATE_TOOL_NAME = 'delegate'
export const BATCH_LIMIT = 16

export const DELEGATE_DESCRIPTION = `Delegate work to a specialist child agent. Spawn one child or fan out a batch.

Each call item MUST provide exactly one of:
- category: routed through the category registry; the child's model comes from the category's resolved chain. Available categories and their routing guidance are listed in the orchestration doctrine and this tool's runtime diagnostics.
- agent: a curated read-only specialist by name: explore (codebase search), librarian (docs/OSS research), oracle (architecture advice).

NEVER pass model together with category: category-routed children take their model from the registry. model is honored for agent spawns only.

Options: run_in_background (return a job id immediately; the completion arrives as a compact notice and you pull the report with job_output), load_skills (skill bodies prepended to the child's prompt), name (stable handle), task_summary (one-line label).

Batch form: tasks (1-16 items) shares top-level options; an item-level run_in_background must agree with the top level.

Every child prompt MUST be self-contained and start with TASK: <imperative>, then name DELIVERABLE, SCOPE, VERIFY, and STOP WHEN. Prompts are executable assignments, not context handoffs: include only what the child needs.

Children cannot delegate further. Curated agents are read-only and never write files.`

/**
 * @typedef {object} DelegateDeps
 * @property {(target: { category?: string, agent?: string, model?: string }, parentRoute?: { provider?: string, model?: string }) => Promise<{
 *   persona: string, agentOptions?: object, toolFilter?: { allow?: string[], deny?: string[] },
 *   label: string, categoryName?: string }>} resolveTarget
 * @property {(skillName: string) => Promise<string>} loadSkill
 * @property {object} subagents - ctx.subagents
 * @property {object | undefined} jobs - ctx.jobs when mounted
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
  const started = await deps.subagents.start('spawn', {
    label: target.label,
    prompt,
    parent: exec.agent,
    signal: exec.signal,
    ...(target.agentOptions ? { agentOptions: target.agentOptions } : {}),
    ...(target.toolFilter ? { toolFilter: target.toolFilter } : {}),
    maxDepth: 1,
    persona: target.persona,
  })
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
          const started = await deps.subagents.start('spawn', {
            label: target.label,
            prompt,
            parent,
            signal: abort.signal,
            ...(target.agentOptions ? { agentOptions: target.agentOptions } : {}),
            ...(target.toolFilter ? { toolFilter: target.toolFilter } : {}),
            maxDepth: 1,
            persona: target.persona,
          })
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
  const text = textOf(first.output)
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
  const respawned = await deps.subagents.start('spawn', {
    label: `${target.label} (escalated)`,
    prompt,
    parent: exec.agent,
    signal: exec.signal,
    ...(target.agentOptions ? { agentOptions: target.agentOptions } : {}),
    ...(target.toolFilter ? { toolFilter: target.toolFilter } : {}),
    maxDepth: 1,
    persona: target.persona,
  })
  const second = await respawned.result
  return {
    id: respawned.id,
    status: second.stopReason,
    text: textOf(second.output),
    escalated: escalation.target,
  }
}

/** The calling agent's current route, when the session has one. */
function parentRouteOf(exec) {
  try {
    const context = exec.agent?.session?.requestContext?.()
    return context ? { provider: context.provider, model: context.model } : undefined
  } catch {
    return undefined
  }
}

/** Extract plain text from content blocks. */
function textOf(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Model-facing rendering of the delegate result value. */
function renderDelegateResult(value) {
  if (!value || typeof value !== 'object') return String(value)
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
