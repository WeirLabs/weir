// Scripted mock LLM adapter for headless integration tests of weir-harness.
// Registers provider `mock` on ctx.llm and answers every request from the
// scenario registry (env WEIR_IT_SCENARIO selects the entry), tracing each
// call as one JSON line to WEIR_IT_TRACE for the driver to assert on.
// Dev-only: never install into a real profile.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IT_ROOT, extract, textChunks } from './mock-kit.js'
import { SCENARIOS, byId } from './scenarios/index.js'

const name = 'weir-it-mock-llm'
const inject = ['llm']

const SCENARIO = process.env.WEIR_IT_SCENARIO ?? 'deepwork'
const TRACE = process.env.WEIR_IT_TRACE ?? join(IT_ROOT, 'trace.jsonl')
const WINDOW = Number(process.env.WEIR_IT_WINDOW ?? '128000')

// Test-only provider capability switch. Unsupported remains the default; any
// opted-in value outside DSH's closed union fails before the profile can run.
function parseToolUpdate(value) {
  if (value === undefined) return undefined
  if (value === 'addition-only' || value === 'in-history') return value
  throw new Error(`WEIR_IT_TOOL_UPDATE must be 'addition-only' or 'in-history' when set; received ${JSON.stringify(value)}`)
}

const TOOL_UPDATE = parseToolUpdate(process.env.WEIR_IT_TOOL_UPDATE)

function modelInfo(provider, model, toolUpdate = TOOL_UPDATE) {
  return {
    provider,
    id: model,
    name: model,
    inputModalities: ['text'],
    context: { contextWindow: WINDOW },
    ...(toolUpdate === undefined ? {} : { toolUpdate }),
  }
}

// The env is the registry lookup key; an unknown id throws at plugin load
// (loud failure) instead of answering an "unknown scenario" text that lets
// the run pass silently (spec: 未知场景显式失败, design D1).
const scenario = byId(SCENARIO)
if (!scenario) {
  throw new Error(`weir-it-mock-llm: unknown scenario '${SCENARIO}' (known: ${SCENARIOS.map((entry) => entry.id).join(', ')})`)
}

let callSeq = 0

function trace(record) {
  try {
    mkdirSync(dirname(TRACE), { recursive: true })
    appendFileSync(TRACE, JSON.stringify({ seq: ++callSeq, ...record }) + '\n')
  } catch {
    // tracing must never break a test run
  }
}

// ---------- request handling (design D2: one extraction per request) ----------

function decide(options, obs) {
  if (options.purpose === 'session-title') return textChunks('Integration Test Session')
  if (options.purpose === 'compaction') return textChunks('SUMMARY: the probe task was in progress with no errors.')
  const contract = obs.system.split('\n', 1)[0]
  if (contract === 'Auto request classification contract: router-classification-contract/1') {
    if (typeof scenario.decideRouterClassification !== 'function') throw new Error(`${scenario.id} has no Auto classification brain`)
    return scenario.decideRouterClassification(options, obs)
  }
  if (contract === 'Auto candidate router contract: router-contract/1') {
    if (typeof scenario.decideRouterRoute !== 'function') throw new Error(`${scenario.id} has no Auto Router brain`)
    return scenario.decideRouterRoute(options, obs)
  }
  if (contract === 'Decision consolidation contract v1') {
    if (typeof scenario.decideConsolidation !== 'function') throw new Error(`${scenario.id} has no consolidation Decision brain`)
    return scenario.decideConsolidation(options, obs)
  }
  // Exact first-line dispatch keeps historical fixtures working without
  // confusing evaluator v3 with the independent consolidation v1 contract.
  if (['Decision evaluator contract v1', 'Decision evaluator contract v2', 'Decision evaluator contract v3'].includes(contract)) {
    return (scenario.decideDecision ?? scenario.decide)(options, obs)
  }
  // Intent-gate semantic-classifier sidecar: scripted answer per scenario.
  if (obs.system.includes('You classify a user prompt')) {
    return textChunks(scenario.id === 'semantic' ? 'deep-work' : 'none')
  }
  return scenario.decide(options, obs)
}

/**
 * Build the trace record for one request from the single extraction: generic
 * fields plus the scenario's own observation keys (design D2; every key name
 * kept verbatim from the pre-registry trace block).
 */
function buildTraceRecord(options, obs, out) {
  return {
    scenario: scenario.id,
    purpose: options.purpose ?? 'main',
    tools: obs.toolNames,
    ...scenario.observe?.(obs),
    emitted: out.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block?.type ?? 'unknown'),
    emittedNames: out.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block?.name ?? chunk.block?.type ?? 'unknown'),
    lastUser: obs.lastUser.slice(0, 200),
    lastTool: obs.lastTool.slice(0, 300),
  }
}

