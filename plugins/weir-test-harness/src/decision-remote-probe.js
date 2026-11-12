// Direct live-service mirror of the Decision typert remote (headless has no gateway). Dev-only.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDecisionRemoteService, decisionRemoteContribution } from '../../weir-harness/src/decision/remote.js'
import { DecisionBroker } from '../../weir-harness/src/decision/broker.js'

export const name = 'weir-it-decision-remote-probe'
export const inject = ['tools']

const CHILD_QUESTION = 'REMOTE_CHILD: escalate a delegated consultation'
// Cross-workspace matrix wire: one label-keyed record per gesture. It carries the
// raw remote payloads (`result`) and the gesture's local observations (`detail`),
// plus a workspace LABEL, never a path, so the matrix driver can compare the wire
// with the authoritative SQLite store.
const CROSS_WIRE = 'decision-cross-workspace-wire.json'

function writeReport(name, value) {
  const path = join(process.env.WEIR_IT_ROOT, 'ws', name)
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  return path
}

async function rootFlow(remote, broker, agent) {
  const calls = {}
  const call = async (method, args) => {
    const result = await remote[method](args)
    calls[method] = result
    return result
  }
  const workspaceKey = realpathSync(agent.session.header.cwd)
  const a = await call('profileUpsert', { sessionId: agent.id, name: 'Decision Remote A', userDescription: 'For REMOTE_ANSWER select Remote A.' })
  const b = await call('profileUpsert', { sessionId: agent.id, name: 'Decision Remote B', userDescription: 'B is an explicit reassignment target.' })
  if (!a.ok || !b.ok) throw new Error(`Remote profile setup failed: ${JSON.stringify({ a, b })}`)
  await call('setSelector', { sessionId: agent.id, mode: 'agent', agentId: a.value.agentId })
  await call('overview', { sessionId: agent.id })
  await call('agents', { sessionId: agent.id })
  await call('agent', { sessionId: agent.id, agentId: a.value.agentId })

  const answered = await broker.consult({ agent, args: { question: 'REMOTE_ANSWER: choose the evidenced answer', options: [{ label: 'Remote A' }, { label: 'Other' }], request_id: 'remote-answered' }, toolCallId: 'remote-answer-call' })
  const waiting = {}
  for (const action of ['decide', 'reassign', 'cancel', 'retry']) {
    waiting[action] = await broker.consult({ agent, args: { question: `REMOTE_${action.toUpperCase()}: needs a new judgment`, options: [{ label: 'User choice' }, { label: 'Other' }], request_id: `remote-${action}` } })
  }
  await call('records', { sessionId: agent.id, filter: {}, cursor: { limit: 100 } })
  await call('record', { sessionId: agent.id, caseId: answered.caseId })
  await call('inbox', { sessionId: agent.id })
  await call('metrics', { sessionId: agent.id, window: 'all' })
  await call('caseForCall', { sessionId: agent.id, questions: [{ id: 'question', question: 'REMOTE_ANSWER: choose the evidenced answer' }] })
  await call('caseForToolCall', { sessionId: agent.id, toolCallId: 'remote-answer-call' })
  await call('feedback', { sessionId: agent.id, caseId: answered.caseId, verb: 'rating_up' })
  await call('correction', { sessionId: agent.id, caseId: answered.caseId, direction: 'Use the corrected remote direction', scope: { workspaces: [workspaceKey] }, supersedes: [answered.caseId] })
  await call('decide', { sessionId: agent.id, caseId: waiting.decide.caseId, answers: [{ id: 'question', selected: ['User choice'] }] })
  await call('reassign', { sessionId: agent.id, caseId: waiting.reassign.caseId, agentId: b.value.agentId })
  await call('cancel', { sessionId: agent.id, caseId: waiting.cancel.caseId })
  await call('retry', { sessionId: agent.id, caseId: waiting.retry.caseId })
  await call('profileSetState', { sessionId: agent.id, agentId: b.value.agentId, state: 'disabled' })
  calls.errorPath = await remote.agent({ sessionId: agent.id, agentId: 'ag_missing' })
  return { calls, fixtures: { agentA: a.value.agentId, agentB: b.value.agentId, answered, waiting } }
}

async function childFlow(remote, agent, caseId) {
  const calls = {
    caseForCall: await remote.caseForCall({ sessionId: agent.id, questions: [{ id: 'question', question: CHILD_QUESTION }] }),
    caseForToolCall: await remote.caseForToolCall({ sessionId: agent.id, toolCallId: 'mock-call-1' }),
    record: await remote.record({ sessionId: agent.id, caseId }),
    inbox: await remote.inbox({ sessionId: agent.id }),
    errorPath: await remote.agent({ sessionId: agent.id, agentId: 'ag_missing_child' }),
  }
  return { calls, childSessionId: agent.id, caseId }
}

