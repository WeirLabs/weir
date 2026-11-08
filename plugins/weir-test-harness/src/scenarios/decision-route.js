// P1 routing: pinned evaluation, unavailable-pin no_route, and one-shot explicit Agent consultation.
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { DECISION_EVENTS, decisionStoreDirectory, observeDecision, readDecisionEvents, readDecisionStore } from '../decision-test-kit.js'

const id = 'decision-route'
const prompt = 'decision-route-probe'
const PINNED = { id: 'decision-route-pinned', question: 'Choose the evidenced pinned route', options: [{ label: 'Pinned A' }, { label: 'Wrong route' }] }
const NO_ROUTE = { id: 'decision-route-no-route', question: 'Choose while the pinned Agent is disabled', options: [{ label: 'Native judgment' }, { label: 'Silent fallback' }] }
const EXPLICIT = { question: 'ROUTE_EXPLICIT: choose the one-shot explicit route', options: [{ label: 'Explicit B' }, { label: 'Pinned A' }], request_id: 'route-explicit' }

function decide(options, obs) {
  const history = obs.transcript
  if (history.includes('DECISION_TEST error')) return textChunks('DECISION_ROUTE_FAILED')
  if (!history.includes('DECISION_TEST done route-setup')) return toolCallChunks('decision_integration_probe', { op: 'route-setup' })
  if (!history.includes(PINNED.id)) return toolCallChunks('ask_user_question', { questions: [PINNED] })
  if (!history.includes('DECISION_TEST done disable-a')) {
    const agentId = /"agentA":"([^"]+)"/.exec(history)?.[1]
    if (!agentId) return textChunks('DECISION_ROUTE_FAILED')
    return toolCallChunks('decision_integration_probe', { op: 'disable-a', agentId })
  }
  if (!history.includes(NO_ROUTE.id)) return toolCallChunks('ask_user_question', { questions: [NO_ROUTE] })
  if (!history.includes('"outcome":"answered"')) {
    const agentId = /"agentB":"([^"]+)"/.exec(history)?.[1]
    if (!agentId) return textChunks('DECISION_ROUTE_FAILED')
    return toolCallChunks('decision_consult', { ...EXPLICIT, agent_id: agentId })
  }
  return textChunks('DECISION_ROUTE_DONE')
}

function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const question = pack.L4.request.questions[0]
  const evidenceId = pack.L5.find(evidence => evidence.source === 'user_profile')?.evidenceId
  if (!evidenceId) return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['Route profile evidence is absent'] }))
  if (question.id === PINNED.id || question.question.startsWith('ROUTE_EXPLICIT')) {
    const selected = question.id === PINNED.id ? 'Pinned A' : 'Explicit B'
    return textChunks(JSON.stringify({
      outcome: 'answer', claims: [{ text: `${selected} is supported by the selected Agent profile.`, evidenceIds: [evidenceId] }],
      answers: [{ id: question.id, selected: [selected] }],
    }))
  }
  return textChunks('disabled pinned Agents must not reach the evaluator')
}

function assert(run) {
  const store = readDecisionStore(run.ws, decisionStoreDirectory(id))
  const events = readDecisionEvents()
  const caseFor = marker => store.cases.find(item => item.request.questions?.[0]?.id === marker || item.request.questions?.[0]?.question?.startsWith(marker))
  const pinned = caseFor(PINNED.id)
  const noRoute = caseFor(NO_ROUTE.id)
  const explicit = caseFor('ROUTE_EXPLICIT')
  const routeFor = item => store.routes.find(route => route.case_id === item?.case_id)
  const snapshot = events.find(event => event.questionIds?.includes(NO_ROUTE.id))?.caseSnapshot?.case
  const selector = store.selectors.find(row => row.root_session_id === pinned?.root_session_id)

  run.check('enabled pinned A produces a pinned RouteDecision and answer', pinned?.closing === 'answered' && pinned?.agent_id === routeFor(pinned)?.chosen && routeFor(pinned)?.mode === 'pinned', JSON.stringify({ pinned, route: routeFor(pinned) }))
  run.check('disabled pinned A yields no_route without using B or starting an Attempt', snapshot?.state === 'awaiting_user' && snapshot?.awaitingReason === 'no_route' && noRoute?.agent_id === pinned?.agent_id && noRoute?.agent_id !== explicit?.agent_id && noRoute?.attempt_count === 0 && routeFor(noRoute)?.mode === 'none' && !run.requests.some(request => request.decisionQuestionIds?.includes(NO_ROUTE.id)), JSON.stringify({ snapshot, noRoute, route: routeFor(noRoute) }))
  run.check('explicit agent_id consults B once with an explicit RouteDecision', explicit?.closing === 'answered' && explicit?.entry === 'consult' && explicit?.agent_id !== pinned?.agent_id && routeFor(explicit)?.mode === 'explicit' && routeFor(explicit)?.chosen === explicit?.agent_id && store.attempts.filter(attempt => attempt.case_id === explicit?.case_id).length === 1, JSON.stringify({ explicit, route: routeFor(explicit) }))
  run.check('selector remains pinned to A after disable and explicit B consultation', selector?.mode === 'agent' && selector.agent_id === pinned?.agent_id && selector.agent_id !== explicit?.agent_id && store.cases.length === 3 && store.routes.length === 3, JSON.stringify({ selector, pinnedAgent: pinned?.agent_id, explicitAgent: explicit?.agent_id }))
  run.check('headless Decision route run exited cleanly', (run.code === 0 || run.code === null) && run.stdout.includes('DECISION_ROUTE_DONE'), `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default {
  id, prompt, decide, decideDecision, observe: observeDecision, assert,
  env: { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_EVENTS: DECISION_EVENTS, WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id) },
}
