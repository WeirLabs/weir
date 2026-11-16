// Strict text-JSON parser for evaluator output. Runtime failures stay distinct.
import { ATTEMPT_OUTCOMES, DecisionContractError, parseAnswerItem, RETURN_CODES } from '../contracts.js'
import { extractJsonObject } from '../json.js'

const TOP_LEVEL = ['outcome', 'reasonCode', 'hint', 'claims', 'answers', 'missing', 'suggestion']

/**
 * @param {unknown} text @param {{evidenceIds?:string[],finishReason?:string}} [context]
 */
export function parseDecision(text, context = {}) {
  if (['timeout', 'model_error', 'truncated', 'aborted', 'interrupted', 'route_unavailable'].includes(context.finishReason ?? '')) {
    return failureOutcome(context.finishReason)
  }
  if (typeof text !== 'string') return invalid('Evaluator output must be text JSON')
  // Fences, surrounding prose and leading/trailing whitespace come from the
  // shared extractor; a mid-object stop is a truncation, never invalid output.
  const extracted = extractJsonObject(text)
  if (extracted.status === 'empty') return invalid('Evaluator output contains no JSON object')
  if (extracted.status === 'truncated') return failureOutcome('truncated')
  if (extracted.status === 'invalid') return invalid('Evaluator output is not valid JSON')
  try {
    return validate(extracted.value, new Set(context.evidenceIds ?? []))
  } catch (error) {
    if (error instanceof DecisionContractError) return invalid(error.message)
    throw error
  }
}

/** @param {string} kind @param {string} [code] */
export function failureOutcome(kind, code) {
  const allowed = ['timeout', 'model_error', 'invalid_output', 'truncated', 'aborted', 'interrupted', 'route_unavailable']
  const normalized = allowed.includes(kind) ? kind : 'model_error'
  return {
    outcome: 'failed',
    error: {
      kind: normalized,
      ...(code ? { code: String(code).slice(0, 100) } : {}),
      detail: failureDetail(normalized),
    },
  }
}

/** @param {string} detail */
function invalid(detail) {
  return { outcome: 'failed', error: { kind: 'invalid_output', detail: detail.slice(0, 200) } }
}

/** @param {any} value @param {Set<string>} evidenceIds */
function validate(value, evidenceIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecisionContractError('INVALID_OUTPUT', 'top level must be an object')
  for (const key of Object.keys(value)) if (!TOP_LEVEL.includes(key)) throw new DecisionContractError('UNKNOWN_FIELD', `unknown top-level field: ${key}`)
  if (!['answer', 'return', 'escalate'].includes(value.outcome) || !ATTEMPT_OUTCOMES.includes(value.outcome)) {
    throw new DecisionContractError('INVALID_OUTCOME', 'outcome must be answer, return, or escalate')
  }
  const result = { outcome: value.outcome }
  if (value.outcome === 'return') {
    if (!RETURN_CODES.includes(value.reasonCode)) throw new DecisionContractError('INVALID_RETURN_CODE', 'return requires a known reasonCode')
    if (typeof value.hint !== 'string' || !value.hint.trim() || value.hint.length > 400) throw new DecisionContractError('INVALID_HINT', 'return hint must contain 1..400 characters')
    result.reasonCode = value.reasonCode
    result.hint = value.hint
  }
  if (value.outcome === 'answer') {
    if (!Array.isArray(value.claims) || value.claims.length < 1 || value.claims.length > 32) throw new DecisionContractError('INVALID_CLAIMS', 'answer requires 1..32 claims')
    result.claims = value.claims.map(validateClaim)
    for (const claim of result.claims) {
      if (claim.evidenceIds.some(id => !evidenceIds.has(id))) throw new DecisionContractError('UNKNOWN_EVIDENCE', 'claims may cite only evidenceIds in this pack')
    }
    if (!Array.isArray(value.answers) || value.answers.length > 16) throw new DecisionContractError('INVALID_ANSWERS', 'answer requires an answers array of at most 16 items')
    result.answers = value.answers.map(parseAnswerItem)
  }
  if (value.missing !== undefined) {
    if (!Array.isArray(value.missing) || value.missing.length > 16 || value.missing.some(item => typeof item !== 'string' || !item || item.length > 400)) {
      throw new DecisionContractError('INVALID_MISSING', 'missing must contain at most 16 non-empty strings')
    }
    result.missing = [...value.missing]
  }
  if (value.suggestion !== undefined) {
    if (!Array.isArray(value.suggestion) || value.suggestion.length > 16) throw new DecisionContractError('INVALID_SUGGESTION', 'suggestion must contain at most 16 answer items')
    result.suggestion = value.suggestion.map(parseAnswerItem)
  }
  return result
}

/** @param {any} value */
function validateClaim(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecisionContractError('INVALID_CLAIM', 'claim must be an object')
  for (const key of Object.keys(value)) if (!['text', 'evidenceIds'].includes(key)) throw new DecisionContractError('UNKNOWN_FIELD', `unknown claim field: ${key}`)
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4000) throw new DecisionContractError('INVALID_CLAIM', 'claim text must contain 1..4000 characters')
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length > 8 || value.evidenceIds.some(id => typeof id !== 'string' || !id)) {
    throw new DecisionContractError('INVALID_CLAIM', 'each claim allows at most 8 evidenceIds; G1 requires a citation')
  }
  return { text: value.text, evidenceIds: [...value.evidenceIds] }
}

/** @param {string} kind */
function failureDetail(kind) {
  return ({
    timeout: 'Evaluator exceeded the Attempt deadline',
    model_error: 'The configured evaluator model failed',
    invalid_output: 'Evaluator output failed strict contract validation',
    truncated: 'Evaluator output was truncated',
    aborted: 'Evaluator Attempt was aborted',
    interrupted: 'Evaluator Attempt was interrupted',
    route_unavailable: 'The configured evaluator route is unavailable',
  })[kind]
}
