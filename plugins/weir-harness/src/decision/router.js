// Broker-private Auto candidate routing. This module never enters the domain
// Attempt/retrieval pipeline or reads its memory.
import { ROUTER_CONTRACT } from './contracts.js'
import { extractJsonObject } from './json.js'
import { profileScopeCovers } from './scope.js'
import { resolveDecisionModelRoute, streamDecision } from './evaluator/sidecar.js'

// The router verdict is one tiny closed JSON object, yet the caller model shares
// a single maxTokens budget between its reasoning and that text. A budget tuned
// for a domain Attempt (the Desktop profile runs 1600) truncates the verdict
// before its closing brace, so a sidecar keeps its own floor and a truncated
// verdict gets exactly one wider retry before failing closed. Domain Attempts
// keep using the configured value untouched.
const SIDECAR_MIN_OUTPUT_TOKENS = 4096
const SIDECAR_RETRY_MAX_OUTPUT_TOKENS = 16384
const TRUNCATION_FAILURE = 'failure:truncated'
const INVALID_OUTPUT_FAILURE = 'failure:invalid_output'
// One bounded repair instruction: appended to the same pack when the first
// verdict is unusable. Fences and prose are already tolerated, so this asks for
// the canonical shape only, in English like every other template layer.
const REPAIR_INSTRUCTION = 'Return only the verdict JSON object. Do not add explanations or code fences.'

const ROUTER_SYSTEM = `Auto candidate router contract: router-contract/1
Choose only an eligible supplied candidate, no route, or a substantive ambiguity. Return one JSON object in one of these shapes:
{"contract":"router-contract/1","outcome":"selected","agentId":"eligible id","reason":"short reason"}
{"contract":"router-contract/1","outcome":"none","reason":"short reason"}
{"contract":"router-contract/1","outcome":"ambiguous","reason":"short reason","ambiguity":{"candidates":["eligible id"],"conflict":"short conflict"}}
Do not answer the questions, add fields, estimate confidence, change scope, or use unstated context.`

/**
 * Deterministic Auto prefilter over the whole profile: every enabled,
 * non-archived assistant whose optional paths/tags hints admit the request.
 * Workspace membership is not part of an identity, so it never filters this
 * list; a request with no eligible assistant simply routes nowhere.
 * @param {{request:any,scope:any,profiles:any[]}} input
 */
export function planAutoRoute(input) {
  const eligible = []
  const candidates = []
  const profiles = (Array.isArray(input.profiles) ? input.profiles : [])
    .filter(profile => typeof profile?.agentId === 'string' && profile.agentId && profile.state !== 'archived')
    .sort((left, right) => left.agentId.localeCompare(right.agentId))
  for (const profile of profiles) {
    const enabled = profile.state === 'enabled'
    let rejectedBecause
    if (!enabled) rejectedBecause = 'disabled'
    else if (!profileScopeCovers(profile.scope, input.scope)) rejectedBecause = 'scope'
    candidates.push({ agentId: profile.agentId, enabled, ...(rejectedBecause ? { rejectedBecause } : {}) })
    if (!rejectedBecause) eligible.push(profile)
  }
  return { candidates, eligible }
}

/**
 * Zero eligible candidates route nowhere without a model call, exactly one is a
 * deterministic selection, and only a real choice reaches the bounded Router.
 * @param {{request:any,scope:any,profiles:any[],sessionRoute?:any,signal?:AbortSignal,llm:any,contextBudgetTokens:number,timeoutMs:number,maxOutputTokens:number,singleShot?:boolean}} input
 */
export async function routeAuto(input) {
  const { candidates, eligible } = planAutoRoute(input)
  if (eligible.length === 0) return { kind: 'none', candidates, reason: 'none:no_candidates' }
  if (eligible.length === 1) return { kind: 'selected', candidates, chosen: eligible[0].agentId, reason: 'deterministic:single_candidate' }
  if (eligible.length > 32) return { kind: 'failed', candidates, reason: 'failure:candidate_limit' }

  const pack = makePack(ROUTER_SYSTEM, {
    contract: ROUTER_CONTRACT,
    questions: (Array.isArray(input.request.questions) ? input.request.questions : []).map(question => projectQuestion(question)),
    context: bounded(input.request.context ?? input.request.taskSummary ?? '', 4000),
    candidates: eligible.map(profile => ({
      agentId: profile.agentId, name: bounded(profile.name, 200),
      userDescription: bounded(profile.userDescription?.text ?? '', 2000),
      scope: projectScope(profile.scope),
    })),
  }, input.contextBudgetTokens)
  if (!pack) return { ...failureResult('failure:context_budget'), candidates }
  const outcome = await streamRouterOutcome(input, pack, text => parseRoute(text, new Set(eligible.map(profile => profile.agentId))))
  if (outcome.reason) return { ...failureResult(outcome.reason, outcome.outputTokens, outcome.invalidCode), candidates }
  return { ...outcome.parsed, candidates }
}

