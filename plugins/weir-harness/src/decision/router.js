// Broker-private Auto admission, classification, and candidate routing. This
// module never enters the domain Attempt/retrieval pipeline or reads its memory.
import {
  ROUTER_CLASSIFICATION_CONTRACT, ROUTER_CONTRACT,
} from './contracts.js'
import { scopeCovers } from './scope.js'
import { resolveDecisionModelRoute, streamDecision } from './evaluator/sidecar.js'

const CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'unknown']
const ANSWER_CLASSES = ['A', 'B', 'C']
const TRUNCATED = Symbol('truncated')

const CLASSIFICATION_SYSTEM = `Auto request classification contract: router-classification-contract/1
Classify only the supplied question ids. Return one JSON object with exactly this shape:
{"contract":"router-classification-contract/1","classes":[{"id":"question id","authorizationClass":"A|B|C|D|E|F|unknown"}]}
Cover every supplied id exactly once. Do not answer the questions, add fields, estimate confidence, or use unstated context.`

const ROUTER_SYSTEM = `Auto candidate router contract: router-contract/1
Choose only an eligible supplied candidate, no route, or a substantive ambiguity. Return one JSON object in one of these shapes:
{"contract":"router-contract/1","outcome":"selected","agentId":"eligible id","reason":"short reason"}
{"contract":"router-contract/1","outcome":"none","reason":"short reason"}
{"contract":"router-contract/1","outcome":"ambiguous","reason":"short reason","ambiguity":{"candidates":["eligible id"],"conflict":"short conflict"}}
Do not answer the questions, add fields, estimate confidence, change scope, or use unstated context.`

/** @param {any} request @param {unknown} allowedClasses @returns {{ok:true,classes:string[]}|{ok:false,reason:'missing_class'|'unknown_class'|'not_allowed'}} */
export function autoAdmission(request, allowedClasses) {
  const allowed = new Set(Array.isArray(allowedClasses) ? allowedClasses.filter(value => ANSWER_CLASSES.includes(value)) : [])
  const questions = Array.isArray(request?.questions) ? request.questions : []
  if (questions.length === 0) return { ok: false, reason: 'missing_class' }
  const supplied = questions.map(question => question?.authorizationClass)
  if (supplied.some(value => value !== undefined && !ANSWER_CLASSES.includes(value))) return { ok: false, reason: 'unknown_class' }
  if (supplied.some(value => value !== undefined && !allowed.has(value))) return { ok: false, reason: 'not_allowed' }
  if (supplied.some(value => value === undefined)) return { ok: false, reason: 'missing_class' }
  return { ok: true, classes: [...new Set(supplied)] }
}

/** @param {{request:any,scope:any,workspaceKey:string,profiles:any[]}} input */
export function planAutoRoute(input) {
  const admission = autoAdmission(input.request, ANSWER_CLASSES)
  const classes = admission.ok ? admission.classes : []
  const eligible = []
  const candidates = []
  const profiles = (Array.isArray(input.profiles) ? input.profiles : [])
    .filter(profile => typeof profile?.agentId === 'string' && profile.agentId
      && profile.workspaceKey === input.workspaceKey && profile.state !== 'archived')
    .sort((left, right) => left.agentId.localeCompare(right.agentId))
  for (const profile of profiles) {
    const enabled = profile.state === 'enabled'
    let rejectedBecause
    if (!enabled) rejectedBecause = 'disabled'
    else if (!admission.ok || !scopeCovers(profile.scope, input.scope, input.workspaceKey)) rejectedBecause = 'scope'
    else if (!classes.every(value => profile.scope?.authorizationClasses?.includes(value))) rejectedBecause = 'authorization'
    candidates.push({ agentId: profile.agentId, enabled, ...(rejectedBecause ? { rejectedBecause } : {}) })
    if (!rejectedBecause) eligible.push(profile)
  }
  return { candidates, eligible }
}

