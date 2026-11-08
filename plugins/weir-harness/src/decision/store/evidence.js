// Evidence references, namespace isolation, and eligibility for future answers.
import { randomUUID } from 'node:crypto'
import { assertSupportedSchemaVersion, canonicalJson, EVIDENCE_SOURCES, EVIDENCE_STATUSES, DecisionContractError } from '../contracts.js'

/** @param {unknown} evidenceScope @param {unknown} requestedScope @param {string} workspaceKey */
export function scopeCovers(evidenceScope, requestedScope, workspaceKey) {
  if (!evidenceScope || !requestedScope || !evidenceScope.workspaces?.includes(workspaceKey)) return false
  if (!requestedScope.workspaces?.includes(workspaceKey)) return false
  const paths = evidenceScope.paths ?? []
  const requestedPaths = requestedScope.paths ?? []
  if (paths.length && (!requestedPaths.length || requestedPaths.some(path => !paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))))) return false
  const tags = evidenceScope.tags ?? []
  const requestedTags = requestedScope.tags ?? []
  if (tags.length && (!requestedTags.length || requestedTags.some(tag => !tags.includes(tag)))) return false
  return true
}

export class DecisionEvidence {
  /** @param {import('./db.js').DecisionDatabase} store @param {{now?:()=>number}} [options] */
  constructor(store, options = {}) { this.store = store; this.now = options.now ?? Date.now }

  /** @param {Record<string, any>} input */
  async add(input) {
    let value
    await this.store.write(db => { value = insertEvidence(db, input, this.now()) })
    return value
  }

  /** @param {string} attemptId @param {string[]} evidenceIds */
  async attach(attemptId, evidenceIds) {
    await this.store.write(db => {
      evidenceIds.forEach((evidenceId, ordinal) => {
        db.prepare('INSERT INTO attempt_evidence(attempt_id,ordinal,evidence_id) VALUES(?,?,?)').run(attemptId, ordinal, evidenceId)
      })
    })
  }

  /** @param {string} attemptId */
  forAttempt(attemptId) {
    return this.store.db.prepare('SELECT evidence.* FROM evidence JOIN attempt_evidence ON evidence.evidence_id=attempt_evidence.evidence_id WHERE attempt_evidence.attempt_id=? ORDER BY attempt_evidence.ordinal').all(attemptId).map(row => expandEvidence(this.store, evidenceOf(row)))
  }

  /** @param {string} evidenceId */
  get(evidenceId) {
    const row = this.store.db.prepare('SELECT * FROM evidence WHERE evidence_id=?').get(evidenceId)
    if (!row) throw new DecisionContractError('EVIDENCE_NOT_FOUND', evidenceId)
    return expandEvidence(this.store, evidenceOf(row))
  }

  /**
   * Only the named Agent and workspace are readable. There is deliberately no
   * cross-Agent query parameter.
   * @param {{agentId:string,workspaceKey:string,scope:object,attemptStartedAt?:number}} input
   */
  candidates(input) {
    const rows = this.store.db.prepare('SELECT * FROM evidence WHERE agent_id=? ORDER BY created_at DESC').all(input.agentId)
    const eligible = []
    for (const row of rows) {
      const evidence = evidenceOf(row)
      const issue = this.eligibilityIssue(evidence, input)
      if (!issue) eligible.push(expandEvidence(this.store, evidence))
    }
    return eligible.sort((left, right) => rank(left.source) - rank(right.source) || right.createdAt - left.createdAt)
  }

  conflictPairs(refs) {
    const records = refs.filter(ref => ref.locator?.kind === 'case').map(ref => {
      const row = this.store.db.prepare('SELECT request_json,decision_json FROM cases WHERE case_id=?').get(ref.locator.caseId)
      return { ref, request: row?.request_json ? JSON.parse(row.request_json) : null, decision: row?.decision_json ? JSON.parse(row.decision_json) : null }
    }).filter(record => Array.isArray(record.decision?.answers))
    const pairs = []
    for (let left = 0; left < records.length; left++) for (let right = left + 1; right < records.length; right++) {
      const a = records[left]
      const b = records[right]
      if (a.ref.evidenceId === b.ref.evidenceId) continue
      for (const question of a.request?.questions ?? []) {
        const other = (b.request?.questions ?? []).find(item => item.question === question.question)
        if (!other) continue
        const answerA = a.decision.answers.find(item => item.id === question.id)
        const answerB = b.decision.answers.find(item => item.id === other.id)
        if (answerA && answerB && canonicalJson({ selected: answerA.selected, custom: answerA.custom }) !== canonicalJson({ selected: answerB.selected, custom: answerB.custom })) pairs.push([a.ref.evidenceId, b.ref.evidenceId])
      }
    }
    return pairs
  }
  /** @param {string[]} evidenceIds @param {{workspaceKey:string,scope:object,attemptStartedAt?:number}} input */
  eligibilityIssues(evidenceIds, input) {
    return evidenceIds.map(evidenceId => {
      const evidence = this.get(evidenceId)
      const issue = this.eligibilityIssue(evidence, { ...input, agentId: evidence.agentId })
      return issue ? { evidenceId, ...issue } : null
    }).filter(Boolean)
  }

