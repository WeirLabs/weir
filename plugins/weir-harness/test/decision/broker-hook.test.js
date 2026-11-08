import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t, enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-hook-'))
  const workspace = realpathSync(dir)
  const calls = []
  const ctx = {
    llm: {
      stream: () => {
        calls.push('stream')
        return (async function * () {
          yield { type: 'text-delta', text: JSON.stringify({ outcome: 'escalate', missing: ['New judgment'] }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: enabled }) })
  await broker.start()
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const request = { questions: [{ id: 'q', question: 'Which title?', options: [{ label: 'A' }, { label: 'B' }] }] }
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, workspace, broker, agent, request, calls }
}

const counts = broker => broker.store ? ({
  cases: broker.store.db.prepare('SELECT COUNT(*) AS n FROM cases').get().n,
  routes: broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions').get().n,
}) : { cases: 0, routes: 0 }

test('Off and globally disabled bypass without Case or route samples', async t => {
  const off = await fixture(t)
  const profile = await off.broker.profileUpsert({ workspaceKey: off.workspace, name: 'A' })
  await off.broker.setSelector('root', 'agent', profile.agentId)
  await off.broker.setSelector('root', 'off')
  assert.deepEqual(await off.broker.hook({ agent: off.agent, request: off.request }), { kind: 'pass', why: 'bypass' })
  assert.deepEqual(counts(off.broker), { cases: 0, routes: 0 })

  const disabled = await fixture(t, false)
  assert.deepEqual(await disabled.broker.hook({ agent: disabled.agent, request: disabled.request }), { kind: 'pass', why: 'bypass' })
  assert.deepEqual(counts(disabled.broker), { cases: 0, routes: 0 })
  assert.equal(existsSync(join(disabled.dir, 'weir', 'profiles', 'test', 'decisions')), false)
})

test('approval, plan-review and execution-authority words bypass before Case creation', async t => {
  const { broker, agent, request, workspace } = await fixture(t)
  const selected = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  await broker.setSelector('root', 'agent', selected.agentId)
  for (const question of [
    { ...request.questions[0], intent: { kind: 'approval' } },
    { ...request.questions[0], intent: { kind: 'plan-review' } },
    { ...request.questions[0], question: 'Run this command and delete the file?' },
    { ...request.questions[0], question: 'Edit this file?' },
    { ...request.questions[0], question: 'Change config.js?' },
    { ...request.questions[0], question: 'Write settings.json?' },
    { ...request.questions[0], question: 'rm -rf build?' },
    { ...request.questions[0], question: 'git reset --hard HEAD~1?' },
  ]) {
    const result = await broker.hook({ agent, request: { questions: [question] } })
    assert.equal(result.kind, 'pass')
    assert.equal(result.why, 'bypass')
  }
  assert.deepEqual(counts(broker), { cases: 0, routes: 0 })
})

test('disabled pinned Agent creates no_route and never falls back to another Agent', async t => {
  const { broker, agent, request, calls, workspace } = await fixture(t)
  const a = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  const b = await broker.profileUpsert({ workspaceKey: workspace, name: 'B' })
  await broker.setSelector('root', 'agent', a.agentId)
  await broker.profileSetState(a.agentId, 'disabled')
  const verdict = await broker.hook({ agent, request })
  assert.equal(verdict.why, 'awaiting_user')
  const current = broker.cases.getCase(verdict.caseId)
  assert.equal(current.state, 'awaiting_user')
  assert.equal(current.awaitingReason, 'no_route')
  assert.equal(current.agentId, a.agentId)
  assert.notEqual(current.agentId, b.agentId)
  assert.equal(calls.length, 0)
  assert.equal(broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0)
})

test('usable pinned Agent writes pinned RouteDecision and enters evaluation', async t => {
  const { broker, agent, request, workspace } = await fixture(t)
  const profile = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  await broker.setSelector('root', 'agent', profile.agentId)
  const verdict = await broker.hook({ agent, request })
  const route = broker.store.db.prepare('SELECT * FROM route_decisions WHERE case_id=?').get(verdict.caseId)
  assert.equal(route.mode, 'pinned')
  assert.equal(route.chosen, profile.agentId)
  assert.equal(broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE case_id=?').get(verdict.caseId).n, 1)
  assert.equal(broker.cases.getCase(verdict.caseId).state, 'awaiting_user')
})
