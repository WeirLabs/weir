// P2 scoped neutral memory through real Host/Broker/SQLite/evaluator processes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { decisionPack, observeDecision, readDecisionEvents, readDecisionStore } from '../decision-test-kit.js'
import { parseJsonlLines, readJsonl } from '../jsonl.js'

const id = 'decision-memory'
const prompt = 'decision-memory-probe'
const COMMENT_SECRET = 'MEMORY_COMMENT_SECRET_must_never_enter_an_evaluator_pack'
const PHASES = ['seed', 'restart', 'failure', 'plan', 'budget']
const QUESTIONS = {
  off: { id: 'decision-memory-off', question: 'While Off, choose the native answer', options: [{ label: 'Native Off' }, { label: 'Neutral answer' }] },
  source: { id: 'decision-memory-source', question: 'Choose the neutral historical direction', options: [{ label: 'Source native' }, { label: 'Neutral answer' }] },
  l3Only: { id: 'decision-memory-l3-only', question: 'Reuse neutral memory without a decisive L5', options: [{ label: 'User resolves L3 only' }, { label: 'Neutral answer' }] },
  l5After: { id: 'decision-memory-l5-after', question: 'Reuse the genuine user decision', options: [{ label: 'User resolves L3 only' }, { label: 'Neutral answer' }] },
  up: { id: 'decision-memory-up', question: 'Reuse the source after rating up', options: [{ label: 'Neutral answer' }, { label: 'Other' }] },
  down: { id: 'decision-memory-down', question: 'Reuse the source after rating down', options: [{ label: 'Native down judgment' }, { label: 'Neutral answer' }] },
  undo: { id: 'decision-memory-undo', question: 'Reuse the source after undoing rating down', options: [{ label: 'Native undo judgment' }, { label: 'Neutral answer' }] },
  comment: { id: 'decision-memory-comment', question: 'Reuse the source after a neutral comment', options: [{ label: 'Native comment judgment' }, { label: 'Neutral answer' }] },
  correction: { id: 'decision-memory-correction', question: 'Apply the correction instead of the superseded episode', options: [{ label: 'Corrected answer' }, { label: 'Neutral answer' }] },
  approval: { id: 'decision-memory-approval', question: 'Approve using neutral memory as permission?', options: [{ label: 'Native approval' }, { label: 'Neutral answer' }], intent: { kind: 'approval' } },
  agentB: { id: 'decision-memory-agent-b', question: 'Answer B without reading A memory', options: [{ label: 'Native B judgment' }, { label: 'Neutral answer' }] },
  failure: { id: 'decision-memory-retrieval-failure', question: 'Recover a real retrieval version failure', options: [{ label: 'Native recovery judgment' }, { label: 'Neutral answer' }] },
  budget: { id: 'decision-memory-budget', question: 'Answer after the real budget omits all neutral episodes', options: [{ label: 'Budget answered' }, { label: 'Other' }] },
}
const CONSULTS = {
  before: { question: 'MEMORY_REPRO_BEFORE: capture stable memory before restart', options: [{ label: 'Wait for user' }, { label: 'Neutral answer' }], request_id: 'memory-repro-before' },
  after: { question: 'MEMORY_REPRO_AFTER: capture identical memory after restart', options: [{ label: 'Wait for user' }, { label: 'Neutral answer' }], request_id: 'memory-repro-after' },
  plan: { question: 'MEMORY_BUDGET_PLAN: recover and measure the actual pack', options: [{ label: 'Wait for user' }, { label: 'Neutral answer' }], request_id: 'memory-budget-plan' },
}
const CROSS_QUESTION = 'MEMORY_CROSS: answer W2 without reading W1 memory'

function ask(question) {
  return toolCallChunks('ask_user_question', { questions: [question] })
}

function consult(value) {
  return toolCallChunks('decision_consult', value)
}

function count(history, marker) {
  return history.split(marker).length - 1
}

function sourceCaseId(history) {
  return /"caseId":"(dc_[^"]+)"/.exec(history)?.[1]
}

function setupValue(history, key) {
  return new RegExp(`"${key}":"([^"]+)"`).exec(history)?.[1]
}

