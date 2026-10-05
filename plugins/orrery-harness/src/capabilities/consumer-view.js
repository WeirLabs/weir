// Task 7.1 of the session-capability-manager change: the unified skill
// consumer view. Every Orrery consumer of skill availability — the model
// catalog, the stock `skill` tool, slash candidates and submission, the
// delegate tool's load_skills and the intent-gate's skill pointers — consults
// the SAME preset-layer selection view. No consumer keeps its own
// authorization copy or stacks an extra filter: the selection provider's
// per-session candidates (selected + available + invocation flags) ARE the
// view; this module only intersects the flags with the caller's purpose
// ('model' vs 'user') and stamps stable reasons for denials.

/** The provider tag the selection provider stamps on its own candidates. */
export const SKILL_VIEW_PROVIDER = 'orrery-selected'

/** Denial reasons (stable, for audit and error text). */
export const SKILL_VIEW_REASONS = Object.freeze({
  notSelected: 'not-selected',
  notModelInvocable: 'not-model-invocable',
  notUserInvocable: 'not-user-invocable',
})

/**
 * @param {{ provider: { list(options: unknown): Promise<{ candidates?: unknown[], complete?: boolean }> } }} input
 */
export function createSkillConsumerView({ provider }) {
  /**
   * Conclude on several skill names with ONE provider list (one snapshot —
   * batch callers like the delegate preflight never observe mixed revisions).
   * @param {unknown} options - provider list options ({ cwd, scope })
   * @param {string[]} names
   * @param {'model'|'user'} [purpose]
   * @returns {Promise<Map<string, { name: string, selected: boolean, available: boolean, invocable: boolean, reason: string|null }>>}
   */
  async function conclusions(options, names, purpose = 'model') {
    const result = await provider.list(options)
    const byName = new Map()
    for (const candidate of result?.candidates ?? []) {
      const name = /** @type {{ name?: unknown }} */ (candidate)?.name
      if (typeof name === 'string' && !byName.has(name)) byName.set(name, candidate)
    }
    const out = new Map()
    for (const name of names) {
      const candidate = byName.get(name)
      const invocation = /** @type {{ modelInvocable?: unknown, userInvocable?: unknown }|undefined} */ (
        /** @type {{ invocation?: unknown }} */ (candidate)?.invocation
      )
      const selected = Boolean(
        candidate
        && /** @type {{ provider?: unknown }} */ (candidate).provider === SKILL_VIEW_PROVIDER
        && invocation,
      )
      const permitted = purpose === 'model' ? invocation?.modelInvocable === true : invocation?.userInvocable === true
      out.set(name, {
        name,
        selected,
        available: selected,
        invocable: selected && permitted,
        reason: !selected
          ? SKILL_VIEW_REASONS.notSelected
          : permitted
            ? null
            : purpose === 'model' ? SKILL_VIEW_REASONS.notModelInvocable : SKILL_VIEW_REASONS.notUserInvocable,
      })
    }
    return out
  }

  /**
   * One-name convenience for the pointer/delegate gates.
   * @param {unknown} options @param {string} name @param {'model'|'user'} [purpose]
   */
  async function conclusion(options, name, purpose = 'model') {
    return (await conclusions(options, [name], purpose)).get(name)
  }

  return { conclusions, conclusion }
}
