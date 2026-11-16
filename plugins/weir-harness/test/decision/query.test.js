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
import { DecisionQuery } from '../../src/decision/store/query.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-query-'))
  let clock = 1_000
  const now = () => ++clock
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const cases = new DecisionCases(store, { now })
  const attempts = new DecisionAttempts(store, { now })
  const evidence = new DecisionEvidence(store, { now })
  const feedback = new DecisionFeedback(store, { now })
  const query = new DecisionQuery(store, { now })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  async function add(key, options = {}) {
    const agentId = options.agentId ?? 'agent-a'
    const rootSessionId = options.rootSessionId ?? 'root'
    const scope = options.scope ?? { workspaces: ['/repo'], paths: ['src'] }
    let current = (await cases.createCase({
      workspaceKey: '/repo', rootSessionId, entry: 'hook', agentId,
      request: { questions: [{ id: 'q', question: `question-${key}` }] }, scope,
      idempotencyKey: key,
    })).case
    const state = options.state ?? 'answered'
    let attempt
    if (['answered', 'returned', 'awaiting_revision'].includes(state)) {
      current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
      attempt = await attempts.start({ caseId: current.caseId, agentId, pins: {}, contextPackHash: key, packManifest: {} })
      current = cases.getCase(current.caseId)
      if (state === 'answered') {
        attempt = await attempts.finish(attempt.attemptId, { outcome: 'answer', claims: [{ text: 'A', evidenceIds: [] }] })
        current = await cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'closed', closing: 'answered', decision: { kind: 'answer', attemptId: attempt.attemptId, answers: [{ id: 'q', selected: ['A'] }] } })
      } else {
        const code = options.reasonCode ?? 'MISSING_CONTEXT'
        attempt = await attempts.finish(attempt.attemptId, { outcome: 'return', reasonCode: code, hint: 'Add context' })
        current = await cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_revision' })
        if (state === 'returned') current = await cases.transition({ caseId: current.caseId, expectedState: 'awaiting_revision', expectedRevision: current.revision, state: 'closed', closing: 'returned', decision: { kind: 'return', attemptId: attempt.attemptId, code, hint: 'Add context' } })
      }
    } else if (state === 'awaiting_user') {
      attempt = await attempts.start({ caseId: current.caseId, agentId, pins: {}, contextPackHash: key, packManifest: {} })
      current = cases.getCase(current.caseId)
      attempt = await attempts.finish(attempt.attemptId, { outcome: options.outcome ?? 'escalate' })
      current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: options.awaitingReason ?? 'authority' })
    } else if (state === 'escalated') {
      current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'authority' })
      current = await cases.transition({ caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision, state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers: [{ id: 'q', selected: ['A'] }] } })
    } else if (state === 'cancelled') {
      current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'closed', closing: 'cancelled', decision: { kind: 'cancelled' } })
    }
    return { current, attempt }
  }
  return { store, cases, attempts, evidence, feedback, query, add, now }
}

