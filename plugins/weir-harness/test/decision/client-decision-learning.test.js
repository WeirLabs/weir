import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientChunk } from '../helpers/load-client-chunk.js'
import { createPageHarness, deferred, textOf } from './page-test-helpers.js'

const learning = (await loadClientChunk('lib/client.decision-learning.js', () => {
  const jsx = (type, props) => ({ type, ...(props ?? {}) })
  return { jsx, jsxs: jsx }
})).exports

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) findAll(item, predicate, found)
    else if (value && typeof value === 'object') findAll(value, predicate, found)
  }
  return found
}

async function openAgentDetail(harness) {
  let tree = harness.render()
  findAll(tree, node => node.type === harness.ui.Button && node['data-view'] === 'agents')[0].onClick()
  await harness.flush()
  tree = harness.render()
  findAll(tree, node => node.type === harness.ui.Button && node['data-action'] === 'open-agent')[0].onClick()
  await harness.flush()
  return harness.render()
}

function renderedLearning(harness, tree = harness.render()) {
  const detail = findAll(tree, node => node['data-agent-detail'])[0]
  const element = findAll(detail, node => node.type === harness.learning.AgentLearning)[0]
  return harness.learning.AgentLearning(element)
}

test('learning projection exposes ordinary idle, running, no-change, candidate, failure, current version, and pending review states', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const project = agent => learning.learningView({ agent, candidateReadiness: model.candidateReadiness })
  const base = { agentId: 'a', state: 'enabled', currentSnapshotId: null, learningRuns: [], snapshots: [] }
  const idle = project(base)
  assert.equal(idle.statusKey, 'decisionLearningIdle')
  assert.equal(idle.currentVersion, null)
  assert.equal(idle.pendingReview, false)
  assert.equal(idle.canStart, true)

  const running = project({ ...base, learningRuns: [{ learningRunId: 'lr_running', outcome: 'running', revision: 1 }] })
  assert.equal(running.statusKey, 'decisionLearningOutcome_running')
  assert.equal(running.startBlockKey, 'decisionLearningStartRunning')
  assert.equal(running.canStart, false)

  const failed = project({ ...base, learningRuns: [{ learningRunId: 'lr_failed', outcome: 'failed', revision: 2 }] })
  assert.equal(failed.statusKey, 'decisionLearningOutcome_failed')
  assert.equal(failed.pendingReview, false)

  const current = { snapshotId: 'ms_current', state: 'published', version: 3, revision: 8, learningRunId: 'lr_current' }
  const candidate = {
    ...base, currentSnapshotId: 'ms_current', snapshots: [current, { snapshotId: 'ms_candidate', state: 'draft', version: 4, revision: 2, learningRunId: 'lr_candidate', parentSnapshotId: 'ms_current' }],
    learningRuns: [{ learningRunId: 'lr_candidate', outcome: 'candidate', revision: 2 }, { learningRunId: 'lr_current', outcome: 'published', revision: 4 }],
  }
  const review = project(candidate)
  assert.equal(review.statusKey, 'decisionLearningOutcome_candidate')
  assert.equal(review.currentVersion, 3)
  assert.equal(review.pendingReview, true)
  assert.equal(review.startBlockKey, 'decisionLearningStartCandidate')
  assert.equal(review.readiness.reason, 'loading')

  const noChanges = learning.learningView({
    agent: { ...base, learningRuns: [{ learningRunId: 'lr_empty', outcome: 'published', revision: 2 }] },
    detail: { agentId: 'a', inspection: { run: { learningRunId: 'lr_empty', agentId: 'a', outcome: 'published', operations: [] }, snapshot: null, parentSnapshot: null } },
    candidateReadiness: model.candidateReadiness,
  })
  assert.equal(noChanges.statusKey, 'decisionLearningNoChanges')
  for (const key of ['decisionLearningIdle', 'decisionLearningNoChanges', 'decisionLearningStartUnavailable', 'decisionLearningStartRunning', 'decisionLearningStartCandidate', 'decisionLearningWorking', 'decisionPrincipleVersion']) {
    assert.equal(typeof model.dictionaries.en[key], 'string', `en ${key}`)
    assert.equal(typeof model.dictionaries.zh[key], 'string', `zh ${key}`)
  }
  assert.equal(noChanges.pendingReview, false)
  const actualNoCandidate = learning.learningView({
    agent: { ...base, learningRuns: [{ learningRunId: 'lr_no_candidate', outcome: 'failed', revision: 3 }] },
    detail: { agentId: 'a', inspection: { run: { learningRunId: 'lr_no_candidate', agentId: 'a', outcome: 'failed', operations: [], replay: { passed: false, detail: 'NO_CANDIDATE_CHANGES' } }, snapshot: null, parentSnapshot: null } },
    candidateReadiness: model.candidateReadiness,
  })
  assert.equal(actualNoCandidate.statusKey, 'decisionLearningNoChanges')
  assert.equal(actualNoCandidate.canStart, true)
})

test('Agent details use the learning chunk product surface instead of legacy buttons and default raw JSON', async () => {
  const agent = { agentId: 'a', name: 'A', state: 'enabled', currentSnapshotId: null, learningRuns: [], snapshots: [] }
  const harness = await createPageHarness({ actions: { agents: async () => [agent], inbox: async () => [], agent: async () => agent } })
  const tree = await openAgentDetail(harness)
  const detail = findAll(tree, node => node['data-agent-detail'] === 'a')[0]
  assert.equal(typeof harness.learning.AgentLearning, 'function')
  const elements = findAll(detail, node => node.type === harness.learning.AgentLearning)
  assert.equal(elements.length, 1)
  const agentAdvanced = findAll(detail, node => node.type === harness.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0]
  assert.equal(agentAdvanced.revealOnOpen, 'end')
  assert.equal(findAll(agentAdvanced.children(), node => node.type === harness.learning.AgentLearning).length, 0)

  const rendered = harness.learning.AgentLearning(elements[0])
  const text = JSON.stringify(rendered)
  for (const key of ['decisionLearningGovernance', 'decisionNoCurrentSnapshot', 'decisionLearningIdle', 'decisionConsolidate']) assert.ok(text.includes(key), key)
  for (const key of ['decisionPublish', 'decisionReject', 'decisionRollback', 'decisionLearningRuns', 'decisionSnapshots', 'learningRuns', 'snapshots']) assert.equal(text.includes(key), false, key)
  assert.equal(findAll(rendered, node => node.type === 'pre').length, 0)
  const learningAdvanced = findAll(rendered, node => node.type === harness.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0]
  assert.equal(learningAdvanced.revealOnOpen, 'end')
  harness.unmount()
})