function decide(options, obs) {
  const history = obs.transcript
  const phase = process.env.WEIR_IT_DECISION_PHASE ?? 'seed'
  if (history.includes('DECISION_TEST error')) return textChunks('DECISION_MEMORY_FAILED')

  if (phase === 'seed') {
    if (!history.includes(QUESTIONS.off.id)) return ask(QUESTIONS.off)
    if (!history.includes('DECISION_TEST done isolation-setup')) return toolCallChunks('decision_integration_probe', { op: 'isolation-setup' })
    if (!history.includes(QUESTIONS.source.id)) return ask(QUESTIONS.source)
    if (!history.includes('DECISION_TEST done case-for-call')) return toolCallChunks('decision_integration_probe', { op: 'case-for-call', questions: [QUESTIONS.source] })
    if (!history.includes(QUESTIONS.l3Only.id)) return ask(QUESTIONS.l3Only)
    if (!history.includes(QUESTIONS.l5After.id)) return ask(QUESTIONS.l5After)
    if (!history.includes('"kind":"rating_up"')) return toolCallChunks('decision_integration_probe', { op: 'feedback', caseId: sourceCaseId(history), verb: 'rating_up' })
    if (!history.includes(QUESTIONS.up.id)) return ask(QUESTIONS.up)
    if (!history.includes('"kind":"rating_down"')) return toolCallChunks('decision_integration_probe', { op: 'feedback', caseId: sourceCaseId(history), verb: 'rating_down' })
    if (!history.includes(QUESTIONS.down.id)) return ask(QUESTIONS.down)
    if (!history.includes('"kind":"undo_rating_down"')) return toolCallChunks('decision_integration_probe', { op: 'feedback', caseId: sourceCaseId(history), verb: 'undo_rating_down' })
    if (!history.includes(QUESTIONS.undo.id)) return ask(QUESTIONS.undo)
    if (!history.includes('"kind":"comment"')) return toolCallChunks('decision_integration_probe', { op: 'feedback', caseId: sourceCaseId(history), verb: 'comment', text: COMMENT_SECRET })
    if (!history.includes(QUESTIONS.comment.id)) return ask(QUESTIONS.comment)
    if (!history.includes('DECISION_TEST done correction')) {
      return toolCallChunks('decision_integration_probe', {
        op: 'correction', caseId: sourceCaseId(history), direction: 'Corrected answer',
        scope: { workspaces: [setupValue(history, 'workspaceKey')] }, supersedes: [sourceCaseId(history)],
      })
    }
    if (!history.includes(QUESTIONS.correction.id)) return ask(QUESTIONS.correction)
    if (!history.includes(QUESTIONS.approval.id)) return ask(QUESTIONS.approval)
    if (count(history, 'DECISION_TEST done select') < 1) return toolCallChunks('decision_integration_probe', { op: 'select', agentId: setupValue(history, 'agentB') })
    if (!history.includes(QUESTIONS.agentB.id)) return ask(QUESTIONS.agentB)
    if (!history.includes('DECISION_TEST done cross-consult')) {
      return toolCallChunks('decision_integration_probe', { op: 'cross-consult', agentId: setupValue(history, 'agentC'), otherWorkspace: setupValue(history, 'otherWorkspace'), question: CROSS_QUESTION })
    }
    if (count(history, 'DECISION_TEST done select') < 2) return toolCallChunks('decision_integration_probe', { op: 'select', agentId: setupValue(history, 'agentA') })
    if (count(history, '"outcome":"awaiting_user"') < 1) return consult(CONSULTS.before)
    return textChunks('DECISION_MEMORY_SEED_DONE')
  }

  if (phase === 'restart') {
    if (count(history, '"outcome":"awaiting_user"') < 2) return consult(CONSULTS.after)
    return textChunks('DECISION_MEMORY_RESTART_DONE')
  }
  if (phase === 'failure') {
    if (!history.includes(QUESTIONS.failure.id)) return ask(QUESTIONS.failure)
    return textChunks('DECISION_MEMORY_FAILURE_DONE')
  }
  if (phase === 'plan') {
    if (count(history, '"outcome":"awaiting_user"') < 3) return consult(CONSULTS.plan)
    return textChunks('DECISION_MEMORY_PLAN_DONE')
  }
  if (phase === 'budget') {
    if (!history.includes(QUESTIONS.budget.id)) return ask(QUESTIONS.budget)
    return textChunks('DECISION_MEMORY_BUDGET_DONE')
  }
  return textChunks('DECISION_MEMORY_FAILED')
}

function answer(question, ref, selected) {
  return textChunks(JSON.stringify({
    outcome: 'answer',
    claims: [{ text: `${selected} is supported by ${ref.source}.`, evidenceIds: [ref.evidenceId] }],
    answers: [{ id: question.id, selected: [selected] }],
  }))
}

function missing(hint) {
  return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint }))
}

