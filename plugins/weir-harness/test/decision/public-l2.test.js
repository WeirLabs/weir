// Dual L2: public guidance and current-workspace experience (OpenSpec 5.1, 5.2, 4.7).
//
// A public principle may enter L2 without its sources being in the current
// workspace L5, but it is never an Evidence Ref: it cannot satisfy G1, prove
// scope, settle G4/G5/G6 or authorize an answer. Private principles keep the
// rule that every source must expand to a current-workspace L5 ref.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attemptOf } from '../../src/decision/store/attempts.js'
import { insertSnapshot } from './p3-fixtures.js'
import { packOf, publicAdd, publicMemoryFixture } from './public-fixtures.js'

const QUESTION = { id: 'q', question: 'Which option now?', options: [{ label: 'A' }, { label: 'B' }] }

async function publishPublicCandidate(f, { paths, sessionId = 'root1' } = {}) {
  f.respond((_options, pack) => ({
    operations: [publicAdd(pack.sources.map(source => source.sourceId), {
      text: 'Prefer the option both workspaces agreed on',
      scope: paths ? { paths: [...paths] } : {},
    })],
  }))
  const refreshed = await f.broker.publicMemoryRefresh({ sessionId, agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(refreshed.status, 'candidate', JSON.stringify(refreshed))
  return f.broker.snapshotPublish({ sessionId, snapshotId: refreshed.candidate.snapshotId, expectedRevision: refreshed.candidate.revision })
}

async function seedPrivateSnapshot(f, source, scope = { workspaces: [f.w1] }) {
  insertSnapshot(f, 'ms_private_w1', 1, 'published', {
    principles: [{ principleId: 'pr_private_w1', text: 'W1 reviewed local principle', scope, sources: [source.caseId], state: 'active' }],
  })
}

test('an Attempt pins private and public Snapshots separately and never turns public guidance into evidence', async t => {
  const f = await publicMemoryFixture(t)
  const w1Source = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'l2-w1' })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'l2-w2' })
  await seedPrivateSnapshot(f, w1Source)
  const published = await publishPublicCandidate(f)
  assert.deepEqual(published.principles[0].scope, {}, 'a public principle has no workspace membership')
  await f.broker.setSelector('root1', 'agent', f.profile.agentId)

  const retrieval = f.broker.retriever.retrieve({
    agentId: f.profile.agentId, workspaceKey: f.w1, scope: { workspaces: [f.w1] }, attemptStartedAt: 1_000, agentState: 'enabled',
  })
  assert.equal(retrieval.L2.snapshotId, 'ms_private_w1')
  assert.deepEqual(retrieval.L2.items.map(item => item.principleId), ['pr_private_w1'])
  assert.equal(retrieval.L2_PUBLIC.snapshotId, published.snapshotId)
  assert.equal(retrieval.L2_PUBLIC.zone, 'public')
  assert.deepEqual(retrieval.L2_PUBLIC.items.map(item => item.principleId), [published.principles[0].principleId])
  const publicItem = retrieval.L2_PUBLIC.items[0]
  assert.equal(publicItem.zone, 'public')
  assert.deepEqual(publicItem.evidenceIds, [])
  assert.equal(publicItem.sources.every(alias => /^origin_[a-f0-9]{12}$/.test(alias)), true)
  assert.equal(JSON.stringify(retrieval.L2_PUBLIC).includes(w1Source.caseId), false)

  let verdict
  f.respond((_options, pack) => {
    verdict = pack
    return {
      outcome: 'answer',
      claims: [{ text: 'The current workspace evidence decides this.', evidenceIds: [pack.L5[0].evidenceId] }],
      answers: [{ id: 'q', selected: ['A'] }],
    }
  })
  const hook = await f.broker.hook({ agent: f.agents.root1, request: { questions: [QUESTION] } })
  assert.equal(hook.kind, 'answer')
  assert.ok(verdict.L2.some(item => item.principleId === retrieval.L2_PUBLIC.items[0].principleId), 'public guidance reaches the model')
  assert.equal(verdict.L5.some(ref => ref.locator?.caseId === w1Source.caseId), true)

  const attempt = f.broker.attempts.forCase(hook.caseId)[0]
  assert.equal(attempt.pins.memorySnapshotId, 'ms_private_w1')
  assert.equal(attempt.pins.publicMemorySnapshotId, published.snapshotId)
  assert.equal(attempt.pins.publicMemorySnapshotRevision, published.revision)
  assert.match(attempt.pins.publicMemorySnapshotHash, /^[a-f0-9]{64}$/)
  assert.equal(attempt.packManifest.memory.L2.zone, 'workspace')
  assert.equal(attempt.packManifest.memory.publicL2.zone, 'public')
  assert.deepEqual(attempt.packManifest.memory.L2.principleIds, ['pr_private_w1'])
  assert.deepEqual(attempt.packManifest.memory.publicL2.principleIds, [published.principles[0].principleId])
  for (const alias of publicItem.sources) assert.equal(attempt.packManifest.evidenceIds.includes(alias), false)
  assert.equal(attempt.packManifest.evidenceIds.some(id => id.startsWith('ev_')), true)
  assert.equal(f.broker.evidence.forAttempt(attempt.attemptId).some(ref => ref.evidenceId === publicItem.sources[0]), false)
})