test('Review new principles has one guarded start, stable ambiguous-retry requestId, and explicit blocked states', async () => {
  const base = { agentId: 'a', name: 'A', state: 'enabled', currentSnapshotId: null, learningRuns: [], snapshots: [] }
  const running = { ...base, learningRuns: [{ learningRunId: 'lr_running', outcome: 'running', revision: 1 }] }
  let current = base
  const gate = deferred()
  const calls = []
  const harness = await createPageHarness({ actions: {
    agents: async () => [current], inbox: async () => [], agent: async () => current,
    learningStart: (agentId, requestId) => { calls.push([agentId, requestId]); return gate.promise },
    learningRun: async id => ({ learningRunId: id, agentId: 'a', outcome: 'running', operations: [], inputFrozen: { parentSnapshotId: null } }),
  } })
  await openAgentDetail(harness)
  const startButton = () => {
    const detail = findAll(harness.render(), node => node['data-agent-detail'] === 'a')[0]
    const element = findAll(detail, node => node.type === harness.learning.AgentLearning)[0]
    const rendered = harness.learning.AgentLearning(element)
    return findAll(rendered, node => node.type === harness.ui.Button && node['data-action'] === 'learning-start')[0]
  }
  let uuid = 0
  window.crypto = { randomUUID: () => `request-${++uuid}` }
  const first = startButton()
  assert.equal(first.disabled, false)
  const one = first.onClick()
  const two = first.onClick()
  assert.deepEqual(calls, [['a', 'request-1']])
  current = running
  gate.resolve({ learningRunId: 'lr_running', agentId: 'a', outcome: 'running' })
  await Promise.all([one, two])
  await harness.flush()
  assert.equal(calls.length, 1)
  assert.equal(startButton().disabled, true)
  harness.unmount()

  current = base
  const retryCalls = []
  const retryHarness = await createPageHarness({ actions: {
    agents: async () => [current], inbox: async () => [], agent: async () => current,
    learningStart: async (agentId, requestId) => {
      retryCalls.push([agentId, requestId])
      if (retryCalls.length === 1) throw Object.assign(new Error('ambiguous network failure'), { code: 'DECISION_REMOTE_FAILED' })
      current = { ...base, learningRuns: [{ learningRunId: 'lr_failed', outcome: 'failed', revision: 2 }] }
      return { learningRunId: 'lr_failed', agentId: 'a', outcome: 'failed' }
    },
    learningRun: async id => ({ learningRunId: id, agentId: 'a', outcome: 'failed', operations: [], inputFrozen: { parentSnapshotId: null } }),
  } })
  await openAgentDetail(retryHarness)
  window.crypto = { randomUUID: () => `request-${++uuid}` }
  const retryButton = () => {
    const detail = findAll(retryHarness.render(), node => node['data-agent-detail'] === 'a')[0]
    const element = findAll(detail, node => node.type === retryHarness.learning.AgentLearning)[0]
    return findAll(retryHarness.learning.AgentLearning(element), node => node.type === retryHarness.ui.Button && node['data-action'] === 'learning-start')[0]
  }
  await retryButton().onClick()
  await retryHarness.flush()
  await retryButton().onClick()
  await retryHarness.flush()
  assert.deepEqual(retryCalls, [['a', 'request-2'], ['a', 'request-2']])
  retryHarness.unmount()

  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  let unguardedStarts = 0
  for (const input of [
    { agent: { ...base, state: 'disabled' } },
    { agent: running },
    { agent: { ...base, learningRuns: [{ learningRunId: 'lr_candidate', outcome: 'candidate' }] } },
    { agent: base, pending: 'learningStart' },
  ]) {
    const rendered = learning.AgentLearning({ ...input, ui: (await createPageHarness({ actions: {} })).ui, t: key => key, candidateReadiness: model.candidateReadiness, onStart: () => { unguardedStarts += 1 } })
    const button = findAll(rendered, node => node.type?.name === 'Button' || node['data-action'] === 'learning-start')[0]
    assert.equal(button.disabled, true)
    await button.onClick()
  }
  assert.equal(unguardedStarts, 0)
})

