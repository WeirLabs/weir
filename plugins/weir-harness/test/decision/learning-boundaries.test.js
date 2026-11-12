import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DecisionBroker } from '../../src/decision/broker.js'
import { CURRENT_SCHEMA_VERSION } from '../../src/decision/store/schema.js'
import { brokerFixture, insertSnapshot, seedUserDecision, snapshotForRun, validAdd } from './p3-fixtures.js'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('learning input limits fail before the model without truncation or running rows', async t => {
  const cases = await brokerFixture(t)
  for (let index = 0; index < 129; index++) await seedUserDecision(cases, `case-limit-${index}`)
  await assert.rejects(
    cases.broker.learningStart({ sessionId: 'root', agentId: cases.profile.agentId, requestId: 'too-many-cases' }),
    error => error.code === 'LEARNING_INPUT_TOO_LARGE',
  )
  assert.equal(cases.requests.length, 0)
  assert.equal(cases.broker.store.db.prepare('SELECT COUNT(*) AS n FROM learning_runs').get().n, 0)

  const feedback = await brokerFixture(t)
  const source = await seedUserDecision(feedback, 'feedback-limit')
  for (let index = 0; index < 257; index++) {
    await feedback.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: source.caseId, kind: 'comment', payload: { text: `comment ${index}` } })
  }
  await assert.rejects(
    feedback.broker.learningStart({ sessionId: 'root', agentId: feedback.profile.agentId, requestId: 'too-much-feedback' }),
    error => error.code === 'LEARNING_INPUT_TOO_LARGE',
  )
  assert.equal(feedback.requests.length, 0)
  assert.equal(feedback.broker.store.db.prepare('SELECT COUNT(*) AS n FROM learning_runs').get().n, 0)

  const parents = await brokerFixture(t)
  insertSnapshot(parents, 'ms_over_limit', 1, 'published', {
    principles: Array.from({ length: 129 }, (_, index) => ({
      principleId: `pr_${index}`, text: `Principle ${index}`, scope: { workspaces: [parents.workspace] }, sources: [], state: 'retired',
    })),
  })
  await assert.rejects(
    parents.broker.learningStart({ sessionId: 'root', agentId: parents.profile.agentId, requestId: 'too-many-principles' }),
    error => error.code === 'LEARNING_INPUT_TOO_LARGE',
  )
  assert.equal(parents.requests.length, 0)
})

test('candidate operation limit and model failures are bounded and never persist raw model text', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'model-failures')
  f.respond(() => ({ operations: Array.from({ length: 65 }, (_, index) => validAdd(f, [source.caseId], { principleId: `tmp_${index}` })) }))
  const tooLarge = await f.broker.learningStart({ sessionId: 'root', agentId: f.profile.agentId, requestId: 'too-many-operations' })
  assert.equal(tooLarge.outcome, 'failed')
  assert.equal(tooLarge.replay.detail, 'TOO_MANY_OPERATIONS')

  f.respond(() => 'RAW-MODEL-SECRET-not-json')
  const invalid = await f.broker.learningStart({ sessionId: 'root', agentId: f.profile.agentId, requestId: 'invalid-json' })
  assert.equal(invalid.outcome, 'failed')
  assert.equal(invalid.replay.detail, 'INVALID_CANDIDATE_JSON')
  assert.equal(JSON.stringify(f.broker.store.db.prepare('SELECT * FROM learning_runs').all()).includes('RAW-MODEL-SECRET'), false)

  f.respond(() => { throw new Error('UPSTREAM-PRIVATE-TEXT') })
  const modelError = await f.broker.learningStart({ sessionId: 'root', agentId: f.profile.agentId, requestId: 'model-error' })
  assert.equal(modelError.outcome, 'failed')
  assert.equal(modelError.replay.detail, 'MODEL_ERROR')
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 0)

  const timeout = await brokerFixture(t)
  await seedUserDecision(timeout, 'timeout-source')
  timeout.config.decisionAgentLearningTimeoutMs = 5
  timeout.respond(() => new Promise(() => {}))
  const timed = await timeout.broker.learningStart({ sessionId: 'root', agentId: timeout.profile.agentId, requestId: 'timeout' })
  assert.equal(timed.outcome, 'failed')
  assert.equal(timed.replay.detail, 'MODEL_TIMEOUT')

  const unavailable = await brokerFixture(t)
  await seedUserDecision(unavailable, 'route-source')
  await unavailable.broker.profileUpsert({
    agentId: unavailable.profile.agentId, modelRoute: { chain: [{ provider: 'missing', model: 'not-installed' }] },
  })
  const noRoute = await unavailable.broker.learningStart({ sessionId: 'root', agentId: unavailable.profile.agentId, requestId: 'no-route' })
  assert.equal(noRoute.outcome, 'failed')
  assert.equal(noRoute.replay.detail, 'ROUTE_UNAVAILABLE')
  assert.equal(unavailable.requests.length, 0)
})

