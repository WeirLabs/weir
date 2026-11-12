// Public/private memory namespaces (OpenSpec 4.1).
//
// The zone helper is the only place that decides what `(agentId, zone,
// workspace)` means. Private and public namespaces keep independent version
// sequences, independent active-run slots and independent current Snapshots.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  memoryNamespace, namespaceKey, publicSourceHighWater, workspaceAlias,
} from '../../src/decision/learning/namespace.js'
import { insertLearningRun, insertSnapshot } from './p3-fixtures.js'
import { publicMemoryFixture } from './public-fixtures.js'

const MODEL_ROUTE = { kind: 'inherited', provider: 'p', model: 'm' }
const EMPTY_REPLAY = { passed: true, metrics: { operationCount: 0, sourceCount: 0, activePrincipleCount: 0, retiredPrincipleCount: 0 } }

test('namespace helpers close the private/public vocabulary', () => {
  assert.deepEqual(memoryNamespace('workspace', '/w1'), { zone: 'workspace', namespaceWorkspaceKey: '/w1' })
  assert.deepEqual(memoryNamespace('public'), { zone: 'public', namespaceWorkspaceKey: null })
  assert.deepEqual(memoryNamespace('public', null), { zone: 'public', namespaceWorkspaceKey: null })
  for (const [zone, key] of [['public', '/w1'], ['workspace', null], ['workspace', ''], ['other', '/w1']]) {
    assert.throws(() => memoryNamespace(zone, key), error => error.code === 'INVALID_NAMESPACE')
  }
  assert.notEqual(namespaceKey(memoryNamespace('workspace', '/w1')), namespaceKey(memoryNamespace('workspace', '/w2')))
  assert.notEqual(namespaceKey(memoryNamespace('workspace', '/w1')), namespaceKey(memoryNamespace('public')))
  const alias = workspaceAlias('/w1')
  assert.match(alias, /^origin_[a-f0-9]{12}$/)
  assert.equal(alias, workspaceAlias('/w1'))
  assert.notEqual(alias, workspaceAlias('/w2'))
  assert.equal(alias.includes('/w1'), false)
})

test('public source high-water is deterministic, order independent and revision sensitive', () => {
  const left = { sourceId: 'dc_a', kind: 'case', revision: 1 }
  const right = { sourceId: 'dc_b', kind: 'correction', revision: 2 }
  assert.equal(publicSourceHighWater([left, right]), publicSourceHighWater([right, left]))
  assert.match(publicSourceHighWater([left, right]), /^[a-f0-9]{64}$/)
  assert.notEqual(publicSourceHighWater([left, right]), publicSourceHighWater([{ ...left, revision: 2 }, right]))
  assert.notEqual(publicSourceHighWater([left, right]), publicSourceHighWater([left, right, { sourceId: 'dc_c', kind: 'case', revision: 1 }]))
  assert.equal(publicSourceHighWater([]), publicSourceHighWater([]))
})

