import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoAdmission, classifyAutoRequest, planAutoRoute, routeAuto,
} from '../../src/decision/router.js'

const WORKSPACE = '/workspace-one'
const SESSION_ROUTE = { provider: 'session-provider', model: 'session-model', reasoningEffort: 'low' }

function question(id, authorizationClass, text = `Question ${id}`) {
  return {
    id, header: `Header ${id}`, question: text, detail: `Detail ${id}`,
    options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
    ...(authorizationClass === undefined ? {} : { authorizationClass }),
  }
}

function request(questions, extra = {}) {
  return { entry: 'consult', questions, context: 'Current task summary', ...extra }
}

function scope(extra = {}) {
  return { workspaces: [WORKSPACE], authorizationClasses: ['A', 'B', 'C'], ...extra }
}

function profile(agentId, extra = {}) {
  return {
    agentId, workspaceKey: WORKSPACE, name: `Agent ${agentId}`, state: 'enabled',
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

describe('Auto deterministic admission and candidate planning', () => {
  it('requires a complete, known, allowed A/B/C class for every question', () => {
    assert.deepEqual(autoAdmission(request([question('q1', 'A'), question('q2', 'C'), question('q3', 'A')]), ['A', 'C']), {
      ok: true, classes: ['A', 'C'],
    })
    assert.deepEqual(autoAdmission(request([question('q1', 'A'), question('q2')]), ['A']), {
      ok: false, reason: 'missing_class',
    })
    for (const authorizationClass of ['D', 'E', 'F', 'unknown', 'a', '', null, 1]) {
      assert.deepEqual(autoAdmission(request([question('q1', authorizationClass)]), ['A', 'B', 'C']), {
        ok: false, reason: 'unknown_class',
      })
    }
    assert.deepEqual(autoAdmission(request([question('q1', 'C')]), ['A', 'B']), {
      ok: false, reason: 'not_allowed',
    })
    assert.deepEqual(autoAdmission(request([question('q1', 'A'), question('q2'), question('q3', 'D')]), ['A']), {
      ok: false, reason: 'unknown_class',
    })
    assert.deepEqual(autoAdmission(request([question('q1', 'C'), question('q2')]), ['A']), {
      ok: false, reason: 'not_allowed',
    })
  })

  it('classifies only missing ids once and marks derived classes without mutating the caller request', async () => {
    const original = request([
      question('provided', 'B'), question('missing-a'), question('missing-c'),
    ])
    const snapshot = structuredClone(original)
    const llm = fakeLlm({
      contract: 'router-classification-contract/1',
      classes: [
        { id: 'missing-a', authorizationClass: 'A' },
        { id: 'missing-c', authorizationClass: 'C' },
      ],
    })
    const result = await classifyAutoRequest({ request: original, ...input(llm) })
    assert.equal(result.kind, 'classified')
    assert.equal(llm.calls.length, 1)
    assert.deepEqual(original, snapshot)
    assert.equal(result.request.questions[0].authorizationClass, 'B')
    assert.equal(result.request.questions[0].authorizationClassSource, undefined)
    assert.deepEqual(result.request.questions.slice(1).map(item => [item.id, item.authorizationClass, item.authorizationClassSource]), [
      ['missing-a', 'A', 'auto_classifier'], ['missing-c', 'C', 'auto_classifier'],
    ])
    assert.ok(llm.calls[0].system.includes('router-classification-contract/1'))
    assert.deepEqual(userPayload(llm.calls[0]).questions.map(item => item.id), ['missing-a', 'missing-c'])
  })

  it('keeps enabled/workspace/scope/paths/tags/class filtering deterministic', () => {
    const eligibleA = profile('agent-a')
    const eligibleB = profile('agent-b', { userDescription: { revision: 4, text: 'Current revision four' } })
    const disabled = profile('agent-disabled', { state: 'disabled' })
    const archived = profile('agent-archived', { state: 'archived' })
    const foreign = profile('agent-foreign', { workspaceKey: '/workspace-two' })
    const wrongPath = profile('agent-path', { scope: scope({ paths: ['src'] }) })
    const wrongTag = profile('agent-tag', { scope: scope({ tags: ['backend'] }) })
    const wrongClass = profile('agent-class', { scope: scope({ authorizationClasses: ['A'] }) })
    const plan = planAutoRoute({
      request: request([question('q1', 'A'), question('q2', 'B')]),
      scope: scope({ paths: ['docs'], tags: ['product'] }), workspaceKey: WORKSPACE,
      profiles: [wrongTag, eligibleB, foreign, disabled, wrongClass, archived, eligibleA, wrongPath],
    })
    assert.deepEqual(plan.eligible.map(item => item.agentId), ['agent-a', 'agent-b'])
    assert.deepEqual(plan.candidates, [
      { agentId: 'agent-a', enabled: true },
      { agentId: 'agent-b', enabled: true },
      { agentId: 'agent-class', enabled: true, rejectedBecause: 'authorization' },
      { agentId: 'agent-disabled', enabled: false, rejectedBecause: 'disabled' },
      { agentId: 'agent-path', enabled: true, rejectedBecause: 'scope' },
      { agentId: 'agent-tag', enabled: true, rejectedBecause: 'scope' },
    ])
    assert.equal(plan.candidates.some(item => item.agentId === 'agent-foreign' || item.agentId === 'agent-archived'), false)
  })

  it('handles zero, one, multiple, and more than 32 eligible candidates without guessing', async () => {
    const req = request([question('q1', 'A')])
    const noModel = unusedLlm()
    assert.deepEqual(await routeAuto({ request: req, scope: scope(), workspaceKey: WORKSPACE, profiles: [], ...input(noModel) }), {
      kind: 'none', candidates: [], reason: 'none:no_candidates',
    })
    assert.deepEqual(await routeAuto({ request: req, scope: scope(), workspaceKey: WORKSPACE, profiles: [profile('only')], ...input(noModel) }), {
      kind: 'selected', candidates: [{ agentId: 'only', enabled: true }], chosen: 'only', reason: 'deterministic:single_candidate',
    })
    assert.equal(noModel.calls.length, 0)

    const llm = fakeLlm({ contract: 'router-contract/1', outcome: 'selected', agentId: 'agent-b', reason: 'Matches the current preference' })
    const selected = await routeAuto({
      request: req, scope: scope(), workspaceKey: WORKSPACE,
      profiles: [profile('agent-a'), profile('agent-b'), profile('foreign', { workspaceKey: '/workspace-two' })],
      ...input(llm),
    })
    assert.equal(selected.kind, 'selected')
    assert.equal(selected.chosen, 'agent-b')
    assert.equal(llm.calls.length, 1)
    assert.deepEqual(userPayload(llm.calls[0]).candidates.map(item => item.agentId), ['agent-a', 'agent-b'])
    assert.equal(JSON.stringify(llm.calls[0]).includes('FORBIDDEN_GENERATED'), false)
    assert.equal(JSON.stringify(llm.calls[0]).includes('candidate-provider'), false)

    const tooMany = Array.from({ length: 33 }, (_, index) => profile(`agent-${String(index).padStart(2, '0')}`))
    const limited = await routeAuto({ request: req, scope: scope(), workspaceKey: WORKSPACE, profiles: tooMany, ...input(noModel) })
    assert.equal(limited.kind, 'failed')
    assert.equal(limited.reason, 'failure:candidate_limit')
    assert.equal(limited.candidates.length, 33)
    assert.equal(noModel.calls.length, 0)
  })
})

describe('Auto bounded packs and closed sidecar contracts', () => {
  const classificationQuestions = () => [question('provided', 'B'), question('missing-a'), question('missing-c')]
  const validClassification = () => ({
    contract: 'router-classification-contract/1',
    classes: [{ id: 'missing-a', authorizationClass: 'A' }, { id: 'missing-c', authorizationClass: 'C' }],
  })
  const validRoute = () => ({ contract: 'router-contract/1', outcome: 'selected', agentId: 'agent-b', reason: 'Relevant preference' })

  async function classifyOutput(output, options = {}) {
    const llm = fakeLlm(output, options)
    const result = await classifyAutoRequest({ request: request(classificationQuestions()), ...input(llm, options) })
    return { result, llm }
  }

  async function routeOutput(output, options = {}) {
    const llm = fakeLlm(output, options)
    const result = await routeAuto({
      request: request([question('q', 'A')]), scope: scope(), workspaceKey: WORKSPACE,
      profiles: [profile('agent-a'), profile('agent-b')], ...input(llm, options),
    })
    return { result, llm }
  }

  it('rejects duplicate, omitted, provided, unknown, and extra-field classification output', async () => {
    const valid = validClassification()
    const cases = [
      { ...valid, classes: [valid.classes[0], valid.classes[0]] },
      { ...valid, classes: [valid.classes[0]] },
      { ...valid, classes: [...valid.classes, { id: 'provided', authorizationClass: 'A' }] },
      { ...valid, classes: [{ id: 'unknown-id', authorizationClass: 'A' }, valid.classes[1]] },
      { ...valid, confidence: 0.9 },
      { ...valid, answer: 'A' },
      { ...valid, scope: {} },
      { ...valid, classes: [{ ...valid.classes[0], confidence: 0.9 }, valid.classes[1]] },
      { ...valid, classes: [{ id: 'missing-a', authorizationClass: 'G' }, valid.classes[1]] },
      { ...valid, contract: 'router-classification-contract/2' },
      'not-json',
    ]
    for (const output of cases) {
      const { result } = await classifyOutput(output)
      assert.equal(result.kind, 'failed', JSON.stringify(output))
      assert.equal(result.reason, 'failure:invalid_output', JSON.stringify(output))
    }
  })

  it('rejects prefix and suffix answer prose or fences around classification JSON', async () => {
    const json = JSON.stringify(validClassification())
    for (const output of [
      `The answer is A.\n${json}`,
      `${json}\nThe answer is A.`,
      `\`\`\`json\n${json}\n\`\`\``,
      `${json}\n${json}`,
    ]) {
      const { result } = await classifyOutput(output)
      assert.equal(result.kind, 'failed', JSON.stringify(output))
      assert.equal(result.reason, 'failure:invalid_output', JSON.stringify(output))
    }
  })

  it('accepts the complete classification vocabulary but fails closed to authority outside A/B/C', async () => {
    for (const authorizationClass of ['D', 'E', 'F', 'unknown']) {
      const output = validClassification()
      output.classes[0].authorizationClass = authorizationClass
      const { result } = await classifyOutput(output)
      assert.equal(result.kind, 'authority')
      assert.equal(result.reason, 'unknown_class')
      assert.equal(result.request.questions[1].authorizationClassSource, 'auto_classifier')
    }
  })

  it('distinguishes truncated classification JSON and max-token finishes', async () => {
    for (const [output, options] of [
      ['{"contract":"router-classification-contract/1","classes":[', {}],
      [validClassification(), { finishReason: 'max-tokens' }],
    ]) {
      const { result } = await classifyOutput(output, options)
      assert.deepEqual(result, { kind: 'failed', reason: 'failure:truncated' })
    }
  })

  it('rejects unknown agents, extra answer/scope/confidence fields, and invalid ambiguity', async () => {
    const valid = validRoute()
    const ambiguous = {
      contract: 'router-contract/1', outcome: 'ambiguous', reason: 'Overlapping preferences',
      ambiguity: { candidates: ['agent-a', 'agent-b'], conflict: 'Both claim this judgment' },
    }
    const cases = [
      { ...valid, agentId: 'agent-unknown' },
      { ...valid, confidence: 0.8 },
      { ...valid, answer: 'A' },
      { ...valid, scope: { workspaces: ['*'] } },
      { ...valid, extra: true },
      { ...valid, reason: '' },
      { ...valid, reason: 'x'.repeat(201) },
      { ...ambiguous, ambiguity: { candidates: [], conflict: 'Empty set' } },
      { ...ambiguous, ambiguity: { candidates: ['agent-a', 'agent-a'], conflict: 'Duplicate is not a subset' } },
      { ...ambiguous, ambiguity: { candidates: ['agent-unknown'], conflict: 'Unknown id' } },
      { ...ambiguous, ambiguity: { candidates: ['agent-a'], conflict: '' } },
      { ...ambiguous, ambiguity: { candidates: ['agent-a'], conflict: 'x'.repeat(201) } },
      { ...ambiguous, ambiguity: { candidates: ['agent-a'], conflict: 'Conflict', extra: true } },
      { contract: 'router-contract/1', outcome: 'none', reason: 'No match', agentId: 'agent-a' },
      { ...valid, contract: 'router-contract/2' },
      'not-json',
    ]
    for (const output of cases) {
      const { result } = await routeOutput(output)
      assert.equal(result.kind, 'failed', JSON.stringify(output))
      assert.equal(result.reason, 'failure:invalid_output', JSON.stringify(output))
    }
  })

  it('rejects prefix and suffix answer prose or fences around router JSON', async () => {
    const json = JSON.stringify(validRoute())
    for (const output of [
      `The answer is to use agent-b.\n${json}`,
      `${json}\nThe answer is to use agent-b.`,
      `\`\`\`json\n${json}\n\`\`\``,
      `${json}\n${json}`,
    ]) {
      const { result } = await routeOutput(output)
      assert.equal(result.kind, 'failed', JSON.stringify(output))
      assert.equal(result.reason, 'failure:invalid_output', JSON.stringify(output))
    }
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

  it('distinguishes truncated router JSON and max-token finishes', async () => {
    for (const [output, options] of [
      ['{"contract":"router-contract/1"', {}],
      [validRoute(), { finishReason: 'max-tokens' }],
    ]) {
      const { result } = await routeOutput(output, options)
      assert.equal(result.kind, 'failed')
      assert.equal(result.reason, 'failure:truncated')
    }
  })

  it('fails closed before invocation when either sidecar exceeds its context budget', async () => {
    const classification = await classifyOutput(validClassification(), { contextBudgetTokens: 1 })
    assert.deepEqual(classification.result, { kind: 'failed', reason: 'failure:context_budget' })
    assert.equal(classification.llm.calls.length, 0)
    const routing = await routeOutput(validRoute(), { contextBudgetTokens: 1 })
    assert.equal(routing.result.kind, 'failed')
    assert.equal(routing.result.reason, 'failure:context_budget')
    assert.equal(routing.llm.calls.length, 0)
  })

  it('bounds Unicode text without dropping fixed ids, authorization metadata, or candidates', async () => {
    const long = '界'.repeat(5000)
    const llm = fakeLlm({ contract: 'router-contract/1', outcome: 'none', reason: 'No match' })
    const req = request([{ ...question('fixed-id', 'A', long), header: long, detail: long }], { context: long })
    const profiles = [
      profile('agent-a', { name: long, userDescription: { revision: 2, text: long } }),
      profile('agent-b', { name: long, userDescription: { revision: 3, text: long } }),
    ]
    const result = await routeAuto({ request: req, scope: scope(), workspaceKey: WORKSPACE, profiles, ...input(llm, { contextBudgetTokens: 8000 }) })
    assert.equal(result.kind, 'none')
    const call = llm.calls[0]
    const raw = call.messages[0].content[0].text
    const payload = userPayload(call)
    assert.equal(payload.questions[0].id, 'fixed-id')
    assert.equal(payload.questions[0].authorizationClass, 'A')
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
    const req = request([{ ...question('q', 'A'), candidateProfile: 'FORBIDDEN_CANDIDATE_CLASS' }], {
      evidence: [{ path: 'secret', excerpt_hint: 'FORBIDDEN_EVIDENCE_HINT' }],
      history: 'FORBIDDEN_HISTORY', sessionLog: 'FORBIDDEN_FULL_SESSION',
    })
    const llm = fakeLlm({ contract: 'router-contract/1', outcome: 'none', reason: 'No match' })
    await routeAuto({
      request: req, scope: scope(), workspaceKey: WORKSPACE,
      profiles: [
        profile('agent-a', { memorySnapshot: 'FORBIDDEN_SNAPSHOT', L2: 'FORBIDDEN_L2', L3: 'FORBIDDEN_L3' }),
        profile('agent-b'), profile('foreign', { workspaceKey: '/workspace-two', name: 'FORBIDDEN_FOREIGN_NAME' }),
      ],
      ...input(llm),
    })
    const wire = JSON.stringify(llm.calls[0])
    for (const forbidden of ['FORBIDDEN_', 'generatedDescription', 'L2', 'L3', 'Snapshot', 'history', 'sessionLog', 'foreign']) {
      assert.equal(wire.includes(forbidden), false, `${forbidden} leaked into router pack`)
    }
    const classification = await classifyOutput(validClassification())
    const classificationWire = JSON.stringify(classification.llm.calls[0])
    assert.equal(classificationWire.includes('candidates'), false)
    assert.equal(classificationWire.includes('FORBIDDEN_'), false)
  })
})

describe('Auto shared sidecar routing and failure mapping', () => {
  function classificationCall(llm, extra = {}) {
    return classifyAutoRequest({ request: request([question('missing')]), ...input(llm, extra) })
  }

  function routeCall(llm, extra = {}) {
    return routeAuto({
      request: request([question('q', 'A')]), scope: scope(), workspaceKey: WORKSPACE,
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
    const classificationLlm = fakeLlm({
      contract: 'router-classification-contract/1', classes: [{ id: 'missing', authorizationClass: 'A' }],
    })
    assert.equal((await classificationCall(classificationLlm)).kind, 'classified')
    const routeLlm = fakeLlm({ contract: 'router-contract/1', outcome: 'none', reason: 'No match' })
    assert.equal((await routeCall(routeLlm)).kind, 'none')
    for (const call of [...classificationLlm.calls, ...routeLlm.calls]) {
      assert.equal(call.provider, SESSION_ROUTE.provider)
      assert.equal(call.model, SESSION_ROUTE.model)
      assert.equal(call.reasoningEffort, SESSION_ROUTE.reasoningEffort)
      assert.equal(call.maxTokens, 1600)
      for (const key of ['tools', 'purpose', 'temperature', 'sessionId']) assert.equal(key in call, false)
    }
  })

  it('skips classification when the whitelist is empty or no classes are missing', async () => {
    const llm = unusedLlm()
    const classless = request([question('missing')])
    const admission = autoAdmission(classless, [])
    assert.deepEqual(admission, { ok: false, reason: 'missing_class' })
    if (admission.ok) await classifyAutoRequest({ request: classless, ...input(llm) })
    const provided = request([question('provided', 'A')])
    const classified = await classifyAutoRequest({ request: provided, ...input(llm) })
    assert.equal(classified.kind, 'classified')
    assert.deepEqual(classified.request, provided)
    assert.equal(llm.calls.length, 0)
  })

  it('maps timeout and model errors for both sidecars without leaking provider detail', async () => {
    for (const run of [classificationCall, routeCall]) {
      const timedLlm = hangingLlm()
      assertFailure(await run(timedLlm, { timeoutMs: 5 }), 'failure:timeout')
      const failedLlm = throwingLlm()
      assertFailure(await run(failedLlm), 'failure:model_error')
      assert.equal(JSON.stringify(failedLlm.calls).includes('UPSTREAM_429'), false)
    }
  })

  it('maps route unavailability before model invocation for both sidecars', async () => {
    for (const run of [classificationCall, routeCall]) {
      const llm = unusedLlm()
      assertFailure(await run(llm, { sessionRoute: undefined }), 'failure:route_unavailable')
      assert.equal(llm.calls.length, 0)
    }
  })

  it('maps an in-flight external abort instead of waiting for the hard timeout', async () => {
    for (const run of [classificationCall, routeCall]) {
      const llm = hangingLlm()
      const controller = new AbortController()
      const pending = run(llm, { timeoutMs: 30, signal: controller.signal })
      setTimeout(() => controller.abort(new Error('caller cancelled')), 2)
      assertFailure(await pending, 'failure:aborted')
      assert.equal(llm.calls.length, 1)
    }
  })

  it('never reads generated descriptions, candidate model routes, domain memory, or history', async () => {
    const req = request([question('q', 'A')])
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
    const llm = fakeLlm({ contract: 'router-contract/1', outcome: 'selected', agentId: 'agent-b', reason: 'Current user preference' })
    const result = await routeAuto({
      request: req, scope: scope(), workspaceKey: WORKSPACE,
      profiles: [guarded('agent-a'), guarded('agent-b')], ...input(llm),
    })
    assert.equal(result.kind, 'selected')
    assert.equal(result.chosen, 'agent-b')
  })
})
