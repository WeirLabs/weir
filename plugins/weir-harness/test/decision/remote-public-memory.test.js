// Remote surface for the public memory zone (OpenSpec 6.1).
//
// Public memory crosses workspaces, so the remote must take the caller's own
// session and assistant only: the root session and workspace are server-derived
// by the Broker, every workspace source stays an opaque alias, and the first
// extraction happens only after the user acknowledges the disclosure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDecisionRemoteService, decisionRemoteContribution, DECISION_REMOTE_METHODS, publicMemoryArgs,
} from '../../src/decision/remote.js'
import { workspaceAlias } from '../../src/decision/learning/namespace.js'
import { insertSnapshot } from './p3-fixtures.js'
import { publicAdd, publicMemoryFixture } from './public-fixtures.js'

function serviceFor(broker, extra = {}) {
  return createDecisionRemoteService({ broker: () => broker, ...extra })
}

function crossWorkspaceAdd() {
  return (_options, pack) => ({
    operations: [publicAdd(pack.sources.map(source => source.sourceId), { text: 'Prefer the shared documented option', scope: {} })],
  })
}

test('public refresh and candidate review are bare-args remotes without scope or ownership parameters', () => {
  for (const method of ['publicMemoryRefresh', 'publicCandidate']) {
    assert.equal(DECISION_REMOTE_METHODS.includes(method), true, method)
    const invocation = decisionRemoteContribution().invocations.find(row => row.method === method)
    assert.ok(invocation, method)
    assert.deepEqual(invocation.parameters, [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }])
    assert.equal(invocation.scope, undefined)
    assert.equal(JSON.stringify(invocation).includes('lookup'), false)
    assert.equal(invocation.cancellation, undefined)
  }
  assert.equal(DECISION_REMOTE_METHODS.filter(method => method === 'publicMemoryRefresh').length, 1)
})

test('publicMemoryArgs drops caller workspace, zone and ownership overrides', () => {
  assert.deepEqual(publicMemoryArgs({
    sessionId: 'child', agentId: 'ag', learningRunId: 'lr', workspaceKey: '/spoof', zone: 'public',
    owner: 'other-agent', rootSessionId: 'forged', acknowledgedDisclosure: 'yes', retryFailedExtraction: 1,
  }), { sessionId: 'child', agentId: 'ag', learningRunId: 'lr' })
  assert.deepEqual(publicMemoryArgs({ sessionId: 's', acknowledgedDisclosure: true, retryFailedExtraction: true }), {
    sessionId: 's', acknowledgedDisclosure: true, retryFailedExtraction: true,
  })
  assert.deepEqual(publicMemoryArgs(undefined), {})
  assert.deepEqual(publicMemoryArgs({ sessionId: 7, agentId: null }), {})
})

