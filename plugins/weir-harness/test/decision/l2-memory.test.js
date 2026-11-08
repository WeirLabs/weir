import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readL2Memory } from '../../src/decision/retrieval/memory.js'
import { brokerFixture, insertSnapshot, seedUserDecision } from './p3-fixtures.js'

function refsFor(f) {
  const scope = { workspaces: [f.workspace] }
  return [
    { evidenceId: 'ev_correction', agentId: f.profile.agentId, source: 'user_correction', locator: { kind: 'feedback', feedbackId: 'fb_correction' }, scope, status: 'active' },
    { evidenceId: 'ev_case', agentId: f.profile.agentId, source: 'user_decision', locator: { kind: 'case', caseId: 'dc_source' }, scope, status: 'active' },
  ]
}

test('L2 expands every declared source into ordered actual L5 evidence and audits exclusions', async t => {
  const f = await brokerFixture(t)
  const scope = { workspaces: [f.workspace] }
  const principles = [
    { principleId: 'pr_ok', text: 'Reviewed principle', scope, sources: ['dc_source', 'fb_correction'], state: 'active' },
    { principleId: 'pr_missing', text: 'Missing source', scope, sources: ['dc_source', 'dc_missing'], state: 'active' },
    { principleId: 'pr_retired', text: 'Retired', scope, sources: ['dc_source'], state: 'retired' },
    { principleId: 'pr_contested', text: 'Contested', scope, sources: ['dc_source'], state: 'contested' },
    { principleId: 'pr_scope', text: 'Out of scope', scope: { workspaces: ['/other'] }, sources: ['dc_source'], state: 'active' },
  ]
  insertSnapshot(f, 'ms_l2', 1, 'published', { principles, revision: 7 })
  const result = readL2Memory(f.broker.store, {
    agentId: f.profile.agentId, workspaceKey: f.workspace, scope, attemptStartedAt: 1_000,
  }, refsFor(f))
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.status, 'populated')
  assert.equal(result.snapshotId, 'ms_l2')
  assert.equal(result.snapshotRevision, 7)
  assert.match(result.snapshotHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.items, [{
    schemaVersion: 1, kind: 'reviewed_principle', principleId: 'pr_ok',
    text: 'Reviewed principle', scope, sources: ['dc_source', 'fb_correction'],
    evidenceIds: ['ev_case', 'ev_correction'],
  }])
  const exclusions = Object.fromEntries(result.exclusions.map(item => [item.principleId, item.reason]))
  assert.deepEqual(exclusions, {
    pr_missing: 'SOURCE_UNAVAILABLE', pr_retired: 'NOT_ACTIVE',
    pr_contested: 'NOT_ACTIVE', pr_scope: 'OUT_OF_SCOPE',
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.items[0]), true)
  assert.equal(Object.isFrozen(result.items[0].evidenceIds), true)
  const foreignScope = refsFor(f)
  foreignScope[1] = { ...foreignScope[1], scope: { workspaces: ['/other'] } }
  const excluded = readL2Memory(f.broker.store, {
    agentId: f.profile.agentId, workspaceKey: f.workspace, scope, attemptStartedAt: 1_000,
  }, foreignScope)
  assert.equal(excluded.items.length, 0)
  assert.ok(excluded.exclusions.some(item => item.principleId === 'pr_ok' && item.reason === 'SOURCE_UNAVAILABLE'))
})

