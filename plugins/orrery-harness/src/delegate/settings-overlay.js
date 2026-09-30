// Delegate-local settings overlay: category chains, supervision tuning and the
// read-only shell guard tables, all resolved at READ time so a committed
// settings edit takes effect on the very next delegation (volatile config,
// S16). Pure module: the platform and the fallback whitelist tables are
// injected by the composition root, so nothing here touches `process` or
// node: builtins.
import { DEFAULT_CATEGORIES } from './categories.js'
import { CURATED_AGENTS } from './agents.js'
import { DEFAULT_TABLES } from './robash-guard-core.js'

/** The shell tool a read-only child gets: pwsh on Windows (where the preset
 * disables bash and mounts pwsh), bash everywhere else. Pure — parameterized
 * on platform for tests. */
export function readOnlyShellName(platform) {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

/**
 * The effective list for one guard table: the product defaults first, then every
 * addition, de-duplicated on first occurrence. Case is preserved — the pwsh path
 * lowercases at lookup time (its matching is case-insensitive) while the POSIX
 * path stays case-sensitive, so folding here would destroy that distinction.
 */
export function mergeWhitelist(defaults, additions) {
  const merged = []
  const seen = new Set()
  for (const entry of [...(defaults ?? []), ...(additions ?? [])]) {
    if (typeof entry !== 'string' || entry.length === 0) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    merged.push(entry)
  }
  return merged
}

/** The settings section's ADDITION lists, per field name, as `[]` when absent. */
function additionsOf(section, fields) {
  const out = {}
  for (const field of fields) {
    const value = section?.[field]
    out[field] = Array.isArray(value) ? value : []
  }
  return out
}

/**
 * Build the delegate-local settings overlay.
 *
 * Sections are re-resolved at every consumption point instead of snapshotted
 * at creation: the settings service recomputes on each get() and broadcasts on
 * commit, so reading late is what makes an online edit take effect in this same
 * process (no app restart). See docs/features/category-delegation.md —
 * "volatile config, 在线编辑即刻生效".
 *
 * @param {object} deps
 * @param {any} deps.settings - orrerySettings service handle (absent = no-op overlay)
 * @param {any} deps.config - plugin row config
 * @param {any} deps.logger - ctx.logger
 * @param {string} deps.platform - process.platform, captured once (per-process constant)
 * @param {any} deps.fallbackTables - FALLBACK_TABLES whitelist defaults
 */
export function createSettingsOverlay({ settings, config, logger, platform, fallbackTables }) {
  const robashOverrideNow = () => settings?.get('robash')
  const delegateOverrideNow = () => settings?.get('delegate')
  const shellName = readOnlyShellName(platform)

  const baseCategories = () => ({ ...DEFAULT_CATEGORIES, ...(config.categories ?? {}) })
  const baseAgents = () => ({ ...CURATED_AGENTS, ...(config.agents ?? {}) })

  // Settings category chains: wholesale chain replacement per named category.
  // Applied onto the base every time, so a commit is visible to the very next
  // delegation rather than to the next process.
  function categoriesNow() {
    const categories = baseCategories()
    const delegateOverride = delegateOverrideNow()
    if (delegateOverride?.categoryChains && typeof delegateOverride.categoryChains === 'object') {
      for (const [category, chain] of Object.entries(delegateOverride.categoryChains)) {
        if (!categories[category]) {
          logger?.warn?.(`orrery-settings: categoryChains names unknown category "${category}" — ignored`)
          continue
        }
        categories[category] = { ...categories[category], chain }
      }
    }
    // Settings-disabled categories (D5 append-only): the settings list can
    // only ADD disables — a registry-level `disabled` flag stays in effect and
    // no settings value can clear it. Unknown names warn and are ignored,
    // exactly like categoryChains.
    if (Array.isArray(delegateOverride?.disabledCategories)) {
      for (const category of delegateOverride.disabledCategories) {
        if (!categories[category]) {
          logger?.warn?.(`orrery-settings: disabledCategories names unknown category "${category}" — ignored`)
          continue
        }
        categories[category] = { ...categories[category], disabled: true }
      }
    }
    return categories
  }

  // Settings agent chains: wholesale chain replacement per named agent — the
  // exact counterpart of the categoryChains overlay above (an agent whose
  // chain stays empty inherits the caller route). Same read-late rule: applied
  // onto the base on every read, so a commit is visible to the very next
  // delegation rather than to the next process.
  function agentsNow() {
    const agents = baseAgents()
    const delegateOverride = delegateOverrideNow()
    if (delegateOverride?.agentChains && typeof delegateOverride.agentChains === 'object') {
      for (const [agent, chain] of Object.entries(delegateOverride.agentChains)) {
        if (!agents[agent]) {
          logger?.warn?.(`orrery-settings: agentChains names unknown agent "${agent}" — ignored`)
          continue
        }
        agents[agent] = { ...agents[agent], chain }
      }
    }
    return agents
  }

  // Supervision parameters the coordinator consumes. Resolved on demand (per
  // coordinator, and pushed into live coordinators on commit) so the settings
  // section stays authoritative without freezing into the row config.
  function supervisionNow() {
    const delegateOverride = delegateOverrideNow()
    const { supervisionMaxRetries, supervisionInitialBackoffMs, supervisionMaxBackoffMs } = delegateOverride ?? {}
    return {
      ...(config.supervision ?? {}),
      ...(supervisionMaxRetries !== undefined ? { maxRetries: supervisionMaxRetries } : {}),
      ...(supervisionInitialBackoffMs !== undefined ? { initialBackoffMs: supervisionInitialBackoffMs } : {}),
      ...(supervisionMaxBackoffMs !== undefined ? { maxBackoffMs: supervisionMaxBackoffMs } : {}),
    }
  }

  // Read-only shell guard: curated agents and readOnly categories get the
  // platform shell (bash, pwsh on win32) behind a fail-closed whitelist
  // guard when enabled.
  //
  // Layering contract (append semantics):
  //   default (from the product defaults file the plugin reads itself)
  //     ∪ row config additions (config.readOnlyBash / readOnlyPwsh)
  //     ∪ user additions (the settings section's list keys)
  //
  // The product defaults are NOT read from the settings row: a DSH patch row is
  // replaced wholesale rather than deep-merged, so a default that rides one can
  // be discarded by any profile that declares its own row — that is how a
  // whitelist addition once became unreachable for every profile that had ever
  // edited a list. The file is read by the plugin at its own path, which no
  // configuration layer can replace.
  //
  // Every layer only ADDS. Nothing here removes a default entry, and an empty
  // array adds nothing rather than clearing the list: appending to allow/gitAllow
  // widens what is permitted, appending to deny tightens it, and neither can
  // shrink the product defaults. The union is de-duplicated preserving first
  // occurrence, so the effective order is defaults first, additions after.
  function robashNow() {
    const robashOverride = robashOverrideNow()
    const defaults = robashOverride?.defaults ?? fallbackTables
    const robashConfig = {
      enabled: true,
      allow: DEFAULT_TABLES.robashAllow,
      gitAllow: DEFAULT_TABLES.robashGitAllow,
      deny: DEFAULT_TABLES.robashDeny,
      ...(config.readOnlyBash ?? {}),
      ...(robashOverride ?? {}),
    }
    const pwshConfig = {
      allow: DEFAULT_TABLES.robashPwshAllow,
      deny: DEFAULT_TABLES.robashPwshDeny,
      ...(config.readOnlyPwsh ?? {}),
    }
    const bashAdditions = additionsOf(robashOverride, ['allow', 'gitAllow', 'deny'])
    const pwshAdditions = additionsOf(robashOverride, ['pwshAllow', 'pwshDeny'])
    const gitAdditions = [...(robashConfig.gitAllow ?? []), ...bashAdditions.gitAllow]
    return {
      // enablement is a plain switch and still takes the section's last word;
      // only the LISTS changed to append semantics below
      enabled: robashConfig.enabled !== false,
      lists: {
        bash: {
          allow: mergeWhitelist(defaults.robashAllow, [...(robashConfig.allow ?? []), ...bashAdditions.allow]),
          gitAllow: mergeWhitelist(defaults.robashGitAllow, gitAdditions),
          deny: mergeWhitelist(defaults.robashDeny, [...(robashConfig.deny ?? []), ...bashAdditions.deny]),
        },
        pwsh: {
          allow: mergeWhitelist(defaults.robashPwshAllow, [...(pwshConfig.allow ?? []), ...pwshAdditions.pwshAllow]),
          // gitAllow is merged once on the bash side and shared with the pwsh
          // git gate, so a pwsh-specific git list is not consulted here.
          gitAllow: mergeWhitelist(defaults.robashGitAllow, gitAdditions),
          deny: mergeWhitelist(defaults.robashPwshDeny, [...(pwshConfig.deny ?? []), ...pwshAdditions.pwshDeny]),
        },
      },
    }
  }
  const readOnlyTools = (base, resolved = robashNow()) => (resolved.enabled ? [...new Set([...base, shellName])] : base)

  return { categoriesNow, agentsNow, supervisionNow, robashNow, readOnlyTools, shellName }
}
