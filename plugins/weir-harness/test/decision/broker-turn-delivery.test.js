import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {{mode?:string, sessionController?:any}} [options]
 */
async function fixture(t, options = {}) {
  const mode = options.mode ?? 'escalate'
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-turn-'))
  const workspace = realpathSync(dir)
  const audits = []
  const followups = []
  let started = 0
  let allStarted
  const startedPromise = new Promise(resolve => { allStarted = resolve })
  const agent = {
    id: 'root',
    session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) },
    followup: async message => { followups.push(message); if (mode === 'delivery-error') throw new Error('offline') },
  }
  // The live registry is mutable so a Case can outlive its source session: that
  // is exactly the cold-session delivery path.
  const registry = { root: agent }
  const ctx = {
    agents: { get: id => registry[id] },
    llm: { stream: options => (async function * () {
      if (mode === 'concurrency') {
        started++
        if (started === 4) allStarted()
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      const output = mode === 'return'
        ? { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add scope' }
        : { outcome: 'escalate', missing: ['New judgment'] }
      yield { type: 'text-delta', text: JSON.stringify(output) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
  }
  // A headless composition mounts no session-controller, so `get` stays absent
  // unless the case under test supplies one.
  if (options.sessionController !== undefined) {
    ctx.get = name => name === 'sessionController' ? options.sessionController : undefined
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: true, decisionAgentMaxConcurrentAttempts: 4 }), audit: (kind, value) => audits.push({ kind, value }) })
  await broker.start()
  const profile = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  await broker.setSelector('root', 'agent', profile.agentId)
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { broker, profile, agent, registry, ctx, workspace, audits, followups, startedPromise }
}

async function returnedCase(broker, profile, workspace, originSessionId, key) {
  let current = (await broker.cases.createCase({ workspaceKey: workspace, rootSessionId: 'root', originSessionId, entry: 'consult', agentId: profile.agentId, request: { questions: [] }, scope: { workspaces: [workspace] }, idempotencyKey: key })).case
  current = await broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  const attempt = await broker.attempts.start({ caseId: current.caseId, agentId: profile.agentId, pins: {}, contextPackHash: key, packManifest: {} })
  await broker.attempts.finish(attempt.attemptId, { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Add scope' })
  current = broker.cases.getCase(current.caseId)
  return broker.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_revision' })
}

test('turn-stopping closes only the current origin awaiting_revision Cases', async t => {
  const f = await fixture(t, { mode: 'return' })
  const own = await returnedCase(f.broker, f.profile, f.workspace, 'root', 'own')
  const other = await returnedCase(f.broker, f.profile, f.workspace, 'other', 'other')
  const result = await f.broker.turnStopping({ agent: f.agent })
  assert.deepEqual(result, { closed: 1 })
  assert.equal(f.broker.cases.getCase(own.caseId).closing, 'returned')
  assert.equal(f.broker.cases.getCase(own.caseId).decision.code, 'MISSING_CONTEXT')
  assert.equal(f.broker.cases.getCase(other.caseId).state, 'awaiting_revision')
})

test('consult decision delivers exactly one UserMessage and reports delivery; Hook decision does not deliver', async t => {
  const f = await fixture(t)
  const consulted = await f.broker.consult({ agent: f.agent, args: { question: 'New judgment?', request_id: 'deliver' } })
  const decided = await f.broker.decide({ caseId: consulted.caseId, answers: [{ id: 'question', selected: ['A'] }] })
  assert.deepEqual(decided.delivery, { state: 'delivered' })
  assert.equal(f.followups.length, 1)
  assert.equal(f.followups[0].role, 'user')
  assert.equal(f.followups[0].source.kind, 'weir-decision')
  assert.ok(f.followups[0].id)
  assert.ok(f.followups[0].content[0].text.includes(consulted.caseId))

  const hooked = await f.broker.hook({ agent: f.agent, request: { questions: [{ id: 'q', question: 'New judgment?' }], wait: { callId: 'hook-no-delivery' } } })
  const hookedDecided = await f.broker.decide({ caseId: hooked.caseId, answers: [{ id: 'q', selected: ['A'] }] })
  // A Hook decision has no source conversation to notify, so it carries no
  // delivery state at all.
  assert.equal(Object.hasOwn(hookedDecided, 'delivery'), false)
  assert.equal(f.followups.length, 1)
})

test('a stopped source session is resumed through sessionController.resolveAgent and receives the ruling', async t => {
  const resumedFollowups = []
  const resumed = {
    id: 'root',
    session: { header: { id: 'root', cwd: '/tmp', delegationDepth: 0 } },
    followup: async message => { resumedFollowups.push(message) },
  }
  const resolved = []
  const f = await fixture(t, {
    sessionController: { resolveAgent: async sessionId => { resolved.push(sessionId); return { agent: resumed } } },
  })
  const consulted = await f.broker.consult({ agent: f.agent, args: { question: 'Resume me?', request_id: 'cold-resume' } })
  // The session stops; the Case stays pending, exactly as after a restart.
  delete f.registry.root
  const decided = await f.broker.decide({ caseId: consulted.caseId, answers: [{ id: 'question', selected: ['A'] }] })
  assert.deepEqual(decided.delivery, { state: 'delivered' })
  assert.deepEqual(resolved, ['root'])
  assert.equal(resumedFollowups.length, 1)
  assert.ok(resumedFollowups[0].content[0].text.includes(consulted.caseId))
  // The ruling is authoritative and stays closed either way.
  assert.equal(f.broker.cases.getCase(consulted.caseId).closing, 'escalated')
  assert.ok(f.audits.some(event => event.kind === 'deliver' && event.value.ok === true && event.value.rootSessionId === 'root'))
})

test('a bounce to a stopped source session is resumed and delivered', async t => {
  const resumedFollowups = []
  const resumed = { id: 'root', session: { header: { id: 'root', cwd: '/tmp', delegationDepth: 0 } }, followup: async message => { resumedFollowups.push(message) } }
  const f = await fixture(t, { sessionController: { resolveAgent: async () => ({ agent: resumed }) } })
  const hooked = await f.broker.hook({ agent: f.agent, request: { questions: [{ id: 'q', question: 'Bounce me?' }] } })
  delete f.registry.root
  const bounced = await f.broker.returnToCaller({ caseId: hooked.caseId, note: 'Re-ask with the background first' })
  assert.equal(bounced.state, 'awaiting_revision')
  assert.deepEqual(bounced.delivery, { state: 'delivered' })
  assert.equal(resumedFollowups.length, 1)
  assert.match(JSON.stringify(resumedFollowups[0]), /Re-ask with the background first/)
})

test('no session-controller leaves the answer authoritative and reports delivery unavailable', async t => {
  const f = await fixture(t)
  const consulted = await f.broker.consult({ agent: f.agent, args: { question: 'Headless?', request_id: 'headless-cold' } })
  delete f.registry.root
  const decided = await f.broker.decide({ caseId: consulted.caseId, answers: [{ id: 'question', selected: ['A'] }] })
  assert.deepEqual(decided.delivery, { state: 'unavailable' })
  assert.equal(f.followups.length, 0)
  assert.equal(f.broker.cases.getCase(consulted.caseId).closing, 'escalated')
  assert.equal(f.broker.cases.getCase(consulted.caseId).decision.kind, 'user_decision')
  assert.ok(f.audits.some(event => event.kind === 'deliver' && event.value.ok === false && event.value.code === 'ROOT_AGENT_UNAVAILABLE'))
})

test('a failed resume reports delivery unavailable without rolling back the ruling', async t => {
  for (const sessionController of [
    { resolveAgent: async () => ({ error: new Error('session gone') }) },
    { resolveAgent: async () => { throw new Error('preset composition failed') } },
  ]) {
    const f = await fixture(t, { sessionController })
    const consulted = await f.broker.consult({ agent: f.agent, args: { question: 'Gone?', request_id: 'gone-cold' } })
    delete f.registry.root
    const decided = await f.broker.decide({ caseId: consulted.caseId, answers: [{ id: 'question', selected: ['A'] }] })
    assert.deepEqual(decided.delivery, { state: 'unavailable' })
    assert.equal(f.followups.length, 0)
    assert.equal(f.broker.cases.getCase(consulted.caseId).closing, 'escalated')
    assert.ok(f.audits.some(event => event.kind === 'deliver' && event.value.ok === false && event.value.code === 'ROOT_AGENT_UNAVAILABLE'))
  }
})

test('delivery failure preserves the authoritative closing and writes audit', async t => {
  const f = await fixture(t, { mode: 'delivery-error' })
  const consulted = await f.broker.consult({ agent: f.agent, args: { question: 'New judgment?', request_id: 'delivery-error' } })
  const closed = await f.broker.decide({ caseId: consulted.caseId, answers: [{ id: 'question', selected: ['A'] }] })
  assert.equal(closed.closing, 'escalated')
  assert.deepEqual(closed.delivery, { state: 'unavailable' })
  assert.equal(f.broker.cases.getCase(closed.caseId).decision.kind, 'user_decision')
  assert.ok(f.audits.some(event => event.kind === 'deliver' && event.value.ok === false))
})

test('four in-flight Attempts saturate the limit; fifth Hook bypasses without a Case', async t => {
  const f = await fixture(t, { mode: 'concurrency' })
  const pending = []
  for (let index = 0; index < 4; index++) {
    pending.push(f.broker.hook({ agent: f.agent, request: { questions: [{ id: `q${index}`, question: 'New judgment?' }], wait: { callId: `slot-${index}` } } }))
  }
  await f.startedPromise
  assert.equal(f.broker.activeEvaluations, 4)
  const fifth = await f.broker.hook({ agent: f.agent, request: { questions: [{ id: 'q5', question: 'New judgment?' }], wait: { callId: 'slot-5' } } })
  assert.deepEqual(fifth, { kind: 'pass', why: 'bypass' })
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 4)

  const ids = f.broker.store.db.prepare('SELECT case_id FROM cases').all().map(row => row.case_id)
  for (const caseId of ids) await f.broker.cancel({ caseId })
  const verdicts = await Promise.all(pending)
  assert.ok(verdicts.every(verdict => verdict.why === 'cancelled'))
  assert.equal(f.broker.activeEvaluations, 0)
  assert.equal(f.broker.evaluationJobs.size, 0)
  assert.equal(f.broker.store.db.prepare("SELECT COUNT(*) AS n FROM cases WHERE closing='answered'").get().n, 0)
})
