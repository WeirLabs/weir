// Versioned, read-only memory projections for one Decision Attempt.
import { DecisionContractError, parseAnswerItem } from '../contracts.js'
import { caseOf } from '../store/cases.js'
import { scopeCovers, scopeHintsCover } from '../scope.js'
import { DecisionLearning } from '../store/learning.js'
import { PUBLIC_ZONE, workspaceAlias } from '../learning/namespace.js'

export const L2_MEMORY_VERSION = 1
export const L3_MEMORY_VERSION = 1
const L3_EXCERPT_LIMIT = 600

/**
 * A disabled or archived Agent has no usable memory in either zone: history is
 * read-only, never guidance for a new Attempt.
 * @param {'enabled'|'disabled'|'archived'|undefined} agentState
 */
function zoneUsableForNewUse(agentState) {
  return agentState === undefined || agentState === 'enabled'
}

/**
 * Read only the current published private Snapshot and expand every principle
 * source into full eligible L5.
 * @param {any} store @param {any} input @param {any[]} [L5] @param {{agentState?:string}} [options]
 */
export function readL2Memory(store, input, L5 = [], options = {}) {
  const snapshot = zoneUsableForNewUse(options.agentState)
    ? new DecisionLearning(store).currentSnapshot(input.agentId, input.workspaceKey)
    : null
  if (!snapshot) return deepFreeze({
    schemaVersion: L2_MEMORY_VERSION, status: 'empty', snapshotId: null,
    snapshotRevision: null, snapshotHash: null, items: [], exclusions: [],
  })
  const items = []
  const exclusions = []
  for (const principle of snapshot.principles) {
    if (principle.state !== 'active') {
      exclusions.push({ principleId: principle.principleId, reason: 'NOT_ACTIVE' })
      continue
    }
    if (!scopeCovers(principle.scope, input.scope, input.workspaceKey)) {
      exclusions.push({ principleId: principle.principleId, reason: 'OUT_OF_SCOPE' })
      continue
    }
    const evidenceIds = []
    for (const source of principle.sources) {
      const ref = L5.find(evidence => evidence.agentId === input.agentId && evidence.status === 'active'
        && scopeCovers(evidence.scope, input.scope, input.workspaceKey) && (
        (['user_decision', 'agent_record'].includes(evidence.source) && evidence.locator?.kind === 'case' && evidence.locator.caseId === source)
        || (evidence.source === 'user_correction' && evidence.locator?.kind === 'feedback' && evidence.locator.feedbackId === source)
      ))
      if (!ref) {
        evidenceIds.length = 0
        break
      }
      if (!evidenceIds.includes(ref.evidenceId)) evidenceIds.push(ref.evidenceId)
    }
    if (principle.sources.length === 0 || evidenceIds.length !== new Set(principle.sources).size) {
      exclusions.push({ principleId: principle.principleId, reason: 'SOURCE_UNAVAILABLE' })
      continue
    }
    items.push({
      schemaVersion: L2_MEMORY_VERSION, kind: 'reviewed_principle',
      principleId: principle.principleId, text: principle.text, scope: principle.scope,
      sources: [...principle.sources], evidenceIds,
    })
  }
  return deepFreeze({
    schemaVersion: L2_MEMORY_VERSION, status: items.length ? 'populated' : 'empty',
    snapshotId: snapshot.snapshotId, snapshotRevision: snapshot.revision, snapshotHash: snapshot.contentHash,
    items, exclusions,
  })
}

/**
 * Read only the current published public Snapshot. A public principle:
 * - has a workspace-agnostic scope: hints only, no workspace membership;
 * - may enter guidance without its sources being in the current workspace L5;
 * - is omitted with a recorded reason when any source fails origin-workspace
 *   revalidation at use time;
 * - carries opaque source aliases and no Evidence Refs.
 * @param {any} store
 * @param {any} input
 * @param {{agentState?:string, evidence?:any}} [options]
 */