function decideDecision(options, obs) {
  const pack = decisionPack(obs)
  const question = pack?.L4?.request?.questions?.[0]
  if (!question) return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['Missing memory fixture request'] }))
  if (question.id === QUESTIONS.source.id) {
    const ref = pack.L5.find(item => item.source === 'user_profile')
    return ref ? answer(question, ref, 'Neutral answer') : missing('The source profile evidence is required.')
  }
  if (question.id === QUESTIONS.l3Only.id) {
    const episode = Array.isArray(pack.L3) ? pack.L3[0] : undefined
    if (episode) {
      return textChunks(JSON.stringify({
        outcome: 'answer',
        claims: [{ text: 'Attempt to reuse neutral history as if it were evidence.', evidenceIds: [episode.sourceCaseId] }],
        answers: [{ id: question.id, selected: ['Neutral answer'] }],
      }))
    }
    return missing('The neutral source episode must be present for this negative fixture.')
  }
  if (question.id === QUESTIONS.l5After.id) {
    const ref = pack.L5.find(item => item.source === 'user_decision' && item.excerpt?.includes('User resolves L3 only'))
    return ref ? answer(question, ref, 'User resolves L3 only') : missing('A genuine user decision is required; L3 cannot replace it.')
  }
  if (question.id === QUESTIONS.up.id) {
    const ref = pack.L5.find(item => item.source === 'agent_record')
    return ref ? answer(question, ref, 'Neutral answer') : missing('Rating up must move the source to validated L5.')
  }
  if ([QUESTIONS.down.id, QUESTIONS.undo.id, QUESTIONS.comment.id, QUESTIONS.agentB.id].includes(question.id)) {
    return missing('No decisive L5 supports this neutral-history fixture; native user judgment is required.')
  }
  if (question.id === QUESTIONS.correction.id) {
    const ref = pack.L5.find(item => item.source === 'user_correction' && item.excerpt === 'Corrected answer')
    return ref ? answer(question, ref, 'Corrected answer') : missing('The active correction is required.')
  }
  if (question.question.startsWith('MEMORY_CROSS')) {
    return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'OUT_OF_SCOPE', hint: 'W2 cannot use W1 memory or evidence.' }))
  }
  if (question.question.startsWith('MEMORY_REPRO') || question.question.startsWith('MEMORY_BUDGET_PLAN')) {
    return textChunks(JSON.stringify({ outcome: 'escalate', missing: ['Keep this reproducibility fixture awaiting user judgment.'] }))
  }
  if (question.id === QUESTIONS.budget.id) {
    const ref = pack.L5.find(item => item.source === 'user_profile')
    return ref ? answer(question, ref, 'Budget answered') : missing('The retained profile L5 is required after L3 omission.')
  }
  return textChunks('Off, approval, and failed retrieval must not reach the Decision evaluator')
}

