// Versioned Learning Run and Memory Snapshot persistence on Decision schema v2.
//
// Both records live in an explicit namespace: `zone='workspace'` plus the
// workspace that owns them, or `zone='public'` with no workspace at all. Version
// sequences, current snapshots and active-run exclusivity are per namespace, so a
// public candidate and a private run never block each other.
import { createHash, randomUUID } from 'node:crypto'
import {
  assertClosedObject, assertObject, assertSupportedSchemaVersion, canonicalJson, DecisionContractError,
} from '../contracts.js'
import { ZONES } from './schema.js'
import { LEARNING_LIMITS, validateLearningScope } from '../learning/constraints.js'
export { LEARNING_LIMITS, validateLearningScope } from '../learning/constraints.js'
import { PRIVATE_ZONE, PUBLIC_ZONE, publicPrincipleScopeForWorkspace, workspaceAlias } from '../learning/namespace.js'
import { projectPublicLearningInput, projectPublicSources, publicContentIssues } from '../learning/public.js'
import { caseOf } from './cases.js'
import { projectLearningRecords } from '../learning/consolidator.js'

export const LEARNING_OUTCOMES = Object.freeze(['running', 'candidate', 'published', 'rejected', 'rolled_back', 'failed'])
export const SNAPSHOT_STATES = Object.freeze(['draft', 'published', 'rolled_back'])
export const PRINCIPLE_STATES = Object.freeze(['active', 'contested', 'retired'])
const TRIGGERS = Object.freeze(['manual', 'schedule', 'threshold', 'refresh'])
const OPERATIONS = Object.freeze(['add', 'refine', 'merge', 'narrow', 'retire'])
const OPERATION_FIELDS = Object.freeze(['op', 'principleId', 'targetPrincipleIds', 'text', 'scope', 'sources', 'inputFeedbackIds'])
const INPUT_FIELDS = Object.freeze([
  'requestId', 'workspaceKey', 'startedAt', 'agentProfileRevision', 'caseIds', 'feedbackIds', 'revisions',
  'feedbackDigest', 'parentSnapshotId', 'parentSnapshotRevision', 'promptVersion', 'modelRoute', 'inputHash',
])
// Public runs additionally freeze their workspace-agnostic source lineage. The
// private frozen shape is unchanged, so pre-Phase-B rows stay readable as-is.
const PUBLIC_INPUT_FIELDS = Object.freeze(['zone', 'sourceHighWater', 'workspaceAliases', 'sourceWorkspaces'])
const ALIAS = /^origin_[a-f0-9]{12}$/
const HEX_256 = /^[a-f0-9]{64}$/
const REPLAY_DETAILS = new Set([
  'NO_CANDIDATE_CHANGES', 'INTERRUPTED', 'MODEL_TIMEOUT', 'MODEL_ERROR', 'ROUTE_UNAVAILABLE',
  'CANDIDATE_TOO_LARGE', 'INVALID_CANDIDATE_JSON', 'INVALID_CANDIDATE', 'TOO_MANY_OPERATIONS',
  'TEMPORARY_ID_CONFLICT', 'UNKNOWN_TARGET', 'UNKNOWN_OPERATION', 'UNKNOWN_FIELD', 'MISSING_FIELD',
  'INVALID_OBJECT', 'INVALID_TEXT', 'INVALID_PRINCIPLE', 'INVALID_RECORD', 'INVALID_LEARNING_OPERATION',
  'INVALID_MERGE', 'MERGE_LINEAGE', 'NARROW_LINEAGE', 'MISSING_AUTHORITY_SOURCE',
  'SOURCE_SCOPE_MISMATCH', 'AUTHORITY_CONFLICT', 'INVALID_AUTHORITY_SOURCE', 'UNKNOWN_FEEDBACK',
  'SCOPE_EXPANSION', 'SCOPE_NOT_NARROWED', 'TARGET_NOT_ACTIVE', 'DUPLICATE_TARGET', 'CYCLIC_TARGET',
  'DUPLICATE_PRINCIPLE', 'TOO_MANY_PRINCIPLES', 'NON_DETERMINISTIC_REPLAY',
  'STRUCTURAL_REPLAY_FAILED', 'LEARNING_INPUT_TOO_LARGE', 'STALE_PARENT_SNAPSHOT', 'STALE_SOURCE',
  'CONSOLIDATION_ERROR', 'PUBLIC_CONTENT_REJECTED',
])

/** @param {unknown} value @param {string} label */
function parseJson(value, label) {
  if (typeof value !== 'string') throw new DecisionContractError('INVALID_RECORD', `${label} must be JSON text`)
  try { return JSON.parse(value) } catch {
    throw new DecisionContractError('INVALID_RECORD', `${label} is not valid JSON`)
  }
}

/** @param {unknown} value @param {string} label */
function requiredId(value, label) {
  if (typeof value !== 'string' || !value || value.length > 200) throw new DecisionContractError('INVALID_RECORD', `${label} is required`)
  return value
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new DecisionContractError('INVALID_RECORD', `${label} must be a positive integer`)
  return value
}

/** @param {unknown} value @param {string} label */
function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new DecisionContractError('INVALID_RECORD', `${label} must be a timestamp`)
  return value
}

/** @param {unknown} value @param {string} label @param {number} [limit] */
function idArray(value, label, limit = 256) {
  if (!Array.isArray(value) || value.length > limit || value.some(entry => typeof entry !== 'string' || !entry || entry.length > 200)) {
    throw new DecisionContractError('INVALID_RECORD', `${label} must be a bounded string array`)
  }
  if (new Set(value).size !== value.length) throw new DecisionContractError('INVALID_RECORD', `${label} must not contain duplicates`)
  return value
}

/** @param {unknown} value @param {string} label */
function hash(value, label) {
  if (typeof value !== 'string' || !HEX_256.test(value)) throw new DecisionContractError('INVALID_RECORD', `${label} must be a SHA-256 digest`)
  return value
}


/**
 * Reads the explicit namespace off a persisted row. A workspace-zone row must
 * name exactly one workspace and a public-zone row must name none: that pair is
 * the whole reason SQLite NULL-distinct semantics cannot be used as the key.
 * @param {any} row @param {string} label
 * @returns {{zone:string, namespaceWorkspaceKey:string|null}}
 */
function namespaceOf(row, label) {
  const zone = row.zone
  if (!ZONES.includes(zone)) throw new DecisionContractError('INVALID_NAMESPACE', `${label}.zone ${String(zone)} is not supported`)
  const namespaceWorkspaceKey = row.namespace_workspace_key ?? null
  if (zone === 'workspace') {
    if (typeof namespaceWorkspaceKey !== 'string' || !namespaceWorkspaceKey) {
      throw new DecisionContractError('INVALID_NAMESPACE', `${label} workspace zone requires a namespace workspace key`)
    }
  } else if (namespaceWorkspaceKey !== null) {
    throw new DecisionContractError('INVALID_NAMESPACE', `${label} public zone must not name a workspace`)
  }
  return { zone, namespaceWorkspaceKey }
}

