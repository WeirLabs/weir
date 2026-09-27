// Orrery delegate plugin: category registry + curated agents + the delegate
// tool. Plain ESM, ctx-only.
import { CURATED_AGENTS, READONLY_BASH_NOTE } from './agents.js'
import { DEFAULT_CATEGORIES } from './categories.js'
import { modelFamily, pickVariant } from './families.js'
import { createGroupCoordinator } from './group-coordinator.js'
import { filterUnsupportedEffort, resolveCategory, snapshotProviders } from './resolver.js'
import { attachReadOnlyBashGuard, DEFAULT_ROBASH } from './robash-guard.js'
import { createAudit } from '../shared/audit.js'
import { userTextMessage } from '../shared/user-message.js'
import { createDelegateTool } from './tool.js'

const name = 'orrery-delegate'
const inject = ['tools', 'subagents', 'llm', 'skills']

function apply(ctx, config = {}) {
  const audit = createAudit(ctx)
  const categories = { ...DEFAULT_CATEGORIES, ...(config.categories ?? {}) }
  const agents = { ...CURATED_AGENTS, ...(config.agents ?? {}) }

  // Read-only bash guard: curated agents and readOnly categories get bash
  // behind a fail-closed whitelist guard when enabled.
  const robashConfig = { ...DEFAULT_ROBASH, ...(config.readOnlyBash ?? {}) }
  const robash = {
    enabled: robashConfig.enabled !== false,
    lists: { allow: robashConfig.allow, gitAllow: robashConfig.gitAllow, deny: robashConfig.deny },
  }
  const readOnlyTools = (base) => (robash.enabled ? [...new Set([...base, 'bash'])] : base)

  // Supervised group coordinators, one per parent session.
  /** @type {Map<string, { coordinator: object, parent: object }>} */
  const coordinators = new Map()
  function coordinatorFor(parent) {
    let entry = coordinators.get(parent.id)
    if (!entry) {
      const coordinator = createGroupCoordinator(
        {
          sendTo: async (childId, text) => {
            await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal: new AbortController().signal })
          },
          interruptChild: (childId) => {
            ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
          },
          schedule: (delayMs, fn) => {
            const timer = setTimeout(fn, delayMs)
            timer.unref?.()
          },
          onAudit: (note) => {
            audit(parent.session, 'supervision', { note })
          },
        },
        config.supervision,
      )
      entry = { coordinator, parent }
      coordinators.set(parent.id, entry)
    }
    return entry.coordinator
  }

  /** Find the entry owning a given child session id (event filter). */
  function entryOfChild(sessionId) {
    for (const entry of coordinators.values()) {
      if (entry.coordinator._children.has(sessionId)) return entry
    }
    return undefined
  }

  // Parent busy ledger: turn/start … turn/end of the parent's own session.
  const parentBusy = new Map()

  /**
   * Deliver queued notices: steer at turn-stopping while the parent is busy,
   * followup (deferred — session/event listeners must not follow up
   * synchronously) when the parent is idle.
   */
  function maybeDeliver(entry) {
    if (parentBusy.get(entry.parent.id)) return // busy: turn-stopping flush covers it
    const notices = entry.coordinator.drainOutbox()
    if (notices.length === 0) return
    const message = userTextMessage(notices.join('\n\n'), 'orrery-delegate')
    setTimeout(() => {
      try {
        entry.parent.followup(message)
      } catch {
        // wake is best-effort; nothing else depends on it
      }
    }, 0)
  }

  // Supervision feed: child assistant text + turn ends drive the state machine;
  // parent turn boundaries maintain the busy ledger.
  ctx.on('session/event', (session, event) => {
    const parentEntry = coordinators.get(session.id)
    if (parentEntry) {
      if (event?.type === 'turn/start') parentBusy.set(session.id, true)
      if (event?.type === 'turn/end') parentBusy.set(session.id, false)
      return
    }
    const entry = entryOfChild(session.id)
    if (!entry) return
    if (event?.type === 'assistant/message') {
      const text = Array.isArray(event.data?.message?.content)
        ? event.data.message.content
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
        : ''
      entry.coordinator.noteAssistantText(session.id, text)
      return
    }
    if (event?.type === 'turn/end') {
      void driveTurnEnd(entry, session.id, event.data?.reason)
    }
  })

  async function driveTurnEnd(entry, childId, reason) {
    await entry.coordinator.onTurnEnd(childId, reason)
    maybeDeliver(entry)
  }

  // Turn-boundary flush: deliver queued blocked notices and merged group
  // reports as one steered message (never mid-turn interjection).
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const entry = coordinators.get(agent.id)
    if (!entry) return
    const notices = entry.coordinator.drainOutbox()
    if (notices.length === 0) return
    agent.steer(userTextMessage(notices.join('\n\n'), 'orrery-delegate'))
  })

  ctx.tools.register(
    createDelegateTool({
      resolveTarget,
      loadSkill,
      subagents: ctx.subagents,
      jobs: ctx.get('jobs'),
      robash,
      coordinatorFor,
    }),
  )

  // Main-agent supervision tools (delegation depth 0 only).
  ctx.tools.register({
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
      const entry = coordinators.get(exec.agent.id)
      if (!entry) throw new Error('resume_agent: this session has no supervised children')
      return entry.coordinator.resume(args.agent, args.context)
    },
  })

  ctx.tools.register({
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
      const entry = coordinators.get(exec.agent.id)
      if (!entry) throw new Error('terminate_agent: this session has no supervised children')
      return entry.coordinator.terminate(args.agent, args.reason)
    },
  })


  // Provider snapshot cache, invalidated on adapter topology changes.
  /** @type {Map<string, string[] | null> | null} */
  let snapshot = null
  const refresh = async () => {
    snapshot = await snapshotProviders(ctx.llm)
    return snapshot
  }
  const snapshotNow = async () => snapshot ?? (await refresh())
  ctx.on('llm/adapters-updated', () => {
    snapshot = null
  })

  /**
   * Resolve one delegation item to persona + agentOptions + toolFilter.
   * Throws explicit errors for unknown/disabled/unavailable targets.
   * parentRoute (when known) gates effort hints on inherited routes.
   */
  async function resolveTarget(item, parentRoute) {
    if (item.agent) {
      const agent = agents[item.agent]
      if (!agent) {
        throw new Error(`delegate: unknown_target "${item.agent}" (available agents: ${Object.keys(agents).join(', ') || 'none'})`)
      }
      if (agent.disabled) throw new Error(`delegate: agent "${item.agent}" is disabled`)
      const label = item.name ?? item.task_summary ?? `${item.agent}: ${firstLine(item.prompt)}`
      return {
        persona: agent.prompt + (robash.enabled ? READONLY_BASH_NOTE : ''),
        toolFilter: { allow: readOnlyTools(agent.tools) },
        label,
        readOnly: true,
      }
    }

    const category = categories[item.category]
    if (!category) {
      throw new Error(`delegate: unknown_target category "${item.category}" (available: ${Object.keys(categories).join(', ') || 'none'})`)
    }
    const providers = await snapshotNow()
    const hasUserConfig = Boolean(config.categories?.[item.category])
    let route = resolveCategory(category, providers, hasUserConfig)
    if (route.kind === 'unavailable') {
      throw new Error(`delegate: category "${item.category}" unavailable — ${route.reason}`)
    }
    if (route.kind === 'resolved') {
      route = await filterUnsupportedEffort(ctx.llm, route)
    }

    const family = modelFamily(route.kind === 'resolved' ? route.model : undefined)
    const persona = pickVariant(category.promptAppend, family)
    const label = item.name ?? item.task_summary ?? `${item.category}: ${firstLine(item.prompt)}`

    const agentOptions = {}
    if (route.kind === 'resolved') {
      agentOptions.provider = route.provider
      agentOptions.model = route.model
      if (route.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort
    } else if (category.reasoningEffort && parentRoute?.provider && parentRoute?.model) {
      // Inherited route: keep the effort hint only when the parent's route
      // advertises it; drop silently otherwise.
      try {
        const info = await ctx.llm.resolveModelInfo(parentRoute.provider, parentRoute.model)
        const efforts = info?.reasoning?.efforts
        if (Array.isArray(efforts) && efforts.some((effort) => effort.id === category.reasoningEffort)) {
          agentOptions.reasoningEffort = category.reasoningEffort
        }
      } catch {
        // unknown route metadata: omit the hint rather than risk a rejection
      }
    }

    return {
      persona,
      ...(category.readOnly ? { toolFilter: { allow: readOnlyTools(['read', 'glob', 'grep']) } } : {}),
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      label,
      categoryName: item.category,
      ...(category.readOnly ? { readOnly: true } : {}),
    }
  }

  async function loadSkill(skillName) {
    const skill = await ctx.skills.get(skillName)
    if (!skill) throw new Error(`delegate: unknown_skill "${skillName}" in load_skills`)
    return skill.content
  }
}

function firstLine(text) {
  return text.split('\n', 1)[0].slice(0, 80)
}

export { name, inject, apply }
