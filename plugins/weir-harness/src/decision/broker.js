// Decision Broker: sole authority for persistence, routing, evaluation and user actions.
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative as relativePath } from 'node:path'
import { createHash } from 'node:crypto'
import { openDecisionDatabase } from './store/db.js'
import { DecisionProfiles, parseScope } from './store/profiles.js'
import { DecisionCases, decisionIdempotencyKey } from './store/cases.js'
import { DecisionAttempts } from './store/attempts.js'
import { DecisionEvidence } from './store/evidence.js'
import { DecisionFeedback } from './store/feedback.js'
import { DecisionQuery } from './store/query.js'
import { canonicalJson, DecisionContractError, parseAnswerBatch } from './contracts.js'
import { buildContextPack } from './evaluator/pack.js'
import { runDecisionAttempt } from './evaluator/attempt-pipeline.js'
import { resolveDecisionModelRoute } from './evaluator/sidecar.js'
import { decisionOrigin, excludedRequest, sessionModelRoute } from './route.js'
import { userTextMessage } from '../shared/user-message.js'

export class DecisionBroker {
  /** @param {{profileContext?:{home?:string,name?:string},config?:()=>Record<string,any>,ctx?:any,now?:()=>number,audit?:(kind:string,value:object)=>void}} [options] */
  constructor(options = {}) {
    this.profileContext = options.profileContext
    this.config = options.config ?? (() => ({}))
    this.ctx = options.ctx
    this.now = options.now ?? Date.now
    this.audit = options.audit ?? (() => {})
    this.started = false
    this.unavailableReason = undefined
    this.store = undefined
    this.activeEvaluations = 0
    this.attemptControllers = new Map()
    this.evaluationJobs = new Set()
  }

  /** @returns {{available:boolean,enabled:boolean,reason?:string}} */
  status() {
    const enabled = this.config().decisionAgentsEnabled === true
    if (!enabled) return { available: false, enabled: false, reason: 'disabled' }
    if (this.unavailableReason) return { available: false, enabled: true, reason: this.unavailableReason }
    if (!this.started) return { available: false, enabled: true, reason: 'not_started' }
    return { available: true, enabled: true }
  }

  async start() {
    this.started = true
    this.unavailableReason = undefined
    if (this.config().decisionAgentsEnabled !== true) return this.status()
    let path
    try { path = this.databasePath() } catch (error) {
      return this.unavailable(error, 'store_root_unavailable')
    }
    if (!existsSync(path)) return this.status()
    try {
      await this.open(path)
    } catch (error) {
      return this.unavailable(error, 'store_open_failed')
    }
    return this.status()
  }

  async flush() {
    for (const controller of this.attemptControllers.values()) controller.abort(new Error('Decision Broker flushed'))
    await Promise.allSettled([...this.evaluationJobs])
    this.store?.close()
    this.store = undefined
    this.cases = undefined
    this.attempts = undefined
    this.profiles = undefined
    this.evidence = undefined
    this.feedbackStore = undefined
    this.query = undefined
    this.started = false
  }

  databasePath() {
    const configured = this.config().decisionAgentStorePath
    if (configured) {
      if (typeof configured !== 'string' || !isAbsolute(configured)) throw new DecisionContractError('INVALID_STORE_PATH', 'decisionAgentStorePath must be absolute')
      return join(configured, 'decision.db')
    }
    const home = this.profileContext?.home
    const name = this.profileContext?.name
    if (typeof home !== 'string' || !home || typeof name !== 'string' || !name) throw new DecisionContractError('STORE_ROOT_UNAVAILABLE', 'profileContext.home and name are required')
    return join(home, 'weir', 'profiles', name, 'decisions', 'decision.db')
  }

  async open(path) {
    const store = openDecisionDatabase(path)
    this.store = store
    this.cases = new DecisionCases(store, { now: this.now, audit: this.audit })
    this.attempts = new DecisionAttempts(store, { now: this.now })
    this.profiles = new DecisionProfiles(store, { now: this.now })
    this.evidence = new DecisionEvidence(store, { now: this.now })
    this.feedbackStore = new DecisionFeedback(store, { now: this.now, audit: this.audit })
    this.query = new DecisionQuery(store, { now: this.now })
    const recovered = await this.attempts.recoverInterrupted()
    this.audit('recover', recovered)
    const retentionDays = this.config().decisionAgentRetentionDays ?? 0
    await this.query.sweep(retentionDays)
  }

  async ensureStore() {
    if (this.config().decisionAgentsEnabled !== true) throw new DecisionContractError('DECISION_OFF', 'Decision Agents are globally disabled')
    if (this.store) return this.store
    if (!this.started) await this.start()
    if (this.unavailableReason) throw new DecisionContractError('DECISION_UNAVAILABLE', this.unavailableReason)
    try {
      await this.open(this.databasePath())
      return this.store
    } catch (error) {
      this.unavailable(error, 'store_open_failed')
      throw new DecisionContractError('DECISION_UNAVAILABLE', this.unavailableReason)
    }
  }

