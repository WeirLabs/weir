// The settings sections core: one FIELDS table declares every flat settings
// key once (its section, field name, type, and description), and both the
// schemastery Config and the service's section map derive from it. Pure:
// same input, same output, no ctx, no event reads, no node: imports — the
// whitelist defaults read is injected by the caller (readDefaults) so this
// module stays inside the jsconfig pure-module curation rule.
import z from '../vendor/schemastery.js'
import { flattenConfig } from './volatile.js'

/**
 * The single declaration of every flat settings key.
 * type: 'string' | 'number' | 'boolean' | { union: string[] }.
 * list: true marks the five robash whitelist tables (append semantics).
 * restart: true marks keys whose consuming module snapshots them once at
 * apply, so a volatile settings commit only takes effect after an app
 * restart (see RESTART_KEYS below).
 */
const FIELDS = [
  { key: 'intentGateClassifier', section: 'intentGate', field: 'classifier', type: { union: ['regex', 'llm', 'jev'] }, description: 'Intent classifier front-end', restart: true },
  { key: 'intentGateProvider', section: 'intentGate', field: 'classifierProvider', type: 'string', description: 'Sidecar route override (llm mode)', restart: true },
  { key: 'intentGateModel', section: 'intentGate', field: 'classifierModel', type: 'string', description: 'Sidecar model override (llm mode)', restart: true },
  { key: 'intentGateReasoningEffort', section: 'intentGate', field: 'classifierReasoningEffort', type: 'string', description: 'Sidecar reasoning-effort override (llm mode)', restart: true },
  { key: 'intentGateTimeoutMs', section: 'intentGate', field: 'classifierTimeoutMs', type: 'number', description: 'Classifier timeout (fail-open)', restart: true },
  { key: 'jevEndpoint', section: 'intentGate', field: 'jevEndpoint', type: 'string', description: 'Jev decisions endpoint (experimental)', restart: true },
  { key: 'jevModel', section: 'intentGate', field: 'jevModel', type: 'string', description: 'Jev model name (experimental)', restart: true },
  { key: 'jevApiKeyEnv', section: 'intentGate', field: 'jevApiKeyEnv', type: 'string', description: 'Env var name holding the Jev API key', restart: true },
  { key: 'delegateCategoryChains', section: 'delegate', field: 'categoryChains', type: 'string', description: 'JSON map of category → ordered [{provider, model, reasoningEffort?}] rungs; replaces the category chain wholesale' },
  { key: 'delegateAgentChains', section: 'delegate', field: 'agentChains', type: 'string', description: 'JSON map of curated agent → ordered [{provider, model, reasoningEffort?}] rungs; replaces that agent\'s chain wholesale (an agent with an empty chain inherits the caller route)' },
  { key: 'delegateDisabledCategories', section: 'delegate', field: 'disabledCategories', type: 'string', description: 'JSON array of category names to disable; disabled categories are hidden from the model and cannot be delegated to' },
  { key: 'supervisionMaxRetries', section: 'delegate', field: 'supervisionMaxRetries', type: 'number', description: 'Supervised continuation retry cap' },
  { key: 'supervisionInitialBackoffMs', section: 'delegate', field: 'supervisionInitialBackoffMs', type: 'number', description: 'Supervised retry initial backoff (ms)' },
  { key: 'supervisionMaxBackoffMs', section: 'delegate', field: 'supervisionMaxBackoffMs', type: 'number', description: 'Supervised retry backoff cap (ms)' },
  { key: 'todoEnabled', section: 'todoDriver', field: 'enabled', type: 'boolean', description: 'Todo continuation driver switch', restart: true },
  { key: 'todoMaxConsecutive', section: 'todoDriver', field: 'maxConsecutive', type: 'number', description: 'Auto-continuation cap without user input', restart: true },
  { key: 'todoErrorRetryMax', section: 'todoDriver', field: 'errorRetryMax', type: 'number', description: 'Provider-error retry cap', restart: true },
  { key: 'todoErrorBackoffBaseMs', section: 'todoDriver', field: 'errorBackoffBaseMs', type: 'number', description: 'Provider-error retry initial backoff (ms)', restart: true },
  { key: 'todoErrorBackoffCapMs', section: 'todoDriver', field: 'errorBackoffCapMs', type: 'number', description: 'Provider-error retry backoff cap (ms)', restart: true },
  { key: 'guardEnabled', section: 'contextGuard', field: 'enabled', type: 'boolean', description: 'Context pressure guard switch', restart: true },
  { key: 'guardSoftThreshold', section: 'contextGuard', field: 'softThreshold', type: 'number', description: 'Soft pressure threshold (advisory)', restart: true },
  { key: 'guardHardThreshold', section: 'contextGuard', field: 'hardThreshold', type: 'number', description: 'Hard pressure threshold (forced compaction)', restart: true },
  { key: 'hashlineHideStockEdit', section: 'hashlineEdit', field: 'hideStockEdit', type: 'boolean', description: 'Hide the stock edit tool (hash_edit only)', restart: true },
  { key: 'editLockEnabled', section: 'editLock', field: 'enabled', type: 'boolean', description: 'Edit Lock cross-session file ownership (experimental, default off; applies after restart)', restart: true },
  // Retention (design D1/D2): one lock batch shares one cumulative allowance, so a
  // session reads one expiry instead of N countdowns. These keys are policy, not
  // mechanism: the kernel never sees them, the lifecycle resolves them per call.
  { key: 'editLockHoldDefaultMinutes', section: 'editLock', field: 'holdDefaultMinutes', type: 'number', description: 'Edit Lock: retention minutes used when a session asks to keep its locks without giving a period (default 30)' },
  { key: 'editLockHoldSingleMaxMinutes', section: 'editLock', field: 'holdSingleMaxMinutes', type: 'number', description: 'Edit Lock: most minutes one retention request may ask for (default 30)' },
  { key: 'editLockHoldCumulativeMaxMinutes', section: 'editLock', field: 'holdCumulativeMaxMinutes', type: 'number', description: 'Edit Lock: cumulative retention minutes one batch of locks may use; asks beyond it are refused and only release remains (default 120)' },
  { key: 'editLockNudgeAttempts', section: 'editLock', field: 'nudgeAttempts', type: 'number', description: 'Edit Lock: how many times a finished turn is continued to ask for still-held locks to be released or retained (default 2)' },
  { key: 'editLockNudgeFallback', section: 'editLock', field: 'nudgeFallback', type: { union: ['release', 'abnormal'] }, description: 'Edit Lock: disposition of locks still held after those notices are used up; release frees the files for other sessions, abnormal keeps them for the user (default release)' },
  { key: 'editLockAutoResume', section: 'editLock', field: 'autoResume', type: 'boolean', description: 'Edit Lock: a genuine user message automatically resumes a stopped session and confirms its retained files (default on)' },
  { key: 'editLockStaleSweep', section: 'editLock', field: 'staleSweep', type: 'boolean', description: 'Edit Lock: a genuine user message silently releases locks whose target file no longer exists (default on; read per message, applies immediately)' },
  { key: 'robashEnabled', section: 'robash', field: 'enabled', type: 'boolean', description: 'Guarded read-only bash for curated agents (master switch)' },
  { key: 'robashAllow', section: 'robash', field: 'allow', type: 'string', list: true, description: 'JSON array of command names to APPEND to the product-default bash allow list (empty adds nothing; the defaults are always in effect)' },
  { key: 'robashGitAllow', section: 'robash', field: 'gitAllow', type: 'string', list: true, description: 'JSON array of git subcommands to APPEND to the product-default git allow list (empty adds nothing; the defaults are always in effect)' },
  { key: 'robashDeny', section: 'robash', field: 'deny', type: 'string', list: true, description: 'JSON array of command names to APPEND to the product-default bash deny list (empty adds nothing; the defaults are always in effect)' },
  { key: 'robashPwshAllow', section: 'robash', field: 'pwshAllow', type: 'string', list: true, description: 'JSON array of command names to APPEND to the product-default pwsh allow list (empty adds nothing; the defaults are always in effect)' },
  { key: 'robashPwshDeny', section: 'robash', field: 'pwshDeny', type: 'string', list: true, description: 'JSON array of command names to APPEND to the product-default pwsh deny list (empty adds nothing; the defaults are always in effect)' },
  { key: 'robashDefaultsPath', section: 'robash', field: 'defaultsPath', type: 'string', description: 'Path to a whitelist defaults file that TAKES OVER the shipped one (JSON object keyed by the five robash* table names); empty uses the shipped defaults' },
  { key: 'robashDefaultsReload', section: 'robash', field: 'defaultsReload', type: 'number', description: 'Bump this number to re-read the whitelist defaults file without restarting (advanced/debug entry)' },
  { key: 'lspEnabled', section: 'lsp', field: 'enabled', type: 'boolean', description: 'LSP capability master switch (default off; when on, sessions start with LSP off and toggle it from the session header switch or the lsp tool)' },
  { key: 'lspIdleMs', section: 'lsp', field: 'idleMs', type: 'number', description: 'LSP server idle shutdown threshold (ms)' },
  { key: 'lspRequestTimeoutMs', section: 'lsp', field: 'requestTimeoutMs', type: 'number', description: 'LSP request timeout (ms)' },
  { key: 'lspDiagnosticsWaitMs', section: 'lsp', field: 'diagnosticsWaitMs', type: 'number', description: 'LSP diagnostics publish wait window (ms)' },
  { key: 'worktreeEnabled', section: 'worktree', field: 'enabled', type: 'boolean', description: 'Worktree lanes capability switch: lane tools, /worktree, Worktree mode, and the lanes panel' },
  { key: 'worktreeRoot', section: 'worktree', field: 'root', type: 'string', description: 'Repository-relative directory that holds lanes (locally ignored through .git/info/exclude)' },
  { key: 'worktreeMaxActive', section: 'worktree', field: 'maxActive', type: 'number', description: 'Maximum number of active lanes per repository' },
  { key: 'worktreeAutoSetup', section: 'worktree', field: 'autoSetup', type: 'boolean', description: 'Install dependencies in a new lane automatically (configured setup, else lockfile-derived)' },
  { key: 'worktreeWatchTimeoutMinutes', section: 'worktree', field: 'watchTimeoutMinutes', type: 'number', description: 'Minutes a lane-state watch (worktree_watch) lives before expiring with one notice (default 360 = 6 hours, minimum 1); frozen per watch at subscribe time' },
  { key: 'lspServers', section: 'lsp', field: 'servers', type: 'string', description: 'JSON map of custom language servers: family → { command, args?, manifests?, installHint?, install? }' },
  { key: 'notifyEnabled', section: 'notify', field: 'enabled', type: 'boolean', description: 'System notifications master switch: tell the user when a session needs them or a turn finishes' },
  { key: 'notifyOnComplete', section: 'notify', field: 'onComplete', type: 'boolean', description: 'Notify when a turn finishes (only turns longer than notifyMinTurnSeconds)' },
  { key: 'notifyOnAttention', section: 'notify', field: 'onAttention', type: 'boolean', description: 'Notify when a session needs the user: approval, question, plan review, a failed or stopped turn' },
  { key: 'notifyMinTurnSeconds', section: 'notify', field: 'minTurnSeconds', type: 'number', description: 'A finished turn is only reported when it ran at least this many seconds (0 reports every turn)' },
  { key: 'notifySound', section: 'notify', field: 'sound', type: 'boolean', description: 'Play the platform notification sound where supported' },
  { key: 'notifyForeground', section: 'notify', field: 'foreground', type: { union: ['skip', 'always'] }, description: 'DeepSeek Harness window in the foreground: skip stays quiet (default), always notifies anyway' },
]