test('the remote drives disclosure, candidate review, publish and rollback with opaque aliases only', async t => {
  const f = await publicMemoryFixture(t)
  const w1 = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'remote-w1' })
  const w2 = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'remote-w2' })
  insertSnapshot(f, 'ms_private_remote', 1, 'published')
  const privateBefore = JSON.stringify(f.broker.store.db.prepare("SELECT * FROM memory_snapshots WHERE zone='workspace' ORDER BY snapshot_id").all())
  f.respond(crossWorkspaceAdd())
  const service = serviceFor(f.broker)

  // A caller-named workspace never reaches the Broker: the first refresh is
  // gated by the disclosure and makes no model call.
  const gated = await service.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, workspaceKey: '/spoof' })
  assert.equal(gated.ok, true)
  assert.equal(gated.value.status, 'disclosure-required')
  assert.equal(gated.value.disclosure.required, true)
  assert.equal(f.requests.length, 0)

  const started = await service.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(started.ok, true)
  assert.equal(started.value.status, 'candidate')
  assert.equal(f.requests.length, 1)

  const review = await service.publicCandidate({ sessionId: 'root2', agentId: f.profile.agentId })
  assert.equal(review.ok, true)
  assert.equal(review.value.zone, 'public')
  assert.equal(review.value.workspaceCount, 2)
  assert.deepEqual(review.value.sources.map(source => source.alias).sort(), [workspaceAlias(f.w1), workspaceAlias(f.w2)].sort())
  assert.equal(review.value.sources.find(source => source.alias === workspaceAlias(f.w2)).readableInCurrentWorkspace, true)
  assert.equal(review.value.sources.find(source => source.alias === workspaceAlias(f.w1)).readableInCurrentWorkspace, false)
  assert.equal(review.value.replay.passed, true)

  const serialized = JSON.stringify([gated.value, started.value, review.value])
  for (const secret of [f.w1, f.w2, f.dir, w1.caseId, w2.caseId, 'namespaceWorkspaceKey', 'workspaceKey']) {
    assert.equal(serialized.includes(secret), false, secret)
  }
  assert.equal(serialized.includes(workspaceAlias(f.w1)), true, 'the opaque alias is the only workspace identity')

  const candidate = started.value.candidate
  const published = await service.snapshotPublish({ sessionId: 'root2', snapshotId: candidate.snapshotId, expectedRevision: candidate.revision })
  assert.equal(published.ok, true)
  assert.equal(published.value.state, 'published')
  assert.equal(published.value.zone, 'public')
  const afterPublish = await service.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId })
  assert.equal(afterPublish.value.current.snapshotId, candidate.snapshotId)
  assert.equal(afterPublish.value.candidate, null)

  const rollback = await service.snapshotRollback({ sessionId: 'root1', snapshotId: candidate.snapshotId, expectedRevision: published.value.revision })
  assert.equal(rollback.ok, true)
  assert.equal(rollback.value.state, 'rolled_back')
  const empty = await service.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId })
  assert.equal(empty.value.current, null)

  assert.equal(JSON.stringify(f.broker.store.db.prepare("SELECT * FROM memory_snapshots WHERE zone='workspace' ORDER BY snapshot_id").all()), privateBefore)
  assert.equal(f.broker.learning.currentSnapshot(f.profile.agentId, f.w1).snapshotId, 'ms_private_remote')
  assert.equal(f.requests.length, 1, 'publish, rollback and the reviews never call the model')
})

test('an unauthorized session or private record fails closed and is audited without body text', async t => {
  const f = await publicMemoryFixture(t)
  insertSnapshot(f, 'ms_private_boundary', 1, 'published')
  const service = serviceFor(f.broker)

  const unknown = await service.publicMemoryRefresh({ sessionId: 'not-a-session', agentId: f.profile.agentId })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'INCOMPLETE_LINEAGE')

  const foreign = await service.memorySnapshot({ sessionId: 'root2', snapshotId: 'ms_private_boundary' })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.error.code, 'OUT_OF_SCOPE')
  assert.equal(f.requests.length, 0)

  const boundary = f.audits.filter(entry => entry.value?.action === 'boundary-reject')
  assert.equal(boundary.length >= 1, true)
  assert.equal(boundary.some(entry => entry.kind === 'snapshot' && entry.value.snapshotId === 'ms_private_boundary'), true)
  const serialized = JSON.stringify(f.audits)
  assert.equal(serialized.includes('Prefer'), false, 'audit mirrors never carry record body text')
  assert.equal(serialized.includes(f.w1), false)
})

test('global off keeps only the overview read and fails the public memory methods closed', async () => {
  const calls = []
  const broker = {
    status: () => ({ available: false, enabled: false, reason: 'disabled' }),
    overview: async () => ({ status: broker.status(), selector: { mode: 'off' }, agents: [] }),
  }
  for (const method of DECISION_REMOTE_METHODS.filter(method => method !== 'overview')) {
    broker[method] = async () => { calls.push(method); return { unexpected: true } }
  }
  const service = serviceFor(broker)
  assert.equal((await service.overview({ sessionId: 'root' })).ok, true)
  for (const method of ['publicMemoryRefresh', 'publicCandidate']) {
    assert.deepEqual(await service[method]({ sessionId: 'root', agentId: 'ag' }), {
      ok: false, error: { code: 'DECISION_UNAVAILABLE', message: 'disabled' },
    }, method)
  }
  assert.deepEqual(calls, [])
})
