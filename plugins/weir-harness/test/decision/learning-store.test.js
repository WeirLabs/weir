import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../../src/decision/contracts.js'
import { brokerFixture, frozenInput, insertLearningRun, insertSnapshot } from './p3-fixtures.js'

test('P3 strict readers reject high-version, corrupt, and unknown records without rewriting v1 rows', async t => {
  const f = await brokerFixture(t)
  insertLearningRun(f, 'lr_high', 'failed')
  f.broker.store.db.prepare('UPDATE learning_runs SET schema_version=99 WHERE learning_run_id=?').run('lr_high')
  await assert.rejects(
    f.broker.learningRun({ sessionId: 'root', learningRunId: 'lr_high' }),
    error => error.code === 'UNSUPPORTED_SCHEMA_VERSION',
  )

  insertLearningRun(f, 'lr_corrupt', 'failed')
  f.broker.store.db.prepare("UPDATE learning_runs SET input_frozen_json='{' WHERE learning_run_id=?").run('lr_corrupt')
  const corruptBefore = f.broker.store.db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get('lr_corrupt')
  await assert.rejects(f.broker.learningRun({ sessionId: 'root', learningRunId: 'lr_corrupt' }))
  assert.deepEqual(f.broker.store.db.prepare('SELECT * FROM learning_runs WHERE learning_run_id=?').get('lr_corrupt'), corruptBefore)

  insertLearningRun(f, 'lr_unknown', 'done')
  await assert.rejects(f.broker.learningRun({ sessionId: 'root', learningRunId: 'lr_unknown' }))
  insertSnapshot(f, 'ms_unknown', 1, 'archived')
  await assert.rejects(f.broker.memorySnapshot({ sessionId: 'root', snapshotId: 'ms_unknown' }))
  assert.equal(f.broker.store.db.prepare('PRAGMA user_version').get().user_version, 1)
})

test('current Snapshot is the unambiguous highest published version, never draft or rolled_back', async t => {
  const f = await brokerFixture(t)
  insertSnapshot(f, 'ms_v1', 1, 'published')
  insertSnapshot(f, 'ms_v2', 2, 'published')
  insertSnapshot(f, 'ms_v3_draft', 3, 'draft')
  insertSnapshot(f, 'ms_v4_rolled', 4, 'rolled_back')
  assert.equal((await f.broker.agent({ sessionId: 'root', agentId: f.profile.agentId })).currentSnapshotId, 'ms_v2')

  insertSnapshot(f, 'ms_v2_duplicate', 2, 'published')
  await assert.rejects(f.broker.agent({ sessionId: 'root', agentId: f.profile.agentId }))
})

test('Snapshot content hash is canonical and generatedDescription stays empty and read-only', async t => {
  const f = await brokerFixture(t)
  const principles = [{
    principleId: 'pr_one', text: 'Prefer A', scope: { workspaces: [f.workspace] },
    sources: ['dc_source'], state: 'active',
  }]
  insertSnapshot(f, 'ms_hash', 1, 'published', { principles })
  const snapshot = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: 'ms_hash' })
  assert.deepEqual(snapshot.generatedDescription, { revision: 0, text: '' })
  const expected = createHash('sha256').update(canonicalJson({
    version: 1, parentSnapshotId: null, principles,
    generatedDescription: { revision: 0, text: '' }, learningRunId: 'lr_ms_hash',
  })).digest('hex')
  assert.equal(snapshot.contentHash, expected)

  f.broker.store.db.prepare('UPDATE memory_snapshots SET generated_description_json=? WHERE snapshot_id=?')
    .run(JSON.stringify({ revision: 1, text: 'INVENTED PROFILE' }), 'ms_hash')
  await assert.rejects(f.broker.memorySnapshot({ sessionId: 'root', snapshotId: 'ms_hash' }))
})

test('P3 strict readers close JSON envelopes, operations, principles, and scopes', async t => {
  const f = await brokerFixture(t)
  insertLearningRun(f, 'lr_extra_input', 'failed', { inputFrozen: { ...frozenInput(f), unexpected: true } })
  await assert.rejects(f.broker.learningRun({ sessionId: 'root', learningRunId: 'lr_extra_input' }), error => error.code === 'UNKNOWN_FIELD')

  insertLearningRun(f, 'lr_bad_operation', 'failed', { operations: [{ op: 'invert', principleId: 'pr_one' }] })
  await assert.rejects(f.broker.learningRun({ sessionId: 'root', learningRunId: 'lr_bad_operation' }))

  insertSnapshot(f, 'ms_extra_principle', 1, 'draft', { principles: [{
    principleId: 'pr_one', text: 'Prefer A', scope: { workspaces: [f.workspace], unexpected: true },
    sources: ['dc_source'], state: 'active', unexpected: true,
  }] })
  await assert.rejects(f.broker.memorySnapshot({ sessionId: 'root', snapshotId: 'ms_extra_principle' }), error => error.code === 'UNKNOWN_FIELD')
})

test('any duplicate Agent/version is ambiguous, even outside the published set', async t => {
  const f = await brokerFixture(t)
  insertSnapshot(f, 'ms_draft_a', 1, 'draft')
  insertSnapshot(f, 'ms_draft_b', 1, 'draft')
  await assert.rejects(
    f.broker.agent({ sessionId: 'root', agentId: f.profile.agentId }),
    error => error.code === 'SNAPSHOT_VERSION_AMBIGUOUS',
  )
})

test('Learning Run replay details are closed bounded failure codes, not raw model text', async t => {
  const f = await brokerFixture(t)
  insertLearningRun(f, 'lr_raw_replay', 'failed', {
    replay: {
      passed: false,
      metrics: { operationCount: 0, sourceCount: 0, activePrincipleCount: 0, retiredPrincipleCount: 0 },
      detail: 'raw model text must not be stored here',
    },
  })
  await assert.rejects(f.broker.learningRun({ sessionId: 'root', learningRunId: 'lr_raw_replay' }))
})