  unavailable(error, fallback) {
    this.unavailableReason = error?.code ? `${fallback}:${error.code}` : fallback
    this.audit('recover', { available: false, reason: this.unavailableReason })
    return this.status()
  }

  selector(rootSessionId) {
    if (!this.store) return { mode: 'off' }
    return this.profiles.selector(rootSessionId)
  }

  async setSelector(rootSessionId, mode, agentId, workspaceKey) {
    if (mode === 'off' && !this.store) {
      this.audit('selector', { rootSessionId, mode: 'off' })
      return { mode: 'off' }
    }
    await this.ensureStore()
    if (workspaceKey && mode === 'agent') {
      const profile = this.profiles.getProfile(agentId)
      if (profile.workspaceKey !== workspaceKey) this.rejectBoundary({ agentId, rootSessionId })
    }
    const value = await this.profiles.setSelector(rootSessionId, { mode, agentId })
    this.audit('selector', { rootSessionId, mode, ...(agentId ? { agentId } : {}) })
    return value
  }

  async profileUpsert(input) {
    await this.ensureStore()
    if (input.agentId && input.workspaceKey) {
      const existing = this.profiles.getProfile(input.agentId)
      if (existing.workspaceKey !== input.workspaceKey) this.rejectBoundary({ agentId: input.agentId, rootSessionId: input.rootSessionId })
    }
    const profile = input.agentId
      ? await this.profiles.updateProfile(input.agentId, input)
      : await this.profiles.createProfile(input)
    this.audit('agent-profile', { agentId: profile.agentId, revision: profile.revision, action: input.agentId ? 'update' : 'create' })
    return profile
  }

  async profileSetState(agentId, state, workspaceKey) {
    await this.ensureStore()
    const existing = this.profiles.getProfile(agentId)
    if (workspaceKey && existing.workspaceKey !== workspaceKey) this.rejectBoundary({ agentId })
    const profile = await this.profiles.setProfileState(agentId, state)
    this.audit('agent-profile', { agentId, state, revision: profile.revision, action: 'state' })
    return profile
  }

