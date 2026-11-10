// P4 Active Auto: real stock Hook/consult routing through the live Decision Broker.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DECISION_EVENTS, decisionPack, decisionStoreDirectory, observeDecision, readDecisionEvents, readDecisionStore } from '../decision-test-kit.js'
import { textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'decision-auto-route'
const prompt = 'decision-auto-route-probe'
const HOOKS = {
  selected: { id: 'decision-auto-selected', question: 'AUTO_SELECTED: choose the evidenced route', options: [{ label: 'Selected A' }, { label: 'Other' }] },
  zero: { id: 'decision-auto-zero', question: 'AUTO_ZERO: no Agent authorizes class C', options: [{ label: 'Native zero' }, { label: 'Fallback' }] },
  one: { id: 'decision-auto-one', question: 'AUTO_ONE: only B authorizes class B', options: [{ label: 'Selected B' }, { label: 'Other' }] },
  none: { id: 'decision-auto-none', question: 'AUTO_NONE: no candidate matches', options: [{ label: 'Native none' }, { label: 'Fallback' }] },
  ambiguous: { id: 'decision-auto-ambiguous', question: 'AUTO_AMBIGUOUS: overlapping candidates', options: [{ label: 'Native ambiguity' }, { label: 'Fallback' }] },
  invalid: { id: 'decision-auto-invalid', question: 'AUTO_INVALID: invalid router output', options: [{ label: 'Native invalid' }, { label: 'Fallback' }] },
  timeout: { id: 'decision-auto-timeout', question: 'AUTO_TIMEOUT: hold the router stream', options: [{ label: 'Native timeout' }, { label: 'Fallback' }] },
}
const PARTIAL = [
  { id: 'decision-auto-partial-1', question: 'AUTO_PARTIAL: first question has an answer', options: [{ label: 'Partial first' }, { label: 'Other first' }] },
  { id: 'decision-auto-partial-2', question: 'AUTO_PARTIAL: second question still needs judgment', options: [{ label: 'Partial second' }, { label: 'Other second' }] },
]
const AUTO_CONSULT = { question: 'AUTO_CONSULT: real classless tool consultation', options: [{ label: 'Auto Consult B' }, { label: 'Other' }], request_id: 'auto-consult' }
const EXPLICIT = { question: 'AUTO_EXPLICIT: explicit B wins over Auto', options: [{ label: 'Explicit B' }, { label: 'Other' }], request_id: 'auto-explicit', authorization_class: 'B' }
const EXPLICIT_UNAVAILABLE = { question: 'AUTO_EXPLICIT_UNAVAILABLE: disabled B must not fall back', options: [{ label: 'Native unavailable' }], request_id: 'auto-explicit-unavailable', authorization_class: 'B' }

function decide(options, obs) {
  const history = obs.transcript
  if (history.includes('DECISION_TEST error')) return textChunks('DECISION_AUTO_ROUTE_FAILED')
  if (!history.includes('DECISION_TEST done auto-setup')) return toolCallChunks('decision_integration_probe', { op: 'auto-setup' })
  for (const question of Object.values(HOOKS)) {
    if (!history.includes(question.id)) return toolCallChunks('ask_user_question', { questions: [question] })
  }
  if (!history.includes(PARTIAL[0].id)) return toolCallChunks('ask_user_question', { questions: PARTIAL })
  if (!history.includes('DECISION_TEST done auto-singleflight')) return toolCallChunks('decision_integration_probe', { op: 'auto-singleflight' })
  if (!history.includes('DECISION_TEST done auto-replay')) return toolCallChunks('decision_integration_probe', { op: 'auto-replay' })
  if (!history.includes('"selected":["Auto Consult B"]')) return toolCallChunks('decision_consult', AUTO_CONSULT)
  if (!history.includes('"selected":["Explicit B"]')) {
    const agentId = /"agentB":"([^"]+)"/.exec(history)?.[1]
    if (!agentId) return textChunks('DECISION_AUTO_ROUTE_FAILED')
    return toolCallChunks('decision_consult', { ...EXPLICIT, agent_id: agentId })
  }
  if (!history.includes('DECISION_TEST done disable-a')) {
    const agentId = /"agentB":"([^"]+)"/.exec(history)?.[1]
    if (!agentId) return textChunks('DECISION_AUTO_ROUTE_FAILED')
    return toolCallChunks('decision_integration_probe', { op: 'disable-a', agentId })
  }
  if (history.includes('AGENT_UNAVAILABLE') || history.includes('unavailable for this workspace')) {
    if (!history.includes('DECISION_TEST done auto-safety')) return toolCallChunks('decision_integration_probe', { op: 'auto-safety' })
    return textChunks('DECISION_AUTO_ROUTE_DONE')
  }
  const agentId = /"agentB":"([^"]+)"/.exec(history)?.[1]
  if (!agentId) return textChunks('DECISION_AUTO_ROUTE_FAILED')
  return toolCallChunks('decision_consult', { ...EXPLICIT_UNAVAILABLE, agent_id: agentId })
}

