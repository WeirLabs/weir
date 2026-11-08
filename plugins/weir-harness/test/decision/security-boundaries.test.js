import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { createDecisionRemoteService } from '../../src/decision/remote.js'

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
  async function open() {
    const request = { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
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
})

test('every remote Case mutation rejects a foreign root and workspace without changing the Case', async t => {
  const f = await fixture(t)
  const actions = [
    ['decide', { answers: [{ id: 'q', selected: ['A'] }] }],
    ['reassign', { agentId: f.b.agentId }],
    ['cancel', {}],
    ['retry', {}],
    ['feedback', { verb: 'rating_down' }],
    ['correction', { direction: 'Use B', scope: { workspaces: [f.otherWorkspace] }, supersedes: [] }],
  ]
  for (const [method, args] of actions) {
    const current = await f.open()
    const before = { state: current.state, agentId: current.agentId, attemptCount: current.attemptCount, feedbackState: current.feedbackState }
    const result = await f.remote[method]({ ...args, sessionId: 'other', caseId: current.caseId })
    assert.equal(result.ok, false, `${method} must reject a foreign caller`)
    assert.equal(result.error.code, 'OUT_OF_SCOPE', method)
    const after = f.broker.cases.getCase(current.caseId)
    assert.deepEqual({ state: after.state, agentId: after.agentId, attemptCount: after.attemptCount, feedbackState: after.feedbackState }, before, method)
    assert.ok(f.audits.some(event => event.kind === 'outcome' && event.value.action === 'boundary-reject' && event.value.caseId === current.caseId), `${method} must audit the rejection`)
  }
})

test('remote profile state changes cannot cross workspace boundaries', async t => {
  const f = await fixture(t)
  const result = await f.remote.profileSetState({ sessionId: 'root', agentId: f.foreign.agentId, state: 'disabled' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'OUT_OF_SCOPE')
  assert.equal(f.broker.profiles.getProfile(f.foreign.agentId).state, 'enabled')
  assert.ok(f.audits.some(event => event.kind === 'outcome' && event.value.action === 'boundary-reject' && event.value.agentId === f.foreign.agentId))
  const read = await f.remote.agent({ sessionId: 'root', agentId: f.foreign.agentId })
  assert.equal(read.ok, false)
  assert.equal(read.error.code, 'OUT_OF_SCOPE')
  assert.ok(f.audits.filter(event => event.kind === 'outcome' && event.value.action === 'boundary-reject' && event.value.agentId === f.foreign.agentId).length >= 2)
})
