// Disposable P0 Desktop store. Authority is ALWAYS the lane-local spike DB.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const parse = text => text ? JSON.parse(text) : null

export class P0SpikeStore {
  constructor(ctx, dbPath, logPath) {
    this.ctx = ctx
    this.logPath = logPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.prepare('PRAGMA journal_mode=WAL').get()
    this.db.prepare('PRAGMA busy_timeout=3000').get()
    this.db.prepare('PRAGMA foreign_keys=ON').get()
    this.db.exec(`CREATE TABLE IF NOT EXISTS selectors (root_session_id TEXT PRIMARY KEY, agent_id TEXT);
      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY, root_session_id TEXT NOT NULL, origin_session_id TEXT NOT NULL,
        state TEXT NOT NULL, closing TEXT, awaiting_reason TEXT, feedback_state TEXT NOT NULL DEFAULT 'none',
        needs_review INTEGER NOT NULL DEFAULT 0, decision_json TEXT, suggestion_json TEXT,
        idempotency_key TEXT, tool_name TEXT, revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, outcome TEXT, failure TEXT,
        ended_at INTEGER, started_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feedback (
        feedback_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
      );`)
    this.recovery = this.recover()
  }

  log(kind, value) {
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, JSON.stringify({ time: Date.now(), kind, ...value }) + '\n')
  }

  recover() {
    const interruptedAt = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const attempts = this.db.prepare('UPDATE attempts SET outcome=?, failure=?, ended_at=? WHERE ended_at IS NULL').run('failed', 'interrupted', interruptedAt).changes
      const cases = this.db.prepare("UPDATE cases SET state='awaiting_user', awaiting_reason='interrupted', decision_json=NULL, revision=revision+1 WHERE state='evaluating'").run().changes
      this.db.exec('COMMIT')
      const result = { interruptedAttempts: attempts, recoveredCases: cases, at: interruptedAt }
      this.log('recover', result)
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close() { this.db.close() }

  async rootOf(sessionId) {
    const query = this.ctx.get('sessionQuery')
    const trace = await query.traceSession(sessionId)
    if (trace.complete !== true) throw new Error(`incomplete lineage for ${sessionId}`)
    return trace.root.header.id
  }

  selector(sessionId) {
    const row = this.db.prepare('SELECT agent_id FROM selectors WHERE root_session_id=?').get(sessionId)
    return row?.agent_id ? { mode: 'agent', agentId: row.agent_id } : { mode: 'off' }
  }

  setSelector(sessionId, mode) {
    if (mode === 'off') this.db.prepare('DELETE FROM selectors WHERE root_session_id=?').run(sessionId)
    else if (mode === 'agent') this.db.prepare('INSERT INTO selectors(root_session_id,agent_id) VALUES (?,?) ON CONFLICT(root_session_id) DO UPDATE SET agent_id=excluded.agent_id').run(sessionId, 'agent-a')
    else throw new Error(`unknown selector mode ${mode}`)
    this.log('selector', { sessionId, mode })
    return this.selector(sessionId)
  }

  createCase({ rootSessionId, originSessionId = rootSessionId, state, closing = null, awaitingReason = null, decision = null, suggestion = null, idempotencyKey = null, toolName = null, attempt = true }) {
    const caseId = `dc_${randomUUID()}`
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO cases(case_id,root_session_id,origin_session_id,state,closing,awaiting_reason,decision_json,suggestion_json,idempotency_key,tool_name) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(caseId, rootSessionId, originSessionId, state, closing, awaitingReason, decision ? JSON.stringify(decision) : null, suggestion ? JSON.stringify(suggestion) : null, idempotencyKey, toolName)
      if (attempt) this.db.prepare('INSERT INTO attempts(attempt_id,case_id,outcome,failure,ended_at,started_at) VALUES (?,?,?,?,?,?)')
        .run(`da_${randomUUID()}`, caseId, closing === 'answered' ? 'answer' : null, null, state === 'evaluating' || state.startsWith('awaiting_') ? null : Date.now(), Date.now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return caseId
  }

  answersFor(questions) {
    return questions.map(question => ({
      id: question.id,
      selected: question.multiSelect ? (question.options ?? []).slice(0, 2).map(option => option.label) : [question.options?.[0]?.label ?? 'Answered'],
      ...(question.options ? {} : { custom: 'Spike answer' }),
    }))
  }

  async hook({ agent, request, next }) {
    const rootSessionId = await this.rootOf(agent.id)
    const selector = this.selector(rootSessionId)
    if (selector.mode === 'off') {
      this.log('hook', { rootSessionId, selector: 'off', questionIds: request.questions.map(item => item.id), caseCreated: false, nextCalled: true })
      return next()
    }
    if (request.questions.some(question => question.intent?.kind === 'approval' || question.intent?.kind === 'plan-review')) {
      this.log('hook', { rootSessionId, selector: 'agent', excluded: true, caseCreated: false, nextCalled: true })
      return next()
    }
    const partial = request.questions.some(question => question.id.startsWith('partial-'))
    const answers = this.answersFor(request.questions)
    if (!partial) {
      const caseId = this.createCase({ rootSessionId, state: 'closed', closing: 'answered', decision: { kind: 'answer', answers }, toolName: 'ask_user_question' })
      this.log('hook', { rootSessionId, selector: 'agent', questionIds: request.questions.map(item => item.id), questionShapes: request.questions.map(item => ({ id: item.id, multiSelect: item.multiSelect, optionLabels: item.options?.map(option => option.label) })), caseId, caseCreated: true, nextCalled: false, answers })
      return { answers }
    }
    const suggestion = { perQuestion: request.questions.map((question, index) => ({ id: question.id, outcome: index === 1 ? 'return' : 'answer', detail: index === 1 ? 'Missing evidence in spike fixture' : 'Answerable suggestion' })) }
    const caseId = this.createCase({ rootSessionId, state: 'awaiting_user', awaitingReason: 'partial_batch', suggestion, toolName: 'ask_user_question' })
    this.log('hook', { rootSessionId, selector: 'agent', questionIds: request.questions.map(item => item.id), caseId, caseCreated: true, nextCalled: true, suggestion })
    try {
      const userAnswer = await next()
      this.db.prepare("UPDATE cases SET state='closed', closing='escalated', decision_json=?, revision=revision+1 WHERE case_id=? AND state='awaiting_user'")
        .run(JSON.stringify({ kind: 'user_decision', answers: userAnswer.answers }), caseId)
      return userAnswer
    } catch (error) {
      this.db.prepare("UPDATE cases SET state='closed', closing='cancelled', revision=revision+1 WHERE case_id=?").run(caseId)
      throw error
    }
  }

  async consult(agent, args) {
    const rootSessionId = await this.rootOf(agent.id)
    const questions = [{ id: 'consult', question: args.question, options: args.options }]
    const answers = this.answersFor(questions)
    const caseId = this.createCase({
      rootSessionId, originSessionId: agent.id, state: 'closed', closing: 'answered',
      decision: { kind: 'answer', answers }, toolName: 'decision_consult', idempotencyKey: args.request_id ?? null,
    })
    return { outcome: 'answered', caseId, answers, evidence: [{ kind: 'case', caseId }], pins: { revision: 1 } }
  }

  feedback(caseId, kind) {
    if (!['rating_down', 'undo_rating_down'].includes(kind)) throw new Error(`unsupported spike feedback ${kind}`)
    const disputed = kind === 'rating_down'
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO feedback(feedback_id,case_id,actor,kind,created_at) VALUES (?,?,?,?,?)').run(`fb_${randomUUID()}`, caseId, 'user', kind, Date.now())
      this.db.prepare('UPDATE cases SET feedback_state=?, needs_review=?, revision=revision+1 WHERE case_id=?').run(disputed ? 'disputed' : 'none', disputed ? 1 : 0, caseId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.log('feedback', { caseId, kind, actor: 'user' })
    return { caseId, feedbackState: disputed ? 'disputed' : 'none', needsReview: disputed }
  }

  decide(caseId, answers) {
    const value = answers ?? [{ id: 'inbox', selected: ['User decided'] }]
    const result = this.db.prepare("UPDATE cases SET state='closed', closing='escalated', decision_json=?, revision=revision+1 WHERE case_id=? AND state='awaiting_user'")
      .run(JSON.stringify({ kind: 'user_decision', answers: value }), caseId)
    if (result.changes !== 1) throw new Error(`decide guard failed for ${caseId}`)
    this.log('decide', { caseId, answers: value })
    return { caseId, state: 'closed', closing: 'escalated', answers: value }
  }

  seedActions(rootSessionId) {
    const answered = this.createCase({ rootSessionId, state: 'closed', closing: 'answered', decision: { kind: 'answer', answers: [{ id: 'feedback', selected: ['A'] }] }, toolName: 'decision_consult' })
    const inbox = this.createCase({ rootSessionId, state: 'awaiting_user', awaitingReason: 'consult_escalate', suggestion: { perQuestion: [{ id: 'inbox', outcome: 'escalate', detail: 'Needs user judgment' }] } })
    return { answered, inbox }
  }

  seedRecovery(rootSessionId) {
    this.setSelector(rootSessionId, 'agent')
    const awaitingUser = this.createCase({ rootSessionId, state: 'awaiting_user', awaitingReason: 'authority', suggestion: { perQuestion: [{ id: 'waiting', outcome: 'escalate', detail: 'Same gap survives restart' }] } })
    const awaitingRevision = this.createCase({ rootSessionId, state: 'awaiting_revision', awaitingReason: 'evidence', suggestion: { perQuestion: [{ id: 'revision', outcome: 'return', detail: 'Revision gap survives restart' }] } })
    const evaluating = this.createCase({ rootSessionId, state: 'evaluating', decision: null })
    return { awaitingUser, awaitingRevision, evaluating, selector: this.selector(rootSessionId) }
  }

  caseView(row, attempts = []) {
    return {
      caseId: row.case_id, rootSessionId: row.root_session_id, originSessionId: row.origin_session_id,
      state: row.state, closing: row.closing, awaitingReason: row.awaiting_reason,
      feedbackState: row.feedback_state, needsReview: row.needs_review === 1,
      decision: parse(row.decision_json), suggestion: parse(row.suggestion_json),
      idempotencyKey: row.idempotency_key, toolName: row.tool_name, revision: row.revision,
      attempts: attempts.map(attempt => ({ attemptId: attempt.attempt_id, outcome: attempt.outcome, failure: attempt.failure, endedAt: attempt.ended_at, startedAt: attempt.started_at })),
    }
  }

  async state(sessionId) {
    const rootSessionId = await this.rootOf(sessionId)
    const rows = this.db.prepare('SELECT * FROM cases WHERE root_session_id=? OR origin_session_id=? ORDER BY rowid').all(rootSessionId, sessionId)
    return {
      rootSessionId, selector: this.selector(rootSessionId),
      cases: rows.map(row => this.caseView(row, this.db.prepare('SELECT * FROM attempts WHERE case_id=? ORDER BY started_at').all(row.case_id))),
      recovery: this.recovery,
    }
  }

  async scanSession(sessionId) {
    const snapshot = await this.ctx.get('sessionQuery').readSession(sessionId)
    const events = snapshot.events.map(event => ({ seq: event.seq, type: event.type, ignorable: event.ignorable === true, ...(event.type === 'tool/call' ? { data: event.data } : {}) }))
    const counts = {}
    for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
    return {
      session: snapshot.session,
      eventCount: events.length,
      events,
      typeCounts: counts,
      commandEvents: events.filter(event => event.type === 'command/run' || event.type === 'command/done'),
      customWeirEvents: events.filter(event => event.type.startsWith('weir/') || event.type.startsWith('decision/')),
    }
  }
}
