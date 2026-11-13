import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from '../helpers/load-client-chunk.js'
import { createPageHarness, deferred, findAll, textOf } from './page-test-helpers.js'

test('management page registers the existing left-panel and keyed main without polling', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({}));
  assert.equal(exports.PAGE_ID, 'weir-decisions');
  const production = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
  assert.match(production, /name: "sidebar.panellist", id: "weir-decisions", order: 12/);
  assert.match(production, /name: "main", key: "weir-decisions", children: \{ "weir-decisions.tab": \{ kind: "list", scope: "root" \} \}/);
  const source = readFileSync(new URL('../../lib/client.decision-page.js', import.meta.url), 'utf8');
  assert.equal(/setInterval|setTimeout/.test(source), false);
  assert.equal(source.includes('document.body'), false);
  assert.equal(source.includes('@deepseek-ai/'), false);
})

test('page model exposes three primary views and advanced metrics without editing or consolidation entry points', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports;
  assert.deepEqual(model.pageView({}).tabs, ['inbox', 'records', 'agents']);
  assert.deepEqual(model.pageView({}).advancedViews, ['metrics']);
  const record = {
    case: { caseId: 'dc', agentId: 'a', state: 'awaiting_user', feedbackState: 'disputed', scope: { paths: ['src'] }, decision: { code: 'STALE_EVIDENCE' } },
    attempts: [{ outcome: 'escalate' }],
  };
  const view = model.pageView({ tab: 'records', records: [record] });
  assert.equal(view.records.length, 1);
  assert.equal('editCase' in view, false);
  assert.equal('consolidate' in view, false);
})
test('page defaults to inbox with a real count, three primary destinations, and separate advanced metrics', async () => {
  const inbox = [
    { caseId: 'dc-one', agentId: 'a', state: 'awaiting_user', request: { questions: [{ id: 'q1', question: 'Choose a title' }] } },
    { caseId: 'dc-two', agentId: 'a', state: 'awaiting_user', request: { questions: [{ id: 'q2', question: 'Choose a scope' }] } },
  ]
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }],
    inbox: async () => inbox,
    records: async () => ({ records: [], nextCursor: null }),
    metrics: async () => ({ casesOpened: 0 }),
  } })
  const { tree } = await harness.settle()
  const nav = findAll(tree, node => node.type === 'nav' && node['data-decision-primary-nav'] === true)[0]
  assert.ok(nav, 'primary navigation exists')
  const destinations = findAll(nav, node => node.type === harness.ui.Button)
  assert.deepEqual(destinations.map(node => node['data-view']), ['inbox', 'records', 'agents'])
  assert.equal(findAll(tree, node => node['data-inbox-count'] === 2).length, 1)
  assert.equal(findAll(tree, node => node.type === 'section' && node['data-view'] === 'inbox').length, 1)
  assert.equal(findAll(tree, node => node.type === harness.ui.Button && node['data-view'] === 'metrics').length, 1)
  assert.equal(findAll(nav, node => node['data-view'] === 'metrics').length, 0)
  assert.equal(textOf(tree).includes('dc-one'), false)
  harness.unmount()
})

test('DecisionPage keeps inbox primary actions inside a 180px visual viewport at real 200% page scale', async () => {
  const listeners = new Map([['resize', new Set()], ['scroll', new Set()]])
  const visualViewport = {
    width: 180, height: 450, scale: 2, offsetLeft: 0, offsetTop: 0,
    addEventListener(type, listener) { listeners.get(type)?.add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    emit(type) { for (const listener of listeners.get(type) ?? []) listener() },
  }
  const previousWindow = globalThis.window
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }],
    inbox: async () => [waitingFixture()],
  } })
  Object.assign(globalThis.window, { innerWidth: 360, innerHeight: 900, devicePixelRatio: 1, visualViewport })
  const pageFrom = tree => {
    const page = findAll(tree, node => node.type === 'main' && node.className === 'weir-da-page')[0]
    assert.ok(page, 'Decision page exists')
    return page
  }
  try {
    let tree = (await harness.settle()).tree
    let page = pageFrom(tree)
    assert.equal(page.style?.position, 'fixed')
    assert.equal(page.style?.left, '0px')
    assert.equal(page.style?.top, '0px')
    assert.equal(page.style?.width, '180px')
    assert.equal(page.style?.height, '450px')
    assert.equal(page.style?.zIndex, 1000, 'the scaled page paints above the host shell instead of being occluded by its sidebar')
    assert.equal(page['data-visual-viewport'], 'compact')
    assert.equal(listeners.get('resize').size, 1)
    assert.equal(listeners.get('scroll').size, 1)
    const inbox = renderedInboxCard(harness, tree)
    assert.equal(findAll(inbox, node => node.type === harness.ui.DecisionAnswers).length, 1, 'the primary answer form remains mounted in the contained page')

    Object.assign(visualViewport, { width: 160, height: 400, offsetLeft: 20, offsetTop: 30 })
    visualViewport.emit('scroll')
    tree = harness.render()
    page = pageFrom(tree)
    assert.equal(page.style?.left, '20px')
    assert.equal(page.style?.top, '30px')
    assert.equal(page.style?.width, '160px')
    assert.equal(page.style?.height, '400px')

    Object.assign(visualViewport, { width: 360, height: 900, scale: 1, offsetLeft: 0, offsetTop: 0 })
    globalThis.window.devicePixelRatio = 2
    visualViewport.emit('resize')
    page = pageFrom(harness.render())
    assert.equal(page.style, undefined, 'DPR alone is not page zoom and all temporary viewport styles are removed')
    assert.equal(page['data-visual-viewport'], undefined)

    harness.unmount()
    assert.equal(listeners.get('resize').size, 0)
    assert.equal(listeners.get('scroll').size, 0)
  } finally {
    harness.unmount()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('directed openCase takes precedence over defaults and loads only that raw record detail', async () => {
  const calls = []
  let openCase = 'dc-directed'
  let destination = 'create'
  const detail = {
    case: { caseId: 'dc-directed', agentId: 'a', state: 'closed', closing: 'answered', feedbackState: 'none', request: { questions: [{ id: 'q', question: 'Directed question' }] }, decision: { answers: [{ id: 'q', selected: ['Directed answer'] }] } },
    attempts: [], feedback: [], routeDecisions: [],
  }
  const harness = await createPageHarness({
    consumeOpenCase: () => { const value = openCase; openCase = null; return value },
    consumeAgentDestination: () => { const value = destination; destination = null; return value },
    actions: {
      agents: async () => { calls.push('agents'); return [{ agentId: 'a', name: 'Tone', state: 'enabled' }] },
      inbox: async () => { calls.push('inbox'); return [] },
      records: async () => { calls.push('records'); return { records: [], nextCursor: null } },
      record: async id => { calls.push(`record:${id}`); return detail },
      metrics: async () => { calls.push('metrics'); return {} },
    },
  })
  const { tree } = await harness.settle()
  assert.equal(findAll(tree, node => node.type === 'section' && node['data-view'] === 'records').length, 1)
  assert.equal(findAll(tree, node => node['data-record-detail'] === 'dc-directed').length, 1)
  assert.equal(textOf(tree).includes('Directed question'), true)
  assert.equal(findAll(tree, node => node['data-agent-editor'] === 'create').length, 0)
  assert.equal(calls.includes('metrics'), false)
  assert.deepEqual(calls.filter(call => call.startsWith('record:')), ['record:dc-directed'])
  harness.unmount()
})

test('initial inbox never prefetches records, raw detail, or metrics and each destination loads on demand', async () => {
  const calls = []
  const harness = await createPageHarness({ actions: {
    agents: async () => { calls.push('agents'); return [] },
    inbox: async () => { calls.push('inbox'); return [] },
    records: async () => { calls.push('records'); return { records: [], nextCursor: null } },
    record: async id => { calls.push(`record:${id}`); return null },
    metrics: async () => { calls.push('metrics'); return { casesOpened: 0 } },
  } })
  await harness.settle()
  assert.deepEqual(calls.sort(), ['agents', 'inbox'])
  let tree = harness.render()
  findAll(tree, node => node.type === harness.ui.Button && node['data-view'] === 'records')[0].onClick()
  await harness.flush()
  tree = harness.render()
  assert.equal(calls.filter(call => call === 'records').length, 1)
  assert.equal(calls.some(call => call.startsWith('record:')), false)
  findAll(tree, node => node.type === harness.ui.Button && node['data-view'] === 'metrics')[0].onClick()
  await harness.flush()
  assert.equal(calls.filter(call => call === 'metrics').length, 1)
  harness.unmount()
})

test('a late response from an old session cannot overwrite the new session inbox', async () => {
  const oldInbox = deferred()
  const newInbox = deferred()
  const harness = await createPageHarness({ sessionId: 'old', actionsForSession: sessionId => ({
    agents: async () => [],
    inbox: () => sessionId === 'old' ? oldInbox.promise : newInbox.promise,
    records: async () => ({ records: [], nextCursor: null }),
    metrics: async () => ({}),
  }) })
  harness.render()
  harness.update({ sessionId: 'new' })
  harness.render()
  newInbox.resolve([{ caseId: 'dc-new', state: 'awaiting_user', request: { questions: [{ question: 'New session question' }] } }])
  await harness.flush()
  oldInbox.resolve([{ caseId: 'dc-old', state: 'awaiting_user', request: { questions: [{ question: 'Old session question' }] } }])
  await harness.flush()
  const items = findAll(harness.render(), node => node.type === harness.page.InboxItem)
  assert.deepEqual(items.map(node => node.item.caseId), ['dc-new'])
  assert.equal(items.some(node => textOf(node).includes('dc-new')), false)
  harness.unmount()
})
function waitingFixture() {
  return {
    caseId: 'dc-waiting', agentId: 'a', state: 'awaiting_user', awaitingReason: 'partial_batch', feedbackState: 'none',
    request: { questions: [
      { id: 'q1', question: 'Choose a title', options: [{ label: 'Short' }, { label: 'Long' }] },
      { id: 'q2', question: 'Explain the choice' },
    ] },
    escalation: {
      suggestion: [{ id: 'q1', selected: ['Short'] }, { id: 'q2', custom: 'Use Short' }],
      perQuestion: [{ id: 'q2', outcome: 'return', detail: 'MISSING_CONTEXT' }],
      missing: ['One question needs your decision'],
    },
  }
}

function renderedInboxCard(harness, tree = harness.render(), caseId = 'dc-waiting') {
  const element = findAll(tree, node => node.type === harness.page.InboxItem && node.item.caseId === caseId)[0]
  assert.ok(element, `inbox card ${caseId}`)
  return harness.page.InboxItem(element)
}

test('inbox uses shared answers, readable tentative guidance, on-demand current evidence, and secondary recovery', async () => {
  const item = waitingFixture()
  const detail = {
    case: item,
    attempts: [
      { attemptId: 'da-old', evidence: [{ evidenceId: 'ev-old', excerpt: 'Old evidence' }] },
      { attemptId: 'da-current', claims: [{ text: 'Current rationale' }], evidence: [{ evidenceId: 'ev-current', excerpt: 'Current evidence' }] },
    ],
    feedback: [], routeDecisions: [],
  }
  let reads = 0
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [item],
    record: async () => { reads += 1; return detail }, records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
  } })
  const { tree } = await harness.settle()
  const card = renderedInboxCard(harness, tree)
  const answers = findAll(card, node => node.type === harness.ui.DecisionAnswers)[0]
  assert.ok(answers)
  assert.deepEqual(answers.questions, item.request.questions)
  assert.deepEqual(answers.suggestions, item.escalation.suggestion)
  const text = textOf(card)
  assert.equal(text.includes('Use Short'), true)
  assert.equal(text.includes('MISSING_CONTEXT'), false)
  assert.equal(text.includes('dc-waiting'), false)
  const disclosures = findAll(card, node => node.type === harness.ui.Disclosure)
  assert.ok(disclosures.some(node => node.label === 'decisionRecoveryActions'))
  const evidence = disclosures.find(node => node.label === 'decisionEvidence')
  assert.ok(evidence)
  assert.equal(evidence.revealOnOpen, 'end')
  assert.equal(evidence.revealReady, false)
  evidence.onOpen()
  const loadingEvidence = findAll(renderedInboxCard(harness), node => node.type === harness.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(loadingEvidence.revealReady, false)
  await harness.flush()
  assert.equal(reads, 1)
  let reopened = findAll(renderedInboxCard(harness), node => node.type === harness.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(reopened.revealReady, true)
  const routes = findAll(renderedInboxCard(harness), node => node.type === harness.ui.Disclosure && node.label === 'decisionRouteHistory')[0]
  assert.equal(routes.revealOnOpen, 'end')
  assert.equal(routes.revealReady, true)
  const recovery = findAll(renderedInboxCard(harness), node => node.type === harness.ui.Disclosure && node.label === 'decisionRecoveryActions')[0]
  assert.equal(recovery.revealOnOpen, 'end')
  assert.equal(textOf(reopened.children()).includes('Current evidence'), true)
  assert.equal(textOf(reopened.children()).includes('Old evidence'), false)
  reopened.onOpen()
  await harness.flush()
  reopened = findAll(renderedInboxCard(harness), node => node.type === harness.ui.Disclosure && node.label === 'decisionEvidence')[0]
  reopened.onOpen()
  await harness.flush()
  assert.equal(reads, 1, 'cached evidence is not reread on close/reopen')
  harness.unmount()
})

