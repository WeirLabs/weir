import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionProfiles } from '../../src/decision/store/profiles.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionAttempts } from '../../src/decision/store/attempts.js'

function fixture(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-broker-life-'))
  const audits = []
  const broker = new DecisionBroker({
    profileContext: { home: dir, name: 'test' },
    config: () => ({ decisionAgentsEnabled: true, decisionAgentRetentionDays: 0, ...config }),
    audit: (kind, value) => audits.push({ kind, value }),
  })
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, broker, audits, decisions: join(dir, 'weir', 'profiles', 'test', 'decisions') }
}

test('disabled and first-use enabled states do not create files until a real write', async t => {
  const { broker, decisions } = fixture(t, { decisionAgentsEnabled: false })
  await broker.start()
  assert.deepEqual(broker.status(), { available: false, enabled: false, reason: 'disabled' })
  assert.equal(existsSync(decisions), false)

  const enabled = fixture(t)
  await enabled.broker.start()
  assert.equal(enabled.broker.status().available, true)
  assert.equal(existsSync(enabled.decisions), false)
  await enabled.broker.setSelector('root', 'off')
  assert.equal(existsSync(join(enabled.decisions, 'decision.db')), true)
  assert.deepEqual({ ...enabled.broker.store.db.prepare('SELECT mode,agent_id FROM selectors WHERE root_session_id=?').get('root') }, { mode: 'off', agent_id: null })
  const profile = await enabled.broker.profileUpsert({ workspaceKey: '/repo', name: 'Tone', userDescription: 'Prefer concise copy' })
  assert.equal(existsSync(join(enabled.decisions, 'decision.db')), true)
  await enabled.broker.setSelector('root', 'agent', profile.agentId)
  assert.deepEqual(enabled.broker.selector('root'), { mode: 'agent', agentId: profile.agentId })
})

test('start recovers only interrupted work and preserves waiting states, selector and Profile', async t => {
  const { dir, broker } = fixture(t)
  const path = join(dir, 'weir', 'profiles', 'test', 'decisions', 'decision.db')
  const store = openDecisionDatabase(path)
  const profiles = new DecisionProfiles(store)
  const cases = new DecisionCases(store)
  const attempts = new DecisionAttempts(store)
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'Tone', userDescription: 'v1' })
  await profiles.setSelector('root', { mode: 'agent', agentId: profile.agentId })
  async function make(key, state) {
    let value = (await cases.createCase({ workspaceKey: '/repo', rootSessionId: 'root', entry: 'hook', agentId: profile.agentId, request: { questions: [] }, scope: { workspaces: ['/repo'] }, idempotencyKey: key })).case
    if (state === 'awaiting_user') return cases.transition({ caseId: value.caseId, expectedState: 'received', expectedRevision: value.revision, state: 'awaiting_user', awaitingReason: 'authority' })
    if (state === 'received') return value
    value = await cases.transition({ caseId: value.caseId, expectedState: 'received', expectedRevision: value.revision, state: 'evaluating' })
    if (state === 'awaiting_revision') return cases.transition({ caseId: value.caseId, expectedState: 'evaluating', expectedRevision: value.revision, state: 'awaiting_revision' })
    if (state === 'evaluating') await attempts.start({ caseId: value.caseId, agentId: profile.agentId, pins: {}, contextPackHash: key, packManifest: {} })
    return cases.getCase(value.caseId)
  }
  const waiting = await make('waiting', 'awaiting_user')
  const revision = await make('revision', 'awaiting_revision')
  const evaluating = await make('evaluating', 'evaluating')
  const received = await make('received', 'received')
  const receivedUnowned = (await cases.createCase({
    workspaceKey: '/repo', rootSessionId: 'root', entry: 'consult', agentId: null,
    request: { questions: [{ id: 'q', question: 'Choose?' }] }, scope: { workspaces: ['/repo'] }, idempotencyKey: 'received-unowned',
  })).case
  const profileBefore = profiles.getProfile(profile.agentId)
  store.close()

  await broker.start()
  assert.equal(broker.cases.getCase(waiting.caseId).state, 'awaiting_user')
  assert.equal(broker.cases.getCase(waiting.caseId).awaitingReason, 'authority')
  assert.equal(broker.cases.getCase(revision.caseId).state, 'awaiting_revision')
  assert.equal(broker.cases.getCase(evaluating.caseId).state, 'awaiting_user')
  assert.equal(broker.cases.getCase(evaluating.caseId).awaitingReason, 'interrupted')
  assert.equal(broker.cases.getCase(received.caseId).state, 'received')
  const recoveredIntake = broker.cases.getCase(receivedUnowned.caseId)
  assert.equal(recoveredIntake.state, 'awaiting_user')
  assert.equal(recoveredIntake.awaitingReason, 'interrupted')
  assert.equal(recoveredIntake.agentId, null)
  assert.equal(recoveredIntake.attemptCount, 0)
  assert.equal(broker.attempts.forCase(receivedUnowned.caseId).length, 0)
  assert.equal(broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions WHERE case_id=?').get(receivedUnowned.caseId).n, 0)
  assert.equal(broker.attempts.forCase(evaluating.caseId)[0].error.kind, 'interrupted')
  assert.equal(broker.cases.getCase(evaluating.caseId).attemptCount, 1)
  assert.deepEqual(broker.selector('root'), { mode: 'agent', agentId: profile.agentId })
  assert.deepEqual(broker.profiles.getProfile(profile.agentId), profileBefore)
})