test('concurrent duplicate delivery shares one persisted running job and late results cannot create a draft', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'concurrent-source')
  const entered = deferred()
  const release = deferred()
  f.respond(async () => {
    entered.resolve()
    await release.promise
    return { operations: [validAdd(f, [source.caseId])] }
  })
  const input = { sessionId: 'root', agentId: f.profile.agentId, requestId: 'req-concurrent' }
  const first = f.broker.learningStart(input)
  await entered.promise
  const running = f.broker.learning.listRuns(f.profile.agentId)
  assert.equal(running.length, 1)
  assert.equal(running[0].outcome, 'running')
  const duplicate = f.broker.learningStart(input)
  await assert.rejects(f.broker.learningStart({ ...input, requestId: 'req-other' }), error => error.code === 'LEARNING_RUN_ACTIVE')
  release.resolve()
  const [left, right] = await Promise.all([first, duplicate])
  assert.deepEqual(left, right)
  assert.equal(left.outcome, 'candidate')
  assert.equal(f.requests.length, 1)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM learning_runs').get().n, 1)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 1)

  const late = await brokerFixture(t)
  const lateSource = await seedUserDecision(late, 'late-source')
  const lateEntered = deferred()
  const lateRelease = deferred()
  late.respond(async () => {
    lateEntered.resolve()
    await lateRelease.promise
    return { operations: [validAdd(late, [lateSource.caseId])] }
  })
  const pending = late.broker.learningStart({ sessionId: 'root', agentId: late.profile.agentId, requestId: 'req-late' })
  await lateEntered.promise
  const runningRow = late.broker.store.db.prepare('SELECT * FROM learning_runs').get()
  await late.broker.store.write(db => {
    db.prepare(`UPDATE learning_runs SET outcome='failed',replay_json=?,revision=revision+1 WHERE learning_run_id=?`)
      .run(JSON.stringify({ passed: false, metrics: { operationCount: 0, sourceCount: 0, activePrincipleCount: 0, retiredPrincipleCount: 0 }, detail: 'INTERRUPTED' }), runningRow.learning_run_id)
  })
  lateRelease.resolve()
  const settled = await pending
  assert.equal(settled.outcome, 'failed')
  assert.equal(settled.replay.detail, 'INTERRUPTED')
  assert.equal(late.broker.store.db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 0)
})

test('flush aborts and awaits a learning job before closing SQLite', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'flush-source')
  const entered = deferred()
  const release = deferred()
  f.respond(async () => {
    entered.resolve()
    await release.promise
    return { operations: [validAdd(f, [source.caseId])] }
  })
  const pending = f.broker.learningStart({ sessionId: 'root', agentId: f.profile.agentId, requestId: 'req-flush' })
  await entered.promise
  const runId = f.broker.learning.listRuns(f.profile.agentId)[0].learningRunId
  let flushed = false
  const flushing = f.broker.flush().then(() => { flushed = true })
  await Promise.resolve()
  assert.equal(flushed, false)
  release.resolve()
  await flushing
  assert.equal((await pending).outcome, 'failed')
  assert.equal(f.broker.store, undefined)

  const restarted = new DecisionBroker({ profileContext: { home: f.dir, name: 'test' }, ctx: f.ctx, config: () => f.config, now: () => 2_000 })
  t.after(() => restarted.flush())
  await restarted.start()
  const recovered = await restarted.learningRun({ sessionId: 'root', learningRunId: runId })
  assert.equal(recovered.outcome, 'failed')
  assert.equal(recovered.replay.detail, 'INTERRUPTED')
  assert.equal(restarted.store.db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 0)
})

