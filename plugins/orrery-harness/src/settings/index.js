// Orrery settings: one profile-level config holder for the whole Orrery
// settings tree. Declares a schemastery Config (projected into the Settings
// app as an auto-generated page) and provides the `orrerySettings` host
// service that preset modules read at mount time.
//
// The schema carries NO defaults on purpose: after cordis validation the row
// config contains only the values the user actually set, so the settings
// service can overlay them over preset-row config without clobbering
// bundle-shipped defaults (layering: module defaults ← row config ← service).
// Plain ESM, ctx-only except the vendored schemastery schema (see
// ../vendor/THIRD-PARTY.md).
import z from '../vendor/schemastery.js'

const name = 'orrery-settings'
const inject = []

/** The one-stop Orrery settings tree (auto-generated Settings page). */
export const Config = z.object({
  intentGate: z.object({
    classifier: z.union(['regex', 'llm', 'jev']).description('Intent classifier front-end'),
    classifierProvider: z.string().description('Sidecar route override (llm mode)'),
    classifierModel: z.string().description('Sidecar model override (llm mode)'),
    classifierTimeoutMs: z.number().description('Classifier timeout (fail-open)'),
    jevEndpoint: z.string().description('Jev decisions endpoint (experimental)'),
    jevModel: z.string().description('Jev model name (experimental)'),
    jevApiKeyEnv: z.string().description('Env var name holding the Jev API key'),
  }),
  delegate: z.object({
    categoryChains: z.string().description('JSON map of category → ordered [{provider, model, reasoningEffort?}] rungs; replaces the category chain wholesale'),
    supervisionMaxRetries: z.number().description('Supervised continuation retry cap'),
    supervisionInitialBackoffMs: z.number().description('Supervised retry initial backoff (ms)'),
    supervisionMaxBackoffMs: z.number().description('Supervised retry backoff cap (ms)'),
  }),
  todoDriver: z.object({
    enabled: z.boolean().description('Todo continuation driver switch'),
    maxConsecutive: z.number().description('Auto-continuation cap without user input'),
    errorRetryMax: z.number().description('Provider-error retry cap'),
    errorBackoffBaseMs: z.number().description('Provider-error retry initial backoff (ms)'),
    errorBackoffCapMs: z.number().description('Provider-error retry backoff cap (ms)'),
  }),
  contextGuard: z.object({
    enabled: z.boolean().description('Context pressure guard switch'),
    softThreshold: z.number().description('Soft pressure threshold (advisory)'),
    hardThreshold: z.number().description('Hard pressure threshold (forced compaction)'),
  }),
  hashlineEdit: z.object({
    hideStockEdit: z.boolean().description('Hide the stock edit tool (hash_edit only)'),
  }),
  robash: z.object({
    enabled: z.boolean().description('Guarded read-only bash for curated agents (master switch)'),
  }),
  lsp: z.object({
    enabled: z.boolean().description('LSP semantic tools (default off; per-session toggle also available via the lsp tool)'),
  }),
})

/** Parse + validate the categoryChains JSON map (bad input fails activation loud). */
function parseChains(raw) {
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('orrery-settings: delegate.categoryChains must be a JSON object map')
  }
  for (const [category, rungs] of Object.entries(parsed)) {
    if (!Array.isArray(rungs)) throw new Error(`orrery-settings: categoryChains.${category} must be an array of rungs`)
    for (const rung of rungs) {
      if (!rung || typeof rung.provider !== 'string' || typeof rung.model !== 'string') {
        throw new Error(`orrery-settings: categoryChains.${category} rungs need { provider, model }`)
      }
    }
  }
  return parsed
}

function apply(ctx, config = {}) {
  const sections = { ...config }
  if (typeof config.delegate?.categoryChains === 'string' && config.delegate.categoryChains.trim().length > 0) {
    sections.delegate = { ...config.delegate, categoryChains: parseChains(config.delegate.categoryChains) }
  }

  // Host-plane service: preset modules read their override section at mount.
  ctx.reflect.provide('orrerySettings', {
    get(section) {
      return sections[section]
    },
  })

  // Settings page policy (auto-generated form); optional in compositions
  // without the settings forms service.
  try {
    ctx.get('settings')?.configure?.({ auto: true })
  } catch {
    // page policy is best-effort
  }
}

export { name, inject, apply }
