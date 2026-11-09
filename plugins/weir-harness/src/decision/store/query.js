// Read-only projections, rebuildable metrics, and startup-only retention sweeps.
import { assertSupportedSchemaVersion, canonicalJson, DecisionContractError, RETURN_CODES, ROUTE_FAILURE_REASONS } from '../contracts.js'
import { attemptOf } from './attempts.js'
import { caseOf } from './cases.js'
import { evidenceOf, expandEvidence } from './evidence.js'

const WINDOW_MS = { '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 }
const FILTER_KEYS = ['agentId', 'state', 'outcome', 'reasonCode', 'scope', 'feedbackState']

export class DecisionQuery {
  /** @param {import('./db.js').DecisionDatabase} store @param {{now?:()=>number}} [options] */
  constructor(store, options = {}) {
    this.store = store
    this.now = options.now ?? Date.now
  }

  /**
   * @param {{sessionId:string,filter?:Record<string,unknown>,cursor?:string|{after?:string,limit?:number}}} input
   */
  records(input) {
    requireSession(input.sessionId)
    const filter = input.filter ?? {}
    for (const key of Object.keys(filter)) {
      if (!FILTER_KEYS.includes(key)) throw new DecisionContractError('INVALID_RECORD_FILTER', `unknown filter: ${key}`)
    }
    const cursor = typeof input.cursor === 'string' ? { after: input.cursor } : input.cursor ?? {}
    const limit = cursor.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DecisionContractError('INVALID_CURSOR', 'limit must be an integer from 1 to 100')

    const where = ['root_session_id=?']
    const params = [input.sessionId]
    const simple = { agentId: 'agent_id', state: 'state', feedbackState: 'feedback_state' }
    for (const [key, column] of Object.entries(simple)) {
      if (filter[key] !== undefined) {
        if (typeof filter[key] !== 'string') throw new DecisionContractError('INVALID_RECORD_FILTER', `${key} must be a string`)
        where.push(`${column}=?`)
        params.push(filter[key])
      }
    }
    if (filter.outcome !== undefined) {
      if (typeof filter.outcome !== 'string') throw new DecisionContractError('INVALID_RECORD_FILTER', 'outcome must be a string')
      where.push('EXISTS(SELECT 1 FROM attempts a WHERE a.case_id=cases.case_id AND a.outcome=?)')
      params.push(filter.outcome)
    }
    if (filter.reasonCode !== undefined) {
      if (!RETURN_CODES.includes(/** @type {any} */ (filter.reasonCode))) throw new DecisionContractError('INVALID_RECORD_FILTER', 'unknown return reasonCode')
      where.push("(json_extract(decision_json,'$.code')=? OR EXISTS(SELECT 1 FROM attempts a WHERE a.case_id=cases.case_id AND a.return_code=?))")
      params.push(filter.reasonCode, filter.reasonCode)
    }
    let rows = this.store.db.prepare(`SELECT * FROM cases WHERE ${where.join(' AND ')} ORDER BY created_at DESC,case_id DESC`).all(...params).map(caseOf)
    if (filter.scope !== undefined) rows = rows.filter(row => scopeMatches(row.scope, filter.scope))
    if (cursor.after !== undefined) {
      const after = decodeCursor(cursor.after)
      rows = rows.filter(row => row.createdAt < after.createdAt || (row.createdAt === after.createdAt && row.caseId < after.caseId))
    }
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return deepFreeze({
      records: page,
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    })
  }

  /** @param {{caseId:string,sessionId?:string}} input */
  record(input) {
    const row = this.store.db.prepare('SELECT * FROM cases WHERE case_id=?').get(input.caseId)
    if (!row || (input.sessionId !== undefined && row.root_session_id !== input.sessionId)) return null
    const attempts = this.store.db.prepare('SELECT * FROM attempts WHERE case_id=? ORDER BY attempt_no').all(input.caseId).map(attemptRow => {
      const attempt = attemptOf(attemptRow)
      const evidence = this.store.db.prepare(`SELECT evidence.* FROM evidence
        JOIN attempt_evidence ON evidence.evidence_id=attempt_evidence.evidence_id
        WHERE attempt_evidence.attempt_id=? ORDER BY attempt_evidence.ordinal`).all(attempt.attemptId).map(row => expandEvidence(this.store, evidenceOf(row)))
      return { ...attempt, evidence }
    })
    const feedback = this.store.db.prepare('SELECT * FROM feedback WHERE case_id=? ORDER BY created_at,rowid').all(input.caseId).map(feedbackOf)
    const routeDecisions = this.store.db.prepare('SELECT * FROM route_decisions WHERE case_id=? ORDER BY created_at,rowid').all(input.caseId).map(routeOf)
    return deepFreeze({ case: caseOf(row), attempts, feedback, routeDecisions })
  }

  /** @param {{sessionId:string}} input */
  inbox(input) {
    requireSession(input.sessionId)
    return deepFreeze(this.store.db.prepare("SELECT * FROM cases WHERE root_session_id=? AND state='awaiting_user' ORDER BY updated_at DESC,case_id DESC").all(input.sessionId).map(caseOf))
  }

  /** @param {{sessionId:string,window?:'24h'|'7d'|'30d'|'all'}} input */
  metrics(input) {
    requireSession(input.sessionId)
    const window = input.window ?? 'all'
    if (window !== 'all' && !(window in WINDOW_MS)) return null
    const now = this.now()
    const since = window === 'all' ? null : now - WINDOW_MS[window]
    const cases = this.store.db.prepare('SELECT * FROM cases WHERE root_session_id=?').all(input.sessionId)
      .filter(row => within(row.created_at, since))
    const attempts = this.store.db.prepare(`SELECT attempts.* FROM attempts JOIN cases ON cases.case_id=attempts.case_id
      WHERE cases.root_session_id=?`).all(input.sessionId).filter(row => within(row.started_at, since))
    const feedback = this.store.db.prepare(`SELECT feedback.* FROM feedback JOIN cases ON cases.case_id=feedback.case_id
      WHERE cases.root_session_id=?`).all(input.sessionId).filter(row => within(row.created_at, since))
    const routes = this.store.db.prepare(`SELECT route_decisions.* FROM route_decisions
      LEFT JOIN cases ON cases.case_id=route_decisions.case_id
      WHERE route_decisions.root_session_id=?`).all(input.sessionId).filter(row => within(row.created_at, since))

    const returnedByCode = Object.fromEntries(RETURN_CODES.map(code => [code, 0]))
    for (const row of cases) {
      const decision = parseJson(row.decision_json)
      if (decision?.kind === 'return' && decision.code in returnedByCode) returnedByCode[decision.code]++
    }
    const evidenceFailures = { stale: 0, conflicting: 0, deleted: 0 }
    for (const row of attempts) {
      const gates = parseJson(row.gates_json)
      for (const gap of gates?.gaps ?? []) {
        if (gap.gate === 'G3') evidenceFailures.stale++
        if (gap.gate === 'G4') evidenceFailures.conflicting++
        if (typeof gap.detail === 'string' && /deleted/i.test(gap.detail)) evidenceFailures.deleted++
      }
    }
    const ended = attempts.filter(row => row.ended_at !== null)
    const autoAnswered = cases.filter(row => row.closing === 'answered').length
    return deepFreeze({
      window,
      since,
      casesOpened: cases.length,
      attemptsTotal: attempts.length,
      autoAnswered,
      autoAnswerRate: cases.length ? autoAnswered / cases.length : 0,
      returnedByCode,
      escalated: cases.filter(row => row.closing === 'escalated').length,
      exhausted: cases.filter(row => row.awaiting_reason === 'exhausted').length,
      cancelled: cases.filter(row => row.closing === 'cancelled').length,
      interrupted: attempts.filter(row => parseJson(row.error_json)?.kind === 'interrupted').length,
      evidenceFailures,
      ratings: {
        up: feedback.filter(row => row.kind === 'rating_up').length,
        down: feedback.filter(row => row.kind === 'rating_down').length,
        undone: feedback.filter(row => row.kind === 'undo_rating_up' || row.kind === 'undo_rating_down').length,
      },
      corrections: feedback.filter(row => row.kind === 'correction').length,
      reassignments: routes.filter(row => row.mode === 'manual_reassign').length,
      feedbackParticipation: new Set(feedback.map(row => row.case_id)).size,
      // Off is deliberately not sampled; this stable zero is not an activity estimate.
      selectorOffBypasses: 0,
      meanAttemptLatencyMs: ended.length ? ended.reduce((sum, row) => sum + Math.max(0, row.ended_at - row.started_at), 0) / ended.length : 0,
    })
  }

  /** @param {{sessionId:string,window?:'24h'|'7d'|'30d'|'all'}} input */
  async rebuildMetrics(input) {
    const metrics = this.metrics(input)
    if (!metrics) throw new DecisionContractError('INVALID_METRIC_WINDOW', String(input.window))
    const entries = flattenMetrics(metrics)
    const prefix = `${input.sessionId}:${metrics.window}:`
    await this.store.write(db => {
      db.prepare("DELETE FROM metrics_counters WHERE substr(bucket,1,?)=?").run(prefix.length, prefix)
      for (const [name, value] of entries) {
        db.prepare('INSERT INTO metrics_counters(bucket,value) VALUES(?,?)').run(`${prefix}${name}`, value)
      }
    })
    return metrics
  }

  /**
   * Called only by Broker startup. No timer or read-path invocation exists here.
   * @param {number} retentionDays @param {{at?:number}} [options]
   */
  async sweep(retentionDays, options = {}) {
    const retainedCases = () => this.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n
    if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new DecisionContractError('INVALID_RETENTION', 'retentionDays must be a non-negative number')
    if (retentionDays === 0) return { deletedCases: 0, retainedCases: retainedCases() }
    const at = options.at ?? this.now()
    const cutoff = at - retentionDays * 24 * 60 * 60 * 1000
    return this.store.write(db => {
      const candidates = db.prepare(`SELECT case_id FROM cases
        WHERE state='closed' AND feedback_state='none' AND updated_at<?
          AND coalesce(json_extract(decision_json,'$.kind'),'')!='user_decision'
          AND NOT EXISTS(SELECT 1 FROM feedback WHERE feedback.case_id=cases.case_id)
        ORDER BY updated_at,case_id`).all(cutoff)
      for (const { case_id: caseId } of candidates) {
        const attemptIds = db.prepare('SELECT attempt_id FROM attempts WHERE case_id=?').all(caseId).map(row => row.attempt_id)
        if (attemptIds.length) {
          const marks = attemptIds.map(() => '?').join(',')
          db.prepare(`DELETE FROM attempt_evidence WHERE attempt_id IN (${marks})`).run(...attemptIds)
        }
        db.prepare('DELETE FROM attempts WHERE case_id=?').run(caseId)
        db.prepare('DELETE FROM route_decisions WHERE case_id=?').run(caseId)
        db.prepare(`DELETE FROM evidence WHERE json_extract(locator_json,'$.caseId')=?
          AND NOT EXISTS(SELECT 1 FROM attempt_evidence WHERE attempt_evidence.evidence_id=evidence.evidence_id)`).run(caseId)
        db.prepare('DELETE FROM cases WHERE case_id=?').run(caseId)
      }
      if (candidates.length) {
        db.prepare(`INSERT INTO meta(key,value) VALUES('deleted_cases',?)
          ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(meta.value AS INTEGER)+excluded.value AS TEXT)`)
          .run(String(candidates.length))
      }
      return { deletedCases: candidates.length, retainedCases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n }
    })
  }
}

/** @param {unknown} sessionId */
function requireSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new DecisionContractError('INVALID_SESSION', 'sessionId is required')
}

