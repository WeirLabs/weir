import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

function makeReact() {
  const hooks = []
  let cursor = 0
  const react = {
    cloneElement: (element, props) => ({ ...element, ...props }),
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: initial }
      const set = value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value }
      return [hooks[index].value, set]
    },
    useRef(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(fn, dependencies) {
      const index = cursor++
      const previous = hooks[index]
      const changed = !previous || !dependencies || !previous.dependencies
        || dependencies.length !== previous.dependencies.length
        || dependencies.some((value, dependency) => !Object.is(value, previous.dependencies[dependency]))
      const hook = previous ?? {}
      hook.dependencies = dependencies ? [...dependencies] : undefined
      hooks[index] = hook
      if (changed) {
        hook.cleanup?.()
        hook.cleanup = fn()
      }
    },
    useId() {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { id: `id-${index}` }
      return hooks[index].id
    },
  }
  return {
    react,
    begin: () => { cursor = 0 },
    unmount: () => {
      for (const hook of hooks) hook?.cleanup?.()
      hooks.length = 0
    },
  }
}

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) findAll(item, predicate, found)
    else if (value && typeof value === 'object') findAll(value, predicate, found)
  }
  return found
}

function textContent(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).filter(Boolean).join(' ')
  if (!node || typeof node !== 'object') return ''
  return textContent(node.children)
}

const agents = [
  { agentId: 'a', name: 'Tone', state: 'enabled' },
  { agentId: 'b', name: 'Second assistant', state: 'enabled' },
]

const answeredDetail = {
  case: {
    caseId: 'dc-current', agentId: 'a', state: 'closed', closing: 'answered', revision: 7, feedbackState: 'none',
    request: { questions: [{ id: 'q-title', question: 'Which title should we use?', options: [{ label: 'Concise title' }, { label: 'Long title' }] }] },
    scope: { workspaces: ['/repo'], paths: ['docs'] },
    decision: { attemptId: 'da-new', answers: [{ id: 'q-title', selected: ['Concise title'] }], hint: 'Use concise wording' },
  },
  attempts: [
    { attemptId: 'da-old', attemptNo: 1, outcome: 'return', reasonCode: 'MISSING_CONTEXT', claims: [{ text: 'Old rationale' }], evidence: [{ evidenceId: 'ev-old', excerpt: 'old evidence' }] },
    { attemptId: 'da-new', attemptNo: 2, outcome: 'answer', claims: [{ text: 'Use concise wording', evidenceIds: ['ev-new'] }], evidence: [{ evidenceId: 'ev-new', source: 'user_decision', excerpt: 'current evidence', locator: { kind: 'case', caseId: 'source' } }] },
  ],
  feedback: [], routeDecisions: [],
}

async function setup() {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const actions = (await loadClientChunk('lib/client.decision-actions.js')).exports
  const runtime = makeReact()
  const jsx = (type, props) => ({ ...props, __type: type, type: props?.type ?? type })
  const card = (await loadClientChunk('lib/client.decision-card.js', name => name === 'react' ? runtime.react : { jsx, jsxs: jsx })).exports
  const ui = Object.fromEntries(['DecisionStyles', 'DecisionIcon', 'Button', 'Badge', 'Field', 'LoadingState', 'EmptyState', 'ErrorState', 'Disclosure', 'ConfirmDialog', 'DecisionAnswers', 'DecisionRouteHistory'].map(name => [name, `ui.${name}`]))
  const render = props => { runtime.begin(); return card.DecisionCard(props) }
  return { model, actions, render, ui, unmount: runtime.unmount }
}

async function mount(detail = answeredDetail, options = {}) {
  const f = await setup()
  const calls = []
  let current = detail
  const decisionRpc = options.decisionRpc ?? (async (_connection, method, request) => {
    calls.push([method, request])
    if (method === 'overview') return { agents }
    if (method === 'caseForCall' || method === 'caseForToolCall' || method === 'record') return current
    return null
  })
  const props = {
    sessionId: 'root', callId: 'call', toolName: 'ask_user_question', questions: [], connection: {},
    decisionRpc, createDecisionActions: f.actions.createDecisionActions,
    cardView: f.model.cardView, decisionModel: f.model, ui: f.ui, t: key => key,
    ...options.props,
  }
  f.render(props)
  for (let index = 0; index < 8; index++) await Promise.resolve()
  return {
    ...f, props, calls,
    render: () => f.render(props),
    setDetail: value => { current = value },
  }
}

test('production registers both toolview keys independently at priority -10 without bypass channels', async () => {
  const production = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  assert.match(production, /for \(const toolName of \["ask_user_question", "decision_consult"\]\)/)
  assert.match(production, /key: toolName, priority: -10/)
  assert.match(production, /ui-weir-settings: \$\{toolName\} decision card/)
  const source = readFileSync(new URL('../../lib/client.decision-card.js', import.meta.url), 'utf8')
  assert.equal(source.includes('session.append') || source.includes('commands.execute'), false)
  assert.equal(source.includes('querySelector') || source.includes('document.body'), false)
})

test('missing Case returns null and leaves native UI untouched', async () => {
  const mounted = await mount(null)
  assert.equal(mounted.render(), null)
})

