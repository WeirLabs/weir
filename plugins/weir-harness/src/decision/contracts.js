// Shared, versioned Decision Agent contracts. Pure JS: no runtime dependencies.

export const DECISION_SCHEMA_VERSION = 1
export const PROMPT_VERSION = 'evaluator-contract/2'
export const EVALUATOR_VERSION = 'sidecar/1'

export const RETURN_CODES = Object.freeze([
  'INVALID_PREMISE', 'MISSING_CONTEXT', 'OUT_OF_SCOPE',
  'CONFLICTING_EVIDENCE', 'STALE_EVIDENCE', 'UNSUPPORTED_OPTIONS',
])
export const ATTEMPT_OUTCOMES = Object.freeze(['answer', 'return', 'escalate', 'failed'])
export const CASE_STATES = Object.freeze(['received', 'evaluating', 'awaiting_revision', 'awaiting_user', 'closed'])
export const CASE_CLOSINGS = Object.freeze(['answered', 'returned', 'escalated', 'cancelled'])
export const AWAITING_REASONS = Object.freeze([
  'no_route', 'route_ambiguous', 'exhausted', 'evidence', 'authority',
  'partial_batch', 'interrupted', 'consult_escalate',
])
export const FEEDBACK_KINDS = Object.freeze([
  'rating_up', 'rating_down', 'undo_rating_up', 'undo_rating_down', 'comment', 'correction',
])
export const EVIDENCE_SOURCES = Object.freeze([
  'user_decision', 'user_correction', 'user_profile', 'agent_record', 'repo_doc', 'current_observation',
])
export const EVIDENCE_STATUSES = Object.freeze(['active', 'superseded', 'deleted'])
export const ROUTE_MODES = Object.freeze(['pinned', 'explicit', 'manual_reassign', 'none'])
export const OMISSION_CODES = Object.freeze([
  'L5_EVIDENCE_TRUNCATED', 'L5_EVIDENCE_OMITTED', 'L5_EXCERPT_OMITTED', 'L4_TRUNCATED',
  'L3_EPISODE_OMITTED', 'L3_EPISODE_TRUNCATED',
  'L2_PRINCIPLE_OMITTED', 'L2_PRINCIPLE_TRUNCATED',
])
export const ATTEMPT_FAILURES = Object.freeze([
  'timeout', 'model_error', 'invalid_output', 'truncated', 'aborted', 'interrupted', 'route_unavailable',
])

export class DecisionContractError extends Error {
  /** @param {string} code @param {string} detail */
  constructor(code, detail) {
    super(`${code}: ${detail}`)
    this.name = 'DecisionContractError'
    this.code = code
  }
}
export function assertSupportedSchemaVersion(value, kind) {
  if (value !== DECISION_SCHEMA_VERSION) throw new DecisionContractError('UNSUPPORTED_SCHEMA_VERSION', `${kind} schema version ${value} is not supported`)
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} label @returns {string} */
export function assertEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new DecisionContractError('INVALID_ENUM', `${label} must be one of ${allowed.join('|')}`)
  }
  return value
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
export function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DecisionContractError('INVALID_OBJECT', `${label} must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {unknown} value @param {readonly string[]} allowed @param {readonly string[]} required @param {string} label */
export function assertClosedObject(value, allowed, required, label) {
  const object = assertObject(value, label)
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new DecisionContractError('UNKNOWN_FIELD', `${label}.${key} is not allowed`)
  }
  for (const key of required) {
    if (object[key] === undefined) throw new DecisionContractError('MISSING_FIELD', `${label}.${key} is required`)
  }
  return object
}

/** @param {unknown} value @param {string} label @returns {string} */
export function assertText(value, label, max = 400) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new DecisionContractError('INVALID_TEXT', `${label} must contain 1..${max} characters`)
  }
  return value
}

/** @param {unknown} value @returns {string} */
export function canonicalJson(value) {
  return JSON.stringify(canonical(value))
}

/** @param {unknown} value @returns {unknown} */
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DecisionContractError('NON_FINITE_NUMBER', 'canonical JSON cannot contain NaN or Infinity')
    return value
  }
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const result = {}
    for (const key of Object.keys(value).sort()) {
      const item = /** @type {Record<string, unknown>} */ (value)[key]
      if (item !== undefined) result[key] = canonical(item)
    }
    return result
  }
  throw new DecisionContractError('NON_JSON_VALUE', `unsupported canonical value type ${typeof value}`)
}


/** @param {unknown} value @returns {import('./contracts.js').AnswerItem} */
export function parseAnswerItem(value) {
  const item = assertClosedObject(value, ['id', 'selected', 'custom'], ['id', 'selected'], 'answer')
  const id = assertText(item.id, 'answer.id', 200)
  if (!Array.isArray(item.selected) || !item.selected.every(entry => typeof entry === 'string')) {
    throw new DecisionContractError('INVALID_ANSWER', 'answer.selected must be a string array')
  }
  const custom = item.custom === undefined ? undefined : assertText(item.custom, 'answer.custom', 4000)
  return { id, selected: [...item.selected], ...(custom === undefined ? {} : { custom }) }
}

/** @param {unknown} value @returns {import('./contracts.js').AnswerItem[]} */
export function parseAnswerBatch(value) {
  const object = assertClosedObject(value, ['answers'], ['answers'], 'answerBatch')
  if (!Array.isArray(object.answers) || object.answers.length > 16) {
    throw new DecisionContractError('INVALID_ANSWER_BATCH', 'answers must be an array of at most 16 items')
  }
  return object.answers.map(parseAnswerItem)
}

/** @typedef {{ id: string, selected: string[], custom?: string }} AnswerItem */