test('candidate review groups readable principle changes, scope, bounded sources, and structural warning; incomplete details cannot write', async () => {
  const host = await createPageHarness({ actions: {} })
  const agent = {
    agentId: 'a', state: 'enabled', currentSnapshotId: 'ms_current',
    learningRuns: [{ learningRunId: 'lr_candidate', outcome: 'candidate', revision: 4 }],
    snapshots: [
      { snapshotId: 'ms_candidate', state: 'draft', version: 4, revision: 2, learningRunId: 'lr_candidate', parentSnapshotId: 'ms_current' },
      { snapshotId: 'ms_current', state: 'published', version: 3, revision: 8, learningRunId: 'lr_current', parentSnapshotId: null },
    ],
  }
  const run = {
    learningRunId: 'lr_candidate', agentId: 'a', outcome: 'candidate', revision: 4,
    inputFrozen: { parentSnapshotId: 'ms_current', parentSnapshotRevision: 8, caseIds: ['dc_source'], feedbackIds: [] },
    operations: [{ op: 'add', principleId: 'p_add', text: 'Use the new direction', scope: { paths: ['src/new'] }, sources: ['dc_source'] }],
    replay: { passed: true, metrics: { operationCount: 1 }, finalHash: 'c'.repeat(64) },
    sourceRecords: [{ sourceId: 'dc_source', kind: 'case', caseId: 'dc_source', revision: 3, excerpt: 'Question: Choose safely\nAnswer: Option A', scope: { workspaces: ['/repo'] } }],
  }
  const candidate = {
    run,
    snapshot: { snapshotId: 'ms_candidate', agentId: 'a', learningRunId: 'lr_candidate', state: 'draft', version: 4, revision: 9, parentSnapshotId: 'ms_current', principles: [
      { principleId: 'p_change', text: 'Use B', scope: { paths: ['src'] }, sources: ['dc_source'], state: 'active' },
      { principleId: 'p_add', text: 'Use the new direction', scope: { paths: ['src/new'] }, sources: ['dc_source'], state: 'active' },
    ], sourceRecords: run.sourceRecords },
    parentSnapshot: { snapshotId: 'ms_current', agentId: 'a', state: 'published', version: 3, revision: 8, principles: [
      { principleId: 'p_change', text: 'Use A', scope: {}, sources: [], state: 'active' },
      { principleId: 'p_remove', text: 'Remove this rule', scope: { tags: ['legacy'] }, sources: [], state: 'active' },
    ] },
  }
  const detail = { agentId: 'a', candidate, inspection: candidate }
  let confirmations = 0
  const props = { agent, detail, ui: host.ui, t: key => key, candidateReadiness: host.model.candidateReadiness, confirmAction: () => { confirmations += 1 } }
  const rendered = learning.AgentLearning(props)
  const text = textOf(rendered)
  for (const value of ['decisionDiffAdded', 'decisionDiffChanged', 'decisionDiffRemoved', 'Use A', 'Use B', 'Use the new direction', 'Remove this rule', 'src/new', 'legacy', 'Question: Choose safely', 'Answer: Option A', 'decisionStructuralQualityWarning']) assert.ok(text.includes(value), value)
  assert.deepEqual(findAll(rendered, node => typeof node['data-principle-change'] === 'string').map(node => node['data-principle-change']).sort(), ['added', 'changed', 'removed'])
  for (const internal of ['ms_candidate', 'lr_candidate', 'p_change', 'dc_source']) assert.equal(text.includes(internal), false, internal)
  for (const action of ['learning-publish', 'learning-reject']) {
    const button = findAll(rendered, node => node.type === host.ui.Button && node['data-action'] === action)[0]
    assert.equal(button.disabled, false, action)
  }

  for (const incomplete of [
    { detail: null },
    { detail, loading: true },
    { detail, error: Object.assign(new Error('read failed'), { code: 'DECISION_REMOTE_FAILED' }) },
    { detail: { ...detail, candidate: { ...candidate, run: { ...run, learningRunId: 'lr_other' } } } },
    { detail: { ...detail, candidate: { ...candidate, snapshot: { ...candidate.snapshot, revision: undefined } } } },
  ]) {
    const blocked = learning.AgentLearning({ ...props, ...incomplete })
    for (const action of ['learning-publish', 'learning-reject']) {
      const button = findAll(blocked, node => node.type === host.ui.Button && node['data-action'] === action)[0]
      assert.equal(button.disabled, true, `${action} ${JSON.stringify(incomplete)}`)
      await button.onClick()
    }
  }
  assert.equal(confirmations, 0)
  host.unmount()
})

function productLearning(harness) {
  const detail = findAll(harness.render(), node => node['data-agent-detail'])[0]
  const element = findAll(detail, node => node.type === harness.learning.AgentLearning)[0]
  return harness.learning.AgentLearning(element)
}

test('Apply, Discard, and Restore use distinct confirmations, exact latest revisions, authoritative rereads, and preserve stale failures', async () => {
  const cases = [
    { method: 'snapshotPublish', action: 'learning-publish', dialog: 'weir-da-learning-publish', title: 'decisionApplyTitle', body: 'decisionApplyFutureOnly', snapshotId: 'ms_candidate', revision: 9, error: 'STALE_SOURCE' },
    { method: 'snapshotReject', action: 'learning-reject', dialog: 'weir-da-learning-reject', title: 'decisionDiscardCandidateTitle', body: 'decisionDiscardCandidateConfirmation', snapshotId: 'ms_candidate', revision: 9, error: 'STALE_PARENT_SNAPSHOT' },
    { method: 'snapshotRollback', action: 'learning-rollback', dialog: 'weir-da-learning-rollback', title: 'decisionRollbackTitle', body: 'decisionRollbackConfirmation', snapshotId: 'ms_current', revision: 11, error: 'REVISION_CONFLICT' },
  ]
  for (const scenario of cases) {
    for (const fails of [true, false]) {
      const candidateRun = { learningRunId: 'lr_candidate', outcome: 'candidate', revision: 4 }
      const currentRun = { learningRunId: 'lr_current', outcome: 'published', revision: 5 }
      const initial = {
        agentId: 'a', name: 'A', state: 'enabled', currentSnapshotId: 'ms_current',
        learningRuns: [candidateRun, currentRun],
        snapshots: [
          { snapshotId: 'ms_candidate', state: 'draft', version: 4, revision: 2, learningRunId: 'lr_candidate', parentSnapshotId: 'ms_current' },
          { snapshotId: 'ms_current', state: 'published', version: 3, revision: 11, learningRunId: 'lr_current', parentSnapshotId: null },
        ],
      }
      let currentAgent = initial
      let agentReads = 0
      const actionCalls = []
      let beforeReads = 0
      let refreshFailure = null
      const readRun = async id => {
        const summary = currentAgent.learningRuns.find(run => run.learningRunId === id) ?? (id === 'lr_candidate' ? candidateRun : currentRun)
        return { learningRunId: id, agentId: 'a', outcome: summary.outcome, revision: summary.revision, operations: [], inputFrozen: { parentSnapshotId: id === 'lr_candidate' ? 'ms_current' : null, ...(id === 'lr_candidate' ? { parentSnapshotRevision: 11 } : {}) }, replay: { passed: true } }
      }
      const readSnapshot = async id => {
        const summary = currentAgent.snapshots.find(snapshot => snapshot.snapshotId === id) ?? initial.snapshots.find(snapshot => snapshot.snapshotId === id)
        return {
          ...summary, agentId: 'a', revision: id === 'ms_candidate' && currentAgent === initial ? 9 : summary.revision,
          principles: [{ principleId: 'p', text: id === 'ms_candidate' ? 'New principle' : 'Old principle', scope: {}, sources: [], state: 'active' }],
        }
      }
      const harness = await createPageHarness({ actions: {
        agents: async () => [currentAgent], inbox: async () => [], agent: async () => { agentReads += 1; if (fails && refreshFailure && agentReads > beforeReads) await refreshFailure.promise; return currentAgent },
        learningRun: readRun, memorySnapshot: readSnapshot,
        [scenario.method]: async (...args) => {
          actionCalls.push(args)
          if (fails) throw Object.assign(new Error('stale review'), { code: scenario.error })
          if (scenario.method === 'snapshotPublish') currentAgent = { ...initial, currentSnapshotId: 'ms_candidate', learningRuns: [{ ...candidateRun, outcome: 'published' }], snapshots: [{ ...initial.snapshots[0], state: 'published', revision: 10 }] }
          if (scenario.method === 'snapshotReject') currentAgent = { ...initial, learningRuns: [{ ...candidateRun, outcome: 'rejected' }, currentRun] }
          if (scenario.method === 'snapshotRollback') currentAgent = { ...initial, currentSnapshotId: null, learningRuns: [{ ...currentRun, outcome: 'rolled_back' }], snapshots: [{ ...initial.snapshots[1], state: 'rolled_back', revision: 12 }] }
          return { snapshotId: scenario.snapshotId }
        },
      } })
      await openAgentDetail(harness)
      beforeReads = agentReads
      const button = findAll(productLearning(harness), node => node.type === harness.ui.Button && node['data-action'] === scenario.action)[0]
      assert.equal(button.disabled, false, `${scenario.method} fails=${fails}`)
      await button.onClick()
      assert.equal(actionCalls.length, 0, 'confirmation precedes mutation')
      const dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog && node.id === scenario.dialog)[0]
      assert.ok(dialog, scenario.dialog)
      assert.equal(dialog.title, scenario.title)
      assert.ok(textOf(dialog.body).includes(scenario.body), scenario.body)
      if (fails) {
        refreshFailure = deferred()
        const confirmation = dialog.onConfirm()
        await harness.flush()
        assert.ok(agentReads > beforeReads, 'failed Snapshot writes reread the authoritative Agent before settling')
        assert.ok(textOf(harness.render()).includes('decisionErrorConflict'), 'the original write failure remains visible during refresh')
        const blocked = findAll(harness.render(), node => node.type === harness.ui.Button && node['data-action'] === scenario.action)
        assert.equal(blocked.length === 0 || blocked[0].disabled, true, 'Snapshot actions stay disabled while authoritative detail reloads')
        refreshFailure.resolve()
        await confirmation
      } else {
        await dialog.onConfirm()
      }
      await harness.flush()
      assert.deepEqual(actionCalls, [[scenario.snapshotId, scenario.revision]])
      if (fails) {
        assert.ok(agentReads > beforeReads, 'failed writes reread without retrying the mutation')
        const review = productLearning(harness)
        const action = findAll(review, node => node.type === harness.ui.Button && node['data-action'] === scenario.action)[0]
        assert.equal(action.disabled, false, 'actions re-enable only after authoritative detail arrives')
        assert.ok(textOf(harness.render()).includes('decisionErrorConflict'), 'rereading never erases the write failure')
      } else {
        assert.ok(agentReads > beforeReads, 'successful writes reread the authoritative Agent')
      }
      await harness.flush()
      assert.equal(actionCalls.length, 1, 'no automatic retry')
      harness.unmount()
    }
  }
})

