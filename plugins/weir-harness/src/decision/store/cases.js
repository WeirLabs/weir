// Decision Case lifecycle, idempotent intake, and routing facts.
import { createHash, randomUUID } from 'node:crypto'
import { assertSupportedSchemaVersion, CASE_CLOSINGS, CASE_STATES, ROUTE_MODES, DecisionContractError } from '../contracts.js'
import { insertEvidence } from './evidence.js'
import { DecisionStoreError } from './db.js'

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
  /** @param {import('./db.js').DecisionDatabase} store @param {{now?:()=>number,audit?:(kind:string,value:object)=>void}} [options] */
  constructor(store, options = {}) {
    this.store = store
    this.now = options.now ?? Date.now
    this.audit = options.audit ?? (() => {})
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
        insertEvidence(db, { agentId: change.agentId ?? current.agentId, source: 'user_decision', locator: { kind: 'case', caseId: current.caseId }, scope: current.scope }, now)
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
    await this.store.write(db => {
      db.prepare(`INSERT INTO route_decisions(route_decision_id,case_id,root_session_id,mode,candidates_json,chosen,reason,ambiguity_json,created_at,updated_at,revision,schema_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`).run(
        id, input.caseId ?? null, input.rootSessionId, input.mode, JSON.stringify(input.candidates ?? []),
        input.chosen ?? null, input.reason, input.ambiguity ? JSON.stringify(input.ambiguity) : null, now, now,
      )
    })
    return id
  }
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
