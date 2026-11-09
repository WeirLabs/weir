// Agent Profile lifecycle, user-owned description revisions, and root selectors.
import { randomUUID } from 'node:crypto'
import { assertSupportedSchemaVersion, DecisionContractError } from '../contracts.js'

/** @typedef {{ workspaces: string[], paths?: string[], tags?: string[], authorizationClasses?: ('A'|'B'|'C')[] }} CaseScope */
/** @typedef {{ provider: string, model: string, reasoningEffort?: string }} ModelRung */

/** @param {unknown} workspaceKey @param {unknown} scope @returns {CaseScope} */
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
  const classes = input.authorizationClasses ?? ['A', 'B', 'C']
  if (!Array.isArray(classes) || !classes.every(entry => ['A', 'B', 'C'].includes(entry))) {
    throw new DecisionContractError('INVALID_AUTHORITY', 'authorizationClasses must contain only A/B/C')
  }
  result.authorizationClasses = [...new Set(classes)]
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

  /** @param {{ workspaceKey: string, name: string, userDescription?: string, scope?: unknown, modelRoute?: { chain: unknown } }} input */
  async createProfile(input) {
    const name = input.name?.trim()
    if (!name) throw new DecisionContractError('INVALID_PROFILE_NAME', 'name is required')
    const scope = parseScope(input.workspaceKey, input.scope)
    const chain = parseChain(input.modelRoute?.chain)
    const now = this.now()
    const profile = {
      schemaVersion: 1, agentId: `ag_${randomUUID()}`, workspaceKey: input.workspaceKey,
      name, state: 'enabled', scope,
      userDescription: { revision: 1, text: input.userDescription ?? '' },
      generatedDescription: { revision: 0, text: '' }, modelRoute: { chain },
      revision: 1, createdAt: now, updatedAt: now,
    }
    await this.store.write(db => {
      db.prepare(`INSERT INTO agent_profiles(
        agent_id,workspace_key,name,state,scope_json,user_desc_rev,generated_desc_rev,
        chain_json,revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        profile.agentId, profile.workspaceKey, profile.name, profile.state, JSON.stringify(scope),
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
    const scope = patch.scope === undefined ? current.scope : parseScope(current.workspaceKey, patch.scope)
    const chain = patch.modelRoute === undefined ? current.modelRoute.chain : parseChain(patch.modelRoute.chain)
    const description = patch.userDescription === undefined ? current.userDescription : {
      revision: current.userDescription.revision + 1, text: patch.userDescription,
    }
    const now = this.now()
    await this.store.write(db => {
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

  /** @param {string} workspaceKey @param {{includeArchived?: boolean}} [options] */
  listProfiles(workspaceKey, options = {}) {
    const rows = this.store.db.prepare(`SELECT * FROM agent_profiles WHERE workspace_key=? ${options.includeArchived ? '' : "AND state!='archived'"} ORDER BY name COLLATE NOCASE`).all(workspaceKey)
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
    schemaVersion: row.schema_version, agentId: row.agent_id, workspaceKey: row.workspace_key,
    name: row.name, state: row.state, scope: JSON.parse(row.scope_json),
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
