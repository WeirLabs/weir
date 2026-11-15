import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../../src/decision/contracts.js'
import { CURRENT_SCHEMA_VERSION } from '../../src/decision/store/schema.js'
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
  assert.equal(f.broker.store.db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION)
})

test('current Snapshot is the unambiguous highest published version, never draft or rolled_back', async t => {
  const f = await brokerFixture(t)
  insertSnapshot(f, 'ms_v1', 1, 'published')
  insertSnapshot(f, 'ms_v2', 2, 'published')
  insertSnapshot(f, 'ms_v3_draft', 3, 'draft')
  insertSnapshot(f, 'ms_v4_rolled', 4, 'rolled_back')
  assert.equal((await f.broker.agent({ sessionId: 'root', agentId: f.profile.agentId })).currentSnapshotId, 'ms_v2')

  // The v2 schema makes a duplicate namespace version impossible. A corrupt or
  // pre-v2 database can still present one, so the strict reader must stay the
  // final guard: drop the constraint, then prove the reader fails closed.
  f.broker.store.db.exec('DROP INDEX memory_snapshots_namespace_version')
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
  // Same reasoning as above: the constraint is dropped only to simulate the
  // corrupt state the reader must still reject.
  f.broker.store.db.exec('DROP INDEX memory_snapshots_namespace_version')
  f.broker.store.db.exec('DROP INDEX learning_runs_active_workspace')
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

/** One draft candidate with a published parent: p_keep is untouched, p_change is
 * reworded by this run, p_add is new this run and p_retire exists only in the
 * parent. Those four cases are exactly the editable/non-editable split. */
function seedCandidate(f, options = {}) {
  const workspace = options.workspace ?? f.workspace
  const scope = { workspaces: [workspace] }
  insertSnapshot(f, 'ms_parent', 1, 'published', {
    principles: [
      { principleId: 'p_keep', text: 'Keep this rule', scope, sources: ['dc_source'], state: 'active' },
      { principleId: 'p_change', text: 'Old wording', scope, sources: ['dc_source'], state: 'active' },
      { principleId: 'p_retire', text: 'Retire this rule', scope, sources: ['dc_source'], state: 'active' },
    ],
  })
  insertSnapshot(f, 'ms_draft', 2, 'draft', {
    parentSnapshotId: 'ms_parent',
    revision: options.revision ?? 3,
    principles: [
      { principleId: 'p_keep', text: 'Keep this rule', scope, sources: ['dc_source'], state: 'active' },
      { principleId: 'p_change', text: 'New wording', scope, sources: ['dc_source'], state: 'active' },
      { principleId: 'p_add', text: 'Added rule', scope, sources: ['dc_source'], state: 'active' },
    ],
  })
}

/** The persisted bytes of the model's own derivation: a user edit must never
 * rewrite them. */
function runBytes(f, learningRunId) {
  const row = f.broker.store.db.prepare('SELECT operations_json,replay_json,revision,outcome FROM learning_runs WHERE learning_run_id=?').get(learningRunId)
  return { operations: row.operations_json, replay: row.replay_json, revision: row.revision, outcome: row.outcome }
}

function snapshotBytes(f, snapshotId) {
  return JSON.stringify(f.broker.store.db.prepare('SELECT * FROM memory_snapshots WHERE snapshot_id=?').get(snapshotId))
}

test('candidate updates revise wording and scope of this review and bump only the draft revision', async t => {
  const f = await brokerFixture(t)
  seedCandidate(f)
  const before = runBytes(f, 'lr_ms_draft')
  const draftBefore = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: 'ms_draft' })
  assert.equal(draftBefore.revision, 3)
  assert.equal(before.outcome, 'candidate')

  const result = await f.broker.learning.updateCandidate('ms_draft', 3, [
    { principleId: 'p_change', text: 'Revised wording', scope: { paths: ['src/api'], authorizationClasses: ['B', 'A'] } },
  ])
  assert.equal(result.edited, 1)
  assert.equal(result.removed, 0)
  assert.equal(result.snapshot.revision, 4)
  const edited = result.snapshot.principles.find(principle => principle.principleId === 'p_change')
  assert.equal(edited.text, 'Revised wording')
  // The workspace stays the candidate's own: the edit only rewrites hints, and
  // the class list keeps the canonical A/B/C order.
  assert.deepEqual(edited.scope, { workspaces: [f.workspace], paths: ['src/api'], authorizationClasses: ['A', 'B'] })
  assert.deepEqual(edited.sources, ['dc_source'])
  assert.equal(edited.state, 'active')
  assert.equal(result.snapshot.contentHash, (await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: 'ms_draft' })).contentHash)
  assert.notEqual(result.snapshot.contentHash, draftBefore.contentHash)
  // The model's derivation and the run's own revision are history, not scratch.
  assert.deepEqual(runBytes(f, 'lr_ms_draft'), before)
  assert.equal(result.run.revision, before.revision)
  // Untouched entries keep their exact stored shape.
  assert.deepEqual(result.snapshot.principles.map(principle => principle.principleId), ['p_keep', 'p_change', 'p_add'])
  assert.equal(result.snapshot.principles[0].text, 'Keep this rule')
})

