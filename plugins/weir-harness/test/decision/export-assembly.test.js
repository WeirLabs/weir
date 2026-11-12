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
import { publicFrozenInput, publicMemoryFixture } from './public-fixtures.js'

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