test('failed Snapshot refreshes preserve the write error and never re-enable stale actions', async () => {
  for (const failureAt of ['agent', 'detail']) {
    const agent = {
      agentId: 'a', name: 'A', state: 'enabled', currentSnapshotId: 'ms_current',
      learningRuns: [{ learningRunId: 'lr_candidate', outcome: 'candidate', revision: 4 }, { learningRunId: 'lr_current', outcome: 'published', revision: 5 }],
      snapshots: [
        { snapshotId: 'ms_candidate', state: 'draft', version: 4, revision: 2, learningRunId: 'lr_candidate', parentSnapshotId: 'ms_current' },
        { snapshotId: 'ms_current', state: 'published', version: 3, revision: 11, learningRunId: 'lr_current', parentSnapshotId: null },
      ],
    }
    let failRefresh = false
    let mutations = 0
    const harness = await createPageHarness({ actions: {
      agents: async () => [agent], inbox: async () => [],
      agent: async () => { if (failRefresh && failureAt === 'agent') throw Object.assign(new Error('Agent refresh offline'), { code: 'NETWORK' }); return agent },
      learningRun: async id => {
        if (failRefresh && failureAt === 'detail') throw Object.assign(new Error('detail refresh offline'), { code: 'NETWORK' })
        const candidate = id === 'lr_candidate'
        return { learningRunId: id, agentId: 'a', outcome: candidate ? 'candidate' : 'published', revision: candidate ? 4 : 5, operations: [], inputFrozen: { parentSnapshotId: candidate ? 'ms_current' : null, ...(candidate ? { parentSnapshotRevision: 11 } : {}) }, replay: { passed: true } }
      },
      memorySnapshot: async id => {
        const candidate = id === 'ms_candidate'
        return { snapshotId: id, agentId: 'a', learningRunId: candidate ? 'lr_candidate' : 'lr_current', state: candidate ? 'draft' : 'published', version: candidate ? 4 : 3, revision: candidate ? 9 : 11, parentSnapshotId: candidate ? 'ms_current' : null, principles: [] }
      },
      snapshotPublish: async () => { mutations += 1; throw Object.assign(new Error('stale source'), { code: 'STALE_SOURCE' }) },
    } })
    await openAgentDetail(harness)
    const publish = findAll(productLearning(harness), node => node.type === harness.ui.Button && node['data-action'] === 'learning-publish')[0]
    assert.equal(publish.disabled, false)
    await publish.onClick()
    const dialog = findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog && node.id === 'weir-da-learning-publish')[0]
    failRefresh = true
    await dialog.onConfirm()
    await harness.flush()
    assert.equal(mutations, 1, 'refresh failure never retries the Snapshot mutation')
    assert.ok(textOf(harness.render()).includes('decisionErrorConflict'))
    const buttons = findAll(harness.render(), node => node.type === harness.ui.Button && ['learning-publish', 'learning-reject', 'learning-rollback'].includes(node['data-action']))
    assert.ok(buttons.every(button => button.disabled), `${failureAt} refresh leaves every Snapshot action blocked`)
    harness.unmount()
  }
})