test('candidate updates delete an added or changed principle without touching the parent history', async t => {
  const f = await brokerFixture(t)
  seedCandidate(f)
  const parentBefore = snapshotBytes(f, 'ms_parent')
  const result = await f.broker.learning.updateCandidate('ms_draft', 3, [{ principleId: 'p_add', remove: true }])
  assert.equal(result.removed, 1)
  assert.equal(result.edited, 0)
  assert.deepEqual(result.snapshot.principles.map(principle => principle.principleId), ['p_keep', 'p_change'])
  assert.equal(result.snapshot.revision, 4)
  // A later revision keeps working off the current draft, not the original one.
  const second = await f.broker.learning.updateCandidate('ms_draft', 4, [{ principleId: 'p_change', remove: true }])
  assert.deepEqual(second.snapshot.principles.map(principle => principle.principleId), ['p_keep'])
  assert.equal(second.snapshot.revision, 5)
  assert.equal(second.removed, 1)
  assert.equal(snapshotBytes(f, 'ms_parent'), parentBefore)
})

test('candidate updates only accept this candidate added/changed entries', async t => {
  const f = await brokerFixture(t)
  seedCandidate(f)
  const draftBefore = snapshotBytes(f, 'ms_draft')
  for (const principleId of ['p_keep', 'p_retire', 'p_absent']) {
    await assert.rejects(
      f.broker.learning.updateCandidate('ms_draft', 3, [{ principleId, text: 'Rejected rewrite' }]),
      error => error.code === 'CANDIDATE_ITEM_NOT_EDITABLE',
      principleId,
    )
  }
  assert.equal(snapshotBytes(f, 'ms_draft'), draftBefore)
})

test('candidate updates reject an open or ambiguous edit shape without writing', async t => {
  const f = await brokerFixture(t)
  seedCandidate(f)
  const draftBefore = snapshotBytes(f, 'ms_draft')
  const rejected = [
    [[], 'INVALID_RECORD'],
    ['not-a-list', 'INVALID_RECORD'],
    [[{ principleId: 'p_add' }], 'INVALID_RECORD'],
    [[{ principleId: 'p_add', remove: true, text: 'Both at once' }], 'INVALID_RECORD'],
    [[{ principleId: 'p_add', remove: true, scope: { paths: ['x'] } }], 'INVALID_RECORD'],
    [[{ principleId: 'p_add', remove: 'yes' }], 'INVALID_RECORD'],
    [[{ principleId: 'p_absent', remove: true }, { principleId: 'p_absent', text: 'Twice' }], 'INVALID_RECORD'],
    [[{ principleId: 'p_add', text: 'Rewrite', sources: ['dc_other'] }], 'UNKNOWN_FIELD'],
    [[{ principleId: 'p_add', text: 'Rewrite', state: 'retired' }], 'UNKNOWN_FIELD'],
    [[{ principleId: 'p_add', text: 'Rewrite', scope: { workspaces: ['/elsewhere'] } }], 'UNKNOWN_FIELD'],
    [[{ principleId: 'p_add', text: 'x'.repeat(601) }], 'INVALID_PRINCIPLE'],
    [[{ principleId: 'p_add', text: '' }], 'INVALID_PRINCIPLE'],
    [[{ principleId: 'p_add', scope: { paths: ['a', 'a'] } }], 'INVALID_PRINCIPLE'],
    [[{ principleId: 'p_add', scope: { authorizationClasses: ['D'] } }], 'INVALID_PRINCIPLE'],
    [Array.from({ length: 33 }, (_, index) => ({ principleId: `p_${index}`, remove: true })), 'CANDIDATE_EDIT_LIMIT'],
  ]
  for (const [edits, code] of rejected) {
    await assert.rejects(f.broker.learning.updateCandidate('ms_draft', 3, edits), error => error.code === code, `${code} ${JSON.stringify(edits).slice(0, 120)}`)
  }
  assert.equal(snapshotBytes(f, 'ms_draft'), draftBefore)
})

test('candidate updates fail closed on a stale revision, a published candidate and a rejected candidate', async t => {
  const f = await brokerFixture(t)
  seedCandidate(f)
  const draftBefore = snapshotBytes(f, 'ms_draft')
  await assert.rejects(
    f.broker.learning.updateCandidate('ms_draft', 2, [{ principleId: 'p_add', text: 'Stale rewrite' }]),
    error => error.code === 'REVISION_CONFLICT',
  )
  assert.equal(snapshotBytes(f, 'ms_draft'), draftBefore)

  // A published Snapshot's principles are immutable history: no edit entry point
  // exists and the store rejects a direct request.
  insertSnapshot(f, 'ms_published', 3, 'published', { parentSnapshotId: 'ms_draft', principles: [
    { principleId: 'p_add', text: 'Added rule', scope: { workspaces: [f.workspace] }, sources: ['dc_source'], state: 'active' },
  ] })
  const publishedBefore = snapshotBytes(f, 'ms_published')
  await assert.rejects(
    f.broker.learning.updateCandidate('ms_published', 1, [{ principleId: 'p_add', text: 'Too late' }]),
    error => error.code === 'SNAPSHOT_STATE_CONFLICT',
  )
  assert.equal(snapshotBytes(f, 'ms_published'), publishedBefore)

  insertLearningRun(f, 'lr_ms_rejected', 'rejected')
  insertSnapshot(f, 'ms_rejected', 4, 'draft', { learningRunId: 'lr_ms_rejected' })
  const rejectedBefore = snapshotBytes(f, 'ms_rejected')
  await assert.rejects(
    f.broker.learning.updateCandidate('ms_rejected', 1, [{ principleId: 'p_add', text: 'Never' }]),
    error => error.code === 'SNAPSHOT_STATE_CONFLICT',
  )
  assert.equal(snapshotBytes(f, 'ms_rejected'), rejectedBefore)
})
