import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionAttempts } from '../../src/decision/store/attempts.js'
import { DecisionEvidence } from '../../src/decision/store/evidence.js'
import { DecisionFeedback } from '../../src/decision/store/feedback.js'
import { DecisionProfiles } from '../../src/decision/store/profiles.js'
import { DecisionContextRetriever } from '../../src/decision/retrieval/retriever.js'
import { L2_MEMORY_VERSION, L3_MEMORY_VERSION, readL2Memory, readL3Memory } from '../../src/decision/retrieval/memory.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-retrieval-'))
  let clock = 100
  const now = () => ++clock
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const cases = new DecisionCases(store, { now })
  const attempts = new DecisionAttempts(store, { now })
  const evidence = new DecisionEvidence(store, { now })
  const feedback = new DecisionFeedback(store, { now })
  const profiles = new DecisionProfiles(store, { now })
  const retriever = new DecisionContextRetriever(store, evidence)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  async function add(key, options = {}) {
    const workspaceKey = options.workspaceKey ?? '/repo'
    const agentId = options.agentId ?? 'agent-a'
    const scope = options.scope ?? { workspaces: [workspaceKey] }
    const request = options.request ?? {
      entry: 'hook',
      questions: [{ id: 'q', question: options.question ?? `Question ${key}`, options: [{ label: 'A' }, { label: 'B' }] }],
      ...(options.taskSummary ? { taskSummary: options.taskSummary } : {}),
    }
    let current = (await cases.createCase({
      workspaceKey, rootSessionId: options.rootSessionId ?? 'root', entry: 'hook', agentId,
      request, scope, idempotencyKey: key,
    })).case
    const state = options.state ?? 'answered'
    let attempt
    if (state === 'answered') {
      current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
      if (options.withAttempt) {
        attempt = await attempts.start({
          caseId: current.caseId, agentId,
          pins: { promptVersion: 'evaluator-contract/1', memorySnapshotId: null },
          contextPackHash: `hash-${key}`,
          packManifest: { layerSizes: { L0: 1, L1: 1, L2: 0, L3: 0, L4: 1, L5: 0 }, evidenceIds: [], correctionIds: [], omissions: [] },
        })
        current = cases.getCase(current.caseId)
        attempt = await attempts.finish(attempt.attemptId, { outcome: 'answer', claims: [{ text: 'A', evidenceIds: [] }] })
      }
      const answers = options.answers ?? [{ id: 'q', selected: [options.selected ?? 'A'], ...(options.custom === undefined ? {} : { custom: options.custom }) }]
      current = await cases.transition({
        caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision,
        state: 'closed', closing: 'answered',
        decision: { kind: 'answer', attemptId: attempt?.attemptId ?? `da_${key}`, answers },
      })
    } else if (state === 'user_decision') {
      current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user' })
      current = await cases.transition({
        caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision,
        state: 'closed', closing: 'escalated',
        decision: { kind: 'user_decision', answers: [{ id: 'q', selected: [options.selected ?? 'A'] }] },
      })
    } else if (state === 'awaiting_user') {
      current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'authority' })
    } else if (state === 'awaiting_revision' || state === 'returned' || state === 'failed') {
      current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
      if (state === 'failed') {
        attempt = await attempts.start({ caseId: current.caseId, agentId, pins: {}, contextPackHash: key, packManifest: {} })
        await attempts.finish(attempt.attemptId, { outcome: 'failed', error: { kind: 'model_error' } })
      } else {
        current = await cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_revision' })
        if (state === 'returned') current = await cases.transition({ caseId: current.caseId, expectedState: 'awaiting_revision', expectedRevision: current.revision, state: 'closed', closing: 'returned', decision: { kind: 'return', code: 'MISSING_CONTEXT' } })
      }
    } else if (state === 'cancelled') {
      current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'closed', closing: 'cancelled', decision: { kind: 'cancelled' } })
    }
    if (options.feedback) await feedback.append({ actor: { kind: 'user' }, caseId: current.caseId, kind: options.feedback })
    return { current: cases.getCase(current.caseId), attempt }
  }

  const query = (overrides = {}) => ({
    agentId: 'agent-a', workspaceKey: '/repo', scope: { workspaces: ['/repo'] }, attemptStartedAt: 1_000, ...overrides,
  })
  return { store, cases, attempts, evidence, feedback, profiles, retriever, add, query }
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const nested of Object.values(value)) assertDeepFrozen(nested)
}

