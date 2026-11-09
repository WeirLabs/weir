import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decorateDecisionText, uniqueToolCall } from '../spikes/decision/gui-fixture/adapter.js'
import { answerFormExpression, exactArgs, exactMutation, immutableChanges, layoutProblems, parseDecisionRequest, recordProjectionProblems } from '../spikes/decision/gui-product-lib.mjs'
import { decisionTriggerExpression } from '../spikes/decision/gui-qa.mjs'

test('product fixture gives each emitted tool call a unique real identity', () => {
  const delta = uniqueToolCall({ type: 'tool-call-delta', id: 'mock-call-1' }, 'unique-1')
  const end = uniqueToolCall({ type: 'block-end', block: { type: 'tool-call', id: 'mock-call-1' } }, 'unique-1')
  assert.equal(delta.id, 'unique-1')
  assert.equal(end.block.id, 'unique-1')
  const text = { type: 'text-delta', text: 'unchanged' }
  assert.equal(uniqueToolCall(text, 'unique-1'), text)
})

test('shared selector wait emits a syntactically valid browser expression', () => {
  const expression = decisionTriggerExpression()
  assert.doesNotThrow(() => new Function(`return (${expression})`))
  assert.ok(expression.includes('data-weir-decision-trigger'))
})

test('inbox answer wait composes the selector before JSON encoding', () => {
  const expression = answerFormExpression('dc_1')
  assert.doesNotThrow(() => new Function(`return (${expression})`))
  const queried = []
  const found = new Function('document', `return (${expression})`)({ querySelector: selector => (queried.push(selector), {}) })
  assert.equal(found, true)
  assert.deepEqual(queried, ['article[data-case-id="dc_1"] form.weir-da-answers'])
  assert.ok(expression.includes('dc_1'))
  assert.ok(expression.includes('article[data-case-id='))
  assert.ok(expression.includes('form.weir-da-answers'))
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(driver.includes('answerFormExpression(caseId)'))
  assert.ok(!driver.includes('JSON.stringify(article)} form.weir-da-answers'))
})

const evaluatorOptions = questions => ({
  system: 'Decision evaluator contract v3\nstrict',
  messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ L4: { request: { questions } } }) }] }],
})
const questions = [
  { id: 'q1', question: 'Question one', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', question: 'Question two' },
]

test('isolated adapter adds suggestions only to real evaluator escalations', () => {
  const output = decorateDecisionText(JSON.stringify({ outcome: 'escalate', missing: ['new judgment'] }), evaluatorOptions(questions))
  assert.deepEqual(JSON.parse(output).suggestion, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [], custom: '未提交建议 / Unsubmitted suggested text' },
  ])
  const answer = JSON.stringify({ outcome: 'answer', answers: [] })
  assert.equal(decorateDecisionText(answer, evaluatorOptions(questions)), answer)
  assert.equal(decorateDecisionText('plain text', { system: 'other', messages: [] }), 'plain text')
})

test('no-change decoration is scoped to the exact isolated assistant', () => {
  const projection = { agentId: 'da_empty', cases: [] }
  const options = { system: 'Decision consolidation contract v1\nstrict', messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(projection) }] }] }
  const original = JSON.stringify({ operations: [{ op: 'add' }] })
  assert.equal(decorateDecisionText(original, options, 'da_empty'), '{"operations":[]}')
  assert.equal(decorateDecisionText(original, options, 'da_other'), original)
})

test('raw network envelopes preserve rpc id method and exact nested args', () => {
  const body = { type: 'client-request', rpcId: 'rpc-real', method: 'weirDecision/decide', payload: { args: { args: { sessionId: 'root', caseId: 'dc_1', answers: [{ id: 'q', selected: ['A'] }] } } } }
  const parsed = parseDecisionRequest('http://local/api/weirDecision/decide', JSON.stringify(body))
  assert.equal(parsed.rpcId, 'rpc-real')
  assert.equal(parsed.method, 'decide')
  assert.deepEqual(parsed.args, body.payload.args.args)
  assert.ok(exactArgs(parsed.args, { answers: [{ selected: ['A'], id: 'q' }], caseId: 'dc_1', sessionId: 'root' }))
  assert.equal(parseDecisionRequest('http://local/api/other', '{}'), null)
})

