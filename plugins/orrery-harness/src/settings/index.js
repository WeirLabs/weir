// Orrery settings: one profile-level config holder for the whole Orrery
// settings tree. Declares a FLAT schemastery Config (the shared client
// SettingsFormModel only addresses flat fields; sections are regrouped by
// the orrerySettings service below) projected into the Settings app page.
//
// The schema carries NO defaults on purpose: after cordis validation the row
// config contains only the values the user actually set, so the settings
// service can overlay them over preset-row config without clobbering
// bundle-shipped defaults (layering: module defaults ← row config ← service).
// All fields are volatile-marked — required for the auto-generated page
// (S16) and for live in-place config updates. Plain ESM, ctx-only except the
// vendored DSH-fork schemastery (see ../vendor/THIRD-PARTY.md).
import z from '../vendor/schemastery.js'
import { isVolatile } from '../vendor/cosmokit.js'

const name = 'orrery-settings'
const inject = []

/** The one-stop Orrery settings tree (flat; auto-generated Settings page). */
export const Config = z.object({
  intentGateClassifier: z.union(['regex', 'llm', 'jev']).volatile().description('Intent classifier front-end'),
  intentGateProvider: z.string().volatile().description('Sidecar route override (llm mode)'),
  intentGateModel: z.string().volatile().description('Sidecar model override (llm mode)'),
  intentGateTimeoutMs: z.number().volatile().description('Classifier timeout (fail-open)'),
  jevEndpoint: z.string().volatile().description('Jev decisions endpoint (experimental)'),
  jevModel: z.string().volatile().description('Jev model name (experimental)'),
  jevApiKeyEnv: z.string().volatile().description('Env var name holding the Jev API key'),
  delegateCategoryChains: z.string().volatile().description('JSON map of category → ordered [{provider, model, reasoningEffort?}] rungs; replaces the category chain wholesale'),
  supervisionMaxRetries: z.number().volatile().description('Supervised continuation retry cap'),
  supervisionInitialBackoffMs: z.number().volatile().description('Supervised retry initial backoff (ms)'),
  supervisionMaxBackoffMs: z.number().volatile().description('Supervised retry backoff cap (ms)'),
  todoEnabled: z.boolean().volatile().description('Todo continuation driver switch'),
  todoMaxConsecutive: z.number().volatile().description('Auto-continuation cap without user input'),
  todoErrorRetryMax: z.number().volatile().description('Provider-error retry cap'),
  todoErrorBackoffBaseMs: z.number().volatile().description('Provider-error retry initial backoff (ms)'),
  todoErrorBackoffCapMs: z.number().volatile().description('Provider-error retry backoff cap (ms)'),
  guardEnabled: z.boolean().volatile().description('Context pressure guard switch'),
  guardSoftThreshold: z.number().volatile().description('Soft pressure threshold (advisory)'),
  guardHardThreshold: z.number().volatile().description('Hard pressure threshold (forced compaction)'),
  hashlineHideStockEdit: z.boolean().volatile().description('Hide the stock edit tool (hash_edit only)'),
  robashEnabled: z.boolean().volatile().description('Guarded read-only bash for curated agents (master switch)'),
  lspEnabled: z.boolean().volatile().description('LSP semantic tools (default off; per-session toggle also available via the lsp tool)'),
})

/** Flat field names per section key (the service regroups them). */
const SECTIONS = {
  intentGate: {
    classifier: 'intentGateClassifier',
    classifierProvider: 'intentGateProvider',
    classifierModel: 'intentGateModel',
    classifierTimeoutMs: 'intentGateTimeoutMs',
    jevEndpoint: 'jevEndpoint',
    jevModel: 'jevModel',
    jevApiKeyEnv: 'jevApiKeyEnv',
  },
  delegate: {
    categoryChains: 'delegateCategoryChains',
    supervisionMaxRetries: 'supervisionMaxRetries',
    supervisionInitialBackoffMs: 'supervisionInitialBackoffMs',
    supervisionMaxBackoffMs: 'supervisionMaxBackoffMs',
  },
  todoDriver: {
    enabled: 'todoEnabled',
    maxConsecutive: 'todoMaxConsecutive',
    errorRetryMax: 'todoErrorRetryMax',
    errorBackoffBaseMs: 'todoErrorBackoffBaseMs',
    errorBackoffCapMs: 'todoErrorBackoffCapMs',
  },
  contextGuard: {
    enabled: 'guardEnabled',
    softThreshold: 'guardSoftThreshold',
    hardThreshold: 'guardHardThreshold',
  },
  hashlineEdit: {
    hideStockEdit: 'hashlineHideStockEdit',
  },
  robash: {
    enabled: 'robashEnabled',
  },
  lsp: {
    enabled: 'lspEnabled',
  },
}

/** Parse + validate the categoryChains JSON map (bad input fails activation loud). */
function parseChains(raw) {
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('orrery-settings: delegateCategoryChains must be a JSON object map')
  }
  for (const [category, rungs] of Object.entries(parsed)) {
    if (!Array.isArray(rungs)) throw new Error(`orrery-settings: delegateCategoryChains.${category} must be an array of rungs`)
    for (const rung of rungs) {
      if (!rung || typeof rung.provider !== 'string' || typeof rung.model !== 'string') {
        throw new Error(`orrery-settings: delegateCategoryChains.${category} rungs need { provider, model }`)
      }
    }
  }
  return parsed
}

function apply(ctx, config = {}) {
  // The DSH-fork schemastery materializes volatile fields as {get()} refs
  // (unset → get() === undefined); unwrap and drop unset fields so modules
  // read the same "absent means absent" values as before.
  const flat = {}
  for (const [key, rawValue] of Object.entries(config ?? {})) {
    const value = isVolatile(rawValue) ? rawValue.get() : rawValue
    if (value === undefined) continue
    flat[key] = value
  }

  /** Regroup flat fields into the sectioned API modules consume. */
  function section(key) {
    const fields = SECTIONS[key]
    if (!fields) return undefined
    const out = {}
    for (const [field, flatKey] of Object.entries(fields)) {
      if (Object.hasOwn(flat, flatKey)) out[field] = flat[flatKey]
    }
    if (key === 'delegate' && typeof out.categoryChains === 'string' && out.categoryChains.trim().length > 0) {
      out.categoryChains = parseChains(out.categoryChains)
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  // Regroup eagerly: malformed categoryChains must fail activation loud.
  const sections = {}
  for (const key of Object.keys(SECTIONS)) sections[key] = section(key)

  // Host-plane service: preset modules read their override section at mount.
  ctx.reflect.provide('orrerySettings', {
    get(key) {
      return sections[key]
    },
  })

  // Settings page policy; optional in compositions without the forms service.
  try {
    ctx.get('settings')?.configure?.({ auto: true })
  } catch {
    // page policy is best-effort
  }
}

export { name, inject, apply }
