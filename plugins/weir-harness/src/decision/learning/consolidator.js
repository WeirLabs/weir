// Bounded manual semantic consolidation and deterministic structural replay.
import { createHash, randomUUID } from 'node:crypto'
import { assertClosedObject, canonicalJson, DecisionContractError } from '../contracts.js'
import { scopeCovers } from '../store/evidence.js'
import { LEARNING_LIMITS, validateLearningScope } from './constraints.js'

export const CONSOLIDATION_PROMPT_VERSION = 'consolidation-contract/1'
export const MAX_CANDIDATE_CHARS = 200_000
export const CONSOLIDATION_SYSTEM = `Decision consolidation contract v1
Produce only one JSON object: {"operations":[...]}.
Use only add, refine, merge, narrow, or retire. Every operation may contain only op, principleId, targetPrincipleIds, text, scope, sources, and inputFeedbackIds.
add requires text, scope, and authoritative sources. refine requires an existing principleId, text, and sources; it may narrow but never widen scope. merge requires at least two existing targetPrincipleIds, text, and scope. narrow requires an existing principleId and a smaller scope. retire requires only an existing principleId.
A source must be a frozen user_decision Case, validated closed answered Case, or active correction Feedback from the same Agent and workspace. Comments and negative ratings may only be inputFeedbackIds; never infer an inverse principle from a negative rating. Every source must cover the complete principle scope. Return no operations when no supported change exists.`

/** @param {any} projection */
export function buildConsolidationPack(projection) {
  return {
    system: CONSOLIDATION_SYSTEM,
    messages: [{ role: 'user', content: canonicalJson(projection) }],
  }
}

/**
 * Project only actual frozen same-namespace records. The authority copy remains
 * outside the model wire and supports replay without re-reading mutable tables.
 * @param {{agentId:string,workspaceKey:string,cases:any[],feedback:any[],corrections?:any[],parentSnapshot?:any}} input
 */
export function projectLearningRecords(input) {
  const corrections = Object.fromEntries((input.corrections ?? []).map(correction => [correction.feedbackId, correction]))
  const caseById = Object.fromEntries(input.cases.map(value => [value.caseId, value]))
  const feedbackById = Object.fromEntries(input.feedback.map(value => [value.feedbackId, value]))
  const cases = input.cases.map(value => {
    const request = value.request ?? { questions: [] }
    const decision = value.decision ?? {}
    const answers = (decision.answers ?? []).map(answer => {
      const selected = [...(answer.selected ?? []), ...(answer.custom === undefined ? [] : [answer.custom])].join(', ')
      return `Answer ${answer.id}: ${selected}`
    })
    const questions = (request.questions ?? []).map(question => `Question ${question.id}: ${question.question}`)
    return {
      caseId: value.caseId, revision: value.revision, scope: value.scope,
      closing: value.closing, feedbackState: value.feedbackState,
      decisionKind: decision.kind, excerpt: [...answers, ...questions].join('\n').slice(0, 600),
    }
  })
  const feedback = input.feedback.map(value => {
    const payload = value.payload ?? {}
    return {
      feedbackId: value.feedbackId, caseId: value.caseId, revision: value.revision, kind: value.kind,
      scope: corrections[value.feedbackId]?.scope ?? caseById[value.caseId]?.scope,
      supersedes: payload.supersedes ?? [],
      ...(value.kind === 'comment' ? { text: String(payload.text ?? '').slice(0, 600) } : {}),
      ...(value.kind === 'correction' ? { direction: String(payload.direction ?? '').slice(0, 600) } : {}),
    }
  })
  const parentSnapshot = input.parentSnapshot ? {
    snapshotId: input.parentSnapshot.snapshotId,
    revision: input.parentSnapshot.revision,
    principles: input.parentSnapshot.principles,
  } : null
  const projection = {
    schemaVersion: 1, agentId: input.agentId, workspaceKey: input.workspaceKey,
    cases, feedback, parentSnapshot,
  }
  const authority = {
    agentId: input.agentId, workspaceKey: input.workspaceKey,
    caseById, feedbackById, corrections,
    parentPrinciples: input.parentSnapshot?.principles ?? [],
  }
  return deepFreeze({ projection, authority })
}