function learningReport(label, value) {
  const name = 'decision-learning-rpc.json'
  const path = join(process.env.WEIR_IT_ROOT, 'ws', name)
  const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  report[label] = value
  writeReport(name, report)
  return path
}

async function waitForLearningRun(broker, agentId, requestId) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const run = broker.learning?.listRuns(agentId).find(item => item.inputFrozen.requestId === requestId)
    if (run?.outcome === 'running') return run
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Learning Run ${requestId} did not persist running before the model gate`)
}

async function learningFlow(remote, broker, agent, args) {
  const sessionId = agent.id
  let result
  if (args.action === 'crossAgent') {
    result = {
      run: await remote.learningRun({ sessionId, agentId: args.agentId, learningRunId: args.learningRunId }),
      snapshot: await remote.memorySnapshot({ sessionId, agentId: args.agentId, snapshotId: args.snapshotId }),
      publish: await remote.snapshotPublish({ sessionId, agentId: args.agentId, snapshotId: args.snapshotId, expectedRevision: args.expectedRevision }),
    }
  } else if (args.action === 'crossWorkspace') {
    const crossAgent = {
      id: agent.id,
      session: {
        header: { ...agent.session.header, cwd: args.otherWorkspace },
        requestContext: () => agent.session.requestContext(),
      },
    }
    const crossBroker = new DecisionBroker({
      profileContext: broker.profileContext, config: broker.config, now: broker.now, audit: broker.audit,
      ctx: { agents: { get: id => id === agent.id ? crossAgent : undefined } },
    })
    await crossBroker.start()
    const crossRemote = createDecisionRemoteService({ broker: () => crossBroker })
    try {
      result = {
        start: await crossRemote.learningStart({ sessionId, agentId: args.agentId, requestId: `${args.label}-foreign-workspace` }),
        run: await crossRemote.learningRun({ sessionId, learningRunId: args.learningRunId }),
        snapshot: await crossRemote.memorySnapshot({ sessionId, snapshotId: args.snapshotId }),
        rollback: await crossRemote.snapshotRollback({ sessionId, snapshotId: args.snapshotId, expectedRevision: args.expectedRevision }),
      }
    } finally {
      await crossBroker.flush()
    }
  } else if (args.action === 'learningStart') {
    const input = { sessionId, agentId: args.agentId, requestId: args.requestId }
    if (args.concurrent) {
      const first = remote.learningStart(input)
      await waitForLearningRun(broker, args.agentId, args.requestId)
      const duplicate = remote.learningStart(input)
      let competing
      try {
        competing = await remote.learningStart({ ...input, requestId: `${args.requestId}-competing` })
      } finally {
        if (process.env.WEIR_IT_LEARNING_RELEASE) writeFileSync(process.env.WEIR_IT_LEARNING_RELEASE, 'release\n')
      }
      result = { first: await first, duplicate: await duplicate, competing }
    } else result = await remote.learningStart(input)
  } else {
    const input = { sessionId, agentId: args.agentId, learningRunId: args.learningRunId, snapshotId: args.snapshotId, expectedRevision: args.expectedRevision }
    if (args.action === 'learningRun' && !input.learningRunId && args.requestId) {
      const row = broker.store.db.prepare("SELECT learning_run_id FROM learning_runs WHERE agent_id=? AND json_extract(input_frozen_json,'$.requestId')=?").get(args.agentId, args.requestId)
      input.learningRunId = row?.learning_run_id
    }
    result = await remote[args.action](input)
  }
  const run = result?.value?.learningRunId ? result.value : result?.first?.value
  const snapshotId = args.snapshotId ?? (run?.learningRunId
    ? broker.store.db.prepare('SELECT snapshot_id FROM memory_snapshots WHERE learning_run_id=?').get(run.learningRunId)?.snapshot_id
    : undefined)
  const value = { completed: true, op: args.op, label: args.label, action: args.action, result, snapshotId }
  const path = learningReport(args.label, value)
  return { ...value, path }
}

// ---------------------------------------------------------------------------
// Cross-workspace matrix gestures (additive ops; the ops above are unchanged).
//
// Wire entry shape: { op, action, label, workspace (a LABEL, never a path),
// sessionId, args, result (the raw remote result), detail (gesture-local facts) }
// ---------------------------------------------------------------------------

/** The agent a gesture names, falling back to the profile-global name lookup. */
function resolveAgentId(broker, args) {
  if (typeof args.agentId === 'string' && args.agentId) return args.agentId
  if (typeof args.name === 'string' && args.name) {
    const row = broker.store?.db.prepare('SELECT agent_id FROM agent_profiles WHERE name = ? COLLATE NOCASE').get(args.name)
    if (row?.agent_id) return row.agent_id
  }
  return undefined
}

function crossWire(label, entry) {
  if (typeof label !== 'string' || !label) return null
  const path = join(process.env.WEIR_IT_ROOT, 'ws', CROSS_WIRE)
  const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  report[label] = entry
  return writeReport(CROSS_WIRE, report)
}

function crossBase(op, action, label, agent) {
  return {
    op, action, label: label ?? null,
    workspace: process.env.WEIR_IT_XWS_LABEL ?? null,
    sessionId: agent.id,
  }
}

function wireArgs(args) {
  const copy = { ...args }
  delete copy.label
  delete copy.op
  return copy
}

function profileSummary(profile) {
  return {
    agentId: profile?.agentId ?? null, name: profile?.name ?? null, revision: profile?.revision ?? null,
    state: profile?.state ?? null, scope: profile?.scope ?? null,
    userDescriptionRevision: profile?.userDescription?.revision ?? null,
    hasWorkspaceField: profile ? Object.keys(profile).some(key => /workspace/i.test(key)) : null,
  }
}

function wireFinish(args, op, agent, result, detail, summary) {
  const path = crossWire(args.label, { ...crossBase(op, args.action, args.label, agent), args: wireArgs(args), result, detail })
  return { ...summary, completed: summary.completed ?? true, op, action: args.action, label: args.label ?? null, ...(path ? { path } : {}) }
}

async function identityFlow(remote, broker, agent, args) {
  const sessionId = agent.id
  if (args.action === 'create') {
    const name = args.variant === 'upper' ? String(args.name ?? '').toUpperCase() : args.name
    const result = await remote.profileUpsert({
      sessionId, name, userDescription: args.userDescription ?? '',
      scope: { authorizationClasses: ['A', 'B', 'C'] }, modelRoute: { chain: [] },
    })
    const expectedFailure = args.variant !== undefined
    return wireFinish(args, 'identity', agent, result, { name, variant: args.variant ?? null, profile: profileSummary(result.value) }, {
      completed: expectedFailure ? true : result.ok === true,
      ok: result.ok === true, agentId: result.value?.agentId ?? null,
      errorCode: result.error?.code ?? null, name,
    })
  }
  if (args.action === 'list') {
    const result = await remote.agents({ sessionId })
    const overview = await remote.overview({ sessionId })
    const agents = result.ok === true ? result.value : []
    return wireFinish(args, 'identity', agent, result, { overview }, {
      completed: result.ok === true && overview.ok === true,
      count: agents.length,
      agents: agents.map(profile => profileSummary(profile)),
      keys: [...new Set(agents.flatMap(profile => Object.keys(profile)))].sort(),
      selector: overview.ok === true ? overview.value.selector : null,
    })
  }
  if (args.action === 'selector-set') {
    const agentId = args.mode === 'agent' ? resolveAgentId(broker, args) : undefined
    const result = await remote.setSelector({ sessionId, mode: args.mode ?? 'agent', agentId })
    const row = broker.store ? broker.store.db.prepare('SELECT * FROM selectors WHERE root_session_id=?').get(sessionId) ?? null : null
    return wireFinish(args, 'identity', agent, result, { row, agentId: agentId ?? null }, {
      completed: result.ok === true, selector: result.value, errorCode: result.error?.code ?? null,
    })
  }
  if (args.action === 'selector-get') {
    const result = await remote.overview({ sessionId })
    const row = broker.store ? broker.store.db.prepare('SELECT * FROM selectors WHERE root_session_id=?').get(sessionId) ?? null : null
    return wireFinish(args, 'identity', agent, result, { row, selector: broker.selector(sessionId) }, {
      completed: result.ok === true,
      selector: result.ok === true ? result.value.selector : null,
      row,
    })
  }
  throw new Error(`Unsupported identity action: ${args.action}`)
}

async function caseFlow(remote, broker, agent, args) {
  const sessionId = agent.id
  if (args.action === 'by-question') {
    const row = broker.store?.db.prepare("SELECT case_id FROM cases WHERE json_extract(request_json,'$.questions[0].id')=? ORDER BY created_at DESC,case_id DESC LIMIT 1").get(args.questionId)
    const result = row ? await remote.record({ sessionId, caseId: row.case_id }) : { ok: true, value: null }
    const record = result.ok === true ? result.value : null
    const attempts = record?.attempts ?? []
    return wireFinish(args, 'caseQuery', agent, result, { questionId: args.questionId }, {
      completed: true, found: Boolean(record), caseId: record?.case?.caseId ?? null,
      state: record?.case?.state ?? null, closing: record?.case?.closing ?? null,
      decisionKind: record?.case?.decision?.kind ?? null, awaitingReason: record?.case?.awaitingReason ?? null,
      attemptCount: attempts.length,
      attempts: attempts.map(attempt => ({
        attemptId: attempt.attemptId, attemptNo: attempt.attemptNo, agentId: attempt.agentId, outcome: attempt.outcome,
        pins: attempt.pins, evidenceIds: attempt.packManifest?.evidenceIds ?? [],
        publicPrincipleIds: attempt.packManifest?.memory?.publicL2?.principleIds ?? [],
        publicSnapshotId: attempt.packManifest?.memory?.publicL2?.snapshotId ?? null,
        privateSnapshotId: attempt.packManifest?.memory?.L2?.snapshotId ?? null,
      })),
      routes: (record?.routeDecisions ?? []).map(route => ({ mode: route.mode, chosen: route.chosen ?? null, reason: route.reason })),
    })
  }
  if (args.action === 'records') {
    const result = await remote.records({ sessionId, filter: {}, cursor: { limit: 100 } })
    const records = result.ok === true ? result.value.records : []
    return wireFinish(args, 'caseQuery', agent, result, {}, {
      completed: result.ok === true, count: records.length,
      caseIds: records.map(item => item.caseId),
    })
  }
  if (args.action === 'read') {
    const result = await remote.record({ sessionId, caseId: args.caseId })
    const record = result.ok === true ? result.value : null
    return wireFinish(args, 'caseQuery', agent, result, { caseId: args.caseId }, {
      completed: true, caseId: args.caseId, found: Boolean(record),
      state: record?.case?.state ?? null, closing: record?.case?.closing ?? null,
      attemptCount: record?.attempts?.length ?? 0,
    })
  }
  if (args.action === 'comment') {
    const before = broker.cases.getCase(args.caseId)
    const result = await remote.feedback({ sessionId, caseId: args.caseId, verb: args.verb ?? 'comment', ...(args.text === undefined ? {} : { payload: { text: args.text } }) })
    const after = broker.cases.getCase(args.caseId)
    return wireFinish(args, 'caseQuery', agent, result, {
      caseId: args.caseId, revisionBefore: before?.revision ?? null, revisionAfter: after?.revision ?? null,
      feedbackStateBefore: before?.feedbackState ?? null, feedbackStateAfter: after?.feedbackState ?? null,
    }, {
      completed: result.ok === true,
      feedbackId: result.value?.feedbackId ?? null, errorCode: result.error?.code ?? null,
    })
  }
  throw new Error(`Unsupported caseQuery action: ${args.action}`)
}

async function publicFlow(remote, broker, agent, args) {
  const sessionId = agent.id
  const agentId = resolveAgentId(broker, args)
  if (args.action === 'refresh') {
    const result = await remote.publicMemoryRefresh({
      sessionId, agentId,
      ...(args.acknowledgedDisclosure === true ? { acknowledgedDisclosure: true } : {}),
      ...(args.retryFailedExtraction === true ? { retryFailedExtraction: true } : {}),
    })
    const value = result.ok === true ? result.value : null
    return wireFinish(args, 'public', agent, result, {}, {
      completed: true, ok: result.ok === true, errorCode: result.error?.code ?? null,
      status: value?.status ?? null, candidateSnapshotId: value?.candidate?.snapshotId ?? null,
      currentSnapshotId: value?.current?.snapshotId ?? null,
      workspaceCount: value?.workspaceCount ?? null, sourceCount: value?.sourceCount ?? null,
    })
  }
  if (args.action === 'candidate') {
    const result = await remote.publicCandidate({ sessionId, agentId, ...(args.learningRunId ? { learningRunId: args.learningRunId } : {}) })
    const value = result.ok === true ? result.value : null
    return wireFinish(args, 'public', agent, result, {}, {
      completed: true, ok: result.ok === true, errorCode: result.error?.code ?? null,
      present: Boolean(value), learningRunId: value?.learningRunId ?? null,
      snapshotId: value?.candidate?.snapshotId ?? null, revision: value?.candidate?.revision ?? null,
      sourceCount: value?.sourceCount ?? null, workspaceCount: value?.workspaceCount ?? null,
    })
  }
  if (args.action === 'publish' || args.action === 'reject' || args.action === 'rollback') {
    const method = args.action === 'publish' ? 'snapshotPublish' : args.action === 'reject' ? 'snapshotReject' : 'snapshotRollback'
    const result = await remote[method]({ sessionId, agentId, snapshotId: args.snapshotId, expectedRevision: args.expectedRevision })
    return wireFinish(args, 'public', agent, result, {}, {
      completed: true, ok: result.ok === true, errorCode: result.error?.code ?? null,
      snapshotId: result.value?.snapshotId ?? null, state: result.value?.state ?? null,
    })
  }
  if (args.action === 'state') {
    const result = await remote.agent({ sessionId, agentId })
    const overview = await remote.overview({ sessionId })
    const value = result.ok === true ? result.value : null
    return wireFinish(args, 'public', agent, result, {
      selector: overview.ok === true ? overview.value.selector : null,
      privateSnapshotId: value?.currentSnapshotId ?? null,
      publicCurrent: value?.publicMemory?.current ?? null,
      publicRun: value?.publicMemory?.run ?? null,
      privateSnapshots: (value?.snapshots ?? []).map(snapshot => ({ snapshotId: snapshot.snapshotId, version: snapshot.version, revision: snapshot.revision, contentHash: snapshot.contentHash, state: snapshot.state })),
    }, {
      completed: result.ok === true,
      errorCode: result.error?.code ?? null,
      agentId: value?.agentId ?? null,
      selector: overview.ok === true ? overview.value.selector : null,
      publicSnapshotId: value?.publicMemory?.current?.snapshotId ?? null,
      publicVersion: value?.publicMemory?.current?.version ?? null,
      candidateRunOutcome: value?.publicMemory?.run?.outcome ?? null,
      privateSnapshotId: value?.currentSnapshotId ?? null,
    })
  }
  throw new Error(`Unsupported public action: ${args.action}`)
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.tools.register({
    name: 'decision_remote_probe',
    description: 'Drive the real Decision remote service with bare root/child session ids. Dev-only.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['root', 'child-read', 'learning', 'identity', 'caseQuery', 'public'] }, caseId: { type: 'string' },
        action: { type: 'string' }, label: { type: 'string' }, agentId: { type: 'string' }, requestId: { type: 'string' },
        learningRunId: { type: 'string' }, snapshotId: { type: 'string' }, expectedRevision: { type: 'integer' },
        otherWorkspace: { type: 'string' }, concurrent: { type: 'boolean' },
        // Cross-workspace matrix gestures (additive).
        name: { type: 'string' }, variant: { type: 'string' }, mode: { type: 'string' }, questionId: { type: 'string' },
        text: { type: 'string' }, verb: { type: 'string' },
        acknowledgedDisclosure: { type: 'boolean' }, retryFailedExtraction: { type: 'boolean' },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `DECISION_REMOTE ${value?.completed ? `done ${args?.op}` : 'error'}:${JSON.stringify(value)}` }],
    },
    async execute(args, exec) {
      try {
        const broker = ctx.get('weirDecisionBroker')
        const agent = exec.agent
        if (!broker || !agent?.id) throw new Error('Decision Broker and execution Agent are required')
        const remote = createDecisionRemoteService({ broker: () => broker })
        if (args.op === 'identity') return await identityFlow(remote, broker, agent, args)
        if (args.op === 'caseQuery') return await caseFlow(remote, broker, agent, args)
        if (args.op === 'public') return await publicFlow(remote, broker, agent, args)
        if (args.op === 'learning') return await learningFlow(remote, broker, agent, args)
        const report = args.op === 'root' ? await rootFlow(remote, broker, agent) : await childFlow(remote, agent, args.caseId)
        const contribution = decisionRemoteContribution()
        const noAgentLookup = contribution.invocations.every(invocation => !JSON.stringify(invocation).includes('lookup'))
        const path = writeReport(args.op === 'root' ? 'decision-ui-remote-report.json' : 'decision-ui-remote-child.json', { ...report, noAgentLookup })
        return { completed: true, op: args.op, path, noAgentLookup }
      } catch (error) {
        return { completed: false, op: args.op, error: error?.message ?? String(error) }
      }
    },
  })
}
