// Safe public candidate review projection and content scan (OpenSpec 4.6).
//
// Reviewing a cross-workspace candidate must never expose a raw foreign
// record, a realpath, a full question or a Case/Evidence id. Candidate text
// containing absolute paths or foreign record ids is rejected before it
// becomes reviewable or publishable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceAlias, publicSourceHighWater } from '../../src/decision/learning/namespace.js'
import { insertLearningRun, insertSnapshot } from './p3-fixtures.js'
import { publicAdd, publicFrozenInput, publicMemoryFixture } from './public-fixtures.js'

const REVIEW_FIELDS = [
  'agentId', 'candidate', 'changes', 'currentPublished', 'disclosure', 'learningRunId',
  'outcome', 'principles', 'replay', 'runRevision', 'sourceCount', 'sources', 'startedAt',
  'workspaceCount', 'zone',
]
const SOURCE_GROUP_FIELDS = ['alias', 'count', 'kinds', 'preview', 'readableInCurrentWorkspace']

function crossWorkspaceCandidate() {
  return (_options, pack) => ({
    operations: [publicAdd(pack.sources.map(source => source.sourceId), {
      text: 'Prefer the option both workspaces already agreed on',
      scope: {},
    })],
  })
}

test('the public review projection is alias-only, bounded and deterministic', async t => {
  const f = await publicMemoryFixture(t)
  const w1 = await f.seedDecision({
    workspaceKey: f.w1, rootSessionId: 'root1', key: 'review-w1',
    question: `SECRET-FULL-QUESTION ${'padding '.repeat(120)}${f.w1}/private/notes.md`,
  })
  const w2 = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'review-w2' })
  f.respond(crossWorkspaceCandidate())
  const refreshed = await f.broker.publicMemoryRefresh({ sessionId: 'root2', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(refreshed.status, 'candidate')

  const review = await f.broker.publicCandidate({ sessionId: 'root2', agentId: f.profile.agentId })
  assert.deepEqual(Object.keys(review).sort(), REVIEW_FIELDS)
  assert.equal(review.zone, 'public')
  assert.equal(review.agentId, f.profile.agentId)
  assert.equal(review.learningRunId, refreshed.run.learningRunId)
  assert.equal(review.outcome, 'candidate')
  assert.equal(review.candidate.snapshotId, refreshed.candidate.snapshotId)
  assert.equal(review.candidate.state, 'draft')
  assert.equal(review.currentPublished, null)
  assert.equal(review.sourceCount, 2)
  assert.equal(review.workspaceCount, 2)
  assert.equal(review.disclosure.required, false)
  assert.equal(review.replay.passed, true)
  assert.equal(review.replay.metrics.operationCount, 1)
  assert.deepEqual(review.changes.map(change => change.op), ['add'])
  assert.ok(review.changes[0].text.length > 0)
  assert.equal('sources' in review.changes[0], false, 'raw source ids never appear in the review payload')
  assert.equal('inputFeedbackIds' in review.changes[0], false)
  assert.deepEqual(review.principles.map(principle => principle.sourceCount), [2])
  assert.equal('sources' in review.principles[0], false)

  assert.equal(review.sources.length, 2)
  for (const group of review.sources) {
    assert.deepEqual(Object.keys(group).sort(), SOURCE_GROUP_FIELDS)
    assert.equal(group.count, 1)
    assert.deepEqual(group.kinds, { case: 1, correction: 0 })
    assert.ok(group.preview.length > 0 && group.preview.length <= 240)
  }
  assert.deepEqual(Object.fromEntries(review.sources.map(group => [group.alias, group.readableInCurrentWorkspace])), {
    [workspaceAlias(f.w1)]: false,
    [workspaceAlias(f.w2)]: true,
  })

  const serialized = JSON.stringify(review)
  for (const workspace of [f.w1, f.w2]) assert.equal(serialized.includes(workspace), false)
  for (const recordId of [w1.caseId, w2.caseId]) assert.equal(serialized.includes(recordId), false)
  assert.equal(/dc_[0-9a-f-]{8,}/.test(serialized), false)
  assert.equal(/ev_[0-9a-f-]{8,}/.test(serialized), false)
  assert.equal(/fb_[0-9a-f-]{8,}/.test(serialized), false)
  assert.equal(serialized.includes('SECRET-FULL-QUESTION'), false, 'the review shows only a bounded redacted preview')

  assert.deepEqual(await f.broker.publicCandidate({ sessionId: 'root2', agentId: f.profile.agentId }), review)
  assert.equal(await f.broker.publicCandidate({ sessionId: 'root1', agentId: f.profile.agentId, learningRunId: refreshed.run.learningRunId }).then(value => value.learningRunId), refreshed.run.learningRunId)
})

