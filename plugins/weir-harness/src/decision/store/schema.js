// SQLite schema v1 for the authoritative Decision Agent store.

export const CURRENT_SCHEMA_VERSION = 1

const ENVELOPE = `
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
`

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
])

export const EXPECTED_TABLES = Object.freeze([
  'meta', 'agent_profiles', 'agent_profile_revisions', 'cases', 'attempts',
  'evidence', 'attempt_evidence', 'feedback', 'corrections', 'route_decisions',
  'selectors', 'memory_snapshots', 'learning_runs', 'metrics_counters',
])