/** @param {string} value @param {number} max */
function bounded(value, max) {
  return Array.from(typeof value === 'string' ? value : String(value ?? '')).slice(0, max).join('')
}

/** @param {any} question */
function projectQuestion(question) {
  return {
    id: question.id,
    ...(question.header === undefined ? {} : { header: bounded(question.header, 4000) }),
    question: bounded(question.question, 4000),
    ...(question.detail === undefined ? {} : { detail: bounded(question.detail, 4000) }),
    ...(question.options === undefined ? {} : { options: (Array.isArray(question.options) ? question.options : []).map(option => ({
      label: bounded(option?.label, 4000),
      ...(option?.description === undefined ? {} : { description: bounded(option.description, 4000) }),
    })) }),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
  }
}

/** @param {any} scope */
function projectScope(scope) {
  return {
    ...(scope?.paths === undefined ? {} : { paths: [...scope.paths] }),
    ...(scope?.tags === undefined ? {} : { tags: [...scope.tags] }),
  }
}

/** @param {string} system @param {any} payload @param {number} [contextBudgetTokens] */
function makePack(system, payload, contextBudgetTokens = 24000) {
  const content = JSON.stringify(payload)
  if (!Number.isFinite(contextBudgetTokens) || contextBudgetTokens <= 0
    || system.length + content.length > contextBudgetTokens * 4) return null
  return { system, messages: [{ role: 'user', content }] }
}

/**
 * The sidecar budget keeps its own floor: a value tuned for a domain Attempt
 * never truncates the router JSON. An explicit budget (the retry) is taken as
 * given so the caller decides how wide the second attempt may be.
 * @param {any} input @param {{system:string,messages:any[]}} pack @param {number} [maxOutputTokens]
 */
async function streamRouter(input, pack, maxOutputTokens = sidecarOutputTokens(input.maxOutputTokens)) {
  const route = await resolveDecisionModelRoute({ llm: input.llm, chain: [], sessionRoute: input.sessionRoute })
  return streamDecision({
    llm: input.llm, route, pack, signal: input.signal,
    timeoutMs: input.timeoutMs, maxOutputTokens,
  })
}

/**
 * Run one sidecar pack and translate its outcome with at most ONE bounded retry:
 * a truncated verdict is retried with a wider (capped) budget, and any other
 * unusable verdict is retried once with the canonical "verdict JSON only"
 * repair instruction. Timeout, abort, model error and route unavailability never
 * retry: they keep the existing fail-closed semantics, and a cancelled session
 * spends no second call. Shadow observation passes `singleShot:true` so a
 * diagnostic sample stays exactly one call.
 * @param {any} input @param {{system:string,messages:any[]}} pack @param {(text:string)=>any} parse
 */
async function streamRouterOutcome(input, pack, parse) {
  const budget = sidecarOutputTokens(input.maxOutputTokens)
  const first = await streamRouterAttempt(input, pack, parse, budget)
  if (!first.reason || input.singleShot === true || input.signal?.aborted) return first
  // Only an unusable OUTPUT earns the one repair; timeout, abort, model error and
  // route unavailability are operational failures and keep fail-closed semantics.
  if (first.reason !== TRUNCATION_FAILURE && first.reason !== INVALID_OUTPUT_FAILURE) return first
  const second = first.reason === TRUNCATION_FAILURE
    ? await streamRouterAttempt(input, pack, parse, retryOutputTokens(budget))
    : await streamRouterAttempt(input, repairPack(pack), parse, budget)
  return { ...second, outputTokens: second.outputTokens ?? first.outputTokens }
}

/** @param {{system:string,messages:any[]}} pack */
function repairPack(pack) {
  return { system: pack.system, messages: [...pack.messages, { role: 'user', content: REPAIR_INSTRUCTION }] }
}