test('private and public namespaces keep independent versions, active slots and current Snapshots', async t => {
  const f = await publicMemoryFixture(t)
  const agentId = f.profile.agentId

  const publicRun = await f.broker.learning.beginPublicRun({
    agentId, requestId: 'public-namespace-1', startedAt: 1_000, agentProfileRevision: f.profile.revision, modelRoute: MODEL_ROUTE,
  })
  assert.equal(publicRun.created, true)
  assert.equal(publicRun.run.zone, 'public')
  assert.equal(publicRun.run.namespaceWorkspaceKey, null)
  assert.equal(publicRun.run.inputFrozen.zone, 'public')
  assert.equal(publicRun.run.inputFrozen.workspaceKey, null)
  assert.equal(publicRun.run.inputFrozen.sourceHighWater, publicSourceHighWater([]))

  const privateInput = {
    agentId, workspaceKey: f.w1, requestId: 'private-namespace-1', startedAt: 1_000,
    agentProfileRevision: f.profile.revision, modelRoute: MODEL_ROUTE,
  }
  const privateRun = await f.broker.learning.beginRun(privateInput)
  assert.equal(privateRun.created, true)
  assert.equal(privateRun.run.zone, 'workspace')
  assert.equal(privateRun.run.namespaceWorkspaceKey, f.w1)

  // Each namespace gets its own single active run: the public candidate never
  // blocks the private run and vice versa.
  await assert.rejects(
    f.broker.learning.beginPublicRun({ agentId, requestId: 'public-namespace-2', startedAt: 1_000, agentProfileRevision: f.profile.revision, modelRoute: MODEL_ROUTE }),
    error => error.code === 'LEARNING_RUN_ACTIVE',
  )
  await assert.rejects(
    f.broker.learning.beginRun({ ...privateInput, requestId: 'private-namespace-2' }),
    error => error.code === 'LEARNING_RUN_ACTIVE',
  )

  const publicSnapshot = (await f.broker.learning.commitCandidate({
    learningRunId: publicRun.run.learningRunId, expectedRevision: publicRun.run.revision,
    operations: [], replay: EMPTY_REPLAY, principles: [],
  })).snapshot
  const privateSnapshot = (await f.broker.learning.commitCandidate({
    learningRunId: privateRun.run.learningRunId, expectedRevision: privateRun.run.revision,
    operations: [], replay: EMPTY_REPLAY, principles: [],
  })).snapshot
  assert.equal(publicSnapshot.version, 1)
  assert.equal(privateSnapshot.version, 1)
  assert.equal(publicSnapshot.zone, 'public')
  assert.equal(privateSnapshot.namespaceWorkspaceKey, f.w1)

  await f.broker.learning.publish(publicSnapshot.snapshotId, publicSnapshot.revision)
  await f.broker.learning.publish(privateSnapshot.snapshotId, privateSnapshot.revision)

  assert.equal(f.broker.learning.currentSnapshot(agentId, f.w1).snapshotId, privateSnapshot.snapshotId)
  assert.equal(f.broker.learning.currentPublicSnapshot(agentId).snapshotId, publicSnapshot.snapshotId)
  // Reading every zone for the Agent must not treat equal per-zone versions as ambiguous.
  assert.equal(f.broker.learning.listSnapshots(agentId).length, 2)
  assert.deepEqual(f.broker.learning.listRuns(agentId).map(run => run.zone).sort(), ['public', 'workspace'])
  assert.equal(f.broker.learning.lastPublicHighWater(agentId), publicSourceHighWater([]))
})

test('the same requestId is deduplicated inside one namespace, never across workspaces or zones', async t => {
  const f = await publicMemoryFixture(t)
  const agentId = f.profile.agentId
  const base = { agentId, requestId: 'shared-request-id', startedAt: 1_000, agentProfileRevision: f.profile.revision, modelRoute: MODEL_ROUTE }
  const w1Run = await f.broker.learning.beginRun({ ...base, workspaceKey: f.w1 })
  const w2Run = await f.broker.learning.beginRun({ ...base, workspaceKey: f.w2 })
  const publicRun = await f.broker.learning.beginPublicRun(base)
  assert.equal(new Set([w1Run.run.learningRunId, w2Run.run.learningRunId, publicRun.run.learningRunId]).size, 3)
  assert.equal(w2Run.run.namespaceWorkspaceKey, f.w2)
  const duplicate = await f.broker.learning.beginRun({ ...base, workspaceKey: f.w1 })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.run.learningRunId, w1Run.run.learningRunId)
  assert.equal(duplicate.run.namespaceWorkspaceKey, f.w1)
})

test('pre-Phase-B private rows keep their frozen input shape and stay readable', async t => {
  const f = await publicMemoryFixture(t)
  insertLearningRun(f, 'lr_legacy_private', 'candidate')
  const run = f.broker.learning.getRunById('lr_legacy_private')
  assert.equal(run.zone, 'workspace')
  assert.equal(run.namespaceWorkspaceKey, f.w1)
  assert.equal('zone' in run.inputFrozen, false)
  assert.equal('sourceHighWater' in run.inputFrozen, false)
  insertSnapshot(f, 'ms_legacy_private', 2, 'published', { learningRunId: 'lr_legacy_private' })
  assert.equal(f.broker.learning.currentSnapshot(f.profile.agentId, f.w1).snapshotId, 'ms_legacy_private')
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId), null)
})
