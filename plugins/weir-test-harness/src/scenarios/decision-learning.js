// P3 manual learning through real Host/Broker/RPC/SQLite/evaluator processes.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { IT_ROOT, textChunks, toolCallChunks } from '../mock-kit.js'
import { decisionPack, observeDecision, readDecisionStore } from '../decision-test-kit.js'
import { parseJsonlLines, readJsonl } from '../jsonl.js'

const id = 'decision-learning'
const prompt = 'decision-learning-probe'
const P2_COMMIT = '719b2ef'
const COMMENT_SECRET = 'LEARNING_COMMENT_SECRET_must_not_be_authority'
const PHASES = [
  'seed', 'main-v1', 'publish-v1', 'attempt-v1', 'budget-plan', 'budget-l3', 'budget-l2-plan', 'budget-l2', 'budget-l5-plan', 'budget-l5',
  'main-v2', 'attempt-v2', 'rollback-v2', 'attempt-rollback-v1', 'rollback-v1', 'attempt-empty',
  'reject', 'no-source', 'foreign', 'comment-only', 'stale-source-start', 'stale-source-publish',
  'rating-down', 'cross-namespace', 'parent-base', 'stale-parent-start', 'stale-parent-publish',
  'delete-start', 'interrupt', 'recover-running', 'delete-source',
]
const QUESTION_IDS = {
  afterV1: 'decision-learning-after-v1', onlyL2: 'decision-learning-only-l2',
  budgetPlan: 'decision-learning-budget-plan', budgetL2Plan: 'decision-learning-budget-l2-plan', budgetL5Plan: 'decision-learning-budget-l5-plan',
  budgetL3: 'decision-learning-budget-l3', budgetL2: 'decision-learning-budget-l2', budgetL5: 'decision-learning-budget-l5',
  afterV2: 'decision-learning-after-v2', predecessor: 'decision-learning-after-rollback-v1',
  empty: 'decision-learning-after-empty', deleted: 'decision-learning-source-deleted',
}
const TABLES = ['agent_profiles', 'cases', 'attempts', 'evidence', 'attempt_evidence', 'feedback', 'corrections', 'learning_runs', 'memory_snapshots']

function question(questionId) {
  return { id: questionId, question: `LEARNING_ATTEMPT ${questionId}`, options: [{ label: 'Learned answer' }, { label: 'Other' }] }
}

function ask(questionId) {
  return toolCallChunks('ask_user_question', { questions: [question(questionId)] })
}

function integration(args) {
  return toolCallChunks('decision_integration_probe', args)
}