/** @param {unknown} value @param {'workspace'|'public'} [zone] */
export function validatePrinciple(value, zone = PRIVATE_ZONE) {
  const principle = assertClosedObject(value, ['principleId', 'text', 'scope', 'sources', 'state'], ['principleId', 'text', 'scope', 'sources', 'state'], 'MemorySnapshot.principle')
  requiredId(principle.principleId, 'Principle.principleId')
  if (typeof principle.text !== 'string' || !principle.text || principle.text.length > 600) {
    throw new DecisionContractError('INVALID_PRINCIPLE', 'Principle.text must contain 1..600 characters')
  }
  if (!PRINCIPLE_STATES.includes(principle.state)) throw new DecisionContractError('INVALID_PRINCIPLE_STATE', String(principle.state))
  idArray(principle.sources, 'Principle.sources', 256)
  validateLearningScope(principle.scope, 'Principle.scope', zone)
  return principle
}

/** @param {unknown} value @param {'workspace'|'public'} [zone] */
function validateOperation(value, zone = PRIVATE_ZONE) {
  const operation = assertClosedObject(value, OPERATION_FIELDS, ['op'], 'LearningRun.operation')
  if (!OPERATIONS.includes(operation.op)) throw new DecisionContractError('INVALID_LEARNING_OPERATION', String(operation.op))
  requiredId(operation.principleId, 'LearningRun.operation.principleId')
  if (operation.inputFeedbackIds !== undefined) idArray(operation.inputFeedbackIds, 'LearningRun.operation.inputFeedbackIds')
  const textRequired = ['add', 'refine', 'merge'].includes(operation.op)
  if (textRequired && (typeof operation.text !== 'string' || !operation.text || operation.text.length > 600)) {
    throw new DecisionContractError('INVALID_LEARNING_OPERATION', `${operation.op}.text must contain 1..600 characters`)
  }
  if (!textRequired && operation.text !== undefined) throw new DecisionContractError('INVALID_LEARNING_OPERATION', `${operation.op}.text is not allowed`)
  if (['add', 'refine', 'merge', 'narrow'].includes(operation.op)) validateLearningScope(operation.scope, `LearningRun.${operation.op}.scope`, zone)
  else if (operation.scope !== undefined) throw new DecisionContractError('INVALID_LEARNING_OPERATION', 'retire.scope is not allowed')
  if (['add', 'refine', 'merge'].includes(operation.op)) idArray(operation.sources, `LearningRun.${operation.op}.sources`)
  else if (operation.sources !== undefined) idArray(operation.sources, `LearningRun.${operation.op}.sources`)
  if (operation.op === 'merge') idArray(operation.targetPrincipleIds, 'LearningRun.merge.targetPrincipleIds', 128)
  else if (operation.targetPrincipleIds !== undefined) throw new DecisionContractError('INVALID_LEARNING_OPERATION', `${operation.op}.targetPrincipleIds is not allowed`)
  return operation
}

/** @param {unknown} value @param {'workspace'|'public'} [zone] */
function validateInputFrozen(value, zone = PRIVATE_ZONE) {
  const input = assertClosedObject(value, [...INPUT_FIELDS, ...PUBLIC_INPUT_FIELDS], INPUT_FIELDS, 'LearningRun.inputFrozen')
  requiredId(input.requestId, 'LearningRun.inputFrozen.requestId')
  if (zone === PUBLIC_ZONE) {
    if (input.zone !== PUBLIC_ZONE || input.workspaceKey !== null) {
      throw new DecisionContractError('INVALID_NAMESPACE', 'a public frozen input must name the public zone and no workspace')
    }
  } else {
    if (input.zone !== undefined && input.zone !== PRIVATE_ZONE) throw new DecisionContractError('INVALID_NAMESPACE', String(input.zone))
    requiredId(input.workspaceKey, 'LearningRun.inputFrozen.workspaceKey')
  }
  timestamp(input.startedAt, 'LearningRun.inputFrozen.startedAt')
  positiveInteger(input.agentProfileRevision, 'LearningRun.inputFrozen.agentProfileRevision')
  idArray(input.caseIds, 'LearningRun.inputFrozen.caseIds', LEARNING_LIMITS.cases)
  idArray(input.feedbackIds, 'LearningRun.inputFrozen.feedbackIds', LEARNING_LIMITS.feedback)
  hash(input.feedbackDigest, 'LearningRun.inputFrozen.feedbackDigest')
  hash(input.inputHash, 'LearningRun.inputFrozen.inputHash')
  if (input.promptVersion !== 'consolidation-contract/1') throw new DecisionContractError('INVALID_PROMPT_VERSION', String(input.promptVersion))
  if (input.parentSnapshotId !== null) requiredId(input.parentSnapshotId, 'LearningRun.inputFrozen.parentSnapshotId')
  if (input.parentSnapshotRevision !== null) positiveInteger(input.parentSnapshotRevision, 'LearningRun.inputFrozen.parentSnapshotRevision')
  if ((input.parentSnapshotId === null) !== (input.parentSnapshotRevision === null)) {
    throw new DecisionContractError('INVALID_RECORD', 'parent Snapshot id and revision must both be null or populated')
  }
  const revisions = assertObject(input.revisions, 'LearningRun.inputFrozen.revisions')
  const expectedRevisions = new Set([...input.caseIds, ...input.feedbackIds])
  if (Object.keys(revisions).length !== expectedRevisions.size) throw new DecisionContractError('INVALID_RECORD', 'LearningRun.inputFrozen.revisions must exactly cover frozen records')
  for (const [id, revision] of Object.entries(revisions)) {
    if (!expectedRevisions.has(id)) throw new DecisionContractError('INVALID_RECORD', 'LearningRun.inputFrozen.revisions contains an unfrozen record')
    positiveInteger(revision, `LearningRun.inputFrozen.revisions.${id}`)
  }
  if (zone === PUBLIC_ZONE) validatePublicFrozenLineage(input)
  const route = assertClosedObject(input.modelRoute, ['kind', 'provider', 'model', 'reasoningEffort', 'reason'], ['kind'], 'LearningRun.inputFrozen.modelRoute')
  if (!['inherited', 'resolved', 'unavailable'].includes(route.kind)) throw new DecisionContractError('INVALID_MODEL_ROUTE', String(route.kind))
  if (route.kind !== 'unavailable') {
    requiredId(route.provider, 'LearningRun.inputFrozen.modelRoute.provider')
    requiredId(route.model, 'LearningRun.inputFrozen.modelRoute.model')
  }
  if (route.reasoningEffort !== undefined) requiredId(route.reasoningEffort, 'LearningRun.inputFrozen.modelRoute.reasoningEffort')
  if (route.reason !== undefined && (typeof route.reason !== 'string' || route.reason.length > 200)) throw new DecisionContractError('INVALID_MODEL_ROUTE', 'route.reason must be bounded text')
  return input
}

/**
 * A public frozen input carries lineage for every frozen source: the opaque
 * alias groups shown to the model and the origin workspace used only for
 * host-internal revalidation. Neither may be replaced by a sentinel.
 * @param {any} input
 */
