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

function* errorChunks(message) {
  yield usage()
  yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'MOCK_429' } } }
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

function decideSemantic(options) {
  const history = transcript(options)
  if (history.includes('<intent-gate id="deep-work"')) {
    return textChunks('semantic mode armed, task done')
  }
  return textChunks('unhandled semantic turn')
}

const TSFIXTURE = process.env.ORRERY_IT_TSFIXTURE ?? '/tmp/orrery-it/ws/probe.ts'

function decideLsp(options) {
  const history = transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('unknown tool')) return textChunks('lsp scenario done')
    if (toolText.includes('disabled for this session')) return toolCallChunks('lsp_diagnostics', { file_path: TSFIXTURE })
    if (toolText.includes('fixtureSymbol')) return toolCallChunks('lsp', { enabled: false })
    if (toolText.includes('reference(s)')) return toolCallChunks('lsp_symbols', { file_path: TSFIXTURE })
    if (toolText.includes('Definition location')) return toolCallChunks('lsp_references', { file_path: TSFIXTURE, line: 3, character: 5 })
    if (toolText.includes('diagnostic(s) for')) return toolCallChunks('lsp_definition', { file_path: TSFIXTURE, line: 3, character: 5 })
    if (toolText.includes('enabled for this session')) return toolCallChunks('lsp_diagnostics', { file_path: TSFIXTURE })
    return textChunks('unhandled lsp turn')
  }
  if (history.includes('lsp-probe')) {
    return toolCallChunks('lsp', { enabled: true })
  }
  return textChunks('unhandled lsp turn')
}

function decideGrouped(options) {  const history = transcript(options)
  // Child A: first turn fails with a provider error; the coordinator's retry
  // message (RETRY_MESSAGE) then gets a clean terminal report.
  if (history.includes('GROUPED_CHILD_A') && !history.includes('grouped-probe')) {
    if (history.includes('Continue the task now, and remember to end')) {
      return textChunks('STATUS: completed\nREPORT: alpha finished after one retry')
    }
    return errorChunks('simulated provider 429')
  }
  // Child B: settles on the first try.
  if (history.includes('GROUPED_CHILD_B') && !history.includes('grouped-probe')) {
    return textChunks('STATUS: completed\nREPORT: beta finished first try')
  }
  // Parent: observe the merged group report; after the delegate tool result,
  // pad the busy window so the headless one-shot driver does not exit before
  // the (instant-mock) children settle; then end the turn and wait.
  if (history.includes('<supervised_group_report')) {
    return textChunks('parent observed group merge')
  }
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('Supervised group')) {
      return toolCallChunks('bash', { command: 'sleep 1', description: 'Let supervised children settle' })
    }
    return textChunks('group started, waiting for the merged report')
  }
  if (history.includes('grouped-probe') && !history.includes('Supervised group')) {
    return toolCallChunks('delegate', {
      group: 'probe-group',
      tasks: [
        { category: 'quick', prompt: 'GROUPED_CHILD_A\nTASK: probe alpha\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
        { category: 'quick', prompt: 'GROUPED_CHILD_B\nTASK: probe beta\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
      ],
    })
  }
  return textChunks('unhandled grouped turn')
}

function decideRobash(options) {
  const history = transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  // Child brain (explore curated agent): run an allowed command, then a denied one.
  if (history.includes('ROBASH_CHILD') && !history.includes('robash-probe')) {
    if (lastRole === 'tool') {
      const toolText = lastOfRole(options, 'tool')
      if (toolText.includes('ROBASH_LS_RAN') && !history.includes('read-only agent')) {
        return toolCallChunks('bash', { command: 'rm -rf fixture.txt', description: 'Try to delete the fixture' })
      }
      return textChunks('MARKER_ROBASH_OK: ls ran, rm was denied')
    }
    return toolCallChunks('bash', { command: 'echo ROBASH_LS_RAN', description: 'Prove bash executed' })
  }
  // Parent brain: delegate to the explore curated agent.
  if (lastRole === 'tool') {
    return textChunks('parent observed robash child result')
  }
  if (history.includes('robash-probe')) {
    return toolCallChunks('delegate', {
      agent: 'explore',
      prompt: 'ROBASH_CHILD\nTASK: prove bash works, then attempt a write command\nDELIVERABLE: report both outcomes\nSCOPE: bash only\nVERIFY: the echo output and the denial both observed\nSTOP WHEN: reported',
      task_summary: 'robash child',
    })
  }
  return textChunks('unhandled robash turn')
}

function decide(options) {
  if (options.purpose === 'session-title') return textChunks('Integration Test Session')
  if (options.purpose === 'compaction') return textChunks('SUMMARY: the probe task was in progress with no errors.')
  // Intent-gate semantic-classifier sidecar: scripted answer per scenario.
  if ((options.system ?? '').includes('You classify a user prompt')) {
    return textChunks(SCENARIO === 'semantic' ? 'deep-work' : 'none')
  }
  switch (SCENARIO) {
    case 'deepwork':
      return decideDeepwork(options)
    case 'delegate':
      return decideDelegate(options)
    case 'hashline':
      return decideHashline(options)
    case 'pressure':
      return decidePressure(options)
    case 'robash':
      return decideRobash(options)
    case 'semantic':
      return decideSemantic(options)
    case 'grouped':
      return decideGrouped(options)
    case 'lsp':
      return decideLsp(options)
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
    sawRobashChild: transcript(options).includes('ROBASH_CHILD'),
    roBashLsSeen: transcript(options).includes('ROBASH_LS_RAN'),
    roBashRmDenied: transcript(options).includes('explicitly denied'),
    sawClassifyCall: (options.system ?? '').includes('You classify a user prompt'),
    sawGroupProbe: transcript(options).includes('grouped-probe'),
    groupRetrySeen: transcript(options).includes('Continue the task now, and remember to end'),
    mergedAlphaSeen: transcript(options).includes('alpha finished after one retry'),
    mergedBetaSeen: transcript(options).includes('beta finished first try'),
    lspToggledOn: transcript(options).includes('LSP semantic tools enabled'),
    lspDiagSeen: transcript(options).includes('mock-diagnostic'),
    lspDefSeen: transcript(options).includes('probe.ts:3:5'),
    lspRefsSeen: transcript(options).includes('2 reference(s)'),
    lspSymbolsSeen: transcript(options).includes('fixtureSymbol'),
    lspUnknownAfterOff: transcript(options).includes('unknown tool "lsp_diagnostics"'),
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
