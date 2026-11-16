import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DecisionBroker } from '../../src/decision/broker.js'
import { brokerFixture, insertLearningRun, insertSnapshot, seedUserDecision, snapshotForRun, validAdd } from './p3-fixtures.js'

test('learningStart freezes actual inputs and requestId retries share one model job and candidate', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'frozen-source')
  f.respond(() => ({ operations: [validAdd(f, [source.caseId])] }))
  const input = { sessionId: 'root', agentId: f.profile.agentId, requestId: 'req-idempotent' }
  const first = await f.broker.learningStart(input)
  assert.equal(first.outcome, 'candidate')
  assert.deepEqual(first.inputFrozen.caseIds, [source.caseId])
  assert.equal(first.inputFrozen.revisions[source.caseId], source.revision)
  assert.equal(first.inputFrozen.requestId, 'req-idempotent')
  assert.equal(first.inputFrozen.workspaceKey, f.workspace)
  assert.match(first.inputFrozen.feedbackDigest, /^[a-f0-9]{64}$/)
  assert.match(first.inputFrozen.inputHash, /^[a-f0-9]{64}$/)

  const duplicate = await f.broker.learningStart(input)
  assert.deepEqual(duplicate, first)
  assert.equal(f.requests.length, 1)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM learning_runs').get().n, 1)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 1)

  await f.broker.feedbackStore.append({
    actor: { kind: 'user' }, caseId: source.caseId, kind: 'comment', payload: { text: 'Written after freeze' },
  })
  const reread = await f.broker.learningRun({ sessionId: 'root', learningRunId: first.learningRunId })
  assert.deepEqual(reread.inputFrozen, first.inputFrozen)
  await assert.rejects(f.broker.learningStart({ ...input, requestId: 'req-different' }))
  assert.equal(f.requests.length, 1)
  assert.equal((await f.broker.agent({ sessionId: 'root', agentId: f.profile.agentId })).currentSnapshotId, null)
})

test('publish/reject/rollback enforce expectedRevision, target-state idempotency, and current-version history', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'lifecycle-source')
  f.respond(() => ({ operations: [validAdd(f, [source.caseId])] }))
  const agentInput = { sessionId: 'root', agentId: f.profile.agentId }

  const candidate = await f.broker.learningStart({ ...agentInput, requestId: 'req-publish' })
  const snapshotId = snapshotForRun(f, candidate.learningRunId).snapshot_id
  let snapshot = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  await assert.rejects(
    f.broker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: snapshot.revision + 1 }),
    error => error.code === 'REVISION_CONFLICT',
  )
  assert.equal((await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })).state, 'draft')

  await f.broker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: snapshot.revision })
  const published = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  assert.equal(published.state, 'published')
  assert.equal((await f.broker.learningRun({ sessionId: 'root', learningRunId: candidate.learningRunId })).outcome, 'published')
  assert.equal((await f.broker.agent(agentInput)).currentSnapshotId, snapshotId)
  await f.broker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: snapshot.revision })
  assert.deepEqual(await f.broker.memorySnapshot({ sessionId: 'root', snapshotId }), published)

  await f.broker.snapshotRollback({ sessionId: 'root', snapshotId, expectedRevision: published.revision })
  const rolledBack = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  assert.equal(rolledBack.state, 'rolled_back')
  assert.equal((await f.broker.learningRun({ sessionId: 'root', learningRunId: candidate.learningRunId })).outcome, 'rolled_back')
  assert.equal((await f.broker.agent(agentInput)).currentSnapshotId, null)
  await f.broker.snapshotRollback({ sessionId: 'root', snapshotId, expectedRevision: published.revision })
  assert.deepEqual(await f.broker.memorySnapshot({ sessionId: 'root', snapshotId }), rolledBack)
  await assert.rejects(f.broker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: rolledBack.revision }))

  const rejected = await f.broker.learningStart({ ...agentInput, requestId: 'req-reject' })
  const rejectedId = snapshotForRun(f, rejected.learningRunId).snapshot_id
  const rejectedDraft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: rejectedId })
  await f.broker.snapshotReject({ sessionId: 'root', snapshotId: rejectedId, expectedRevision: rejectedDraft.revision })
  assert.equal((await f.broker.learningRun({ sessionId: 'root', learningRunId: rejected.learningRunId })).outcome, 'rejected')
  assert.equal((await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: rejectedId })).state, 'draft')
  await f.broker.snapshotReject({ sessionId: 'root', snapshotId: rejectedId, expectedRevision: rejectedDraft.revision })
  assert.equal((await f.broker.agent(agentInput)).currentSnapshotId, null)
  assert.equal(f.requests.length, 2)
})