function validatePublicFrozenLineage(input) {
  hash(input.sourceHighWater, 'LearningRun.inputFrozen.sourceHighWater')
  const aliases = input.workspaceAliases
  if (!Array.isArray(aliases) || aliases.length > 128) throw new DecisionContractError('INVALID_RECORD', 'LearningRun.inputFrozen.workspaceAliases must be a bounded array')
  const seen = new Set()
  for (const group of aliases) {
    const value = assertClosedObject(group, ['alias', 'count', 'kinds', 'preview'], ['alias', 'count'], 'LearningRun.inputFrozen.workspaceAliases[]')
    if (typeof value.alias !== 'string' || !ALIAS.test(value.alias) || seen.has(value.alias)) throw new DecisionContractError('INVALID_RECORD', 'public workspace aliases must be unique opaque tokens')
    seen.add(value.alias)
    positiveInteger(value.count, 'LearningRun.inputFrozen.workspaceAliases[].count')
    if (value.kinds !== undefined) {
      const kinds = assertClosedObject(value.kinds, ['case', 'correction'], ['case', 'correction'], 'LearningRun.inputFrozen.workspaceAliases[].kinds')
      for (const [key, count] of Object.entries(kinds)) {
        if (!Number.isSafeInteger(count) || count < 0) throw new DecisionContractError('INVALID_RECORD', `public alias kinds.${key} must be a count`)
      }
      if (kinds.case + kinds.correction !== value.count) throw new DecisionContractError('INVALID_RECORD', 'public alias kind counts must sum to the group count')
    }
    if (value.preview !== undefined && (typeof value.preview !== 'string' || value.preview.length > 240)) {
      throw new DecisionContractError('INVALID_RECORD', 'public alias preview must be bounded text')
    }
  }
  const expected = new Set([...input.caseIds, ...input.feedbackIds])
  const sourceWorkspaces = assertObject(input.sourceWorkspaces, 'LearningRun.inputFrozen.sourceWorkspaces')
  if (Object.keys(sourceWorkspaces).length !== expected.size) throw new DecisionContractError('INVALID_RECORD', 'LearningRun.inputFrozen.sourceWorkspaces must exactly cover frozen sources')
  const aliasesSeen = new Set()
  for (const [sourceId, workspaceKey] of Object.entries(sourceWorkspaces)) {
    if (!expected.has(sourceId)) throw new DecisionContractError('INVALID_RECORD', 'LearningRun.inputFrozen.sourceWorkspaces contains an unfrozen source')
    requiredId(workspaceKey, `LearningRun.inputFrozen.sourceWorkspaces.${sourceId}`)
    aliasesSeen.add(workspaceAlias(workspaceKey))
  }
  if (aliasesSeen.size !== seen.size || [...aliasesSeen].some(alias => !seen.has(alias))) {
    throw new DecisionContractError('INVALID_RECORD', 'public alias groups must match the frozen source workspaces')
  }
}

/** @param {unknown} value */
function validateReplay(value) {
  const replay = assertClosedObject(value, ['passed', 'metrics', 'detail', 'finalHash'], ['passed', 'metrics'], 'LearningRun.replay')
  if (typeof replay.passed !== 'boolean') throw new DecisionContractError('INVALID_RECORD', 'LearningRun.replay.passed must be boolean')
  const metrics = assertClosedObject(replay.metrics, ['operationCount', 'sourceCount', 'activePrincipleCount', 'retiredPrincipleCount'], ['operationCount', 'sourceCount', 'activePrincipleCount', 'retiredPrincipleCount'], 'LearningRun.replay.metrics')
  for (const [key, count] of Object.entries(metrics)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new DecisionContractError('INVALID_RECORD', `LearningRun.replay.metrics.${key} must be a count`)
  }
  if (replay.detail !== undefined && (typeof replay.detail !== 'string' || !REPLAY_DETAILS.has(replay.detail))) {
    throw new DecisionContractError('INVALID_RECORD', 'LearningRun.replay.detail must be a closed failure code')
  }
  if (replay.finalHash !== undefined) hash(replay.finalHash, 'LearningRun.replay.finalHash')
  return replay
}

/** @param {any} row */
export function learningRunOf(row) {
  if (!row) throw new DecisionContractError('LEARNING_RUN_NOT_FOUND')
  assertSupportedSchemaVersion(row.schema_version, 'LearningRun')
  if (!LEARNING_OUTCOMES.includes(row.outcome)) throw new DecisionContractError('INVALID_LEARNING_OUTCOME', String(row.outcome))
  if (!TRIGGERS.includes(row.trigger)) throw new DecisionContractError('INVALID_LEARNING_TRIGGER', String(row.trigger))
  const namespace = namespaceOf(row, 'LearningRun')
  const inputFrozen = validateInputFrozen(parseJson(row.input_frozen_json, 'LearningRun.inputFrozen'), namespace.zone)
  const operations = parseJson(row.operations_json, 'LearningRun.operations')
  if (!Array.isArray(operations) || operations.length > LEARNING_LIMITS.operations) throw new DecisionContractError('INVALID_RECORD', 'LearningRun.operations must be a bounded array')
  operations.forEach(operation => validateOperation(operation, namespace.zone))
  const replay = row.replay_json == null ? undefined : validateReplay(parseJson(row.replay_json, 'LearningRun.replay'))
  return deepFreeze({
    schemaVersion: row.schema_version,
    learningRunId: requiredId(row.learning_run_id, 'LearningRun.learningRunId'),
    agentId: requiredId(row.agent_id, 'LearningRun.agentId'), trigger: row.trigger,
    zone: namespace.zone, namespaceWorkspaceKey: namespace.namespaceWorkspaceKey,
    inputFrozen, operations, ...(replay === undefined ? {} : { replay }), outcome: row.outcome,
    revision: positiveInteger(row.revision, 'LearningRun.revision'),
    createdAt: timestamp(row.created_at, 'LearningRun.createdAt'), updatedAt: timestamp(row.updated_at, 'LearningRun.updatedAt'),
  })
}

/** @param {any} row */
export function memorySnapshotOf(row) {
  if (!row) throw new DecisionContractError('SNAPSHOT_NOT_FOUND')
  assertSupportedSchemaVersion(row.schema_version, 'MemorySnapshot')
  if (!SNAPSHOT_STATES.includes(row.state)) throw new DecisionContractError('INVALID_SNAPSHOT_STATE', String(row.state))
  const namespace = namespaceOf(row, 'MemorySnapshot')
  const principles = parseJson(row.principles_json, 'MemorySnapshot.principles')
  if (!Array.isArray(principles) || principles.length > LEARNING_LIMITS.principles) throw new DecisionContractError('INVALID_RECORD', 'MemorySnapshot.principles must be a bounded array')
  principles.forEach(principle => validatePrinciple(principle, namespace.zone))
  if (new Set(principles.map(principle => principle.principleId)).size !== principles.length) throw new DecisionContractError('INVALID_RECORD', 'MemorySnapshot principle ids must be unique')
  const generatedDescription = assertClosedObject(parseJson(row.generated_description_json, 'MemorySnapshot.generatedDescription'), ['revision', 'text'], ['revision', 'text'], 'MemorySnapshot.generatedDescription')
  if (generatedDescription.revision !== 0 || generatedDescription.text !== '') {
    throw new DecisionContractError('GENERATED_DESCRIPTION_READONLY', 'P3 generatedDescription must remain empty and read-only')
  }
  const value = {
    schemaVersion: row.schema_version,
    snapshotId: requiredId(row.snapshot_id, 'MemorySnapshot.snapshotId'),
    agentId: requiredId(row.agent_id, 'MemorySnapshot.agentId'),
    zone: namespace.zone, namespaceWorkspaceKey: namespace.namespaceWorkspaceKey,
    version: positiveInteger(row.version, 'MemorySnapshot.version'),
    parentSnapshotId: row.parent_snapshot_id ?? null, state: row.state, principles,
    generatedDescription, learningRunId: requiredId(row.learning_run_id, 'MemorySnapshot.learningRunId'),
    revision: positiveInteger(row.revision, 'MemorySnapshot.revision'),
    createdAt: timestamp(row.created_at, 'MemorySnapshot.createdAt'), updatedAt: timestamp(row.updated_at, 'MemorySnapshot.updatedAt'),
  }
  if (value.parentSnapshotId !== null) requiredId(value.parentSnapshotId, 'MemorySnapshot.parentSnapshotId')
  const contentHash = createHash('sha256').update(canonicalJson({
    version: value.version, parentSnapshotId: value.parentSnapshotId,
    principles: value.principles, generatedDescription: value.generatedDescription,
    learningRunId: value.learningRunId,
  })).digest('hex')
  return deepFreeze({ ...value, contentHash })
}

