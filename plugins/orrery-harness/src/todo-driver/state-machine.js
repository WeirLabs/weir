// Todo continuation state machine — pure core, one instance per session.
//
// Two decision points:
// - decideAtTurnStopping (the sanctioned boundary: a listener steers and the
//   machine runs another step) — the normal completed-turn continuation.
// - decideTurnEnd (bookkeeping from the durable turn/end reason) — user-abort
//   disarm and the provider-error delayed, counted retry path.
// User input always rearms and resets every counter.

export const PROVIDER_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED',
  'RATE_LIMIT', 'RATE_LIMITED', 'OVERLOADED', 'UNAVAILABLE', 'TIMEOUT',
])

/** Classify an LlmFailure as a transient provider/network error. */
export function isProviderError(failure) {
  if (!failure || typeof failure !== 'object') return false
  const status = failure.status
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true
  const code = typeof failure.code === 'string' ? failure.code : ''
  if (PROVIDER_ERROR_CODES.has(code)) return true
  const message = typeof failure.message === 'string' ? failure.message.toLowerCase() : ''
  return /\b(429|5\d\d|overloaded|rate limit|timed? ?out|timeout|connection|network|econnreset|etimedout)\b/.test(message)
}

/** Backoff for the n-th (1-based) consecutive provider error: 30s doubling, 5min cap. */
export function backoffDelay(errorStreak, baseMs = 30_000, capMs = 300_000) {
  const exponent = Math.max(0, errorStreak - 1)
  return Math.min(baseMs * 2 ** exponent, capMs)
}

export const DEFAULTS = {
  enabled: true,
  maxConsecutive: 8,
  errorRetryMax: 5,
  errorBackoffBaseMs: 30_000,
  errorBackoffCapMs: 300_000,
}

/**
 * @param {Partial<typeof DEFAULTS>} options
 */
export function createContinuationState(options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const state = {
    armed: true,
    consecutive: 0,
    errorStreak: 0,
    /** @type {string | null} */
    stopReason: null,
  }
  return {
    get armed() {
      return state.armed
    },
    get consecutive() {
      return state.consecutive
    },
    get errorStreak() {
      return state.errorStreak
    },
    get stopReason() {
      return state.stopReason
    },

    /** A fresh user message rearms and resets everything. */
    onUserMessage() {
      state.armed = true
      state.consecutive = 0
      state.errorStreak = 0
      state.stopReason = null
    },

    /** The model's escape hatch: disarm with a recorded reason. */
    onStopContinuation(reason) {
      state.armed = false
      state.stopReason = typeof reason === 'string' && reason.length > 0 ? reason : 'unspecified'
    },

    /**
     * Decide at the turn-stopping boundary (the sanctioned continuation point:
     * a listener steers and the machine runs another step).
     * @param {{ todosRemain: boolean, aborted: boolean, abortCauseKind?: string,
     *   providerErrorPending: boolean }} input
     * @returns {{ kind: 'continue' } | { kind: 'none' }}
     */
    decideAtTurnStopping(input) {
      if (!opts.enabled || !state.armed) return { kind: 'none' }
      if (input.aborted) {
        // A user interrupt disarms; other abort causes leave the state alone.
        if (input.abortCauseKind === 'user') {
          state.armed = false
          state.stopReason = 'user interrupt'
        }
        return { kind: 'none' }
      }
      // The provider-error path owns its own delayed, counted retry — never
      // steer a fresh continuation in the same closing turn.
      if (input.providerErrorPending) return { kind: 'none' }
      if (!input.todosRemain) return { kind: 'none' }
      if (state.consecutive >= opts.maxConsecutive) return { kind: 'none' }
      state.consecutive += 1
      return { kind: 'continue' }
    },

    /**
     * Bookkeeping for one ended turn (durable turn/end reason).
     * @param {any} reason - TurnEndReason from the durable turn/end event
     * @param {boolean} todosRemain
     * @returns {{ kind: 'continue', delayMs: number }
     *   | { kind: 'blocked', notice: string }
     *   | { kind: 'none' }}
     */
    decideTurnEnd(reason, todosRemain) {
      if (!opts.enabled) return { kind: 'none' }
      if (!reason || typeof reason !== 'object') return { kind: 'none' }

      if (reason.kind === 'completed') {
        // A healthy turn resets the provider-error streak. Continuation on
        // completed turns is owned by the turn-stopping boundary, not here.
        state.errorStreak = 0
        return { kind: 'none' }
      }

      if (reason.kind === 'aborted') {
        const cause = reason.reason
        if (cause && cause.kind === 'user') {
          state.armed = false
          state.stopReason = 'user interrupt'
        }
        return { kind: 'none' }
      }

      if (!state.armed) return { kind: 'none' }

      if (reason.kind === 'error') {
        if (!todosRemain) return { kind: 'none' }
        if (!isProviderError(reason.error)) return { kind: 'none' }
        if (state.errorStreak >= opts.errorRetryMax) {
          state.armed = false
          return {
            kind: 'blocked',
            notice: `Continuation stopped after ${state.errorStreak} consecutive provider errors (${reason.error?.code ?? reason.error?.status ?? 'unknown'}). The todo list remains unfinished.`,
          }
        }
        state.errorStreak += 1
        state.consecutive += 1
        return { kind: 'continue', delayMs: backoffDelay(state.errorStreak, opts.errorBackoffBaseMs, opts.errorBackoffCapMs) }
      }

      // blocked / max-tokens / interrupted / forked and unknown kinds never continue.
      return { kind: 'none' }
    },
  }
}

/** The English continuation template; todo item text stays in its original language. */
export function renderContinuation(remaining) {
  const lines = remaining.map((todo) => `- ${todo}`).join('\n')
  return `<todo_continuation>
The todo list still has unfinished items:
${lines}

Continue working through them now. If one is genuinely blocked, call stop_continuation with the reason instead of idling.
</todo_continuation>`
}
