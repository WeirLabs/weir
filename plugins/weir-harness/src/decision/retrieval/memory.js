// Versioned, read-only memory projections for one Decision Attempt.
import { DecisionContractError, parseAnswerItem } from '../contracts.js'
import { caseOf } from '../store/cases.js'
import { scopeCovers } from '../store/evidence.js'

export const L2_MEMORY_VERSION = 1
export const L3_MEMORY_VERSION = 1
const L3_EXCERPT_LIMIT = 600

/**
 * P2 deliberately has no semantic-memory reader. Arguments are accepted for a
 * stable adapter shape, but no store object is inspected and no Snapshot or
 * Learning Run table can be read or written through this path.
 */
export function readL2Memory() {
  return deepFreeze({ schemaVersion: L2_MEMORY_VERSION, status: 'empty', snapshotId: null, items: [] })
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
