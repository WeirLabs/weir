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

/**
 * Two-entry consolidation for the candidate-edit acceptance leg: the parent's
 * active principle is refined in place (a `changed` entry) and one new principle
 * is added (an `added` entry), so one real review offers two editable rows. The
 * product parser, structural replay and store consume the result unchanged.
 * @param {any} input the frozen projection the product handed the model
 */
function candidateEditOperations(input) {
  const principles = Array.isArray(input?.parentSnapshot?.principles) ? input.parentSnapshot.principles : []
  const parent = principles.find(principle => principle?.state === 'active')
  const workspaceKey = typeof input?.workspaceKey === 'string' && input.workspaceKey ? input.workspaceKey : null
  const lineage = values => values.filter(id => typeof id === 'string' && id.length > 0)
  const correction = (Array.isArray(input?.feedback) ? input.feedback : []).find(item => item.kind === 'correction')
  const sources = lineage(parent?.sources ?? [])
  if (!parent?.principleId || !workspaceKey || sources.length === 0) return null
  return [
    { op: 'refine', principleId: parent.principleId, text: 'Reviewed GUI successor principle: prefer the second source-backed answer under a reviewed class.', sources },
    // A second entry keeps its own lineage: the correction when the packet has one.
    { op: 'add', principleId: 'temporary-gui-edit-second', text: 'Reviewed GUI second principle: keep the isolated GUI review scope for one more entry.', scope: { workspaces: [workspaceKey] }, sources: lineage([correction?.feedbackId ?? sources[0]]) },
  ]
}

/** Add non-authoritative suggestions to real escalation output, never answers. */
export function decorateDecisionText(text, options, noChangeAgentId = null, candidateEditAgentId = null) {
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
    if (input.agentId === noChangeAgentId) return JSON.stringify({ operations: [] })
    const edited = input.agentId === candidateEditAgentId ? candidateEditOperations(input) : null
    return edited ? JSON.stringify({ operations: edited }) : text
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

function controlAgent(out, file) {
  const path = join(out, file)
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
  const noChangeAgentId = controlAgent(out, 'no-change-agent.json')
  const candidateEditAgentId = controlAgent(out, 'candidate-edit-agent.json')
  const toolCallId = `mock-product-${randomUUID()}`
  for await (const original of mock.streamScenario(options)) {
    const chunk = original
    uniqueToolCall(chunk, toolCallId)
    const target = responseText(chunk)
    if (target) {
      const transformed = decorateDecisionText(target.value, options, noChangeAgentId, candidateEditAgentId)
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
