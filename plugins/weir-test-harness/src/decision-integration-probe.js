// Live Decision Agent integration fixtures. Dev-only; never mount in a real profile.
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DecisionBroker } from '../../weir-harness/src/decision/broker.js'
import { DatabaseSync } from 'node:sqlite'

export const name = 'weir-it-decision-integration-probe'
export const inject = ['tools']

function render(args, value) {
  const status = value?.completed ? `done ${args?.op ?? ''}` : 'error'
  return [{ type: 'text', text: `DECISION_TEST ${status}:${JSON.stringify(value)}` }]
}

async function seedLearningDecision(broker, agent, input) {
  const opened = await broker.cases.createCase({
    workspaceKey: input.workspaceKey, rootSessionId: agent.id, entry: 'hook', agentId: input.agentId,
    request: { entry: 'hook', questions: [{ id: `decision-learning-${input.key}`, question: `LEARNING_FIXTURE ${input.key}`, options: [{ label: input.selected }] }] },
    scope: { workspaces: [input.workspaceKey] },
    idempotencyKey: `decision-learning:${input.key}`,
  })
  let current = await broker.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'awaiting_user' })
  current = await broker.cases.transition({
    caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision,
    state: 'closed', closing: 'escalated',
    decision: { kind: 'user_decision', answers: [{ id: `decision-learning-${input.key}`, selected: [input.selected] }] },
  })
  return current
}

async function seedLearningAnswer(broker, agent, input) {
  const questionId = `decision-learning-${input.key}`
  const opened = await broker.cases.createCase({
    workspaceKey: input.workspaceKey, rootSessionId: agent.id, entry: 'hook', agentId: input.agentId,
    request: { entry: 'hook', questions: [{ id: questionId, question: `LEARNING_ANSWER ${input.key}`, options: [{ label: 'Neutral answer' }] }] },
    scope: { workspaces: [input.workspaceKey] },
    idempotencyKey: `decision-learning:${input.key}`,
  })
  let current = await broker.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'evaluating' })
  const attempt = await broker.attempts.start({
    caseId: current.caseId, agentId: input.agentId, pins: input.pins,
    contextPackHash: `decision-learning-${input.key}-hash`, packManifest: input.manifest,
  })
  await broker.attempts.finish(attempt.attemptId, { outcome: 'answer', claims: [], citedEvidenceIds: [] })
  current = broker.cases.getCase(current.caseId)
  current = await broker.cases.transition({
    caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision,
    state: 'closed', closing: 'answered',
    decision: { kind: 'answer', attemptId: attempt.attemptId, answers: [{ id: questionId, selected: ['Neutral answer'] }], decidedAt: broker.now() },
  })
  return { current, attempt }
}

async function learningSeed(broker, agent) {
  const workspaceKey = realpathSync(agent.session.header.cwd)
  const otherWorkspace = join(workspaceKey, 'decision-learning-other')
  mkdirSync(otherWorkspace, { recursive: true })
  const otherWorkspaceKey = realpathSync(otherWorkspace)
  const scope = { workspaces: [workspaceKey] }
  const agentA = await broker.profileUpsert({ workspaceKey, name: 'Decision Learning A', scope, userDescription: 'Use the reviewed principle only with its evidence.', modelRoute: { chain: [] } })
  const agentB = await broker.profileUpsert({ workspaceKey, name: 'Decision Learning B', scope, userDescription: 'Independent Agent namespace.', modelRoute: { chain: [] } })
  const agentC = await broker.profileUpsert({ workspaceKey: otherWorkspaceKey, name: 'Decision Learning W2', scope: { workspaces: [otherWorkspaceKey] }, userDescription: 'Foreign workspace namespace.', modelRoute: { chain: [] } })
  await broker.setSelector(agent.id, 'agent', agentA.agentId)
  const sourceA = await seedLearningDecision(broker, agent, { key: 'source-a', selected: 'Source A', agentId: agentA.agentId, workspaceKey })
  const sourceB = await seedLearningDecision(broker, agent, { key: 'source-b', selected: 'Source B', agentId: agentA.agentId, workspaceKey })
  const sourceC = await seedLearningDecision(broker, agent, { key: 'source-c', selected: 'Source C', agentId: agentA.agentId, workspaceKey })
  const foreign = await seedLearningDecision(broker, agent, { key: 'foreign', selected: 'FOREIGN_WORKSPACE_SECRET', agentId: agentC.agentId, workspaceKey: otherWorkspaceKey })
  const emptyManifest = { layerSizes: { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 }, evidenceIds: [], correctionIds: [], omissions: [] }
  const neutral = await seedLearningAnswer(broker, agent, {
    key: 'neutral', agentId: agentA.agentId, workspaceKey,
    pins: { promptVersion: 'evaluator-contract/2', evaluatorVersion: 'sidecar/1', memorySnapshotId: null },
    manifest: { ...emptyManifest, memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: [] } } },
  })
  const p1 = await seedLearningAnswer(broker, agent, {
    key: 'p1-fixture', agentId: agentA.agentId, workspaceKey,
    pins: { promptVersion: 'evaluator-contract/1', evaluatorVersion: 'sidecar/1', memorySnapshotId: null }, manifest: emptyManifest,
  })
  const p2 = await seedLearningAnswer(broker, agent, {
    key: 'p2-fixture', agentId: agentA.agentId, workspaceKey,
    pins: { promptVersion: 'evaluator-contract/2', evaluatorVersion: 'sidecar/1', memorySnapshotId: null },
    manifest: { ...emptyManifest, memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: [] } } },
  })
  const fixture = {
    completed: true, op: 'learning-seed', workspaceKey, otherWorkspace: otherWorkspaceKey,
    agentA: agentA.agentId, agentB: agentB.agentId, agentC: agentC.agentId,
    sourceA: sourceA.caseId, sourceB: sourceB.caseId, sourceC: sourceC.caseId, foreign: foreign.caseId,
    neutral: neutral.current.caseId,
    compatibility: {
      p1: { caseId: p1.current.caseId, attemptId: p1.attempt.attemptId },
      p2: { caseId: p2.current.caseId, attemptId: p2.attempt.attemptId },
    },
  }
  writeFileSync(join(process.env.WEIR_IT_ROOT, 'ws', 'decision-learning-fixtures.json'), JSON.stringify(fixture, null, 2) + '\n')
  return fixture
}