test('cold inbox evidence and route errors settle reveal readiness without losing error content', async () => {
  const item = waitingFixture()
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [item],
    record: async () => { throw Object.assign(new Error('cold read failed'), { code: 'NETWORK' }) },
    records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
  } })
  await harness.settle()
  let card = renderedInboxCard(harness)
  let evidence = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(evidence.revealOnOpen, 'end')
  evidence.onOpen()
  card = renderedInboxCard(harness)
  evidence = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(evidence.revealReady, false)
  await harness.flush()
  card = renderedInboxCard(harness)
  evidence = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionEvidence')[0]
  assert.equal(evidence.revealReady, true)
  assert.ok(findAll(evidence.children(), node => node.type === harness.ui.ErrorState).length > 0)
  const routes = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRouteHistory')[0]
  assert.equal(routes.revealReady, true)
  assert.ok(findAll(routes.children(), node => node.type === harness.ui.ErrorState).length > 0)
  harness.unmount()
})

test('inbox decision submit is guarded and converges through authoritative record and inbox rereads', async () => {
  const item = waitingFixture()
  const gate = deferred()
  let waiting = [item]
  const calls = []
  const authoritative = { case: { ...item, state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers: [{ id: 'q1', selected: ['Short'] }, { id: 'q2', custom: 'Because' }] } }, attempts: [], feedback: [], routeDecisions: [] }
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }],
    inbox: async () => { calls.push('inbox'); return waiting },
    decide: async (caseId, batch) => { calls.push(['decide', caseId, batch]); return gate.promise },
    record: async caseId => { calls.push(['record', caseId]); return authoritative },
    records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
  } })
  await harness.settle()
  calls.length = 0
  const answers = findAll(renderedInboxCard(harness), node => node.type === harness.ui.DecisionAnswers)[0]
  const batch = [{ id: 'q1', selected: ['Short'] }, { id: 'q2', selected: [], custom: 'Because' }]
  const first = answers.onSubmit(batch)
  const second = answers.onSubmit(batch)
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'decide').length, 1)
  waiting = []
  gate.resolve({ accepted: true })
  await Promise.all([first, second])
  await harness.flush()
  assert.deepEqual(calls.map(call => Array.isArray(call) ? call[0] : call), ['decide', 'record', 'inbox'])
  assert.deepEqual(calls[0][2], batch)
  assert.equal(findAll(harness.render(), node => node.type === harness.page.InboxItem).length, 0)
  assert.equal(textOf(harness.render()).includes('decisionInboxEmpty'), true)
  harness.unmount()
})

test('failed decision writes and failed authoritative rereads preserve the same Case draft', async () => {
  for (const failureAt of ['mutation', 'reread']) {
    const item = waitingFixture()
    let recordReads = 0
    const harness = await createPageHarness({ actions: {
      agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [item],
      decide: async () => { if (failureAt === 'mutation') throw Object.assign(new Error('offline'), { code: 'NETWORK' }); return { accepted: true } },
      record: async () => { recordReads += 1; throw new Error('reread offline') },
      records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
    } })
    await harness.settle()
    let answers = findAll(renderedInboxCard(harness), node => node.type === harness.ui.DecisionAnswers)[0]
    const draft = { q1: { selected: ['Short'] }, q2: { selected: [], custom: 'Keep this draft' } }
    answers.onChange(draft)
    answers = findAll(renderedInboxCard(harness), node => node.type === harness.ui.DecisionAnswers)[0]
    assert.deepEqual(answers.answers, draft)
    await answers.onSubmit([{ id: 'q1', selected: ['Short'] }, { id: 'q2', selected: [], custom: 'Keep this draft' }])
    await harness.flush()
    answers = findAll(renderedInboxCard(harness), node => node.type === harness.ui.DecisionAnswers)[0]
    assert.deepEqual(answers.answers, draft, failureAt)
    assert.equal(textOf(harness.render()).includes('decisionFailed'), true)
    assert.equal(recordReads, failureAt === 'reread' ? 1 : 0)
    harness.unmount()
  }
})

test('reassign and retry stay secondary while cancel requires explicit confirmation', async () => {
  const item = waitingFixture()
  const calls = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }, { agentId: 'b', name: 'Second', state: 'enabled' }], inbox: async () => [item],
    reassign: async (...args) => { calls.push(['reassign', ...args]); return {} }, retry: async (...args) => { calls.push(['retry', ...args]); return {} }, cancel: async (...args) => { calls.push(['cancel', ...args]); return {} },
    record: async () => ({ case: item, attempts: [], feedback: [], routeDecisions: [] }), records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
  } })
  await harness.settle()
  let card = renderedInboxCard(harness)
  let recovery = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRecoveryActions')[0]
  const target = findAll(recovery, node => node.type === 'select')[0]
  target.onChange({ target: { value: 'b' } })
  card = renderedInboxCard(harness)
  recovery = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRecoveryActions')[0]
  await findAll(recovery, node => node.type === harness.ui.Button && node.children === 'decisionReassign')[0].onClick()
  await harness.flush()
  assert.deepEqual(calls[0], ['reassign', 'dc-waiting', 'b'])
  card = renderedInboxCard(harness)
  recovery = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRecoveryActions')[0]
  await findAll(recovery, node => node.type === harness.ui.Button && node.children === 'decisionRetry')[0].onClick()
  await harness.flush()
  assert.deepEqual(calls[1], ['retry', 'dc-waiting'])
  card = renderedInboxCard(harness)
  recovery = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRecoveryActions')[0]
  findAll(recovery, node => node.type === harness.ui.Button && node.children === 'decisionCancel')[0].onClick()
  assert.equal(calls.some(call => call[0] === 'cancel'), false)
  const dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  assert.ok(dialog)
  const navigation = findAll(harness.render(), node => node['data-decision-primary-nav'] === true)[0]
  assert.ok(navigation)
  assert.equal(navigation.tabIndex, -1)
  assert.equal(dialog.returnFocusFallback, navigation.ref)
  await dialog.onConfirm()
  await harness.flush()
  assert.deepEqual(calls[2], ['cancel', 'dc-waiting'])
  harness.unmount()
})
function openRecords(harness) {
  const button = findAll(harness.render(), node => node.type === harness.ui.Button && node['data-view'] === 'records')[0]
  assert.ok(button)
  button.onClick()
  return harness.flush().then(() => harness.render())
}

function recordFilter(harness, tree, key) {
  const advanced = findAll(tree, node => node.type === harness.ui.Disclosure && node.label === 'decisionMoreFilters')[0]
  const root = ['outcome', 'reasonCode', 'scope', 'feedbackState'].includes(key) ? advanced?.children() : tree
  return findAll(root, node => node['data-filter'] === key)[0]
}

test('record filters expose common controls and advanced choices while preserving all six exact RPC parameters', async () => {
  const calls = []
  const record = { caseId: 'dc-filtered', agentId: 'a', state: 'awaiting_user', request: { questions: [{ id: 'q', question: 'Filtered question' }] } }
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [],
    records: async (filter, cursor) => { calls.push({ filter, cursor }); return { records: [record], nextCursor: null } }, metrics: async () => ({}),
  } })
  await harness.settle()
  let tree = await openRecords(harness)
  assert.ok(recordFilter(harness, tree, 'agentId'))
  assert.ok(recordFilter(harness, tree, 'state'))
  assert.equal(textOf(tree).includes('dc-filtered'), false)
  const values = { agentId: 'a', state: 'awaiting_user', outcome: 'return', reasonCode: 'STALE_EVIDENCE', scope: 'src', feedbackState: 'disputed' }
  for (const [key, value] of Object.entries(values)) {
    tree = harness.render()
    const control = recordFilter(harness, tree, key)
    assert.ok(control, key)
    control.onChange({ target: { value } })
  }
  tree = harness.render()
  findAll(tree, node => node.type === harness.ui.Button && node.children === 'decisionApplyFilters')[0].onClick()
  await harness.flush()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { filter: {}, cursor: undefined })
  assert.deepEqual(calls[1], { filter: values, cursor: undefined })
  harness.unmount()
})

test('record pagination appends and dedupes without replacing the selected detail, with narrow drill-in back navigation', async () => {
  const first = { caseId: 'dc-a', agentId: 'a', state: 'closed', closing: 'answered', createdAt: '2026-01-02T03:04:05.000Z', request: { questions: [{ id: 'q', question: 'Original A' }] } }
  const second = { caseId: 'dc-b', agentId: 'a', state: 'awaiting_user', createdAt: '2026-01-03T03:04:05.000Z', request: { questions: [{ id: 'q', question: 'Record B' }] } }
  const detail = { case: { ...first, decision: { answers: [{ id: 'q', selected: ['Answer A'] }] } }, attempts: [], feedback: [], routeDecisions: [] }
  const calls = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [],
    records: async (filter, cursor) => {
      calls.push({ filter, cursor })
      return cursor ? { records: [{ ...first, request: { questions: [{ id: 'q', question: 'Updated duplicate A' }] } }, second], nextCursor: null } : { records: [first], nextCursor: 'cursor-1' }
    },
    record: async () => detail, metrics: async () => ({}),
  } })
  await harness.settle()
  let tree = await openRecords(harness)
  let rows = findAll(tree, node => node.role === 'button' && node['data-case-id'])
  assert.equal(rows.length, 1)
  // Rows are content-sized divs with button semantics. The scrolling stack
  // keeps them uncompressed (flex: 0 0 auto children — a single-column grid
  // collapsed its auto tracks to min-height under overflow), and the inline
  // display/width keep the row block-level even if a stale CSS chunk loads.
  assert.equal(rows[0].role, 'button')
  assert.equal(rows[0].tabIndex, 0)
  assert.equal(rows[0].style?.display, 'block')
  assert.equal(rows[0].style?.width, '100%')
  assert.equal(textOf(rows[0]).includes('Original A'), true)
  assert.equal(textOf(rows[0]).includes('Tone'), true)
  assert.equal(textOf(rows[0]).includes('2026'), true)
  rows[0].onKeyDown({ key: 'Enter', preventDefault() {} })
  await harness.flush()
  await rows[0].onClick()
  await harness.flush()
  tree = harness.render()
  assert.equal(findAll(tree, node => node['data-record-detail'] === 'dc-a').length, 1)
  assert.equal(findAll(tree, node => node.className === 'weir-da-records-layout')[0]['data-drill-in'], true)
  const more = findAll(tree, node => node.type === harness.ui.Button && node['data-load-more'] === true)[0]
  assert.ok(more)
  await more.onClick()
  await harness.flush()
  tree = harness.render()
  rows = findAll(tree, node => node.role === 'button' && node['data-case-id'])
  assert.deepEqual(rows.map(row => row['data-case-id']), ['dc-a', 'dc-b'])
  assert.equal(textOf(rows[0]).includes('Original A'), true)
  assert.equal(textOf(rows[0]).includes('Updated duplicate A'), false)
  assert.equal(findAll(tree, node => node['data-record-detail'] === 'dc-a').length, 1)
  assert.deepEqual(calls[1], { filter: {}, cursor: { after: 'cursor-1' } })
  assert.equal(findAll(tree, node => node.type === harness.ui.Button && node['data-load-more'] === true).length, 0)
  const back = findAll(tree, node => node.type === harness.ui.Button && node.className === 'weir-da-record-back')[0]
  assert.ok(back)
  back.onClick()
  tree = harness.render()
  assert.equal(findAll(tree, node => node.className === 'weir-da-records-layout')[0]['data-drill-in'], false)
  assert.equal(findAll(tree, node => node['data-record-detail'] === 'dc-a').length, 1)
  harness.unmount()
})

