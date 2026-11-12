// Host-internal public source extraction port (OpenSpec 4.3).
//
// Eligible Cases, corrections and validated answers from every workspace reach
// the public consolidation input only through a closed field whitelist with
// opaque workspace aliases, bounded redacted excerpts and per-source versions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicSourceHighWater, workspaceAlias } from '../../src/decision/learning/namespace.js'
import { publicMemoryFixture } from './public-fixtures.js'

const SOURCE_FIELDS = ['alias', 'closing', 'createdAt', 'excerpt', 'feedbackState', 'kind', 'revision', 'scope', 'sourceId']

test('public extraction reads eligible sources from both workspaces through the closed whitelist', async t => {
  const f = await publicMemoryFixture(t)
  const w1Decision = await f.seedDecision({
    workspaceKey: f.w1, rootSessionId: 'root1', key: 'w1-source', question: `Question about ${f.w1}/src/index.js`, selected: 'A',
  })
  const w2Decision = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'w2-source', question: 'W2 question', selected: 'B' })
  const w2Validated = await f.seedValidated({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'w2-validated', selected: 'A' })
  const correction = await f.broker.feedbackStore.append({
    actor: { kind: 'user' }, caseId: w2Decision.caseId, kind: 'correction',
    payload: { direction: 'Prefer B for this question', scope: { workspaces: [f.w2] }, supersedes: [] },
  })

  const set = f.broker.learning.publicSourceSet(f.profile.agentId)
  assert.deepEqual(set.sources.map(source => source.sourceId).sort(), [w1Decision.caseId, w2Decision.caseId, w2Validated.caseId, correction.feedbackId].sort())
  for (const source of set.sources) {
    assert.deepEqual(Object.keys(source).sort(), SOURCE_FIELDS)
    assert.ok(['case', 'correction'].includes(source.kind))
    assert.equal(source.alias, workspaceAlias(source.sourceId === correction.feedbackId || source.sourceId === w2Decision.caseId || source.sourceId === w2Validated.caseId ? f.w2 : f.w1))
    assert.ok(Number.isSafeInteger(source.revision) && source.revision >= 1)
    assert.ok(source.excerpt.length > 0 && source.excerpt.length <= 600)
    assert.equal('workspaces' in source.scope, false)
    assert.equal('workspaceKey' in source.scope, false)
  }
  // Neither real workspace path nor the raw request/decision JSON reaches the projection.
  const serialized = JSON.stringify(set.sources)
  for (const workspace of [f.w1, f.w2]) assert.equal(serialized.includes(workspace), false)
  for (const key of ['request', 'decision', 'taskSummary', 'payload', 'request_json', 'decision_json']) assert.equal(serialized.includes(key), false)
  // The absolute path inside a frozen question is redacted, not forwarded verbatim.
  const w1Source = set.sources.find(source => source.sourceId === w1Decision.caseId)
  assert.equal(w1Source.excerpt.includes(f.w1), false)
  assert.ok(w1Source.excerpt.includes('<path>'))

  assert.deepEqual(set.workspaces.map(group => group.alias).sort(), [workspaceAlias(f.w1), workspaceAlias(f.w2)].sort())
  assert.deepEqual(Object.fromEntries(set.workspaces.map(group => [group.alias, group.count])), {
    [workspaceAlias(f.w1)]: 1, [workspaceAlias(f.w2)]: 3,
  })
  for (const workspace of [f.w1, f.w2]) assert.equal(JSON.stringify(set.workspaces).includes(workspace), false)
  // Host-internal lineage stays available for origin-workspace revalidation.
  assert.equal(set.sourceWorkspaces[w2Decision.caseId], f.w2)
  assert.equal(set.sourceWorkspaces[correction.feedbackId], f.w2)
  assert.equal(set.revisions[w1Decision.caseId], w1Decision.revision)
  assert.equal(set.highWater, publicSourceHighWater(set.sources))
})

test('public extraction excludes ineligible, disputed, foreign-Agent and unvalidated sources', async t => {
  const f = await publicMemoryFixture(t)
  const foreign = await f.broker.profileUpsert({ workspaceKey: f.w2, name: 'Other', userDescription: 'Other assistant' })
  const eligible = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'eligible' })
  const pending = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'pending', state: 'awaiting_user' })
  await f.seedValidated({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'unrated', rate: false })
  const disputed = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'disputed' })
  await f.dispute(disputed.caseId)
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'foreign', agentId: foreign.agentId })
  const comment = await f.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: eligible.caseId, kind: 'comment', payload: { text: 'A comment is not authority' } })
  const unratedCase = f.broker.store.db.prepare('SELECT case_id FROM cases WHERE idempotency_key=?').get('unrated')

  const set = f.broker.learning.publicSourceSet(f.profile.agentId)
  const ids = set.sources.map(source => source.sourceId)
  assert.deepEqual(ids, [eligible.caseId])
  assert.equal(ids.includes(pending.caseId), false)
  assert.equal(ids.includes(disputed.caseId), false)
  assert.equal(ids.includes(unratedCase.case_id), false)
  assert.equal(ids.includes(comment.feedbackId), false)
  assert.equal(JSON.stringify(set.sources).includes(foreign.agentId), false)
})

test('the public high-water mark tracks eligible additions and revisions only', async t => {
  const f = await publicMemoryFixture(t)
  const agentId = f.profile.agentId
  const first = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'highwater-1' })
  const initial = f.broker.learning.publicSourceSet(agentId)
  assert.deepEqual(f.broker.learning.publicSourceSet(agentId), initial)
  assert.equal(f.broker.learning.lastPublicHighWater(agentId), null)

  // A new eligible source in the second workspace changes the high-water mark.
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'highwater-2' })
  const grown = f.broker.learning.publicSourceSet(agentId)
  assert.notEqual(grown.highWater, initial.highWater)

  // A comment revision on an included source changes it again; an ineligible
  // pending Case does not.
  await f.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: first.caseId, kind: 'comment', payload: { text: 'Bounded note' } })
  const revised = f.broker.learning.publicSourceSet(agentId)
  assert.notEqual(revised.highWater, grown.highWater)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'highwater-pending', state: 'awaiting_user' })
  assert.equal(f.broker.learning.publicSourceSet(agentId).highWater, revised.highWater)
})