/** @param {any} value @param {unknown} filter */
function scopeMatches(value, filter) {
  if (typeof filter === 'string') return canonicalJson(value).includes(filter)
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new DecisionContractError('INVALID_RECORD_FILTER', 'scope must be a string or object')
  return canonicalJson(value) === canonicalJson(filter)
}

/** @param {any} row */
function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, caseId: row.caseId })).toString('base64url')
}

/** @param {string} value */
function decodeCursor(value) {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Number.isInteger(cursor.createdAt) || typeof cursor.caseId !== 'string' || !cursor.caseId || Object.keys(cursor).some(key => !['createdAt', 'caseId'].includes(key))) throw new Error('shape')
    return cursor
  } catch {
    throw new DecisionContractError('INVALID_CURSOR', 'cursor is not a valid record cursor')
  }
}

/** @param {any} row */
function feedbackOf(row) {
  assertSupportedSchemaVersion(row.schema_version, 'Feedback')
  return {
    schemaVersion: row.schema_version, feedbackId: row.feedback_id, caseId: row.case_id,
    attemptId: row.attempt_id ?? undefined, agentId: row.agent_id, actor: row.actor, kind: row.kind,
    payload: parseJson(row.payload_json) ?? undefined, effect: parseJson(row.effect_json),
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

/** @param {any} row */
function routeOf(row) {
  assertSupportedSchemaVersion(row.schema_version, 'RouteDecision')
  return {
    schemaVersion: row.schema_version, routeDecisionId: row.route_decision_id, caseId: row.case_id ?? undefined,
    rootSessionId: row.root_session_id, mode: row.mode, candidates: parseJson(row.candidates_json),
    chosen: row.chosen ?? undefined, reason: row.reason, ambiguity: parseJson(row.ambiguity_json) ?? undefined,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

/** @param {any} value */
function parseJson(value) {
  return value === null || value === undefined ? null : JSON.parse(value)
}

/** @param {any} value @param {number|null} since */
function within(value, since) {
  return since === null || value >= since
}

/** @param {Record<string,any>} metrics */
function flattenMetrics(metrics) {
  /** @type {[string,number][]} */
  const result = []
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === 'number') result.push([key, value])
    else if (value && typeof value === 'object') {
      for (const [child, item] of Object.entries(value)) if (typeof item === 'number') result.push([`${key}.${child}`, item])
    }
  }
  return result
}

const ROUTING_SUMMARY_BY_OUTCOME = Object.freeze({
  agreement: 'agreement', disagreement: 'disagreement',
  shadow_none: 'shadowNone', shadow_ambiguous: 'shadowAmbiguous', shadow_failure: 'shadowFailure',
  auto_none: 'autoNone', auto_ambiguous: 'autoAmbiguous', auto_failure: 'autoFailure',
  manual_reassign: 'manualReassign', uncomparable: 'uncomparable',
})

/** Project immutable route facts without interpreting natural-language reasons. */
export function projectRoutingChains(chains) {
  const summary = {
    agreement: 0, disagreement: 0,
    shadowNone: 0, shadowAmbiguous: 0, shadowFailure: 0,
    autoNone: 0, autoAmbiguous: 0, autoFailure: 0,
    manualReassign: 0, uncomparable: 0,
  }
  const items = []
  for (const chain of chains) {
    const routes = [...chain.routes].sort((left, right) => left.createdAt - right.createdAt || left.routeDecisionId.localeCompare(right.routeDecisionId))
    const hasShadow = routes.some(route => route.mode === 'auto_shadow')
    for (let index = 0; index < routes.length; index++) {
      const route = routes[index]
      const prior = routes.slice(0, index)
      const classified = classifyRoute(route, prior, hasShadow)
      const summaryKey = ROUTING_SUMMARY_BY_OUTCOME[classified.outcome]
      if (summaryKey) summary[summaryKey]++
      items.push({
        caseId: chain.case.caseId,
        routeDecisionId: route.routeDecisionId,
        mode: route.mode,
        candidates: (Array.isArray(route.candidates) ? route.candidates : []).map(candidate => ({
          agentId: candidate.agentId,
          enabled: candidate.enabled === true,
          ...(typeof candidate.rejectedBecause === 'string' ? { rejectedBecause: candidate.rejectedBecause } : {}),
        })),
        chosen: typeof route.chosen === 'string' && route.chosen ? route.chosen : null,
        reason: typeof route.reason === 'string' ? route.reason : '',
        ambiguity: route.ambiguity && typeof route.ambiguity === 'object' && !Array.isArray(route.ambiguity) ? {
          candidates: Array.isArray(route.ambiguity.candidates) ? route.ambiguity.candidates.filter(value => typeof value === 'string') : [],
          conflict: typeof route.ambiguity.conflict === 'string' ? route.ambiguity.conflict : '',
        } : null,
        createdAt: route.createdAt,
        agentId: typeof chain.case.agentId === 'string' && chain.case.agentId ? chain.case.agentId : null,
        outcome: classified.outcome,
        ...(classified.baselineAgentId === undefined ? {} : { baselineAgentId: classified.baselineAgentId }),
        ...(classified.reassignment === undefined ? {} : { reassignment: classified.reassignment }),
      })
    }
  }
  items.sort((left, right) => right.createdAt - left.createdAt || right.routeDecisionId.localeCompare(left.routeDecisionId))
  return deepFreeze({ summary, items })
}

function classifyRoute(route, prior, hasShadow) {
  if (route.mode === 'manual_reassign') {
    const previous = [...prior].reverse().find(candidate => ['pinned', 'explicit', 'auto', 'manual_reassign'].includes(candidate.mode)
      && typeof candidate.chosen === 'string' && candidate.chosen)
    return {
      outcome: 'manual_reassign',
      reassignment: { from: previous?.chosen ?? null, to: typeof route.chosen === 'string' && route.chosen ? route.chosen : null },
    }
  }
  if (route.mode === 'auto') return { outcome: automaticOutcome(route, 'auto') }
  if (route.mode === 'auto_shadow') {
    const baseline = [...prior].reverse().find(candidate => candidate.mode === 'pinned' && typeof candidate.chosen === 'string' && candidate.chosen)
    if (!baseline) return { outcome: 'uncomparable' }
    if (typeof route.chosen === 'string' && route.chosen) {
      return { outcome: route.chosen === baseline.chosen ? 'agreement' : 'disagreement', baselineAgentId: baseline.chosen }
    }
    return { outcome: automaticOutcome(route, 'shadow'), baselineAgentId: baseline.chosen }
  }
  if (route.mode === 'pinned' && hasShadow && typeof route.chosen === 'string' && route.chosen) return { outcome: 'baseline' }
  return { outcome: 'uncomparable' }
}

function automaticOutcome(route, prefix) {
  if (typeof route.chosen === 'string' && route.chosen) return `${prefix}_selected`
  if (ROUTE_FAILURE_REASONS.includes(route.reason)) return `${prefix}_failure`
  if (route.ambiguity && typeof route.ambiguity === 'object' && !Array.isArray(route.ambiguity)
    && Array.isArray(route.ambiguity.candidates) && typeof route.ambiguity.conflict === 'string') return `${prefix}_ambiguous`
  return `${prefix}_none`
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
