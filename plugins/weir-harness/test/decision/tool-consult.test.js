import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DECISION_CONSULT_PARAMETERS, registerDecisionConsultTool } from '../../src/decision/tool.js'

function setup(result) {
  const registrations = []
  const calls = []
  const broker = {
    status: () => ({ available: true }),
    consult: async input => { calls.push(input); if (result instanceof Error) throw result; return result },
  }
  const ctx = { get: () => broker, tools: { register: definition => { registrations.push(definition); return () => {} } } }
  registerDecisionConsultTool(ctx)
  return { tool: registrations[0], calls }
}

const exec = { agent: { id: 'agent' }, signal: new AbortController().signal }

test('decision_consult schema is object-rooted and matches the frozen parameter surface', () => {
  const { tool } = setup({ outcome: 'awaiting_user', caseId: 'dc', state: 'awaiting_user' })
  assert.equal(tool.name, 'decision_consult')
  assert.equal(tool.parameters, DECISION_CONSULT_PARAMETERS)
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['question'])
  assert.deepEqual(Object.keys(tool.parameters.properties), ['question', 'detail', 'header', 'options', 'multi_select', 'scope', 'context', 'evidence', 'agent_id', 'request_id'])
  assert.deepEqual(tool.parameters.properties.options.items.required, ['label'])
  assert.deepEqual(tool.parameters.properties.evidence.items.required, ['path'])
  assert.deepEqual(Object.keys(tool.parameters.properties.scope.properties), ['workspaces', 'paths', 'tags'])
})

for (const result of [
  { outcome: 'answered', caseId: 'dc_a', answer: { id: 'question', selected: ['A'] }, evidence: [], pins: { promptVersion: 'evaluator-contract/1' } },
  { outcome: 'returned', caseId: 'dc_r', code: 'MISSING_CONTEXT', hint: 'Add scope' },
  { outcome: 'awaiting_user', caseId: 'dc_u', state: 'awaiting_user', reason: 'consult_escalate' },
]) {
  test(`${result.outcome} returns parseable compact JSON plus a human summary`, async () => {
    const { tool, calls } = setup(result)
    const value = await tool.execute({ question: 'Which?', multi_select: false }, exec)
    assert.equal(value.outcome, result.outcome)
    const [json, summary] = value.message.split('\n')
    assert.deepEqual(JSON.parse(json), result)
    assert.ok(summary.length > 0)
    assert.equal(calls[0].agent, exec.agent)
    assert.equal(calls[0].signal, exec.signal)
    assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: value.message }])
  })
}

test('decision_consult removes optional undefined fields before the Host lossless-JSON gate', async () => {
  const { tool } = setup({
    outcome: 'answered', caseId: 'dc_json', answer: { id: 'question', selected: ['A'] },
    evidence: [{ evidenceId: 'ev', source: 'user_decision', locator: { kind: 'case', caseId: 'dc_source' }, excerpt: undefined }],
    pins: { promptVersion: 'evaluator-contract/1', reasoningEffort: undefined },
  })
  const value = await tool.execute({ question: 'Which?' }, exec)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  assert.equal('excerpt' in value.evidence[0], false)
  assert.equal('reasoningEffort' in value.pins, false)
})
test('Broker failures remain explicit tool errors and unavailable Broker cannot consult', async () => {
  const failure = new Error('DECISION_OFF')
  const { tool } = setup(failure)
  await assert.rejects(tool.execute({ question: 'Q' }, exec), error => error === failure)

  const ctx = { get: () => undefined, tools: { register: definition => definition } }
  const unavailable = registerDecisionConsultTool(ctx)
  await assert.rejects(unavailable.execute({ question: 'Q' }, exec), /Decision Broker is unavailable/)
})
