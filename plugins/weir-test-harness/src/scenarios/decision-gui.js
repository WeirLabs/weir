// Opt-in real-Desktop Decision QA brain. It only emits product tool calls.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { decisionPack, observeDecision } from '../decision-test-kit.js'

const id = 'decision-gui'
const prompt = 'decision-gui-probe'
const LONG_QUESTIONS = [
  { id: 'product-long-choice', question: '长中文题面：请在保留既有证据、权限与人工审批边界的前提下选择后续判断方式；English continuation with an intentionally long question that must wrap naturally without pushing the primary action outside the reachable viewport.', multi_select: true, options: [
    { label: '采用这个同时包含中文与 English and deliberately extended wording 的长选项，以验证换行、复选状态与读屏名称。', description: '长选项说明 / Long option description remains readable at every viewport.' },
    { label: '另一个长选项 / Another intentionally long option' },
  ] },
  { id: 'product-long-text', question: '请补充一段中英文混合的自由文本判断理由 / Provide a multilingual free-text rationale that must remain editable before submission.' },
]
const QUESTIONS = {
  GUI_A_ANSWER: { id: 'gui-a-answer', question: 'Choose the evidenced GUI title', options: [{ label: 'Native fallback' }, { label: 'Concise' }] },
  GUI_A_OFF: { id: 'gui-a-off', question: 'Choose while the selector is Off', options: [{ label: 'Native Off' }, { label: 'Automatic' }] },
  GUI_B_NEW: { id: 'gui-b-new', question: 'Choose a genuinely new GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_REUSE: { id: 'gui-b-reuse', question: 'Reuse the same GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_AFTER_DOWN: { id: 'gui-b-after-down', question: 'Reuse the disputed GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_AFTER_UNDO: { id: 'gui-b-after-undo', question: 'Reuse the restored GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_AFTER_COMMENT: { id: 'gui-b-after-comment', question: 'Reuse after a neutral GUI comment', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_B_CORRECTED: { id: 'gui-b-corrected', question: 'Apply the corrected GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] },
  GUI_C_OFF: { id: 'gui-c-off', question: 'Choose in a fresh Off profile', options: [{ label: 'Native Off' }, { label: 'Automatic' }] },
  GUI_C_APPROVAL: { id: 'gui-c-approval', question: 'Approve the GUI operation?', options: [{ label: 'Approve' }, { label: 'Reject' }], intent: { kind: 'approval' } },
  GUI_C_PLAN: { id: 'gui-c-plan', question: 'Review the GUI plan?', options: [{ label: 'Accept' }, { label: 'Revise' }], intent: { kind: 'plan-review' } },
  GUI_MEMORY_SOURCE: { id: 'gui-memory-source', question: 'Choose the neutral GUI memory source', options: [{ label: 'Source native' }, { label: 'Neutral GUI answer' }] },
  GUI_MEMORY_REUSE: { id: 'gui-memory-reuse', question: 'Reuse neutral GUI memory without decisive evidence', options: [{ label: 'User resolves GUI memory' }, { label: 'Neutral GUI answer' }] },
  GUI_LEARNING_SOURCE: { id: 'gui-learning-source', question: 'Choose the authoritative GUI learning source', options: [{ label: 'User backed GUI answer' }, { label: 'Other GUI answer' }] },
  GUI_LEARNING_AFTER_V1: { id: 'gui-learning-after-v1', question: 'Use the first published GUI Snapshot', options: [{ label: 'Learned GUI answer' }, { label: 'Other GUI answer' }] },
  GUI_LEARNING_AFTER_V2: { id: 'gui-learning-after-v2', question: 'Use the successor GUI Snapshot', options: [{ label: 'Learned GUI answer' }, { label: 'Other GUI answer' }] },
  GUI_LEARNING_AFTER_ROLLBACK: { id: 'gui-learning-after-rollback', question: 'Use the predecessor GUI Snapshot after rollback', options: [{ label: 'Learned GUI answer' }, { label: 'Other GUI answer' }] },
  GUI_LEARNING_AFTER_EMPTY: { id: 'gui-learning-after-empty', question: 'Answer after all GUI Snapshots roll back', options: [{ label: 'Learned GUI answer' }, { label: 'Other GUI answer' }] },
  GUI_AUTO_SELECTED: { id: 'gui-auto-selected', question: 'GUI_AUTO_SELECTED: choose an eligible assistant', options: [{ label: 'Auto answer' }, { label: 'Other' }] },
  GUI_AUTO_NONE: { id: 'gui-auto-none', question: 'GUI_AUTO_NONE: no candidate matches', options: [{ label: 'Native none' }, { label: 'Other' }] },
  GUI_AUTO_AMBIGUOUS: { id: 'gui-auto-ambiguous', question: 'GUI_AUTO_AMBIGUOUS: candidates overlap', options: [{ label: 'Native ambiguity' }, { label: 'Other' }] },
  GUI_AUTO_INVALID: { id: 'gui-auto-invalid', question: 'GUI_AUTO_INVALID: reject invalid Router output', options: [{ label: 'Native invalid' }, { label: 'Other' }] },
  GUI_AUTO_TIMEOUT: { id: 'gui-auto-timeout', question: 'GUI_AUTO_TIMEOUT: hold the Router stream', options: [{ label: 'Native timeout' }, { label: 'Other' }] },
  GUI_AUTO_EMPTY: { id: 'gui-auto-empty', question: 'GUI_AUTO_EMPTY: empty whitelist retains authority', options: [{ label: 'Native empty' }, { label: 'Other' }] },
  GUI_AUTO_ZERO: { id: 'gui-auto-zero', question: 'GUI_AUTO_ZERO: zero eligible candidates', options: [{ label: 'Native zero' }, { label: 'Other' }] },
  GUI_AUTO_ONE: { id: 'gui-auto-one', question: 'GUI_AUTO_ONE: one eligible candidate', options: [{ label: 'Auto one' }, { label: 'Other' }] },
  GUI_AUTO_PENDING: { id: 'gui-auto-pending', question: 'GUI_AUTO_PENDING: pending survives restart', options: [{ label: 'Pending user answer' }, { label: 'Other' }] },
  GUI_AUTO_INTERRUPT: { id: 'gui-auto-interrupt', question: 'GUI_AUTO_INTERRUPT: interrupt before routing commits', options: [{ label: 'Interrupted user answer' }, { label: 'Other' }] },
  GUI_AUTO_HIGH_RISK: { id: 'gui-auto-high-risk', question: 'Execute this irreversible high-risk isolated operation?', options: [{ label: 'Approve high risk' }, { label: 'Reject' }] },
  GUI_AUTO_EXECUTION: { id: 'gui-auto-execution', question: 'GUI_AUTO_EXECUTION: execute this command and grant permission for the isolated operation?', options: [{ label: 'Grant execution' }, { label: 'Reject' }] },
  GUI_SHADOW_PARITY: { id: 'gui-shadow-parity', question: 'GUI_SHADOW_PARITY: identical pinned control and observed outcome', options: [{ label: 'Pinned parity answer' }, { label: 'Other' }] },
}
for (let index = 1; index <= 21; index += 1) {
  const suffix = String(index).padStart(2, '0')
  QUESTIONS[`GUI_AUTO_PAGE_${suffix}`] = { id: `gui-auto-page-${suffix}`, question: `GUI_AUTO_PAGE_${suffix}: real routing pagination item`, options: [{ label: `Page answer ${suffix}` }, { label: 'Other' }] }
}

// Task 7.3 cross-workspace matrix markers. The Desktop driver submits these
// three prompts verbatim (gui-qa submitMarker) and the stock host only opens a
// Case from a real ask_user_question, so each marker needs its own question with
// answerable options. They are appended after the GUI_* table so no existing
// marker answer changes.
const CROSS_QUESTIONS = {
  CROSS_W1_Q: { id: 'cross-w1-source', question: 'CROSS_W1_Q: choose the documented option this workspace records', options: [{ label: 'Documented option' }, { label: 'Other' }] },
  CROSS_W2_Q: { id: 'cross-w2-source', question: 'CROSS_W2_Q: choose the documented option this workspace records', options: [{ label: 'Documented option' }, { label: 'Other' }] },
  CROSS_AUTO_Q: { id: 'cross-auto-question', question: 'CROSS_AUTO_Q: confirm the documented option for the Auto decision', options: [{ label: 'Documented option' }, { label: 'Other' }] },
}
Object.assign(QUESTIONS, CROSS_QUESTIONS)
// The public zone is workspace-agnostic, so one shared principle text is enough
// to prove extraction, replay and adoption without naming a workspace.
const PUBLIC_PRINCIPLE_TEXT = 'Prefer the documented option both workspaces agreed on.'
// A refine must read differently from the wording it replaces: the Desktop review
// leg compares the refined candidate against the still-published text, and an
// identical wording would make a stale render indistinguishable from the refine.
const PUBLIC_REFINED_PRINCIPLE_TEXT = 'Prefer the documented option both workspaces agreed on, and restate that agreed wording before acting on it.'
const GUI_LEARNING_QUESTION_IDS = Object.values(QUESTIONS).map(question => question.id).filter(id => id.startsWith('gui-learning-'))

function consultArgs(marker) {
  return { question: `${marker}: needs a new user judgment`, options: [{ label: 'User choice' }, { label: 'Other' }], request_id: marker.toLowerCase() }
}

/**
 * Public consolidation: emit exactly one workspace-agnostic operation whose
 * sources are the packet's frozen source ids. The product's parser and
 * structural replay (parseConsolidationCandidate / replayOperations) reject any
 * path, foreign record id or workspace scope, so nothing else is emitted.
 * @param {any} obs
 */
function publicConsolidation(obs) {
  let projection
  try { projection = JSON.parse(obs.lastUser) } catch { projection = null }
  const sources = (projection?.sources ?? []).map(source => source.sourceId).filter(id => typeof id === 'string' && id.length > 0)
  if (sources.length === 0) return textChunks(JSON.stringify({ operations: [] }))
  const parent = projection?.parentSnapshot?.principles?.find(principle => principle?.state === 'active') ?? projection?.parentSnapshot?.principles?.[0]
  if (parent?.principleId) {
    return textChunks(JSON.stringify({ operations: [{ op: 'refine', principleId: parent.principleId, text: PUBLIC_REFINED_PRINCIPLE_TEXT, sources }] }))
  }
  return textChunks(JSON.stringify({ operations: [{ op: 'add', principleId: 'public-principle', text: PUBLIC_PRINCIPLE_TEXT, scope: {}, sources }] }))
}

function decide(options, obs) {
  // The public consolidation contract reaches this brain through the generic
  // dispatcher (mock-llm only special-cases the private consolidation contract).
  if (obs.system.startsWith('Decision public consolidation contract v1')) return publicConsolidation(obs)
  const messages = options.messages ?? []
  if (messages.at(-1)?.role === 'tool') return textChunks('GUI_SCENARIO_DONE')
  const lastTool = messages.findLastIndex(message => message.role === 'tool')
  const history = JSON.stringify(messages.slice(lastTool + 1))
  const markers = Object.keys(QUESTIONS)
  const marker = markers.find(key => history.includes(key))
  if (history.includes('GUI_LONG_NATIVE')) return toolCallChunks('ask_user_question', { questions: LONG_QUESTIONS })
  if (marker) return toolCallChunks('ask_user_question', { questions: [QUESTIONS[marker]] })
  const action = ['GUI_B_DECIDE', 'GUI_B_REASSIGN', 'GUI_B_CANCEL', 'GUI_B_RETRY', 'GUI_C_RETURN', 'GUI_AUTO_EXPLICIT'].find(key => history.includes(key))
  if (action) {
    const args = consultArgs(action)
    if (action === 'GUI_AUTO_EXPLICIT') {
      const control = JSON.parse(readFileSync(join(process.env.WEIR_DECISION_GUI_OUT, 'auto-control.json'), 'utf8'))
      args.agent_id = control.explicitAgentId
      args.authorization_class = 'A'
    }
    return toolCallChunks('decision_consult', args)
  }
  return textChunks('unhandled Decision GUI turn')
}

function decideConsolidation(options, obs) {
  const projection = JSON.parse(obs.lastUser)
  const source = projection.cases.find(item => item.excerpt?.includes('Question gui-learning-source:'))?.caseId
  const rejecting = projection.cases.some(item => item.excerpt?.includes('Question gui-learning-after-empty:'))
  const correction = (projection.feedback ?? []).find(item => item.kind === 'correction')
  const successor = Boolean(projection.parentSnapshot)
  const text = rejecting
    ? 'Rejected GUI candidate: this principle must never become current.'
    : successor
      ? 'Reviewed GUI successor principle: prefer the second source-backed answer.'
      : correction
        ? 'Reviewed GUI correction principle: prefer the corrected cross-root answer.'
        : 'Reviewed GUI principle: prefer the source-backed answer.'
  return textChunks(JSON.stringify({ operations: [{
    op: 'add', principleId: 'temporary-gui-learning', text,
    scope: { workspaces: [projection.workspaceKey] }, sources: correction ? [correction.feedbackId] : source ? [source] : [],
  }] }))
}
function decideDecision(options, obs) {
  const pack = JSON.parse(obs.lastUser)
  const question = pack.L4.request.questions[0]
  if (GUI_LEARNING_QUESTION_IDS.includes(question.id) && question.id !== 'gui-learning-source') {
    const principles = Array.isArray(pack.L2) ? pack.L2 : []
    const principle = question.id === 'gui-learning-after-v2'
      ? principles.find(item => item.text?.includes('successor'))
      : principles[0]
    const mapped = principle?.evidenceIds?.[0]
    const fallback = question.id === 'gui-learning-after-empty'
      ? pack.L5.find(ref => ref.source === 'user_decision')?.evidenceId
      : undefined
    const evidenceId = mapped ?? fallback
    if (evidenceId && pack.L5.some(ref => ref.evidenceId === evidenceId)) {
      return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: `${question.id} uses actual L5 provenance.`, evidenceIds: [evidenceId] }], answers: [{ id: question.id, selected: [question.options[0].label] }] }))
    }
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'A reviewed principle must map to actual L5 evidence.' }))
  }
  if (question.id === 'gui-memory-source') {
    const ref = pack.L5.find(evidence => evidence.source === 'user_profile')
    if (ref) return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Neutral GUI answer is supported by the user profile.', evidenceIds: [ref.evidenceId] }], answers: [{ id: question.id, selected: ['Neutral GUI answer'] }] }))
  }
  if (question.id === 'gui-memory-reuse') {
    const episode = Array.isArray(pack.L3) ? pack.L3[0] : undefined
    if (episode) return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Deliberately treat neutral GUI history as evidence.', evidenceIds: [episode.sourceCaseId] }], answers: [{ id: question.id, selected: ['Neutral GUI answer'] }] }))
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'The actual neutral GUI source episode is required for this negative fixture.' }))
  }
  if (question.id === 'gui-a-answer') {
    const ref = pack.L5[0]
    if (ref) return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'Concise is supported by the supplied evidence.', evidenceIds: [ref.evidenceId] }], answers: [{ id: question.id, selected: ['Concise'] }] }))
  }
  if (question.id?.startsWith('gui-b-') && question.id !== 'gui-b-new') {
    const correction = pack.L5.find(evidence => evidence.source === 'user_correction')
    const decision = pack.L5.find(evidence => evidence.source === 'user_decision')
    const ref = correction ?? decision
    const selected = ref ? ['Use Long', 'Use Short'].find(choice => ref.excerpt?.includes(choice)) : undefined
    if (ref && selected) {
      return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: `${selected} uses the current ${ref.source}.`, evidenceIds: [ref.evidenceId] }], answers: [{ id: question.id, selected: [selected] }] }))
    }
  }
  if (question.question?.includes('GUI_C_RETURN')) {
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add the missing GUI scope and retry the consultation.' }))
  }
  const autoAnswer = /^(?:GUI_AUTO_(?:SELECTED|ONE|AMBIGUOUS|EXPLICIT|PAGE_\d+)|GUI_SHADOW_PARITY)/.test(question.question ?? '')
  if (autoAnswer) {
    const ref = pack.L5.find(evidence => evidence.source === 'user_profile')
    if (ref) return textChunks(JSON.stringify({ outcome: 'answer', claims: [{ text: 'The actual routed Agent profile supports this isolated answer.', evidenceIds: [ref.evidenceId] }], answers: [{ id: question.id, selected: [question.options[0].label] }] }))
  }
  return textChunks(JSON.stringify({ outcome: 'escalate', missing: [`${question.question} requires a new user judgment`] }))
}

