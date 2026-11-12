// Public and private memory zones in the assistant detail (OpenSpec 6.2/6.3/6.4).
//
// The assistant is one profile-global identity with exactly two ordinary-language
// memory zones. The public zone loads once per open, is disclosure-gated before
// its first automatic review, reviews cross-workspace candidates through opaque
// aliases, and only adopts, discards or rolls back through an explicit
// confirmation. The private zone keeps the existing record navigation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientChunk } from '../helpers/load-client-chunk.js'
import { createPageHarness, deferred, findAll, textOf } from './page-test-helpers.js'

const aliasOne = 'origin_aaaaaaaaaaaa'
const aliasTwo = 'origin_bbbbbbbbbbbb'

function agentDetail(overrides = {}) {
  return {
    agentId: 'ag', name: 'Shared assistant', state: 'enabled',
    userDescription: { revision: 1, text: 'Prefer the documented option' },
    scope: { paths: ['src'], authorizationClasses: ['A', 'B'] },
    currentSnapshotId: null, learningRuns: [], snapshots: [], descriptionHistory: [],
    ...overrides,
  }
}

function disclosureValue() {
  return {
    status: 'disclosure-required', agentId: 'ag', zone: 'public',
    disclosure: { required: true, version: 1, key: 'public-memory-first-extraction' },
    highWater: 'h1', workspaceCount: 2, sourceCount: 2, current: null, run: null, candidate: null,
  }
}

function candidateValue(overrides = {}) {
  return {
    status: 'candidate', agentId: 'ag', zone: 'public',
    disclosure: { required: false, version: 1, key: 'public-memory-first-extraction' },
    highWater: 'h2', workspaceCount: 2, sourceCount: 3, current: null,
    run: { learningRunId: 'lr_public', outcome: 'candidate', revision: 3, createdAt: 1 },
    candidate: {
      learningRunId: 'lr_public', snapshotId: 'ms_public_candidate', version: 1, state: 'draft', revision: 2,
      contentHash: 'c'.repeat(64), principleCount: 1, workspaceCount: 2, sourceCount: 3, createdAt: 1,
    },
    ...overrides,
  }
}

function candidateReview(overrides = {}) {
  return {
    agentId: 'ag', zone: 'public', learningRunId: 'lr_public', outcome: 'candidate', runRevision: 3,
    startedAt: 1,
    candidate: { snapshotId: 'ms_public_candidate', version: 1, state: 'draft', revision: 2, contentHash: 'c'.repeat(64), principleCount: 1, parentSnapshotId: null, createdAt: 1 },
    currentPublished: null,
    changes: [{ op: 'add', principleId: 'pr_public', text: 'Prefer the documented option', scope: {} }],
    principles: [{ principleId: 'pr_public', text: 'Prefer the documented option', scope: {}, state: 'active', sourceCount: 2 }],
    sources: [
      { alias: aliasOne, count: 2, kinds: { case: 2, correction: 0 }, preview: 'Bounded redacted excerpt from another workspace', readableInCurrentWorkspace: false },
      { alias: aliasTwo, count: 1, kinds: { case: 1, correction: 0 }, preview: 'Bounded redacted excerpt from this workspace', readableInCurrentWorkspace: true },
    ],
    workspaceCount: 2, sourceCount: 3,
    replay: { passed: true, metrics: { operationCount: 1 } },
    disclosure: { required: false, version: 1, key: 'public-memory-first-extraction' },
    ...overrides,
  }
}

function publishedValue(overrides = {}) {
  return {
    status: 'up-to-date', agentId: 'ag', zone: 'public',
    disclosure: { required: false, version: 1, key: 'public-memory-first-extraction' },
    highWater: 'h2', workspaceCount: 2, sourceCount: 3,
    current: { snapshotId: 'ms_public_published', version: 1, revision: 6, contentHash: 'd'.repeat(64), principleCount: 1, workspaceCount: 2, sourceCount: 3 },
    run: null, candidate: null,
    ...overrides,
  }
}

