// Profile-level user surface (OpenSpec decision-pending-overview D1/D4/D6): one
// decision page lists the pending Cases of every workspace in the profile,
// labels a stopped source session, and never ships a raw workspace path to the
// client. Automation reads stay workspace-scoped and are covered elsewhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-inbox-'))
  const [w1, w2] = ['w1', 'w2'].map(name => {
    const path = join(dir, name)
    mkdirSync(path, { recursive: true })
    return realpathSync(path)
  })
  const agents = {
    root1: { id: 'root1', session: { header: { id: 'root1', cwd: w1, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } },
    root2: { id: 'root2', session: { header: { id: 'root2', cwd: w2, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } },
  }
  let clock = 1_000
  const ctx = { agents: { get: id => agents[id] } }
  const broker = new DecisionBroker({
    profileContext: { home: dir, name: 'test' },
    ctx,
    config: () => ({ decisionAgentsEnabled: true, decisionAgentRetentionDays: 0 }),
    now: () => ++clock,
  })
  await broker.start()
  const a = await broker.profileUpsert({ workspaceKey: w1, name: 'A' })
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  /** One pending Case, whichever root session and workspace own it. */
  async function pending(options) {
    let current = (await broker.cases.createCase({
      workspaceKey: options.workspaceKey,
      rootSessionId: options.rootSessionId,
      entry: 'hook',
      agentId: options.agentId ?? a.agentId,
      request: { questions: [{ id: 'q', question: options.question }] },
      scope: { workspaces: [options.workspaceKey] },
      idempotencyKey: options.key,
    })).case
    current = await broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'authority' })
    return current
  }
  return { broker, dir, w1, w2, a, agents, pending }
}

test('the inbox merges pending Cases from every workspace and names no raw path', async t => {
  const f = await fixture(t)
  const first = await f.pending({ workspaceKey: f.w1, rootSessionId: 'root1', question: 'FIRST_W1?', key: 'w1-first' })
  const second = await f.pending({ workspaceKey: f.w2, rootSessionId: 'root2', question: 'SECOND_W2?', key: 'w2-second' })
  // A third pending Case whose source session is not running (no live Agent).
  const cold = await f.pending({ workspaceKey: f.w2, rootSessionId: 'root3', question: 'COLD_W2?', key: 'w2-cold' })

  const inbox = await f.broker.inbox()
  // Both workspaces are in one list, newest first.
  assert.deepEqual(inbox.map(item => item.caseId), [cold.caseId, second.caseId, first.caseId])
  assert.deepEqual(inbox.map(item => item.rootSessionId), ['root3', 'root2', 'root1'])
  // `sourceActive` is the live-Agent fact the client may label, never a gate.
  assert.deepEqual(inbox.map(item => item.sourceActive), [false, true, true])
  // The payload rule: the aggregated list never names another workspace's key, so
  // the client resolves the workspace name from the source session instead.
  for (const item of inbox) assert.equal(Object.hasOwn(item, 'workspaceKey'), false)
  assert.equal(JSON.stringify(inbox).includes('"workspaceKey"'), false)
  // Every item stays a complete Case projection, so the card can render it.
  for (const item of inbox) {
    assert.equal(item.state, 'awaiting_user')
    assert.equal(item.entry, 'hook')
    assert.equal(typeof item.updatedAt, 'number')
    assert.ok(item.request.questions[0].question.length > 0)
  }
})

test('an empty or disabled store reads as an empty inbox', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.broker.inbox(), [])
  const cold = new DecisionBroker({ profileContext: { home: f.dir, name: 'other' }, ctx: { agents: { get: () => undefined } }, config: () => ({ decisionAgentsEnabled: true }) })
  assert.deepEqual(await cold.inbox(), [])
})

test('a pending Case carries its latest non-Shadow route status, never the reason text', async t => {
  const f = await fixture(t)
  const routed = await f.pending({ workspaceKey: f.w2, rootSessionId: 'root2', question: 'ROUTED_W2?', key: 'routed' })
  const bare = await f.pending({ workspaceKey: f.w1, rootSessionId: 'root1', question: 'BARE_W1?', key: 'bare' })
  await f.broker.cases.recordRoute({ caseId: routed.caseId, rootSessionId: 'root2', mode: 'auto_shadow', candidates: [], reason: 'failure:truncated' })
  await f.broker.cases.recordRoute({ caseId: routed.caseId, rootSessionId: 'root2', mode: 'auto', candidates: [], reason: 'failure:timeout' })
  const inbox = await f.broker.inbox()
  const routedItem = inbox.find(item => item.caseId === routed.caseId)
  const bareItem = inbox.find(item => item.caseId === bare.caseId)
  // The Shadow sample never overrides the real routing outcome.
  assert.equal(routedItem.routeStatus, 'failure')
  assert.equal(Object.hasOwn(bareItem, 'routeStatus'), false)
  assert.equal(JSON.stringify(inbox).includes('timeout'), false)
})

test('the record detail is keyed by Case id alone, wherever the Case lives', async t => {
  const f = await fixture(t)
  const other = await f.pending({ workspaceKey: f.w2, rootSessionId: 'root2', question: 'OTHER_W2?', key: 'other-detail' })
  const detail = await f.broker.record({ caseId: other.caseId })
  assert.equal(detail.case.caseId, other.caseId)
  assert.equal(detail.case.rootSessionId, 'root2')
  assert.equal(detail.case.state, 'awaiting_user')
  assert.deepEqual(detail.attempts, [])
  assert.equal(await f.broker.record({ caseId: 'dc_missing_case' }), null)
  // Automation reads keep their workspace scope: this read names another root.
  assert.deepEqual((await f.broker.records({ sessionId: 'root1' })).records.map(row => row.caseId), [])
})
