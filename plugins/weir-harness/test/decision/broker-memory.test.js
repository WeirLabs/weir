import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { buildContextPack } from '../../src/decision/evaluator/pack.js'
import { DecisionContractError } from '../../src/decision/contracts.js'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionProfiles } from '../../src/decision/store/profiles.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionAttempts, attemptOf } from '../../src/decision/store/attempts.js'
import { CURRENT_SCHEMA_VERSION } from '../../src/decision/store/schema.js'
import { insertSnapshot } from './p3-fixtures.js'

function question(text = 'Which?') {
  return { id: 'q', question: text, options: [{ label: 'A' }, { label: 'B' }] }
}

function packOf(options) {
  const content = options.messages[0].content
  return JSON.parse(typeof content === 'string' ? content : content[0].text)
}

function defaultResponse(pack) {
  const evidenceId = pack.L5.find(ref => ref.source === 'user_profile')?.evidenceId ?? pack.L5[0]?.evidenceId
  if (!evidenceId) return { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add authoritative evidence.' }
  return {
    outcome: 'answer',
    claims: [{ text: 'Use the packed authoritative evidence.', evidenceIds: [evidenceId] }],
    answers: pack.L4.request.questions.map(item => ({ id: item.id, selected: [item.options?.[0]?.label ?? 'A'] })),
  }
}

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-broker-memory-'))
  const workspace = realpathSync(dir)
  const config = { decisionAgentsEnabled: true, ...overrides }
  const requests = []
  let respond = defaultResponse
  let sessionReads = 0
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const ctx = {
    agents: { get: id => id === 'root' ? agent : undefined },
    sessionQuery: { traceSession: async () => { sessionReads++; throw new Error('retrieval must not fall back to sessions') } },
    llm: { stream: options => {
      requests.push(options)
      const output = respond(packOf(options))
      return (async function * () {
        yield { type: 'text-delta', text: JSON.stringify(output) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    } },
  }
  const broker = new DecisionBroker({
    profileContext: { home: dir, name: 'test' }, ctx, now: () => 1_000,
    config: () => config,
  })
  await broker.start()
  const profile = await broker.profileUpsert({ workspaceKey: workspace, name: 'A', userDescription: 'Prefer A' })
  await broker.setSelector('root', 'agent', profile.agentId)
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, workspace, config, broker, profile, agent, requests, respond: fn => { respond = fn }, sessionReads: () => sessionReads }
}

async function seedAnswer(f, key, options = {}) {
  const workspaceKey = options.workspaceKey ?? f.workspace
  const agentId = options.agentId ?? f.profile.agentId
  const scope = options.scope ?? { workspaces: [workspaceKey] }
  const request = { entry: 'hook', questions: [question(options.text ?? `Question ${key}`)] }
  let current = (await f.broker.cases.createCase({ workspaceKey, rootSessionId: 'root', entry: 'hook', agentId, request, scope, idempotencyKey: key })).case
  current = await f.broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  let attempt
  if (options.withAttempt) {
    attempt = await f.broker.attempts.start({
      caseId: current.caseId, agentId,
      pins: { promptVersion: 'evaluator-contract/1', memorySnapshotId: null },
      contextPackHash: `old-${key}`,
      packManifest: { layerSizes: { L0: 1, L1: 1, L2: 0, L3: 0, L4: 1, L5: 0 }, evidenceIds: [], correctionIds: [], omissions: [] },
    })
    current = f.broker.cases.getCase(current.caseId)
    await f.broker.attempts.finish(attempt.attemptId, { outcome: 'answer', claims: [{ text: 'A', evidenceIds: [] }] })
  }
  current = await f.broker.cases.transition({
    caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision,
    state: 'closed', closing: 'answered',
    decision: { kind: 'answer', attemptId: attempt?.attemptId ?? `da_${key}`, answers: [{ id: 'q', selected: [options.selected ?? 'A'] }] },
  })
  return { current, attempt }
}

async function seedUserDecision(f, key, selected) {
  let current = (await f.broker.cases.createCase({
    workspaceKey: f.workspace, rootSessionId: 'root', entry: 'hook', agentId: f.profile.agentId,
    request: { entry: 'hook', questions: [question('Same conflict question')] }, scope: { workspaces: [f.workspace] }, idempotencyKey: key,
  })).case
  current = await f.broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user' })
  return f.broker.cases.transition({
    caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision,
    state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers: [{ id: 'q', selected: [selected] }] },
  })
}

test('Broker open/evaluate/flush uses real retrieval and persists only actual memory and L5 projections', async t => {
  const f = await fixture(t)
  const source = await seedAnswer(f, 'broker-neutral', { withAttempt: true, text: 'Historical neutral question', selected: 'A' })
  const oldAttemptBefore = JSON.stringify(f.broker.store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(source.attempt.attemptId))
  assert.ok(f.broker.retriever)

  const verdict = await f.broker.hook({ agent: f.agent, request: { questions: [question('New question')] } })
  assert.equal(verdict.kind, 'answer')
  const sent = packOf(f.requests[0])
  assert.deepEqual(sent.L3.map(item => item.sourceCaseId), [source.current.caseId])
  assert.equal(sent.L5.some(ref => ref.locator?.caseId === source.current.caseId), false)
  assert.equal('temperature' in f.requests[0], false)
  for (const key of ['tools', 'sessionId']) assert.equal(key in f.requests[0], false)

  const attempt = f.broker.attempts.forCase(verdict.caseId)[0]
  assert.equal(attempt.pins.promptVersion, 'evaluator-contract/3')
  assert.equal(attempt.pins.evaluatorVersion, 'sidecar/1')
  assert.equal(attempt.pins.memorySnapshotId, null)
  assert.deepEqual(attempt.packManifest.memory, {
    L2: {
      schemaVersion: 1, zone: 'workspace', status: 'empty', snapshotId: null, snapshotRevision: null, snapshotHash: null,
      principleIds: [], items: [], exclusions: [], layerSize: 0,
    },
    publicL2: {
      schemaVersion: 1, zone: 'public', status: 'empty', snapshotId: null, snapshotRevision: null, snapshotHash: null,
      principleIds: [], items: [], exclusions: [], layerSize: 0,
    },
    L3: { schemaVersion: 1, sourceCaseIds: [source.current.caseId] },
  })
  const attached = f.broker.store.db.prepare(`SELECT evidence.locator_json FROM attempt_evidence
    JOIN evidence ON evidence.evidence_id=attempt_evidence.evidence_id WHERE attempt_evidence.attempt_id=?`).all(attempt.attemptId)
  assert.equal(attached.length, attempt.packManifest.evidenceIds.length)
  assert.equal(attached.some(row => JSON.parse(row.locator_json).caseId === source.current.caseId), false)
  assert.equal(JSON.stringify(f.broker.store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(source.attempt.attemptId)), oldAttemptBefore)

  await f.broker.flush()
  assert.equal(f.broker.retriever, undefined)
})

test('a fixed retrieval result drives pack pins, manifest, and current observation hash validation', async t => {
  const f = await fixture(t)
  const observation = await f.broker.evidence.add({
    agentId: f.profile.agentId, source: 'current_observation', locator: { kind: 'file', path: join(f.workspace, 'a'), hash: 'fresh-hash' },
    observedAt: 1_000, hash: 'fresh-hash', scope: { workspaces: [f.workspace] },
  })
  const fixed = {
    schemaVersion: 1,
    L2: { schemaVersion: 1, status: 'empty', snapshotId: null, items: [] }, L3: [],
    L5: [observation], conflictPairs: [], currentObservationHashes: { [observation.evidenceId]: 'fresh-hash' },
  }
  let captured
  f.broker.retriever = { retrieve: input => { captured = input; return fixed } }
  f.respond(pack => ({
    outcome: 'answer', claims: [{ text: 'The observation is fresh.', evidenceIds: [observation.evidenceId] }],
    answers: [{ id: 'q', selected: ['A'] }],
  }))
  const verdict = await f.broker.hook({ agent: f.agent, request: { questions: [question('Observed question')] } })
  assert.equal(verdict.kind, 'answer')
  assert.equal(captured.agentId, f.profile.agentId)
  assert.equal(captured.workspaceKey, f.workspace)
  assert.deepEqual(captured.scope, { workspaces: [f.workspace] })
  assert.equal(captured.attemptStartedAt, 1_000)
  assert.equal(captured.excludeCaseId, verdict.caseId)
  const attempt = f.broker.attempts.forCase(verdict.caseId)[0]
  assert.deepEqual(attempt.packManifest.evidenceIds, [observation.evidenceId])
  assert.deepEqual(f.broker.evidence.forAttempt(attempt.attemptId).map(ref => ref.evidenceId), [observation.evidenceId])
})

test('Broker applies full pre-trim conflictPairs when the actual pack contains only one side', async t => {
  const f = await fixture(t)
  await seedUserDecision(f, 'broker-conflict-left', 'A')
  await seedUserDecision(f, 'broker-conflict-right', 'B')
  const input = { agentId: f.profile.agentId, workspaceKey: f.workspace, scope: { workspaces: [f.workspace] }, attemptStartedAt: 1_000 }
  const fixed = f.broker.retriever.retrieve(input)
  assert.equal(fixed.conflictPairs.length, 1)
  const request = { entry: 'hook', questions: [question('Same conflict question')] }
  let budgetTokens
  for (let candidate = 1; candidate <= 6_000; candidate++) {
    const packed = buildContextPack({ profile: f.profile, request, evidence: fixed.L5, modelRoute: { kind: 'inherited' }, budgetTokens: candidate, criticalEvidenceIds: [] })
    if (packed.outcome === 'ready' && packed.packManifest.evidenceIds.length === 1) { budgetTokens = candidate; break }
  }
  assert.ok(budgetTokens, 'the fixture must produce a one-sided pack')
  f.config.decisionAgentContextBudgetTokens = budgetTokens
  f.broker.retriever = { retrieve: () => fixed }
  f.respond(pack => ({
    outcome: 'answer', claims: [{ text: 'Cite only the packed side.', evidenceIds: [pack.L5[0].evidenceId] }],
    answers: [{ id: 'q', selected: ['A'] }],
  }))
  const verdict = await f.broker.hook({ agent: f.agent, request })
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.code, 'CONFLICTING_EVIDENCE')
  const attempt = f.broker.attempts.forCase(verdict.caseId)[0]
  assert.equal(attempt.packManifest.evidenceIds.length, 1)
  assert.equal(attempt.gates.g4, false)
  assert.ok(attempt.gates.gaps.some(gap => gap.gate === 'G4' && fixed.conflictPairs[0].every(id => gap.evidenceId.includes(id))))
})

