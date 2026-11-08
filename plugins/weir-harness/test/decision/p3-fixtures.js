import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

export async function brokerFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-p3-'))
  const workspace = realpathSync(dir)
  const config = { decisionAgentsEnabled: true, decisionAgentRetentionDays: 0 }
  const requests = []
  let respond = () => ({ operations: [] })
  const agent = {
    id: 'root',
    session: {
      header: { id: 'root', cwd: workspace, delegationDepth: 0 },
      requestContext: () => ({ provider: 'p', model: 'm' }),
    },
  }
  const ctx = {
    agents: { get: id => id === 'root' ? agent : undefined },
    llm: {
      stream: options => {
        requests.push(options)
        return (async function * () {
          const output = await respond(options)
          yield { type: 'text-delta', text: typeof output === 'string' ? output : JSON.stringify(output) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const broker = new DecisionBroker({
    profileContext: { home: dir, name: 'test' }, ctx,
    config: () => config, now: () => 1_000,
  })
  await broker.start()
  const profile = await broker.profileUpsert({ workspaceKey: workspace, name: 'A', userDescription: 'Prefer concise copy' })
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return {
    dir, workspace, config, ctx, agent, broker, profile, requests,
    respond: fn => { respond = fn },
  }
}

export async function seedUserDecision(f, key, options = {}) {
  const workspaceKey = options.workspaceKey ?? f.workspace
  const agentId = options.agentId ?? f.profile.agentId
  const scope = options.scope ?? { workspaces: [workspaceKey] }
  let current = (await f.broker.cases.createCase({
    workspaceKey, rootSessionId: 'root', entry: 'hook', agentId,
    request: {
      entry: 'hook',
      questions: [{ id: 'q', question: options.question ?? `Question ${key}`, options: [{ label: 'A' }, { label: 'B' }] }],
      ...(options.taskSummary ? { taskSummary: options.taskSummary } : {}),
    },
    scope, idempotencyKey: key,
  })).case
  current = await f.broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user' })
  return f.broker.cases.transition({
    caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision,
    state: 'closed', closing: 'escalated',
    decision: { kind: 'user_decision', answers: [{ id: 'q', selected: [options.selected ?? 'A'] }] },
  })
}

/** Build a real validated agent_record Evidence owner through public stores. */
export async function seedValidatedAnswer(f, key, options = {}) {
  const workspaceKey = options.workspaceKey ?? f.workspace
  const agentId = options.agentId ?? f.profile.agentId
  const scope = options.scope ?? { workspaces: [workspaceKey] }
  let current = (await f.broker.cases.createCase({
    workspaceKey, rootSessionId: 'root', entry: 'hook', agentId,
    request: { entry: 'hook', questions: [{ id: 'q', question: options.question ?? `Question ${key}`, options: [{ label: 'A' }, { label: 'B' }] }] },
    scope, idempotencyKey: key,
  })).case
  current = await f.broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  const attempt = await f.broker.attempts.start({
    caseId: current.caseId, agentId, pins: {}, contextPackHash: `hash-${key}`, packManifest: {},
  })
  await f.broker.attempts.finish(attempt.attemptId, { outcome: 'answer', citedEvidenceIds: [] })
  current = f.broker.cases.getCase(current.caseId)
  current = await f.broker.cases.transition({
    caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision,
    state: 'closed', closing: 'answered',
    decision: { kind: 'answer', attemptId: attempt.attemptId, answers: [{ id: 'q', selected: [options.selected ?? 'A'] }], decidedAt: f.broker.now() },
  })
  await f.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: current.caseId, attemptId: attempt.attemptId, kind: 'rating_up' })
  return f.broker.cases.getCase(current.caseId)
}

export function validAdd(f, sources, overrides = {}) {
  return {
    op: 'add', principleId: 'temporary-add', text: 'Prefer A for this question',
    scope: { workspaces: [f.workspace] }, sources, ...overrides,
  }
}

export function frozenInput(f, overrides = {}) {
  return {
    requestId: 'req-fixture', workspaceKey: f.workspace, startedAt: 1_000,
    agentProfileRevision: f.profile.revision, caseIds: [], feedbackIds: [], revisions: {},
    feedbackDigest: '0'.repeat(64), parentSnapshotId: null, parentSnapshotRevision: null,
    promptVersion: 'consolidation-contract/1',
    modelRoute: { kind: 'inherited', provider: 'p', model: 'm' }, inputHash: '0'.repeat(64),
    ...overrides,
  }
}

export function insertLearningRun(f, learningRunId, outcome = 'candidate', overrides = {}) {
  f.broker.store.db.prepare(`INSERT INTO learning_runs(
    learning_run_id,agent_id,trigger,input_frozen_json,operations_json,replay_json,outcome,
    created_at,updated_at,revision,schema_version
  ) VALUES(?,?,?,?,?,?,?,1,1,?,?)`).run(
    learningRunId, overrides.agentId ?? f.profile.agentId, 'manual',
    JSON.stringify(overrides.inputFrozen ?? frozenInput(f)), JSON.stringify(overrides.operations ?? []),
    overrides.replay === undefined ? null : JSON.stringify(overrides.replay), outcome,
    overrides.revision ?? 1, overrides.schemaVersion ?? 1,
  )
  return learningRunId
}

export function insertSnapshot(f, snapshotId, version, state = 'draft', overrides = {}) {
  const learningRunId = overrides.learningRunId ?? `lr_${snapshotId}`
  const exists = f.broker.store.db.prepare('SELECT 1 FROM learning_runs WHERE learning_run_id=?').get(learningRunId)
  if (!exists) insertLearningRun(f, learningRunId, state === 'draft' ? 'candidate' : state)
  f.broker.store.db.prepare(`INSERT INTO memory_snapshots(
    snapshot_id,agent_id,version,parent_snapshot_id,state,principles_json,generated_description_json,
    learning_run_id,created_at,updated_at,revision,schema_version
  ) VALUES(?,?,?,?,?,?,?,?,1,1,?,?)`).run(
    snapshotId, overrides.agentId ?? f.profile.agentId, version, overrides.parentSnapshotId ?? null, state,
    JSON.stringify(overrides.principles ?? []),
    JSON.stringify(overrides.generatedDescription ?? { revision: 0, text: '' }), learningRunId,
    overrides.revision ?? 1, overrides.schemaVersion ?? 1,
  )
  return snapshotId
}

export function snapshotForRun(f, learningRunId) {
  return f.broker.store.db.prepare('SELECT snapshot_id FROM memory_snapshots WHERE learning_run_id=?').get(learningRunId)
}