test('publish fails closed on stale source or parent and preserves the immutable draft', async t => {
  const staleSource = await brokerFixture(t)
  const source = await seedUserDecision(staleSource, 'stale-source')
  staleSource.respond(() => ({ operations: [validAdd(staleSource, [source.caseId])] }))
  const candidate = await staleSource.broker.learningStart({ sessionId: 'root', agentId: staleSource.profile.agentId, requestId: 'stale-source-run' })
  const snapshotId = snapshotForRun(staleSource, candidate.learningRunId).snapshot_id
  const before = await staleSource.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  await staleSource.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: source.caseId, kind: 'rating_down' })
  await assert.rejects(
    staleSource.broker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: before.revision }),
    error => error.code === 'STALE_SOURCE',
  )
  assert.equal((await staleSource.broker.learningRun({ sessionId: 'root', learningRunId: candidate.learningRunId })).outcome, 'failed')
  const after = await staleSource.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  assert.equal(after.state, 'draft')
  assert.equal(after.contentHash, before.contentHash)
  await assert.rejects(staleSource.broker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: before.revision }))

  const staleParent = await brokerFixture(t)
  const parentSource = await seedUserDecision(staleParent, 'stale-parent-source')
  insertSnapshot(staleParent, 'ms_parent_v1', 1, 'published')
  staleParent.respond(() => ({ operations: [validAdd(staleParent, [parentSource.caseId])] }))
  const parentCandidate = await staleParent.broker.learningStart({ sessionId: 'root', agentId: staleParent.profile.agentId, requestId: 'stale-parent-run' })
  const draftId = snapshotForRun(staleParent, parentCandidate.learningRunId).snapshot_id
  const draft = await staleParent.broker.memorySnapshot({ sessionId: 'root', snapshotId: draftId })
  assert.equal(draft.parentSnapshotId, 'ms_parent_v1')
  insertSnapshot(staleParent, 'ms_parent_v3', 3, 'published', { parentSnapshotId: 'ms_parent_v1' })
  await assert.rejects(
    staleParent.broker.snapshotPublish({ sessionId: 'root', snapshotId: draftId, expectedRevision: draft.revision }),
    error => error.code === 'STALE_PARENT_SNAPSHOT',
  )
  assert.equal((await staleParent.broker.learningRun({ sessionId: 'root', learningRunId: parentCandidate.learningRunId })).outcome, 'failed')
  assert.equal((await staleParent.broker.memorySnapshot({ sessionId: 'root', snapshotId: draftId })).state, 'draft')
})

test('rollback restores the predecessor without mutating either Snapshot content', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'history-source')
  f.respond(() => ({ operations: [validAdd(f, [source.caseId])] }))
  const input = { sessionId: 'root', agentId: f.profile.agentId }
  const firstRun = await f.broker.learningStart({ ...input, requestId: 'history-v1' })
  const firstId = snapshotForRun(f, firstRun.learningRunId).snapshot_id
  const firstDraft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: firstId })
  const first = await f.broker.snapshotPublish({ sessionId: 'root', snapshotId: firstId, expectedRevision: firstDraft.revision })
  const secondRun = await f.broker.learningStart({ ...input, requestId: 'history-v2' })
  const secondId = snapshotForRun(f, secondRun.learningRunId).snapshot_id
  const secondDraft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: secondId })
  assert.equal(secondDraft.parentSnapshotId, firstId)
  const second = await f.broker.snapshotPublish({ sessionId: 'root', snapshotId: secondId, expectedRevision: secondDraft.revision })
  assert.equal((await f.broker.agent(input)).currentSnapshotId, secondId)
  const rolled = await f.broker.snapshotRollback({ sessionId: 'root', snapshotId: secondId, expectedRevision: second.revision })
  assert.equal(rolled.state, 'rolled_back')
  assert.equal(rolled.contentHash, second.contentHash)
  assert.deepEqual(rolled.principles, second.principles)
  assert.equal((await f.broker.agent(input)).currentSnapshotId, firstId)
  const firstAfter = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId: firstId })
  assert.equal(firstAfter.contentHash, first.contentHash)
  assert.deepEqual(firstAfter.principles, first.principles)
  assert.deepEqual(await f.broker.snapshotRollback({ sessionId: 'root', snapshotId: secondId, expectedRevision: second.revision }), rolled)
  await assert.rejects(f.broker.snapshotPublish({ sessionId: 'root', snapshotId: secondId, expectedRevision: rolled.revision }))
})