test('answered card presents real questions and answers with a lean static layer and grouped diagnostics', async () => {
  const mounted = await mount()
  const tree = mounted.render()
  const text = textContent(tree)
  assert.equal(tree['data-decision-variant'], 'answered')
  assert.match(text, /Tone/)
  assert.match(text, /Which title should we use\?/)
  assert.match(text, /Concise title/)
  assert.match(text, /Use concise wording/)
  assert.equal(text.includes('dc-current') || text.includes('da-new') || text.includes('decisionRevision'), false)
  const primary = findAll(tree, node => node.__type === mounted.ui.Button && node.variant === 'primary')
  assert.equal(primary.length, 0, 'a closed answered card has no primary action; open-record is a quiet ghost')
  assert.equal(findAll(tree, node => node.__type === mounted.ui.Button && node.children === 'decisionHistory')[0].variant, 'ghost')
  const disclosures = findAll(tree, node => node.__type === mounted.ui.Disclosure)
  assert.ok(disclosures.some(node => node.label === 'decisionEvidence'))
  assert.equal(disclosures.find(node => node.label === 'decisionEvaluationHistory' || node.label === 'decisionRouteHistory' || node.label === 'decisionAdvancedDiagnostics'), undefined, 'diagnostics are not static top-level rows')
  const advanced = nestedDisclosure(tree, mounted.ui, 'decisionAdvancedDiagnostics')
  assert.ok(advanced)
  assert.equal(typeof advanced.children, 'function')
  assert.match(textContent(advanced.children()), /dc-current/)
})

test('more-details entry previews substantive diagnostic signals only', async () => {
  const plain = await mount()
  assert.equal(moreDetails(plain.render(), plain.ui).label, 'decisionMoreDetails')

  const failedDetail = { ...answeredDetail, attempts: [{ ...answeredDetail.attempts[0], outcome: 'failed' }, answeredDetail.attempts[1]] }
  const failedMount = await mount(failedDetail)
  assert.equal(moreDetails(failedMount.render(), failedMount.ui).label, 'decisionMoreDetails · decisionMoreDetailsFailedAttempt')

  const routed = { ...answeredDetail, routeDecisions: [{ routeDecisionId: 'rd-1', mode: 'auto', chosen: null, reason: 'failure:model_error', createdAt: '2026-01-02T03:04:05.000Z' }] }
  const routedMount = await mount(routed)
  assert.equal(moreDetails(routedMount.render(), routedMount.ui).label, 'decisionMoreDetails · decisionMoreDetailsRouteIssue')
})

test('production card fallback uses the active locale for an unavailable assistant', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const detail = {
    case: { ...answeredDetail.case, agentId: 'missing', request: { questions: [] } },
    attempts: [], feedback: [], routeDecisions: [],
  }
  const mounted = await mount(detail, { props: { t: key => model.dictionaries.zh[key] } })
  const text = textContent(mounted.render())
  assert.match(text, /决策助手/)
  assert.equal(text.includes('Decision assistant'), false)
})

test('card status variants retain localized state without a static primary action', async () => {
  const variants = [
    [{ state: 'closed', closing: 'answered' }, 'answered', 'decisionStatusAnswered'],
    [{ state: 'awaiting_user', closing: undefined, awaitingReason: 'authority', decision: null }, 'pending', 'decisionStatusAwaitingUser'],
    [{ state: 'closed', closing: 'returned', decision: null }, 'needs_more', 'decisionStatusReturned'],
    [{ state: 'awaiting_user', closing: undefined, awaitingReason: 'exhausted', decision: null }, 'failed', 'decisionStatusFailed'],
    [{ state: 'closed', closing: 'cancelled', decision: null }, 'cancelled', 'decisionStatusCancelled'],
  ]
  for (const [patch, variant, statusKey] of variants) {
    const detail = { ...answeredDetail, case: { ...answeredDetail.case, ...patch } }
    const mounted = await mount(detail)
    const tree = mounted.render()
    assert.equal(tree['data-decision-variant'], variant)
    assert.ok(findAll(tree, node => node.__type === mounted.ui.Badge).some(node => node.children === statusKey))
    assert.equal(findAll(tree, node => node.__type === mounted.ui.Button && node.variant === 'primary').length, 0)
  }
})

const waitingDetail = {
  ...answeredDetail,
  case: {
    ...answeredDetail.case,
    state: 'awaiting_user', closing: undefined, awaitingReason: 'authority', decision: null,
    escalation: {
      missing: ['A new title judgment is required'],
      suggestion: [{ id: 'q-title', selected: ['Use Short'] }],
      perQuestion: [{ id: 'q-title', outcome: 'return', detail: 'MISSING_CONTEXT' }],
    },
  },
}

test('awaiting explicit consult leads with its only answer form and no duplicate review content', async () => {
  const mounted = await mount(waitingDetail, { props: { toolName: 'decision_consult' } })
  const tree = mounted.render()
  const content = tree.children.filter(Boolean)
  const forms = findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)
  const answerFormIndex = content.findIndex(node => node.__type === mounted.ui.DecisionAnswers)
  const secondaryLabels = ['decisionEvidence', 'decisionMoreDetails', 'decisionRecoveryActions']
  const secondaryContentAfterForm = secondaryLabels.every(label => content.findIndex(node => node.__type === mounted.ui.Disclosure && node.label === label) > answerFormIndex)
    && content.findIndex(node => node.__type === mounted.ui.Button && node.children === 'decisionHistory') > answerFormIndex
    && content.findIndex(node => node.className === 'weir-da-feedback-editor') > answerFormIndex
  assert.deepEqual({
    formCount: forms.length,
    answerFormImmediatelyAfterHeader: content[0]?.__type === mounted.ui.DecisionStyles && content[1]?.className === 'weir-da-card-header' && answerFormIndex === 2,
    recordAnswerSummaries: findAll(tree, node => node.className === 'weir-da-record-answers').length,
    suggestionReviews: findAll(tree, node => node.className === 'weir-da-suggestion-review').length,
    secondaryContentAfterForm,
  }, {
    formCount: 1,
    answerFormImmediatelyAfterHeader: true,
    recordAnswerSummaries: 0,
    suggestionReviews: 0,
    secondaryContentAfterForm: true,
  })
  assert.deepEqual(forms[0].suggestions, waitingDetail.case.escalation.suggestion)
  // No decision yet: ratings are premature and hidden, but note/correction
  // entries stay available on the waiting card.
  assert.equal(findAll(tree, node => node['data-feedback']).length, 0)
  assert.ok(findAll(tree, node => node['data-action'] === 'open-comment')[0])
  assert.ok(findAll(tree, node => node['data-action'] === 'open-correction')[0])
  assert.equal(textContent(tree).includes('decisionNoAnswer'), false)
})