export class DecisionLearning {
  /** @param {import('./db.js').DecisionDatabase} store @param {{now?:()=>number,evidence?:import('./evidence.js').DecisionEvidence}} [options] */
  constructor(store, options = {}) { this.store = store; this.now = options.now ?? Date.now; this.evidence = options.evidence }

  /** @param {string} agentId @param {string} learningRunId */
  getRun(agentId, learningRunId) {
    return learningRunOf(this.store.db.prepare('SELECT * FROM learning_runs WHERE agent_id=? AND learning_run_id=?').get(agentId, learningRunId))
  }

  /** @param {string} learningRunId */
  getRunById(learningRunId) {
    return learningRunOf(this.store.db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(learningRunId))
  }

  /** @param {string} agentId @param {string} snapshotId */
  getSnapshot(agentId, snapshotId) {
    return memorySnapshotOf(this.store.db.prepare('SELECT * FROM memory_snapshots WHERE agent_id=? AND snapshot_id=?').get(agentId, snapshotId))
  }

  /** @param {string} snapshotId */
  getSnapshotById(snapshotId) {
    return memorySnapshotOf(this.store.db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(snapshotId))
  }

  /** @param {string} agentId @param {{zone:string,namespaceWorkspaceKey:string|null}} [namespace] */
  listRuns(agentId, namespace) {
    const rows = namespace
      ? this.store.db.prepare('SELECT * FROM learning_runs WHERE agent_id=? AND zone=? AND namespace_workspace_key IS ? ORDER BY created_at DESC,learning_run_id DESC').all(agentId, namespace.zone, namespace.namespaceWorkspaceKey)
      : this.store.db.prepare('SELECT * FROM learning_runs WHERE agent_id=? ORDER BY created_at DESC,learning_run_id DESC').all(agentId)
    return deepFreeze(rows.map(learningRunOf))
  }

  /** @param {string} agentId @param {{zone:string,namespaceWorkspaceKey:string|null}} [namespace] */
  listSnapshots(agentId, namespace) {
    const rows = namespace
      ? this.store.db.prepare('SELECT * FROM memory_snapshots WHERE agent_id=? AND zone=? AND namespace_workspace_key IS ? ORDER BY version DESC,snapshot_id DESC').all(agentId, namespace.zone, namespace.namespaceWorkspaceKey)
      : this.store.db.prepare('SELECT * FROM memory_snapshots WHERE agent_id=? ORDER BY version DESC,snapshot_id DESC').all(agentId)
    assertUniqueSnapshotVersions(rows, agentId)
    return deepFreeze(rows.map(memorySnapshotOf))
  }

  /** The only active public run/candidate for one Agent, if any. */
  activePublicRun(agentId) {
    const row = this.store.db.prepare(`SELECT * FROM learning_runs
      WHERE agent_id=? AND zone='public' AND outcome IN ('running','candidate')
      ORDER BY created_at DESC,learning_run_id DESC LIMIT 1`).get(agentId)
    return row ? learningRunOf(row) : null
  }

  /** The most recent public run, whatever its outcome. */
  lastPublicRun(agentId) {
    const row = this.store.db.prepare(`SELECT * FROM learning_runs WHERE agent_id=? AND zone='public'
      ORDER BY created_at DESC,learning_run_id DESC LIMIT 1`).get(agentId)
    return row ? learningRunOf(row) : null
  }

  /** Frozen input high-water of the most recent public run, or null. */
  lastPublicHighWater(agentId) {
    return this.lastPublicRun(agentId)?.inputFrozen?.sourceHighWater ?? null
  }

  /** @param {string} agentId */
  hasPublicRun(agentId) {
    return Boolean(this.store.db.prepare("SELECT 1 FROM learning_runs WHERE agent_id=? AND zone='public' LIMIT 1").get(agentId))
  }

  /** The current published public Snapshot: the public zone has no workspace. */
  currentPublicSnapshot(agentId) {
    const rows = currentSnapshotRows(this.store.db, agentId, PUBLIC_ZONE, null)
    return rows.length ? memorySnapshotOf(rows[0]) : null
  }

  /**
   * Host-internal public source port. This is the only read path that spans
   * workspaces, and it returns the bounded whitelist projection only.
   * @param {string} agentId
   */
  publicSourceSet(agentId) {
    return deepFreeze(readPublicFreeze(this.store.db, agentId).sourceSet)
  }