test('a current Snapshot with no eligible principle keeps its pin while rolled_back returns true empty', async t => {
  const f = await brokerFixture(t)
  const scope = { workspaces: [f.workspace] }
  insertSnapshot(f, 'ms_empty_pin', 1, 'published', {
    principles: [{ principleId: 'pr_unavailable', text: 'Unavailable', scope, sources: ['dc_deleted'], state: 'active' }],
    revision: 4,
  })
  const input = { agentId: f.profile.agentId, workspaceKey: f.workspace, scope, attemptStartedAt: 1_000 }
  const pinned = readL2Memory(f.broker.store, input, [])
  assert.equal(pinned.status, 'empty')
  assert.equal(pinned.snapshotId, 'ms_empty_pin')
  assert.equal(pinned.snapshotRevision, 4)
  assert.match(pinned.snapshotHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(pinned.items, [])
  assert.deepEqual(pinned.exclusions, [{ principleId: 'pr_unavailable', reason: 'SOURCE_UNAVAILABLE' }])

  f.broker.store.db.prepare("UPDATE memory_snapshots SET state='rolled_back' WHERE snapshot_id='ms_empty_pin'").run()
  assert.deepEqual(readL2Memory(f.broker.store, input, []), {
    schemaVersion: 1, status: 'empty', snapshotId: null, snapshotRevision: null,
    snapshotHash: null, items: [], exclusions: [],
  })
})

test('an externally inserted active principle with zero sources is excluded', async t => {
  const f = await brokerFixture(t)
  const scope = { workspaces: [f.workspace] }
  insertSnapshot(f, 'ms_zero_sources', 1, 'published', {
    principles: [{ principleId: 'pr_zero', text: 'Unsourced external principle', scope, sources: [], state: 'active' }],
  })
  const result = readL2Memory(f.broker.store, {
    agentId: f.profile.agentId, workspaceKey: f.workspace, scope, attemptStartedAt: 1_000,
  }, refsFor(f))
  assert.equal(result.status, 'empty')
  assert.equal(result.snapshotId, 'ms_zero_sources')
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.exclusions, [{ principleId: 'pr_zero', reason: 'SOURCE_UNAVAILABLE' }])
})

test('only the highest compatible published Snapshot is current across draft, rolled_back, and namespace rows', async t => {
  const f = await brokerFixture(t)
  const scope = { workspaces: [f.workspace] }
  const principle = { principleId: 'pr_current', text: 'Current reviewed principle', scope, sources: ['dc_source'], state: 'active' }
  insertSnapshot(f, 'ms_draft_future', 4, 'draft', { principles: [principle], schemaVersion: 99 })
  insertSnapshot(f, 'ms_rolled_future', 3, 'rolled_back', { principles: [principle] })
  insertSnapshot(f, 'ms_current', 2, 'published', { principles: [principle], revision: 8 })
  const input = { agentId: f.profile.agentId, workspaceKey: f.workspace, scope, attemptStartedAt: 1_000 }
  const current = readL2Memory(f.broker.store, input, refsFor(f))
  assert.equal(current.snapshotId, 'ms_current')
  assert.equal(current.snapshotRevision, 8)
  assert.deepEqual(current.items.map(item => item.principleId), ['pr_current'])

  f.broker.store.db.prepare("UPDATE memory_snapshots SET schema_version=99 WHERE snapshot_id='ms_current'").run()
  assert.throws(() => readL2Memory(f.broker.store, input, refsFor(f)), error => error.code === 'UNSUPPORTED_SCHEMA_VERSION')
})

test('a published Snapshot from another Agent/workspace never becomes current L2', async t => {
  const f = await brokerFixture(t)
  const other = await f.broker.profileUpsert({ workspaceKey: '/other', name: 'Other', userDescription: 'Other namespace' })
  insertSnapshot(f, 'ms_other', 1, 'published', {
    agentId: other.agentId,
    principles: [{ principleId: 'pr_other', text: 'Foreign principle', scope: { workspaces: ['/other'] }, sources: ['dc_other'], state: 'active' }],
  })
  const result = readL2Memory(f.broker.store, {
    agentId: f.profile.agentId, workspaceKey: f.workspace, scope: { workspaces: [f.workspace] }, attemptStartedAt: 1_000,
  }, [])
  assert.deepEqual(result, {
    schemaVersion: 1, status: 'empty', snapshotId: null, snapshotRevision: null,
    snapshotHash: null, items: [], exclusions: [],
  })
})

test('Retriever supplies the full eligible L5 set to L2 before deriving the final frozen projection', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'retrieval-l2-source')
  const scope = { workspaces: [f.workspace] }
  const ref = await f.broker.evidence.add({
    agentId: f.profile.agentId, source: 'user_decision', locator: { kind: 'case', caseId: source.caseId }, scope,
  })
  insertSnapshot(f, 'ms_retriever', 1, 'published', {
    principles: [{ principleId: 'pr_retriever', text: 'Use the reviewed source', scope, sources: [source.caseId], state: 'active' }],
  })
  const result = f.broker.retriever.retrieve({
    agentId: f.profile.agentId, workspaceKey: f.workspace, scope, attemptStartedAt: 1_000,
  })
  assert.equal(result.L2.snapshotId, 'ms_retriever')
  assert.deepEqual(result.L2.items.map(item => item.evidenceIds), [[ref.evidenceId]])
  assert.ok(result.L5.some(item => item.evidenceId === ref.evidenceId))
  assert.deepEqual(result.L3, [])
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.L2.items[0]), true)
})
