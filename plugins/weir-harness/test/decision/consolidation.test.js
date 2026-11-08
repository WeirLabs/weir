import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brokerFixture, insertSnapshot, seedUserDecision, snapshotForRun, validAdd } from './p3-fixtures.js'

test('consolidation-contract/1 sends only bounded frozen authority without tools or temperature', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'wire-source', {
    question: 'QUESTION-AFTER-TOKEN', selected: 'ANSWER-FIRST-TOKEN', taskSummary: 'TASK-SUMMARY-SECRET',
  })
  await f.broker.feedbackStore.append({
    actor: { kind: 'user' }, caseId: source.caseId, kind: 'comment',
    payload: { text: `COMMENT-BOUND-${'c'.repeat(700)}` },
  })
  const other = await f.broker.profileUpsert({ workspaceKey: '/other', name: 'Other', userDescription: 'OTHER-PROFILE-SECRET' })
  await seedUserDecision(f, 'wire-other', {
    agentId: other.agentId, workspaceKey: '/other', question: 'OTHER-WORKSPACE-SECRET', selected: 'OTHER-ANSWER-SECRET',
  })
  f.respond(() => ({ operations: [validAdd(f, [source.caseId])] }))
  const run = await f.broker.learningStart({
    sessionId: 'root', agentId: f.profile.agentId, requestId: 'req-wire',
  })
  assert.equal(run.outcome, 'candidate')
  assert.deepEqual(run.inputFrozen.caseIds, [source.caseId])
  assert.equal(run.inputFrozen.promptVersion, 'consolidation-contract/1')

  assert.equal(f.requests.length, 1)
  const request = f.requests[0]
  assert.equal(request.system.split('\n')[0], 'Decision consolidation contract v1')
  for (const key of ['tools', 'temperature', 'sessionId']) assert.equal(key in request, false)
  const wire = request.messages.map(message => (message.content ?? []).map(block => block.text ?? '').join('\n')).join('\n')
  assert.ok(wire.indexOf('ANSWER-FIRST-TOKEN') < wire.indexOf('QUESTION-AFTER-TOKEN'))
  assert.ok(wire.indexOf('ANSWER-FIRST-TOKEN') >= 0)
  for (const secret of ['TASK-SUMMARY-SECRET', 'OTHER-PROFILE-SECRET', 'OTHER-WORKSPACE-SECRET', 'OTHER-ANSWER-SECRET', 'c'.repeat(700)]) {
    assert.equal(wire.includes(secret), false)
  }
})

test('strict candidate parsing and authority replay reject missing, foreign, comment-only, and negative-only sources', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'candidate-source')
  const comment = await f.broker.feedbackStore.append({
    actor: { kind: 'user' }, caseId: source.caseId, kind: 'comment', payload: { text: 'A comment is not authority' },
  })
  const down = await f.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: source.caseId, kind: 'rating_down' })
  const other = await f.broker.profileUpsert({ workspaceKey: '/other', name: 'Other', userDescription: 'Other namespace' })
  const foreign = await seedUserDecision(f, 'candidate-foreign', { agentId: other.agentId, workspaceKey: '/other', selected: 'B' })
  const cases = [
    ['no-source', { operations: [validAdd(f, [])] }],
    ['cross-namespace', { operations: [validAdd(f, [foreign.caseId])] }],
    ['comment-only', { operations: [validAdd(f, [comment.feedbackId], { inputFeedbackIds: [comment.feedbackId] })] }],
    ['rating-down-inverse', { operations: [validAdd(f, [down.feedbackId], { text: 'Prefer B because the user disliked A', inputFeedbackIds: [down.feedbackId] })] }],
    ['unknown-operation', { operations: [{ ...validAdd(f, [source.caseId]), op: 'invert' }] }],
    ['unknown-field', { operations: [{ ...validAdd(f, [source.caseId]), confidence: 0.99 }] }],
    ['empty-operations', { operations: [] }],
  ]
  for (const [name, output] of cases) {
    f.respond(() => output)
    const run = await f.broker.learningStart({
      sessionId: 'root', agentId: f.profile.agentId, requestId: `req-${name}`,
    })
    assert.equal(run.outcome, 'failed', name)
    if (name === 'empty-operations') assert.equal(run.replay?.detail, 'NO_CANDIDATE_CHANGES')
    assert.equal((await f.broker.agent({ sessionId: 'root', agentId: f.profile.agentId })).currentSnapshotId, null, name)
  }
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 0)
})

test('add/refine/merge/narrow/retire replay deterministically into a complete draft without auto-publish', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'replay-source')
  const scope = { workspaces: [f.workspace] }
  const parentPrinciples = [
    { principleId: 'pr_refine', text: 'Refine me', scope, sources: [source.caseId], state: 'active' },
    { principleId: 'pr_merge_a', text: 'Merge left', scope, sources: [source.caseId], state: 'active' },
    { principleId: 'pr_merge_b', text: 'Merge right', scope, sources: [source.caseId], state: 'active' },
    { principleId: 'pr_narrow', text: 'Narrow me', scope, sources: [source.caseId], state: 'active' },
    { principleId: 'pr_retire', text: 'Retire me', scope, sources: [source.caseId], state: 'active' },
  ]
  insertSnapshot(f, 'ms_parent', 1, 'published', { principles: parentPrinciples })
  f.respond(() => ({ operations: [
    { ...validAdd(f, [source.caseId]), principleId: 'tmp_add' },
    { op: 'refine', principleId: 'pr_refine', text: 'Refined', scope, sources: [source.caseId] },
    { op: 'merge', principleId: 'tmp_merge', targetPrincipleIds: ['pr_merge_a', 'pr_merge_b'], text: 'Merged', scope, sources: [source.caseId] },
    { op: 'narrow', principleId: 'pr_narrow', scope: { workspaces: [f.workspace], paths: ['src'] } },
    { op: 'retire', principleId: 'pr_retire' },
  ] }))
  const run = await f.broker.learningStart({ sessionId: 'root', agentId: f.profile.agentId, requestId: 'req-five-ops' })
  assert.equal(run.outcome, 'candidate')
  assert.equal(run.replay.passed, true)
  assert.equal(run.replay.metrics.operationCount, 5)
  assert.equal(run.replay.metrics.activePrincipleCount, 4)
  assert.equal(run.replay.metrics.retiredPrincipleCount, 3)
  assert.match(run.replay.finalHash, /^[a-f0-9]{64}$/)
  assert.equal(run.inputFrozen.parentSnapshotId, 'ms_parent')
  assert.equal(run.operations.some(operation => ['tmp_add', 'tmp_merge'].includes(operation.principleId)), false)

  const draftRow = snapshotForRun(f, run.learningRunId)
  assert.ok(draftRow)
  const draft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: draftRow.snapshot_id })
  assert.equal(draft.state, 'draft')
  assert.equal(draft.version, 2)
  assert.equal(draft.parentSnapshotId, 'ms_parent')
  assert.equal(draft.learningRunId, run.learningRunId)
  assert.deepEqual(draft.generatedDescription, { revision: 0, text: '' })
  assert.equal(draft.principles.filter(principle => principle.state === 'active').length, 4)
  assert.equal(draft.principles.filter(principle => principle.state === 'retired').length, 3)
  assert.equal((await f.broker.agent({ sessionId: 'root', agentId: f.profile.agentId })).currentSnapshotId, 'ms_parent')
})