test('a late response for old record filters cannot replace the new filter result', async () => {
  const oldPage = deferred()
  const newPage = deferred()
  let reads = 0
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [],
    records: async () => { reads += 1; return reads === 1 ? oldPage.promise : newPage.promise }, metrics: async () => ({}),
  } })
  await harness.settle()
  let tree = await openRecords(harness)
  recordFilter(harness, tree, 'state').onChange({ target: { value: 'closed' } })
  tree = harness.render()
  findAll(tree, node => node.type === harness.ui.Button && node.children === 'decisionApplyFilters')[0].onClick()
  await Promise.resolve()
  newPage.resolve({ records: [{ caseId: 'dc-new-filter', state: 'closed', request: { questions: [{ question: 'New filter result' }] } }], nextCursor: null })
  await harness.flush()
  oldPage.resolve({ records: [{ caseId: 'dc-old-filter', state: 'awaiting_user', request: { questions: [{ question: 'Old filter result' }] } }], nextCursor: null })
  await harness.flush()
  const rows = findAll(harness.render(), node => node.role === 'button' && node['data-case-id'])
  assert.deepEqual(rows.map(row => row['data-case-id']), ['dc-new-filter'])
  harness.unmount()
})
test('load more uses the applied result-set filter rather than an unapplied draft', async () => {
  const calls = []
  const waiting = caseId => ({ caseId, agentId: 'a', state: 'awaiting_user', request: { questions: [{ id: 'q', question: caseId }] } })
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [],
    records: async (filter, cursor) => {
      calls.push({ filter, cursor })
      return cursor ? { records: [waiting('dc-waiting-2')], nextCursor: null } : { records: [waiting('dc-waiting')], nextCursor: 'cursor-all' }
    },
  } })
  await harness.settle()
  let tree = await openRecords(harness)
  recordFilter(harness, tree, 'state').onChange({ target: { value: 'closed' } })
  tree = harness.render()
  await findAll(tree, node => node.type === harness.ui.Button && node['data-load-more'] === true)[0].onClick()
  await harness.flush()
  assert.deepEqual(calls[1], { filter: {}, cursor: { after: 'cursor-all' } })
  const rows = findAll(harness.render(), node => node.role === 'button' && node['data-case-id'])
  assert.deepEqual(rows.map(row => row['data-case-id']), ['dc-waiting', 'dc-waiting-2'])
  harness.unmount()
})

test('applying filters resets old pagination busy and error state and ignores stale settlement', async () => {
  const stalePage = deferred()
  const calls = []
  const waiting = { caseId: 'dc-waiting', agentId: 'a', state: 'awaiting_user', request: { questions: [{ id: 'q', question: 'Waiting result' }] } }
  const closed = { caseId: 'dc-closed', agentId: 'a', state: 'closed', closing: 'answered', request: { questions: [{ id: 'q', question: 'Closed result' }] } }
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [],
    records: async (filter, cursor) => {
      calls.push({ filter, cursor })
      if (cursor?.after === 'cursor-all') return stalePage.promise
      if (cursor?.after === 'cursor-closed') throw Object.assign(new Error('pagination offline'), { code: 'NETWORK' })
      return filter.state === 'closed' ? { records: [closed], nextCursor: 'cursor-closed' } : { records: [waiting], nextCursor: 'cursor-all' }
    },
  } })
  await harness.settle()
  let tree = await openRecords(harness)
  const oldMore = findAll(tree, node => node.type === harness.ui.Button && node['data-load-more'] === true)[0].onClick()
  tree = harness.render()
  assert.equal(findAll(tree, node => node.type === harness.ui.Button && node['data-load-more'] === true)[0]['aria-busy'], true)

  recordFilter(harness, tree, 'state').onChange({ target: { value: 'closed' } })
  tree = harness.render()
  findAll(tree, node => node.type === harness.ui.Button && node.children === 'decisionApplyFilters')[0].onClick()
  await harness.flush()
  tree = harness.render()
  let more = findAll(tree, node => node.type === harness.ui.Button && node['data-load-more'] === true)[0]
  assert.equal(more.disabled, false)
  assert.equal(more['aria-busy'], false)

  stalePage.resolve({ records: [waiting], nextCursor: 'stale-cursor' })
  await oldMore
  await harness.flush()
  tree = harness.render()
  assert.deepEqual(findAll(tree, node => node.role === 'button' && node['data-case-id']).map(row => row['data-case-id']), ['dc-closed'])
  more = findAll(tree, node => node.type === harness.ui.Button && node['data-load-more'] === true)[0]
  assert.equal(more.disabled, false)
  assert.equal(more['aria-busy'], false)

  await more.onClick()
  await harness.flush()
  assert.equal(textOf(harness.render()).includes('decisionReadFailed'), true)
  tree = harness.render()
  recordFilter(harness, tree, 'state').onChange({ target: { value: 'awaiting_user' } })
  tree = harness.render()
  findAll(tree, node => node.type === harness.ui.Button && node.children === 'decisionApplyFilters')[0].onClick()
  await harness.flush()
  tree = harness.render()
  assert.equal(textOf(tree).includes('decisionReadFailed'), false, 'a new result set clears the old pagination error')
  assert.deepEqual(findAll(tree, node => node.role === 'button' && node['data-case-id']).map(row => row['data-case-id']), ['dc-waiting'])
  assert.ok(calls.some(call => call.filter.state === 'closed' && call.cursor === undefined))
  harness.unmount()
})

test('production record summaries pass the active locale to fallback text', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const record = { caseId: 'dc-unavailable-agent', agentId: 'missing', state: 'closed', closing: 'answered', request: { questions: [] } }
  const harness = await createPageHarness({
    t: key => model.dictionaries.zh[key],
    actions: { agents: async () => [], inbox: async () => [], records: async () => ({ records: [record], nextCursor: null }) },
  })
  await harness.settle()
  const tree = await openRecords(harness)
  const row = findAll(tree, node => node.role === 'button' && node['data-case-id'] === record.caseId)[0]
  const text = textOf(row)
  assert.ok(text.includes('判断记录'))
  assert.ok(text.includes('决策助手'))
  assert.equal(text.includes('Decision assistant'), false)
  assert.equal(text.includes('Decision record'), false)
  harness.unmount()
})

test('Attempt Context Pack details show actual neutral sources and truthful legacy empty states', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({ jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) }));
  const render = attempt => exports.AttemptContextPack({ attempt, t: key => key });
  const actual = JSON.stringify(render({
    attemptId: 'da-new',
    packManifest: {
      layerSizes: { L2: 0, L3: 240, L5: 300 },
      memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: ['dc-neutral'] } },
      omissions: ['L3_EPISODE_OMITTED'],
    },
  }));
  assert.equal(actual.includes('decisionContextPack'), true);
  assert.equal(actual.includes('decisionNeutralEpisodes'), true);
  assert.equal(actual.includes('dc-neutral'), true);
  assert.equal(actual.includes('L3_EPISODE_OMITTED'), true);
  const legacy = JSON.stringify(render({ attemptId: 'da-p1', packManifest: { layerSizes: { L2: 0, L3: 0 }, omissions: [] } }));
  assert.equal(actual.includes('decisionPartitionEmpty'), true);
  assert.equal(actual.includes('decisionPartitionLegacy'), true);
  assert.equal(legacy.includes('decisionPartitionLegacy'), true);
  assert.equal(legacy.includes('dc-neutral'), false);
})
test('Context Pack is an accessible read-only disclosure with ordered sources and exact manifest values', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({ jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) }));
  const rendered = exports.AttemptContextPack({
    attempt: {
      attemptId: 'da-ordered',
      packManifest: {
        layerSizes: { L0: 10, L1: 20, L2: 0, L3: 240, L4: 30, L5: 300 },
        memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: ['dc-new', 'dc-old'] } },
        omissions: ['L3_EPISODE_OMITTED', 'L3_EPISODE_TRUNCATED'],
      },
    },
    t: key => key,
  });
  assert.equal(rendered.type, 'details');
  assert.equal(rendered['data-attempt-context-pack'], 'da-ordered');
  assert.equal(rendered['aria-label'], 'decisionContextPack: da-ordered');
  assert.equal(findAll(rendered, node => node.type === 'summary').length, 1);
  assert.deepEqual(findAll(rendered, node => node.type === 'dt').map(node => node.children), ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
  assert.deepEqual(findAll(rendered, node => node.type === 'dd').map(node => node.children), ['10', '20', '0', '240', '30', '300']);
  const text = JSON.stringify(rendered);
  assert.equal(text.includes('decisionWorkspaceExperience'), true);
  assert.equal(text.includes('decisionPublicMemory'), true);
  assert.equal(text.includes('decisionPartitionEmpty'), true);
  assert.equal(text.includes('decisionNeutralEpisodes'), true);
  assert.equal(text.includes('decisionLayerSizes'), true);
  assert.equal(text.includes('decisionOmissions'), true);
  assert.ok(text.indexOf('dc-new') < text.indexOf('dc-old'));
  assert.ok(text.indexOf('L3_EPISODE_OMITTED') < text.indexOf('L3_EPISODE_TRUNCATED'));
  assert.deepEqual(findAll(rendered, node => ['button', 'input', 'select', 'textarea'].includes(node.type)), []);
});

test('Context Pack renders truthful no-L3, P1 legacy, and missing-manifest empty states', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({ jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) }));
  const attempts = [
    {
      attemptId: 'da-empty',
      packManifest: {
        layerSizes: { L0: 10, L1: 20, L2: 0, L3: 0, L4: 30, L5: 40 },
        memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: [] } },
        omissions: [],
      },
    },
    { attemptId: 'da-p1', packManifest: { layerSizes: { L2: 0, L3: 0 }, omissions: [] } },
    { attemptId: 'da-missing' },
  ];
  for (const attempt of attempts) {
    const rendered = exports.AttemptContextPack({ attempt, t: key => key });
    const text = JSON.stringify(rendered);
    assert.equal(rendered.type, 'details');
    assert.equal(text.includes('decisionNeutralEpisodes'), true, attempt.attemptId);
    assert.equal(text.includes(attempt.attemptId === 'da-empty' ? 'decisionPartitionEmpty' : 'decisionPartitionLegacy'), true, attempt.attemptId);
    assert.equal(text.includes('decisionNoMemory'), false, attempt.attemptId);
    assert.equal(text.includes('dc-invented'), false, attempt.attemptId);
    assert.deepEqual(findAll(rendered, node => node.type === 'ol'), [], attempt.attemptId);
  }
  const legacy = exports.AttemptContextPack({ attempt: attempts[1], t: key => key });
  assert.deepEqual(findAll(legacy, node => node.type === 'dt').map(node => node.children), ['L2', 'L3']);
  assert.deepEqual(findAll(legacy, node => node.type === 'dd').map(node => node.children), ['0', '0']);
  const missing = exports.AttemptContextPack({ attempt: attempts[2], t: key => key });
  assert.deepEqual(findAll(missing, node => node.type === 'dt' || node.type === 'dd'), []);
});

function openAgents(harness) {
  const button = findAll(harness.render(), node => node.type === harness.ui.Button && node['data-view'] === 'agents')[0]
  assert.ok(button)
  button.onClick()
  return harness.flush().then(() => harness.render())
}

function currentAgentEditor(harness) {
  return findAll(harness.render(), node => node.type === 'form' && node['data-agent-editor'])[0]
}

function agentField(harness, name) {
  return findAll(harness.render(), node => node['data-agent-field'] === name)[0]
}

function currentAgentLayout(harness) {
  return findAll(harness.render(), node => node.className === 'weir-da-agents-layout')[0]
}

async function openAssistant(harness, agentId) {
  const summary = findAll(harness.render(), node => node['data-agent-summary'] === agentId)[0]
  assert.ok(summary, `assistant summary ${agentId}`)
  await findAll(summary, node => node['data-action'] === 'open-agent')[0].onClick()
  await harness.flush()
}

function currentLearningInspection(harness) {
  const detail = findAll(harness.render(), node => node['data-agent-detail'] === 'ag_a')[0]
  const learning = findAll(detail, node => node.type === harness.learning.AgentLearning)[0]
  return {
    run: learning?.detail?.inspection?.run?.learningRunId,
    snapshot: learning?.detail?.inspection?.snapshot?.snapshotId ?? null,
  }
}

function learningDiagnosticControl(harness, attribute, value) {
  const detail = findAll(harness.render(), node => node['data-agent-detail'] === 'ag_a')[0]
  const learning = findAll(detail, node => node.type === harness.learning.AgentLearning)[0]
  const advanced = findAll(harness.learning.AgentLearning(learning), node => node.type === harness.ui.Disclosure)[0]
  const control = findAll(advanced.children(), node => node[attribute] === value)[0]
  assert.ok(control, `${attribute} ${value}`)
  return control
}