/** Flat settings keys that only take effect after an app restart: their
 * consuming modules snapshot them once at apply, so a volatile settings
 * commit does not re-read them. Derived from FIELDS (declared once); the
 * settings page keeps a client-side copy pinned to this list by test. */
export const RESTART_KEYS = Object.freeze(FIELDS.filter(({ restart }) => restart).map(({ key }) => key))

export { FIELDS }

/** Product defaults of the flat settings keys, mirrored from the consuming
 * modules' code defaults (intent-gate classifier, delegate supervision,
 * todo driver, context guard, edit-lock retention, robash, lsp, worktree,
 * notify). This is the canonical declaration: the cordis.patch.yml
 * orrery-settings row carries the same values so saved profiles resolve
 * them, and the settings page mirrors this table client-side to SHOW the
 * effective default of an unset field (both directions pinned by test).
 * Keys where unset is meaningful (route overrides, chains, the five robash
 * whitelist tables, robashDefaultsPath/Reload, lspServers) have NO entry. */
export const FIELD_DEFAULTS = Object.freeze({
  intentGateClassifier: 'regex',
  intentGateTimeoutMs: 1500,
  jevModel: 'jev',
  supervisionMaxRetries: 5,
  supervisionInitialBackoffMs: 30000,
  supervisionMaxBackoffMs: 300000,
  todoEnabled: true,
  todoMaxConsecutive: 8,
  todoErrorRetryMax: 5,
  todoErrorBackoffBaseMs: 30000,
  todoErrorBackoffCapMs: 300000,
  guardEnabled: true,
  guardSoftThreshold: 0.72,
  guardHardThreshold: 0.88,
  hashlineHideStockEdit: true,
  editLockEnabled: false,
  editLockHoldDefaultMinutes: 30,
  editLockHoldSingleMaxMinutes: 30,
  editLockHoldCumulativeMaxMinutes: 120,
  editLockNudgeAttempts: 2,
  editLockNudgeFallback: 'release',
  editLockAutoResume: true,
  editLockStaleSweep: true,
  robashEnabled: true,
  lspEnabled: false,
  lspIdleMs: 600000,
  lspRequestTimeoutMs: 15000,
  lspDiagnosticsWaitMs: 2000,
  worktreeEnabled: true,
  worktreeRoot: '.orrery/worktrees',
  worktreeMaxActive: 4,
  worktreeAutoSetup: true,
  worktreeWatchTimeoutMinutes: 360,
  notifyEnabled: true,
  notifyOnComplete: true,
  notifyOnAttention: true,
  notifyMinTurnSeconds: 15,
  notifySound: true,
  notifyForeground: 'skip',
})