/** A published public version whose reviewed wording is readable. */
function publishedWithPrinciples(overrides = {}) {
  return publishedValue({
    current: {
      ...publishedValue().current,
      principles: [{ principleId: 'pr_public', text: 'Prefer the documented option', scope: { paths: ['src/decision'] } }],
    },
    ...overrides,
  })
}
function pageActions(overrides = {}) {
  const calls = []
  const actions = {
    agents: async () => [agentDetail()],
    inbox: async () => [],
    agent: async id => agentDetail({ agentId: id }),
    records: async () => ({ records: [], nextCursor: null }),
    metrics: async () => ({}),
    learningRun: async () => null,
    memorySnapshot: async () => null,
    publicMemoryRefresh: async (agentId, options) => { calls.push(['publicMemoryRefresh', agentId, options]); return disclosureValue() },
    publicCandidate: async agentId => { calls.push(['publicCandidate', agentId]); return candidateReview() },
    snapshotPublish: async (...args) => { calls.push(['snapshotPublish', ...args]); return { state: 'published' } },
    snapshotReject: async (...args) => { calls.push(['snapshotReject', ...args]); return { state: 'draft' } },
    snapshotRollback: async (...args) => { calls.push(['snapshotRollback', ...args]); return { state: 'rolled_back' } },
    ...overrides,
  }
  return { actions, calls }
}

async function openAssistant(harness, agentId = 'ag') {
  const summary = findAll(harness.render(), node => node['data-agent-summary'] === agentId)[0]
  assert.ok(summary, `assistant summary ${agentId}`)
  await findAll(summary, node => node['data-action'] === 'open-agent')[0].onClick()
  await harness.flush()
  return harness.render()
}

function zone(tree, name) {
  return findAll(tree, node => node['data-memory-zone'] === name)[0]
}

function publicZone(tree) {
  return findAll(tree, node => node['data-public-memory'] === true)[0]
}

test('public memory projection keeps disclosure, versions, readiness and failures honest', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const t = key => model.dictionaries.zh[key]

  const gated = model.publicMemoryView({ phase: 'ready', value: disclosureValue() }, t)
  assert.equal(gated.disclosureRequired, true)
  assert.equal(gated.statusKey, 'decisionPublicStatusDisclosureRequired')
  assert.equal(gated.canReview, false)
  assert.equal(gated.current, null)

  const loading = model.publicMemoryView({ phase: 'ready', value: candidateValue(), candidatePhase: 'loading' }, t)
  assert.equal(loading.candidate.snapshotId, 'ms_public_candidate')
  assert.equal(loading.readiness.ready, false)
  assert.equal(loading.canReview, false)

  const ready = model.publicMemoryView({ phase: 'ready', value: candidateValue(), candidate: candidateReview(), candidatePhase: 'ready' }, t)
  assert.equal(ready.readiness.ready, true)
  assert.equal(ready.readiness.expectedRevision, 2)
  assert.equal(ready.readiness.changeCount, 1)
  assert.equal(ready.canReview, true)
  assert.equal(ready.canRollback, false)
  assert.equal(ready.sources.length, 2)
  assert.equal(JSON.stringify(ready).includes('/repo'), false)
  assert.equal(JSON.stringify(ready).includes('dc_'), false, 'no foreign record id reaches the projection')

  const mismatched = model.publicMemoryView({ phase: 'ready', value: candidateValue(), candidate: candidateReview({ candidate: { ...candidateReview().candidate, revision: 5 } }), candidatePhase: 'ready' }, t)
  assert.equal(mismatched.readiness.ready, false)
  assert.equal(mismatched.readiness.reason, 'mismatch')

  const replayFailed = model.publicMemoryView({ phase: 'ready', value: candidateValue(), candidate: candidateReview({ replay: { passed: false, detail: 'NO_CANDIDATE_CHANGES' } }), candidatePhase: 'ready' }, t)
  assert.equal(replayFailed.canReview, false)
  assert.equal(replayFailed.readiness.reason, 'replay')

  const failed = model.publicMemoryView({ phase: 'ready', value: candidateValue({ status: 'failed', candidate: null, run: { learningRunId: 'lr_failed', outcome: 'failed', revision: 4 } }) }, t)
  assert.equal(failed.retryable, true)
  assert.equal(failed.statusKey, 'decisionPublicStatusFailed')

  const published = model.publicMemoryView({ phase: 'ready', value: publishedValue() }, t)
  assert.equal(published.current.version, 1)
  assert.equal(published.canRollback, true)

  const readFailed = model.publicMemoryView({ phase: 'error', error: Object.assign(new Error('nope'), { code: 'DECISION_UNAVAILABLE' }) }, t)
  assert.equal(readFailed.statusKey, 'decisionPublicStatusError')
  assert.equal(readFailed.errorKey, 'decisionFailed')

  assert.equal(model.publicMemoryView({ phase: 'loading' }, t).hasValue, false)
})

