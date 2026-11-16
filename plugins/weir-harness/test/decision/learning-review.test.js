import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brokerFixture, frozenInput, insertLearningRun, insertSnapshot, seedUserDecision, snapshotForRun, validAdd } from './p3-fixtures.js'
import { publicAdd, publicMemoryFixture } from './public-fixtures.js'

test('current Snapshot remains actionable beyond twenty newer rejected drafts', async t => {
  const f = await brokerFixture(t)
  insertSnapshot(f, 'ms_current', 1, 'published', { revision: 7 })
  for (let version = 2; version <= 22; version++) {
    const snapshotId = `ms_rejected_${version}`
    insertSnapshot(f, snapshotId, version, 'draft')
    f.broker.store.db.prepare("UPDATE learning_runs SET outcome='rejected' WHERE learning_run_id=?").run(`lr_${snapshotId}`)
  }
  const detail = await f.broker.agent({ sessionId: 'root', agentId: f.profile.agentId })
  assert.equal(detail.currentSnapshotId, 'ms_current')
  const current = detail.snapshots.find(snapshot => snapshot.snapshotId === 'ms_current')
  assert.equal(current?.revision, 7)
  assert.equal(current?.state, 'published')
  assert.ok(detail.snapshots.length <= 21)
})

test('learning review exposes bounded cross-root Case and correction Feedback sources without weakening root history isolation', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'cross-root-review', {
    rootSessionId: 'other-root', question: 'CROSS ROOT SOURCE QUESTION', selected: 'Cross-root A',
    taskSummary: 'DO_NOT_EXPOSE_TASK_SUMMARY',
  })
  const correction = await f.broker.feedbackStore.append({
    actor: { kind: 'user' }, caseId: source.caseId, kind: 'correction',
    payload: { direction: 'Use the corrected direction', scope: source.scope, supersedes: [source.caseId] },
  })
  insertLearningRun(f, 'lr_source_review', 'candidate', {
    inputFrozen: frozenInput(f, {
      caseIds: [source.caseId], feedbackIds: [correction.feedbackId],
      revisions: { [source.caseId]: source.revision, [correction.feedbackId]: 1 },
    }),
    operations: [
      validAdd(f, [source.caseId, correction.feedbackId]),
      validAdd(f, [source.caseId], { principleId: 'temporary-add-2' }),
    ],
  })
  insertSnapshot(f, 'ms_source_review', 1, 'draft', {
    learningRunId: 'lr_source_review',
    principles: [
      { principleId: 'pr_review', text: 'Prefer the corrected answer', scope: source.scope, sources: [source.caseId, correction.feedbackId], state: 'active' },
      { principleId: 'pr_review_2', text: 'Retain the source answer', scope: source.scope, sources: [source.caseId], state: 'active' },
    ],
  })

  // The record LIST stays root-scoped (the automation read), while the
  // user-surface record detail is keyed by Case id alone.
  const listed = await f.broker.records({ sessionId: 'root' })
  assert.equal(listed.records.some(row => row.caseId === source.caseId), false)
  assert.equal((await f.broker.record({ caseId: source.caseId })).case.caseId, source.caseId)
  const detail = await f.broker.learningRun({ sessionId: 'root', learningRunId: 'lr_source_review' })
  assert.ok(Array.isArray(detail.sourceRecords))
  assert.deepEqual(detail.sourceRecords.map(record => record.sourceId), [source.caseId, correction.feedbackId])
  const caseReview = detail.sourceRecords[0]
  assert.equal(caseReview.kind, 'case')
  assert.equal(caseReview.caseId, source.caseId)
  assert.equal(caseReview.revision, source.revision)
  assert.match(caseReview.excerpt, /Cross-root A/)
  assert.match(caseReview.excerpt, /CROSS ROOT SOURCE QUESTION/)
  assert.equal(JSON.stringify(caseReview).includes('DO_NOT_EXPOSE_TASK_SUMMARY'), false)
  const correctionReview = detail.sourceRecords[1]
  assert.equal(correctionReview.kind, 'correction')
  assert.equal(correctionReview.feedbackId, correction.feedbackId)
  assert.equal(correctionReview.caseId, source.caseId)
  assert.equal(correctionReview.direction, 'Use the corrected direction')
  assert.deepEqual(correctionReview.supersedes, [source.caseId])
  const snapshot = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: 'ms_source_review' })
  assert.deepEqual(snapshot.sourceRecords, detail.sourceRecords)
  assert.equal(new Set(detail.sourceRecords.map(record => record.sourceId)).size, 2)
})

test('learning source review rejects source fan-out beyond the combined frozen input bound', async t => {
  const f = await brokerFixture(t)
  const sourceIds = Array.from({ length: 385 }, (_, index) => `dc_review_${index}`)
  insertLearningRun(f, 'lr_source_bound', 'candidate', {
    operations: [
      validAdd(f, sourceIds.slice(0, 256)),
      validAdd(f, sourceIds.slice(256), { principleId: 'temporary-add-2' }),
    ],
  })
  await assert.rejects(
    f.broker.learningRun({ sessionId: 'root', learningRunId: 'lr_source_bound' }),
    error => error.code === 'LEARNING_INPUT_TOO_LARGE',
  )
})