/** Resolved Edit Lock retention policy. The keys are declared above; this is the
 * ONE place that turns them into the values the lifecycle consumes, so defaults
 * and validation cannot drift apart. */
export const EDIT_LOCK_DEFAULTS = Object.freeze({
  holdDefaultMinutes: 30,
  holdSingleMaxMinutes: 30,
  holdCumulativeMaxMinutes: 120,
  nudgeAttempts: 2,
  nudgeFallback: 'release',
})

/** Overlay one Edit Lock section onto the defaults. A key the user never set
 * falls back to its default; a key that is present but unusable (alone or in
 * combination) throws with the flat settings key named, because silently clamping
 * a retention cap would change how long other sessions stay blocked from those
 * files. The Edit Lock composition refuses retention requests with that error and
 * runs every other path (settling, status, release, stop, unlock) on defaults.
 * @param {any} section */
export function editLockLimits(section) {
  const value = section && typeof section === 'object' ? section : {}
  /** @type {{holdDefaultMinutes: number, holdSingleMaxMinutes: number, holdCumulativeMaxMinutes: number, nudgeAttempts: number, nudgeFallback: 'release'|'abnormal'}} */
  const limits = { ...EDIT_LOCK_DEFAULTS }
  /** @param {'holdDefaultMinutes'|'holdSingleMaxMinutes'|'holdCumulativeMaxMinutes'} key @param {string} name */
  const take = (key, name) => {
    const input = value[key]
    if (input === undefined) return
    if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
      throw new Error(`orrery-settings: ${name} must be a positive number`)
    }
    limits[key] = input
  }
  take('holdDefaultMinutes', 'editLockHoldDefaultMinutes')
  take('holdSingleMaxMinutes', 'editLockHoldSingleMaxMinutes')
  take('holdCumulativeMaxMinutes', 'editLockHoldCumulativeMaxMinutes')
  if (limits.holdDefaultMinutes > limits.holdSingleMaxMinutes) {
    throw new Error('orrery-settings: editLockHoldDefaultMinutes must not exceed editLockHoldSingleMaxMinutes')
  }
  if (limits.holdCumulativeMaxMinutes < limits.holdSingleMaxMinutes) {
    throw new Error('orrery-settings: editLockHoldCumulativeMaxMinutes must be at least editLockHoldSingleMaxMinutes')
  }
  if (value.nudgeAttempts !== undefined) {
    if (!Number.isSafeInteger(value.nudgeAttempts) || value.nudgeAttempts < 0) {
      throw new Error('orrery-settings: editLockNudgeAttempts must be a non-negative integer')
    }
    limits.nudgeAttempts = value.nudgeAttempts
  }
  if (value.nudgeFallback !== undefined) {
    if (value.nudgeFallback !== 'release' && value.nudgeFallback !== 'abnormal') {
      throw new Error('orrery-settings: editLockNudgeFallback must be "release" or "abnormal"')
    }
    limits.nudgeFallback = value.nudgeFallback
  }
  return Object.freeze(limits)
}
const zs = z

