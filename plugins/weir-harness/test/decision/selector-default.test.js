import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { apply as applyPreset } from '../../src/decision/index.js'

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-selector-default-'))
  const config = {
    decisionAgentsEnabled: true,
    decisionAgentSelectorDefault: 'auto',
    decisionAgentAutoShadow: false,
    decisionAgentAutoAnswerClasses: [],
    decisionAgentRetentionDays: 0,
    ...overrides,
  }
  const options = {
    profileContext: { home: dir, name: 'test' },
    config: () => config,
  }
  const broker = new DecisionBroker(options)
  const agent = (id = 'root', header = {}) => ({
    id,
    session: { header: { id, cwd: dir, delegationDepth: 0, ...header } },
  })
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, broker, config, options, agent, database: join(dir, 'weir', 'profiles', 'test', 'decisions', 'decision.db') }
}

test('fresh enabled startup root initializes Auto and restores it after restart', async t => {
  const f = fixture(t)
  await f.broker.start()
  assert.deepEqual(f.broker.selector('root'), { mode: 'off' })
  assert.equal(existsSync(f.database), false)

  const listeners = {}
  applyPreset({
    on: (name, listener) => { listeners[name] = listener },
    get: name => name === 'weirDecisionBroker' ? f.broker : undefined,
    effect: fn => { fn(); return () => {} },
    tools: { register: () => () => {} },
  })
  await listeners['agent/created']({ agent: f.agent(), source: 'startup' })
  assert.deepEqual(f.broker.selector('root'), { mode: 'auto' })
  assert.deepEqual({ ...f.broker.store.db.prepare('SELECT mode,agent_id FROM selectors WHERE root_session_id=?').get('root') }, { mode: 'auto', agent_id: null })
  await f.broker.flush()

  const cold = new DecisionBroker(f.options)
  await cold.start()
  assert.deepEqual(cold.selector('root'), { mode: 'auto' })
  await cold.flush()
})

test('preset creation listener contains initialization errors and leaves the root Off', async t => {
  const f = fixture(t)
  const blocked = join(f.dir, 'not-a-directory')
  writeFileSync(blocked, 'x')
  f.config.decisionAgentStorePath = blocked
  const listeners = {}
  const ctx = {
    on: (name, listener) => { listeners[name] = listener },
    get: name => name === 'weirDecisionBroker' ? f.broker : undefined,
    effect: fn => { fn(); return () => {} },
    tools: { register: () => () => {} },
    logger: { warn: () => {} },
  }
  applyPreset(ctx)
  assert.equal(typeof listeners['agent/created'], 'function')
  await assert.doesNotReject(listeners['agent/created']({ agent: f.agent(), source: 'startup' }))
  assert.deepEqual(f.broker.selector('root'), { mode: 'off' })
  assert.equal(f.broker.store, undefined)
})

test('resume, replacement sources and startup children never receive default Auto', async t => {
  const f = fixture(t)
  await f.broker.start()
  for (const input of [
    { agent: f.agent('resume'), source: 'resume' },
    { agent: f.agent('clear'), source: 'clear' },
    { agent: f.agent('compact'), source: 'compact' },
    { agent: f.agent('origin-child', { origin: 'subagent' }), source: 'startup' },
    { agent: f.agent('depth-child', { delegationDepth: 1 }), source: 'startup' },
  ]) {
    assert.deepEqual(await f.broker.initializeSelectorDefault(input), { mode: 'off' })
  }
  assert.equal(existsSync(f.database), false)
  await f.broker.profileUpsert({ workspaceKey: f.dir, name: 'Existing store' })
  assert.deepEqual(await f.broker.initializeSelectorDefault({ agent: f.agent('existing-resume'), source: 'resume' }), { mode: 'off' })
  assert.equal(f.broker.store.db.prepare("SELECT 1 FROM selectors WHERE root_session_id='existing-resume'").get(), undefined)

  for (const overrides of [{ decisionAgentSelectorDefault: 'off' }, { decisionAgentsEnabled: false }]) {
    const conservative = fixture(t, overrides)
    await conservative.broker.start()
    assert.deepEqual(await conservative.broker.initializeSelectorDefault({ agent: conservative.agent(), source: 'startup' }), { mode: 'off' })
    assert.equal(existsSync(conservative.database), false)
  }
})

