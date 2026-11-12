// Host-internal public source projection, redaction and content scan.
//
// This is the only port through which eligible records from several workspaces
// reach public extraction. It returns a closed field whitelist, an opaque
// workspace alias per source, bounded redacted excerpts and the per-source
// versions needed to revalidate later. It never reads session logs, raw JSON,
// absolute paths or unrelated records.
import { DecisionContractError } from '../contracts.js'
import { LEARNING_LIMITS } from './constraints.js'
import { publicSourceHighWater, workspaceAlias } from './namespace.js'

export const PUBLIC_SOURCE_FIELDS = Object.freeze([
  'sourceId', 'kind', 'alias', 'createdAt', 'closing', 'feedbackState', 'revision', 'scope', 'excerpt',
])
export const PUBLIC_EXCERPT_LIMIT = 600
export const PUBLIC_PREVIEW_LIMIT = 240

export const PUBLIC_CONSOLIDATION_SYSTEM = `Decision public consolidation contract v1
Produce only one JSON object: {"operations":[...]}.
Use only add, refine, merge, narrow, or retire. Every operation may contain only op, principleId, targetPrincipleIds, text, scope, sources, and inputFeedbackIds.
Public sources come from several workspaces. Every source id must be one of the frozen sources in this input. Every operation scope is workspace-agnostic: optional paths and tags only, never a workspace list.
add requires text, scope, and authoritative sources. refine requires an existing principleId, text, and sources; it may narrow but never widen scope. merge requires at least two existing targetPrincipleIds, text, and scope. narrow requires an existing principleId and a smaller scope. retire requires only an existing principleId.
Every source must cover the complete principle scope inside the workspace it came from. Return no operations when no supported change exists.
Never put absolute file paths, workspace paths, Case ids, Evidence ids, or Feedback ids into principle text; refer to sources only through the sources field.`

