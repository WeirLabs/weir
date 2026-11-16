// Router memory blindness (OpenSpec 5.5).
//
// The Auto Router may see the shared identity, the request and its metadata.
// It must never read public memory, private memory, Snapshots, principles or
// any history, even when those exist for the same shared Agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planAutoRoute, routeAuto } from '../../src/decision/router.js'
import { insertSnapshot } from './p3-fixtures.js'
import { publicAdd, publicMemoryFixture } from './public-fixtures.js'

const asked = { id: 'q', question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }] }
const scope = { workspaces: ['/repo'], paths: ['src/ui'], tags: ['decision'] }
const sessionRoute = { provider: 'p', model: 'm' }

function autoProfile(agentId) {
  return {
    agentId, name: `Agent ${agentId}`, state: 'enabled',
    scope: { paths: ['src'], tags: ['decision'] },
    userDescription: { revision: 1, text: `USER DESCRIPTION ${agentId}` },
    generatedDescription: { revision: 0, text: '' },
    modelRoute: { chain: [] },
  }
}

function capturingLlm(value) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function * () {
        yield { type: 'text-delta', text: JSON.stringify(value) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

test('the Router candidate pack is a closed identity projection', async () => {
  const llm = capturingLlm({ contract: 'router-contract/1', outcome: 'selected', agentId: 'ag_a', reason: 'Best scope fit' })
  const route = await routeAuto({
    request: { entry: 'consult', questions: [asked], context: 'Bounded task context' },
    scope,
    profiles: [autoProfile('ag_a'), autoProfile('ag_b')],
    llm, sessionRoute, timeoutMs: 1_000, maxOutputTokens: 1_600, contextBudgetTokens: 24_000,
  })
  assert.equal(route.kind, 'selected')
  assert.equal(llm.calls.length, 1)
  const payload = JSON.parse(llm.calls[0].messages[0].content[0].text)
  assert.deepEqual(Object.keys(payload).sort(), ['candidates', 'context', 'contract', 'questions'])
  for (const candidate of payload.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['agentId', 'name', 'scope', 'userDescription'])
    assert.deepEqual(Object.keys(candidate.scope).sort(), ['paths', 'tags'])
  }
  const wire = JSON.stringify(llm.calls[0])
  for (const forbidden of ['PRIVATE PRINCIPLE', 'PUBLIC GUIDANCE', 'ms_private', 'ms_public', 'origin_', 'snapshot', 'principle', '/repo/w1']) {
    assert.equal(wire.includes(forbidden), false, forbidden)
  }
  assert.deepEqual(planAutoRoute({
    request: { entry: 'consult', questions: [asked] }, scope, profiles: [autoProfile('ag_a')],
  }).candidates, [{ agentId: 'ag_a', enabled: true }])
})

test('a real Auto hook sends no memory to the Router but still sends public guidance to the evaluator', async t => {
  const f = await publicMemoryFixture(t, { decisionAgentAutoAnswer: true })
  const w1Source = await f.seedDecision({ workspaceKey: f.w1, rootSessionId: 'root1', key: 'router-w1' })
  await f.seedDecision({ workspaceKey: f.w2, rootSessionId: 'root2', key: 'router-w2' })
  insertSnapshot(f, 'ms_private_router', 1, 'published', {
    principles: [{ principleId: 'pr_private_router', text: 'PRIVATE PRINCIPLE TEXT', scope: { workspaces: [f.w1] }, sources: [w1Source.caseId], state: 'active' }],
  })
  f.respond((_options, pack) => ({ operations: [publicAdd(pack.sources.map(source => source.sourceId), { text: 'PUBLIC GUIDANCE TEXT', scope: {} })] }))
  const refreshed = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
  await f.broker.snapshotPublish({ sessionId: 'root1', snapshotId: refreshed.candidate.snapshotId, expectedRevision: refreshed.candidate.revision })

  const second = await f.broker.profileUpsert({ workspaceKey: f.w1, name: 'B', userDescription: 'Second shared assistant' })
  f.respond(options => {
    if (options.system.includes('Auto candidate router contract')) {
      return { contract: 'router-contract/1', outcome: 'selected', agentId: f.profile.agentId, reason: 'W1 has the matching history' }
    }
    return { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'No decisive evidence in this pack.' }
  })
  await f.broker.setSelector('root1', 'auto')
  const before = f.requests.length
  const verdict = await f.broker.hook({ agent: f.agents.root1, request: { questions: [asked] } })
  assert.ok(before >= 1)
  // The Router decision and the domain evaluation are the last two calls of
  // this Hook (no classifier call exists anymore).
  const tail = f.requests.slice(-2)
  const routerCall = tail.find(call => call.system.includes('Auto candidate router contract'))
  const evaluatorCall = tail.find(call => call.system.includes('Decision evaluator contract'))
  assert.ok(routerCall, 'the Router verdict is one of the last two calls')
  assert.ok(evaluatorCall, 'the domain evaluation is one of the last two calls')
  const routerWire = JSON.stringify(routerCall.messages)
  for (const forbidden of ['PUBLIC GUIDANCE TEXT', 'PRIVATE PRINCIPLE TEXT', 'ms_public', 'ms_private_router', 'origin_', f.w1, f.w2, 'pr_private_router']) {
    assert.equal(routerWire.includes(forbidden), false, forbidden)
  }
  const routerPayload = JSON.parse(routerCall.messages[0].content[0].text)
  assert.deepEqual(routerPayload.candidates.map(candidate => candidate.agentId).sort(), [f.profile.agentId, second.agentId].sort())
  assert.equal(JSON.stringify(routerPayload).includes(second.agentId), true)
  // The domain pack is the only place reviewed memory may appear.
  assert.equal(JSON.stringify(evaluatorCall.messages).includes('PUBLIC GUIDANCE TEXT'), true)

  const routeRow = f.broker.store.db.prepare("SELECT candidates_json,mode FROM route_decisions WHERE case_id=? AND mode='auto'").get(verdict.caseId)
  assert.equal(routeRow.mode, 'auto')
  const candidates = JSON.parse(routeRow.candidates_json)
  assert.deepEqual(candidates.map(candidate => candidate.agentId).sort(), [f.profile.agentId, second.agentId].sort())
  assert.equal(JSON.stringify(candidates).includes('ev_'), false)
  assert.equal(JSON.stringify(candidates).includes('pr_'), false)
})
