import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) findAll(item, predicate, found)
    else if (value && typeof value === 'object') findAll(value, predicate, found)
  }
  return found
}

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

test('existing Agent detail exposes manual governance and candidate state without a fifth view or automatic action', async () => {
  const agent = { agentId: 'a', name: 'A', state: 'enabled' }
  const agentDetail = {
    ...agent, scope: { workspaces: ['/repo'] }, generatedDescription: { revision: 0, text: '' }, descriptionHistory: [],
    currentSnapshotId: 'ms_current',
    learningRuns: [{ learningRunId: 'lr_candidate', outcome: 'candidate', revision: 2 }],
    snapshots: [{ snapshotId: 'ms_candidate', state: 'draft', version: 2 }],
  }
  const states = [
    'agents', [agent], [], [], null, null, null, agentDetail, {}, null, '', '', '',
  ]
  let cursor = 0
  const react = { useState: initial => [cursor < states.length ? states[cursor++] : initial, () => {}], useEffect: () => {} }
  const { exports } = await loadClientChunk('lib/client.decision-page.js', name => name === 'react' ? react : {
    jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }),
  })
  const rendered = exports.DecisionPage({
    connection: {}, decisionRpc: async () => {}, createDecisionActions: () => ({}),
    getSessionId: () => 'root', t: key => key,
  })
  const text = JSON.stringify(rendered)
  for (const value of ['ms_current', 'lr_candidate', 'ms_candidate', 'candidate', 'draft']) assert.equal(text.includes(value), true, value)
  const buttons = findAll(rendered, node => node.type === 'button')
  const labels = buttons.map(button => button.children)
  for (const label of ['decisionConsolidate', 'decisionPublish', 'decisionReject', 'decisionRollback']) assert.ok(labels.includes(label), label)
  const nav = findAll(rendered, node => node.type === 'nav')
  assert.equal(nav.length, 1)
  assert.deepEqual(nav[0].children.map(button => button.key), ['agents', 'records', 'inbox', 'metrics'])
  assert.equal(labels.some(label => /auto|export|generatedDescription|import/i.test(String(label))), false)
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

test('manual governance uses fresh browser UUIDs and latest Snapshot revisions for real actions', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({
    jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }),
  }))
  const calls = []
  const opened = []
  const run = async (...args) => { calls.push(args) }
  const base = { run, pending: null, selectRun: async () => {}, selectSnapshot: async () => {}, openRecord: async id => { opened.push(id) }, t: key => key }
  let uuid = 0
  window.crypto = { randomUUID: () => `browser-uuid-${++uuid}` }
  const empty = exports.AgentLearning({ ...base, agent: { agentId: 'a', state: 'enabled', currentSnapshotId: null, learningRuns: [], snapshots: [] } })
  const emptyText = JSON.stringify(empty)
  for (const key of ['decisionNoCurrentSnapshot', 'decisionNoLearningRuns', 'decisionNoSnapshots', 'decisionNoLearningDetail']) assert.ok(emptyText.includes(key), key)
  const consolidate = findAll(empty, node => node.type === 'button' && node.children === 'decisionConsolidate')[0]
  assert.equal(consolidate.disabled, false)
  await consolidate.onClick()
  await consolidate.onClick()
  assert.deepEqual(calls, [
    ['learningStart', 'a', 'browser-uuid-1'],
    ['learningStart', 'a', 'browser-uuid-2'],
  ])

  const agent = {
    agentId: 'a', state: 'enabled', currentSnapshotId: 'ms_current',
    learningRuns: [
      { learningRunId: 'lr_candidate', outcome: 'candidate', revision: 3 },
      { learningRunId: 'lr_current', outcome: 'published', revision: 4 },
    ],
    snapshots: [
      { snapshotId: 'ms_candidate', state: 'draft', version: 2, revision: 4, learningRunId: 'lr_candidate', parentSnapshotId: 'ms_current' },
      { snapshotId: 'ms_current', state: 'published', version: 1, revision: 8, learningRunId: 'lr_current', parentSnapshotId: null },
    ],
  }
  const detail = {
    agentId: 'a',
    run: {
      learningRunId: 'lr_candidate', agentId: 'a', outcome: 'candidate', revision: 3,
      inputFrozen: { caseIds: ['dc_source'], feedbackIds: ['df_correction'], parentSnapshotId: 'ms_current', parentSnapshotRevision: 8, promptVersion: 'consolidation-contract/1', inputHash: 'a'.repeat(64), feedbackDigest: 'b'.repeat(64) },
      operations: [{ op: 'refine', principleId: 'pr_one', text: 'Use B', scope: { paths: ['src'] }, sources: ['dc_source', 'df_correction'] }],
      replay: { passed: true, metrics: { operationCount: 1, sourceCount: 2, activePrincipleCount: 1, retiredPrincipleCount: 0 }, finalHash: 'c'.repeat(64) },
    },
    snapshot: { snapshotId: 'ms_candidate', state: 'draft', version: 2, revision: 5, principles: [{ principleId: 'pr_one', text: 'Use B', scope: { paths: ['src'] }, sources: ['dc_source'], state: 'active' }] },
    parentSnapshot: { snapshotId: 'ms_current', state: 'published', version: 1, revision: 8, principles: [{ principleId: 'pr_one', text: 'Use A', scope: {}, sources: ['dc_old'], state: 'active' }] },
  }
  const rendered = exports.AgentLearning({ ...base, agent, detail })
  const text = JSON.stringify(rendered)
  for (const value of ['refine', 'Use A', 'Use B', 'dc_old', 'df_correction', 'decisionStructuralReplay', 'decisionReplayPassed', 'decisionFrozenInput', 'decisionOperations', 'decisionPrincipleDiff', 'decisionDiffChanged']) assert.ok(text.includes(value), value)
  for (const [label, expected] of [
    ['decisionPublish', ['snapshotPublish', 'ms_candidate', 5]],
    ['decisionReject', ['snapshotReject', 'ms_candidate', 5]],
    ['decisionRollback', ['snapshotRollback', 'ms_current', 8]],
  ]) {
    const button = findAll(rendered, node => node.type === 'button' && node.children === label)[0]
    assert.equal(button.disabled, false, label)
    await button.onClick()
    assert.deepEqual(calls.at(-1), expected)
  }
  const source = findAll(rendered, node => node.type === 'button' && node.children === 'dc_source')[0]
  await source.onClick()
  assert.deepEqual(opened, ['dc_source'])
  assert.equal(findAll(rendered, node => node.type === 'button' && node.children === 'decisionConsolidate')[0].disabled, true)
})