test('Broker pins and cites actual source-bound L2 without rewriting history on rollback', async t => {
  const f = await fixture(t)
  const source = await seedUserDecision(f, 'broker-l2-source', 'A')
  const scope = { workspaces: [f.workspace] }
  const ref = await f.broker.evidence.add({
    agentId: f.profile.agentId, source: 'user_decision', locator: { kind: 'case', caseId: source.caseId }, scope,
  })
  insertSnapshot(f, 'ms_broker_l2', 1, 'published', {
    principles: [{ principleId: 'pr_broker', text: 'Prefer the reviewed decision', scope, sources: [source.caseId], state: 'active' }],
  })
  f.respond(pack => ({
    outcome: 'answer', claims: [{ text: 'Use the actual L5 source.', evidenceIds: [ref.evidenceId] }],
    answers: pack.L4.request.questions.map(item => ({ id: item.id, selected: ['A'] })),
  }))

  const verdict = await f.broker.hook({ agent: f.agent, request: { questions: [question('Use reviewed memory')] } })
  assert.equal(verdict.kind, 'answer')
  const wire = packOf(f.requests[0])
  assert.deepEqual(wire.L2.map(item => item.principleId), ['pr_broker'])
  assert.deepEqual(wire.L2[0].evidenceIds, [ref.evidenceId])
  const attempt = f.broker.attempts.forCase(verdict.caseId)[0]
  assert.equal(attempt.pins.memorySnapshotId, 'ms_broker_l2')
  assert.equal(attempt.pins.memorySnapshotRevision, 1)
  assert.match(attempt.pins.memorySnapshotHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(attempt.citedEvidenceIds, [ref.evidenceId])
  assert.deepEqual(attempt.packManifest.memory.L2.principleIds, ['pr_broker'])
  assert.deepEqual(attempt.packManifest.memory.L2.items[0].evidenceIds, [ref.evidenceId])
  assert.equal(attempt.packManifest.evidenceIds.includes('pr_broker'), false)
  const before = JSON.stringify(f.broker.store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attempt.attemptId))

  await f.broker.learning.rollback('ms_broker_l2', 1)
  assert.equal(JSON.stringify(f.broker.store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attempt.attemptId)), before)
  const after = await f.broker.hook({ agent: f.agent, request: { questions: [question('After Snapshot rollback')] } })
  assert.equal(after.kind, 'answer')
  const afterAttempt = f.broker.attempts.forCase(after.caseId)[0]
  assert.equal(afterAttempt.pins.memorySnapshotId, null)
  assert.equal(packOf(f.requests[1]).L2, '')
})

