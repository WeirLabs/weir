// Category chain resolution — pure core, testable without a running Harness.
// A chain rung resolves when its provider is registered and either that
// provider advertises no catalog (catalog is advisory per the runtime
// contract) or the model is listed. An empty chain inherits the caller's
// route. A configured chain with no resolvable rung fails explicitly.

/**
 * @typedef {object} ChainRung
 * @property {string} provider
 * @property {string} model
 * @property {string} [reasoningEffort]
 */

/**
 * Snapshot of registered providers and their catalogs.
 * Map<provider, string[] | null> — null means no catalog constraint.
 * @typedef {Map<string, string[] | null>} ProviderSnapshot
 */

/**
 * Build the snapshot from the llm service. Catalog failures degrade to null
 * (advisory absence), never to a rejected snapshot.
 * @param {object} llm - ctx.llm
 * @returns {Promise<ProviderSnapshot>}
 */
export async function snapshotProviders(llm) {
  const providers = llm.listProviders()
  const snapshot = new Map()
  await Promise.all(providers.map(async (info) => {
    try {
      const models = await llm.listModels(info.id)
      snapshot.set(info.id, models.map((model) => model.id))
    } catch {
      snapshot.set(info.id, null)
    }
  }))
  return snapshot
}

/** @returns {boolean} whether one rung resolves against the snapshot. */
export function rungResolves(rung, snapshot) {
  if (!snapshot.has(rung.provider)) return false
  const catalog = snapshot.get(rung.provider)
  if (catalog === null || catalog === undefined) return true
  return catalog.includes(rung.model)
}

/**
 * Resolve a category's route.
 * @param {object} category - registry entry { chain, gateModels?, disabled? }
 * @param {ProviderSnapshot} snapshot
 * @param {boolean} hasExplicitUserConfig - any explicit user config for this category
 * @returns {{ kind: 'resolved', provider: string, model: string, reasoningEffort?: string }
 *   | { kind: 'inherited' }
 *   | { kind: 'unavailable', reason: string }}
 */
export function resolveCategory(category, snapshot, hasExplicitUserConfig) {
  if (category.disabled) {
    return { kind: 'unavailable', reason: 'category disabled by configuration' }
  }
  const gateModels = category.gateModels
  if (!hasExplicitUserConfig && Array.isArray(gateModels) && gateModels.length > 0) {
    // Gates are fail-closed: only an explicit catalog listing satisfies them;
    // a provider without a catalog (unknown) never opens a gate.
    const satisfied = gateModels.some((model) => {
      for (const catalog of snapshot.values()) {
        if (catalog !== null && catalog !== undefined && catalog.includes(model)) return true
      }
      return false
    })
    if (!satisfied) {
      return { kind: 'unavailable', reason: `category requires one of ${gateModels.join(', ')}; none is registered` }
    }
  }
  const chain = Array.isArray(category.chain) ? category.chain : []
  if (chain.length === 0) return { kind: 'inherited' }
  for (const rung of chain) {
    if (rungResolves(rung, snapshot)) {
      return {
        kind: 'resolved',
        provider: rung.provider,
        model: rung.model,
        ...(rung.reasoningEffort ? { reasoningEffort: rung.reasoningEffort } : {}),
      }
    }
  }
  return {
    kind: 'unavailable',
    reason: `no chain rung resolves (tried: ${chain.map((rung) => `${rung.provider}/${rung.model}`).join(' → ')})`,
  }
}

/**
 * Drop a reasoningEffort the resolved route does not advertise. Returns a new
 * route object, or the input untouched when the effort survives.
 */
export async function filterUnsupportedEffort(llm, route) {
  if (route.kind !== 'resolved' || !route.reasoningEffort) return route
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const efforts = info?.reasoning?.efforts
    if (!Array.isArray(efforts) || efforts.length === 0) {
      const { reasoningEffort, ...rest } = route
      return rest
    }
    const supported = efforts.some((effort) => effort.id === route.reasoningEffort)
    if (supported) return route
    const { reasoningEffort, ...rest } = route
    return rest
  } catch {
    const { reasoningEffort, ...rest } = route
    return rest
  }
}