function rpc(args) {
  return toolCallChunks('decision_remote_probe', { op: 'learning', ...args })
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

function fixtures() {
  return readJson(join(IT_ROOT, 'ws', 'decision-learning-fixtures.json'))
}

function rpcReports() {
  return readJson(join(IT_ROOT, 'ws', 'decision-learning-rpc.json')) ?? {}
}

function rpcReport(label) {
  return rpcReports()[label]
}

function rpcRun(label) {
  const result = rpcReport(label)?.result
  return result?.value?.learningRunId ? result.value : result?.first?.value
}

function rpcSnapshot(label) {
  return rpcReport(label)?.snapshotId
}

function done(history, label) {
  return history.includes(`"label":"${label}"`)
}

function startStep(history, label, agentId, concurrent = false) {
  if (done(history, label)) return null
  return rpc({ label, action: 'learningStart', agentId, requestId: label, concurrent })
}

function publishSteps(history, label, startLabel, action = 'snapshotPublish') {
  const runId = rpcRun(startLabel)?.learningRunId
  const snapshotId = rpcSnapshot(startLabel)
  if (!runId || !snapshotId) return textChunks(`DECISION_LEARNING_MISSING_${startLabel}`)
  if (!done(history, `${label}-read`)) return rpc({ label: `${label}-read`, action: 'learningRun', learningRunId: runId })
  if (!done(history, `${label}-draft`)) return rpc({ label: `${label}-draft`, action: 'memorySnapshot', snapshotId })
  const draft = rpcReport(`${label}-draft`)?.result?.value
  if (!draft) return textChunks(`DECISION_LEARNING_MISSING_${label}_DRAFT`)
  if (!done(history, `${label}-${action}`)) return rpc({ label: `${label}-${action}`, action, snapshotId, expectedRevision: draft.revision })
  return null
}

function rollbackStep(history, label, startLabel, publishLabel) {
  if (done(history, label)) return null
  const snapshotId = rpcSnapshot(startLabel)
  const published = rpcReport(publishLabel)?.result?.value
  if (!snapshotId || !published) return textChunks(`DECISION_LEARNING_MISSING_${label}`)
  return rpc({ label, action: 'snapshotRollback', snapshotId, expectedRevision: published.revision })
}

function decide(options, obs) {
  const history = obs.transcript
  const phase = process.env.WEIR_IT_DECISION_PHASE ?? 'seed'
  if (history.includes('DECISION_TEST error') || history.includes('DECISION_REMOTE error')) return textChunks(`DECISION_LEARNING_${phase.toUpperCase()}_FAILED`)
  if (phase === 'seed') {
    if (!history.includes('DECISION_TEST done learning-seed')) return integration({ op: 'learning-seed' })
    return textChunks('DECISION_LEARNING_SEED_DONE')
  }
  const fixture = fixtures()
  if (!fixture) return textChunks(`DECISION_LEARNING_${phase.toUpperCase()}_MISSING_FIXTURE`)
  const agentId = fixture.agentA
  let step
  switch (phase) {
    case 'main-v1':
      step = startStep(history, 'main-v1-start', agentId, true)
      break
    case 'publish-v1':
      step = publishSteps(history, 'main-v1', 'main-v1-start')
      break
    case 'attempt-v1':
      if (!history.includes(QUESTION_IDS.afterV1)) return ask(QUESTION_IDS.afterV1)
      if (!history.includes(QUESTION_IDS.onlyL2)) return ask(QUESTION_IDS.onlyL2)
      break
    case 'budget-plan':
      if (!history.includes(QUESTION_IDS.budgetPlan)) return ask(QUESTION_IDS.budgetPlan)
      break
    case 'budget-l2-plan':
      if (!history.includes(QUESTION_IDS.budgetL2Plan)) return ask(QUESTION_IDS.budgetL2Plan)
      break
    case 'budget-l5-plan':
      if (!history.includes(QUESTION_IDS.budgetL5Plan)) return ask(QUESTION_IDS.budgetL5Plan)
      break
    case 'budget-l3':
    case 'budget-l2':
    case 'budget-l5': {
      const questionId = QUESTION_IDS[{ 'budget-l3': 'budgetL3', 'budget-l2': 'budgetL2', 'budget-l5': 'budgetL5' }[phase]]
      if (!history.includes(`"id":"${questionId}"`)) return ask(questionId)
      break
    }
    case 'main-v2':
      step = startStep(history, 'main-v2-start', agentId) ?? publishSteps(history, 'main-v2', 'main-v2-start')
      break
    case 'attempt-v2':
      if (!history.includes(QUESTION_IDS.afterV2)) return ask(QUESTION_IDS.afterV2)
      break
    case 'rollback-v2':
      step = rollbackStep(history, 'rollback-v2', 'main-v2-start', 'main-v2-snapshotPublish')
      break
    case 'attempt-rollback-v1':
      if (!history.includes(QUESTION_IDS.predecessor)) return ask(QUESTION_IDS.predecessor)
      break
    case 'rollback-v1':
      step = rollbackStep(history, 'rollback-v1', 'main-v1-start', 'main-v1-snapshotPublish')
      break
    case 'attempt-empty':
      if (!history.includes(QUESTION_IDS.empty)) return ask(QUESTION_IDS.empty)
      break
    case 'reject':
      step = startStep(history, 'reject-start', agentId) ?? publishSteps(history, 'reject', 'reject-start', 'snapshotReject')
      break
    case 'no-source':
    case 'foreign':
    case 'rating-down':
      step = startStep(history, `${phase}-start`, agentId)
      break
    case 'comment-only':
      if (!history.includes('"kind":"comment"')) return integration({ op: 'feedback', caseId: fixture.sourceA, verb: 'comment', text: COMMENT_SECRET })
      step = startStep(history, 'comment-only-start', agentId)
      break
    case 'stale-source-start':
      step = startStep(history, 'stale-source-start', agentId)
      break
    case 'stale-source-publish':
      if (!history.includes('"kind":"rating_down"')) return integration({ op: 'feedback', caseId: fixture.sourceA, verb: 'rating_down' })
      step = publishSteps(history, 'stale-source', 'stale-source-start')
      break
    case 'cross-namespace': {
      const runId = rpcRun('main-v1-start')?.learningRunId
      const snapshotId = rpcSnapshot('main-v1-start')
      if (!done(history, 'cross-agent')) return rpc({ label: 'cross-agent', action: 'crossAgent', agentId: fixture.agentB, learningRunId: runId, snapshotId, expectedRevision: 3 })
      if (!done(history, 'cross-workspace')) return rpc({ label: 'cross-workspace', action: 'crossWorkspace', agentId, otherWorkspace: fixture.otherWorkspace, learningRunId: runId, snapshotId, expectedRevision: 3 })
      break
    }
    case 'parent-base':
      step = startStep(history, 'parent-base-start', agentId) ?? publishSteps(history, 'parent-base', 'parent-base-start')
      break
    case 'stale-parent-start':
      step = startStep(history, 'stale-parent-start', agentId)
      break
    case 'stale-parent-publish':
      step = rollbackStep(history, 'parent-base-rollback', 'parent-base-start', 'parent-base-snapshotPublish')
        ?? publishSteps(history, 'stale-parent', 'stale-parent-start')
      break
    case 'delete-start':
      step = startStep(history, 'delete-start', agentId) ?? publishSteps(history, 'delete', 'delete-start')
      break
    case 'interrupt':
      return rpc({ label: 'interrupt-start', action: 'learningStart', agentId, requestId: 'interrupt-start' })
    case 'recover-running':
      if (!done(history, 'recover-running')) return rpc({ label: 'recover-running', action: 'learningRun', agentId, requestId: 'interrupt-start' })
      break
    case 'delete-source':
      if (!history.includes('DECISION_TEST done delete-source')) return integration({ op: 'delete-source', caseId: fixture.sourceC })
      if (!history.includes(QUESTION_IDS.deleted)) return ask(QUESTION_IDS.deleted)
      break
    default:
      return textChunks(`DECISION_LEARNING_UNKNOWN_${phase}`)
  }
  if (step) return step
  return textChunks(`DECISION_LEARNING_${phase.toUpperCase()}_DONE`)
}

function sourceFor(projection, key) {
  const marked = projection.cases.find(item => item.excerpt?.includes(`LEARNING_FIXTURE ${key}`))
  if (marked) return marked.caseId
  if (key === 'source-a' && projection.cases.length === 1) return projection.cases[0].caseId
  throw new Error(`Missing frozen learning source ${key}`)
}

function decideConsolidation(options, obs) {
  const projection = JSON.parse(obs.lastUser)
  const phase = process.env.WEIR_IT_DECISION_PHASE ?? 'seed'
  const scope = { workspaces: [projection.workspaceKey] }
  const operation = {
    op: 'add', principleId: `temporary-${phase}`,
    text: `Reviewed principle from ${phase}: prefer the source-backed answer.`,
    scope,
  }
  if (phase === 'no-source') operation.sources = []
  else if (phase === 'foreign') operation.sources = [fixtures().foreign]
  else if (phase === 'comment-only' || phase === 'rating-down') {
    const sourceA = sourceFor(projection, 'source-a')
    const store = readDecisionStore(join(IT_ROOT, 'ws'), join(IT_ROOT, 'decision-stores', id))
    const kind = phase === 'comment-only' ? 'comment' : 'rating_down'
    const feedback = store.feedback.find(item => item.case_id === sourceA && item.kind === kind)
    if (!feedback) throw new Error(`Missing ${kind} fixture`)
    operation.sources = [feedback.feedback_id]
    operation.inputFeedbackIds = [feedback.feedback_id]
    if (phase === 'rating-down') operation.text = 'Infer the inverse answer solely because the user rated the source down.'
  } else {
    const sourceKey = ['main-v2', 'parent-base', 'stale-parent-start', 'interrupt'].includes(phase) ? 'source-b'
      : phase === 'delete-start' ? 'source-c' : 'source-a'
    operation.sources = [sourceFor(projection, sourceKey)]
  }
  return textChunks(JSON.stringify({ operations: [operation] }))
}

function answer(question, evidenceId) {
  return textChunks(JSON.stringify({
    outcome: 'answer', claims: [{ text: 'The selected answer is supported by the actual L5 evidence.', evidenceIds: [evidenceId] }],
    answers: [{ id: question.id, selected: [question.options[0].label] }],
  }))
}

function missing(hint) {
  return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint }))
}