function fieldSchema(type) {
  if (typeof type === 'object' && type !== null && Array.isArray(type.union)) return zs.union(type.union)
  if (type === 'number') return zs.number()
  if (type === 'boolean') return zs.boolean()
  return zs.string()
}

/** The one-stop Orrery settings tree (flat; auto-generated Settings page). */
export const Config = zs.object(
  Object.fromEntries(FIELDS.map(({ key, type, description }) => [key, fieldSchema(type).volatile().description(description)])),
)

/** Flat field names per section key (the service regroups them). */
export const SECTIONS = FIELDS.reduce((acc, { key, section, field }) => {
  ;(acc[section] ??= {})[field] = key
  return acc
}, {})

/** The five robash whitelist tables, derived from FIELDS (declared once). */
const ROBASH_LIST_FIELDS = FIELDS.filter(({ section, list }) => section === 'robash' && list).map(({ key, field }) => [field, key])

/** Parse + validate a chains JSON map (target → ordered rungs), shared by
 * delegateCategoryChains and delegateAgentChains; bad input fails activation
 * loud with the flat settings key named in every error. Partially applied per
 * key (chainsValidator) so the parseJsonField memoization key — the validator
 * function itself — is stable per settings key. */
function validateChains(key, raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`orrery-settings: ${key} must be a JSON object map of rung arrays (invalid JSON)`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`orrery-settings: ${key} must be a JSON object map`)
  }
  for (const [target, rungs] of Object.entries(parsed)) {
    if (!Array.isArray(rungs)) throw new Error(`orrery-settings: ${key}.${target} must be an array of rungs`)
    for (const rung of rungs) {
      if (!rung || typeof rung.provider !== 'string' || typeof rung.model !== 'string') {
        throw new Error(`orrery-settings: ${key}.${target} rungs need { provider, model }`)
      }
    }
  }
  return parsed
}