/**
 * Strictly parse raw model JSON and allocate final ids exactly once.
 * @param {string} text @param {any[]} parentPrinciples
 */
export function parseConsolidationCandidate(text, parentPrinciples) {
  if (typeof text !== 'string' || text.length > MAX_CANDIDATE_CHARS) throw new DecisionContractError('CANDIDATE_TOO_LARGE', 'Consolidation candidate exceeds the output limit')
  let candidate
  try { candidate = JSON.parse(text) } catch { throw new DecisionContractError('INVALID_CANDIDATE_JSON', 'Consolidation candidate must be strict JSON') }
  const object = assertClosedObject(candidate, ['operations'], ['operations'], 'ConsolidationCandidate')
  if (!Array.isArray(object.operations)) throw new DecisionContractError('INVALID_CANDIDATE', 'operations must be an array')
  if (object.operations.length === 0) throw new DecisionContractError('NO_CANDIDATE_CHANGES', 'No candidate operations were produced')
  if (object.operations.length > LEARNING_LIMITS.operations) throw new DecisionContractError('TOO_MANY_OPERATIONS', 'At most 64 operations are allowed')
  const parentById = new Map(parentPrinciples.map(principle => [principle.principleId, principle]))
  const allocated = new Set()
  const operations = object.operations.map(value => normalizeOperation(value, parentById, allocated))
  return deepFreeze(operations)
}

