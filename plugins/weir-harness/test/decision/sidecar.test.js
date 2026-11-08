import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDecisionModelRoute, streamDecision } from '../../src/decision/evaluator/sidecar.js'

const pack = { system: 'Decision evaluator contract v2', messages: [{ role: 'user', content: '{"L4":{}}' }] }

function fakeLlm(chunks) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function * () { for (const chunk of chunks) yield chunk })()
    },
  }
}

function input(llm, overrides = {}) {
  return { llm, route: { kind: 'resolved', provider: 'p', model: 'm' }, pack, maxOutputTokens: 1600, timeoutMs: 1000, ...overrides }
}

test('sidecar accumulates text and usage with only existing GenerateOptions fields', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', text: '{"outcome":' },
    { type: 'text-delta', text: '"escalate"}' },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 9 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await streamDecision(input(llm))
  assert.equal(result.text, '{"outcome":"escalate"}')
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.inputTokens, 120)
  assert.equal(result.outputTokens, 9)
  const options = llm.calls[0]
  assert.equal(options.maxTokens, 1600)
  assert.deepEqual(options.messages[0].content, [{ type: 'text', text: '{"L4":{}}' }])
  for (const key of ['tools', 'purpose', 'sessionId']) assert.equal(key in options, false)
})

const kimiK3Route = { kind: 'resolved', provider: 'kimi-coding', model: 'k3.1-pro' }
const inheritedDeepSeekRoute = { kind: 'inherited', provider: 'deepseek-official', model: 'deepseek-chat' }

function assertNoExplicitSamplingOptions(options, route) {
  assert.equal('temperature' in options, false, 'Decision requests must omit temperature and defer to the provider default')
  assert.equal(options.provider, route.provider)
  assert.equal(options.model, route.model)
  assert.equal(options.maxTokens, 1600)
  assert.deepEqual(options.messages[0].content, [{ type: 'text', text: '{"L4":{}}' }])
  for (const key of ['tools', 'purpose', 'sessionId']) assert.equal(key in options, false)
}

test('Kimi K3 fixed-temperature route sends no explicit temperature', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', text: '{"outcome":"answer"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await streamDecision(input(llm, { route: kimiK3Route }))
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.text, '{"outcome":"answer"}')
  assertNoExplicitSamplingOptions(llm.calls[0], kimiK3Route)
})

test('ordinary inherited DeepSeek route sends no explicit temperature either', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', text: '{"outcome":"return"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await streamDecision(input(llm, { route: inheritedDeepSeekRoute }))
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.text, '{"outcome":"return"}')
  assertNoExplicitSamplingOptions(llm.calls[0], inheritedDeepSeekRoute)
})

for (const [kind, failureCode] of [['error', 'UPSTREAM_429'], ['aborted', undefined], ['max-tokens', undefined]]) {
  test(`finish ${kind} retains its exact runtime classification`, async () => {
    const llm = fakeLlm([{ type: 'finish', reason: { kind, ...(failureCode ? { failure: { code: failureCode } } : {}) } }])
    const result = await streamDecision(input(llm))
    assert.equal(result.finishReason, kind)
    assert.equal(result.failureCode, failureCode)
  })
}

test('hard timeout aborts a hanging stream and external abort wins before invocation', async () => {
  const hanging = { stream: () => (async function * () { await new Promise(() => {}) })() }
  const timed = await streamDecision(input(hanging, { timeoutMs: 5 }))
  assert.equal(timed.finishReason, 'timeout')

  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const llm = { stream: () => { calls++; return fakeLlm([]).stream({}) } }
  const aborted = await streamDecision(input(llm, { signal: controller.signal }))
  assert.equal(aborted.finishReason, 'aborted')
  assert.equal(calls, 0)
})

test('empty model chain inherits the session route', async () => {
  const route = await resolveDecisionModelRoute({ llm: {}, chain: [], sessionRoute: { provider: 'session-p', model: 'session-m', reasoningEffort: 'low' } })
  assert.deepEqual(route, { kind: 'inherited', provider: 'session-p', model: 'session-m', reasoningEffort: 'low' })
  assert.equal((await resolveDecisionModelRoute({ llm: {}, chain: [] })).kind, 'unavailable')
})

test('configured unavailable rung fails closed and unsupported effort is filtered', async () => {
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
  }
  const unavailable = await resolveDecisionModelRoute({ llm, chain: [{ provider: 'absent', model: 'other' }] })
  assert.equal(unavailable.kind, 'unavailable')
  const routed = await resolveDecisionModelRoute({ llm, chain: [{ provider: 'p', model: 'm', reasoningEffort: 'max' }] })
  assert.deepEqual(routed, { kind: 'resolved', provider: 'p', model: 'm' })
  const failed = await streamDecision(input(llm, { route: unavailable }))
  assert.equal(failed.finishReason, 'route_unavailable')
})