  async consult({ agent, args, signal, toolCallId }) {
    const status = this.status()
    if (!status.enabled || status.reason === 'disabled') throw new DecisionContractError('DECISION_OFF', 'Decision Agents are globally disabled')
    if (!status.available) throw new DecisionContractError('DECISION_UNAVAILABLE', status.reason ?? 'Decision Broker is unavailable')
    const origin = await decisionOrigin(agent, this.ctx)
    const selector = this.selector(origin.rootSessionId)
    if (selector.mode === 'off') throw new DecisionContractError('DECISION_OFF', 'The root session Decision selector is Off')
    const explicit = typeof args.agent_id === 'string' && args.agent_id.length > 0
    const selected = explicit ? args.agent_id : selector.agentId
    this.assertAttemptCapacity()
    await this.ensureStore()
    let profile
    try { profile = this.profiles.getProfile(selected) } catch { /* Explicit failure / persisted no_route below. */ }
    if (explicit && (profile?.state !== 'enabled' || profile.workspaceKey !== origin.workspaceKey)) {
      this.rejectBoundary({ agentId: selected, rootSessionId: origin.rootSessionId, code: 'AGENT_UNAVAILABLE', detail: `Decision Agent ${selected} is unavailable for this workspace` })
    }
    const scope = parseScope(origin.workspaceKey, args.scope)
    const question = {
      id: 'question', question: args.question,
      ...(args.detail === undefined ? {} : { detail: args.detail }),
      ...(args.header === undefined ? {} : { header: args.header }),
      ...(args.options === undefined ? {} : { options: args.options }),
      ...(args.multi_select === undefined ? {} : { multiSelect: args.multi_select }),
    }
    const request = { entry: 'consult', questions: [question], ...(args.context === undefined ? {} : { context: args.context, taskSummary: args.context }), ...(args.evidence === undefined ? {} : { evidence: args.evidence }), ...(toolCallId ? { toolCallId } : {}), excluded: [] }
    const idempotencyKey = args.request_id
      ? `consult:${origin.rootSessionId}:${args.request_id}`
      : decisionIdempotencyKey({ rootSessionId: origin.rootSessionId, agentId: selected, request: canonicalJson({ question, scope, context: args.context }) })
    const opened = await this.cases.createCase({ ...origin, entry: 'consult', agentId: selected, request, scope, idempotencyKey, maxAttempts: this.config().decisionAgentMaxAttemptsPerCase ?? 3 })
    if (!opened.created) {
      const current = opened.case
      if (current.state === 'awaiting_revision' && consultFingerprint(current.request, current.scope) !== consultFingerprint(request, scope)) {
        const revisionProfile = this.profiles.getProfile(selected)
        if (revisionProfile.state !== 'enabled' || revisionProfile.workspaceKey !== current.workspaceKey) this.rejectBoundary({ caseId: current.caseId, agentId: selected, rootSessionId: current.rootSessionId, code: 'AGENT_UNAVAILABLE', detail: `Decision Agent ${selected} is unavailable for this workspace` })
        if (selected !== current.agentId) await this.cases.recordRoute({ caseId: current.caseId, rootSessionId: origin.rootSessionId, mode: explicit ? 'explicit' : 'pinned', candidates: [{ agentId: selected, enabled: true }], chosen: selected, reason: explicit ? 'Explicit agent_id for a revised consultation' : 'Pinned by root session selector for a revised consultation' })
        const evaluating = await this.cases.transition({ caseId: current.caseId, expectedState: 'awaiting_revision', expectedRevision: current.revision, state: 'evaluating', agentId: selected, request, scope })
        const revised = await this.evaluateCase(evaluating, agent, signal)
        return this.consultResult(this.cases.getCase(revised.caseId), revised)
      }
      return this.consultResult(current)
    }
    try {
      await this.cases.recordRoute({ caseId: opened.case.caseId, rootSessionId: origin.rootSessionId, mode: explicit ? 'explicit' : 'pinned', candidates: [{ agentId: selected, enabled: profile?.state === 'enabled' }], chosen: profile?.state === 'enabled' ? selected : undefined, reason: explicit ? 'Explicit agent_id for one consultation' : 'Pinned by root session selector' })
      if (explicit) this.audit('case-open', { caseId: opened.case.caseId, entry: 'consult', agentId: selected, explicit: true })
      if (profile?.state !== 'enabled' || profile.workspaceKey !== origin.workspaceKey) {
        const waiting = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'awaiting_user', awaitingReason: 'no_route', escalation: { missing: ['The pinned Agent is unavailable'] } })
        return this.consultResult(waiting)
      }
      if (excludedRequest(request)) {
        const waiting = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'awaiting_user', awaitingReason: 'authority', escalation: { missing: ['This consultation requires native user authority'] } })
        return this.consultResult(waiting)
      }
      const evaluating = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'evaluating' })
      const verdict = await this.evaluateCase(evaluating, agent, signal)
      return this.consultResult(this.cases.getCase(verdict.caseId), verdict)
    } catch (error) {
      return this.recoverUnexpected(opened.case, error)
    }
  }

  consultResult(current, verdict = undefined) {
    const attempts = this.attempts.forCase(current.caseId)
    const latest = attempts.at(-1)
    if (current.state === 'closed' && current.closing === 'answered') {
      const evidenceIds = current.decision.evidenceIds ?? latest?.citedEvidenceIds ?? []
      return {
        outcome: 'answered', caseId: current.caseId,
        answer: current.decision.answers[0],
        evidence: evidenceIds.map(id => this.evidence.get(id)),
        pins: this.attempts.get(current.decision.attemptId).pins,
        revision: current.revision,
      }
    }
    if (current.state === 'closed' && current.closing === 'escalated' && current.decision?.kind === 'user_decision') {
      const evidence = this.store.db.prepare("SELECT evidence_id FROM evidence WHERE agent_id=? AND source='user_decision' AND json_extract(locator_json,'$.caseId')=?").all(current.agentId, current.caseId).map(row => this.evidence.get(row.evidence_id))
      return { outcome: 'answered', caseId: current.caseId, userDecided: true, answer: current.decision.answers[0], evidence, revision: current.revision }
    }
    if (current.state === 'awaiting_revision' || (current.state === 'closed' && current.closing === 'returned')) {
      return { outcome: 'returned', caseId: current.caseId, code: current.decision?.code ?? latest?.reasonCode ?? verdict?.code, hint: current.decision?.hint ?? latest?.hint ?? verdict?.hint }
    }
    if (current.state === 'closed' && current.closing === 'cancelled') throw new DecisionContractError('DECISION_CANCELLED', current.caseId)
    return { outcome: 'awaiting_user', caseId: current.caseId, state: current.state, reason: current.awaitingReason }
  }

  async hook({ agent, request, signal }) {
    if (!this.status().available) return { kind: 'pass', why: 'bypass' }
    const origin = await decisionOrigin(agent, this.ctx)
    const selector = this.selector(origin.rootSessionId)
    if (selector.mode === 'off') return { kind: 'pass', why: 'bypass' }
    if (excludedRequest(request)) {
      this.audit('bypass', { rootSessionId: origin.rootSessionId, reason: 'excluded' })
      return { kind: 'pass', why: 'bypass' }
    }
    if (!this.hasAttemptCapacity()) {
      this.audit('bypass', { rootSessionId: origin.rootSessionId, reason: 'concurrency_limit' })
      return { kind: 'pass', why: 'bypass' }
    }
    await this.ensureStore()
    const selected = selector.agentId
    let profile
    try { profile = this.profiles.getProfile(selected) } catch { /* Persist no_route below. */ }
    const usable = profile?.state === 'enabled' && profile.workspaceKey === origin.workspaceKey
    const opened = await this.cases.createCase({
      ...origin, entry: 'hook', agentId: selected,
      request: { entry: 'hook', questions: request.questions ?? [] },
      scope: { workspaces: [origin.workspaceKey] },
      callId: request.wait?.callId,
      maxAttempts: this.config().decisionAgentMaxAttemptsPerCase ?? 3,
    })
    if (!opened.created) return this.persistedVerdict(opened.case)
    try {
      if (!usable) {
        await this.cases.recordRoute({ caseId: opened.case.caseId, rootSessionId: origin.rootSessionId, mode: 'none', candidates: [{ agentId: selected, enabled: false, rejectedBecause: 'pinned_agent_unavailable' }], reason: 'Pinned Agent is unavailable' })
        const waiting = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'awaiting_user', awaitingReason: 'no_route', escalation: { missing: ['The pinned Agent is unavailable; choose a route or answer the original question.'] } })
        this.audit('case-open', { caseId: waiting.caseId, entry: 'hook', outcome: 'no_route' })
        return { kind: 'pass', caseId: waiting.caseId, why: 'awaiting_user' }
      }
      await this.cases.recordRoute({ caseId: opened.case.caseId, rootSessionId: origin.rootSessionId, mode: 'pinned', candidates: [{ agentId: selected, enabled: true }], chosen: selected, reason: 'Pinned by user' })
      const evaluating = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'evaluating' })
      this.audit('case-open', { caseId: evaluating.caseId, entry: 'hook', agentId: selected })
      return this.evaluateCase(evaluating, agent, signal)
    } catch (error) {
      return this.recoverUnexpected(opened.case, error)
    }
  }

  async hookUserAnswer({ caseId, answer }) {
    const current = this.cases.getCase(caseId)
    if (current.state !== 'awaiting_user') throw new DecisionContractError('NOT_AWAITING_USER', `${caseId} is ${current.state}`)
    const answers = parseAnswerBatch(answer)
    const closed = await this.cases.transition({ caseId, expectedState: 'awaiting_user', expectedRevision: current.revision, state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers, decidedAt: this.now() } })
    this.audit('outcome', { caseId, closing: 'escalated', answerCount: answers.length })
    return closed
  }

  async hookUserAborted({ caseId }) {
    const current = this.cases.getCase(caseId)
    if (current.state === 'closed') return current
    this.attemptControllers.get(caseId)?.abort(new Error('Decision Case cancelled'))
    await this.attempts.interruptOpen(caseId)
    const closed = await this.cases.transition({ caseId, expectedState: current.state, expectedRevision: current.revision, state: 'closed', closing: 'cancelled', decision: { kind: 'cancelled', at: this.now() } })
    this.audit('cancel', { caseId, from: current.state })
    return closed
  }

  persistedVerdict(current) {
    if (current.state === 'closed' && current.closing === 'answered') return { kind: 'answer', caseId: current.caseId, answer: { answers: current.decision.answers } }
    return { kind: 'pass', caseId: current.caseId, why: current.state === 'awaiting_revision' ? 'awaiting_revision' : current.state === 'closed' ? current.closing : 'awaiting_user' }
  }

  async recoverUnexpected(initial, error) {
    let current = this.cases.getCase(initial.caseId)
    if (current.state === 'received') current = await this.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
    if (current.state !== 'evaluating') return current.entry === 'consult' ? this.consultResult(current) : this.persistedVerdict(current)
    const open = this.attempts.forCase(current.caseId).find(attempt => attempt.endedAt === undefined)
    const attempt = open ?? await this.attempts.start({ caseId: current.caseId, agentId: current.agentId, pins: {}, contextPackHash: 'unexpected', packManifest: { layerSizes: {}, evidenceIds: [], correctionIds: [], omissions: [] } })
    await this.attempts.finish(attempt.attemptId, { outcome: 'failed', error: { kind: 'model_error', code: typeof error?.code === 'string' ? error.code : 'EVALUATION_ERROR', detail: 'Unexpected evaluation infrastructure failure' } })
    current = this.cases.getCase(current.caseId)
    const waiting = await this.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: current.entry === 'consult' ? 'consult_escalate' : 'exhausted', escalation: { attemptId: attempt.attemptId, missing: ['Unexpected evaluation infrastructure failure'], gaps: [] } })
    this.audit('attempt', { caseId: current.caseId, attemptId: attempt.attemptId, outcome: 'failed', failureKind: 'model_error' })
    return current.entry === 'consult' ? this.consultResult(waiting) : this.persistedVerdict(waiting)
  }

  evaluateCase(initial, agent, signal) {
    this.assertAttemptCapacity()
    this.activeEvaluations++
    const job = this.evaluateCaseWithinSlot(initial, agent, signal).catch(error => this.recoverUnexpected(initial, error)).finally(() => { this.activeEvaluations-- })
    this.evaluationJobs.add(job)
    job.then(() => this.evaluationJobs.delete(job), () => this.evaluationJobs.delete(job))
    return job
  }

  hasAttemptCapacity() {
    return this.activeEvaluations < (this.config().decisionAgentMaxConcurrentAttempts ?? 4)
  }

  assertAttemptCapacity() {
    if (!this.hasAttemptCapacity()) throw new DecisionContractError('DECISION_BUSY', 'The Decision Attempt concurrency limit is reached')
  }

  async evaluateCaseWithinSlot(initial, agent, signal) {
    let current = initial
    while (current.state === 'evaluating' && current.attemptCount < current.maxAttempts) {
      const profile = this.profiles.getProfile(current.agentId)
      const configuredChains = this.config().decisionAgentChains
      const modelRoute = await resolveDecisionModelRoute({ llm: this.ctx.llm, chain: configuredChains?.[profile.agentId] ?? profile.modelRoute.chain, sessionRoute: sessionModelRoute(agent) })
      await this.ensureProfileEvidence(profile)
      const attemptStartedAt = this.now()
      await this.refreshEvidenceHints(current, signal)
      const candidates = this.evidence.candidates({ agentId: profile.agentId, workspaceKey: current.workspaceKey, scope: current.scope, attemptStartedAt })
      const packed = buildContextPack({ profile, request: current.request, evidence: candidates, modelRoute, budgetTokens: this.config().decisionAgentContextBudgetTokens ?? 24000 })
      const attempt = await this.attempts.start({ caseId: current.caseId, agentId: profile.agentId, pins: packed.pins, contextPackHash: packed.contextPackHash, packManifest: packed.packManifest })
      current = this.cases.getCase(current.caseId)
      const controller = new AbortController()
      const onAbort = () => controller.abort(signal?.reason)
      if (signal?.aborted) controller.abort(signal.reason)
      else signal?.addEventListener('abort', onAbort, { once: true })
      this.attemptControllers.set(current.caseId, controller)
      let result
      try {
        result = await runDecisionAttempt({
        ctx: this.ctx, profile, request: current.request, evidence: candidates, packed,
        modelRoute, budgetTokens: packed.pins.budgetTokens,
        maxOutputTokens: this.config().decisionAgentMaxOutputTokens ?? 1600,
        timeoutMs: this.config().decisionAgentAnswerTimeoutMs ?? 60000, signal: controller.signal,
        workspaceKey: current.workspaceKey, scope: current.scope,
        questions: current.request.questions, attemptStartedAt,
        conflictPairs: this.evidence.conflictPairs(candidates),
        currentObservationHashes: Object.fromEntries(candidates.filter(ref => ref.source === 'current_observation').map(ref => [ref.evidenceId, ref.hash])),
        recheckEvidence: evidenceId => {
          try {
            const ref = this.evidence.get(evidenceId)
            return { evidence: ref, sourceCase: ref.locator.kind === 'case' ? this.cases.getCase(ref.locator.caseId) : undefined }
          } catch { return undefined }
        },
      })
      } finally {
        this.attemptControllers.delete(current.caseId)
        signal?.removeEventListener('abort', onAbort)
      }
      const afterRun = this.cases.getCase(current.caseId)
      if (afterRun.state === 'closed' && afterRun.closing === 'cancelled') return this.persistedVerdict(afterRun)
      await this.evidence.attach(attempt.attemptId, packed.packManifest.evidenceIds)
      const finished = await this.attempts.finish(attempt.attemptId, result)
      this.audit('attempt', { caseId: current.caseId, attemptId: attempt.attemptId, outcome: result.outcome, failureKind: result.error?.kind })
      if (result.outcome === 'answer') {
        current = await this.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'closed', closing: 'answered', decision: { kind: 'answer', attemptId: attempt.attemptId, answers: result.answers, decidedAt: this.now(), evidenceIds: result.citedEvidenceIds ?? packed.packManifest.evidenceIds } })
        this.audit('outcome', { caseId: current.caseId, closing: 'answered', attemptId: attempt.attemptId })
        return { kind: 'answer', caseId: current.caseId, answer: { answers: result.answers }, evidenceIds: result.citedEvidenceIds ?? [], pins: finished.pins }
      }
      const batchAnswers = Array.isArray(result.answers) ? result.answers : []
      const matchedIds = new Set(batchAnswers.map(answer => answer.id))
      const questions = current.request.questions ?? []
      const matchedCount = questions.filter(question => matchedIds.has(question.id)).length
      if (result.outcome === 'return' && result.gates && questions.length > 1 && matchedCount > 0 && matchedCount < questions.length) {
        const perQuestion = questions.map(question => ({
          id: question.id,
          outcome: matchedIds.has(question.id) ? 'answer' : 'return',
          ...(matchedIds.has(question.id) ? {} : { detail: result.hint ?? 'Missing a complete evidence-backed answer' }),
        }))
        current = await this.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'partial_batch', escalation: { attemptId: attempt.attemptId, missing: ['At least one question in the batch cannot be answered'], suggestion: batchAnswers, perQuestion, gaps: result.gates.gaps } })
        return { kind: 'pass', caseId: current.caseId, why: 'awaiting_user', perQuestion }
      }
      if (result.outcome === 'return') {
        const exhausted = current.attemptCount >= current.maxAttempts
        current = await this.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: exhausted ? 'awaiting_user' : 'awaiting_revision', ...(exhausted ? { awaitingReason: 'exhausted' } : {}) })
        return { kind: 'pass', caseId: current.caseId, why: exhausted ? 'awaiting_user' : 'awaiting_revision', code: result.reasonCode, hint: result.hint }
      }
      if (result.outcome === 'escalate') {
        current = await this.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: current.entry === 'consult' ? 'consult_escalate' : 'authority', escalation: { attemptId: attempt.attemptId, missing: result.missing ?? [], suggestion: result.suggestion, gaps: result.gates?.gaps ?? [] } })
        return { kind: 'pass', caseId: current.caseId, why: 'awaiting_user' }
      }
      if (result.error?.kind === 'aborted') {
        current = await this.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'closed', closing: 'cancelled', decision: { kind: 'cancelled', at: this.now() } })
        return { kind: 'pass', caseId: current.caseId, why: 'cancelled' }
      }
      if (current.attemptCount >= current.maxAttempts) {
        current = await this.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'exhausted', escalation: { attemptId: attempt.attemptId, missing: [result.error?.detail ?? 'Evaluator failed'], gaps: result.gates?.gaps ?? [] } })
        return { kind: 'pass', caseId: current.caseId, why: 'awaiting_user' }
      }
    }
    return this.persistedVerdict(current)
  }

  async refreshEvidenceHints(current, signal) {
    const hints = current.request?.evidence
    if (!Array.isArray(hints) || hints.length === 0) return
    const fs = this.ctx?.fs
    if (!fs) throw new DecisionContractError('STALE_EVIDENCE', 'File evidence cannot be refreshed without ctx.fs')
    const workspace = await fs.resolve(current.workspaceKey, { signal })
    for (const hint of hints.slice(0, 16)) {
      if (typeof hint?.path !== 'string' || !hint.path) throw new DecisionContractError('INVALID_EVIDENCE_LOCATOR', 'evidence.path is required')
      const target = await fs.resolve(hint.path, { cwd: current.workspaceKey, signal })
      if (!fs.contains(workspace, target)) this.rejectBoundary({ caseId: current.caseId, rootSessionId: current.rootSessionId, detail: hint.path })
      const subject = isAbsolute(target.displayPath) ? relativePath(current.workspaceKey, target.displayPath).replaceAll('\\', '/') : hint.path.replaceAll('\\', '/')
      if ((current.scope?.paths ?? []).length && !current.scope.paths.some(prefix => subject === prefix || subject.startsWith(`${prefix}/`))) this.rejectBoundary({ caseId: current.caseId, rootSessionId: current.rootSessionId, detail: hint.path })
      const stat = await fs.stat(target, signal)
      if (stat?.type !== 'file') throw new DecisionContractError('STALE_EVIDENCE', `${hint.path} is not a readable file`)
      const text = await fs.readText(target, signal)
      const hash = createHash('sha256').update(text).digest('hex')
      const match = typeof hint.excerpt_hint === 'string' ? text.indexOf(hint.excerpt_hint) : -1
      const start = match >= 0 ? Math.max(0, match - 100) : 0
      const excerpt = text.slice(start, start + 600)
      await this.evidence.add({ agentId: current.agentId, source: 'current_observation', locator: { kind: 'file', path: target.displayPath, hash }, excerpt, hash, version: stat.version, observedAt: this.now(), scope: current.scope })
    }
  }

  async ensureProfileEvidence(profile) {
    const row = this.store.db.prepare("SELECT evidence_id FROM evidence WHERE agent_id=? AND source='user_profile' AND json_extract(locator_json,'$.revision')=? AND status='active'").get(profile.agentId, profile.userDescription.revision)
    if (row) return this.evidence.get(row.evidence_id)
    return this.evidence.add({ agentId: profile.agentId, source: 'user_profile', locator: { kind: 'profile', descriptionKind: 'user', revision: profile.userDescription.revision }, scope: profile.scope, status: 'active' })
  }

  rejectBoundary({ caseId, agentId, rootSessionId, code = 'OUT_OF_SCOPE', detail }) {
    this.audit('outcome', { caseId, agentId, rootSessionId, action: 'boundary-reject', code })
    throw new DecisionContractError(code, detail ?? caseId ?? agentId ?? rootSessionId)
  }

  async mutate(input) {
    const current = this.cases.getCase(input.caseId)
    if ((input.sessionId !== undefined || input.workspaceKey !== undefined) && (input.sessionId !== current.rootSessionId || input.workspaceKey !== current.workspaceKey)) {
      this.rejectBoundary({ caseId: current.caseId, rootSessionId: input.sessionId })
    }
    switch (input.action) {
      case 'decide': return this.hookUserAnswer({ caseId: current.caseId, answer: { answers: input.answers } })
      case 'cancel': return this.hookUserAborted({ caseId: current.caseId })
      case 'reassign': {
        if (current.state !== 'awaiting_user') throw new DecisionContractError('NOT_RECOVERABLE', 'Only awaiting_user Cases can be reassigned')
        const target = this.profiles.getProfile(input.agentId)
        if (target.state !== 'enabled' || target.workspaceKey !== current.workspaceKey) this.rejectBoundary({ caseId: current.caseId, agentId: target.agentId, rootSessionId: current.rootSessionId, code: 'AGENT_UNAVAILABLE', detail: input.agentId })
        const evaluating = await this.cases.transition({ caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision, state: 'evaluating', agentId: target.agentId, ...(current.attemptCount >= current.maxAttempts ? { maxAttempts: current.attemptCount + 1 } : {}) })
        await this.cases.recordRoute({ caseId: current.caseId, rootSessionId: current.rootSessionId, mode: 'manual_reassign', candidates: [{ agentId: target.agentId, enabled: true }], chosen: target.agentId, reason: 'User reassigned the Case' })
        this.audit('outcome', { caseId: current.caseId, action: 'reassign', agentId: target.agentId })
        return evaluating
      }
      case 'retry': {
        if (current.state !== 'awaiting_user') throw new DecisionContractError('NOT_RECOVERABLE', 'Only awaiting_user Cases can be retried')
        const profile = this.profiles.getProfile(current.agentId)
        if (profile.state !== 'enabled' || profile.workspaceKey !== current.workspaceKey) this.rejectBoundary({ caseId: current.caseId, agentId: current.agentId, rootSessionId: current.rootSessionId, code: 'AGENT_UNAVAILABLE', detail: current.agentId })
        const evaluating = await this.cases.transition({ caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision, state: 'evaluating', ...(current.attemptCount >= current.maxAttempts ? { maxAttempts: current.attemptCount + 1 } : {}) })
        this.audit('outcome', { caseId: current.caseId, action: 'retry', attemptCount: current.attemptCount + 1 })
        return evaluating
      }
      case 'feedback': return this.feedbackStore.append({ actor: { kind: 'user' }, caseId: current.caseId, kind: input.verb, payload: input.payload })
      case 'correction': return this.feedbackStore.append({ actor: { kind: 'user' }, caseId: current.caseId, kind: 'correction', payload: { direction: input.direction, scope: input.scope, supersedes: input.supersedes } })
      default: throw new DecisionContractError('UNKNOWN_DECISION_ACTION', String(input.action))
    }
  }

  async decide(input) {
    const closed = await this.mutate({ ...input, action: 'decide' })
    if (closed.entry === 'consult') await this.deliverDecision(closed)
    return closed
  }
  async cancel(input) { return this.mutate({ ...input, action: 'cancel' }) }
  async feedback(input) { return this.mutate({ ...input, action: 'feedback' }) }
  async correction(input) { return this.mutate({ ...input, action: 'correction' }) }

  async reassign(input) {
    this.assertAttemptCapacity()
    const current = this.cases.getCase(input.caseId)
    const agent = await this.rootAgent(current.rootSessionId)
    const evaluating = await this.mutate({ ...input, action: 'reassign' })
    return this.evaluateCase(evaluating, agent)
  }

  async retry(input) {
    this.assertAttemptCapacity()
    const current = this.cases.getCase(input.caseId)
    const agent = await this.rootAgent(current.rootSessionId)
    const evaluating = await this.mutate({ ...input, action: 'retry' })
    return this.evaluateCase(evaluating, agent)
  }

  async turnStopping({ agent }) {
    if (!this.store) return { closed: 0 }
    const rows = this.store.db.prepare("SELECT case_id FROM cases WHERE state='awaiting_revision' AND origin_session_id=?").all(agent.id)
    let closed = 0
    for (const row of rows) {
      const current = this.cases.getCase(row.case_id)
      const latest = this.attempts.forCase(current.caseId).at(-1)
      if (!latest || latest.outcome !== 'return') continue
      await this.cases.transition({ caseId: current.caseId, expectedState: 'awaiting_revision', expectedRevision: current.revision, state: 'closed', closing: 'returned', decision: { kind: 'return', attemptId: latest.attemptId, code: latest.reasonCode, hint: latest.hint, decidedAt: this.now() } })
      closed++
      this.audit('outcome', { caseId: current.caseId, closing: 'returned', attemptId: latest.attemptId })
    }
    return { closed }
  }

  async deliverDecision(current) {
    try {
      const agent = await this.rootAgent(current.rootSessionId)
      const labels = current.decision.answers.flatMap(answer => answer.selected).join(', ')
      await agent.followup(userTextMessage(`Decision ${current.caseId} was resolved by the user: ${labels}`, 'weir-decision'))
      this.audit('deliver', { caseId: current.caseId, ok: true })
    } catch (error) {
      this.audit('deliver', { caseId: current.caseId, ok: false, code: error?.code ?? 'DELIVERY_FAILED' })
    }
  }

  async rootAgent(rootSessionId) {
    const agents = this.ctx?.agents
    const agent = agents?.get?.(rootSessionId) ?? agents?.getById?.(rootSessionId)
    if (!agent) throw new DecisionContractError('ROOT_AGENT_UNAVAILABLE', rootSessionId)
    return agent
  }

  async sessionContext(sessionId) {
    const agent = this.ctx?.agents?.get?.(sessionId) ?? this.ctx?.agents?.getById?.(sessionId)
    if (agent) return decisionOrigin(agent, this.ctx)
    const trace = await this.ctx?.sessionQuery?.traceSession?.(sessionId)
    const root = trace?.root?.header
    if (trace?.complete === true && typeof root?.id === 'string' && typeof root?.cwd === 'string') {
      return { rootSessionId: root.id, workspaceKey: realpathSync(root.cwd) }
    }
    if (!this.ctx) return { rootSessionId: sessionId }
    throw new DecisionContractError('INCOMPLETE_LINEAGE', sessionId)
  }

  async overview(input) {
    const context = await this.sessionContext(input.sessionId)
    return { status: this.status(), selector: this.store ? this.profiles.selector(context.rootSessionId) : { mode: 'off' }, agents: this.store && context.workspaceKey ? this.profiles.listProfiles(context.workspaceKey, { includeArchived: true }) : [] }
  }

  async agents(input) {
    if (!this.store) return []
    const context = await this.sessionContext(input.sessionId)
    return this.profiles.listProfiles(context.workspaceKey, { includeArchived: true })
  }

  async agent(input) {
    if (!this.store) return null
    const context = await this.sessionContext(input.sessionId)
    const profile = this.profiles.getProfile(input.agentId)
    if (profile.workspaceKey !== context.workspaceKey) this.rejectBoundary({ agentId: input.agentId, rootSessionId: context.rootSessionId })
    return { ...profile, descriptionHistory: this.profiles.descriptionHistory(profile.agentId) }
  }

  async caseForCall(input) {
    if (!this.store) return null
    const context = await this.sessionContext(input.sessionId)
    const signature = canonicalJson((input.questions ?? []).map(question => ({ id: question.id, question: question.question })))
    const rows = this.store.db.prepare('SELECT case_id,request_json FROM cases WHERE root_session_id=? ORDER BY created_at DESC,case_id DESC').all(context.rootSessionId)
    const found = rows.find(row => canonicalJson((JSON.parse(row.request_json).questions ?? []).map(question => ({ id: question.id, question: question.question }))) === signature)
    return found ? this.query.record({ caseId: found.case_id, sessionId: context.rootSessionId }) : null
  }

  async caseForToolCall(input) {
    if (!this.store) return null
    const context = await this.sessionContext(input.sessionId)
    const row = this.store.db.prepare("SELECT case_id FROM cases WHERE root_session_id=? AND entry='consult' AND json_extract(request_json,'$.toolCallId')=? ORDER BY created_at DESC,case_id DESC LIMIT 1").get(context.rootSessionId, input.toolCallId)
    return row ? this.query.record({ caseId: row.case_id, sessionId: context.rootSessionId }) : null
  }

  async records(input) {
    if (!this.store) return { records: [], nextCursor: null }
    const context = await this.sessionContext(input.sessionId)
    return this.query.records({ ...input, sessionId: context.rootSessionId })
  }

  async record(input) {
    if (!this.store) return null
    const context = await this.sessionContext(input.sessionId)
    return this.query.record({ ...input, sessionId: context.rootSessionId })
  }

  async inbox(input) {
    if (!this.store) return []
    const context = await this.sessionContext(input.sessionId)
    return this.query.inbox({ sessionId: context.rootSessionId })
  }

  async metrics(input) {
    if (!this.store) return { window: input.window ?? 'all', casesOpened: 0, attemptsTotal: 0, autoAnswered: 0 }
    const context = await this.sessionContext(input.sessionId)
    return this.query.metrics({ ...input, sessionId: context.rootSessionId })
  }
}
function consultFingerprint(request, scope) {
  return canonicalJson({ questions: request.questions, context: request.context, taskSummary: request.taskSummary, evidence: request.evidence, scope })
}
