import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readL2Memory } from '../../src/decision/retrieval/memory.js'
import { brokerFixture, insertSnapshot } from './p3-fixtures.js'

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
