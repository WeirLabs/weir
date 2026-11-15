import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { createDecisionRemoteService } from '../../src/decision/remote.js'
import { decisionAuditPayload } from '../../src/decision/audit.js'
import { seedUserDecision, snapshotForRun } from './p3-fixtures.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-boundaries-'))
  const otherDir = mkdtempSync(join(tmpdir(), 'weir-decision-boundaries-other-'))
  const workspace = realpathSync(dir)
  const otherWorkspace = realpathSync(otherDir)
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const ctx = {
    agents: { get: id => id === 'root' ? agent : undefined },
    sessionQuery: { traceSession: async id => {
      if (id === 'child') return { complete: true, root: { header: { id: 'root', cwd: dir } } }
      if (id === 'other') return { complete: true, root: { header: { id: 'other', cwd: otherDir } } }
      throw new Error(`unknown session ${id}`)
    } },
    llm: { stream: () => (async function * () {
      yield { type: 'text-delta', text: JSON.stringify({ outcome: 'escalate', missing: ['New judgment'] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
  }
  const audits = []
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: true }), audit: (kind, value) => audits.push({ kind, value }) })
  await broker.start()
  const a = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  const b = await broker.profileUpsert({ workspaceKey: workspace, name: 'B' })
  const foreign = await broker.profileUpsert({ workspaceKey: otherWorkspace, name: 'Foreign' })
  await broker.setSelector('root', 'agent', a.agentId)
  const remote = createDecisionRemoteService({ broker: () => broker })
  t.after(async () => {
    await broker.flush()
    rmSync(dir, { recursive: true, force: true })
    rmSync(otherDir, { recursive: true, force: true })
  })
  // Every open() must be a distinct intake: the Hook idempotency key hashes the
  // question text, so a shared default would hand back the same Case.
  let opened = 0
  async function open(question = `Which option ${++opened}?`) {
    const request = { questions: [{ id: 'q', question, options: [{ label: 'A' }, { label: 'B' }] }] }
    const verdict = await broker.hook({ agent, request })
    return broker.cases.getCase(verdict.caseId)
  }
  return { broker, remote, agent, a, b, foreign, workspace, otherWorkspace, open, audits }
}

test('remote resolves child selector writes to the root session', async t => {
  const f = await fixture(t)
  const off = await f.remote.setSelector({ sessionId: 'child', mode: 'off' })
  assert.equal(off.ok, true)
  assert.equal(f.broker.selector('root').mode, 'off')
  assert.equal(f.broker.selector('child').mode, 'off')
  const selected = await f.remote.setSelector({ sessionId: 'child', mode: 'agent', agentId: f.a.agentId })
  assert.equal(selected.ok, true)
  assert.equal(f.broker.selector('root').agentId, f.a.agentId)
  const automatic = await f.remote.setSelector({ sessionId: 'child', mode: 'auto' })
  assert.equal(automatic.ok, true)
  assert.deepEqual(automatic.value, { mode: 'auto' })
  assert.deepEqual(f.broker.selector('root'), { mode: 'auto' })
})

test('every remote Case action applies to the Case own workspace and ignores a caller-named root or workspace', async t => {
  const f = await fixture(t)
  const actions = [
    ['decide', { answers: [{ id: 'q', selected: ['A'] }] }],
    ['reassign', { agentId: f.b.agentId }],
    ['cancel', {}],
    ['retry', {}],
    ['feedback', { verb: 'rating_down' }],
    ['correction', { direction: 'Use B', scope: { workspaces: [f.workspace] }, supersedes: [] }],
    ['returnToCaller', { note: 'Re-ask with the background first' }],
  ]
  for (const [method, args] of actions) {
    const current = await f.open()
    // A foreign caller names another root session and workspace; both are dropped.
    const result = await f.remote[method]({ ...args, sessionId: 'other', workspaceKey: f.otherWorkspace, caseId: current.caseId })
    assert.equal(result.ok, true, `${method}: ${JSON.stringify(result)}`)
    const after = f.broker.cases.getCase(current.caseId)
    assert.equal(after.workspaceKey, f.workspace, `${method} must keep the Case workspace`)
    assert.equal(after.rootSessionId, 'root', `${method} must keep the Case root session`)
    assert.equal(f.audits.some(event => event.value.action === 'boundary-reject' && event.value.caseId === current.caseId), false, `${method} must not reject a user-surface action`)
  }
})

test('the Broker mutate boundary still rejects an automation caller that names a foreign context', async t => {
  const f = await fixture(t)
  const current = await f.open()
  const before = { state: current.state, feedbackState: current.feedbackState }
  await assert.rejects(
    f.broker.mutate({ action: 'decide', caseId: current.caseId, sessionId: 'other', answers: [{ id: 'q', selected: ['A'] }] }),
    error => error.code === 'OUT_OF_SCOPE',
  )
  await assert.rejects(
    f.broker.mutate({ action: 'cancel', caseId: current.caseId, workspaceKey: f.otherWorkspace }),
    error => error.code === 'OUT_OF_SCOPE',
  )
  const after = f.broker.cases.getCase(current.caseId)
  assert.deepEqual({ state: after.state, feedbackState: after.feedbackState }, before)
  assert.equal(f.audits.filter(event => event.value.action === 'boundary-reject' && event.value.caseId === current.caseId).length, 2)
})

test('remote profile state changes reach a shared identity from any workspace without leaking paths', async t => {
  const f = await fixture(t)
  // The assistant was created in another workspace; its identity is global, so
  // management from this workspace succeeds and never exposes the raw path.
  const result = await f.remote.profileSetState({ sessionId: 'root', agentId: f.foreign.agentId, state: 'disabled' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(f.broker.profiles.getProfile(f.foreign.agentId).state, 'disabled')
  assert.equal(JSON.stringify(result.value).includes(f.otherWorkspace), false)
  const read = await f.remote.agent({ sessionId: 'root', agentId: f.foreign.agentId })
  assert.equal(read.ok, true, JSON.stringify(read))
  assert.equal(read.value.agentId, f.foreign.agentId)
  assert.equal(JSON.stringify(read.value).includes(f.otherWorkspace), false)

  // The user surface is profile-level: a Case from another workspace is cancelled
  // from here and audited with the Case's own root session.
  const current = await f.open()
  const cancelled = await f.remote.cancel({ sessionId: 'other', caseId: current.caseId })
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  assert.equal(f.broker.cases.getCase(current.caseId).closing, 'cancelled')
  assert.ok(f.audits.some(event => event.kind === 'cancel' && event.value.caseId === current.caseId && event.value.rootSessionId === 'root'))
  assert.equal(f.audits.some(event => event.value.action === 'boundary-reject' && event.value.caseId === current.caseId), false)
})

test('learning reads and lifecycle writes reject foreign workspaces and Agent spoofing with metadata audit', async t => {
  const f = await fixture(t)
  const fixtureView = { broker: f.broker, workspace: f.workspace, profile: f.a }
  const source = await seedUserDecision(fixtureView, 'remote-learning-source')
  f.broker.ctx.llm.stream = () => (async function * () {
    yield { type: 'text-delta', text: JSON.stringify({ operations: [{
      op: 'add', text: 'Prefer A', scope: { workspaces: [f.workspace] }, sources: [source.caseId],
    }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const run = await f.broker.learningStart({ sessionId: 'root', agentId: f.a.agentId, requestId: 'remote-authorization' })
  const snapshotId = snapshotForRun(fixtureView, run.learningRunId).snapshot_id
  const snapshot = await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })

  for (const [method, idKey, id] of [['learningRun', 'learningRunId', run.learningRunId], ['memorySnapshot', 'snapshotId', snapshotId]]) {
    const foreign = await f.remote[method]({ sessionId: 'other', [idKey]: id })
    assert.equal(foreign.ok, false, method)
    assert.equal(foreign.error.code, 'OUT_OF_SCOPE', method)
    const spoofed = await f.remote[method]({ sessionId: 'root', agentId: f.b.agentId, [idKey]: id })
    assert.equal(spoofed.ok, false, `${method} Agent spoof`)
    assert.equal(spoofed.error.code, 'OUT_OF_SCOPE')
  }
  for (const method of ['snapshotPublish', 'snapshotReject', 'snapshotRollback']) {
    const result = await f.remote[method]({ sessionId: 'other', snapshotId, expectedRevision: snapshot.revision })
    assert.equal(result.ok, false, method)
    assert.equal(result.error.code, 'OUT_OF_SCOPE', method)
  }
  // A shared identity may start a private run from any workspace: the run freezes
  // THIS workspace's sources, so the other workspace's records stay unreadable.
  const sharedStart = await f.remote.learningStart({ sessionId: 'root', agentId: f.foreign.agentId, requestId: 'shared-start' })
  assert.equal(sharedStart.ok, true, JSON.stringify(sharedStart))
  const sharedRun = f.broker.learning.getRunById(sharedStart.value.learningRunId)
  assert.equal(sharedRun.namespaceWorkspaceKey, f.workspace)
  assert.deepEqual(sharedRun.inputFrozen.caseIds, [])
  const sharedSnapshotRow = f.broker.store.db.prepare('SELECT snapshot_id FROM memory_snapshots WHERE learning_run_id=?').get(sharedRun.learningRunId)
  if (sharedSnapshotRow) {
    const foreignRead = await f.remote.memorySnapshot({ sessionId: 'other', snapshotId: sharedSnapshotRow.snapshot_id })
    assert.equal(foreignRead.ok, false)
    assert.equal(foreignRead.error.code, 'OUT_OF_SCOPE')
  }
  assert.equal((await f.broker.memorySnapshot({ sessionId: 'root', snapshotId })).state, 'draft')
  assert.ok(f.audits.some(event => event.kind === 'learning-run' && event.value.action === 'boundary-reject'))
  assert.ok(f.audits.some(event => event.kind === 'snapshot' && event.value.action === 'boundary-reject'))
  assert.equal(JSON.stringify(f.audits).includes('Prefer A'), false)
})

test('cross-workspace actions and delivery write bounded audit facts without the question body', async t => {
  const f = await fixture(t)
  // A consult Case owns a source conversation, so its ruling produces a delivery fact.
  const consultQuestion = 'CROSS_WORKSPACE_CONSULT_BODY?'
  const consulted = await f.broker.consult({ agent: f.agent, args: { question: consultQuestion, options: [{ label: 'A' }], request_id: 'bounded-audit', authorization_class: 'A' } })
  assert.equal(consulted.outcome, 'awaiting_user')
  const decided = await f.remote.decide({ sessionId: 'other', caseId: consulted.caseId, answers: [{ id: 'question', selected: ['A'] }] })
  assert.equal(decided.ok, true, JSON.stringify(decided))
  assert.equal(decided.value.closing, 'escalated')
  // This fixture's source session has no followup channel, so delivery is reported
  // as unavailable instead of being faked.
  assert.deepEqual(decided.value.delivery, { state: 'unavailable' })

  const bounceQuestion = 'CROSS_WORKSPACE_BOUNCE_BODY?'
  const bouncedCase = await f.open(bounceQuestion)
  const bounced = await f.remote.returnToCaller({ sessionId: 'other', caseId: bouncedCase.caseId, note: 'Re-ask with the background first' })
  assert.equal(bounced.ok, true, JSON.stringify(bounced))
  assert.equal(bounced.value.state, 'awaiting_revision')
  assert.deepEqual(bounced.value.delivery, { state: 'unavailable' })

  // Every action/delivery fact is bounded: the audit projection keeps all its
  // fields (an unbounded one would be dropped) and no question body is present.
  const actionFacts = f.audits.filter(event => ['outcome', 'cancel', 'deliver', 'feedback'].includes(event.kind))
  assert.ok(actionFacts.length >= 3)
  for (const event of actionFacts) assert.deepEqual(decisionAuditPayload(event.value), event.value, JSON.stringify(event.value))
  const serialized = JSON.stringify(f.audits)
  assert.equal(serialized.includes('CROSS_WORKSPACE_CONSULT_BODY'), false)
  assert.equal(serialized.includes('CROSS_WORKSPACE_BOUNCE_BODY'), false)
  assert.ok(f.audits.some(event => event.kind === 'deliver' && event.value.caseId === consulted.caseId && event.value.rootSessionId === 'root' && event.value.ok === false))
  assert.ok(f.audits.some(event => event.kind === 'deliver' && event.value.kind === 'bounce' && event.value.caseId === bouncedCase.caseId && event.value.ok === false))
})
