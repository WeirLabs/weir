import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planAutoRoute, routeAuto } from '../../src/decision/router.js'

const WORKSPACE = '/workspace-one'
const SESSION_ROUTE = { provider: 'session-provider', model: 'session-model', reasoningEffort: 'low' }

function question(id, text = `Question ${id}`) {
  return {
    id, header: `Header ${id}`, question: text, detail: `Detail ${id}`,
    options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
  }
}

function request(questions, extra = {}) {
  return { entry: 'consult', questions, context: 'Current task summary', ...extra }
}

function scope(extra = {}) {
  return { workspaces: [WORKSPACE], ...extra }
}

function profile(agentId, extra = {}) {
  return {
    agentId, name: `Agent ${agentId}`, state: 'enabled',
    scope: scope(), userDescription: { revision: 1, text: `Current user-written preference for ${agentId}` },
    generatedDescription: { revision: 99, text: `FORBIDDEN_GENERATED_${agentId}` },
    modelRoute: { chain: [{ provider: 'candidate-provider', model: 'candidate-model' }] },
    ...extra,
  }
}

function fakeLlm(value, { finishReason = 'stop', failureCode } = {}) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function * () {
        yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) }
        yield { type: 'finish', reason: { kind: finishReason, ...(failureCode ? { failure: { code: failureCode } } : {}) } }
      })()
    },
  }
}

// One scripted reply per sidecar call, so a test can force the first attempt to
// truncate/invalidate and the retry to succeed. A missing reply throws: an
// unexpected call has to be loud, not a silent copy of the previous answer.
function fakeSequenceLlm(replies) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const reply = replies[calls.length - 1]
      if (!reply) throw new Error('unexpected sidecar call')
      return (async function * () {
        if (typeof reply.outputTokens === 'number') yield { type: 'usage', usage: { outputTokens: reply.outputTokens } }
        if (typeof reply.text === 'string') yield { type: 'text-delta', text: reply.text }
        yield { type: 'finish', reason: { kind: reply.finishReason ?? 'stop' } }
      })()
    },
  }
}

function unusedLlm() {
  const calls = []
  return { calls, stream(options) { calls.push(options); throw new Error('model must not be called') } }
}

function input(llm, extra = {}) {
  return {
    llm, sessionRoute: SESSION_ROUTE, timeoutMs: 1000, maxOutputTokens: 1600,
    contextBudgetTokens: 24000, ...extra,
  }
}

function userPayload(call) {
  return JSON.parse(call.messages[0].content[0].text)
}

function validRoute() {
  return { contract: 'router-contract/1', outcome: 'selected', agentId: 'agent-b', reason: 'Relevant preference' }
}

