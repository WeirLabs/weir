import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-failures-'))
  const workspace = realpathSync(dir)
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const ctx = {
    agents: { get: id => id === 'root' ? agent : undefined },
    llm: { stream: () => (async function * () {
      yield { type: 'text-delta', text: JSON.stringify({ outcome: 'escalate', missing: ['New judgment'] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: true }) })
  await broker.start()
  const profile = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  await broker.setSelector('root', 'agent', profile.agentId)
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { broker, agent, profile, workspace }
}

test('a pre-Attempt route failure becomes a failed Attempt and recoverable Hook Case', async t => {
  const f = await fixture(t)
  f.broker.cases.recordRoute = async () => { throw new Error('route write exploded') }
  const verdict = await f.broker.hook({ agent: f.agent, request: { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }] }] } })
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.why, 'awaiting_user')
  const current = f.broker.cases.getCase(verdict.caseId)
  assert.equal(current.state, 'awaiting_user')
  const attempts = f.broker.attempts.forCase(current.caseId)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].outcome, 'failed')
  assert.equal(attempts[0].error.kind, 'model_error')
})

test('an unexpected evaluator setup failure becomes a failed Attempt and recoverable consult Case', async t => {
  const f = await fixture(t)
  f.broker.evidence.candidates = () => { throw new Error('evidence read exploded') }
  const result = await f.broker.consult({ agent: f.agent, args: { question: 'Which?', options: [{ label: 'A' }], request_id: 'setup-failure' } })
  assert.equal(result.outcome, 'awaiting_user')
  const current = f.broker.cases.getCase(result.caseId)
  assert.equal(current.state, 'awaiting_user')
  const attempts = f.broker.attempts.forCase(current.caseId)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].outcome, 'failed')
  assert.equal(attempts[0].error.kind, 'model_error')
})