test('records filter all six dimensions and paginate without duplicates', async t => {
  const { query, feedback, add } = await fixture(t)
  const first = await add('one', { state: 'answered' })
  const second = await add('two', { state: 'awaiting_user', outcome: 'escalate', scope: { workspaces: ['/repo'], paths: ['docs'] } })
  const third = await add('three', { state: 'returned', agentId: 'agent-b', reasonCode: 'OUT_OF_SCOPE' })
  await add('four', { state: 'answered' })
  await feedback.append({ actor: { kind: 'user' }, caseId: first.current.caseId, kind: 'rating_up' })
  await feedback.append({ actor: { kind: 'user' }, caseId: second.current.caseId, kind: 'rating_down' })

  const cases = (filter = {}) => query.records({ sessionId: 'root', filter }).records.map(row => row.caseId)
  assert.deepEqual(cases({ agentId: 'agent-b' }), [third.current.caseId])
  assert.deepEqual(cases({ state: 'awaiting_user' }), [second.current.caseId])
  assert.deepEqual(cases({ outcome: 'escalate' }), [second.current.caseId])
  assert.deepEqual(cases({ reasonCode: 'OUT_OF_SCOPE' }), [third.current.caseId])
  assert.deepEqual(cases({ scope: { workspaces: ['/repo'], paths: ['docs'] } }), [second.current.caseId])
  assert.deepEqual(cases({ feedbackState: 'validated' }), [first.current.caseId])
  assert.throws(() => cases({ workspaceKey: '/repo' }), error => error.code === 'INVALID_RECORD_FILTER')

  const page1 = query.records({ sessionId: 'root', cursor: { limit: 2 } })
  assert.equal(page1.records.length, 2)
  assert.ok(page1.nextCursor)
  const page2 = query.records({ sessionId: 'root', cursor: { after: page1.nextCursor, limit: 2 } })
  assert.equal(page2.records.length, 2)
  assert.equal(page2.nextCursor, null)
  assert.equal(new Set([...page1.records, ...page2.records].map(row => row.caseId)).size, 4)
  assert.deepEqual(query.records({ sessionId: 'other' }).records, [])
})
test('return reason filter includes awaiting_revision Attempts as well as closed returned Cases', async t => {
  const { query, add } = await fixture(t)
  const pending = await add('pending-return', { state: 'awaiting_revision', reasonCode: 'STALE_EVIDENCE' })
  const closed = await add('closed-return', { state: 'returned', reasonCode: 'MISSING_CONTEXT' })
  await add('not-a-return', { state: 'answered' })
  assert.deepEqual(query.records({ sessionId: 'root', filter: { reasonCode: 'STALE_EVIDENCE' } }).records.map(row => row.caseId), [pending.current.caseId])
  assert.deepEqual(query.records({ sessionId: 'root', filter: { reasonCode: 'MISSING_CONTEXT' } }).records.map(row => row.caseId), [closed.current.caseId])
})

test('record is a deeply frozen projection of Case, Attempts, Evidence, Feedback and RouteDecision', async t => {
  const { cases, query, evidence, feedback, add } = await fixture(t)
  const { current, attempt } = await add('detail', { state: 'answered' })
  const ref = await evidence.add({ agentId: 'agent-a', source: 'agent_record', locator: { kind: 'case', caseId: current.caseId }, scope: current.scope })
  await evidence.attach(attempt.attemptId, [ref.evidenceId])
  await feedback.append({ actor: { kind: 'user' }, caseId: current.caseId, kind: 'comment', payload: { text: 'nuance' } })
  await cases.recordRoute({ caseId: current.caseId, rootSessionId: 'root', mode: 'pinned', chosen: 'agent-a', reason: 'Pinned' })

  const detail = query.record({ caseId: current.caseId })
  assert.equal(detail.case.caseId, current.caseId)
  assert.equal(detail.attempts[0].attemptId, attempt.attemptId)
  assert.deepEqual(detail.attempts[0].evidence.map(row => row.evidenceId), [ref.evidenceId])
  assert.equal(detail.feedback[0].kind, 'comment')
  assert.equal(detail.routeDecisions[0].mode, 'pinned')
  for (const value of [detail, detail.case, detail.attempts, detail.attempts[0], detail.attempts[0].evidence, detail.feedback, detail.routeDecisions]) {
    assert.equal(Object.isFrozen(value), true)
  }
  assert.throws(() => { detail.case.state = 'received' }, TypeError)
  assert.throws(() => { detail.attempts[0].evidence[0].excerpt = 'rewrite' }, TypeError)
  assert.equal(query.record({ sessionId: 'other', caseId: current.caseId }), null)
})