test('L2 is a versioned empty read-only adapter and never touches Snapshot or Learning Run', async t => {
  const f = fixture(t)
  const profile = await f.profiles.createProfile({ workspaceKey: '/repo', name: 'A', userDescription: 'User owned' })
  f.store.db.prepare(`INSERT INTO learning_runs(learning_run_id,agent_id,trigger,input_frozen_json,operations_json,outcome,created_at,updated_at)
    VALUES('lr_external','agent-a','external','{}','[]','done',1,1)`).run()
  f.store.db.prepare(`INSERT INTO memory_snapshots(snapshot_id,agent_id,version,state,principles_json,generated_description_json,learning_run_id,created_at,updated_at)
    VALUES('ms_external','agent-a',1,'published','[]','{"text":"EXTERNAL"}','lr_external',1,1)`).run()
  const before = f.profiles.getProfile(profile.agentId)
  const queries = []
  const prepare = f.store.db.prepare.bind(f.store.db)
  f.store.db.prepare = sql => { queries.push(sql); return prepare(sql) }
  const result = readL2Memory(f.store, f.query())
  assert.deepEqual(result, { schemaVersion: L2_MEMORY_VERSION, status: 'empty', snapshotId: null, items: [] })
  assert.deepEqual(queries, [])
  assertDeepFrozen(result)
  assert.deepEqual(f.profiles.getProfile(profile.agentId).generatedDescription, before.generatedDescription)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n, 1)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM learning_runs').get().n, 1)
})

test('L3 is SQL-namespace scoped, answer-first, bounded, stable, and excludes comments and task summaries', async t => {
  const f = fixture(t)
  const eligible = await f.add('eligible', { question: 'SAFE QUESTION', selected: 'Safe answer', taskSummary: 'TASK-SUMMARY-SECRET' })
  await f.feedback.append({ actor: { kind: 'user' }, caseId: eligible.current.caseId, kind: 'comment', payload: { text: 'COMMENT-SECRET' } })
  const otherAgent = await f.add('other-agent', { agentId: 'agent-b', question: 'SAFE QUESTION', selected: 'OTHER-AGENT-SECRET' })
  const otherWorkspace = await f.add('other-workspace', { workspaceKey: '/other', question: 'SAFE QUESTION', selected: 'OTHER-WORKSPACE-SECRET' })
  await f.add('narrow', { scope: { workspaces: ['/repo'], paths: ['src'] }, selected: 'NARROW-SECRET' })
  const long = await f.add('long', { custom: 'x'.repeat(700) })

  const episodes = readL3Memory(f.store, f.query({ excludeCaseId: long.current.caseId }))
  assert.deepEqual(episodes.map(item => item.sourceCaseId), [eligible.current.caseId])
  const episode = episodes[0]
  assert.equal(episode.schemaVersion, L3_MEMORY_VERSION)
  assert.equal(episode.kind, 'neutral_agent_answer')
  assert.equal(episode.sourceRevision, f.cases.getCase(eligible.current.caseId).revision)
  assert.deepEqual(episode.scope, { workspaces: ['/repo'] })
  assert.ok(episode.excerpt.startsWith('Answer q: Safe answer'))
  assert.ok(episode.excerpt.includes('Question q: SAFE QUESTION'))
  for (const secret of ['COMMENT-SECRET', 'TASK-SUMMARY-SECRET', 'OTHER-AGENT-SECRET', 'OTHER-WORKSPACE-SECRET', 'NARROW-SECRET']) assert.equal(episode.excerpt.includes(secret), false)
  assert.deepEqual(readL3Memory(f.store, f.query({ agentId: 'agent-b' })).map(item => item.sourceCaseId), [otherAgent.current.caseId])
  assert.deepEqual(readL3Memory(f.store, f.query({ workspaceKey: '/other', scope: { workspaces: ['/other'] } })).map(item => item.sourceCaseId), [otherWorkspace.current.caseId])

  const bounded = readL3Memory(f.store, f.query({ excludeCaseId: eligible.current.caseId }))
  const longEpisode = bounded.find(item => item.sourceCaseId === long.current.caseId)
  assert.equal(longEpisode.excerpt.length <= 600, true)
  assert.ok(longEpisode.excerpt.startsWith('Answer q: A, x'))

  const second = await f.add('tie-second')
  const first = await f.add('tie-first')
  f.store.db.prepare('UPDATE cases SET created_at=500 WHERE case_id IN (?,?)').run(first.current.caseId, second.current.caseId)
  const ordered = readL3Memory(f.store, f.query()).filter(item => [first.current.caseId, second.current.caseId].includes(item.sourceCaseId)).map(item => item.sourceCaseId)
  assert.deepEqual(ordered, [first.current.caseId, second.current.caseId].sort().reverse())
})