/**
 * Decide + observe one request with exactly one transcript extraction
 * (design D2). extractImpl is injectable so the conformance suite can count
 * extraction calls per request.
 */
function planRequest(options, extractImpl = extract) {
  const obs = extractImpl(options)
  const out = [...decide(options, obs)]
  return { out, record: buildTraceRecord(options, obs, out) }
}

async function* streamScenario(options) {
  // Strict-provider schema validation: every tool's parameters must be an
  // object-rooted JSON Schema (DeepSeek rejects anything else) — this check
  // reproduces the provider-side schema gate headlessly.
  const invalidTools = (options.tools ?? [])
    .filter((tool) => tool.deferLoading !== true && (!tool.parameters || tool.parameters.type !== 'object'))
    .map((tool) => tool.name)
  if (invalidTools.length > 0) {
    throw new Error(`Invalid schema for function '${invalidTools[0]}': schema must be a JSON Schema of 'type: "object"'`)
  }
  const { out, record } = planRequest(options)
  trace(record)
  if (scenario.id === 'decision-learning' && record.decisionLearning?.kind === 'consolidation' && process.env.WEIR_IT_LEARNING_HOLD === '1') {
    const ready = process.env.WEIR_IT_LEARNING_READY
    const release = process.env.WEIR_IT_LEARNING_RELEASE
    if (ready) writeFileSync(ready, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n')
    const deadline = Date.now() + 60_000
    while (!options.signal?.aborted && (!release || !existsSync(release))) {
      if (Date.now() >= deadline) throw new Error('decision-learning consolidation hold timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'MOCK_ABORT', message: 'learning stream aborted' } } }
      return
    }
  }
  if (record.autoRouterHold === 'singleflight') {
    const ready = join(IT_ROOT, 'decision-auto-singleflight.ready')
    const release = join(IT_ROOT, 'decision-auto-singleflight.release')
    writeFileSync(ready, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n')
    const deadline = Date.now() + 10_000
    while (!options.signal?.aborted && !existsSync(release)) {
      if (Date.now() >= deadline) throw new Error('decision-auto-route single-flight hold timed out')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'MOCK_ABORT', message: 'single-flight Router stream aborted' } } }
      return
    }
  }
  if (record.autoRouterHold === 'flush' || record.autoRouterHold === 'interruption') {
    const kind = record.autoRouterHold
    const ready = join(IT_ROOT, `decision-auto-${kind}.ready`)
    const release = join(IT_ROOT, `decision-auto-${kind}.release`)
    writeFileSync(ready, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n')
    const deadline = Date.now() + 30_000
    while (!options.signal?.aborted && !existsSync(release)) {
      if (Date.now() >= deadline) throw new Error(`decision-auto ${kind} hold timed out`)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    if (options.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'MOCK_ABORT', message: `${kind} Router stream aborted` } } }
      return
    }
  }
  if (record.autoRouterHold === 'timeout') {
    await new Promise((resolve) => {
      if (options.signal?.aborted) return resolve()
      options.signal?.addEventListener('abort', resolve, { once: true })
    })
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'MOCK_ABORT', message: 'Router stream held until abort' } } }
    return
  }
  if (scenario.id === 'decision-spike-cancel' && record.s6Fixture === 'hang') {
    const events = process.env.WEIR_DECISION_SPIKE_EVENTS
    if (events) appendFileSync(events, JSON.stringify({ time: Date.now(), spike: 'S6', listener: 'llm-hang' }) + '\n')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    await new Promise((resolve) => {
      if (options.signal?.aborted) return resolve()
      options.signal?.addEventListener('abort', resolve, { once: true })
    })
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'MOCK_ABORT', message: 'mock stream aborted' } } }
    return
  }
  yield* out
}

function apply(ctx) {
  const adapter = {
    providerInfo: (provider) => ({ id: provider, name: 'Mock LLM' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async (provider) => [{ provider, id: 'mock-1', name: 'Mock One', inputModalities: ['text'] }],
    resolveModel: async (provider, model) => modelInfo(provider, model),
    prepareCall: async (provider, model) => ({
      config: { provider, model },
      retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      adapterDefaults: {},
      model: modelInfo(provider, model),
      stream: (options) => streamScenario(options),
    }),
    stream: (options) => streamScenario(options),
  }
  ctx.llm.registerAdapter(['mock'], adapter)
}

export { name, inject, apply, modelInfo, parseToolUpdate, planRequest, buildTraceRecord, streamScenario }