test('candidate text with an absolute path or a foreign record id never becomes reviewable', async t => {
  for (const badText of [
    `Prefer the file at ${'/Users/alice/secret/repo/notes.md'}`,
    'Prefer the file at C:\\Users\\alice\\secret\\notes.md',
    'Prefer the file at ~/secret/notes.md',
    'Prefer case dc_00000000-0000-4000-8000-000000000000 from the other workspace',
    'Prefer evidence ev_00000000-0000-4000-8000-000000000000',
  ]) {
    const f = await publicMemoryFixture(t)
    await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'scan-w1' })
    f.respond((_options, pack) => ({
      operations: [publicAdd(pack.sources.map(source => source.sourceId), { text: badText, scope: {} })],
    }))
    const refreshed = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
    assert.equal(refreshed.status, 'failed', badText)
    assert.equal(refreshed.candidate, null)
    const run = f.broker.learning.getRunById(refreshed.run.learningRunId)
    assert.equal(run.outcome, 'failed')
    assert.equal(run.replay.detail, 'PUBLIC_CONTENT_REJECTED')
    assert.equal(f.broker.store.db.prepare("SELECT COUNT(*) AS n FROM memory_snapshots WHERE zone='public'").get().n, 0)
    assert.equal(await f.broker.publicCandidate({ sessionId: 'root1', agentId: f.profile.agentId }), null)
  }
})

test('an externally inserted public draft is content-scanned before display and publish', async t => {
  const f = await publicMemoryFixture(t)
  const source = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'external-scan' })
  insertLearningRun(f, 'lr_external_public', 'candidate', {
    zone: 'public',
    inputFrozen: publicFrozenInput(f, {
      caseIds: [source.caseId], revisions: { [source.caseId]: source.revision },
      sourceWorkspaces: { [source.caseId]: f.w1 },
      workspaceAliases: [{ alias: workspaceAlias(f.w1), count: 1 }],
      sourceHighWater: publicSourceHighWater([{ sourceId: source.caseId, kind: 'case', revision: source.revision }]),
    }),
  })
  insertSnapshot(f, 'ms_external_public', 1, 'draft', {
    zone: 'public', learningRunId: 'lr_external_public',
    principles: [{
      principleId: 'pr_external', text: `Read ${f.w1}/private/notes.md first`, scope: {},
      sources: [source.caseId], state: 'active',
    }],
  })
  await assert.rejects(
    f.broker.publicCandidate({ sessionId: 'root1', agentId: f.profile.agentId }),
    error => error.code === 'PUBLIC_CONTENT_REJECTED',
  )
  await assert.rejects(
    f.broker.snapshotPublish({ sessionId: 'root1', snapshotId: 'ms_external_public', expectedRevision: 1 }),
    error => error.code === 'PUBLIC_CONTENT_REJECTED',
  )
  assert.equal(f.broker.learning.getSnapshotById('ms_external_public').state, 'draft')
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId), null)
})

test('publicCandidate returns null without an active candidate and never exposes private zones', async t => {
  const f = await publicMemoryFixture(t)
  assert.equal(await f.broker.publicCandidate({ sessionId: 'root1', agentId: f.profile.agentId }), null)
  await assert.rejects(
    f.broker.publicCandidate({ sessionId: 'root1', agentId: 'agent-missing' }),
    error => ['PROFILE_NOT_FOUND', 'AGENT_UNAVAILABLE'].includes(error.code),
  )
})