test('cross-root sources keep bounded excerpts in place and only confirmed current-root records can navigate', async () => {
  const sources = [
    { sourceId: 'dc_cross', kind: 'case', caseId: 'dc_cross', revision: 3, excerpt: 'Authorized cross-root excerpt', scope: { workspaces: ['/repo'] } },
    { sourceId: 'fb_cross', kind: 'correction', caseId: 'dc_cross', revision: 1, direction: 'Bounded correction direction', scope: { workspaces: ['/repo'] } },
    { sourceId: 'dc_local', kind: 'case', caseId: 'dc_local', revision: 2, excerpt: 'Current-root excerpt', scope: { workspaces: ['/repo'] } },
  ]
  const initial = {
    agentId: 'a', name: 'A', state: 'enabled', currentSnapshotId: null,
    learningRuns: [{ learningRunId: 'lr_candidate', outcome: 'candidate', revision: 2 }],
    snapshots: [{ snapshotId: 'ms_candidate', state: 'draft', version: 1, revision: 1, learningRunId: 'lr_candidate', parentSnapshotId: null }],
  }
  let allowNavigation = true
  const recordCalls = []
  const recordDetail = { case: { caseId: 'dc_local', agentId: 'a', state: 'closed', closing: 'answered', feedbackState: 'none', request: { questions: [{ id: 'q', question: 'Local source question' }] }, decision: { answers: [{ id: 'q', selected: ['Local answer'] }] } }, attempts: [], feedback: [] }
  const harness = await createPageHarness({ actions: {
    agents: async () => [initial], inbox: async () => [], agent: async () => initial,
    learningRun: async () => ({ learningRunId: 'lr_candidate', agentId: 'a', outcome: 'candidate', revision: 2, operations: [], inputFrozen: { parentSnapshotId: null }, sourceRecords: sources }),
    memorySnapshot: async () => ({ snapshotId: 'ms_candidate', agentId: 'a', learningRunId: 'lr_candidate', state: 'draft', version: 1, revision: 1, parentSnapshotId: null, principles: [], sourceRecords: sources }),
    record: async id => {
      recordCalls.push(id)
      if (id === 'dc_cross') return null
      if (id === 'dc_local' && allowNavigation) return recordDetail
      return null
    },
    records: async () => ({ records: [recordDetail.case], nextCursor: null }),
  } })
  await openAgentDetail(harness)
  let review = productLearning(harness)
  const text = textOf(review)
  for (const excerpt of ['Authorized cross-root excerpt', 'Bounded correction direction', 'Current-root excerpt']) assert.ok(text.includes(excerpt), excerpt)
  const sourceRows = findAll(review, node => typeof node['data-learning-source-record'] === 'string')
  assert.equal(sourceRows.length, 3)
  for (const id of ['dc_cross', 'fb_cross']) {
    const row = sourceRows.find(node => node['data-learning-source-record'] === id)
    assert.equal(findAll(row, node => node.type === harness.ui.Button && node['data-action'] === 'open-learning-record').length, 0, id)
  }
  const localRow = sourceRows.find(node => node['data-learning-source-record'] === 'dc_local')
  const open = findAll(localRow, node => node.type === harness.ui.Button && node['data-action'] === 'open-learning-record')[0]
  assert.ok(open, 'only the confirmed current-root record has navigation')
  assert.equal(textOf(open).includes('dc_local'), false)

  allowNavigation = false
  await open.onClick()
  await harness.flush()
  assert.equal(findAll(harness.render(), node => node.type === 'section' && node['data-view'] === 'agents').length, 1, 'a failed revalidation never switches to an empty detail')
  assert.equal(findAll(harness.render(), node => node['data-record-detail'] === 'dc_local').length, 0)

  allowNavigation = true
  review = productLearning(harness)
  const retryOpen = findAll(review, node => node.type === harness.ui.Button && node['data-action'] === 'open-learning-record')[0]
  await retryOpen.onClick()
  await harness.flush()
  assert.equal(findAll(harness.render(), node => node['data-record-detail'] === 'dc_local').length, 1)
  assert.ok(recordCalls.filter(id => id === 'dc_cross').length >= 1)
  assert.ok(recordCalls.filter(id => id === 'dc_local').length >= 3, 'access check plus each explicit navigation revalidation')
  harness.unmount()
})

test('advanced diagnostics retain runs, Snapshots, operations, frozen input, replay, hashes, and full diff while old current stays restorable', async () => {
  const host = await createPageHarness({ actions: {} })
  const newer = Array.from({ length: 21 }, (_, index) => {
    const version = 22 - index
    return { snapshotId: `ms_draft_${version}`, state: 'draft', version, revision: 1, learningRunId: `lr_draft_${version}`, parentSnapshotId: 'ms_current' }
  })
  const currentSummary = { snapshotId: 'ms_current', state: 'published', version: 1, revision: 7, learningRunId: 'lr_current', parentSnapshotId: 'ms_previous', contentHash: 'd'.repeat(64) }
  const agent = {
    agentId: 'a', state: 'enabled', currentSnapshotId: 'ms_current',
    learningRuns: newer.map(snapshot => ({ learningRunId: snapshot.learningRunId, outcome: 'rejected', revision: 2 })),
    snapshots: [...newer, currentSummary],
  }
  const run = {
    learningRunId: 'lr_current', agentId: 'a', outcome: 'published', revision: 6,
    operations: [{ op: 'refine', principleId: 'pr_current', text: 'Current rule', sources: ['dc_source'] }],
    inputFrozen: { requestId: 'req-current', parentSnapshotId: 'ms_previous', parentSnapshotRevision: 4, caseIds: ['dc_source'], revisions: { dc_source: 3 }, inputHash: 'a'.repeat(64), feedbackDigest: 'b'.repeat(64) },
    replay: { passed: true, detail: null, metrics: { operationCount: 1, sourceCount: 1 }, finalHash: 'c'.repeat(64) },
    sourceRecords: [{ sourceId: 'dc_source', kind: 'case', excerpt: 'Bounded source' }],
  }
  const currentSnapshot = { ...currentSummary, agentId: 'a', principles: [{ principleId: 'pr_current', text: 'Current rule', scope: { paths: ['src'] }, sources: ['dc_source'], state: 'active' }] }
  const inspection = {
    agentId: 'a', run, snapshot: currentSnapshot,
    parentSnapshot: { snapshotId: 'ms_previous', agentId: 'a', state: 'published', revision: 4, principles: [{ principleId: 'pr_current', text: 'Earlier rule', scope: {}, sources: [], state: 'active' }] },
  }
  const detail = { agentId: 'a', candidate: null, inspection, current: { agentId: 'a', snapshot: currentSnapshot, run } }
  const confirmations = []
  const selectedRuns = []
  const selectedSnapshots = []
  const rendered = learning.AgentLearning({
    agent, detail, ui: host.ui, t: key => key, candidateReadiness: host.model.candidateReadiness,
    confirmAction: action => confirmations.push(action), selectRun: id => selectedRuns.push(id), selectSnapshot: id => selectedSnapshots.push(id),
  })
  const ordinary = textOf(rendered)
  assert.ok(ordinary.includes('decisionPrincipleVersion 1'))
  for (const technical of ['ms_current', 'lr_current', 'decisionLearningRuns', 'decisionSnapshots', 'decisionOperations', 'decisionFrozenInput', 'decisionPrincipleDiff']) assert.equal(ordinary.includes(technical), false, technical)
  const rollback = findAll(rendered, node => node.type === host.ui.Button && node['data-action'] === 'learning-rollback')[0]
  assert.equal(rollback.disabled, false)
  await rollback.onClick()
  assert.deepEqual(confirmations, [{ kind: 'snapshotRollback', snapshotId: 'ms_current', expectedRevision: 7, currentVersion: 1 }])

  const disclosure = findAll(rendered, node => node.type === host.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0]
  const advanced = disclosure.children()
  const diagnosticText = textOf(advanced)
  for (const value of [
    'decisionLearningRuns', 'decisionSnapshots', 'decisionOperations', 'decisionFrozenInput', 'decisionStructuralReplay', 'decisionPrincipleDiff',
    'lr_current', 'ms_current', 'ms_previous', 'pr_current', 'dc_source', 'req-current', 'Current rule', 'Earlier rule',
    'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64),
  ]) assert.ok(diagnosticText.includes(value), value)
  assert.ok(findAll(advanced, node => node['data-snapshot-id'] === 'ms_current').length > 0)
  await findAll(advanced, node => node.type === host.ui.Button && node['data-learning-run-id'] === 'lr_draft_22')[0].onClick()
  await findAll(advanced, node => node.type === host.ui.Button && node['data-snapshot-id'] === 'ms_current')[0].onClick()
  assert.deepEqual(selectedRuns, ['lr_draft_22'])
  assert.deepEqual(selectedSnapshots, ['ms_current'])
  assert.equal(/qualityScore|decisionQualityScore/.test(diagnosticText), false)
  const controls = findAll(advanced, node => node.type === host.ui.Button).map(node => node['data-action'])
  assert.equal(controls.some(value => /auto|publish|generatedDescription/i.test(String(value))), false)
  host.unmount()
})