test('Broker source recheck rejects evidence deleted after an L2 pack was sent', async t => {
  const f = await fixture(t)
  const source = await seedUserDecision(f, 'broker-l2-stale-source', 'A')
  const scope = { workspaces: [f.workspace] }
  const ref = await f.broker.evidence.add({
    agentId: f.profile.agentId, source: 'user_decision', locator: { kind: 'case', caseId: source.caseId }, scope,
  })
  insertSnapshot(f, 'ms_broker_stale', 1, 'published', {
    principles: [{ principleId: 'pr_stale', text: 'Reviewed but still source-bound', scope, sources: [source.caseId], state: 'active' }],
  })
  f.respond(() => {
    f.broker.store.db.prepare("UPDATE evidence SET status='deleted' WHERE evidence_id=?").run(ref.evidenceId)
    return { outcome: 'answer', claims: [{ text: 'Try to use the stale source.', evidenceIds: [ref.evidenceId] }], answers: [{ id: 'q', selected: ['A'] }] }
  })
  const verdict = await f.broker.hook({ agent: f.agent, request: { questions: [question('Recheck the L2 source')] } })
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.code, 'STALE_EVIDENCE')
  const attempt = f.broker.attempts.forCase(verdict.caseId)[0]
  assert.equal(attempt.outcome, 'return')
  assert.equal(attempt.gates.g3, false)
  assert.equal(attempt.pins.memorySnapshotId, 'ms_broker_stale')
  assert.deepEqual(attempt.packManifest.memory.L2.principleIds, ['pr_stale'])
})