  /**
   * Freeze the full eligible source set and insert a running public run before
   * any model call. The public zone owns its own version sequence and its own
   * active-run slot.
   * @param {{agentId:string,requestId:string,startedAt:number,agentProfileRevision:number,modelRoute:object}} input
   */
  async beginPublicRun(input) {
    let result
    await this.store.write(db => {
      const runs = db.prepare("SELECT * FROM learning_runs WHERE agent_id=? AND zone='public'").all(input.agentId).map(learningRunOf)
      const duplicate = runs.find(run => run.inputFrozen.requestId === input.requestId)
      if (duplicate) { result = { created: false, run: duplicate }; return }
      if (runs.some(run => run.outcome === 'running' || run.outcome === 'candidate')) {
        throw new DecisionContractError('LEARNING_RUN_ACTIVE', 'An active public Learning Run or candidate already exists for this Agent')
      }
      const freeze = readPublicFreeze(db, input.agentId)
      const parentRows = currentSnapshotRows(db, input.agentId, PUBLIC_ZONE, null)
      if (parentRows[0]) {
        const rawPrinciples = parseJson(parentRows[0].principles_json, 'MemorySnapshot.principles')
        if (Array.isArray(rawPrinciples) && rawPrinciples.length > LEARNING_LIMITS.principles) throw new DecisionContractError('LEARNING_INPUT_TOO_LARGE', 'At most 128 parent principles can be learned at once')
      }
      const parentSnapshot = parentRows[0] ? memorySnapshotOf(parentRows[0]) : null
      const projection = projectPublicLearningInput({ agentId: input.agentId, sourceSet: freeze.sourceSet, parentSnapshot })
      const inputFrozen = {
        zone: PUBLIC_ZONE, workspaceKey: null, requestId: input.requestId, startedAt: input.startedAt,
        agentProfileRevision: input.agentProfileRevision,
        caseIds: freeze.sourceSet.sources.filter(source => source.kind === 'case').map(source => source.sourceId),
        feedbackIds: freeze.sourceSet.sources.filter(source => source.kind === 'correction').map(source => source.sourceId),
        revisions: { ...freeze.sourceSet.revisions },
        feedbackDigest: createHash('sha256').update(canonicalJson(freeze.sourceSet.sources.filter(source => source.kind === 'correction'))).digest('hex'),
        parentSnapshotId: parentSnapshot?.snapshotId ?? null, parentSnapshotRevision: parentSnapshot?.revision ?? null,
        promptVersion: 'consolidation-contract/1', modelRoute: clone(input.modelRoute),
        inputHash: createHash('sha256').update(canonicalJson(projection)).digest('hex'),
        sourceHighWater: freeze.sourceSet.highWater,
        workspaceAliases: freeze.sourceSet.workspaces.map(group => ({
          alias: group.alias, count: group.count, kinds: { ...group.kinds }, preview: group.preview,
        })),
        sourceWorkspaces: { ...freeze.sourceSet.sourceWorkspaces },
      }
      const learningRunId = `lr_${randomUUID()}`
      const now = input.startedAt
      db.prepare(`INSERT INTO learning_runs(
        learning_run_id,agent_id,zone,namespace_workspace_key,trigger,input_frozen_json,operations_json,
        replay_json,outcome,created_at,updated_at,revision,schema_version
      ) VALUES(?,?,'public',NULL,'refresh',?,?,NULL,'running',?,?,1,1)`).run(
        learningRunId, input.agentId, JSON.stringify(inputFrozen), '[]', now, now,
      )
      result = {
        created: true,
        run: learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(learningRunId)),
        projection, sourceSet: freeze.sourceSet,
        authority: {
          zone: PUBLIC_ZONE, workspaceKey: null, sourceWorkspaces: { ...freeze.sourceSet.sourceWorkspaces },
          caseById: freeze.caseById, feedbackById: freeze.feedbackById, corrections: freeze.corrections,
          parentPrinciples: parentSnapshot?.principles ?? [],
        },
      }
    })
    return result
  }

  /**
   * Use-time revalidation: a public principle is omitted when any of its
   * sources no longer revalidates inside its own origin workspace.
   * @param {any} snapshot
   */
  publicPrincipleIssues(snapshot) {
    const issues = {}
    let run
    try { run = this.getRunById(snapshot.learningRunId) } catch { run = null }
    for (const principle of snapshot.principles) {
      if (principle.state !== 'active') continue
      for (const sourceId of principle.sources) {
        if (!run || !this.evidence || publicSourceIssue(this.store.db, this.evidence, run, sourceId, principle)) {
          issues[principle.principleId] = 'SOURCE_UNAVAILABLE'
          break
        }
      }
    }
    return issues
  }

  /**
   * The current published Snapshot of one namespace. Attempts read the private
   * `(agentId, workspace)` namespace only; the public zone is a separate read.
   * @param {string} agentId @param {string|null} namespaceWorkspaceKey @param {'workspace'|'public'} [zone]
   */
  currentSnapshot(agentId, namespaceWorkspaceKey, zone = 'workspace') {
    const rows = currentSnapshotRows(this.store.db, agentId, zone, namespaceWorkspaceKey)
    if (!rows.length) return null
    return memorySnapshotOf(rows[0])
  }

  /**
   * Read only explicitly reviewed sources, with Agent/workspace authorization
   * independent of the root-scoped general history reader.
   * @param {{agentId:string,workspaceKey:string,sourceIds:string[],revisions?:Record<string,number>}} input
   */
  sourceRecords(input) {
    const sourceIds = [...new Set(input.sourceIds)]
    const limit = LEARNING_LIMITS.cases + LEARNING_LIMITS.feedback
    if (sourceIds.length > limit) throw new DecisionContractError('LEARNING_INPUT_TOO_LARGE', `At most ${limit} unique learning sources can be reviewed`)
    const revisions = input.revisions ?? {}
    const records = []
    for (const sourceId of sourceIds) {
      const caseRow = this.store.db.prepare('SELECT * FROM cases WHERE case_id=? AND agent_id=? AND workspace_key=?').get(sourceId, input.agentId, input.workspaceKey)
      if (caseRow) {
        const projected = projectLearningRecords({
          agentId: input.agentId, workspaceKey: input.workspaceKey, cases: [caseOf(caseRow)], feedback: [],
        }).projection.cases[0]
        records.push({ sourceId, kind: 'case', ...projected, revision: revisions[sourceId] ?? projected.revision })
        continue
      }
      const feedbackRow = this.store.db.prepare(`SELECT feedback.* FROM feedback
        JOIN cases ON cases.case_id=feedback.case_id
        WHERE feedback.feedback_id=? AND feedback.agent_id=? AND feedback.kind='correction'
          AND cases.agent_id=? AND cases.workspace_key=?`).get(sourceId, input.agentId, input.agentId, input.workspaceKey)
      const correctionRow = feedbackRow
        ? this.store.db.prepare('SELECT * FROM corrections WHERE feedback_id=? AND agent_id=?').get(sourceId, input.agentId)
        : undefined
      if (!feedbackRow || !correctionRow) continue
      const projected = projectLearningRecords({
        agentId: input.agentId, workspaceKey: input.workspaceKey, cases: [],
        feedback: [feedbackRecord(feedbackRow)], corrections: [correctionRecord(correctionRow)],
      }).projection.feedback[0]
      records.push({ sourceId, ...projected, revision: revisions[sourceId] ?? projected.revision })
    }
    return deepFreeze(records)
  }

  /** Freeze the actual model input and insert running before any model call. */
  async beginRun(input) {
    let result
    await this.store.write(db => {
      const runs = db.prepare('SELECT * FROM learning_runs WHERE agent_id=?').all(input.agentId).map(learningRunOf)
      // A duplicate request is only a duplicate inside its own namespace: a W2
      // requestId must never return a W1 run.
      const duplicate = runs.find(run => run.zone === 'workspace' && run.namespaceWorkspaceKey === input.workspaceKey
        && run.inputFrozen.requestId === input.requestId)
      if (duplicate) { result = { created: false, run: duplicate }; return }
      if (runs.some(run => run.zone === 'workspace' && run.namespaceWorkspaceKey === input.workspaceKey
        && (run.outcome === 'running' || run.outcome === 'candidate'))) {
        throw new DecisionContractError('LEARNING_RUN_ACTIVE', 'An active Learning Run or candidate already exists for this Agent and workspace')
      }
      const caseRows = db.prepare(`SELECT * FROM cases
        WHERE agent_id=? AND workspace_key=? AND state='closed' AND closing IN ('answered','escalated')
        ORDER BY created_at,case_id`).all(input.agentId, input.workspaceKey)
      if (caseRows.length > LEARNING_LIMITS.cases) throw new DecisionContractError('LEARNING_INPUT_TOO_LARGE', 'At most 128 Cases can be learned at once')
      const cases = caseRows.map(caseOf)
      const caseIds = new Set(cases.map(value => value.caseId))
      const feedbackRows = db.prepare(`SELECT feedback.* FROM feedback
        JOIN cases ON cases.case_id=feedback.case_id
        WHERE feedback.agent_id=? AND cases.workspace_key=?
        ORDER BY feedback.created_at,feedback.feedback_id`).all(input.agentId, input.workspaceKey)
        .filter(row => caseIds.has(row.case_id))
      if (feedbackRows.length > LEARNING_LIMITS.feedback) throw new DecisionContractError('LEARNING_INPUT_TOO_LARGE', 'At most 256 Feedback records can be learned at once')
      const feedback = feedbackRows.map(feedbackRecord)
      const parentRows = currentSnapshotRows(db, input.agentId, 'workspace', input.workspaceKey)
      if (parentRows[0]) {
        const rawPrinciples = parseJson(parentRows[0].principles_json, 'MemorySnapshot.principles')
        if (Array.isArray(rawPrinciples) && rawPrinciples.length > LEARNING_LIMITS.principles) throw new DecisionContractError('LEARNING_INPUT_TOO_LARGE', 'At most 128 parent principles can be learned at once')
      }
      const parentSnapshot = parentRows[0] ? memorySnapshotOf(parentRows[0]) : null
      const feedbackIds = new Set(feedback.map(value => value.feedbackId))
      const corrections = db.prepare('SELECT * FROM corrections WHERE agent_id=? ORDER BY created_at,feedback_id').all(input.agentId)
        .filter(row => feedbackIds.has(row.feedback_id)).map(correctionRecord)
      const frozen = projectLearningRecords({ agentId: input.agentId, workspaceKey: input.workspaceKey, cases, feedback, corrections, parentSnapshot })
      const revisions = Object.fromEntries([
        ...cases.map(value => [value.caseId, value.revision]),
        ...feedback.map(value => [value.feedbackId, value.revision]),
      ])
      const inputFrozen = {
        requestId: input.requestId, workspaceKey: input.workspaceKey, startedAt: input.startedAt,
        agentProfileRevision: input.agentProfileRevision,
        caseIds: cases.map(value => value.caseId), feedbackIds: feedback.map(value => value.feedbackId), revisions,
        feedbackDigest: createHash('sha256').update(canonicalJson(frozen.projection.feedback)).digest('hex'),
        parentSnapshotId: parentSnapshot?.snapshotId ?? null, parentSnapshotRevision: parentSnapshot?.revision ?? null,
        promptVersion: 'consolidation-contract/1', modelRoute: clone(input.modelRoute),
        inputHash: createHash('sha256').update(canonicalJson(frozen.projection)).digest('hex'),
      }
      const learningRunId = `lr_${randomUUID()}`
      const now = input.startedAt
      db.prepare(`INSERT INTO learning_runs(
        learning_run_id,agent_id,zone,namespace_workspace_key,trigger,input_frozen_json,operations_json,
        replay_json,outcome,created_at,updated_at,revision,schema_version
      ) VALUES(?,?,'workspace',?,'manual',?,?,NULL,'running',?,?,1,1)`).run(
        learningRunId, input.agentId, input.workspaceKey, JSON.stringify(inputFrozen), '[]', now, now,
      )
      result = {
        created: true, run: learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(learningRunId)),
        projection: frozen.projection, authority: frozen.authority,
      }
    })
    return result
  }

  /** Atomically persist a validated candidate and its complete immutable draft. */
  async commitCandidate(input) {
    if (input.replay?.passed !== true) throw new DecisionContractError('STRUCTURAL_REPLAY_FAILED', 'Only a passing structural replay can create a draft')
    let result
    await this.store.write(db => {
      const row = db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(input.learningRunId)
      const run = learningRunOf(row)
      if (run.outcome !== 'running' || run.revision !== input.expectedRevision) throw new DecisionContractError('STALE_LEARNING_RUN', run.learningRunId)
      const version = db.prepare(`SELECT COALESCE(MAX(version),0)+1 AS version FROM memory_snapshots
        WHERE agent_id=? AND zone=? AND namespace_workspace_key IS ?`).get(run.agentId, run.zone, run.namespaceWorkspaceKey).version
      const snapshotId = `ms_${randomUUID()}`
      const now = this.now()
      const update = db.prepare(`UPDATE learning_runs SET operations_json=?,replay_json=?,outcome='candidate',revision=revision+1,updated_at=?
        WHERE learning_run_id=? AND outcome='running' AND revision=?`).run(
        JSON.stringify(input.operations), JSON.stringify(input.replay), now, run.learningRunId, run.revision,
      )
      if (update.changes !== 1) throw new DecisionContractError('STALE_LEARNING_RUN', run.learningRunId)
      db.prepare(`INSERT INTO memory_snapshots(
        snapshot_id,agent_id,zone,namespace_workspace_key,version,parent_snapshot_id,state,principles_json,
        generated_description_json,learning_run_id,created_at,updated_at,revision,schema_version
      ) VALUES(?,?,?,?,?,?,'draft',?,?,?, ?,?,1,1)`).run(
        snapshotId, run.agentId, run.zone, run.namespaceWorkspaceKey, version, run.inputFrozen.parentSnapshotId,
        JSON.stringify(input.principles), JSON.stringify({ revision: 0, text: '' }), run.learningRunId, now, now,
      )
      result = {
        run: learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(run.learningRunId)),
        snapshot: memorySnapshotOf(db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(snapshotId)),
      }
    })
    return result
  }

  /** Fail only a still-running result; late completion cannot rewrite it. */
  async failRun(learningRunId, failure, expectedRevision) {
    await this.store.write(db => {
      const replayValue = typeof failure === 'string'
        ? { passed: false, metrics: emptyMetrics(), detail: REPLAY_DETAILS.has(failure) ? failure : 'CONSOLIDATION_ERROR' }
        : { ...failure, ...(failure.detail && !REPLAY_DETAILS.has(failure.detail) ? { detail: 'CONSOLIDATION_ERROR' } : {}) }
      const replay = JSON.stringify(replayValue)
      db.prepare(`UPDATE learning_runs SET outcome='failed',replay_json=?,revision=revision+1,updated_at=?
        WHERE learning_run_id=? AND outcome='running' ${expectedRevision === undefined ? '' : 'AND revision=?'}`).run(
        ...(expectedRevision === undefined ? [replay, this.now(), learningRunId] : [replay, this.now(), learningRunId, expectedRevision]),
      )
    })
    return this.getRunById(learningRunId)
  }

  async publish(snapshotId, expectedRevision) {
    let result
    await this.store.write(db => {
      const snapshot = memorySnapshotOf(db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(snapshotId))
      const run = learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(snapshot.learningRunId))
      if (run.agentId !== snapshot.agentId) throw new DecisionContractError('INVALID_RECORD', 'Snapshot and Learning Run namespaces differ')
      if (snapshot.state === 'published' && run.outcome === 'published') { result = { snapshot, run }; return }
      if (snapshot.state !== 'draft' || run.outcome !== 'candidate') throw new DecisionContractError('SNAPSHOT_STATE_CONFLICT', `${snapshot.state}/${run.outcome}`)
      if (snapshot.revision !== expectedRevision) throw new DecisionContractError('REVISION_CONFLICT', snapshot.snapshotId)
      const currentRows = currentSnapshotRows(db, snapshot.agentId, snapshot.zone, snapshot.namespaceWorkspaceKey)
      const currentId = currentRows[0]?.snapshot_id ?? null
      if (currentId !== snapshot.parentSnapshotId) {
        result = { error: 'STALE_PARENT_SNAPSHOT', run: failCandidate(db, run, 'STALE_PARENT_SNAPSHOT', this.now()) }
        return
      }
      const issue = snapshot.zone === PUBLIC_ZONE
        ? publicPublishIssue(db, run, snapshot, this.evidence)
        : sourcePublishIssue(db, run, snapshot, this.evidence)
      if (issue) {
        result = { error: issue, run: failCandidate(db, run, issue, this.now()) }
        return
      }
      const now = this.now()
      const changed = db.prepare(`UPDATE memory_snapshots SET state='published',revision=revision+1,updated_at=?
        WHERE snapshot_id=? AND state='draft' AND revision=?`).run(now, snapshot.snapshotId, expectedRevision)
      if (changed.changes !== 1) throw new DecisionContractError('REVISION_CONFLICT', snapshot.snapshotId)
      db.prepare(`UPDATE learning_runs SET outcome='published',revision=revision+1,updated_at=?
        WHERE learning_run_id=? AND outcome='candidate'`).run(now, run.learningRunId)
      result = {
        snapshot: memorySnapshotOf(db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(snapshot.snapshotId)),
        run: learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(run.learningRunId)),
      }
    })
    return result
  }

  async reject(snapshotId, expectedRevision) {
    let result
    await this.store.write(db => {
      const snapshot = memorySnapshotOf(db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(snapshotId))
      const run = learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(snapshot.learningRunId))
      if (snapshot.state === 'draft' && run.outcome === 'rejected') { result = { snapshot, run }; return }
      if (snapshot.state !== 'draft' || run.outcome !== 'candidate') throw new DecisionContractError('SNAPSHOT_STATE_CONFLICT', `${snapshot.state}/${run.outcome}`)
      if (snapshot.revision !== expectedRevision) throw new DecisionContractError('REVISION_CONFLICT', snapshot.snapshotId)
      const now = this.now()
      const changed = db.prepare(`UPDATE learning_runs SET outcome='rejected',revision=revision+1,updated_at=?
        WHERE learning_run_id=? AND outcome='candidate'`).run(now, run.learningRunId)
      if (changed.changes !== 1) throw new DecisionContractError('REVISION_CONFLICT', snapshot.snapshotId)
      result = { snapshot, run: learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(run.learningRunId)) }
    })
    return result
  }

  async rollback(snapshotId, expectedRevision) {
    let result
    await this.store.write(db => {
      const snapshot = memorySnapshotOf(db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(snapshotId))
      const run = learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(snapshot.learningRunId))
      if (snapshot.state === 'rolled_back' && run.outcome === 'rolled_back') { result = { snapshot, run }; return }
      if (snapshot.state !== 'published' || run.outcome !== 'published') throw new DecisionContractError('SNAPSHOT_STATE_CONFLICT', `${snapshot.state}/${run.outcome}`)
      if (snapshot.revision !== expectedRevision) throw new DecisionContractError('REVISION_CONFLICT', snapshot.snapshotId)
      const current = currentSnapshotRows(db, snapshot.agentId, snapshot.zone, snapshot.namespaceWorkspaceKey)[0]
      if (current?.snapshot_id !== snapshot.snapshotId) throw new DecisionContractError('SNAPSHOT_NOT_CURRENT', snapshot.snapshotId)
      const now = this.now()
      const changed = db.prepare(`UPDATE memory_snapshots SET state='rolled_back',revision=revision+1,updated_at=?
        WHERE snapshot_id=? AND state='published' AND revision=?`).run(now, snapshot.snapshotId, expectedRevision)
      if (changed.changes !== 1) throw new DecisionContractError('REVISION_CONFLICT', snapshot.snapshotId)
      db.prepare(`UPDATE learning_runs SET outcome='rolled_back',revision=revision+1,updated_at=?
        WHERE learning_run_id=? AND outcome='published'`).run(now, run.learningRunId)
      result = {
        snapshot: memorySnapshotOf(db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(snapshot.snapshotId)),
        run: learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(run.learningRunId)),
      }
    })
    return result
  }

  async recoverInterrupted() {
    return this.store.write(db => {
      const now = this.now()
      const result = db.prepare(`UPDATE learning_runs SET outcome='failed',replay_json=?,revision=revision+1,updated_at=?
        WHERE outcome='running'`).run(JSON.stringify({ passed: false, metrics: emptyMetrics(), detail: 'INTERRUPTED' }), now)
      return { interruptedLearningRuns: result.changes, at: now }
    })
  }
}