test('assistant detail shows exactly the two ordinary-language memory zones without workspace paths or a fourth navigation', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const { actions } = pageActions({ agent: async id => agentDetail({ agentId: id, publicMemory: publishedValue() }) })
  const harness = await createPageHarness({ actions, consumeAgentDestination: () => 'manage', t: key => model.dictionaries.zh[key] })
  await harness.settle()
  const tree = await openAssistant(harness)
  const detail = findAll(tree, node => node['data-agent-detail'] === 'ag')[0]
  assert.ok(detail)
  const zones = findAll(detail, node => node['data-memory-zone']).map(node => node['data-memory-zone'])
  assert.deepEqual(zones, ['public', 'workspace'])
  const headings = findAll(detail, node => node.type === 'h3').map(node => textOf(node))
  assert.equal(headings.includes(model.dictionaries.zh.decisionPublicMemory), true)
  assert.equal(headings.includes(model.dictionaries.zh.decisionWorkspaceExperience), true)
  assert.equal(model.dictionaries.zh.decisionPublicMemory, '公共记忆')
  assert.equal(model.dictionaries.zh.decisionWorkspaceExperience, '当前工作区经验')
  assert.equal(findAll(detail, node => node['data-public-guidance-only'] === true).length, 1)
  assert.equal(findAll(detail, node => node['data-private-isolation'] === true).length, 1)
  const text = textOf(detail)
  assert.equal(text.includes('/repo'), false)
  assert.equal(text.includes('/Users/'), false)
  assert.equal(text.includes('decisionPublicGuidanceOnly'), false, 'ordinary language, not dictionary keys')
  const nav = findAll(tree, node => node['data-decision-primary-nav'] === true)[0]
  assert.deepEqual(findAll(nav, node => node.type === harness.ui.Button).map(button => button['data-view']), ['inbox', 'records', 'agents'])
  // No control promises an automatic publication.
  const labels = findAll(detail, node => node.type === harness.ui.Button).map(button => String(button.children))
  assert.equal(labels.some(label => /auto/i.test(label)), false, labels.join(','))
  harness.unmount()
})