test('mutation evidence rejects duplicates, argument drift and missing raw responses', () => {
  const entry = { method: 'snapshotPublish', args: { sessionId: 'root', snapshotId: 'ms_1', expectedRevision: 1 }, rpcId: 'rpc-1', response: { ok: true } }
  assert.equal(exactMutation([entry], 'snapshotPublish', entry.args).rpcId, 'rpc-1')
  assert.throws(() => exactMutation([entry, entry], 'snapshotPublish', entry.args), /found 2/)
  assert.throws(() => exactMutation([entry], 'snapshotPublish', { ...entry.args, expectedRevision: 2 }), /found 0/)
  assert.throws(() => exactMutation([{ ...entry, response: null }], 'snapshotPublish', entry.args), /lacks raw rpcId or response/)
})

test('layout guard fails overflow, clipping, unnamed controls and false viewport evidence', () => {
  const clean = { viewport: { width: 360 }, document: { horizontalOverflow: false }, surfaceOverflow: [], clippedPrimary: [], unnamedControls: [], internalVocabulary: [] }
  assert.deepEqual(layoutProblems(clean), [])
  assert.match(layoutProblems({ ...clean, document: { horizontalOverflow: true }, clippedPrimary: ['Submit'] }).join('\n'), /horizontal overflow[\s\S]*clipped primary/)
  assert.match(layoutProblems({ ...clean, unnamedControls: ['<input>'] }).join('\n'), /unnamed control/)
  assert.match(layoutProblems({ ...clean, viewport: { width: 0 } }).join('\n'), /missing real viewport/)
})

test('record projection compares question answers current evidence and advanced disclosure', () => {
  const detail = {
    case: { caseId: 'dc_1', revision: 2, decision: { attemptId: 'at_2', answers: [{ id: 'q', selected: ['A'] }] }, request: { questions: [{ id: 'q', question: 'Choose' }] } },
    attempts: [{ attemptId: 'at_2', evidence: [{ evidenceId: 'ev_1', excerpt: 'authoritative excerpt' }] }],
  }
  const dom = { caseId: 'dc_1', defaultText: 'Choose\nA', currentEvidence: 'authoritative excerpt', advancedText: '{"caseId":"dc_1"}' }
  assert.deepEqual(recordProjectionProblems(detail, dom), [])
  assert.match(recordProjectionProblems(detail, { ...dom, currentEvidence: 'stale excerpt' }).join('\n'), /missing current evidence/)
  assert.match(recordProjectionProblems(detail, { ...dom, defaultText: 'dc_1 Choose A' }).join('\n'), /leaks caseId/)
})

test('immutable audit allows lifecycle revisions but rejects Attempt or Snapshot content rewrites', () => {
  const attempt = { attempt_id: 'at_1', revision: 1, claims_json: '[]' }
  const snapshot = { snapshot_id: 'ms_1', version: 1, state: 'draft', revision: 1, principles_json: '[]', generated_description_json: '{}', learning_run_id: 'lr_1', created_at: 1, schema_version: 1 }
  const before = { phase: 'before', rows: { attempts: [attempt], memory_snapshots: [snapshot] } }
  const lifecycle = { phase: 'after', rows: { attempts: [attempt], memory_snapshots: [{ ...snapshot, state: 'published', revision: 2 }] } }
  assert.deepEqual(immutableChanges([before, lifecycle]), [])
  const rewrite = { phase: 'rewrite', rows: { attempts: [{ ...attempt, claims_json: '[{"changed":true}]' }], memory_snapshots: [] } }
  assert.deepEqual(immutableChanges([before, rewrite]), [{ kind: 'attempt', id: 'at_1', phase: 'rewrite' }])
})

test('product driver is wired only to new UI and real CDP capabilities', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const cdp = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/cdp.mjs'), 'utf8')
  const shared = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-qa.mjs'), 'utf8')
  const fixture = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-fixture/index.js'), 'utf8')
  assert.ok(driver.includes('data-weir-decision-trigger'))
  assert.ok(driver.includes('data-decision-primary-nav'))
  assert.ok(!driver.includes('selectDecisionTab'))
  assert.ok(!/import[\s\S]*?\bsetSelector\b[\s\S]*?from '\.\/gui-qa\.mjs'/.test(driver.split("from './gui-qa.mjs'")[0]))
  assert.ok(shared.includes('data-weir-decision-trigger'))
  for (const method of ['Emulation.setDeviceMetricsOverride', 'Emulation.setPageScaleFactor', 'Emulation.setEmulatedMedia', 'Input.dispatchKeyEvent', 'Accessibility.getPartialAXTree']) assert.ok(cdp.includes(method), method)
  assert.ok(fixture.includes("exec.arguments?.request_id !== 'gui_b_decide'"))
  assert.ok(!driver.includes('127.0.0.1:52011'))
})
