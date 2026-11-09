// Direct ctx.llm.stream sidecar with explicit routing and a hard Attempt deadline.
import { filterUnsupportedEffort, resolveTargetRoute, snapshotProviders } from '../../delegate/resolver.js'

/** @param {{llm:any,chain?:any[],sessionRoute?:{provider?:string,model?:string,reasoningEffort?:string}}} input */
export async function resolveDecisionModelRoute(input) {
  const chain = input.chain ?? []
  if (chain.length === 0) {
    const route = input.sessionRoute
    if (!route?.provider || !route?.model) return { kind: 'unavailable', reason: 'inherited session route is unavailable' }
    return {
      kind: 'inherited', provider: route.provider, model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    }
  }
  const snapshot = await snapshotProviders(input.llm)
  const resolved = resolveTargetRoute({ chain }, snapshot, true)
  if (resolved.kind === 'unavailable') return resolved
  return filterUnsupportedEffort(input.llm, resolved)
}

/**
 * @param {{llm:any,route:any,pack:{system:string,messages:any[]},maxOutputTokens:number,timeoutMs:number,signal?:AbortSignal}} input
 */
export async function streamDecision(input) {
  if (input.route?.kind === 'unavailable') return failure('route_unavailable')
  if (!input.route?.provider || !input.route?.model) return failure('route_unavailable')
  if (input.signal?.aborted) return failure('aborted')

  const controller = new AbortController()
  let onAbort = () => {}
  /** @type {Promise<{kind:'aborted'}>} */
  const aborted = new Promise(resolve => {
    onAbort = () => {
      controller.abort(input.signal?.reason)
      resolve({ kind: 'aborted' })
    }
  })
  input.signal?.addEventListener('abort', onAbort, { once: true })
  const options = {
    provider: input.route.provider,
    model: input.route.model,
    ...(input.route.reasoningEffort ? { reasoningEffort: input.route.reasoningEffort } : {}),
    system: input.pack.system,
    messages: input.pack.messages.map(message => ({
      role: message.role,
      content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content,
    })),
    maxTokens: input.maxOutputTokens,
    signal: controller.signal,
  }

  let timer
  let consuming
  try {
    consuming = consume(input.llm.stream(options)).then(value => ({ kind: 'done', value }), error => ({ kind: 'error', error }))
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort(new Error('Decision evaluator deadline'))
        resolve({ kind: 'timeout' })
      }, input.timeoutMs)
    })
    const winner = await Promise.race([consuming, timeout, aborted])
    if (winner.kind === 'aborted') {
      consuming.catch(() => {})
      return failure('aborted')
    }
    if (winner.kind === 'timeout') {
      consuming.catch(() => {})
      return failure('timeout')
    }
    if (winner.kind === 'error') {
      if (input.signal?.aborted || controller.signal.aborted) return failure('aborted')
      return failure('model_error', winner.error?.code)
    }
    return winner.value
  } catch (error) {
    if (input.signal?.aborted || controller.signal.aborted) return failure('aborted')
    return failure('model_error', /** @type {any} */ (error)?.code)
  } finally {
    if (timer) clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

/** @param {AsyncIterable<any>} stream */
async function consume(stream) {
  let text = ''
  let finishReason = 'stop'
  let failureCode
  let inputTokens
  let outputTokens
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'usage') {
      const usage = chunk.usage ?? chunk
      inputTokens = usage.inputTokens ?? usage.input_tokens ?? inputTokens
      outputTokens = usage.outputTokens ?? usage.output_tokens ?? outputTokens
    }
    if (chunk.type === 'finish') {
      finishReason = chunk.reason?.kind ?? 'stop'
      failureCode = chunk.reason?.failure?.code
      break
    }
  }
  return { text, finishReason, failureCode, inputTokens, outputTokens }
}

/** @param {string} finishReason @param {string} [failureCode] */
function failure(finishReason, failureCode) {
  return { text: '', finishReason, failureCode }
}