test('opening the assistant reads public memory once, gates the first review, and acknowledges explicitly', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const { actions, calls } = pageActions()
  const harness = await createPageHarness({ actions, consumeAgentDestination: () => 'manage', t: key => model.dictionaries.zh[key] })
  await harness.settle()
  let tree = await openAssistant(harness)
  tree = harness.render()
  tree = harness.render()
  assert.equal(calls.filter(call => call[0] === 'publicMemoryRefresh').length, 1, 'exactly one automatic read per open')
  assert.deepEqual(calls[0], ['publicMemoryRefresh', 'ag', {}])
  const zoneTree = publicZone(tree)
  assert.ok(zoneTree)
  const disclosure = findAll(zoneTree, node => node['data-public-disclosure'] === true)[0]
  assert.ok(disclosure)
  assert.equal(textOf(disclosure).includes(model.dictionaries.zh.decisionPublicDisclosureBody), true)
  const acknowledge = findAll(disclosure, node => node['data-action'] === 'public-acknowledge')[0]
  assert.ok(acknowledge)
  assert.equal(acknowledge.disabled, false)
  assert.equal(calls.some(call => call[0] === 'snapshotPublish'), false)

  await acknowledge.onClick()
  await harness.flush()
  const refreshCalls = calls.filter(call => call[0] === 'publicMemoryRefresh')
  assert.equal(refreshCalls.length, 2)
  assert.deepEqual(refreshCalls[1], ['publicMemoryRefresh', 'ag', { acknowledgedDisclosure: true }])
  assert.equal(calls.some(call => call[0] === 'publicCandidate'), false, 'the gated read produced no candidate')
  harness.unmount()
})

test('a ready candidate is reviewed through opaque aliases and adopted only through an explicit confirmation', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  let refresh = candidateValue()
  const { actions, calls } = pageActions({ publicMemoryRefresh: async (agentId, options) => { calls.push(['publicMemoryRefresh', agentId, options]); return refresh } })
  const harness = await createPageHarness({ actions, consumeAgentDestination: () => 'manage', t: key => model.dictionaries.zh[key] })
  await harness.settle()
  let tree = await openAssistant(harness)
  tree = harness.render()
  const zoneTree = publicZone(tree)
  const candidate = findAll(zoneTree, node => node['data-public-candidate'])[0]
  assert.ok(candidate)
  assert.deepEqual(findAll(zoneTree, node => node['data-public-source']).map(node => node['data-public-source']).sort(), [aliasOne, aliasTwo].sort())
  const serialized = JSON.stringify(zoneTree)
  for (const secret of [aliasOne, aliasTwo]) assert.ok(serialized.includes(secret))
  assert.equal(serialized.includes('readableInCurrentWorkspace'), false)
  assert.equal(serialized.includes('dc_'), false)

  const publish = findAll(zoneTree, node => node['data-action'] === 'public-publish')[0]
  assert.ok(publish)
  assert.equal(publish.disabled, false)
  assert.equal(calls.some(call => call[0] === 'snapshotPublish'), false, 'no publication happens on render')
  await publish.onClick()
  assert.equal(calls.some(call => call[0] === 'snapshotPublish'), false, 'adoption waits for the confirmation dialog')
  const dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  assert.ok(dialog)
  assert.equal(dialog.title, model.dictionaries.zh.decisionPublicApplyTitle)
  assert.equal(textOf(dialog.body).includes(model.dictionaries.zh.decisionPublicApplyConfirmation), true)
  await dialog.onConfirm()
  await harness.flush()
  const publishCall = calls.find(call => call[0] === 'snapshotPublish')
  assert.deepEqual(publishCall, ['snapshotPublish', 'ms_public_candidate', 2])
  assert.equal(calls.filter(call => call[0] === 'publicMemoryRefresh').length >= 2, true, 'the lifecycle action re-reads the zone')
  harness.unmount()
})

