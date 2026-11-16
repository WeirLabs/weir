// Agent Profile lifecycle, user-owned description revisions, and root selectors.
//
// An Agent Profile is a profile-global Decision identity: no workspace owns,
// hides, ranks or authorizes it. The workspace it was originally created in, if
// any, survives only as an opaque legacy-origin alias for advanced provenance.
import { randomUUID } from 'node:crypto'
import { assertSupportedSchemaVersion, DecisionContractError } from '../contracts.js'

/** @typedef {{ workspaces: string[], paths?: string[], tags?: string[] }} CaseScope */
/** @typedef {{ paths?: string[], tags?: string[] }} ProfileScope */
/** @typedef {{ provider: string, model: string, reasoningEffort?: string }} ModelRung */

/**
 * Request/Case scope: always bound to exactly the current workspace. Raw records
 * stay private to the workspace that produced them.
 * @param {unknown} workspaceKey @param {unknown} scope @returns {CaseScope}
 */
export function parseScope(workspaceKey, scope) {
  if (typeof workspaceKey !== 'string' || workspaceKey.length === 0) throw new DecisionContractError('INVALID_WORKSPACE', 'workspaceKey is required')
  const value = scope === undefined ? { workspaces: [workspaceKey] } : scope
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DecisionContractError('INVALID_SCOPE', 'scope must be an object')
  const input = /** @type {Record<string, unknown>} */ (value)
  if (!Array.isArray(input.workspaces) || input.workspaces.length !== 1 || input.workspaces[0] !== workspaceKey) {
    throw new DecisionContractError('SCOPE_WORKSPACE_MISMATCH', 'P1 scope.workspaces must contain exactly the current workspaceKey')
  }
  const result = { workspaces: [workspaceKey] }
  for (const key of ['paths', 'tags']) {
    const entries = input[key]
    if (entries !== undefined && (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string'))) {
      throw new DecisionContractError('INVALID_SCOPE', `scope.${key} must be a string array`)
    }
    if (Array.isArray(entries)) result[key] = [...entries]
  }
  return result
}

/**
 * Profile scope: optional paths/tags expertise hints only. It deliberately has
 * no workspace membership — an empty hint list means "no extra restriction",
 * never "any workspace".
 * @param {unknown} scope @returns {ProfileScope}
 */
export function parseProfileScope(scope) {
  const value = scope === undefined ? {} : scope
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DecisionContractError('INVALID_SCOPE', 'scope must be an object')
  const input = /** @type {Record<string, unknown>} */ (value)
  const result = /** @type {ProfileScope} */ ({})
  for (const key of ['paths', 'tags']) {
    const entries = input[key]
    if (entries !== undefined && (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string'))) {
      throw new DecisionContractError('INVALID_SCOPE', `scope.${key} must be a string array`)
    }
    if (Array.isArray(entries) && entries.length) result[key] = [...entries]
  }
  return result
}

/** @param {unknown} chain @returns {ModelRung[]} */
function parseChain(chain) {
  if (chain === undefined) return []
  if (!Array.isArray(chain)) throw new DecisionContractError('INVALID_MODEL_ROUTE', 'modelRoute.chain must be an array')
  return chain.map(rung => {
    if (!rung || typeof rung !== 'object' || typeof rung.provider !== 'string' || typeof rung.model !== 'string') {
      throw new DecisionContractError('INVALID_MODEL_ROUTE', 'each model rung requires provider and model')
    }
    return { provider: rung.provider, model: rung.model, ...(rung.reasoningEffort === undefined ? {} : { reasoningEffort: String(rung.reasoningEffort) }) }
  })
}

export class DecisionProfiles {
  /** @param {import('./db.js').DecisionDatabase} store @param {{ now?: () => number }} [options] */
  constructor(store, options = {}) {
    this.store = store
    this.now = options.now ?? Date.now
  }

  /**
   * `workspaceKey` is accepted for compatibility with pre-v2 callers and never
   * becomes part of the identity.
   * @param {{ workspaceKey?: string, name: string, userDescription?: string, scope?: unknown, modelRoute?: { chain: unknown } }} input
   */
  async createProfile(input) {
    const name = input.name?.trim()
    if (!name) throw new DecisionContractError('INVALID_PROFILE_NAME', 'name is required')
    const scope = parseProfileScope(input.scope)
    const chain = parseChain(input.modelRoute?.chain)
    const now = this.now()
    const profile = {
      schemaVersion: 1, agentId: `ag_${randomUUID()}`,
      name, state: 'enabled', scope,
      userDescription: { revision: 1, text: input.userDescription ?? '' },
      generatedDescription: { revision: 0, text: '' }, modelRoute: { chain },
      revision: 1, createdAt: now, updatedAt: now,
    }
    await this.store.write(db => {
      this.assertNameAvailable(db, name)
      db.prepare(`INSERT INTO agent_profiles(
        agent_id,name,legacy_origin_alias,state,scope_json,user_desc_rev,generated_desc_rev,
        chain_json,revision,created_at,updated_at
      ) VALUES(?,?,NULL,?,?,?,?,?,?,?,?)`).run(
        profile.agentId, profile.name, profile.state, JSON.stringify(scope),
        1, 0, JSON.stringify(profile.modelRoute), 1, now, now,
      )
      db.prepare('INSERT INTO agent_profile_revisions(agent_id,kind,revision,text,created_at) VALUES(?,?,?,?,?)')
        .run(profile.agentId, 'user', 1, profile.userDescription.text, now)
    })
    return profile
  }

  /** @param {string} agentId @param {{ name?: string, userDescription?: string, scope?: unknown, modelRoute?: {chain:unknown} }} patch */
  async updateProfile(agentId, patch) {
    const current = this.getProfile(agentId)
    const name = patch.name?.trim() ?? current.name
    if (!name) throw new DecisionContractError('INVALID_PROFILE_NAME', 'name is required')
    const scope = patch.scope === undefined ? current.scope : parseProfileScope(patch.scope)
    const chain = patch.modelRoute === undefined ? current.modelRoute.chain : parseChain(patch.modelRoute.chain)
    const description = patch.userDescription === undefined ? current.userDescription : {
      revision: current.userDescription.revision + 1, text: patch.userDescription,
    }
    const now = this.now()
    await this.store.write(db => {
      if (name !== current.name) this.assertNameAvailable(db, name, agentId)
      const result = db.prepare(`UPDATE agent_profiles SET name=?,scope_json=?,chain_json=?,user_desc_rev=?,revision=revision+1,updated_at=? WHERE agent_id=?`)
        .run(name, JSON.stringify(scope), JSON.stringify({ chain }), description.revision, now, agentId)
      if (result.changes !== 1) throw new DecisionContractError('PROFILE_NOT_FOUND', agentId)
      if (description.revision !== current.userDescription.revision) {
        db.prepare('INSERT INTO agent_profile_revisions(agent_id,kind,revision,text,created_at) VALUES(?,?,?,?,?)')
          .run(agentId, 'user', description.revision, description.text, now)
      }
    })
    return this.getProfile(agentId)
  }

  /**
   * Name uniqueness is case-insensitive and profile-global: any workspace must be
   * rejected when the same assistant name already exists.
   * @param {import('node:sqlite').DatabaseSync} db @param {string} name @param {string} [agentId]
   */
  assertNameAvailable(db, name, agentId) {
    const row = db.prepare('SELECT agent_id FROM agent_profiles WHERE name=? COLLATE NOCASE AND (? IS NULL OR agent_id<>?) LIMIT 1')
      .get(name, agentId ?? null, agentId ?? null)
    if (row) throw new DecisionContractError('PROFILE_NAME_TAKEN', name)
  }

  /** @param {string} agentId @param {'enabled'|'disabled'|'archived'} state */
  async setProfileState(agentId, state) {
    if (!['enabled', 'disabled', 'archived'].includes(state)) throw new DecisionContractError('INVALID_PROFILE_STATE', state)
    await this.store.write(db => {
      const result = db.prepare('UPDATE agent_profiles SET state=?,archived_at=?,revision=revision+1,updated_at=? WHERE agent_id=?')
        .run(state, state === 'archived' ? this.now() : null, this.now(), agentId)
      if (result.changes !== 1) throw new DecisionContractError('PROFILE_NOT_FOUND', agentId)
    })
    return this.getProfile(agentId)
  }
  /** @param {string} agentId */
  getProfile(agentId) {
    const row = this.store.db.prepare('SELECT * FROM agent_profiles WHERE agent_id=?').get(agentId)
    if (!row) throw new DecisionContractError('PROFILE_NOT_FOUND', agentId)
    return profileOf(row, this.descriptionRevision(agentId, 'user', row.user_desc_rev))
  }

  /**
   * Read-only counts of every record family an assistant owns, for the delete
   * confirmation dialog. Returns null when the assistant does not exist.
   * @param {string} agentId
   */
  deletePreview(agentId) {
    const db = this.store.db
    const profile = db.prepare('SELECT agent_id,name,state FROM agent_profiles WHERE agent_id=?').get(agentId)
    if (!profile) return null
    const count = sql => db.prepare(sql).get(agentId)?.n ?? 0
    return {
      agentId: profile.agent_id, name: profile.name, state: profile.state,
      counts: {
        cases: count('SELECT COUNT(*) n FROM cases WHERE agent_id=?'),
        attempts: count('SELECT COUNT(*) n FROM attempts WHERE agent_id=?'),
        evidence: count('SELECT COUNT(*) n FROM evidence WHERE agent_id=?'),
        feedback: count('SELECT COUNT(*) n FROM feedback WHERE agent_id=?'),
        corrections: count('SELECT COUNT(*) n FROM corrections WHERE agent_id=?'),
        routeDecisions: db.prepare('SELECT COUNT(*) n FROM route_decisions WHERE case_id IN (SELECT case_id FROM cases WHERE agent_id=?)').get(agentId)?.n ?? 0,
        learningRuns: count('SELECT COUNT(*) n FROM learning_runs WHERE agent_id=?'),
        snapshots: count('SELECT COUNT(*) n FROM memory_snapshots WHERE agent_id=?'),
        revisions: count('SELECT COUNT(*) n FROM agent_profile_revisions WHERE agent_id=?'),
      },
    }
  }

  /**
   * Permanently delete an assistant and every record it owns, inside one
   * serialized write transaction. Selectors, aggregate metrics and on-disk
   * export files are deliberately left untouched.
   * @param {string} agentId @returns {Promise<Record<string, number>>} deleted row counts
   */
  async deleteCascade(agentId) {
    return this.store.write(db => {
      const counts = {}
      counts.corrections = db.prepare('DELETE FROM corrections WHERE agent_id=?').run(agentId).changes
      counts.feedback = db.prepare('DELETE FROM feedback WHERE agent_id=?').run(agentId).changes
      counts.attemptEvidence = db.prepare('DELETE FROM attempt_evidence WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE agent_id=?)').run(agentId).changes
      counts.evidence = db.prepare('DELETE FROM evidence WHERE agent_id=?').run(agentId).changes
      counts.attempts = db.prepare('DELETE FROM attempts WHERE agent_id=?').run(agentId).changes
      counts.routeDecisions = db.prepare('DELETE FROM route_decisions WHERE case_id IN (SELECT case_id FROM cases WHERE agent_id=?)').run(agentId).changes
      counts.cases = db.prepare('DELETE FROM cases WHERE agent_id=?').run(agentId).changes
      counts.learningRuns = db.prepare('DELETE FROM learning_runs WHERE agent_id=?').run(agentId).changes
      counts.snapshots = db.prepare('DELETE FROM memory_snapshots WHERE agent_id=?').run(agentId).changes
      counts.revisions = db.prepare('DELETE FROM agent_profile_revisions WHERE agent_id=?').run(agentId).changes
      const result = db.prepare('DELETE FROM agent_profiles WHERE agent_id=?').run(agentId)
      if (result.changes !== 1) throw new DecisionContractError('PROFILE_NOT_FOUND', agentId)
      return counts
    })
  }

  /** @param {{includeArchived?: boolean}} [options] */
  listProfiles(options = {}) {
    const rows = this.store.db.prepare(`SELECT * FROM agent_profiles WHERE 1=1 ${options.includeArchived ? '' : "AND state!='archived'"} ORDER BY name COLLATE NOCASE, agent_id`).all()
    return rows.map(row => profileOf(row, this.descriptionRevision(row.agent_id, 'user', row.user_desc_rev)))
  }

  /** @param {string} agentId @param {'user'|'generated'} kind @param {number} revision */
  descriptionRevision(agentId, kind, revision) {
    const row = this.store.db.prepare('SELECT text FROM agent_profile_revisions WHERE agent_id=? AND kind=? AND revision=?').get(agentId, kind, revision)
    if (!row) throw new DecisionContractError('DESCRIPTION_REVISION_NOT_FOUND', `${agentId}/${kind}/${revision}`)
    return row.text
  }

  descriptionHistory(agentId) {
    return this.store.db.prepare("SELECT revision,text,created_at FROM agent_profile_revisions WHERE agent_id=? AND kind='user' ORDER BY revision").all(agentId)
      .map(row => ({ revision: row.revision, text: row.text, createdAt: row.created_at }))
  }

  /** @param {string} rootSessionId @param {{mode:'off'|'agent'|'auto',agentId?:string}} value */
  async setSelector(rootSessionId, value) {
    if (value.mode === 'off') {
      await this.store.write(db => {
        db.prepare(`INSERT INTO selectors(root_session_id,mode,agent_id,revision,updated_at) VALUES(?,'off',NULL,1,?)
          ON CONFLICT(root_session_id) DO UPDATE SET mode='off',agent_id=NULL,revision=selectors.revision+1,updated_at=excluded.updated_at`)
          .run(rootSessionId, this.now())
      })
      return { mode: 'off' }
    }
    if (value.mode === 'auto') {
      await this.store.write(db => {
        db.prepare(`INSERT INTO selectors(root_session_id,mode,agent_id,revision,updated_at) VALUES(?,'auto',NULL,1,?)
          ON CONFLICT(root_session_id) DO UPDATE SET mode='auto',agent_id=NULL,revision=selectors.revision+1,updated_at=excluded.updated_at`)
          .run(rootSessionId, this.now())
      })
      return { mode: 'auto' }
    }
    if (value.mode !== 'agent' || typeof value.agentId !== 'string') throw new DecisionContractError('INVALID_SELECTOR', 'agent selector requires agentId')
    const profile = this.getProfile(value.agentId)
    if (profile.state !== 'enabled') throw new DecisionContractError('AGENT_UNAVAILABLE', value.agentId)
    await this.store.write(db => {
      db.prepare(`INSERT INTO selectors(root_session_id,mode,agent_id,revision,updated_at) VALUES(?,?,?,1,?)
        ON CONFLICT(root_session_id) DO UPDATE SET mode='agent',agent_id=excluded.agent_id,revision=selectors.revision+1,updated_at=excluded.updated_at`)
        .run(rootSessionId, 'agent', value.agentId, this.now())
    })
    return { mode: 'agent', agentId: value.agentId }
  }

  /** Initialize Auto only when no selector row exists; return whether this call inserted it. */
  async initializeAutoSelector(rootSessionId) {
    return this.store.write(db => {
      const existing = db.prepare('SELECT 1 FROM selectors WHERE root_session_id=?').get(rootSessionId)
      if (existing) return false
      db.prepare("INSERT INTO selectors(root_session_id,mode,agent_id,revision,updated_at) VALUES(?,'auto',NULL,1,?)")
        .run(rootSessionId, this.now())
      return true
    })
  }

  /** @param {string} rootSessionId */
  selector(rootSessionId) {
    const row = this.store.db.prepare('SELECT mode,agent_id FROM selectors WHERE root_session_id=?').get(rootSessionId)
    if (row?.mode === 'agent') return { mode: 'agent', agentId: row.agent_id }
    if (row?.mode === 'auto') return { mode: 'auto' }
    return { mode: 'off' }
  }
}

/** @param {any} row @param {string} description */
function profileOf(row, description) {
  assertSupportedSchemaVersion(row.schema_version, 'AgentProfile')
  return {
    schemaVersion: row.schema_version, agentId: row.agent_id,
    name: row.name, state: row.state, scope: JSON.parse(row.scope_json),
    ...(row.legacy_origin_alias ? { legacyOriginAlias: row.legacy_origin_alias } : {}),
    userDescription: { revision: row.user_desc_rev, text: description },
    generatedDescription: { revision: 0, text: '' }, modelRoute: JSON.parse(row.chain_json),
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  }
}

/** Resolve the durable root through the existing SessionQuery lineage face. */
export async function resolveRootSession(sessionId, sessionQuery) {
  const trace = await sessionQuery.traceSession(sessionId)
  if (trace.complete !== true || typeof trace.root?.header?.id !== 'string') throw new DecisionContractError('INCOMPLETE_LINEAGE', sessionId)
  return trace.root.header.id
}