test('real SQLite reopen preserves committed states and legacy Case Attempt Answer Feedback bytes', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'restart-source')
  await f.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: source.caseId, kind: 'comment', payload: { text: 'Historical comment' } })
  const attempt = await f.broker.attempts.start({
    caseId: source.caseId, agentId: f.profile.agentId, pins: { historical: true }, contextPackHash: 'legacy-hash', packManifest: { legacy: true },
  })
  await f.broker.attempts.finish(attempt.attemptId, { outcome: 'answer', citedEvidenceIds: [] })
  const rows = db => Object.fromEntries(['cases', 'attempts', 'feedback'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  const before = rows(f.broker.store.db)
  f.respond(() => ({ operations: [validAdd(f, [source.caseId])] }))
  const candidate = await f.broker.learningStart({ sessionId: 'root', agentId: f.profile.agentId, requestId: 'restart-committed' })
  const snapshotId = snapshotForRun(f, candidate.learningRunId).snapshot_id
  const draft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  await f.broker.flush()

  const reopen = async now => {
    const broker = new DecisionBroker({ profileContext: { home: f.dir, name: 'test' }, ctx: f.ctx, config: () => f.config, now: () => now })
    await broker.start()
    t.after(() => broker.flush())
    return broker
  }
  const candidateBroker = await reopen(2_000)
  assert.equal((await candidateBroker.learningRun({ sessionId: 'root', learningRunId: candidate.learningRunId })).outcome, 'candidate')
  assert.equal((await candidateBroker.memorySnapshot({ sessionId: 'root', snapshotId })).state, 'draft')
  assert.equal(f.requests.length, 1)
  assert.deepEqual(rows(candidateBroker.store.db), before)
  const published = await candidateBroker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: draft.revision })
  await candidateBroker.flush()

  const publishedBroker = await reopen(3_000)
  assert.equal((await publishedBroker.memorySnapshot({ sessionId: 'root', snapshotId })).state, 'published')
  assert.equal((await publishedBroker.learningRun({ sessionId: 'root', learningRunId: candidate.learningRunId })).outcome, 'published')
  assert.equal(f.requests.length, 1)
  assert.deepEqual(rows(publishedBroker.store.db), before)
  const rolled = await publishedBroker.snapshotRollback({ sessionId: 'root', snapshotId, expectedRevision: published.revision })
  await publishedBroker.flush()

  const rolledBroker = await reopen(4_000)
  assert.equal((await rolledBroker.memorySnapshot({ sessionId: 'root', snapshotId })).state, 'rolled_back')
  assert.equal((await rolledBroker.learningRun({ sessionId: 'root', learningRunId: candidate.learningRunId })).outcome, 'rolled_back')
  assert.equal((await rolledBroker.agent({ sessionId: 'root', agentId: f.profile.agentId })).currentSnapshotId, null)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(rows(rolledBroker.store.db), before)
  assert.equal(rolledBroker.store.db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION)
  assert.equal(rolled.contentHash, published.contentHash)
})

test('revision conflicts and unavailable Agents never rewrite learning history', async t => {
  const f = await brokerFixture(t)
  const source = await seedUserDecision(f, 'availability-source')
  f.respond(() => ({ operations: [validAdd(f, [source.caseId])] }))
  const input = { sessionId: 'root', agentId: f.profile.agentId }
  const run = await f.broker.learningStart({ ...input, requestId: 'availability-run' })
  const snapshotId = snapshotForRun(f, run.learningRunId).snapshot_id
  const draft = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })
  await assert.rejects(
    f.broker.snapshotReject({ sessionId: 'root', snapshotId, expectedRevision: draft.revision + 1 }),
    error => error.code === 'REVISION_CONFLICT',
  )
  assert.equal((await f.broker.learningRun({ sessionId: 'root', learningRunId: run.learningRunId })).outcome, 'candidate')
  const published = await f.broker.snapshotPublish({ sessionId: 'root', snapshotId, expectedRevision: draft.revision })
  await assert.rejects(
    f.broker.snapshotRollback({ sessionId: 'root', snapshotId, expectedRevision: published.revision + 1 }),
    error => error.code === 'REVISION_CONFLICT',
  )
  assert.equal((await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })).state, 'published')
  assert.equal((await f.broker.learningRun({ sessionId: 'root', learningRunId: run.learningRunId })).outcome, 'published')

  await f.broker.profileSetState(f.profile.agentId, 'disabled', f.workspace)
  await assert.rejects(
    f.broker.learningStart({ ...input, requestId: 'disabled-agent' }),
    error => error.code === 'AGENT_UNAVAILABLE',
  )
  f.config.decisionAgentsEnabled = false
  await assert.rejects(
    f.broker.learningStart({ ...input, requestId: 'globally-off' }),
    error => error.code === 'DECISION_OFF',
  )
  assert.equal(f.requests.length, 1)
  const persisted = f.broker.store.db.prepare('SELECT state,principles_json FROM memory_snapshots WHERE snapshot_id=?').get(snapshotId)
  assert.equal(persisted.state, 'published')
  assert.deepEqual(JSON.parse(persisted.principles_json), published.principles)
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM learning_runs').get().n, 1)
})
