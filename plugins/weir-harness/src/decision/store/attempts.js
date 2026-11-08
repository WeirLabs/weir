// Decision Attempts: one immutable evaluation record per attempt number.
import { randomUUID } from 'node:crypto'
import { assertSupportedSchemaVersion, ATTEMPT_OUTCOMES, DecisionContractError } from '../contracts.js'

export class DecisionAttempts {
  /** @param {import('./db.js').DecisionDatabase} store @param {{now?:()=>number}} [options] */
  constructor(store, options = {}) { this.store = store; this.now = options.now ?? Date.now }

  /** @param {{caseId:string,agentId:string,pins:object,contextPackHash:string,packManifest:object}} input */
  async start(input) {
    const now = this.now()
    const id = `da_${randomUUID()}`
    await this.store.write(db => {
      const current = db.prepare('SELECT attempt_count FROM cases WHERE case_id=?').get(input.caseId)
      if (!current) throw new DecisionContractError('CASE_NOT_FOUND', input.caseId)
      const attemptNo = current.attempt_count + 1
      db.prepare(`INSERT INTO attempts(
        attempt_id,case_id,attempt_no,agent_id,pins_json,context_pack_hash,pack_manifest_json,
        started_at,created_at,updated_at,revision,schema_version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`).run(
        id, input.caseId, attemptNo, input.agentId, JSON.stringify(input.pins),
        input.contextPackHash, JSON.stringify(input.packManifest), now, now, now,
      )
      db.prepare('UPDATE cases SET attempt_count=?,revision=revision+1,updated_at=? WHERE case_id=?').run(attemptNo, now, input.caseId)
    })
    return this.get(id)
  }

  /** @param {string} attemptId @param {{outcome:string,reasonCode?:string,hint?:string,error?:object,claims?:object[],citedEvidenceIds?:string[],gates?:object,inputTokens?:number,outputTokens?:number}} result */
  async finish(attemptId, result) {
    if (!ATTEMPT_OUTCOMES.includes(result.outcome)) throw new DecisionContractError('INVALID_ATTEMPT_OUTCOME', result.outcome)
    await this.store.write(db => {
      const updated = db.prepare(`UPDATE attempts SET outcome=?,return_code=?,return_hint=?,error_json=?,claims_json=?,cited_evidence_ids_json=?,gates_json=?,input_tokens=?,output_tokens=?,ended_at=?,updated_at=?
        WHERE attempt_id=? AND ended_at IS NULL`).run(
        result.outcome, result.reasonCode ?? null, result.hint ?? null, result.error ? JSON.stringify(result.error) : null,
        result.claims ? JSON.stringify(result.claims) : null,
        result.citedEvidenceIds ? JSON.stringify(result.citedEvidenceIds) : null,
        result.gates ? JSON.stringify(result.gates) : null,
        result.inputTokens ?? null, result.outputTokens ?? null, this.now(), this.now(), attemptId,
      )
      if (updated.changes !== 1) throw new DecisionContractError('ATTEMPT_IMMUTABLE', attemptId)
    })
    return this.get(attemptId)
  }

  async interruptOpen(caseId) {
    return this.store.write(db => db.prepare(`UPDATE attempts SET outcome='failed',error_json=?,ended_at=?,updated_at=?
      WHERE case_id=? AND ended_at IS NULL`).run(JSON.stringify({ kind: 'interrupted' }), this.now(), this.now(), caseId).changes)
  }

  async recoverInterrupted() {
    return this.store.write(db => {
      const now = this.now()
      const interrupted = db.prepare("UPDATE attempts SET outcome='failed',error_json=?,ended_at=?,updated_at=? WHERE ended_at IS NULL")
        .run(JSON.stringify({ kind: 'interrupted' }), now, now).changes
      const recovered = db.prepare("UPDATE cases SET state='awaiting_user',awaiting_reason='interrupted',decision_json=NULL,revision=revision+1,updated_at=? WHERE state='evaluating'").run(now).changes
      return { interruptedAttempts: interrupted, recoveredCases: recovered, at: now }
    })
  }

  /** @param {string} caseId */
  forCase(caseId) {
    return this.store.db.prepare('SELECT * FROM attempts WHERE case_id=? ORDER BY attempt_no').all(caseId).map(attemptOf)
  }

  /** @param {string} attemptId */
  get(attemptId) {
    const row = this.store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId)
    if (!row) throw new DecisionContractError('ATTEMPT_NOT_FOUND', attemptId)
    return attemptOf(row)
  }
}

/** @param {any} row */
export function attemptOf(row) {
  assertSupportedSchemaVersion(row.schema_version, 'DecisionAttempt')
  const parse = value => value == null ? null : JSON.parse(value)
  return {
    schemaVersion: row.schema_version, attemptId: row.attempt_id, caseId: row.case_id,
    attemptNo: row.attempt_no, agentId: row.agent_id, outcome: row.outcome,
    reasonCode: row.return_code ?? undefined, hint: row.return_hint ?? undefined,
    inputTokens: row.input_tokens ?? undefined, outputTokens: row.output_tokens ?? undefined,
    error: parse(row.error_json), claims: parse(row.claims_json),
    citedEvidenceIds: parse(row.cited_evidence_ids_json), gates: parse(row.gates_json),
    pins: parse(row.pins_json), contextPackHash: row.context_pack_hash,
    packManifest: parse(row.pack_manifest_json), startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
