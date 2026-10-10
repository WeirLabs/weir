// Context pressure evaluation — pure core.
// pressure = measured total tokens / active route context window.
// Soft threshold: one advisory per crossing (hysteresis). Hard threshold:
// force one compaction at the turn boundary.

export const PRESSURE_DEFAULTS = {
  enabled: true,
  softThreshold: 0.72,
  hardThreshold: 0.88,
}

/** Validate the live guard policy before any measurement or saved config lands. */
export function guardOptions(options = {}) {
  const value = { ...PRESSURE_DEFAULTS, ...options }
  if (!Number.isFinite(value.softThreshold) || !Number.isFinite(value.hardThreshold) || !(0 < value.softThreshold && value.softThreshold < value.hardThreshold && value.hardThreshold < 1)) {
    throw new Error('guardSoftThreshold and guardHardThreshold require finite values with 0 < soft < hard < 1')
  }
  return value
}

/**
 * @param {number | undefined} totalTokens
 * @param {number | undefined} contextWindow
 * @returns {number | undefined} the pressure ratio, or undefined when unknown
 */
export function computePressure(totalTokens, contextWindow) {
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens)) return undefined
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  return totalTokens / contextWindow
}

/**
 * @param {Partial<typeof PRESSURE_DEFAULTS>} options
 */
export function createPressureState(options = {}) {
  const opts = guardOptions(options)
  const state = {
    advised: false,
    forced: false,
  }
  return {
    get advised() {
      return state.advised
    },
    /** Reset hysteresis after a compaction (or an explicit reset). */
    reset() {
      state.advised = false
      state.forced = false
    },
    /**
     * Evaluate one pressure reading at a boundary.
     * @param {number | undefined} pressure
     * @param {'step' | 'turn'} boundary - step boundaries advise; only turn
     *   boundaries request maintenance (the agent is still running there).
     * @returns {{ kind: 'advise' | 'force' | 'none' }}
     */
    evaluate(pressure, boundary = 'turn') {
      if (!opts.enabled || pressure === undefined) return { kind: 'none' }
      if (pressure < opts.softThreshold) {
        state.advised = false
        state.forced = false
        return { kind: 'none' }
      }
      if (pressure >= opts.hardThreshold) {
        if (boundary === 'turn') {
          if (state.forced) return { kind: 'none' }
          state.forced = true
          state.advised = true
          return { kind: 'force' }
        }
        // Mid-turn over the hard threshold: advise once, force at the turn.
        if (state.advised) return { kind: 'none' }
        state.advised = true
        return { kind: 'advise' }
      }
      if (state.advised) return { kind: 'none' }
      state.advised = true
      return { kind: 'advise' }
    },
  }
}

/** English advisory template; the percentage is computed content. */
export function renderAdvisory(pressure) {
  const percent = Math.round(pressure * 100)
  return `<context_pressure>
Context pressure is at ${percent}%. Finish the current subtask and persist key state (plan, findings, evidence paths), then request compact_context. Queued is not completed: only a confirmed native summary permits summary-based continuation. If maintenance is busy or another wake wins, the request is blocked without background retry; genuine user input is needed before a new request. Native automatic compaction may occur independently.
</context_pressure>`
}

/** English continuation template injected after a successful compaction. */
export const RESUME_AFTER_COMPACTION = `<context_pressure>
Compaction completed. Resume the task from the compaction summary and the durable state (todos, plan files, evidence); do not restart completed work. Continue until the goal is actually done.
</context_pressure>`