const assistantDetail = {
  agentId: 'ag_a', name: 'Tone', state: 'enabled', workspaceKey: '/repo',
  userDescription: { revision: 2, text: 'Prefer concise copy' }, generatedDescription: { revision: 0, text: '' },
  scope: { workspaces: ['/repo'], paths: ['src'], authorizationClasses: ['A', 'B'] },
  modelRoute: { chain: [{ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'low' }] },
  descriptionHistory: [{ revision: 1, text: 'Old preference' }, { revision: 2, text: 'Prefer concise copy' }],
  currentSnapshotId: 'ms-current', learningRuns: [{ learningRunId: 'lr-candidate', outcome: 'candidate', revision: 1 }],
  snapshots: [{ snapshotId: 'ms-current', version: 3, state: 'published', revision: 4, learningRunId: 'lr-current' }],
}

test('assistant summaries stay compact and retain pending review without opening detail', async () => {
  const summary = {
    agentId: 'ag_summary', name: 'Summary assistant', state: 'enabled',
    userDescription: { revision: 1, text: 'Use reviewed guidance' },
    currentSnapshotId: 'ms-current', currentSnapshotVersion: 3, pendingReview: true,
  }
  const harness = await createPageHarness({ actions: {
    agents: async () => [summary], inbox: async () => [],
    agent: async () => { throw new Error('list summary must not require an Agent detail read') },
  } })
  await harness.settle()
  const tree = await openAgents(harness)
  const card = findAll(tree, node => node['data-agent-summary'] === 'ag_summary')[0]
  const text = textOf(card)
  assert.equal(text.includes('decisionCurrentSnapshot'), false)
  assert.equal(text.includes('v3'), false)
  assert.ok(text.includes('decisionPendingReview'))
  assert.equal(text.includes('decisionVersionUnavailable'), false)
  assert.equal(text.includes('decisionNoCurrentSnapshot'), false)
  assert.equal(text.includes('decisionPrincipleDetailsOnOpen'), false)
  assert.equal(findAll(card, node => node.className === 'weir-da-agent-summary-preference').length, 1)
  assert.equal(findAll(tree, node => node['data-agent-detail']).length, 0)
  harness.unmount()
})

test('assistant desktop master-detail keeps the compact list beside detail and editor regions', async () => {
  const second = { agentId: 'ag_b', name: 'Second assistant', state: 'disabled', userDescription: { revision: 1, text: 'Review risky changes' } }
  const harness = await createPageHarness({ actions: {
    agents: async () => [assistantDetail, second], inbox: async () => [],
    agent: async id => id === 'ag_a' ? { ...assistantDetail, learningRuns: [], snapshots: [], currentSnapshotId: null } : second,
  } })
  await harness.settle()
  let tree = await openAgents(harness)
  let layout = findAll(tree, node => node.className === 'weir-da-agents-layout')[0]
  assert.ok(layout, 'assistant list and detail have a master-detail layout')
  assert.equal(layout['data-agent-drill-in'], false)
  let list = findAll(layout, node => node.className === 'weir-da-agent-list')[0]
  let detailPane = findAll(layout, node => node.className === 'weir-da-agent-detail-pane')[0]
  assert.ok(list)
  assert.ok(detailPane)
  assert.equal(findAll(list, node => node['data-agent-summary']).length, 2)
  assert.equal(textOf(detailPane).includes('decisionChooseAssistant'), true)
  assert.equal(findAll(tree, node => node['data-action'] === 'create-agent').length, 1)

  const firstSummary = findAll(list, node => node['data-agent-summary'] === 'ag_a')[0]
  await findAll(firstSummary, node => node['data-action'] === 'open-agent')[0].onClick()
  await harness.flush()
  tree = harness.render()
  layout = findAll(tree, node => node.className === 'weir-da-agents-layout')[0]
  list = findAll(layout, node => node.className === 'weir-da-agent-list')[0]
  detailPane = findAll(layout, node => node.className === 'weir-da-agent-detail-pane')[0]
  assert.equal(findAll(list, node => node['data-agent-summary']).length, 2, 'opening detail does not replace the list')
  assert.equal(findAll(list, node => node['data-agent-summary'] === 'ag_a')[0]['data-selected'], true)
  assert.equal(findAll(list, node => node['data-agent-summary'] === 'ag_b')[0]['data-selected'], false)
  assert.equal(findAll(list, node => node['data-agent-detail']).length, 0)
  assert.equal(findAll(detailPane, node => node['data-agent-detail'] === 'ag_a').length, 1)
  assert.equal(findAll(detailPane, node => node['data-agent-summary']).length, 0)

  findAll(detailPane, node => node['data-action'] === 'edit-agent')[0].onClick()
  tree = harness.render()
  layout = findAll(tree, node => node.className === 'weir-da-agents-layout')[0]
  list = findAll(layout, node => node.className === 'weir-da-agent-list')[0]
  detailPane = findAll(layout, node => node.className === 'weir-da-agent-detail-pane')[0]
  assert.equal(findAll(list, node => node['data-agent-summary']).length, 2, 'editing does not replace the list')
  assert.equal(findAll(detailPane, node => node['data-agent-editor'] === 'edit').length, 1)
  assert.equal(findAll(list, node => node['data-agent-editor']).length, 0)
  harness.unmount()
})

test('narrow create Back resumes the exact same draft view-only without rereads', async () => {
  let agentReads = 0
  let listReads = 0
  const harness = await createPageHarness({ actions: {
    agents: async () => { listReads += 1; return [assistantDetail] }, inbox: async () => [],
    agent: async () => { agentReads += 1; return assistantDetail },
  } })
  await harness.settle()
  await openAgents(harness)
  const create = () => findAll(harness.render(), node => node['data-action'] === 'create-agent')[0]
  const layout = () => findAll(harness.render(), node => node.className === 'weir-da-agents-layout')[0]
  create().onClick()
  assert.equal(layout()['data-agent-drill-in'], true)
  agentField(harness, 'name').onChange({ target: { value: 'Unsaved bilingual 草稿' } })
  agentField(harness, 'preference').onChange({ target: { value: 'Keep every exact character: 空格  and punctuation…' } })
  const expectedDraft = { name: 'Unsaved bilingual 草稿', preference: 'Keep every exact character: 空格  and punctuation…' }
  assert.deepEqual({ name: agentField(harness, 'name').value, preference: agentField(harness, 'preference').value }, expectedDraft)
  const readsBefore = { agentReads, listReads }

  const back = findAll(harness.render(), node => node.className === 'weir-da-agent-back')[0]
  assert.ok(back, 'narrow detail has a dedicated Back action')
  back.onClick()
  assert.equal(layout()['data-agent-drill-in'], false)
  assert.deepEqual({ name: agentField(harness, 'name').value, preference: agentField(harness, 'preference').value }, expectedDraft)
  assert.equal(findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog).length, 0)

  create().onClick()
  assert.equal(layout()['data-agent-drill-in'], true)
  assert.deepEqual({ name: agentField(harness, 'name').value, preference: agentField(harness, 'preference').value }, expectedDraft)
  assert.equal(findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog).length, 0)
  assert.deepEqual({ agentReads, listReads }, readsBefore, 'same-create resume performs no authority reread')
  harness.unmount()
})

test('narrow same-assistant Back restores the exact dirty editor without confirmation or reread', async () => {
  const reads = []
  const detail = { ...assistantDetail, learningRuns: [], snapshots: [], currentSnapshotId: null }
  const harness = await createPageHarness({ actions: {
    agents: async () => [assistantDetail], inbox: async () => [],
    agent: async id => { reads.push(id); return detail },
  } })
  await harness.settle()
  await openAgents(harness)
  await openAssistant(harness, 'ag_a')
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], true)
  findAll(harness.render(), node => node['data-action'] === 'edit-agent')[0].onClick()
  agentField(harness, 'name').onChange({ target: { value: 'Tone 未保存 draft' } })
  agentField(harness, 'preference').onChange({ target: { value: 'Exact spacing  and … punctuation' } })
  const expectedDraft = { name: 'Tone 未保存 draft', preference: 'Exact spacing  and … punctuation' }
  const readsBefore = [...reads]

  findAll(harness.render(), node => node.className === 'weir-da-agent-back')[0].onClick()
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], false)
  assert.deepEqual({ name: agentField(harness, 'name').value, preference: agentField(harness, 'preference').value }, expectedDraft)
  await openAssistant(harness, 'ag_a')
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], true)
  assert.deepEqual({ name: agentField(harness, 'name').value, preference: agentField(harness, 'preference').value }, expectedDraft)
  assert.equal(findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog).length, 0)
  assert.deepEqual(reads, readsBefore, 'same-assistant resume does not reread the profile')
  harness.unmount()
})

test('assistant create edit and narrow Back transitions hand off connected visible focus', async () => {
  const detail = { ...assistantDetail, learningRuns: [], snapshots: [], currentSnapshotId: null }
  const reads = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [assistantDetail], inbox: async () => [],
    agent: async id => { reads.push(id); return detail },
  } })
  const active = () => {
    const element = harness.document.activeElement
    assert.equal(element?.isConnected, true, 'transition focus is connected')
    assert.ok(element?.getClientRects().length > 0, 'transition focus is visible')
    return element
  }
  const create = () => findAll(harness.render(), node => node['data-action'] === 'create-agent')[0]
  const back = () => findAll(harness.render(), node => node.className === 'weir-da-agent-back')[0]
  await harness.settle()
  await openAgents(harness)

  create().onClick()
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], true)
  assert.equal(active().id, 'weir-da-agent-name-create', 'Create enters its name field')
  back().onClick()
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], false)
  assert.equal(active().action, 'create-agent', 'Back from create returns to its visible list action')
  create().onClick()
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], true)
  assert.equal(active().id, 'weir-da-agent-name-create', 'same-create resume restores the editor focus')

  back().onClick()
  currentAgentLayout(harness)
  await openAssistant(harness, 'ag_a')
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], true)
  assert.match(active().className, /weir-da-agent-back/, 'list → detail enters the visible narrow detail navigation')
  findAll(harness.render(), node => node['data-action'] === 'edit-agent')[0].onClick()
  assert.equal(agentField(harness, 'name').value, 'Tone')
  assert.equal(active().id, 'weir-da-agent-name-ag_a', 'Edit enters the existing assistant name field')
  const readsBeforeResume = [...reads]
  back().onClick()
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], false)
  const summaryOpen = findAll(harness.render(), node => node['data-agent-summary'] === 'ag_a')[0]
  const open = findAll(summaryOpen, node => node['data-action'] === 'open-agent')[0]
  assert.equal(active(), open.ref?.current, 'Back from edit returns to the same assistant summary action')
  await openAssistant(harness, 'ag_a')
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], true)
  assert.equal(active().id, 'weir-da-agent-name-ag_a', 'same-assistant resume restores its dirty editor focus')
  assert.deepEqual(reads, readsBeforeResume, 'focus handoff adds no same-target authority reread')
  assert.equal(findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog).length, 0)
  harness.unmount()
})

test('successful assistant save hands focus to the resulting connected visible detail', async () => {
  const created = { ...assistantDetail, agentId: 'ag_new', name: 'New assistant', learningRuns: [], snapshots: [], currentSnapshotId: null }
  const harness = await createPageHarness({ actions: {
    agents: async () => [assistantDetail], inbox: async () => [],
    agent: async id => id === 'ag_new' ? created : assistantDetail,
    profileUpsert: async payload => ({ ...created, name: payload.name }),
  } })
  await harness.settle()
  await openAgents(harness)
  findAll(harness.render(), node => node['data-action'] === 'create-agent')[0].onClick()
  agentField(harness, 'name').onChange({ target: { value: 'New assistant' } })
  agentField(harness, 'preference').onChange({ target: { value: 'Prefer short answers' } })
  await currentAgentEditor(harness).onSubmit({ preventDefault() {} })

  // Chromium moves focus to body when the focused editor is removed. Model that
  // native unmount before the component's mounted-region focus effect runs.
  harness.document.activeElement = { isConnected: true, className: '', tagName: 'BODY', getClientRects: () => [1] }
  const tree = harness.render()
  const detail = findAll(tree, node => node['data-agent-detail'] === 'ag_new')[0]
  assert.ok(detail, 'successful save reveals the resulting assistant detail')
  assert.equal(currentAgentEditor(harness), undefined)
  const active = harness.document.activeElement
  assert.equal(active?.isConnected, true, 'save focus is connected')
  assert.ok(active?.getClientRects().length > 0, 'save focus is visible')
  assert.ok(active === detail.ref?.current || /weir-da-agent-back/.test(active?.className ?? ''), 'save focus lands on the resulting detail or its navigation')
  harness.unmount()
})