test('inbox is every awaiting_user Case in the profile, newest first, with no session filter', async t => {
  const { query, store, add } = await fixture(t)
  assert.deepEqual(query.inbox(), [])
  const waiting = await add('waiting', { state: 'awaiting_user' })
  await add('answered', { state: 'answered' })
  const otherRoot = await add('other-root', { state: 'awaiting_user', rootSessionId: 'other' })
  await add('awaiting-revision', { state: 'awaiting_revision' })
  const rows = query.inbox()
  // Another root session and workspace is included: the user surface is profile-level.
  assert.deepEqual(rows.map(row => row.caseId), [otherRoot.current.caseId, waiting.current.caseId])
  // A caller-named session cannot narrow the profile read.
  assert.deepEqual(query.inbox().map(row => row.caseId), [otherRoot.current.caseId, waiting.current.caseId])
  // Same timestamp falls back to case_id DESC so the order stays total.
  store.db.prepare('UPDATE cases SET updated_at=? WHERE case_id IN (?,?,?)').run(9_999, waiting.current.caseId, otherRoot.current.caseId, 'nothing')
  assert.deepEqual(query.inbox().map(row => row.caseId), [waiting.current.caseId, otherRoot.current.caseId].sort().reverse())
  // The projection trims routing internals: status is a bounded enum, never the reason text.
  const [first] = query.inbox()
  assert.equal(Object.hasOwn(first, 'reason'), false)
  assert.equal(Object.hasOwn(first, 'ambiguity'), false)
  assert.equal(typeof first.rootSessionId, 'string')
  assert.equal(typeof first.updatedAt, 'number')
  assert.equal(typeof first.agentId, 'string')
})

test('inbox projects the latest non-Shadow RouteDecision status as a bounded enum', async t => {
  const { cases, query, add } = await fixture(t)
  const failed = await add('inbox-failure', { state: 'awaiting_user', awaitingReason: 'no_route' })
  const ambiguous = await add('inbox-ambiguous', { state: 'awaiting_user', awaitingReason: 'route_ambiguous' })
  const none = await add('inbox-none', { state: 'awaiting_user', awaitingReason: 'no_route' })
  const bare = await add('inbox-bare', { state: 'awaiting_user', awaitingReason: 'authority' })
  const record = async (current, routes) => {
    for (const route of routes) await cases.recordRoute({ caseId: current.current.caseId, rootSessionId: 'root', ...route })
  }
  await record(failed, [
    { mode: 'auto', candidates: [], reason: 'failure:timeout' },
    { mode: 'auto_shadow', candidates: [], reason: 'failure:truncated' },
    { mode: 'auto', candidates: [], reason: 'failure:truncated' },
  ])
  await record(ambiguous, [{ mode: 'auto', candidates: [], reason: 'Overlap', ambiguity: { candidates: ['agent-a'], conflict: 'Both claim it' } }])
  await record(none, [{ mode: 'auto', candidates: [{ agentId: 'agent-a', enabled: true, rejectedBecause: 'scope' }], reason: 'none:no_candidates' }])
  await record(bare, [{ mode: 'manual_reassign', candidates: [{ agentId: 'agent-a', enabled: true }], chosen: 'agent-a', reason: '' }])

  const statuses = Object.fromEntries(query.inbox().map(row => [row.caseId, row.routeStatus ?? null]))
  // The latest non-Shadow decision wins; the Shadow sample never overrides it.
  assert.equal(statuses[failed.current.caseId], 'failure')
  assert.equal(statuses[ambiguous.current.caseId], 'ambiguous')
  assert.equal(statuses[none.current.caseId], 'none')
  assert.equal(statuses[bare.current.caseId], 'selected')
  // A Case without a readable RouteDecision carries no invented status.
  const undecided = await add('inbox-undecided', { state: 'awaiting_user', awaitingReason: 'no_route' })
  const rows = query.inbox()
  assert.equal('routeStatus' in rows.find(row => row.caseId === undecided.current.caseId), false)
  // Records and other reads keep their existing shape: the enum is inbox-only.
  assert.equal('routeStatus' in query.record({ caseId: failed.current.caseId, sessionId: 'root' }).case, false)
})