export function readPublicL2Memory(store, input, options = {}) {
  const empty = () => deepFreeze({
    schemaVersion: L2_MEMORY_VERSION, zone: PUBLIC_ZONE, status: 'empty', snapshotId: null,
    snapshotRevision: null, snapshotHash: null, items: [], exclusions: [],
  })
  if (!zoneUsableForNewUse(options.agentState)) return empty()
  const learning = new DecisionLearning(store, { evidence: options.evidence })
  const snapshot = learning.currentPublicSnapshot(input.agentId)
  if (!snapshot) return empty()
  let sourceWorkspaces = {}
  try {
    const run = learning.getRunById(snapshot.learningRunId)
    sourceWorkspaces = run.inputFrozen.sourceWorkspaces ?? {}
  } catch { sourceWorkspaces = {} }
  const issues = learning.publicPrincipleIssues(snapshot)
  const items = []
  const exclusions = []
  for (const principle of snapshot.principles) {
    if (principle.state !== 'active') {
      exclusions.push({ principleId: principle.principleId, reason: 'NOT_ACTIVE' })
      continue
    }
    if (!scopeHintsCover(principle.scope, input.scope)) {
      exclusions.push({ principleId: principle.principleId, reason: 'OUT_OF_SCOPE' })
      continue
    }
    if (issues[principle.principleId] || !sourceAliases(principle, sourceWorkspaces).length) {
      exclusions.push({ principleId: principle.principleId, reason: 'SOURCE_UNAVAILABLE' })
      continue
    }
    items.push({
      schemaVersion: L2_MEMORY_VERSION, kind: 'reviewed_principle', zone: PUBLIC_ZONE,
      principleId: principle.principleId, text: principle.text, scope: cloneScope(principle.scope),
      sources: sourceAliases(principle, sourceWorkspaces), evidenceIds: [],
    })
  }
  return deepFreeze({
    schemaVersion: L2_MEMORY_VERSION, zone: PUBLIC_ZONE, status: items.length ? 'populated' : 'empty',
    snapshotId: snapshot.snapshotId, snapshotRevision: snapshot.revision, snapshotHash: snapshot.contentHash,
    items, exclusions,
  })
}

/** Opaque, deterministic source aliases; a public payload never names a record. */
function sourceAliases(principle, sourceWorkspaces) {
  const aliases = principle.sources
    .map(sourceId => sourceWorkspaces[sourceId])
    .filter(workspaceKey => typeof workspaceKey === 'string' && workspaceKey)
    .map(workspaceKey => workspaceAlias(workspaceKey))
  return [...new Set(aliases)].sort()
}

/** @param {any} scope */
function cloneScope(scope) {
  return {
    ...(scope.paths?.length ? { paths: [...scope.paths] } : {}),
    ...(scope.tags?.length ? { tags: [...scope.tags] } : {}),
  }
}

/**
 * SQL establishes the complete Agent/workspace/outcome/feedback boundary before
 * any Case body is expanded. The result is a derived projection, never stored.
 * @param {import('../store/db.js').DecisionDatabase} store
 * @param {{agentId:string,workspaceKey:string,scope:object,excludeCaseId?:string}} input
 */
export function readL3Memory(store, input) {
  const rows = store.db.prepare(`SELECT cases.* FROM cases
    WHERE cases.agent_id=? AND cases.workspace_key=?
      AND cases.state='closed' AND cases.closing='answered'
      AND cases.feedback_state='none' AND cases.needs_review=0
      AND (? IS NULL OR cases.case_id<>?)
      AND NOT EXISTS (
        SELECT 1 FROM corrections AS correction, json_each(correction.supersedes_json) AS superseded
        WHERE correction.agent_id=cases.agent_id AND superseded.value=cases.case_id
      )
    ORDER BY cases.created_at DESC,cases.case_id DESC`).all(
    input.agentId, input.workspaceKey, input.excludeCaseId ?? null, input.excludeCaseId ?? null,
  )
  const episodes = []
  for (const row of rows) {
    const source = caseOf(row)
    if (!scopeCovers(source.scope, input.scope, input.workspaceKey)) continue
    const episode = episodeOf(source)
    if (episode) episodes.push(episode)
  }
  return deepFreeze(episodes)
}

/** @param {ReturnType<typeof caseOf>} source */
function episodeOf(source) {
  const decision = source.decision
  const questions = source.request?.questions
  if (decision?.kind !== 'answer' || !Array.isArray(decision.answers) || !Array.isArray(questions) || questions.length === 0) return null
  if (decision.answers.length !== questions.length) return null
  let answers
  try {
    answers = decision.answers.map(parseAnswerItem)
  } catch (error) {
    if (error instanceof DecisionContractError) return null
    throw error
  }
  if (answers.some((answer, index) => answer.id !== questions[index]?.id)) return null

  const answerLines = answers.map(answer => {
    const values = [...answer.selected, ...(answer.custom === undefined ? [] : [answer.custom])]
    return `Answer ${answer.id}: ${values.join(', ')}`
  })
  const questionLines = questions.map(question => `Question ${question.id}: ${question.question}`)
  return {
    schemaVersion: L3_MEMORY_VERSION,
    kind: 'neutral_agent_answer',
    sourceCaseId: source.caseId,
    sourceRevision: source.revision,
    scope: source.scope,
    excerpt: [...answerLines, ...questionLines].join('\n').slice(0, L3_EXCERPT_LIMIT),
    createdAt: source.createdAt,
    closedAt: source.closedAt,
  }
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
