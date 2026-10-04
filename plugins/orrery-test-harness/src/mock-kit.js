// Pure-function kit shared by the mock LLM entry and the scenario modules
// (design D3, extracted from mock-llm.js with zero behavior change).
//
// Two families:
//   - request inspection: blockText/transcript/lastOfRole/lastToolName, and
//     the single-extraction observation base `extract` (design D2)
//   - chunk emitters: usage/textChunks/toolCallChunks/errorChunks plus the
//     named-operation shellCall wrapper (platform shell via ./shell.js)
// Also owns the harness-wide env-derived root so mock, event-tap and scenario
// modules derive paths from one source.
import { join } from 'node:path'
import { shellCommand, shellToolName } from './shell.js'
import { textOf } from './message-text.js'
import { defaultItRoot } from './it-root.js'

// Also works when mounted without the driver; all consumers share the default.
const IT_ROOT = process.env.ORRERY_IT_ROOT ?? defaultItRoot()

const SHELL = shellToolName()

// The curated-agent shell is `pwsh` on win32 and `bash` elsewhere, so callers
// emit named operations and src/shell.js renders the platform command.
function shellCall(operation, args, description) {
  return toolCallChunks(SHELL, { command: shellCommand(operation, process.platform, args), description })
}

// ---------- request inspection ----------

function blockText(message) {
  return textOf(message)
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

/**
 * The single per-request observation extraction (design D2): every consumer
 * (scenario decide/observe, the trace record) derives from this one pass.
 * `toolNames` feeds the generic trace field; `toolDefs` carries the raw tool
 * definitions for observations that inspect schemas (hashline's escalation
 * enum).
 * @param {object} options - the LLM request options
 * @returns {{transcript: string, lastUser: string, lastTool: string, system: string, toolNames: string[], toolDefs: any[], messages: any[]}}
 */
function extract(options) {
  return {
    transcript: transcript(options),
    lastUser: lastOfRole(options, 'user'),
    lastTool: lastOfRole(options, 'tool'),
    system: options.system ?? '',
    toolNames: (options.tools ?? []).map((tool) => tool.name),
    toolDefs: options.tools ?? [],
    messages: options.messages ?? [],
  }
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

export {
  IT_ROOT,
  blockText,
  transcript,
  lastOfRole,
  lastToolName,
  extract,
  usage,
  textChunks,
  toolCallChunks,
  errorChunks,
  shellCall,
}