function classify(pack) {
  return pack.questions.map(question => ({
    id: question.id,
    authorizationClass: question.question?.startsWith('AUTO_ZERO') ? 'C'
      : question.question?.startsWith('AUTO_SAFETY_UNKNOWN') ? 'unknown'
        : question.question?.startsWith('AUTO_SAFETY_MIXED_MISSING') ? 'D'
          : /^(?:AUTO_ONE|AUTO_SINGLEFLIGHT|AUTO_REPLAY|AUTO_CONSULT)/.test(question.question ?? '') ? 'B' : 'A',
  }))
}

function decideRouterClassification(options, obs) {
  const pack = decisionPack(obs)
  if (!pack || !Array.isArray(pack.questions)) throw new Error('decision-auto-route: malformed classification pack')
  if (process.env.WEIR_IT_AUTO_SHADOW_FAILURE === 'classification' && pack.questions.some(question => question.question?.startsWith('AUTO_SAFETY_SHADOW_FAILURE_CONTROL'))) return textChunks('not-json')
  return textChunks(JSON.stringify({ contract: 'router-classification-contract/1', classes: classify(pack) }))
}

function decideRouterRoute(options, obs) {
  const pack = decisionPack(obs)
  const question = pack?.questions?.[0]?.question ?? ''
  if (question.startsWith('AUTO_SAFETY_SHADOW_FAILURE_CONTROL') && process.env.WEIR_IT_AUTO_SHADOW_FAILURE === 'routing') return textChunks('not-json')
  if (question.startsWith('AUTO_SAFETY_UNOWNED')) return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'none', reason: 'No Auto owner; preserve the unowned user decision boundary' }))
  if (question.startsWith('AUTO_TIMEOUT')) return []
  if (question.startsWith('AUTO_NONE')) {
    return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'none', reason: 'No eligible Agent matches this request' }))
  }
  if (question.startsWith('AUTO_AMBIGUOUS')) {
    return textChunks(JSON.stringify({
      contract: 'router-contract/1', outcome: 'ambiguous', reason: 'The eligible Agents have overlapping authority',
      ambiguity: { candidates: pack.candidates.map(candidate => candidate.agentId), conflict: 'Both candidate descriptions claim the same decision fixture' },
    }))
  }
  if (question.startsWith('AUTO_INVALID')) {
    return textChunks('{"contract":"router-contract/1","outcome":"selected","agentId":"ag_not_eligible","reason":"Unknown candidate must be rejected"}')
  }
  const selected = question.startsWith('AUTO_SAFETY_SHADOW')
    ? pack?.candidates?.find(candidate => candidate.name?.endsWith(' B'))
    : pack?.candidates?.find(candidate => candidate.name?.endsWith(' A')) ?? pack?.candidates?.[0]
  if (!selected) throw new Error('decision-auto-route: selected fixture requires an eligible candidate')
  return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'selected', agentId: selected.agentId, reason: 'Auto A owns this evidenced fixture' }))
}

function decideDecision(options, obs) {
  const pack = decisionPack(obs)
  const questions = pack?.L4?.request?.questions ?? []
  const question = questions[0]
  if (question?.question?.startsWith('AUTO_REPLAY')) {
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'AUTO_REPLAY requires a real caller revision' }))
  }
  if (question?.question?.startsWith('AUTO_SAFETY_RETRY')) {
    return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['The owned Auto retry fixture requires user judgment'] }))
  }
  const evidenceId = pack?.L5?.find(evidence => evidence.source === 'user_profile')?.evidenceId
  if (!question || !evidenceId) return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['The Auto fixture requires selected Agent evidence'] }))
  const answered = question.question?.startsWith('AUTO_PARTIAL') ? questions.slice(0, 1) : questions
  return textChunks(JSON.stringify({
    outcome: 'answer',
    claims: [{ text: 'The selected Auto Agent profile supports this answer.', evidenceIds: [evidenceId] }],
    answers: answered.map(item => ({ id: item.id, selected: [item.options?.[0]?.label ?? 'Selected A'] })),
  }))
}

function probeReport(obs, op) {
  const prefix = `DECISION_TEST done ${op}:`
  if (!obs.lastTool.startsWith(prefix)) return null
  try { return JSON.parse(obs.lastTool.slice(prefix.length)) } catch { return null }
}