test('public guidance alone cannot answer and citing it is a structural failure', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'only-public-w1' })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'only-public-w2' })
  const published = await publishPublicCandidate(f)
  await f.broker.setSelector('root3', 'agent', f.profile.agentId)

  const retrieval = f.broker.retriever.retrieve({
    agentId: f.profile.agentId, workspaceKey: f.w3, scope: { workspaces: [f.w3] }, attemptStartedAt: 1_000, agentState: 'enabled',
  })
  assert.deepEqual(retrieval.L5, [])
  assert.equal(retrieval.L2.status, 'empty')
  assert.equal(retrieval.L2_PUBLIC.status, 'populated')

  f.respond((_options, pack) => {
    // Only the workspace-bound profile ref may appear; no foreign or public source.
    assert.equal(pack.L5.every(ref => ref.source === 'user_profile'), true)
    assert.equal(JSON.stringify(pack).includes(published.principles[0].principleId), true)
    return { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'The current workspace has no eligible evidence.' }
  })
  const returned = await f.broker.hook({ agent: f.agents.root3, request: { questions: [QUESTION] } })
  assert.equal(returned.kind, 'pass')
  assert.equal(returned.code, 'MISSING_CONTEXT')
  const attempt = f.broker.attempts.forCase(returned.caseId).at(-1)
  assert.equal(attempt.outcome, 'return')
  assert.equal(attempt.pins.publicMemorySnapshotId, published.snapshotId)
  assert.deepEqual(attempt.packManifest.memory.publicL2.principleIds, [published.principles[0].principleId])
  assert.equal(attempt.packManifest.evidenceIds.includes(published.principles[0].principleId), false)
  const manifestJson = JSON.stringify(attempt.packManifest)
  assert.equal(manifestJson.includes('dc_'), false, 'public source mappings stay opaque aliases')
  for (const workspace of [f.w1, f.w2, f.w3]) assert.equal(manifestJson.includes(workspace), false)
  assert.deepEqual(attempt.packManifest.memory.publicL2.items[0].sources.every(alias => /^origin_[a-f0-9]{12}$/.test(alias)), true)

  // Citing the public principle id as a decisive basis is rejected before any gate.
  f.respond(() => ({
    outcome: 'answer',
    claims: [{ text: 'Trust the public principle', evidenceIds: [published.principles[0].principleId] }],
    answers: [{ id: 'q', selected: ['A'] }],
  }))
  const cited = await f.broker.hook({ agent: f.agents.root3, request: { questions: [{ ...QUESTION, question: 'Which option now, citing guidance?' }] } })
  assert.equal(cited.kind, 'pass')
  assert.equal(cited.why, 'awaiting_user')
  const failed = f.broker.attempts.forCase(cited.caseId).at(-1)
  assert.equal(failed.outcome, 'failed')
  assert.equal(failed.error.kind, 'invalid_output')
})

test('use-time revalidation omits a public principle with a recorded reason while keeping the pin', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'revalidate-w1' })
  const w2 = await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'revalidate-w2' })
  const published = await publishPublicCandidate(f)
  const input = { agentId: f.profile.agentId, workspaceKey: f.w3, scope: { workspaces: [f.w3] }, attemptStartedAt: 1_000, agentState: 'enabled' }
  assert.equal(f.broker.retriever.retrieve(input).L2_PUBLIC.status, 'populated')

  await f.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: w2.caseId, kind: 'comment', payload: { text: 'Bounded later note' } })
  const stale = f.broker.retriever.retrieve(input)
  assert.equal(stale.L2_PUBLIC.status, 'empty')
  assert.equal(stale.L2_PUBLIC.snapshotId, published.snapshotId)
  assert.deepEqual(stale.L2_PUBLIC.exclusions, [{ principleId: published.principles[0].principleId, reason: 'SOURCE_UNAVAILABLE' }])
})

