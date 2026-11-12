// Decision data export: assembly, redaction, counts and checksum
// (OpenSpec decision-data-export tasks 1.1/1.2).
//
// One export is assembled from the reviewed read models and must stay inside the
// caller's root session and workspace: another workspace's records, absolute
// paths, real workspace keys and the public zone's provenance never appear.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { canonicalJson } from '../../src/decision/contracts.js'
import { workspaceAlias } from '../../src/decision/learning/namespace.js'
import { exportChecksum } from '../../src/decision/store/export.js'
import { insertLearningRun, insertSnapshot } from './p3-fixtures.js'
import { publicAdd, publicFrozenInput, publicMemoryFixture } from './public-fixtures.js'

const ABSOLUTE_PATH = /(?:^|["'\s])(?:\/Users\/|\/home\/|\/private\/|\/var\/|[A-Za-z]:\\)/

/** Seed a published public snapshot plus one private draft for the same Agent. */
function seedMemory(f) {
  insertLearningRun(f, 'lr_pub_memory', 'published', { zone: 'public', inputFrozen: publicFrozenInput(f) })
  insertSnapshot(f, 'ms_public_published', 1, 'published', {
    zone: 'public', learningRunId: 'lr_pub_memory',
    principles: [{ principleId: 'pr_public_published', text: 'Prefer the reviewed public wording', scope: { paths: ['docs'] }, sources: [], state: 'active' }],
  })
  insertLearningRun(f, 'lr_private_w1', 'candidate', { workspaceKey: f.w1 })
  insertSnapshot(f, 'ms_private_w1', 1, 'draft', {
    workspaceKey: f.w1, learningRunId: 'lr_private_w1',
    principles: [{ principleId: 'pr_private_w1', text: 'Prefer the reviewed private wording', scope: { workspaces: [f.w1], paths: ['src'] }, sources: [], state: 'active' }],
  })
  insertLearningRun(f, 'lr_private_w2', 'candidate', { workspaceKey: f.w2 })
  insertSnapshot(f, 'ms_private_w2', 1, 'draft', {
    workspaceKey: f.w2, learningRunId: 'lr_private_w2',
    principles: [{ principleId: 'pr_private_w2', text: 'FOREIGN-WORKSPACE-SECRET principle', scope: { workspaces: [f.w2], paths: ['src'] }, sources: [], state: 'active' }],
  })
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

test('the export envelope carries exactly the caller workspace through the reviewed read models', async t => {
  const f = await publicMemoryFixture(t)
  const w1Case = await f.seedDecision({
    workspaceKey: f.w1, rootSessionId: 'root1', key: 'export-w1',
    question: 'Which wording should the export record?', selected: 'A',
  })
  // Same root session, different workspace: the workspace is the export boundary.
  const foreign = await f.seedDecision({
    workspaceKey: f.w2, rootSessionId: 'root1', key: 'export-w2-same-root',
    question: 'W2-EXPORT-SECRET which other workspace answer?', selected: 'B',
  })
  seedMemory(f)

  const exported = await f.broker.exportData({ sessionId: 'root1' })
  assert.equal(typeof exported.file, 'string')
  assert.ok(exported.bytes > 0)
  assert.equal(exported.exportedAt, 1000)
  const text = readFileSync(exported.file, 'utf8')
  const envelope = JSON.parse(text)

  assert.equal(envelope.kind, 'weir-decision-export')
  assert.equal(envelope.formatVersion, 1)
  assert.equal(envelope.exportedAt, 1000)
  assert.deepEqual(Object.keys(envelope.generator).sort(), ['name', 'version'])
  assert.deepEqual(envelope.scope, { workspaceAlias: workspaceAlias(f.w1) })
  assert.equal(envelope.integrity.algorithm, 'sha256')
  assert.match(envelope.integrity.value, /^[a-f0-9]{64}$/)

  // Cases: only the caller workspace, all states, with their real sub-records.
  assert.deepEqual(envelope.cases.map(entry => entry.case.caseId), [w1Case.caseId])
  assert.equal(envelope.cases[0].case.state, 'closed')
  assert.equal(envelope.cases[0].case.workspaceKey, undefined, 'no real workspace key survives')
  assert.equal(envelope.cases.some(entry => entry.case.caseId === foreign.caseId), false, 'another workspace never enters')
  for (const entry of envelope.cases) {
    assert.deepEqual(Object.keys(entry).sort(), ['attempts', 'case', 'feedback', 'routeDecisions'])
    for (const attempt of entry.attempts) assert.ok(Array.isArray(attempt.evidence))
  }

  // Private learning rows of this workspace only; the public zone is never content.
  assert.deepEqual(envelope.learning.runs.map(run => run.learningRunId), ['lr_private_w1'])
  assert.deepEqual(envelope.learning.snapshots.map(snapshot => snapshot.snapshotId), ['ms_private_w1'])
  assert.equal(JSON.stringify(envelope.learning).includes('lr_pub_memory'), false, 'a public run is not private learning content')
  assert.equal(JSON.stringify(envelope.learning).includes('ms_private_w2'), false, 'another workspace keeps its own private rows')

  // The published public zone exports reviewed wording and workspace-agnostic scope only.
  assert.deepEqual(envelope.public, {
    kind: 'published-principles-only',
    principles: [{ principleId: 'pr_public_published', text: 'Prefer the reviewed public wording', scope: { paths: ['docs'] } }],
  })

  // Agent profiles carry user-visible fields only.
  const shared = envelope.agents.find(agent => agent.agentId === f.profile.agentId)
  assert.ok(shared, 'the shared assistant profile is exported')
  assert.equal(shared.name, 'A')
  assert.equal(shared.state, 'enabled')
  assert.deepEqual(shared.userDescription, { revision: 1, text: 'Prefer A' })
  for (const key of ['revision', 'schemaVersion', 'legacyOriginAlias', 'generatedDescription']) {
    assert.equal(key in shared, false, `Agent export never carries ${key}`)
  }

  // Counts are the file's own entries, so a reader can verify them.
  assert.deepEqual(envelope.counts, {
    agents: envelope.agents.length,
    cases: envelope.cases.length,
    attempts: envelope.cases.reduce((sum, entry) => sum + entry.attempts.length, 0),
    evidence: envelope.cases.reduce((sum, entry) => sum + entry.attempts.reduce((inner, attempt) => inner + attempt.evidence.length, 0), 0),
    feedback: envelope.cases.reduce((sum, entry) => sum + entry.feedback.length, 0),
    routeDecisions: envelope.cases.reduce((sum, entry) => sum + entry.routeDecisions.length, 0),
    learningRuns: envelope.learning.runs.length,
    memorySnapshots: envelope.learning.snapshots.length,
    publishedPrinciples: envelope.public.principles.length,
  })
  assert.deepEqual(exported.counts, envelope.counts)

  // The checksum covers everything except itself, in canonical order.
  const rest = { ...envelope }
  delete rest.integrity
  assert.equal(envelope.integrity.value, exportChecksum(envelope))
  assert.equal(envelope.integrity.value, digest(canonicalJson(rest)))
  const tampered = { ...rest, exportedAt: 1001 }
  assert.notEqual(envelope.integrity.value, digest(canonicalJson(tampered)), 'any field change breaks the checksum')
})

test('the export payload carries no absolute path, no real workspace key and no foreign marker', async t => {
  const f = await publicMemoryFixture(t)
  const w1Case = await f.seedDecision({
    workspaceKey: f.w1, rootSessionId: 'root1', key: 'redact-w1',
    question: `Which file under ${f.w1}/private/notes.md or /opt/other-machine/secret.txt decides this?`, selected: 'A',
  })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'redact-w2', question: 'W2-EXPORT-SECRET other workspace' })
  seedMemory(f)
  const exported = await f.broker.exportData({ sessionId: 'root1' })
  const text = readFileSync(exported.file, 'utf8')
  const envelope = JSON.parse(text)

  // The case really did carry its workspace path: the export redacted it.
  const stored = f.broker.query.record({ caseId: w1Case.caseId, sessionId: 'root1' })
  assert.ok(JSON.stringify(stored).includes(f.w1), 'the stored record still carries the real workspace key')
  assert.equal(JSON.stringify(stored).includes('/opt/other-machine/secret.txt'), true)
  // `/private/` as a relative suffix of a redacted alias is content, not an
  // absolute path: the forbidden list is about path roots and workspace keys.
  for (const secret of [f.w1, f.w2, '/Users/', '/home/', '/var/', '/opt/other-machine/']) {
    assert.equal(text.includes(secret), false, `the export never carries ${secret}`)
  }
  assert.equal(ABSOLUTE_PATH.test(text), false, 'no absolute path shape survives')
  assert.equal(text.includes('workspaceKey'), false, 'no real workspace key field survives')
  assert.equal(text.includes('W2-EXPORT-SECRET'), false, 'another workspace marker never enters')
  assert.equal(text.includes('FOREIGN-WORKSPACE-SECRET'), false, 'another workspace private memory never enters')
  // The alias identity and the redaction marker are what a reader sees instead.
  assert.equal(envelope.scope.workspaceAlias, workspaceAlias(f.w1))
  assert.ok(text.includes('<path>'), 'absolute paths are redacted with the reviewed marker')
  assert.ok(JSON.stringify(envelope.cases).includes(workspaceAlias(f.w1)), 'the scope keeps the opaque alias')
})

test('an empty workspace still exports a verifiable, honest envelope', async t => {
  const f = await publicMemoryFixture(t)
  const exported = await f.broker.exportData({ sessionId: 'root1' })
  const envelope = JSON.parse(readFileSync(exported.file, 'utf8'))
  assert.deepEqual(envelope.cases, [])
  assert.deepEqual(envelope.learning, { runs: [], snapshots: [] })
  assert.deepEqual(envelope.public, { kind: 'published-principles-only', principles: [] })
  assert.deepEqual(envelope.counts, {
    agents: 0, cases: 0, attempts: 0, evidence: 0, feedback: 0, routeDecisions: 0,
    learningRuns: 0, memorySnapshots: 0, publishedPrinciples: 0,
  })
  assert.equal(envelope.integrity.value, exportChecksum(envelope))
})

test('every exported partition carries real rows and the evidence locator is redacted', async t => {
  const f = await publicMemoryFixture(t)
  // A real answered Case: one Attempt, one answered decision, one rating_up Feedback.
  const validated = await f.seedValidated({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'partition-validated' })
  const stored = f.broker.query.record({ caseId: validated.caseId, sessionId: 'root1' })
  assert.equal(stored.attempts.length, 1, 'the fixture really created one Attempt')
  const attempt = stored.attempts[0]
  // Real Evidence whose locator carries a workspace path and a foreign absolute path.
  const evidence = await f.broker.evidence.add({
    agentId: f.profile.agentId, source: 'current_observation',
    locator: { kind: 'file', path: `${f.w1}/private/notes.md`, foreignPath: '/opt/other-machine/secret.txt', line: 12 },
    excerpt: `Observed ${f.w1}/private/notes.md and /opt/other-machine/secret.txt`,
    scope: { workspaces: [f.w1] },
  })
  await f.broker.evidence.attach(attempt.attemptId, [evidence.evidenceId])
  const routeId = await f.broker.cases.recordRoute({
    caseId: validated.caseId, rootSessionId: 'root1', mode: 'pinned',
    candidates: [{ agentId: f.profile.agentId, enabled: true }], chosen: f.profile.agentId, reason: 'Pinned by user',
  })

  const exported = await f.broker.exportData({ sessionId: 'root1' })
  const text = readFileSync(exported.file, 'utf8')
  const envelope = JSON.parse(text)
  const entry = envelope.cases.find(item => item.case.caseId === validated.caseId)
  assert.ok(entry, 'the validated case is exported')

  // Each partition carries the real row, not an empty placeholder.
  assert.equal(entry.attempts.length, 1)
  assert.equal(entry.attempts[0].attemptId, attempt.attemptId)
  assert.equal(entry.attempts[0].outcome, 'answer')
  assert.equal(entry.attempts[0].caseId, validated.caseId)
  assert.equal(entry.attempts[0].evidence.length, 1)
  assert.equal(entry.feedback.length, 1)
  assert.equal(entry.routeDecisions.length, 1)
  assert.equal(entry.routeDecisions[0].routeDecisionId, routeId)
  assert.equal(entry.routeDecisions[0].mode, 'pinned')
  assert.equal(entry.routeDecisions[0].chosen, f.profile.agentId)
  assert.equal(entry.routeDecisions[0].reason, 'Pinned by user')

  // The Feedback holds its real shape, including the effect the product recorded.
  const feedback = entry.feedback[0]
  assert.equal(feedback.kind, 'rating_up')
  assert.equal(feedback.caseId, validated.caseId)
  assert.match(feedback.feedbackId, /^fb_/)
  assert.equal(feedback.actor, 'user')
  assert.deepEqual(feedback.effect, { feedbackStateBefore: 'none', feedbackStateAfter: 'validated', needsReview: false })

  // The counts are the file's own entries and every partition is non-zero.
  const fileCounts = {
    attempts: envelope.cases.reduce((sum, item) => sum + item.attempts.length, 0),
    evidence: envelope.cases.reduce((sum, item) => sum + item.attempts.reduce((inner, item2) => inner + item2.evidence.length, 0), 0),
    feedback: envelope.cases.reduce((sum, item) => sum + item.feedback.length, 0),
    routeDecisions: envelope.cases.reduce((sum, item) => sum + item.routeDecisions.length, 0),
  }
  assert.deepEqual(fileCounts, { attempts: 1, evidence: 1, feedback: 1, routeDecisions: 1 })
  assert.deepEqual({
    attempts: envelope.counts.attempts, evidence: envelope.counts.evidence,
    feedback: envelope.counts.feedback, routeDecisions: envelope.counts.routeDecisions,
  }, fileCounts)
  for (const key of ['attempts', 'evidence', 'feedback', 'routeDecisions']) assert.ok(envelope.counts[key] > 0, `${key} is non-zero`)

  // The Evidence locator keeps its identity and loses every real path.
  const exportedEvidence = entry.attempts[0].evidence[0]
  assert.equal(exportedEvidence.evidenceId, evidence.evidenceId)
  assert.equal(exportedEvidence.agentId, f.profile.agentId)
  assert.equal(exportedEvidence.source, 'current_observation')
  assert.equal(exportedEvidence.status, 'active')
  const locator = exportedEvidence.locator
  assert.equal(locator.kind, 'file')
  assert.equal(locator.line, 12)
  assert.equal(locator.foreignPath, '<path>', 'a foreign absolute path is redacted with the reviewed marker')
  const locatorPath = String(locator.path)
  assert.equal(locatorPath.includes(f.w1), false, 'the real workspace key never survives in a locator')
  assert.equal(locatorPath.startsWith('/'), false, 'no absolute path survives in a locator')
  assert.ok(locatorPath === '<path>' || locatorPath.startsWith(workspaceAlias(f.w1)), 'the workspace path is either redacted or reduced to the opaque alias')
  assert.equal(String(exportedEvidence.excerpt).includes(f.w1), false, 'the excerpt loses the workspace key')
  assert.equal(String(exportedEvidence.excerpt).includes('/opt/other-machine/'), false, 'the excerpt loses the foreign path')

  // Nothing anywhere in the file names a real path, a workspace key or a foreign root.
  for (const secret of [f.w1, f.w2, '/Users/', '/home/', '/opt/other-machine/', '/var/']) {
    assert.equal(text.includes(secret), false, `the export never carries ${secret}`)
  }
  assert.equal(ABSOLUTE_PATH.test(text), false, 'no absolute path shape survives')
  assert.equal(text.includes('workspaceKey'), false, 'no real workspace key field survives')
  assert.equal(envelope.integrity.value, exportChecksum(envelope), 'the richer payload still verifies')
})

/**
 * The shipped client copy promises public-memory provenance is never included.
 * A real Attempt that used public guidance records the origin aliases of that
 * guidance in its pack manifest, so the file must lose every foreign alias.
 */
test('a real Attempt that used public guidance exports no foreign workspace alias', async t => {
  const f = await publicMemoryFixture(t)
  // Two other workspaces contributed to the public zone; the caller is the third.
  await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'alias-w1' })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'alias-w2' })
  await f.seedDecision({ workspaceKey: f.w3, rootSessionId: 'root3', key: 'alias-w3' })
  f.respond((_options, pack) => ({
    operations: [publicAdd(pack.sources.map(source => source.sourceId), { text: 'Prefer the option every workspace agreed on', scope: {} })],
  }))
  const refreshed = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  assert.equal(refreshed.status, 'candidate', JSON.stringify(refreshed))
  assert.equal(refreshed.workspaceCount, 3, 'the public guidance really came from three workspaces')
  const published = await f.broker.snapshotPublish({ sessionId: 'root1', snapshotId: refreshed.candidate.snapshotId, expectedRevision: refreshed.candidate.revision })

  // A real Attempt for the third workspace consumes that guidance.
  await f.broker.setSelector('root3', 'agent', f.profile.agentId)
  f.respond(() => ({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'The current workspace has no eligible evidence.' }))
  const hooked = await f.broker.hook({ agent: f.agents.root3, request: { questions: [{ id: 'q', question: 'Which option now?', options: [{ label: 'A' }, { label: 'B' }] }] } })

  // The stored Attempt really carries the Desktop-shaped lineage: two foreign
  // aliases and the caller's own one.
  const stored = f.broker.query.record({ caseId: hooked.caseId, sessionId: 'root3' })
  const storedAttempt = stored.attempts.at(-1)
  const storedLineage = storedAttempt.packManifest.memory.publicL2.items[0].sources
  assert.deepEqual([...storedLineage].sort(), [workspaceAlias(f.w1), workspaceAlias(f.w2), workspaceAlias(f.w3)].sort(), 'the real manifest records two foreign aliases and the caller alias')

  const exported = await f.broker.exportData({ sessionId: 'root3' })
  const text = readFileSync(exported.file, 'utf8')
  const envelope = JSON.parse(text)
  const exportedAttempt = envelope.cases.find(entry => entry.case.caseId === hooked.caseId).attempts.at(-1)
  const publicL2 = exportedAttempt.packManifest.memory.publicL2

  // The public-zone identity stays checkable; its provenance does not enter.
  assert.equal(publicL2.snapshotId, published.snapshotId)
  assert.equal(publicL2.snapshotRevision, published.revision)
  assert.match(String(publicL2.snapshotHash), /^[0-9a-f]{64}$/)
  assert.deepEqual(publicL2.principleIds, [published.principles[0].principleId])
  assert.ok(publicL2.layerSize > 0, 'the real layer size survives')
  assert.deepEqual(publicL2.items.map(item => item.principleId), [published.principles[0].principleId])
  for (const item of publicL2.items) {
    assert.equal('sources' in item, false, 'public-memory provenance never enters the file')
    assert.deepEqual(item.evidenceIds, [], 'public guidance is still no Evidence Ref')
  }

  // The only origin_ token in the whole file is the caller's own alias.
  assert.equal(envelope.scope.workspaceAlias, workspaceAlias(f.w3))
  const tokens = [...new Set(text.match(/origin_[0-9a-f]{12}/g) ?? [])]
  assert.deepEqual(tokens, [envelope.scope.workspaceAlias], 'no foreign origin alias survives')
  for (const foreign of [workspaceAlias(f.w1), workspaceAlias(f.w2)]) assert.equal(text.includes(foreign), false, `the export never carries ${foreign}`)
  assert.equal(envelope.integrity.value, exportChecksum(envelope), 'the redacted payload still verifies')
})

