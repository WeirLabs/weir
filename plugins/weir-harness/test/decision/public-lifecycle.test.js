// Manual public publish / reject / rollback with per-source revalidation (4.5).
//
// Every source is rechecked in its own origin workspace at publish time. A
// stale source fails closed and keeps read-only history; public lifecycle
// actions never touch private Snapshots, Cases or Attempts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertSnapshot } from './p3-fixtures.js'
import { publicAdd, publicMemoryFixture } from './public-fixtures.js'

function candidateAnswer() {
  return (_options, pack) => ({
    operations: [publicAdd(pack.sources.map(source => source.sourceId), { text: 'Prefer the agreed option', scope: {} })],
  })
}

async function createCandidate(f, sessionId = 'root1') {
  const refreshed = await f.broker.publicMemoryRefresh({ sessionId, agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(refreshed.status, 'candidate', JSON.stringify(refreshed))
  return refreshed.candidate
}

async function publishCandidate(f, candidate, sessionId = 'root1') {
  return f.broker.snapshotPublish({ sessionId, snapshotId: candidate.snapshotId, expectedRevision: candidate.revision })
}

test('a cross-workspace public candidate publishes from another workspace and leaves private memory untouched', async t => {
  const f = await publicMemoryFixture(t)
  const w1 = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'lifecycle-w1' })
  const w2 = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'lifecycle-w2' })
  insertSnapshot(f, 'ms_private_w1', 1, 'published')
  const privateBefore = JSON.stringify(f.broker.store.db.prepare("SELECT * FROM memory_snapshots WHERE zone='workspace' ORDER BY snapshot_id").all())
  const attemptsBefore = JSON.stringify(f.broker.store.db.prepare('SELECT * FROM attempts ORDER BY attempt_id').all())

  f.respond(candidateAnswer())
  const candidate = await createCandidate(f)
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId), null)
  const published = await publishCandidate(f, candidate, 'root2')
  assert.equal(published.state, 'published')
  assert.equal(published.zone, 'public')
  assert.equal(published.namespaceWorkspaceKey, null)

  const current = f.broker.learning.currentPublicSnapshot(f.profile.agentId)
  assert.equal(current.snapshotId, candidate.snapshotId)
  const run = f.broker.learning.getRunById(candidate.learningRunId)
  assert.equal(run.outcome, 'published')
  assert.deepEqual([...run.inputFrozen.caseIds].sort(), [w1.caseId, w2.caseId].sort())
  assert.equal(run.inputFrozen.revisions[w2.caseId], w2.revision)

  assert.equal(JSON.stringify(f.broker.store.db.prepare("SELECT * FROM memory_snapshots WHERE zone='workspace' ORDER BY snapshot_id").all()), privateBefore)
  assert.equal(JSON.stringify(f.broker.store.db.prepare('SELECT * FROM attempts ORDER BY attempt_id').all()), attemptsBefore)
  assert.equal(f.broker.learning.currentSnapshot(f.profile.agentId, f.w1).snapshotId, 'ms_private_w1')
})

test('a source whose origin workspace changed after freezing fails the publish closed', async t => {
  const f = await publicMemoryFixture(t)
  const w1 = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'stale-w1' })
  const w2 = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'stale-w2' })
  f.respond(candidateAnswer())
  const candidate = await createCandidate(f)

  // A user comment bumps the W2 Case revision in its own workspace.
  await f.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: w2.caseId, kind: 'comment', payload: { text: 'Later note' } })
  await assert.rejects(publishCandidate(f, candidate), error => error.code === 'STALE_SOURCE')
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId), null)
  const run = f.broker.learning.getRunById(candidate.learningRunId)
  assert.equal(run.outcome, 'failed')
  assert.equal(run.replay.detail, 'STALE_SOURCE')
  assert.equal(f.broker.learning.getSnapshotById(candidate.snapshotId).state, 'draft')

  // The W1 source is still read-only; nothing about it was rewritten.
  assert.equal(f.broker.cases.getCase(w1.caseId).revision, w1.revision)
})

