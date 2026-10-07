// Notification policy: pure decisions about WHICH session state changes are
// worth a system notification. No ctx, no node: imports — the event wiring
// lives in ./index.js, the platform delivery in ./notifier.js. Classification
// follows the discipline for turn state: only the durable `turn/end` reason
// decides how a turn ended (completed / aborted / error / ...), never a
// heuristic.

/**
 * Module defaults; the weirSettings `notify` section and the row config
 * layer over them (module defaults ← row config ← settings service).
 * `settleMs` and `coalesceMs` are code-level tuning knobs, not settings keys.
 */
export const DEFAULTS = Object.freeze({
  /** Master switch. */
  enabled: true,
  /** Report a finished turn (completion status). */
  onComplete: true,
  /** Report states that need the user: approval, question, plan review, failure, stop. */
  onAttention: true,
  /** A completion is only reported when the turn ran at least this long (seconds). */
  minTurnSeconds: 15,
  /** Play the platform's notification sound where the platform supports it. */
  sound: true,
  /** DSH window in the foreground: 'skip' stays quiet (default), 'always' notifies anyway. */
  foreground: 'skip',
  /** A finished turn is held this long; the agent running again cancels it. */
  settleMs: 1500,
  /** Same session + same kind inside this window collapses into one notification. */
  coalesceMs: 3000,
})

/** Tools whose call means the agent is waiting for a human answer. */
export const ATTENTION_TOOLS = Object.freeze({
  ask_user_question: 'question',
  exit_plan_mode: 'plan',
})

/**
 * @typedef {{ kind: 'completed' | 'failed' | 'stopped' | 'none', detail?: string }} TurnOutcome
 */

/**
 * Classify a durable `turn/end` reason for notification purposes.
 *
 * - `completed` → the turn finished normally.
 * - `error` → the turn failed (detail = the failure message).
 * - `blocked` / `max-tokens` / a hook abort → the turn stopped and nobody
 *   is going to resume it by itself.
 * - a user abort, parent/disposed cancellation, `interrupted`, `forked`, and
 *   anything unknown → no notification (the user caused it, or the runtime
 *   is tearing the session down).
 *
 * @param {any} reason - the `turn/end` event's `data.reason`
 * @returns {TurnOutcome}
 */
export function classifyTurnEnd(reason) {
  switch (reason?.kind) {
    case 'completed':
      return { kind: 'completed' }
    case 'error': {
      const message = reason.error?.message
      return typeof message === 'string' && message.length > 0 ? { kind: 'failed', detail: message } : { kind: 'failed' }
    }
    case 'blocked':
      return { kind: 'stopped', detail: 'blocked' }
    case 'max-tokens':
      return { kind: 'stopped', detail: 'max-tokens' }
    case 'aborted':
      return reason.reason?.kind === 'hook' ? { kind: 'stopped', detail: 'hook' } : { kind: 'none' }
    default:
      return { kind: 'none' }
  }
}

/**
 * Whether a session is a delegated child: its completion reaches the parent
 * through the job notification, so only the top-level session reports.
 *
 * @param {any} session
 * @returns {boolean}
 */
export function isChildSession(session) {
  const header = session?.header
  return header?.origin === 'subagent' || typeof header?.parentSession === 'string'
}

/**
 * Describe a `tool/call` event when the tool waits for a human answer.
 *
 * @param {string} toolName
 * @param {string} argumentsJson - the raw `arguments` string of the event
 * @returns {{ kind: 'question' | 'plan', question?: string } | undefined}
 */
export function attentionOfToolCall(toolName, argumentsJson) {
  const kind = /** @type {Record<string, 'question' | 'plan'>} */ (ATTENTION_TOOLS)[toolName]
  if (kind === undefined) return undefined
  if (kind === 'plan') return { kind }
  try {
    const parsed = JSON.parse(argumentsJson)
    const question = parsed?.questions?.[0]?.question
    return typeof question === 'string' && question.trim().length > 0 ? { kind, question: question.trim() } : { kind }
  } catch {
    return { kind }
  }
}

/**
 * Time-window de-duplication keyed by an arbitrary string. A key seen inside
 * the window is dropped; the window restarts only from an ACCEPTED hit, so a
 * steady stream of events still gets through once per window.
 *
 * @param {number} windowMs
 * @param {() => number} [now]
 * @returns {{ accept(key: string): boolean, clear(): void }}
 */
export function createCoalescer(windowMs, now = Date.now) {
  /** @type {Map<string, number>} */
  const last = new Map()
  return {
    accept(key) {
      const at = now()
      const previous = last.get(key)
      if (previous !== undefined && at - previous < windowMs) return false
      last.set(key, at)
      // Bound the map: entries older than the window can never suppress again.
      if (last.size > 256) {
        for (const [entry, time] of last) if (at - time >= windowMs) last.delete(entry)
      }
      return true
    },
    clear() {
      last.clear()
    },
  }
}