test('global disable, Off, excluded authority, no-route, and capacity never invoke retrieval', async t => {
  const f = await fixture(t, { decisionAgentMaxConcurrentAttempts: 1 })
  let calls = 0
  const retrieve = f.broker.retriever.retrieve.bind(f.broker.retriever)
  f.broker.retriever.retrieve = input => { calls++; return retrieve(input) }
  const counts = () => ({
    cases: f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n,
    routes: f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n,
    attempts: f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,
  })
  const initial = counts()

  const excluded = await f.broker.hook({ agent: f.agent, request: { questions: [{ ...question('Approve native authority?'), intent: { kind: 'approval' } }] } })
  assert.deepEqual(excluded, { kind: 'pass', why: 'bypass' })
  assert.deepEqual(counts(), initial)
  await f.broker.setSelector('root', 'off')
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: { questions: [question('Off question')] } }), { kind: 'pass', why: 'bypass' })
  assert.deepEqual(counts(), initial)
  f.config.decisionAgentsEnabled = false
  assert.deepEqual(await f.broker.hook({ agent: f.agent, request: { questions: [question('Disabled question')] } }), { kind: 'pass', why: 'bypass' })
  assert.deepEqual(counts(), initial)

  f.config.decisionAgentsEnabled = true
  await f.broker.setSelector('root', 'agent', f.profile.agentId)
  await f.broker.profileSetState(f.profile.agentId, 'disabled')
  const noRoute = await f.broker.hook({ agent: f.agent, request: { questions: [question('No route question')] } })
  assert.equal(noRoute.why, 'awaiting_user')
  assert.deepEqual(counts(), { cases: initial.cases + 1, routes: initial.routes + 1, attempts: 0 })

  await f.broker.profileSetState(f.profile.agentId, 'enabled')
  f.broker.activeEvaluations = 1
  try {
    assert.deepEqual(await f.broker.hook({ agent: f.agent, request: { questions: [question('Capacity question')] } }), { kind: 'pass', why: 'bypass' })
  } finally { f.broker.activeEvaluations = 0 }
  assert.equal(counts().cases, initial.cases + 1)
  assert.equal(counts().routes, initial.routes + 1)
  assert.equal(counts().attempts, 0)
  assert.equal(calls, 0)
  assert.equal(f.requests.length, 0)
})