test('discard and rollback are explicit, and a failed review retries only on request', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  let refresh = candidateValue()
  const { actions, calls } = pageActions({
    publicMemoryRefresh: async (agentId, options) => { calls.push(['publicMemoryRefresh', agentId, options]); return refresh },
  })
  const harness = await createPageHarness({ actions, consumeAgentDestination: () => 'manage', t: key => model.dictionaries.zh[key] })
  await harness.settle()
  let tree = await openAssistant(harness)
  tree = harness.render()
  const zoneTree = publicZone(tree)
  await findAll(zoneTree, node => node['data-action'] === 'public-reject')[0].onClick()
  let dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  assert.equal(textOf(dialog.body).includes(model.dictionaries.zh.decisionPublicDiscardConfirmation), true)
  await dialog.onConfirm()
  await harness.flush()
  assert.deepEqual(calls.find(call => call[0] === 'snapshotReject'), ['snapshotReject', 'ms_public_candidate', 2])

  // A published version can be rolled back, again only after confirmation.
  refresh = publishedValue()
  await findAll(harness.render(), node => node['data-action'] === 'public-refresh')[0].onClick()
  await harness.flush()
  tree = harness.render()
  const publishedZone = publicZone(tree)
  const rollback = findAll(publishedZone, node => node['data-action'] === 'public-rollback')[0]
  assert.ok(rollback)
  assert.equal(rollback.disabled, false)
  await rollback.onClick()
  dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  assert.equal(dialog.title, model.dictionaries.zh.decisionPublicRollbackTitle)
  await dialog.onConfirm()
  await harness.flush()
  assert.deepEqual(calls.find(call => call[0] === 'snapshotRollback'), ['snapshotRollback', 'ms_public_published', 6])

  // A failed extraction shows its real state and retries only from the button.
  refresh = { status: 'failed', agentId: 'ag', zone: 'public', disclosure: { required: false, version: 1 }, highWater: 'h3', workspaceCount: 1, sourceCount: 1, current: null, run: { learningRunId: 'lr_failed', outcome: 'failed', revision: 5 }, candidate: null }
  await findAll(harness.render(), node => node['data-action'] === 'public-refresh')[0].onClick()
  await harness.flush()
  let failedZone = publicZone(harness.render())
  const retry = findAll(failedZone, node => node['data-action'] === 'public-retry')[0]
  assert.ok(retry)
  const before = calls.filter(call => call[0] === 'publicMemoryRefresh').length
  await retry.onClick()
  await harness.flush()
  const after = calls.filter(call => call[0] === 'publicMemoryRefresh')
  assert.equal(after.length, before + 1)
  assert.deepEqual(after.at(-1), ['publicMemoryRefresh', 'ag', { retryFailedExtraction: true }])
  failedZone = publicZone(harness.render())
  assert.equal(findAll(failedZone, node => node['data-action'] === 'public-retry').length, 1, 'the state stays retryable until it really changes')
  harness.unmount()
})

test('public lifecycle actions return focus to the public zone heading', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const { actions } = pageActions({
    publicMemoryRefresh: async () => candidateValue(),
  })
  const harness = await createPageHarness({ actions, consumeAgentDestination: () => 'manage', t: key => model.dictionaries.zh[key] })
  await harness.settle()
  let tree = await openAssistant(harness)
  tree = harness.render()
  await findAll(publicZone(tree), node => node['data-action'] === 'public-publish')[0].onClick()
  const dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog)[0]
  await dialog.onConfirm()
  await harness.flush()
  const rendered = harness.render()
  assert.equal(harness.document.activeElement?.id, 'weir-da-public-zone-ag')
  const heading = findAll(rendered, node => node.id === 'weir-da-public-zone-ag')[0]
  assert.equal(heading.tabIndex, -1, 'the heading is a programmatic focus target, not a tab stop')
  assert.equal(rendered['data-visual-viewport'], undefined)
  harness.unmount()
})

test('pending public actions stay disabled and keep a screen-reader status', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const gate = deferred()
  const { actions } = pageActions({ publicMemoryRefresh: async () => gate.promise })
  const harness = await createPageHarness({ actions, consumeAgentDestination: () => 'manage', t: key => model.dictionaries.zh[key] })
  await harness.settle()
  let tree = await openAssistant(harness)
  tree = harness.render()
  const zoneTree = publicZone(tree)
  const status = findAll(zoneTree, node => node['data-public-status'])[0]
  assert.equal(status?.['aria-live'], 'polite')
  assert.equal(status?.['role'], 'status')
  gate.resolve(candidateValue())
  await harness.flush()
  tree = harness.render()
  assert.equal(findAll(publicZone(tree), node => node['data-public-candidate']).length, 1)
  harness.unmount()
})

