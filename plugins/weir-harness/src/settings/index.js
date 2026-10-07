// Weir settings: one profile-level config holder for the whole Weir
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
import { wireEnvAdmin } from './env-admin.js'
import { createEditLockEvidence, wireEditLockMaintenance } from '../edit-lock/maintenance.js'
import { managementRootFor } from '../edit-lock/domains.js'
import { createAudit, AUDIT_TYPES } from '../shared/audit.js'

// Host lifetime, not settings-row lifetime: remounting settings must not forget
// still-live preset rows. Weak keys isolate hosts and release stopped hosts.
const evidenceByHost = new WeakMap()

export { Config } from './sections.js'

const name = 'weir-settings'
const inject = []

// Explicit resolver seam keeps root-discovery tests away from ancestor authorities.
export function maintenanceRoots(agents, resolveRoot = managementRootFor) {
  const roots = new Set()
  for (const agent of agents?.roots?.() ?? []) {
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string') continue
    try { roots.add(resolveRoot(cwd)) } catch { /* unavailable root */ }
  }
  return [...roots]
}
/** @param {{ resolveRoot?: typeof managementRootFor }} [dependencies] */
export function createSettingsPlugin({ resolveRoot = managementRootFor } = {}) {
// Arrow apply: cordis must retain the returned endpoint disposer, not construct it.
return (ctx, config = {}) => {
  // The whitelist defaults cache: the defaults file is read once per process,
  // and an explicit reload entry (robashDefaultsReload) clears it. Nothing here
  // runs on the guard's per-command decision path.
  const whitelistDefaults = createWhitelistDefaultsCache({ logger: ctx.logger })
  const readDefaults = (path) => whitelistDefaults.tables(path ?? DEFAULT_WHITELIST_PATH)
  // Sections are recomputed on every get(): volatile settings commits mutate
  // this `config` reference IN PLACE (no remount), so live reads see saved
  // values immediately; consumers resolve `ctx.get('weirSettings')` at
  // read time for the same freshness.
  const compute = () => computeSections(config, { readDefaults })

  // Compute eagerly: malformed categoryChains/lspServers/robash lists fail
  // activation loud.
  compute()
  const host = ctx.root ?? ctx
  let editLockEvidence = evidenceByHost.get(host)
  if (!editLockEvidence) {
    editLockEvidence = createEditLockEvidence()
    evidenceByHost.set(host, editLockEvidence)
  }
  const candidateRoots = () => maintenanceRoots(ctx.get?.('agents'), resolveRoot)
  const savedEnabled = () => compute().editLock?.enabled === true
  const audit = createAudit(ctx)
  let lastEnabled = savedEnabled()

  const listeners = new Set()
  // Host-plane service: preset modules read their override section on demand.
  ctx.reflect.provide('weirSettings', {
    editLockEvidence,
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
    const enabled = savedEnabled()
    if (enabled !== lastEnabled) {
      lastEnabled = enabled
      // Profile intent has no session log. Mirror only when a server-derived
      // workspace exists; no cwd fallback to the developer's current directory.
      const data = { kind: enabled ? 'enable-requested' : 'disable-requested', scope: 'profile', appliesAfterRestart: true }
      let roots = []
      try { roots = candidateRoots() } catch { /* emit remains available */ }
      if (roots.length) for (const root of roots) audit(null, AUDIT_TYPES.editLockMaintenance, data, { root })
      else audit(null, AUDIT_TYPES.editLockMaintenance, data)
    }
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

  const offMaintenance = wireEditLockMaintenance(ctx, { savedEnabled, evidence: editLockEvidence, candidateRoots })
  // Environment facts endpoint (settings-page `when: { env }` rows): same
  // settings-row wiring as the LSP endpoints above (S19).
  const offEnvAdmin = wireEnvAdmin(ctx)
  return () => { offMaintenance(); offLspAdmin(); offEnvAdmin(); listeners.clear() }
}
}
const apply = createSettingsPlugin()

export { name, inject, apply }