const chainsValidators = new Map()
function chainsValidator(key) {
  let validate = chainsValidators.get(key)
  if (!validate) {
    validate = (raw) => validateChains(key, raw)
    chainsValidators.set(key, validate)
  }
  return validate
}

/** Parse + validate the lspServers JSON map (bad input fails activation loud). */
function validateLspServers(raw) {
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

/** Parse + validate one JSON-string field holding an array of strings; bad
 * input fails activation loud with the settings key named in the error. Shared
 * by the five robash whitelist tables and delegate disabledCategories. The
 * validator is partially applied with the flat key so the memoization key
 * (the validator function itself) is stable per table. */
const listValidators = new Map()
function jsonStringListValidator(key) {
  let validate = listValidators.get(key)
  if (!validate) {
    validate = (raw) => {
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
    listValidators.set(key, validate)
  }
  return validate
}

/** Memoized JSON-field parsing keyed by the validator function itself. Only
 * successful parses are cached — a failure propagates and is retried raw next
 * time (identical to the previous per-key cache blocks). */
const parseCaches = new WeakMap() // validate -> { raw, parsed }
export function parseJsonField(validate, raw) {
  const cache = parseCaches.get(validate)
  if (cache && cache.raw === raw) return cache.parsed
  const parsed = validate(raw)
  parseCaches.set(validate, { raw, parsed })
  return parsed
}

/**
 * Regroup the flat (volatile-unwrapped) config into the service's section
 * tree. Pure: no ctx, no events, no node: — the whitelist defaults read is
 * injected. Replicates the previous compute() layering exactly:
 * - JSON-in-string fields (categoryChains/agentChains/disabledCategories/
 *   lspServers/five robash lists) parse through the memoized validators, bad
 *   input throws (fails activation loud);
 * - robash list keys: unset or empty-string dropped; '[]' adds nothing and is
 *   dropped so consumers see ONE shape; a non-empty array becomes additions;
 * - robashDefaultsPath/defaultsReload configure the defaults read and never
 *   reach the section; the product defaults are published as plain arrays.
 * @param {object} config - raw row config (volatile refs allowed)
 * @param {{ readDefaults?: (path?: string) => { tables: object, source: object } }} [options]
 */
export function computeSections(config, { readDefaults } = {}) {
  const flat = flattenConfig(config)
  const sections = {}
  for (const key of Object.keys(SECTIONS)) {
    const fields = SECTIONS[key]
    const out = {}
    for (const [field, flatKey] of Object.entries(fields)) {
      if (Object.hasOwn(flat, flatKey)) out[field] = flat[flatKey]
    }
    if (key === 'delegate') {
      if (typeof out.categoryChains === 'string' && out.categoryChains.trim().length > 0) {
        out.categoryChains = parseJsonField(chainsValidator('delegateCategoryChains'), out.categoryChains)
      }
      // The two newer delegate keys normalize harder than legacy categoryChains
      // (whose 1.0 shape is kept): an empty string, an empty map, or an empty
      // array is dropped so consumers see ONE shape — present-and-non-empty or
      // absent. Bad JSON still fails activation loud, flat key named.
      if (typeof out.agentChains === 'string') {
        if (out.agentChains.trim().length === 0) {
          delete out.agentChains
        } else {
          const parsed = parseJsonField(chainsValidator('delegateAgentChains'), out.agentChains)
          if (Object.keys(parsed).length === 0) delete out.agentChains
          else out.agentChains = parsed
        }
      }
      if (typeof out.disabledCategories === 'string') {
        if (out.disabledCategories.trim().length === 0) {
          delete out.disabledCategories
        } else {
          const parsed = parseJsonField(jsonStringListValidator('delegateDisabledCategories'), out.disabledCategories)
          if (parsed.length === 0) delete out.disabledCategories
          else out.disabledCategories = parsed
        }
      }
    }
    if (key === 'lsp' && typeof out.servers === 'string' && out.servers.trim().length > 0) {
      out.servers = parseJsonField(validateLspServers, out.servers)
    }
    if (key === 'robash') {
      // Append semantics: an unset or empty-string list key is dropped so the
      // guard merges no additions; a present non-empty string parses into that
      // list's ADDITIONS — including '[]', which adds nothing. The product
      // defaults never come from here (a patch row can be replaced wholesale);
      // they are published below from the defaults file the plugin reads
      // itself. Bad JSON still fails activation loud.
      for (const [field, flatKey] of ROBASH_LIST_FIELDS) {
        if (typeof out[field] !== 'string') continue
        if (out[field].trim().length === 0) {
          delete out[field]
          continue
        }
        const parsed = parseJsonField(jsonStringListValidator(flatKey), out[field])
        // an explicitly empty array is a no-op addition, i.e. indistinguishable
        // from absent: drop it so the consumer has ONE shape to handle
        if (parsed.length === 0) {
          delete out[field]
          continue
        }
        out[field] = parsed
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
      if (readDefaults) {
        const read = readDefaults(path)
        out.defaults = read.tables
        out.defaultsSource = read.source
      }
    }
    if (Object.keys(out).length > 0) sections[key] = out
  }
  return sections
}