/** @param {any} row */
function feedbackRecord(row) {
  assertSupportedSchemaVersion(row.schema_version, 'Feedback')
  return {
    schemaVersion: row.schema_version, feedbackId: requiredId(row.feedback_id, 'Feedback.feedbackId'),
    caseId: requiredId(row.case_id, 'Feedback.caseId'), agentId: requiredId(row.agent_id, 'Feedback.agentId'),
    kind: row.kind, payload: row.payload_json == null ? undefined : parseJson(row.payload_json, 'Feedback.payload'),
    revision: positiveInteger(row.revision, 'Feedback.revision'), createdAt: timestamp(row.created_at, 'Feedback.createdAt'),
    updatedAt: timestamp(row.updated_at, 'Feedback.updatedAt'),
  }
}

/** @param {any} row */
function correctionRecord(row) {
  return {
    feedbackId: requiredId(row.feedback_id, 'Correction.feedbackId'), agentId: requiredId(row.agent_id, 'Correction.agentId'),
    direction: row.direction, scope: parseJson(row.scope_json, 'Correction.scope'),
    supersedes: parseJson(row.supersedes_json, 'Correction.supersedes'), active: row.active === 1,
    createdAt: timestamp(row.created_at, 'Correction.createdAt'),
  }
}

/** @param {any} db @param {any} run @param {string} detail @param {number} now */
function failCandidate(db, run, detail, now) {
  const replay = JSON.stringify({
    passed: false, metrics: run.replay?.metrics ?? emptyMetrics(), detail,
  })
  db.prepare(`UPDATE learning_runs SET outcome='failed',replay_json=?,revision=revision+1,updated_at=?
    WHERE learning_run_id=? AND outcome='candidate'`).run(replay, now, run.learningRunId)
  return learningRunOf(db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get(run.learningRunId))
}