/** @param {{request:any,llm:any,sessionRoute?:any,signal?:AbortSignal,timeoutMs:number,maxOutputTokens:number,contextBudgetTokens?:number}} input */
export async function classifyAutoRequest(input) {
  const initial = autoAdmission(input.request, ANSWER_CLASSES)
  const normalized = normalizeRequest(input.request)
  if (initial.ok) return { kind: 'classified', request: normalized }
  if (initial.reason === 'unknown_class') return { kind: 'authority', reason: 'unknown_class', request: normalized }

  const missing = normalized.questions.filter(question => question.authorizationClass === undefined)
  const pack = makePack(CLASSIFICATION_SYSTEM, {
    contract: ROUTER_CLASSIFICATION_CONTRACT,
    questions: missing.map(question => projectQuestion(question, false)),
    context: bounded(normalized.context ?? normalized.taskSummary ?? '', 4000),
  }, input.contextBudgetTokens)
  if (!pack) return { kind: 'failed', reason: 'failure:context_budget' }
  const streamed = await streamRouter(input, pack)
  const failure = sidecarFailure(streamed)
  if (failure) return { kind: 'failed', reason: failure }
  const parsed = parseClassification(streamed.text, missing.map(question => question.id))
  if (parsed === TRUNCATED) return { kind: 'failed', reason: 'failure:truncated' }
  if (!parsed) return { kind: 'failed', reason: 'failure:invalid_output' }
  for (const item of parsed) {
    const question = normalized.questions.find(candidate => candidate.id === item.id)
    question.authorizationClass = item.authorizationClass
    question.authorizationClassSource = 'auto_classifier'
  }
  if (parsed.some(item => !ANSWER_CLASSES.includes(item.authorizationClass))) {
    return { kind: 'authority', reason: 'unknown_class', request: normalized }
  }
  return { kind: 'classified', request: normalized }
}

/** @param {{request:any,scope:any,workspaceKey:string,profiles:any[],sessionRoute?:any,signal?:AbortSignal,llm:any,contextBudgetTokens:number,timeoutMs:number,maxOutputTokens:number}} input */
export async function routeAuto(input) {
  if (!autoAdmission(input.request, ANSWER_CLASSES).ok) {
    return { kind: 'none', candidates: [], reason: 'admission:authority' }
  }
  const { candidates, eligible } = planAutoRoute(input)
  if (eligible.length === 0) return { kind: 'none', candidates, reason: 'none:no_candidates' }
  if (eligible.length === 1) return { kind: 'selected', candidates, chosen: eligible[0].agentId, reason: 'deterministic:single_candidate' }
  if (eligible.length > 32) return { kind: 'failed', candidates, reason: 'failure:candidate_limit' }

  const pack = makePack(ROUTER_SYSTEM, {
    contract: ROUTER_CONTRACT,
    questions: input.request.questions.map(question => projectQuestion(question, true)),
    context: bounded(input.request.context ?? input.request.taskSummary ?? '', 4000),
    candidates: eligible.map(profile => ({
      agentId: profile.agentId, name: bounded(profile.name, 200),
      userDescription: bounded(profile.userDescription?.text ?? '', 2000),
      scope: projectScope(profile.scope),
    })),
  }, input.contextBudgetTokens)
  if (!pack) return { kind: 'failed', candidates, reason: 'failure:context_budget' }
  const streamed = await streamRouter(input, pack)
  const failure = sidecarFailure(streamed)
  if (failure) return { kind: 'failed', candidates, reason: failure }
  const parsed = parseRoute(streamed.text, new Set(eligible.map(profile => profile.agentId)))
  if (parsed === TRUNCATED) return { kind: 'failed', candidates, reason: 'failure:truncated' }
  if (!parsed) return { kind: 'failed', candidates, reason: 'failure:invalid_output' }
  return { ...parsed, candidates }
}

function normalizeRequest(request) {
  return { ...request, questions: (Array.isArray(request?.questions) ? request.questions : []).map(question => ({ ...question })) }
}

function bounded(value, max) {
  return Array.from(typeof value === 'string' ? value : String(value ?? '')).slice(0, max).join('')
}

function projectQuestion(question, includeClass) {
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
    ...(includeClass ? { authorizationClass: question.authorizationClass } : {}),
  }
}

function projectScope(scope) {
  return {
    workspaces: [...(scope?.workspaces ?? [])],
    ...(scope?.paths === undefined ? {} : { paths: [...scope.paths] }),
    ...(scope?.tags === undefined ? {} : { tags: [...scope.tags] }),
    authorizationClasses: [...(scope?.authorizationClasses ?? [])],
  }
}