test('Hook pending card defers to the native question and never duplicates its answer form', async () => {
  const mounted = await mount(waitingDetail, { props: { toolName: 'ask_user_question' } })
  const tree = mounted.render()
  const text = textContent(tree)
  assert.match(text, /decisionNativeAnswerHint/)
  assert.match(text, /A new title judgment is required/)
  assert.match(text, /Use Short/)
  assert.match(text, /decisionSuggestionNotSubmitted/)
  assert.match(text, /decisionReasonMissingContext/)
  assert.equal(text.includes('MISSING_CONTEXT'), false)
  assert.equal(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers).length, 0)
  assert.equal(findAll(tree, node => node.__type === 'input' || node.__type === 'textarea' || node.__type === 'select').length, 0)
})

test('explicit consult card reuses DecisionAnswers and writes back with an authoritative reread', async () => {
  let current = { ...waitingDetail, case: { ...waitingDetail.case, caseId: 'dc-consult' } }
  const calls = []
  const mounted = await mount(current, {
    props: { toolName: 'decision_consult' },
    decisionRpc: async (_connection, method, request) => {
      calls.push([method, request])
      if (method === 'overview') return { agents }
      if (method === 'caseForToolCall' || method === 'record') return current
      if (method === 'decide') {
        current = { ...current, case: { ...current.case, state: 'closed', closing: 'escalated', decision: { attemptId: 'da-new', answers: request.answers } } }
        return current.case
      }
      return null
    },
  })
  let tree = mounted.render()
  const form = findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0]
  assert.ok(form)
  assert.deepEqual(form.questions, current.case.request.questions)
  assert.deepEqual(form.suggestions, current.case.escalation.suggestion)
  assert.deepEqual(form.answers, {})
  const openRecord = findAll(tree, node => node.__type === mounted.ui.Button && node.children === 'decisionHistory')[0]
  assert.equal(openRecord.variant, 'secondary')
  const batch = [{ id: 'q-title', selected: ['User choice'] }]
  await form.onSubmit(batch)
  for (let index = 0; index < 8; index++) await Promise.resolve()
  tree = mounted.render()
  assert.deepEqual(calls.filter(call => call[0] === 'decide'), [['decide', { sessionId: 'root', caseId: 'dc-consult', answers: batch }]])
  assert.ok(calls.some(call => call[0] === 'record' && call[1].caseId === 'dc-consult'))
  assert.equal(calls.filter(call => call[0] === 'caseForToolCall').length, 1)
  assert.equal(tree['data-decision-variant'], 'answered')
  assert.match(textContent(tree), /User choice/)
})