/** Reuse authoritative Evidence eligibility and frozen source revisions at publish. */
function sourcePublishIssue(db, run, snapshot, evidence) {
  if (!evidence) return 'STALE_SOURCE'
  for (const principle of snapshot.principles.filter(value => value.state === 'active')) {
    for (const sourceId of principle.sources) {
      const expectedRevision = run.inputFrozen.revisions[sourceId]
      if (!expectedRevision) return 'STALE_SOURCE'
      const caseRow = db.prepare('SELECT * FROM cases WHERE case_id=?').get(sourceId)
      let evidenceSource
      if (caseRow) {
        const current = caseOf(caseRow)
        if (current.agentId !== run.agentId || current.workspaceKey !== run.inputFrozen.workspaceKey || current.revision !== expectedRevision) return 'STALE_SOURCE'
        if (current.feedbackState === 'disputed') return 'STALE_SOURCE'
        if (current.closing === 'escalated' && current.decision?.kind === 'user_decision') evidenceSource = 'user_decision'
        else if (current.closing === 'answered' && current.feedbackState === 'validated' && current.decision?.kind === 'answer') evidenceSource = 'agent_record'
        else return 'STALE_SOURCE'
      } else {
        const feedbackRow = db.prepare(`SELECT feedback.* FROM feedback JOIN cases ON cases.case_id=feedback.case_id
          WHERE feedback.feedback_id=? AND feedback.agent_id=? AND cases.workspace_key=?`).get(sourceId, run.agentId, run.inputFrozen.workspaceKey)
        if (!feedbackRow || feedbackRecord(feedbackRow).revision !== expectedRevision || feedbackRow.kind !== 'correction') return 'STALE_SOURCE'
        const correction = db.prepare('SELECT active FROM corrections WHERE feedback_id=? AND agent_id=?').get(sourceId, run.agentId)
        if (correction?.active !== 1) return 'STALE_SOURCE'
        evidenceSource = 'user_correction'
      }
      const locatorField = caseRow ? 'caseId' : 'feedbackId'
      const rows = db.prepare(`SELECT evidence_id FROM evidence
        WHERE agent_id=? AND source=? AND json_extract(locator_json,?)=?`).all(run.agentId, evidenceSource, `$.${locatorField}`, sourceId)
      const eligible = rows.some(row => {
        try {
          const ref = evidence.get(row.evidence_id)
          return !evidence.eligibilityIssue(ref, {
            agentId: run.agentId, workspaceKey: run.inputFrozen.workspaceKey, scope: principle.scope,
          })
        } catch { return false }
      })
      if (!eligible) return 'STALE_SOURCE'
    }
  }
  return null
}

