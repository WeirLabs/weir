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

test('the published public version exposes its reviewed wording read-only and no provenance', async t => {
  const f = await publicMemoryFixture(t)
  const w1 = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'wording-w1', paths: ['docs'] })
  const w2 = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'wording-w2', paths: ['docs'] })
  assert.deepEqual(f.broker.publicState(f.profile.agentId), { current: null }, 'nothing is published yet')
  assert.equal(f.broker.publicMemorySummary(f.profile.agentId).current, null, 'the assistant detail reports no public version')

  const wording = 'Prefer the documented option when both workspaces agree'
  f.respond((_options, pack) => ({
    operations: [publicAdd(pack.sources.map(source => source.sourceId), { text: wording, scope: { paths: ['docs'] } })],
  }))
  const candidate = await createCandidate(f)
  const review = await f.broker.publicCandidate({ sessionId: 'root2', agentId: f.profile.agentId })
  assert.equal(review.changes[0].text, wording, 'the candidate review already carried the wording')
  await publishCandidate(f, candidate)

  const snapshot = f.broker.learning.currentPublicSnapshot(f.profile.agentId)
  const expected = [{ principleId: snapshot.principles[0].principleId, text: wording, scope: { paths: ['docs'] } }]
  const state = f.broker.publicState(f.profile.agentId)
  assert.deepEqual(Object.keys(state.current).sort(), [
    'contentHash', 'principleCount', 'principles', 'revision', 'snapshotId', 'sourceCount', 'version', 'workspaceCount',
  ])
  assert.deepEqual(state.current.principles, expected)
  assert.deepEqual(f.broker.publicMemorySummary(f.profile.agentId).current, state.current)
  const refreshed = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId })
  assert.equal(refreshed.status, 'up-to-date')
  assert.deepEqual(refreshed.current.principles, expected)

  const serialized = JSON.stringify([state, refreshed, f.broker.publicMemorySummary(f.profile.agentId)])
  for (const workspace of [f.w1, f.w2]) assert.equal(serialized.includes(workspace), false, 'no workspace key')
  for (const recordId of [w1.caseId, w2.caseId]) assert.equal(serialized.includes(recordId), false, 'no source record id')
  assert.equal(serialized.includes('origin_'), false, 'no source alias either')
  assert.equal(serialized.includes('inputFrozen'), false, 'no raw frozen input')
  assert.equal('workspaces' in state.current.principles[0].scope, false, 'the scope stays workspace-agnostic')
})

test('a scope hint that carries a path or a record id never reaches the published read model', async t => {
  const f = await publicMemoryFixture(t)
  insertSnapshot(f, 'ms_public_dirty_hint', 9, 'published', {
    zone: 'public',
    principles: [{
      principleId: 'pr_dirty', text: 'Prefer the documented option',
      scope: { paths: ['/Users/alice/repo', 'docs'], tags: ['dc_00000000-0000-4000-8000-000000000000', 'safety'] },
      sources: [], state: 'active',
    }],
  })
  const state = f.broker.publicState(f.profile.agentId)
  assert.deepEqual(state.current.principles, [
    { principleId: 'pr_dirty', text: 'Prefer the documented option', scope: { paths: ['docs'], tags: ['safety'] } },
  ])
  const serialized = JSON.stringify(state)
  assert.equal(serialized.includes('/Users/'), false)
  assert.equal(serialized.includes('dc_'), false)
})

test('a retired public principle leaves the published read-only list and the count agrees with it', async t => {
  const f = await publicMemoryFixture(t)
  const w1 = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'retire-keep' })
  const w2 = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'retire-drop' })
  const keepText = 'Keep the documented option both workspaces agreed on'
  const dropText = 'Drop the superseded option one workspace still repeats'
  f.respond((_options, pack) => {
    const sources = pack.sources.map(source => source.sourceId)
    return {
      operations: [
        publicAdd(sources.slice(0, 1), { principleId: 'temporary-keep', text: keepText, scope: {} }),
        publicAdd(sources.slice(1, 2), { principleId: 'temporary-drop', text: dropText, scope: {} }),
      ],
    }
  })
  const first = await createCandidate(f)
  const v1 = await publishCandidate(f, first)
  assert.equal(v1.version, 1)
  const keepId = v1.principles.find(principle => principle.text === keepText).principleId
  const dropId = v1.principles.find(principle => principle.text === dropText).principleId
  assert.equal(v1.principles.filter(principle => principle.state === 'active').length, 2, 'both added principles start active')
  assert.deepEqual(f.broker.publicState(f.profile.agentId).current.principles.map(row => row.principleId).sort(), [dropId, keepId].sort())

  // A genuinely newer source starts the second extraction, which retires one of
  // the two published principles and leaves the other one active.
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'retire-trigger' })
  f.respond(() => ({ operations: [{ op: 'retire', principleId: dropId }] }))
  const second = await createCandidate(f, 'root2')
  // The candidate review still carries the retirement and the wording it retires.
  const review = await f.broker.publicCandidate({ sessionId: 'root2', agentId: f.profile.agentId })
  assert.deepEqual(review.changes.map(change => ({ op: change.op, principleId: change.principleId })), [{ op: 'retire', principleId: dropId }])
  assert.equal(review.principles.find(principle => principle.principleId === dropId).state, 'retired')
  assert.equal(review.principles.find(principle => principle.principleId === dropId).text, dropText, 'the retired wording stays readable where it is reviewed')
  const v2 = await publishCandidate(f, second, 'root2')
  assert.equal(v2.version, 2)
  assert.equal(f.broker.learning.getSnapshotById(v2.snapshotId).principles.find(principle => principle.principleId === dropId).state, 'retired')
  const state = f.broker.publicState(f.profile.agentId)
  assert.deepEqual(state.current.principles, [{ principleId: keepId, text: keepText, scope: {} }], 'the published read-only list carries only active principles')
  assert.equal(state.current.principleCount, state.current.principles.length, 'the published count agrees with the published list')
  assert.equal(state.current.principleCount, 1)
  const summary = f.broker.publicMemorySummary(f.profile.agentId)
  assert.deepEqual(summary.current, state.current, 'the assistant detail publishes the same read-only projection')
  // A second refresh replays the published high-water mark without another model call.
  const requestsBefore = f.requests.length
  const refreshed = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId })
  assert.equal(f.requests.length, requestsBefore, 'a published high-water mark never calls the model again')
  assert.deepEqual(refreshed.current, state.current)

  // Host-side snapshot detail keeps the retired principle auditable at full fidelity.
  const detail = f.broker.learning.getSnapshotById(v2.snapshotId)
  assert.equal(detail.principles.find(principle => principle.principleId === dropId).state, 'retired')
  assert.equal(detail.principles.find(principle => principle.principleId === keepId).state, 'active')
  assert.equal(detail.principles.find(principle => principle.principleId === dropId).text, dropText)

  // The published read-only projection carries no source id, workspace key or origin label.
  const serialized = JSON.stringify([state, summary, refreshed])
  for (const workspace of [f.w1, f.w2]) assert.equal(serialized.includes(workspace), false, 'no workspace key')
  for (const recordId of [w1.caseId, w2.caseId]) assert.equal(serialized.includes(recordId), false, 'no source record id')
  assert.equal(serialized.includes(dropText), false, 'the retired wording is not published as current')
  assert.equal(serialized.includes('origin_'), false, 'no source alias either')
})