function decideRouterClassification(options, obs) {
  const pack = decisionPack(obs)
  if (!pack || !Array.isArray(pack.questions)) throw new Error('decision-gui: malformed classification pack')
  return textChunks(JSON.stringify({
    contract: 'router-classification-contract/1',
    classes: pack.questions.map(question => ({ id: question.id, authorizationClass: 'A' })),
  }))
}

function decideRouterRoute(options, obs) {
  const pack = decisionPack(obs)
  const question = pack?.questions?.[0]?.question ?? ''
  if (question.startsWith('GUI_AUTO_TIMEOUT')) return []
  if (question.startsWith('GUI_AUTO_NONE')) return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'none', reason: 'No eligible GUI candidate matches this request' }))
  if (question.startsWith('GUI_AUTO_PENDING')) return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'none', reason: 'Pending restart fixture deliberately has no owner' }))
  if (question.startsWith('GUI_AUTO_AMBIGUOUS')) {
    return textChunks(JSON.stringify({
      contract: 'router-contract/1', outcome: 'ambiguous', reason: 'Eligible GUI candidates have overlapping authority',
      ambiguity: { candidates: pack?.candidates?.map(candidate => candidate.agentId) ?? [], conflict: 'Both GUI candidates claim the same isolated fixture' },
    }))
  }
  if (question.startsWith('GUI_AUTO_INVALID')) return textChunks('{"contract":"router-contract/1","outcome":"selected","agentId":"ag_not_eligible","reason":"Unknown candidate must be rejected"}')
  // The cross-workspace matrix has no classless GUI fixture: Auto must stay able
  // to pick the one shared assistant instead of failing the route brain.
  if (question.startsWith('CROSS_')) {
    const shared = pack?.candidates?.find(candidate => /Shared memory assistant/.test(candidate.name ?? '')) ?? pack?.candidates?.[0]
    if (!shared) return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'none', reason: 'No eligible candidate can serve the cross-workspace request' }))
    return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'selected', agentId: shared.agentId, reason: 'The shared memory assistant owns this cross-workspace request' }))
  }
  const intendedName = question.startsWith('GUI_SHADOW_PARITY') ? /Empty review assistant|Secondary/ : /Decision Product QA|Primary/
  const selected = pack?.candidates?.find(candidate => intendedName.test(candidate.name ?? ''))
  if (!selected) throw new Error('decision-gui: selected fixture requires an eligible candidate')
  return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'selected', agentId: selected.agentId, reason: 'The intended GUI candidate owns this fixture' }))
}