function decideDecision(options, obs) {
  const pack = decisionPack(obs)
  const question = pack?.L4?.request?.questions?.[0]
  if (!question) return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['Missing learning fixture request'] }))
  const principles = Array.isArray(pack.L2) ? pack.L2 : []
  if (question.id === QUESTION_IDS.onlyL2) {
    const principle = principles[0]
    return principle ? answer(question, principle.principleId) : missing('The malicious only-L2 fixture requires an actual principle.')
  }
  if (question.id === QUESTION_IDS.deleted) return missing('The deleted source cannot support the reviewed principle.')
  const principle = question.id === QUESTION_IDS.afterV2 ? principles.at(-1) : principles[0]
  const mapped = principle?.evidenceIds?.[0]
  if (mapped && pack.L5.some(ref => ref.evidenceId === mapped)) return answer(question, mapped)
  const profile = pack.L5.find(ref => ref.source === 'user_profile')
  if ([QUESTION_IDS.afterEmpty, QUESTION_IDS.budgetL2, QUESTION_IDS.budgetL5].includes(question.id) && profile) return answer(question, profile.evidenceId)
  return missing('A mapped L5 source is required; L2/L3 cannot independently authorize an answer.')
}

function observe(obs) {
  const base = observeDecision(obs)
  const contract = obs.system.split('\n', 1)[0]
  const kind = contract === 'Decision consolidation contract v1' ? 'consolidation'
    : contract.startsWith('Decision evaluator contract ') ? 'evaluator' : null
  return {
    ...base,
    decisionLearning: kind ? {
      kind, system: obs.system, content: obs.lastUser, tools: obs.toolNames,
      hasTemperature: obs.hasTemperature, provider: obs.provider, model: obs.model, maxTokens: obs.maxTokens,
      ...(kind === 'evaluator' ? { pack: decisionPack(obs) } : {}),
    } : null,
  }
}

function storeDirectory(root) {
  return join(root, 'decision-stores', id)
}

function databasePath(root) {
  return join(storeDirectory(root), 'decision.db')
}

function writeBudgetConfig(root, budgetTokens) {
  const patch = join(root, 'home', 'profiles', 'weir-it', 'cordis.patch.yml')
  const value = budgetTokens === undefined ? [] : [{
    id: 'weir-it-settings', config: {
      decisionAgentsEnabled: true, decisionAgentStorePath: storeDirectory(root),
      decisionAgentContextBudgetTokens: budgetTokens,
    },
  }]
  writeFileSync(patch, JSON.stringify(value, null, 2) + '\n')
}

function snapshotStore(root, phase) {
  const db = new DatabaseSync(databasePath(root), { readOnly: true })
  try {
    const snapshot = {
      phase, schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      schema: db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      rows: Object.fromEntries(TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    }
    const path = join(root, 'ws', 'decision-learning-snapshots', `${phase}.json`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n')
    return snapshot
  } finally {
    db.close()
  }
}

function length(value) {
  return typeof value === 'string' ? value.length : JSON.stringify(value).length
}

function budgetPlan(request) {
  const wire = request?.decisionLearning
  const pack = wire?.pack
  if (!wire || !pack) return undefined
  const fixed = wire.system.length + length(pack.L1) + length(pack.L4)
  const full = fixed + length(pack.L2) + length(pack.L3) + length(pack.L5)
  const l5NoExcerpt = pack.L5.map(ref => {
    const copy = { ...ref }
    delete copy.excerpt
    return copy
  })
  const budgets = {}
  const fixedByPhase = {}
  for (const [phase, key] of [['budget-l3', 'budgetL3'], ['budget-l2', 'budgetL2'], ['budget-l5', 'budgetL5']]) {
    const targetL4 = { entry: 'hook', request: { entry: 'hook', questions: [question(QUESTION_IDS[key])] } }
    const targetFixed = wire.system.length + length(pack.L1) + length(targetL4)
    const targetFull = targetFixed + length(pack.L2) + length(pack.L3) + length(pack.L5)
    const withoutL3 = targetFull - length(pack.L3)
    const withoutL2 = withoutL3 - length(pack.L2)
    budgets[phase] = Math.ceil((phase === 'budget-l3' ? withoutL3 : phase === 'budget-l2' ? withoutL2 : targetFixed + length(l5NoExcerpt)) / 4)
    fixedByPhase[phase] = { fixed: targetFixed, full: targetFull, withoutL3, withoutL2, l5NoExcerptCharacters: targetFixed + length(l5NoExcerpt) }
  }
  return { budgets, fixed, full, fixedByPhase }
}

async function waitForRunningInterruption(root, readyPath) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(readyPath) && existsSync(databasePath(root))) {
      const db = new DatabaseSync(databasePath(root), { readOnly: true })
      try {
        const row = db.prepare("SELECT * FROM learning_runs WHERE json_extract(input_frozen_json,'$.requestId')='interrupt-start'").get()
        if (row?.outcome === 'running') return { ready: JSON.parse(readFileSync(readyPath, 'utf8')), running: row }
      } finally { db.close() }
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for persisted running Learning Run and entered consolidation wire')
}

function proveP2Compatibility(root, fixture, workspaceRoot) {
  const target = join(root, 'compat-p2')
  const files = ['contracts.js', 'retrieval/memory.js', 'store/cases.js', 'store/evidence.js', 'store/db.js', 'store/migrate.js', 'store/schema.js']
  const hashes = {}
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), '{"type":"module"}\n')
  for (const file of files) {
    const source = execFileSync('git', ['show', `${P2_COMMIT}:plugins/weir-harness/src/decision/${file}`], { cwd: workspaceRoot, encoding: 'utf8' })
    const path = join(target, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
    hashes[file] = createHash('sha256').update(source).digest('hex')
  }
  return (async () => {
    const p2 = await import(pathToFileURL(join(target, 'retrieval/memory.js')).href)
    let storeReads = 0
    const throwingStore = new Proxy({}, { get() { storeReads++; throw new Error('P2 L2 must not inspect the store') } })
    const L2 = p2.readL2Memory(throwingStore, { agentId: fixture.agentA, workspaceKey: fixture.workspaceKey })
    const db = new DatabaseSync(databasePath(root), { readOnly: true })
    let L3
    let snapshotCount
    try {
      snapshotCount = db.prepare('SELECT COUNT(*) AS n FROM memory_snapshots').get().n
      L3 = p2.readL3Memory({ db }, { agentId: fixture.agentA, workspaceKey: fixture.workspaceKey, scope: { workspaces: [fixture.workspaceKey] } })
    } finally { db.close() }
    const report = { commit: P2_COMMIT, hashes, storeReads, L2, snapshotCount, l3Count: L3.length }
    writeFileSync(join(root, 'ws', 'decision-learning-p2-compatibility.json'), JSON.stringify(report, null, 2) + '\n')
    return report
  })()
}

