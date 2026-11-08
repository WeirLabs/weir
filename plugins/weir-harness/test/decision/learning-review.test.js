import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brokerFixture, frozenInput, insertLearningRun, insertSnapshot, seedUserDecision, validAdd } from './p3-fixtures.js'

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

  assert.equal(await f.broker.record({ sessionId: 'root', caseId: source.caseId }), null)
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
