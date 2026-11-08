// Decision audit projection: no question, evidence, profile, or answer bodies.
import { AUDIT_SUBTYPES, AUDIT_TYPES, createAudit } from '../shared/audit.js'

const ID_FIELDS = new Set(['caseId', 'attemptId', 'feedbackId', 'agentId', 'routeDecisionId', 'rootSessionId', 'originSessionId'])
const ENUM_FIELDS = new Set(['kind', 'action', 'state', 'closing', 'outcome', 'awaitingReason', 'failureKind', 'reason', 'code', 'from', 'target', 'mode', 'entry', 'rejected'])
const COUNT_FIELDS = new Set(['revision', 'attemptCount', 'answerCount', 'interruptedAttempts', 'recoveredCases', 'durationMs', 'at'])
const FLAG_FIELDS = new Set(['available', 'enabled', 'needsReview', 'ok', 'explicit'])

/** @param {Record<string,unknown>} payload */
export function decisionAuditPayload(payload) {
  const result = {}
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (ID_FIELDS.has(key) && typeof value === 'string') result[key] = value.slice(0, 200)
    else if (ENUM_FIELDS.has(key) && typeof value === 'string') result[key] = value.slice(0, 200)
    else if (COUNT_FIELDS.has(key) && Number.isFinite(value)) result[key] = value
    else if (FLAG_FIELDS.has(key) && typeof value === 'boolean') result[key] = value
  }
  return result
}

/** @param {any} ctx @param {{root?:string}} [options] */
export function createDecisionAudit(ctx, options = {}) {
  const audit = createAudit(ctx)
  return (kind, payload) => {
    if (!AUDIT_SUBTYPES.decision.includes(kind)) return
    const data = decisionAuditPayload(payload)
    const agent = ctx?.agents?.get?.(data.rootSessionId) ?? ctx?.agents?.getById?.(data.rootSessionId)
    const session = agent?.session ?? (options.root ? { id: data.rootSessionId ?? null, header: { cwd: options.root } } : null)
    audit(session, `${AUDIT_TYPES.decision}/${kind}`, data, options)
  }
}