/** @param {unknown} value @param {Map<string,any>} parentById @param {Set<string>} allocated */
function normalizeOperation(value, parentById, allocated) {
  const base = assertClosedObject(value, ['op', 'principleId', 'targetPrincipleIds', 'text', 'scope', 'sources', 'inputFeedbackIds'], ['op'], 'ConsolidationOperation')
  if (!['add', 'refine', 'merge', 'narrow', 'retire'].includes(base.op)) throw new DecisionContractError('UNKNOWN_OPERATION', String(base.op))
  const allowed = {
    add: ['op', 'principleId', 'text', 'scope', 'sources', 'inputFeedbackIds'],
    refine: ['op', 'principleId', 'text', 'scope', 'sources', 'inputFeedbackIds'],
    merge: ['op', 'principleId', 'targetPrincipleIds', 'text', 'scope', 'sources', 'inputFeedbackIds'],
    narrow: ['op', 'principleId', 'scope', 'sources', 'inputFeedbackIds'],
    retire: ['op', 'principleId', 'inputFeedbackIds'],
  }[base.op]
  const operation = assertClosedObject(value, allowed, ['op'], `ConsolidationOperation.${base.op}`)
  if (operation.inputFeedbackIds !== undefined) stringArray(operation.inputFeedbackIds, 'inputFeedbackIds', LEARNING_LIMITS.feedback)
  const result = { op: operation.op }
  if (operation.inputFeedbackIds !== undefined) result.inputFeedbackIds = [...operation.inputFeedbackIds]

  if (operation.op === 'add' || operation.op === 'merge') {
    if (operation.principleId !== undefined) {
      requiredString(operation.principleId, 'principleId', 200)
      if (parentById.has(operation.principleId) || allocated.has(operation.principleId)) throw new DecisionContractError('TEMPORARY_ID_CONFLICT', operation.principleId)
      allocated.add(operation.principleId)
    }
    result.principleId = `pr_${randomUUID()}`
  } else {
    requiredString(operation.principleId, 'principleId', 200)
    result.principleId = operation.principleId
  }

  if (['add', 'refine', 'merge'].includes(operation.op)) {
    requiredString(operation.text, 'text', 600)
    result.text = operation.text
  }
  if (operation.op === 'add' || operation.op === 'merge') {
    result.scope = validateLearningScope(operation.scope, `${operation.op}.scope`)
  }
  if (operation.op === 'refine') {
    const parent = parentById.get(operation.principleId)
    if (!parent) throw new DecisionContractError('UNKNOWN_TARGET', operation.principleId)
    result.scope = operation.scope === undefined ? parent.scope : validateLearningScope(operation.scope, 'refine.scope')
  }
  if (operation.op === 'narrow') {
    const parent = parentById.get(operation.principleId)
    if (!parent) throw new DecisionContractError('UNKNOWN_TARGET', operation.principleId)
    result.scope = validateLearningScope(operation.scope, 'narrow.scope')
  }
  if (operation.op === 'retire' && !parentById.has(operation.principleId)) throw new DecisionContractError('UNKNOWN_TARGET', operation.principleId)

  if (operation.op === 'merge') {
    stringArray(operation.targetPrincipleIds, 'targetPrincipleIds', LEARNING_LIMITS.principles)
    if (operation.targetPrincipleIds.length < 2) throw new DecisionContractError('INVALID_MERGE', 'merge requires at least two targets')
    result.targetPrincipleIds = [...operation.targetPrincipleIds]
    const targets = operation.targetPrincipleIds.map(id => {
      const parent = parentById.get(id)
      if (!parent) throw new DecisionContractError('UNKNOWN_TARGET', id)
      return parent
    })
    const lineage = [...new Set(targets.flatMap(target => target.sources))]
    if (operation.sources !== undefined) {
      stringArray(operation.sources, 'sources', LEARNING_LIMITS.feedback)
      if (operation.sources.some(id => !lineage.includes(id))) throw new DecisionContractError('MERGE_LINEAGE', 'merge sources must come from its targets')
    }
    result.sources = lineage
  } else if (operation.op === 'narrow') {
    const parent = parentById.get(operation.principleId)
    const sources = operation.sources ?? parent.sources
    stringArray(sources, 'sources', LEARNING_LIMITS.feedback)
    if (sources.some(id => !parent.sources.includes(id))) throw new DecisionContractError('NARROW_LINEAGE', 'narrow cannot introduce sources')
    result.sources = [...sources]
  } else if (operation.op !== 'retire') {
    stringArray(operation.sources, 'sources', LEARNING_LIMITS.feedback)
    result.sources = [...operation.sources]
  }
  return result
}

/** @param {unknown} value @param {string} label @param {number} max */
function requiredString(value, label, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new DecisionContractError('INVALID_TEXT', `${label} must contain 1..${max} characters`)
}

/** @param {unknown} value @param {string} label @param {number} max */
function stringArray(value, label, max) {
  if (!Array.isArray(value) || value.length > max || value.some(entry => typeof entry !== 'string' || !entry || entry.length > 200)) {
    throw new DecisionContractError('INVALID_CANDIDATE', `${label} must be a bounded string array`)
  }
  if (new Set(value).size !== value.length) throw new DecisionContractError('INVALID_CANDIDATE', `${label} must not contain duplicates`)
}

/**
 * Validate and apply operations twice from the same immutable parent. This is a
 * structural replay only; it says nothing about answer quality.
 * @param {any[]} parentPrinciples @param {any[]} operations @param {any} authority
 */
