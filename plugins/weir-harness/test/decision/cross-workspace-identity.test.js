// Public contracts for profile-global Decision Agent identity (schema v2).
//
// One DSH profile, two real workspaces, one Decision store: the assistant
// identity is shared and selectable everywhere, while Cases, Evidence,
// Feedback, L3 and private Snapshots stay inside the workspace that produced
// them, and the public memory zone is never readable as private memory or as
// evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { createDecisionRemoteService } from '../../src/decision/remote.js'
import { evaluateGates, gateFailureOutcome } from '../../src/decision/gates.js'
import { seedUserDecision } from './p3-fixtures.js'

/** @param {import('node:test').TestContext} t */
async function dualWorkspaceFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-cross-ws-'))
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
  const ctx = {
    agents: { get: id => agents[id] },
    sessionQuery: {
      traceSession: async id => {
        if (id === 'child1') return { complete: true, root: { header: { id: 'root1', cwd: w1 } } }
        if (id === 'child2') return { complete: true, root: { header: { id: 'root2', cwd: w2 } } }
        throw new Error(`unknown session ${id}`)
      },
    },
    llm: {
      stream: () => (async function * () {
        yield { type: 'text-delta', text: JSON.stringify({ outcome: 'escalate', missing: ['Cross-workspace question'] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
  }
  const broker = new DecisionBroker({
    profileContext: { home: dir, name: 'test' },
    ctx,
    config: () => ({ decisionAgentsEnabled: true, decisionAgentRetentionDays: 0 }),
    audit: (kind, value) => audits.push({ kind, value }),
  })
  await broker.start()
  const remote = createDecisionRemoteService({ broker: () => broker, ensureRegistered: () => true })
  t.after(async () => {
    await broker.flush()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, w1, w2, broker, remote, agents, audits }
}

test('one shared identity is listed, selectable and consultable from both workspaces', async t => {
  const f = await dualWorkspaceFixture(t)
  const created = await f.remote.profileUpsert({ sessionId: 'root1', name: 'Taste', userDescription: 'Prefer concise copy' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const agentId = created.value.agentId

  // The raw workspace key/realpath is not part of the identity payload.
  assert.equal(Object.hasOwn(created.value, 'workspaceKey'), false)
  assert.equal(JSON.stringify(created.value).includes(f.w1), false)
  assert.equal(JSON.stringify(created.value).includes(f.w2), false)

  // The same assistant is listed for the second workspace.
  const listed = await f.remote.agents({ sessionId: 'root2' })
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.value.map(profile => profile.agentId), [agentId])

  // Profile-global case-insensitive name uniqueness, enforced from any workspace.
  const duplicate = await f.remote.profileUpsert({ sessionId: 'root2', name: 'taste' })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error.code, 'PROFILE_NAME_TAKEN')
  assert.equal((await f.remote.agents({ sessionId: 'root2' })).value.length, 1)

  // Selectable from W2 and read back from the W2 root session.
  const selected = await f.remote.setSelector({ sessionId: 'root2', mode: 'agent', agentId })
  assert.equal(selected.ok, true, JSON.stringify(selected))
  assert.deepEqual(f.broker.selector('root2'), { mode: 'agent', agentId })

  // Consultable from W2: a shared identity is never "unavailable for this workspace".
  const verdict = await f.broker.hook({
    agent: f.agents.root2,
    request: { questions: [{ id: 'q', question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }] }] },
  })
  assert.notEqual(verdict.why, undefined)
  const opened = f.broker.cases.getCase(verdict.caseId)
  assert.equal(opened.workspaceKey, f.w2)
  assert.equal(opened.agentId, agentId)

  // Detail read from W2 includes the identity but no absolute workspace path.
  const detail = await f.remote.agent({ sessionId: 'root2', agentId })
  assert.equal(detail.ok, true, JSON.stringify(detail))
  assert.equal(detail.value.agentId, agentId)
  assert.equal(JSON.stringify(detail.value).includes(f.w1), false)
})

test('private records, evidence and snapshots stay inside the workspace that produced them', async t => {
  const f = await dualWorkspaceFixture(t)
  const profile = (await f.remote.profileUpsert({ sessionId: 'root1', name: 'Taste' })).value
  const source = await seedUserDecision(
    { broker: f.broker, workspace: f.w1, profile },
    'cross-workspace-private',
  )

  // W1 evidence is never a W2 candidate, even though the identity is shared.
  const w1Candidates = f.broker.evidence.candidates({ agentId: profile.agentId, workspaceKey: f.w1, scope: { workspaces: [f.w1] } })
  const w2Candidates = f.broker.evidence.candidates({ agentId: profile.agentId, workspaceKey: f.w2, scope: { workspaces: [f.w2] } })
  assert.ok(w1Candidates.length > 0)
  assert.deepEqual(w2Candidates, [])

  // The W1 Case never appears in W2 record reads.
  const records = await f.remote.records({ sessionId: 'root2' })
  assert.equal(records.ok, true)
  assert.deepEqual(records.value.records.map(record => record.caseId), [])

  // A private learning run keeps its workspace namespace: W2 cannot read it.
  f.broker.ctx.llm.stream = () => (async function * () {
    yield { type: 'text-delta', text: JSON.stringify({ operations: [{
      op: 'add', text: 'Prefer A', scope: { workspaces: [f.w1] }, sources: [source.caseId],
    }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const run = await f.broker.learningStart({ sessionId: 'root1', agentId: profile.agentId, requestId: 'w1-private-learning' })
  const snapshotRow = f.broker.store.db.prepare('SELECT snapshot_id FROM memory_snapshots WHERE learning_run_id=?').get(run.learningRunId)
  assert.ok(snapshotRow, 'the W1 run must produce a private draft')

  const foreign = await f.remote.memorySnapshot({ sessionId: 'root2', snapshotId: snapshotRow.snapshot_id })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.error.code, 'OUT_OF_SCOPE')

  // The workspace-private snapshot is reported for W1 only.
  const w1Detail = await f.remote.agent({ sessionId: 'root1', agentId: profile.agentId })
  const w2Detail = await f.remote.agent({ sessionId: 'root2', agentId: profile.agentId })
  assert.equal(w1Detail.ok, true)
  assert.equal(w2Detail.ok, true)
  assert.equal(w2Detail.value.currentSnapshotId, null)
  assert.equal(w1Detail.value.currentSnapshotId, null, 'a draft candidate is not the current snapshot')

  // W2 retrieval starts from an empty private L5/L3/L2 even with a shared identity.
  const retrieval = f.broker.retriever.retrieve({
    agentId: profile.agentId, workspaceKey: f.w2,
    scope: { workspaces: [f.w2] }, attemptStartedAt: 1,
  })
  assert.deepEqual(retrieval.L5, [])
  assert.deepEqual(retrieval.L3, [])
  assert.equal(retrieval.L2.status, 'empty')
})

test('the public memory zone is never the private snapshot, never L5, and cannot be an Evidence Ref', async t => {
  const f = await dualWorkspaceFixture(t)
  const profile = (await f.remote.profileUpsert({ sessionId: 'root1', name: 'Taste' })).value
  const principleId = 'pr_public_only'

  // A published public-zone snapshot exists for this Agent.
  f.broker.store.db.prepare(`INSERT INTO memory_snapshots(
    snapshot_id,agent_id,zone,namespace_workspace_key,version,parent_snapshot_id,state,principles_json,
    generated_description_json,learning_run_id,created_at,updated_at,revision,schema_version
  ) VALUES(?,?,?,NULL,1,NULL,'published',?,?,?,?,?,1,1)`).run(
    'ms_public_only', profile.agentId, 'public',
    JSON.stringify([{ principleId, text: 'Prefer A across projects', scope: { paths: ['src'] }, sources: ['case_elsewhere'], state: 'active' }]),
    JSON.stringify({ revision: 0, text: '' }), 'lr_public_only', 10, 10,
  )

  // It is not the private current snapshot and never enters the private L2/L5.
  assert.equal(f.broker.learning.currentSnapshot(profile.agentId, f.w1), null)
  const retrieval = f.broker.retriever.retrieve({
    agentId: profile.agentId, workspaceKey: f.w1, scope: { workspaces: [f.w1] }, attemptStartedAt: 1,
  })
  assert.equal(retrieval.L2.status, 'empty')
  assert.deepEqual(retrieval.L5, [])
  // Phase B reads the public zone as reviewed guidance only: this principle is
  // path-scoped, so a workspace-level request omits it with a recorded reason and
  // it never appears in the private partition or the eligible L5 set.
  assert.equal(retrieval.L2_PUBLIC.status, 'empty')
  assert.deepEqual(retrieval.L2_PUBLIC.exclusions, [{ principleId, reason: 'OUT_OF_SCOPE' }])
  assert.equal(retrieval.L2.items.some(item => item.principleId === principleId), false)
  assert.equal(JSON.stringify(retrieval.L5).includes(principleId), false)

  // Citing the public principle as a decision basis fails G1: guidance is not evidence.
  const gates = evaluateGates({
    claims: [{ evidenceIds: [principleId] }],
    answers: [], questions: [{ id: 'q', options: [{ label: 'A' }] }],
    evidence: [], packEvidenceIds: [],
    profile: { agentId: profile.agentId, scope: {} },
    workspaceKey: f.w1, scope: { workspaces: [f.w1] },
    attemptStartedAt: 1,
  })
  assert.equal(gates.g1, false)
  assert.equal(gateFailureOutcome(gates).outcome, 'return')
  assert.equal(gateFailureOutcome(gates).reasonCode, 'MISSING_CONTEXT')
})
