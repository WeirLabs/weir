// Target resolution for one delegation item: agent or category → persona +
// agentOptions + toolFilter + label. Owns the provider snapshot cache and the
// model-family variant tables. Pure module: the llm service, the adapter-update
// subscription and the settings overlay bundle are all injected, so nothing
// here touches ctx, `process` or node: builtins.
import { readOnlyShellNote } from './agents.js'
import { filterUnsupportedEffort, resolveCategory, snapshotProviders } from './resolver.js'

// Model-family detection for prompt-append variant selection.
// Claude/Kimi-like models follow mechanics-driven checklist prompts best;
// GPT-like models follow principle-driven prompts; everything else gets the
// neutral default.

/**
 * @param {string | undefined} modelId
 * @returns {'mechanics' | 'principle' | 'neutral'}
 */
export function modelFamily(modelId) {
  if (!modelId) return 'neutral'
  const id = modelId.toLowerCase()
  if (id.includes('claude') || id.includes('kimi') || id.includes('glm') || id.includes('k3')) return 'mechanics'
  if (id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4')) return 'principle'
  return 'neutral'
}

/**
 * Pick the prompt-append variant for one model family.
 * @param {string | { default: string, mechanics?: string, principle?: string }} append
 * @param {'mechanics' | 'principle' | 'neutral'} family
 * @returns {string}
 */
export function pickVariant(append, family) {
  if (typeof append === 'string') return append
  if (!append || typeof append !== 'object') return ''
  if (family === 'mechanics' && typeof append.mechanics === 'string') return append.mechanics
  if (family === 'principle' && typeof append.principle === 'string') return append.principle
  return typeof append.default === 'string' ? append.default : ''
}

function firstLine(text) {
  return text.split('\n', 1)[0].slice(0, 80)
}

/**
 * Build the target resolver.
 * @param {object} deps
 * @param {any} deps.agents - merged agent registry (CURATED_AGENTS ∪ row config agents)
 * @param {any} deps.userCategories - row config categories (config.categories)
 * @param {any} deps.overlay - settings overlay bundle { categoriesNow, robashNow, readOnlyTools, shellName }
 * @param {any} deps.llm - ctx.llm
 * @param {(fn: () => void) => void} deps.onAdaptersUpdated - llm/adapters-updated subscription
 */
export function createTargetResolver({ agents, userCategories, overlay, llm, onAdaptersUpdated }) {
  // Provider snapshot cache, invalidated on adapter topology changes.
  /** @type {Map<string, string[] | null> | null} */
  let snapshot = null
  const refresh = async () => {
    snapshot = await snapshotProviders(llm)
    return snapshot
  }
  const snapshotNow = async () => snapshot ?? (await refresh())
  onAdaptersUpdated(() => {
    snapshot = null
  })

  /**
   * Resolve one delegation item to persona + agentOptions + toolFilter.
   * Throws explicit errors for unknown/disabled/unavailable targets.
   * parentRoute (when known) gates effort hints on inherited routes.
   */
  async function resolveTarget(item, parentRoute) {
    // Resolve the guard overlay once for this delegation, so every branch below
    // describes one committed snapshot (see the hot-reload contract in
    // docs/features/category-delegation.md).
    const robash = overlay.robashNow()
    if (item.agent) {
      const agent = agents[item.agent]
      if (!agent) {
        throw new Error(`delegate: unknown_target "${item.agent}" (available agents: ${Object.keys(agents).join(', ') || 'none'})`)
      }
      if (agent.disabled) throw new Error(`delegate: agent "${item.agent}" is disabled`)
      const label = item.name ?? item.task_summary ?? `${item.agent}: ${firstLine(item.prompt)}`
      return {
        persona: agent.prompt + (robash.enabled ? readOnlyShellNote(overlay.shellName) : ''),
        toolFilter: { allow: overlay.readOnlyTools(agent.tools, robash) },
        label,
        readOnly: true,
      }
    }

    // Resolve once per delegation so the surface, the guard and the route all
    // agree on one snapshot of the settings overlay.
    const categories = overlay.categoriesNow()
    const category = categories[item.category]
    if (!category) {
      throw new Error(`delegate: unknown_target category "${item.category}" (available: ${Object.keys(categories).join(', ') || 'none'})`)
    }
    const providers = await snapshotNow()
    const hasUserConfig = Boolean(userCategories?.[item.category])
    let route = resolveCategory(category, providers, hasUserConfig)
    if (route.kind === 'unavailable') {
      throw new Error(`delegate: category "${item.category}" unavailable — ${route.reason}`)
    }
    if (route.kind === 'resolved') {
      route = await filterUnsupportedEffort(llm, route)
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
        const info = await llm.resolveModelInfo(parentRoute.provider, parentRoute.model)
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
      ...(category.readOnly ? { toolFilter: { allow: overlay.readOnlyTools(['read', 'glob', 'grep'], robash) } } : {}),
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      label,
      categoryName: item.category,
      ...(category.readOnly ? { readOnly: true } : {}),
    }
  }

  return { resolveTarget }
}
