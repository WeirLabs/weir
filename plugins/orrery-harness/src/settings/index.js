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
import { diffWhitelist, readBaselineWhitelists, renderDriftWarning } from '../shared/whitelist-drift.js'
import { buildRegistry } from '../lsp/registry.js'
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
  robashAllow: z.string().volatile().description('JSON array of allowed command names for the read-only bash guard (authoritative when set, including an empty array)'),
  robashGitAllow: z.string().volatile().description('JSON array of allowed git subcommands for the read-only bash guard (authoritative when set, including an empty array)'),
  robashDeny: z.string().volatile().description('JSON array of explicitly denied command names for the read-only bash guard (authoritative when set, including an empty array)'),
  robashPwshAllow: z.string().volatile().description('JSON array of allowed command names for the read-only pwsh guard (authoritative when set, including an empty array)'),
  robashPwshDeny: z.string().volatile().description('JSON array of explicitly denied command names for the read-only pwsh guard (authoritative when set, including an empty array)'),
  lspEnabled: z.boolean().volatile().description('LSP capability master switch (default off; when on, sessions start with LSP off and toggle it from the session header switch or the lsp tool)'),
  lspIdleMs: z.number().volatile().description('LSP server idle shutdown threshold (ms)'),
  lspRequestTimeoutMs: z.number().volatile().description('LSP request timeout (ms)'),
  lspDiagnosticsWaitMs: z.number().volatile().description('LSP diagnostics publish wait window (ms)'),
  lspServers: z.string().volatile().description('JSON map of custom language servers: family → { command, args?, manifests?, installHint?, install? }'),
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
    allow: 'robashAllow',
    gitAllow: 'robashGitAllow',
    deny: 'robashDeny',
    pwshAllow: 'robashPwshAllow',
    pwshDeny: 'robashPwshDeny',
  },
  lsp: {
    enabled: 'lspEnabled',
    idleMs: 'lspIdleMs',
    requestTimeoutMs: 'lspRequestTimeoutMs',
    diagnosticsWaitMs: 'lspDiagnosticsWaitMs',
    servers: 'lspServers',
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

/** Parse + validate the lspServers JSON map (bad input fails activation loud). */
export function parseLspServers(raw) {
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('orrery-settings: lspServers must be a JSON object map')
  }
  for (const [family, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string' || entry.command.trim().length === 0) {
      throw new Error(`orrery-settings: lspServers.${family} needs a { command } entry`)
    }
    if (entry.args !== undefined && !Array.isArray(entry.args)) {
      throw new Error(`orrery-settings: lspServers.${family}.args must be an array`)
    }
  }
  return parsed
}


/** Parse + validate one robash whitelist JSON string: a JSON array of strings;
 * bad input fails activation loud with the settings key named in the error. */
export function parseRobashLists(key, raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`orrery-settings: ${key} must be a JSON array of strings (invalid JSON)`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`orrery-settings: ${key} must be a JSON array of strings`)
  }
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      throw new Error(`orrery-settings: ${key} entries must all be strings`)
    }
  }
  return parsed
}

// The recomputed section uses the NESTED field names (`allow`, `pwshAllow`, ...)
// while the patch row and the baseline use the FLAT ones (`robashAllow`, ...).
// Without this map the drift check would compare against `undefined` on every
// key and silently never fire — the same class of blind spot it exists to catch.
const DRIFT_FIELD_TO_FLAT = {
  allow: 'robashAllow',
  gitAllow: 'robashGitAllow',
  deny: 'robashDeny',
  pwshAllow: 'robashPwshAllow',
  pwshDeny: 'robashPwshDeny',
}

function apply(ctx, config = {}) {
  // One drift report per process; compute() runs on every settings get().
  let driftReported = false
  // The DSH-fork schemastery materializes volatile fields as {get()} refs
  // (unset → get() === undefined); unwrap and drop unset fields so modules
  // read the same "absent means absent" values as before.
  //
  // Sections are recomputed on every get(): volatile settings commits mutate
  // this `config` reference IN PLACE (no remount), so live reads see saved
  // values immediately; consumers resolve `ctx.get('orrerySettings')` at
  // read time for the same freshness.
  let chainsCache = { raw: undefined, parsed: undefined }
  let lspServersCache = { raw: undefined, parsed: undefined }
  const robashListCaches = {
    allow: { raw: undefined, parsed: undefined },
    gitAllow: { raw: undefined, parsed: undefined },
    deny: { raw: undefined, parsed: undefined },
    pwshAllow: { raw: undefined, parsed: undefined },
    pwshDeny: { raw: undefined, parsed: undefined },
  }

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
      if (key === 'lsp' && typeof out.servers === 'string' && out.servers.trim().length > 0) {
        if (lspServersCache.raw !== out.servers) {
          lspServersCache = { raw: out.servers, parsed: parseLspServers(out.servers) }
        }
        out.servers = lspServersCache.parsed
      }
      if (key === 'robash') {
        // Empty-vs-absent (D2): an unset or empty-string list key is dropped
        // so the guard merge layer falls back to the lower config layer; a
        // present non-empty string parses into an authoritative array —
        // including '[]', an explicitly cleared list (fail-closed stricter,
        // never a fallback to defaults). Bad JSON fails activation loud.
        for (const [field, flatKey] of [['allow', 'robashAllow'], ['gitAllow', 'robashGitAllow'], ['deny', 'robashDeny'], ['pwshAllow', 'robashPwshAllow'], ['pwshDeny', 'robashPwshDeny']]) {
          if (typeof out[field] !== 'string') continue
          if (out[field].trim().length === 0) {
            delete out[field]
            continue
          }
          if (robashListCaches[field].raw !== out[field]) {
            robashListCaches[field] = { raw: out[field], parsed: parseRobashLists(flatKey, out[field]) }
          }
          out[field] = robashListCaches[field].parsed
        }
      }
      if (Object.keys(out).length > 0) sections[key] = out
    }
    // Report (never rewrite) whitelist drift once per process. Silent when the
    // composition declares no whitelist at all — that is the layered case, where
    // the guard falls back to module defaults by design (and what the headless
    // integration profile relies on).
    if (!driftReported) {
      driftReported = true
      const declared = {}
      const robash = sections.robash
      if (robash) {
        for (const [field, flatKey] of Object.entries(DRIFT_FIELD_TO_FLAT)) {
          if (Array.isArray(robash[field])) declared[flatKey] = robash[field]
        }
      }
      const drift = diffWhitelist(declared, readBaselineWhitelists())
      if (drift) ctx.logger?.warn?.(renderDriftWarning(drift))
    }
    return sections
  }

  // Compute eagerly: malformed categoryChains/lspServers/robash lists fail
  // activation loud.
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
  // package subpath (S14: new exports require an app restart). The services
  // resolve through ctx.inject — ctx.get does not see them from this scope
  // (verified live); absent → the callback never fires and nothing registers.
  // The registry is live: user `lspServers` merge over the built-in catalog.
  let offLspAdmin = () => {}
  ctx.inject?.(['connection', 'subprocess'], (scope) => {
    const off = registerLspAdminEndpoints(scope, {
      registry: () => buildRegistry(compute().lsp?.servers),
    })
    offLspAdmin = off
    return off
  })

  return () => offLspAdmin()
}

export { name, inject, apply }
