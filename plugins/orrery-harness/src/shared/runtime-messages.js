// Shared runtime message adaptation helpers for orrery plugins: genuine-user
// classification, settings overlay merging, and warn-swallowing injection
// wrappers. Plain ESM, ctx-only — no static @deepseek-ai/* imports, and NEVER
// session.append (the cold-read red line; audit lives in src/shared/audit.js).

/**
 * Classify whether a message object or a `user/message` session event is
 * genuine user input. Only source.kind 'user' counts; every runtime-injected
 * message (producer-tagged source) is exempt. The event form is strictly
 * gated by type === 'user/message' — any other event type returns false, even
 * when its data carries a user-looking source. Role filtering stays with the
 * callers (batch-scan semantics differ per plugin); this function only judges
 * the source kind.
 *
 * @param {object} messageOrEvent - a UserMessage-shaped object or a session/event event
 * @returns {boolean}
 */
export function isGenuineUserMessage(messageOrEvent) {
  if (!messageOrEvent || typeof messageOrEvent !== 'object') return false
  const type = messageOrEvent.type
  if (type !== undefined) {
    // Event form: strictly gated — only user/message events can qualify.
    return type === 'user/message' && messageOrEvent.data?.source?.kind === 'user'
  }
  return messageOrEvent.source?.kind === 'user'
}

/**
 * Merge the plugin's settings overlay: the orrerySettings section wins over
 * the inline config; options.defaults sit underneath both. An absent service
 * or a non-object section is a no-op. options.nestKeys declares flat overlay
 * keys that map into a nested sub-object (intent-gate's jev* keys): declared
 * keys are removed from the flat merge and, when defined, merge into the
 * existing config[subKey] (undefined never overrides).
 *
 * @param {object} ctx - plugin context (reads the orrerySettings service)
 * @param {string} section - settings section name, e.g. 'intentGate'
 * @param {object} config - inline plugin config
 * @param {object} [options]
 * @param {object} [options.defaults] - defaults underneath the inline config
 * @param {Object<string, Object<string, string>>} [options.nestKeys] - { subKey: { nestedKey: overlayKey } }
 * @returns {object} the merged config (a fresh object; inputs are not mutated)
 */
export function overlayConfig(ctx, section, config, options = {}) {
  const { defaults, nestKeys } = options
  const base = { ...defaults, ...config }
  const override = ctx.get?.('orrerySettings')?.get(section)
  if (!override || typeof override !== 'object') return base
  const rest = { ...override }
  /** @type {Object<string, Object<string, unknown>>} */
  const nested = {}
  if (nestKeys) {
    for (const [subKey, mapping] of Object.entries(nestKeys)) {
      for (const [nestedKey, overlayKey] of Object.entries(mapping)) {
        delete rest[overlayKey]
        const value = override[overlayKey]
        if (value === undefined) continue
        nested[subKey] = { ...nested[subKey], [nestedKey]: value }
      }
    }
  }
  const result = { ...base, ...rest }
  for (const [subKey, values] of Object.entries(nested)) {
    result[subKey] = { ...(result[subKey] ?? {}), ...values }
  }
  return result
}

/**
 * Run an injection (steer/followup/inject) with uniform failure semantics: a
 * throw is swallowed and logged through ctx.logger.warn, never breaking the
 * current turn. The caller passes the warn prefix verbatim (existing wording
 * is pinned by plugin tests); this module appends the error summary.
 *
 * @param {object} ctx - plugin context (ctx.logger)
 * @param {string} message - full warn prefix, e.g. `todo-driver: could not steer continuation for "${id}"`
 * @param {() => unknown} fn - the injection call
 * @returns {unknown} fn()'s result, or undefined when it threw
 */
export function injectOrWarn(ctx, message, fn) {
  try {
    return fn()
  } catch (error) {
    ctx.logger?.warn?.(`${message}: ${error?.message ?? error}`)
    return undefined
  }
}
