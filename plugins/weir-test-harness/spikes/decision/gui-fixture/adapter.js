// Isolated-Desktop-only adapter decorations for product UI acceptance.
// The real Decision parser, Broker, RPC and SQLite store still consume the output.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extract } from '../../../src/mock-kit.js'
import * as mock from '../../../src/mock-llm.js'

function responseText(chunk) {
  if (chunk?.type === 'text-delta') return { value: chunk.text, write: text => { chunk.text = text } }
  if (chunk?.type === 'block-end' && chunk.block?.type === 'text') return { value: chunk.block.text, write: text => { chunk.block.text = text } }
  return null
}

/** Add non-authoritative suggestions to real escalation output, never answers. */
export function decorateDecisionText(text, options, noChangeAgentId = null) {
  const observation = extract(options)
  const contract = observation.system.split('\n', 1)[0]
  if (!['Decision evaluator contract v1', 'Decision evaluator contract v2', 'Decision evaluator contract v3', 'Decision consolidation contract v1'].includes(contract)) return text
  let output
  let input
  try {
    output = JSON.parse(text)
    input = JSON.parse(observation.lastUser)
  } catch {
    return text
  }
  if (contract === 'Decision consolidation contract v1') {
    return input.agentId === noChangeAgentId ? JSON.stringify({ operations: [] }) : text
  }
  if (output.outcome !== 'escalate') return text
  const questions = input?.L4?.request?.questions
  if (!Array.isArray(questions) || questions.length === 0) return text
  output.suggestion = questions.map(question => ({
    id: question.id,
    ...(Array.isArray(question.options)
      ? { selected: [String(question.options[0]?.label ?? question.options[0]?.value ?? '')] }
      : { selected: [], custom: '未提交建议 / Unsubmitted suggested text' }),
  }))
  return JSON.stringify(output)
}

function noChangeAgent(out) {
  const path = join(out, 'no-change-agent.json')
  if (!existsSync(path)) return null
  try {
    const control = JSON.parse(readFileSync(path, 'utf8'))
    return control.enabled === true && typeof control.agentId === 'string' ? control.agentId : null
  } catch {
    return null
  }
}

export function uniqueToolCall(chunk, id) {
  if (chunk?.type === 'tool-call-delta') chunk.id = id
  if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') chunk.block.id = id
  return chunk
}
async function* stream(options, out) {
  const noChangeAgentId = noChangeAgent(out)
  const toolCallId = `mock-product-${randomUUID()}`
  for await (const original of mock.streamScenario(options)) {
    const chunk = original
    uniqueToolCall(chunk, toolCallId)
    const target = responseText(chunk)
    if (target) {
      const transformed = decorateDecisionText(target.value, options, noChangeAgentId)
      if (transformed !== target.value) {
        target.write(transformed)
        appendFileSync(join(out, 'adapter-transforms.jsonl'), `${JSON.stringify({ contract: extract(options).system.split('\n', 1)[0], before: target.value, after: transformed })}\n`)
      }
    }
    yield chunk
  }
}

/** Register the same mock provider with narrowly scoped product-QA decorations. */
export function applyGuiAdapter(ctx, out) {
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'Mock LLM' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async provider => [{ provider, id: 'mock-1', name: 'Mock One', inputModalities: ['text'] }],
    resolveModel: async (provider, model) => mock.modelInfo(provider, model),
    prepareCall: async (provider, model) => ({
      config: { provider, model },
      retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      adapterDefaults: {},
      model: mock.modelInfo(provider, model),
      stream: options => stream(options, out),
    }),
    stream: options => stream(options, out),
  }
  ctx.llm.registerAdapter(['mock'], adapter)
}
