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
import { createWhitelistDefaultsCache, DEFAULT_WHITELIST_PATH } from '../shared/whitelist-defaults.js'
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
  robashAllow: z.string().volatile().description('JSON array of command names to APPEND to the product-default bash allow list (empty adds nothing; the defaults are always in effect)'),
  robashGitAllow: z.string().volatile().description('JSON array of git subcommands to APPEND to the product-default git allow list (empty adds nothing; the defaults are always in effect)'),
  robashDeny: z.string().volatile().description('JSON array of command names to APPEND to the product-default bash deny list (empty adds nothing; the defaults are always in effect)'),
  robashPwshAllow: z.string().volatile().description('JSON array of command names to APPEND to the product-default pwsh allow list (empty adds nothing; the defaults are always in effect)'),
  robashPwshDeny: z.string().volatile().description('JSON array of command names to APPEND to the product-default pwsh deny list (empty adds nothing; the defaults are always in effect)'),
  robashDefaultsPath: z.string().volatile().description('Path to a whitelist defaults file that TAKES OVER the shipped one (JSON object keyed by the five robash* table names); empty uses the shipped defaults'),
  robashDefaultsReload: z.number().volatile().description('Bump this number to re-read the whitelist defaults file without restarting (advanced/debug entry)'),
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
    defaultsPath: 'robashDefaultsPath',
    defaultsReload: 'robashDefaultsReload',
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


function apply(ctx, config = {}) {
  // The whitelist defaults cache: the defaults file is read once per process,
  // and an explicit reload entry (robashDefaultsReload) clears it. Nothing here
  // runs on the guard's per-command decision path.
  const whitelistDefaults = createWhitelistDefaultsCache({ logger: ctx.logger })
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
        // Append semantics: an unset or empty-string list key is dropped so the
        // guard merges no additions; a present non-empty string parses into that
        // list's ADDITIONS — including '[]', which adds nothing. The product
        // defaults never come from here (a patch row can be replaced wholesale);
        // they are published below from the defaults file the plugin reads
        // itself. Bad JSON still fails activation loud.
        for (const [field, flatKey] of [['allow', 'robashAllow'], ['gitAllow', 'robashGitAllow'], ['deny', 'robashDeny'], ['pwshAllow', 'robashPwshAllow'], ['pwshDeny', 'robashPwshDeny']]) {
          if (typeof out[field] !== 'string') continue
          if (out[field].trim().length === 0) {
            delete out[field]
            continue
          }
          if (robashListCaches[field].raw !== out[field]) {
            robashListCaches[field] = { raw: out[field], parsed: parseRobashLists(flatKey, out[field]) }
          }
          // an explicitly empty array is a no-op addition, i.e. indistinguishable
          // from absent: drop it so the consumer has ONE shape to handle
          if (robashListCaches[field].parsed.length === 0) {
            delete out[field]
            continue
          }
          out[field] = robashListCaches[field].parsed
        }
        // The product defaults, read from the plugin's own data file and
        // therefore immune to whole-value patch composition. Published to the
        // consumer as plain arrays (never callables) so a cached section cannot
        // throw a temporal-dead-zone error when an async consumer reads it late.
        const path = typeof out.defaultsPath === 'string' && out.defaultsPath.trim().length > 0
          ? out.defaultsPath.trim()
          : undefined
        delete out.defaultsPath
        delete out.defaultsReload
        const read = whitelistDefaults.tables(path ?? DEFAULT_WHITELIST_PATH)
        out.defaults = read.tables
        out.defaultsSource = read.source
      }
      if (Object.keys(out).length > 0) sections[key] = out
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
  // The explicit defaults-reload entry (robashDefaultsReload): a volatile commit
  // that only bumps this number clears the cache, so an edited defaults file is
  // picked up without a restart. It is a setting, not a tool, on purpose — the
  // entry exists for an administrator debugging their own whitelist file, and no
  // agent-facing surface should be able to widen the guard mid-session.
  // Read the marker off the raw config, not off `sections`: compute() consumes
  // these two keys (they configure the read, they are not part of the guard's
  // policy surface), so a section lookup would always see `undefined` and the
  // entry would never fire.
  const rawConfigValue = (key) => {
    const raw = config?.[key]
    return isVolatile(raw) ? raw.get() : raw
  }
  let lastReloadMarker = undefined
  const observeReloadEntry = () => {
    const marker = rawConfigValue('robashDefaultsReload')
    if (lastReloadMarker !== undefined && marker !== lastReloadMarker) whitelistDefaults.reload()
    lastReloadMarker = marker
  }
  observeReloadEntry()
  ctx.on('loader/volatile-update', () => {
    observeReloadEntry()
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
