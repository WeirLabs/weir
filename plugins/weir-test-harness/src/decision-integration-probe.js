// Live Decision Agent integration fixtures. Dev-only; never mount in a real profile.
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
    scope: { workspaces: [input.workspaceKey], authorizationClasses: ['A', 'B', 'C'] },
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
    scope: { workspaces: [input.workspaceKey], authorizationClasses: ['A', 'B', 'C'] },
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
  const scope = { workspaces: [workspaceKey], authorizationClasses: ['A', 'B', 'C'] }
  const agentA = await broker.profileUpsert({ workspaceKey, name: 'Decision Learning A', scope, userDescription: 'Use the reviewed principle only with its evidence.', modelRoute: { chain: [] } })
  const agentB = await broker.profileUpsert({ workspaceKey, name: 'Decision Learning B', scope, userDescription: 'Independent Agent namespace.', modelRoute: { chain: [] } })
  const agentC = await broker.profileUpsert({ workspaceKey: otherWorkspaceKey, name: 'Decision Learning W2', scope: { workspaces: [otherWorkspaceKey], authorizationClasses: ['A', 'B', 'C'] }, userDescription: 'Foreign workspace namespace.', modelRoute: { chain: [] } })
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
    workspaceKey, name: 'Decision Auto A', scope: { ...base, authorizationClasses: ['A'] },
    userDescription: 'Auto A private profile body: select the evidenced A answer.', modelRoute: { chain: [] },
  })
  const agentB = await broker.profileUpsert({
    workspaceKey, name: 'Decision Auto B', scope: { ...base, authorizationClasses: ['A', 'B'] },
    userDescription: 'Auto B private profile body: select the evidenced B answer.', modelRoute: { chain: [] },
  })
  await broker.setSelector(agent.id, 'auto')
  return { completed: true, op: 'auto-setup', agentA: agentA.agentId, agentB: agentB.agentId, workspaceKey, rootSessionId: agent.id, selector: broker.selector(agent.id) }
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
    return { completed: true, op: 'auto-singleflight', caseId, before, after }
  } finally {
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
    derivedClass: initialQuestion.authorizationClass, derivedSource: initialQuestion.authorizationClassSource,
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
    currentArgs = change(currentArgs)
    const result = await broker.consult({ agent, args: currentArgs })
    const current = broker.cases.getCase(first.caseId)
    revisions.push({
      field, outcome: result.outcome, state: current.state, sameAgent: current.agentId === initialCase.agentId,
      ...autoCaseCounts(broker, first.caseId),
    })
  }
  return { completed: true, op: 'auto-replay', caseId: first.caseId, initial, replay, revisions }
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.tools.register({
    name: 'decision_integration_probe',
    description: 'Create isolated Decision Agent fixtures through the real Broker. Dev-only integration probe.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['setup', 'record', 'route-setup', 'disable-a', 'case-for-call', 'feedback', 'correction', 'isolation-setup', 'select', 'cross-consult', 'learning-seed', 'delete-source', 'auto-setup', 'auto-singleflight', 'auto-replay'] },
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
          const scope = { workspaces: [workspaceKey], authorizationClasses: ['A', 'B', 'C'] }
          const agentA = await broker.profileUpsert({ workspaceKey, name: 'Decision Isolation A', scope, userDescription: 'A private profile marker must never reach Agent B.', modelRoute: { chain: [] } })
          const agentB = await broker.profileUpsert({ workspaceKey, name: 'Decision Isolation B', scope, userDescription: 'B has an independent namespace and no prior decision.', modelRoute: { chain: [] } })
          const agentC = await broker.profileUpsert({ workspaceKey: otherWorkspaceKey, name: 'Decision Isolation W2', scope: { workspaces: [otherWorkspaceKey], authorizationClasses: ['A', 'B', 'C'] }, userDescription: 'W2 has no W1 evidence.', modelRoute: { chain: [] } })
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
          const scope = { workspaces: [workspaceKey], authorizationClasses: ['A', 'B', 'C'] }
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
          scope: { workspaces: [workspaceKey], authorizationClasses: ['A', 'B', 'C'] },
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