test('evidence rereads once on open and earlier evaluations keep their own evidence grouped', async () => {
  const mounted = await mount()
  let tree = mounted.render()
  let evidence = findAll(tree, node => node.__type === mounted.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(mounted.calls.filter(call => call[0] === 'record').length, 0)
  assert.equal(evidence.onToggle, undefined)
  await evidence.onOpen()
  for (let index = 0; index < 8; index++) await Promise.resolve()
  tree = mounted.render()
  evidence = findAll(tree, node => node.__type === mounted.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(mounted.calls.filter(call => call[0] === 'record').length, 1)
  const currentText = textContent(evidence.children())
  assert.match(currentText, /current evidence/)
  assert.equal(currentText.includes('old evidence'), false)
  await evidence.onOpen()
  for (let index = 0; index < 8; index++) await Promise.resolve()
  assert.equal(mounted.calls.filter(call => call[0] === 'record').length, 1)

  const history = nestedDisclosure(mounted.render(), mounted.ui, 'decisionEvaluationHistory')
  assert.ok(history)
  const historyText = textContent(history.children())
  assert.match(historyText, /Old rationale/)
  assert.match(historyText, /old evidence/)
  assert.match(historyText, /decisionReasonMissingContext/)
  assert.equal(historyText.includes('current evidence') || historyText.includes('da-old') || historyText.includes('MISSING_CONTEXT'), false)
})

test('cold card evidence and route disclosures become reveal-ready only after authoritative success', async () => {
  let resolveCold
  const cold = new Promise(resolve => { resolveCold = resolve })
  let coldReads = 0
  const mounted = await mount(answeredDetail, { decisionRpc: async (_connection, method) => {
    if (method === 'record') { coldReads += 1; return cold }
    if (method === 'overview') return { agents }
    if (method === 'caseForCall' || method === 'caseForToolCall') return answeredDetail
    return null
  } })
  let tree = mounted.render()
  let evidence = findAll(tree, node => node.__type === mounted.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(evidence.revealOnOpen, 'end')
  assert.equal(evidence.revealReady, false)
  const read = evidence.onOpen()
  tree = mounted.render()
  evidence = findAll(tree, node => node.__type === mounted.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(evidence.revealReady, false, 'cold loading content is not settled')
  resolveCold(answeredDetail)
  await read
  for (let index = 0; index < 8; index++) await Promise.resolve()
  tree = mounted.render()
  evidence = findAll(tree, node => node.__type === mounted.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(evidence.revealReady, true)
  const group = moreDetails(tree, mounted.ui)
  assert.equal(group.revealOnOpen, 'end')
  const routes = nestedDisclosure(tree, mounted.ui, 'decisionRouteHistory')
  assert.equal(routes.revealOnOpen, undefined, 'nested disclosures do not re-jump')
  await routes.onOpen()
  assert.equal(coldReads, 1, 'route opening reuses the settled authoritative read')
  for (const label of ['decisionEvaluationHistory', 'decisionAdvancedDiagnostics']) {
    assert.equal(nestedDisclosure(tree, mounted.ui, label).revealOnOpen, undefined, label)
  }
  mounted.unmount()
})

test('cold card evidence errors are settled reveal content and preserve retry semantics', async () => {
  const mounted = await mount(answeredDetail, { decisionRpc: async (_connection, method) => {
    if (method === 'record') throw Object.assign(new Error('cold evidence unavailable'), { code: 'NETWORK' })
    if (method === 'overview') return { agents }
    if (method === 'caseForCall' || method === 'caseForToolCall') return answeredDetail
    return null
  } })
  let tree = mounted.render()
  let evidence = findAll(tree, node => node.__type === mounted.ui.Disclosure && node.label === 'decisionEvidence')[0]
  await evidence.onOpen()
  for (let index = 0; index < 8; index++) await Promise.resolve()
  tree = mounted.render()
  evidence = findAll(tree, node => node.__type === mounted.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(evidence.revealOnOpen, 'end')
  assert.equal(evidence.revealReady, true)
  assert.match(textContent(evidence.children()), /decisionReadFailed/)
  const routes = nestedDisclosure(tree, mounted.ui, 'decisionRouteHistory')
  assert.match(textContent(routes.children()), /decisionReadFailed/)
  mounted.unmount()
})

test('stale, conflicting, and missing evidence remain visible in ordinary language', async () => {
  const stale = {
    ...answeredDetail,
    case: answeredDetail.case,
    attempts: [answeredDetail.attempts[0], { ...answeredDetail.attempts[1], reasonCode: 'STALE_EVIDENCE', evidence: [{ evidenceId: 'ev-new', status: 'superseded' }] }],
  }
  const staleMount = await mount(stale)
  const staleTree = staleMount.render()
  assert.match(textContent(staleTree), /decisionReasonStaleEvidence/)
  const staleEvidence = findAll(staleTree, node => node.__type === staleMount.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.match(textContent(staleEvidence.children()), /decisionEvidenceSuperseded/)
  assert.match(textContent(staleEvidence.children()), /decisionEvidenceUnavailable/)

  const conflict = { ...answeredDetail, case: { ...answeredDetail.case, decision: { ...answeredDetail.case.decision, code: 'CONFLICTING_EVIDENCE' } } }
  const conflictMount = await mount(conflict)
  assert.match(textContent(conflictMount.render()), /decisionReasonConflictingEvidence/)

  const missing = { ...answeredDetail, attempts: [answeredDetail.attempts[0], { ...answeredDetail.attempts[1], evidence: [] }] }
  const missingMount = await mount(missing)
  const missingEvidence = findAll(missingMount.render(), node => node.__type === missingMount.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.match(textContent(missingEvidence.children()), /decisionNoEvidence/)
})

test('feedback actions follow rating state and dispute stays a single reason-free RPC', async () => {
  const expected = { none: ['rating_up', 'rating_down'], validated: ['undo_rating_up'], disputed: ['undo_rating_down'], unknown: [] }
  for (const [feedbackState, verbs] of Object.entries(expected)) {
    const detail = { ...answeredDetail, case: { ...answeredDetail.case, feedbackState } }
    const mounted = await mount(detail)
    let tree = mounted.render()
    const controls = findAll(tree, node => node.__type === mounted.ui.Button && node['data-feedback'])
    assert.deepEqual(controls.map(node => node['data-feedback']), verbs)
    if (feedbackState === 'none') {
      assert.equal(controls.some(node => String(node['data-feedback']).startsWith('undo_')), false)
      assert.match(textContent(tree), /decisionFeedbackHintShort/)
      const detailGroup = moreDetails(tree, mounted.ui)
      assert.match(textContent(detailGroup.children()), /decisionConfirmConsequence/)
      assert.match(textContent(detailGroup.children()), /decisionDisputeConsequence/)
      const down = controls.find(node => node['data-feedback'] === 'rating_down')
      await down.onClick()
      for (let index = 0; index < 8; index++) await Promise.resolve()
      assert.deepEqual(mounted.calls.filter(call => call[0] === 'feedback'), [['feedback', { sessionId: 'root', caseId: 'dc-current', verb: 'rating_down' }]])
      tree = mounted.render()
    }
    if (feedbackState === 'validated') assert.match(textContent(tree), /decisionFeedbackValidated/)
    if (feedbackState === 'disputed') assert.match(textContent(tree), /decisionFeedbackDisputed/)
  }
})

test('note and correction entries keep separate content, previews, and exact RPC arguments', async () => {
  const mounted = await mount()
  let tree = mounted.render()
  findAll(tree, node => node.__type === mounted.ui.Button && node['data-action'] === 'open-comment')[0].onClick()
  tree = mounted.render()
  let note = findAll(tree, node => node.__type === 'textarea' && node['data-draft'] === 'comment')[0]
  assert.equal(findAll(tree, node => node.__type === mounted.ui.Field && node.label === 'decisionComment')[0].hint, 'decisionNoteNoEffect')
  note.onChange({ target: { value: 'A note for later' } })

  tree = mounted.render()
  findAll(tree, node => node.__type === mounted.ui.Button && node['data-action'] === 'open-correction')[0].onClick()
  tree = mounted.render()
  const correction = findAll(tree, node => node.__type === 'textarea' && node['data-draft'] === 'correction')[0]
  assert.notEqual(correction.value, 'A note for later')
  correction.onChange({ target: { value: 'Use the longer title' } })
  tree = mounted.render()
  const preview = textContent(tree)
  assert.match(preview, /decisionCorrectionScope/)
  assert.match(preview, /decisionScopeCurrentWorkspace/)
  assert.match(preview, /docs/)
  assert.equal(preview.includes('/repo'), false, 'the default preview never shows a workspace realpath')
  assert.match(preview, /docs/)
  assert.match(preview, /decisionCorrectionTarget/)
  assert.match(preview, /Which title should we use\?/)
  assert.match(preview, /decisionCorrectionFutureOnly/)
  await findAll(tree, node => node.__type === mounted.ui.Button && node['data-action'] === 'correction')[0].onClick()
  for (let index = 0; index < 8; index++) await Promise.resolve()
  assert.deepEqual(mounted.calls.filter(call => call[0] === 'correction'), [['correction', {
    sessionId: 'root', caseId: 'dc-current', direction: 'Use the longer title',
    scope: answeredDetail.case.scope, supersedes: ['dc-current'],
  }]])

  tree = mounted.render()
  findAll(tree, node => node.__type === mounted.ui.Button && node['data-action'] === 'open-comment')[0].onClick()
  tree = mounted.render()
  note = findAll(tree, node => node.__type === 'textarea' && node['data-draft'] === 'comment')[0]
  assert.equal(note.value, 'A note for later')
  await findAll(tree, node => node.__type === mounted.ui.Button && node['data-action'] === 'comment')[0].onClick()
  for (let index = 0; index < 8; index++) await Promise.resolve()
  assert.deepEqual(mounted.calls.filter(call => call[0] === 'feedback'), [['feedback', {
    sessionId: 'root', caseId: 'dc-current', verb: 'comment', payload: { text: 'A note for later' },
  }]])
})

function action(tree, ui, name) {
  return findAll(tree, node => node.__type === ui.Button && node['data-action'] === name)[0]
}

function draftInput(tree, field) {
  return findAll(tree, node => (node.__type === 'textarea' || node.__type === 'select') && node['data-draft'] === field)[0]
}

function recovery(tree, ui) {
  return findAll(tree, node => node.__type === ui.Disclosure && node.label === 'decisionRecoveryActions')[0]
}

function moreDetails(tree, ui) {
  return findAll(tree, node => node.__type === ui.Disclosure && String(node.label).startsWith('decisionMoreDetails'))[0]
}

function nestedDisclosure(tree, ui, label) {
  const group = moreDetails(tree, ui)
  return findAll(typeof group?.children === 'function' ? group.children() : null, node => node.__type === ui.Disclosure && node.label === label)[0]
}

async function flushCard() {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

test('answers, comment, correction, and reassign drafts stay isolated by session and Case', async () => {
  const makeWaiting = caseId => ({ ...waitingDetail, case: { ...waitingDetail.case, caseId } })
  const byCall = { 'call-a': makeWaiting('dc-a'), 'call-b': makeWaiting('dc-b') }
  const byCase = Object.fromEntries(Object.values(byCall).map(value => [value.case.caseId, value]))
  const mounted = await mount(byCall['call-a'], {
    props: { toolName: 'decision_consult', callId: 'call-a' },
    decisionRpc: async (_connection, method, request) => {
      if (method === 'overview') return { agents }
      if (method === 'caseForToolCall') return byCall[request.toolCallId]
      if (method === 'record') return byCase[request.caseId]
      return null
    },
  })
  const answersA = { 'q-title': { selected: ['Answer A'] } }
  let tree = mounted.render()
  findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].onChange(answersA)
  action(tree, mounted.ui, 'open-comment').onClick()
  tree = mounted.render()
  draftInput(tree, 'comment').onChange({ target: { value: 'Comment A' } })
  tree = mounted.render()
  action(tree, mounted.ui, 'open-correction').onClick()
  tree = mounted.render()
  draftInput(tree, 'correction').onChange({ target: { value: 'Correction A' } })
  tree = mounted.render()
  let target = findAll(recovery(tree, mounted.ui).children(), node => node.__type === 'select')[0]
  target.onChange({ target: { value: 'b' } })

  mounted.props.callId = 'call-b'
  mounted.render()
  await flushCard()
  tree = mounted.render()
  assert.deepEqual(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].answers, {})
  action(tree, mounted.ui, 'open-comment').onClick()
  tree = mounted.render()
  assert.equal(draftInput(tree, 'comment').value, '')
  draftInput(tree, 'comment').onChange({ target: { value: 'Comment B' } })
  tree = mounted.render()
  assert.equal(findAll(recovery(tree, mounted.ui).children(), node => node.__type === 'select')[0].value, '')

  mounted.props.callId = 'call-a'
  mounted.render()
  await flushCard()
  tree = mounted.render()
  assert.deepEqual(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].answers, answersA)
  action(tree, mounted.ui, 'open-comment').onClick()
  tree = mounted.render()
  assert.equal(draftInput(tree, 'comment').value, 'Comment A')
  tree = mounted.render()
  action(tree, mounted.ui, 'open-correction').onClick()
  tree = mounted.render()
  assert.equal(draftInput(tree, 'correction').value, 'Correction A')
  assert.equal(findAll(recovery(tree, mounted.ui).children(), node => node.__type === 'select')[0].value, 'b')

  mounted.props.sessionId = 'other'
  mounted.render()
  await flushCard()
  tree = mounted.render()
  assert.deepEqual(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].answers, {})
  action(tree, mounted.ui, 'open-comment').onClick()
  tree = mounted.render()
  assert.equal(draftInput(tree, 'comment').value, '')
  assert.equal(findAll(recovery(tree, mounted.ui).children(), node => node.__type === 'select')[0].value, '')
})

test('write and reread failures retain drafts; success clears only the relevant draft', async () => {
  let current = { ...waitingDetail, case: { ...waitingDetail.case, caseId: 'dc-safe' } }
  const failures = new Set(['decide', 'comment', 'correction', 'reassign'])
  let failRecord = false
  const mounted = await mount(current, {
    props: { toolName: 'decision_consult' },
    decisionRpc: async (_connection, method, request) => {
      if (method === 'overview') return { agents }
      if (method === 'caseForToolCall') return current
      if (method === 'record') {
        if (failRecord) throw Object.assign(new Error('raw reread socket details'), { code: 'NETWORK' })
        return current
      }
      if (method === 'decide' && failures.has('decide')) throw Object.assign(new Error('raw revision details'), { code: 'REVISION_CONFLICT' })
      if (method === 'feedback' && request.verb === 'comment' && failures.has('comment')) throw new Error('raw comment details')
      if (method === 'correction' && failures.has('correction')) throw new Error('raw correction details')
      if (method === 'reassign' && failures.has('reassign')) throw new Error('raw reassign details')
      return null
    },
  })
  const answers = { 'q-title': { selected: ['Draft answer'] } }
  const batch = [{ id: 'q-title', selected: ['Draft answer'] }]
  let tree = mounted.render()
  findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].onChange(answers)
  action(tree, mounted.ui, 'open-comment').onClick()
  tree = mounted.render()
  draftInput(tree, 'comment').onChange({ target: { value: 'Keep this note' } })
  tree = mounted.render()
  action(tree, mounted.ui, 'open-correction').onClick()
  tree = mounted.render()
  draftInput(tree, 'correction').onChange({ target: { value: 'Keep this correction' } })
  tree = mounted.render()
  findAll(recovery(tree, mounted.ui).children(), node => node.__type === 'select')[0].onChange({ target: { value: 'b' } })

  tree = mounted.render()
  await findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].onSubmit(batch)
  await flushCard()
  tree = mounted.render()
  assert.deepEqual(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].answers, answers)
  assert.match(textContent(tree), /decisionErrorConflict/)
  assert.equal(textContent(tree).includes('raw revision details'), false)
  const advanced = nestedDisclosure(tree, mounted.ui, 'decisionAdvancedDiagnostics')
  assert.match(textContent(advanced.children()), /REVISION_CONFLICT/)
  assert.match(textContent(advanced.children()), /raw revision details/)

  action(tree, mounted.ui, 'open-comment').onClick()
  tree = mounted.render()
  await action(tree, mounted.ui, 'comment').onClick()
  await flushCard()
  tree = mounted.render()
  assert.equal(draftInput(tree, 'comment').value, 'Keep this note')
  assert.equal(textContent(tree).includes('raw comment details'), false)

  action(tree, mounted.ui, 'open-correction').onClick()
  tree = mounted.render()
  await action(tree, mounted.ui, 'correction').onClick()
  await flushCard()
  tree = mounted.render()
  assert.equal(draftInput(tree, 'correction').value, 'Keep this correction')

  let recoveryTree = recovery(tree, mounted.ui).children()
  await findAll(recoveryTree, node => node.__type === mounted.ui.Button && node['data-action'] === 'reassign')[0].onClick()
  await flushCard()
  tree = mounted.render()
  assert.equal(findAll(recovery(tree, mounted.ui).children(), node => node.__type === 'select')[0].value, 'b')

  failures.delete('comment')
  action(tree, mounted.ui, 'open-comment').onClick()
  tree = mounted.render()
  await action(tree, mounted.ui, 'comment').onClick()
  await flushCard()
  tree = mounted.render()
  action(tree, mounted.ui, 'open-comment').onClick()
  tree = mounted.render()
  assert.equal(draftInput(tree, 'comment').value, '')
  assert.deepEqual(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].answers, answers)
  action(tree, mounted.ui, 'open-correction').onClick()
  tree = mounted.render()
  assert.equal(draftInput(tree, 'correction').value, 'Keep this correction')
  assert.equal(findAll(recovery(tree, mounted.ui).children(), node => node.__type === 'select')[0].value, 'b')

  failures.delete('correction')
  await action(tree, mounted.ui, 'correction').onClick()
  await flushCard()
  tree = mounted.render()
  action(tree, mounted.ui, 'open-correction').onClick()
  tree = mounted.render()
  assert.equal(draftInput(tree, 'correction').value, '')
  assert.deepEqual(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].answers, answers)

  failures.delete('reassign')
  await findAll(recovery(tree, mounted.ui).children(), node => node.__type === mounted.ui.Button && node['data-action'] === 'reassign')[0].onClick()
  await flushCard()
  tree = mounted.render()
  assert.equal(findAll(recovery(tree, mounted.ui).children(), node => node.__type === 'select')[0].value, '')
  assert.deepEqual(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].answers, answers)

  failures.delete('decide')
  failRecord = true
  await findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].onSubmit(batch)
  await flushCard()
  tree = mounted.render()
  assert.deepEqual(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0].answers, answers)
  assert.equal(textContent(tree).includes('raw reread socket details'), false)
})