describe('Auto deterministic candidate planning', () => {
  it('keeps enabled/archived/scope filtering deterministic across the whole profile', () => {
    const eligibleA = profile('agent-a')
    const eligibleB = profile('agent-b', { userDescription: { revision: 4, text: 'Current revision four' } })
    const disabled = profile('agent-disabled', { state: 'disabled' })
    const archived = profile('agent-archived', { state: 'archived' })
    // Created elsewhere in the profile: identity is shared, so it is eligible.
    const foreign = profile('agent-foreign')
    const wrongPath = profile('agent-path', { scope: scope({ paths: ['src'] }) })
    const wrongTag = profile('agent-tag', { scope: scope({ tags: ['backend'] }) })
    // A legacy class field is inert: it neither filters nor rejects.
    const legacyClass = profile('agent-class', { scope: { authorizationClasses: ['A'] } })
    const plan = planAutoRoute({
      request: request([question('q1'), question('q2')]),
      scope: scope({ paths: ['docs'], tags: ['product'] }),
      profiles: [wrongTag, eligibleB, foreign, disabled, legacyClass, archived, eligibleA, wrongPath],
    })
    assert.deepEqual(plan.eligible.map(item => item.agentId), ['agent-a', 'agent-b', 'agent-class', 'agent-foreign'])
    assert.deepEqual(plan.candidates, [
      { agentId: 'agent-a', enabled: true },
      { agentId: 'agent-b', enabled: true },
      { agentId: 'agent-class', enabled: true },
      { agentId: 'agent-disabled', enabled: false, rejectedBecause: 'disabled' },
      { agentId: 'agent-foreign', enabled: true },
      { agentId: 'agent-path', enabled: true, rejectedBecause: 'scope' },
      { agentId: 'agent-tag', enabled: true, rejectedBecause: 'scope' },
    ])
    assert.equal(plan.candidates.some(item => item.agentId === 'agent-archived'), false)
  })

  it('handles zero, one, multiple, and more than 32 eligible candidates without guessing', async () => {
    const req = request([question('q1')])
    const noModel = unusedLlm()
    assert.deepEqual(await routeAuto({ request: req, scope: scope(), profiles: [], ...input(noModel) }), {
      kind: 'none', candidates: [], reason: 'none:no_candidates',
    })
    assert.deepEqual(await routeAuto({ request: req, scope: scope(), profiles: [profile('only')], ...input(noModel) }), {
      kind: 'selected', candidates: [{ agentId: 'only', enabled: true }], chosen: 'only', reason: 'deterministic:single_candidate',
    })
    assert.equal(noModel.calls.length, 0)

    const llm = fakeLlm(validRoute())
    const selected = await routeAuto({
      request: req, scope: scope(),
      profiles: [profile('agent-a'), profile('agent-b'), profile('foreign')],
      ...input(llm),
    })
    assert.equal(selected.kind, 'selected')
    assert.equal(selected.chosen, 'agent-b')
    assert.equal(llm.calls.length, 1)
    assert.deepEqual(userPayload(llm.calls[0]).candidates.map(item => item.agentId), ['agent-a', 'agent-b', 'foreign'])
    assert.equal(JSON.stringify(llm.calls[0]).includes('FORBIDDEN_GENERATED'), false)
    assert.equal(JSON.stringify(llm.calls[0]).includes('candidate-provider'), false)

    const tooMany = Array.from({ length: 33 }, (_, index) => profile(`agent-${String(index).padStart(2, '0')}`))
    const limited = await routeAuto({ request: req, scope: scope(), profiles: tooMany, ...input(noModel) })
    assert.equal(limited.kind, 'failed')
    assert.equal(limited.reason, 'failure:candidate_limit')
    assert.equal(limited.candidates.length, 33)
    assert.equal(noModel.calls.length, 0)
  })

  it('never appends an authorization class to the caller request or the Router wire', async () => {
    const req = request([question('q1'), question('q2')])
    const snapshot = structuredClone(req)
    const llm = fakeLlm(validRoute())
    await routeAuto({ request: req, scope: scope(), profiles: [profile('agent-a'), profile('agent-b')], ...input(llm) })
    assert.deepEqual(req, snapshot)
    const payload = userPayload(llm.calls[0])
    for (const item of payload.questions) {
      assert.equal(Object.hasOwn(item, 'authorizationClass'), false)
      assert.equal(Object.hasOwn(item, 'authorizationClassSource'), false)
    }
    assert.equal(JSON.stringify(llm.calls[0]).includes('authorizationClass'), false)
  })
})