function observe(obs) {
  const observation = observeDecision(obs)
  if (!observation.decisionEvaluator) return observation
  return {
    ...observation,
    decisionMemorySystem: obs.system,
    decisionMemoryPack: decisionPack(obs),
    decisionMemoryCommentLeak: obs.lastUser.includes(COMMENT_SECRET),
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
  const value = budgetTokens === undefined ? [] : [{ id: 'weir-it-settings', config: { decisionAgentsEnabled: true, decisionAgentStorePath: storeDirectory(root), decisionAgentContextBudgetTokens: budgetTokens } }]
  writeFileSync(patch, JSON.stringify(value, null, 2) + '\n')
}

function snapshotStore(root, phase) {
  const db = new DatabaseSync(databasePath(root), { readOnly: true })
  let snapshot
  try {
    snapshot = {
      phase,
      attempts: db.prepare('SELECT * FROM attempts ORDER BY case_id,attempt_no').all(),
      attemptEvidence: db.prepare('SELECT * FROM attempt_evidence ORDER BY attempt_id,ordinal').all(),
      caseContent: db.prepare('SELECT case_id,request_json,decision_json,closed_at FROM cases ORDER BY case_id').all(),
    }
  } finally {
    db.close()
  }
  writeFileSync(join(root, 'ws', `decision-memory-${phase}-snapshot.json`), JSON.stringify(snapshot, null, 2) + '\n')
  return snapshot
}

function setSourceVersion(root, caseId, version) {
  if (!caseId) return
  const db = new DatabaseSync(databasePath(root))
  try {
    db.prepare('UPDATE cases SET schema_version=? WHERE case_id=?').run(version, caseId)
  } finally {
    db.close()
  }
}

function packCharacters(request) {
  const pack = request?.decisionMemoryPack
  if (!pack || typeof request.decisionMemorySystem !== 'string') return undefined
  return request.decisionMemorySystem.length + ['L1', 'L2', 'L4', 'L5'].reduce((sum, key) => {
    const layer = pack[key]
    return sum + (typeof layer === 'string' ? layer.length : JSON.stringify(layer).length)
  }, 0)
}

function combineTraces(root, traces) {
  const aggregate = join(root, `trace-${id}.jsonl`)
  const body = traces.filter(path => existsSync(path)).map(path => readFileSync(path, 'utf8').trim()).filter(Boolean).join('\n')
  writeFileSync(aggregate, body ? body + '\n' : '')
  return aggregate
}

async function run(driver) {
  const root = driver.IT_ROOT
  const events = join(root, 'decision-integration-events.jsonl')
  const traces = {}
  const runs = []
  const processRuns = []
  writeBudgetConfig(root, undefined)

  const spawn = async phase => {
    const trace = join(root, `trace-${id}-${phase}.jsonl`)
    traces[phase] = trace
    const first = phase === 'seed'
    const sessionId = runs[0]?.sessionId
    if (!first && !sessionId) return { code: 1, stdout: '', stderr: 'missing seed session id' }
    const args = first ? ['weir-it', '--json', prompt] : ['weir-it', '--session-id', sessionId, prompt]
    const outcome = await driver.spawnHeadless(args, driver.scenarioEnv(id, trace, {
      WEIR_IT_DECISION: '1', WEIR_IT_DECISION_EVENTS: events,
      WEIR_IT_DECISION_STORE_PATH: storeDirectory(root), WEIR_IT_DECISION_PHASE: phase,
    }))
    const session = first ? parseJsonlLines(outcome.stdout).find(row => row?.type === 'session')?.sessionId : sessionId
    const value = { ...outcome, sessionId: session, phase }
    runs.push(value)
    processRuns.push({ phase, exitCode: outcome.code, trace })
    return value
  }

  await spawn('seed')
  if (runs[0]?.sessionId) {
    snapshotStore(root, 'seed')
    await spawn('restart')
    snapshotStore(root, 'restart')

    const beforeFailure = readDecisionStore(join(root, 'ws'), storeDirectory(root))
    const corrupted = beforeFailure.cases.find(item => item.request.questions?.[0]?.id === QUESTIONS.up.id)
    setSourceVersion(root, corrupted?.case_id, 99)
    try {
      await spawn('failure')
      snapshotStore(root, 'failure')
    } finally {
      setSourceVersion(root, corrupted?.case_id, 1)
    }

    await spawn('plan')
    snapshotStore(root, 'plan')
    const planRequest = readJsonl(traces.plan).find(request => request.decisionMemoryPack?.L4?.request?.questions?.[0]?.question === CONSULTS.plan.question)
    const characters = packCharacters(planRequest)
    const budgetTokens = characters === undefined ? undefined : Math.ceil((characters + 1) / 4)
    writeBudgetConfig(root, budgetTokens)
    try {
      await spawn('budget')
      snapshotStore(root, 'budget')
    } finally {
      writeBudgetConfig(root, undefined)
    }

    const trace = combineTraces(root, PHASES.map(phase => traces[phase]))
    const finalRaw = snapshotStore(root, 'final')
    const store = readDecisionStore(join(root, 'ws'), storeDirectory(root))
    const wire = readJsonl(trace).filter(request => request.decisionEvaluator).map(request => ({
      questionIds: request.decisionQuestionIds,
      system: request.decisionMemorySystem,
      pack: request.decisionMemoryPack,
      commentLeak: request.decisionMemoryCommentLeak,
    }))
    writeFileSync(join(root, 'ws', 'decision-memory-final.json'), JSON.stringify({
      scenario: id, sessionId: runs[0].sessionId, processRuns, corruptedCaseId: corrupted?.case_id,
      budgetTokens, budgetBaseCharacters: characters, store, finalRaw, wire,
    }, null, 2) + '\n')
    return {
      scenario: id, trace, sessionId: runs[0].sessionId,
      code: runs.every(item => item.code === 0) ? 0 : 1,
      stdout: runs.map(item => item.stdout).join('\n'), stderr: runs.map(item => item.stderr).join('\n'),
      processRuns,
    }
  }

  const trace = combineTraces(root, Object.values(traces))
  return { scenario: id, trace, code: 1, stdout: runs.map(item => item.stdout).join('\n'), stderr: runs.map(item => item.stderr).join('\n'), processRuns }
}

function readReport(ws) {
  const path = join(ws, 'decision-memory-final.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function questionOf(request) {
  return request?.decisionMemoryPack?.L4?.request?.questions?.[0]
}

function wireFor(run, marker) {
  return run.requests.find(request => {
    const question = questionOf(request)
    return question?.id === marker || question?.question === marker || question?.question?.startsWith(marker)
  })
}

function wiresForCase(run, item) {
  const questions = item?.request?.questions ?? []
  return run.requests.filter(request => {
    const question = questionOf(request)
    return questions.some(expected => question?.id === expected.id && question?.question === expected.question)
  })
}

function caseFor(store, marker) {
  return store?.cases.find(item => item.request.questions?.some(question => question.id === marker || question.question === marker || question.question?.startsWith(marker)))
}

function attemptFor(store, item) {
  return store?.attempts.filter(attempt => attempt.case_id === item?.case_id) ?? []
}

function memoryIds(pack) {
  return Array.isArray(pack?.L3) ? pack.L3.map(episode => episode.sourceCaseId) : []
}

function evidenceIds(pack) {
  return pack?.L5?.map(ref => ref.evidenceId) ?? []
}

function linkedEvidence(raw, attemptId) {
  return raw?.attemptEvidence.filter(row => row.attempt_id === attemptId).sort((a, b) => a.ordinal - b.ordinal).map(row => row.evidence_id) ?? []
}

function immutableSnapshots(ws, finalRaw) {
  const attempts = new Map(finalRaw?.attempts.map(row => [row.attempt_id, JSON.stringify(row)]))
  const links = new Map(finalRaw?.attemptEvidence.map(row => [`${row.attempt_id}:${row.ordinal}`, JSON.stringify(row)]))
  const cases = new Map(finalRaw?.caseContent.map(row => [row.case_id, JSON.stringify(row)]))
  const snapshots = PHASES.map(phase => {
    const path = join(ws, `decision-memory-${phase}-snapshot.json`)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  })
  return {
    snapshots: snapshots.map(snapshot => ({ phase: snapshot?.phase, attempts: snapshot?.attempts.length, links: snapshot?.attemptEvidence.length, cases: snapshot?.caseContent.length })),
    ok: snapshots.every(snapshot => snapshot
      && snapshot.attempts.every(row => attempts.get(row.attempt_id) === JSON.stringify(row))
      && snapshot.attemptEvidence.every(row => links.get(`${row.attempt_id}:${row.ordinal}`) === JSON.stringify(row))
      && snapshot.caseContent.every(row => cases.get(row.case_id) === JSON.stringify(row))),
  }
}

function assert(run) {
  const report = readReport(run.ws)
  const store = report?.store
  const raw = report?.finalRaw
  const source = caseFor(store, QUESTIONS.source.id)
  const l3Only = caseFor(store, QUESTIONS.l3Only.id)
  const l5After = caseFor(store, QUESTIONS.l5After.id)
  const up = caseFor(store, QUESTIONS.up.id)
  const down = caseFor(store, QUESTIONS.down.id)
  const undo = caseFor(store, QUESTIONS.undo.id)
  const comment = caseFor(store, QUESTIONS.comment.id)
  const correction = caseFor(store, QUESTIONS.correction.id)
  const agentB = caseFor(store, QUESTIONS.agentB.id)
  const cross = caseFor(store, CROSS_QUESTION)
  const failure = caseFor(store, QUESTIONS.failure.id)
  const before = caseFor(store, CONSULTS.before.question)
  const after = caseFor(store, CONSULTS.after.question)
  const plan = caseFor(store, CONSULTS.plan.question)
  const budget = caseFor(store, QUESTIONS.budget.id)
  const sourceWire = wireFor(run, QUESTIONS.source.id)
  const l3Wires = run.requests.filter(request => questionOf(request)?.id === QUESTIONS.l3Only.id)
  const l5Wire = wireFor(run, QUESTIONS.l5After.id)
  const upWire = wireFor(run, QUESTIONS.up.id)
  const downWire = wireFor(run, QUESTIONS.down.id)
  const undoWire = wireFor(run, QUESTIONS.undo.id)
  const commentWire = wireFor(run, QUESTIONS.comment.id)
  const correctionWire = wireFor(run, QUESTIONS.correction.id)
  const bWire = wireFor(run, QUESTIONS.agentB.id)
  const crossWire = wireFor(run, CROSS_QUESTION)
  const beforeWire = wireFor(run, CONSULTS.before.question)
  const afterWire = wireFor(run, CONSULTS.after.question)
  const planWire = wireFor(run, CONSULTS.plan.question)
  const budgetWire = wireFor(run, QUESTIONS.budget.id)
  const sourceAttempts = attemptFor(store, source)
  const l3Attempts = attemptFor(store, l3Only)
  const l5Attempts = attemptFor(store, l5After)
  const failureAttempts = attemptFor(store, failure)
  const budgetAttempts = attemptFor(store, budget)
  const userDecision = store?.evidence.find(ref => ref.source === 'user_decision' && ref.locator?.caseId === l3Only?.case_id)
  const events = readDecisionEvents(join(run.ws, '..', 'decision-integration-events.jsonl'))
  const offStub = events.find(event => event.questionIds?.includes(QUESTIONS.off.id))
  const approvalStub = events.find(event => event.questionIds?.includes(QUESTIONS.approval.id))

  run.check('Off and approval use native authority with no Case, evaluator wire, or retrieval-created record',
    !caseFor(store, QUESTIONS.off.id) && !caseFor(store, QUESTIONS.approval.id)
      && !wireFor(run, QUESTIONS.off.id) && !wireFor(run, QUESTIONS.approval.id)
      && offStub?.caseSnapshot === null && approvalStub?.caseSnapshot === null,
    JSON.stringify({ offStub, approvalStub, offWire: wireFor(run, QUESTIONS.off.id), approvalWire: wireFor(run, QUESTIONS.approval.id) }))

  run.check('unrated answered source becomes L3, and three L3-only citations fail closed as UNKNOWN_EVIDENCE',
    source?.closing === 'answered' && sourceAttempts.length === 1 && sourceAttempts[0].outcome === 'answer'
      && memoryIds(sourceWire?.decisionMemoryPack).length === 0
      && l3Wires.length === 3 && l3Wires.every(request => memoryIds(request.decisionMemoryPack).includes(source?.case_id)
        && !request.decisionMemoryPack.L5.some(ref => ref.locator?.caseId === source?.case_id)
        && request.decisionMemorySystem.includes('Decision evaluator contract v3'))
      && l3Attempts.length === 3 && l3Attempts.every(attempt => attempt.outcome === 'failed'
        && attempt.error?.kind === 'invalid_output' && attempt.error?.detail === 'UNKNOWN_EVIDENCE: claims may cite only evidenceIds in this pack')
      && l3Only?.closing === 'escalated' && l3Only.decision?.kind === 'user_decision',
    JSON.stringify({ source, sourceWire, l3Only, l3Attempts, l3Wires }))

  run.check('after the genuine user decision the later answer cites only that L5 on wire, Attempt, and SQLite links',
    l5After?.closing === 'answered' && l5After.decision?.answers?.[0]?.selected?.[0] === 'User resolves L3 only'
      && l5Attempts.length === 1 && l5Attempts[0].outcome === 'answer'
      && JSON.stringify(l5Attempts[0].citedEvidenceIds) === JSON.stringify([userDecision?.evidence_id])
      && memoryIds(l5Wire?.decisionMemoryPack).includes(source?.case_id)
      && JSON.stringify(l5Attempts[0].packManifest?.memory?.L3?.sourceCaseIds) === JSON.stringify(memoryIds(l5Wire?.decisionMemoryPack))
      && JSON.stringify(l5Attempts[0].packManifest?.evidenceIds) === JSON.stringify(evidenceIds(l5Wire?.decisionMemoryPack))
      && JSON.stringify(linkedEvidence(raw, l5Attempts[0].attempt_id)) === JSON.stringify(l5Attempts[0].packManifest?.evidenceIds)
      && !l5Attempts[0].citedEvidenceIds?.includes(source?.case_id),
    JSON.stringify({ l5After, l5Attempts, userDecision, l5Wire, links: linkedEvidence(raw, l5Attempts[0]?.attempt_id) }))

  run.check('rating up moves source to L5, down excludes both layers, and undo restores only neutral L3',
    up?.closing === 'answered' && !memoryIds(upWire?.decisionMemoryPack).includes(source?.case_id)
      && upWire?.decisionMemoryPack.L5.some(ref => ref.source === 'agent_record' && ref.locator?.caseId === source?.case_id)
      && !memoryIds(downWire?.decisionMemoryPack).includes(source?.case_id)
      && !downWire?.decisionMemoryPack.L5.some(ref => ref.locator?.caseId === source?.case_id)
      && down?.closing === 'returned' && down.decision?.code === 'MISSING_CONTEXT'
      && memoryIds(undoWire?.decisionMemoryPack).includes(source?.case_id)
      && !undoWire?.decisionMemoryPack.L5.some(ref => ref.source === 'agent_record' && ref.locator?.caseId === source?.case_id)
      && undo?.closing === 'returned' && undo.decision?.code === 'MISSING_CONTEXT'
      && ['rating_up', 'rating_down', 'undo_rating_down'].every(kind => store.feedback.some(item => item.case_id === source?.case_id && item.kind === kind)),
    JSON.stringify({ sourceFeedback: store?.feedback.filter(item => item.case_id === source?.case_id), up, down, undo, upWire, downWire, undoWire }))

  run.check('comment persists only as feedback and cannot alter or enter the neutral episode',
    store?.feedback.some(item => item.case_id === source?.case_id && item.kind === 'comment' && item.payload?.text === COMMENT_SECRET)
      && commentWire?.decisionMemoryCommentLeak === false && !JSON.stringify(commentWire?.decisionMemoryPack).includes(COMMENT_SECRET)
      && commentWire?.decisionMemoryPack.L3.find(episode => episode.sourceCaseId === source?.case_id)?.excerpt
        === undoWire?.decisionMemoryPack.L3.find(episode => episode.sourceCaseId === source?.case_id)?.excerpt
      && source?.feedback_state === 'none' && source?.needs_review === 0
      && comment?.closing === 'returned' && comment.decision?.code === 'MISSING_CONTEXT',
    JSON.stringify({ comment, commentWire, undoEpisode: undoWire?.decisionMemoryPack.L3.find(episode => episode.sourceCaseId === source?.case_id) }))

  run.check('correction supersedes the old episode and drives an answer only through its active L5',
    store?.corrections.some(item => item.agent_id === source?.agent_id && item.supersedes?.includes(source?.case_id))
      && !memoryIds(correctionWire?.decisionMemoryPack).includes(source?.case_id)
      && !correctionWire?.decisionMemoryPack.L5.some(ref => ref.source === 'agent_record' && ref.locator?.caseId === source?.case_id)
      && correction?.closing === 'answered' && correction.decision?.answers?.[0]?.selected?.[0] === 'Corrected answer'
      && correction.decision?.evidenceIds?.length === 1
      && store.evidence.find(ref => ref.evidence_id === correction.decision.evidenceIds[0])?.source === 'user_correction',
    JSON.stringify({ correction, correctionWire, corrections: store?.corrections }))

  const aCaseIds = new Set(store?.cases.filter(item => item.agent_id === source?.agent_id).map(item => item.case_id))
  const aEvidenceIds = new Set(store?.evidence.filter(item => item.agent_id === source?.agent_id).map(item => item.evidence_id))
  const isolated = request => request && memoryIds(request.decisionMemoryPack).every(caseId => !aCaseIds.has(caseId))
    && evidenceIds(request.decisionMemoryPack).every(evidenceId => !aEvidenceIds.has(evidenceId))
    && request.decisionMemoryCommentLeak === false
  run.check('Agent B and workspace W2 receive no A/W1 L3 episode, evidence, comment, or answer',
    isolated(bWire) && isolated(crossWire) && agentB?.agent_id !== source?.agent_id && cross?.agent_id !== source?.agent_id
      && cross?.workspace_key !== source?.workspace_key && agentB?.closing === 'returned' && cross?.closing === 'returned',
    JSON.stringify({ source: { caseId: source?.case_id, agentId: source?.agent_id, workspace: source?.workspace_key }, agentB, cross, bWire, crossWire }))

  run.check('a high-version eligible L3 row creates a recoverable failed Attempt without evaluator fallback, then retrieval recovers',
    report?.corruptedCaseId === up?.case_id && failureAttempts.length === 1 && failureAttempts[0].outcome === 'failed'
      && failureAttempts[0].error?.code === 'UNSUPPORTED_SCHEMA_VERSION' && failure?.decision?.kind === 'user_decision'
      && !wireFor(run, QUESTIONS.failure.id) && store.cases.find(item => item.case_id === up?.case_id)?.schema_version === 1
      && planWire && plan?.state === 'awaiting_user' && attemptFor(store, plan).length === 1 && attemptFor(store, plan)[0].outcome === 'escalate',
    JSON.stringify({ corruptedCaseId: report?.corruptedCaseId, failure, failureAttempts, plan, planAttempts: attemptFor(store, plan), failureWire: wireFor(run, QUESTIONS.failure.id) }))

  run.check('real process restart reproduces the complete ordered non-empty L3 and L5 evaluator inputs',
    beforeWire && afterWire && memoryIds(beforeWire?.decisionMemoryPack).length > 0
      && JSON.stringify(beforeWire?.decisionMemoryPack.L3) === JSON.stringify(afterWire?.decisionMemoryPack.L3)
      && JSON.stringify(beforeWire?.decisionMemoryPack.L5) === JSON.stringify(afterWire?.decisionMemoryPack.L5)
      && before?.state === 'awaiting_user' && after?.state === 'awaiting_user'
      && report?.processRuns.find(item => item.phase === 'seed')?.exitCode === 0
      && report?.processRuns.find(item => item.phase === 'restart')?.exitCode === 0,
    JSON.stringify({ before, after, beforeWire, afterWire, processRuns: report?.processRuns }))

  run.check('actual pinned budget omits L3 before preserving every planned L5 and still calls the evaluator',
    memoryIds(planWire?.decisionMemoryPack).length > 0 && budgetWire?.decisionMemoryPack.L3 === ''
      && budgetAttempts.length === 1 && budgetAttempts[0].outcome === 'answer'
      && budgetAttempts[0].pins?.budgetTokens === report?.budgetTokens && report?.budgetTokens < 24000
      && budgetAttempts[0].packManifest?.memory?.L3?.sourceCaseIds?.length === 0
      && budgetAttempts[0].packManifest?.omissions?.includes('L3_EPISODE_OMITTED')
      && budgetAttempts[0].packManifest?.omissions?.includes('L3_EPISODE_TRUNCATED')
      && !budgetAttempts[0].packManifest?.omissions?.some(code => code.startsWith('L5_'))
      && JSON.stringify(budgetAttempts[0].packManifest?.evidenceIds) === JSON.stringify(evidenceIds(planWire?.decisionMemoryPack))
      && JSON.stringify(evidenceIds(budgetWire?.decisionMemoryPack)) === JSON.stringify(evidenceIds(planWire?.decisionMemoryPack)),
    JSON.stringify({ budgetTokens: report?.budgetTokens, budgetBaseCharacters: report?.budgetBaseCharacters, budget, budgetAttempts, planWire, budgetWire }))

  const ordinaryCases = store?.cases.filter(item => item.case_id !== failure?.case_id) ?? []
  const manifestMatches = ordinaryCases.every(item => {
    const wires = wiresForCase(run, item)
    const attempts = attemptFor(store, item)
    return wires.length === attempts.length && attempts.every((attempt, index) =>
      JSON.stringify(attempt.packManifest?.memory?.L3?.sourceCaseIds ?? []) === JSON.stringify(memoryIds(wires[index]?.decisionMemoryPack))
      && JSON.stringify(attempt.packManifest?.evidenceIds ?? []) === JSON.stringify(evidenceIds(wires[index]?.decisionMemoryPack)))
  })
  const linksMatch = store?.attempts.every(attempt => JSON.stringify(linkedEvidence(raw, attempt.attempt_id)) === JSON.stringify(attempt.packManifest?.evidenceIds ?? []))
  run.check('every ordinary Attempt manifest matches its actual model layers and every attempt_evidence row is ordered L5 only',
    Boolean(store) && manifestMatches && linksMatch,
    JSON.stringify({ manifestMatches, linksMatch, attempts: store?.attempts.map(attempt => ({ attemptId: attempt.attempt_id, caseId: attempt.case_id, memory: attempt.packManifest?.memory, evidenceIds: attempt.packManifest?.evidenceIds, linked: linkedEvidence(raw, attempt.attempt_id) })) }))

  const immutable = immutableSnapshots(run.ws, raw)
  run.check('all prior Attempt bytes, ordered attempt_evidence rows, and Case request/decision content survive every later phase unchanged',
    immutable.ok, JSON.stringify(immutable))

  run.check('all five real headless processes exited cleanly after seed, restart, failure, recovery plan, and budget execution',
    run.code === 0 && report?.processRuns.length === 5 && report.processRuns.every(item => item.exitCode === 0)
      && ['SEED', 'RESTART', 'FAILURE', 'PLAN', 'BUDGET'].every(phase => run.stdout.includes(`DECISION_MEMORY_${phase}_DONE`)),
    `processes=${JSON.stringify(report?.processRuns)} stderr=${run.stderr.slice(-1000)}`)
}

export default { id, prompt, decide, decideDecision, observe, run, assert }