async function autoSetup(broker, agent) {
  const workspaceKey = realpathSync(agent.session.header.cwd)
  const base = { workspaces: [workspaceKey] }
  const agentA = await broker.profileUpsert({
    workspaceKey, name: 'Decision Auto A', scope: { ...base },
    userDescription: 'Auto A private profile body: select the evidenced A answer.', modelRoute: { chain: [] },
  })
  const agentB = await broker.profileUpsert({
    workspaceKey, name: 'Decision Auto B', scope: { ...base },
    userDescription: 'Auto B private profile body: select the evidenced B answer.', modelRoute: { chain: [] },
  })
  const initialSelector = broker.selector(agent.id)
  await broker.setSelector(agent.id, 'auto')
  return { completed: true, op: 'auto-setup', agentA: agentA.agentId, agentB: agentB.agentId, workspaceKey, rootSessionId: agent.id, initialSelector, selector: broker.selector(agent.id) }
}

async function waitForFile(path, signal, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (signal?.aborted) throw new Error(`Auto probe aborted while waiting for ${path}`)
    if (Date.now() >= deadline) throw new Error(`Auto probe timed out waiting for ${path}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function autoCaseCounts(broker, caseId) {
  return {
    cases: caseId ? 1 : 0,
    routes: caseId ? broker.store.db.prepare('SELECT COUNT(*) AS n FROM route_decisions WHERE case_id=?').get(caseId).n : 0,
    attempts: caseId ? broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE case_id=?').get(caseId).n : 0,
  }
}

async function autoSingleflight(broker, agent, signal) {
  const root = process.env.WEIR_IT_ROOT
  if (!root) throw new Error('WEIR_IT_ROOT is required for the Auto single-flight handshake')
  const ready = join(root, 'decision-auto-singleflight.ready')
  const release = join(root, 'decision-auto-singleflight.release')
  rmSync(ready, { force: true })
  rmSync(release, { force: true })
  const args = {
    question: 'AUTO_SINGLEFLIGHT: join this classless consultation',
    options: [{ label: 'Joined B' }, { label: 'Other' }], request_id: 'auto-singleflight',
  }
  const publish = broker.publishConsult.bind(broker)
  let publishes = 0
  let firstSettled = false
  let replaySettled = false
  broker.publishConsult = current => { publishes++; return publish(current) }
  try {
    const first = broker.consult({ agent, args, signal }).then(value => { firstSettled = true; return value })
    const replay = broker.consult({ agent, args, signal }).then(value => { replaySettled = true; return value })
    await waitForFile(ready, signal)
    const row = broker.store.db.prepare("SELECT case_id,state FROM cases WHERE json_extract(request_json,'$.questions[0].question')=?").get(args.question)
    const caseId = row?.case_id
    const before = {
      ...autoCaseCounts(broker, caseId), received: row?.state === 'received' ? 1 : 0,
      firstSettled, replaySettled, publishes, flights: broker.autoFlights.size,
    }
    writeFileSync(release, JSON.stringify({ at: Date.now() }) + '\n')
    const [firstResult, replayResult] = await Promise.all([first, replay])
    const current = broker.cases.getCase(caseId)
    const after = {
      ...autoCaseCounts(broker, caseId), sameResult: JSON.stringify(firstResult) === JSON.stringify(replayResult),
      outcome: firstResult.outcome, state: current.state, agentId: current.agentId,
      publishes, flights: broker.autoFlights.size,
    }
    rmSync(ready, { force: true })
    rmSync(release, { force: true })
    const selectorArgs = {
      question: 'AUTO_SINGLEFLIGHT_SELECTOR_CONSULT: join after Auto becomes pinned',
      options: [{ label: 'Selector joined B' }], request_id: 'auto-singleflight-selector-consult',
    }
    const selectorPublishBaseline = publishes
    let selectorFirstSettled = false
    let selectorReplaySettled = false
    const selectorFirst = broker.consult({ agent, args: selectorArgs, signal }).then(value => { selectorFirstSettled = true; return value })
    await waitForFile(ready, signal)
    await broker.setSelector(agent.id, 'agent', current.agentId)
    const selectorReplay = broker.consult({ agent, args: selectorArgs, signal }).then(value => { selectorReplaySettled = true; return value })
    await new Promise(resolve => setTimeout(resolve, 20))
    const selectorRow = broker.store.db.prepare("SELECT case_id,state FROM cases WHERE json_extract(request_json,'$.questions[0].question')=?").get(selectorArgs.question)
    const selectorCaseId = selectorRow?.case_id
    const selectorBefore = {
      ...autoCaseCounts(broker, selectorCaseId), received: selectorRow?.state === 'received' ? 1 : 0,
      firstSettled: selectorFirstSettled, replaySettled: selectorReplaySettled,
      publishes: publishes - selectorPublishBaseline, flights: broker.autoFlights.size,
    }
    writeFileSync(release, JSON.stringify({ at: Date.now() }) + '\n')
    const [selectorFirstResult, selectorReplayResult] = await Promise.all([selectorFirst, selectorReplay])
    const selectorAfter = {
      ...autoCaseCounts(broker, selectorCaseId), sameResult: JSON.stringify(selectorFirstResult) === JSON.stringify(selectorReplayResult),
      publishes: publishes - selectorPublishBaseline, flights: broker.autoFlights.size,
    }

    await broker.setSelector(agent.id, 'auto')
    rmSync(ready, { force: true })
    rmSync(release, { force: true })
    const selectorHookRequest = {
      questions: [{ id: 'decision-auto-selector-hook', question: 'AUTO_SINGLEFLIGHT_HOOK: join after Auto becomes pinned', options: [{ label: 'Selector Hook B' }] }],
      wait: { callId: 'auto-singleflight-selector-hook' },
    }
    let selectorHookFirstSettled = false
    let selectorHookReplaySettled = false
    const selectorHookFirst = broker.hook({ agent, request: selectorHookRequest, signal }).then(value => { selectorHookFirstSettled = true; return value })
    await waitForFile(ready, signal)
    await broker.setSelector(agent.id, 'agent', current.agentId)
    const selectorHookReplay = broker.hook({ agent, request: selectorHookRequest, signal }).then(value => { selectorHookReplaySettled = true; return value })
    await new Promise(resolve => setTimeout(resolve, 20))
    const selectorHookRow = broker.store.db.prepare("SELECT case_id,state FROM cases WHERE json_extract(request_json,'$.questions[0].question')=?").get(selectorHookRequest.questions[0].question)
    const selectorHookCaseId = selectorHookRow?.case_id
    const selectorHookBefore = {
      ...autoCaseCounts(broker, selectorHookCaseId), received: selectorHookRow?.state === 'received' ? 1 : 0,
      firstSettled: selectorHookFirstSettled, replaySettled: selectorHookReplaySettled, flights: broker.autoFlights.size,
    }
    writeFileSync(release, JSON.stringify({ at: Date.now() }) + '\n')
    const [selectorHookFirstResult, selectorHookReplayResult] = await Promise.all([selectorHookFirst, selectorHookReplay])
    const selectorHookAfter = {
      ...autoCaseCounts(broker, selectorHookCaseId), sameResult: JSON.stringify(selectorHookFirstResult) === JSON.stringify(selectorHookReplayResult),
      flights: broker.autoFlights.size,
    }
    await broker.setSelector(agent.id, 'auto')
    return {
      completed: true, op: 'auto-singleflight', caseId, before, after,
      selectorConsult: { caseId: selectorCaseId, before: selectorBefore, after: selectorAfter },
      selectorHook: { caseId: selectorHookCaseId, before: selectorHookBefore, after: selectorHookAfter },
    }
  } finally {
    await broker.setSelector(agent.id, 'auto')
    broker.publishConsult = publish
    writeFileSync(release, JSON.stringify({ at: Date.now(), cleanup: true }) + '\n')
  }
}

async function autoReplay(broker, agent) {
  const workspaceKey = realpathSync(agent.session.header.cwd)
  const original = {
    question: 'AUTO_REPLAY: original classless question',
    options: [{ label: 'Replay original' }, { label: 'Other' }],
    context: 'AUTO_REPLAY context secret', request_id: 'auto-replay',
  }
  const first = await broker.consult({ agent, args: original })
  const initialCase = broker.cases.getCase(first.caseId)
  const initialQuestion = initialCase.request.questions[0]
  const initial = {
    caseId: first.caseId, outcome: first.outcome, state: initialCase.state, flights: broker.autoFlights.size,
    request: initialQuestion,
    ...autoCaseCounts(broker, first.caseId),
  }
  const replayResult = await broker.consult({ agent, args: original })
  const replay = {
    sameResult: JSON.stringify(replayResult) === JSON.stringify(first),
    state: broker.cases.getCase(first.caseId).state,
    ...autoCaseCounts(broker, first.caseId),
  }
  const changes = [
    ['question', current => ({ ...current, question: 'AUTO_REPLAY: changed question' })],
    ['context', current => ({ ...current, context: 'AUTO_REPLAY context changed' })],
    ['options', current => ({ ...current, options: [{ label: 'Replay revised option' }] })],
    ['scope', current => ({ ...current, scope: { workspaces: [workspaceKey], paths: ['src'] } })],
  ]
  const revisions = []
  let currentArgs = original
  for (const [field, change] of changes) {
    currentArgs = { ...change(currentArgs) }
    const result = await broker.consult({ agent, args: currentArgs })
    const current = broker.cases.getCase(first.caseId)
    revisions.push({
      field, outcome: result.outcome, state: current.state, sameAgent: current.agentId === initialCase.agentId,
      ...autoCaseCounts(broker, first.caseId),
    })
  }
  const denials = []
  const eligibleArgs = currentArgs
  for (const [label, change] of [
    ['approval', args => ({ ...args, question: 'AUTO_REPLAY: approve this revised deployment?' })],
    ['high-risk', args => ({ ...args, question: 'AUTO_REPLAY: execute this irreversible operation?' })],
    ['execution', args => ({ ...args, question: 'AUTO_REPLAY: edit this file with execution authority?' })],
  ]) {
    const before = broker.cases.getCase(first.caseId)
    const outcome = await broker.consult({ agent, args: change({ ...eligibleArgs, question: `AUTO_REPLAY: denied ${label}` }) })
      .then(value => ({ value }), error => ({ error }))
    const after = broker.cases.getCase(first.caseId)
    denials.push({
      label, errorCode: outcome.error?.code ?? null, unchanged: JSON.stringify(after) === JSON.stringify(before),
      sameAgent: after.agentId === initialCase.agentId, ...autoCaseCounts(broker, first.caseId),
    })
  }
  return { completed: true, op: 'auto-replay', caseId: first.caseId, initial, replay, revisions, denials }
}

function autoSafetyCounts(broker) {
  if (!broker.store) return { cases: 0, routes: 0, attempts: 0, evidence: 0, shadow: 0 }
  const count = table => broker.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  return {
    cases: count('cases'), routes: count('route_decisions'), attempts: count('attempts'), evidence: count('evidence'),
    shadow: broker.store.db.prepare("SELECT COUNT(*) AS n FROM route_decisions WHERE mode='auto_shadow'").get().n,
  }
}

function autoSafetyRequest(marker, options = {}) {
  return {
    questions: [{ id: `decision-auto-safety-${marker.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`, question: `AUTO_SAFETY_${marker}: choose the safe fixture`, options: [{ label: 'Safety user choice' }, { label: 'Other' }], ...options }],
    wait: { callId: `auto-safety-${marker}` },
  }
}

function normalizeAutoSafety(value, identities) {
  if (typeof value === 'string') return identities.get(value) ?? value
  if (Array.isArray(value)) return value.map(item => normalizeAutoSafety(item, identities))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeAutoSafety(item, identities)]))
  return value
}

function autoSafetyOutcome(broker, verdict, pinned, alternative) {
  const current = broker.cases.getCase(verdict.caseId)
  const attempts = broker.attempts.forCase(current.caseId)
  const evidence = broker.store.db.prepare('SELECT * FROM evidence ORDER BY created_at,evidence_id').all()
  const feedback = broker.store.db.prepare('SELECT * FROM feedback ORDER BY created_at,feedback_id').all()
  const identities = new Map([
    [pinned.agentId, 'pinned'], [alternative.agentId, 'alternative'], [current.caseId, 'case'],
    ...attempts.map((attempt, index) => [attempt.attemptId, `attempt-${index + 1}`]),
    ...evidence.map((row, index) => [row.evidence_id, `evidence-${index + 1}`]),
    ...feedback.map((row, index) => [row.feedback_id, `feedback-${index + 1}`]),
  ])
  const normalize = value => normalizeAutoSafety(value, identities)
  const scope = value => ({ ...value, workspaces: value.workspaces.map(() => 'workspace') })
  return normalize({
    delivery: { kind: verdict.kind, why: verdict.why, answer: verdict.answer },
    case: {
      agentId: current.agentId, state: current.state, closing: current.closing, awaitingReason: current.awaitingReason,
      attemptCount: current.attemptCount, request: current.request, scope: scope(current.scope), decision: current.decision,
      feedbackState: current.feedbackState, needsReview: current.needsReview,
    },
    attempts: attempts.map(attempt => ({
      attemptNo: attempt.attemptNo, agentId: attempt.agentId, outcome: attempt.outcome, reasonCode: attempt.reasonCode,
      hint: attempt.hint, error: attempt.error, claims: attempt.claims, citedEvidenceIds: attempt.citedEvidenceIds,
      gates: attempt.gates, pins: attempt.pins, packManifest: attempt.packManifest,
    })),
    evidence: evidence.map(row => ({
      agentId: row.agent_id, source: row.source, locator: JSON.parse(row.locator_json), scope: scope(JSON.parse(row.scope_json)),
      status: row.status, excerpt: row.excerpt,
    })),
    feedback: feedback.map(row => ({ caseId: row.case_id, agentId: row.agent_id, kind: row.kind, payload: JSON.parse(row.payload_json), effect: JSON.parse(row.effect_json) })),
  })
}

async function autoSafety(broker, agent, signal) {
  const root = process.env.WEIR_IT_ROOT
  if (!root) throw new Error('WEIR_IT_ROOT is required for Auto safety fixtures')
  const brokers = []
  const make = async (label, overrides = {}) => {
    const storePath = join(root, 'decision-stores', `decision-auto-safety-${label}`)
    const config = {
      decisionAgentsEnabled: true, decisionAgentStorePath: storePath,
      decisionAgentSelectorDefault: 'off', decisionAgentAutoShadow: false,
      decisionAgentAutoAnswer: true, decisionAgentAnswerTimeoutMs: 100,
      decisionAgentMaxOutputTokens: 1600, decisionAgentContextBudgetTokens: 24000,
      ...overrides,
    }
    const value = new DecisionBroker({ profileContext: { home: join(root, 'home'), name: 'weir-it' }, ctx: broker.ctx, config: () => config, now: () => 1700000000000 })
    await value.start()
    brokers.push(value)
    return { broker: value, config, storePath }
  }
  const setupAgents = async value => {
    const workspaceKey = realpathSync(agent.session.header.cwd)
    const scope = { workspaces: [workspaceKey] }
    const pinned = await value.broker.profileUpsert({ workspaceKey, name: 'Decision Auto A', scope, userDescription: 'Auto A private profile body: pinned safety evidence.', modelRoute: { chain: [] } })
    const alternative = await value.broker.profileUpsert({ workspaceKey, name: 'Decision Auto B', scope, userDescription: 'Auto B private profile body: alternative safety evidence.', modelRoute: { chain: [] } })
    return { pinned, alternative, workspaceKey }
  }
  const report = { completed: true, op: 'auto-safety' }
  try {
    const selector = await make('selector', { decisionAgentSelectorDefault: 'auto' })
    report.selector = {
      storeBefore: existsSync(selector.broker.databasePath()),
      fresh: await selector.broker.initializeSelectorDefault({ agent, source: 'startup' }),
    }
    await selector.broker.setSelector(agent.id, 'off')
    report.selector.explicitOff = await selector.broker.initializeSelectorDefault({ agent, source: 'startup' })
    const selectorPath = selector.broker.databasePath()
    await selector.broker.flush()
    const resumed = new DecisionBroker({ profileContext: selector.broker.profileContext, ctx: broker.ctx, config: () => selector.config })
    brokers.push(resumed)
    await resumed.start()
    report.selector.resumed = await resumed.initializeSelectorDefault({ agent, source: 'resume' })
    report.selector.restartedStartup = await resumed.initializeSelectorDefault({ agent, source: 'startup' })
    report.selector.persistedRows = resumed.store.db.prepare('SELECT mode,agent_id FROM selectors WHERE root_session_id=?').all(agent.id)
    report.selector.storePath = selectorPath

    const off = await make('off', { decisionAgentAutoShadow: true })
    report.off = {
      hook: await off.broker.hook({ agent, request: autoSafetyRequest('OFF'), signal }),
      consultError: await off.broker.consult({ agent, args: { question: 'AUTO_SAFETY_OFF consult', request_id: 'auto-safety-off' }, signal }).catch(error => ({ code: error.code })),
    }
    report.off.databaseExists = existsSync(off.broker.databasePath())
    report.off.storeOpen = Boolean(off.broker.store)

    const global = await make('global-off', { decisionAgentsEnabled: false, decisionAgentSelectorDefault: 'auto', decisionAgentAutoShadow: true })
    report.globalOff = {
      initial: await global.broker.initializeSelectorDefault({ agent, source: 'startup' }),
      hook: await global.broker.hook({ agent, request: autoSafetyRequest('GLOBAL_OFF'), signal }),
      consultError: await global.broker.consult({ agent, args: { question: 'AUTO_SAFETY_GLOBAL_OFF consult', request_id: 'auto-safety-global-off' }, signal }).catch(error => ({ code: error.code })),
    }
    report.globalOff.databaseExists = existsSync(global.broker.databasePath())
    report.globalOff.storeOpen = Boolean(global.broker.store)

    const excluded = await make('excluded', { decisionAgentAutoShadow: true })
    const excludedAgents = await setupAgents(excluded)
    await excluded.broker.setSelector(agent.id, 'agent', excludedAgents.pinned.agentId)
    const beforeExcluded = autoSafetyCounts(excluded.broker)
    const excludedRequests = [
      autoSafetyRequest('APPROVAL', { intent: { kind: 'approval' } }),
      autoSafetyRequest('PLAN_REVIEW', { intent: { kind: 'plan-review' } }),
      autoSafetyRequest('HIGH_RISK', { question: 'AUTO_SAFETY_HIGH_RISK: approve this irreversible high-risk operation?' }),
      autoSafetyRequest('EXECUTION', { question: 'AUTO_SAFETY_EXECUTION: edit this file with execution authority?' }),
      autoSafetyRequest('CREDENTIAL', { question: 'AUTO_SAFETY_CREDENTIAL: read this credential secret?' }),
    ]
    report.excluded = { before: beforeExcluded, hookResults: [] }
    for (const request of excludedRequests) report.excluded.hookResults.push(await excluded.broker.hook({ agent, request, signal }))
    report.excluded.afterHooks = autoSafetyCounts(excluded.broker)
    report.excluded.consults = []
    for (const [requestId, args] of [
      ['auto-safety-consult-delete', { question: 'AUTO_SAFETY_CONSULT_DELETE: delete this deployment?' }],
      ['auto-safety-consult-approval', { question: 'AUTO_SAFETY_CONSULT_APPROVAL: approve this native operation?' }],
    ]) {
      const result = await excluded.broker.consult({ agent, args: { ...args, options: [{ label: 'Native authority' }], request_id: requestId }, signal })
      report.excluded.consults.push({ result, case: excluded.broker.cases.getCase(result.caseId), routes: excluded.broker.store.db.prepare('SELECT mode,chosen,reason FROM route_decisions WHERE case_id=?').all(result.caseId) })
    }
    await excluded.broker.setSelector(agent.id, 'auto')
    report.excluded.beforeAuto = autoSafetyCounts(excluded.broker)
    report.excluded.autoHook = await excluded.broker.hook({ agent, request: autoSafetyRequest('AUTO_APPROVAL', { intent: { kind: 'approval' } }), signal })
    report.excluded.afterAuto = autoSafetyCounts(excluded.broker)

    // Classless admission: with nothing eligible the request routes nowhere and
    // never reaches a model; it is still an owned-free native handoff.
    const admission = await make('admission')
    await admission.broker.setSelector(agent.id, 'auto')
    const zero = await admission.broker.hook({ agent, request: autoSafetyRequest('ZERO'), signal })
    report.admission = {
      zero: { verdict: zero, case: admission.broker.cases.getCase(zero.caseId), counts: autoSafetyCounts(admission.broker) },
      final: autoSafetyCounts(admission.broker),
    }

    // One eligible assistant is a deterministic selection: no Router call at all.
    const single = await make('single')
    const singleAgent = await single.broker.profileUpsert({ workspaceKey: realpathSync(agent.session.header.cwd), name: 'Decision Auto Single', userDescription: 'Single candidate fixture', modelRoute: { chain: [] } })
    await single.broker.setSelector(agent.id, 'auto')
    const singleVerdict = await single.broker.hook({ agent, request: autoSafetyRequest('SINGLE'), signal })
    report.single = { agentId: singleAgent.agentId, verdict: singleVerdict, case: single.broker.cases.getCase(singleVerdict.caseId), route: single.broker.store.db.prepare('SELECT mode,chosen,reason FROM route_decisions WHERE case_id=?').all(singleVerdict.caseId) }

    const isolation = await make('isolation')
    const local = await setupAgents(isolation)
    const otherWorkspace = join(root, 'ws', 'decision-auto-safety-other-workspace')
    mkdirSync(otherWorkspace, { recursive: true })
    const otherWorkspaceKey = realpathSync(otherWorkspace)
    const foreign = await isolation.broker.profileUpsert({ workspaceKey: otherWorkspaceKey, name: 'FORBIDDEN FOREIGN ROUTER CANDIDATE', scope: { workspaces: [otherWorkspaceKey] }, userDescription: 'FOREIGN WORKSPACE PRIVATE PROFILE BODY', modelRoute: { chain: [] } })
    await isolation.broker.setSelector(agent.id, 'auto')
    const isolated = await isolation.broker.hook({ agent, request: autoSafetyRequest('ISOLATION'), signal })
    report.isolation = {
      caseId: isolated.caseId, case: isolation.broker.cases.getCase(isolated.caseId),
      localAgents: [local.pinned.agentId, local.alternative.agentId], foreignAgent: foreign.agentId,
      route: isolation.broker.store.db.prepare('SELECT * FROM route_decisions WHERE case_id=?').get(isolated.caseId),
      attempts: isolation.broker.attempts.forCase(isolated.caseId),
    }

    const runShadow = async (label, enabled, failure) => {
      const value = await make(`shadow-${label}`, { decisionAgentAutoShadow: enabled })
      const agents = await setupAgents(value)
      await value.broker.setSelector(agent.id, 'agent', agents.pinned.agentId)
      if (failure === 'write') value.broker.store.db.exec("CREATE TRIGGER reject_auto_safety_shadow BEFORE INSERT ON route_decisions WHEN NEW.mode='auto_shadow' BEGIN SELECT RAISE(ABORT,'forced safety shadow write failure'); END;")
      const request = autoSafetyRequest(failure ? 'SHADOW_FAILURE_CONTROL' : 'SHADOW_CONTROL')
      const requestSnapshot = structuredClone(request)
      if (failure) process.env.WEIR_IT_AUTO_SHADOW_FAILURE = failure
      try {
        const verdict = await value.broker.hook({ agent, request, signal })
        const real = autoSafetyOutcome(value.broker, verdict, agents.pinned, agents.alternative)
        const routesBeforeReplay = value.broker.store.db.prepare('SELECT * FROM route_decisions WHERE case_id=? ORDER BY rowid').all(verdict.caseId)
        const replay = await value.broker.hook({ agent, request, signal })
        const routesAfterReplay = value.broker.store.db.prepare('SELECT * FROM route_decisions WHERE case_id=? ORDER BY rowid').all(verdict.caseId)
        return {
          caseId: verdict.caseId, real, routes: routesAfterReplay.map(route => ({ mode: route.mode, chosen: route.chosen, reason: route.reason })),
          appendOnly: JSON.stringify(routesAfterReplay.slice(0, routesBeforeReplay.length)) === JSON.stringify(routesBeforeReplay),
          replaySameAnswer: replay.kind === verdict.kind && replay.caseId === verdict.caseId && JSON.stringify(replay.answer) === JSON.stringify(verdict.answer), requestUnchanged: JSON.stringify(request) === JSON.stringify(requestSnapshot),
          counts: autoSafetyCounts(value.broker),
        }
      } finally {
        delete process.env.WEIR_IT_AUTO_SHADOW_FAILURE
      }
    }
    const shadowControl = await runShadow('control', false)
    const shadowObserved = await runShadow('observed', true)
    report.shadow = {
      control: shadowControl, observed: shadowObserved,
      parity: JSON.stringify(shadowObserved.real) === JSON.stringify(shadowControl.real),
      failures: [],
    }
    const failureControl = await runShadow('failure-control', false, 'control')
    for (const failure of ['routing', 'write']) {
      const value = await runShadow(`failure-${failure}`, true, failure)
      report.shadow.failures.push({ failure, equal: JSON.stringify(value.real) === JSON.stringify(failureControl.real), ...value })
    }

    const unowned = await make('unowned')
    const unownedAgents = await setupAgents(unowned)
    await unowned.broker.setSelector(agent.id, 'auto')
    const open = async action => {
      const args = { question: `AUTO_SAFETY_UNOWNED_${action.toUpperCase()}: user must decide`, options: [{ label: 'Unowned user answer' }, { label: 'Other' }], request_id: `auto-safety-unowned-${action}` }
      const result = await unowned.broker.consult({ agent, args, signal })
      return { args, result, case: unowned.broker.cases.getCase(result.caseId) }
    }
    const answer = await open('answer')
    const answered = await unowned.broker.decide({ caseId: answer.result.caseId, answers: [{ id: 'question', selected: ['Unowned user answer'] }] })
    const reread = await unowned.broker.consult({ agent, args: answer.args, signal })
    const cancel = await open('cancel')
    const cancelled = await unowned.broker.cancel({ caseId: cancel.result.caseId })
    const retry = await open('retry')
    const retryBefore = JSON.stringify(unowned.broker.cases.getCase(retry.result.caseId))
    const retryError = await unowned.broker.retry({ caseId: retry.result.caseId }).catch(error => ({ code: error.code }))
    const retryAfter = unowned.broker.cases.getCase(retry.result.caseId)
    const reassign = await open('reassign')
    const reassigned = await unowned.broker.reassign({ caseId: reassign.result.caseId, agentId: unownedAgents.pinned.agentId })
    report.unowned = {
      answer: { opened: answer, answered, reread, evidence: unowned.broker.store.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE json_extract(locator_json,'$.caseId')=?").get(answer.result.caseId).n },
      cancel: { opened: cancel, cancelled, counts: autoCaseCounts(unowned.broker, cancel.result.caseId) },
      retry: { opened: retry, error: retryError, unchanged: JSON.stringify(retryAfter) === retryBefore, after: retryAfter, counts: autoCaseCounts(unowned.broker, retry.result.caseId) },
      reassign: { opened: reassign, reassigned, current: unowned.broker.cases.getCase(reassign.result.caseId), routes: unowned.broker.store.db.prepare('SELECT mode,chosen,reason FROM route_decisions WHERE case_id=? ORDER BY rowid').all(reassign.result.caseId), counts: autoCaseCounts(unowned.broker, reassign.result.caseId) },
      final: autoSafetyCounts(unowned.broker),
    }

    const retryAuthority = await make('retry-authority')
    await setupAgents(retryAuthority)
    await retryAuthority.broker.setSelector(agent.id, 'auto')
    const retryOpened = await retryAuthority.broker.consult({ agent, args: {
      question: 'AUTO_SAFETY_RETRY: owned Auto Case must revalidate exclusion', options: [{ label: 'Retry must be denied' }],
      request_id: 'auto-safety-retry-authority',
    }, signal })
    const retryOwned = retryAuthority.broker.cases.getCase(retryOpened.caseId)
    const retryDeniedRequest = {
      ...retryOwned.request,
      questions: retryOwned.request.questions.map(question => ({ ...question, intent: { kind: 'approval' } })),
    }
    await retryAuthority.broker.store.write(db => {
      db.prepare('UPDATE cases SET request_json=? WHERE case_id=?').run(JSON.stringify(retryDeniedRequest), retryOwned.caseId)
    })
    const retryAuthorityBefore = retryAuthority.broker.cases.getCase(retryOwned.caseId)
    const authorityRetryError = await retryAuthority.broker.retry({ caseId: retryOwned.caseId }).catch(error => ({ code: error.code }))
    const retryAuthorityAfter = retryAuthority.broker.cases.getCase(retryOwned.caseId)
    report.retryAuthority = {
      before: retryAuthorityBefore, error: authorityRetryError, unchanged: JSON.stringify(retryAuthorityAfter) === JSON.stringify(retryAuthorityBefore),
      counts: autoCaseCounts(retryAuthority.broker, retryOwned.caseId),
    }

    const reassignAuthority = await make('reassign-authority')
    const reassignAgents = await setupAgents(reassignAuthority)
    await reassignAuthority.broker.setSelector(agent.id, 'auto')
    const reassignOpened = await reassignAuthority.broker.consult({ agent, args: {
      question: 'AUTO_SAFETY_UNOWNED_REASSIGN_AUTHORITY: current answer switch must be rechecked',
      options: [{ label: 'Reassign must be denied' }], request_id: 'auto-safety-reassign-authority',
    }, signal })
    reassignAuthority.config.decisionAgentAutoAnswer = false
    const reassignBefore = reassignAuthority.broker.cases.getCase(reassignOpened.caseId)
    const reassignError = await reassignAuthority.broker.reassign({ caseId: reassignOpened.caseId, agentId: reassignAgents.pinned.agentId }).catch(error => ({ code: error.code }))
    const reassignAfter = reassignAuthority.broker.cases.getCase(reassignOpened.caseId)
    report.reassignAuthority = {
      before: reassignBefore, error: reassignError, unchanged: JSON.stringify(reassignAfter) === JSON.stringify(reassignBefore),
      counts: autoCaseCounts(reassignAuthority.broker, reassignOpened.caseId),
    }

    const flush = await make('flush')
    await setupAgents(flush)
    await flush.broker.setSelector(agent.id, 'auto')
    const flushReady = join(root, 'decision-auto-flush.ready')
    const flushRelease = join(root, 'decision-auto-flush.release')
    rmSync(flushReady, { force: true })
    rmSync(flushRelease, { force: true })
    let flushSettled = false
    const flushing = flush.broker.consult({ agent, args: {
      question: 'AUTO_SAFETY_FLUSH: abort and await this route', options: [{ label: 'Must not auto answer' }], request_id: 'auto-safety-flush',
    }, signal }).then(value => { flushSettled = true; return value }, error => { flushSettled = true; throw error })
    try {
      await waitForFile(flushReady, signal)
      const databasePath = flush.broker.store.path
      const before = autoSafetyCounts(flush.broker)
      const received = flush.broker.store.db.prepare('SELECT case_id,state,agent_id,attempt_count FROM cases').all()
      await flush.broker.flush()
      const result = await flushing
      const readAuthority = () => {
        const db = new DatabaseSync(databasePath, { readOnly: true })
        try {
          return {
            cases: db.prepare('SELECT * FROM cases ORDER BY case_id').all(),
            routes: db.prepare('SELECT * FROM route_decisions ORDER BY route_decision_id').all(),
            attempts: db.prepare('SELECT * FROM attempts ORDER BY attempt_id').all(),
            evidence: db.prepare('SELECT * FROM evidence ORDER BY evidence_id').all(),
          }
        } finally { db.close() }
      }
      const after = readAuthority()
      await new Promise(resolve => setTimeout(resolve, 40))
      const later = readAuthority()
      report.flush = {
        result, before, received, after, later,
        lateStable: JSON.stringify(after) === JSON.stringify(later), settled: flushSettled,
        flights: flush.broker.autoFlights.size, controllers: flush.broker.routingControllers.size,
        jobs: flush.broker.routingJobs.size, active: flush.broker.activeEvaluations,
      }
    } finally {
      writeFileSync(flushRelease, JSON.stringify({ at: Date.now(), cleanup: true }) + '\n')
    }

    const path = join(root, 'ws', 'decision-auto-safety.json')
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n')
    return {
      completed: true, op: 'auto-safety', path,
      selector: report.selector, off: report.off, globalOff: report.globalOff,
      shadowParity: report.shadow.parity, shadowFailures: report.shadow.failures.map(item => ({ failure: item.failure, equal: item.equal, routes: item.routes })),
      admission: report.admission.final, unowned: report.unowned.final,
      flush: report.flush ? { result: report.flush.result, lateStable: report.flush.lateStable, settled: report.flush.settled } : null,
    }
  } finally {
    delete process.env.WEIR_IT_AUTO_SHADOW_FAILURE
    await Promise.allSettled(brokers.map(value => value.flush()))
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.tools.register({
    name: 'decision_integration_probe',
    description: 'Create isolated Decision Agent fixtures through the real Broker. Dev-only integration probe.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['setup', 'record', 'route-setup', 'disable-a', 'case-for-call', 'feedback', 'correction', 'isolation-setup', 'select', 'cross-consult', 'learning-seed', 'delete-source', 'auto-setup', 'auto-singleflight', 'auto-replay', 'auto-safety'] },
        caseId: { type: 'string' }, agentId: { type: 'string' }, verb: { type: 'string' }, text: { type: 'string' },
        direction: { type: 'string' }, scope: { type: 'object' }, supersedes: { type: 'array', items: { type: 'string' } },
        questions: { type: 'array', items: { type: 'object' } },
        question: { type: 'string' }, otherWorkspace: { type: 'string' },
      },
      required: ['op'],
    },
    output: { schema: { type: 'object' }, render },
    async execute(args, exec) {
      try {
        const broker = ctx.get('weirDecisionBroker')
        const agent = exec.agent
        if (!broker || !agent?.id) throw new Error('Decision Broker and execution Agent are required')
        if (args.op === 'auto-setup') return await autoSetup(broker, agent)
        if (args.op === 'auto-singleflight') return await autoSingleflight(broker, agent, exec.signal)
        if (args.op === 'auto-replay') return await autoReplay(broker, agent)
        if (args.op === 'auto-safety') return await autoSafety(broker, agent, exec.signal)
        if (args.op === 'learning-seed') return await learningSeed(broker, agent)
        if (args.op === 'delete-source') {
          const deleted = await broker.store.write(db => {
            const source = db.prepare('SELECT * FROM cases WHERE case_id=?').get(args.caseId)
            if (!source) throw new Error(`Missing deletion fixture ${args.caseId}`)
            const evidence = db.prepare("DELETE FROM evidence WHERE json_extract(locator_json,'$.caseId')=?").run(args.caseId)
            const cases = db.prepare('DELETE FROM cases WHERE case_id=?').run(args.caseId)
            return { caseId: args.caseId, evidence: evidence.changes, cases: cases.changes }
          })
          return { completed: true, op: args.op, deleted }
        }
        if (args.op === 'record') {
          const record = await broker.record({ sessionId: agent.id, caseId: args.caseId })
          const inbox = await broker.inbox({ sessionId: agent.id })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, caseId: args.caseId, record, inbox }))
        }
        if (args.op === 'case-for-call') {
          const record = await broker.caseForCall({ sessionId: agent.id, questions: args.questions })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, record }))
        }
        if (args.op === 'feedback') {
          const result = await broker.feedback({ caseId: args.caseId, verb: args.verb, ...(args.text === undefined ? {} : { payload: { text: args.text } }) })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, result, case: broker.cases.getCase(args.caseId) }))
        }
        if (args.op === 'correction') {
          const result = await broker.correction({ caseId: args.caseId, direction: args.direction, scope: args.scope, supersedes: args.supersedes })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, result, case: broker.cases.getCase(args.caseId) }))
        }
        if (args.op === 'isolation-setup') {
          const workspaceKey = realpathSync(agent.session.header.cwd)
          const otherWorkspace = join(workspaceKey, 'decision-isolation-other')
          mkdirSync(otherWorkspace, { recursive: true })
          const otherWorkspaceKey = realpathSync(otherWorkspace)
          const scope = { workspaces: [workspaceKey] }
          const agentA = await broker.profileUpsert({ workspaceKey, name: 'Decision Isolation A', scope, userDescription: 'A private profile marker must never reach Agent B.', modelRoute: { chain: [] } })
          const agentB = await broker.profileUpsert({ workspaceKey, name: 'Decision Isolation B', scope, userDescription: 'B has an independent namespace and no prior decision.', modelRoute: { chain: [] } })
          const agentC = await broker.profileUpsert({ workspaceKey: otherWorkspaceKey, name: 'Decision Isolation W2', scope: { workspaces: [otherWorkspaceKey] }, userDescription: 'W2 has no W1 evidence.', modelRoute: { chain: [] } })
          await broker.setSelector(agent.id, 'agent', agentA.agentId)
          return { completed: true, op: args.op, agentA: agentA.agentId, agentB: agentB.agentId, agentC: agentC.agentId, workspaceKey, otherWorkspace: otherWorkspaceKey }
        }
        if (args.op === 'select') {
          const selector = await broker.setSelector(agent.id, 'agent', args.agentId)
          return { completed: true, op: args.op, selector }
        }
        if (args.op === 'cross-consult') {
          const header = agent.session.header
          const crossAgent = {
            id: agent.id,
            session: {
              header: { ...header, cwd: args.otherWorkspace },
              requestContext: () => agent.session.requestContext(),
            },
          }
          const result = await broker.consult({ agent: crossAgent, args: { question: args.question, options: [{ label: 'W2 native' }, { label: 'W1 answer' }], agent_id: args.agentId, request_id: 'isolation-cross' }, signal: exec.signal })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, result }))
        }
        if (args.op === 'route-setup') {
          const workspaceKey = realpathSync(agent.session.header.cwd)
          const scope = { workspaces: [workspaceKey] }
          const agentA = await broker.profileUpsert({ workspaceKey, name: 'Decision Route A', scope, userDescription: 'For a pinned Decision Route request, select Pinned A.', modelRoute: { chain: [] } })
          const agentB = await broker.profileUpsert({ workspaceKey, name: 'Decision Route B', scope, userDescription: 'For an explicit Decision Route consultation, select Explicit B.', modelRoute: { chain: [] } })
          await broker.setSelector(agent.id, 'agent', agentA.agentId)
          return { completed: true, op: args.op, agentA: agentA.agentId, agentB: agentB.agentId, selector: broker.selector(agent.id) }
        }
        if (args.op === 'disable-a') {
          const profile = await broker.profileSetState(args.agentId, 'disabled')
          return { completed: true, op: args.op, agentId: profile.agentId, state: profile.state, selector: broker.selector(agent.id) }
        }
        if (args.op !== 'setup') throw new Error(`Unsupported Decision probe operation: ${args.op}`)
        const cwd = agent.session?.header?.cwd
        if (typeof cwd !== 'string') throw new Error('Session cwd is required')
        const databasePath = broker.databasePath()
        const before = {
          storeExistedBeforeSetup: existsSync(databasePath),
          storeOpenBeforeSetup: Boolean(broker.store),
        }
        const workspaceKey = realpathSync(cwd)
        const profile = await broker.profileUpsert({
          workspaceKey,
          name: `Decision ${process.env.WEIR_IT_SCENARIO ?? 'integration'} QA`,
          scope: { workspaces: [workspaceKey] },
          userDescription: 'For Decision Hook QA, prefer the Concise title when that option is available.',
          modelRoute: { chain: [] },
        })
        await broker.setSelector(agent.id, 'agent', profile.agentId)
        return {
          completed: true,
          op: args.op,
          ...before,
          databasePath,
          workspaceKey,
          rootSessionId: agent.id,
          agentId: profile.agentId,
          selector: broker.selector(agent.id),
        }
      } catch (error) {
        return { completed: false, op: args.op, error: error?.message ?? String(error) }
      }
    },
  })
}
