// Automatic public candidate extraction on open/refresh (OpenSpec 4.4, 4.7).
//
// A refresh compares the eligible-source high-water mark with the last frozen
// public input. New sources start at most one coalesced public Learning Run
// after a one-time disclosure; a stable high-water mark never calls the model,
// and a candidate is never published automatically.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicAdd, packOf, publicMemoryFixture } from './public-fixtures.js'

/** Answer every public consolidation call with one valid cross-workspace add. */
function crossWorkspaceAdd(count = 1) {
  return (_options, pack) => ({
    operations: [publicAdd(pack.sources.slice(0, count).map(source => source.sourceId), {
      text: 'Prefer the shared documented option', scope: {},
    })],
  })
}

test('a refresh without eligible sources never calls the model or creates a run', async t => {
  const f = await publicMemoryFixture(t)
  const result = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId })
  assert.equal(result.status, 'empty-sources')
  assert.equal(result.agentId, f.profile.agentId)
  assert.equal(result.zone, 'public')
  assert.equal(result.current, null)
  assert.equal(result.candidate, null)
  assert.equal(result.run, null)
  assert.equal(result.disclosure.required, true)
  assert.equal(f.requests.length, 0)
  assert.equal(f.broker.learning.listRuns(f.profile.agentId).filter(run => run.zone === 'public').length, 0)
})

test('the first automatic extraction requires disclosure and sends only whitelisted aliases', async t => {
  const f = await publicMemoryFixture(t)
  const w1 = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'refresh-w1', question: 'W1 EXACT QUESTION' })
  const w2 = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'refresh-w2', question: 'W2 EXACT QUESTION' })
  const expectedHighWater = f.broker.learning.publicSourceSet(f.profile.agentId).highWater

  const gated = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId })
  assert.equal(gated.status, 'disclosure-required')
  assert.equal(gated.disclosure.required, true)
  assert.equal(gated.disclosure.version, 1)
  assert.equal(typeof gated.disclosure.key, 'string')
  assert.equal(gated.workspaceCount, 2)
  assert.equal(gated.sourceCount, 2)
  assert.equal(gated.highWater, expectedHighWater)
  assert.equal(f.requests.length, 0)
  assert.equal(f.broker.learning.listRuns(f.profile.agentId).filter(run => run.zone === 'public').length, 0)

  f.respond(crossWorkspaceAdd(2))
  const started = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(started.status, 'candidate', JSON.stringify(started))
  assert.equal(f.requests.length, 1)
  assert.equal(started.run.outcome, 'candidate')
  assert.equal(started.candidate.state, 'draft')
  assert.equal(started.current, null, 'a candidate is never published automatically')
  assert.equal(started.disclosure.required, false)

  const pack = packOf(f.requests[0])
  assert.equal(pack.zone, 'public')
  assert.equal(pack.agentId, f.profile.agentId)
  assert.deepEqual(pack.workspaceAliases.map(group => group.count).sort(), [1, 1])
  assert.equal(pack.parentSnapshot, null)
  assert.deepEqual(pack.sources.map(source => source.sourceId).sort(), [w1.caseId, w2.caseId].sort())
  const serialized = JSON.stringify(pack)
  for (const workspace of [f.w1, f.w2]) assert.equal(serialized.includes(workspace), false)
  assert.equal(serialized.includes('taskSummary'), false)
  for (const source of pack.sources) assert.ok(source.excerpt.length > 0 && source.excerpt.length <= 600)

  const run = f.broker.learning.getRunById(started.run.learningRunId)
  assert.equal(run.zone, 'public')
  assert.equal(run.outcome, 'candidate')
  assert.equal(run.inputFrozen.sourceHighWater, expectedHighWater)
  assert.deepEqual([...run.inputFrozen.caseIds].sort(), [w1.caseId, w2.caseId].sort())
  assert.equal(f.broker.store.db.prepare('SELECT state FROM memory_snapshots WHERE learning_run_id=?').get(run.learningRunId).state, 'draft')
  assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId), null)
})

test('an unchanged high-water mark never calls the model twice and a pending candidate blocks new runs', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'noop-w1' })
  f.respond(crossWorkspaceAdd())
  const first = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(first.status, 'candidate')
  assert.equal(f.requests.length, 1)

  const repeated = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(repeated.status, 'candidate')
  assert.equal(repeated.run.learningRunId, first.run.learningRunId)
  assert.equal(f.requests.length, 1, 'no new source means no second model call')

  // A new eligible source cannot start a second run while the candidate awaits review.
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'noop-w2' })
  const blocked = await f.broker.publicMemoryRefresh({ sessionId: 'root2', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(blocked.status, 'candidate')
  assert.equal(blocked.run.learningRunId, first.run.learningRunId)
  assert.equal(f.requests.length, 1)
  assert.equal(f.broker.learning.getRunById(first.run.learningRunId).inputFrozen.caseIds.length, 1, 'the frozen input is not extended by later sources')
})