test('a retrieval exception follows recoverUnexpected without model, namespace, or session fallback', async t => {
  const f = await fixture(t)
  await seedAnswer(f, 'other-namespace', { workspaceKey: '/other', agentId: 'agent-other', selected: 'B' })
  let calls = 0
  f.broker.retriever = { retrieve: () => { calls++; throw new DecisionContractError('CORRUPT_RETRIEVAL', 'broken projection') } }
  const verdict = await f.broker.hook({ agent: f.agent, request: { questions: [question('Failure question')] } })
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.why, 'awaiting_user')
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.state, 'awaiting_user')
  const attempts = f.broker.attempts.forCase(current.caseId)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].outcome, 'failed')
  assert.equal(attempts[0].error.code, 'CORRUPT_RETRIEVAL')
  assert.equal(calls, 1)
  assert.equal(f.requests.length, 0)
  assert.equal(f.sessionReads(), 0)
})

test('a high-version eligible record fails into a recoverable Case without evaluator fallback', async t => {
  const f = await fixture(t)
  const source = await seedAnswer(f, 'high-version')
  f.broker.store.db.prepare('UPDATE cases SET schema_version=99 WHERE case_id=?').run(source.current.caseId)
  const verdict = await f.broker.hook({ agent: f.agent, request: { questions: [question('Version gate question')] } })
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.why, 'awaiting_user')
  const attempts = f.broker.attempts.forCase(verdict.caseId)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].outcome, 'failed')
  assert.equal(attempts[0].error.code, 'UNSUPPORTED_SCHEMA_VERSION')
  assert.equal(f.requests.length, 0)
  assert.equal(f.sessionReads(), 0)
})

test('restart recovery interrupts open work without rewriting its memory pins, hash, or manifest', async t => {
  const f = await fixture(t)
  let current = (await f.broker.cases.createCase({
    workspaceKey: f.workspace, rootSessionId: 'root', entry: 'hook', agentId: f.profile.agentId,
    request: { entry: 'hook', questions: [question()] }, scope: { workspaces: [f.workspace] }, idempotencyKey: 'restart-memory',
  })).case
  current = await f.broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  const manifest = {
    layerSizes: { L0: 1, L1: 1, L2: 0, L3: 10, L4: 1, L5: 0 }, evidenceIds: [], correctionIds: [],
    memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: ['dc_neutral'] } }, omissions: [],
  }
  const attempt = await f.broker.attempts.start({ caseId: current.caseId, agentId: f.profile.agentId, pins: { promptVersion: 'evaluator-contract/2', memorySnapshotId: null }, contextPackHash: 'memory-hash', packManifest: manifest })
  const immutableBefore = f.broker.store.db.prepare('SELECT pins_json,context_pack_hash,pack_manifest_json FROM attempts WHERE attempt_id=?').get(attempt.attemptId)
  await f.broker.flush()

  const restarted = new DecisionBroker({ profileContext: { home: f.dir, name: 'test' }, config: () => ({ decisionAgentsEnabled: true }), now: () => 2_000 })
  try {
    await restarted.start()
    const recovered = restarted.cases.getCase(current.caseId)
    assert.equal(recovered.state, 'awaiting_user')
    assert.equal(recovered.awaitingReason, 'interrupted')
    const interrupted = restarted.attempts.get(attempt.attemptId)
    assert.equal(interrupted.outcome, 'failed')
    assert.equal(interrupted.error.kind, 'interrupted')
    assert.deepEqual(interrupted.packManifest, manifest)
    assert.deepEqual(restarted.store.db.prepare('SELECT pins_json,context_pack_hash,pack_manifest_json FROM attempts WHERE attempt_id=?').get(attempt.attemptId), immutableBefore)
  } finally { await restarted.flush() }
})