/**
 * Read the eligible public source set from every workspace. Only closed,
 * authoritative, non-disputed Cases and active corrections of Cases in the same
 * set are eligible; nothing reads a session log or the raw request/decision JSON.
 * @param {any} db @param {string} agentId
 */
function readPublicFreeze(db, agentId) {
  const caseRows = db.prepare(`SELECT * FROM cases
    WHERE agent_id=? AND state='closed' AND closing IN ('answered','escalated')
    ORDER BY created_at,case_id`).all(agentId)
  const cases = []
  const caseById = {}
  for (const row of caseRows) {
    const current = caseOf(row)
    const userDecision = current.closing === 'escalated' && current.decision?.kind === 'user_decision'
    const validatedAnswer = current.closing === 'answered' && current.feedbackState === 'validated' && current.decision?.kind === 'answer'
    if (!userDecision && !validatedAnswer) continue
    if (current.feedbackState === 'disputed') continue
    if (typeof current.workspaceKey !== 'string' || !current.workspaceKey) continue
    cases.push(current)
    caseById[current.caseId] = current
  }
  const feedbackRows = db.prepare(`SELECT feedback.* FROM feedback JOIN cases ON cases.case_id=feedback.case_id
    WHERE feedback.agent_id=? AND feedback.kind='correction'
    ORDER BY feedback.created_at,feedback.feedback_id`).all(agentId)
  const corrections = []
  const feedback = []
  const feedbackById = {}
  for (const row of feedbackRows) {
    const owner = caseById[row.case_id]
    if (!owner) continue
    const correctionRow = db.prepare('SELECT * FROM corrections WHERE feedback_id=? AND agent_id=?').get(row.feedback_id, agentId)
    if (!correctionRow || correctionRow.active !== 1) continue
    const record = feedbackRecord(row)
    feedback.push(record)
    feedbackById[record.feedbackId] = record
    corrections.push({ ...correctionRecord(correctionRow), caseRecord: owner })
  }
  return {
    sourceSet: projectPublicSources({ agentId, cases, corrections, feedback }),
    caseById, feedbackById, corrections,
  }
}

/** Public candidate text is scanned before display and before publish. */
function publicPublishIssue(db, run, snapshot, evidence) {
  const allowed = [...run.inputFrozen.caseIds, ...run.inputFrozen.feedbackIds]
  for (const principle of snapshot.principles) {
    if (publicContentIssues(principle.text, allowed).length) return 'PUBLIC_CONTENT_REJECTED'
  }
  if (!evidence) return 'STALE_SOURCE'
  for (const principle of snapshot.principles.filter(value => value.state === 'active')) {
    for (const sourceId of principle.sources) {
      if (publicSourceIssue(db, evidence, run, sourceId, principle)) return 'STALE_SOURCE'
    }
  }
  return null
}

/**
 * Revalidate one public source inside its own origin workspace. A public source
 * is "expandable" only when the Host can recheck it there; it never grants the
 * current session a foreign-record read path.
 * @param {any} db @param {any} evidence @param {any} run @param {string} sourceId @param {any} principle
 */
function publicSourceIssue(db, evidence, run, sourceId, principle) {
  const expectedRevision = run.inputFrozen.revisions?.[sourceId]
  const workspaceKey = run.inputFrozen.sourceWorkspaces?.[sourceId]
  if (!expectedRevision || typeof workspaceKey !== 'string' || !workspaceKey) return 'STALE_SOURCE'
  const scope = publicPrincipleScopeForWorkspace(principle?.scope ?? {}, workspaceKey)
  const caseRow = db.prepare('SELECT * FROM cases WHERE case_id=?').get(sourceId)
  let evidenceSource
  if (caseRow) {
    const current = caseOf(caseRow)
    if (current.agentId !== run.agentId || current.workspaceKey !== workspaceKey || current.revision !== expectedRevision) return 'STALE_SOURCE'
    if (current.feedbackState === 'disputed') return 'STALE_SOURCE'
    if (current.closing === 'escalated' && current.decision?.kind === 'user_decision') evidenceSource = 'user_decision'
    else if (current.closing === 'answered' && current.feedbackState === 'validated' && current.decision?.kind === 'answer') evidenceSource = 'agent_record'
    else return 'STALE_SOURCE'
  } else {
    const feedbackRow = db.prepare(`SELECT feedback.* FROM feedback JOIN cases ON cases.case_id=feedback.case_id
      WHERE feedback.feedback_id=? AND feedback.agent_id=? AND cases.agent_id=? AND cases.workspace_key=?`)
      .get(sourceId, run.agentId, run.agentId, workspaceKey)
    if (!feedbackRow || feedbackRecord(feedbackRow).revision !== expectedRevision || feedbackRow.kind !== 'correction') return 'STALE_SOURCE'
    const correction = db.prepare('SELECT active FROM corrections WHERE feedback_id=? AND agent_id=?').get(sourceId, run.agentId)
    if (correction?.active !== 1) return 'STALE_SOURCE'
    evidenceSource = 'user_correction'
  }
  const locatorField = caseRow ? 'caseId' : 'feedbackId'
  const rows = db.prepare(`SELECT evidence_id FROM evidence
    WHERE agent_id=? AND source=? AND json_extract(locator_json,?)=?`).all(run.agentId, evidenceSource, `$.${locatorField}`, sourceId)
  const eligible = rows.some(row => {
    try {
      const ref = evidence.get(row.evidence_id)
      return !evidence.eligibilityIssue(ref, { agentId: run.agentId, workspaceKey, scope })
    } catch { return false }
  })
  return eligible ? null : 'STALE_SOURCE'
}

/** @template T @param {T} value @returns {T} */
function clone(value) { return JSON.parse(JSON.stringify(value)) }

/** @param {any} db @param {string} agentId @param {string} zone @param {string|null} namespaceWorkspaceKey */
function currentSnapshotRows(db, agentId, zone, namespaceWorkspaceKey) {
  const rows = db.prepare(`SELECT * FROM memory_snapshots
    WHERE agent_id=? AND zone=? AND namespace_workspace_key IS ?
    ORDER BY version DESC,snapshot_id DESC`).all(agentId, zone, namespaceWorkspaceKey)
  assertUniqueSnapshotVersions(rows, agentId)
  return rows.filter(row => row.state === 'published')
}

/** Versions are unique per namespace, never across the public/private zones. */
/** @param {any[]} rows @param {string} agentId */
function assertUniqueSnapshotVersions(rows, agentId) {
  const seen = new Set()
  for (const row of rows) {
    const key = `${row.zone}\u0000${row.namespace_workspace_key ?? ''}\u0000${row.version}`
    if (seen.has(key)) throw new DecisionContractError('SNAPSHOT_VERSION_AMBIGUOUS', `${agentId}@${row.zone}@${row.version}`)
    seen.add(key)
  }
}

function emptyMetrics() { return { operationCount: 0, sourceCount: 0, activePrincipleCount: 0, retiredPrincipleCount: 0 } }

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
