// Shared live-only Decision scenario observers and authoritative-store readers.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IT_ROOT } from './mock-kit.js'
import { canonicalJson } from '../../weir-harness/src/decision/contracts.js'

export const DECISION_CONTRACTS = Object.freeze(['Decision evaluator contract v1', 'Decision evaluator contract v2', 'Decision evaluator contract v3'])
export const DECISION_EVENTS = join(IT_ROOT, 'decision-integration-events.jsonl')

// The Hook scenario retains the canonical default path; later scenarios get
// independent stores so an all-scenario run never shares mutable fixtures.
export function decisionStoreDirectory(id) {
  return id === 'decision-hook' ? undefined : join(IT_ROOT, 'decision-stores', id)
}

export function decisionPack(obs) {
  try { return JSON.parse(obs.lastUser) } catch { return undefined }
}

export function observeDecision(obs) {
  const evaluator = DECISION_CONTRACTS.includes(obs.system.split('\n', 1)[0])
  const pack = evaluator ? decisionPack(obs) : undefined
  return {
    decisionEvaluator: evaluator,
    decisionQuestionIds: pack?.L4?.request?.questions?.map(question => question.id) ?? [],
    decisionEvidenceIds: pack?.L5?.map(evidence => evidence.evidenceId) ?? [],
  }
}

export function readDecisionEvents(path = DECISION_EVENTS) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

export function parseDecisionToolResult(text) {
  try {
    const value = JSON.parse(String(text).split('\n')[0])
    return typeof value?.outcome === 'string' && typeof value?.caseId === 'string' ? value : null
  } catch { return null }
}

function parse(value) {
  return value === null || value === undefined ? null : JSON.parse(value)
}

export function readDecisionStore(ws, storeDirectory = process.env.WEIR_IT_DECISION_STORE_PATH) {
  const path = storeDirectory ? join(storeDirectory, 'decision.db') : join(ws, '..', 'home', 'weir', 'profiles', 'weir-it', 'decisions', 'decision.db')
  if (!existsSync(path)) return { path, profiles: [], selectors: [], cases: [], attempts: [], evidence: [], feedback: [], corrections: [], routes: [], learning_runs: [], memory_snapshots: [] }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      path,
      profiles: db.prepare('SELECT * FROM agent_profiles ORDER BY created_at,agent_id').all()
        .map(row => ({ ...row, scope: parse(row.scope_json), chain: parse(row.chain_json) })),
      selectors: db.prepare('SELECT * FROM selectors ORDER BY root_session_id').all(),
      cases: db.prepare('SELECT * FROM cases ORDER BY created_at,case_id').all()
        .map(row => ({ ...row, request: parse(row.request_json), scope: parse(row.scope_json), escalation: parse(row.escalation_json), decision: parse(row.decision_json) })),
      attempts: db.prepare('SELECT * FROM attempts ORDER BY case_id,attempt_no').all()
        .map(row => ({ ...row, error: parse(row.error_json), claims: parse(row.claims_json), citedEvidenceIds: parse(row.cited_evidence_ids_json), gates: parse(row.gates_json), pins: parse(row.pins_json), packManifest: parse(row.pack_manifest_json) })),
      evidence: db.prepare('SELECT * FROM evidence ORDER BY created_at,evidence_id').all()
        .map(row => ({ ...row, locator: parse(row.locator_json), scope: parse(row.scope_json) })),
      feedback: db.prepare('SELECT * FROM feedback ORDER BY created_at,feedback_id').all()
        .map(row => ({ ...row, payload: parse(row.payload_json), effect: parse(row.effect_json) })),
      corrections: db.prepare('SELECT * FROM corrections ORDER BY created_at,feedback_id').all()
        .map(row => ({ ...row, scope: parse(row.scope_json), supersedes: parse(row.supersedes_json) })),
      routes: db.prepare('SELECT * FROM route_decisions ORDER BY created_at,route_decision_id').all()
        .map(row => ({ ...row, candidates: parse(row.candidates_json), ambiguity: parse(row.ambiguity_json) })),
      learning_runs: db.prepare('SELECT * FROM learning_runs ORDER BY created_at,learning_run_id').all()
        .map(row => ({ ...row, inputFrozen: parse(row.input_frozen_json), operations: parse(row.operations_json), replay: parse(row.replay_json) })),
      memory_snapshots: db.prepare('SELECT * FROM memory_snapshots ORDER BY version,snapshot_id').all()
        .map(row => {
          const principles = parse(row.principles_json)
          const generatedDescription = parse(row.generated_description_json)
          const contentHash = createHash('sha256').update(canonicalJson({
            version: row.version, parentSnapshotId: row.parent_snapshot_id, principles, generatedDescription, learningRunId: row.learning_run_id,
          })).digest('hex')
          return { ...row, principles, generatedDescription, contentHash }
        }),
    }
  } finally {
    db.close()
  }
}
