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
import { DecisionQuery, emptyRoutingReview, projectRoutingChains } from './store/query.js'
import { DecisionContextRetriever } from './retrieval/retriever.js'
import { canonicalJson, DecisionContractError, parseAnswerBatch } from './contracts.js'
import { buildContextPack } from './evaluator/pack.js'
import { runDecisionAttempt } from './evaluator/attempt-pipeline.js'
import { resolveDecisionModelRoute, streamDecision } from './evaluator/sidecar.js'
import {
  applyConsolidationOperations, buildConsolidationPack, parseConsolidationCandidate, replayOperations,
} from './learning/consolidator.js'
import { DecisionLearning } from './store/learning.js'
import { decisionOrigin, excludedRequest, excludedStockHookRequest, sessionModelRoute } from './route.js'
import { autoAdmission, classifyAutoRequest, routeAuto } from './router.js'
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
    this.retriever = undefined
    this.activeEvaluations = 0
    this.attemptControllers = new Map()
    this.evaluationJobs = new Set()
    this.learningControllers = new Map()
    this.learningJobs = new Set()
    this.learningJobKeys = new Map()
    this.consultWaiters = new Set()
    this.autoFlights = new Map()
    this.routingControllers = new Map()
    this.routingJobs = new Set()
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
    for (const waiter of [...this.consultWaiters]) waiter.abort(new Error('Decision Broker flushed'))
    for (const controller of this.attemptControllers.values()) controller.abort(new Error('Decision Broker flushed'))
    for (const controller of this.learningControllers.values()) controller.abort(new Error('Decision Broker flushed'))
    for (const controller of this.routingControllers.values()) controller.abort(new Error('Decision Broker flushed'))
    await Promise.allSettled([...this.evaluationJobs, ...this.learningJobs, ...this.routingJobs])
    this.store?.close()
    this.store = undefined
    this.cases = undefined
    this.attempts = undefined
    this.profiles = undefined
    this.evidence = undefined
    this.feedbackStore = undefined
    this.query = undefined
    this.retriever = undefined
    this.learning = undefined
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
    this.profiles = new DecisionProfiles(store, { now: this.now })
    this.cases = new DecisionCases(store, { now: this.now, audit: this.audit, profiles: this.profiles })
    this.attempts = new DecisionAttempts(store, { now: this.now })
    this.evidence = new DecisionEvidence(store, { now: this.now })
    this.feedbackStore = new DecisionFeedback(store, { now: this.now, audit: this.audit })
    this.query = new DecisionQuery(store, { now: this.now })
    this.retriever = new DecisionContextRetriever(store, this.evidence)
    this.learning = new DecisionLearning(store, { now: this.now, evidence: this.evidence })
    const incompleteIntake = store.db.prepare("SELECT case_id FROM cases WHERE state='received' AND agent_id IS NULL").all()
    for (const row of incompleteIntake) {
      const current = this.cases.getCase(row.case_id)
      await this.cases.transition({
        caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision,
        state: 'awaiting_user', awaitingReason: 'interrupted',
      })
    }
    this.audit('recover', { recoveredIntake: incompleteIntake.length })
    const recovered = await this.attempts.recoverInterrupted()
    this.audit('recover', recovered)
    const recoveredLearning = await this.learning.recoverInterrupted()
    this.audit('recover', recoveredLearning)
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

  /** Apply selectorDefault=auto only to a genuinely fresh startup root. */
  async initializeSelectorDefault({ agent, source }) {
    const config = this.config()
    const header = agent?.session?.header
    const rootSessionId = header?.id ?? agent?.id
    if (typeof rootSessionId !== 'string' || !rootSessionId) return { mode: 'off' }
    if (config.decisionAgentsEnabled !== true || config.decisionAgentSelectorDefault !== 'auto' || source !== 'startup') {
      return this.selector(rootSessionId)
    }
    if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) >= 1) return this.selector(rootSessionId)
    await this.ensureStore()
    const initialized = await this.profiles.initializeAutoSelector(rootSessionId)
    if (initialized) this.audit('selector', { rootSessionId, mode: 'auto' })
    return this.profiles.selector(rootSessionId)
  }

  /**
   * A selector is root-session state. It never carries a workspace: the same
   * assistant is selectable from every workspace in the profile.
   */
  async setSelector(rootSessionId, mode, agentId) {
    if (mode === 'off' && !this.store && this.config().decisionAgentsEnabled !== true) {
      this.audit('selector', { rootSessionId, mode: 'off' })
      return { mode: 'off' }
    }
    await this.ensureStore()
    const value = await this.profiles.setSelector(rootSessionId, { mode, agentId })
    this.audit('selector', { rootSessionId, mode, ...(agentId ? { agentId } : {}) })
    return value
  }

  async profileUpsert(input) {
    await this.ensureStore()
    const profile = input.agentId
      ? await this.profiles.updateProfile(input.agentId, input)
      : await this.profiles.createProfile(input)
    this.audit('agent-profile', { agentId: profile.agentId, revision: profile.revision, action: input.agentId ? 'update' : 'create' })
    return profile
  }

  async profileSetState(agentId, state) {
    await this.ensureStore()
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
    const explicit = typeof args.agent_id === 'string' && args.agent_id.length > 0
    const automatic = !explicit && selector.mode === 'auto'
    const selected = explicit ? args.agent_id : selector.agentId
    const scope = parseScope(origin.workspaceKey, args.scope)
    const question = {
      id: 'question', question: args.question,
      ...(args.detail === undefined ? {} : { detail: args.detail }),
      ...(args.header === undefined ? {} : { header: args.header }),
      ...(args.options === undefined ? {} : { options: args.options }),
      ...(args.multi_select === undefined ? {} : { multiSelect: args.multi_select }),
      ...(args.authorization_class === undefined ? {} : { authorizationClass: args.authorization_class }),
    }
    const request = { entry: 'consult', questions: [question], ...(args.context === undefined ? {} : { context: args.context, taskSummary: args.context }), ...(args.evidence === undefined ? {} : { evidence: args.evidence }), ...(toolCallId ? { toolCallId } : {}), excluded: [] }
    const idempotencyKey = args.request_id
      ? `consult:${origin.rootSessionId}:${args.request_id}`
      : decisionIdempotencyKey({ rootSessionId: origin.rootSessionId, agentId: selected, request: canonicalJson({ question, scope, context: args.context }) })
    const existing = !explicit && this.autoFlights.get(`${origin.rootSessionId}\0${idempotencyKey}`)
    if (existing) return existing
    if (selector.mode === 'off') throw new DecisionContractError('DECISION_OFF', 'The root session Decision selector is Off')
    if (!automatic) this.assertAttemptCapacity()
    if (!automatic) await this.ensureStore()
    let profile
    if (!automatic) try { profile = this.profiles.getProfile(selected) } catch { /* Explicit failure / persisted no_route below. */ }
    if (explicit && profile?.state !== 'enabled') {
      this.rejectBoundary({ agentId: selected, rootSessionId: origin.rootSessionId, code: 'AGENT_UNAVAILABLE', detail: `Decision Agent ${selected} is unavailable for this workspace` })
    }
    const openAndConsult = async flightSignal => {
      if (automatic) await this.ensureStore()
      const opened = await this.cases.createCase({ ...origin, entry: 'consult', agentId: selected, request, scope, idempotencyKey, maxAttempts: this.config().decisionAgentMaxAttemptsPerCase ?? 3 })
      if (!opened.created) {
        const current = opened.case
        if (automatic && current.state === 'received') throw new DecisionContractError('DECISION_UNAVAILABLE', 'The previous Auto route did not commit')
        if (!explicit && this.hasAutoRoute(current)) {
          return this.consultAutoReplay({ current, request, scope, agent, signal: flightSignal, heldSlot: automatic })
        }
        if (automatic) return this.consultResult(current)
        if (current.state === 'awaiting_revision' && consultFingerprint(current.request, current.scope) !== consultFingerprint(request, scope)) {
          const revisionProfile = this.profiles.getProfile(selected)
          if (revisionProfile.state !== 'enabled') this.rejectBoundary({ caseId: current.caseId, agentId: selected, rootSessionId: current.rootSessionId, code: 'AGENT_UNAVAILABLE', detail: `Decision Agent ${selected} is unavailable` })
          if (selected !== current.agentId) await this.cases.recordRoute({ caseId: current.caseId, rootSessionId: origin.rootSessionId, mode: explicit ? 'explicit' : 'pinned', candidates: [{ agentId: selected, enabled: true }], chosen: selected, reason: explicit ? 'Explicit agent_id for a revised consultation' : 'Pinned by root session selector for a revised consultation' })
          const evaluating = await this.cases.transition({ caseId: current.caseId, expectedState: 'awaiting_revision', expectedRevision: current.revision, state: 'evaluating', agentId: selected, request, scope })
          const revised = await this.evaluateCase(evaluating, agent, flightSignal)
          return this.consultResult(this.cases.getCase(revised.caseId), revised)
        }
        return this.consultResult(current)
      }
      if (automatic) return this.consultAuto({ current: opened.case, request, scope, origin, agent, signal: flightSignal, heldSlot: true })
      try {
        await this.cases.recordRoute({ caseId: opened.case.caseId, rootSessionId: origin.rootSessionId, mode: explicit ? 'explicit' : 'pinned', candidates: [{ agentId: selected, enabled: profile?.state === 'enabled' }], chosen: profile?.state === 'enabled' ? selected : undefined, reason: explicit ? 'Explicit agent_id for one consultation' : 'Pinned by root session selector' })
        if (explicit) this.audit('case-open', { caseId: opened.case.caseId, entry: 'consult', agentId: selected, explicit: true })
        if (profile?.state !== 'enabled') {
          const waiting = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'awaiting_user', awaitingReason: 'no_route', escalation: { missing: ['The pinned Agent is unavailable'] } })
          return this.consultResult(waiting)
        }
        if (excludedRequest(request)) {
          const waiting = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'awaiting_user', awaitingReason: 'authority', escalation: { missing: ['This consultation requires native user authority'] } })
          return this.consultResult(waiting)
        }
        if (!explicit) await this.observeShadow({ current: opened.case, request, scope, origin, agent, signal: flightSignal })
        const evaluating = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'evaluating' })
        const verdict = await this.evaluateCase(evaluating, agent, flightSignal)
        return this.consultResult(this.cases.getCase(verdict.caseId), verdict)
      } catch (error) {
        return this.recoverUnexpected(opened.case, error)
      }
    }
    if (automatic) {
      return this.runAutoFlight({
        rootSessionId: origin.rootSessionId, idempotencyKey, signal,
        onBusy: () => this.assertAttemptCapacity(),
      }, openAndConsult)
    }
    return openAndConsult(signal)
  }

  hasAutoRoute(current) {
    return Boolean(this.store.db.prepare("SELECT 1 FROM route_decisions WHERE case_id=? AND mode='auto' LIMIT 1").get(current.caseId))
  }

  assertAutoAttemptAuthority(request) {
    const configured = this.config().decisionAgentAutoAnswerClasses
    const allowedClasses = Array.isArray(configured) && configured.every(value => ['A', 'B', 'C'].includes(value))
      ? [...new Set(configured)]
      : []
    if (excludedRequest(request) || allowedClasses.length === 0 || !autoAdmission(request, allowedClasses).ok) {
      throw new DecisionContractError('AUTHORITY', 'This Auto Case requires native user authority')
    }
  }

  async consultAutoReplay({ current, request, scope, agent, signal, heldSlot }) {
    if (current.state === 'awaiting_revision'
      && callerRevisionFingerprint(current.request, current.scope) !== callerRevisionFingerprint(request, scope)) {
      this.assertAutoAttemptAuthority(request)
      const selected = current.agentId
      if (typeof selected !== 'string' || !selected) throw new DecisionContractError('AGENT_UNAVAILABLE', 'An unowned Auto Case requires explicit reassignment')
      const profile = this.profiles.getProfile(selected)
      if (profile.state !== 'enabled') {
        this.rejectBoundary({ caseId: current.caseId, agentId: selected, rootSessionId: current.rootSessionId, code: 'AGENT_UNAVAILABLE', detail: `Decision Agent ${selected} is unavailable` })
      }
      const evaluating = await this.cases.transition({ caseId: current.caseId, expectedState: 'awaiting_revision', expectedRevision: current.revision, state: 'evaluating', agentId: selected, request, scope })
      const revised = await this.evaluateCase(evaluating, agent, signal, { heldSlot })
      return this.consultResult(this.cases.getCase(revised.caseId), revised)
    }
    return this.consultResult(current)
  }

  consultResult(current, verdict = undefined) {
    this.publishConsult(current)
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
    const idempotencyKey = decisionIdempotencyKey({
      rootSessionId: origin.rootSessionId, callId: request.wait?.callId,
      questions: (request.questions ?? []).map(question => ({ id: question.id, question: question.question })),
    })
    const existing = this.autoFlights.get(`${origin.rootSessionId}\0${idempotencyKey}`)
    if (existing) return existing
    const selector = this.selector(origin.rootSessionId)
    if (selector.mode === 'off') return { kind: 'pass', why: 'bypass' }
    if (await excludedStockHookRequest(request, origin.originSessionId, this.ctx)) {
      this.audit('bypass', { rootSessionId: origin.rootSessionId, reason: 'excluded' })
      return { kind: 'pass', why: 'bypass' }
    }
    const automatic = selector.mode === 'auto'
    if (!automatic && !this.hasAttemptCapacity()) {
      this.audit('bypass', { rootSessionId: origin.rootSessionId, reason: 'concurrency_limit' })
      return { kind: 'pass', why: 'bypass' }
    }
    if (!automatic) await this.ensureStore()
    const selected = selector.agentId
    let profile
    if (!automatic) try { profile = this.profiles.getProfile(selected) } catch { /* Persist no_route below. */ }
    const usable = profile?.state === 'enabled'
    const openAndHook = async flightSignal => {
      if (automatic) await this.ensureStore()
      const opened = await this.cases.createCase({
        ...origin, entry: 'hook', agentId: selected,
        request: { entry: 'hook', questions: request.questions ?? [] },
        scope: { workspaces: [origin.workspaceKey] },
        callId: request.wait?.callId, idempotencyKey,
        maxAttempts: this.config().decisionAgentMaxAttemptsPerCase ?? 3,
      })
      if (!opened.created) {
        if (automatic && opened.case.state === 'received') return { kind: 'pass', why: 'bypass' }
        return this.persistedVerdict(opened.case)
      }
      if (automatic) return this.hookAuto({ current: opened.case, request: opened.case.request, scope: opened.case.scope, origin, agent, signal: flightSignal, heldSlot: true })
      try {
        if (!usable) {
          await this.cases.recordRoute({ caseId: opened.case.caseId, rootSessionId: origin.rootSessionId, mode: 'none', candidates: [{ agentId: selected, enabled: false, rejectedBecause: 'pinned_agent_unavailable' }], reason: 'Pinned Agent is unavailable' })
          const waiting = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'awaiting_user', awaitingReason: 'no_route', escalation: { missing: ['The pinned Agent is unavailable; choose a route or answer the original question.'] } })
          this.audit('case-open', { caseId: waiting.caseId, entry: 'hook', outcome: 'no_route' })
          return { kind: 'pass', caseId: waiting.caseId, why: 'awaiting_user' }
        }
        await this.cases.recordRoute({ caseId: opened.case.caseId, rootSessionId: origin.rootSessionId, mode: 'pinned', candidates: [{ agentId: selected, enabled: true }], chosen: selected, reason: 'Pinned by user' })
        await this.observeShadow({ current: opened.case, request: opened.case.request, scope: opened.case.scope, origin, agent, signal: flightSignal })
        const evaluating = await this.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'evaluating' })
        this.audit('case-open', { caseId: evaluating.caseId, entry: 'hook', agentId: selected })
        return this.evaluateCase(evaluating, agent, flightSignal)
      } catch (error) {
        return this.recoverUnexpected(opened.case, error)
      }
    }
    if (automatic) {
      return this.runAutoFlight({
        rootSessionId: origin.rootSessionId, idempotencyKey, signal,
        onBusy: () => {
          this.audit('bypass', { rootSessionId: origin.rootSessionId, reason: 'concurrency_limit' })
          return { kind: 'pass', why: 'bypass' }
        },
      }, openAndHook)
    }
    return openAndHook(signal)
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
    this.routingControllers.get(`${current.rootSessionId}\0${current.idempotencyKey}`)?.abort(new Error('Decision Case cancelled'))
    await this.attempts.interruptOpen(caseId)
    const latest = this.cases.getCase(caseId)
    if (latest.state === 'closed') return latest
    const closed = await this.cases.transition({ caseId, expectedState: latest.state, expectedRevision: latest.revision, state: 'closed', closing: 'cancelled', decision: { kind: 'cancelled', at: this.now() } })
    this.audit('cancel', { caseId, from: latest.state })
    return closed
  }

  persistedVerdict(current) {
    if (current.state === 'closed' && current.closing === 'answered') return { kind: 'answer', caseId: current.caseId, answer: { answers: current.decision.answers } }
    return { kind: 'pass', caseId: current.caseId, why: current.state === 'awaiting_revision' ? 'awaiting_revision' : current.state === 'closed' ? current.closing : 'awaiting_user' }
  }

  async consultAuto({ current, request, scope, origin, agent, signal, heldSlot }) {
    const routed = await this.routeAutoCase({ current, request, scope, origin, agent, signal })
    const latest = this.cases.getCase(routed.caseId)
    if (latest.state !== 'evaluating') return this.consultResult(latest)
    const verdict = await this.evaluateCase(latest, agent, signal, { heldSlot })
    return this.consultResult(this.cases.getCase(verdict.caseId), verdict)
  }

  async hookAuto({ current, request, scope, origin, agent, signal, heldSlot }) {
    const routed = await this.routeAutoCase({ current, request, scope, origin, agent, signal })
    const latest = this.cases.getCase(routed.caseId)
    if (latest.state === 'closed') return this.persistedVerdict(latest)
    if (latest.state !== 'evaluating') return { kind: 'pass', caseId: latest.caseId, why: 'awaiting_user' }
    return this.evaluateCase(latest, agent, signal, { heldSlot })
  }

  /** Append one diagnostic route without changing the already-pinned Case. */
  async observeShadow({ current, request, scope, origin, agent, signal }) {
    if (this.config().decisionAgentAutoShadow !== true) return
    const sidecar = {
      llm: this.ctx.llm, sessionRoute: sessionModelRoute(agent), signal,
      timeoutMs: this.config().decisionAgentAnswerTimeoutMs ?? 60000,
      maxOutputTokens: this.config().decisionAgentMaxOutputTokens ?? 1600,
      contextBudgetTokens: this.config().decisionAgentContextBudgetTokens ?? 24000,
    }
    try {
      const pinned = this.profiles.getProfile(current.agentId)
      if (pinned.state !== 'enabled') return
      const classified = await classifyAutoRequest({ request, ...sidecar })
      let route
      if (classified.kind === 'failed') {
        route = { kind: 'failed', candidates: [], reason: classified.reason }
      } else if (classified.kind === 'authority') {
        route = { kind: 'none', candidates: [], reason: 'admission:authority' }
      } else {
        const profiles = this.profiles.listProfiles()
        route = await routeAuto({
          request: classified.request, scope, profiles, ...sidecar,
        })
      }
      await this.cases.recordRoute({
        caseId: current.caseId, rootSessionId: current.rootSessionId, mode: 'auto_shadow',
        candidates: route.candidates, ...(route.kind === 'selected' ? { chosen: route.chosen } : {}),
        reason: route.reason, ...(route.ambiguity ? { ambiguity: route.ambiguity } : {}),
      })
    } catch {
      // Shadow is diagnostic only: model, parsing, and storage failures never
      // enter domain recovery or change the real pinned outcome.
    }
  }

  async routeAutoCase({ current, request, scope, origin, agent, signal }) {
    const authority = (normalized = request) => this.commitAutoRoute({
      current, request: normalized, scope,
      route: { kind: 'none', candidates: [], reason: 'admission:authority' }, awaitingReason: 'authority',
    })
    if (current.entry === 'consult' && excludedRequest(request)) return authority()

    const configured = this.config().decisionAgentAutoAnswerClasses
    const allowedClasses = Array.isArray(configured) && configured.every(value => ['A', 'B', 'C'].includes(value))
      ? [...new Set(configured)]
      : []
    if (allowedClasses.length === 0) return authority()

    const initial = autoAdmission(request, allowedClasses)
    if (!initial.ok && initial.reason !== 'missing_class') return authority()
    const sidecar = {
      llm: this.ctx.llm, sessionRoute: sessionModelRoute(agent), signal,
      timeoutMs: this.config().decisionAgentAnswerTimeoutMs ?? 60000,
      maxOutputTokens: this.config().decisionAgentMaxOutputTokens ?? 1600,
      contextBudgetTokens: this.config().decisionAgentContextBudgetTokens ?? 24000,
    }
    let normalized = request
    if (initial.reason === 'missing_class') {
      const classified = await classifyAutoRequest({ request, ...sidecar })
      if (classified.kind === 'failed') {
        return this.commitAutoRoute({ current, request, scope, route: { kind: 'failed', candidates: [], reason: classified.reason }, awaitingReason: 'no_route' })
      }
      normalized = classified.request
      if (classified.kind === 'authority') return authority(normalized)
    }
    if (!autoAdmission(normalized, allowedClasses).ok) return authority(normalized)

    const profiles = this.profiles.listProfiles()
    const route = await routeAuto({
      request: normalized, scope, profiles, ...sidecar,
    })
    return this.commitAutoRoute({
      current, request: normalized, scope, route,
      awaitingReason: route.kind === 'ambiguous' ? 'route_ambiguous' : 'no_route',
    })
  }

  async commitAutoRoute({ current, request, scope, route, awaitingReason }) {
    const latest = this.cases.getCase(current.caseId)
    if (latest.state === 'closed' && latest.closing === 'cancelled') return latest
    const selected = route.kind === 'selected'
    try {
      return await this.cases.transitionWithRoute({
        caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision,
        state: selected ? 'evaluating' : 'awaiting_user', request, scope,
        ...(selected ? { agentId: route.chosen } : { awaitingReason }),
      }, {
        caseId: current.caseId, rootSessionId: current.rootSessionId, mode: 'auto',
        candidates: route.candidates, ...(selected ? { chosen: route.chosen } : {}),
        reason: route.reason, ...(route.ambiguity ? { ambiguity: route.ambiguity } : {}),
      })
    } catch (error) {
      const afterFailure = this.cases.getCase(current.caseId)
      if (afterFailure.state === 'closed' && afterFailure.closing === 'cancelled') return afterFailure
      throw error
    }
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

  evaluateCase(initial, agent, signal, { heldSlot = false } = {}) {
    if (!heldSlot) this.assertAttemptCapacity()
    if (!heldSlot) this.activeEvaluations++
    const job = this.evaluateCaseWithinSlot(initial, agent, signal).catch(error => this.recoverUnexpected(initial, error)).finally(() => { if (!heldSlot) this.activeEvaluations-- })
    this.evaluationJobs.add(job)
    job.then(() => this.evaluationJobs.delete(job), () => this.evaluationJobs.delete(job))
    return job
  }

  runAutoFlight({ rootSessionId, idempotencyKey, signal, onBusy }, task) {
    const key = `${rootSessionId}\0${idempotencyKey}`
    const existing = this.autoFlights.get(key)
    if (existing) return existing
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) controller.abort(signal.reason)
    else signal?.addEventListener('abort', onAbort, { once: true })
    const job = Promise.resolve().then(async () => {
      if (!this.hasAttemptCapacity()) return onBusy()
      this.activeEvaluations++
      try { return await task(controller.signal) } finally { this.activeEvaluations-- }
    })
    this.autoFlights.set(key, job)
    this.routingControllers.set(key, controller)
    this.routingJobs.add(job)
    const cleanup = () => {
      this.autoFlights.delete(key)
      this.routingControllers.delete(key)
      this.routingJobs.delete(job)
      signal?.removeEventListener('abort', onAbort)
    }
    job.then(cleanup, cleanup)
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
      await this.ensureProfileEvidence(profile, current.workspaceKey)
      const attemptStartedAt = this.now()
      await this.refreshEvidenceHints(current, signal)
      const retrieval = this.retriever.retrieve({ agentId: profile.agentId, workspaceKey: current.workspaceKey, scope: current.scope, attemptStartedAt, excludeCaseId: current.caseId })
      const candidates = retrieval.L5
      const packed = buildContextPack({ profile, request: current.request, evidence: candidates, memory: { L2: retrieval.L2, L3: retrieval.L3 }, modelRoute, budgetTokens: this.config().decisionAgentContextBudgetTokens ?? 24000 })
      const beforeAttempt = this.cases.getCase(current.caseId)
      if (beforeAttempt.state === 'closed' && beforeAttempt.closing === 'cancelled') return this.persistedVerdict(beforeAttempt)
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
        authorizationClass: domainAuthorizationClass(current.request, profile),
        intentKind: domainIntentKind(current.request),
        conflictPairs: retrieval.conflictPairs,
        currentObservationHashes: retrieval.currentObservationHashes,
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

  /**
   * The profile identity is shared, but an Evidence Ref is still workspace-bound:
   * each workspace gets its own `user_profile` ref for the current description
   * revision instead of one row that would have to claim every workspace.
   */
  async ensureProfileEvidence(profile, workspaceKey) {
    const scope = { workspaces: [workspaceKey], ...(profile.scope.paths ? { paths: [...profile.scope.paths] } : {}), ...(profile.scope.tags ? { tags: [...profile.scope.tags] } : {}) }
    const row = this.store.db.prepare(`SELECT evidence_id FROM evidence
      WHERE agent_id=? AND source='user_profile' AND json_extract(locator_json,'$.revision')=?
        AND json_extract(scope_json,'$.workspaces[0]')=? AND status='active'`)
      .get(profile.agentId, profile.userDescription.revision, workspaceKey)
    if (row) return this.evidence.get(row.evidence_id)
    return this.evidence.add({ agentId: profile.agentId, source: 'user_profile', locator: { kind: 'profile', descriptionKind: 'user', revision: profile.userDescription.revision }, scope, status: 'active' })
  }

  /**
   * Private zones stay readable only from their own workspace. The public zone is
   * profile-global; Phase A has no public writer yet, so it is never readable here.
   * @param {{zone:string, namespaceWorkspaceKey:string|null}} record @param {string} workspaceKey
   */
  readableNamespace(record, workspaceKey) {
    return record.zone === 'workspace' && record.namespaceWorkspaceKey === workspaceKey
  }

  rejectBoundary({ caseId, agentId, rootSessionId, code = 'OUT_OF_SCOPE', detail }) {
    this.audit('outcome', { caseId, agentId, rootSessionId, action: 'boundary-reject', code })
    throw new DecisionContractError(code, detail ?? caseId ?? agentId ?? rootSessionId)
  }

  rejectLearningBoundary(kind, { learningRunId, snapshotId, agentId, rootSessionId, code = 'OUT_OF_SCOPE' }) {
    this.audit(kind, { learningRunId, snapshotId, agentId, rootSessionId, action: 'boundary-reject', code })
    throw new DecisionContractError(code, snapshotId ?? learningRunId ?? agentId ?? rootSessionId)
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
        if (this.hasAutoRoute(current)) this.assertAutoAttemptAuthority(current.request)
        const target = this.profiles.getProfile(input.agentId)
        if (target.state !== 'enabled') this.rejectBoundary({ caseId: current.caseId, agentId: target.agentId, rootSessionId: current.rootSessionId, code: 'AGENT_UNAVAILABLE', detail: input.agentId })
        const evaluating = await this.cases.transitionWithRoute({
          caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision,
          state: 'evaluating', agentId: target.agentId,
          ...(current.attemptCount >= current.maxAttempts ? { maxAttempts: current.attemptCount + 1 } : {}),
        }, {
          caseId: current.caseId, rootSessionId: current.rootSessionId, mode: 'manual_reassign',
          candidates: [{ agentId: target.agentId, enabled: true }], chosen: target.agentId, reason: 'User reassigned the Case',
        })
        this.audit('outcome', { caseId: current.caseId, action: 'reassign', agentId: target.agentId })
        return evaluating
      }
      case 'retry': {
        if (current.state !== 'awaiting_user') throw new DecisionContractError('NOT_RECOVERABLE', 'Only awaiting_user Cases can be retried')
        if (typeof current.agentId !== 'string' || !current.agentId) throw new DecisionContractError('AGENT_UNAVAILABLE', 'An unowned Case requires reassignment before retry')
        if (this.hasAutoRoute(current)) this.assertAutoAttemptAuthority(current.request)
        const profile = this.profiles.getProfile(current.agentId)
        if (profile.state !== 'enabled') this.rejectBoundary({ caseId: current.caseId, agentId: current.agentId, rootSessionId: current.rootSessionId, code: 'AGENT_UNAVAILABLE', detail: current.agentId })
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
    const config = this.config()
    const configuredClasses = config.decisionAgentAutoAnswerClasses
    const answerClasses = Array.isArray(configuredClasses) && configuredClasses.every(value => ['A', 'B', 'C'].includes(value))
      ? [...new Set(configuredClasses)]
      : []
    return {
      status: this.status(),
      selector: this.store ? this.profiles.selector(context.rootSessionId) : { mode: 'off' },
      agents: this.store ? this.profiles.listProfiles({ includeArchived: true }) : [],
      auto: { answerClasses, shadow: config.decisionAgentAutoShadow === true },
    }
  }

  async agents(input) {
    if (!this.store) return []
    const context = await this.sessionContext(input.sessionId)
    return this.profiles.listProfiles({ includeArchived: true }).map(profile => {
      const currentSnapshot = this.learning.currentSnapshot(profile.agentId, context.workspaceKey)
      return {
        ...profile,
        currentSnapshotId: currentSnapshot?.snapshotId ?? null,
        currentSnapshotVersion: currentSnapshot?.version ?? null,
        pendingReview: this.learning.listRuns(profile.agentId).some(run => run.outcome === 'candidate'),
      }
    })
  }

  async agent(input) {
    if (!this.store) return null
    const context = await this.sessionContext(input.sessionId)
    const profile = this.profiles.getProfile(input.agentId)
    const currentSnapshot = this.learning.currentSnapshot(profile.agentId, context.workspaceKey)
    const snapshotHistory = this.learning.listSnapshots(profile.agentId).slice(0, 20)
    if (currentSnapshot && !snapshotHistory.some(snapshot => snapshot.snapshotId === currentSnapshot.snapshotId)) snapshotHistory.push(currentSnapshot)
    return {
      ...profile,
      descriptionHistory: this.profiles.descriptionHistory(profile.agentId),
      currentSnapshotId: currentSnapshot?.snapshotId ?? null,
      learningRuns: this.learning.listRuns(profile.agentId).slice(0, 20).map(run => ({
        learningRunId: run.learningRunId, outcome: run.outcome, revision: run.revision,
        createdAt: run.createdAt, updatedAt: run.updatedAt,
      })),
      snapshots: snapshotHistory.map(snapshot => ({
        snapshotId: snapshot.snapshotId, version: snapshot.version, parentSnapshotId: snapshot.parentSnapshotId,
        state: snapshot.state, learningRunId: snapshot.learningRunId, revision: snapshot.revision,
        contentHash: snapshot.contentHash, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt,
      })),
    }
  }

  async caseForCall(input) {
    if (!this.store) return null
    const context = await this.sessionContext(input.sessionId)
    const signature = canonicalJson((input.questions ?? []).map(question => ({ id: question.id, question: question.question })))
    const rows = this.store.db.prepare('SELECT case_id,request_json FROM cases WHERE root_session_id=? ORDER BY created_at DESC,case_id DESC').all(context.rootSessionId)
    const found = rows.find(row => canonicalJson((JSON.parse(row.request_json).questions ?? []).map(question => ({ id: question.id, question: question.question }))) === signature)
    return found ? this.query.record({ caseId: found.case_id, sessionId: context.rootSessionId }) : null
  }

  consultCaseForToolCall(rootSessionId, toolCallId) {
    const row = this.store.db.prepare("SELECT case_id FROM cases WHERE root_session_id=? AND entry='consult' AND json_extract(request_json,'$.toolCallId')=? ORDER BY created_at DESC,case_id DESC LIMIT 1").get(rootSessionId, toolCallId)
    return row ? this.cases.getCase(row.case_id) : null
  }

  async caseForToolCall(input) {
    if (!this.store) return null
    const context = await this.sessionContext(input.sessionId)
    const current = this.consultCaseForToolCall(context.rootSessionId, input.toolCallId)
    return current ? this.query.record({ caseId: current.caseId, sessionId: context.rootSessionId }) : null
  }

  async waitForToolCall(input, signal) {
    if (!this.store) return null
    const context = await this.sessionContext(input.sessionId)
    const existing = this.consultCaseForToolCall(context.rootSessionId, input.toolCallId)
    if (existing && existing.state !== 'received' && existing.state !== 'evaluating') {
      return { caseId: existing.caseId, revision: existing.revision, state: existing.state }
    }
    // After sessionContext there is deliberately no await before registration:
    // an outcome cannot slip between this authoritative check and the waiter.
    return new Promise((resolve, reject) => {
      const waiter = { rootSessionId: context.rootSessionId, toolCallId: input.toolCallId, notify: null, abort: null }
      const onAbort = () => waiter.abort(signal.reason)
      const cleanup = () => {
        this.consultWaiters.delete(waiter)
        signal?.removeEventListener('abort', onAbort)
      }
      waiter.notify = current => {
        cleanup()
        resolve({ caseId: current.caseId, revision: current.revision, state: current.state })
      }
      waiter.abort = reason => {
        cleanup()
        reject(reason instanceof Error ? reason : new Error(String(reason ?? 'Decision wait aborted')))
      }
      this.consultWaiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) waiter.abort(signal.reason)
    })
  }

  publishConsult(current) {
    const toolCallId = current.request?.toolCallId
    if (!toolCallId || current.state === 'received' || current.state === 'evaluating') return
    for (const waiter of [...this.consultWaiters]) {
      if (waiter.rootSessionId === current.rootSessionId && waiter.toolCallId === toolCallId) waiter.notify(current)
    }
  }

  async learningStart(input) {
    await this.ensureStore()
    if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 200) {
      throw new DecisionContractError('INVALID_REQUEST_ID', 'requestId is required')
    }
    const context = await this.sessionContext(input.sessionId)
    const profile = this.profiles.getProfile(input.agentId)
    // A private run freezes exactly the caller's workspace: the shared identity
    // does not widen which private records this run may read.
    const workspaceMismatch = input.workspaceKey !== undefined && input.workspaceKey !== context.workspaceKey
    if (profile.state !== 'enabled' || workspaceMismatch) {
      this.rejectLearningBoundary('learning-run', {
        agentId: input.agentId, rootSessionId: context.rootSessionId,
        code: workspaceMismatch ? 'OUT_OF_SCOPE' : 'AGENT_UNAVAILABLE',
      })
    }
    const jobKey = `${profile.agentId}\0${input.requestId}`
    const existing = this.learningJobKeys.get(jobKey)
    if (existing) return existing
    const job = this.executeLearningStart({ input, context, profile })
    this.learningJobKeys.set(jobKey, job)
    this.learningJobs.add(job)
    const cleanup = () => {
      this.learningJobKeys.delete(jobKey)
      this.learningJobs.delete(job)
    }
    job.then(cleanup, cleanup)
    return job
  }

  async executeLearningStart({ input, context, profile }) {
    let modelRoute
    try {
      const agent = await this.rootAgent(context.rootSessionId)
      const configuredChains = this.config().decisionAgentChains
      modelRoute = await resolveDecisionModelRoute({
        llm: this.ctx.llm, chain: configuredChains?.[profile.agentId] ?? profile.modelRoute.chain,
        sessionRoute: sessionModelRoute(agent),
      })
    } catch {
      modelRoute = { kind: 'unavailable', reason: 'route_resolution_failed' }
    }
    const started = await this.learning.beginRun({
      agentId: profile.agentId, workspaceKey: context.workspaceKey, requestId: input.requestId,
      agentProfileRevision: profile.revision, startedAt: this.now(), modelRoute,
    })
    if (!started.created) return started.run
    const run = started.run
    this.audit('learning-run', { learningRunId: run.learningRunId, agentId: run.agentId, rootSessionId: context.rootSessionId, action: 'start', outcome: 'running' })
    const controller = new AbortController()
    this.learningControllers.set(run.learningRunId, controller)
    try {
      const streamed = await streamDecision({
        llm: this.ctx.llm, route: modelRoute, pack: buildConsolidationPack(started.projection),
        maxOutputTokens: this.config().decisionAgentLearningMaxOutputTokens ?? 4000,
        timeoutMs: this.config().decisionAgentLearningTimeoutMs ?? 60000,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return this.finishFailedLearning(run, 'INTERRUPTED', context.rootSessionId)
      if (streamed.finishReason !== 'stop') {
        const detail = ({
          timeout: 'MODEL_TIMEOUT', route_unavailable: 'ROUTE_UNAVAILABLE', aborted: 'INTERRUPTED',
          'max-tokens': 'CANDIDATE_TOO_LARGE',
        })[streamed.finishReason] ?? 'MODEL_ERROR'
        return this.finishFailedLearning(run, detail, context.rootSessionId)
      }
      let operations
      try {
        operations = parseConsolidationCandidate(streamed.text, started.authority.parentPrinciples)
      } catch (error) {
        return this.finishFailedLearning(run, typeof error?.code === 'string' ? error.code : 'INVALID_CANDIDATE', context.rootSessionId)
      }
      const replay = replayOperations(started.authority.parentPrinciples, operations, started.authority)
      if (!replay.passed) return this.finishFailedLearning(run, replay, context.rootSessionId)
      const principles = applyConsolidationOperations(started.authority.parentPrinciples, operations, started.authority)
      try {
        const committed = await this.learning.commitCandidate({
          learningRunId: run.learningRunId, expectedRevision: run.revision, operations, replay, principles,
        })
        this.audit('learning-run', {
          learningRunId: run.learningRunId, agentId: run.agentId, rootSessionId: context.rootSessionId, outcome: 'candidate',
          revision: committed.run.revision, operationCount: operations.length,
        })
        this.audit('snapshot', {
          snapshotId: committed.snapshot.snapshotId, learningRunId: run.learningRunId, agentId: run.agentId, rootSessionId: context.rootSessionId,
          state: 'draft', version: committed.snapshot.version, revision: committed.snapshot.revision,
          contentHash: committed.snapshot.contentHash,
        })
        return committed.run
      } catch (error) {
        if (error?.code === 'STALE_LEARNING_RUN') return this.learning.getRunById(run.learningRunId)
        throw error
      }
    } catch (error) {
      return this.finishFailedLearning(run, typeof error?.code === 'string' ? error.code : 'CONSOLIDATION_ERROR', context.rootSessionId)
    } finally {
      this.learningControllers.delete(run.learningRunId)
    }
  }

  async finishFailedLearning(run, failure, rootSessionId) {
    const failed = await this.learning.failRun(run.learningRunId, failure, run.revision)
    this.audit('learning-run', {
      learningRunId: run.learningRunId, agentId: run.agentId, rootSessionId, outcome: failed.outcome,
      revision: failed.revision, code: failed.replay?.detail,
    })
    return failed
  }

  async snapshotPublish(input) { return this.snapshotAction('publish', input) }
  async snapshotReject(input) { return this.snapshotAction('reject', input) }
  async snapshotRollback(input) { return this.snapshotAction('rollback', input) }

  async snapshotAction(action, input) {
    const context = await this.sessionContext(input.sessionId)
    const snapshot = await this.memorySnapshot(input)
    const result = await this.learning[action](snapshot.snapshotId, input.expectedRevision)
    if (result.error) {
      this.audit('learning-run', {
        learningRunId: result.run.learningRunId, agentId: result.run.agentId, rootSessionId: context.rootSessionId,
        outcome: result.run.outcome, revision: result.run.revision, code: result.error,
      })
      this.audit('snapshot', { snapshotId: snapshot.snapshotId, agentId: snapshot.agentId, rootSessionId: context.rootSessionId, action, state: snapshot.state, code: result.error })
      throw new DecisionContractError(result.error, snapshot.snapshotId)
    }
    this.audit('learning-run', {
      learningRunId: result.run.learningRunId, agentId: result.run.agentId, rootSessionId: context.rootSessionId,
      outcome: result.run.outcome, revision: result.run.revision,
    })
    this.audit('snapshot', {
      snapshotId: result.snapshot.snapshotId, learningRunId: result.run.learningRunId, agentId: result.run.agentId, rootSessionId: context.rootSessionId,
      action, state: result.snapshot.state, version: result.snapshot.version,
      revision: result.snapshot.revision, contentHash: result.snapshot.contentHash,
    })
    return result.snapshot
  }

  async learningRun(input) {
    await this.ensureStore()
    const context = await this.sessionContext(input.sessionId)
    const run = this.learning.getRunById(input.learningRunId)
    if (!this.readableNamespace(run, context.workspaceKey) || (input.agentId && input.agentId !== run.agentId)) {
      this.rejectLearningBoundary('learning-run', { learningRunId: run.learningRunId, agentId: run.agentId, rootSessionId: context.rootSessionId })
    }
    return {
      ...run,
      sourceRecords: this.learning.sourceRecords({
        agentId: run.agentId, workspaceKey: context.workspaceKey,
        sourceIds: run.operations.flatMap(operation => operation.sources ?? []), revisions: run.inputFrozen.revisions,
      }),
    }
  }

  async memorySnapshot(input) {
    await this.ensureStore()
    const context = await this.sessionContext(input.sessionId)
    const snapshot = this.learning.getSnapshotById(input.snapshotId)
    if (!this.readableNamespace(snapshot, context.workspaceKey) || (input.agentId && input.agentId !== snapshot.agentId)) {
      this.rejectLearningBoundary('snapshot', { snapshotId: snapshot.snapshotId, agentId: snapshot.agentId, rootSessionId: context.rootSessionId })
    }
    const run = this.learning.getRunById(snapshot.learningRunId)
    const revisions = run.agentId === snapshot.agentId && run.inputFrozen.workspaceKey === context.workspaceKey ? run.inputFrozen.revisions : {}
    return {
      ...snapshot,
      sourceRecords: this.learning.sourceRecords({
        agentId: snapshot.agentId, workspaceKey: context.workspaceKey,
        sourceIds: snapshot.principles.flatMap(principle => principle.sources), revisions,
      }),
    }
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

  async routingReview(input) {
    const context = await this.sessionContext(input.sessionId)
    const authorized = { ...input, sessionId: context.rootSessionId, workspaceKey: context.workspaceKey }
    if (!this.store) return emptyRoutingReview(authorized)
    return this.query.routingReview(authorized)
  }

  async metrics(input) {
    if (!this.store) return { window: input.window ?? 'all', casesOpened: 0, attemptsTotal: 0, autoAnswered: 0, routing: projectRoutingChains([]).summary, reassignments: 0, selectorOffBypasses: 0 }
    const context = await this.sessionContext(input.sessionId)
    return this.query.metrics({ ...input, sessionId: context.rootSessionId, workspaceKey: context.workspaceKey })
  }
}
function consultFingerprint(request, scope) {
  return canonicalJson({ questions: request.questions, context: request.context, taskSummary: request.taskSummary, evidence: request.evidence, scope })
}

function callerRevisionFingerprint(request, scope) {
  const questions = (request.questions ?? []).map(question => {
    if (question?.authorizationClassSource !== 'auto_classifier' || !Object.hasOwn(question, 'authorizationClass')) return question
    const { authorizationClass, authorizationClassSource, ...callerQuestion } = question
    return callerQuestion
  })
  return canonicalJson({ questions, context: request.context, taskSummary: request.taskSummary, evidence: request.evidence, scope })
}

function domainAuthorizationClass(request, profile) {
  const classes = (request.questions ?? []).map(question => question?.authorizationClass).filter(value => value !== undefined)
  return classes.find(value => !profile.scope?.authorizationClasses?.includes(value)) ?? classes[0]
}

function domainIntentKind(request) {
  const kinds = (request.questions ?? []).map(question => question?.intent?.kind).filter(value => value !== undefined)
  return kinds.find(value => ['approval', 'plan-review'].includes(value)) ?? kinds[0]
}