test('non-dirty editor close hands focus to visible create or resulting detail navigation', async () => {
  const detail = { ...assistantDetail, learningRuns: [], snapshots: [], currentSnapshotId: null }
  const reads = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [detail], inbox: async () => [],
    agent: async id => { reads.push(id); return detail },
  } })
  const bodyFocus = () => { harness.document.activeElement = { isConnected: true, className: '', action: null, tagName: 'BODY', getClientRects: () => [1] } }
  const cancel = () => findAll(currentAgentEditor(harness), node => node.type === harness.ui.Button && node.children === 'decisionCancel')[0].onClick()
  await harness.settle()
  await openAgents(harness)

  findAll(harness.render(), node => node['data-action'] === 'create-agent')[0].onClick()
  cancel()
  bodyFocus()
  let tree = harness.render()
  const createCloseFocus = harness.document.activeElement
  assert.equal(findAll(tree, node => node.type === harness.ui.ConfirmDialog).length, 0, 'non-dirty create close needs no confirmation')

  await openAssistant(harness, 'ag_a')
  findAll(harness.render(), node => node['data-action'] === 'edit-agent')[0].onClick()
  cancel()
  bodyFocus()
  tree = harness.render()
  const editCloseFocus = harness.document.activeElement
  assert.equal(findAll(tree, node => node.type === harness.ui.ConfirmDialog).length, 0, 'non-dirty edit close needs no confirmation')
  assert.equal(currentAgentEditor(harness), undefined)
  assert.deepEqual(reads, ['ag_a'], 'non-dirty close adds no same-target authority reread')

  assert.equal(createCloseFocus?.action, 'create-agent', 'create close returns to its visible create navigation')
  assert.match(editCloseFocus?.className ?? '', /weir-da-agent-back/, 'edit close returns to the resulting assistant detail navigation')
  for (const active of [createCloseFocus, editCloseFocus]) {
    assert.equal(active?.isConnected, true, 'close focus is connected')
    assert.ok(active?.getClientRects().length > 0, 'close focus is visible')
  }
  harness.unmount()
})

test('narrow same-assistant Back preserves the selected learning run and snapshot with zero rereads', async () => {
  const runs = [
    { learningRunId: 'lr-candidate', agentId: 'ag_a', outcome: 'candidate', revision: 5, operations: [], inputFrozen: { parentSnapshotId: 'ms-current' } },
    { learningRunId: 'lr-history', agentId: 'ag_a', outcome: 'published', revision: 3, operations: [], inputFrozen: {} },
    { learningRunId: 'lr-current', agentId: 'ag_a', outcome: 'published', revision: 1, operations: [], inputFrozen: {} },
  ]
  const snapshots = [
    { snapshotId: 'ms-candidate', agentId: 'ag_a', learningRunId: 'lr-candidate', parentSnapshotId: 'ms-current', version: 4, state: 'draft', revision: 6, principles: [] },
    { snapshotId: 'ms-history', agentId: 'ag_a', learningRunId: 'lr-history', version: 2, state: 'published', revision: 4, principles: [] },
    { snapshotId: 'ms-current', agentId: 'ag_a', learningRunId: 'lr-current', version: 3, state: 'published', revision: 4, principles: [] },
  ]
  const detail = { ...assistantDetail, learningRuns: runs, snapshots, currentSnapshotId: 'ms-current' }
  let agentReads = 0
  const runReads = []
  const snapshotReads = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [assistantDetail], inbox: async () => [],
    agent: async () => { agentReads += 1; return detail },
    learningRun: async id => { runReads.push(id); return runs.find(run => run.learningRunId === id) },
    memorySnapshot: async id => { snapshotReads.push(id); return snapshots.find(snapshot => snapshot.snapshotId === id) },
  } })
  await harness.settle()
  await openAgents(harness)
  await openAssistant(harness, 'ag_a')
  await learningDiagnosticControl(harness, 'data-learning-run-id', 'lr-history').onClick()
  await harness.flush()
  assert.deepEqual(currentLearningInspection(harness), { run: 'lr-history', snapshot: 'ms-history' })

  let readsBefore = { agentReads, runReads: [...runReads], snapshotReads: [...snapshotReads] }
  findAll(harness.render(), node => node.className === 'weir-da-agent-back')[0].onClick()
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], false)
  assert.deepEqual(currentLearningInspection(harness), { run: 'lr-history', snapshot: 'ms-history' })
  await openAssistant(harness, 'ag_a')
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], true)
  assert.deepEqual(currentLearningInspection(harness), { run: 'lr-history', snapshot: 'ms-history' })
  assert.deepEqual({ agentReads, runReads, snapshotReads }, readsBefore)

  await learningDiagnosticControl(harness, 'data-snapshot-id', 'ms-current').onClick()
  await harness.flush()
  assert.deepEqual(currentLearningInspection(harness), { run: 'lr-current', snapshot: 'ms-current' })
  readsBefore = { agentReads, runReads: [...runReads], snapshotReads: [...snapshotReads] }
  findAll(harness.render(), node => node.className === 'weir-da-agent-back')[0].onClick()
  await openAssistant(harness, 'ag_a')
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], true)
  assert.deepEqual(currentLearningInspection(harness), { run: 'lr-current', snapshot: 'ms-current' })
  assert.deepEqual({ agentReads, runReads, snapshotReads }, readsBefore)
  harness.unmount()
})

test('narrow different-assistant selection retains dirty confirmation and authoritative reread', async () => {
  const second = { agentId: 'ag_b', name: 'Second assistant', state: 'enabled', userDescription: { revision: 1, text: 'Second preference' }, learningRuns: [], snapshots: [], currentSnapshotId: null }
  const first = { ...assistantDetail, learningRuns: [], snapshots: [], currentSnapshotId: null }
  const reads = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [first, second], inbox: async () => [],
    agent: async id => { reads.push(id); return id === 'ag_a' ? first : second },
  } })
  await harness.settle()
  await openAgents(harness)
  await openAssistant(harness, 'ag_a')
  findAll(harness.render(), node => node['data-action'] === 'edit-agent')[0].onClick()
  agentField(harness, 'name').onChange({ target: { value: 'Dirty first assistant' } })
  findAll(harness.render(), node => node.className === 'weir-da-agent-back')[0].onClick()

  await openAssistant(harness, 'ag_b')
  let dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  assert.ok(dialog, 'a real target change confirms the dirty draft')
  assert.equal(dialog.id, 'weir-da-discard-editor')
  assert.deepEqual(reads, ['ag_a'], 'the new target is not read before confirmation')
  assert.equal(agentField(harness, 'name').value, 'Dirty first assistant')
  dialog.onCancel()
  assert.equal(findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog).length, 0)
  assert.equal(agentField(harness, 'name').value, 'Dirty first assistant')
  assert.deepEqual(reads, ['ag_a'])

  await openAssistant(harness, 'ag_b')
  dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  await dialog.onConfirm()
  await harness.flush()
  assert.deepEqual(reads, ['ag_a', 'ag_b'])
  assert.equal(currentAgentLayout(harness)['data-agent-drill-in'], true)
  assert.equal(currentAgentEditor(harness), undefined)
  assert.equal(findAll(harness.render(), node => node['data-agent-detail'] === 'ag_b').length, 1)
  harness.unmount()
})

test('assistant summaries are read-only and simple create preserves defaults, dirty drafts, and cancel confirmation', async () => {
  const calls = []
  let failSave = true
  const harness = await createPageHarness({ actions: {
    agents: async () => [assistantDetail], inbox: async () => [], records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
    agent: async id => id === 'ag_new' ? { ...assistantDetail, agentId: id, name: 'New assistant', learningRuns: [], snapshots: [], currentSnapshotId: null } : assistantDetail,
    profileUpsert: async payload => { calls.push(payload); if (failSave) throw new Error('save offline'); return { ...assistantDetail, agentId: 'ag_new', name: payload.name } },
  } })
  await harness.settle()
  let tree = await openAgents(harness)
  const summary = findAll(tree, node => node['data-agent-summary'] === 'ag_a')[0]
  assert.ok(summary)
  assert.equal(textOf(summary).includes('Tone'), true)
  assert.equal(textOf(summary).includes('Prefer concise copy'), true)
  assert.equal(textOf(summary).includes('ag_a'), false)
  assert.equal(findAll(summary, node => node.type === 'pre').length, 0)
  findAll(tree, node => node.type === harness.ui.Button && node['data-action'] === 'create-agent')[0].onClick()
  assert.equal(currentAgentEditor(harness)['data-agent-editor'], 'create')
  agentField(harness, 'name').onChange({ target: { value: 'Discard me' } })
  findAll(currentAgentEditor(harness), node => node.type === harness.ui.Button && node.children === 'decisionCancel')[0].onClick()
  let dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  assert.ok(dialog)
  assert.equal(calls.length, 0)
  dialog.onConfirm()
  assert.equal(currentAgentEditor(harness), undefined)
  findAll(harness.render(), node => node.type === harness.ui.Button && node['data-action'] === 'create-agent')[0].onClick()
  agentField(harness, 'name').onChange({ target: { value: 'New assistant' } })
  agentField(harness, 'preference').onChange({ target: { value: 'Prefer short answers' } })
  await currentAgentEditor(harness).onSubmit({ preventDefault() {} })
  await harness.flush()
  assert.equal(calls.length, 1)
  assert.equal(agentField(harness, 'name').value, 'New assistant')
  assert.equal(textOf(harness.render()).includes('decisionFailed'), true)
  failSave = false
  await currentAgentEditor(harness).onSubmit({ preventDefault() {} })
  await harness.flush()
  assert.deepEqual(calls[1], { name: 'New assistant', userDescription: 'Prefer short answers' })
  assert.equal('scope' in calls[1], false)
  assert.equal('modelRoute' in calls[1], false)
  assert.equal(currentAgentEditor(harness), undefined)
  harness.unmount()
})

test('assistant edit keeps simple fields primary and preserves exact advanced scope and model route payload', async () => {
  const calls = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [assistantDetail], inbox: async () => [], agent: async () => ({ ...assistantDetail, learningRuns: [], snapshots: [], currentSnapshotId: null }), records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
    profileUpsert: async payload => { calls.push(payload); return { ...assistantDetail, ...payload } },
  } })
  await harness.settle()
  let tree = await openAgents(harness)
  await findAll(tree, node => node.type === harness.ui.Button && node['data-action'] === 'open-agent')[0].onClick()
  await harness.flush()
  tree = harness.render()
  findAll(tree, node => node.type === harness.ui.Button && node['data-action'] === 'edit-agent')[0].onClick()
  let editor = currentAgentEditor(harness)
  assert.equal(editor['data-agent-editor'], 'edit')
  assert.equal(agentField(harness, 'name').value, 'Tone')
  assert.equal(agentField(harness, 'preference').value, 'Prefer concise copy')
  agentField(harness, 'name').onChange({ target: { value: 'Tone editor' } })
  const advanced = findAll(editor, node => node.type === harness.ui.Disclosure && node.label === 'decisionAdvancedSettings')[0]
  assert.ok(advanced)
  assert.equal(advanced.revealOnOpen, 'end')
  const advancedTree = advanced.children()
  const scope = findAll(advancedTree, node => node['data-agent-field'] === 'scope')[0]
  const route = findAll(advancedTree, node => node['data-agent-field'] === 'modelRoute')[0]
  assert.deepEqual(JSON.parse(scope.value), assistantDetail.scope)
  assert.deepEqual(JSON.parse(route.value), assistantDetail.modelRoute)
  scope.onChange({ target: { value: JSON.stringify({ workspaces: ['/repo'], paths: ['src/decision'], authorizationClasses: ['A'] }) } })
  editor = currentAgentEditor(harness)
  const updatedAdvanced = findAll(editor, node => node.type === harness.ui.Disclosure && node.label === 'decisionAdvancedSettings')[0].children()
  findAll(updatedAdvanced, node => node['data-agent-field'] === 'modelRoute')[0].onChange({ target: { value: JSON.stringify({ chain: [{ provider: 'other', model: 'model-b' }] }) } })
  await currentAgentEditor(harness).onSubmit({ preventDefault() {} })
  await harness.flush()
  assert.deepEqual(calls, [{
    agentId: 'ag_a', name: 'Tone editor', userDescription: 'Prefer concise copy',
    scope: { workspaces: ['/repo'], paths: ['src/decision'], authorizationClasses: ['A'] },
    modelRoute: { chain: [{ provider: 'other', model: 'model-b' }] },
  }])
  harness.unmount()
})