test('L3 admits only complete unrated closed answered agent answers and excludes every other outcome', async t => {
  const f = fixture(t)
  const eligible = await f.add('matrix-eligible')
  const user = await f.add('matrix-user', { state: 'user_decision' })
  const validated = await f.add('matrix-validated', { feedback: 'rating_up' })
  const disputed = await f.add('matrix-disputed', { feedback: 'rating_down' })
  const incomplete = await f.add('matrix-incomplete', { answers: [] })
  await f.add('matrix-pending', { state: 'awaiting_user' })
  await f.add('matrix-revision', { state: 'awaiting_revision' })
  await f.add('matrix-returned', { state: 'returned' })
  await f.add('matrix-cancelled', { state: 'cancelled' })
  await f.add('matrix-failed', { state: 'failed' })
  const deleted = await f.add('matrix-deleted')
  f.store.db.prepare('DELETE FROM cases WHERE case_id=?').run(deleted.current.caseId)

  const result = f.retriever.retrieve(f.query({ excludeCaseId: eligible.current.caseId }))
  assert.deepEqual(result.L3, [])
  const all = f.retriever.retrieve(f.query())
  assert.deepEqual(all.L3.map(item => item.sourceCaseId), [eligible.current.caseId])
  assert.equal(all.L5.some(ref => ref.locator?.caseId === user.current.caseId && ref.source === 'user_decision'), true)
  assert.equal(all.L5.some(ref => ref.locator?.caseId === validated.current.caseId && ref.source === 'agent_record'), true)
  assert.equal(all.L5.some(ref => ref.locator?.caseId === disputed.current.caseId), false)
  assert.equal(all.L5.some(ref => ref.locator?.caseId === incomplete.current.caseId), false)
  assert.equal(all.L3.some(item => item.excerpt.includes('matrix-deleted')), false)
})

