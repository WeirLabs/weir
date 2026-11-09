// P4 Active Auto: real stock Hook/consult routing through the live Decision Broker.
import { decisionPack, decisionStoreDirectory, observeDecision } from '../decision-test-kit.js'
import { textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'decision-auto-route'
const prompt = 'decision-auto-route-probe'
const SELECTED = {
  id: 'decision-auto-selected',
  question: 'AUTO_SELECTED: choose the evidenced route',
  options: [{ label: 'Selected A' }, { label: 'Other' }],
}

function decide(options, obs) {
  const history = obs.transcript
  if (!history.includes('DECISION_TEST done auto-setup')) {
    return toolCallChunks('decision_integration_probe', { op: 'auto-setup' })
  }
  if (!history.includes(SELECTED.id)) return toolCallChunks('ask_user_question', { questions: [SELECTED] })
  return textChunks('DECISION_AUTO_ROUTE_DONE')
}

function classify(pack) {
  return pack.questions.map(question => ({
    id: question.id,
    authorizationClass: question.question?.startsWith('AUTO_ZERO') ? 'C'
      : /^(?:AUTO_ONE|AUTO_SINGLEFLIGHT|AUTO_REPLAY|AUTO_CONSULT)/.test(question.question ?? '') ? 'B' : 'A',
  }))
}

function decideRouterClassification(options, obs) {
  const pack = decisionPack(obs)
  if (!pack || !Array.isArray(pack.questions)) throw new Error('decision-auto-route: malformed classification pack')
  return textChunks(JSON.stringify({ contract: 'router-classification-contract/1', classes: classify(pack) }))
}

function decideRouterRoute(options, obs) {
  const pack = decisionPack(obs)
  const question = pack?.questions?.[0]?.question ?? ''
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
  const selected = pack?.candidates?.find(candidate => candidate.name?.endsWith(' A')) ?? pack?.candidates?.[0]
  if (!selected) throw new Error('decision-auto-route: selected fixture requires an eligible candidate')
  return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'selected', agentId: selected.agentId, reason: 'Auto A owns this evidenced fixture' }))
}

function decideDecision(options, obs) {
  const pack = decisionPack(obs)
  const question = pack?.L4?.request?.questions?.[0]
  const evidenceId = pack?.L5?.find(evidence => evidence.source === 'user_profile')?.evidenceId
  if (!question || !evidenceId) return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['The Auto fixture requires selected Agent evidence'] }))
  return textChunks(JSON.stringify({
    outcome: 'answer',
    claims: [{ text: 'The selected Auto Agent profile supports this answer.', evidenceIds: [evidenceId] }],
    answers: [{ id: question.id, selected: [question.options?.[0]?.label ?? 'Selected A'] }],
  }))
}

function observe(obs) {
  const base = observeDecision(obs)
  const contract = obs.system.split('\n', 1)[0]
  const classification = contract === 'Auto request classification contract: router-classification-contract/1'
  const routing = contract === 'Auto candidate router contract: router-contract/1'
  if (!classification && !routing) return base
  const pack = decisionPack(obs)
  return {
    ...base,
    autoRouter: {
      kind: classification ? 'classification' : 'route', pack,
      tools: obs.toolNames, hasTemperature: obs.hasTemperature,
      provider: obs.provider, model: obs.model, maxTokens: obs.maxTokens,
    },
    ...(pack?.questions?.[0]?.question?.startsWith('AUTO_TIMEOUT') ? { autoRouterHold: 'timeout' } : {}),
  }
}

function assert(run) {
  run.check('decision-auto-route scenario boots through the real runtime', (run.code === 0 || run.code === null) && run.stdout.includes('DECISION_AUTO_ROUTE_DONE'), `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default {
  id, prompt, decide, decideDecision, decideRouterClassification, decideRouterRoute, observe, assert,
  env: { WEIR_IT_DECISION: '1', WEIR_IT_DECISION_STORE_PATH: decisionStoreDirectory(id) },
}