test('after a rejection a genuinely newer source starts exactly one new candidate', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'reject-w1' })
  f.respond(crossWorkspaceAdd())
  const first = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  await f.broker.snapshotReject({ sessionId: 'root1', snapshotId: first.candidate.snapshotId, expectedRevision: first.candidate.revision })

  assert.equal((await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId })).status, 'up-to-date')
  assert.equal(f.requests.length, 1)

  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'reject-w2' })
  const second = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(second.status, 'candidate')
  assert.notEqual(second.run.learningRunId, first.run.learningRunId)
  assert.equal(f.requests.length, 2)
})

test('concurrent refreshes coalesce into one public run and one model call', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'concurrent-w1' })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'concurrent-w2' })
  f.respond(async (_options, pack) => {
    await new Promise(resolve => setTimeout(resolve, 10))
    return { operations: [publicAdd([pack.sources[0].sourceId], { text: 'Coalesced candidate', scope: {} })] }
  })
  const [left, right] = await Promise.all([
    f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true }),
    f.broker.publicMemoryRefresh({ sessionId: 'root2', agentId: f.profile.agentId, acknowledgedDisclosure: true }),
  ])
  assert.equal(f.requests.length, 1)
  assert.equal(left.status, 'candidate')
  assert.equal(right.status, 'candidate')
  assert.equal(left.run.learningRunId, right.run.learningRunId)
  assert.equal(f.broker.learning.listRuns(f.profile.agentId).filter(run => run.zone === 'public').length, 1)
})

test('extraction that does not fit the pinned context budget fails closed without a model call', async t => {
  const f = await publicMemoryFixture(t, { decisionAgentContextBudgetTokens: 200 })
  for (let index = 0; index < 6; index++) {
    await f.seedDecision({ workspaceKey: index % 2 ? f.w2 : f.w1, rootSessionId: index % 2 ? 'root2' : 'root1', key: `budget-${index}`, question: `Budget question ${index} ${'detail '.repeat(80)}` })
  }
  const result = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(result.status, 'failed')
  assert.equal(result.candidate, null)
  assert.equal(f.requests.length, 0)
  assert.equal(f.broker.learning.getRunById(result.run.learningRunId).replay.detail, 'LEARNING_INPUT_TOO_LARGE')
})

test('archived and disabled Agents never start public extraction', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'archive-source' })
  await f.broker.profileSetState(f.profile.agentId, 'disabled')
  await assert.rejects(
    f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true }),
    error => error.code === 'AGENT_UNAVAILABLE',
  )
  await f.broker.profileSetState(f.profile.agentId, 'archived')
  await assert.rejects(
    f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true }),
    error => error.code === 'AGENT_UNAVAILABLE',
  )
  assert.equal(f.requests.length, 0)
  assert.equal(f.broker.learning.listRuns(f.profile.agentId).filter(run => run.zone === 'public').length, 0)
})

test('the published public summary carries the reviewed wording but no provenance', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'summary-w1' })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'summary-w2' })
  f.respond(crossWorkspaceAdd(2))
  const started = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(started.status, 'candidate', JSON.stringify(started))
  const published = await f.broker.snapshotPublish({ sessionId: 'root1', snapshotId: started.candidate.snapshotId, expectedRevision: started.candidate.revision })
  assert.equal(published.state, 'published')
  assert.equal(published.zone, 'public')

  const summary = f.broker.publicMemorySummary(f.profile.agentId)
  assert.equal(summary.current.version, 1)
  assert.equal(summary.current.principles.length, 1)
  const principle = summary.current.principles[0]
  assert.equal(principle.text, 'Prefer the shared documented option')
  assert.deepEqual(principle.scope, {})
  assert.deepEqual(Object.keys(principle).sort(), ['principleId', 'scope', 'text'], 'only reviewed wording and workspace-agnostic hints survive')
  const serialized = JSON.stringify(summary)
  for (const workspace of [f.w1, f.w2]) assert.equal(serialized.includes(workspace), false)
  assert.equal(serialized.includes('"sources"'), false)
})