  /** @param {any} evidence @param {{agentId:string,workspaceKey:string,scope:object,attemptStartedAt?:number}} input */
  eligibilityIssue(evidence, input) {
    if (evidence.agentId !== input.agentId) return { gate: 'G2', code: 'OUT_OF_SCOPE' }
    if (evidence.status !== 'active') return { gate: 'G3', code: 'STALE_EVIDENCE' }
    if (!scopeCovers(evidence.scope, input.scope, input.workspaceKey)) return { gate: 'G2', code: 'OUT_OF_SCOPE' }
    const locator = evidence.locator
    if (locator.kind === 'case') {
      const sourceCase = this.store.db.prepare('SELECT feedback_state,decision_json,state,closing FROM cases WHERE case_id=?').get(locator.caseId)
      if (!sourceCase || sourceCase.feedback_state === 'disputed') return { gate: 'G3', code: 'STALE_EVIDENCE' }
      const decision = sourceCase.decision_json ? JSON.parse(sourceCase.decision_json) : null
      if (evidence.source === 'user_decision' && decision?.kind !== 'user_decision') return { gate: 'G3', code: 'STALE_EVIDENCE' }
      if (evidence.source === 'agent_record' && sourceCase.feedback_state !== 'validated') return { gate: 'G3', code: 'STALE_EVIDENCE' }
    }
    if (evidence.source === 'user_correction') {
      const correction = this.store.db.prepare('SELECT active FROM corrections WHERE feedback_id=?').get(locator.feedbackId)
      if (!correction?.active) return { gate: 'G3', code: 'STALE_EVIDENCE' }
    }
    if (evidence.source === 'current_observation' && (!evidence.observedAt || !evidence.hash || evidence.observedAt < (input.attemptStartedAt ?? 0))) {
      return { gate: 'G5', code: 'STALE_EVIDENCE' }
    }
    return null
  }
}

export function insertEvidence(db, input, now = Date.now()) {
  if (!EVIDENCE_SOURCES.includes(input.source)) throw new DecisionContractError('INVALID_EVIDENCE_SOURCE', input.source)
  if (input.status && !EVIDENCE_STATUSES.includes(input.status)) throw new DecisionContractError('INVALID_EVIDENCE_STATUS', input.status)
  if (typeof input.agentId !== 'string' || !input.agentId) throw new DecisionContractError('INVALID_EVIDENCE_AGENT', 'agentId is required')
  if (!input.locator || typeof input.locator !== 'object') throw new DecisionContractError('INVALID_EVIDENCE_LOCATOR', 'locator is required')
  const locatorJson = JSON.stringify(input.locator)
  if (['user_decision', 'agent_record'].includes(input.source)) {
    const existing = db.prepare('SELECT * FROM evidence WHERE agent_id=? AND source=? AND locator_json=?').get(input.agentId, input.source, locatorJson)
    if (existing) return evidenceOf(existing)
  }
  const id = `ev_${randomUUID()}`
  const value = {
    schemaVersion: 1, evidenceId: id, agentId: input.agentId, source: input.source,
    locator: input.locator, excerpt: input.excerpt, hash: input.hash, version: input.version,
    observedAt: input.observedAt, scope: input.scope, status: input.status ?? 'active',
    revision: 1, createdAt: now, updatedAt: now,
  }
  db.prepare(`INSERT INTO evidence(evidence_id,agent_id,source,locator_json,excerpt,hash,version,observed_at,scope_json,status,created_at,updated_at,revision,schema_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    id, input.agentId, input.source, locatorJson, input.excerpt ?? null,
    input.hash ?? null, input.version ?? null, input.observedAt ?? null,
    JSON.stringify(input.scope), value.status, now, now, 1,
  )
  return value
}

export function expandEvidence(store, evidence) {
  if (evidence.excerpt !== undefined || evidence.locator?.kind !== 'case') return evidence
  const row = store.db.prepare('SELECT request_json,decision_json FROM cases WHERE case_id=?').get(evidence.locator.caseId)
  if (!row?.decision_json) return evidence
  const request = row.request_json ? JSON.parse(row.request_json) : { questions: [] }
  const decision = JSON.parse(row.decision_json)
  if (!['user_decision', 'answer'].includes(decision.kind) || !Array.isArray(decision.answers)) return evidence
  const lines = decision.answers.map(answer => {
    const question = (request.questions ?? []).find(item => item.id === answer.id)
    const selected = [...(answer.selected ?? []), ...(answer.custom === undefined ? [] : [answer.custom])].join(', ')
    return `${decision.kind === 'user_decision' ? 'User decision' : 'Validated agent answer'} ${answer.id}: ${selected}${question ? ` | question: ${question.question}` : ''}`
  }).filter(Boolean)
  return lines.length ? { ...evidence, excerpt: lines.join('\n').slice(0, 600) } : evidence
}

/** @param {string} source */
function rank(source) {
  return ({ user_correction: 0, user_profile: 1, user_decision: 2, current_observation: 3, repo_doc: 4, agent_record: 5 })[source] ?? 9
}

/** @param {any} row */
export function evidenceOf(row) {
  assertSupportedSchemaVersion(row.schema_version, 'EvidenceRef')
  return {
    schemaVersion: row.schema_version, evidenceId: row.evidence_id, agentId: row.agent_id,
    source: row.source, locator: JSON.parse(row.locator_json), excerpt: row.excerpt ?? undefined,
    hash: row.hash ?? undefined, version: row.version ?? undefined,
    observedAt: row.observed_at ?? undefined, scope: JSON.parse(row.scope_json), status: row.status,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