function combineTraces(root, traces) {
  const aggregate = join(root, `trace-${id}.jsonl`)
  const body = PHASES.map(phase => traces[phase]).filter(path => path && existsSync(path))
    .map(path => readFileSync(path, 'utf8').trim()).filter(Boolean).join('\n')
  writeFileSync(aggregate, body ? body + '\n' : '')
  return aggregate
}

async function run(driver) {
  const root = driver.IT_ROOT
  const traces = {}
  const runs = []
  const processRuns = []
  let sessionId
  let interruption
  const budgetPlans = {}
  writeBudgetConfig(root, undefined)

  const spawnOne = async (phase, onChild) => {
    const trace = join(root, `trace-${id}-${phase}.jsonl`)
    traces[phase] = trace
    const control = ['main-v1', 'interrupt'].includes(phase) ? {
      WEIR_IT_LEARNING_HOLD: '1',
      WEIR_IT_LEARNING_READY: join(root, `${id}-${phase}-ready.json`),
      WEIR_IT_LEARNING_RELEASE: join(root, `${id}-${phase}-release.txt`),
    } : {}
    const args = !sessionId ? ['weir-it', '--json', prompt] : ['weir-it', '--session-id', sessionId, prompt]
    const outcome = await driver.spawnHeadless(args, driver.scenarioEnv(id, trace, {
      WEIR_IT_DECISION: '1', WEIR_IT_DECISION_REMOTE: '1', WEIR_IT_DECISION_EVENTS: join(root, 'decision-integration-events.jsonl'),
      WEIR_IT_DECISION_STORE_PATH: storeDirectory(root), WEIR_IT_DECISION_PHASE: phase, ...control,
    }), onChild)
    if (!sessionId) sessionId = parseJsonlLines(outcome.stdout).find(row => row?.type === 'session')?.sessionId
    const value = { ...outcome, sessionId, phase }
    runs.push(value)
    processRuns.push({ phase, pid: outcome.pid, exitCode: outcome.code, signal: outcome.signal ?? null, trace })
    return value
  }

  const spawn = async phase => {
    const outcome = await spawnOne(phase)
    if (existsSync(databasePath(root))) snapshotStore(root, phase)
    return outcome
  }

  await spawn('seed')
  let plan
  if (sessionId) {
    for (const phase of PHASES.slice(1)) {
      if (phase === 'interrupt') {
        let child
        const pending = spawnOne(phase, value => { child = value })
        try {
          const observed = await waitForRunningInterruption(root, join(root, `${id}-${phase}-ready.json`))
          const killRequested = child.kill('SIGKILL')
          const outcome = await pending
          interruption = { ...observed, killRequested, outcome: { code: outcome.code, signal: outcome.signal, pid: outcome.pid } }
        } catch (error) {
          child?.kill('SIGKILL')
          await pending
          interruption = { error: error?.message ?? String(error) }
        }
        if (existsSync(databasePath(root))) snapshotStore(root, phase)
        continue
      }
      if (['budget-l3', 'budget-l2', 'budget-l5'].includes(phase)) {
        const planPhase = phase === 'budget-l3' ? 'budget-plan' : `${phase}-plan`
        const questionKey = { 'budget-l3': 'budgetPlan', 'budget-l2': 'budgetL2Plan', 'budget-l5': 'budgetL5Plan' }[phase]
        const base = readJsonl(traces[planPhase]).find(request => request.decisionLearning?.pack?.L4?.request?.questions?.[0]?.id === QUESTION_IDS[questionKey])
        plan = budgetPlan(base)
        budgetPlans[phase] = plan
      }
      if (plan?.budgets[phase]) writeBudgetConfig(root, plan.budgets[phase])
      try { await spawn(phase) } finally { if (plan?.budgets[phase]) writeBudgetConfig(root, undefined) }
    }
  }

  const trace = combineTraces(root, traces)
  const finalRaw = existsSync(databasePath(root)) ? snapshotStore(root, 'final') : null
  const store = readDecisionStore(join(root, 'ws'), storeDirectory(root))
  const fixture = readJson(join(root, 'ws', 'decision-learning-fixtures.json'))
  const compatibility = fixture ? await proveP2Compatibility(root, fixture, driver.WS_ROOT) : null
  const rpcReport = readJson(join(root, 'ws', 'decision-learning-rpc.json'))
  const diffs = store.memory_snapshots.map(snapshot => {
    const parent = store.memory_snapshots.find(item => item.snapshot_id === snapshot.parent_snapshot_id)
    const parentIds = new Set((parent?.principles ?? []).map(item => item.principleId))
    return {
      snapshotId: snapshot.snapshot_id, version: snapshot.version,
      added: snapshot.principles.filter(item => !parentIds.has(item.principleId)),
      retained: snapshot.principles.filter(item => parentIds.has(item.principleId)),
    }
  })
  writeFileSync(join(root, 'ws', 'decision-learning-final.json'), JSON.stringify({
    scenario: id, sessionId, processRuns, interruption, budgetPlan: plan, budgetPlans, fixture,
    store, finalRaw, rpcReport, diffs, compatibility,
  }, null, 2) + '\n')
  return {
    scenario: id, trace, sessionId,
    code: processRuns.every(item => item.phase === 'interrupt' ? item.signal === 'SIGKILL' : item.exitCode === 0) ? 0 : 1,
    stdout: runs.map(item => item.stdout).join('\n'), stderr: runs.map(item => item.stderr).join('\n'), processRuns,
  }
}