/** @param {any} input @param {{system:string,messages:any[]}} pack @param {(text:string)=>any} parse @param {number} maxOutputTokens */
async function streamRouterAttempt(input, pack, parse, maxOutputTokens) {
  const streamed = await streamRouter(input, pack, maxOutputTokens)
  const outputTokens = boundedCount(/** @type {any} */ (streamed).outputTokens)
  const failure = sidecarFailure(streamed)
  if (failure) return { reason: failure, ...(failure === TRUNCATION_FAILURE ? { invalidCode: 'truncated' } : {}), parsed: null, outputTokens }
  const parsed = parse(streamed.text)
  if (parsed.truncated) return { reason: TRUNCATION_FAILURE, invalidCode: 'truncated', parsed: null, outputTokens }
  if (!parsed.ok) return { reason: 'failure:invalid_output', invalidCode: parsed.invalidCode, parsed: null, outputTokens }
  return { reason: null, parsed: parsed.value, outputTokens }
}

/** @param {number|undefined} configured @returns {number} */
function sidecarOutputTokens(configured) {
  const value = typeof configured === 'number' && Number.isFinite(configured) ? Math.trunc(configured) : SIDECAR_MIN_OUTPUT_TOKENS
  return Math.max(value, SIDECAR_MIN_OUTPUT_TOKENS)
}

/** @param {number} budget @returns {number} */
function retryOutputTokens(budget) {
  return Math.max(budget, Math.min(budget * 2, SIDECAR_RETRY_MAX_OUTPUT_TOKENS))
}

/** @param {unknown} value @returns {number|undefined} */
function boundedCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

/** @param {string} reason @param {number} [outputTokens] @param {string} [invalidCode] */
function failureResult(reason, outputTokens, invalidCode) {
  return {
    kind: 'failed', reason,
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(invalidCode === undefined ? {} : { invalidCode }),
  }
}

/** @param {any} streamed */
function sidecarFailure(streamed) {
  if (['max-tokens', 'truncated'].includes(streamed.finishReason)) return TRUNCATION_FAILURE
  if (['timeout', 'model_error', 'error', 'aborted', 'route_unavailable'].includes(streamed.finishReason)) {
    return `failure:${streamed.finishReason === 'error' ? 'model_error' : streamed.finishReason}`
  }
  return null
}

/** @param {unknown} value */
function validReason(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}

/**
 * One verdict, extracted tolerantly: fences and surrounding prose are fine and
 * unknown extra fields are IGNORED (they are not a failure reason). The required
 * score still stays strict — contract version, a known outcome, a candidate
 * from the input set, an ambiguity shape and a bounded reason.
 * @param {unknown} text @param {Set<string>} eligibleIds
 * @returns {{ok:true,value:any}|{ok:false,invalidCode:string,truncated?:true}}
 */
function parseRoute(text, eligibleIds) {
  const extracted = extractJsonObject(text)
  if (extracted.status === 'truncated') return { ok: false, truncated: true, invalidCode: 'truncated' }
  if (extracted.status !== 'parsed') return { ok: false, invalidCode: 'not_json' }
  const value = extracted.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, invalidCode: 'not_json' }
  if (value.contract !== ROUTER_CONTRACT) return { ok: false, invalidCode: 'missing_field' }
  if (!validReason(value.reason)) return { ok: false, invalidCode: 'reason_invalid' }
  if (value.outcome === 'none') return { ok: true, value: { kind: 'none', reason: value.reason } }
  if (value.outcome === 'selected') {
    if (typeof value.agentId !== 'string' || !value.agentId) return { ok: false, invalidCode: 'missing_field' }
    if (!eligibleIds.has(value.agentId)) return { ok: false, invalidCode: 'unknown_agent' }
    return { ok: true, value: { kind: 'selected', chosen: value.agentId, reason: value.reason } }
  }
  if (value.outcome === 'ambiguous') {
    const ambiguity = value.ambiguity
    if (!ambiguity || typeof ambiguity !== 'object' || Array.isArray(ambiguity)
      || !Array.isArray(ambiguity.candidates) || ambiguity.candidates.length === 0
      || new Set(ambiguity.candidates).size !== ambiguity.candidates.length
      || ambiguity.candidates.some(id => typeof id !== 'string' || !eligibleIds.has(id))
      || !validReason(ambiguity.conflict)) return { ok: false, invalidCode: 'ambiguous_shape' }
    return { ok: true, value: { kind: 'ambiguous', reason: value.reason, ambiguity: { candidates: [...ambiguity.candidates], conflict: ambiguity.conflict } } }
  }
  // No known outcome: the one required discriminator is missing.
  return { ok: false, invalidCode: 'missing_field' }
}
