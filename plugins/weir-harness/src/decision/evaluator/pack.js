// Bounded, deterministic L0/L1/L4/L5 context assembly for one Attempt.
import { createHash } from 'node:crypto'
import { canonicalJson, DecisionContractError } from '../contracts.js'
import { evaluatorVersion, promptVersion, renderEvaluatorContract } from './contract.js'

const L4_CONTEXT_LIMIT = 2048

/**
 * @param {{profile:any,request:any,evidence?:any[],modelRoute?:object,budgetTokens:number,criticalEvidenceIds?:string[]}} input
 */
export function buildContextPack(input) {
  if (!input.profile || !input.request) throw new DecisionContractError('INVALID_PACK_INPUT', 'profile and request are required')
  if (!Number.isInteger(input.budgetTokens) || input.budgetTokens < 1) throw new DecisionContractError('INVALID_PACK_BUDGET', 'budgetTokens must be a positive integer')
  const budgetCharacters = input.budgetTokens * 4
  const omissions = []
  const L0 = renderEvaluatorContract()
  const L1 = {
    agentProfileRevision: input.profile.revision,
    userDescriptionRevision: input.profile.userDescription?.revision ?? 1,
    userDescription: input.profile.userDescription?.text ?? '',
    scope: input.profile.scope,
    authorizationClasses: input.profile.scope?.authorizationClasses ?? [],
  }
  const request = normalizeRequest(input.request, omissions)
  const L4 = { entry: input.request.entry, request }
  const pins = {
    agentProfileRevision: input.profile.revision,
    userDescriptionRevision: input.profile.userDescription?.revision ?? 1,
    generatedDescriptionRevision: 0,
    memorySnapshotId: null,
    promptVersion,
    evaluatorVersion,
    modelRoute: input.modelRoute ?? { kind: 'inherited' },
    budgetTokens: input.budgetTokens,
  }
  const ordered = orderEvidence(input.evidence ?? [])
  let L5 = ordered.map(evidence => sanitizeEvidence(evidence, false))
  const critical = new Set(input.criticalEvidenceIds ?? ordered
    .filter(evidence => evidence.source === 'user_correction' || evidence.source === 'user_profile')
    .map(evidence => evidence.evidenceId))

  const fixedLength = packLength({ L0, L1, L2: '', L3: '', L4, L5: [] })
  if (fixedLength > budgetCharacters) {
    return earlyResult('escalate', {
      hint: 'Reduce the fixed profile or Case context before retrying.',
      missing: ['The fixed L0/L1/L4 layers exceed the pinned context budget.'],
    }, { L0, L1, L2: '', L3: '', L4, L5: [] }, pins, omissions)
  }

  if (packLength({ L0, L1, L2: '', L3: '', L4, L5 }) > budgetCharacters) {
    const hadExcerpts = L5.some(evidence => typeof evidence.excerpt === 'string')
    L5 = L5.map(evidence => sanitizeEvidence(evidence, true))
    if (hadExcerpts) omissions.push('L5_EXCERPT_OMITTED')
  }

  while (L5.length && packLength({ L0, L1, L2: '', L3: '', L4, L5 }) > budgetCharacters) {
    const oldest = oldestIndex(L5)
    const [dropped] = L5.splice(oldest, 1)
    if (!omissions.includes('L5_EVIDENCE_OMITTED')) omissions.push('L5_EVIDENCE_OMITTED', 'L5_EVIDENCE_TRUNCATED')
    if (critical.has(dropped.evidenceId)) {
      return earlyResult('return', {
        reasonCode: 'MISSING_CONTEXT',
        hint: `Increase the context budget or reduce evidence so critical evidence ${dropped.evidenceId} fits.`,
        missing: [`Critical evidence ${dropped.evidenceId} did not fit the pinned context budget.`],
      }, { L0, L1, L2: '', L3: '', L4, L5 }, pins, omissions)
    }
  }

  const layers = { L0, L1, L2: '', L3: '', L4, L5 }
  if (packLength(layers) > budgetCharacters) {
    return earlyResult('escalate', {
      hint: 'Reduce the fixed profile or Case context before retrying.',
      missing: ['The bounded context envelope exceeds the pinned budget after evidence omission.'],
    }, layers, pins, omissions)
  }
  return result('ready', layers, pins, omissions)
}