function reportOf(ws) {
  return readJson(join(ws, 'decision-learning-final.json'))
}

function phaseSnapshot(ws, phase) {
  return readJson(join(ws, 'decision-learning-snapshots', `${phase}.json`))
}

function caseFor(store, questionId) {
  return store?.cases.find(item => item.request.questions?.some(question => question.id === questionId))
}

function attemptsFor(store, item) {
  return store?.attempts.filter(attempt => attempt.case_id === item?.case_id) ?? []
}

function wireFor(run, questionId) {
  return run.requests.find(request => request.decisionLearning?.pack?.L4?.request?.questions?.[0]?.id === questionId)
}

function linkedEvidence(raw, attemptId) {
  return raw?.rows.attempt_evidence.filter(row => row.attempt_id === attemptId).sort((a, b) => a.ordinal - b.ordinal).map(row => row.evidence_id) ?? []
}

function runByRequest(store, requestId) {
  return store?.learning_runs.find(run => run.inputFrozen.requestId === requestId)
}

function snapshotForRun(store, run) {
  return store?.memory_snapshots.find(snapshot => snapshot.learning_run_id === run?.learning_run_id)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')
}

function expectedAttemptHash(attempt, pack) {
  return digest({
    pins: attempt.pins, request: pack.L4.request,
    evidenceIds: attempt.packManifest.evidenceIds, correctionIds: attempt.packManifest.correctionIds,
    L2: pack.L2, L3: pack.L3, omissions: attempt.packManifest.omissions,
  })
}

function immutableEvidence(ws) {
  const attempts = new Map()
  const links = new Map()
  const snapshots = new Map()
  let ok = true
  for (const phase of [...PHASES, 'final']) {
    const snapshot = phaseSnapshot(ws, phase)
    if (!snapshot) { ok = false; continue }
    for (const row of snapshot.rows.attempts) {
      const text = JSON.stringify(row)
      if (attempts.has(row.attempt_id) && attempts.get(row.attempt_id) !== text) ok = false
      attempts.set(row.attempt_id, text)
    }
    for (const row of snapshot.rows.attempt_evidence) {
      const key = `${row.attempt_id}:${row.ordinal}`
      const text = JSON.stringify(row)
      if (links.has(key) && links.get(key) !== text) ok = false
      links.set(key, text)
    }
    for (const row of snapshot.rows.memory_snapshots) {
      const content = JSON.stringify({
        version: row.version, parent_snapshot_id: row.parent_snapshot_id, principles_json: row.principles_json,
        generated_description_json: row.generated_description_json, learning_run_id: row.learning_run_id,
        created_at: row.created_at, schema_version: row.schema_version,
      })
      if (snapshots.has(row.snapshot_id) && snapshots.get(row.snapshot_id) !== content) ok = false
      snapshots.set(row.snapshot_id, content)
    }
  }
  return { ok, attempts: attempts.size, links: links.size, snapshots: snapshots.size }
}