test('Client actions expose six P3 methods with sessionId, requestId, and expectedRevision intact', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-actions.js')
  const calls = []
  const rpc = async (_connection, method, args) => { calls.push({ method, args }); return { ok: true } }
  const actions = exports.createDecisionActions('connection', 'child', rpc)
  await actions.learningStart('agent-a', 'req-client')
  await actions.learningRun('lr_one')
  await actions.snapshotPublish('ms_one', 4)
  await actions.snapshotReject('ms_one', 4)
  await actions.snapshotRollback('ms_one', 5)
  await actions.memorySnapshot('ms_one')
  assert.deepEqual(calls.map(call => call.method), [
    'learningStart', 'learningRun', 'snapshotPublish', 'snapshotReject', 'snapshotRollback', 'memorySnapshot',
  ])
  for (const call of calls) assert.equal(call.args.sessionId, 'child')
  assert.deepEqual(calls[0].args, { sessionId: 'child', agentId: 'agent-a', requestId: 'req-client' })
  assert.deepEqual(calls[2].args, { sessionId: 'child', snapshotId: 'ms_one', expectedRevision: 4 })
  assert.deepEqual(calls[4].args, { sessionId: 'child', snapshotId: 'ms_one', expectedRevision: 5 })
})

test('Agent detail exposes the single candidate review path without a fifth view or automatic action', async () => {
  const agent = { agentId: 'a', name: 'A', state: 'enabled' }
  const agentDetail = {
    ...agent, scope: { workspaces: ['/repo'] }, generatedDescription: { revision: 0, text: '' }, descriptionHistory: [],
    currentSnapshotId: 'ms_current', learningRuns: [{ learningRunId: 'lr_candidate', outcome: 'candidate', revision: 2 }],
    snapshots: [{ snapshotId: 'ms_candidate', state: 'draft', version: 2, learningRunId: 'lr_candidate', parentSnapshotId: 'ms_current' }, { snapshotId: 'ms_current', state: 'published', version: 1, learningRunId: 'lr_current', revision: 2, parentSnapshotId: null }],
  }
  const harness = await createPageHarness({ actions: {
    agents: async () => [agent], inbox: async () => [], agent: async () => agentDetail,
    learningRun: async id => ({ learningRunId: id, agentId: 'a', outcome: 'candidate', inputFrozen: { parentSnapshotId: 'ms_current' }, operations: [] }),
    memorySnapshot: async id => ({ snapshotId: id, agentId: 'a', learningRunId: 'lr_candidate', state: id === 'ms_candidate' ? 'draft' : 'published', revision: 2, principles: [] }),
  } })
  const tree = await openAgentDetail(harness)
  const rendered = renderedLearning(harness, tree)
  const text = textOf(rendered)
  for (const value of ['decisionCurrentSnapshot', 'decisionPendingReview', 'decisionLearningOutcome_candidate', 'decisionPublish', 'decisionReject']) assert.ok(text.includes(value), value)
  for (const value of ['ms_current', 'lr_candidate', 'ms_candidate']) assert.equal(text.includes(value), false, value)
  const actions = findAll(rendered, node => node.type === harness.ui.Button).map(button => button['data-action'])
  assert.deepEqual(actions, ['learning-rollback', 'learning-publish', 'learning-reject'])
  const nav = findAll(tree, node => node.type === 'nav' && node['data-decision-primary-nav'] === true)[0]
  assert.deepEqual(findAll(nav, node => node.type === harness.ui.Button).map(button => button['data-view']), ['inbox', 'records', 'agents'])
  assert.equal(actions.some(label => /auto|export|generatedDescription|import/i.test(String(label))), false)
  harness.unmount()
})