test('recovered Auto intake replay returns interrupted waiting without rerouting or an Attempt', async t => {
  const { dir, broker } = fixture(t, { decisionAgentAutoAnswerClasses: ['A'] })
  const path = join(dir, 'weir', 'profiles', 'test', 'decisions', 'decision.db')
  const store = openDecisionDatabase(path)
  const profiles = new DecisionProfiles(store)
  const cases = new DecisionCases(store)
  await profiles.setSelector('root', { mode: 'auto', agentId: null })
  const current = (await cases.createCase({
    workspaceKey: dir, rootSessionId: 'root', entry: 'consult', agentId: null,
    request: { entry: 'consult', questions: [{ id: 'question', question: 'Choose?', options: [{ label: 'A' }] }] },
    scope: { workspaces: [dir] }, idempotencyKey: 'consult:root:interrupted-auto',
  })).case
  store.close()

  await broker.start()
  const recovered = broker.cases.getCase(current.caseId)
  assert.equal(recovered.state, 'awaiting_user')
  assert.equal(recovered.awaitingReason, 'interrupted')
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const replay = await broker.consult({ agent, args: { question: 'Choose?', options: [{ label: 'A' }], request_id: 'interrupted-auto' } })
  assert.deepEqual(replay, { outcome: 'awaiting_user', caseId: current.caseId, state: 'awaiting_user', reason: 'interrupted' })
  assert.equal(broker.cases.getCase(current.caseId).revision, recovered.revision)
  assert.equal(broker.cases.getCase(current.caseId).attemptCount, 0)
  assert.equal(broker.attempts.forCase(current.caseId).length, 0)
  assert.equal(broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions WHERE case_id=?').get(current.caseId).n, 0)
})

test('unresolvable root and storage open failure are readable and audited', async t => {
  const audits = []
  const missing = new DecisionBroker({ config: () => ({ decisionAgentsEnabled: true }), audit: (kind, value) => audits.push({ kind, value }) })
  await missing.start()
  assert.equal(missing.status().available, false)
  assert.match(missing.status().reason, /store_root_unavailable/)
  assert.ok(audits.some(event => event.value.reason?.includes('store_root_unavailable')))

  const { dir, broker } = fixture(t)
  const blocked = join(dir, 'not-a-directory')
  writeFileSync(blocked, 'x')
  broker.config = () => ({ decisionAgentsEnabled: true, decisionAgentStorePath: blocked })
  await broker.start()
  await assert.rejects(broker.profileUpsert({ workspaceKey: '/repo', name: 'Tone' }), error => error.code === 'DECISION_UNAVAILABLE')
  assert.equal(broker.status().available, false)
  assert.match(broker.status().reason, /store_open_failed/)
})
