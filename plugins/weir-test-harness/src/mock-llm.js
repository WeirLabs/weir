// Scripted mock LLM adapter for headless integration tests of weir-harness.
// Registers provider `mock` on ctx.llm and answers every request from the
// scenario registry (env WEIR_IT_SCENARIO selects the entry), tracing each
// call as one JSON line to WEIR_IT_TRACE for the driver to assert on.
// Dev-only: never install into a real profile.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IT_ROOT, extract, textChunks } from './mock-kit.js'
import { SCENARIOS, byId } from './scenarios/index.js'

const name = 'weir-it-mock-llm'
const inject = ['llm']

const SCENARIO = process.env.WEIR_IT_SCENARIO ?? 'deepwork'
const TRACE = process.env.WEIR_IT_TRACE ?? join(IT_ROOT, 'trace.jsonl')
const WINDOW = Number(process.env.WEIR_IT_WINDOW ?? '128000')

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
  yield* out
}

function apply(ctx) {
  const adapter = {
    providerInfo: (provider) => ({ id: provider, name: 'Mock LLM' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async (provider) => [{ provider, id: 'mock-1', name: 'Mock One', inputModalities: ['text'] }],
    resolveModel: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: WINDOW },
    }),
    prepareCall: async (provider, model) => ({
      config: { provider, model },
      retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      adapterDefaults: {},
      model: {
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: WINDOW },
      },
      stream: (options) => streamScenario(options),
    }),
    stream: (options) => streamScenario(options),
  }
  ctx.llm.registerAdapter(['mock'], adapter)
}

export { name, inject, apply, planRequest, buildTraceRecord, streamScenario }