test('a foreign alias outside a source list becomes the other-workspace marker, and record ids stay', async t => {
  const f = await publicMemoryFixture(t)
  const ownAlias = workspaceAlias(f.w1)
  const foreignAlias = workspaceAlias(f.w2)
  const w1Case = await f.seedDecision({
    workspaceKey: f.w1, rootSessionId: 'root1', key: 'alias-text',
    question: `Which option matches ${foreignAlias} or ${ownAlias}?`, selected: 'A',
  })
  // A reviewed private snapshot whose source list mixes a record id and an alias.
  insertLearningRun(f, 'lr_private_alias', 'candidate', { workspaceKey: f.w1 })
  insertSnapshot(f, 'ms_private_alias', 1, 'published', {
    workspaceKey: f.w1, learningRunId: 'lr_private_alias',
    principles: [{ principleId: 'pr_private_alias', text: 'Prefer the reviewed wording', scope: { workspaces: [f.w1], paths: ['src'] }, sources: [w1Case.caseId, foreignAlias], state: 'active' }],
  })

  const exported = await f.broker.exportData({ sessionId: 'root1' })
  const text = readFileSync(exported.file, 'utf8')
  const envelope = JSON.parse(text)

  // User content that names another workspace's alias keeps only the marker.
  const question = String(envelope.cases[0].case.request.questions[0].question)
  assert.equal(question.includes(foreignAlias), false, 'a foreign alias is never echoed back')
  assert.ok(question.includes('<other-workspace>'), 'the marker stands in for the foreign workspace')
  assert.ok(question.includes(ownAlias), 'the caller may read its own alias')

  // A source list is provenance: the foreign alias is dropped, the record id stays.
  const principle = envelope.learning.snapshots.find(snapshot => snapshot.snapshotId === 'ms_private_alias').principles[0]
  assert.deepEqual(principle.sources, [w1Case.caseId])
  assert.equal(text.includes(foreignAlias), false, 'no foreign origin alias survives anywhere')
  assert.deepEqual([...new Set(text.match(/origin_[0-9a-f]{12}/g) ?? [])], [ownAlias])
})