test('Attempt Context Pack shows actual L2 pins, principles, L5 sources, and exclusions while preserving pinned-empty truth', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({
    jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }),
  }))
  const populated = exports.AttemptContextPack({
    attempt: {
      attemptId: 'da_l2',
      pins: { memorySnapshotId: 'ms_two', memorySnapshotRevision: 4, memorySnapshotHash: 'd'.repeat(64) },
      packManifest: {
        layerSizes: { L2: 120, L3: 0, L5: 300 },
        memory: {
          L2: {
            schemaVersion: 1, status: 'populated', snapshotId: 'ms_two', snapshotRevision: 4, snapshotHash: 'd'.repeat(64),
            principleIds: ['pr_actual'],
            items: [{ principleId: 'pr_actual', sources: ['dc_source'], evidenceIds: ['ev_source'] }],
            exclusions: [{ principleId: 'pr_excluded', reason: 'SOURCE_UNAVAILABLE' }],
          },
          L3: { schemaVersion: 1, sourceCaseIds: [] },
        },
        omissions: ['L2_PRINCIPLE_OMITTED'],
      },
    },
    t: key => key,
  })
  const text = JSON.stringify(populated)
  for (const value of ['ms_two', 'pr_actual', 'dc_source', 'ev_source', 'pr_excluded', 'SOURCE_UNAVAILABLE', 'L2_PRINCIPLE_OMITTED']) {
    assert.equal(text.includes(value), true, value)
  }
  assert.equal(text.includes('decisionReviewedPrinciples'), true)
  assert.equal(text.includes('decisionNoMemory'), false, 'actual L2 use must not claim no L2/L3 memory')
  assert.deepEqual(findAll(populated, node => ['button', 'input', 'select', 'textarea'].includes(node.type)), [])

  const pinnedEmpty = JSON.stringify(exports.AttemptContextPack({
    attempt: {
      attemptId: 'da_pinned_empty', pins: { memorySnapshotId: 'ms_empty', memorySnapshotRevision: 2 },
      packManifest: {
        layerSizes: { L2: 0, L3: 0 },
        memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: 'ms_empty', snapshotRevision: 2, principleIds: [], items: [], exclusions: [] } },
        omissions: [],
      },
    },
    t: key => key,
  }))
  assert.equal(pinnedEmpty.includes('ms_empty'), true)
  assert.equal(pinnedEmpty.includes('decisionMemoryEmpty'), true)
  assert.equal(pinnedEmpty.includes('pr_actual'), false)
})


test('Agent selection loads actual run, Snapshot, and parent details without polling', async () => {
  const calls = []
  const agent = {
    agentId: 'a', name: 'A', state: 'enabled', currentSnapshotId: 'ms_current', learningRuns: [{ learningRunId: 'lr_candidate', outcome: 'candidate', revision: 2 }],
    snapshots: [{ snapshotId: 'ms_candidate', state: 'draft', version: 2, revision: 1, learningRunId: 'lr_candidate', parentSnapshotId: 'ms_current' }],
  }
  const actions = {
    agents: async () => [agent], inbox: async () => [],
    agent: async id => { calls.push(['agent', id]); return agent },
    learningRun: async id => { calls.push(['learningRun', id]); return { learningRunId: id, agentId: 'a', outcome: 'candidate', inputFrozen: { parentSnapshotId: 'ms_current' }, operations: [] } },
    memorySnapshot: async id => { calls.push(['memorySnapshot', id]); return { snapshotId: id, agentId: 'a', learningRunId: id === 'ms_candidate' ? 'lr_candidate' : 'lr_current', principles: [] } },
  }
  const harness = await createPageHarness({ actions })
  await openAgentDetail(harness)
  assert.deepEqual(calls, [
    ['agent', 'a'], ['learningRun', 'lr_candidate'], ['memorySnapshot', 'ms_candidate'], ['memorySnapshot', 'ms_current'],
  ])
  harness.unmount()
})

test('advanced learning diagnostics expose every real lifecycle state and conflicting starts stay blocked', async () => {
  const host = await createPageHarness({ actions: {} })
  const outcomes = ['running', 'candidate', 'published', 'rejected', 'rolled_back', 'failed']
  const agent = {
    agentId: 'a', state: 'enabled', currentSnapshotId: 'ms_published',
    learningRuns: outcomes.map(outcome => ({ learningRunId: `lr_${outcome}`, outcome, revision: 1 })),
    snapshots: [
      { snapshotId: 'ms_candidate', state: 'draft', version: 3, revision: 1, learningRunId: 'lr_candidate' },
      { snapshotId: 'ms_published', state: 'published', version: 2, revision: 2, learningRunId: 'lr_published' },
      { snapshotId: 'ms_rolled_back', state: 'rolled_back', version: 1, revision: 2, learningRunId: 'lr_rolled_back' },
    ],
  }
  const view = learning.learningView({ agent, candidateReadiness: host.model.candidateReadiness })
  assert.equal(view.canStart, false)
  const rendered = learning.AgentLearning({ agent, detail: null, ui: host.ui, candidateReadiness: host.model.candidateReadiness, t: key => key })
  const advanced = findAll(rendered, node => node.type === host.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0].children()
  const text = textOf(advanced)
  for (const outcome of outcomes) assert.ok(text.includes(`decisionLearningOutcome_${outcome}`), outcome)
  for (const state of ['draft', 'published', 'rolled_back']) assert.ok(text.includes(`decisionSnapshotState_${state}`), state)
  assert.equal(learning.learningView({ agent: { ...agent, state: 'disabled', learningRuns: [], snapshots: [], currentSnapshotId: null }, candidateReadiness: host.model.candidateReadiness }).startBlockKey, 'decisionLearningStartUnavailable')
  host.unmount()
})


