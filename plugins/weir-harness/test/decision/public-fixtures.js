// Fixtures for the cross-workspace public memory zone (Phase B).
//
// One DSH profile, one Decision store, two real workspaces, two root sessions.
// The assistant identity is shared; every private record still belongs to the
// workspace that produced it, while the public zone reads eligible sources from
// both workspaces through the Host-internal extraction port.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { publicSourceHighWater } from '../../src/decision/learning/namespace.js'

/** Parse the JSON payload the model actually received. */
export function packOf(options) {
  const content = options.messages[0].content
  return JSON.parse(typeof content === 'string' ? content : content[0].text)
}

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, any>} [overrides]
 */
export async function publicMemoryFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-public-'))
  const workspaces = ['w1', 'w2', 'w3'].map(name => {
    const path = join(dir, name)
    mkdirSync(path, { recursive: true })
    return realpathSync(path)
  })
  const [w1, w2, w3] = workspaces
  const config = {
    decisionAgentsEnabled: true,
    decisionAgentRetentionDays: 0,
    decisionAgentContextBudgetTokens: 24_000,
    decisionAgentLearningMaxOutputTokens: 4_000,
    decisionAgentLearningTimeoutMs: 60_000,
    ...overrides,
  }
  const requests = []
  let respond = () => ({ operations: [] })
  const audits = []
  const agents = {
    root1: { id: 'root1', session: { header: { id: 'root1', cwd: w1, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } },
    root2: { id: 'root2', session: { header: { id: 'root2', cwd: w2, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } },
    root3: { id: 'root3', session: { header: { id: 'root3', cwd: w3, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } },
  }
  const ctx = {
    agents: { get: id => agents[id] },
    llm: {
      stream: options => {
        requests.push(options)
        return (async function * () {
          const output = await respond(options, packOf(options))
          yield { type: 'text-delta', text: typeof output === 'string' ? output : JSON.stringify(output) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const broker = new DecisionBroker({
    profileContext: { home: dir, name: 'test' }, ctx,
    config: () => config, now: () => 1_000,
    audit: (kind, value) => audits.push({ kind, value }),
  })
  await broker.start()
  const profile = await broker.profileUpsert({ workspaceKey: w1, name: 'A', userDescription: 'Prefer A' })

  /** Seed a closed user_decision Case in one workspace. */
  async function seedDecision(options = {}) {
    const workspaceKey = options.workspaceKey ?? w1
    const rootSessionId = options.rootSessionId ?? (workspaceKey === w2 ? 'root2' : 'root1')
    const scope = options.scope ?? { workspaces: [workspaceKey], ...(options.paths ? { paths: [...options.paths] } : {}) }
    let current = (await broker.cases.createCase({
      workspaceKey, rootSessionId, entry: 'hook', agentId: options.agentId ?? profile.agentId,
      request: {
        entry: 'hook',
        questions: [{
          id: 'q', question: options.question ?? `Question ${options.key}`,
          options: [{ label: 'A' }, { label: 'B' }],
        }],
        ...(options.taskSummary ? { taskSummary: options.taskSummary } : {}),
      },
      scope, idempotencyKey: options.key,
    })).case
    if (options.state === 'awaiting_user') {
      return broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'evidence' })
    }
    current = await broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user' })
    current = await broker.cases.transition({
      caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision,
      state: 'closed', closing: 'escalated',
      decision: { kind: 'user_decision', answers: [{ id: 'q', selected: [options.selected ?? 'A'] }] },
    })
    if (options.feedback) await broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: current.caseId, kind: options.feedback, ...(options.feedbackPayload ? { payload: options.feedbackPayload } : {}) })
    return broker.cases.getCase(current.caseId)
  }

  /** Seed a closed answered Case that only becomes authoritative after a rating up. */
  async function seedValidated(options = {}) {
    const workspaceKey = options.workspaceKey ?? w1
    const rootSessionId = options.rootSessionId ?? (workspaceKey === w2 ? 'root2' : 'root1')
    const scope = options.scope ?? { workspaces: [workspaceKey] }
    let current = (await broker.cases.createCase({
      workspaceKey, rootSessionId, entry: 'hook', agentId: options.agentId ?? profile.agentId,
      request: { entry: 'hook', questions: [{ id: 'q', question: options.question ?? `Question ${options.key}`, options: [{ label: 'A' }, { label: 'B' }] }] },
      scope, idempotencyKey: options.key,
    })).case
    current = await broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
    const attempt = await broker.attempts.start({ caseId: current.caseId, agentId: options.agentId ?? profile.agentId, pins: {}, contextPackHash: `hash-${options.key}`, packManifest: {} })
    await broker.attempts.finish(attempt.attemptId, { outcome: 'answer', citedEvidenceIds: [] })
    current = broker.cases.getCase(current.caseId)
    current = await broker.cases.transition({
      caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision,
      state: 'closed', closing: 'answered',
      decision: { kind: 'answer', attemptId: attempt.attemptId, answers: [{ id: 'q', selected: [options.selected ?? 'A'] }], decidedAt: broker.now() },
    })
    if (options.rate !== false) {
      await broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: current.caseId, attemptId: attempt.attemptId, kind: 'rating_up' })
    }
    return broker.cases.getCase(current.caseId)
  }

  /** Mark a closed Case disputed through the real feedback surface. */
  async function dispute(caseId) {
    await broker.feedbackStore.append({ actor: { kind: 'user' }, caseId, kind: 'rating_down' })
    return broker.cases.getCase(caseId)
  }

  t.after(async () => {
    await broker.flush()
    rmSync(dir, { recursive: true, force: true })
  })

  return {
    dir, w1, w2, w3, workspace: w1, broker, profile, agents, config, requests, audits,
    seedDecision, seedValidated, dispute,
    respond: fn => { respond = fn },
  }
}

/** A valid public `add` operation whose sources are frozen cross-workspace originals. */
export function publicAdd(sources, overrides = {}) {
  return {
    op: 'add', principleId: 'temporary-public-add',
    text: 'Prefer the documented option when both workspaces agree',
    scope: {}, sources, ...overrides,
  }
}

export function replayMetrics(overrides = {}) {
  return { operationCount: 1, sourceCount: 1, activePrincipleCount: 1, retiredPrincipleCount: 0, ...overrides }
}

/** A schema-valid frozen input for one public Learning Run. */
export function publicFrozenInput(f, overrides = {}) {
  return {
    zone: 'public', workspaceKey: null, requestId: 'req-public-fixture', startedAt: 1_000,
    agentProfileRevision: f.profile.revision, caseIds: [], feedbackIds: [], revisions: {},
    feedbackDigest: '0'.repeat(64), parentSnapshotId: null, parentSnapshotRevision: null,
    promptVersion: 'consolidation-contract/1', modelRoute: { kind: 'inherited', provider: 'p', model: 'm' },
    inputHash: '0'.repeat(64), sourceHighWater: publicSourceHighWater([]),
    workspaceAliases: [], sourceWorkspaces: {}, ...overrides,
  }
}