describe('Auto Router verdict tolerance and strict required fields', () => {
  async function routeOutput(output, options = {}) {
    const llm = fakeLlm(output, options)
    const result = await routeAuto({
      request: request([question('q')]), scope: scope(),
      profiles: [profile('agent-a'), profile('agent-b')], ...input(llm, options),
    })
    return { result, llm }
  }

  it('accepts a fenced verdict, surrounding prose, and unknown extra fields', async () => {
    const json = JSON.stringify(validRoute())
    for (const output of [
      json,
      `  \n${json}\n  `,
      `The verdict is below.\n${json}`,
      `${json}\nThat is the whole verdict.`,
      `\`\`\`json\n${json}\n\`\`\``,
      JSON.stringify({ ...validRoute(), confidence: 0.8, scope: { workspaces: ['*'] }, answer: 'A', extra: true }),
    ]) {
      const { result } = await routeOutput(output)
      assert.equal(result.kind, 'selected', JSON.stringify(output))
      assert.equal(result.chosen, 'agent-b', JSON.stringify(output))
    }
  })

  it('keeps the required verdict shape strict and reports a closed invalidCode', async () => {
    const ambiguous = {
      contract: 'router-contract/1', outcome: 'ambiguous', reason: 'Overlapping preferences',
      ambiguity: { candidates: ['agent-a', 'agent-b'], conflict: 'Both claim this judgment' },
    }
    const cases = [
      [{ ...validRoute(), agentId: 'agent-unknown' }, 'unknown_agent'],
      [{ ...validRoute(), reason: '' }, 'reason_invalid'],
      [{ ...validRoute(), reason: 'x'.repeat(201) }, 'reason_invalid'],
      [{ ...validRoute(), contract: 'router-contract/2' }, 'missing_field'],
      [{ contract: 'router-contract/1', outcome: 'maybe', reason: 'No such outcome' }, 'missing_field'],
      [{ contract: 'router-contract/1', outcome: 'selected', reason: 'No agent id' }, 'missing_field'],
      [{ ...ambiguous, ambiguity: { candidates: [], conflict: 'Empty set' } }, 'ambiguous_shape'],
      [{ ...ambiguous, ambiguity: { candidates: ['agent-a', 'agent-a'], conflict: 'Duplicate is not a subset' } }, 'ambiguous_shape'],
      [{ ...ambiguous, ambiguity: { candidates: ['agent-unknown'], conflict: 'Unknown id' } }, 'ambiguous_shape'],
      [{ ...ambiguous, ambiguity: { candidates: ['agent-a'], conflict: '' } }, 'ambiguous_shape'],
      [{ ...ambiguous, ambiguity: 'not-an-object' }, 'ambiguous_shape'],
      ['not-json', 'not_json'],
      ['[]', 'not_json'],
    ]
    // Both a fresh verdict and its single repair retry fail: the failure keeps
    // the sub-reason and stays fail-closed.
    for (const [output, invalidCode] of cases) {
      const llm = fakeSequenceLlm([{ text: JSON.stringify(output) }, { text: JSON.stringify(output) }])
      const result = await routeAuto({
        request: request([question('q')]), scope: scope(),
        profiles: [profile('agent-a'), profile('agent-b')], ...input(llm),
      })
      assert.equal(result.kind, 'failed', JSON.stringify(output))
      assert.equal(result.reason, 'failure:invalid_output', JSON.stringify(output))
      assert.equal(result.invalidCode, invalidCode, JSON.stringify(output))
      assert.equal(llm.calls.length, 2, JSON.stringify(output))
    }
  })

  it('repairs an unusable verdict exactly once with the verdict-JSON-only instruction', async () => {
    const llm = fakeSequenceLlm([
      { text: 'I would pick agent-b because it owns this.' },
      { text: JSON.stringify(validRoute()) },
    ])
    const result = await routeAuto({
      request: request([question('q')]), scope: scope(),
      profiles: [profile('agent-a'), profile('agent-b')], ...input(llm),
    })
    assert.equal(result.kind, 'selected')
    assert.equal(result.chosen, 'agent-b')
    assert.equal(llm.calls.length, 2)
    // The repair keeps the same budget and appends one explicit instruction.
    assert.deepEqual(llm.calls.map(call => call.maxTokens), [4096, 4096])
    const repair = llm.calls[1].messages.at(-1)
    assert.equal(repair.role, 'user')
    assert.match(typeof repair.content === 'string' ? repair.content : repair.content[0].text, /^Return only the verdict JSON object\./)
  })

  it('returns strict none and ambiguity outcomes with the existing candidate projection', async () => {
    const none = await routeOutput({ contract: 'router-contract/1', outcome: 'none', reason: 'No suitable preference' })
    assert.deepEqual(none.result, {
      kind: 'none', candidates: [{ agentId: 'agent-a', enabled: true }, { agentId: 'agent-b', enabled: true }], reason: 'No suitable preference',
    })
    const ambiguous = await routeOutput({
      contract: 'router-contract/1', outcome: 'ambiguous', reason: 'Material overlap',
      ambiguity: { candidates: ['agent-b'], conflict: 'The same preference has two owners' },
    })
    assert.deepEqual(ambiguous.result, {
      kind: 'ambiguous', candidates: [{ agentId: 'agent-a', enabled: true }, { agentId: 'agent-b', enabled: true }],
      reason: 'Material overlap', ambiguity: { candidates: ['agent-b'], conflict: 'The same preference has two owners' },
    })
  })

  it('fails closed before invocation when the pack exceeds its context budget', async () => {
    const routing = await routeOutput(validRoute(), { contextBudgetTokens: 1 })
    assert.equal(routing.result.kind, 'failed')
    assert.equal(routing.result.reason, 'failure:context_budget')
    assert.equal(routing.llm.calls.length, 0)
  })

  it('bounds Unicode text without dropping fixed ids or candidates', async () => {
    const long = '界'.repeat(5000)
    const llm = fakeLlm({ contract: 'router-contract/1', outcome: 'none', reason: 'No match' })
    const req = request([{ ...question('fixed-id', long), header: long, detail: long }], { context: long })
    const profiles = [
      profile('agent-a', { name: long, userDescription: { revision: 2, text: long } }),
      profile('agent-b', { name: long, userDescription: { revision: 3, text: long } }),
    ]
    const result = await routeAuto({ request: req, scope: scope(), profiles, ...input(llm, { contextBudgetTokens: 8000 }) })
    assert.equal(result.kind, 'none')
    const call = llm.calls[0]
    const raw = call.messages[0].content[0].text
    const payload = userPayload(call)
    assert.equal(payload.questions[0].id, 'fixed-id')
    assert.equal(payload.questions[0].question.length, 4000)
    assert.equal(payload.questions[0].header.length, 4000)
    assert.equal(payload.questions[0].detail.length, 4000)
    assert.equal(payload.context.length, 4000)
    assert.equal(payload.candidates.length, 2)
    for (const candidate of payload.candidates) {
      assert.equal(candidate.name.length, 200)
      assert.equal(candidate.userDescription.length, 2000)
    }
    assert.equal(call.system.length + raw.length <= 8000 * 4, true)
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(raw), false)
  })

  it('keeps generated memory, evidence hints, history, full sessions, and foreign profiles out of packs', async () => {
    const req = request([question('q')], {
      evidence: [{ path: 'secret', excerpt_hint: 'FORBIDDEN_EVIDENCE_HINT' }],
      history: 'FORBIDDEN_HISTORY', sessionLog: 'FORBIDDEN_FULL_SESSION',
    })
    const llm = fakeLlm({ contract: 'router-contract/1', outcome: 'none', reason: 'No match' })
    await routeAuto({
      request: req, scope: scope(),
      profiles: [
        profile('agent-a', { memorySnapshot: 'FORBIDDEN_SNAPSHOT', L2: 'FORBIDDEN_L2', L3: 'FORBIDDEN_L3' }),
        profile('agent-b'), profile('agent-foreign'),
      ],
      ...input(llm),
    })
    const wire = JSON.stringify(llm.calls[0])
    // No workspace identity, memory, evidence hints, history or generated text
    // ever reaches the Router wire — a shared identity adds no such field.
    for (const forbidden of ['FORBIDDEN_', 'generatedDescription', 'L2', 'L3', 'Snapshot', 'history', 'sessionLog', 'workspace']) {
      assert.equal(wire.includes(forbidden), false, `${forbidden} leaked into router pack`)
    }
  })

  it('never reads generated descriptions, candidate model routes, domain memory, or history', async () => {
    const req = request([question('q')])
    for (const key of ['evidence', 'history', 'sessionLog']) {
      Object.defineProperty(req, key, { get() { throw new Error(`forbidden request read: ${key}`) } })
    }
    const guarded = (id) => {
      const value = profile(id)
      for (const key of ['generatedDescription', 'modelRoute', 'memorySnapshot', 'L2', 'L3']) {
        Object.defineProperty(value, key, { get() { throw new Error(`forbidden profile read: ${key}`) } })
      }
      return value
    }
    const llm = fakeLlm(validRoute())
    const result = await routeAuto({
      request: req, scope: scope(),
      profiles: [guarded('agent-a'), guarded('agent-b')], ...input(llm),
    })
    assert.equal(result.kind, 'selected')
    assert.equal(result.chosen, 'agent-b')
  })
})

