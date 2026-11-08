// Bounded, deterministic L0/L1/L2/L3/L4/L5 context assembly for one Attempt.
import { createHash } from 'node:crypto'
import { canonicalJson, DecisionContractError } from '../contracts.js'
import { evaluatorVersion, promptVersion, renderEvaluatorContract } from './contract.js'

const L4_CONTEXT_LIMIT = 2048
const L3_EXCERPT_LIMIT = 600
const L2_TEXT_LIMIT = 600
const L2_EXCLUSION_REASONS = Object.freeze(['NOT_ACTIVE', 'OUT_OF_SCOPE', 'SOURCE_UNAVAILABLE'])
const HEX_256 = /^[a-f0-9]{64}$/

/**
 * @param {{profile:any,request:any,evidence?:any[],memory?:{L2?:any,L3?:any[]},modelRoute?:object,budgetTokens:number,criticalEvidenceIds?:string[]}} input
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
  const ordered = orderEvidence(input.evidence ?? [])
  const memoryL2 = normalizeL2(input.memory?.L2, ordered)
  const pins = {
    agentProfileRevision: input.profile.revision,
    userDescriptionRevision: input.profile.userDescription?.revision ?? 1,
    generatedDescriptionRevision: 0,
    memorySnapshotId: memoryL2.snapshotId,
    memorySnapshotRevision: memoryL2.snapshotRevision,
    memorySnapshotHash: memoryL2.snapshotHash,
    promptVersion,
    evaluatorVersion,
    modelRoute: input.modelRoute ?? { kind: 'inherited' },
    budgetTokens: input.budgetTokens,
  }
  let L2 = memoryL2.items
  let L3 = normalizeL3(input.memory?.L3)
  let L5 = ordered.map(evidence => sanitizeEvidence(evidence, false))

  // Fixed overflow is independent of every trimmable layer. A large L2 hit is
  // not a fixed-profile failure: it can still be omitted whole below.
  const fixedLength = packLength({ L0, L1, L2: '', L3: '', L4, L5: [] })
  if (fixedLength > budgetCharacters) {
    return earlyResult('escalate', {
      hint: 'Reduce the fixed profile or Case context before retrying.',
      missing: ['The fixed L0/L1/L4 layers exceed the pinned context budget.'],
    }, { L0, L1, L2: '', L3: '', L4, L5: [] }, pins, omissions, memoryL2.exclusions)
  }

  // Neutral memory has the lowest retention priority: remove whole episodes in
  // reverse retrieval order, never leave a source locator without its content.
  while (L3.length && packLength({ L0, L1, L2, L3: L3.length ? L3 : '', L4, L5 }) > budgetCharacters) {
    L3.pop()
    if (!omissions.includes('L3_EPISODE_OMITTED')) omissions.push('L3_EPISODE_OMITTED', 'L3_EPISODE_TRUNCATED')
  }

  // Reviewed principles are also trimmed as whole entries, after L3 and before
  // any L5 excerpt/evidence loss. Snapshot pins deliberately survive this trim.
  while (L2.length && packLength({ L0, L1, L2, L3: L3.length ? L3 : '', L4, L5 }) > budgetCharacters) {
    L2.pop()
    if (!omissions.includes('L2_PRINCIPLE_OMITTED')) omissions.push('L2_PRINCIPLE_OMITTED', 'L2_PRINCIPLE_TRUNCATED')
  }

  // Every source needed by a retained principle inherits critical-evidence
  // behavior. L5 can never silently strand a live L2 principle without sources.
  const critical = new Set([
    ...(input.criticalEvidenceIds ?? ordered
      .filter(evidence => evidence.source === 'user_correction' || evidence.source === 'user_profile')
      .map(evidence => evidence.evidenceId)),
    ...L2.flatMap(principle => principle.evidenceIds),
  ])

  if (packLength({ L0, L1, L2: L2.length ? L2 : '', L3: L3.length ? L3 : '', L4, L5 }) > budgetCharacters) {
    const hadExcerpts = L5.some(evidence => typeof evidence.excerpt === 'string')
    L5 = L5.map(evidence => sanitizeEvidence(evidence, true))
    if (hadExcerpts) omissions.push('L5_EXCERPT_OMITTED')
  }

  while (L5.length && packLength({ L0, L1, L2: L2.length ? L2 : '', L3: L3.length ? L3 : '', L4, L5 }) > budgetCharacters) {
    const oldest = oldestIndex(L5)
    const [dropped] = L5.splice(oldest, 1)
    if (!omissions.includes('L5_EVIDENCE_OMITTED')) omissions.push('L5_EVIDENCE_OMITTED', 'L5_EVIDENCE_TRUNCATED')
    if (critical.has(dropped.evidenceId)) {
      const retained = L2.filter(principle => principle.evidenceIds.every(id => L5.some(ref => ref.evidenceId === id)))
      if (retained.length !== L2.length) {
        L2 = retained
        if (!omissions.includes('L2_PRINCIPLE_OMITTED')) omissions.push('L2_PRINCIPLE_OMITTED', 'L2_PRINCIPLE_TRUNCATED')
      }
      return earlyResult('return', {
        reasonCode: 'MISSING_CONTEXT',
        hint: `Increase the context budget or reduce evidence so critical evidence ${dropped.evidenceId} fits.`,
        missing: [`Critical evidence ${dropped.evidenceId} did not fit the pinned context budget.`],
      }, { L0, L1, L2: L2.length ? L2 : '', L3: L3.length ? L3 : '', L4, L5 }, pins, omissions, memoryL2.exclusions)
    }
  }

  const layers = { L0, L1, L2: L2.length ? L2 : '', L3: L3.length ? L3 : '', L4, L5 }
  if (packLength(layers) > budgetCharacters) {
    return earlyResult('escalate', {
      hint: 'Reduce the fixed profile or Case context before retrying.',
      missing: ['The bounded context envelope exceeds the pinned budget after evidence omission.'],
    }, layers, pins, omissions, memoryL2.exclusions)
  }
  return result('ready', layers, pins, omissions, memoryL2.exclusions)
}

/**
 * @param {any} value
 * @param {any[]} evidence
 */
