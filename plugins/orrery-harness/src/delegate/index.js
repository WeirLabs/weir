// Orrery delegate plugin: category registry + curated agents + the delegate
// tool. Plain ESM, ctx-only.
import { CURATED_AGENTS, READONLY_BASH_NOTE } from './agents.js'
import { DEFAULT_CATEGORIES } from './categories.js'
import { modelFamily, pickVariant } from './families.js'
import { filterUnsupportedEffort, resolveCategory, snapshotProviders } from './resolver.js'
import { attachReadOnlyBashGuard, DEFAULT_ROBASH } from './robash-guard.js'
import { createDelegateTool } from './tool.js'

const name = 'orrery-delegate'
const inject = ['tools', 'subagents', 'llm', 'skills']

function apply(ctx, config = {}) {
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

  ctx.tools.register(
    createDelegateTool({
      resolveTarget,
      loadSkill,
      subagents: ctx.subagents,
      jobs: ctx.get('jobs'),
      robash,
    }),
  )
}

function firstLine(text) {
  return text.split('\n', 1)[0].slice(0, 80)
}

export { name, inject, apply }