describe('Auto Router sidecar routing and failure mapping', () => {
  function routeCall(llm, extra = {}) {
    return routeAuto({
      request: request([question('q')]), scope: scope(),
      profiles: [profile('agent-a'), profile('agent-b')], ...input(llm, extra),
    })
  }

  function hangingLlm() {
    const calls = []
    return {
      calls,
      stream(options) {
        calls.push(options)
        return (async function * () { await new Promise(() => {}) })()
      },
    }
  }

  function throwingLlm() {
    const calls = []
    return {
      calls,
      stream(options) { calls.push(options); throw Object.assign(new Error('upstream failed'), { code: 'UPSTREAM_429' }) },
    }
  }

  function assertFailure(result, reason) {
    assert.equal(result.kind, 'failed')
    assert.equal(result.reason, reason)
  }

  it('inherits only the stock session route and omits tools, purpose, and temperature', async () => {
    const llm = fakeLlm({ contract: 'router-contract/1', outcome: 'none', reason: 'No match' })
    assert.equal((await routeCall(llm)).kind, 'none')
    const call = llm.calls[0]
    assert.equal(call.provider, SESSION_ROUTE.provider)
    assert.equal(call.model, SESSION_ROUTE.model)
    assert.equal(call.reasoningEffort, SESSION_ROUTE.reasoningEffort)
    // A 1600-token Attempt budget never bounds the router's own JSON.
    assert.equal(call.maxTokens, 4096)
    for (const key of ['tools', 'purpose', 'temperature', 'sessionId']) assert.equal(key in call, false)
  })

  it('maps timeout and model errors without leaking provider detail', async () => {
    const timedLlm = hangingLlm()
    assertFailure(await routeCall(timedLlm, { timeoutMs: 5 }), 'failure:timeout')
    const failedLlm = throwingLlm()
    assertFailure(await routeCall(failedLlm), 'failure:model_error')
    assert.equal(JSON.stringify(failedLlm.calls).includes('UPSTREAM_429'), false)
  })

  it('maps route unavailability before model invocation', async () => {
    const llm = unusedLlm()
    assertFailure(await routeCall(llm, { sessionRoute: undefined }), 'failure:route_unavailable')
    assert.equal(llm.calls.length, 0)
  })

  it('maps an in-flight external abort instead of waiting for the hard timeout', async () => {
    const llm = hangingLlm()
    const controller = new AbortController()
    const pending = routeCall(llm, { timeoutMs: 30, signal: controller.signal })
    setTimeout(() => controller.abort(new Error('caller cancelled')), 2)
    assertFailure(await pending, 'failure:aborted')
    assert.equal(llm.calls.length, 1)
  })

  it('keeps its own sidecar budget floor without widening a larger configured budget', async () => {
    for (const configured of [1600, 1024, 0, -1]) {
      const llm = fakeLlm({ contract: 'router-contract/1', outcome: 'none', reason: 'No match' })
      assert.equal((await routeCall(llm, { maxOutputTokens: configured })).kind, 'none', String(configured))
      assert.equal(llm.calls[0].maxTokens, 4096, String(configured))
    }
    for (const configured of [8192, 4096]) {
      const llm = fakeLlm({ contract: 'router-contract/1', outcome: 'none', reason: 'No match' })
      assert.equal((await routeCall(llm, { maxOutputTokens: configured })).kind, 'none', String(configured))
      assert.equal(llm.calls[0].maxTokens, configured, String(configured))
    }
  })

  it('retries a truncated verdict once with a doubled budget and recovers on the retry', async () => {
    const routing = fakeSequenceLlm([
      { text: '{"contract":"router-contract/1"', finishReason: 'max-tokens' },
      { text: JSON.stringify(validRoute()) },
    ])
    const routed = await routeCall(routing)
    assert.equal(routed.kind, 'selected')
    assert.equal(routed.chosen, 'agent-b')
    assert.equal(routing.calls.length, 2)
    assert.deepEqual(routing.calls.map(call => call.maxTokens), [4096, 8192])
  })

  it('fails closed after a second truncation and reports the bounded output tokens', async () => {
    const llm = fakeSequenceLlm([
      { text: '{"contract":"router-', finishReason: 'max-tokens', outputTokens: 4096 },
      { text: '{"contract":"router-', finishReason: 'max-tokens', outputTokens: 8192 },
    ])
    const result = await routeCall(llm)
    assertFailure(result, 'failure:truncated')
    assert.equal(result.invalidCode, 'truncated')
    assert.equal(llm.calls.length, 2)
    assert.equal(result.outputTokens, 8192)
    // The doubled retry is capped instead of growing without bound, and never
    // shrinks below the already configured budget.
    const capped = fakeSequenceLlm([
      { text: '{"contract":"router-', finishReason: 'truncated' },
      { text: '{"contract":"router-', finishReason: 'truncated' },
    ])
    assertFailure(await routeCall(capped, { maxOutputTokens: 20000 }), 'failure:truncated')
    assert.deepEqual(capped.calls.map(call => call.maxTokens), [20000, 20000])
  })

  it('never retries timeout, model error, route unavailability, an aborted signal, or a single-shot sample', async () => {
    const timed = hangingLlm()
    assertFailure(await routeCall(timed, { timeoutMs: 5 }), 'failure:timeout')
    assert.equal(timed.calls.length, 1)
    const failed = throwingLlm()
    assertFailure(await routeCall(failed), 'failure:model_error')
    assert.equal(failed.calls.length, 1)
    const unavailable = unusedLlm()
    assertFailure(await routeCall(unavailable, { sessionRoute: undefined }), 'failure:route_unavailable')
    assert.equal(unavailable.calls.length, 0)
    const aborted = new AbortController()
    aborted.abort(new Error('caller cancelled'))
    const truncated = fakeSequenceLlm([{ text: '{"contract":"router-', finishReason: 'max-tokens' }])
    assertFailure(await routeCall(truncated, { signal: aborted.signal }), 'failure:aborted')
    assert.equal(truncated.calls.length, 0)
    // A truncation and an unusable verdict both stay single-call when the sample
    // is diagnostic only (Shadow observation).
    const single = fakeSequenceLlm([{ text: '{"contract":"router-', finishReason: 'max-tokens' }])
    assertFailure(await routeCall(single, { singleShot: true }), 'failure:truncated')
    assert.equal(single.calls.length, 1)
    const singleInvalid = fakeSequenceLlm([{ text: 'not-json' }])
    const invalid = await routeCall(singleInvalid, { singleShot: true })
    assertFailure(invalid, 'failure:invalid_output')
    assert.equal(invalid.invalidCode, 'not_json')
    assert.equal(singleInvalid.calls.length, 1)
  })
})