test('a disputed source invalidates the candidate instead of being silently dropped', async t => {
  const f = await publicMemoryFixture(t)
  const w2 = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'disputed-source' })
  f.respond(candidateAnswer())
  const candidate = await createCandidate(f)
  await f.dispute(w2.caseId)
  await assert.rejects(publishCandidate(f, candidate), error => error.code === 'STALE_SOURCE')
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId), null)
})

test('a stale public parent invalidates the publish without rewriting the frozen candidate', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'parent-w1' })
  f.respond(candidateAnswer())
  const first = await createCandidate(f)
  await publishCandidate(f, first)

  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'parent-w2' })
  const second = await createCandidate(f)
  const secondRun = f.broker.learning.getRunById(second.learningRunId)
  assert.equal(secondRun.inputFrozen.parentSnapshotId, first.snapshotId)

  // A different public Snapshot becomes current after the second candidate froze.
  insertSnapshot(f, 'ms_public_newer', 9, 'published', { zone: 'public' })
  await assert.rejects(publishCandidate(f, second), error => error.code === 'STALE_PARENT_SNAPSHOT')
  assert.equal(f.broker.learning.getSnapshotById(second.snapshotId).state, 'draft')
})

test('reject keeps the public zone unchanged and preserves the rejected history', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'reject-keep' })
  f.respond(candidateAnswer())
  const candidate = await createCandidate(f)
  const rejected = await f.broker.snapshotReject({ sessionId: 'root1', snapshotId: candidate.snapshotId, expectedRevision: candidate.revision })
  assert.equal(rejected.state, 'draft')
  assert.equal(f.broker.learning.getRunById(candidate.learningRunId).outcome, 'rejected')
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId), null)
  assert.equal(f.broker.learning.getSnapshotById(candidate.snapshotId).state, 'draft')
})

test('public rollback restores the previous public version and finally empty public L2', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'rollback-w1' })
  insertSnapshot(f, 'ms_private_rollback', 1, 'published')
  f.respond(candidateAnswer())
  const first = await createCandidate(f)
  const v1 = await publishCandidate(f, first)
  assert.equal(v1.version, 1)

  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'rollback-w2' })
  const second = await createCandidate(f, 'root2')
  const v2 = await publishCandidate(f, second, 'root2')
  assert.equal(v2.version, 2)
  assert.equal(v2.parentSnapshotId, v1.snapshotId)

  const privateBefore = JSON.stringify(f.broker.store.db.prepare("SELECT * FROM memory_snapshots WHERE zone='workspace' ORDER BY snapshot_id").all())
  const rolled = await f.broker.snapshotRollback({ sessionId: 'root1', snapshotId: v2.snapshotId, expectedRevision: v2.revision })
  assert.equal(rolled.state, 'rolled_back')
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId).snapshotId, v1.snapshotId)

  const rolledV1 = await f.broker.snapshotRollback({ sessionId: 'root1', snapshotId: v1.snapshotId, expectedRevision: v1.revision })
  assert.equal(rolledV1.state, 'rolled_back')
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId), null)
  assert.equal(JSON.stringify(f.broker.store.db.prepare("SELECT * FROM memory_snapshots WHERE zone='workspace' ORDER BY snapshot_id").all()), privateBefore)

  // Rolled-back versions are never republished, and the public sequence keeps its own numbering.
  const versions = f.broker.store.db.prepare("SELECT version,state FROM memory_snapshots WHERE zone='public' ORDER BY version").all()
    .map(row => ({ version: row.version, state: row.state }))
  assert.deepEqual(versions, [{ version: 1, state: 'rolled_back' }, { version: 2, state: 'rolled_back' }])
})

test('an archived Agent can neither publish nor create public memory but keeps read-only history', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'archive-publish' })
  f.respond(candidateAnswer())
  const candidate = await createCandidate(f)
  await f.broker.profileSetState(f.profile.agentId, 'archived')
  await assert.rejects(publishCandidate(f, candidate), error => error.code === 'AGENT_UNAVAILABLE')
  assert.equal(f.broker.learning.getSnapshotById(candidate.snapshotId).state, 'draft')
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId), null)
  assert.equal(f.broker.learning.getRunById(candidate.learningRunId).outcome, 'candidate')
})