test('P1 v1 fixtures reopen without migration or backfill and additive manifests remain reader-compatible', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-p1-compat-'))
  const path = join(dir, 'decision.db')
  const store = openDecisionDatabase(path)
  const profiles = new DecisionProfiles(store, { now: () => 100 })
  const cases = new DecisionCases(store, { now: () => 100 })
  const attempts = new DecisionAttempts(store, { now: () => 100 })
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'P1' })
  let current = (await cases.createCase({ workspaceKey: '/repo', rootSessionId: 'root', entry: 'hook', agentId: profile.agentId, request: { entry: 'hook', questions: [question()] }, scope: { workspaces: ['/repo'] }, idempotencyKey: 'p1-old' })).case
  current = await cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  const p1Manifest = { layerSizes: { L0: 10, L1: 10, L2: 0, L3: 0, L4: 10, L5: 0 }, evidenceIds: ['ev_p1'], correctionIds: [], omissions: [] }
  const old = await attempts.start({ caseId: current.caseId, agentId: profile.agentId, pins: { promptVersion: 'evaluator-contract/1', memorySnapshotId: null }, contextPackHash: 'p1-hash', packManifest: p1Manifest })
  current = cases.getCase(current.caseId)
  await attempts.finish(old.attemptId, { outcome: 'answer', claims: [{ text: 'A', evidenceIds: ['ev_p1'] }] })
  current = await cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'closed', closing: 'answered', decision: { kind: 'answer', attemptId: old.attemptId, answers: [{ id: 'q', selected: ['A'] }] } })
  const schema = db => JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all())
  const schemaBefore = schema(store.db)
  const oldBefore = JSON.stringify(store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(old.attemptId))
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION)
  store.close()

  const broker = new DecisionBroker({ config: () => ({ decisionAgentsEnabled: true, decisionAgentStorePath: dir }), now: () => 200 })
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  await broker.start()
  assert.equal(CURRENT_SCHEMA_VERSION, 2)
  assert.equal(broker.store.db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION)
  assert.equal(schema(broker.store.db), schemaBefore)
  assert.equal(existsSync(join(dir, 'backups')), false)
  assert.equal(JSON.stringify(broker.store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(old.attemptId)), oldBefore)
  const oldRecord = broker.query.record({ caseId: current.caseId })
  assert.deepEqual(oldRecord.attempts[0].packManifest, p1Manifest)
  assert.equal('memory' in oldRecord.attempts[0].packManifest, false)

  let newer = (await broker.cases.createCase({ workspaceKey: '/repo', rootSessionId: 'root', entry: 'hook', agentId: profile.agentId, request: { entry: 'hook', questions: [question('P2')] }, scope: { workspaces: ['/repo'] }, idempotencyKey: 'p2-new' })).case
  newer = await broker.cases.transition({ caseId: newer.caseId, expectedState: 'received', expectedRevision: newer.revision, state: 'evaluating' })
  const additive = { ...p1Manifest, memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: ['dc_safe'] } } }
  const added = await broker.attempts.start({ caseId: newer.caseId, agentId: profile.agentId, pins: { promptVersion: 'evaluator-contract/2' }, contextPackHash: 'p2-hash', packManifest: additive })
  await broker.attempts.finish(added.attemptId, { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Fixture complete' })
  const raw = broker.store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(added.attemptId)
  const compatible = attemptOf(raw)
  assert.deepEqual(compatible.packManifest.layerSizes, additive.layerSizes)
  assert.deepEqual(compatible.packManifest.evidenceIds, additive.evidenceIds)
  assert.deepEqual(compatible.packManifest.correctionIds, additive.correctionIds)
  assert.deepEqual(compatible.packManifest.omissions, additive.omissions)
  assert.equal(JSON.stringify(broker.store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(old.attemptId)), oldBefore)
})