function assert(run) {
  run.check('GUI scenario is opt-in and only produces product tool calls', true, 'Real Desktop assertions live in .weir/decision-qa/gui-*')
}

function observe(obs) {
  const observation = observeDecision(obs)
  const contract = obs.system.split('\n', 1)[0]
  if (contract === 'Auto request classification contract: router-classification-contract/1' || contract === 'Auto candidate router contract: router-contract/1') {
    const kind = contract.startsWith('Auto request') ? 'classification' : 'route'
    const pack = decisionPack(obs)
    const question = pack?.questions?.[0]?.question ?? ''
    return {
      ...observation,
      autoRouter: {
        kind, pack, system: obs.system, sessionId: obs.sessionId ?? null,
        tools: obs.toolNames, hasTemperature: obs.hasTemperature,
        provider: obs.provider, model: obs.model, maxTokens: obs.maxTokens,
      },
      ...(kind === 'route' && question.startsWith('GUI_AUTO_TIMEOUT') ? { autoRouterHold: 'timeout' } : {}),
      ...(kind === 'classification' && question.startsWith('GUI_AUTO_INTERRUPT') ? { autoRouterHold: 'interruption' } : {}),
    }
  }
  const learning = contract === 'Decision consolidation contract v1' || observation.decisionQuestionIds.some(id => GUI_LEARNING_QUESTION_IDS.includes(id))
  if (learning) {
    let pack
    if (observation.decisionEvaluator) { try { pack = JSON.parse(obs.lastUser) } catch { pack = undefined } }
    return { ...observation, decisionGuiLearning: {
      kind: contract === 'Decision consolidation contract v1' ? 'consolidation' : 'evaluator',
      system: obs.system, content: obs.lastUser, tools: obs.toolNames,
      hasTemperature: obs.hasTemperature, provider: obs.provider, model: obs.model, maxTokens: obs.maxTokens,
      ...(pack ? { pack } : {}),
    } }
  }
  if (!observation.decisionEvaluator || !observation.decisionQuestionIds.some(id => ['gui-memory-source', 'gui-memory-reuse'].includes(id))) return observation
  let pack
  try { pack = JSON.parse(obs.lastUser) } catch { return observation }
  return { ...observation, decisionGuiMemorySystem: obs.system, decisionGuiMemoryPack: pack }
}

export default { id, prompt, decide, decideConsolidation, decideDecision, decideRouterClassification, decideRouterRoute, observe, assert }