/** @param {any} request @param {string[]} omissions */
function normalizeRequest(request, omissions) {
  const copy = { ...request }
  const context = copy.context ?? copy.taskSummary
  if (typeof context === 'string' && context.length > L4_CONTEXT_LIMIT) {
    const truncated = context.slice(0, L4_CONTEXT_LIMIT)
    if (copy.context !== undefined) copy.context = truncated
    if (copy.taskSummary !== undefined) copy.taskSummary = truncated
    omissions.push('L4_TRUNCATED')
  }
  return copy
}

/** @param {any[]} evidence */
function orderEvidence(evidence) {
  return evidence.map((item, index) => ({ item, index })).sort((left, right) => {
    const rank = source => source === 'user_correction' ? 0 : source === 'user_profile' ? 1 : 2
    return rank(left.item.source) - rank(right.item.source) || left.index - right.index
  }).map(entry => entry.item)
}

/** @param {any} evidence @param {boolean} omitExcerpt */
function sanitizeEvidence(evidence, omitExcerpt) {
  const result = {
    evidenceId: evidence.evidenceId,
    source: evidence.source,
    locator: evidence.locator,
    hash: evidence.hash,
    version: evidence.version,
    observedAt: evidence.observedAt,
    scope: evidence.scope,
    status: evidence.status,
    createdAt: evidence.createdAt,
  }
  // Profile prose is exclusively L1; its L5 ref exists only for claim citations.
  if (!omitExcerpt && evidence.source !== 'user_profile' && evidence.excerpt !== undefined) result.excerpt = evidence.excerpt
  return result
}

/** @param {any[]} evidence */
function oldestIndex(evidence) {
  let index = 0
  for (let cursor = 1; cursor < evidence.length; cursor++) {
    const left = evidence[cursor]
    const right = evidence[index]
    if ((left.createdAt ?? 0) < (right.createdAt ?? 0)) index = cursor
  }
  return index
}

/** @param {Record<string,any>} layers */
function packLength(layers) {
  return Object.values(layers).reduce((sum, layer) => sum + (typeof layer === 'string' ? layer.length : JSON.stringify(layer).length), 0)
}

/** @param {'ready'|'answer'|'return'|'escalate'} outcome @param {Record<string,any>} layers @param {any} pins @param {string[]} omissions */
function result(outcome, layers, pins, omissions, extra = {}) {
  const evidenceIds = layers.L5.map(evidence => evidence.evidenceId)
  const correctionIds = layers.L5.filter(evidence => evidence.source === 'user_correction').map(evidence => evidence.evidenceId)
  const packManifest = {
    layerSizes: Object.fromEntries(Object.entries(layers).map(([key, value]) => [key, typeof value === 'string' ? value.length : JSON.stringify(value).length])),
    evidenceIds,
    correctionIds,
    omissions: [...omissions],
  }
  const contextPackHash = createHash('sha256').update(canonicalJson({
    pins, request: layers.L4.request, evidenceIds, correctionIds, omissions,
  })).digest('hex')
  return {
    outcome,
    ...extra,
    system: layers.L0,
    messages: outcome === 'ready' ? [{ role: 'user', content: JSON.stringify({ L1: layers.L1, L2: '', L3: '', L4: layers.L4, L5: layers.L5 }) }] : [],
    layers,
    pins,
    packManifest,
    contextPackHash,
  }
}

/** @param {'return'|'escalate'} outcome @param {object} extra @param {Record<string,any>} layers @param {any} pins @param {string[]} omissions */
function earlyResult(outcome, extra, layers, pins, omissions) {
  return result(outcome, layers, pins, omissions, extra)
}