test('metrics rebuild exclusively from authoritative rows after counters disappear', async t => {
  const { store, cases, query, feedback, add } = await fixture(t)
  const answered = await add('metric-answer', { state: 'answered' })
  await add('metric-return', { state: 'returned', reasonCode: 'STALE_EVIDENCE' })
  const escalated = await add('metric-escalated', { state: 'escalated' })
  await add('metric-cancelled', { state: 'cancelled' })
  await add('metric-exhausted', { state: 'awaiting_user', outcome: 'failed', awaitingReason: 'exhausted' })
  await feedback.append({ actor: { kind: 'user' }, caseId: answered.current.caseId, kind: 'rating_up' })
  await feedback.append({ actor: { kind: 'user' }, caseId: escalated.current.caseId, kind: 'rating_down' })
  await feedback.append({ actor: { kind: 'user' }, caseId: escalated.current.caseId, kind: 'undo_rating_down' })
  await feedback.append({ actor: { kind: 'user' }, caseId: escalated.current.caseId, kind: 'correction', payload: { direction: 'Use B', scope: { workspaces: ['/repo'] }, supersedes: [] } })
  await cases.recordRoute({ caseId: escalated.current.caseId, rootSessionId: 'root', mode: 'manual_reassign', chosen: 'agent-b', reason: 'User reassigned' })

  await query.rebuildMetrics({ sessionId: 'root', window: 'all' })
  const before = query.metrics({ sessionId: 'root', window: 'all' })
  assert.equal(before.casesOpened, 5)
  assert.equal(before.autoAnswered, 1)
  assert.equal(before.returnedByCode.STALE_EVIDENCE, 1)
  assert.equal(before.escalated, 1)
  assert.equal(before.exhausted, 1)
  assert.equal(before.cancelled, 1)
  assert.deepEqual(before.ratings, { up: 1, down: 1, undone: 1 })
  assert.equal(before.corrections, 1)
  assert.equal(before.reassignments, 1)
  assert.equal(before.feedbackParticipation, 2)
  assert.ok(before.meanAttemptLatencyMs >= 0)
  assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM metrics_counters').get().n > 0)

  store.db.prepare('DELETE FROM metrics_counters').run()
  assert.deepEqual(query.metrics({ sessionId: 'root', window: 'all' }), before)
  await query.rebuildMetrics({ sessionId: 'root', window: 'all' })
  assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM metrics_counters').get().n > 0)
  assert.equal(query.metrics({ sessionId: 'root', window: '24h' }).casesOpened, 5)
  assert.equal(query.metrics({ sessionId: 'root', window: 'unknown' }), null)
})

test('startup sweep deletes only old unreviewed closed history and stores a body-free count', async t => {
  const { store, query, feedback, add } = await fixture(t)
  const deleted = await add('sweep-delete', { state: 'returned' })
  const userDecision = await add('sweep-user', { state: 'escalated' })
  const commented = await add('sweep-comment', { state: 'returned' })
  const rated = await add('sweep-rated', { state: 'answered' })
  const recent = await add('sweep-recent', { state: 'returned' })
  await feedback.append({ actor: { kind: 'user' }, caseId: commented.current.caseId, kind: 'comment', payload: { text: 'private question context' } })
  await feedback.append({ actor: { kind: 'user' }, caseId: rated.current.caseId, kind: 'rating_down' })
  const protectedAttempts = store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n
  const at = 2 * 24 * 60 * 60 * 1000 + query.now()
  store.db.prepare('UPDATE cases SET updated_at=? WHERE case_id IN (?,?,?,?)').run(1, deleted.current.caseId, userDecision.current.caseId, commented.current.caseId, rated.current.caseId)
  store.db.prepare('UPDATE cases SET updated_at=? WHERE case_id=?').run(at, recent.current.caseId)

  assert.deepEqual(await query.sweep(0), { deletedCases: 0, retainedCases: 5 })
  const result = await query.sweep(1, { at })
  assert.equal(result.deletedCases, 1)
  assert.equal(query.record({ caseId: deleted.current.caseId }), null)
  for (const kept of [userDecision, commented, rated, recent]) assert.ok(query.record({ caseId: kept.current.caseId }))
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, protectedAttempts - 1)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM route_decisions WHERE case_id=?").get(deleted.current.caseId).n, 0)
  const tombstone = store.db.prepare("SELECT value FROM meta WHERE key='deleted_cases'").get().value
  assert.equal(tombstone, '1')
  assert.ok(!tombstone.includes('sweep-delete'))
  assert.ok(!tombstone.includes('private question context'))
})

