// Scripted mock LLM adapter for headless integration tests of orrery-harness.
// Registers provider `mock` on ctx.llm and answers every request from
// content-driven scenario rules (env ORRERY_IT_SCENARIO), tracing each call
// as one JSON line to ORRERY_IT_TRACE for the driver to assert on.
// Dev-only: never install into a real profile.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const name = 'orrery-it-mock-llm'
const inject = ['llm']

const SCENARIO = process.env.ORRERY_IT_SCENARIO ?? 'deepwork'
const TRACE = process.env.ORRERY_IT_TRACE ?? '/tmp/orrery-it/trace.jsonl'
const FIXTURE = process.env.ORRERY_IT_FIXTURE ?? '/tmp/orrery-it/ws/fixture.txt'
const WINDOW = Number(process.env.ORRERY_IT_WINDOW ?? '128000')
const LONG_FILLER = 'Filler line to raise pressure. '.repeat(600)

let callSeq = 0

function trace(record) {
  try {
    mkdirSync(dirname(TRACE), { recursive: true })
    appendFileSync(TRACE, JSON.stringify({ seq: ++callSeq, ...record }) + '\n')
  } catch {
    // tracing must never break a test run
  }
}

// ---------- request inspection ----------

function blockText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function transcript(options) {
  return (options.messages ?? [])
    .map((message) => `${message.role}:\n${blockText(message)}`)
    .join('\n---\n')
}

function lastOfRole(options, role) {
  const messages = options.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === role) {
      const text = blockText(messages[index])
      if (text.length > 0) return text
    }
  }
  return ''
}

function lastToolName(options) {
  const messages = options.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'tool') return message.source?.toolCallId ?? ''
  }
  return ''
}

// ---------- chunk emitters ----------

function usage() {
  return { type: 'usage', usage: { inputTokens: 600, outputTokens: 60 } }
}

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield usage()
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolCallChunks(callName, args) {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: 'mock-call-1', name: callName, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'mock-call-1', name: callName, arguments: argumentsText } }
  yield usage()
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

// ---------- scenario brains ----------

function decideDeepwork(options) {
  const history = transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    // after a tool result
    if (history.includes('<todo_continuation>')) {
      return textChunks('All todos are complete now. Deep work run finished.')
    }
    return textChunks('Registered the plan and paused with one open todo.')
  }
  if (history.includes('<todo_continuation>')) {
    return toolCallChunks('todo_write', {
      todos: [
        { content: 'register the plan', status: 'completed' },
        { content: 'finish the run', status: 'completed' },
      ],
    })
  }
  if (history.includes('深度工作')) {
    return toolCallChunks('todo_write', {
      todos: [
        { content: 'register the plan', status: 'completed' },
        { content: 'finish the run', status: 'pending' },
      ],
    })
  }
  return textChunks('unhandled deepwork turn')
}

function decideDelegate(options) {
  const history = transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (history.includes('MARKER_CHILD_OK') && !history.includes('delegate-probe')) {
    return textChunks('MARKER_CHILD_OK: child finished')
  }
  if (lastRole === 'tool') {
    return textChunks('parent observed child result')
  }
  if (history.includes('delegate-probe')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      prompt: 'TASK: reply with the exact marker text MARKER_CHILD_OK\nDELIVERABLE: the marker line\nSCOPE: nothing else\nVERIFY: the reply contains the marker\nSTOP WHEN: the marker is sent',
      task_summary: 'probe child',
    })
  }
  return textChunks('unhandled delegate turn')
}

function decideHashline(options) {
  const history = transcript(options)
  const messages = options.messages ?? []
  const lastRole = messages.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    const anchor = /\n2#([ZPMQVRWSNKTXJBYH]{2})\|/.exec(`\n${toolText}`)
    if (anchor && !history.includes('hash_edit applied')) {
      return toolCallChunks('hash_edit', {
        file_path: FIXTURE,
        edits: [{ op: 'replace', pos: `2#${anchor[1]}`, lines: ['CHANGED-BY-HASHLINE'] }],
      })
    }
    return textChunks('hashline edit applied')
  }
  if (history.includes('hashline-probe')) {
    return toolCallChunks('read', { file_path: FIXTURE })
  }
  return textChunks('unhandled hashline turn')
}

function decidePressure(options) {
  if (options.purpose === 'compaction') {
    return textChunks('SUMMARY: the probe task was in progress with no errors.')
  }
  const history = transcript(options)
  if (history.includes('Resume the task from the compaction summary')) {
    return textChunks('resumed after compaction')
  }
  if (history.includes('pressure-probe')) {
    return textChunks(LONG_FILLER)
  }
  return textChunks('unhandled pressure turn')
}

function decide(options) {
  if (options.purpose === 'session-title') return textChunks('Integration Test Session')
  if (options.purpose === 'compaction') return textChunks('SUMMARY: the probe task was in progress with no errors.')
  switch (SCENARIO) {
    case 'deepwork':
      return decideDeepwork(options)
    case 'delegate':
      return decideDelegate(options)
    case 'hashline':
      return decideHashline(options)
    case 'pressure':
      return decidePressure(options)
    default:
      return textChunks(`unknown scenario ${SCENARIO}`)
  }
}

async function* streamScenario(options) {
  const tools = (options.tools ?? []).map((tool) => tool.name)
  // Strict-provider schema validation: every tool's parameters must be an
  // object-rooted JSON Schema (DeepSeek rejects anything else) — this check
  // reproduces the provider-side schema gate headlessly.
  const invalidTools = (options.tools ?? [])
    .filter((tool) => tool.deferLoading !== true && (!tool.parameters || tool.parameters.type !== 'object'))
    .map((tool) => tool.name)
  if (invalidTools.length > 0) {
    throw new Error(`Invalid schema for function '${invalidTools[0]}': schema must be a JSON Schema of 'type: "object"'`)
  }
  const out = [...decide(options)]
  trace({
    scenario: SCENARIO,
    purpose: options.purpose ?? 'main',
    tools,
    intentInjected: transcript(options).includes('<intent-gate id="deep-work"'),
    continuationSeen: transcript(options).includes('<todo_continuation>'),
    pressureAdvisorySeen: transcript(options).includes('<context_pressure>'),
    anchoredReadSeen: /#([ZPMQVRWSNKTXJBYH]{2})\|/.test(transcript(options)),
    sawDelegateProbe: transcript(options).includes('delegate-probe'),
    sawChildMarker: transcript(options).includes('MARKER_CHILD_OK'),
    emitted: out.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block?.type ?? 'unknown'),
    lastUser: lastOfRole(options, 'user').slice(0, 200),
  })
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

export { name, inject, apply }