export function replayOperations(parentPrinciples, operations, authority) {
  const parentMetrics = metrics(parentPrinciples, operations)
  try {
    if (!Array.isArray(operations) || operations.length === 0) throw new DecisionContractError('NO_CANDIDATE_CHANGES', 'No candidate operations')
    if (operations.length > LEARNING_LIMITS.operations) throw new DecisionContractError('TOO_MANY_OPERATIONS', 'At most 64 operations are allowed')
    if (!Array.isArray(parentPrinciples) || parentPrinciples.length > LEARNING_LIMITS.principles) throw new DecisionContractError('LEARNING_INPUT_TOO_LARGE', 'Parent principles exceed the input limit')
    const first = applyOperations(parentPrinciples, operations, authority)
    validateFinalPrinciples(first, authority)
    const second = applyOperations(parentPrinciples, operations, authority)
    validateFinalPrinciples(second, authority)
    if (canonicalJson(first) !== canonicalJson(second)) throw new DecisionContractError('NON_DETERMINISTIC_REPLAY', 'Structural replay diverged')
    return {
      passed: true, metrics: metrics(first, operations),
      finalHash: createHash('sha256').update(canonicalJson(first)).digest('hex'),
    }
  } catch (error) {
    return {
      passed: false, metrics: parentMetrics,
      detail: typeof error?.code === 'string' ? error.code.slice(0, 200) : 'STRUCTURAL_REPLAY_FAILED',
    }
  }
}

/** Apply a candidate that has already passed replayOperations. */
export function applyConsolidationOperations(parentPrinciples, operations, authority) {
  return deepFreeze(applyOperations(parentPrinciples, operations, authority))
}

/** @param {any[]} parentPrinciples @param {any[]} operations @param {any} authority */
function applyOperations(parentPrinciples, operations, authority) {
  const principles = parentPrinciples.map(principle => ({
    ...principle, scope: clone(principle.scope), sources: [...principle.sources],
  }))
  const parentIds = new Set(parentPrinciples.map(principle => principle.principleId))
  if (parentIds.size !== parentPrinciples.length) throw new DecisionContractError('DUPLICATE_PRINCIPLE', 'Parent principle ids must be unique')
  const usedTargets = new Set()
  const workspaceKey = authority.workspaceKey
  for (const operation of operations) {
    for (const feedbackId of operation.inputFeedbackIds ?? []) {
      if (!authority.feedbackById[feedbackId]) throw new DecisionContractError('UNKNOWN_FEEDBACK', feedbackId)
    }
    if (operation.op === 'add') {
      if (parentIds.has(operation.principleId) || principles.some(principle => principle.principleId === operation.principleId)) throw new DecisionContractError('TEMPORARY_ID_CONFLICT', operation.principleId)
      principles.push({ principleId: operation.principleId, text: operation.text, scope: clone(operation.scope), sources: [...operation.sources], state: 'active' })
      continue
    }
    if (operation.op === 'merge') {
      if (operation.targetPrincipleIds.includes(operation.principleId)) throw new DecisionContractError('CYCLIC_TARGET', operation.principleId)
      const targets = operation.targetPrincipleIds.map(id => targetPrinciple(parentPrinciples, id, usedTargets))
      for (const target of targets) {
        if (!scopeCovers(target.scope, operation.scope, workspaceKey)) throw new DecisionContractError('SCOPE_EXPANSION', operation.principleId)
      }
      for (const target of targets) {
        principles.find(principle => principle.principleId === target.principleId).state = 'retired'
      }
      principles.push({ principleId: operation.principleId, text: operation.text, scope: clone(operation.scope), sources: [...operation.sources], state: 'active' })
      continue
    }
    const target = targetPrinciple(parentPrinciples, operation.principleId, usedTargets)
    const current = principles.find(principle => principle.principleId === target.principleId)
    if (operation.op === 'retire') {
      current.state = 'retired'
      continue
    }
    if (!scopeCovers(target.scope, operation.scope, workspaceKey)) throw new DecisionContractError('SCOPE_EXPANSION', operation.principleId)
    if (operation.op === 'refine') {
      current.text = operation.text
      current.scope = clone(operation.scope)
      current.sources = [...operation.sources]
      current.state = 'active'
    } else if (operation.op === 'narrow') {
      if (canonicalJson(target.scope) === canonicalJson(operation.scope)) throw new DecisionContractError('SCOPE_NOT_NARROWED', operation.principleId)
      current.scope = clone(operation.scope)
      current.sources = [...operation.sources]
    } else throw new DecisionContractError('UNKNOWN_OPERATION', String(operation.op))
  }
  if (principles.length > LEARNING_LIMITS.principles) throw new DecisionContractError('TOO_MANY_PRINCIPLES', 'Snapshot exceeds the principle limit')
  return principles
}