/** The persisted model derivation of one run, byte for byte. */
function runDerivation(f, learningRunId) {
  const row = f.broker.store.db.prepare('SELECT operations_json,replay_json,revision FROM learning_runs WHERE learning_run_id=?').get(learningRunId)
  return { operations: row.operations_json, replay: row.replay_json, revision: row.revision }
}

test('a reviewed candidate publishes the user wording and drops the deleted principle without rewriting the run', async t => {
  const f = await brokerFixture(t)
  const kept = await seedUserDecision(f, 'revise-kept')
  const dropped = await seedUserDecision(f, 'revise-dropped')
  f.respond(() => ({
    operations: [
      validAdd(f, [kept.caseId], { text: 'Prefer A for this question' }),
      validAdd(f, [dropped.caseId], { principleId: 'temporary-add-2', text: 'Second modelled rule' }),
    ],
  }))
  const candidate = await f.broker.learningStart({ sessionId: 'root', agentId: f.profile.agentId, requestId: 'req-revise' })
  const snapshotId = snapshotForRun(f, candidate.learningRunId).snapshot_id
  const draft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  assert.equal(draft.principles.length, 2)
  const [first, second] = draft.principles
  const derivation = runDerivation(f, candidate.learningRunId)

  const updated = await f.broker.learning.updateCandidate(snapshotId, draft.revision, [
    { principleId: first.principleId, text: 'Use the wording the user reviewed', scope: { paths: ['plugins/weir-harness/src'] } },
    { principleId: second.principleId, remove: true },
  ])
  assert.equal(updated.edited, 1)
  assert.equal(updated.removed, 1)
  assert.equal(updated.snapshot.revision, draft.revision + 1)
  // The model's derivation is a record of what it proposed, not scratch space.
  assert.deepEqual(runDerivation(f, candidate.learningRunId), derivation)

  const published = await f.broker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: updated.snapshot.revision })
  assert.equal(published.state, 'published')
  assert.deepEqual(published.principles.map(principle => principle.principleId), [first.principleId])
  assert.equal(published.principles[0].text, 'Use the wording the user reviewed')
  assert.deepEqual(published.principles[0].scope, { workspaces: [f.workspace], paths: ['plugins/weir-harness/src'] })
  // Publishing did not retain the deleted entry, and the run it came from is
  // still the same run with the same derivation and an unchanged operation count.
  assert.deepEqual(runDerivation(f, candidate.learningRunId).operations, derivation.operations)
  assert.deepEqual(runDerivation(f, candidate.learningRunId).replay, derivation.replay)
  assert.equal(f.broker.learning.getRunById(candidate.learningRunId).outcome, 'published')
  const current = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  assert.deepEqual(current.principles.map(principle => principle.principleId), [first.principleId])
  // The next Attempt reads the reviewed wording, not the model's original text.
  assert.equal(f.broker.learning.currentSnapshot(f.profile.agentId, f.workspace).snapshotId, snapshotId)
  // A published version keeps no edit entry point at the store either.
  await assert.rejects(
    f.broker.learning.updateCandidate(snapshotId, updated.snapshot.revision + 1, [{ principleId: first.principleId, text: 'Too late' }]),
    error => error.code === 'SNAPSHOT_STATE_CONFLICT',
  )
})

test('a public candidate edit is scanned for paths and stays workspace-agnostic', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'public-edit-w1' })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'public-edit-w2' })
  f.respond((_options, pack) => ({
    operations: [publicAdd(pack.sources.map(source => source.sourceId), { text: 'Prefer the agreed option', scope: {} })],
  }))
  const refreshed = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(refreshed.status, 'candidate')
  const listed = await f.broker.publicCandidate({ sessionId: 'root2', agentId: f.profile.agentId })
  const principle = listed.principles[0]
  const draftBefore = JSON.stringify(f.broker.store.db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(listed.candidate.snapshotId))

  // Public wording is scanned when it is saved, not only at publish.
  for (const text of ['Edit under /Users/somebody/secret/repo', 'See dc_foreign_record for this rule']) {
    await assert.rejects(
      f.broker.learning.updateCandidate(listed.candidate.snapshotId, listed.candidate.revision, [{ principleId: principle.principleId, text }]),
      error => error.code === 'PUBLIC_CONTENT_REJECTED',
      text,
    )
  }
  assert.equal(JSON.stringify(f.broker.store.db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(listed.candidate.snapshotId)), draftBefore)

  const updated = await f.broker.learning.updateCandidate(listed.candidate.snapshotId, listed.candidate.revision, [{
    principleId: principle.principleId,
    text: 'Prefer the agreed option, worded by the user',
    scope: { tags: ['release-notes'], authorizationClasses: ['A'] },
  }])
  // The public zone owns no workspace: the hints survive and no list appears.
  assert.deepEqual(updated.snapshot.principles[0].scope, { tags: ['release-notes'], authorizationClasses: ['A'] })
  assert.equal(updated.snapshot.zone, 'public')
  const published = await f.broker.snapshotPublish({ sessionId: 'root1', snapshotId: listed.candidate.snapshotId, expectedRevision: updated.snapshot.revision })
  assert.equal(published.principles[0].text, 'Prefer the agreed option, worded by the user')
  assert.deepEqual(published.principles[0].scope, { tags: ['release-notes'], authorizationClasses: ['A'] })
})