test('unified pending guard suppresses duplicate and competing writes', async () => {
  let current = waitingDetail
  let release
  const calls = []
  const mounted = await mount(current, {
    props: { toolName: 'decision_consult' },
    decisionRpc: async (_connection, method, request) => {
      calls.push([method, request])
      if (method === 'overview') return { agents }
      if (method === 'caseForToolCall' || method === 'record') return current
      if (method === 'decide') return new Promise(resolve => {
        release = () => {
          current = { ...current, case: { ...current.case, state: 'closed', closing: 'escalated', decision: { attemptId: 'da-new', answers: request.answers } } }
          resolve(current.case)
        }
      })
      return null
    },
  })
  const tree = mounted.render()
  const form = findAll(tree, node => node.__type === mounted.ui.DecisionAnswers)[0]
  const batch = [{ id: 'q-title', selected: ['One answer'] }]
  const first = form.onSubmit(batch)
  const second = form.onSubmit(batch)
  const pendingTree = mounted.render()
  assert.equal(calls.filter(call => call[0] === 'decide').length, 1)
  // Ratings are hidden until a decision exists; assert the pending guard on
  // the note entry instead (same section, same guard).
  const commentEntry = action(pendingTree, mounted.ui, 'open-comment')
  assert.equal(commentEntry.disabled, true)
  await commentEntry.onClick()
  assert.equal(findAll(mounted.render(), node => node['data-draft'] === 'comment').length, 0)
  assert.equal(calls.filter(call => call[0] === 'feedback').length, 0)
  assert.equal(findAll(mounted.render(), node => node.__type === mounted.ui.ConfirmDialog).length, 0)
  release()
  await Promise.all([first, second])
  await flushCard()
  assert.equal(calls.filter(call => call[0] === 'decide').length, 1)
})