test('agents exposes additive read-only current-version and pending-review summaries through real lifecycle reads', async t => {
  const f = await brokerFixture(t)
  const input = { sessionId: 'root', agentId: f.profile.agentId }
  let [summary] = await f.broker.agents({ sessionId: 'root' })
  assert.equal(summary.currentSnapshotId, null)
  assert.equal(summary.currentSnapshotVersion, null)
  assert.equal(summary.pendingReview, false)

  const firstSource = await seedUserDecision(f, 'summary-first-source')
  f.respond(() => ({ operations: [validAdd(f, [firstSource.caseId])] }))
  const firstCandidate = await f.broker.learningStart({ ...input, requestId: 'req-summary-first' })
  ;[summary] = await f.broker.agents({ sessionId: 'root' })
  assert.equal(summary.currentSnapshotId, null)
  assert.equal(summary.pendingReview, true)

  const firstSnapshotId = snapshotForRun(f, firstCandidate.learningRunId).snapshot_id
  const firstDraft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: firstSnapshotId })
  await f.broker.snapshotPublish({ sessionId: 'root', snapshotId: firstSnapshotId, expectedRevision: firstDraft.revision })
  ;[summary] = await f.broker.agents({ sessionId: 'root' })
  assert.equal(summary.currentSnapshotId, firstSnapshotId)
  assert.equal(summary.currentSnapshotVersion, 1)
  assert.equal(summary.pendingReview, false)

  const secondSource = await seedUserDecision(f, 'summary-second-source')
  f.respond(() => ({ operations: [validAdd(f, [secondSource.caseId], { principleId: 'temporary-add-second', text: 'Prefer the second reviewed direction' })] }))
  const secondCandidate = await f.broker.learningStart({ ...input, requestId: 'req-summary-second' })
  ;[summary] = await f.broker.agents({ sessionId: 'root' })
  assert.equal(summary.currentSnapshotId, firstSnapshotId)
  assert.equal(summary.currentSnapshotVersion, 1)
  assert.equal(summary.pendingReview, true)
  assert.equal(summary.name, 'A')
  assert.equal('learningRuns' in summary, false)
  assert.equal('snapshots' in summary, false)
  assert.equal('descriptionHistory' in summary, false)
  assert.equal('cleaned' in summary, false)
  assert.equal('retentionState' in summary, false)

  const secondSnapshotId = snapshotForRun(f, secondCandidate.learningRunId).snapshot_id
  const secondDraft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: secondSnapshotId })
  await f.broker.snapshotReject({ sessionId: 'root', snapshotId: secondSnapshotId, expectedRevision: secondDraft.revision })
  ;[summary] = await f.broker.agents({ sessionId: 'root' })
  assert.equal(summary.currentSnapshotId, firstSnapshotId)
  assert.equal(summary.currentSnapshotVersion, 1)
  assert.equal(summary.pendingReview, false, 'a terminal rejected candidate no longer awaits review')
})

test('restart marks a persisted running Learning Run INTERRUPTED without candidate creation or model replay', async t => {
  const f = await brokerFixture(t)
  insertLearningRun(f, 'lr_interrupted', 'running')
  await f.broker.flush()

  const restarted = new DecisionBroker({
    profileContext: { home: f.dir, name: 'test' }, ctx: f.ctx,
    config: () => f.config, now: () => 2_000,
  })
  t.after(() => restarted.flush())
  await restarted.start()
  const recovered = await restarted.learningRun({ sessionId: 'root', learningRunId: 'lr_interrupted' })
  assert.equal(recovered.outcome, 'failed')
  assert.equal(recovered.replay.detail, 'INTERRUPTED')
  assert.equal((await restarted.agent({ sessionId: 'root', agentId: f.profile.agentId })).currentSnapshotId, null)
  assert.equal(restarted.store.db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 0)
  assert.equal(f.requests.length, 0)
})