function observe(obs) {
  const setup = probeReport(obs, 'auto-setup')
  const singleflight = probeReport(obs, 'auto-singleflight')
  const replay = probeReport(obs, 'auto-replay')
  const explicitUnavailable = obs.lastTool.includes('AGENT_UNAVAILABLE') || obs.lastTool.includes('unavailable for this workspace')
  const base = {
    ...observeDecision(obs),
    ...(setup ? { autoSetupReport: setup } : {}),
    ...(singleflight ? { autoSingleflightReport: singleflight } : {}),
    ...(replay ? { autoReplayReport: replay } : {}),
    ...(explicitUnavailable ? { autoExplicitUnavailable: true } : {}),
  }
  if (base.decisionEvaluator) {
    const pack = decisionPack(obs)
    const question = pack?.L4?.request?.questions?.[0]
    const store = readDecisionStore(process.env.WEIR_IT_ROOT ?? '', decisionStoreDirectory(id))
    const current = store.cases.find(item => item.request.questions?.some(candidate => candidate.id === question?.id && candidate.question === question?.question))
    const route = store.routes.find(item => item.case_id === current?.case_id)
    return {
      ...base,
      ...(current && route?.mode === 'auto' ? { autoAtomic: {
        caseId: current.case_id, state: current.state, agentId: current.agent_id,
        routeMode: route.mode, chosen: route.chosen, request: current.request,
      } } : {}),
    }
  }
  const contract = obs.system.split('\n', 1)[0]
  const classification = contract === 'Auto request classification contract: router-classification-contract/1'
  const routing = contract === 'Auto candidate router contract: router-contract/1'
  if (!classification && !routing) return base
  const pack = decisionPack(obs)
  const question = pack?.questions?.[0]?.question ?? ''
  return {
    ...base,
    autoRouter: {
      kind: classification ? 'classification' : 'route', pack,
      tools: obs.toolNames, hasTemperature: obs.hasTemperature,
      provider: obs.provider, model: obs.model, maxTokens: obs.maxTokens,
    },
    ...(routing && question.startsWith('AUTO_TIMEOUT') ? { autoRouterHold: 'timeout' } : {}),
    ...(classification && question.startsWith('AUTO_SINGLEFLIGHT') ? { autoRouterHold: 'singleflight' } : {}),
    ...(classification && question.startsWith('AUTO_SAFETY_FLUSH') ? { autoRouterHold: 'flush' } : {}),
  }
}