test('rating, undo, comment and correction migrate the next retrieval without rewriting old Attempts', async t => {
  const f = fixture(t)
  const source = await f.add('feedback-source', { withAttempt: true, question: 'Feedback question', selected: 'A' })
  const caseId = source.current.caseId
  const rawAttempt = () => JSON.stringify(f.store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(source.attempt.attemptId))
  const beforeAttempt = rawAttempt()
  const layer = () => {
    const result = f.retriever.retrieve(f.query())
    return {
      L3: result.L3.filter(item => item.sourceCaseId === caseId),
      L5: result.L5.filter(ref => ref.locator?.caseId === caseId),
    }
  }
  const initial = layer()
  assert.equal(initial.L3.length, 1)
  assert.equal(initial.L5.length, 0)

  await f.feedback.append({ actor: { kind: 'user' }, caseId, kind: 'comment', payload: { text: 'COMMENT-NEVER-IN-L3' } })
  const commented = layer()
  assert.equal(commented.L3[0].excerpt, initial.L3[0].excerpt)
  assert.equal(commented.L3[0].excerpt.includes('COMMENT-NEVER-IN-L3'), false)

  await f.feedback.append({ actor: { kind: 'user' }, caseId, kind: 'rating_up' })
  assert.equal(layer().L3.length, 0)
  assert.deepEqual(layer().L5.map(ref => ref.source), ['agent_record'])
  await f.feedback.append({ actor: { kind: 'user' }, caseId, kind: 'undo_rating_up' })
  assert.equal(layer().L3.length, 1)
  assert.equal(layer().L5.length, 0)

  await f.feedback.append({ actor: { kind: 'user' }, caseId, kind: 'rating_down' })
  assert.equal(layer().L3.length, 0)
  assert.equal(layer().L5.length, 0)
  await f.feedback.append({ actor: { kind: 'user' }, caseId, kind: 'undo_rating_down' })
  assert.equal(layer().L3.length, 1)
  assert.equal(layer().L5.length, 0)

  const correction = await f.feedback.append({ actor: { kind: 'user' }, caseId, kind: 'correction', payload: { direction: 'Use B instead', scope: { workspaces: ['/repo'] }, supersedes: [caseId] } })
  assert.equal(layer().L3.length, 0)
  f.store.db.prepare('UPDATE corrections SET active=0 WHERE feedback_id=?').run(correction.feedbackId)
  assert.equal(layer().L3.length, 0, 'correction history permanently excludes the superseded answer')
  assert.equal(rawAttempt(), beforeAttempt)
})

test('retrieval is deeply frozen and reproducible with full L5 conflicts, fresh hashes, and id tie-breaks', async t => {
  const f = fixture(t)
  const left = await f.add('conflict-left', { state: 'user_decision', question: 'Same question', selected: 'A' })
  const right = await f.add('conflict-right', { state: 'user_decision', question: 'Same question', selected: 'B' })
  const episode = await f.add('neutral', { question: 'Neutral question', selected: 'A' })
  const observation = await f.evidence.add({
    agentId: 'agent-a', source: 'current_observation', locator: { kind: 'file', path: '/repo/a', hash: 'hash-a' },
    observedAt: 1_000, hash: 'hash-a', scope: { workspaces: ['/repo'] },
  })
  const leftRef = f.evidence.candidates(f.query()).find(ref => ref.locator?.caseId === left.current.caseId)
  const rightRef = f.evidence.candidates(f.query()).find(ref => ref.locator?.caseId === right.current.caseId)
  f.store.db.prepare('UPDATE evidence SET created_at=700 WHERE evidence_id IN (?,?)').run(leftRef.evidenceId, rightRef.evidenceId)

  const first = f.retriever.retrieve(f.query())
  const second = f.retriever.retrieve(f.query())
  assert.deepEqual(first, second)
  assert.equal(first.schemaVersion, 1)
  assert.deepEqual(first.L2, { schemaVersion: 1, status: 'empty', snapshotId: null, items: [] })
  assert.deepEqual(first.L3.map(item => item.sourceCaseId), [episode.current.caseId])
  assert.deepEqual(first.L5.filter(ref => ref.source === 'user_decision').map(ref => ref.evidenceId), [leftRef.evidenceId, rightRef.evidenceId].sort())
  assert.deepEqual(first.conflictPairs, [[leftRef.evidenceId, rightRef.evidenceId].sort()])
  assert.deepEqual(first.currentObservationHashes, { [observation.evidenceId]: 'hash-a' })
  assert.equal(first.L5.some(ref => ref.evidenceId === episode.current.caseId), false)
  assertDeepFrozen(first)
  assert.throws(() => { first.L3[0].excerpt = 'rewrite' }, TypeError)
  assert.throws(() => { first.conflictPairs.push(['x', 'y']) }, TypeError)
})
