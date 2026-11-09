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

function fakeLlm(value) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function * () {
        yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) }
        yield { type: 'finish', reason: { kind: 'stop' } }
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