test('snapshotUpdate authorizes a draft like the other Snapshot actions and audits counts alone', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'update-source')
  f.respond(() => ({ operations: [validAdd(f, [source.caseId])] }))
  const agentInput = { sessionId: 'root', agentId: f.profile.agentId }
  const candidate = await f.broker.learningStart({ ...agentInput, requestId: 'req-update' })
  const snapshotId = snapshotForRun(f, candidate.learningRunId).snapshot_id
  const draft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  const principle = draft.principles[0]
  f.audits.length = 0

  const updated = await f.broker.snapshotUpdate({
    ...agentInput, snapshotId, expectedRevision: draft.revision,
    edits: [{ principleId: principle.principleId, text: 'The wording the user chose' }],
  })
  assert.equal(updated.snapshotId, snapshotId)
  assert.equal(updated.revision, draft.revision + 1)
  assert.equal(updated.principles[0].text, 'The wording the user chose')
  const audited = f.audits.filter(entry => entry.kind === 'snapshot' && entry.value.action === 'candidate-update')
  assert.equal(audited.length, 1)
  assert.deepEqual(audited[0].value, {
    snapshotId, learningRunId: candidate.learningRunId, agentId: f.profile.agentId, rootSessionId: 'root',
    zone: 'workspace', action: 'candidate-update',
    revisionBefore: draft.revision, revisionAfter: updated.revision, edited: 1, removed: 0,
  })
  assert.equal(JSON.stringify(f.audits).includes('The wording the user chose'), false, 'the audit never carries a principle body')
  // Editing is not publishing: the draft stays a draft and the current version is untouched.
  assert.equal(updated.state, 'draft')
  assert.equal((await f.broker.agent(agentInput)).currentSnapshotId, null)
  assert.equal((await f.broker.learningRun({ sessionId: 'root', learningRunId: candidate.learningRunId })).outcome, 'candidate')
  assert.equal(f.requests.length, 1, 'editing never calls the model')
})

test('snapshotUpdate rejects a foreign workspace, a mismatched assistant and a forged edit field', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'update-boundary-source')
  f.respond(() => ({ operations: [validAdd(f, [source.caseId])] }))
  const candidate = await f.broker.learningStart({ sessionId: 'root', agentId: f.profile.agentId, requestId: 'req-boundary' })
  const snapshotId = snapshotForRun(f, candidate.learningRunId).snapshot_id
  const draft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  const principle = draft.principles[0]

  const foreignWorkspace = `${f.workspace}-other`
  insertLearningRun(f, 'lr_foreign_workspace', 'candidate', { workspaceKey: foreignWorkspace })
  insertSnapshot(f, 'ms_foreign_workspace', 1, 'draft', { workspaceKey: foreignWorkspace, learningRunId: 'lr_foreign_workspace' })
  f.audits.length = 0
  await assert.rejects(
    f.broker.snapshotUpdate({ sessionId: 'root', snapshotId: 'ms_foreign_workspace', expectedRevision: 1, edits: [{ principleId: principle.principleId, text: 'Foreign' }] }),
    error => error.code === 'OUT_OF_SCOPE',
  )
  await assert.rejects(
    f.broker.snapshotUpdate({ sessionId: 'root', agentId: 'ag_someone_else', snapshotId, expectedRevision: draft.revision, edits: [{ principleId: principle.principleId, text: 'Mismatched' }] }),
    error => error.code === 'OUT_OF_SCOPE',
  )
  const boundary = f.audits.filter(entry => entry.kind === 'snapshot' && entry.value.action === 'boundary-reject')
  assert.equal(boundary.length, 2)
  assert.equal(boundary.every(entry => entry.value.snapshotId !== undefined && entry.value.rootSessionId === 'root'), true)

  // A caller cannot smuggle a source or a state change into an edit.
  await assert.rejects(
    f.broker.snapshotUpdate({ sessionId: 'root', snapshotId, expectedRevision: draft.revision, edits: [{ principleId: principle.principleId, text: 'Forged', sources: ['ev_forged'] }] }),
    error => error.code === 'UNKNOWN_FIELD',
  )
  assert.equal((await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })).revision, draft.revision)
})

test('an editing Agent does not need to be enabled, but publishing still does', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'update-disabled-source')
  f.respond(() => ({ operations: [validAdd(f, [source.caseId])] }))
  const candidate = await f.broker.learningStart({ sessionId: 'root', agentId: f.profile.agentId, requestId: 'req-disabled' })
  const snapshotId = snapshotForRun(f, candidate.learningRunId).snapshot_id
  const draft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  await f.broker.profileSetState(f.profile.agentId, 'disabled')
  const updated = await f.broker.snapshotUpdate({
    sessionId: 'root', snapshotId, expectedRevision: draft.revision,
    edits: [{ principleId: draft.principles[0].principleId, text: 'Reviewed while disabled' }],
  })
  assert.equal(updated.state, 'draft')
  await assert.rejects(
    f.broker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: updated.revision }),
    error => error.code === 'AGENT_UNAVAILABLE',
  )
})