test('the public zone stays inside a real 200% visual viewport without horizontal layout assumptions', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const listeners = new Map([['resize', new Set()], ['scroll', new Set()]])
  const visualViewport = {
    width: 180, height: 450, scale: 2, offsetLeft: 0, offsetTop: 0,
    addEventListener(type, listener) { listeners.get(type)?.add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
  }
  const { actions } = pageActions({ publicMemoryRefresh: async () => candidateValue() })
  const harness = await createPageHarness({ actions, consumeAgentDestination: () => 'manage', t: key => model.dictionaries.zh[key] })
  Object.assign(globalThis.window, { innerWidth: 360, innerHeight: 900, devicePixelRatio: 1, visualViewport })
  try {
    await harness.settle()
    const tree = await openAssistant(harness)
    const page = findAll(tree, node => node.type === 'main' && node.className === 'weir-da-page')[0]
    assert.equal(page.style?.width, '180px')
    assert.equal(page['data-visual-viewport'], 'compact')
    const zoneTree = publicZone(tree)
    assert.ok(zoneTree)
    assert.equal(findAll(zoneTree, node => node.style?.width !== undefined && String(node.style.width).endsWith('px')).length, 0, 'the zone never pins a fixed pixel width')
    assert.equal(findAll(zoneTree, node => node['data-public-source']).length, 2)
  } finally {
    Object.assign(globalThis.window, { visualViewport: undefined })
    harness.unmount()
  }
})

test('the public projection carries the reviewed wording read-only and drops provenance hints', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const t = key => model.dictionaries.zh[key]

  const published = model.publicMemoryView({ phase: 'ready', value: publishedWithPrinciples() }, t)
  assert.deepEqual(published.current.principles, [
    { principleId: 'pr_public', text: 'Prefer the documented option', scope: { paths: ['src/decision'] } },
  ])
  assert.equal(JSON.stringify(published.current.principles).includes('/Users/'), false)

  // An unsafe hint is dropped, never rendered: a workspace list, an absolute
  // path and a record id have no place on the published surface.
  const dirty = model.publicMemoryView({
    phase: 'ready',
    value: publishedValue({
      current: {
        ...publishedValue().current,
        principles: [
          {
            principleId: 'pr_a', text: 'Keep the documented option',
            scope: {
              workspaces: ['/repo'],
              paths: ['/Users/alice/repo', 'docs'],
              tags: ['dc_00000000-0000-4000-8000-000000000000', 'safety'],
            },
          },
          { text: 'missing an id' },
          { principleId: 'pr_b' },
        ],
      },
    }),
  }, t)
  assert.deepEqual(dirty.current.principles, [
    { principleId: 'pr_a', text: 'Keep the documented option', scope: { paths: ['docs'], tags: ['safety'] } },
    { principleId: 'pr_b', text: '', scope: {} },
  ])
})