test('cancel requires confirmation and terminal records expose no revival controls', async () => {
  let current = waitingDetail
  const calls = []
  const mounted = await mount(current, {
    props: { toolName: 'decision_consult' },
    decisionRpc: async (_connection, method, request) => {
      calls.push([method, request])
      if (method === 'overview') return { agents }
      if (method === 'caseForToolCall' || method === 'record') return current
      if (method === 'cancel') {
        current = { ...current, case: { ...current.case, state: 'closed', closing: 'cancelled', decision: null } }
        return current.case
      }
      return null
    },
  })
  let tree = mounted.render()
  let cancel = findAll(recovery(tree, mounted.ui).children(), node => node.__type === mounted.ui.Button && node['data-action'] === 'cancel')[0]
  cancel.onClick()
  tree = mounted.render()
  assert.equal(calls.filter(call => call[0] === 'cancel').length, 0)
  let dialog = findAll(tree, node => node.__type === mounted.ui.ConfirmDialog)[0]
  assert.ok(dialog)
  assert.equal(dialog.body, 'decisionCancelConfirmation')
  dialog.onCancel()
  assert.equal(calls.filter(call => call[0] === 'cancel').length, 0)
  tree = mounted.render()
  cancel = findAll(recovery(tree, mounted.ui).children(), node => node.__type === mounted.ui.Button && node['data-action'] === 'cancel')[0]
  cancel.onClick()
  tree = mounted.render()
  dialog = findAll(tree, node => node.__type === mounted.ui.ConfirmDialog)[0]
  await dialog.onConfirm()
  await flushCard()
  assert.deepEqual(calls.filter(call => call[0] === 'cancel'), [['cancel', { sessionId: 'root', caseId: 'dc-current' }]])
  tree = mounted.render()
  assert.equal(tree['data-decision-variant'], 'cancelled')
  assert.equal(recovery(tree, mounted.ui), undefined)
  assert.equal(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers).length, 0)
  assert.equal(action(tree, mounted.ui, 'retry'), undefined)
})