test('default initialization never overwrites explicit Off, Auto, Agent or unknown rows', async t => {
  const f = fixture(t)
  await f.broker.start()
  const profile = await f.broker.profileUpsert({ workspaceKey: f.dir, name: 'Tone' })
  await f.broker.setSelector('off', 'off')
  await f.broker.setSelector('auto', 'auto')
  await f.broker.setSelector('agent', 'agent', profile.agentId)
  await f.broker.store.write(db => {
    db.prepare("INSERT INTO selectors(root_session_id,mode,agent_id,updated_at) VALUES('unknown','future-mode',NULL,1)").run()
  })
  const before = f.broker.store.db.prepare('SELECT root_session_id,mode,agent_id,revision FROM selectors ORDER BY root_session_id').all().map(row => ({ ...row }))
  for (const root of ['off', 'auto', 'agent', 'unknown']) {
    await f.broker.initializeSelectorDefault({ agent: f.agent(root), source: 'startup' })
  }
  assert.deepEqual(f.broker.selector('off'), { mode: 'off' })
  assert.deepEqual(f.broker.selector('auto'), { mode: 'auto' })
  assert.deepEqual(f.broker.selector('agent'), { mode: 'agent', agentId: profile.agentId })
  assert.deepEqual(f.broker.selector('unknown'), { mode: 'off' })
  assert.deepEqual(f.broker.store.db.prepare('SELECT root_session_id,mode,agent_id,revision FROM selectors ORDER BY root_session_id').all().map(row => ({ ...row })), before)
})

test('selector writes enforce workspace boundaries without changing an open Case', async t => {
  const f = fixture(t)
  await f.broker.start()
  const a = await f.broker.profileUpsert({ workspaceKey: f.dir, name: 'A' })
  const b = await f.broker.profileUpsert({ workspaceKey: f.dir, name: 'B' })
  const foreign = await f.broker.profileUpsert({ workspaceKey: '/other', name: 'Foreign' })
  await f.broker.setSelector('root', 'agent', a.agentId, f.dir)
  await assert.rejects(f.broker.setSelector('root', 'agent', foreign.agentId, f.dir), error => error.code === 'OUT_OF_SCOPE')
  assert.deepEqual(f.broker.selector('root'), { mode: 'agent', agentId: a.agentId })

  const opened = await f.broker.cases.createCase({
    workspaceKey: f.dir, rootSessionId: 'root', originSessionId: 'root', originKind: 'root', entry: 'hook',
    agentId: a.agentId, request: { questions: [{ id: 'q', question: 'Which?' }] }, scope: { workspaces: [f.dir] },
    idempotencyKey: 'selector-change', maxAttempts: 3,
  })
  const before = f.broker.cases.getCase(opened.case.caseId)
  await f.broker.setSelector('root', 'auto', undefined, f.dir)
  await f.broker.setSelector('root', 'agent', b.agentId, f.dir)
  assert.deepEqual(f.broker.cases.getCase(opened.case.caseId), before)
  assert.equal(before.agentId, a.agentId)
})

test('overview exposes effective Auto settings and real global status without readiness claims', async t => {
  const f = fixture(t, { decisionAgentAutoAnswerClasses: ['A', 'A', 'C'], decisionAgentAutoShadow: true })
  await f.broker.start()
  const view = await f.broker.overview({ sessionId: 'root' })
  assert.deepEqual(view.auto, { answerClasses: ['A', 'C'], shadow: true })
  assert.deepEqual(view.status, { available: true, enabled: true })
  assert.deepEqual(view.selector, { mode: 'off' })
  assert.equal('ready' in view.auto, false)

  view.auto.answerClasses.push('B')
  f.config.decisionAgentsEnabled = false
  const disabled = await f.broker.overview({ sessionId: 'root' })
  assert.deepEqual(disabled.auto, { answerClasses: ['A', 'C'], shadow: true })
  assert.deepEqual(disabled.status, { available: false, enabled: false, reason: 'disabled' })

  f.config.decisionAgentAutoAnswerClasses = ['A', 'D']
  f.config.decisionAgentAutoShadow = 'true'
  assert.deepEqual((await f.broker.overview({ sessionId: 'root' })).auto, { answerClasses: [], shadow: false })
})