function normalizeL2(value, evidence) {
  if (value === undefined) return emptyL2()
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || !['empty', 'populated'].includes(value.status)
    || !Array.isArray(value.items) || value.items.length > 128
    || (value.exclusions !== undefined && (!Array.isArray(value.exclusions) || value.exclusions.length > 128))
    || (value.status === 'empty') !== (value.items.length === 0)) {
    throw invalidL2('L2 memory must be a bounded versioned empty/populated adapter result')
  }
  const snapshotId = value.snapshotId
  if (snapshotId !== null && (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 200)) {
    throw invalidL2('L2 snapshotId must be null or a bounded id')
  }
  if (snapshotId === null && value.items.length !== 0) throw invalidL2('L2 items require a current Snapshot pin')
  const snapshotRevision = value.snapshotRevision ?? null
  const snapshotHash = value.snapshotHash ?? null
  if (snapshotId === null) {
    if (snapshotRevision !== null || snapshotHash !== null) throw invalidL2('Empty no-Snapshot L2 must have null pins')
  } else {
    if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 1 || typeof snapshotHash !== 'string' || !HEX_256.test(snapshotHash)) {
      throw invalidL2('A pinned Snapshot requires a positive revision and SHA-256 content hash')
    }
  }
  const evidenceIds = new Set(evidence.map(item => item.evidenceId))
  const items = value.items.map(item => sanitizePrinciple(item, evidenceIds))
  const exclusions = (value.exclusions ?? []).map(sanitizeL2Exclusion)
  return { snapshotId, snapshotRevision, snapshotHash, items, exclusions }
}

function emptyL2() {
  return { snapshotId: null, snapshotRevision: null, snapshotHash: null, items: [], exclusions: [] }
}

/** @param {any} principle @param {Set<string>} availableEvidenceIds */
function sanitizePrinciple(principle, availableEvidenceIds) {
  if (!principle || typeof principle !== 'object' || Array.isArray(principle)
    || principle.schemaVersion !== 1 || principle.kind !== 'reviewed_principle'
    || !boundedId(principle.principleId) || typeof principle.text !== 'string'
    || !principle.text || principle.text.length > L2_TEXT_LIMIT) {
    throw invalidL2('L2 items must be complete bounded reviewed_principle projections')
  }
  const sources = boundedIdArray(principle.sources, 'sources')
  const evidenceIds = boundedIdArray(principle.evidenceIds, 'evidenceIds')
  if (evidenceIds.some(id => !availableEvidenceIds.has(id))) throw invalidL2('L2 evidenceIds must refer to the supplied eligible L5 set')
  return {
    schemaVersion: 1,
    kind: 'reviewed_principle',
    principleId: principle.principleId,
    text: principle.text,
    scope: sanitizeScope(principle.scope),
    sources,
    evidenceIds,
  }
}

/** @param {any} exclusion */
function sanitizeL2Exclusion(exclusion) {
  if (!exclusion || typeof exclusion !== 'object' || Array.isArray(exclusion)
    || !boundedId(exclusion.principleId) || !L2_EXCLUSION_REASONS.includes(exclusion.reason)) {
    throw invalidL2('L2 exclusions must use bounded principle ids and closed reasons')
  }
  return { principleId: exclusion.principleId, reason: exclusion.reason }
}

/** @param {any} value @param {string} label */
function boundedIdArray(value, label) {
  if (!Array.isArray(value) || value.length > 256 || value.some(item => !boundedId(item))
    || new Set(value).size !== value.length) {
    throw invalidL2(`L2 ${label} must be a bounded unique id array`)
  }
  return [...value]
}