test('current Snapshot detail automatically resolves even when its run is outside the recent-run cap', async () => {
  const calls = []
  const newer = Array.from({ length: 21 }, (_, index) => {
    const version = 22 - index
    return { snapshotId: `ms_rejected_${version}`, state: 'draft', version, revision: 1, learningRunId: `lr_rejected_${version}` }
  })
  const agent = {
    agentId: 'a', name: 'A', state: 'enabled', currentSnapshotId: 'ms_current',
    learningRuns: newer.map(snapshot => ({ learningRunId: snapshot.learningRunId, outcome: 'rejected', revision: 2 })),
    snapshots: [...newer, { snapshotId: 'ms_current', state: 'published', version: 1, revision: 7, learningRunId: 'lr_current', parentSnapshotId: null }],
  }
  const actions = {
    agents: async () => [agent], inbox: async () => [], agent: async () => agent,
    learningRun: async id => { calls.push(['learningRun', id]); return { learningRunId: id, agentId: 'a', outcome: 'published', inputFrozen: { parentSnapshotId: null }, operations: [] } },
    memorySnapshot: async id => { calls.push(['memorySnapshot', id]); return { snapshotId: id, agentId: 'a', learningRunId: 'lr_current', state: 'published', version: 1, revision: 7, principles: [] } },
  }
  const harness = await createPageHarness({ actions })
  await openAgentDetail(harness)
  assert.deepEqual(calls.map(call => call.join(':')).sort(), ['learningRun:lr_current', 'learningRun:lr_rejected_22', 'memorySnapshot:ms_current', 'memorySnapshot:ms_rejected_22'].sort(), 'latest inspection and out-of-cap current detail both load')
  const rendered = renderedLearning(harness)
  assert.equal(findAll(rendered, node => node.type === harness.ui.Button && node['data-action'] === 'learning-rollback')[0].disabled, false)
  harness.unmount()
})

test('latest failed inspection reports only real no-change outcomes while preserving current version and rollback', async () => {
  for (const [replayDetail, expectedStatus] of [['NO_CANDIDATE_CHANGES', 'decisionLearningNoChanges'], ['MODEL_OUTPUT_INVALID', 'decisionLearningOutcome_failed']]) {
    const calls = []
    const agent = {
      agentId: 'a', name: 'A', state: 'enabled', currentSnapshotId: 'ms_current',
      learningRuns: [{ learningRunId: 'lr_latest_failed', outcome: 'failed', revision: 6 }, { learningRunId: 'lr_current', outcome: 'published', revision: 5 }],
      snapshots: [{ snapshotId: 'ms_current', state: 'published', version: 3, revision: 7, learningRunId: 'lr_current', parentSnapshotId: null }],
    }
    const harness = await createPageHarness({ actions: {
      agents: async () => [agent], inbox: async () => [], agent: async () => agent,
      learningRun: async id => {
        calls.push(['learningRun', id])
        if (id === 'lr_latest_failed') return { learningRunId: id, agentId: 'a', outcome: 'failed', revision: 6, operations: [], inputFrozen: { parentSnapshotId: 'ms_current' }, replay: { passed: false, detail: replayDetail }, sourceRecords: [] }
        return { learningRunId: id, agentId: 'a', outcome: 'published', revision: 5, operations: [{ op: 'add' }], inputFrozen: { parentSnapshotId: null }, replay: { passed: true } }
      },
      memorySnapshot: async id => { calls.push(['memorySnapshot', id]); return { snapshotId: id, agentId: 'a', learningRunId: 'lr_current', state: 'published', version: 3, revision: 7, parentSnapshotId: null, principles: [] } },
    } })
    await openAgentDetail(harness)
    assert.ok(calls.some(call => call[0] === 'learningRun' && call[1] === 'lr_latest_failed'), 'the latest real run is inspected')
    assert.ok(calls.some(call => call[0] === 'memorySnapshot' && call[1] === 'ms_current'), 'current Snapshot detail stays loaded')
    const rendered = renderedLearning(harness)
    const text = textOf(rendered)
    assert.ok(text.includes(expectedStatus), `${replayDetail} projects ${expectedStatus}`)
    assert.ok(text.includes('decisionPrincipleVersion 3'))
    assert.equal(text.includes(expectedStatus === 'decisionLearningNoChanges' ? 'decisionLearningOutcome_failed' : 'decisionLearningNoChanges'), false)
    const rollback = findAll(rendered, node => node.type === harness.ui.Button && node['data-action'] === 'learning-rollback')[0]
    assert.equal(rollback.disabled, false)
    assert.equal(findAll(rendered, node => node.type === harness.ui.Button && ['learning-publish', 'learning-reject'].includes(node['data-action'])).length, 0)
    harness.unmount()
  }
})

test('learning review renders bounded Case and correction excerpts without exposing unrelated source content', async () => {
  const host = await createPageHarness({ actions: {} })
  const sourceRecords = [
    { sourceId: 'dc_cross_root', kind: 'case', caseId: 'dc_cross_root', revision: 3, scope: { workspaces: ['/repo'] }, excerpt: 'Answer q: Cross-root A\nQuestion q: CROSS ROOT SOURCE QUESTION' },
    { sourceId: 'fb_correction', kind: 'correction', feedbackId: 'fb_correction', caseId: 'dc_cross_root', revision: 1, direction: 'Use the corrected direction', scope: { workspaces: ['/repo'] }, supersedes: ['dc_cross_root'] },
  ]
  const agent = {
    agentId: 'a', state: 'enabled', currentSnapshotId: null,
    learningRuns: [{ learningRunId: 'lr_review', outcome: 'candidate', revision: 2 }],
    snapshots: [{ snapshotId: 'ms_review', state: 'draft', version: 1, revision: 1, learningRunId: 'lr_review', parentSnapshotId: null }],
  }
  const detail = {
    agentId: 'a', recordAccess: {},
    run: { learningRunId: 'lr_review', agentId: 'a', outcome: 'candidate', revision: 2, inputFrozen: { parentSnapshotId: null, caseIds: ['dc_cross_root'], feedbackIds: ['fb_correction'] }, operations: [], sourceRecords },
    snapshot: { snapshotId: 'ms_review', agentId: 'a', learningRunId: 'lr_review', state: 'draft', version: 1, revision: 1, principles: [], sourceRecords },
  }
  const rendered = learning.AgentLearning({ agent, detail, ui: host.ui, candidateReadiness: host.model.candidateReadiness, t: key => key })
  const disclosures = findAll(rendered, node => typeof node['data-learning-source-record'] === 'string')
  assert.deepEqual(disclosures.map(node => node['data-learning-source-record']), ['dc_cross_root', 'fb_correction'])
  const text = textOf(disclosures)
  for (const value of ['Answer q: Cross-root A', 'CROSS ROOT SOURCE QUESTION', 'Use the corrected direction', '/repo']) assert.ok(text.includes(value), value)
  assert.equal(text.includes('DO_NOT_EXPOSE_TASK_SUMMARY'), false)
  for (const disclosure of disclosures) assert.deepEqual(findAll(disclosure, node => ['button', 'input', 'textarea', 'select'].includes(node.type) || node.type === host.ui.Button), [])
  host.unmount()
})
