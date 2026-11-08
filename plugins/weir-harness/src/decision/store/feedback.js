// Append-only user Feedback and immediately active Corrections.
import { randomUUID } from 'node:crypto'
import { FEEDBACK_KINDS, DecisionContractError } from '../contracts.js'
import { insertEvidence } from './evidence.js'

export class DecisionFeedback {
  /** @param {import('./db.js').DecisionDatabase} store @param {{now?:()=>number,audit?:(kind:string,value:object)=>void}} [options] */
  constructor(store, options = {}) {
    this.store = store
    this.now = options.now ?? Date.now
    this.audit = options.audit ?? (() => {})
  }

  /** @param {{actor:{kind:string},caseId:string,kind:string,payload?:{text?:string,direction?:string,scope?:object,supersedes?:string[]},attemptId?:string}} input */
  async append(input) {
    if (input.actor?.kind !== 'user') {
      this.audit('feedback', { caseId: input.caseId, kind: input.kind, rejected: 'non-user' })
      throw new DecisionContractError('USER_FEEDBACK_ONLY', 'Feedback can only be written by the user surface')
    }
    if (!FEEDBACK_KINDS.includes(input.kind)) throw new DecisionContractError('INVALID_FEEDBACK_KIND', input.kind)
    const currentCase = this.store.db.prepare('SELECT case_id,agent_id,workspace_key,feedback_state,needs_review,state,closing,scope_json FROM cases WHERE case_id=?').get(input.caseId)
    if (!currentCase) throw new DecisionContractError('CASE_NOT_FOUND', input.caseId)
    if (input.kind === 'correction') validateCorrection(input.payload)
    if (input.kind === 'correction') this.assertCorrectionTargets(currentCase, input.payload)
    if (input.kind === 'comment' && typeof input.payload?.text !== 'string') throw new DecisionContractError('INVALID_COMMENT', 'comment text is required')

    const before = project(this.store, input.caseId)
    const after = applyRating(before, input.kind)
    const now = this.now()
    const feedbackId = `fb_${randomUUID()}`
    const effect = {
      feedbackStateBefore: before.state, feedbackStateAfter: after.state,
      needsReview: after.needsReview,
    }
    await this.store.write(db => {
      db.prepare(`INSERT INTO feedback(feedback_id,case_id,attempt_id,agent_id,actor,kind,payload_json,effect_json,created_at,updated_at,revision,schema_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`).run(
        feedbackId, input.caseId, input.attemptId ?? null, currentCase.agent_id, 'user', input.kind,
        input.payload === undefined ? null : JSON.stringify(input.payload), JSON.stringify(effect), now, now,
      )
      if (input.kind === 'correction') {
        const payload = input.payload
        db.prepare('INSERT INTO corrections(feedback_id,agent_id,direction,scope_json,supersedes_json,active,created_at) VALUES(?,?,?,?,?,1,?)')
          .run(feedbackId, currentCase.agent_id, payload.direction, JSON.stringify(payload.scope), JSON.stringify(payload.supersedes), now)
          const evidenceId = `ev_${randomUUID()}`
          db.prepare(`INSERT INTO evidence(evidence_id,agent_id,source,locator_json,excerpt,hash,version,observed_at,scope_json,status,created_at,updated_at,revision,schema_version)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
            evidenceId, currentCase.agent_id, 'user_correction', JSON.stringify({ kind: 'feedback', feedbackId }), payload.direction,
            null, null, null, JSON.stringify(payload.scope), 'active', now, now, 1,
          )
        for (const target of payload.supersedes) {
          db.prepare('UPDATE corrections SET active=0 WHERE feedback_id=?').run(target)
          db.prepare("UPDATE evidence SET status='superseded',updated_at=?,revision=revision+1 WHERE json_extract(locator_json,'$.caseId')=? OR json_extract(locator_json,'$.feedbackId')=?").run(now, target, target)
        }
      }
      if (input.kind === 'rating_up' && currentCase.state === 'closed' && currentCase.closing === 'answered') {
        insertEvidence(db, { agentId: currentCase.agent_id, source: 'agent_record', locator: { kind: 'case', caseId: input.caseId }, scope: JSON.parse(currentCase.scope_json) }, now)
      }
      db.prepare('UPDATE cases SET feedback_state=?,needs_review=?,revision=revision+1,updated_at=? WHERE case_id=?')
        .run(after.state, after.needsReview ? 1 : 0, now, input.caseId)
    })
    this.audit('feedback', { caseId: input.caseId, kind: input.kind, feedbackId })
    return { feedbackId, kind: input.kind, effect, correction: input.kind === 'correction' }
  }

  assertCorrectionTargets(currentCase, payload) {
    for (const target of payload.supersedes) {
      const targetCase = this.store.db.prepare('SELECT agent_id,workspace_key FROM cases WHERE case_id=?').get(target)
      const targetFeedback = this.store.db.prepare('SELECT feedback.agent_id,cases.workspace_key FROM feedback LEFT JOIN cases ON cases.case_id=feedback.case_id WHERE feedback_id=?').get(target)
      const owner = targetCase?.agent_id ?? targetFeedback?.agent_id
      if (!owner) {
        this.audit('feedback', { caseId: currentCase.case_id, kind: 'correction', rejected: 'unknown-target', target })
        throw new DecisionContractError('CORRECTION_TARGET_NOT_FOUND', target)
      }
      const workspace = targetCase?.workspace_key ?? targetFeedback?.workspace_key
      if (owner !== currentCase.agent_id || workspace !== currentCase.workspace_key) {
        this.audit('feedback', { caseId: currentCase.case_id, kind: 'correction', rejected: 'cross-namespace-target', target })
        throw new DecisionContractError('OUT_OF_SCOPE', target)
      }
    }
  }

  /** @param {string} agentId @param {string} workspaceKey */
  activeCorrections(agentId, workspaceKey) {
    return this.store.db.prepare('SELECT * FROM corrections WHERE agent_id=? AND active=1 ORDER BY created_at DESC').all(agentId)
      .map(row => ({
        feedbackId: row.feedback_id, agentId: row.agent_id, direction: row.direction,
        scope: JSON.parse(row.scope_json), supersedes: JSON.parse(row.supersedes_json), createdAt: row.created_at,
      }))
      .filter(correction => correction.scope?.workspaces?.includes(workspaceKey))
  }
}

/** @param {import('./db.js').DecisionDatabase} store @param {string} caseId */
function project(store, caseId) {
  const events = store.db.prepare('SELECT kind FROM feedback WHERE case_id=? ORDER BY created_at,rowid').all(caseId)
  let state = 'none'
  for (const event of events) {
    if (event.kind === 'rating_up') state = 'validated'
    if (event.kind === 'rating_down') state = 'disputed'
    if (event.kind === 'undo_rating_up' && state === 'validated') state = 'none'
    if (event.kind === 'undo_rating_down' && state === 'disputed') state = 'none'
  }
  return { state, needsReview: state === 'disputed' }
}

/** @param {{state:string,needsReview:boolean}} before @param {string} kind */
function applyRating(before, kind) {
  if (kind === 'rating_up') return { state: 'validated', needsReview: false }
  if (kind === 'rating_down') return { state: 'disputed', needsReview: true }
  if (kind === 'undo_rating_up' && before.state === 'validated') return { state: 'none', needsReview: false }
  if (kind === 'undo_rating_down' && before.state === 'disputed') return { state: 'none', needsReview: false }
  return before
}

/** @param {unknown} payload */
function validateCorrection(payload) {
  if (!payload || typeof payload !== 'object') throw new DecisionContractError('INVALID_CORRECTION', 'direction, scope and supersedes are required')
  const value = /** @type {any} */ (payload)
  if (typeof value.direction !== 'string' || value.direction.length === 0) throw new DecisionContractError('INVALID_CORRECTION', 'direction is required')
  if (!value.scope || typeof value.scope !== 'object') throw new DecisionContractError('INVALID_CORRECTION', 'scope is required')
  if (!Array.isArray(value.supersedes) || !value.supersedes.every(entry => typeof entry === 'string')) {
    throw new DecisionContractError('INVALID_CORRECTION', 'supersedes must be a string array')
  }
}