function assert(run) {
  const report = reportOf(run.ws)
  const store = report?.store
  const fixture = report?.fixture
  const rpc = report?.rpcReport ?? {}
  const v1Run = runByRequest(store, 'main-v1-start')
  const v2Run = runByRequest(store, 'main-v2-start')
  const v1 = snapshotForRun(store, v1Run)
  const v2 = snapshotForRun(store, v2Run)
  const afterV1 = attemptsFor(store, caseFor(store, QUESTION_IDS.afterV1))
  const afterV2 = attemptsFor(store, caseFor(store, QUESTION_IDS.afterV2))
  const predecessor = attemptsFor(store, caseFor(store, QUESTION_IDS.predecessor))
  const empty = attemptsFor(store, caseFor(store, QUESTION_IDS.empty))
  const onlyL2 = attemptsFor(store, caseFor(store, QUESTION_IDS.onlyL2))
  const deleted = attemptsFor(store, caseFor(store, QUESTION_IDS.deleted))
  const afterV1Wire = wireFor(run, QUESTION_IDS.afterV1)
  const afterV2Wire = wireFor(run, QUESTION_IDS.afterV2)
  const predecessorWire = wireFor(run, QUESTION_IDS.predecessor)
  const emptyWire = wireFor(run, QUESTION_IDS.empty)
  const deletedWire = wireFor(run, QUESTION_IDS.deleted)

  run.check('concurrent duplicate RPC starts share one model/draft while a competing request is rejected',
    rpc['main-v1-start']?.result?.first?.value?.outcome === 'candidate'
      && rpc['main-v1-start']?.result?.duplicate?.value?.learningRunId === v1Run?.learning_run_id
      && rpc['main-v1-start']?.result?.competing?.error?.code === 'LEARNING_RUN_ACTIVE'
      && store?.learning_runs.filter(item => item.inputFrozen.requestId.startsWith('main-v1-start')).length === 1
      && run.requests.filter(request => request.decisionLearning?.kind === 'consolidation' && digest(request.decisionLearning.content) === v1Run?.inputFrozen.inputHash).length === 1,
    JSON.stringify({ start: rpc['main-v1-start'], v1Run }))

  const candidateRaw = phaseSnapshot(run.ws, 'main-v1')
  const publishedRaw = phaseSnapshot(run.ws, 'publish-v1')
  const candidateSnapshot = candidateRaw?.rows.memory_snapshots.find(row => row.learning_run_id === v1Run?.learning_run_id)
  const publishedSnapshot = publishedRaw?.rows.memory_snapshots.find(row => row.snapshot_id === v1?.snapshot_id)
  const mainWire = run.requests.find(request => request.decisionLearning?.kind === 'consolidation' && digest(request.decisionLearning.content) === v1Run?.inputFrozen.inputHash)
  run.check('manual run freezes real revisions/digests and commits a reviewable candidate/diff before any publish',
    v1Run?.outcome === 'rolled_back' && v1Run.inputFrozen.revisions[fixture?.sourceA] > 0
      && candidateSnapshot?.state === 'draft' && candidateSnapshot.revision === 1 && candidateSnapshot.parent_snapshot_id === null
      && publishedSnapshot?.state === 'published' && publishedSnapshot.revision === 2
      && v1Run.replay.passed === true && v1Run.operations[0]?.op === 'add'
      && report?.diffs.find(diff => diff.snapshotId === v1?.snapshot_id)?.added.length === 1
      && mainWire?.decisionLearning.content.includes(`"caseId":"${fixture?.sourceA}"`)
      && !mainWire?.decisionLearning.content.includes('LEARNING_FIXTURE foreign')
      && v1.generatedDescription?.revision === 0 && v1.generatedDescription?.text === '',
    JSON.stringify({ v1Run, candidateSnapshot, publishedSnapshot, diff: report?.diffs.find(diff => diff.snapshotId === v1?.snapshot_id), mainWire }))

  run.check('published v1 drives actual L2 while Attempt, response, manifest, hash, and attempt_evidence retain only real L5 ids',
    afterV1.length === 1 && afterV1[0].outcome === 'answer'
      && afterV1[0].pins.memorySnapshotId === v1?.snapshot_id
      && afterV1[0].pins.memorySnapshotRevision === publishedSnapshot?.revision
      && afterV1[0].pins.memorySnapshotHash === v1?.contentHash
      && afterV1Wire?.decisionLearning.pack.L2.length === 1
      && afterV1[0].citedEvidenceIds.length === 1
      && afterV1Wire.decisionLearning.pack.L5.some(ref => ref.evidenceId === afterV1[0].citedEvidenceIds[0])
      && !afterV1[0].citedEvidenceIds.includes(afterV1Wire.decisionLearning.pack.L2[0].principleId)
      && JSON.stringify(linkedEvidence(report?.finalRaw, afterV1[0].attempt_id)) === JSON.stringify(afterV1[0].packManifest.evidenceIds)
      && expectedAttemptHash(afterV1[0], afterV1Wire.decisionLearning.pack) === afterV1[0].context_pack_hash,
    JSON.stringify({ afterV1, wire: afterV1Wire, links: linkedEvidence(report?.finalRaw, afterV1[0]?.attempt_id) }))

  const seedHistory = phaseSnapshot(run.ws, 'seed')
  const postRollbackHistory = phaseSnapshot(run.ws, 'attempt-empty')
  const postRollbackCases = new Map(postRollbackHistory?.rows.cases.map(row => [row.case_id, JSON.stringify(row)]))
  const postRollbackFeedback = new Map(postRollbackHistory?.rows.feedback.map(row => [row.feedback_id, JSON.stringify(row)]))
  run.check('v2 rollback restores v1 and the second rollback restores true empty L2 without rewriting historical Case/Attempt/Feedback rows',
    v2?.parent_snapshot_id === v1?.snapshot_id && v2.version === v1.version + 1
      && afterV2[0]?.pins.memorySnapshotId === v2.snapshot_id && afterV2Wire?.decisionLearning.pack.L2.length === 2
      && predecessor[0]?.pins.memorySnapshotId === v1.snapshot_id && predecessorWire?.decisionLearning.pack.L2.length === 1
      && seedHistory?.rows.cases.every(row => postRollbackCases.get(row.case_id) === JSON.stringify(row))
      && seedHistory.rows.feedback.every(row => postRollbackFeedback.get(row.feedback_id) === JSON.stringify(row))
      && empty[0]?.pins.memorySnapshotId === null && emptyWire?.decisionLearning.pack.L2 === ''
      && v1.state === 'rolled_back' && v2.state === 'rolled_back'
      && v1Run.outcome === 'rolled_back' && v2Run.outcome === 'rolled_back'
      && immutableEvidence(run.ws).ok,
    JSON.stringify({ v1, v2, afterV2, predecessor, empty, immutable: immutableEvidence(run.ws) }))

  run.check('an evaluator answer citing only the actual L2 principle id fails UNKNOWN_EVIDENCE and falls back to native user judgment',
    onlyL2.length === 3 && onlyL2.every(attempt => attempt.outcome === 'failed'
      && attempt.error?.kind === 'invalid_output' && attempt.error?.detail?.startsWith('UNKNOWN_EVIDENCE'))
      && caseFor(store, QUESTION_IDS.onlyL2)?.closing === 'escalated'
      && caseFor(store, QUESTION_IDS.onlyL2)?.decision?.kind === 'user_decision'
      && wireFor(run, QUESTION_IDS.onlyL2)?.decisionLearning.pack.L2.length === 1,
    JSON.stringify({ onlyL2, case: caseFor(store, QUESTION_IDS.onlyL2) }))

  const adverse = ['no-source', 'foreign', 'comment-only', 'rating-down'].map(phase => ({ phase, run: runByRequest(store, `${phase}-start`) }))
  run.check('no-source, foreign, comment-only, and rating-down inverse candidates all fail without draft Snapshots',
    adverse.every(item => item.run?.outcome === 'failed' && item.run.replay.passed === false && !snapshotForRun(store, item.run))
      && adverse.find(item => item.phase === 'no-source')?.run.replay.detail === 'MISSING_AUTHORITY_SOURCE'
      && adverse.find(item => item.phase === 'foreign')?.run.replay.detail === 'INVALID_AUTHORITY_SOURCE'
      && adverse.find(item => item.phase === 'comment-only')?.run.replay.detail === 'INVALID_AUTHORITY_SOURCE'
      && adverse.find(item => item.phase === 'rating-down')?.run.replay.detail === 'INVALID_AUTHORITY_SOURCE'
      && !JSON.stringify(adverse).includes(COMMENT_SECRET),
    JSON.stringify(adverse))

  const staleSource = runByRequest(store, 'stale-source-start')
  const staleParent = runByRequest(store, 'stale-parent-start')
  run.check('source and parent changes after candidate commit make publish fail closed with immutable drafts',
    staleSource?.outcome === 'failed' && staleSource.replay.detail === 'STALE_SOURCE'
      && snapshotForRun(store, staleSource)?.state === 'draft'
      && staleParent?.outcome === 'failed' && staleParent.replay.detail === 'STALE_PARENT_SNAPSHOT'
      && snapshotForRun(store, staleParent)?.state === 'draft'
      && rpc['stale-source-snapshotPublish']?.result?.error?.code === 'STALE_SOURCE'
      && rpc['stale-parent-snapshotPublish']?.result?.error?.code === 'STALE_PARENT_SNAPSHOT',
    JSON.stringify({ staleSource, staleParent, sourceRpc: rpc['stale-source-snapshotPublish'], parentRpc: rpc['stale-parent-snapshotPublish'] }))

  const crossAgent = rpc['cross-agent']?.result
  const crossWorkspace = rpc['cross-workspace']?.result
  run.check('cross-Agent and cross-workspace RPC reads and mutations are denied without changing authority',
    ['run', 'snapshot', 'publish'].every(key => crossAgent?.[key]?.error?.code === 'OUT_OF_SCOPE')
      && ['start', 'run', 'snapshot', 'rollback'].every(key => crossWorkspace?.[key]?.error?.code === 'OUT_OF_SCOPE')
      && !runByRequest(store, 'cross-workspace-foreign-workspace'),
    JSON.stringify({ crossAgent, crossWorkspace }))

  const rejected = runByRequest(store, 'reject-start')
  run.check('explicit reject retains an immutable unpublished draft and no current Snapshot',
    rejected?.outcome === 'rejected' && snapshotForRun(store, rejected)?.state === 'draft'
      && rpc['reject-snapshotReject']?.result?.ok === true
      && phaseSnapshot(run.ws, 'reject')?.rows.memory_snapshots.filter(row => row.state === 'published').length === 0,
    JSON.stringify({ rejected, snapshot: snapshotForRun(store, rejected) }))

  const planAttempt = attemptsFor(store, caseFor(store, QUESTION_IDS.budgetPlan))[0]
  const planWire = wireFor(run, QUESTION_IDS.budgetPlan)
  const budgetL3 = attemptsFor(store, caseFor(store, QUESTION_IDS.budgetL3))[0]
  const budgetL2 = attemptsFor(store, caseFor(store, QUESTION_IDS.budgetL2))[0]
  const budgetL5 = attemptsFor(store, caseFor(store, QUESTION_IDS.budgetL5))[0]
  const budgetL3Wire = wireFor(run, QUESTION_IDS.budgetL3)
  const budgetL2Wire = wireFor(run, QUESTION_IDS.budgetL2)
  const budgetL5Wire = wireFor(run, QUESTION_IDS.budgetL5)
  run.check('actual pinned budgets trim L3 then whole L2 then L5 excerpts/evidence, preserving actual-only manifests and hashes',
    planWire?.decisionLearning.pack.L3.length > 0
      && budgetL3?.packManifest.omissions.includes('L3_EPISODE_OMITTED')
      && !budgetL3.packManifest.omissions.some(code => code.startsWith('L2_') || code.startsWith('L5_'))
      && budgetL3Wire?.decisionLearning.pack.L2.length === 1
      && budgetL2?.packManifest.omissions.includes('L2_PRINCIPLE_OMITTED') && budgetL2Wire?.decisionLearning.pack.L2 === ''
      && budgetL2.packManifest.memory.L2.snapshotId === v1?.snapshot_id && budgetL2.packManifest.memory.L2.principleIds.length === 0
      && !budgetL2.packManifest.omissions.some(code => code.startsWith('L5_'))
      && budgetL5?.packManifest.omissions.includes('L5_EXCERPT_OMITTED')
      && budgetL5.packManifest.omissions.includes('L5_EVIDENCE_OMITTED')
      && budgetL5.packManifest.memory.L2.principleIds.length === 0
      && budgetL5.packManifest.evidenceIds.length > 0 && budgetL5.packManifest.evidenceIds.length < planAttempt?.packManifest.evidenceIds.length
      && budgetL5.packManifest.evidenceIds.every(evidenceId => planAttempt?.packManifest.evidenceIds.includes(evidenceId))
      && [budgetL3, budgetL2, budgetL5].every(attempt => attempt?.outcome === 'answer')
      && new Set([planAttempt?.context_pack_hash, budgetL3?.context_pack_hash, budgetL2?.context_pack_hash, budgetL5?.context_pack_hash]).size === 4,
    JSON.stringify({ plan: report?.budgetPlan, budgetL3, budgetL2, budgetL5, wires: [budgetL3Wire, budgetL2Wire, budgetL5Wire] }))

  const interrupted = runByRequest(store, 'interrupt-start')
  run.check('SIGKILL during a persisted running consolidation recovers INTERRUPTED with no draft or model replay; committed states survive surrounding restarts',
    report?.interruption?.killRequested === true && report.interruption.outcome.signal === 'SIGKILL'
      && report.interruption.running?.outcome === 'running'
      && report.interruption.ready?.pid === report.interruption.outcome.pid
      && interrupted?.outcome === 'failed' && interrupted.replay.detail === 'INTERRUPTED' && !snapshotForRun(store, interrupted)
      && rpc['recover-running']?.result?.value?.outcome === 'failed'
      && phaseSnapshot(run.ws, 'main-v1') && phaseSnapshot(run.ws, 'publish-v1') && phaseSnapshot(run.ws, 'rollback-v2'),
    JSON.stringify({ interruption: report?.interruption, interrupted, recovered: rpc['recover-running'] }))

  const deletedSnapshot = snapshotForRun(store, runByRequest(store, 'delete-start'))
  run.check('deleting a published principle source leaves a pinned but empty L2 with SOURCE_UNAVAILABLE and no answer',
    deletedSnapshot?.state === 'published' && deleted[0]?.pins.memorySnapshotId === deletedSnapshot.snapshot_id
      && deleted[0]?.outcome === 'return' && deleted[0]?.return_code === 'MISSING_CONTEXT'
      && deletedWire?.decisionLearning.pack.L2 === ''
      && deleted[0]?.packManifest.memory.L2.principleIds.length === 0
      && deleted[0]?.packManifest.memory.L2.exclusions.some(item => item.reason === 'SOURCE_UNAVAILABLE')
      && !store.cases.some(item => item.case_id === fixture?.sourceC),
    JSON.stringify({ deletedSnapshot, deleted, wire: deletedWire }))

  const seedRaw = phaseSnapshot(run.ws, 'seed')
  const finalRaw = report?.finalRaw
  const legacyIds = [fixture?.compatibility.p1.attemptId, fixture?.compatibility.p2.attemptId]
  const legacyRows = raw => raw?.rows.attempts.filter(row => legacyIds.includes(row.attempt_id))
  const legacyCases = raw => raw?.rows.cases.filter(row => [fixture?.compatibility.p1.caseId, fixture?.compatibility.p2.caseId].includes(row.case_id))
  run.check('P1/P2 v1 fixtures reopen byte-identically without schema migration/backfill and exact P2 code never reads Snapshots',
    seedRaw?.schemaVersion === 1 && finalRaw?.schemaVersion === 1
      && JSON.stringify(seedRaw.schema) === JSON.stringify(finalRaw.schema)
      && JSON.stringify(legacyRows(seedRaw)) === JSON.stringify(legacyRows(finalRaw))
      && JSON.stringify(legacyCases(seedRaw)) === JSON.stringify(legacyCases(finalRaw))
      && report?.compatibility?.commit === P2_COMMIT && report.compatibility.storeReads === 0
      && report.compatibility.snapshotCount > 0 && report.compatibility.L2.snapshotId === null
      && report.compatibility.L2.items.length === 0 && report.compatibility.l3Count > 0,
    JSON.stringify({ compatibility: report?.compatibility, legacyBefore: legacyRows(seedRaw), legacyAfter: legacyRows(finalRaw) }))

  const learningWires = run.requests.filter(request => request.decisionLearning)
  const runHashes = new Set(store?.learning_runs.map(item => item.inputFrozen.inputHash))
  const wireHashes = new Set(learningWires.filter(request => request.decisionLearning.kind === 'consolidation').map(request => digest(request.decisionLearning.content)))
  const actualAttempts = store?.attempts.filter(attempt => attempt.pins?.promptVersion === 'evaluator-contract/3') ?? []
  const manifestOk = actualAttempts.every(attempt => {
    const item = store.cases.find(item => item.case_id === attempt.case_id)
    const questionId = item?.request.questions?.[0]?.id
    const wire = wireFor(run, questionId)
    const pack = wire?.decisionLearning?.pack
    return pack && expectedAttemptHash(attempt, pack) === attempt.context_pack_hash
      && JSON.stringify(attempt.packManifest.memory.L2.principleIds) === JSON.stringify(Array.isArray(pack.L2) ? pack.L2.map(item => item.principleId) : [])
      && JSON.stringify(attempt.packManifest.memory.L3.sourceCaseIds) === JSON.stringify(Array.isArray(pack.L3) ? pack.L3.map(item => item.sourceCaseId) : [])
      && JSON.stringify(linkedEvidence(finalRaw, attempt.attempt_id)) === JSON.stringify(attempt.packManifest.evidenceIds)
  })
  const snapshotHashesOk = store?.memory_snapshots.every(snapshot => snapshot.contentHash === digest({
    version: snapshot.version, parentSnapshotId: snapshot.parent_snapshot_id, principles: snapshot.principles,
    generatedDescription: snapshot.generatedDescription, learningRunId: snapshot.learning_run_id,
  }))
  run.check('every real sidecar request is tool-free/temperature-free and every run/Snapshot/Attempt digest matches its actual frozen content',
    learningWires.length > 0 && learningWires.every(request => request.decisionLearning.tools.length === 0
      && request.decisionLearning.hasTemperature === false && request.decisionLearning.provider === 'mock'
      && request.decisionLearning.model === 'mock-1' && request.decisionLearning.maxTokens > 0
      && request.decisionLearning.content.length > 0)
      && [...runHashes].every(hash => wireHashes.has(hash)) && manifestOk && snapshotHashesOk,
    JSON.stringify({ wires: learningWires.length, runHashes: [...runHashes], wireHashes: [...wireHashes], manifestOk, snapshotHashesOk }))

  const auditPath = join(run.ws, '.weir', 'audit.jsonl')
  const audit = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : ''
  run.check('learning/snapshot audit contains metadata only, never comment, foreign answer, or principle bodies',
    audit.includes('learning-run') && audit.includes('snapshot')
      && !audit.includes(COMMENT_SECRET) && !audit.includes('FOREIGN_WORKSPACE_SECRET')
      && !audit.includes('Reviewed principle from'),
    audit.slice(-2000))

  run.check('all clean real headless phases plus the intentional exact-PID SIGKILL completed with their terminal markers',
    report?.processRuns.length === PHASES.length && run.code === 0
      && report.processRuns.filter(item => item.phase !== 'interrupt').every(item => item.exitCode === 0)
      && report.processRuns.find(item => item.phase === 'interrupt')?.signal === 'SIGKILL'
      && PHASES.filter(phase => !['interrupt'].includes(phase)).every(phase => run.stdout.includes(`DECISION_LEARNING_${phase.toUpperCase()}_DONE`)),
    `processes=${JSON.stringify(report?.processRuns)} stderr=${run.stderr.slice(-1500)}`)
}

export default { id, prompt, decide, decideConsolidation, decideDecision, observe, run, assert }