test('assistant state and archive require confirmation, retain history copy, and keep learning in the task detail', async () => {
  const calls = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [assistantDetail], inbox: async () => [], agent: async () => assistantDetail, records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
    profileSetState: async (...args) => { calls.push(args); return { ...assistantDetail, state: args[1] } },
    learningRun: async id => ({ learningRunId: id, agentId: 'ag_a', outcome: 'candidate', inputFrozen: { parentSnapshotId: 'ms-current' }, operations: [] }),
    memorySnapshot: async id => ({ snapshotId: id, agentId: 'ag_a', learningRunId: 'lr-current', state: 'published', revision: 4, principles: [] }),
  } })
  await harness.settle()
  let tree = await openAgents(harness)
  await findAll(tree, node => node.type === harness.ui.Button && node['data-action'] === 'open-agent')[0].onClick()
  await harness.flush()
  tree = harness.render()
  const detail = findAll(tree, node => node['data-agent-detail'] === 'ag_a')[0]
  assert.ok(detail)
  const learningElement = findAll(detail, node => node.type === harness.learning.AgentLearning)[0]
  const learningText = textOf(harness.learning.AgentLearning(learningElement))
  assert.equal(learningText.includes('decisionCurrentSnapshot'), true)
  assert.equal(learningText.includes('decisionPendingReview'), false)
  assert.equal(learningText.includes('ms-current'), false)
  assert.equal(findAll(detail, node => node.type === 'pre').length, 0)
  const advanced = findAll(detail, node => node.type === harness.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0]
  assert.ok(advanced)
  const diagnostics = advanced.children()
  assert.equal(findAll(diagnostics, node => node.type === harness.learning.AgentLearning).length, 0)
  assert.equal(findAll(diagnostics, node => node.type === 'pre').length > 0, true)
  findAll(detail, node => node.type === harness.ui.Button && node['data-agent-state'] === 'disabled')[0].onClick()
  assert.equal(calls.length, 0)
  let dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  await dialog.onConfirm()
  await harness.flush()
  assert.deepEqual(calls[0], ['ag_a', 'disabled'])
  tree = harness.render()
  findAll(tree, node => node.type === harness.ui.Button && node['data-agent-state'] === 'archived')[0].onClick()
  dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  assert.equal(dialog.body, 'decisionArchiveConfirmation')
  await dialog.onConfirm()
  await harness.flush()
  assert.deepEqual(calls[1], ['ag_a', 'archived'])
  harness.unmount()
})
test('advanced metrics load lazily, retry failures, and show readable values with raw values separately disclosed', async () => {
  const raw = {
    window: 'all', since: null, casesOpened: 12, attemptsTotal: 20, autoAnswered: 3, autoAnswerRate: 0.25,
    returnedByCode: { STALE_EVIDENCE: 2 }, escalated: 4, exhausted: 1, cancelled: 2, interrupted: 1,
    evidenceFailures: { stale: 2, conflicting: 1, deleted: 0 }, ratings: { up: 5, down: 1, undone: 1 },
    corrections: 2, reassignments: 3, feedbackParticipation: 6, selectorOffBypasses: 0, meanAttemptLatencyMs: 1500,
  }
  let reads = 0
  const harness = await createPageHarness({ actions: {
    agents: async () => [], inbox: async () => [], records: async () => ({ records: [], nextCursor: null }),
    metrics: async window => { reads += 1; if (reads === 1) throw new Error('metrics offline'); assert.equal(window, 'all'); return raw },
  } })
  await harness.settle()
  assert.equal(reads, 0)
  findAll(harness.render(), node => node.type === harness.ui.Button && node['data-view'] === 'metrics')[0].onClick()
  await harness.flush()
  let tree = harness.render()
  let section = findAll(tree, node => node.type === 'section' && node['data-view'] === 'metrics')[0]
  assert.equal(reads, 1)
  assert.equal(findAll(section, node => node.type === harness.ui.ErrorState).length, 1)
  findAll(section, node => node.type === harness.ui.Button && node.children === 'decisionRetry')[0].onClick()
  await harness.flush()
  tree = harness.render()
  section = findAll(tree, node => node.type === 'section' && node['data-view'] === 'metrics')[0]
  assert.equal(reads, 2)
  const readable = findAll(section, node => node['data-metrics-view'] === true)[0]
  assert.ok(readable)
  const text = textOf(readable)
  for (const value of ['decisionMetricCasesOpened', 'decisionMetricAutoAnswerRate', '25%', '1.5 s', 'decisionRateNotQuality']) assert.equal(text.includes(value), true, value)
  assert.equal(findAll(readable, node => node.type === 'pre' || node.type === 'canvas').length, 0)
  const rawDisclosure = findAll(readable, node => node.type === harness.ui.Disclosure && node.label === 'decisionRawMetrics')[0]
  assert.ok(rawDisclosure)
  assert.equal(findAll(rawDisclosure.children(), node => node.type === 'pre' && node.children === JSON.stringify(raw, null, 2)).length, 1)
  harness.unmount()
})
test('record detail groups prior evaluations, shows truthful memory limits, and hides raw diagnostics until requested', async () => {
  const detail = {
    case: {
      caseId: 'dc-detail', agentId: 'a', state: 'closed', closing: 'answered', feedbackState: 'validated', scope: { workspaces: ['/repo'] },
      request: { questions: [{ id: 'q', question: 'Detailed question' }] }, decision: { attemptId: 'da-new', answers: [{ id: 'q', selected: ['Detailed answer'] }] },
    },
    attempts: [
      { attemptId: 'da-old', attemptNo: 1, outcome: 'return', claims: [{ text: 'Old rationale' }], evidence: [{ evidenceId: 'ev-old', excerpt: 'Old evidence' }] },
      {
        attemptId: 'da-new', attemptNo: 2, outcome: 'answer', claims: [{ text: 'Current rationale' }], evidence: [{ evidenceId: 'ev-new', excerpt: 'Current evidence' }],
        pins: { memorySnapshotId: 'ms-pinned' },
        packManifest: { layerSizes: { L2: 0, L3: 20, L5: 40 }, memory: { L2: { status: 'empty', principleIds: [], items: [] }, L3: { sourceCaseIds: ['dc-history'] } }, omissions: [] },
      },
    ],
    feedback: [
      { kind: 'comment', payload: { text: 'Readable note' } },
      { kind: 'correction', payload: { direction: 'Readable correction' } },
    ],
    routeDecisions: [],
  }
  let openCase = 'dc-detail'
  const harness = await createPageHarness({
    consumeOpenCase: () => { const value = openCase; openCase = null; return value },
    actions: { agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [], record: async () => detail, records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}) },
  })
  const { tree } = await harness.settle()
  const record = findAll(tree, node => node['data-record-detail'] === 'dc-detail')[0]
  const current = findAll(record, node => node['data-current-evidence'] === true)[0]
  assert.ok(current)
  assert.equal(textOf(current).includes('Current evidence'), true)
  assert.equal(textOf(current).includes('Old evidence'), false)
  const history = findAll(record, node => node['data-evaluation-history'] === true)[0]
  assert.ok(history)
  assert.equal(textOf(history).includes('Old rationale'), true)
  assert.equal(textOf(history).includes('Old evidence'), true)
  assert.equal(findAll(history, node => node['data-evaluation-group'] === true).length, 1)
  const defaultText = textOf(record)
  assert.equal(defaultText.includes('decisionPinnedEmpty'), true)
  assert.equal(defaultText.includes('decisionHistoricalNotEvidence'), true)
  assert.equal(defaultText.includes('Readable note'), true)
  assert.equal(defaultText.includes('Readable correction'), true)
  for (const technical of ['da-old', 'da-new', 'ev-old', 'ev-new', 'dc-history', 'ms-pinned']) assert.equal(defaultText.includes(technical), false, technical)
  assert.equal(findAll(record, node => node.type === 'pre').length, 0)
  const advanced = findAll(record, node => node.type === harness.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0]
  assert.ok(advanced)
  assert.equal(advanced.revealOnOpen, 'end')
  const routeDisclosure = findAll(record, node => node.type === harness.ui.Disclosure && node.label === 'decisionRouteHistory')[0]
  assert.equal(routeDisclosure.revealOnOpen, 'end')
  const diagnostics = advanced.children()
  assert.equal(findAll(diagnostics, node => node.type === 'pre' && node.children === JSON.stringify(detail, null, 2)).length, 1)
  assert.deepEqual(findAll(diagnostics, node => node['data-attempt-context-pack']).map(node => node['data-attempt-context-pack']), ['da-old', 'da-new'])
  assert.equal(findAll(diagnostics, node => node['data-attempt-context-pack'] && node.revealOnOpen !== undefined).length, 0, 'nested Context Packs have no second reveal mechanism')
  assert.equal(textOf(diagnostics).includes('dc-history'), true)
  harness.unmount()
})

test('record feedback is state-aware and note and correction drafts submit independently with exact RPC arguments', async () => {
  const scope = { workspaces: ['/repo'], paths: ['src'] }
  const detail = {
    case: { caseId: 'dc-feedback', agentId: 'a', state: 'closed', closing: 'answered', feedbackState: 'none', scope, request: { questions: [{ id: 'q', question: 'Feedback question' }] }, decision: { answers: [{ id: 'q', selected: ['A'] }] } },
    attempts: [], feedback: [], routeDecisions: [],
  }
  const calls = []
  let openCase = 'dc-feedback'
  const harness = await createPageHarness({
    consumeOpenCase: () => { const value = openCase; openCase = null; return value },
    actions: {
      agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [], record: async () => detail, records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
      feedback: async (...args) => { calls.push(['feedback', ...args]); return {} }, correction: async (...args) => { calls.push(['correction', ...args]); return {} },
    },
  })
  await harness.settle()
  let record = findAll(harness.render(), node => node['data-record-detail'] === 'dc-feedback')[0]
  assert.equal(findAll(record, node => node['data-feedback'] === 'rating_up').length, 1)
  assert.equal(findAll(record, node => node['data-feedback'] === 'rating_down').length, 1)
  assert.equal(findAll(record, node => String(node['data-feedback'] ?? '').startsWith('undo_')).length, 0)
  findAll(record, node => node['data-draft'] === 'comment')[0].onChange({ target: { value: 'A note' } })
  record = findAll(harness.render(), node => node['data-record-detail'] === 'dc-feedback')[0]
  findAll(record, node => node['data-draft'] === 'correction')[0].onChange({ target: { value: 'Use B' } })
  record = findAll(harness.render(), node => node['data-record-detail'] === 'dc-feedback')[0]
  assert.equal(findAll(record, node => node['data-draft'] === 'comment')[0].value, 'A note')
  assert.equal(findAll(record, node => node['data-draft'] === 'correction')[0].value, 'Use B')
  assert.equal(textOf(record).includes('decisionCorrectionFutureOnly'), true)
  await findAll(record, node => node['data-action'] === 'comment')[0].onClick()
  await harness.flush()
  assert.deepEqual(calls[0], ['feedback', 'dc-feedback', 'comment', 'A note'])
  record = findAll(harness.render(), node => node['data-record-detail'] === 'dc-feedback')[0]
  assert.equal(findAll(record, node => node['data-draft'] === 'comment')[0].value, '')
  assert.equal(findAll(record, node => node['data-draft'] === 'correction')[0].value, 'Use B')
  await findAll(record, node => node['data-action'] === 'correction')[0].onClick()
  await harness.flush()
  assert.deepEqual(calls[1], ['correction', 'dc-feedback', 'Use B', scope, ['dc-feedback']])
  harness.unmount()
})
test('record detail is a readable projection without default raw JSON or internal identifiers', async () => {
  const detail = {
    case: {
      caseId: 'dc-record', agentId: 'a', state: 'closed', closing: 'answered', feedbackState: 'none', scope: {},
      request: { questions: [{ id: 'q', question: 'Which title is clearest?' }] },
      decision: { answers: [{ id: 'q', selected: ['A clear title'] }], hint: 'It names the outcome' },
    },
    attempts: [
      { attemptId: 'da-one', claims: [{ text: 'Old rationale' }], evidence: [{ evidenceId: 'ev-old', excerpt: 'Old evidence' }] },
      { attemptId: 'da-two', claims: [{ text: 'Current rationale' }], evidence: [{ evidenceId: 'ev-new', excerpt: 'Current evidence' }] },
    ],
    feedback: [], routeDecisions: [],
  }
  let openCase = 'dc-record'
  const harness = await createPageHarness({
    consumeOpenCase: () => { const value = openCase; openCase = null; return value },
    actions: {
      agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [],
      record: async () => detail, records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
    },
  })
  const { tree } = await harness.settle()
  const record = findAll(tree, node => node['data-record-detail'] === 'dc-record')[0]
  assert.ok(record)
  const text = textOf(record)
  for (const value of ['Which title is clearest?', 'A clear title', 'It names the outcome', 'Current evidence']) assert.equal(text.includes(value), true, value)
  for (const value of ['dc-record', 'da-one', 'da-two', 'ev-old', 'ev-new']) assert.equal(text.includes(value), false, value)
  assert.equal(findAll(record, node => node.type === 'pre').length, 0)
  harness.unmount()
})
test('inbox loading, failure, retry, and empty states are local to the inbox view', async () => {
  let reads = 0
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Available assistant', state: 'enabled' }],
    inbox: async () => { reads += 1; if (reads === 1) throw Object.assign(new Error('offline'), { code: 'NETWORK' }); return [] },
    records: async () => ({ records: [], nextCursor: null }),
    metrics: async () => ({}),
  } })
  const { first } = await harness.settle()
  assert.equal(findAll(first, node => node.type === harness.ui.LoadingState).length > 0, true)
  let tree = harness.render()
  const inbox = findAll(tree, node => node.type === 'section' && node['data-view'] === 'inbox')[0]
  assert.equal(findAll(inbox, node => node.type === harness.ui.ErrorState).length, 1)
  assert.equal(textOf(inbox).includes('decisionReadFailed'), true)
  findAll(inbox, node => node.type === harness.ui.Button && node.children === 'decisionRetry')[0].onClick()
  await harness.flush()
  tree = harness.render()
  const retried = findAll(tree, node => node.type === 'section' && node['data-view'] === 'inbox')[0]
  assert.equal(findAll(retried, node => node.type === harness.ui.EmptyState).length, 1)
  assert.equal(textOf(retried).includes('decisionInboxEmpty'), true)
  assert.equal(reads, 2)
  harness.unmount()
})