test('public scope matches request hints without evaluating workspace membership', async t => {
  const f = await publicMemoryFixture(t)
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'scope-w1', scope: { workspaces: [f.w1], paths: ['src'] } })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'scope-w2', scope: { workspaces: [f.w2], paths: ['src'] } })
  await publishPublicCandidate(f, { paths: ['src'] })

  const inside = f.broker.retriever.retrieve({
    agentId: f.profile.agentId, workspaceKey: f.w3, scope: { workspaces: [f.w3], paths: ['src/ui'] }, attemptStartedAt: 1_000, agentState: 'enabled',
  })
  assert.equal(inside.L2_PUBLIC.status, 'populated')
  const outside = f.broker.retriever.retrieve({
    agentId: f.profile.agentId, workspaceKey: f.w3, scope: { workspaces: [f.w3], paths: ['docs'] }, attemptStartedAt: 1_000, agentState: 'enabled',
  })
  assert.equal(outside.L2_PUBLIC.status, 'empty')
  assert.deepEqual(outside.L2_PUBLIC.exclusions.map(item => item.reason), ['OUT_OF_SCOPE'])
  const noHints = f.broker.retriever.retrieve({
    agentId: f.profile.agentId, workspaceKey: f.w3, scope: { workspaces: [f.w3] }, attemptStartedAt: 1_000, agentState: 'enabled',
  })
  assert.equal(noHints.L2_PUBLIC.status, 'empty', 'a path-scoped principle never covers an unscoped request')
})

test('archived or disabled Agents invalidate both zones for new use but keep read-only history', async t => {
  const f = await publicMemoryFixture(t)
  const w1Source = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'archive-l2' })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'archive-l2-w2' })
  await seedPrivateSnapshot(f, w1Source)
  const published = await publishPublicCandidate(f)
  const input = { agentId: f.profile.agentId, workspaceKey: f.w1, scope: { workspaces: [f.w1] }, attemptStartedAt: 1_000 }

  for (const state of ['disabled', 'archived']) {
    await f.broker.profileSetState(f.profile.agentId, state)
    const gated = f.broker.retriever.retrieve({ ...input, agentState: state })
    assert.equal(gated.L2.status, 'empty')
    assert.equal(gated.L2.snapshotId, null)
    assert.equal(gated.L2_PUBLIC.status, 'empty')
    assert.equal(gated.L2_PUBLIC.snapshotId, null)
    // History itself is untouched and readable through the store.
    assert.equal(f.broker.learning.currentSnapshot(f.profile.agentId, f.w1).snapshotId, 'ms_private_w1')
    assert.equal(f.broker.learning.currentPublicSnapshot(f.profile.agentId).snapshotId, published.snapshotId)
  }
})

test('an Attempt without a public Snapshot records an explicit null public pin', async t => {
  const f = await publicMemoryFixture(t)
  const w1Source = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'single-pin' })
  await seedPrivateSnapshot(f, w1Source)
  await f.broker.setSelector('root1', 'agent', f.profile.agentId)
  f.respond((_options, pack) => ({
    outcome: 'answer',
    claims: [{ text: 'Use the private source.', evidenceIds: [pack.L5[0].evidenceId] }],
    answers: [{ id: 'q', selected: ['A'] }],
  }))
  const hook = await f.broker.hook({ agent: f.agents.root1, request: { questions: [QUESTION] } })
  assert.equal(hook.kind, 'answer')
  const attempt = f.broker.attempts.forCase(hook.caseId)[0]
  assert.equal(attempt.pins.publicMemorySnapshotId, null)
  assert.equal(attempt.pins.publicMemorySnapshotRevision, null)
  assert.equal(attempt.packManifest.memory.publicL2.snapshotId, null)
  // An old Attempt whose persisted pins predate the public pin stays reader-compatible.
  const legacy = attemptOf({
    schema_version: 1, attempt_id: 'da_legacy', case_id: hook.caseId, attempt_no: 2,
    agent_id: f.profile.agentId, pins_json: JSON.stringify({ memorySnapshotId: 'ms_private_w1' }),
    context_pack_hash: 'legacy', pack_manifest_json: JSON.stringify({ layerSizes: {}, evidenceIds: [], correctionIds: [], omissions: [] }),
    started_at: 1, revision: 1, created_at: 1, updated_at: 1,
  })
  assert.deepEqual(legacy.pins, { memorySnapshotId: 'ms_private_w1' })
})
