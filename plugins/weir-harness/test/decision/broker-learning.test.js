import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DecisionBroker } from '../../src/decision/broker.js'
import { brokerFixture, insertLearningRun, seedUserDecision, snapshotForRun, validAdd } from './p3-fixtures.js'

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