test('Agent selection loads actual run, Snapshot, and parent details without polling', async () => {
  const calls = []
  const agent = {
    agentId: 'a', name: 'A', state: 'enabled', currentSnapshotId: 'ms_current', learningRuns: [{ learningRunId: 'lr_candidate', outcome: 'candidate', revision: 2 }],
    snapshots: [{ snapshotId: 'ms_candidate', state: 'draft', version: 2, revision: 1, learningRunId: 'lr_candidate', parentSnapshotId: 'ms_current' }],
  }
  const actions = {
    agent: async id => { calls.push(['agent', id]); return agent },
    learningRun: async id => { calls.push(['learningRun', id]); return { learningRunId: id, agentId: 'a', outcome: 'candidate', inputFrozen: { parentSnapshotId: 'ms_current' }, operations: [] } },
    memorySnapshot: async id => { calls.push(['memorySnapshot', id]); return { snapshotId: id, agentId: 'a', learningRunId: id === 'ms_candidate' ? 'lr_candidate' : 'lr_current', principles: [] } },
  }
  const states = ['agents', [agent], [], [], null, null, null, null, {}, null, '', '', '']
  let cursor = 0
  const react = { useState: initial => [cursor < states.length ? states[cursor++] : initial, () => {}], useEffect: () => {} }
  const { exports } = await loadClientChunk('lib/client.decision-page.js', name => name === 'react' ? react : {
    jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }),
  })
  const rendered = exports.DecisionPage({
    connection: {}, decisionRpc: async () => {}, createDecisionActions: () => actions,
    getSessionId: () => 'root', t: key => key,
  })
  const select = findAll(rendered, node => node.type === 'button' && node.children === 'A · enabled · v0')[0]
  await select.onClick()
  assert.deepEqual(calls, [
    ['agent', 'a'], ['learningRun', 'lr_candidate'], ['memorySnapshot', 'ms_candidate'], ['memorySnapshot', 'ms_current'],
  ])
})

test('Agent governance exposes every real lifecycle state and blocks conflicting starts', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({
    jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }),
  }))
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
  const rendered = exports.AgentLearning({ agent, detail: null, run: async () => {}, pending: null, selectRun: async () => {}, selectSnapshot: async () => {}, openRecord: async () => {}, t: key => key })
  const text = JSON.stringify(rendered)
  for (const outcome of outcomes) assert.ok(text.includes(`decisionLearningOutcome_${outcome}`), outcome)
  for (const state of ['draft', 'published', 'rolled_back']) assert.ok(text.includes(`decisionSnapshotState_${state}`), state)
  assert.equal(findAll(rendered, node => node.type === 'button' && node.children === 'decisionConsolidate')[0].disabled, true)
  const disabled = exports.AgentLearning({ agent: { ...agent, state: 'disabled', learningRuns: [], snapshots: [], currentSnapshotId: null }, detail: null, run: async () => {}, pending: null, selectRun: async () => {}, selectSnapshot: async () => {}, openRecord: async () => {}, t: key => key })
  assert.equal(findAll(disabled, node => node.type === 'button' && node.children === 'decisionConsolidate')[0].disabled, true)
})

