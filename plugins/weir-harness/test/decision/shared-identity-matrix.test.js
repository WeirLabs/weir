// Shared-identity lifecycle matrix across two real workspaces in one profile.
//
// Covers the surfaces that used to reject a workspace mismatch: consult, Hook,
// explicit-vs-pinned priority, disable, archive, name conflicts and restart.
// Record-level isolation is asserted here too, so a shared identity can never be
// mistaken for shared history.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {{config?: Record<string, any>}} [options]
 */
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-shared-matrix-'))
  const workspaces = ['w1', 'w2'].map(name => {
    const path = join(dir, name)
    mkdirSync(path, { recursive: true })
    return realpathSync(path)
  })
  const [w1, w2] = workspaces
  const agents = {
    root1: { id: 'root1', session: { header: { id: 'root1', cwd: w1, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } },
    root2: { id: 'root2', session: { header: { id: 'root2', cwd: w2, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } },
  }
  const audits = []
  const config = {
    decisionAgentsEnabled: true, decisionAgentRetentionDays: 0,
    decisionAgentAutoAnswerClasses: [], ...options.config,
  }
  const brokerFor = () => new DecisionBroker({
    profileContext: { home: dir, name: 'test' },
    ctx: {
      agents: { get: id => agents[id] },
      sessionQuery: { traceSession: async () => { throw new Error('no lineage in this fixture') } },
      llm: { stream: () => (async function * () {
        yield { type: 'text-delta', text: JSON.stringify({ outcome: 'escalate', missing: ['Shared identity question'] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })() },
    },
    config: () => config,
    audit: (kind, value) => audits.push({ kind, value }),
  })
  const broker = brokerFor()
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, w1, w2, agents, audits, config, broker, brokerFor }
}

const request = id => ({ questions: [{ id, question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }] }] })

test('a shared identity consults and hooks from both workspaces while cases keep their own workspace', async t => {
  const f = await fixture(t)
  await f.broker.start()
  const shared = await f.broker.profileUpsert({ name: 'Shared' })
  await f.broker.setSelector('root1', 'agent', shared.agentId)

  const w1 = await f.broker.hook({ agent: f.agents.root1, request: request('w1-hook') })
  assert.equal(f.broker.cases.getCase(w1.caseId).workspaceKey, f.w1)
  assert.equal(f.broker.cases.getCase(w1.caseId).agentId, shared.agentId)

  // The same assistant answers (here: escalates) for the second workspace.
  await f.broker.setSelector('root2', 'agent', shared.agentId)
  const w2 = await f.broker.hook({ agent: f.agents.root2, request: request('w2-hook') })
  assert.equal(f.broker.cases.getCase(w2.caseId).workspaceKey, f.w2)
  assert.equal(f.broker.cases.getCase(w2.caseId).agentId, shared.agentId)

  // Explicit consult from the other workspace needs no workspace match either.
  const explicit = await f.broker.consult({ agent: f.agents.root2, args: { question: 'Explicit?', agent_id: shared.agentId, request_id: 'explicit-shared' } })
  assert.equal(f.broker.cases.getCase(explicit.caseId).workspaceKey, f.w2)

  // Record reads stay scoped to the calling root session and its workspace.
  assert.deepEqual(f.broker.query.records({ sessionId: 'root1' }).records.map(record => record.caseId), [w1.caseId])
  assert.deepEqual(f.broker.query.records({ sessionId: 'root2' }).records.map(record => record.caseId).sort(), [w2.caseId, explicit.caseId].sort())
})

test('explicit Agent outranks the pinned selector, and disabling or archiving fails closed without reassignment', async t => {
  const f = await fixture(t)
  await f.broker.start()
  const pinned = await f.broker.profileUpsert({ name: 'Pinned' })
  const other = await f.broker.profileUpsert({ name: 'Other' })
  await f.broker.setSelector('root2', 'agent', pinned.agentId)

  const explicit = await f.broker.consult({ agent: f.agents.root2, args: { question: 'Explicit?', agent_id: other.agentId, request_id: 'explicit-priority' } })
  assert.equal(f.broker.cases.getCase(explicit.caseId).agentId, other.agentId)

  const pinnedRun = await f.broker.hook({ agent: f.agents.root2, request: request('pinned-hook') })
  assert.equal(f.broker.cases.getCase(pinnedRun.caseId).agentId, pinned.agentId)

  // Disabled: no automatic answer, no silent reassignment to the other shared
  // assistant — the native question goes back to the user.
  await f.broker.profileSetState(pinned.agentId, 'disabled')
  const disabled = await f.broker.hook({ agent: f.agents.root2, request: request('disabled-hook') })
  assert.equal(disabled.kind, 'pass')
  assert.equal(disabled.why, 'awaiting_user')
  const blocked = f.broker.cases.getCase(disabled.caseId)
  assert.equal(blocked.state, 'awaiting_user')
  assert.equal(blocked.awaitingReason, 'no_route')
  assert.equal(blocked.agentId, pinned.agentId)
  const route = f.broker.store.db.prepare('SELECT candidates_json,chosen,mode FROM route_decisions WHERE case_id=?').get(disabled.caseId)
  assert.equal(route.chosen, null)
  assert.equal(route.mode, 'none')
  assert.deepEqual(JSON.parse(route.candidates_json), [{ agentId: pinned.agentId, enabled: false, rejectedBecause: 'pinned_agent_unavailable' }])
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE case_id=?').get(disabled.caseId).n, 0)
  await assert.rejects(
    f.broker.consult({ agent: f.agents.root2, args: { question: 'Q', agent_id: pinned.agentId } }),
    error => error.code === 'AGENT_UNAVAILABLE',
  )
  assert.ok(f.audits.some(event => event.kind === 'outcome' && event.value.action === 'boundary-reject' && event.value.agentId === pinned.agentId))

  // Archived: it stays visible read-only in management but can never be selected
  // again, and its history is untouched.
  await f.broker.profileSetState(pinned.agentId, 'archived')
  const managed = new Map((await f.broker.agents({ sessionId: 'root2' })).map(profile => [profile.agentId, profile.state]))
  assert.equal(managed.get(pinned.agentId), 'archived')
  assert.equal(managed.get(other.agentId), 'enabled')
  assert.equal(f.broker.cases.getCase(pinnedRun.caseId).agentId, pinned.agentId)
  await assert.rejects(f.broker.setSelector('root2', 'agent', pinned.agentId), error => error.code === 'AGENT_UNAVAILABLE')
  await assert.rejects(
    f.broker.consult({ agent: f.agents.root2, args: { question: 'Q', agent_id: pinned.agentId } }),
    error => error.code === 'AGENT_UNAVAILABLE',
  )
})

test('names stay profile-unique, both identities survive a conflict, and both restore after restart', async t => {
  const f = await fixture(t)
  await f.broker.start()
  const first = await f.broker.profileUpsert({ name: 'Copy tone', userDescription: 'v1' })
  await assert.rejects(f.broker.profileUpsert({ name: 'copy TONE' }), error => error.code === 'PROFILE_NAME_TAKEN')
  const second = await f.broker.profileUpsert({ name: 'Copy tone · 2' })
  assert.notEqual(first.agentId, second.agentId)
  await f.broker.setSelector('root1', 'agent', first.agentId)
  await f.broker.setSelector('root2', 'agent', second.agentId)
  await f.broker.flush()

  const cold = f.brokerFor()
  t.after(async () => { await cold.flush() })
  await cold.start()
  assert.deepEqual(cold.profiles.listProfiles({ includeArchived: true }).map(profile => profile.agentId).sort(), [first.agentId, second.agentId].sort())
  assert.deepEqual(cold.selector('root1'), { mode: 'agent', agentId: first.agentId })
  assert.deepEqual(cold.selector('root2'), { mode: 'agent', agentId: second.agentId })
  // The identity keeps its user-written description revision across workspaces.
  assert.deepEqual(cold.profiles.getProfile(first.agentId).userDescription, { revision: 1, text: 'v1' })
  assert.equal(JSON.stringify(cold.profiles.listProfiles()).includes(f.w1), false)
})