test('records and advanced metrics use the no-session empty state without issuing reads', async () => {
  const calls = []
  const harness = await createPageHarness({ sessionId: null, actions: {
    agents: async () => { calls.push('agents'); return [] }, inbox: async () => { calls.push('inbox'); return [] },
    records: async () => { calls.push('records'); return { records: [], nextCursor: null } }, metrics: async () => { calls.push('metrics'); return {} },
  } })
  await harness.settle()
  for (const view of ['records', 'metrics']) {
    findAll(harness.render(), node => node.type === harness.ui.Button && node['data-view'] === view)[0].onClick()
    await harness.flush()
    const section = findAll(harness.render(), node => node.type === 'section' && node['data-view'] === view)[0]
    assert.equal(textOf(section).includes('decisionNoSession'), true, view)
    assert.equal(findAll(section, node => node.type === harness.ui.LoadingState).length, 0, view)
  }
  assert.deepEqual(calls, [])
  harness.unmount()
})
function routingSummary(patch = {}) {
  return { agreement: 0, disagreement: 0, shadowNone: 0, shadowAmbiguous: 0, shadowFailure: 0, autoNone: 0, autoAmbiguous: 0, autoFailure: 0, manualReassign: 0, uncomparable: 0, ...patch }
}
function routingItem(caseId, patch = {}) {
  return { caseId, routeDecisionId: `rd-${caseId}`, mode: 'auto_shadow', outcome: 'agreement', questionSummary: `Question ${caseId}`, createdAt: '2026-01-02T03:04:05.000Z', record: { caseId }, ...patch }
}
async function openMetrics(harness) {
  findAll(harness.render(), node => node.type === harness.ui.Button && node['data-view'] === 'metrics')[0].onClick()
  await harness.flush()
  return harness.render()
}
function routingCases(tree) {
  return findAll(tree, node => node['data-routing-case']).map(node => node['data-routing-case'])
}

test('advanced metrics include ordinary-language routing diagnostics and authorized record navigation only', async () => {
  const calls = []
  const first = routingItem('dc-agree')
  const second = routingItem('dc-failed', { mode: 'auto', outcome: 'auto_failure', reason: 'failure:timeout' })
  const detail = { case: { caseId: 'dc-agree', agentId: 'a', state: 'closed', closing: 'answered', request: { questions: [{ id: 'q', question: 'Authorized detail' }] }, decision: { answers: [] } }, attempts: [], feedback: [], routeDecisions: [first] }
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [],
    metrics: async () => ({ window: 'all', casesOpened: 2 }),
    routingReview: async (window, cursor) => { calls.push(['review', window, cursor]); return { window, summary: routingSummary({ agreement: 1, autoFailure: 1 }), items: [first, second], nextCursor: null } },
    record: async caseId => { calls.push(['record', caseId]); return detail }, records: async () => ({ records: [detail.case], nextCursor: null }),
  } })
  await harness.settle()
  assert.equal(calls.length, 0)
  let tree = await openMetrics(harness)
  assert.deepEqual(calls, [['review', 'all', undefined]])
  const review = findAll(tree, node => node['data-routing-review'] === true)[0]
  assert.ok(review)
  const text = textOf(review)
  for (const value of ['decisionRoutingReview', 'decisionRoutingDiagnostic', 'decisionRoutingAgreement', 'decisionRoutingAutoFailure', 'Question dc-agree', 'decisionRoutingShown']) assert.equal(text.includes(value), true, value)
  assert.equal(text.includes('failure:timeout'), false)
  assert.equal(text.includes('decisionAdopt') || text.includes('decisionIgnore'), false)
  const windowControl = findAll(review, node => node['data-routing-window'] === true)[0]
  assert.equal(windowControl.value, 'all')
  assert.equal(windowControl['aria-label'], 'decisionMetricWindow')
  const link = findAll(review, node => node['data-routing-record'] === 'dc-agree')[0]
  assert.match(link['aria-label'], /decisionRoutingOpenRecord/)
  assert.match(link['aria-label'], /Question dc-agree/)
  await link.onClick()
  await harness.flush()
  tree = harness.render()
  assert.equal(calls.some(call => call[0] === 'record' && call[1] === 'dc-agree'), true)
  assert.equal(findAll(tree, node => node['data-record-detail'] === 'dc-agree').length, 1)
  const nav = findAll(tree, node => node.type === 'nav' && node['data-decision-primary-nav'] === true)[0]
  assert.deepEqual(findAll(nav, node => node.type === harness.ui.Button).map(node => node['data-view']), ['inbox', 'records', 'agents'])
  harness.unmount()
})

test('routing review appends once, dedupes only repeated RouteDecisions, and retains same-Case history', async () => {
  const first = routingItem('dc-a', { questionSummary: 'Original A' })
  const second = routingItem('dc-b', { outcome: 'manual_reassign', mode: 'manual_reassign' })
  const firstPage = [first, ...Array.from({ length: 19 }, (_, index) => routingItem(`dc-page-${index}`))]
  const gate = deferred()
  const calls = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [], inbox: async () => [], metrics: async () => ({}),
    routingReview: async (window, cursor) => {
      calls.push({ window, cursor })
      if (!cursor) return { window, summary: routingSummary({ agreement: 20 }), items: firstPage, nextCursor: 'cursor-1' }
      return gate.promise
    },
  } })
  await harness.settle()
  let tree = await openMetrics(harness)
  assert.equal(routingCases(tree).length, 20)
  const more = findAll(tree, node => node['data-routing-load-more'] === true)[0]
  assert.equal(more['aria-busy'], false)
  const firstRead = more.onClick()
  const duplicateRead = more.onClick()
  tree = harness.render()
  assert.equal(findAll(tree, node => node['data-routing-load-more'] === true)[0]['aria-busy'], true)
  assert.equal(calls.length, 2)
  gate.resolve({ window: 'all', summary: routingSummary({ agreement: 21, manualReassign: 1 }), items: [{ ...first, questionSummary: 'Updated duplicate A' }, { ...first, routeDecisionId: 'rd-a-shadow', questionSummary: 'Shadow A' }, second], nextCursor: null })
  await Promise.all([firstRead, duplicateRead])
  await harness.flush()
  tree = harness.render()
  assert.deepEqual(routingCases(tree), [...firstPage.map(item => item.caseId), 'dc-a', 'dc-b'])
  assert.equal(textOf(tree).includes('Original A'), true)
  assert.equal(textOf(tree).includes('Updated duplicate A'), false)
  assert.equal(textOf(tree).includes('Shadow A'), true)
  assert.deepEqual(calls[1], { window: 'all', cursor: 'cursor-1' })
  assert.equal(findAll(tree, node => node['data-routing-load-more'] === true).length, 0)
  assert.match(textOf(findAll(tree, node => node['data-routing-status'] === true)[0]), /22/)
  harness.unmount()
})

test('routing review retains loaded items on append failure and has explicit retry, empty, and no-data states', async () => {
  const first = routingItem('dc-kept')
  let initialFails = true
  let appendFails = true
  const harness = await createPageHarness({ actions: {
    agents: async () => [], inbox: async () => [], metrics: async () => ({}),
    routingReview: async (window, cursor) => {
      if (initialFails) { initialFails = false; throw Object.assign(new Error('offline'), { code: 'NETWORK' }) }
      if (!cursor) return { window, summary: routingSummary(), items: [first], nextCursor: 'next' }
      if (appendFails) { appendFails = false; throw new Error('append offline') }
      return { window, summary: routingSummary(), items: [], nextCursor: null }
    },
  } })
  await harness.settle()
  let tree = await openMetrics(harness)
  let review = findAll(tree, node => node['data-routing-review'] === true)[0]
  assert.equal(findAll(review, node => node.type === harness.ui.ErrorState).length, 1)
  findAll(review, node => node.type === harness.ui.Button && node.children === 'decisionRetry')[0].onClick()
  await harness.flush()
  tree = harness.render()
  assert.deepEqual(routingCases(tree), ['dc-kept'])
  await findAll(tree, node => node['data-routing-load-more'] === true)[0].onClick()
  await harness.flush()
  tree = harness.render()
  assert.deepEqual(routingCases(tree), ['dc-kept'])
  review = findAll(tree, node => node['data-routing-review'] === true)[0]
  assert.equal(textOf(review).includes('decisionReadFailed'), true)
  findAll(review, node => node.type === harness.ui.Button && node.children === 'decisionRetry')[0].onClick()
  await harness.flush()
  assert.equal(findAll(harness.render(), node => node['data-routing-load-more'] === true).length, 0)

  const empty = await createPageHarness({ actions: {
    agents: async () => [], inbox: async () => [], metrics: async () => ({}),
    routingReview: async window => ({ window, summary: routingSummary(), items: [], nextCursor: null }),
  } })
  await empty.settle()
  tree = await openMetrics(empty)
  review = findAll(tree, node => node['data-routing-review'] === true)[0]
  assert.equal(textOf(review).includes('decisionRoutingNoData'), true)
  assert.equal(findAll(review, node => node.type === 'pre').length, 0)
  empty.unmount()
  harness.unmount()
})

test('late routing responses cannot replace a newer window or session epoch', async () => {
  const oldWindow = deferred()
  const harness = await createPageHarness({ actions: {
    agents: async () => [], inbox: async () => [], metrics: async () => ({}),
    routingReview: async window => window === 'all' ? oldWindow.promise : { window, summary: routingSummary(), items: [routingItem('dc-seven-day')], nextCursor: null },
  } })
  await harness.settle()
  let tree = await openMetrics(harness)
  findAll(tree, node => node['data-routing-window'] === true)[0].onChange({ target: { value: '7d' } })
  await harness.flush()
  assert.deepEqual(routingCases(harness.render()), ['dc-seven-day'])
  oldWindow.resolve({ window: 'all', summary: routingSummary(), items: [routingItem('dc-old-window')], nextCursor: null })
  await harness.flush()
  assert.deepEqual(routingCases(harness.render()), ['dc-seven-day'])
  harness.unmount()

  const oldSession = deferred()
  const sessions = await createPageHarness({ sessionId: 'old', actionsForSession: sessionId => ({
    agents: async () => [], inbox: async () => [], metrics: async () => ({}),
    routingReview: async window => sessionId === 'old' ? oldSession.promise : { window, summary: routingSummary(), items: [routingItem('dc-new-session')], nextCursor: null },
  }) })
  await sessions.settle()
  await openMetrics(sessions)
  sessions.update({ sessionId: 'new' })
  sessions.render()
  await sessions.flush()
  await openMetrics(sessions)
  assert.deepEqual(routingCases(sessions.render()), ['dc-new-session'])
  oldSession.resolve({ window: 'all', summary: routingSummary(), items: [routingItem('dc-old-session')], nextCursor: null })
  await sessions.flush()
  assert.deepEqual(routingCases(sessions.render()), ['dc-new-session'])
  sessions.unmount()
})