/** @param {any[]} parent @param {string} id @param {Set<string>} usedTargets */
function targetPrinciple(parent, id, usedTargets) {
  const target = parent.find(principle => principle.principleId === id)
  if (!target) throw new DecisionContractError('UNKNOWN_TARGET', id)
  if (target.state !== 'active') throw new DecisionContractError('TARGET_NOT_ACTIVE', id)
  if (usedTargets.has(id)) throw new DecisionContractError('DUPLICATE_TARGET', id)
  usedTargets.add(id)
  return target
}

/** @param {any[]} principles @param {any} authority */
function validateFinalPrinciples(principles, authority) {
  for (const principle of principles) {
    if (principle.state !== 'active') continue
    if (!Array.isArray(principle.sources) || principle.sources.length === 0) throw new DecisionContractError('MISSING_AUTHORITY_SOURCE', principle.principleId)
    const sources = principle.sources.map(id => authoritativeSource(id, authority))
    for (const source of sources) {
      if (!scopeCovers(source.scope, principle.scope, authority.workspaceKey)) throw new DecisionContractError('SOURCE_SCOPE_MISMATCH', principle.principleId)
    }
    for (let left = 0; left < sources.length; left++) for (let right = left + 1; right < sources.length; right++) {
      if (conflictingCases(sources[left].caseRecord, sources[right].caseRecord)) throw new DecisionContractError('AUTHORITY_CONFLICT', principle.principleId)
    }
  }
}

/** @param {string} id @param {any} authority */
function authoritativeSource(id, authority) {
  const caseRecord = authority.caseById[id]
  if (caseRecord) {
    const userDecision = caseRecord.closing === 'escalated' && caseRecord.decision?.kind === 'user_decision'
    const validatedAnswer = caseRecord.closing === 'answered' && caseRecord.feedbackState === 'validated' && caseRecord.decision?.kind === 'answer'
    if ((!userDecision && !validatedAnswer) || caseRecord.feedbackState === 'disputed') throw new DecisionContractError('INVALID_AUTHORITY_SOURCE', id)
    return { scope: caseRecord.scope, caseRecord }
  }
  const feedback = authority.feedbackById[id]
  const correction = authority.corrections[id]
  if (feedback?.kind === 'correction' && correction?.active === true) return { scope: correction.scope, feedback }
  throw new DecisionContractError('INVALID_AUTHORITY_SOURCE', id)
}

/** @param {any} left @param {any} right */
function conflictingCases(left, right) {
  if (!left || !right || left.caseId === right.caseId) return false
  for (const question of left.request?.questions ?? []) {
    const other = (right.request?.questions ?? []).find(candidate => candidate.question === question.question)
    if (!other) continue
    const a = left.decision?.answers?.find(answer => answer.id === question.id)
    const b = right.decision?.answers?.find(answer => answer.id === other.id)
    if (a && b && canonicalJson({ selected: a.selected, custom: a.custom }) !== canonicalJson({ selected: b.selected, custom: b.custom })) return true
  }
  return false
}

/** @param {any[]} principles @param {any[]} operations */
function metrics(principles, operations) {
  return {
    operationCount: operations?.length ?? 0,
    sourceCount: new Set((principles ?? []).flatMap(principle => principle.sources ?? [])).size,
    activePrincipleCount: (principles ?? []).filter(principle => principle.state === 'active').length,
    retiredPrincipleCount: (principles ?? []).filter(principle => principle.state === 'retired').length,
  }
}

/** @template T @param {T} value @returns {T} */
function clone(value) { return JSON.parse(JSON.stringify(value)) }

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