// The judgment history is the profile-level user surface (OpenSpec
// decision-records-profile-history D1): no session means every root session of
// this profile, and `filter.sessionId` picks one source root session.
test('records reads every root session until a session or source filter narrows it', async t => {
  const { query, add } = await fixture(t)
  const mine = await add('mine', { state: 'answered' })
  const other = await add('other-root', { state: 'answered', rootSessionId: 'other' })
  // No session named: the whole profile, whichever root session opened each Case.
  assert.deepEqual(query.records({}).records.map(row => row.caseId).sort(), [mine.current.caseId, other.current.caseId].sort())
  // A named session still narrows to that root — the export and the internal
  // readers keep their scope — and the source filter picks one root session.
  assert.deepEqual(query.records({ sessionId: 'root' }).records.map(row => row.caseId), [mine.current.caseId])
  assert.deepEqual(query.records({ filter: { sessionId: 'other' } }).records.map(row => row.caseId), [other.current.caseId])
  // Naming both is the intersection, never a widened read.
  assert.deepEqual(query.records({ sessionId: 'root', filter: { sessionId: 'other' } }).records, [])
  assert.deepEqual(query.records({ filter: { sessionId: 'missing-root' } }).records, [])
  assert.throws(() => query.records({ filter: { sessionId: '' } }), error => error.code === 'INVALID_RECORD_FILTER')
  assert.throws(() => query.records({ sessionId: '' }), error => error.code === 'INVALID_SESSION')
  // Pagination and the other filters live on top of the same read.
  const first = query.records({ filter: { state: 'closed' }, cursor: { limit: 1 } })
  assert.equal(first.records.length, 1)
  assert.ok(first.nextCursor)
  assert.equal(query.records({ filter: { state: 'closed' }, cursor: { after: first.nextCursor, limit: 1 } }).records.length, 1)
})

test('recordSources counts the Cases of each root session, newest first and bounded', async t => {
  const { store, query, add } = await fixture(t)
  assert.deepEqual(query.recordSources(), [])
  await add('source-a1', { state: 'answered' })
  await add('source-a2', { state: 'answered' })
  await add('source-b1', { state: 'returned', rootSessionId: 'root-b' })
  await add('source-c1', { state: 'cancelled', rootSessionId: 'root-c' })
  store.db.prepare('UPDATE cases SET updated_at=? WHERE root_session_id=?').run(9_000, 'root')
  store.db.prepare('UPDATE cases SET updated_at=? WHERE root_session_id=?').run(5_000, 'root-b')
  store.db.prepare('UPDATE cases SET updated_at=? WHERE root_session_id=?').run(1_000, 'root-c')
  // Newest update first, with the real Case count of each root session.
  assert.deepEqual(query.recordSources(), [
    { sessionId: 'root', count: 2, lastAt: 9_000 },
    { sessionId: 'root-b', count: 1, lastAt: 5_000 },
    { sessionId: 'root-c', count: 1, lastAt: 1_000 },
  ])
  assert.equal(Object.isFrozen(query.recordSources()), true)
  // The menu is bounded: more sources exist than it offers.
  for (let index = 0; index < 55; index++) await add(`source-bulk-${index}`, { state: 'cancelled', rootSessionId: `bulk-root-${index}` })
  const sources = query.recordSources()
  assert.equal(sources.length, 50)
  assert.equal(sources.some(source => source.sessionId === 'root-c'), false)
})