function assert(run) {
  const store = readDecisionStore(run.ws, decisionStoreDirectory(id))
  const events = readDecisionEvents()
  const caseFor = marker => store.cases.find(item => item.request.questions?.some(question => question.id === marker || question.question?.startsWith(marker)))
  const routeFor = item => store.routes.find(route => route.case_id === item?.case_id)
  const attemptsFor = item => store.attempts.filter(attempt => attempt.case_id === item?.case_id)
  const nativeFor = marker => events.find(event => event.questionIds?.includes(marker))
  const snapshotFor = marker => nativeFor(marker)?.caseSnapshot?.case
  const wiresFor = (marker, kind) => run.requests.filter(request => request.autoRouter?.kind === kind && request.autoRouter.pack?.questions?.some(question => question.id === marker || question.question?.startsWith(marker)))
  const evaluationFor = marker => run.requests.filter(request => request.decisionQuestionIds?.includes(marker) || request.autoAtomic?.request?.questions?.some(question => question.question?.startsWith(marker)))
  const agentA = store.profiles.find(profile => profile.name === 'Decision Auto A')?.agent_id
  const agentB = store.profiles.find(profile => profile.name === 'Decision Auto B')?.agent_id
  const allGates = attempt => ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'].every(gate => attempt?.gates?.[gate] === true)
  const selected = caseFor('decision-auto-selected')
  const zero = caseFor('decision-auto-zero')
  const one = caseFor('decision-auto-one')
  const none = caseFor('decision-auto-none')
  const ambiguous = caseFor('decision-auto-ambiguous')
  const invalid = caseFor('decision-auto-invalid')
  const timeout = caseFor('decision-auto-timeout')
  const partial = caseFor('decision-auto-partial-1')
  const singleflight = caseFor('AUTO_SINGLEFLIGHT')
  const replay = caseFor('AUTO_REPLAY')
  const autoConsult = caseFor('AUTO_CONSULT')
  const explicit = caseFor('AUTO_EXPLICIT:')
  const singleflightReport = run.requests.find(request => request.autoSingleflightReport)?.autoSingleflightReport
  const replayReport = run.requests.find(request => request.autoReplayReport)?.autoReplayReport

  const selectedRoute = routeFor(selected)
  const selectedAttempt = attemptsFor(selected)[0]
  const selectedWire = wiresFor('decision-auto-selected', 'classification')[0]
  const selectedRouteWire = wiresFor('decision-auto-selected', 'route')[0]
  run.check('classless stock Hook uses bounded derived A classification and selects only A through the real multi-candidate Router', selected?.closing === 'answered' && selected?.agent_id === agentA && selectedRoute?.mode === 'auto' && selectedRoute?.chosen === agentA && selected?.request.questions[0].authorizationClassSource === 'auto_classifier' && selected?.request.questions[0].authorizationClass === 'A' && selectedRouteWire?.autoRouter.pack.candidates?.map(candidate => candidate.agentId).sort().join(',') === [agentA, agentB].sort().join(',') && selectedWire?.autoRouter.pack.candidates === undefined && selectedWire?.autoRouter.pack.questions.every(question => !Object.hasOwn(question, 'authorizationClass') && !Object.hasOwn(question, 'authorizationClassSource')) && !nativeFor('decision-auto-selected') && allGates(selectedAttempt), JSON.stringify({ selected, route: selectedRoute, selectedWire, selectedRouteWire, attempt: selectedAttempt }))

  const zeroRoute = routeFor(zero)
  run.check('zero eligible candidates fail closed without a Router call or domain Attempt', zero?.closing === 'escalated' && zero?.agent_id === null && zeroRoute?.chosen === null && zeroRoute?.reason === 'none:no_candidates' && zero?.request.questions[0].authorizationClass === 'C' && zero?.request.questions[0].authorizationClassSource === 'auto_classifier' && snapshotFor('decision-auto-zero')?.awaitingReason === 'no_route' && attemptsFor(zero).length === 0 && wiresFor('decision-auto-zero', 'route').length === 0, JSON.stringify({ zero, route: zeroRoute, native: nativeFor('decision-auto-zero') }))

  const oneRoute = routeFor(one)
  run.check('one eligible B candidate is deterministic and still passes every domain gate', one?.closing === 'answered' && one?.agent_id === agentB && oneRoute?.chosen === agentB && oneRoute?.reason === 'deterministic:single_candidate' && attemptsFor(one).length === 1 && allGates(attemptsFor(one)[0]) && wiresFor('decision-auto-one', 'route').length === 0 && !nativeFor('decision-auto-one'), JSON.stringify({ one, route: oneRoute, attempts: attemptsFor(one) }))

  const noneRoute = routeFor(none)
  run.check('substantive no-match yields an unowned no_route native handoff without evaluation', none?.agent_id === null && noneRoute?.mode === 'auto' && noneRoute?.chosen === null && noneRoute?.reason === 'No eligible Agent matches this request' && snapshotFor('decision-auto-none')?.awaitingReason === 'no_route' && attemptsFor(none).length === 0, JSON.stringify({ none, route: noneRoute, native: nativeFor('decision-auto-none') }))

  const ambiguousRoute = routeFor(ambiguous)
  run.check('substantive ambiguity preserves both candidates and conflict without choosing or evaluating', ambiguous?.agent_id === null && ambiguousRoute?.chosen === null && ambiguousRoute?.ambiguity?.conflict?.length > 0 && ambiguousRoute?.ambiguity?.candidates?.slice().sort().join(',') === [agentA, agentB].sort().join(',') && snapshotFor('decision-auto-ambiguous')?.awaitingReason === 'route_ambiguous' && attemptsFor(ambiguous).length === 0, JSON.stringify({ ambiguous, route: ambiguousRoute, native: nativeFor('decision-auto-ambiguous') }))

  run.check('invalid Router output fails closed with no selected Agent or domain Attempt', routeFor(invalid)?.reason === 'failure:invalid_output' && routeFor(invalid)?.chosen === null && invalid?.agent_id === null && snapshotFor('decision-auto-invalid')?.awaitingReason === 'no_route' && attemptsFor(invalid).length === 0, JSON.stringify({ invalid, route: routeFor(invalid), native: nativeFor('decision-auto-invalid') }))

  const timeoutWire = wiresFor('decision-auto-timeout', 'route')[0]
  run.check('Router timeout comes from the held streaming seam and creates no domain Attempt', routeFor(timeout)?.reason === 'failure:timeout' && routeFor(timeout)?.chosen === null && timeout?.agent_id === null && snapshotFor('decision-auto-timeout')?.awaitingReason === 'no_route' && attemptsFor(timeout).length === 0 && timeoutWire?.emitted.length === 0, JSON.stringify({ timeout, route: routeFor(timeout), timeoutWire, native: nativeFor('decision-auto-timeout') }))

  const partialAttempt = attemptsFor(partial)[0]
  run.check('selected Auto still enforces G7 all-or-nothing and returns the complete native batch for a partial answer', routeFor(partial)?.chosen === agentA && partialAttempt?.gates?.g7 === false && partialAttempt?.outcome === 'return' && snapshotFor('decision-auto-partial-1')?.awaitingReason === 'partial_batch' && nativeFor('decision-auto-partial-1')?.questionIds?.length === 2 && attemptsFor(partial).length === 1 && partial?.closing === 'escalated', JSON.stringify({ partial, attempt: partialAttempt, native: nativeFor('decision-auto-partial-1') }))

  const autoAttempts = store.attempts.filter(attempt => routeFor(store.cases.find(item => item.case_id === attempt.case_id))?.mode === 'auto')
  const atomicSnapshots = run.requests.map(request => request.autoAtomic).filter(Boolean)
  const badAtomic = atomicSnapshots.filter(snapshot => {
    const current = store.cases.find(item => item.case_id === snapshot.caseId)
    return snapshot.state !== 'evaluating' || snapshot.routeMode !== 'auto' || snapshot.chosen !== snapshot.agentId || !current
  })
  run.check('every Auto domain model call observes atomically committed RouteDecision, Case ownership and evaluating state', atomicSnapshots.length === autoAttempts.length && autoAttempts.length === 10 && badAtomic.length === 0 && autoAttempts.filter(attempt => attempt.outcome === 'answer').every(allGates), JSON.stringify({ autoAttempts: autoAttempts.map(attempt => ({ caseId: attempt.case_id, outcome: attempt.outcome, gates: attempt.gates })), atomicSnapshots, badAtomic }))

  run.check('genuine concurrent same-key consultations join before commit and publish only one settled result', singleflightReport?.before?.cases === 1 && singleflightReport?.before?.received === 1 && singleflightReport?.before?.routes === 0 && singleflightReport?.before?.attempts === 0 && singleflightReport?.before?.firstSettled === false && singleflightReport?.before?.replaySettled === false && singleflightReport?.before?.publishes === 0 && singleflightReport?.before?.flights === 1 && singleflightReport?.after?.sameResult === true && singleflightReport?.after?.publishes === 1 && singleflightReport?.after?.flights === 0 && singleflight?.agent_id === agentB && attemptsFor(singleflight).length === 1 && wiresFor('AUTO_SINGLEFLIGHT', 'classification').length === 1, JSON.stringify({ singleflightReport, singleflight, route: routeFor(singleflight) }))

  const revisionAttempts = replayReport?.revisions?.map(item => item.attempts).join(',')
  run.check('post-flight identical classless replay adds nothing while question/context/options/scope changes are real revisions', replayReport?.initial?.state === 'awaiting_revision' && replayReport?.initial?.flights === 0 && replayReport?.initial?.derivedClass === 'B' && replayReport?.initial?.derivedSource === 'auto_classifier' && replayReport?.replay?.sameResult === true && replayReport?.replay?.routes === 1 && replayReport?.replay?.attempts === 1 && revisionAttempts === '2,3,4,5' && replayReport?.revisions?.every(item => item.state === 'awaiting_revision' && item.routes === 1 && item.sameAgent === true) && replayReport?.revisions?.map(item => item.field).join(',') === 'question,context,options,scope' && wiresFor('AUTO_REPLAY', 'classification').length === 1 && evaluationFor('AUTO_REPLAY').length === 5, JSON.stringify({ replayReport, replay, route: routeFor(replay) }))
  run.check('Auto content revisions revalidate exclusion and caller/current whitelist authority without a new Attempt', replayReport?.denials?.length === 4 && replayReport.denials.every(item => item.errorCode === 'AUTHORITY' && item.unchanged === true && item.sameAgent === true && item.routes === 1 && item.attempts === 5), JSON.stringify({ denials: replayReport?.denials }))

  run.check('real classless decision_consult persists derived B and answers through Auto without native questions', autoConsult?.entry === 'consult' && autoConsult?.closing === 'answered' && autoConsult?.agent_id === agentB && routeFor(autoConsult)?.mode === 'auto' && autoConsult?.request.questions[0].authorizationClass === 'B' && autoConsult?.request.questions[0].authorizationClassSource === 'auto_classifier' && attemptsFor(autoConsult).length === 1 && allGates(attemptsFor(autoConsult)[0]), JSON.stringify({ autoConsult, route: routeFor(autoConsult) }))

  const selector = store.selectors.find(row => row.root_session_id === selected?.root_session_id)
  const unavailable = caseFor('AUTO_EXPLICIT_UNAVAILABLE')
  run.check('real explicit agent_id has priority, never changes Auto, and unavailable B never falls back to A', explicit?.closing === 'answered' && explicit?.agent_id === agentB && routeFor(explicit)?.mode === 'explicit' && routeFor(explicit)?.chosen === agentB && wiresFor('AUTO_EXPLICIT:', 'classification').length === 0 && wiresFor('AUTO_EXPLICIT:', 'route').length === 0 && selector?.mode === 'auto' && selector?.agent_id === null && !unavailable && run.requests.some(request => request.autoExplicitUnavailable), JSON.stringify({ explicit, route: routeFor(explicit), selector, unavailable }))

  const routerWires = run.requests.filter(request => request.autoRouter)
  const coreRouterWires = routerWires.filter(request => request.autoRouter.pack?.questions?.every(question => !/^(?:AUTO_SAFETY|AUTO_SHADOW)/.test(question.question ?? '')))
  const classificationWires = coreRouterWires.filter(request => request.autoRouter.kind === 'classification')
  const routeWires = coreRouterWires.filter(request => request.autoRouter.kind === 'route')
  const cleanWire = request => request.autoRouter.tools.length === 0 && request.autoRouter.hasTemperature === false && request.autoRouter.provider === 'mock' && request.autoRouter.model === 'mock-1' && request.autoRouter.maxTokens === 1600
  const forbiddenWireKeys = /generatedDescription|memorySnapshot|snapshotId|principles|feedback|attempts|history/
  run.check('Router model wire is bounded, tool-free, temperature-free and excludes domain history/profile memory', classificationWires.length === 11 && routeWires.length === 6 && routerWires.every(cleanWire) && classificationWires.every(request => !forbiddenWireKeys.test(JSON.stringify(request.autoRouter.pack)) && !JSON.stringify(request.autoRouter.pack).includes('Decision Auto')) && routeWires.every(request => !forbiddenWireKeys.test(JSON.stringify(request.autoRouter.pack))), JSON.stringify({ classifications: classificationWires.length, routes: routeWires.length, bad: routerWires.filter(request => !cleanWire(request)) }))

  const nativeIds = events.flatMap(event => event.questionIds ?? [])
  const expectedNativeIds = ['decision-auto-zero', 'decision-auto-none', 'decision-auto-ambiguous', 'decision-auto-invalid', 'decision-auto-timeout', 'decision-auto-partial-1', 'decision-auto-partial-2']
  run.check('native-question events occur only after persisted recoverable failure or partial-batch states, never for answered Auto/consult work', events.length === 6 && nativeIds.slice().sort().join(',') === expectedNativeIds.slice().sort().join(',') && events.every(event => event.caseSnapshot?.case?.state === 'awaiting_user') && !nativeIds.some(questionId => ['decision-auto-selected', 'decision-auto-one'].includes(questionId)), JSON.stringify({ events }))

  const knownAgents = new Set([agentA, agentB, null])
  run.check('exact authority census has no duplicate flight, false revision, partial answer, or generic fallback Agent', store.cases.length === 12 && store.routes.length === 12 && store.attempts.length === 11 && store.profiles.length === 2 && store.cases.every(item => knownAgents.has(item.agent_id)) && store.routes.every(route => route.chosen === null || knownAgents.has(route.chosen)), JSON.stringify({ cases: store.cases.length, routes: store.routes.length, attempts: store.attempts.length, profiles: store.profiles.map(profile => ({ id: profile.agent_id, name: profile.name })) }))

  const safetyPath = join(run.ws, 'decision-auto-safety.json')
  const safety = existsSync(safetyPath) ? JSON.parse(readFileSync(safetyPath, 'utf8')) : null
  const setupReport = run.requests.find(request => request.autoSetupReport)?.autoSetupReport
  const safetyWires = marker => routerWires.filter(request => request.autoRouter.pack?.questions?.some(question => question.question?.startsWith(marker)))
  run.check('fresh startup roots receive Auto while explicit Off survives reinitialization and store reopen', setupReport?.initialSelector?.mode === 'auto' && (setupReport?.initialSelector?.agentId ?? null) === null && safety?.selector?.storeBefore === false && safety?.selector?.fresh?.mode === 'auto' && safety?.selector?.explicitOff?.mode === 'off' && safety?.selector?.resumed?.mode === 'off' && safety?.selector?.restartedStartup?.mode === 'off' && safety?.selector?.persistedRows?.length === 1 && safety.selector.persistedRows[0].mode === 'off', JSON.stringify({ setupReport, selector: safety?.selector }))

  run.check('Off and global-off entry semantics create no hidden database, Case, Route, Attempt, or Shadow sampling', safety?.off?.hook?.kind === 'pass' && safety.off.hook.why === 'bypass' && safety.off.consultError?.code === 'DECISION_OFF' && safety.off.databaseExists === false && safety.off.storeOpen === false && safety?.globalOff?.initial?.mode === 'off' && safety.globalOff.hook?.kind === 'pass' && safety.globalOff.consultError?.code === 'DECISION_OFF' && safety.globalOff.databaseExists === false && safety.globalOff.storeOpen === false && safetyWires('AUTO_SAFETY_OFF').length === 0 && safetyWires('AUTO_SAFETY_GLOBAL_OFF').length === 0, JSON.stringify({ off: safety?.off, globalOff: safety?.globalOff }))

  const excludedWireCount = ['APPROVAL', 'PLAN_REVIEW', 'CLASS_D', 'CLASS_E', 'CLASS_F', 'HIGH_RISK', 'EXECUTION', 'AUTO_CLASS_D', 'CONSULT_D', 'CONSULT_APPROVAL'].reduce((sum, marker) => sum + safetyWires(`AUTO_SAFETY_${marker}`).length, 0)
  run.check('approval, plan-review, D/E/F, high-risk, and execution-authority paths never sample Shadow or Auto', safety?.excluded?.hookResults?.length === 7 && safety.excluded.hookResults.every(result => result.kind === 'pass' && result.why === 'bypass') && JSON.stringify(safety.excluded.before) === JSON.stringify(safety.excluded.afterHooks) && safety.excluded.consults?.length === 2 && safety.excluded.consults.every(item => item.case?.awaitingReason === 'authority' && item.case?.attemptCount === 0 && item.routes?.length === 1 && item.routes[0].mode === 'pinned') && safety.excluded.autoHook?.why === 'bypass' && JSON.stringify(safety.excluded.beforeAuto) === JSON.stringify(safety.excluded.afterAuto) && safety.excluded.afterAuto.shadow === 0 && excludedWireCount === 0, JSON.stringify({ excluded: safety?.excluded, excludedWireCount }))

  const unknownSafety = safety?.admission?.unknown?.case
  const mixedSafety = safety?.admission?.mixed?.case
  run.check('unclassified unknown and mixed batches fail closed as one authority batch without Router or Attempts', unknownSafety?.awaitingReason === 'authority' && unknownSafety?.agentId === null && unknownSafety?.request?.questions?.[0]?.authorizationClass === 'unknown' && mixedSafety?.awaitingReason === 'authority' && mixedSafety?.request?.questions?.[0]?.authorizationClassSource === undefined && mixedSafety?.request?.questions?.[1]?.authorizationClass === 'D' && mixedSafety?.request?.questions?.[1]?.authorizationClassSource === 'auto_classifier' && safety?.admission?.final?.cases === 2 && safety.admission.final.routes === 2 && safety.admission.final.attempts === 0 && safetyWires('AUTO_SAFETY_UNKNOWN').filter(request => request.autoRouter.kind === 'classification').length === 1 && safetyWires('AUTO_SAFETY_MIXED').filter(request => request.autoRouter.kind === 'classification').length === 1 && safetyWires('AUTO_SAFETY_UNKNOWN').filter(request => request.autoRouter.kind === 'route').length === 0 && safetyWires('AUTO_SAFETY_MIXED').filter(request => request.autoRouter.kind === 'route').length === 0, JSON.stringify({ unknownSafety, mixedSafety, admission: safety?.admission?.final }))

  const isolationWire = safetyWires('AUTO_SAFETY_ISOLATION').find(request => request.autoRouter.kind === 'route')
  const isolationStore = readDecisionStore(run.ws, join(run.ws, '..', 'decision-stores', 'decision-auto-safety-isolation'))
  const isolationEvidenceIds = safety?.isolation?.attempts?.flatMap(attempt => attempt.packManifest?.evidenceIds ?? []) ?? []
  run.check('cross-workspace candidates and cross-Agent Evidence never enter Router or domain packs', safety?.isolation?.case?.agentId === safety?.isolation?.localAgents?.[0] && isolationWire && isolationWire.autoRouter.pack.candidates.map(candidate => candidate.agentId).sort().join(',') === safety.isolation.localAgents.slice().sort().join(',') && !JSON.stringify(isolationWire).includes(safety.isolation.foreignAgent) && !JSON.stringify(isolationWire).includes('FORBIDDEN FOREIGN ROUTER CANDIDATE') && !JSON.stringify(isolationWire).includes('FOREIGN WORKSPACE PRIVATE PROFILE BODY') && isolationEvidenceIds.length > 0 && isolationEvidenceIds.every(evidenceId => isolationStore.evidence.find(ref => ref.evidence_id === evidenceId)?.agent_id === safety.isolation.case.agentId), JSON.stringify({ isolation: safety?.isolation, wire: isolationWire, isolationEvidenceIds }))

  const shadowControl = safety?.shadow?.control
  const shadowObserved = safety?.shadow?.observed
  run.check('pinned Shadow on/off controls have identical real Case, answer, Evidence, Feedback, delivery, and Attempts with one append-only diagnostic', safety?.shadow?.parity === true && shadowControl?.routes?.map(route => route.mode).join(',') === 'pinned' && shadowObserved?.routes?.map(route => route.mode).join(',') === 'pinned,auto_shadow' && shadowObserved.routes[0].chosen !== shadowObserved.routes[1].chosen && shadowObserved.real?.case?.agentId === 'pinned' && shadowObserved.real?.case?.state === 'closed' && shadowObserved.real?.case?.closing === 'answered' && shadowObserved.counts?.shadow === 1 && shadowObserved.counts?.attempts === 1 && shadowControl.counts?.attempts === 1 && shadowObserved.replaySameAnswer === true && shadowObserved.appendOnly === true && shadowObserved.requestUnchanged === true, JSON.stringify({ parity: safety?.shadow?.parity, control: shadowControl, observed: shadowObserved }))

  const shadowFailures = safety?.shadow?.failures ?? []
  run.check('Shadow classification, Router, and write failures preserve the real pinned result without retry or late diagnostic duplication', shadowFailures.length === 3 && shadowFailures.every(item => item.equal === true && item.replaySameAnswer === true && item.appendOnly === true && item.requestUnchanged === true && item.counts?.attempts === 1 && item.counts?.cases === 1) && shadowFailures.find(item => item.failure === 'write')?.routes?.map(route => route.mode).join(',') === 'pinned' && shadowFailures.filter(item => item.failure !== 'write').every(item => item.routes?.map(route => route.mode).join(',') === 'pinned,auto_shadow' && item.routes[1].chosen === null && item.routes[1].reason === 'failure:invalid_output'), JSON.stringify(shadowFailures))

  const unowned = safety?.unowned
  run.check('unowned answer/cancel/retry/reassign preserve user authority, create no premature Evidence or Attempt, and retry only after ownership', unowned?.answer?.opened?.case?.agentId === null && unowned.answer.answered?.agentId === null && unowned.answer.answered?.closing === 'escalated' && unowned.answer.answered?.decision?.answers?.[0]?.selected?.[0] === 'Unowned user answer' && unowned.answer.reread?.userDecided === true && unowned.answer.reread?.evidence?.length === 0 && unowned.answer.evidence === 0 && unowned.cancel.cancelled?.closing === 'cancelled' && unowned.cancel.counts?.attempts === 0 && unowned.retry.error?.code === 'AGENT_UNAVAILABLE' && unowned.retry.unchanged === true && unowned.retry.counts?.attempts === 0 && unowned.reassign.current?.agentId !== null && unowned.reassign.current?.closing === 'answered' && unowned.reassign.routes?.map(route => route.mode).join(',') === 'auto,manual_reassign' && unowned.reassign.counts?.attempts === 1 && unowned.final?.cases === 4 && unowned.final?.routes === 5 && unowned.final?.attempts === 1, JSON.stringify(unowned))
  run.check('Auto retry rechecks persisted native exclusion and unowned reassignment rechecks the current whitelist', safety?.retryAuthority?.error?.code === 'AUTHORITY' && safety.retryAuthority.unchanged === true && safety.retryAuthority.counts?.routes === 1 && safety.retryAuthority.counts?.attempts === 1 && safety?.reassignAuthority?.error?.code === 'AUTHORITY' && safety.reassignAuthority.unchanged === true && safety.reassignAuthority.counts?.routes === 1 && safety.reassignAuthority.counts?.attempts === 0, JSON.stringify({ retry: safety?.retryAuthority, reassign: safety?.reassignAuthority }))

  const flush = safety?.flush
  run.check('flush aborts and awaits real routing, persists no answer or Attempt, and leaves no late writes or jobs', flush?.before?.cases === 1 && flush.before.routes === 0 && flush.before.attempts === 0 && flush.received?.length === 1 && flush.received[0].state === 'received' && flush.received[0].agent_id === null && flush.result?.outcome === 'awaiting_user' && flush.result?.reason === 'no_route' && flush.after?.cases?.length === 1 && flush.after.cases[0].state === 'awaiting_user' && flush.after.cases[0].awaiting_reason === 'no_route' && flush.after.cases[0].agent_id === null && flush.after.cases[0].decision_json === null && flush.after.routes?.length === 1 && flush.after.routes[0].reason === 'failure:aborted' && flush.after.attempts?.length === 0 && flush.lateStable === true && flush.settled === true && flush.flights === 0 && flush.controllers === 0 && flush.jobs === 0 && flush.active === 0, JSON.stringify(flush))

  const auditPath = join(run.ws, '.weir', 'audit.jsonl')
  const audit = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : ''
  const auditEvents = JSON.stringify(run.events.filter(event => event.type?.startsWith('weir/decision/')))
  const combinedAudit = `${audit}\n${auditEvents}`
  const safetyCases = [unknownSafety, mixedSafety, safety?.isolation?.case,
    ...(safety?.excluded?.consults?.map(item => item.case) ?? []),
    unowned?.answer?.opened?.case, unowned?.cancel?.opened?.case, unowned?.retry?.opened?.case, unowned?.reassign?.opened?.case,
  ].filter(Boolean)
  const shadowRequests = [shadowControl, shadowObserved, ...shadowFailures].flatMap(item => item?.real?.case?.request?.questions?.map(question => question.question) ?? [])
  const sensitive = [
    'AUTO_SAFETY_FLUSH: abort and await this route',
    ...store.cases.flatMap(item => item.request.questions?.map(question => question.question) ?? []),
    ...safetyCases.flatMap(item => item.request?.questions?.map(question => question.question) ?? []), ...shadowRequests,
    'Auto A private profile body', 'Auto B private profile body', 'AUTO_REPLAY context secret',
    'AUTO_SAFETY_OFF: choose the safe fixture', 'AUTO_SAFETY_GLOBAL_OFF: choose the safe fixture',
    'FORBIDDEN FOREIGN ROUTER CANDIDATE', 'FOREIGN WORKSPACE PRIVATE PROFILE BODY',
  ]
  run.check('Decision audit contains ids/counts/reasons but no question, context, or profile bodies', auditEvents.includes('weir/decision/attempt') && auditEvents.includes('weir/decision/outcome') && sensitive.every(body => typeof body === 'string' && body.length > 0 && !combinedAudit.includes(body)), JSON.stringify({ auditPath, auditBytes: audit.length, auditEvents: run.events.filter(event => event.type?.startsWith('weir/decision/')).length, leaked: sensitive.filter(body => combinedAudit.includes(body)) }))
  run.check('decision-auto-route real headless run exits cleanly', (run.code === 0 || run.code === null) && run.stdout.includes('DECISION_AUTO_ROUTE_DONE') && !run.stdout.includes('DECISION_AUTO_ROUTE_FAILED'), `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default {
  id, prompt, decide, decideDecision, decideRouterClassification, decideRouterRoute, observe, assert,
  env: {
    WEIR_IT_DECISION: '1', WEIR_IT_DECISION_EVENTS: DECISION_EVENTS, WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id),
    WEIR_IT_DECISION_AUTO_CLASSES: '["A","B","C"]', WEIR_IT_DECISION_SELECTOR_DEFAULT: 'auto', WEIR_IT_DECISION_TIMEOUT_MS: '100', WEIR_IT_DECISION_MAX_ATTEMPTS: '16',
  },
}