/** @param {any} value */
function boundedId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** @param {string} detail */
function invalidL2(detail) {
  return new DecisionContractError('INVALID_MEMORY_INPUT', detail)
}

/** @param {any} value */
function normalizeL3(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new DecisionContractError('INVALID_MEMORY_INPUT', 'L3 memory must be an Episode array')
  return value.map(sanitizeEpisode)
}

/** @param {any} episode */
function sanitizeEpisode(episode) {
  if (!episode || typeof episode !== 'object' || Array.isArray(episode)
    || episode.schemaVersion !== 1 || episode.kind !== 'neutral_agent_answer'
    || typeof episode.sourceCaseId !== 'string' || !episode.sourceCaseId
    || !Number.isInteger(episode.sourceRevision) || episode.sourceRevision < 1
    || typeof episode.excerpt !== 'string' || !episode.excerpt || episode.excerpt.length > L3_EXCERPT_LIMIT
    || !Number.isFinite(episode.createdAt) || !Number.isFinite(episode.closedAt)) {
    throw new DecisionContractError('INVALID_MEMORY_INPUT', 'L3 Episodes must be complete, bounded neutral_agent_answer projections')
  }
  return {
    schemaVersion: 1,
    kind: 'neutral_agent_answer',
    sourceCaseId: episode.sourceCaseId,
    sourceRevision: episode.sourceRevision,
    scope: sanitizeScope(episode.scope),
    excerpt: episode.excerpt,
    createdAt: episode.createdAt,
    closedAt: episode.closedAt,
  }
}

/** @param {any} value */
function sanitizeScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.workspaces)
    || value.workspaces.length === 0 || value.workspaces.some(item => typeof item !== 'string' || !item)) {
    throw new DecisionContractError('INVALID_MEMORY_INPUT', 'Memory scope must contain workspace strings')
  }
  const result = { workspaces: [...value.workspaces] }
  for (const key of ['paths', 'tags', 'authorizationClasses']) {
    if (value[key] === undefined) continue
    if (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string' || !item)) {
      throw new DecisionContractError('INVALID_MEMORY_INPUT', `Memory scope.${key} must be a string array`)
    }
    result[key] = [...value[key]]
  }
  return result
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

/**
 * @param {'ready'|'answer'|'return'|'escalate'} outcome
 * @param {Record<string,any>} layers
 * @param {any} pins
 * @param {string[]} omissions
 * @param {any[]} l2Exclusions
 * @param {object} [extra]
 */
function result(outcome, layers, pins, omissions, l2Exclusions, extra = {}) {
  const evidenceIds = layers.L5.map(evidence => evidence.evidenceId)
  const correctionIds = layers.L5.filter(evidence => evidence.source === 'user_correction').map(evidence => evidence.evidenceId)
  const actualL2 = Array.isArray(layers.L2) ? layers.L2 : []
  const packManifest = {
    layerSizes: Object.fromEntries(Object.entries(layers).map(([key, value]) => [key, typeof value === 'string' ? value.length : JSON.stringify(value).length])),
    evidenceIds,
    correctionIds,
    memory: {
      L2: {
        schemaVersion: 1,
        status: actualL2.length ? 'populated' : 'empty',
        snapshotId: pins.memorySnapshotId ?? null,
        snapshotRevision: pins.memorySnapshotRevision ?? null,
        snapshotHash: pins.memorySnapshotHash ?? null,
        principleIds: actualL2.map(item => item.principleId),
        items: actualL2.map(item => ({ principleId: item.principleId, sources: [...item.sources], evidenceIds: [...item.evidenceIds] })),
        exclusions: l2Exclusions.map(item => ({ principleId: item.principleId, reason: item.reason })),
      },
      L3: { schemaVersion: 1, sourceCaseIds: typeof layers.L3 === 'string' ? [] : layers.L3.map(episode => episode.sourceCaseId) },
    },
    omissions: [...omissions],
  }
  const contextPackHash = createHash('sha256').update(canonicalJson({
    pins, request: layers.L4.request, evidenceIds, correctionIds,
    L2: layers.L2, L3: layers.L3, omissions,
  })).digest('hex')
  return {
    outcome,
    ...extra,
    system: layers.L0,
    messages: outcome === 'ready' ? [{ role: 'user', content: JSON.stringify({ L1: layers.L1, L2: layers.L2, L3: layers.L3, L4: layers.L4, L5: layers.L5 }) }] : [],
    layers,
    pins,
    packManifest,
    contextPackHash,
  }
}

/**
 * @param {'return'|'escalate'} outcome
 * @param {object} extra
 * @param {Record<string,any>} layers
 * @param {any} pins
 * @param {string[]} omissions
 * @param {any[]} l2Exclusions
 */
function earlyResult(outcome, extra, layers, pins, omissions, l2Exclusions) {
  return result(outcome, layers, pins, omissions, l2Exclusions, extra)
}