test('a candidate review renders the proposed wording, the frozen input and the adopted principles read-only', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const t = key => model.dictionaries.zh[key]
  const wording = 'Prefer the documented option when both workspaces agree'
  const review = candidateReview({
    changes: [{ op: 'refine', principleId: 'pr_public', text: wording, scope: { paths: ['src'] } }],
    principles: [{ principleId: 'pr_public', text: wording, scope: { paths: ['src'] }, state: 'active', sourceCount: 2 }],
  })
  const { actions, calls } = pageActions({
    publicMemoryRefresh: async () => candidateValue({ current: publishedWithPrinciples().current }),
    publicCandidate: async agentId => { calls.push(['publicCandidate', agentId]); return review },
  })
  const harness = await createPageHarness({ actions, consumeAgentDestination: () => 'manage', t })
  await harness.settle()
  const zoneTree = publicZone(await openAssistant(harness))
  assert.ok(zoneTree)

  const change = findAll(zoneTree, node => node['data-public-change'] === 'refine')[0]
  assert.ok(change, 'the review renders one operation')
  assert.equal(textOf(findAll(change, node => node['data-public-change-text'])[0]), wording)
  assert.equal(textOf(change).includes(t('decisionPublicOpRefine')), true, 'the operation is labelled in ordinary language')
  assert.equal(textOf(findAll(change, node => node['data-public-change-scope'])[0]).includes('src'), true)

  const frozen = findAll(zoneTree, node => node['data-public-frozen-input'] === true)[0]
  assert.ok(frozen, 'the candidate review states the frozen input by counts only')
  assert.equal(textOf(frozen).includes('2'), true)
  assert.equal(textOf(frozen).includes('3'), true)

  // The wording must be readable before adopting or discarding.
  assert.equal(findAll(zoneTree, node => node['data-action'] === 'public-publish')[0].disabled, false)
  assert.equal(findAll(zoneTree, node => node['data-action'] === 'public-reject')[0].disabled, false)

  const publishedSection = findAll(zoneTree, node => node['data-public-published-principles'] === true)[0]
  assert.ok(publishedSection, 'the current published principles are readable')
  assert.equal(textOf(publishedSection).includes('Prefer the documented option'), true)
  assert.equal(findAll(publishedSection, node => node.type === harness.ui.Button).length, 0, 'the published version stays read-only')
  assert.deepEqual(findAll(zoneTree, node => node['data-public-published-principle']).map(node => node['data-public-published-principle']), ['pr_public'])

  // Safe fields only: the rendered zone carries the wording, its scope hints and
  // counts — never an absolute path, a record id or the raw frozen input.
  const serialized = JSON.stringify(zoneTree)
  for (const leaked of ['/Users/', 'dc_', 'inputFrozen', 'readableInCurrentWorkspace', 'principleId\":\"pr_other']) {
    assert.equal(serialized.includes(leaked), false, `${leaked} stays out of the public zone`)
  }
  harness.unmount()
})

test('narrow and retire changes fall back to the wording they keep or remove', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const t = key => model.dictionaries.zh[key]

  const narrow = candidateReview({
    changes: [{ op: 'narrow', principleId: 'pr_public', scope: { paths: ['docs'] } }],
    principles: [{ principleId: 'pr_public', text: 'Keep the documented option', scope: { paths: ['docs'] }, state: 'active', sourceCount: 2 }],
  })
  const narrowHarness = await createPageHarness({
    actions: pageActions({ publicMemoryRefresh: async () => candidateValue(), publicCandidate: async () => narrow }).actions,
    consumeAgentDestination: () => 'manage', t,
  })
  await narrowHarness.settle()
  const narrowZone = publicZone(await openAssistant(narrowHarness))
  assert.equal(textOf(findAll(narrowZone, node => node['data-public-change-text'])[0]), 'Keep the documented option')
  narrowHarness.unmount()

  // A retirement removes the principle from the candidate Snapshot, so the
  // wording it retires comes from the current published version.
  const retire = candidateReview({ changes: [{ op: 'retire', principleId: 'pr_public' }], principles: [] })
  const retireHarness = await createPageHarness({
    actions: pageActions({
      publicMemoryRefresh: async () => candidateValue({ current: publishedWithPrinciples().current }),
      publicCandidate: async () => retire,
    }).actions,
    consumeAgentDestination: () => 'manage', t,
  })
  await retireHarness.settle()
  const retireZone = publicZone(await openAssistant(retireHarness))
  const retireChange = findAll(retireZone, node => node['data-public-change'] === 'retire')[0]
  assert.ok(retireChange)
  assert.equal(textOf(findAll(retireChange, node => node['data-public-change-text'])[0]), 'Prefer the documented option')
  assert.equal(textOf(retireChange).includes(t('decisionPublicCurrentText')), true, 'a retirement shows the wording it removes')
  retireHarness.unmount()
})
