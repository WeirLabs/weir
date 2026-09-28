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
import { registerLspAdminEndpoints } from '../lsp/admin.js'

const name = 'orrery-settings'
const inject = []

/** The one-stop Orrery settings tree (flat; auto-generated Settings page). */
export const Config = z.object({
  intentGateClassifier: z.union(['regex', 'llm', 'jev']).volatile().description('Intent classifier front-end'),
  intentGateProvider: z.string().volatile().description('Sidecar route override (llm mode)'),
  intentGateModel: z.string().volatile().description('Sidecar model override (llm mode)'),
  intentGateReasoningEffort: z.string().volatile().description('Sidecar reasoning-effort override (llm mode)'),
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
  lspEnabled: z.boolean().volatile().description('LSP capability master switch (default off; when on, sessions start with LSP off and toggle it from the session header switch or the lsp tool)'),
  lspIdleMs: z.number().volatile().description('LSP server idle shutdown threshold (ms)'),
  lspRequestTimeoutMs: z.number().volatile().description('LSP request timeout (ms)'),
  lspDiagnosticsWaitMs: z.number().volatile().description('LSP diagnostics publish wait window (ms)'),
})

/** Flat field names per section key (the service regroups them). */
const SECTIONS = {
  intentGate: {
    classifier: 'intentGateClassifier',
    classifierProvider: 'intentGateProvider',
    classifierModel: 'intentGateModel',
    classifierReasoningEffort: 'intentGateReasoningEffort',
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
    idleMs: 'lspIdleMs',
    requestTimeoutMs: 'lspRequestTimeoutMs',
    diagnosticsWaitMs: 'lspDiagnosticsWaitMs',
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
  //
  // Sections are recomputed on every get(): volatile settings commits mutate
  // this `config` reference IN PLACE (no remount), so live reads see saved
  // values immediately; consumers resolve `ctx.get('orrerySettings')` at
  // read time for the same freshness.
  let chainsCache = { raw: undefined, parsed: undefined }

  function compute() {
    const flat = {}
    for (const [key, rawValue] of Object.entries(config ?? {})) {
      const value = isVolatile(rawValue) ? rawValue.get() : rawValue
      if (value === undefined) continue
      flat[key] = value
    }
    const sections = {}
    for (const key of Object.keys(SECTIONS)) {
      const fields = SECTIONS[key]
      const out = {}
      for (const [field, flatKey] of Object.entries(fields)) {
        if (Object.hasOwn(flat, flatKey)) out[field] = flat[flatKey]
      }
      if (key === 'delegate' && typeof out.categoryChains === 'string' && out.categoryChains.trim().length > 0) {
        if (chainsCache.raw !== out.categoryChains) {
          chainsCache = { raw: out.categoryChains, parsed: parseChains(out.categoryChains) }
        }
        out.categoryChains = chainsCache.parsed
      }
      if (Object.keys(out).length > 0) sections[key] = out
    }
    return sections
  }

  // Compute eagerly: malformed categoryChains must fail activation loud.
  compute()

  const listeners = new Set()
  // Host-plane service: preset modules read their override section on demand.
  ctx.reflect.provide('orrerySettings', {
    get(key) {
      return compute()[key]
    },
    /** Subscribe to volatile settings commits (loader/volatile-update). */
    onChange(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  })
  ctx.on('loader/volatile-update', () => {
    for (const callback of listeners) callback()
  })

  // Settings page policy; optional in compositions without the forms service.
  try {
    ctx.get('settings')?.configure?.({ auto: true })
  } catch {
    // page policy is best-effort
  }

  // LSP management endpoints (status/install over the community catalog):
  // wired here on the profile-level settings row so the preset needs no new
  // package subpath (S14: new exports require an app restart). Optional
  // services; absent → the module warns and registers nothing.
  const offLspAdmin = registerLspAdminEndpoints(ctx)

  return () => offLspAdmin()
}

export { name, inject, apply }