test('native pending interaction refreshes an early tool-call card without polling', async () => {
  let pendingInteraction
  let current = null
  const calls = []
  const mounted = await mount(null, {
    props: { useSessionStatus: () => pendingInteraction },
    decisionRpc: async (_connection, method, request) => {
      calls.push([method, request])
      if (method === 'overview') return { agents }
      if (method === 'caseForCall') return current
      return null
    },
  })
  assert.equal(mounted.render(), null)
  current = waitingDetail
  pendingInteraction = { kind: 'question', callId: 'call' }
  mounted.render()
  await flushCard()
  assert.equal(mounted.render()['data-decision-variant'], 'pending')
  assert.equal(calls.filter(call => call[0] === 'caseForCall').length, 2)
  const source = readFileSync(new URL('../../lib/client.decision-card.js', import.meta.url), 'utf8')
  assert.equal(source.includes('props.useSessionStatus?.('), true)
  assert.equal(source.includes('props.refreshKey, pendingInteraction]'), true)
  assert.equal(/setInterval|setTimeout/.test(source), false)
})

test('consult refreshes an early null once its authoritative Case arrives before tool result', async () => {
  let current = null
  const waits = []
  const calls = []
  const mounted = await mount(null, {
    props: {
      toolName: 'decision_consult', callId: 'call-early',
      // No refreshKey/tool-result and no native pendingInteraction exist here.
      waitForDecisionCase: (sessionId, callId, signal) => new Promise(resolve => {
        waits.push({ sessionId, callId, signal, resolve })
      }),
    },
    decisionRpc: async (_connection, method, request) => {
      calls.push([method, request])
      if (method === 'overview') return { agents }
      if (method === 'caseForToolCall') return current
      return null
    },
  })
  assert.equal(mounted.render(), null)
  assert.equal(calls.filter(call => call[0] === 'caseForToolCall').length, 1)

  current = { ...waitingDetail, case: { ...waitingDetail.case, caseId: 'dc-early' } }
  for (const wait of waits) wait.resolve({ caseId: 'dc-early', revision: current.case.revision })
  await flushCard()

  const tree = mounted.render()
  assert.equal(tree?.['data-weir-decision-card'], 'dc-early')
  assert.equal(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers).length, 1)
  assert.equal(calls.filter(call => call[0] === 'caseForToolCall').length, 2)
  assert.deepEqual(waits.map(wait => [wait.sessionId, wait.callId]), [['root', 'call-early']])
})

