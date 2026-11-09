// Decision Case lifecycle, idempotent intake, and routing facts.
import { createHash, randomUUID } from 'node:crypto'
import { assertSupportedSchemaVersion, CASE_CLOSINGS, CASE_STATES, ROUTE_MODES, DecisionContractError } from '../contracts.js'
import { insertEvidence } from './evidence.js'
import { DecisionStoreError } from './db.js'
import { DecisionProfiles } from './profiles.js'
import { scopeCovers } from '../scope.js'

export class IllegalTransition extends DecisionStoreError {
  /** @param {string} detail */ constructor(detail) { super('ILLEGAL_TRANSITION', detail) }
}
export class RevisionConflict extends DecisionStoreError {
  /** @param {string} caseId */ constructor(caseId) { super('REVISION_CONFLICT', `case revision changed: ${caseId}`) }
}

/** @param {unknown} value @returns {string} */
export function decisionIdempotencyKey(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const ALLOWED = {
  received: { evaluating: true, awaiting_user: true, closed: ['cancelled'] },
  evaluating: { awaiting_revision: true, awaiting_user: true, closed: ['answered', 'cancelled'] },
  awaiting_revision: { evaluating: true, closed: ['returned', 'cancelled'] },
  awaiting_user: { evaluating: true, closed: ['escalated', 'cancelled'] },
  closed: {},
}

export class DecisionCases {
  /** @param {import('./db.js').DecisionDatabase} store @param {{now?:()=>number,audit?:(kind:string,value:object)=>void,profiles?:DecisionProfiles}} [options] */
  constructor(store, options = {}) {
    this.store = store
    this.now = options.now ?? Date.now
    this.audit = options.audit ?? (() => {})
    this.profiles = options.profiles ?? new DecisionProfiles(store, { now: this.now })
  }

  /** @param {Record<string, any>} input */
  async createCase(input) {
    const key = input.idempotencyKey ?? decisionIdempotencyKey({
      rootSessionId: input.rootSessionId, callId: input.callId,
      questions: (input.request?.questions ?? []).map(question => ({ id: question.id, question: question.question })),
    })
    const existing = this.byIdempotencyKey(key)
    if (existing) return { case: existing, created: false }
    const now = this.now()
    const caseId = `dc_${randomUUID()}`
    const value = {
      schemaVersion: 1, caseId, workspaceKey: input.workspaceKey,
      rootSessionId: input.rootSessionId, originSessionId: input.originSessionId ?? input.rootSessionId,
      originKind: input.originKind ?? 'root', entry: input.entry,
      agentId: input.agentId ?? null, request: input.request, scope: input.scope,
      idempotencyKey: key, state: 'received', attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 3, feedbackState: 'none', needsReview: false,
      revision: 1, createdAt: now, updatedAt: now,
    }
    for (const field of ['workspaceKey', 'rootSessionId', 'originSessionId', 'entry']) {
      if (typeof value[field] !== 'string' || value[field].length === 0) throw new DecisionContractError('INVALID_CASE', `${field} is required`)
    }
    let duplicate
    try {
      await this.store.write(db => {
        duplicate = db.prepare('SELECT * FROM cases WHERE idempotency_key=?').get(key)
        if (duplicate) return
        db.prepare(`INSERT INTO cases(
          case_id,workspace_key,root_session_id,origin_session_id,origin_kind,entry,agent_id,
          request_json,scope_json,idempotency_key,state,attempt_count,max_attempts,
          feedback_state,needs_review,revision,created_at,updated_at,schema_version
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
          value.caseId, value.workspaceKey, value.rootSessionId, value.originSessionId, value.originKind,
          value.entry, value.agentId, JSON.stringify(value.request), JSON.stringify(value.scope),
          key, value.state, 0, value.maxAttempts, 'none', 0, 1, now, now,
        )
      })
    } catch (error) {
      const persisted = this.byIdempotencyKey(key)
      if (persisted) return { case: persisted, created: false }
      throw error
    }
    if (duplicate) return { case: caseOf(duplicate), created: false }
    return { case: this.getCase(caseId), created: true }
  }

  /** @param {string} key */
  byIdempotencyKey(key) {
    const row = this.store.db.prepare('SELECT * FROM cases WHERE idempotency_key=?').get(key)
    return row ? caseOf(row) : null
  }

  /** @param {string} caseId */
  getCase(caseId) {
    const row = this.store.db.prepare('SELECT * FROM cases WHERE case_id=?').get(caseId)
    if (!row) throw new DecisionContractError('CASE_NOT_FOUND', caseId)
    return caseOf(row)
  }

  /** @param {{caseId:string,expectedState:string,expectedRevision:number,state:string,closing?:string,awaitingReason?:string,decision?:object,escalation?:object,agentId?:string,request?:object,scope?:object,maxAttempts?:number}} change */
  async transition(change) {
    const current = this.getCase(change.caseId)
    if (current.revision !== change.expectedRevision) throw new RevisionConflict(change.caseId)
    if (!CASE_STATES.includes(change.state)) throw new DecisionContractError('INVALID_CASE_STATE', change.state)
    if (change.state === 'closed') {
      if (!change.closing || !CASE_CLOSINGS.includes(change.closing)) throw new DecisionContractError('INVALID_CASE_CLOSING', String(change.closing))
      if (!ALLOWED[current.state]?.closed?.includes(change.closing)) return this.rejectTransition(current, `closed(${change.closing})`)
    } else if (!ALLOWED[current.state]?.[change.state]) {
      return this.rejectTransition(current, change.state)
    }
    const now = this.now()
    await this.store.write(db => {
      if (change.state === 'closed' && change.closing === 'escalated' && change.decision?.kind === 'user_decision') {
        const agentId = change.agentId ?? current.agentId
        if (typeof agentId === 'string' && agentId) insertEvidence(db, { agentId, source: 'user_decision', locator: { kind: 'case', caseId: current.caseId }, scope: current.scope }, now)
      }
      const result = db.prepare(`UPDATE cases SET state=?,closing=?,awaiting_reason=?,decision_json=?,escalation_json=?,agent_id=?,request_json=?,scope_json=?,max_attempts=?,closed_at=?,revision=revision+1,updated_at=?
        WHERE case_id=? AND state=? AND revision=?`).run(
        change.state, change.closing ?? null, change.awaitingReason ?? null,
        change.decision === undefined ? current.decision ? JSON.stringify(current.decision) : null : JSON.stringify(change.decision),
        change.escalation === undefined ? current.escalation ? JSON.stringify(current.escalation) : null : JSON.stringify(change.escalation),
        change.agentId ?? current.agentId,
        change.request === undefined ? JSON.stringify(current.request) : JSON.stringify(change.request),
        change.scope === undefined ? JSON.stringify(current.scope) : JSON.stringify(change.scope),
        change.maxAttempts ?? current.maxAttempts,
        change.state === 'closed' ? now : null, now,
        change.caseId, change.expectedState, change.expectedRevision,
      )
      if (result.changes !== 1) throw new RevisionConflict(change.caseId)
    })
    return this.getCase(change.caseId)
  }

  /** Commit one route fact and its guarded Case transition in the same write. */
  async transitionWithRoute(change, route) {
    if (!ROUTE_MODES.includes(route.mode)) throw new DecisionContractError('INVALID_ROUTE_MODE', route.mode)
    const now = this.now()
    const routeId = `rd_${randomUUID()}`
    await this.store.write(db => {
      const row = db.prepare('SELECT * FROM cases WHERE case_id=?').get(change.caseId)
      if (!row) throw new DecisionContractError('CASE_NOT_FOUND', change.caseId)
      const current = caseOf(row)
      if (current.revision !== change.expectedRevision) throw new RevisionConflict(change.caseId)
      if ((route.caseId ?? current.caseId) !== current.caseId || route.rootSessionId !== current.rootSessionId) {
        throw new DecisionContractError('ROUTE_CASE_MISMATCH', change.caseId)
      }

      let next = change
      let fact = route
      if (route.mode === 'auto' && change.state === 'evaluating') {
        let profile
        if (typeof route.chosen === 'string') {
          try { profile = this.profiles.getProfile(route.chosen) } catch (error) {
            if (error?.code !== 'PROFILE_NOT_FOUND') throw error
          }
        }
        if (!autoTargetEligible(profile, current, change, route.chosen)) {
          next = { ...change, state: 'awaiting_user', awaitingReason: 'no_route', agentId: null }
          fact = { ...route, chosen: undefined, reason: 'none:no_candidates' }
        }
      }
      if (next.state !== 'evaluating') fact = { ...fact, chosen: undefined }
      if (!CASE_STATES.includes(next.state)) throw new DecisionContractError('INVALID_CASE_STATE', next.state)
      if (next.state === 'closed') {
        if (!next.closing || !CASE_CLOSINGS.includes(next.closing)) throw new DecisionContractError('INVALID_CASE_CLOSING', String(next.closing))
        if (!ALLOWED[current.state]?.closed?.includes(next.closing)) return this.rejectTransition(current, `closed(${next.closing})`)
      } else if (!ALLOWED[current.state]?.[next.state]) {
        return this.rejectTransition(current, next.state)
      }

      insertRoute(db, fact, now, routeId)
      if (next.state === 'closed' && next.closing === 'escalated' && next.decision?.kind === 'user_decision') {
        const agentId = next.agentId ?? current.agentId
        if (typeof agentId === 'string' && agentId) insertEvidence(db, { agentId, source: 'user_decision', locator: { kind: 'case', caseId: current.caseId }, scope: current.scope }, now)
      }
      const result = db.prepare(`UPDATE cases SET state=?,closing=?,awaiting_reason=?,decision_json=?,escalation_json=?,agent_id=?,request_json=?,scope_json=?,max_attempts=?,closed_at=?,revision=revision+1,updated_at=?
        WHERE case_id=? AND state=? AND revision=?`).run(
        next.state, next.closing ?? null, next.awaitingReason ?? null,
        next.decision === undefined ? current.decision ? JSON.stringify(current.decision) : null : JSON.stringify(next.decision),
        next.escalation === undefined ? current.escalation ? JSON.stringify(current.escalation) : null : JSON.stringify(next.escalation),
        Object.hasOwn(next, 'agentId') ? next.agentId : current.agentId,
        next.request === undefined ? JSON.stringify(current.request) : JSON.stringify(next.request),
        next.scope === undefined ? JSON.stringify(current.scope) : JSON.stringify(next.scope),
        next.maxAttempts ?? current.maxAttempts,
        next.state === 'closed' ? now : null, now,
        next.caseId, next.expectedState, next.expectedRevision,
      )
      if (result.changes !== 1) throw new RevisionConflict(change.caseId)
    })
    return this.getCase(change.caseId)
  }

  rejectTransition(current, target) {
    const error = new IllegalTransition(`${current.state} -> ${target}`)
    this.audit('illegal-transition', { caseId: current.caseId, from: current.state, target })
    throw error
  }

  /** @param {{caseId?:string,rootSessionId:string,mode:string,candidates?:object[],chosen?:string,reason:string,ambiguity?:object}} input */
  async recordRoute(input) {
    if (!ROUTE_MODES.includes(input.mode)) throw new DecisionContractError('INVALID_ROUTE_MODE', input.mode)
    const now = this.now()
    const id = `rd_${randomUUID()}`
    await this.store.write(db => { insertRoute(db, input, now, id) })
    return id
  }
}

/** @param {import('node:sqlite').DatabaseSync} db @param {any} input @param {number} now @param {string} id */
function insertRoute(db, input, now, id) {
  db.prepare(`INSERT INTO route_decisions(route_decision_id,case_id,root_session_id,mode,candidates_json,chosen,reason,ambiguity_json,created_at,updated_at,revision,schema_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`).run(
    id, input.caseId ?? null, input.rootSessionId, input.mode, JSON.stringify(input.candidates ?? []),
    input.chosen ?? null, input.reason, input.ambiguity ? JSON.stringify(input.ambiguity) : null, now, now,
  )
}

/** Re-read Auto selection authority against the final normalized request. */
function autoTargetEligible(profile, current, change, chosen) {
  if (!profile || change.agentId !== chosen || profile.state !== 'enabled' || profile.workspaceKey !== current.workspaceKey) return false
  const request = change.request ?? current.request
  const scope = change.scope ?? current.scope
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const classes = questions.map(question => question?.authorizationClass)
  return questions.length > 0
    && classes.every(value => ['A', 'B', 'C'].includes(value))
    && scopeCovers(profile.scope, scope, current.workspaceKey)
    && classes.every(value => profile.scope?.authorizationClasses?.includes(value))
}

/** @param {any} row */
export function caseOf(row) {
  assertSupportedSchemaVersion(row.schema_version, 'DecisionCase')
  const parse = value => value == null ? null : JSON.parse(value)
  return {
    schemaVersion: row.schema_version, caseId: row.case_id, workspaceKey: row.workspace_key,
    rootSessionId: row.root_session_id, originSessionId: row.origin_session_id,
    originKind: row.origin_kind, entry: row.entry, agentId: row.agent_id,
    request: parse(row.request_json), scope: parse(row.scope_json), idempotencyKey: row.idempotency_key,
    state: row.state, closing: row.closing, awaitingReason: row.awaiting_reason,
    attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
    feedbackState: row.feedback_state, needsReview: row.needs_review === 1,
    escalation: parse(row.escalation_json), decision: parse(row.decision_json),
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
  }
}
