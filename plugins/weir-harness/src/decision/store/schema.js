// SQLite schema for the authoritative Decision Agent store.
//
// v1 created the workspace-owned shapes. v2 makes Agent identity profile-global
// (one row per assistant, no workspace in the identity) and gives Learning Runs
// and Memory Snapshots an explicit `(zone, namespace_workspace_key)` namespace,
// while every persisted record envelope stays `schema_version = 1`: the database
// version and the row envelope version are deliberately independent.
import { createHash } from 'node:crypto'

export const CURRENT_SCHEMA_VERSION = 2

/** @typedef {string | ((db: import('node:sqlite').DatabaseSync) => void)} MigrationStep */

const ENVELOPE = `
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
`

export const ZONES = Object.freeze(['workspace', 'public'])

export const MIGRATIONS = Object.freeze([
  Object.freeze([
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE agent_profiles (
      agent_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, name TEXT NOT NULL,
      state TEXT NOT NULL, scope_json TEXT NOT NULL, user_desc_rev INTEGER NOT NULL,
      generated_desc_rev INTEGER NOT NULL DEFAULT 0, chain_json TEXT NOT NULL,
      archived_at INTEGER, ${ENVELOPE},
      UNIQUE(workspace_key, name COLLATE NOCASE)
    )`,
    `CREATE TABLE agent_profile_revisions (
      agent_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
      text TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(agent_id, kind, revision)
    )`,
    `CREATE TABLE cases (
      case_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, root_session_id TEXT NOT NULL,
      origin_session_id TEXT NOT NULL, origin_kind TEXT NOT NULL, entry TEXT NOT NULL,
      agent_id TEXT, request_json TEXT NOT NULL, scope_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE, state TEXT NOT NULL, closing TEXT,
      awaiting_reason TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL, feedback_state TEXT NOT NULL DEFAULT 'none',
      needs_review INTEGER NOT NULL DEFAULT 0, escalation_json TEXT,
      decision_json TEXT, closed_at INTEGER, ${ENVELOPE}
    )`,
    `CREATE TABLE attempts (
      attempt_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
      agent_id TEXT NOT NULL, outcome TEXT, return_code TEXT, return_hint TEXT, input_tokens INTEGER, output_tokens INTEGER,
      error_json TEXT, claims_json TEXT, cited_evidence_ids_json TEXT, gates_json TEXT,
      pins_json TEXT, context_pack_hash TEXT, pack_manifest_json TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER, ${ENVELOPE},
      UNIQUE(case_id, attempt_no)
    )`,
    `CREATE TABLE evidence (
      evidence_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source TEXT NOT NULL,
      locator_json TEXT NOT NULL, excerpt TEXT, hash TEXT, version TEXT,
      observed_at INTEGER, scope_json TEXT NOT NULL, status TEXT NOT NULL, ${ENVELOPE}
    )`,
    `CREATE TABLE attempt_evidence (
      attempt_id TEXT NOT NULL, ordinal INTEGER NOT NULL, evidence_id TEXT NOT NULL,
      PRIMARY KEY(attempt_id, ordinal)
    )`,
    `CREATE TABLE feedback (
      feedback_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, attempt_id TEXT,
      agent_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
      payload_json TEXT, effect_json TEXT NOT NULL, ${ENVELOPE}
    )`,
    `CREATE TABLE corrections (
      feedback_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, direction TEXT NOT NULL,
      scope_json TEXT NOT NULL, supersedes_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE route_decisions (
      route_decision_id TEXT PRIMARY KEY, case_id TEXT, root_session_id TEXT NOT NULL,
      mode TEXT NOT NULL, candidates_json TEXT NOT NULL, chosen TEXT,
      reason TEXT NOT NULL, ambiguity_json TEXT, ${ENVELOPE}
    )`,
    `CREATE TABLE selectors (
      root_session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, agent_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE memory_snapshots (
      snapshot_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version INTEGER NOT NULL,
      parent_snapshot_id TEXT, state TEXT NOT NULL, principles_json TEXT NOT NULL,
      generated_description_json TEXT NOT NULL, learning_run_id TEXT, ${ENVELOPE}
    )`,
    `CREATE TABLE learning_runs (
      learning_run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, trigger TEXT NOT NULL,
      input_frozen_json TEXT NOT NULL, operations_json TEXT NOT NULL,
      replay_json TEXT, outcome TEXT NOT NULL, ${ENVELOPE}
    )`,
    `CREATE TABLE metrics_counters (bucket TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
    `CREATE INDEX cases_workspace_agent ON cases(workspace_key, agent_id)`,
    `CREATE INDEX cases_root_created ON cases(root_session_id, created_at DESC)`,
    `CREATE INDEX cases_workspace_state ON cases(workspace_key, state, updated_at DESC)`,
    `CREATE INDEX attempts_case_started ON attempts(case_id, started_at)`,
    `CREATE INDEX evidence_agent_source ON evidence(agent_id, source, status)`,
    `CREATE INDEX feedback_case_created ON feedback(case_id, created_at)`,
    `CREATE INDEX feedback_agent_kind ON feedback(agent_id, kind)`,
  ]),
  Object.freeze([
    // 1. Namespaces before the profile rebuild: the private zone inherits the
    //    legacy profile workspace, which only the v1 table still carries.
    `ALTER TABLE learning_runs ADD COLUMN zone TEXT NOT NULL DEFAULT 'workspace'`,
    `ALTER TABLE learning_runs ADD COLUMN namespace_workspace_key TEXT`,
    `ALTER TABLE memory_snapshots ADD COLUMN zone TEXT NOT NULL DEFAULT 'workspace'`,
    `ALTER TABLE memory_snapshots ADD COLUMN namespace_workspace_key TEXT`,
    `UPDATE learning_runs SET namespace_workspace_key=(
       SELECT agent_profiles.workspace_key FROM agent_profiles WHERE agent_profiles.agent_id=learning_runs.agent_id
     ) WHERE namespace_workspace_key IS NULL`,
    `UPDATE memory_snapshots SET namespace_workspace_key=(
       SELECT agent_profiles.workspace_key FROM agent_profiles WHERE agent_profiles.agent_id=memory_snapshots.agent_id
     ) WHERE namespace_workspace_key IS NULL`,
    // 2. agent_profiles becomes profile-global. The legacy workspace survives
    //    only as an opaque origin alias for advanced provenance.
    `CREATE TABLE agent_profiles_v2 (
      agent_id TEXT PRIMARY KEY, name TEXT NOT NULL, legacy_origin_alias TEXT,
      state TEXT NOT NULL, scope_json TEXT NOT NULL, user_desc_rev INTEGER NOT NULL,
      generated_desc_rev INTEGER NOT NULL DEFAULT 0, chain_json TEXT NOT NULL,
      archived_at INTEGER, ${ENVELOPE}
    )`,
    `INSERT INTO agent_profiles_v2(
       agent_id,name,legacy_origin_alias,state,scope_json,user_desc_rev,generated_desc_rev,
       chain_json,archived_at,schema_version,revision,created_at,updated_at
     ) SELECT agent_id,name,NULL,state,scope_json,user_desc_rev,generated_desc_rev,
       chain_json,archived_at,schema_version,revision,created_at,updated_at FROM agent_profiles`,
    /** @type {MigrationStep} */
    (db => migrateProfilesToGlobal(db)),
    `DROP TABLE agent_profiles`,
    `ALTER TABLE agent_profiles_v2 RENAME TO agent_profiles`,
    `CREATE UNIQUE INDEX agent_profiles_name_unique ON agent_profiles(name COLLATE NOCASE)`,
    `CREATE INDEX agent_profiles_state ON agent_profiles(state, name COLLATE NOCASE)`,
    // 3. Per-namespace version sequences, current snapshots and active runs.
    //    SQLite treats NULLs as distinct, so the public zone additionally pins
    //    exclusivity with partial unique indexes instead of a sentinel value.
    `CREATE UNIQUE INDEX memory_snapshots_namespace_version ON memory_snapshots(agent_id, zone, namespace_workspace_key, version)`,
    // SQLite treats NULLs as distinct, so the NULL-namespace public zone needs its
    // own partial unique index to keep one version sequence per Agent.
    `CREATE UNIQUE INDEX memory_snapshots_public_version ON memory_snapshots(agent_id, version)
       WHERE zone='public'`,
    `CREATE INDEX memory_snapshots_namespace_state ON memory_snapshots(agent_id, zone, namespace_workspace_key, state, version DESC)`,
    `CREATE UNIQUE INDEX learning_runs_active_workspace ON learning_runs(agent_id, namespace_workspace_key)
       WHERE zone='workspace' AND outcome IN ('running','candidate')`,
    `CREATE UNIQUE INDEX learning_runs_active_public ON learning_runs(agent_id)
       WHERE zone='public' AND outcome IN ('running','candidate')`,
    `CREATE INDEX learning_runs_namespace ON learning_runs(agent_id, zone, namespace_workspace_key, created_at DESC)`,
  ]),
])

export const EXPECTED_TABLES = Object.freeze([
  'meta', 'agent_profiles', 'agent_profile_revisions', 'cases', 'attempts',
  'evidence', 'attempt_evidence', 'feedback', 'corrections', 'route_decisions',
  'selectors', 'memory_snapshots', 'learning_runs', 'metrics_counters',
])

/**
 * Distinct display names without merging identities or re-keying history.
 *
 * Two passes make the result order-independent and idempotent: names that are
 * already unique are reserved first, then each duplicate group keeps its first
 * row on the base name and suffixes the rest on the ORIGINAL base name. An
 * already-suffixed name therefore stays untouched instead of gaining a suffix of
 * its own, and re-running the migration on its own output changes nothing.
 * @param {{agent_id:string,name:string}[]} rows ordered by created_at, agent_id
 */
export function uniqueProfileNames(rows) {
  const counts = new Map()
  for (const row of rows) {
    const key = String(row.name).toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const taken = new Set()
  const names = new Map()
  for (const row of rows) {
    if ((counts.get(String(row.name).toLowerCase()) ?? 0) === 1) {
      taken.add(String(row.name).toLowerCase())
      names.set(row.agent_id, String(row.name))
    }
  }
  for (const row of rows) {
    if (names.has(row.agent_id)) continue
    const base = String(row.name)
    let candidate = base
    for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix++) candidate = `${base} · ${suffix}`
    taken.add(candidate.toLowerCase())
    names.set(row.agent_id, candidate)
  }
  return names
}

/** @param {import('node:sqlite').DatabaseSync} db */
function migrateProfilesToGlobal(db) {
  const rows = db.prepare('SELECT agent_id,workspace_key,name,scope_json FROM agent_profiles ORDER BY created_at,agent_id').all()
  const names = uniqueProfileNames(rows)
  const update = db.prepare('UPDATE agent_profiles_v2 SET name=?,legacy_origin_alias=?,scope_json=? WHERE agent_id=?')
  for (const row of rows) {
    update.run(names.get(row.agent_id), legacyOriginAlias(row.workspace_key), JSON.stringify(normalizeLegacyProfileScope(row.scope_json)), row.agent_id)
  }
}

/**
 * Workspace membership is no longer part of a profile. Dropping it here keeps a
 * legacy `scope.workspaces` array from silently acting as a workspace lock.
 * @param {unknown} scopeJson
 */
export function normalizeLegacyProfileScope(scopeJson) {
  let value = /** @type {any} */ (null)
  try { value = typeof scopeJson === 'string' ? JSON.parse(scopeJson) : scopeJson } catch { value = null }
  const scope = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  /** @type {Record<string, unknown>} */
  const normalized = {}
  for (const key of ['paths', 'tags']) {
    const entries = scope[key]
    if (Array.isArray(entries) && entries.every(entry => typeof entry === 'string')) normalized[key] = [...entries]
  }
  // An inherited authorizationClasses array is inert legacy data: it is dropped
  // here rather than migrated, because the class axis no longer exists.
  return normalized
}

/** Opaque, stable origin token: never the raw workspace key or realpath. */
export function legacyOriginAlias(workspaceKey) {
  if (typeof workspaceKey !== 'string' || !workspaceKey) return null
  return `origin_${createHash('sha256').update(workspaceKey).digest('hex').slice(0, 12)}`
}
