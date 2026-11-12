// Public extraction retry and the assistant read model (OpenSpec 6.1/6.2/6.3).
//
// A failed extraction never repeats on its own; exactly one new run starts from
// an explicit user retry at the same eligible-source high-water mark. The
// assistant read model keeps the two memory zones apart: private runs and
// snapshots belong to the current workspace, the public summary belongs to the
// profile-global assistant.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicAdd, publicMemoryFixture } from './public-fixtures.js'
import { insertLearningRun, insertSnapshot } from './p3-fixtures.js'

function crossWorkspaceAdd() {
  return (_options, pack) => ({
    operations: [publicAdd(pack.sources.map(source => source.sourceId), { text: 'Prefer the shared documented option', scope: {} })],
  })
}

test('a failed public extraction retries exactly once from an explicit user action', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'retry-w1' })
  f.respond(() => 'not-json')
  const failed = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(failed.status, 'failed')
  assert.equal(f.requests.length, 1)

  // Opening or refreshing again at the same high-water mark must not repeat the
  // model call, and must not pretend the failure disappeared.
  const repeated = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId })
  assert.equal(repeated.status, 'failed')
  assert.equal(f.requests.length, 1)
  assert.equal(f.broker.learning.listRuns(f.profile.agentId).filter(run => run.zone === 'public').length, 1)

  f.respond(crossWorkspaceAdd())
  const retried = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, retryFailedExtraction: true })
  assert.equal(retried.status, 'candidate', JSON.stringify(retried))
  assert.equal(f.requests.length, 2)
  const runs = f.broker.learning.listRuns(f.profile.agentId).filter(run => run.zone === 'public')
  assert.equal(runs.length, 2)
  assert.notEqual(runs[0].inputFrozen.requestId, runs[1].inputFrozen.requestId, 'an explicit retry starts a distinct run')
  assert.equal(f.audits.some(entry => entry.kind === 'learning-run' && entry.value?.zone === 'public' && entry.value?.action === 'retry'), true)

  // While a candidate awaits review an explicit retry is not a second run.
  const blocked = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, retryFailedExtraction: true })
  assert.equal(blocked.status, 'candidate')
  assert.equal(blocked.run.learningRunId, retried.run.learningRunId)
  assert.equal(f.requests.length, 2)
})

test('a successful extraction ignores the retry gesture', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'retry-noop-w1' })
  f.respond(crossWorkspaceAdd())
  const first = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(first.status, 'candidate')
  await f.broker.snapshotReject({ sessionId: 'root1', snapshotId: first.candidate.snapshotId, expectedRevision: first.candidate.revision })
  const stable = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, retryFailedExtraction: true })
  assert.equal(stable.status, 'up-to-date')
  assert.equal(f.requests.length, 1)
})

test('the assistant read model keeps the private workspace zone apart from the public zone', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'agent-w1' })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'agent-w2' })
  insertLearningRun(f, 'lr_private_w1', 'candidate')
  insertSnapshot(f, 'ms_private_w1', 1, 'draft', { learningRunId: 'lr_private_w1' })
  f.respond(crossWorkspaceAdd())
  const refreshed = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(refreshed.status, 'candidate')

  const fromW1 = await f.broker.agent({ sessionId: 'root1', agentId: f.profile.agentId })
  assert.deepEqual(fromW1.learningRuns.map(run => run.learningRunId), ['lr_private_w1'])
  assert.deepEqual(fromW1.snapshots.map(snapshot => snapshot.snapshotId), ['ms_private_w1'])
  assert.equal(fromW1.currentSnapshotId, null, 'a public candidate is never the private current version')
  assert.equal(fromW1.publicMemory.zone, 'public')
  assert.equal(fromW1.publicMemory.current, null)
  assert.equal(fromW1.publicMemory.candidate.snapshotId, refreshed.candidate.snapshotId)
  assert.equal(fromW1.publicMemory.disclosure.required, false)
  const serialized = JSON.stringify(fromW1)
  for (const secret of [f.w1, f.w2, f.dir]) assert.equal(serialized.includes(secret), false, secret)

  // The same assistant identity and public zone are visible from the other
  // workspace, while its private zone stays that workspace's own.
  const fromW2 = await f.broker.agent({ sessionId: 'root2', agentId: f.profile.agentId })
  assert.equal(fromW2.agentId, fromW1.agentId)
  assert.equal(fromW2.name, fromW1.name)
  assert.deepEqual(fromW2.learningRuns, [])
  assert.deepEqual(fromW2.snapshots, [])
  assert.equal(fromW2.publicMemory.candidate.snapshotId, refreshed.candidate.snapshotId)
})

test('a fresh assistant reports the disclosure as required and no fabricated public version', async t => {
  const f = await publicMemoryFixture(t)
  const detail = await f.broker.agent({ sessionId: 'root1', agentId: f.profile.agentId })
  assert.deepEqual(detail.publicMemory.current, null)
  assert.equal(detail.publicMemory.candidate, null)
  assert.equal(detail.publicMemory.disclosure.required, true)
  assert.equal(detail.publicMemory.disclosure.version, 1)
})