test('current Snapshot beyond twenty newer drafts keeps authoritative rollback and detail actions', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({
    jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }),
  }))
  const newer = Array.from({ length: 21 }, (_, index) => {
    const version = 22 - index
    return { snapshotId: `ms_rejected_${version}`, state: 'draft', version, revision: 1, learningRunId: `lr_rejected_${version}` }
  })
  const current = { snapshotId: 'ms_current', state: 'published', version: 1, revision: 7, learningRunId: 'lr_current', parentSnapshotId: null }
  const agent = {
    agentId: 'a', state: 'enabled', currentSnapshotId: 'ms_current',
    learningRuns: newer.map(snapshot => ({ learningRunId: snapshot.learningRunId, outcome: 'rejected', revision: 2 })),
    snapshots: [...newer, current],
  }
  const calls = []
  const selected = []
  const rendered = exports.AgentLearning({
    agent, detail: null, pending: null, run: async (...args) => { calls.push(args) },
    selectRun: async () => {}, selectSnapshot: async id => { selected.push(id) }, openRecord: async () => {}, t: key => key,
  })
  const rollback = findAll(rendered, node => node.type === 'button' && node.children === 'decisionRollback')[0]
  assert.equal(rollback.disabled, false)
  await rollback.onClick()
  assert.deepEqual(calls, [['snapshotRollback', 'ms_current', 7]])
  const currentButton = findAll(rendered, node => node.type === 'button' && node.children === 'ms_current · v1 · decisionSnapshotState_published · r7')[0]
  await currentButton.onClick()
  assert.deepEqual(selected, ['ms_current'])
})

test('current Snapshot detail resolves even when its run is outside the recent-run cap', async () => {
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
    learningRun: async id => { calls.push(['learningRun', id]); return { learningRunId: id, agentId: 'a', outcome: 'published', inputFrozen: { parentSnapshotId: null }, operations: [] } },
    memorySnapshot: async id => { calls.push(['memorySnapshot', id]); return { snapshotId: id, agentId: 'a', learningRunId: 'lr_current', principles: [] } },
  }
  const states = ['agents', [agent], [], [], null, null, null, agent, {}, null, '', '', '', null, null]
  let cursor = 0
  const react = { useState: initial => [cursor < states.length ? states[cursor++] : initial, () => {}], useEffect: () => {} }
  const { exports } = await loadClientChunk('lib/client.decision-page.js', name => name === 'react' ? react : {
    jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }),
  })
  const rendered = exports.DecisionPage({
    connection: {}, decisionRpc: async () => {}, createDecisionActions: () => actions,
    getSessionId: () => 'root', t: key => key,
  })
  const current = findAll(rendered, node => node.type === 'button' && node.children === 'ms_current · v1 · decisionSnapshotState_published · r7')[0]
  await current.onClick()
  assert.deepEqual(calls, [['learningRun', 'lr_current'], ['memorySnapshot', 'ms_current']])
})

test('learning detail renders bounded Case and correction source disclosures read-only', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({
    jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }),
  }))
  const sourceRecords = [
    { sourceId: 'dc_cross_root', kind: 'case', caseId: 'dc_cross_root', revision: 3, scope: { workspaces: ['/repo'] }, excerpt: 'Answer q: Cross-root A\nQuestion q: CROSS ROOT SOURCE QUESTION' },
    { sourceId: 'fb_correction', kind: 'correction', feedbackId: 'fb_correction', caseId: 'dc_cross_root', revision: 1, direction: 'Use the corrected direction', scope: { workspaces: ['/repo'] }, supersedes: ['dc_cross_root'] },
  ]
  const agent = {
    agentId: 'a', state: 'enabled', currentSnapshotId: null,
    learningRuns: [{ learningRunId: 'lr_review', outcome: 'candidate', revision: 2 }],
    snapshots: [{ snapshotId: 'ms_review', state: 'draft', version: 1, revision: 1, learningRunId: 'lr_review' }],
  }
  const detail = {
    agentId: 'a',
    run: { learningRunId: 'lr_review', agentId: 'a', outcome: 'candidate', revision: 2, inputFrozen: { caseIds: ['dc_cross_root'], feedbackIds: ['fb_correction'] }, operations: [], sourceRecords },
    snapshot: { snapshotId: 'ms_review', agentId: 'a', state: 'draft', version: 1, revision: 1, principles: [], sourceRecords },
  }
  const rendered = exports.AgentLearning({
    agent, detail, pending: null, run: async () => {}, selectRun: async () => {}, selectSnapshot: async () => {}, openRecord: async () => {}, t: key => key,
  })
  const disclosures = findAll(rendered, node => typeof node['data-learning-source-record'] === 'string')
  assert.deepEqual(disclosures.map(node => node['data-learning-source-record']), ['dc_cross_root', 'fb_correction'])
  const text = JSON.stringify(disclosures)
  for (const value of ['Answer q: Cross-root A', 'CROSS ROOT SOURCE QUESTION', 'Use the corrected direction', '/repo', 'dc_cross_root']) assert.ok(text.includes(value), value)
  assert.equal(text.includes('DO_NOT_EXPOSE_TASK_SUMMARY'), false)
  for (const disclosure of disclosures) assert.deepEqual(findAll(disclosure, node => ['button', 'input', 'textarea', 'select'].includes(node.type)), [])
})