test('unowned inbox keeps answer, reassign, and cancel while retry appears only after authoritative reassign', async () => {
  const original = { ...waitingFixture(), caseId: 'dc-inbox-unowned', agentId: null, awaitingReason: 'no_route', escalation: { missing: [], suggestion: [], perQuestion: [] } }
  const auto = { routeDecisionId: 'rd-inbox-auto', mode: 'auto', chosen: null, reason: 'none:no_candidates', createdAt: '2026-01-02T03:04:05.000Z' }
  let current = original
  let routes = [auto]
  const harness = await createPageHarness({ actions: {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }, { agentId: 'b', name: 'Second', state: 'enabled' }],
    inbox: async () => [current],
    record: async () => ({ case: current, attempts: [], feedback: [], routeDecisions: routes }),
    reassign: async () => {
      current = { ...current, agentId: 'b', awaitingReason: 'authority' }
      routes = [...routes, { routeDecisionId: 'rd-inbox-manual', mode: 'manual_reassign', chosen: 'b', reason: '', createdAt: '2026-01-02T03:05:05.000Z' }]
      return {}
    },
    records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
  } })
  await harness.settle()
  let card = renderedInboxCard(harness, harness.render(), original.caseId)
  assert.ok(findAll(card, node => node.type === harness.ui.DecisionAnswers)[0])
  assert.equal(textOf(card).includes('decisionNoAssignedAgent'), true)
  let recoveryTree = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRecoveryActions')[0].children
  assert.ok(findAll(recoveryTree, node => node.children === 'decisionReassign')[0])
  assert.ok(findAll(recoveryTree, node => node.children === 'decisionCancel')[0])
  assert.equal(findAll(recoveryTree, node => node.children === 'decisionRetry').length, 0)
  let history = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRouteHistory')[0]
  assert.ok(history)
  history.onOpen()
  await harness.flush()
  card = renderedInboxCard(harness, harness.render(), original.caseId)
  history = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRouteHistory')[0]
  let historyView = findAll(history.children(), node => node.type === harness.ui.DecisionRouteHistory)[0]
  assert.deepEqual(historyView.history.map(item => item.mode), ['auto'])

  recoveryTree = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRecoveryActions')[0].children
  findAll(recoveryTree, node => node.type === 'select')[0].onChange({ target: { value: 'b' } })
  card = renderedInboxCard(harness, harness.render(), original.caseId)
  recoveryTree = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRecoveryActions')[0].children
  await findAll(recoveryTree, node => node.children === 'decisionReassign')[0].onClick()
  await harness.flush()
  card = renderedInboxCard(harness, harness.render(), original.caseId)
  assert.equal(textOf(card).includes('Second'), true)
  recoveryTree = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRecoveryActions')[0].children
  assert.ok(findAll(recoveryTree, node => node.children === 'decisionRetry')[0])
  history = findAll(card, node => node.type === harness.ui.Disclosure && node.label === 'decisionRouteHistory')[0]
  historyView = findAll(history.children(), node => node.type === harness.ui.DecisionRouteHistory)[0]
  assert.deepEqual(historyView.history.map(item => item.mode), ['auto', 'manual_reassign'])
  harness.unmount()
})

test('unowned record detail hides Agent feedback and correction but retains no-Evidence truth and read-only RouteDecision history', async () => {
  const auto = { routeDecisionId: 'rd-record-auto', mode: 'auto', chosen: null, reason: 'none:no_candidates', createdAt: '2026-01-02T03:04:05.000Z' }
  const detail = {
    case: { caseId: 'dc-record-unowned', agentId: null, state: 'closed', closing: 'escalated', feedbackState: 'none', request: { questions: [{ id: 'q', question: 'Unowned question' }] }, decision: { kind: 'user_decision', answers: [{ id: 'q', selected: ['User answer'] }] } },
    attempts: [], feedback: [], routeDecisions: [auto],
  }
  let openCase = detail.case.caseId
  const harness = await createPageHarness({
    consumeOpenCase: () => { const value = openCase; openCase = null; return value },
    actions: { agents: async () => [], inbox: async () => [], record: async () => detail, records: async () => ({ records: [detail.case], nextCursor: null }), metrics: async () => ({}) },
  })
  const { tree } = await harness.settle()
  const record = findAll(tree, node => node['data-record-detail'] === detail.case.caseId)[0]
  assert.ok(record)
  assert.equal(textOf(record).includes('User answer'), true)
  assert.equal(textOf(record).includes('decisionNoAssignedAgent'), true)
  assert.equal(textOf(record).includes('decisionRoutingAutoNone'), true)
  assert.equal(findAll(record, node => node['data-feedback'] || ['comment', 'correction', 'retry'].includes(node['data-action'])).length, 0)
  assert.equal(findAll(record, node => node['data-draft'] === 'comment' || node['data-draft'] === 'correction').length, 0)
  assert.equal(textOf(findAll(record, node => node['data-current-evidence'] === true)[0]).includes('decisionNoEvidence'), true)
  const history = findAll(record, node => node.type === harness.ui.Disclosure && node.label === 'decisionRouteHistory')[0]
  assert.ok(history)
  const historyView = findAll(history.children(), node => node.type === harness.ui.DecisionRouteHistory)[0]
  assert.equal(historyView.history.length, 1)
  assert.equal(historyView.history[0].statusKey, 'decisionRouteStatusNone')
  assert.equal(findAll(history.children(), node => node.type === 'button' || node.type === 'input').length, 0)
  harness.unmount()
})

test('client manifest injects layout for render-time panel access', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
})

test('same-assistant Snapshot reload keeps the detail mounted and clamps the settled scroll to the new maximum', async () => {
  // Real 7.3 run FuiXDF (uiux-acceptance.json, snapshotPublish-v1) measured
  // main.weir-da-page at a 900px viewport height: scrollTop 811.5 with scrollHeight
  // 4019 before and during the confirmation, then a composition frame at
  // scrollHeight 900 (the whole assistant detail unmounted) that let the browser
  // clamp scrollTop to 0, and 1093 once the publish removed the candidate review.
  // The reload must keep the previous detail mounted so the only clamp is the
  // intended 1093 - 900 = 193.
  const VIEWPORT = 900
  const REVIEW_CONTENT = 4019
  const SETTLED_CONTENT = 1093
  const candidateRun = { learningRunId: 'lr_candidate', outcome: 'candidate', revision: 4 }
  const currentRun = { learningRunId: 'lr_current', outcome: 'published', revision: 5 }
  const beforePublish = {
    agentId: 'ag_a', name: 'Tone', state: 'enabled', workspaceKey: '/repo',
    userDescription: { revision: 2, text: 'Prefer concise copy' }, generatedDescription: { revision: 0, text: '' },
    scope: { workspaces: ['/repo'], paths: ['src'] }, modelRoute: { chain: [] },
    currentSnapshotId: 'ms_current',
    learningRuns: [candidateRun, currentRun],
    snapshots: [
      { snapshotId: 'ms_candidate', state: 'draft', version: 4, revision: 9, learningRunId: 'lr_candidate', parentSnapshotId: 'ms_current' },
      { snapshotId: 'ms_current', state: 'published', version: 3, revision: 11, learningRunId: 'lr_current', parentSnapshotId: null },
    ],
  }
  const afterPublish = {
    ...beforePublish,
    currentSnapshotId: 'ms_candidate',
    learningRuns: [{ ...candidateRun, outcome: 'published', revision: 6 }, currentRun],
    snapshots: [
      { ...beforePublish.snapshots[0], state: 'published', version: 4, revision: 10 },
      beforePublish.snapshots[1],
    ],
  }
  let currentAgent = beforePublish
  let agentReads = 0
  const reload = deferred()
  const harness = await createPageHarness({ actions: {
    agents: async () => [beforePublish],
    inbox: async () => [],
    agent: async () => {
      agentReads += 1
      return agentReads === 1 ? beforePublish : reload.promise
    },
    learningRun: async id => {
      const summary = currentAgent.learningRuns.find(run => run.learningRunId === id) ?? currentRun
      return {
        learningRunId: id, agentId: 'ag_a', outcome: summary.outcome, revision: summary.revision, operations: [],
        inputFrozen: id === 'lr_candidate' ? { parentSnapshotId: 'ms_current', parentSnapshotRevision: 11 } : { parentSnapshotId: null },
        replay: { passed: true },
      }
    },
    memorySnapshot: async id => {
      const summary = currentAgent.snapshots.find(snapshot => snapshot.snapshotId === id)
      const principleId = id === 'ms_current' ? 'pr_old' : 'pr_new'
      return { ...summary, agentId: 'ag_a', principles: [{ principleId, text: principleId, scope: {}, sources: [], state: 'active' }] }
    },
    snapshotPublish: async () => { currentAgent = afterPublish; return { snapshotId: 'ms_candidate' } },
    publicMemoryRefresh: async () => null,
    publicCandidate: async () => null,
  } })
  // The measured page is 4019px while the candidate review renders its diff and
  // 1093px once the publish removes it. A pending same-assistant reload can only
  // replace that diff with a loading placeholder, so the page height stays between
  // those measurements; only an unmounted detail drops it to the 900px viewport of
  // the collapse frame, which is what clamped scrollTop to 0.
  const learningTree = tree => {
    const detail = findAll(tree, node => node['data-agent-detail'] === 'ag_a')[0]
    const element = detail ? findAll(detail, node => node.type === harness.learning.AgentLearning)[0] : null
    return element ? harness.learning.AgentLearning(element) : null
  }
  const contentHeight = tree => {
    if (findAll(tree, node => node['data-agent-detail'] === 'ag_a').length === 0) return VIEWPORT
    const learning = learningTree(tree)
    return learning && findAll(learning, node => node['data-principle-change']).length > 0 ? REVIEW_CONTENT : SETTLED_CONTENT
  }
  const clampScroll = (scrollTop, tree) => Math.min(scrollTop, Math.max(0, contentHeight(tree) - VIEWPORT))
  const learningText = tree => textOf(learningTree(tree))

  let tree = await openAgents(harness)
  await findAll(tree, node => node.type === harness.ui.Button && node['data-action'] === 'open-agent')[0].onClick()
  await harness.flush()
  tree = harness.render()
  assert.equal(findAll(tree, node => node['data-agent-detail'] === 'ag_a').length, 1)
  assert.equal(learningText(tree).includes('decisionPrincipleVersion 3'), true)
  let scrollTop = clampScroll(811.5, tree)
  assert.equal(scrollTop, 811.5)

  await findAll(learningTree(tree), node => node.type === harness.ui.Button && node['data-action'] === 'learning-publish')[0].onClick()
  tree = harness.render()
  const dialog = findAll(tree, node => node.type === harness.ui.ConfirmDialog && node.id === 'weir-da-learning-publish')[0]
  assert.ok(dialog, 'the confirmed publish asks first')
  const confirmation = dialog.onConfirm()
  await harness.flush()
  tree = harness.render()
  assert.equal(agentReads, 2, 'the confirmed publish rereads the same assistant')
  assert.equal(findAll(tree, node => node['data-agent-detail'] === 'ag_a').length, 1, 'the pending reload keeps the detail mounted instead of a viewport-height LoadingState frame')
  assert.equal(learningText(tree).includes('decisionPrincipleVersion 3'), true, 'the previous assistant stays rendered until the fresh value arrives')
  const pendingPublish = findAll(learningTree(tree), node => node.type === harness.ui.Button && node['data-action'] === 'learning-publish')[0]
  assert.ok(pendingPublish)
  assert.equal(pendingPublish.disabled, true, 'the previous review cannot publish again while the reload is in flight')
  scrollTop = clampScroll(scrollTop, tree)
  assert.ok(scrollTop >= SETTLED_CONTENT - VIEWPORT, 'the pending reload keeps at least the settled maximum instead of clamping to 0')
  assert.ok(scrollTop <= 811.5, 'the pending reload never moves the preserved position down')

  reload.resolve(afterPublish)
  await confirmation
  await harness.flush()
  tree = harness.render()
  assert.equal(findAll(tree, node => node['data-agent-detail'] === 'ag_a').length, 1)
  assert.equal(findAll(tree, node => node['data-candidate-review'] === true).length, 0, 'the published candidate review is gone')
  assert.equal(learningText(tree).includes('decisionPrincipleVersion 4'), true, 'the fresh authoritative value replaced the previous one')
  scrollTop = clampScroll(scrollTop, tree)
  assert.equal(scrollTop, 193, 'the settled content shrinks to the new maximum instead of staying at 0')
  harness.unmount()
})
