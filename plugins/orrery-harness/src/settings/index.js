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
import { isVolatile } from '../vendor/cosmokit.js'

const name = 'orrery-settings'
const inject = []

/** The one-stop Orrery settings tree (auto-generated Settings page). */
export const Config = z.object({
  intentGate: z.object({
    classifier: z.union(['regex', 'llm', 'jev']).volatile().description('Intent classifier front-end'),
    classifierProvider: z.string().volatile().description('Sidecar route override (llm mode)'),
    classifierModel: z.string().volatile().description('Sidecar model override (llm mode)'),
    classifierTimeoutMs: z.number().volatile().description('Classifier timeout (fail-open)'),
    jevEndpoint: z.string().volatile().description('Jev decisions endpoint (experimental)'),
    jevModel: z.string().volatile().description('Jev model name (experimental)'),
    jevApiKeyEnv: z.string().volatile().description('Env var name holding the Jev API key'),
  }),
  delegate: z.object({
    categoryChains: z.string().volatile().description('JSON map of category → ordered [{provider, model, reasoningEffort?}] rungs; replaces the category chain wholesale'),
    supervisionMaxRetries: z.number().volatile().description('Supervised continuation retry cap'),
    supervisionInitialBackoffMs: z.number().volatile().description('Supervised retry initial backoff (ms)'),
    supervisionMaxBackoffMs: z.number().volatile().description('Supervised retry backoff cap (ms)'),
  }),
  todoDriver: z.object({
    enabled: z.boolean().volatile().description('Todo continuation driver switch'),
    maxConsecutive: z.number().volatile().description('Auto-continuation cap without user input'),
    errorRetryMax: z.number().volatile().description('Provider-error retry cap'),
    errorBackoffBaseMs: z.number().volatile().description('Provider-error retry initial backoff (ms)'),
    errorBackoffCapMs: z.number().volatile().description('Provider-error retry backoff cap (ms)'),
  }),
  contextGuard: z.object({
    enabled: z.boolean().volatile().description('Context pressure guard switch'),
    softThreshold: z.number().volatile().description('Soft pressure threshold (advisory)'),
    hardThreshold: z.number().volatile().description('Hard pressure threshold (forced compaction)'),
  }),
  hashlineEdit: z.object({
    hideStockEdit: z.boolean().volatile().description('Hide the stock edit tool (hash_edit only)'),
  }),
  robash: z.object({
    enabled: z.boolean().volatile().description('Guarded read-only bash for curated agents (master switch)'),
  }),
  lsp: z.object({
    enabled: z.boolean().volatile().description('LSP semantic tools (default off; per-session toggle also available via the lsp tool)'),
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
  // The DSH-fork schemastery materializes unset volatile fields as empty
  // wrapper objects ({}); strip them so modules see the same "absent means
  // absent" semantics as before, then parse the categoryChains JSON overlay.
  const raw = stripVolatileEmpties(config)
  const sections = { ...raw }
  if (typeof raw.delegate?.categoryChains === 'string' && raw.delegate.categoryChains.trim().length > 0) {
    sections.delegate = { ...raw.delegate, categoryChains: parseChains(raw.delegate.categoryChains) }
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


/**
 * Unwrap DSH-fork volatile refs ({get()}) and drop unset fields (their refs
 * snapshot {}) plus fully emptied sections, so modules read the same
 * "absent means absent" values the non-fork schemastery produced.
 */
function stripVolatileEmpties(config) {
  const out = {}
  for (const [sectionKey, section] of Object.entries(config ?? {})) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue
    const cleaned = {}
    for (const [fieldKey, rawValue] of Object.entries(section)) {
      const value = isVolatile(rawValue) ? rawValue.get() : rawValue
      if (value === undefined) continue
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue
      cleaned[fieldKey] = value
    }
    if (Object.keys(cleaned).length > 0) out[sectionKey] = cleaned
  }
  return out
}

export { name, inject, apply }
