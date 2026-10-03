// Notification text composition: pure. Templates are English (template-layer
// discipline); the instance content they embed — the session title, the
// question, the failure message — is passed through verbatim and so follows
// the session language.

/** Platform toasts truncate long text anyway; keep what we hand over short. */
const MAX_BODY = 160
const MAX_FRAGMENT = 90

/**
 * Collapse whitespace/control characters and truncate on a code-point
 * boundary. Notification centers render newlines unevenly, and a title that
 * starts with a dash must never look like a CLI option to a delivery tool.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function clean(value, max) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  const points = Array.from(flat)
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : flat
}

/**
 * Human-readable duration: `45s`, `2m 10s`, `1h 5m`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    const seconds = total % 60
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/**
 * @typedef {{ title: string, body: string, urgent: boolean }} Note
 *
 * @typedef {(
 *   { type: 'completed', durationMs?: number } |
 *   { type: 'failed', detail?: string } |
 *   { type: 'stopped', detail?: string } |
 *   { type: 'approval', toolName?: string } |
 *   { type: 'question', question?: string } |
 *   { type: 'plan' }
 * )} NoteSpec
 */

/**
 * Compose one notification. `label` is the session title (or the workspace
 * name when the session is untitled).
 *
 * @param {NoteSpec} spec
 * @param {string} label
 * @returns {Note}
 */
export function compose(spec, label) {
  const session = clean(label, MAX_FRAGMENT)
  /** @param {string} detail */
  const withSession = (detail) => clean(session.length > 0 ? `${session} — ${detail}` : detail, MAX_BODY)
  switch (spec.type) {
    case 'completed': {
      const took = spec.durationMs === undefined ? '' : ` in ${formatDuration(spec.durationMs)}`
      return { title: 'Task finished', body: withSession(`finished${took}`), urgent: false }
    }
    case 'failed': {
      const detail = clean(spec.detail, MAX_FRAGMENT)
      return { title: 'Task failed', body: withSession(detail.length > 0 ? detail : 'the model request failed'), urgent: true }
    }
    case 'stopped': {
      const why =
        spec.detail === 'max-tokens' ? 'reached the output limit'
        : spec.detail === 'hook' ? 'stopped by a hook'
        : 'stopped and needs your input'
      return { title: 'Task stopped', body: withSession(why), urgent: true }
    }
    case 'approval': {
      const tool = clean(spec.toolName, 40)
      return { title: 'Approval needed', body: withSession(tool.length > 0 ? `wants to use ${tool}` : 'waiting for your approval'), urgent: true }
    }
    case 'question': {
      const question = clean(spec.question, MAX_FRAGMENT)
      return { title: 'Question for you', body: withSession(question.length > 0 ? question : 'waiting for your answer'), urgent: true }
    }
    case 'plan':
      return { title: 'Plan ready for review', body: withSession('waiting for your decision'), urgent: true }
  }
}