function makePack(system, payload, contextBudgetTokens = 24000) {
  const content = JSON.stringify(payload)
  if (!Number.isFinite(contextBudgetTokens) || contextBudgetTokens <= 0
    || system.length + content.length > contextBudgetTokens * 4) return null
  return { system, messages: [{ role: 'user', content }] }
}

async function streamRouter(input, pack) {
  const route = await resolveDecisionModelRoute({ llm: input.llm, chain: [], sessionRoute: input.sessionRoute })
  return streamDecision({
    llm: input.llm, route, pack, signal: input.signal,
    timeoutMs: input.timeoutMs, maxOutputTokens: input.maxOutputTokens,
  })
}

function sidecarFailure(streamed) {
  if (['max-tokens', 'truncated'].includes(streamed.finishReason)) return 'failure:truncated'
  if (['timeout', 'model_error', 'error', 'aborted', 'route_unavailable'].includes(streamed.finishReason)) {
    return `failure:${streamed.finishReason === 'error' ? 'model_error' : streamed.finishReason}`
  }
  return null
}

function parseJson(text) {
  if (typeof text !== 'string') return null
  const cleaned = text.trim()
  if (!cleaned.startsWith('{')) return null
  try { return JSON.parse(cleaned) } catch (error) {
    const message = /** @type {any} */ (error)?.message ?? ''
    if (/after json/i.test(message)) return null
    if (!cleaned.endsWith('}') || /unexpected end|unterminated|end of (?:json )?(?:input|data)/i.test(message)) return TRUNCATED
    return null
  }
}

function closed(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
}

function validReason(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}

function parseClassification(text, missingIds) {
  const value = parseJson(text)
  if (value === TRUNCATED) return TRUNCATED
  if (!closed(value, ['contract', 'classes'], ['contract', 'classes'])
    || value.contract !== ROUTER_CLASSIFICATION_CONTRACT || !Array.isArray(value.classes)) return null
  if (value.classes.some(item => !closed(item, ['id', 'authorizationClass'], ['id', 'authorizationClass'])
    || typeof item.id !== 'string' || !CLASSES.includes(item.authorizationClass))) return null
  const ids = value.classes.map(item => item.id)
  if (ids.length !== missingIds.length || new Set(ids).size !== ids.length || ids.some(id => !missingIds.includes(id))) return null
  return value.classes.map(item => ({ id: item.id, authorizationClass: item.authorizationClass }))
}

function parseRoute(text, eligibleIds) {
  const value = parseJson(text)
  if (value === TRUNCATED) return TRUNCATED
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.contract !== ROUTER_CONTRACT || !validReason(value.reason)) return null
  if (value.outcome === 'none') {
    if (!closed(value, ['contract', 'outcome', 'reason'], ['contract', 'outcome', 'reason'])) return null
    return { kind: 'none', reason: value.reason }
  }
  if (value.outcome === 'selected') {
    if (!closed(value, ['contract', 'outcome', 'agentId', 'reason'], ['contract', 'outcome', 'agentId', 'reason'])
      || typeof value.agentId !== 'string' || !eligibleIds.has(value.agentId)) return null
    return { kind: 'selected', chosen: value.agentId, reason: value.reason }
  }
  if (value.outcome === 'ambiguous') {
    if (!closed(value, ['contract', 'outcome', 'reason', 'ambiguity'], ['contract', 'outcome', 'reason', 'ambiguity'])
      || !closed(value.ambiguity, ['candidates', 'conflict'], ['candidates', 'conflict'])
      || !Array.isArray(value.ambiguity.candidates) || value.ambiguity.candidates.length === 0
      || new Set(value.ambiguity.candidates).size !== value.ambiguity.candidates.length
      || value.ambiguity.candidates.some(id => typeof id !== 'string' || !eligibleIds.has(id))
      || !validReason(value.ambiguity.conflict)) return null
    return { kind: 'ambiguous', reason: value.reason, ambiguity: { candidates: [...value.ambiguity.candidates], conflict: value.ambiguity.conflict } }
  }
  return null
}
