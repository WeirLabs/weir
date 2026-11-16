// Profile-level judgment history (OpenSpec decision-records-profile-history
// D1/D2/D3): one list covers every root session of the profile, the source
// summary rides the first page only, and a row never carries the raw workspace
// key. A caller that names its session — the export and the internal readers —
// keeps the root scope it asks for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-records-'))
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
  const broker = new DecisionBroker({
    profileContext: { home: dir, name: 'test' },
    ctx: { agents: { get: id => agents[id] } },
    config: () => ({ decisionAgentsEnabled: true, decisionAgentRetentionDays: 0 }),
    now: () => ++clock,
  })
  await broker.start()
  const a = await broker.profileUpsert({ workspaceKey: w1, name: 'A' })
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  /** One closed Case, whichever root session and workspace own it. */
  async function closed(options) {
    let current = (await broker.cases.createCase({
      workspaceKey: options.workspaceKey,
      rootSessionId: options.rootSessionId,
      entry: 'hook',
      agentId: a.agentId,
      request: { questions: [{ id: 'q', question: options.question }] },
      scope: { workspaces: [options.workspaceKey] },
      idempotencyKey: options.key,
    })).case
    current = await broker.cases.transition({
      caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision,
      state: 'closed', closing: 'cancelled', decision: { kind: 'cancelled' },
    })
    return current
  }
  return { broker, dir, w1, w2, a, agents, closed }
}

test('judgment records list every root session of the profile and name no raw workspace', async t => {
  const f = await fixture(t)
  const first = await f.closed({ workspaceKey: f.w1, rootSessionId: 'root1', question: 'FIRST_W1?', key: 'w1-first' })
  const second = await f.closed({ workspaceKey: f.w2, rootSessionId: 'root2', question: 'SECOND_W2?', key: 'w2-second' })

  const page = await f.broker.records({})
  assert.deepEqual(page.records.map(row => row.caseId), [second.caseId, first.caseId])
  assert.deepEqual(page.records.map(row => row.rootSessionId), ['root2', 'root1'])
  // The payload rule: a row never names another workspace's key, so the client
  // resolves the workspace name from the Case's own root session.
  for (const row of page.records) assert.equal(Object.hasOwn(row, 'workspaceKey'), false)
  assert.equal(JSON.stringify(page.records).includes('"workspaceKey"'), false)
  // The first page carries the source summary the filter menu is built from.
  assert.deepEqual(page.sources.map(source => [source.sessionId, source.count]), [['root2', 1], ['root1', 1]])
  assert.equal(page.nextCursor, null)
})

test('the source summary rides the first page only and an appended page carries none', async t => {
  const f = await fixture(t)
  await f.closed({ workspaceKey: f.w1, rootSessionId: 'root1', question: 'PAGE_ONE?', key: 'page-one' })
  await f.closed({ workspaceKey: f.w2, rootSessionId: 'root2', question: 'PAGE_TWO?', key: 'page-two' })

  const first = await f.broker.records({ cursor: { limit: 1 } })
  assert.equal(first.records.length, 1)
  assert.ok(first.nextCursor)
  assert.deepEqual(first.sources.map(source => source.count), [1, 1])
  const second = await f.broker.records({ cursor: { after: first.nextCursor, limit: 1 } })
  assert.equal(second.records.length, 1)
  assert.equal(second.nextCursor, null)
  // No second grouping query for a page that cannot change the menu.
  assert.equal(Object.hasOwn(second, 'sources'), false)
})

test('a session-named read keeps its root scope while the profile read needs no live session', async t => {
  const f = await fixture(t)
  const mine = await f.closed({ workspaceKey: f.w1, rootSessionId: 'root1', question: 'MINE_W1?', key: 'mine' })
  const other = await f.closed({ workspaceKey: f.w2, rootSessionId: 'root2', question: 'OTHER_W2?', key: 'other' })

  // The export and the internal readers name their root: still one root only.
  const scoped = await f.broker.records({ sessionId: 'root1' })
  assert.deepEqual(scoped.records.map(row => row.caseId), [mine.caseId])
  // The source filter narrows the profile read to one root session.
  const filtered = await f.broker.records({ filter: { sessionId: 'root2' } })
  assert.deepEqual(filtered.records.map(row => row.caseId), [other.caseId])
  // With no live Agent left for either root, the profile read still answers: it
  // resolves no session context at all.
  delete f.agents.root1
  delete f.agents.root2
  assert.deepEqual((await f.broker.records({})).records.map(row => row.caseId), [other.caseId, mine.caseId])
  await assert.rejects(f.broker.records({ sessionId: 'root1' }), error => error.code === 'INCOMPLETE_LINEAGE')
})

test('a missing store keeps the list shape with an empty source summary', async t => {
  const f = await fixture(t)
  const cold = new DecisionBroker({
    profileContext: { home: join(f.dir, 'cold'), name: 'other' },
    ctx: { agents: { get: () => undefined } },
    config: () => ({ decisionAgentsEnabled: true }),
  })
  assert.deepEqual(await cold.records({}), { records: [], nextCursor: null, sources: [] })
})