test('consult wait cancellation and generation guards isolate switches and unmounts', async () => {
  const byCall = {
    'call-old': null,
    'call-new': { ...waitingDetail, case: { ...waitingDetail.case, caseId: 'dc-new' } },
    'call-unmount': null,
  }
  const waits = []
  const calls = []
  const mounted = await mount(null, {
    props: {
      toolName: 'decision_consult', callId: 'call-old',
      waitForDecisionCase: (_sessionId, callId, signal) => new Promise(resolve => {
        // Deliberately non-cooperative after abort: a late resolution must still be inert.
        waits.push({ callId, signal, resolve })
      }),
    },
    decisionRpc: async (_connection, method, request) => {
      calls.push([method, request])
      if (method === 'overview') return { agents }
      if (method === 'caseForToolCall') return byCall[request.toolCallId]
      return null
    },
  })
  const oldWait = waits[0]
  assert.equal(oldWait.callId, 'call-old')

  mounted.props.callId = 'call-new'
  mounted.render()
  await flushCard()
  assert.equal(oldWait.signal.aborted, true)
  assert.equal(mounted.render()['data-weir-decision-card'], 'dc-new')
  const readsAfterSwitch = calls.filter(call => call[0] === 'caseForToolCall').length
  oldWait.resolve({ caseId: 'dc-old' })
  await flushCard()
  assert.equal(mounted.render()['data-weir-decision-card'], 'dc-new')
  assert.equal(calls.filter(call => call[0] === 'caseForToolCall').length, readsAfterSwitch)

  mounted.props.callId = 'call-unmount'
  mounted.render()
  await flushCard()
  const unmountWait = waits.find(wait => wait.callId === 'call-unmount')
  assert.ok(unmountWait)
  mounted.unmount()
  assert.equal(unmountWait.signal.aborted, true)
  const readsAtUnmount = calls.filter(call => call[0] === 'caseForToolCall').length
  unmountWait.resolve({ caseId: 'dc-late' })
  await flushCard()
  assert.equal(calls.filter(call => call[0] === 'caseForToolCall').length, readsAtUnmount)
})


const unownedAutoDetail = {
  ...waitingDetail,
  case: { ...waitingDetail.case, caseId: 'dc-unowned', agentId: null, awaitingReason: 'no_route', escalation: { missing: [], suggestion: [], perQuestion: [] } },
  attempts: [], feedback: [],
  routeDecisions: [{ routeDecisionId: 'rd-auto-none', mode: 'auto', chosen: null, reason: 'none:no_candidates', createdAt: '2026-01-02T03:04:05.000Z' }],
}

test('unowned Auto consult and Hook cards retain their native answer paths but no Agent feedback or retry', async () => {
  for (const toolName of ['decision_consult', 'ask_user_question']) {
    const mounted = await mount(unownedAutoDetail, { props: { toolName } })
    const tree = mounted.render()
    const text = textContent(tree)
    assert.match(text, /decisionNoAssignedAgent/)
    assert.match(text, /decisionRoutingAutoNone/)
    assert.equal(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers).length, toolName === 'decision_consult' ? 1 : 0)
    assert.equal(findAll(tree, node => node['data-native-answer'] === true).length, toolName === 'ask_user_question' ? 1 : 0)
    assert.equal(findAll(tree, node => node['data-feedback'] || ['open-comment', 'open-correction', 'comment', 'correction', 'retry'].includes(node['data-action'])).length, 0)
    const recoveryTree = recovery(tree, mounted.ui).children()
    assert.ok(findAll(recoveryTree, node => node['data-action'] === 'reassign')[0])
    assert.ok(findAll(recoveryTree, node => node['data-action'] === 'cancel')[0])
    assert.equal(findAll(recoveryTree, node => node['data-action'] === 'retry').length, 0)
    const routes = nestedDisclosure(tree, mounted.ui, 'decisionRouteHistory')
    assert.ok(routes)
    const history = findAll(routes.children(), node => node.__type === mounted.ui.DecisionRouteHistory)[0]
    assert.equal(history.history.length, 1)
    assert.equal(history.history[0].mode, 'auto')
    assert.equal(history.history[0].statusKey, 'decisionRouteStatusNone')
    mounted.unmount()
  }
})

test('explicit reassign is single-flight and restores normal owned recovery and route history', async () => {
  let current = unownedAutoDetail
  let release
  const calls = []
  const mounted = await mount(current, {
    props: { toolName: 'decision_consult' },
    decisionRpc: async (_connection, method, request) => {
      calls.push([method, request])
      if (method === 'overview') return { agents }
      if (method === 'caseForToolCall' || method === 'record') return current
      if (method === 'reassign') return new Promise(resolve => {
        release = () => {
          current = { ...current, case: { ...current.case, agentId: 'b', awaitingReason: 'authority' }, routeDecisions: [...current.routeDecisions, { routeDecisionId: 'rd-manual', mode: 'manual_reassign', chosen: 'b', reason: '', createdAt: '2026-01-02T03:05:05.000Z' }] }
          resolve(current.case)
        }
      })
      return null
    },
  })
  let tree = mounted.render()
  let recoveryTree = recovery(tree, mounted.ui).children()
  draftInput(recoveryTree, 'reassignTarget').onChange({ target: { value: 'b' } })
  tree = mounted.render()
  const reassign = action(recovery(tree, mounted.ui).children(), mounted.ui, 'reassign')
  const first = reassign.onClick()
  const second = reassign.onClick()
  assert.equal(calls.filter(call => call[0] === 'reassign').length, 1)
  release()
  await Promise.all([first, second])
  await flushCard()
  tree = mounted.render()
  assert.match(textContent(tree), /Second assistant/)
  assert.match(textContent(tree), /decisionRoutingManualReassign/)
  assert.ok(action(recovery(tree, mounted.ui).children(), mounted.ui, 'retry'))
  assert.ok(action(tree, mounted.ui, 'open-correction'))
  const routes = nestedDisclosure(tree, mounted.ui, 'decisionRouteHistory')
  const history = findAll(routes.children(), node => node.__type === mounted.ui.DecisionRouteHistory)[0]
  assert.deepEqual(history.history.map(item => item.mode), ['auto', 'manual_reassign'])
  assert.equal(history.history[1].from, null)
  assert.equal(history.history[1].toName, 'Second assistant')
  assert.equal(findAll(tree, node => node.__type === mounted.ui.DecisionAnswers).length, 1)
  mounted.unmount()
})
