// Orrery settings: one profile-level config holder for the whole Orrery
// settings tree. This row is now a THIN WIRING shell: the schema (Config),
// the section regrouping, the JSON-field parsing, and the volatile-ref
// unwrapping live in the pure modules ./sections.js and ./volatile.js (see
// docs/features/preset-packaging.md); the LSP endpoint wiring lives in
// src/lsp/admin.js (wireLspAdmin) and is only INVOKED here (S19).
//
// The schema carries NO defaults on purpose: after cordis validation the row
// config contains only the values the user actually set, so the settings
// service can overlay them over preset-row config without clobbering
// bundle-shipped defaults (layering: module defaults ← row config ← service).
import { createWhitelistDefaultsCache, DEFAULT_WHITELIST_PATH } from '../shared/whitelist-defaults.js'
import { configValue } from './volatile.js'
import { computeSections } from './sections.js'
import { wireLspAdmin } from '../lsp/admin.js'

export { Config } from './sections.js'

const name = 'orrery-settings'
const inject = []

function apply(ctx, config = {}) {
  // The whitelist defaults cache: the defaults file is read once per process,
  // and an explicit reload entry (robashDefaultsReload) clears it. Nothing here
  // runs on the guard's per-command decision path.
  const whitelistDefaults = createWhitelistDefaultsCache({ logger: ctx.logger })
  const readDefaults = (path) => whitelistDefaults.tables(path ?? DEFAULT_WHITELIST_PATH)
  // Sections are recomputed on every get(): volatile settings commits mutate
  // this `config` reference IN PLACE (no remount), so live reads see saved
  // values immediately; consumers resolve `ctx.get('orrerySettings')` at
  // read time for the same freshness.
  const compute = () => computeSections(config, { readDefaults })

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
  let lastReloadMarker = undefined
  const observeReloadEntry = () => {
    const marker = configValue(config?.['robashDefaultsReload'])
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
  // INVOKED here on the profile-level settings row so the preset needs no new
  // package subpath (S19: new exports require an app restart); the wiring body
  // (inject tuple, registry builder, disposer bookkeeping) lives in
  // src/lsp/admin.js. The registry is live: user `lspServers` merge over the
  // built-in catalog.
  const offLspAdmin = wireLspAdmin(ctx, () => compute().lsp?.servers)

  return () => offLspAdmin()
}

export { name, inject, apply }