// Deterministic absolute-path shapes. Candidate text and source excerpts must
// never carry one of them.
const ABSOLUTE_PATH_PATTERNS = Object.freeze([
  /file:\/\/[^\s"'`<>]+/g,
  /\\\\[^\s"'`<>\\]+(?:\\[^\s"'`<>\\]+)+/g,
  /[A-Za-z]:\\[^\s"'`<>]+/g,
  /~\/[^\s"'`<>]*/g,
  /(?<![\w.:])\/(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]*/g,
])
const RECORD_ID = /\b(?:dc|ev|fb|lr|ms)_[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g

/** Replace every absolute path shape with the `<path>` marker. */
export function redactPublicText(text) {
  if (typeof text !== 'string') return ''
  let value = text.replaceAll('\r\n', '\n')
  for (const pattern of ABSOLUTE_PATH_PATTERNS) value = value.replace(pattern, '<path>')
  return value
}

/**
 * Deterministic scan of public candidate text. `allowedIds` are the frozen
 * source ids of this run: any other record id is foreign.
 * @param {string} text @param {string[]} [allowedIds]
 */
export function publicContentIssues(text, allowedIds = []) {
  if (typeof text !== 'string' || !text) return [{ code: 'INVALID_TEXT' }]
  const issues = []
  if (redactPublicText(text) !== text) issues.push({ code: 'ABSOLUTE_PATH' })
  const allowed = new Set(allowedIds)
  for (const match of text.matchAll(RECORD_ID)) {
    if (!allowed.has(match[0])) issues.push({ code: 'FOREIGN_RECORD_ID' })
  }
  return issues
}

/** Bound and redact one excerpt. Slicing first keeps the byte bound exact. */
export function publicExcerpt(text) {
  return redactPublicText(String(text ?? '')).slice(0, PUBLIC_EXCERPT_LIMIT)
}

/**
 * One alias group: opaque workspace token, source counts by kind and the
 * bounded redacted preview the review surface may show instead of the record.
 * @param {Map<string, any>} groups @param {string} alias @param {'case'|'correction'} kind @param {any} source
 */
function addToGroup(groups, alias, kind, source) {
  const group = groups.get(alias) ?? { alias, count: 0, kinds: { case: 0, correction: 0 }, preview: '' }
  group.count += 1
  group.kinds[kind] += 1
  const excerpt = kind === 'case' ? caseAnswerExcerpt(source) : publicExcerpt(source.direction)
  if (!group.preview) group.preview = excerpt.slice(0, PUBLIC_PREVIEW_LIMIT)
  groups.set(alias, group)
}

/** @param {{paths?:string[],tags?:string[]}} scope */
function scopeHints(scope) {
  return {
    ...(scope?.paths?.length ? { paths: [...scope.paths] } : {}),
    ...(scope?.tags?.length ? { tags: [...scope.tags] } : {}),
  }
}

/**
 * The review preview never carries a question: a bounded answer/correction
 * excerpt is enough to judge the principle without exposing a foreign题面.
 * @param {any} sourceCase
 */
function caseAnswerExcerpt(sourceCase) {
  const answers = (sourceCase.decision?.answers ?? []).map(answer => {
    const selected = [...(answer.selected ?? []), ...(answer.custom === undefined ? [] : [answer.custom])].join(', ')
    return `Answer ${answer.id}: ${selected}`
  })
  return publicExcerpt(answers.join('\n'))
}

/** @param {any} sourceCase */
function caseExcerpt(sourceCase) {
  const request = sourceCase.request ?? { questions: [] }
  const decision = sourceCase.decision ?? {}
  const questions = (request.questions ?? []).map(question => `Question ${question.id}: ${question.question}`)
  const answers = (decision.answers ?? []).map(answer => {
    const selected = [...(answer.selected ?? []), ...(answer.custom === undefined ? [] : [answer.custom])].join(', ')
    return `Answer ${answer.id}: ${selected}`
  })
  return publicExcerpt([...questions, ...answers].join('\n'))
}

/**
 * Project frozen public sources. `cases` and `corrections` are authoritative
 * case records; `feedbackById` supplies the correction feedback revisions.
 * @param {{agentId:string,cases:any[],corrections?:any[],feedback?:any[]}} input
 */
export function projectPublicSources(input) {
  const corrections = input.corrections ?? []
  const feedbackById = Object.fromEntries((input.feedback ?? []).map(value => [value.feedbackId, value]))
  const workspaceKeyOf = record => /** @type {string} */ (record.workspaceKey)
  const sources = []
  const sourceWorkspaces = {}
  const revisions = {}
  const groups = new Map()

  for (const sourceCase of input.cases) {
    if (sources.length >= LEARNING_LIMITS.cases) throw new DecisionContractError('LEARNING_INPUT_TOO_LARGE', `At most ${LEARNING_LIMITS.cases} Cases can be learned at once`)
    const workspaceKey = workspaceKeyOf(sourceCase)
    const alias = workspaceAlias(workspaceKey)
    sources.push({
      sourceId: sourceCase.caseId, kind: 'case', alias,
      createdAt: sourceCase.createdAt, closing: sourceCase.closing, feedbackState: sourceCase.feedbackState,
      revision: sourceCase.revision, scope: scopeHints(sourceCase.scope), excerpt: caseExcerpt(sourceCase),
    })
    sourceWorkspaces[sourceCase.caseId] = workspaceKey
    revisions[sourceCase.caseId] = sourceCase.revision
    addToGroup(groups, alias, 'case', sourceCase)
  }
  for (const correction of corrections) {
    if (sources.length >= LEARNING_LIMITS.cases + LEARNING_LIMITS.feedback) throw new DecisionContractError('LEARNING_INPUT_TOO_LARGE', `At most ${LEARNING_LIMITS.feedback} Feedback sources can be learned at once`)
    const feedback = feedbackById[correction.feedbackId]
    const workspaceKey = workspaceKeyOf(correction.caseRecord)
    const alias = workspaceAlias(workspaceKey)
    sources.push({
      sourceId: correction.feedbackId, kind: 'correction', alias,
      createdAt: correction.createdAt, closing: correction.caseRecord.closing, feedbackState: correction.caseRecord.feedbackState,
      revision: feedback.revision, scope: scopeHints(correction.scope),
      excerpt: publicExcerpt(correction.direction),
    })
    sourceWorkspaces[correction.feedbackId] = workspaceKey
    revisions[correction.feedbackId] = feedback.revision
    addToGroup(groups, alias, 'correction', correction)
  }
  const workspaces = [...groups.values()].sort((left, right) => left.alias.localeCompare(right.alias))
  return {
    sources,
    workspaces,
    sourceWorkspaces,
    revisions,
    highWater: publicSourceHighWater(sources),
  }
}

/**
 * The exact model input for one public run: aliases, hints, bounded redacted
 * excerpts and the parent public Snapshot. No raw record or workspace path.
 * @param {{agentId:string,sourceSet:ReturnType<typeof projectPublicSources>,parentSnapshot:any}} input
 */
export function projectPublicLearningInput(input) {
  return {
    schemaVersion: 1,
    zone: 'public',
    agentId: input.agentId,
    workspaceAliases: input.sourceSet.workspaces.map(group => ({ alias: group.alias, count: group.count })),
    sources: input.sourceSet.sources.map(source => ({
      sourceId: source.sourceId, kind: source.kind, alias: source.alias,
      createdAt: source.createdAt, closing: source.closing, feedbackState: source.feedbackState,
      revision: source.revision, scope: source.scope, excerpt: source.excerpt,
    })),
    parentSnapshot: input.parentSnapshot ? {
      snapshotId: input.parentSnapshot.snapshotId,
      revision: input.parentSnapshot.revision,
      principles: input.parentSnapshot.principles,
    } : null,
  }
}
