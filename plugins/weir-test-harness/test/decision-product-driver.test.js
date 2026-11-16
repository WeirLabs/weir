import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
import { join } from 'node:path'
import { decorateDecisionText, uniqueToolCall } from '../spikes/decision/gui-fixture/adapter.js'
import { answerFormExpression, assistantRoutePickerProblems, assistantVisualEditorProblems, assistantVisualReadbackProblems, MODEL_PICKER_KEYS, candidateEditConfirmationProblems, candidateUpdateAuditProblems, correctionPreviewProblems, crossWorkspaceShareProblems, decisionSettingsAdvancedProblems, decisionSettingsAnswerSwitchProblems, decisionSettingsClosedProblems, decisionSettingsNavProblems, decisionSettingsPageProblems, exactArgs, exactMutation, immutableChanges, layoutProblems, legacyLiveSurfaceProblems, legacyMigratedProfileProblems, memoryZoneProblems, parseDecisionRequest, pendingBubbleProblems, pendingOverviewProblems, publicCandidateBodyProblems, publicCandidateRejectionProblems, publicCandidateWordingProblems, publicGuidancePinProblems, publicPublishedPrinciplesProblems, publicRecordDetailProblems, publicRefinedWordingProblems, publicWireAttributionProblems, recordProjectionProblems, scrollLockProblems, exportConfirmationProblems, exportFailureSurfaceProblems, exportSuccessSurfaceProblems } from '../spikes/decision/gui-product-lib.mjs'
import decisionGui from '../src/scenarios/decision-gui.js'
import { extract } from '../src/mock-kit.js'
import { PUBLIC_CONSOLIDATION_SYSTEM } from '../../weir-harness/src/decision/learning/public.js'
import { appEnvironment, decisionTriggerExpression } from '../spikes/decision/gui-qa.mjs'
import { connectCdp } from '../spikes/decision/cdp.mjs'

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

test('Desktop app environment isolates HOME and preserves required runtime variables', t => {
  const originalHome = process.env.HOME
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })
  process.env.HOME = '/real-home-must-not-leak'
  const paths = {
    home: '/isolated/root/home',
    profile: '/isolated/root/home/profiles/desktop',
    electronData: '/isolated/root/electron-data',
  }
  const env = appEnvironment(paths, '/isolated/root/out', true)
  assert.equal(env.HOME, paths.home)
  assert.notEqual(env.HOME, process.env.HOME)
  assert.equal(env.PATH, process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin')
  assert.equal(env.DSH_HOME, paths.home)
  assert.equal(env.DSH_AGENTS_HOME, join(paths.home, 'agents-home'))
})

test('Desktop selector-default ternary stays one quoted YAML JS scalar', () => {
  const patch = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-fixture/cordis.patch.yml'), 'utf8')
  const line = patch.split('\n').find(row => row.trim().startsWith('decisionAgentSelectorDefault:'))
  const expression = line?.match(/!!js "([^"]+)"/)?.[1]
  assert.ok(expression, 'the ternary must be quoted so YAML cannot parse it as a mapping')
  const evaluate = value => Function('process', `return (${expression})`)({ env: { WEIR_DECISION_GUI_SELECTOR_DEFAULT: value } })
  assert.equal(evaluate('auto'), 'auto')
  assert.equal(evaluate('off'), 'off')
  assert.equal(evaluate(undefined), 'off')
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
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(driver.includes('answerFormExpression(caseId)'))
  assert.ok(!driver.includes('JSON.stringify(article)} form.weir-da-answers'))
})

test('cold reveal waits execute one fully quoted descendant selector', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const matrix = driver.match(/async function runColdRevealMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(matrix, 'runColdRevealMatrix exists')
  const cases = [
    { target: 'routeTarget', root: '#weir-da-inbox-routes-dc_cold-content', descendant: '[role="alert"]' },
    { target: 'evidenceTarget', root: '#weir-da-evidence-dc_cold-content', descendant: '.weir-da-evidence-list' },
  ]
  const failures = []
  for (const item of cases) {
    try {
      const line = matrix.split('\n').find(row => row.includes(`JSON.stringify(${item.target}`) && row.includes('document.querySelector'))
      assert.ok(line, `${item.target} wait exists`)
      const template = line.match(/instance\.cdp\.evaluate\((`.*`)\)/)?.[1]
      assert.ok(template, `${item.target} browser expression template is available`)
      const expression = new Function(item.target, `return (${template})`)(item.root)
      assert.doesNotThrow(() => new Function('document', 'role', `return (${expression})`), expression)
      const queried = []
      const expected = `${item.root} ${item.descendant}`
      const document = {
        querySelector(selector) {
          queried.push(selector)
          return selector === expected ? {} : null
        },
      }
      const found = new Function('document', 'role', `return (${expression})`)(document)
      assert.equal(found, true, expression)
      assert.deepEqual(queried, [expected], expression)
    } catch (error) {
      failures.push(`${item.target}: ${error.message}`)
    }
  }
  assert.deepEqual(failures, [])
})

test('cold reveal refresh restores the exact draft and compares the post-edit baseline', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const matrix = driver.match(/async function runColdRevealMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(matrix, 'runColdRevealMatrix exists')
  for (const token of ['routeRefreshBaseline', 'evidenceRefreshBaseline', "keyboardFill('Exercise cold refresh draft'", "keyboardFill('Restore cold refresh draft'", 'cold-refresh-draft.json', 'refreshBaseline', "holdDecision('record', { sessionId, caseId }, 'hold-fail')", 'await releaseDecision(routeControl)']) assert.ok(matrix.includes(token), token)
  assert.ok(!matrix.includes("openPage('records')"), 'Records → Inbox unmounts the open disclosures and is not a refresh')
  assert.ok(!matrix.includes('refreshDecisions'), 'panel toggling is not substituted for a same-mount parent render')
  const fixture = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-fixture/client.js'), 'utf8')
  assert.ok(!fixture.includes('refreshDecisions'), 'no layout-toggle fixture remains once the real draft render is used')
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

test('the candidate-edit consolidation emits one refine and one add for its assistant only', () => {
  const source = { caseId: 'dc_source', excerpt: 'Question gui-learning-source: Choose', scope: { workspaces: ['/ws'] } }
  const correction = { feedbackId: 'fb_correction', kind: 'correction', direction: 'Use the corrected direction' }
  const projection = {
    agentId: 'da_edit', workspaceKey: '/ws', cases: [source], feedback: [correction],
    parentSnapshot: { snapshotId: 'ms_v1', revision: 2, principles: [{ principleId: 'pr_1', text: 'Reviewed GUI correction principle', scope: { workspaces: ['/ws'] }, sources: ['fb_correction'], state: 'active' }] },
  }
  const options = { system: 'Decision consolidation contract v1\nstrict', messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(projection) }] }] }
  const original = JSON.stringify({ operations: [{ op: 'add', principleId: 'temporary-gui-learning', text: 'Reviewed GUI successor principle: prefer the second source-backed answer.', scope: { workspaces: ['/ws'] }, sources: ['fb_correction'] }] })
  const operations = JSON.parse(decorateDecisionText(original, options, null, 'da_edit')).operations
  assert.equal(operations.length, 2)
  assert.deepEqual(operations[0], { op: 'refine', principleId: 'pr_1', text: 'Reviewed GUI successor principle: prefer the second source-backed answer under a reviewed class.', sources: ['fb_correction'] })
  assert.equal(operations[1].op, 'add')
  assert.equal(operations[1].principleId, 'temporary-gui-edit-second')
  assert.deepEqual(operations[1].scope, { workspaces: ['/ws'] })
  assert.deepEqual(operations[1].sources, ['fb_correction'])
  assert.equal(decorateDecisionText(original, options, null, 'da_other'), original, 'another assistant keeps the single-operation packet')
  assert.equal(decorateDecisionText(original, options, 'da_edit', 'da_edit'), '{"operations":[]}', 'the no-change control wins for its own assistant')
  const withoutParent = { ...projection, parentSnapshot: null }
  const bare = { system: options.system, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(withoutParent) }] }] }
  assert.equal(decorateDecisionText(original, bare, null, 'da_edit'), original, 'without a published parent the product packet is left alone')
})

test('candidate audit facts carry counts and revisions without any principle content', () => {
  const line = (data, index) => ({ time: 1, session: 'root', type: 'weir/decision/snapshot', data: { snapshotId: 'ms_9', learningRunId: 'lr_9', agentId: 'da', rootSessionId: 'root', zone: 'workspace', action: 'candidate-update', revisionBefore: index, revisionAfter: index + 1, edited: index === 1 ? 1 : 0, removed: index === 2 ? 1 : 0, ...data } })
  const lines = [line({}, 1), line({}, 2)]
  assert.deepEqual(candidateUpdateAuditProblems(lines, { snapshotId: 'ms_9' }), [])
  assert.match(candidateUpdateAuditProblems([], { snapshotId: 'ms_9' }).join('\n'), /audit count 0 != 2/)
  assert.match(candidateUpdateAuditProblems([line({}, 1)], { snapshotId: 'ms_9' }).join('\n'), /audit count 1 != 2/)
  assert.match(candidateUpdateAuditProblems([line({}, 1), line({}, 2)], { snapshotId: 'ms_other' }).join('\n'), /audit count 0 != 2/, 'another candidate never satisfies the check')
  assert.match(candidateUpdateAuditProblems([line({}, 1), line({}, 2)].map(item => ({ ...item, data: { ...item.data, action: 'boundary-reject' } })), { snapshotId: 'ms_9' }).join('\n'), /audit count 0 != 2/, 'only candidate updates of this candidate count')
  assert.match(candidateUpdateAuditProblems([line({ text: 'Reviewed GUI principle' }, 1), line({}, 2)], { snapshotId: 'ms_9' }).join('\n'), /non-fact field: text/)
  assert.match(candidateUpdateAuditProblems([line({}, 1), line({}, 2)].map(item => ({ ...item, data: { ...item.data, scope: { paths: ['/x'] } } })), { snapshotId: 'ms_9' }).join('\n'), /non-fact field: scope/)
  assert.match(candidateUpdateAuditProblems([line({}, 2), line({}, 3)], { snapshotId: 'ms_9' }).join('\n'), /audit 0 revisions 2->3 != 1->2/)
  assert.match(candidateUpdateAuditProblems([line({ edited: 2 }, 1), line({}, 2)], { snapshotId: 'ms_9' }).join('\n'), /audit edited count 2 != 1/)
  assert.match(candidateUpdateAuditProblems([line({}, 1), line({}, 2)].map(item => ({ ...item, data: { ...item.data, zone: 'public' } })), { snapshotId: 'ms_9' }).join('\n'), /zone public != workspace/)
})

test('the publish confirmation states this review\'s own edit counts', () => {
  assert.deepEqual(candidateEditConfirmationProblems('其中 1 条由你编辑 · 已删除 1 条', { edited: 1, removed: 1 }), [])
  assert.deepEqual(candidateEditConfirmationProblems('Edited by you: 1 · Removed: 1', { edited: 1, removed: 1 }), [])
  assert.deepEqual(candidateEditConfirmationProblems(null, { edited: 1, removed: 1 }), ['the publish confirmation states no user edits'])
  assert.match(candidateEditConfirmationProblems('其中 1 条由你编辑', { edited: 1, removed: 1 }).join('\n'), /edit fact count 1 != 2/)
  assert.match(candidateEditConfirmationProblems('其中 2 条由你编辑 · 已删除 1 条', { edited: 1, removed: 1 }).join('\n'), /edited 2 != 1/)
  assert.match(candidateEditConfirmationProblems('其中 1 条由你编辑 · 已删除 2 条', { edited: 1, removed: 1 }).join('\n'), /removed 2 != 1/)
  assert.match(candidateEditConfirmationProblems('其中 1 条由你编辑 · 已删除 1 条 · Reviewed GUI successor principle', { edited: 1, removed: 1 }).join('\n'), /exposes the model wording/)
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

const realCorrectionPreview = '适用于: /Users/young/Documents/Orrery\n取代以下问题的答案: Choose a genuinely new GUI direction\n只影响之后的判断，原回答保留不变。'
const correctionPreview = (...lines) => lines.filter(line => line !== null).join('\n')

test('correction preview accepts real localized scope target and future-only wording', () => {
  assert.deepEqual(correctionPreviewProblems(realCorrectionPreview), [])
  // Run wab8MC regression anchor: the old oracle demanded the literal label 适用范围.
  assert.equal(/scope|适用范围/i.test(realCorrectionPreview), false)
  const legacy = correctionPreview('适用范围: /Users/young/Documents/Orrery', '取代以下问题的答案: Choose a direction', '只影响之后的判断，原回答保留不变。')
  assert.deepEqual(correctionPreviewProblems(legacy), [])
  const english = correctionPreview('Applies to: /Users/young/Documents/Orrery', 'Supersedes the answer to: Choose a direction', 'Only future decisions are affected; the original answer remains unchanged.')
  assert.deepEqual(correctionPreviewProblems(english), [])
})

test('correction preview rejects missing scope target or future-only consequence', () => {
  const scope = '适用于: /Users/young/Documents/Orrery'
  const target = '取代以下问题的答案: Choose a genuinely new GUI direction'
  const future = '只影响之后的判断，原回答保留不变。'
  assert.match(correctionPreviewProblems(correctionPreview(null, target, future)).join('\n'), /omits scope/)
  assert.match(correctionPreviewProblems(correctionPreview(scope, null, future)).join('\n'), /omits superseded answer/)
  assert.match(correctionPreviewProblems(correctionPreview(scope, target, null)).join('\n'), /omits future-only consequence/)
  for (const empty of ['', '   ', null, undefined]) assert.match(correctionPreviewProblems(empty).join('\n'), /missing correction preview/)
})

test('product driver consumes the shared correction preview guard', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(driver.includes('correctionPreviewProblems(preview)'))
  assert.ok(!driver.includes('/scope|适用范围/i.test(preview)'))
})

test('immutable audit allows lifecycle revisions and draft revisions but rejects accepted Snapshot content rewrites', () => {
  const attempt = { attempt_id: 'at_1', revision: 1, claims_json: '[]' }
  const snapshot = { snapshot_id: 'ms_1', version: 1, state: 'draft', revision: 1, principles_json: '[]', generated_description_json: '{}', learning_run_id: 'lr_1', created_at: 1, schema_version: 1 }
  const before = { phase: 'before', rows: { attempts: [attempt], memory_snapshots: [snapshot] } }
  const lifecycle = { phase: 'after', rows: { attempts: [attempt], memory_snapshots: [{ ...snapshot, state: 'published', revision: 3 }] } }
  assert.deepEqual(immutableChanges([before, lifecycle]), [])
  const rewrite = { phase: 'rewrite', rows: { attempts: [{ ...attempt, claims_json: '[{"changed":true}]' }], memory_snapshots: [] } }
  assert.deepEqual(immutableChanges([before, rewrite]), [{ kind: 'attempt', id: 'at_1', phase: 'rewrite' }])
  // A draft is what the user revises before accepting it: its principles may move
  // while it stays a draft, and the accepted content is fixed from then on.
  const revised = { phase: 'revised', rows: { attempts: [attempt], memory_snapshots: [{ ...snapshot, revision: 2, principles_json: '[{"principleId":"pr_1"}]' }] } }
  assert.deepEqual(immutableChanges([before, revised]), [])
  const accepted = { phase: 'accepted', rows: { attempts: [attempt], memory_snapshots: [{ ...snapshot, state: 'published', revision: 3, principles_json: '[{"principleId":"pr_1"}]' }] } }
  assert.deepEqual(immutableChanges([before, revised, accepted]), [])
  const acceptedRewrite = { phase: 'accepted-rewrite', rows: { attempts: [attempt], memory_snapshots: [{ ...snapshot, state: 'published', revision: 4, principles_json: '[{"principleId":"pr_2"}]' }] } }
  assert.deepEqual(immutableChanges([before, revised, accepted, acceptedRewrite]), [{ kind: 'snapshot-content', id: 'ms_1', phase: 'accepted-rewrite' }])
})

test('product driver is wired only to new UI and real CDP capabilities', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const cdp = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/cdp.mjs'), 'utf8')
  const shared = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-qa.mjs'), 'utf8')
  const fixture = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-fixture/index.js'), 'utf8')
  const fixtureClient = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-fixture/client.js'), 'utf8')
  assert.ok(driver.includes('data-weir-decision-trigger'))
  assert.ok(driver.includes('data-decision-primary-nav'))
  assert.ok(!driver.includes('selectDecisionTab'))
  assert.ok(!/import[\s\S]*?\bsetSelector\b[\s\S]*?from '\.\/gui-qa\.mjs'/.test(driver.split("from './gui-qa.mjs'")[0]))
  assert.ok(shared.includes('data-weir-decision-trigger'))
  assert.ok(fixtureClient.includes('activeSessionId') && fixtureClient.includes('retainedBy?.mainView'), 'the fixture reads the authoritative mainView session identity')
  assert.ok(shared.includes('getState().activeSessionId==='), 'session creation/opening waits for the requested active root')
  const fixtureOpen = fixtureClient.match(/async function openSession\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const openCall = fixtureOpen.indexOf('ctx.uiWorkspace.openSession(sessionId)')
  const existingReady = fixtureOpen.indexOf("await ctx.uiWorkspace.sessions.using(currentSessionId, { source: 'decisionQA' }, async () => {})")
  assert.ok(existingReady >= 0 && openCall > existingReady, 'the existing restored root is ready before the driver displaces it')
  const readyCall = fixtureOpen.indexOf("await ctx.uiWorkspace.sessions.using(sessionId, { source: 'decisionQA' }, async () => {})")
  const panelSwitch = fixtureOpen.indexOf('ctx.layout.selectPanel(null)')
  assert.ok(openCall >= 0 && readyCall > openCall && panelSwitch > readyCall, 'uiWorkspace opening awaits ClientSessions.using reference.ready before panel switching; using owns finally release')
  assert.ok(fixtureClient.includes('await openSession(sessionId)'), 'session creation uses the same readiness handshake')
  assert.ok(!fixtureClient.includes('sessionBinding') && !shared.includes('sessionBindingReady'), 'the binding-presence workaround is fully removed')
  for (const method of ['Emulation.setDeviceMetricsOverride', 'Emulation.setPageScaleFactor', 'Emulation.setEmulatedMedia', 'Input.dispatchKeyEvent', 'Accessibility.getFullAXTree']) assert.ok(cdp.includes(method), method)
  assert.ok(!cdp.includes('Accessibility.getPartialAXTree'), 'partial relatives are not a substitute for the target full subtree')
  assert.ok(fixture.includes("exec.arguments?.request_id !== 'gui_b_decide'"))
  assert.ok(!driver.includes('127.0.0.1:52011'))
  assert.ok(cdp.includes('data-desktop-onboarding') && cdp.includes('dismissed: true'), 'startup completes and verifies the real host onboarding path')
})

test('product driver settles host credit onboarding with scoped native keyboard steps', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(driver.includes('submitMarker as submitMarkerRaw'), 'the shared marker submit is wrapped without changing other callers')
  const dismiss = driver.match(/async function dismissCreditOnboarding\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(dismiss.includes('[data-desktop-onboarding="credit"]'), 'only the exact host credit page is handled')
  assert.ok(dismiss.includes("labels: ['跳过', 'Skip']") && dismiss.includes("labels: ['我知道了', 'Got it']"), 'both real Skip and confirmation steps are covered')
  assert.ok(!/\.click\(|\.focus\(|dispatchMouseEvent/.test(dismiss), 'host onboarding remains native-keyboard only')
  const submit = driver.match(/async function submitMarker\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const dismissFirst = submit.indexOf('await dismissCreditOnboarding(instance)')
  const rawSubmit = submit.indexOf('await submitMarkerRaw(instance, marker)')
  assert.ok(dismissFirst >= 0 && rawSubmit > dismissFirst, 'the host surface is settled before marker submission')
  assert.ok(driver.includes('consoleErrors.length === 0'), 'the zero-console-error runtime gate remains unchanged')
})

test('delayed host welcome onboarding is resolved around native keyboard targeting with durable evidence', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const dismiss = driver.match(/async function settleDelayedHostOnboarding\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(dismiss, 'the delayed host onboarding guard exists')
  assert.ok(dismiss.includes('[data-desktop-onboarding="welcome"]'), 'only the exact visible host welcome page is classified as delayed onboarding')
  assert.ok(dismiss.includes("#weir-da-selector-panel,dialog.weir-da-dialog"), 'an active native Decision modal is never bypassed as host onboarding')
  assert.ok(dismiss.includes('chooseDefaultWorkspace('), 'the existing real host UI flow resolves the welcome page')
  assert.match(dismiss, /resolution\?\.dismissed === true/, 'host dismissal must be observed')
  assert.ok(dismiss.includes('resolution.selection'), 'default workspace selection must be observed')
  assert.ok(dismiss.includes("host-onboarding.json"), 'every delayed dismissal is persisted with its triggering product action')
  assert.ok(!/\.click\(|\.focus\(|body\.innerText\.includes/.test(dismiss), 'the guard neither uses DOM actions nor classifies product error copy as onboarding')

  const focus = driver.match(/async function keyboardFocus\(action, selector, options = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok((focus.match(/await settleHost\(\)/g) ?? []).length >= 2, 'host state is checked both before target readiness and during native Tab traversal')
  assert.ok(dismiss.includes('[data-desktop-onboarding="credit"]'), 'delayed credit is classified by its exact host marker, not product text')
  assert.ok(dismiss.includes('dismissCreditOnboarding(instance)'), 'delayed credit reuses the proven native Skip and confirmation flow')
  const credit = driver.match(/async function dismissCreditOnboarding\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.equal(credit.match(/skipDelayedHostOnboarding: true/g)?.length, 2, 'Skip and confirmation suppress only their own recursive delayed-host detection')
  assert.ok(focus.includes('options.skipDelayedHostOnboarding'), 'keyboardFocus honors the narrow reentry guard')
  assert.ok(dismiss.includes('chooseDefaultWorkspace(() => dismissCreditOnboarding(instance))'), 'credit appearing during the welcome flow is dismissed without waiting for an unreachable workspace button')
  assert.ok(dismiss.includes('resolution.creditDismissed'), 'the welcome → credit transition has explicit completion evidence')
  const cdp = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/cdp.mjs'), 'utf8')
  const choose = cdp.match(/async chooseDefaultWorkspace\([^)]*\) \{[\s\S]*?\n    \}/)?.[0] ?? ''
  assert.ok(choose.includes('onCredit') && choose.includes('creditDismissed'), 'the real CDP welcome flow observes and settles a mid-flow credit transition')
  assert.ok(focus.includes('step < 500'), 'the existing focus traversal bound is not expanded to conceal a trap')
  assert.ok(!/\.click\(|\.focus\(/.test(focus), 'product targeting remains native-keyboard only')
  assert.ok((driver.match(/result\.artifacts\.hostOnboarding = join\(out, 'host-onboarding\.json'\)/g) ?? []).length === 2, 'final and blocked result indexes include the dismissal evidence')
})

test('shrunk-content clamp accepts a sub-pixel browser clamp but never a real jump', () => {
  const inline = Object.fromEntries(['overflow', 'overflowX', 'overflowY', 'overscrollBehavior', 'overscrollBehaviorX', 'overscrollBehaviorY', 'paddingRight', 'paddingBottom', 'overflowAnchor'].map(key => [key, '']))
  const container = (scrollHeight, clientHeight, scrollTop, extra = {}) => ({
    scrollHeight, clientHeight, scrollTop, scrollLeft: 0, scrollWidth: 900, clientWidth: 900, inline: { ...inline, ...extra },
  })
  const lockedInline = { overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden', overscrollBehavior: 'none', overscrollBehaviorX: 'none', overscrollBehaviorY: 'none', paddingRight: '5px', overflowAnchor: 'none' }
  const mutation = { method: 'learningStart', args: {}, rpcId: 'r1', response: { rpcId: 'r1', result: { ok: true, value: { ok: true } } }, settled: true, authoritative: { confirmed: true } }
  const base = {
    before: { page: container(1452, 900, 552.5) },
    during: { page: container(1452, 900, 552.5, lockedInline) },
    attempts: [{ type: 'wheel', observed: true }, { type: 'touch', observed: true }, { type: 'PageDown', observed: true }],
    contentMutation: mutation,
  }
  const required = ['page']
  const attempts = ['wheel', 'touch', 'PageDown']
  // A real browser clamps to a fractional maximum; scrollHeight only reports 1093.
  assert.deepEqual(scrollLockProblems({ ...base, after: { page: container(1093, 900, 193.5) } }, required, attempts), [])
  assert.deepEqual(scrollLockProblems({ ...base, after: { page: container(1093, 900, 193) } }, required, attempts), [])
  assert.ok(scrollLockProblems({ ...base, after: { page: container(1093, 900, 194) } }, required, attempts).some(problem => /clamp\(552.5, 193\)/.test(problem)), 'a whole-pixel deviation is still a failure')
  assert.ok(scrollLockProblems({ ...base, after: { page: container(1093, 900, 195) } }, required, attempts).some(problem => /clamp\(552.5, 193\)/.test(problem)))
  assert.ok(scrollLockProblems({ ...base, after: { page: container(1093, 900, 0) } }, required, attempts).some(problem => /clamp\(552.5, 193\)/.test(problem)))
  // Without a shrink the restoration must still be exact.
  assert.ok(scrollLockProblems({ ...base, after: { page: container(1452, 900, 550) } }, required, attempts).some(problem => /not restored exactly/.test(problem)))
  assert.deepEqual(scrollLockProblems({ ...base, after: { page: container(1452, 900, 552.5) } }, required, attempts), [])
})

test('confirmation focus measurement retains original element identity across a state-dependent selector change', async () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const source = driver.match(/async function measureConfirmationFocus\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(source, 'the public Desktop measurement helper exists')
  const originSelector = '[data-agent-detail="agent-1"] [data-agent-state="disabled"]'
  const button = () => ({ isConnected: true, disabled: false, id: '', className: 'weir-da-button', tagName: 'BUTTON', getAttribute: () => null, getClientRects: () => [{}] })
  const origin = button()
  const fallback = button()
  const body = { tagName: 'BODY', id: '', className: '' }
  let originMatches = true
  const document = {
    activeElement: body,
    querySelector(selector) {
      if (selector === originSelector) return originMatches ? origin : null
      if (selector === '[data-decision-primary-nav]') return fallback
      return null
    },
  }
  const window = {}
  const instance = { cdp: { evaluate: async expression => new Function('document', 'window', 'getComputedStyle', `return (${expression})`)(document, window, () => ({ visibility: 'visible' })) } }
  const measure = new Function('instance', 'decisionControl', `${source};return measureConfirmationFocus`)(instance, async () => ({ settled: true }))
  const before = await measure(originSelector, 'control-1')
  assert.equal(before.targetFocused, false)
  originMatches = false
  document.activeElement = origin
  const after = await measure(originSelector, 'control-1')
  assert.equal(after.targetFocused, true, 'the original connected enabled element remains the focus target even when its old state selector no longer matches')
  assert.equal(after.target?.focused, true)
  assert.equal(after.fallbackFocused, false)
})

test('held explicit consult Desktop acceptance puts one answer form before secondary content', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const state = driver.match(/async function cardState\(caseId\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(state, 'cardState exists')
  for (const token of ['form.weir-da-answers', 'formImmediatelyAfterHeader', 'formBeforeSecondary', '.weir-da-record-answers', '.weir-da-suggestion-review', 'secondary.length===5']) assert.ok(state.includes(token), token)
  const revealBody = driver.match(/async function revealCard\(caseId\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(revealBody, 'revealCard exists')
  // The card is owned by the Turn-layer chat node, so reading it never opens a
  // process disclosure: the assertion replaced the old pointer-driven reveal.
  assert.match(revealBody, /decisionCardProblems/, 'the reveal asserts the card contract where it stands')
  assert.ok(!/dispatchMouseEvent|data-process-activity|\.click\(|\.focus\(/.test(revealBody), 'the reveal never opens a disclosure, clicks, or focuses')
  const held = driver.indexOf("check('consultSingleWritableCardBeforeToolResult'")
  const reveal = driver.indexOf('beforeCard = await revealCard(consult.caseId)', held)
  const focused = driver.indexOf("check('consultWaitingCardPutsDecisionFirst'")
  const release = driver.indexOf("writeFileSync(join(out, 'consult-result.release')")
  assert.ok(held >= 0 && reveal > held && focused > reveal && release > focused, 'the held card is revealed and asserted before tool result release')
  const acceptance = driver.slice(reveal, release)
  for (const condition of ['beforeCard.cards === 1', 'beforeCard.forms === 1', 'beforeCard.formImmediatelyAfterHeader', 'beforeCard.formBeforeSecondary', 'beforeCard.recordAnswerSummaries === 0', 'beforeCard.suggestionReviews === 1', "beforeCard.text.includes('GUI_B_DECIDE')"]) assert.ok(acceptance.includes(condition), condition)
  assert.ok(acceptance.includes('beforeCard = await revealCard(consult.caseId)'), 'the held card is scrolled into view and must expose non-empty rendered text before its screenshot')
  // The tentative-suggestion block is measured where it now lives: inside the
  // answer form, with the fill helper in its heading row and a submit-only row.
  const blockProbe = driver.match(/async function suggestionBlockDom\(caseId[^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(blockProbe, 'suggestionBlockDom exists')
  for (const token of ['[data-suggestion-review]', '.weir-da-suggestion-header', 'blockInForm', 'beforeActionsRow', 'afterQuestions', 'fillType', "getAttribute('type')", 'actionButtons']) assert.ok(blockProbe.includes(token), token)
  assert.ok(!/\.click\(|\.focus\(/.test(blockProbe), 'the probe measures the block without activating it')
  assert.ok(acceptance.includes("check('consultSuggestionBlockGroupsFillAction'"), 'the consult card asserts its block before the tool result is released')
  assert.ok(acceptance.includes("check('suggestionTitleIsShort'"), 'the short-title assertion belongs to the same held-card window')
  assert.ok(acceptance.includes("await frameSuggestionBlock('10b-consult-suggestion-block'"), 'the block screenshot is taken inside the held-card window')
  assert.ok(driver.includes("answerInboxWithSuggestions(sessionId, consult.caseId, '12-consult-inbox', { checkBlock: 'inboxSuggestionBlockGroupsFillAction' })"), 'the inbox card records the block check while proving the fill never submits')
  const inboxWindow = driver.slice(driver.indexOf('async function answerInboxWithSuggestions('), driver.indexOf('async function skipLongNativeStep('))
  assert.ok(inboxWindow.includes('options.checkBlock') && inboxWindow.includes("stillPending.case.state === 'awaiting_user'"), 'the inbox block check re-proves the case stays awaiting the user after the fill')
})

test('Decision settings navigation targets the third Weir page without a page-body probe', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const body = driver.match(/async function openDecisionSettings\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(body, 'openDecisionSettings exists')
  // Host Settings restores the last visited page, so neither a version string nor
  // one page's body text is a readiness probe: the dialog, its navigation ledger
  // and the decision page's own basic group are.
  assert.ok(!body.includes('当前版本'), 'readiness is the dialog and the page groups, not a restored page body')
  assert.ok(!body.includes('Auto Shadow'), 'the Auto Shadow body text is never the readiness signal')
  const dialog = body.indexOf('[role="dialog"]')
  const section = body.indexOf("keyboardActivate('Open the Decision assistant settings page'")
  const ready = body.indexOf('[data-group="decisionBasics"]')
  assert.ok(dialog >= 0 && section > dialog && ready > section, 'dialog → Decision assistant section → its basic group')
  assert.ok(body.includes('decisionSettingsNavProblems('), 'the navigation ledger proves the third Weir section registered')
  const shell = driver.match(/async function openSettingsDialog\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(shell, 'openSettingsDialog exists')
  assert.ok(shell.includes("await instance.cdp.key('Escape')"), 'a restored open dialog is closed before the menu gesture')
  assert.ok(!/\.click\(|dispatchMouseEvent/.test(body + shell), 'Host Settings navigation stays native-keyboard only')
})

test('Decision settings page structure and close are asserted from real DOM attributes', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const dom = driver.match(/async function decisionSettingsDom\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(dom, 'decisionSettingsDom exists')
  assert.ok(dom.includes('Allow automatic answers'), 'the answer switch is read from its real accessible name')
  assert.ok(dom.includes('aria-checked') || dom.includes('checked'), 'the switch state is the checked attribute')
  assert.ok(dom.includes("data-advanced-toggle") && dom.includes('aria-expanded'), 'the fold state is the toggle aria-expanded')
  assert.ok(!dom.includes('data-decision-class-set'), 'the retired class-chip container is no longer read')
  assert.ok(driver.includes('decisionSettingsPageProblems(opened, { masterEnabled: true })'), 'the open page is asserted through the three-row guard')
  assert.ok(driver.includes('decisionSettingsAdvancedProblems(expanded, authority)'), 'the expanded advanced group is asserted against the authority')
  assert.ok(driver.includes('decisionSettingsPageProblems(off, { masterEnabled: false })'), 'the master-off page is asserted to lose the advanced group')
  assert.ok(!driver.includes('document.body.innerText.includes("Auto Shadow'), 'no close assertion relies on the Auto Shadow body text')
  const closeBody = driver.match(/async function closeDecisionSettings\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(closeBody, 'closeDecisionSettings exists')
  assert.ok(closeBody.includes('decisionSettingsClosedProblems('), 'the close assertion is the structural page-absent guard')
})


test('Decision settings answer switch replaces the retired whitelist text input', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(!driver.includes('input#plugin-config-weir-settings-decisionAgentAutoAnswerClasses'), 'the whitelist is no longer a text input')
  assert.ok(!driver.includes('data-decision-class'), 'the retired class chips are gone from the driver')
  const staged = driver.match(/async function setDecisionAutoAnswer\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(staged, 'setDecisionAutoAnswer exists')
  assert.ok(staged.includes('Allow automatic answers'), 'the switch is driven by its real accessible name')
  assert.ok(staged.includes('decisionSettingsAnswerSwitchProblems('), 'the staged switch is compared against the requested value')
  assert.ok(driver.includes('await setDecisionAdvanced(true)'), 'the advanced group is expanded before its rows are touched')
  assert.ok(!/keyboardFill\('Edit Auto answer-class whitelist'/.test(driver), 'no JSON text entry survives for the whitelist')
})

test('a delayed host credit page above a Decision modal is still dismissed', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const body = driver.match(/async function settleDelayedHostOnboarding\(action\) \{[\s\S]*?\n\}\n/)?.[0] ?? ''
  assert.ok(body, 'settleDelayedHostOnboarding exists')
  // The Host can raise its credit page above an open Decision modal; a blanket
  // "a Decision modal is open, skip" guard wedged a real run at selectorOpen.
  assert.ok(body.includes('elementFromPoint'), 'the overlay and the modal are ordered by what is really topmost')
  assert.ok(!/if\(decisionDialog\)return null/.test(body), 'an overlay that really covers the modal is still dismissed')
  assert.ok(body.includes("page==='credit'"), 'the credit page keeps its own dismissal path')
})
test('Host language matrix activates General settings through native keyboard before General-only controls', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const body = driver.match(/async function setGuiLanguage\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(body, 'setGuiLanguage exists')
  const settings = body.indexOf("await keyboardActivate('Open Settings for language'")
  const general = body.indexOf("await keyboardActivate('Open General settings for language', '[role=\"dialog\"] button', { labels: ['通用设置', 'General', 'General settings'] })")
  const version = body.indexOf('当前版本')
  const language = body.indexOf("await keyboardActivate('Open real Language preference'")
  assert.ok(settings >= 0 && general > settings && version > general && language > version, 'Settings → General → version readiness → real Language selector is the required navigation order')
  assert.ok(!/\.click\(|\.focus\(|dispatchMouseEvent/.test(body), 'Host Settings navigation remains native-keyboard only')
})

test('Host language trigger recognizes rendered Chinese and legacy variants inside Settings', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const body = driver.match(/async function setGuiLanguage\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const call = body.match(/await keyboardActivate\('Open real Language preference', '([^']+)', (\{[^\n]+\})\)/)
  assert.ok(call, 'the real Language trigger call exists')
  assert.equal(call[1], '[role="dialog"] button[aria-haspopup="menu"]', 'trigger discovery remains scoped to the Settings dialog')
  const options = Function(`return (${call[2]})`)()
  const pattern = new RegExp(options.namePattern, 'i')
  for (const label of ['中文', '简体中文', 'English', 'Chinese']) assert.ok(pattern.test(label), label)
  for (const label of ['选择模型，当前 Mock One', 'Chinese preset', '标准']) assert.ok(!pattern.test(label), label)
})

test('Host language Chinese restore uses real menu labels inside the open Settings menu', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const body = driver.match(/async function setGuiLanguage\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const expression = body.match(/const labels = ([^\n]+)/)?.[1]
  assert.ok(expression, 'language selection exposes the complete rendered label candidates')
  const labelsFor = new Function('language', `return (${expression})`)
  assert.deepEqual(labelsFor('zh'), ['中文', '简体中文', 'Chinese'])
  assert.deepEqual(labelsFor('en'), ['English'])
  const call = body.match(/await keyboard(?:Menu)?Activate\(`Select \$\{labels\[0\]\} GUI language`, '([^']+)', (\{[^\n]+\})\)/)
  assert.ok(call, 'language selection uses the rendered label candidates')
  assert.equal(call[1], '[role="menuitemradio"],[role="menuitem"],button')
  const options = new Function('labels', `return (${call[2]})`)(['sentinel'])
  assert.equal(options.scope, '[role="menu"]', 'selection cannot match an unrelated model or preset menu')
  assert.deepEqual(options.labels, ['sentinel'])
})

test('Host language menu uses native directional selection in both directions', async () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const language = driver.match(/async function setGuiLanguage\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(language.includes('await keyboardMenuActivate(`Select ${labels[0]} GUI language`'), 'setGuiLanguage uses the native menu navigation seam')
  const source = driver.match(/async function keyboardMenuActivate\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(source, 'keyboardMenuActivate exists')
  assert.ok(!/\.click\(|\.focus\(|dispatchMouseEvent/.test(`${source}\n${language}`), 'menu navigation never bypasses native keyboard input')

  const item = name => ({ tagName: 'BUTTON', id: '', role: 'menuitem', offsetParent: {}, disabled: false, innerText: name, textContent: name, labels: [], value: '', getAttribute: name => name === 'aria-label' ? null : name === 'role' ? 'menuitem' : null })
  const chinese = item('中文')
  const english = item('English')
  const trigger = item('Language')
  const items = [chinese, english]
  const root = { querySelectorAll: () => items }
  const document = { activeElement: trigger, querySelector: selector => selector === '[role="menu"]' ? root : null, getElementById: () => null }
  const keys = []
  let current = chinese
  const instance = { cdp: {
    evaluate: async expression => new Function('document', `return (${expression})`)(document),
    async key(key) {
      keys.push(key)
      if (key === 'Tab') document.activeElement = current
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        const offset = key === 'ArrowDown' ? 1 : -1
        document.activeElement = items[items.indexOf(document.activeElement) + offset]
      }
    },
  } }
  const audits = []
  const waitFor = async check => {
    const value = await check()
    assert.ok(value, 'the menu target is immediately ready in this fixture')
    return value
  }
  const requireEvidence = (condition, message) => assert.ok(condition, message)
  const activate = new Function('instance', 'keyboardAudits', 'saveKeyboardAudits', 'waitFor', 'requireEvidence', `${source};return keyboardMenuActivate`)(instance, audits, () => {}, waitFor, requireEvidence)
  for (const [target, arrow] of [['English', 'ArrowDown'], ['中文', 'ArrowUp']]) {
    keys.length = 0
    current = target === 'English' ? chinese : english
    document.activeElement = trigger
    const audit = await activate(`Select ${target} GUI language`, '[role="menuitemradio"],[role="menuitem"],button', { scope: '[role="menu"]', labels: [target] })
    assert.deepEqual(keys, ['Tab', arrow, 'Enter'], target)
    assert.equal(audit.reached, true)
    assert.equal(audit.activation.key, 'Enter')
  }
  assert.equal(audits.length, 2)
})

test('English visual matrix returns to the Decision inbox before layout audits', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const body = driver.match(/async function runEnglishVisualMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(body, 'runEnglishVisualMatrix exists')
  const change = body.indexOf("const change = await setGuiLanguage('en')")
  const inbox = body.indexOf("await openPage('inbox')", change)
  const audit = body.indexOf('await layoutAudit(`en-${theme}-${width}`', change)
  assert.ok(change >= 0 && inbox > change && audit > inbox, 'Settings → native language change → Decision inbox → visual measurements is the required order')
})

test('English selector baseline waits for stable composer geometry and scroll', async () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const english = driver.match(/async function runEnglishVisualMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(english.includes("const scrollBefore = (await selectorOpen({ scrollBaseline: 'stable' })).scrollBefore"), 'the English selector uses a settled baseline after native focus and before activation')
  const source = driver.match(/async function measureStableScrollContainers\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(source, 'measureStableScrollContainers exists')
  const sample = (x, width, scrollTop, scrollHeight) => ({ composer: { rect: { x, width }, scrollTop, scrollLeft: 0, clientHeight: 728, scrollHeight, clientWidth: width, scrollWidth: 615 } })
  const samples = [sample(280.5, 77.5, 3905, 9818), sample(0, 358, 1587.5, 5911), sample(0, 358, 1587.5, 5911)]
  let calls = 0
  const measureScrollContainers = async () => samples[calls++]
  const waitFor = async check => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const value = await check()
      if (value) return value
    }
    throw new Error('measurement did not settle')
  }
  const measure = new Function('measureScrollContainers', 'waitFor', `${source};return measureStableScrollContainers`)(measureScrollContainers, waitFor)
  const result = await measure({ root: 'html', body: 'body' }, 'trigger')
  assert.equal(calls, 3, 'the changing transition sample cannot become the baseline')
  assert.deepEqual(result, samples[2])
})

test('modal scroll baseline follows native focus and precedes activation', async () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const source = driver.match(/async function keyboardActivate\(action, selector, options = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(source, 'keyboardActivate exists')
  const events = []
  let scrollTop = 2606
  const audit = {}
  const keyboardFocus = async () => {
    events.push('native-focus')
    scrollTop = 372
    return audit
  }
  const measureScrollContainers = async () => {
    events.push(`measure:${scrollTop}`)
    return { decisionPage: { scrollTop } }
  }
  const instance = { cdp: { key: async key => events.push(`activate:${key}`) } }
  const activate = new Function('instance', 'keyboardFocus', 'keyboardSnapshot', 'saveKeyboardAudits', 'measureScrollContainers', 'measureStableScrollContainers', 'requireEvidence', `${source};return keyboardActivate`)(
    instance,
    keyboardFocus,
    async () => ({ active: 'learning-publish' }),
    () => {},
    measureScrollContainers,
    measureScrollContainers,
    (condition, message) => assert.ok(condition, message),
  )
  const activated = await activate('Request snapshotPublish', '[data-action="learning-publish"]', { scrollBaseline: 'immediate' })
  assert.deepEqual(events, ['native-focus', 'measure:372', 'activate:Enter'])
  assert.equal(activated.scrollBefore.decisionPage.scrollTop, 372, 'the obsolete pre-focus 2606 sample cannot become the modal baseline')

  const learning = driver.match(/async function confirmLearning\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(learning.includes('scrollBaseline'))
  assert.ok(!learning.includes('const scrollBefore = await measureScrollContainers'), 'learning cannot sample before its native Shift+Tab traversal')
  const begin = driver.match(/async function beginModalAudit\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(!begin.includes('options.before ??'), 'an open dialog cannot supply a missing pre-activation baseline')
})

test('learning shrink restoration is bound to its exact settled mutation receipt', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const learning = driver.match(/async function confirmLearning\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  for (const token of ['const contentMutation = {', 'method: kind', 'args: { sessionId, snapshotId, expectedRevision }', 'rpcId: mutation.rpcId', 'response: mutation.response', 'settled: afterFocus.control.settled', 'authoritative: {', 'const confirmed =', 'finishModalAudit(audit, { focus, focusProblems, contentMutation })']) assert.ok(learning.includes(token), token)
  const finish = driver.match(/async function finishModalAudit\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(finish.includes('audit.contentMutation = contentMutation'), 'the raw receipt is preserved with the modal measurements')
})

// Keyboard acceptance must observe real focus traversal; querying a target is read-only and
// may never be followed by programmatic focus, DOM clicks or value setters.
test('product driver keyboard helpers record native focus traversal and text entry', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const focus = driver.match(/async function keyboardFocus\(action, selector, options = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(focus, 'the shared keyboard focus helper exists')
  assert.match(focus, /instance\.cdp\.key\('Tab',/, 'focus moves only through native Tab packets')
  assert.match(focus, /const direction = \(await keyboardSnapshot\(selector, options\)\)\.direction/, 'each action chooses its direction once')
  assert.match(focus, /instance\.cdp\.key\('Tab', direction === 'Shift\+Tab' \? 8 : 0\)/, 'native traversal keeps that direction instead of oscillating around unindexed active elements')
  assert.ok(!focus.includes('before.direction'), 'a per-step direction flip cannot recreate the composer Tab/Shift+Tab livelock')
  const snapshot = driver.match(/async function keyboardSnapshot\(selector, options = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(snapshot, /accessibleName/, 'each trace records the accessible name')
  assert.ok(snapshot.includes('[role="textbox"],[contenteditable="true"]'), 'the actual composer textbox participates in initial direction calculation')
  assert.match(snapshot, /const namePattern=\$\{JSON\.stringify\(options\.namePattern \?\? null\)\}/, 'the browser receives the serialized name pattern instead of an undefined options reference')
  assert.ok(!/!options\.namePattern/.test(snapshot), 'no browser-side expression dereferences the Node-only options object')
  assert.match(focus, /activeElement/, 'each trace records the actual active element')
  assert.match(driver, /writeJson\(join\(out, 'keyboard-interactions\.json'\), keyboardAudits\)/, 'focus evidence is durable after every step')
  assert.ok(!/\.focus\(|\.click\(|value\)\.set|HTMLInputElement|HTMLTextAreaElement/.test(focus), 'focus never bypasses keyboard reachability')

  const activate = driver.match(/async function keyboardActivate\(action, selector, options = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(activate, /await keyboardFocus\(action, selector, options\)/)
  assert.match(activate, /instance\.cdp\.key\(options\.key \?\? 'Enter'\)/)
  const fill = driver.match(/async function keyboardFill\(action, selector, value\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(fill, /await keyboardFocus\(action, selector\)/)
  assert.match(fill, /instance\.cdp\.key\('a', 4\)/, 'editing selects old text with native Meta+A')
  assert.match(fill, /Input\.insertText/, 'text is inserted through the native CDP input channel')
  assert.ok(!/\.focus\(|\.click\(|value\)\.set|HTMLInputElement|HTMLTextAreaElement/.test(`${activate}\n${fill}`))
  const select = driver.match(/async function keyboardSelect\(action, selector, value, options = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(select.includes('const target = current.options.find(option => option.value === value)'), 'the target comes from actual authoritative options')
  assert.ok(select.includes('prefix += char') && select.includes('option.label.startsWith(prefix)'), 'a unique visible-label prefix drives native typeahead')
  assert.ok(select.includes("type: 'char'") && select.includes('text: char'), 'selection uses the real-proven native char packet')
  assert.ok(!select.includes("instance.cdp.key('Space')"), 'the failed native-popup path is not retained')
  assert.ok(!/\.focus\(|\.click\(|value\)\.set|HTMLSelectElement/.test(select), 'select remains keyboard-only without DOM value mutation')
})

test('all product write paths use native keyboard helpers instead of DOM actions', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(!/\bsetInput\b/.test(driver), 'the DOM value setter is not imported or called')
  for (const name of ['selectorOpen', 'selectorChoose', 'fillAgent', 'createAgent', 'agentState', 'answerNative', 'answerInboxWithSuggestions', 'skipLongNativeStep', 'feedback', 'startCandidate', 'confirmLearning']) {
    const body = driver.match(new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''
    assert.ok(body, `${name} exists`)
    assert.ok(!/\.focus\(|\.click\(|\bclick\(|\bclickText\(|\bsetInput\(/.test(body), `${name} is keyboard-only`)
  }
  for (const call of ["await keyboardActivate('Submit note'", "await keyboardActivate('Submit correction'", "await keyboardFill('Edit assistant name'", "await keyboardFill('Enter independent note'", "await keyboardFill('Enter correction'"]) {
    assert.ok(driver.includes(call), `missing traced keyboard action: ${call}`)
  }
  assert.ok(driver.includes("artifacts: { uiux:") && driver.includes("keyboard: join(out, 'keyboard-interactions.json')"), 'the result indexes structured UIUX and keyboard evidence')
})

function fakeTransitionCdp(t) {
  const state = { scale: 1, scheme: 'light', pendingScale: null, pendingScheme: null }
  const requests = []
  const fixture = { state, requests, axNodes: [] }
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  t.after(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket })
  globalThis.fetch = async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://isolated.test' }] })
  const evaluate = expression => {
    if (state.pendingScale && --state.pendingScale.polls === 0) state.scale = state.pendingScale.value
    if (state.pendingScheme && --state.pendingScheme.polls === 0) state.scheme = state.pendingScheme.value
    return new Function('visualViewport', 'matchMedia', `return (${expression})`)(
      { scale: state.scale },
      query => ({ matches: query === `(prefers-color-scheme: ${state.scheme})` }),
    )
  }
  globalThis.WebSocket = class FakeWebSocket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.emit('open', {})) }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    emit(type, event) { this.listeners.get(type)?.(event) }
    send(text) {
      const request = JSON.parse(text)
      requests.push(request)
      queueMicrotask(() => {
        if (request.method === 'Emulation.setPageScaleFactor') state.pendingScale = { value: request.params.pageScaleFactor, polls: 2 }
        if (request.method === 'Emulation.setEmulatedMedia') state.pendingScheme = { value: request.params.features[0].value, polls: 2 }
        const result = request.method === 'Runtime.evaluate' ? { result: { value: evaluate(request.params.expression) } }
          : request.method === 'DOM.getDocument' ? { root: { nodeId: 1 } }
            : request.method === 'DOM.querySelector' ? { nodeId: request.params.selector }
              : request.method === 'DOM.describeNode' ? { node: { backendNodeId: request.params.nodeId === '#native' ? 43 : 42 } }
                : request.method === 'Accessibility.getPartialAXTree' ? { nodes: fixture.axNodes.filter(node => node.backendDOMNodeId === request.params.backendNodeId) }
                  : request.method === 'Accessibility.getFullAXTree' ? { nodes: fixture.axNodes }
                    : {}
        this.emit('message', { data: JSON.stringify({ id: request.id, result }) })
      })
    }
    close() {}
  }
  return fixture
}

test('CDP accessibility acquires each target full subtree with deep semantics only', async t => {
  const fake = fakeTransitionCdp(t)
  const ax = (nodeId, backendDOMNodeId, role, name, childIds = [], extra = {}) => ({ nodeId, backendDOMNodeId, role: { value: role }, name: { value: name }, childIds, ...extra })
  fake.axNodes = [
    ax('root', 1, 'RootWebArea', 'Desktop', ['selector', 'native', 'foreign']),
    ax('selector', 42, 'dialog', 'Choose assistant', ['radiogroup']),
    ax('radiogroup', 420, 'radiogroup', 'Choose assistant', ['label']),
    ax('label', 4200, 'generic', '', ['auto']),
    ax('auto', 42000, 'radio', 'Auto', [], { properties: [{ name: 'checked', value: { value: 'checked' } }] }),
    ax('native', 43, 'none', null, ['native-body'], { ignored: true }),
    ax('native-body', 430, 'generic', '', ['options']),
    ax('options', 4300, 'group', ''),
    ax('foreign', 44, 'button', 'Foreign control'),
  ]
  const cdp = await connectCdp(9495)
  const selector = await cdp.accessibility('#selector')
  assert.deepEqual(selector.map(node => [node.role, node.name, node.ignored]), [
    ['dialog', 'Choose assistant', false],
    ['radiogroup', 'Choose assistant', false],
    ['generic', '', false],
    ['radio', 'Auto', false],
  ])
  assert.equal(selector.at(-1).properties.checked, 'checked', 'the nested checked Auto radio survives projection')
  const native = await cdp.accessibility('#native')
  assert.deepEqual(native.map(node => [node.role, node.name, node.ignored]), [
    ['none', null, true],
    ['generic', '', false],
    ['group', '', false],
  ], 'the real pending-question option group is acquired below its ignored frame')
  assert.ok(![...selector, ...native].some(node => node.name === 'Foreign control' || node.role === 'RootWebArea'), 'full-document acquisition remains target scoped')
  assert.equal(fake.requests.filter(request => request.method === 'Accessibility.getFullAXTree').length, 2)
  assert.equal(fake.requests.filter(request => request.method === 'Accessibility.getPartialAXTree').length, 0)
  cdp.close()
})

test('CDP key emits native Enter and Space activation packets without changing navigation keys', async t => {
  const fake = fakeTransitionCdp(t)
  const cdp = await connectCdp(9493)
  for (const key of ['Enter', 'Space', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp']) await cdp.key(key)
  const events = fake.requests.filter(request => request.method === 'Input.dispatchKeyEvent').map(request => request.params)
  assert.deepEqual(events, [
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0, text: '\r', unmodifiedText: '\r' },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 },
    { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 0, text: ' ', unmodifiedText: ' ' },
    { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 0 },
    { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0 },
    { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0 },
    { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, modifiers: 0 },
    { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, modifiers: 0 },
    { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, modifiers: 0 },
    { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40, modifiers: 0 },
    { type: 'rawKeyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38, modifiers: 0 },
    { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38, modifiers: 0 },
  ])
  assert.deepEqual(cdp.inputPackets.map(packet => packet.params), events, 'the live driver retains every native input packet verbatim')
  cdp.close()
})

test('CDP key emits native reverse Tab and Meta+A editing packets', async t => {
  const fake = fakeTransitionCdp(t)
  const cdp = await connectCdp(9494)
  await cdp.key('Tab', 8)
  await cdp.key('a', 4)
  const events = fake.requests.filter(request => request.method === 'Input.dispatchKeyEvent').map(request => request.params)
  assert.deepEqual(events, [
    { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8 },
    { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8 },
    { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4, commands: ['SelectAll'] },
    { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 },
  ])
  cdp.close()
})

test('CDP page zoom helper waits until the requested visual scale is observable', async t => {
  const fake = fakeTransitionCdp(t)
  const cdp = await connectCdp(9491)
  await cdp.setPageZoom(2)
  assert.equal(fake.state.scale, 2, 'ack alone must not resolve while the renderer still reports scale 1')
  assert.ok(fake.requests.filter(request => request.method === 'Runtime.evaluate').length >= 2, 'the helper polls the real scale condition')
  cdp.close()
})

test('CDP color scheme helper waits for both dark and light target media states', async t => {
  const fake = fakeTransitionCdp(t)
  const cdp = await connectCdp(9492)
  const observed = []
  for (const scheme of ['dark', 'light']) {
    await cdp.setColorScheme(scheme)
    observed.push(fake.state.scheme)
  }
  assert.deepEqual(observed, ['dark', 'light'])
  assert.ok(fake.requests.filter(request => request.method === 'Runtime.evaluate').length >= 4, 'each target is independently polled')
  cdp.close()
})

test('product visual audit waits for target computed colors and retains strict zoom and layout guards', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const audit = driver.match(/async function layoutAudit\(name, theme = 'light', zoom = 1\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(audit, 'layoutAudit exists')
  assert.match(audit, /await waitFor\(/, 'the audit waits for a real condition rather than sampling the CDP ack')
  assert.match(audit, /expectedColors/, 'light and dark have explicit computed-color targets')
  assert.match(audit, /audit\.colors\?\.background===expectedColors\.background/)
  assert.match(audit, /audit\.colors\?\.color===expectedColors\.color/)
  assert.match(audit, /layoutProblems\(audit\)/)
  assert.ok(audit.includes('layoutProblems(candidate).length===0') && audit.includes('candidate.colors?.background===expectedColors.background') && audit.includes('Math.abs((candidate.viewport.scale ?? 1) - zoom) < 0.01'), 'the audit waits for the same strict layout, color, and zoom predicates before the screenshot')
  assert.ok(audit.includes('audit = candidate'), 'the latest real measurements remain available if settling fails')
  assert.match(audit, /Math\.abs\(\(audit\.viewport\.scale \?\? 1\) - zoom\) < 0\.01/)
  for (const guard of ['surfaceOverflow', 'clippedPrimary', 'unnamedControls']) assert.ok(audit.includes(guard), guard)
  const zoomLoop = driver.match(/for \(const width of \[360, 768, 1440\]\) \{\s*await instance\.cdp\.setViewport\(width, 900, true\)[\s\S]*?await instance\.cdp\.setPageZoom\(1\)/)?.[0] ?? ''
  assert.ok(zoomLoop.includes('await instance.cdp.setPageZoom(2)'), '200% uses the real mobile-enabled CDP page-scale mechanism')
})

test('narrow visual audit natively closes the host drawer and requires independent main-region hit testing', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const normalize = driver.match(/async function normalizeDecisionHostChrome\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(normalize, 'ordinary narrow audits normalize the real host drawer state')
  assert.match(normalize, /keyboardActivate\('Close host sidebar for Decision visual audit'/)
  assert.match(normalize, /收起侧边栏/)
  assert.match(normalize, /Close sidebar/)
  assert.ok(!normalize.includes('.click('), 'host chrome is changed only through native input')
  assert.match(normalize, /keyboardFocus\('Focus Decision navigation for visual audit'/)
  assert.match(normalize, /keyboardKey\('Restore Decision page top for visual audit', 'Home'\)/)
  const audit = driver.match(/async function layoutAudit\(name, theme = 'light', zoom = 1\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  for (const evidence of ['mainRegionProblems(candidate)', 'mainRegionProblems(audit)', 'elementsFromPoint', 'hitTestSamples', 'hostNavigation', 'navigationActions', 'primaryActions', 'weir-da-page-header']) assert.ok(audit.includes(evidence), evidence)
  assert.ok(audit.includes('if(right<left||bottom<top)return'), 'wholly offscreen regions produce zero samples instead of out-of-viewport hit-tests')
  assert.ok(!audit.includes('points.push([left,top]'), 'rounded CSS corners are not misclassified as foreign occlusion')
  for (const inset of ['value.left+8', 'value.right-8', 'value.top+8', 'value.bottom-8']) assert.ok(audit.includes(inset), `centerlines retain an 8px edge inset: ${inset}`)
})

test('keyboard selector audits precede native pending and retain long-case visual coverage', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const keyboard360 = /await instance\.cdp\.setViewport\(360\)\s*await keyboardSelector\(sessionId, secondary\.agentId\)\s*await keyboardSelector\(sessionId, 'auto'\)\s*await keyboardSelector\(sessionId, primary\.agentId\)/.exec(driver)
  assert.ok(keyboard360, 'Agent, Auto, and Agent keyboard flows all run together at 360px')
  const longAsk = driver.indexOf('const longCase = await askLongNative(sessionId)')
  const themeAudit = driver.indexOf("for (const theme of ['light', 'dark'])", longAsk)
  const zoomAudit = driver.indexOf('await layoutAudit(`zoom200-${width}`', longAsk)
  const answer = driver.indexOf("await answerInboxWithSuggestions(sessionId, longCase.caseId, '18-long-inbox')", longAsk)
  assert.ok(longAsk > keyboard360.index, 'the keyboard-only flow finishes before native pending hides the composer')
  assert.ok(!driver.slice(longAsk).includes('await keyboardSelector('), 'no selector keyboard audit is retried against the hidden composer')
  assert.ok(themeAudit > longAsk && zoomAudit > themeAudit && answer > zoomAudit, 'the same pending long Case retains every visual audit before its intended answer')
  assert.equal(driver.match(/const longCase = await askLongNative\(sessionId\)/g)?.length, 1, 'the scenario neither closes nor recreates the long Case to pass')
  const longBody = driver.match(/async function askLongNative\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(longBody.includes("submitMarker(instance, 'GUI_LONG_NATIVE')"), 'the long Case enters through a real unresolved stock tool call')
  assert.ok(!longBody.includes("fixture('askNative'"), 'a direct userQuestions call cannot satisfy current no-wait stock authority binding')
  assert.match(driver, /pending native question hides the composer/i, 'the ordering documents the verified host contract')
})

// Run W1nSiy regression anchor: native ArrowDown selected and closed the radio panel;
// a subsequent Space confirmation has no target and is not part of the product contract.
test('keyboard selector treats directional native selection as the complete activation path', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const body = driver.match(/async function keyboardSelector\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(body, 'keyboardSelector exists')
  assert.ok(!/\.focus\(|\.click\(/.test(body), 'the keyboard audit never substitutes programmatic focus or click')
  assert.match(body, /document\.activeElement\?\.checked/, 'Tab stops at the native radio group current item')
  assert.match(body, /navigation\.targetIndex > navigation\.activeIndex \? 'ArrowDown' : 'ArrowUp'/, 'direction is computed toward the requested target')
  assert.match(body, /const expectedValue = navigation\.values\[expectedIndex\]/, 'each arrow predicts the native selection it must produce')
  assert.match(body, /await instance\.cdp\.key\(direction\)/)
  assert.ok(!body.includes("await instance.cdp.key('Space')"), 'native arrow selection requires no second Space confirmation')
  assert.match(body, /await expectMutation\('setSelector', selectorEnvelope\(sessionId, expectedMode, expectedAgentId\)\)/, 'every native selection has exactly one matching raw mutation')
  assert.match(body, /selected\.selector/, 'the authoritative selector is reread after every native selection')
  assert.match(body, /!document\.querySelector\('#weir-da-selector-panel'\).*document\.activeElement===document\.querySelector/, 'panel closure and trigger focus are observed together')
  assert.ok(body.includes("mode === 'agent' ? 'keyboardReachesAgentRadio'"), 'the existing Agent keyboard assertion remains')
  assert.ok(body.includes("mode === 'auto' ? 'keyboardReachesAutoRadio'"), 'Auto has the same native keyboard assertion')
  assert.ok(body.includes("mode === 'agent' ? 'keyboardSelectionAndFocusReturn'"), 'the existing authority and focus-return assertion remains')
  const enter = body.indexOf("await instance.cdp.key('Enter')")
  const escape = body.indexOf("await instance.cdp.key('Escape')")
  const tab = body.lastIndexOf("await instance.cdp.key('Tab')")
  const arrow = body.indexOf('await instance.cdp.key(direction)')
  assert.ok(enter >= 0 && escape > enter && tab > escape && arrow > tab, 'Enter/Escape/Tab precede native directional activation')
})

// Run JxliG6 regression anchor: the long native question outlived the inbox decision that
// closed its Case and kept the composer occupied, so GUI_LEARNING_SOURCE never landed. The
// driver now finishes that card with the rendered native Skip, which the Hook routes through
// hookUserAborted — a no-op on the already closed record — and rethrows the native cancel.
test('long native Skip retires the leftover question without touching the closed record', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const answered = driver.indexOf("await answerInboxWithSuggestions(sessionId, longCase.caseId, '18-long-inbox')")
  const skipped = driver.indexOf('await finishLongNativeWithSkip(sessionId, longCase.caseId)')
  const reopened = driver.indexOf('await openSession(instance, sessionId)', skipped)
  const marker = driver.indexOf("await submitMarker(instance, 'GUI_LEARNING_SOURCE')")
  assert.ok(answered >= 0, 'the long inbox decision remains the acceptance step')
  assert.equal(driver.match(/answerInboxWithSuggestions\(sessionId, longCase\.caseId/g)?.length, 1, 'the long Case keeps its one inbox decision')
  assert.ok(skipped > answered, 'the native Skip finishes the Case that the inbox decision closed')
  assert.ok(reopened > skipped && marker > reopened, 'the learning source marker only runs after the native card is retired')

  const step = driver.match(/async function skipLongNativeStep\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(step, 'skipLongNativeStep exists')
  assert.equal(step.match(/instance\.cdp\.evaluate\(/g)?.length, 1, 'one read-only readiness expression precedes each keyboard activation')
  assert.ok(!/setTimeout|sleep\(|delay\(/.test(step), 'the Skip waits by polling, never by an arbitrary sleep')
  assert.match(step, /await nativeState\(\)/, 'the Skip reads the currently visible native question')
  assert.match(step, /el\.offsetParent!==null/, 'readiness is scoped to the visible card')
  assert.match(step, /!el\.disabled/, 'a disabled control is never activated')
  assert.ok(step.includes('/^(跳过|Skip)$/i'), 'only the real localized Skip control is accepted')
  assert.match(step, /await keyboardActivate\('Skip native question', 'button', \{ scope: card, labels: \['跳过', 'Skip'\] \}\)/)
  assert.ok(!/\.click\(|\.focus\(|提交|Submit|下一题|Next/.test(step), 'Skip never falls back to DOM actions or another control')
  const finish = driver.match(/async function finishLongNativeWithSkip\(sessionId, caseId\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(finish, 'finishLongNativeWithSkip exists')
  const before = finish.indexOf("const before = await record(sessionId, 'long-native-skip-before', caseId)")
  const firstSkip = finish.indexOf('await skipLongNativeStep()')
  const after = finish.indexOf("const after = await record(sessionId, 'long-native-skip-after', caseId)")
  assert.ok(before >= 0 && firstSkip > before && after > firstSkip, 'the authoritative record is saved before the Skip and reread after it')
  const session = finish.indexOf('await openSession(instance, sessionId)')
  const firstNativeState = finish.indexOf('await nativeState()')
  const settledWait = finish.indexOf('const settled = await waitFor(async () =>')
  assert.ok(session > before, 'the driver returns to the owning session after saving the authoritative record')
  assert.equal(finish.match(/await openSession\(instance, sessionId\)/g)?.length, 1, 'the driver reopens the owning session exactly once')
  assert.ok(session >= 0 && firstNativeState > session, 'the native card is only read inside the owning session, never on whatever page the inbox step left behind')
  assert.ok(firstSkip > firstNativeState && settledWait > firstSkip && after > settledWait, 'record → openSession → nativeState → Skip → persisted stock tool result → reread is the exact finishing order')
  assert.ok(!/await answerInboxWithSuggestions|await answerNative\(|skipLongNativeStep\(\)\s*\/\//.test(finish), 'the finish step only skips: it never answers or decides the Case again')
  assert.match(finish, /requireEvidence\(before\.case\.state === 'closed'/, 'the Skip only finishes an already decided Case')
  assert.match(finish, /requireEvidence\(steps\.length < \d+/, 'the Skip loop is bounded instead of unbounded')
  assert.match(finish, /const next = await nativeState\(\); return !next\.pending/, 'the driver waits for the real pending state to clear')
  assert.match(finish, /value === 'skipped' \|\| value === 'gone' \? value : null/, 'only a real click or a vanished card ends the wait')
  assert.match(finish, /if \(outcome === 'gone'\) break/, 'a card that disappears mid-wait ends the loop instead of clicking nothing')
  assert.ok(finish.includes("scanSession(sessionId, 'long-native-skip-session.json')"), 'the real native session is scanned after Skip')
  assert.ok(finish.includes("event.type === 'tool/result' && event.callId === stockCall.callId"), 'the exact stock call must have a persisted tool result before the record is compared')
  assert.ok(!finish.includes('__decisionProductLong'), 'no direct-fixture promise state substitutes for stock tool settlement')
  assert.match(finish, /after\.case\.state === 'closed'/, 'the Case is still closed after the Skip')
  assert.match(finish, /after\.case\.revision === before\.case\.revision/, 'the revision is unchanged')
  assert.match(finish, /JSON\.stringify\(after\) === JSON\.stringify\(before\)/, 'the whole record is byte-identical across the no-op')
  assert.ok(finish.includes("check('longNativeSkipKeepsClosedRecord'"), 'the no-op has exactly one named acceptance check')
  assert.match(finish, /await shot\('18b-long-native-skip-closed'\)/, 'the finished card is captured as real PNG evidence')
  assert.ok(!/hookUserAborted\(|broker\.|\.dismiss\(/.test(finish), 'the driver never bypasses the rendered Skip with a broker or store call')
  assert.ok(!/await rpc\(sessionId, [^)]*'(decide|cancel|discard|reopen)'/.test(finish), 'no direct RPC mutation finishes the card')
})

test('product learning candidates cite the real correction and advance beyond their parent', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.match(driver, /const learningCorrection = corrected\.feedback\.find\(item => item\.kind === 'correction'\)/)
  assert.ok(!driver.includes('sources?.[0] === learningSource.caseId'), 'the unrelated learning Case is not the correction candidate source')
  assert.match(driver, /learningSource\.decision\?\.kind === 'user_decision'/, 'the native learning-source decision evidence remains')
  for (const version of ['V1', 'V2', 'V3']) {
    assert.ok(driver.includes(`candidate${version}.run.operations[0]?.sources?.[0] === learningCorrection.feedbackId`), `${version} cites the actual correction Feedback`)
  }
  assert.ok(driver.includes("candidateV1.run.operations[0]?.text === 'Reviewed GUI correction principle: prefer the corrected cross-root answer.'"))
  for (const version of ['V2', 'V3']) {
    assert.ok(driver.includes(`candidate${version}.run.operations[0]?.text === 'Reviewed GUI successor principle: prefer the second source-backed answer.'`), `${version} changes the correction principle into a successor`)
  }
})

// decision-candidate-edit 6.1 anchor: the accepted reviewed version must be reached
// through the rendered review only, and every fact about it must come from an
// authority this driver cannot write.
test('the accepted candidate edit is driven through the real review and read back authoritatively', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const matrix = driver.match(/async function runCandidateEditMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(matrix, 'runCandidateEditMatrix exists')
  const start = matrix.indexOf('candidate = await startCandidate(sessionId, agent, 4)')
  const disabled = matrix.indexOf("writeJson(control, { enabled: false, agentId: agent.agentId })")
  assert.ok(matrix.indexOf("writeJson(control, { enabled: true, agentId: agent.agentId })") >= 0 && start > 0 && disabled > start, 'the two-entry packet is enabled for the real learning start and switched off afterwards')
  assert.match(matrix, /finally \{\s*writeJson\(control/, 'the control file is disabled even when the candidate start fails')
  assert.ok(!/\.click\(|\.focus\(|INSERT INTO|UPDATE memory_snapshots/.test(matrix), 'the review is driven through native keyboard activation and the rendered controls, never a synthetic DOM or SQL write')
  const order = [
    "keyboardActivate('Edit candidate principle'",
    "keyboardFill('Candidate principle wording'",
    "keyboardActivate('Save candidate principle'",
    "expectMutation('snapshotUpdate'",
    "keyboardActivate('Request candidate principle removal'",
    "#weir-da-candidate-remove",
    "keyboardActivate('Confirm candidate principle removal'",
    "expectMutation('snapshotUpdate'",
    "confirmLearning('snapshotPublish'",
    "candidateEditConfirmationProblems(published.userEdits",
    "await openSession(instance, sessionId)",
    "submitMarker(instance, 'GUI_LEARNING_AFTER_V2')",
    'candidateUpdateAuditProblems(',
  ]
  let cursor = -1
  for (const token of order) {
    const at = matrix.indexOf(token, cursor + 1)
    assert.ok(at > cursor, `${token} runs in order`)
    cursor = at
  }
  assert.ok(matrix.includes("edits: [{ principleId: changedEntry.principleId, text: CANDIDATE_EDIT_TEXT, scope: { paths: ['src'] } }]"), 'the save carries the reviewed wording and the staged paths')
  assert.ok(matrix.includes("edits: [{ principleId: addedEntry.principleId, remove: true }]"), 'the removal carries only the id and remove')
  assert.ok(matrix.includes('JSON.stringify(editedRun.operations) === JSON.stringify(reviewedRun.operations)'), 'the learning run operations are compared byte-for-byte')
  assert.ok(matrix.includes('JSON.stringify(editedRun.replay) === JSON.stringify(reviewedRun.replay)'), 'the structural replay is compared byte-for-byte')
  assert.ok(driver.includes('await runCandidateEditMatrix(sessionId, primary, publishedV1)'), 'the chain starts from the still-published v1 parent')
  assert.ok(driver.indexOf('candidateEdit: candidateEdit.publishedSnapshot.snapshotId') > driver.indexOf('const candidateEdit = await runCandidateEditMatrix'), 'the before-restart evidence names the accepted version')
})

// The fixture packet must be a packet the product really accepts: its own parser,
// structural replay and source scope rules decide whether the two-entry candidate
// exists at all. This runs those three real steps instead of trusting the shape.
test('the candidate-edit packet passes the real parser, replay and source scope rules', async () => {
  const { parseConsolidationCandidate, replayOperations, applyConsolidationOperations } = await import('../../weir-harness/src/decision/learning/consolidator.js')
  const parentPrinciples = [{ principleId: 'pr_1', text: 'Reviewed GUI correction principle', scope: { workspaces: ['/ws'] }, sources: ['fb_correction'], state: 'active' }]
  const projection = {
    agentId: 'da_edit', workspaceKey: '/ws',
    cases: [{ caseId: 'dc_source', excerpt: 'Question gui-learning-source: Choose', scope: { workspaces: ['/ws'] } }],
    feedback: [{ feedbackId: 'fb_correction', kind: 'correction', direction: 'Use the corrected direction' }],
    parentSnapshot: { snapshotId: 'ms_v1', revision: 2, principles: parentPrinciples },
  }
  const options = { system: 'Decision consolidation contract v1\nstrict', messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(projection) }] }] }
  const original = JSON.stringify({ operations: [{ op: 'add', principleId: 'temporary-gui-learning', text: 'Reviewed GUI successor principle: prefer the second source-backed answer.', scope: { workspaces: ['/ws'] }, sources: ['fb_correction'] }] })
  const raw = decorateDecisionText(original, options, null, 'da_edit')
  const operations = parseConsolidationCandidate(raw, parentPrinciples)
  assert.equal(operations.length, 2)
  const authority = {
    agentId: 'da_edit', workspaceKey: '/ws', parentPrinciples,
    caseById: { dc_source: { caseId: 'dc_source', workspaceKey: '/ws', scope: { workspaces: ['/ws'] }, closing: 'escalated', feedbackState: 'none', decision: { kind: 'user_decision' } } },
    feedbackById: { fb_correction: { feedbackId: 'fb_correction', caseId: 'dc_source', kind: 'correction' } },
    corrections: { fb_correction: { feedbackId: 'fb_correction', active: true, scope: { workspaces: ['/ws'] } } },
  }
  const replay = replayOperations(parentPrinciples, operations, authority)
  assert.equal(replay.passed, true, JSON.stringify(replay))
  const principles = applyConsolidationOperations(parentPrinciples, operations, authority)
  assert.equal(principles.length, 2, 'one refined parent entry and one added entry')
  assert.equal(principles[0].principleId, 'pr_1')
  assert.equal(principles[0].text, 'Reviewed GUI successor principle: prefer the second source-backed answer under a reviewed class.')
  assert.equal(principles[1].state, 'active')
  assert.ok(principles[1].principleId.startsWith('pr_'), 'the product allocates the real id')
  assert.deepEqual(principles[1].scope, { workspaces: ['/ws'] })
})

// Run 47hAKq regression anchor: global-off UI evidence passed, then the disabled process
// issued learningRun and correctly received DECISION_UNAVAILABLE. Persistence authority
// belongs to a fresh enabled process, never to the disabled-bypass phase.
test('global off bypass and enabled restart persistence run in separate owned processes', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const disabledStart = driver.indexOf('instance = await startDesktop(false)')
  const disabledStop = driver.indexOf("await stopOwned('process-2')", disabledStart)
  assert.ok(disabledStart >= 0 && disabledStop > disabledStart, 'the disabled instance has an exact owned cleanup boundary')
  const disabled = driver.slice(disabledStart, disabledStop)
  assert.doesNotMatch(disabled, /\b(?:rpc|records|record|openAgent|openRecord|compareRecord|waitAgent|waitCase)\(/, 'the disabled phase never calls a disabled Decision read or a helper that performs one')

  const firstOpen = disabled.indexOf('await openSession(instance, sessionId)')
  const selector = disabled.indexOf('await selectorOpen()', firstOpen)
  const explanation = disabled.indexOf("check('globalOffExplainsBypassAndRetainsPinnedSelection'", selector)
  const screenshot = disabled.indexOf("await shot('23-restart-global-off')", explanation)
  const escape = disabled.indexOf("await instance.cdp.key('Escape')", screenshot)
  const reopened = disabled.indexOf('await openSession(instance, sessionId)', escape)
  const marker = disabled.indexOf("await submitMarker(instance, 'GUI_C_OFF')", reopened)
  const pending = disabled.indexOf('await waitFor(async () => (await nativeState()).pending, 30_000)', marker)
  const answered = disabled.indexOf("await answerNative('Native Off')", pending)
  const disabledScan = disabled.indexOf("const scanAfter = await scanSession(sessionId, 'session-after-restart.json')", answered)
  const disabledScanCheck = disabled.indexOf("check('restartAddsNoForbiddenSessionEvents', scanAfter.commandEvents.length === 0 && scanAfter.customDecisionEvents.length === 0)", disabledScan)
  const disabledOrder = [firstOpen, selector, explanation, screenshot, escape, reopened, marker, pending, answered, disabledScan, disabledScanCheck]
  assert.ok(disabledOrder.every((index, position) => index >= 0 && (position === 0 || index > disabledOrder[position - 1])), 'disabled open → selector evidence → Escape → native bypass → forbidden-event scan stays ordered')

  const beforeGlobalOff = driver.indexOf('const beforeGlobalOff = await records(sessionId)')
  const firstStop = driver.indexOf("await stopOwned('process-1', { crash: true })")
  assert.ok(beforeGlobalOff >= 0 && beforeGlobalOff < firstStop, 'the enabled authority captures the record count before process 1 stops')
  assert.ok(firstStop >= 0, 'process 1 uses the explicit owned crash boundary for received-intake recovery')

  const enabledStart = driver.indexOf('instance = await startDesktop(true)', disabledStop)
  const enabledStop = driver.indexOf("await stopOwned('process-3')", enabledStart)
  assert.ok(enabledStart > disabledStop && enabledStop > enabledStart, 'a fresh enabled process 3 starts only after disabled process 2 is stopped')
  const enabled = driver.slice(enabledStart, enabledStop)
  const enabledOpen = enabled.indexOf('await openSession(instance, sessionId)')
  const restartedRun = enabled.indexOf("const restartedRun = await rpc(sessionId, 'restart', 'learningRun'", enabledOpen)
  const restartedSnapshot = enabled.indexOf("const restartedSnapshot = await rpc(sessionId, 'restart', 'memorySnapshot'", restartedRun)
  const restartedAgent = enabled.indexOf("const restartedAgent = await rpc(sessionId, 'restart', 'agent'", restartedSnapshot)
  const restartedRecord = enabled.indexOf("const restartedRecord = await record(sessionId, 'restart', learned.caseId)", restartedAgent)
  const persisted = enabled.indexOf("check('restartPersistsLearningFeedbackSelectorAndRecords'", restartedRecord)
  const openedAgent = enabled.indexOf('await openAgent(sessionId, primary.agentId)', persisted)
  const advanced = enabled.indexOf('await openDisclosure(`weir-da-agent-advanced-${primary.agentId}`)', openedAgent)
  const restartShot = enabled.indexOf("await shot('24-restart-learning-persisted')", advanced)
  const openedRecord = enabled.indexOf('await openRecord(sessionId, learned.caseId)', restartShot)
  const compared = enabled.indexOf("await compareRecord(sessionId, 'restart-record', learned.caseId, true)", openedRecord)
  const afterGlobalOff = enabled.indexOf('const afterGlobalOff = await records(sessionId)', compared)
  const sameCount = enabled.indexOf("check('globalOffCreatesNoNewCase', afterGlobalOff.records.length === beforeGlobalOff.records.length)", afterGlobalOff)
  const finalScan = enabled.indexOf("await scanSession(sessionId, 'session-after-enabled-restart.json')", sameCount)
  const finalScanCheck = enabled.indexOf('enabledRestartAddsNoForbiddenSessionEvents', finalScan)
  const enabledOrder = [enabledOpen, restartedRun, restartedSnapshot, restartedAgent, restartedRecord, persisted, openedAgent, advanced, restartShot, openedRecord, compared, afterGlobalOff, sameCount, finalScan, finalScanCheck]
  assert.ok(enabledOrder.every((index, position) => index >= 0 && (position === 0 || index > enabledOrder[position - 1])), 'enabled open → four authority rereads → original assertions/UI comparisons → count comparison → final scan stays ordered')
  assert.ok(enabled.includes("restartedRun.outcome === 'rejected' && restartedRun.revision === rejectedV3.run.revision"), 'the original learning-run persistence assertions remain')
  assert.ok(enabled.includes("restartedSnapshot.state === 'draft' && restartedSnapshot.revision === rejectedV3.snapshot.revision"), 'the original snapshot persistence assertions remain')
  // The accepted reviewed version is what a restart must read back as current.
  assert.ok(enabled.includes('restartedAgent.currentSnapshotId === candidateEdit.publishedSnapshot.snapshotId'), 'the current-snapshot assertion follows the accepted reviewed version')
  assert.ok(enabled.includes('JSON.stringify(restartedRecord) === JSON.stringify(learnedDetail)'), 'the original whole-record persistence assertion remains')

  const matrix = driver.match(/async function runProductMatrix\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(matrix, 'the original matrix is separate from preflight-only startup')
  assert.deepEqual([...matrix.matchAll(/instance = await startDesktop\((true|false)\)/g)].map(match => match[1]), ['true', 'false', 'true', 'true'], 'the successful path owns enabled, disabled, a fresh enabled restart, and the cross-workspace instance')
  assert.deepEqual([...matrix.matchAll(/await stopOwned\('process-(\d)'(?:, \{ crash: true \})?\)/g)].map(match => match[1]), ['1', '2', '3'], 'all three instances have exact owned cleanup receipts')
  assert.match(driver, /check\(`\$\{label\}ExactOwnedCleanup`, receipt\.pass/, 'each owned cleanup retains its named acceptance check')
  for (const log of ['desktop-enabled.log', 'desktop-disabled.log']) assert.ok(driver.includes(`'${log}'`), `${log} is included in the import scan`)
  assert.match(driver, /const importFailures = desktopLogs\.flatMap\(/, 'runtime import failures are scanned across both log modes')
})

test('product driver preserves all legacy AX groups and derives the expanded P4 requirements', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const capture = driver.match(/async function captureAccessibility\(name, selector\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(capture, 'a single capture helper owns every AX collection')
  assert.match(capture, /accessibility\[name\] = await instance\.cdp\.accessibility\(selector\)/, 'every capture owns its complete target subtree')
  assert.match(capture, /writeJson\(join\(out, 'accessibility\.json'\), accessibility\)/, 'every capture is durable before later scenario steps')
  const requirements = driver.match(/const accessibilityRequirements = \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(requirements.includes("nativeDecision: { role: 'group', name: '' }"), 'the source-verified pending native option-group semantics stay unchanged')
  for (const name of ['selectorTrigger', 'selectorPanel', 'longRecord', 'snapshotPublishDialog', 'snapshotRejectDialog', 'snapshotRollbackDialog', 'nativeDecision', 'unownedDecision', 'routingReview', 'routingStatus', 'cancelDecisionDialog']) {
    assert.ok(requirements.includes(`${name}:`), `${name} has an explicit AX requirement`)
  }
  assert.match(driver, /const requiredGroups = Object\.keys\(accessibilityRequirements\)/)
  assert.match(driver, /missingGroups\.length === 0 && unexpectedGroups\.length === 0/)
  assert.ok(!/completeAccessibilityEvidence[^\n]*=== 6/.test(driver), 'the old hardcoded six-group acceptance count is gone')
  assert.match(driver, /Object\.keys\(accessibility\)\.length/, 'the report count comes from the persisted object rather than a hard-coded claim')
  const answered = driver.indexOf("await answerInboxWithSuggestions(sessionId, longCase.caseId, '18-long-inbox')")
  const opened = driver.indexOf('await openRecord(sessionId, longCase.caseId)', answered)
  const captured = driver.indexOf("await captureAccessibility('longRecord'", answered)
  const finished = driver.indexOf('await finishLongNativeWithSkip(sessionId, longCase.caseId)', captured)
  assert.ok(answered >= 0 && opened > answered && captured > opened && finished > captured, 'longRecord AX reads the still-rendered authoritative record after inbox closure')
})
test('native AX group evidence comes from the pending multi-select stock question', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const scenario = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/src/scenarios/decision-gui.js'), 'utf8')
  assert.match(scenario, /product-long-choice[\s\S]*?multi_select: true/, 'the real stock long question is the source-verified native group surface')
  assert.equal(driver.match(/await captureAccessibility\('nativeDecision'/g)?.length, 1, 'single-select pending cases cannot occupy the multi-select AX slot')
  const finish = driver.match(/async function finishLongNativeWithSkip\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const capture = finish.indexOf("await captureAccessibility('nativeDecision'")
  const skip = finish.indexOf('await skipLongNativeStep()')
  assert.ok(finish.includes('长中文题面'), 'the capture waits for the actual long stock question rather than a generic pending card')
  assert.ok(capture >= 0 && skip > capture, 'the pending native group is captured before any native Skip settles it')
  const settle = driver.match(/async function settleNativeSkip\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(!settle.includes("captureAccessibility('nativeDecision'"), 'single-select native Skip does not overwrite group evidence')
})

test('P4 acceptance owns the full real matrix, raw evidence, crash recovery, restoration, and cleanup', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  for (const token of [
    'runP4BeforeRestart', 'runP4AfterRestart', 'auditP4RawEvidence',
    'freshRootsDefaultToPersistedAuto', 'restartPreservesAutoExplicitOffAndLegacyNoRowOff',
    'answerSwitchOffRoutesOwnedAuthorityWithoutAttempt', 'zeroCandidatesNoRouteOrAttempt',
    'oneCandidateDeterministicAllGates', 'stockClasslessSelectedRouteHasNoDerivedClassAndAllGates',
    'ambiguityHasCandidatesConflictAndNoAttempt', 'invalidOutputFailureHasNoOwnerOrAttempt',
    'timeoutFailureHasNoOwnerOrAttempt', 'explicitConsultPrioritizesSecondaryWithoutChangingAuto',
    'shadowOnOffIdenticalActualOutcomeAndHistoryExceptAppendOnlyDiagnostic',
    'routingReviewFirstPageHasExactlyTwentyRealItems', 'routingPaginationAppendsRealRecordsWithoutDuplicates',
    'interruptedReceivedIntakeRecoversWaitingWithoutRouteOrAttempt',
    'stockSessionAndWireProveRealClasslessClassificationWithoutInjectionOrLeakage',
    'sqliteReadModelAndRouteJoinAgreeWithoutExtraAttempts', 'everyTemporaryAgentArchivedThroughRealProfileSetState',
    'testOwnedSelectorsAndSettingsRestored', 'allOwnedProcessesAndPortFinallyReleased', 'nativeKeyPacketsPersisted',
  ]) assert.ok(driver.includes(token), token)
  const hold = driver.indexOf("await waitFor(() => existsSync(join(out, 'it-root', 'decision-auto-interruption.ready'))")
  const crash = driver.indexOf("await stopOwned('process-1', { crash: true })")
  const snapshot = driver.indexOf("sqliteSnapshot('p4-interrupted-before-crash')")
  assert.ok(hold >= 0 && crash > hold && snapshot > crash, 'the owned crash immediately follows the held Router ready marker; SQLite is read only after the process stops')
  const heldWindow = driver.slice(hold, crash)
  assert.ok(!heldWindow.includes('waitCase') && !heldWindow.includes('record('), 'no authority RPC can race the 150ms Router timeout before the crash')
  const holdRoot = driver.indexOf("mkdirSync(join(out, 'it-root'), { recursive: true })")
  assert.ok(holdRoot >= 0 && holdRoot < hold, 'the Desktop run creates the hold-marker root before any Router hold')
  assert.match(driver, /await openIsolatedSession\(p4State\.autoSession\)\s*await submitMarker\(instance, 'GUI_AUTO_INTERRUPT'\)/, 'the held interruption uses the existing Auto session without changing the pinned session used by global-off checks')
  assert.match(driver, /record\(state\.autoSession, 'p4-interrupted-after-restart'/, 'restart authority reads the interrupted Case in its owning Auto session')
  assert.match(driver, /process\.kill\(mainPid, 'SIGKILL'\)/)
  assert.match(driver, /process\.kill\(hostPid, 'SIGKILL'\)/)
  const stopBody = driver.slice(driver.indexOf('async function stopOwned('), driver.indexOf('function saveKeyboardAudits()'))
  const mainSignal = stopBody.indexOf("process.kill(mainPid, 'SIGKILL')")
  const networkCollection = stopBody.indexOf('await collectNetwork(value)')
  assert.ok(mainSignal >= 0 && networkCollection > mainSignal, 'crash signals the owned main PID before any asynchronous network collection')
  assert.ok(stopBody.indexOf('const mainPid = value.app.pid') < mainSignal && stopBody.indexOf('const before =') < mainSignal, 'ownership identity and liveness are captured synchronously before SIGKILL')
  assert.match(driver, /knownSessionIds\.has\(sessionId\)/, 'raw authority reads are limited to run-created sessions')
  assert.ok(driver.includes('Allow automatic answers'), 'the Auto answer permission is entered through the rendered switch')
  assert.ok(!driver.includes('data-decision-class'), 'the retired A/B/C chips are not addressed anymore')
  assert.ok(!driver.includes('input#plugin-config-weir-settings-decisionAgentAutoAnswerClasses'), 'the retired whitelist text input is not addressed anymore')
  assert.match(driver, /keyboardSelect\('Change routing review window', 'select\[data-routing-window\]', '24h'\)/, 'Desktop changes to the first real non-default window before its controlled select starts loading')
  assert.ok(!driver.includes("keyboardSelect('Change routing review window', 'select[data-routing-window]', '7d')"), 'the known intermediate-onChange 7d prefix path is not retained')
  assert.ok(driver.includes('input#plugin-config-weir-settings-decisionAgentAnswerTimeoutMs'), 'the held interruption uses the real timeout setting input')
  assert.match(driver, /setAutoSettings\('p4-interruption-window', \{ answerTimeoutMs: 30000 \}\)/, 'only the held interruption receives an explicit bounded longer window')
  assert.match(driver, /setAutoSettings\('p4-restored', \{ shadow: false, autoAnswer: false, answerTimeoutMs: 150 \}\)/, 'final real-UI restoration includes the original 150ms timeout')
  assert.match(driver, /compareRoutingReview\(reviewSession, 'p4-routing-before-visuals', allAgain\)/, 'a fresh session mount compares to its authoritative first page')
  assert.ok(!driver.includes("compareRoutingReview(reviewSession, 'p4-routing-before-visuals', combined)"), 'the prior expanded page is not expected after a fresh mount')
  const agentStateBody = driver.match(/async function agentState\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const owningSession = agentStateBody.indexOf('await openIsolatedSession(sessionId, true)')
  const agentPage = agentStateBody.indexOf('await openAgent(sessionId, agentId)')
  assert.ok(owningSession >= 0 && agentPage > owningSession, 'Agent state actions restore their owning session before opening the management page')
})

test('P4 Desktop settings default closed and forward only explicit isolated overrides', t => {
  const keys = ['WEIR_DECISION_GUI_SELECTOR_DEFAULT', 'WEIR_DECISION_GUI_SHADOW', 'WEIR_DECISION_GUI_AUTO_ANSWER']
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] } })
  const paths = { home: '/isolated/root/home', profile: '/isolated/root/home/profiles/desktop', electronData: '/isolated/root/electron-data' }
  for (const key of keys) delete process.env[key]
  const conservative = appEnvironment(paths, '/isolated/root/out', true)
  assert.equal(conservative.WEIR_DECISION_GUI_SELECTOR_DEFAULT, 'off')
  assert.equal(conservative.WEIR_DECISION_GUI_SHADOW, '0')
  assert.equal(conservative.WEIR_DECISION_GUI_AUTO_ANSWER, '0')
  process.env.WEIR_DECISION_GUI_SELECTOR_DEFAULT = 'auto'
  process.env.WEIR_DECISION_GUI_SHADOW = '1'
  process.env.WEIR_DECISION_GUI_AUTO_ANSWER = '1'
  const enabled = appEnvironment(paths, '/isolated/root/out', true)
  assert.equal(enabled.WEIR_DECISION_GUI_SELECTOR_DEFAULT, 'auto')
  assert.equal(enabled.WEIR_DECISION_GUI_SHADOW, '1')
  assert.equal(enabled.WEIR_DECISION_GUI_AUTO_ANSWER, '1')
  const patch = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-fixture/cordis.patch.yml'), 'utf8')
  for (const token of ['decisionAgentSelectorDefault', 'decisionAgentAutoShadow', 'decisionAgentAutoAnswer', 'WEIR_DECISION_GUI_SELECTOR_DEFAULT', 'WEIR_DECISION_GUI_SHADOW', 'WEIR_DECISION_GUI_AUTO_ANSWER']) assert.ok(patch.includes(token), token)
})

test('selector requests and authoritative rereads distinguish Off Auto and Agent exactly', async () => {
  const lib = await import('../spikes/decision/gui-product-lib.mjs')
  assert.equal(typeof lib.selectorEnvelope, 'function')
  assert.equal(typeof lib.selectorMatches, 'function')
  assert.deepEqual(lib.selectorEnvelope('root', 'off'), { sessionId: 'root', mode: 'off' })
  assert.deepEqual(lib.selectorEnvelope('root', 'auto'), { sessionId: 'root', mode: 'auto' })
  assert.deepEqual(lib.selectorEnvelope('root', 'agent', 'ag_1'), { sessionId: 'root', mode: 'agent', agentId: 'ag_1' })
  assert.throws(() => lib.selectorEnvelope('root', 'agent'), /agentId/)
  assert.throws(() => lib.selectorEnvelope('root', 'other'), /mode/)
  assert.equal(lib.selectorMatches({ mode: 'auto' }, 'auto'), true)
  assert.equal(lib.selectorMatches({ mode: 'auto', agentId: null }, 'auto'), true)
  assert.equal(lib.selectorMatches({ mode: 'auto', agentId: 'ag_wrong' }, 'auto'), false)
  assert.equal(lib.selectorMatches({ mode: 'agent', agentId: 'ag_1' }, 'agent', 'ag_1'), true)
  assert.equal(lib.selectorMatches({ mode: 'off', agentId: 'ag_stale' }, 'off'), false)
})

test('immutable audit rejects RouteDecision rewrites and disappearance across SQLite phases', () => {
  const route = { route_decision_id: 'rd_1', case_id: 'dc_1', root_session_id: 'root', mode: 'auto', chosen: 'ag_1', reason: 'selected', candidates_json: '[]', ambiguity_json: null }
  const before = { phase: 'before', rows: { route_decisions: [route] } }
  assert.deepEqual(immutableChanges([before, { phase: 'same', rows: { route_decisions: [route] } }]), [])
  assert.deepEqual(immutableChanges([before, { phase: 'rewrite', rows: { route_decisions: [{ ...route, chosen: 'ag_2' }] } }]), [{ kind: 'route', id: 'rd_1', phase: 'rewrite' }])
  assert.deepEqual(immutableChanges([before, { phase: 'missing', rows: { route_decisions: [] } }]), [{ kind: 'route-missing', id: 'rd_1', phase: 'missing' }])
})

test('P4 driver exposes native Auto selection routing review and classless stock evidence seams', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const fixture = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-fixture/index.js'), 'utf8')
  const selector = driver.match(/async function selectorChoose\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const keyboard = driver.match(/async function keyboardSelector\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  for (const body of [selector, keyboard]) {
    assert.ok(body.includes('selectorEnvelope('), 'both native selector paths share exact envelopes')
    assert.ok(body.includes('selectorMatches('), 'both native selector paths use the authoritative predicate')
  }
  assert.ok(!/expectedValue === 'off' \? 'off' : 'agent'/.test(`${selector}\n${keyboard}`), 'Auto is not misclassified as Agent')
  assert.ok(driver.includes("'routingReview'"), 'authorized read-only RPC includes routingReview')
  assert.ok(driver.includes("'route_decisions'"), 'SQLite snapshots include immutable RouteDecision rows')
  for (const selector of ['section[data-routing-review]', 'select[data-routing-window]', '[data-routing-status]', 'article[data-routing-case]', '[data-routing-record]', '[data-routing-load-more]', '.weir-da-route-history']) assert.ok(driver.includes(selector), selector)
  assert.ok(fixture.includes("'decisionConfig'"), 'fixture reads effective Decision settings')
  assert.ok(fixture.includes('stock-tool-calls.jsonl'), 'raw pre-Hook stock tool arguments are durable')
  assert.ok(fixture.includes('event.data'), 'session scans retain raw stock tool-call evidence')
  assert.ok(driver.includes("typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data?.arguments"), 'session stock evidence parses the persisted JSON argument string without discarding the raw event')
  assert.ok(!/fixture\('askNative'[\s\S]{0,300}GUI_AUTO_/.test(driver), 'stock Auto proof never uses fixture askNative')
  const unowned = driver.match(/async function unownedInbox\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const disclosure = unowned.indexOf("await openDisclosure(`weir-da-inbox-routes-${caseId}`)")
  const routeReady = unowned.indexOf('const routeReady = await waitFor(')
  const domRead = unowned.indexOf('const dom = await instance.cdp.evaluate(')
  assert.ok(disclosure >= 0 && routeReady > disclosure && domRead > routeReady, 'inbox RouteDecision history finishes loading before its DOM is asserted')
  for (const surface of ['card', 'inbox']) assert.ok(unowned.includes(`weir-da-${surface}-routes-`), `${surface} route history opens through its real disclosure path`)
  assert.ok(unowned.includes('weir-da-card-more-'), 'the card route history lives inside the grouped more-details disclosure')
  assert.ok(!unowned.includes('weir-da-card-recovery-'), 'the redundant conversation recovery expansion is gone')
  const recovery = unowned.indexOf('await openDisclosure(`weir-da-recovery-${caseId}`)')
  assert.ok(recovery > routeReady && domRead > recovery, 'the actual inbox recovery controls render before no-retry is asserted')
  const selectorOpenBody = driver.match(/async function selectorOpen\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(selectorOpenBody, /正在加载判断记录|Loading decision/i, 'selector opening waits for the real overview loading state to clear')
})

test('startup isolation contract rejects current App P0 roots ports and foreign Decision stores', async () => {
  const qa = await import('../spikes/decision/gui-qa.mjs')
  assert.equal(typeof qa.startupIsolationProblems, 'function')
  const root = '/lane/.weir/decision-product-ux/desktop-fresh'
  const valid = {
    root, port: 9468, mainPid: 100, databasePath: `${root}/home/weir/profiles/desktop/decisions/decision.db`,
    paths: { home: `${root}/home`, profile: `${root}/home/profiles/desktop`, electronData: `${root}/electron-data` },
    host: { pid: 101, parentPid: 100, profile: { home: `${root}/home`, name: 'desktop' }, env: { HOME: `${root}/home`, DSH_HOME: `${root}/home` } },
    processArgs: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --remote-debugging-port=9468 --remote-debugging-address=127.0.0.1 --user-data-dir=/lane/.weir/decision-product-ux/desktop-fresh/electron-data',
  }
  assert.deepEqual(qa.startupIsolationProblems(valid), [])
  for (const port of [9442, 9451, 52011]) assert.match(qa.startupIsolationProblems({ ...valid, port, processArgs: valid.processArgs.replace('9468', String(port)) }).join('\n'), /forbidden.*port/i)
  assert.match(qa.startupIsolationProblems({ ...valid, root: '/current/app' }, { currentRoots: ['/current/app'] }).join('\n'), /current App/i)
  assert.match(qa.startupIsolationProblems({ ...valid, root: '/lane/.weir/decision-qa/desktop-a' }).join('\n'), /P0/i)
  assert.match(qa.startupIsolationProblems({ ...valid, databasePath: '/current/app/decision.db' }).join('\n'), /Decision DB/i)
  assert.match(qa.startupIsolationProblems({ ...valid, host: { ...valid.host, parentPid: 999 } }).join('\n'), /owned Host/i)
})

test('minimal P4 startup smoke keeps provenance runtime gates and exact owned cleanup', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(driver.includes('WEIR_DECISION_PRODUCT_PREFLIGHT_ONLY'))
  assert.ok(driver.includes("runStartupPreflight"), 'a separate minimal mode avoids running the 9.2–9.3 matrix')
  const smoke = driver.match(/async function runStartupPreflight\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  for (const token of ['preflight.json', 'host.json', 'instance.json', 'runtime-scan.json', 'stopOwned(', 'noRuntimeExceptionsConsoleErrorsOrSlotCrashes']) assert.ok(driver.includes(token), token)
  assert.ok(smoke.includes("stopOwned('preflight')"), 'the smoke has an exact-PID/port cleanup receipt')
  assert.ok(!smoke.includes('submitMarker('), 'startup proof does not masquerade as the behavioral matrix')
})

test('record route history compares authoritative count and immutable timestamps', async () => {
  const lib = await import('../spikes/decision/gui-product-lib.mjs')
  assert.equal(typeof lib.routeHistoryProblems, 'function')
  const detail = { case: { caseId: 'dc_1' }, routeDecisions: [
    { routeDecisionId: 'rd_1', createdAt: '2026-01-01T00:00:00.000Z' },
    { routeDecisionId: 'rd_2', createdAt: '2026-01-02T00:00:00.000Z' },
  ] }
  const dom = { routeHistory: [
    { text: 'Auto · selected', createdAt: '2026-01-01T00:00:00.000Z' },
    { text: 'Manual reassign · selected', createdAt: '2026-01-02T00:00:00.000Z' },
  ] }
  assert.deepEqual(lib.routeHistoryProblems(detail, dom), [])
  assert.match(lib.routeHistoryProblems(detail, { ...dom, routeHistory: dom.routeHistory.slice(1) }).join('\n'), /count/)
  assert.match(lib.routeHistoryProblems(detail, { ...dom, routeHistory: [dom.routeHistory[0], { ...dom.routeHistory[1], createdAt: '2026-01-03T00:00:00.000Z' }] }).join('\n'), /timestamp/)
  const numeric = { case: { caseId: 'dc_numeric' }, routeDecisions: [{ createdAt: 1794282129137 }] }
  assert.deepEqual(lib.routeHistoryProblems(numeric, { routeHistory: [{ text: 'Pinned', createdAt: '1794282129137' }] }), [], 'numeric RPC timestamps equal their DOM dateTime strings')
  assert.match(lib.routeHistoryProblems(numeric, { routeHistory: [{ text: 'Pinned', createdAt: '1794282129138' }] }).join('\n'), /timestamp/)
})

test('memory zone guard requires both zones, ordinary copy and no fabricated public hit', () => {
  const good = {
    zones: { public: true, workspace: true },
    headings: ['公共记忆', '当前工作区经验'],
    guidance: '公共记忆只是经审阅的指导，不是判断依据：自动回答仍需要当前工作区的依据。',
    privateIsolation: '私有经验只在记录它的当前工作区可读。',
    text: '公共记忆 当前工作区经验 当前已发布的公共版本',
    navigation: ['inbox', 'records', 'agents'],
    controls: [{ text: '采用公共原则' }, { text: '放弃候选' }, { text: '恢复前序公共版本' }],
    status: { present: true, role: 'status', live: 'polite' },
    disclosure: { required: false, acknowledge: false },
    candidate: { present: true, aliases: ['origin_aaaaaaaaaaaa'], replay: 'passed', adopt: true, discard: true, readableLinks: 0, adoptOnRender: false },
    current: { version: '1', rollback: true },
  }
  assert.deepEqual(memoryZoneProblems(good), [])
  const leaking = { ...good, workspacePaths: ['/Users/young/Documents/Orrery'], text: '/Users/young/Documents/Orrery 公共记忆' }
  assert.ok(memoryZoneProblems(leaking).some(problem => /workspace path/.test(problem)), 'a realpath must be rejected')
  const fourNav = { ...good, navigation: ['inbox', 'records', 'agents', 'metrics'] }
  assert.ok(memoryZoneProblems(fourNav).some(problem => /three primary navigation/.test(problem)))
  const autoPublish = { ...good, controls: [{ text: '自动发布公共原则' }] }
  assert.ok(memoryZoneProblems(autoPublish).some(problem => /automatic publication/.test(problem)))
  const gatedWithCandidate = { ...good, disclosure: { required: true, acknowledge: true }, candidate: { present: true } }
  assert.ok(memoryZoneProblems(gatedWithCandidate).some(problem => /before the disclosure/.test(problem)))
  const foreignLink = { ...good, candidate: { ...good.candidate, readableLinks: 1 } }
  assert.ok(memoryZoneProblems(foreignLink).some(problem => /never offer foreign record navigation/.test(problem)))
  const missingGuidance = { ...good, guidance: '公共记忆' }
  assert.ok(memoryZoneProblems(missingGuidance).some(problem => /not evidence/.test(problem)))
})

test('cross-workspace guard requires shared identity, private isolation and honest Auto', () => {
  const denial = (method, extra = {}) => method === 'record'
    ? { method, shape: 'null', returnedNull: true, bodyLeaked: false, ...extra }
    : { method, shape: 'error', code: 'OUT_OF_SCOPE', bodyLeaked: false, audit: { recorded: true, action: 'boundary-reject', code: 'OUT_OF_SCOPE', idsOnly: true }, ...extra }
  const good = {
    workspaces: [
      { label: 'W1', assistantNames: ['ag_shared:Shared'], publicVersion: 1, privateRecordIds: ['c1'], navigation: ['inbox', 'records', 'agents'], text: 'no path' },
      { label: 'W2', assistantNames: ['ag_shared:Shared'], publicVersion: 1, privateRecordIds: ['c2'], navigation: ['inbox', 'records', 'agents'], text: 'no path' },
      { label: 'W3', assistantNames: ['ag_shared:Shared'], publicVersion: 1, privateRecordIds: [], navigation: ['inbox', 'records', 'agents'], text: 'no path' },
    ],
    workspacePaths: ['/repo/one', '/repo/two'],
    denials: [denial('record'), denial('learningRun'), denial('memorySnapshot')],
    autoShare: { selectorAccepted: true, answered: false, awaitingReason: 'authority' },
  }
  assert.deepEqual(crossWorkspaceShareProblems(good), [])
  assert.ok(crossWorkspaceShareProblems({ ...good, workspaces: [good.workspaces[0]] }).some(problem => /at least two/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, workspaces: [good.workspaces[0], { ...good.workspaces[1], assistantNames: ['ag_other:Other'] }, good.workspaces[2]] }).some(problem => /same assistant identities/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, workspaces: [good.workspaces[0], { ...good.workspaces[1], privateRecordIds: ['c1'] }, good.workspaces[2]] }).some(problem => /never be readable across/.test(problem)))
  // The public version must be the one each workspace really rendered.
  assert.ok(crossWorkspaceShareProblems({ ...good, workspaces: good.workspaces.map(item => ({ ...item, publicVersion: null })) }).some(problem => /placeholder/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, workspaces: [good.workspaces[0], { ...good.workspaces[1], publicVersion: 2 }, good.workspaces[2]] }).some(problem => /same public version/.test(problem)))
  // Denials: an empty list, an unproven read path and a leaked body all fail.
  assert.ok(crossWorkspaceShareProblems({ ...good, denials: [] }).some(problem => /cross-workspace private record denials/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, denials: [denial('record')] }).some(problem => /never exercised learningRun/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, denials: [denial('record'), denial('learningRun')] }).some(problem => /never exercised memorySnapshot/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, denials: [{ method: 'record', shape: 'value', returnedNull: false, bodyLeaked: true }] }).some(problem => /leaked body text/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, denials: [{ method: 'record', shape: 'value', returnedNull: false, bodyLeaked: false }] }).some(problem => /did not fail closed/.test(problem)))
  // A silent null is only legal for the record query, never for a learning read.
  assert.ok(crossWorkspaceShareProblems({ ...good, denials: [denial('record'), denial('learningRun'), { method: 'memorySnapshot', shape: 'null', returnedNull: true, bodyLeaked: false }] }).some(problem => /must not silently return an empty body/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, denials: [denial('record'), denial('learningRun', { code: 'CASE_FOUND', audit: { recorded: true, action: 'boundary-reject', code: 'CASE_FOUND', idsOnly: true } }), denial('memorySnapshot')] }).some(problem => /did not fail closed/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, denials: [denial('record'), denial('learningRun', { audit: { recorded: false, action: null, code: 'OUT_OF_SCOPE', idsOnly: false } }), denial('memorySnapshot')] }).some(problem => /not audited with ids and state only/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, denials: [denial('record'), denial('learningRun', { audit: { recorded: true, action: 'boundary-reject', code: 'OUT_OF_SCOPE', idsOnly: false } }), denial('memorySnapshot')] }).some(problem => /not audited with ids and state only/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, autoShare: { selectorAccepted: true, answered: true, attemptCount: 0, citedEvidenceCount: 0 } }).some(problem => /real current-workspace Attempt|current-workspace evidence/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, workspaces: [good.workspaces[0], { ...good.workspaces[1], text: '/repo/one' }, good.workspaces[2]] }).some(problem => /workspace path/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, autoShare: { selectorAccepted: true, answered: false, awaitingReason: 'answered' } }).some(problem => /fail closed/.test(problem)))
  // An evidence-free workspace escalates: the product's real exhausted shape is legal.
  assert.deepEqual(crossWorkspaceShareProblems({ ...good, autoShare: { selectorAccepted: true, answered: false, attemptCount: 1, citedEvidenceCount: 0, lastAttemptOutcome: 'escalate', awaitingReason: 'exhausted' } }), [])
  assert.ok(crossWorkspaceShareProblems({ ...good, autoShare: { selectorAccepted: true, answered: false, attemptCount: 1, citedEvidenceCount: 2, lastAttemptOutcome: 'escalate', awaitingReason: 'exhausted' } }).some(problem => /must not carry cited evidence/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, autoShare: { selectorAccepted: true, answered: false, attemptCount: 1, citedEvidenceCount: 0, lastAttemptOutcome: 'answer', awaitingReason: null } }).some(problem => /fail closed/.test(problem)))
  assert.ok(crossWorkspaceShareProblems({ ...good, autoShare: { selectorAccepted: false, answered: true, attemptCount: 1, citedEvidenceCount: 1, lastAttemptOutcome: 'answer' } }).some(problem => /Auto path/.test(problem)))
})

test('legacy live surface guard requires identity, private ownership, an empty public zone and no history rewrite', () => {
  const expected = {
    agentIds: ['ag_one_w1', 'ag_one_w2', 'ag_suffixed', 'ag_archived'],
    names: { ag_one_w1: 'copy-tone', ag_one_w2: 'copy-tone · 3', ag_suffixed: 'copy-tone · 2', ag_archived: 'Retired' },
    privateWorkspaceKey: '/repo/one', privateSnapshotId: 'ms_w1',
    privateLearningRunId: 'lr_w1', attemptPinSnapshotId: 'ms_w1', ownerAgentId: 'ag_one_w1',
  }
  const auditReceipt = { recorded: true, action: 'boundary-reject', code: 'OUT_OF_SCOPE', idsOnly: true }
  const denials = [
    { method: 'memorySnapshot', shape: 'error', code: 'OUT_OF_SCOPE', bodyLeaked: false, audit: auditReceipt },
    { method: 'learningRun', shape: 'error', code: 'OUT_OF_SCOPE', bodyLeaked: false, audit: auditReceipt },
  ]
  const agents = [
    { agentId: 'ag_one_w1', name: 'copy-tone', state: 'enabled', revision: 3, hasWorkspaces: false },
    { agentId: 'ag_one_w2', name: 'copy-tone · 3', state: 'enabled', revision: 3, hasWorkspaces: false },
    { agentId: 'ag_suffixed', name: 'copy-tone · 2', state: 'enabled', revision: 3, hasWorkspaces: false },
    { agentId: 'ag_archived', name: 'Retired', state: 'archived', revision: 3, hasWorkspaces: false },
  ]
  const capture = {
    agents: agents.map(agent => ({ ...agent })), renderedIds: ['ag_one_w1', 'ag_one_w2', 'ag_suffixed', 'ag_archived'],
    ownerAgentId: 'ag_one_w1', currentSnapshotId: null,
    public: { currentVersion: null, candidate: false, publishedSnapshots: 0, learningRuns: 0 },
    pageText: 'copy-tone copy-tone · 2 Retired',
    snapshot: { zone: 'workspace', namespace_workspace_key: '/repo/one' },
    attemptPin: { memorySnapshotId: 'ms_w1' }, denials: denials.map(denial => ({ ...denial })),
  }
  const tables = { cases: { rows: 1, digest: 'a' }, memory_snapshots: { rows: 1, digest: 'b' } }
  const good = {
    expected,
    boot: capture,
    restart: { ...capture, agents: agents.map(agent => ({ ...agent })), denials: denials.map(denial => ({ ...denial })) },
    history: { before: { tables }, afterBoot: { tables }, afterRestart: { tables, integrityCheck: 'ok' } },
    legacyWorkspacePaths: ['/repo/one'],
  }
  assert.deepEqual(legacyLiveSurfaceProblems(good), [])
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, agents: [] } }).some(problem => /never read through the rendered surface/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, expected: { ...expected, agentIds: [...expected.agentIds, 'ag_extra'] } }).some(problem => /missing from the live profile/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, expected: { ...expected, names: { ...expected.names, ag_one_w1: 'renamed' } } }).some(problem => /lost its name/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, renderedIds: ['ag_one_w1'] } }).some(problem => /does not list migrated assistant/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, agents: [{ ...agents[0], hasWorkspaces: true }, ...agents.slice(1)] } }).some(problem => /scopes by workspace membership/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, agents: [agents[0], { ...agents[1], name: 'copy-tone' }, ...agents.slice(2)] } }).some(problem => /distinct display names/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, expected: { ...expected, agentIds: ['ag_one_w1', 'ag_one_w2'] } }).some(problem => /exactly the migrated assistants/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, pageText: 'copy-tone /repo/one' } }).some(problem => /exposes a legacy workspace path/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, public: { ...capture.public, currentVersion: '1' } } }).some(problem => /must not show a public version/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, public: { ...capture.public, publishedSnapshots: 1 } } }).some(problem => /empty public zone/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, attemptPin: { memorySnapshotId: 'ms_other' } } }).some(problem => /Attempt pin/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, snapshot: { zone: 'workspace', namespace_workspace_key: '/repo/two' } } }).some(problem => /private namespace/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, currentSnapshotId: 'ms_w1' } }).some(problem => /foreign workspace must not see/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, denials: [] } }).some(problem => /both private read paths/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, denials: [{ method: 'memorySnapshot', shape: 'value', code: null, bodyLeaked: true, audit: auditReceipt }] } }).some(problem => /did not fail closed/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, boot: { ...capture, denials: [{ ...denials[0], audit: { recorded: false, action: null, code: 'OUT_OF_SCOPE', idsOnly: false } }, denials[1]] } }).some(problem => /not audited with ids and state only/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, restart: { ...capture, agents: [{ ...agents[0], revision: 4 }, ...agents.slice(1)], denials: denials.map(item => ({ ...item })) } }).some(problem => /changed assistant identity/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, restart: { ...capture, agents: agents.map(agent => ({ ...agent })), currentSnapshotId: 'ms_w1', denials: denials.map(item => ({ ...item })) } }).some(problem => /changed private memory visibility/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, restart: { ...capture, agents: agents.map(agent => ({ ...agent })), public: { ...capture.public, learningRuns: 1 }, denials: denials.map(item => ({ ...item })) } }).some(problem => /resurrected public memory/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, restart: { ...capture, agents: agents.map(agent => ({ ...agent })), denials: [] } }).some(problem => /changed the private denial behaviour/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, history: { before: { tables }, afterBoot: { tables }, afterRestart: { tables, integrityCheck: 'broken' } } }).some(problem => /integrity_check/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, history: { before: { tables }, afterBoot: { tables: { cases: { rows: 2, digest: 'c' }, memory_snapshots: tables.memory_snapshots } }, afterRestart: { tables, integrityCheck: 'ok' } } }).some(problem => /cases gained or lost rows/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, history: { before: { tables }, afterBoot: { tables }, afterRestart: { tables: { cases: { rows: 1, digest: 'z' }, memory_snapshots: tables.memory_snapshots }, integrityCheck: 'ok' } } }).some(problem => /cases bytes changed/.test(problem)))
  assert.ok(legacyLiveSurfaceProblems({ ...good, history: {} }).some(problem => /never measured before the live boots/.test(problem)))
})

test('legacy migration guard keeps identity and private history and starts public-empty', () => {
  const report = {
    versions: { before: 1, after: 2 },
    integrityCheck: 'ok',
    rowCounts: { noRowLoss: true },
    recordBytesUnchanged: { cases: true, attempts: true, evidence: true, feedback: true },
    profilesAfterMigration: [{ agentId: 'ag_one_w1', scope: { paths: ['src'] }, legacyOriginAlias: 'origin_aaaaaaaaaaaa', hasWorkspaceKeyField: false }],
    privateMemory: { snapshots: [{ snapshotId: 'ms_w1', zone: 'workspace', namespaceWorkspaceKey: '/repo/one' }], currentOtherWorkspace: null },
    publicZone: { publishedSnapshots: 0, learningRuns: 0, currentPublicSnapshot: null },
    attemptPins: { memorySnapshotId: 'ms_w1' },
    attemptPinSnapshot: { zone: 'workspace' },
    backups: [{ name: 'v1.db', userVersion: 1 }],
  }
  assert.deepEqual(legacyMigratedProfileProblems(report), [])
  assert.ok(legacyMigratedProfileProblems({ ...report, versions: { after: 1 } }).some(problem => /user_version 2/.test(problem)))
  assert.ok(legacyMigratedProfileProblems({ ...report, rowCounts: { noRowLoss: false } }).some(problem => /lose rows/.test(problem)))
  assert.ok(legacyMigratedProfileProblems({ ...report, publicZone: { ...report.publicZone, publishedSnapshots: 1 } }).some(problem => /no published public Snapshot/.test(problem)))
  assert.ok(legacyMigratedProfileProblems({ ...report, privateMemory: { snapshots: [{ snapshotId: 'ms_w1', zone: 'public' }], currentOtherWorkspace: null } }).some(problem => /workspace zone/.test(problem)))
  assert.ok(legacyMigratedProfileProblems({ ...report, attemptPinSnapshot: { zone: 'public' } }).some(problem => /private Snapshot/.test(problem)))
  assert.ok(legacyMigratedProfileProblems({ ...report, backups: [] }).some(problem => /v1 backup/.test(problem)))
  assert.ok(legacyMigratedProfileProblems({ ...report, profilesAfterMigration: [{ agentId: 'ag', scope: { workspaces: ['/repo'] }, hasWorkspaceKeyField: true }] }).length >= 2)
  assert.ok(legacyMigratedProfileProblems({ ...report, currentAppTouched: true, walSidecarsLeft: true }).some(problem => /current App data/.test(problem)))
})

test('the cross-workspace Auto fixture opens the real answer switch first', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const phase = driver.match(/async function runCrossWorkspaceMemoryMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const settings = phase.indexOf("await setAutoSettings(`${phase}-auto`, { shadow: false, autoAnswer: true, answerTimeoutMs: 150 })")
  const marker = phase.indexOf("await submitMarker(instance, 'CROSS_AUTO_Q')")
  assert.ok(settings > 0 && marker > settings, 'the answer switch is opened through the real settings surface before the Auto request')
  assert.ok(phase.includes('autoRecord.case.agentId === shared.agentId'), 'the Auto evidence proves the shared assistant really received the route')
  assert.ok(phase.includes('lastAttemptOutcome'), 'the Auto evidence records the attempt outcome')
})

test('cross-workspace waits return plain data across the CDP boundary', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const phase = driver.match(/async function runCrossWorkspaceMemoryMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(phase, 'the sharing phase exists')
  assert.ok(phase.includes("return Boolean(zone?.querySelector('[data-public-disclosure]'))"), 'the disclosure wait returns a boolean')
  assert.ok(phase.includes("return Boolean(candidate&&candidate.querySelector('[data-public-source]'))"), 'the candidate wait returns a boolean')
  assert.equal(phase.includes('?zone:null'), false, 'no wait may hand a DOM node back through CDP')
})

test('every cross-workspace selector gesture reopens its session first', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const phase = driver.match(/async function runCrossWorkspaceMemoryMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(phase, 'the sharing phase exists')
  for (const session of ['w1.sessionId', 'w2.sessionId', 'w3.sessionId']) {
    assert.ok(phase.includes(`await openIsolatedSession(${session})\n  await selectorChoose(${session}`), `${session}: the selector is only reachable after the session is opened again`)
  }
  // The assistant page hides the composer, so create must be followed by a reopen.
  assert.match(phase, /createAgent\(w1\.sessionId,[\s\S]{0,400}?await openIsolatedSession\(w1\.sessionId\)\n  await selectorChoose\(w1\.sessionId/, 'create is followed by a reopen before the selector gesture')
})

test('the driver imports every guard it calls', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const lib = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product-lib.mjs'), 'utf8')
  const imported = new Set((driver.match(/import \{([^}]+)\} from '\.\/gui-product-lib\.mjs'/) ?? [, ''])[1].split(',').map(name => name.trim()).filter(Boolean))
  const called = [...driver.matchAll(/\b(legacyLiveSurfaceProblems|legacyMigratedProfileProblems|crossWorkspaceShareProblems|memoryZoneProblems|scrollLockProblems|publicGuidancePinProblems|publicWireAttributionProblems|publicCandidateRejectionProblems|publicCandidateBodyProblems|publicCandidateWordingProblems|publicPublishedPrinciplesProblems|publicRecordDetailProblems|publicRefinedWordingProblems|exportConfirmationProblems|exportSuccessSurfaceProblems|exportFailureSurfaceProblems)\b/g)].map(match => match[1])
  for (const name of new Set(called)) {
    assert.ok(imported.has(name), `${name} is called by the driver and must be imported from the lib`)
    assert.ok(lib.includes(`export function ${name}(`), `${name} is really exported by the lib`)
  }
})

test('the P4 candidate fixtures do not rely on workspace-bound eligibility', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const created = driver.indexOf("const foreign = await createAgentWithVisualSettings(foreignSession, 'FOREIGN WORKSPACE PRIVATE PROFILE")
  assert.ok(created > 0, 'the foreign assistant fixture still exists (created through the visual scope/route editor)')
  assert.ok(driver.includes('async function createAgentWithVisualSettings('), 'the visual-scope assistant flow exists')
  const disabled = driver.indexOf("await agentState(foreignSession, foreign.agentId, 'disabled')", created)
  const firstMarker = driver.indexOf('await submitMarker(instance, \'GUI_AUTO_EMPTY\')', created)
  assert.ok(disabled > created && disabled < firstMarker, 'the foreign assistant is switched off through the rendered confirmation before any Auto fixture counts candidates')
  for (const label of ["await agentState(autoSession, primary.agentId, 'disabled')", "await agentState(autoSession, secondary.agentId, 'disabled')"]) {
    assert.ok(driver.includes(label), `${label} still prepares the zero-candidate fixture`)
  }
  assert.ok(driver.includes("check('zeroCandidatesNoRouteOrAttempt'"), 'the zero-candidate check is unchanged')
  assert.ok(driver.includes("check('oneCandidateDeterministicAllGates'"), 'the single-candidate check is unchanged')
})

test('SQLite snapshots accept only the v2 store whose row envelopes stay v1', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const snapshot = driver.match(/function sqliteSnapshot\(phase\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(snapshot, 'sqliteSnapshot exists')
  assert.ok(snapshot.includes("db.prepare('PRAGMA integrity_check')"), 'the snapshot reads the real integrity check')
  assert.ok(snapshot.includes('raw.schemaVersion === 2'), 'the store gate follows the schema-v2 store this change introduces')
  assert.equal(snapshot.includes('raw.schemaVersion === 1'), false, 'a v1 store gate would reject every store the product now opens')
  assert.ok(snapshot.includes('envelopeVersions.every(version => version === 1)'), 'row envelopes must stay schema_version 1')
  assert.ok(driver.includes("const ENVELOPE_TABLES = ['agent_profiles'"), 'the envelope tables are declared once')
})

test('the driver keeps the cross-workspace matrix gated, isolated and lane-local', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const lib = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product-lib.mjs'), 'utf8')
  assert.ok(driver.includes("process.env.WEIR_DECISION_PRODUCT_CROSS_WORKSPACE === '1'"), 'the matrix needs an explicit opt-in flag')
  const phase = driver.match(/async function runCrossWorkspaceMemoryMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(phase, 'runCrossWorkspaceMemoryMatrix exists')
  assert.ok(phase.includes('if (!CROSS_WORKSPACE_MEMORY) return null'), 'the phase never runs in the default matrix')
  assert.ok(phase.includes('legacyMigratedProfileProblems') === false, 'the migrated legacy profile is no longer judged from its fixture report inside the sharing phase')
  // Minor 1: the candidate guard is fed the real workspace paths and foreign ids.
  for (const dom of ['gatedDom', 'candidateDom', 'publishedDom']) {
    assert.ok(phase.includes(`memoryZoneProblems({ ...${dom}, workspacePaths, foreignRecordIds`), `${dom} feeds its workspace paths and foreign record ids into the zone guard`)
  }
  assert.ok(phase.includes('memoryZoneProblems({ ...secondCandidateDom, workspacePaths, foreignRecordIds'), 'the second candidate feeds the same guard')
  assert.ok(phase.includes('crossWorkspaceShareProblems'), 'the shared-identity facts are guarded')
  assert.ok(phase.includes("join(root, 'cross-w1')") && phase.includes("join(root, 'cross-w2')") && phase.includes("join(root, 'cross-w3')"), 'two workspaces plus an evidence-free Auto workspace live inside the isolated root')
  for (const action of ['public-acknowledge', 'public-publish', 'public-rollback']) {
    assert.ok(phase.includes(`[data-action="${action}"]`), `the flow uses the real rendered ${action} control`)
  }
  // The discard and adopt affordances are captured by the shared DOM probe.
  for (const action of ['public-publish', 'public-reject']) assert.ok(driver.includes(`[data-action="${action}"]`), `the DOM probe reads ${action}`)
  assert.ok(phase.includes("networkRpc.filter(entry => entry.method === 'publicMemoryRefresh')"), 'the refresh evidence is the real wire, not a component prop')
  // The shared public version is what each workspace really rendered.
  assert.ok(phase.includes('publicVersions = { w1: Number(publishedDom.current?.version)'), 'the public version is read from the rendered zones')
  assert.ok(phase.includes("check('publicMemoryVersionIsSharedAcrossWorkspaces'"), 'the shared version is its own falsifiable check')
  // Private denials probe both product shapes and keep their audit receipts.
  assert.ok(phase.includes("method: 'learningRun'") && phase.includes("method: 'memorySnapshot'"), 'both private learning read paths are probed')
  assert.ok(driver.includes(".filter(item => item?.type === type && item?.data?.action === 'boundary-reject')"), 'denial receipts are matched to their audit type')
  assert.ok(driver.includes('idsOnly: Object.keys(data).every(key => DENIAL_AUDIT_FIELDS.has(key))'), 'an audit receipt must carry ids and state only')
  assert.ok(lib.includes('const FAIL_CLOSED_CODES = new Set([\'OUT_OF_SCOPE\', \'FORBIDDEN\', \'PERMISSION_DENIED\'])'), 'the guard accepts the product denial codes')
  assert.ok(lib.includes("const NULL_BODY_METHODS = new Set(['record', 'records'])"), 'the guard accepts the empty-body shape only for the record query')
  assert.ok(lib.includes('export function legacyLiveSurfaceProblems'), 'the migrated legacy profile has its own live-surface guard')
  // The migrated database is the live isolated store, booted and restarted for real.
  const legacy = driver.match(/async function runMigratedLegacyProfileSurface\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(legacy, 'runMigratedLegacyProfileSurface exists')
  assert.ok(legacy.includes('stageMigratedLegacyProfile({ root, lane: LANE })'), 'the legacy fixture is staged into the isolated root itself')
  assert.equal(legacy.includes("join(root, 'cross-legacy')"), false, 'no separate legacy root is used')
  assert.equal((legacy.match(/startDesktop\(true\)/g) ?? []).length, 2, 'the migrated profile boots and restarts')
  assert.equal((legacy.match(/await stopOwned\(/g) ?? []).length, 2, 'each migrated boot is stopped by an exact owned cleanup')
  assert.ok(legacy.includes('legacyHistoryDigest()'), 'history rows are measured around the live boots')
  assert.ok(legacy.includes("check('crossWorkspaceLegacyProfileBootsAndRestartsOnTheRealSurface'"), 'the live legacy surface is a real check')
  assert.ok(legacy.includes('legacyLiveSurfaceProblems'), 'the live legacy surface facts are guarded')
  assert.ok(driver.includes('p4State.crossWorkspaceLegacy = await runMigratedLegacyProfileSurface()'), 'the migrated boot is wired into the matrix')
  assert.ok(driver.indexOf('auditP4RawEvidence(p4State, primary, secondary)') < driver.indexOf('p4State.crossWorkspaceLegacy = await runMigratedLegacyProfileSurface()'), 'the migration swap runs after every pre-migration assertion')
  assert.ok(driver.includes('learningRunId: p4State.crossWorkspaceLegacy.expected.privateLearningRunId') && driver.includes('snapshotId: p4State.crossWorkspaceLegacy.expected.privateSnapshotId'), 'the gated phase is wired with private ids that exist in the live migrated store')
  assert.ok(driver.includes('cleanups.length === 6'), 'the matrix now signs off six exact owned process pairs')
  assert.equal(driver.includes('/Users/young'), false, 'the driver never hard-codes a user path')
  assert.equal(phase.includes('startDesktop('), false, 'the sharing phase reuses the live isolated instance and its owned cleanup')
})

test('assistant creation is guarded by the profile-global identity contract, not workspace membership', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.equal(/scope\?\.workspaces\?\.includes\(LANE\)/.test(driver), false, 'no oracle may require a profile to belong to the lane workspace')
  const guard = driver.match(/check\('selectorCreateUsesProfileGlobalIdentity'[^\n]*/)?.[0] ?? ''
  assert.ok(guard, 'the created assistant is still guarded')
  assert.ok(guard.includes("!Object.hasOwn(createdScope, 'workspaces')"), 'the guard rejects a workspace membership field, the shape parseProfileScope no longer writes')
  assert.ok(guard.includes('authorizationClasses'), 'the guard requires the profile-global authorization classes that parseProfileScope always writes')
  assert.ok(guard.includes("primary.name === longName"), 'the guard still proves the new page created this exact assistant')
})

test('reused drivers expect three primary destinations instead of the retired four-view contract', () => {
  for (const [file, token] of [
    ['gui-c.mjs', 'exactlyThreePrimaryDestinations'],
    ['gui-memory.mjs', 'threePrimaryDestinationsAndNoFutureControls'],
  ]) {
    const source = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision', file), 'utf8')
    assert.ok(source.includes(token), `${file} carries the repaired navigation contract`)
    assert.equal(/main nav button"\)\.length === 4/.test(source), false, `${file} no longer expects four navigation buttons`)
  }
  for (const file of ['gui-learning.mjs', 'gui-qa.mjs']) {
    const source = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision', file), 'utf8')
    assert.equal(source.includes('nav.length === 4'), false, `${file} no longer expects four navigation actions`)
    assert.equal(source.includes('length === 4'), false, `${file} no longer expects four navigation buttons`)
  }
  const learning = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-learning.mjs'), 'utf8')
  assert.ok(learning.includes('nav.length === 3'), 'gui-learning pins the three-destination contract')
})

test('public guidance guard accepts a real pinned guidance-only Attempt and rejects every drift', () => {
  const published = { snapshotId: 'ms_public_1', version: 1, revision: 2, contentHash: 'a'.repeat(64) }
  const attempt = {
    outcome: 'escalate',
    citedEvidenceIds: null,
    evidence: [{ source: 'user_profile', evidenceId: 'ev_profile' }],
    pins: {
      memorySnapshotId: null, memorySnapshotRevision: null, memorySnapshotHash: null,
      publicMemorySnapshotId: 'ms_public_1', publicMemorySnapshotRevision: 2, publicMemorySnapshotHash: 'a'.repeat(64),
    },
    packManifest: {
      evidenceIds: ['ev_profile'],
      memory: {
        L2: { zone: 'workspace', principleIds: [], items: [] },
        publicL2: {
          zone: 'public', status: 'populated', snapshotId: 'ms_public_1', snapshotRevision: 2, snapshotHash: 'a'.repeat(64),
          principleIds: ['pr_public_1'],
          items: [{ principleId: 'pr_public_1', sources: ['origin_aaaaaaaaaaaa', 'origin_bbbbbbbbbbbb'], evidenceIds: [] }],
        },
      },
    },
  }
  assert.deepEqual(publicGuidancePinProblems({ published, attempt }), [])
  assert.ok(publicGuidancePinProblems({ published, attempt: null }).some(problem => /no real Attempt/.test(problem)))
  assert.ok(publicGuidancePinProblems({ published: {}, attempt }).some(problem => /current published public Snapshot is unknown/.test(problem)))
  const driftedPin = { ...attempt, pins: { ...attempt.pins, publicMemorySnapshotId: 'ms_other' } }
  assert.ok(publicGuidancePinProblems({ published, attempt: driftedPin }).some(problem => /did not pin the current published public Snapshot/.test(problem)))
  const driftedRevision = { ...attempt, pins: { ...attempt.pins, publicMemorySnapshotRevision: 1 } }
  assert.ok(publicGuidancePinProblems({ published, attempt: driftedRevision }).some(problem => /did not pin the published public revision/.test(problem)))
  const driftedHash = { ...attempt, pins: { ...attempt.pins, publicMemorySnapshotHash: 'b'.repeat(64) } }
  assert.ok(publicGuidancePinProblems({ published, attempt: driftedHash }).some(problem => /did not pin the published public content hash/.test(problem)))
  const noPublic = { ...attempt, packManifest: { ...attempt.packManifest, memory: { ...attempt.packManifest.memory, publicL2: null } } }
  assert.ok(publicGuidancePinProblems({ published, attempt: noPublic }).some(problem => /no public L2 partition/.test(problem)))
  const emptyPublic = { ...attempt, packManifest: { ...attempt.packManifest, memory: { ...attempt.packManifest.memory, publicL2: { ...attempt.packManifest.memory.publicL2, principleIds: [], items: [] } } } }
  assert.ok(publicGuidancePinProblems({ published, attempt: emptyPublic }).some(problem => /not offered as guidance/.test(problem)))
  const evidenceLink = { ...attempt, packManifest: { ...attempt.packManifest, memory: { ...attempt.packManifest.memory, publicL2: { ...attempt.packManifest.memory.publicL2, items: [{ principleId: 'pr_public_1', sources: [], evidenceIds: ['ev_1'] }] } } } }
  assert.ok(publicGuidancePinProblems({ published, attempt: evidenceLink }).some(problem => /claims evidence ids/.test(problem)))
  const cited = { ...attempt, citedEvidenceIds: ['ms_public_1'] }
  assert.ok(publicGuidancePinProblems({ published, attempt: cited }).some(problem => /cited evidence ids it never validated/.test(problem)))
  const citedPrinciple = { ...attempt, citedEvidenceIds: ['pr_public_1'] }
  assert.ok(publicGuidancePinProblems({ published, attempt: citedPrinciple }).some(problem => /was cited as evidence/.test(problem)))
  const answered = { ...attempt, outcome: 'answer' }
  assert.ok(publicGuidancePinProblems({ published, attempt: answered }).some(problem => /must return or escalate/.test(problem)))
  const privatePin = { ...attempt, pins: { ...attempt.pins, memorySnapshotId: 'ms_private_1' } }
  assert.ok(publicGuidancePinProblems({ published, attempt: privatePin }).some(problem => /pinned a private Snapshot/.test(problem)))
  const privateL2 = { ...attempt, packManifest: { ...attempt.packManifest, memory: { ...attempt.packManifest.memory, L2: { zone: 'workspace', principleIds: ['pr_private_1'], items: [] } } } }
  assert.ok(publicGuidancePinProblems({ published, attempt: privateL2 }).some(problem => /no eligible private principles/.test(problem)))
  const learnedEvidence = { ...attempt, evidence: [...attempt.evidence, { source: 'user_decision', evidenceId: 'ev_learned' }] }
  assert.ok(publicGuidancePinProblems({ published, attempt: learnedEvidence }).some(problem => /beyond the authored assistant profile/.test(problem)))
  const packEvidence = { ...attempt, packManifest: { ...attempt.packManifest, evidenceIds: [...attempt.packManifest.evidenceIds, 'ev_foreign'] } }
  assert.ok(publicGuidancePinProblems({ published, attempt: packEvidence }).some(problem => /outside the authored profile/.test(problem)))
  const noEvidence = { ...attempt, evidence: [], packManifest: { ...attempt.packManifest, evidenceIds: [] } }
  assert.deepEqual(publicGuidancePinProblems({ published, attempt: noEvidence }), [])
})

test('public wire attribution guard requires every gesture under its own workspace session', () => {
  const action = (method, sessionId, extra = {}) => ({ label: `${method}@${sessionId}`, method, expectedSessionId: sessionId, sessionId, rpcId: `rpc-${method}`, responded: true, occurrences: 1, ...extra })
  const binding = (sessionId, bound = sessionId) => ({ label: `page@${sessionId}`, sessionId, attempts: [{ attempt: 1, bound }] })
  const actions = [
    action('publicMemoryRefresh', 's1'), action('publicMemoryRefresh', 's4'),
    action('publicCandidate', 's1'), action('publicCandidate', 's4'),
    action('snapshotPublish', 's1'), action('snapshotReject', 's4'), action('snapshotRollback', 's1'),
  ]
  const bindings = [binding('s1'), binding('s4')]
  assert.deepEqual(publicWireAttributionProblems({ actions, bindings }), [])
  assert.ok(publicWireAttributionProblems({ actions: [], bindings }).some(problem => /no UI-triggered public RPC/.test(problem)))
  assert.ok(publicWireAttributionProblems({ actions: actions.filter(item => item.method !== 'snapshotReject'), bindings }).some(problem => /no UI gesture exercised snapshotReject/.test(problem)))
  // The review finding: the gesture carried W2 while the intended page was W1.
  assert.ok(publicWireAttributionProblems({ actions: actions.map(item => item.method === 'snapshotPublish' ? { ...item, sessionId: 's2' } : item), bindings }).some(problem => /instead of the intended workspace session/.test(problem)))
  assert.ok(publicWireAttributionProblems({ actions: actions.map(item => ({ ...item, sessionId: 's9' })), bindings }).some(problem => /instead of the intended workspace session/.test(problem)))
  assert.ok(publicWireAttributionProblems({ actions: actions.map(item => item.method === 'publicCandidate' ? { ...item, rpcId: null } : item), bindings }).some(problem => /no raw rpc id/.test(problem)))
  assert.ok(publicWireAttributionProblems({ actions: actions.map(item => item.method === 'snapshotRollback' ? { ...item, responded: false } : item), bindings }).some(problem => /no captured response payload/.test(problem)))
  assert.ok(publicWireAttributionProblems({ actions: actions.map(item => ({ ...item, sessionId: 's1', expectedSessionId: 's1' })), bindings }).some(problem => /one workspace session only/.test(problem)))
  assert.ok(publicWireAttributionProblems({ actions, bindings: [binding('s1')] }).some(problem => /never re-opened per workspace/.test(problem)))
  // A page that never bound to its own workspace cannot vouch for any action.
  assert.ok(publicWireAttributionProblems({ actions, bindings: [binding('s1'), binding('s4', 's1')] }).some(problem => /never bound to its own workspace session/.test(problem)))
})

test('public candidate rejection guard keeps the published version and demands both audit lines', () => {
  const candidate = { snapshotId: 'ms_candidate_v2', learningRunId: 'lr_candidate_v2' }
  const beforeCurrent = { snapshotId: 'ms_public_v1', version: 1, revision: 2 }
  const afterCurrent = { snapshotId: 'ms_public_v1', version: 1, revision: 2 }
  const audit = [
    { kind: 'learning-run', action: 'start', outcome: 'running', learningRunId: 'lr_candidate_v2', rootSessionId: 's4' },
    { kind: 'learning-run', outcome: 'rejected', learningRunId: 'lr_candidate_v2', rootSessionId: 's4' },
    { kind: 'snapshot', action: 'reject', snapshotId: 'ms_candidate_v2', rootSessionId: 's4' },
  ]
  const good = { sessionId: 's4', wireSessionId: 's4', candidate, beforeCurrent, afterCurrent, runOutcome: 'rejected', runId: 'lr_candidate_v2', snapshotState: 'draft', domVersion: 1, domCandidatePresent: false, auditSessionId: 's4', audit }
  assert.deepEqual(publicCandidateRejectionProblems(good), [])
  assert.ok(publicCandidateRejectionProblems({ ...good, wireSessionId: 's2' }).some(problem => /did not carry the intended workspace session/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, auditSessionId: 's2' }).some(problem => /audit belongs to another workspace/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, runOutcome: 'candidate' }).some(problem => /non-rejected learning run/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, runOutcome: null }).some(problem => /non-rejected learning run/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, runId: 'lr_other' }).some(problem => /not the reviewed candidate run/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, snapshotState: 'published' }).some(problem => /no longer a draft/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, afterCurrent: null }).some(problem => /published public version disappeared/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, afterCurrent: { ...afterCurrent, snapshotId: 'ms_other' } }).some(problem => /replaced the current public Snapshot/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, afterCurrent: { ...afterCurrent, version: 2 } }).some(problem => /changed the current public version/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, afterCurrent: { ...afterCurrent, revision: 3 } }).some(problem => /changed the current public revision/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, afterCurrent: { snapshotId: 'ms_candidate_v2', version: 2, revision: 1 } }).some(problem => /became the current public version/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, domVersion: 2 }).some(problem => /no longer renders the previous published version/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, domCandidatePresent: true }).some(problem => /still offered for review/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, audit: audit.filter(line => line.kind !== 'learning-run' || line.outcome !== 'rejected') }).some(problem => /rejected learning run has no audit line/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, audit: audit.filter(line => line.kind !== 'snapshot') }).some(problem => /rejected Snapshot has no audit line/.test(problem)))
  assert.ok(publicCandidateRejectionProblems({ ...good, candidate: {} }).some(problem => /never identified/.test(problem)))
})

test('candidate body guard rejects workspace paths and foreign record ids', () => {
  const clean = {
    present: true,
    text: '待你审阅的候选\n涉及的工作区数: 3 · 来源条数: 3\norigin_39e1ded167dc · 1 · 来自其他工作区（只读概览）\nAnswer cross-w1-source: Documented option',
    workspacePaths: ['/repo/cross-w1', '/repo/cross-w4'],
    foreignRecordIds: ['dc_feebc83f-20e3-4eb3-96b4-95a987acc293', 'ms_w1'],
    aliases: ['origin_39e1ded167dc', 'origin_8c3ba8df843a'],
  }
  assert.deepEqual(publicCandidateBodyProblems(clean), [])
  assert.ok(publicCandidateBodyProblems({ ...clean, present: false }).some(problem => /no candidate body was rendered/.test(problem)))
  assert.ok(publicCandidateBodyProblems({ ...clean, text: '  ' }).some(problem => /candidate body was empty/.test(problem)))
  assert.ok(publicCandidateBodyProblems({ ...clean, text: `${clean.text}\n/repo/cross-w1` }).some(problem => /workspace path/.test(problem)))
  assert.ok(publicCandidateBodyProblems({ ...clean, text: `${clean.text}\ndc_feebc83f-20e3-4eb3-96b4-95a987acc293` }).some(problem => /foreign record id/.test(problem)))
  assert.ok(publicCandidateBodyProblems({ ...clean, text: `${clean.text}\n/Users/young/secret` }).some(problem => /absolute path/.test(problem)))
  assert.ok(publicCandidateBodyProblems({ ...clean, aliases: ['workspace-one'] }).some(problem => /non-opaque source label/.test(problem)))
})

test('public candidate wording guard requires the reviewed text in ordinary language', () => {
  const principleId = 'pr_reviewed_1'
  const wording = 'Prefer the documented option both workspaces agreed on.'
  const frozenInput = '本次审阅的冻结输入: 涉及的工作区数 2 · 来源条数 2'
  const clean = {
    rpc: {
      changes: [{ op: 'add', principleId, text: wording, scope: { tags: ['release'] } }],
      principles: [{ principleId, text: wording, scope: { tags: ['release'] } }],
      current: [],
    },
    dom: {
      present: true,
      text: `待你审阅的候选\n新增原则 · ${principleId}\n拟定原则文本: ${wording}\n适用范围: release\n${frozenInput}\n采用公共原则\n放弃候选`,
      changes: [{ op: 'add', label: `新增原则 · ${principleId}`, text: wording, scope: '适用范围: release' }],
      frozenInput,
    },
    expectedOps: ['add'],
    workspacePaths: ['/repo/cross-w1'],
    foreignRecordIds: ['dc_foreign'],
    aliases: ['origin_abcdef123456'],
  }
  const failing = (domPatch = {}, rpcPatch = {}, auditPatch = {}) => publicCandidateWordingProblems({
    ...clean, ...auditPatch,
    rpc: { ...clean.rpc, ...rpcPatch },
    dom: { ...clean.dom, ...domPatch },
  })
  assert.deepEqual(publicCandidateWordingProblems(clean), [])
  // The reviewed wording itself must be rendered exactly, after whitespace collapse.
  assert.ok(failing({ changes: [{ ...clean.dom.changes[0], text: 'A different wording.' }] }).some(problem => /instead of the reviewed wording/.test(problem)))
  // A raw id instead of the wording is not a review.
  assert.ok(failing({ changes: [{ ...clean.dom.changes[0], text: principleId }] }).some(problem => /instead of the reviewed wording/.test(problem)))
  // The operation is labelled in ordinary language, never `add · id`.
  assert.ok(failing({ changes: [{ ...clean.dom.changes[0], label: `add · ${principleId}` }] }).some(problem => /not labelled in ordinary language/.test(problem)))
  assert.ok(failing({ changes: [{ ...clean.dom.changes[0], label: principleId }] }).some(problem => /not labelled in ordinary language/.test(problem)))
  assert.ok(failing({ changes: [{ ...clean.dom.changes[0], label: '新增原则' }] }).some(problem => /does not identify the reviewed principle/.test(problem)))
  assert.ok(failing({ changes: [{ ...clean.dom.changes[0], label: '' }] }).some(problem => /renders no operation label/.test(problem)))
  // A scope hint the change really carries must be rendered; an invented one fails.
  assert.ok(failing({ changes: [{ ...clean.dom.changes[0], scope: '' }] }).some(problem => /omits the scope hint/.test(problem)))
  assert.ok(failing({ changes: [{ ...clean.dom.changes[0], scope: '适用范围: release' }] }, { changes: [{ op: 'add', principleId, text: wording, scope: {} }], principles: [{ principleId, text: wording, scope: {} }] }).some(problem => /does not carry/.test(problem)))
  // The wording falls back to the candidate principle (narrow) and to the
  // published principle a retire removes, exactly as the product does.
  assert.deepEqual(publicCandidateWordingProblems({
    ...clean,
    rpc: { changes: [{ op: 'narrow', principleId, scope: {} }], principles: [{ principleId, text: wording, scope: {} }], current: [] },
    dom: { ...clean.dom, changes: [{ op: 'narrow', label: `收窄原则 · ${principleId}`, text: wording, scope: '' }] },
    expectedOps: ['narrow'],
  }), [])
  assert.deepEqual(publicCandidateWordingProblems({
    ...clean,
    rpc: { changes: [{ op: 'retire', principleId, scope: {} }], principles: [], current: [{ principleId, text: wording, scope: {} }] },
    dom: { ...clean.dom, changes: [{ op: 'retire', label: `废止原则 · ${principleId}`, text: wording, scope: '' }] },
    expectedOps: ['retire'],
  }), [])
  // With no readable wording anywhere the candidate cannot be reviewed.
  assert.ok(publicCandidateWordingProblems({ ...clean, rpc: { changes: [{ op: 'add', principleId, scope: {} }], principles: [], current: [] } }).some(problem => /carries no readable wording/.test(problem)))
  // A change count or operation drift is never silently accepted.
  assert.ok(failing({ changes: [] }).some(problem => /lists 0 changes instead of the reviewed 1/.test(problem)))
  assert.ok(failing({}, { changes: [{ op: 'refine', principleId, text: wording, scope: { tags: ['release'] } }] }).some(problem => /renders operation add instead of refine/.test(problem)))
  assert.ok(publicCandidateWordingProblems({ ...clean, expectedOps: ['refine'] }).some(problem => /carries no refine operation/.test(problem)))
  // B3 leak scan: no frozen input, source id, path or raw JSON in the review.
  assert.ok(failing({ text: `${clean.dom.text}\n/repo/cross-w1` }).some(problem => /workspace path/.test(problem)))
  assert.ok(failing({ text: `${clean.dom.text}\ndc_foreign` }).some(problem => /foreign record id/.test(problem)))
  assert.ok(failing({ text: `${clean.dom.text}\nms_1f3e801b0ff6` }).some(problem => /source record id/.test(problem)))
  assert.ok(failing({ text: `${clean.dom.text}\n/Users/young/secret` }).some(problem => /absolute path/.test(problem)))
  assert.ok(failing({ text: `${clean.dom.text}\n{"inputFrozen":{"caseIds":[]}}` }).some(problem => /raw frozen input/.test(problem)))
  assert.ok(failing({ text: `${clean.dom.text}\n{"changes":[{"op":"add"}]}` }).some(problem => /raw JSON/.test(problem)))
  assert.ok(failing({ frozenInput: '' }).some(problem => /renders no frozen-input summary/.test(problem)))
  assert.ok(failing({ frozenInput: '{"workspaceAliases":["a"]}' }).some(problem => /raw input instead of counts/.test(problem)))
  assert.ok(failing({}, {}, { aliases: ['workspace-one'] }).some(problem => /non-opaque source label/.test(problem)))
  assert.ok(failing({ present: false }).some(problem => /no public candidate was rendered/.test(problem)))
})

test('published principles guard requires read-only reviewed wording, not a stale or editable copy', () => {
  const principleId = 'pr_reviewed_1'
  const wording = 'Prefer the documented option both workspaces agreed on.'
  const clean = {
    expected: [{ principleId, text: wording, scope: { tags: ['release'] } }],
    dom: {
      current: { version: '1', rollback: true },
      published: {
        present: true,
        text: `已发布的公共原则\n${wording}\n适用范围: release`,
        principles: [{ principleId, text: wording, scope: '适用范围: release' }],
        controls: [],
      },
    },
    workspacePaths: ['/repo/cross-w1'],
    foreignRecordIds: ['dc_foreign'],
  }
  const failing = (patch = {}) => publicPublishedPrinciplesProblems({ ...clean, ...patch })
  const section = patch => ({ dom: { ...clean.dom, published: { ...clean.dom.published, ...patch } } })
  assert.deepEqual(publicPublishedPrinciplesProblems(clean), [])
  // The published version must carry readable wording at all.
  assert.ok(failing({ expected: [] }).some(problem => /carries no reviewed wording/.test(problem)))
  assert.ok(failing({ expected: [{ principleId, text: '  ', scope: {} }] }).some(problem => /carries no reviewed wording/.test(problem)))
  assert.ok(failing(section({ present: false })).some(problem => /renders no published-principles section/.test(problem)))
  // A stale (superseded) wording or an extra superseded principle fails.
  assert.ok(failing(section({ principles: [{ principleId, text: 'Superseded wording.', scope: '适用范围: release' }] })).some(problem => /instead of its reviewed wording/.test(problem)))
  assert.ok(failing(section({ principles: [...clean.dom.published.principles, { principleId: 'pr_superseded', text: 'Old wording.', scope: '' }] })).some(problem => /does not carry/.test(problem)))
  assert.ok(failing(section({ principles: [] })).some(problem => /does not render principle/.test(problem)))
  // The section is read-only: no publish/reject/rollback control of its own.
  assert.ok(failing(section({ controls: [{ tag: 'BUTTON', text: '采用公共原则', action: 'public-publish' }] })).some(problem => /not read-only/.test(problem)))
  assert.ok(failing(section({ controls: [{ tag: 'BUTTON', text: '放弃候选', action: 'public-reject' }] })).some(problem => /not read-only/.test(problem)))
  assert.ok(failing(section({ controls: [{ tag: 'INPUT', text: '', action: null, editable: true }] })).some(problem => /not read-only/.test(problem)))
  // The zone still renders the version it published.
  assert.ok(failing({ dom: { ...clean.dom, current: null } }).some(problem => /no longer renders its published version/.test(problem)))
  // The published section is not a provenance surface.
  assert.ok(failing(section({ text: `${clean.dom.published.text}\n/repo/cross-w1` })).some(problem => /workspace path/.test(problem)))
  assert.ok(failing(section({ text: `${clean.dom.published.text}\ndc_foreign` })).some(problem => /foreign record id/.test(problem)))
  assert.ok(failing(section({ text: `${clean.dom.published.text}\nms_1f3e801b0ff6` })).some(problem => /source record id/.test(problem)))
  assert.ok(failing(section({ text: `${clean.dom.published.text}\norigin_abcdef123456` })).some(problem => /source alias/.test(problem)))
  assert.ok(failing(section({ text: `${clean.dom.published.text}\n/Users/young/secret` })).some(problem => /absolute path/.test(problem)))
  assert.ok(failing(section({ text: `${clean.dom.published.text}\n{"snapshotId":"ms_1"}` })).some(problem => /raw JSON/.test(problem)))
  assert.ok(failing(section({ text: '' })).some(problem => /rendered nothing/.test(problem)))
  // A scope hint the published version carries must stay readable; an unsafe
  // hint must never be rendered.
  assert.ok(failing(section({ principles: [{ principleId, text: wording, scope: '' }] })).some(problem => /omits the scope hint/.test(problem)))
  assert.ok(publicPublishedPrinciplesProblems({
    ...clean,
    expected: [{ principleId, text: wording, scope: { paths: ['/repo/cross-w1'] } }],
    dom: { ...clean.dom, published: { ...clean.dom.published, principles: [{ principleId, text: wording, scope: '适用范围: /repo/cross-w1' }] } },
  }).some(problem => /path or a record id/.test(problem)))
})

test('refined wording guard discriminates a refined candidate from the still-published text', () => {
  const principleId = 'pr_public_v1'
  const publishedWording = 'Prefer the documented option both workspaces agreed on.'
  const refinedWording = 'Prefer the documented option both workspaces agreed on, and restate that agreed wording before acting on it.'
  const clean = {
    rpc: {
      changes: [{ op: 'refine', principleId, text: refinedWording, scope: {} }],
      principles: [{ principleId, text: refinedWording, scope: {} }],
      current: [],
    },
    dom: { present: true, changes: [{ op: 'refine', label: `改写原则 · ${principleId}`, text: refinedWording, scope: '' }] },
    published: [{ principleId, text: publishedWording, scope: {} }],
  }
  assert.deepEqual(publicRefinedWordingProblems(clean), [])
  // The pre-fix fixture refined with the wording it was already publishing, so a
  // stale render and a refined render were the same pixels.
  const stale = {
    ...clean,
    rpc: { ...clean.rpc, changes: [{ op: 'refine', principleId, text: publishedWording, scope: {} }] },
    dom: { ...clean.dom, changes: [{ ...clean.dom.changes[0], text: publishedWording }] },
  }
  assert.ok(publicRefinedWordingProblems(stale).some(problem => /identical to the wording still published/.test(problem)))
  // A render that keeps the stale published wording fails even when the RPC refused it.
  assert.ok(publicRefinedWordingProblems({ ...clean, dom: { ...clean.dom, changes: [{ ...clean.dom.changes[0], text: publishedWording }] } }).some(problem => /instead of the refined wording/.test(problem)))
  // A candidate without a refine operation cannot prove the leg at all.
  assert.ok(publicRefinedWordingProblems({ ...clean, rpc: { changes: [{ op: 'add', principleId, text: refinedWording, scope: {} }], principles: [], current: [] } }).some(problem => /carries no refine operation/.test(problem)))
  // A refine without wording, a missing published version and an unrendered candidate all fail.
  assert.ok(publicRefinedWordingProblems({ ...clean, rpc: { ...clean.rpc, changes: [{ op: 'refine', principleId, scope: {} }] } }).some(problem => /carries no reviewed wording/.test(problem)))
  assert.ok(publicRefinedWordingProblems({ ...clean, published: [] }).some(problem => /carries no wording to compare/.test(problem)))
  assert.ok(publicRefinedWordingProblems({ ...clean, dom: { present: false, changes: [] } }).some(problem => /no public candidate was rendered/.test(problem)))
  assert.ok(publicRefinedWordingProblems({ ...clean, dom: { present: true, changes: [] } }).some(problem => /lists no refine change/.test(problem)))
})

test('the GUI public consolidation brain refines with wording the review leg can tell apart', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(driver.includes('publicRefinedWordingProblems({ rpc: secondWording.rpc, dom: secondWording.dom, published: publishedPrinciples })'), 'the refine leg is judged against the wording that is still published')
  assert.ok(driver.includes("check('publicSecondCandidateRefinesDistinctWording'"), 'the distinct refine wording is its own falsifiable check')
  const publishedWording = 'Prefer the documented option both workspaces agreed on.'
  const packet = {
    zone: 'public', agentId: 'ag_shared',
    sources: [
      { sourceId: 'dc_w1_source', kind: 'case', alias: 'origin_aaaaaaaaaaaa', excerpt: 'Question cross-w1-source: choose the documented option' },
      { sourceId: 'dc_w2_source', kind: 'case', alias: 'origin_bbbbbbbbbbbb', excerpt: 'Question cross-w2-source: choose the documented option' },
    ],
    parentSnapshot: { snapshotId: 'ms_public_v1', revision: 1, principles: [{ principleId: 'pr_public_v1', text: publishedWording, scope: {}, sources: ['dc_w1_source'], state: 'active' }] },
  }
  const options = { messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(packet) }] }], tools: [], system: PUBLIC_CONSOLIDATION_SYSTEM }
  const block = [...decisionGui.decide(options, extract(options))].filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)[0]
  const [operation] = JSON.parse(block.text).operations
  assert.equal(operation.op, 'refine')
  const published = packet.parentSnapshot.principles
  assert.deepEqual(publicRefinedWordingProblems({
    rpc: { changes: [operation], principles: [], current: [] },
    dom: { present: true, changes: [{ op: 'refine', label: `改写原则 · ${operation.principleId}`, text: operation.text }] },
    published,
  }), [], 'the shipped fixture refines with distinct wording')
  // The pre-fix brain refined with exactly the published wording; that leg must fail.
  assert.ok(publicRefinedWordingProblems({
    rpc: { changes: [{ op: 'refine', principleId: operation.principleId, text: publishedWording, sources: operation.sources }], principles: [], current: [] },
    dom: { present: true, changes: [{ op: 'refine', label: `改写原则 · ${operation.principleId}`, text: publishedWording }] },
    published,
  }).some(problem => /identical to the wording still published/.test(problem)))
})

test('export confirmation guard requires the scope and the real dialog surface', () => {
  const clean = {
    dialog: {
      present: true,
      title: '导出本工作区的决策数据？',
      body: '文件将包含本工作区的判断记录、私有记忆与已发布的公共原则文本，写入本地决策数据目录。导出不会改变或授权任何东西，也无法从应用内还原：本产品不提供导入。',
      buttons: [{ text: '取消' }, { text: '导出数据' }],
    },
    ax: [
      { role: 'dialog', name: '', ignored: false },
      { role: 'button', name: '取消', ignored: false },
      { role: 'button', name: '导出数据', ignored: false },
    ],
  }
  assert.deepEqual(exportConfirmationProblems(clean), [])
  const failing = patch => exportConfirmationProblems({ ...clean, dialog: { ...clean.dialog, ...patch } })
  assert.ok(exportConfirmationProblems({ dialog: {} }).some(problem => /no export confirmation dialog/.test(problem)))
  assert.ok(failing({ title: 'Are you sure?' }).some(problem => /does not name the workspace export/.test(problem)))
  assert.ok(failing({ body: 'It writes a file.' }).some(problem => /changes and authorizes nothing/.test(problem)))
  assert.ok(failing({ body: '只写一个文件。导出不会改变或授权任何东西。' }).some(problem => /no import/.test(problem)))
  assert.ok(failing({ buttons: [{ text: '导出数据' }] }).some(problem => /instead of a confirm and a cancel/.test(problem)))
  assert.ok(exportConfirmationProblems({ ...clean, ax: [] }).some(problem => /not an accessible dialog/.test(problem)))
  assert.ok(exportConfirmationProblems({ ...clean, ax: [{ role: 'button', name: '导出数据', ignored: true }] }).some(problem => /not an accessible dialog/.test(problem)))
})

function exportSuccessFixture() {
  const sha = 'a'.repeat(64)
  return {
    dom: {
      present: true, errorPresent: false,
      file: `文件: /tmp/root/exports/decision-export-origin_abc-1000-deadbeef.json`,
      bytesText: '大小: 2.0 KB', sha256: `校验和: ${sha}`,
    },
    wire: { file: '/tmp/root/exports/decision-export-origin_abc-1000-deadbeef.json', bytes: 2048, sha256: sha, counts: { cases: 2 }, exportedAt: 1000 },
    wireArgs: { sessionId: 'root' },
    file: {
      exists: true, bytes: 2048, mode: '600', directoryMode: '700', sha256: sha,
      envelope: { kind: 'weir-decision-export', formatVersion: 1, integrity: { value: sha }, checksumValid: true, counts: { cases: 2 }, scope: { workspaceAlias: 'origin_abcdef123456' } },
      aliases: { caller: 'origin_abcdef123456', tokens: ['origin_abcdef123456'], foreign: [] },
      containsWorkspaceKey: false, containsAbsolutePath: false,
    },
    focus: { active: true },
  }
}

test('export success guard binds the rendered surface, the wire and the file', () => {
  const clean = exportSuccessFixture()
  assert.deepEqual(exportSuccessSurfaceProblems(clean), [])
  const patch = changes => exportSuccessSurfaceProblems({ ...clean, ...changes })
  assert.ok(patch({ dom: { ...clean.dom, present: false } }).some(problem => /no export success surface/.test(problem)))
  assert.ok(patch({ dom: { ...clean.dom, errorPresent: true } }).some(problem => /success and a failure surface/.test(problem)))
  assert.ok(patch({ dom: { ...clean.dom, file: '文件: /tmp/invented.json' } }).some(problem => /does not show the real path/.test(problem)))
  assert.ok(patch({ wire: { ...clean.wire, bytes: 0 } }).some(problem => /no byte count/.test(problem)))
  assert.ok(patch({ wire: { ...clean.wire, sha256: 'nope' } }).some(problem => /no sha256 checksum/.test(problem)))
  assert.ok(patch({ dom: { ...clean.dom, sha256: '校验和: bbbb' } }).some(problem => /does not show the real checksum/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, exists: false } }).some(problem => /does not exist on disk/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, bytes: 10 } }).some(problem => /file is 10 bytes/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, sha256: 'b'.repeat(64) } }).some(problem => /does not hash to the reported checksum/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, mode: '644' } }).some(problem => /mode is 644/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, directoryMode: '755' } }).some(problem => /directory mode is 755/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, envelope: { kind: 'something-else' } } }).some(problem => /not a versioned decision export envelope/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, envelope: { ...clean.file.envelope, checksumValid: false } } }).some(problem => /checksum does not verify/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, envelope: { ...clean.file.envelope, counts: { cases: 0 } } } }).some(problem => /did not carry the live workspace records/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, containsWorkspaceKey: true } }).some(problem => /real workspaceKey/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, containsAbsolutePath: true } }).some(problem => /carries an absolute path/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, aliases: { ...clean.file.aliases, tokens: ['origin_abcdef123456', 'origin_0123456789ab'], foreign: ['origin_0123456789ab'] } } }).some(problem => /carries other workspaces' aliases: origin_0123456789ab/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, aliases: { caller: 'origin_abcdef123456', tokens: [], foreign: [] } } }).some(problem => /does not carry the exporting workspace alias/.test(problem)))
  assert.ok(patch({ file: { ...clean.file, aliases: undefined } }).some(problem => /not scanned for origin aliases/.test(problem)))
  assert.ok(patch({ wireArgs: { sessionId: 'root', workspaceKey: '/caller/named' } }).some(problem => /instead of only the session/.test(problem)))
  assert.ok(patch({ focus: { active: false } }).some(problem => /focus did not return/.test(problem)))
})

test('export failure guard forbids a success surface and demands an actionable exit', () => {
  const clean = {
    dom: { present: true, successPresent: false, reason: 'exports 目录无法写入。请确认决策数据目录可写后重试。', retry: true },
    filesBefore: 1, filesAfter: 1, focus: { active: true },
  }
  assert.deepEqual(exportFailureSurfaceProblems(clean), [])
  const patch = changes => exportFailureSurfaceProblems({ ...clean, ...changes })
  assert.ok(patch({ dom: { present: false } }).some(problem => /no export failure surface/.test(problem)))
  assert.ok(patch({ dom: { ...clean.dom, successPresent: true } }).some(problem => /still renders a success surface/.test(problem)))
  assert.ok(patch({ dom: { ...clean.dom, reason: '  ' } }).some(problem => /no ordinary-language reason/.test(problem)))
  assert.ok(patch({ dom: { ...clean.dom, reason: 'Something went wrong.' } }).some(problem => /not actionable/.test(problem)))
  assert.ok(patch({ dom: { ...clean.dom, retry: false } }).some(problem => /offers no retry/.test(problem)))
  assert.ok(patch({ filesAfter: 2 }).some(problem => /left 2 files behind/.test(problem)))
  assert.ok(patch({ focus: { active: false } }).some(problem => /focus did not return/.test(problem)))
})

test('the export leg is gated, uses the real controls and verifies the file itself', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(driver.includes("process.env.WEIR_DECISION_PRODUCT_EXPORT !== '1'"), 'the export leg needs an explicit opt-in flag')
  assert.ok(driver.includes('const exportSurface = await runExportSurfaceAcceptance(w4.sessionId)'), 'the leg runs inside the real Desktop matrix on the live workspace session')
  assert.ok(driver.includes("'[data-record-export] [data-action=\"export\"]'"), 'the action is reached through the rendered advanced area')
  assert.ok(driver.includes("'#weir-da-export .weir-da-actions button:last-child'"), 'the confirmation is the rendered dialog')
  assert.ok(driver.includes("waitFor(() => instance.cdp.evaluate(`(() => {\n    const section=document.querySelector('[data-export-result=\"success\"]')"), 'success is read from the rendered surface')
  assert.ok(driver.includes("await shot('export-success')") && driver.includes("await shot('export-failure')"), 'both paths keep screenshots')
  assert.ok(driver.includes('[data-export-result=\"error\"] [data-action=\"export-retry\"]'), 'the retry is reached on the rendered failure surface')
  assert.ok(driver.includes("chmodSync(exportsDir, 0o500)") && driver.includes("chmodSync(exportsDir, 0o700)"), 'the failure path really removes write permission and restores it')
  assert.ok(driver.includes('inspectExportFile(successPayload)'), 'the file is verified from disk, not only from the surface')
  assert.ok(driver.includes("check('exportFileCarriesNoForeignWorkspaceAlias'"), 'the real file may only carry the exporting workspace alias')
  assert.ok(driver.includes('aliases: { caller, tokens, foreign: tokens.filter(token => token !== caller) }'), 'the driver derives the alias facts from the file itself')
  assert.ok(driver.includes("check('exportFailureShowsActionableReasonWithoutSuccess'"), 'the failure path cannot show a success surface')
  assert.ok(driver.includes("check('exportSuccessShowsRealFileBytesAndChecksum'"), 'the success path binds path, bytes and checksum')
  assert.ok(driver.includes('exportConfirmationProblems({ dialog, ax: dialogAx })'), 'the confirmation is judged by its own guard')
})

test('record detail guard requires both partitions and the real public pin', () => {
  const capture = {
    caseId: 'dc_w4', advancedOpen: true,
    publicTitle: '公共记忆', privateTitle: '当前工作区经验',
    publicText: '公共记忆\n状态: 已装入\n{\n  "snapshotId": "ms_public_v1"\n}\npr_public_1\n来源映射',
    privateText: '当前工作区经验\n状态: 未固定版本',
    publicPin: { snapshotId: 'ms_public_v1', snapshotRevision: 2, snapshotHash: 'a'.repeat(64) },
    publicMapping: [{ principleId: 'pr_public_1', evidenceIds: [] }],
    publicPrincipleIds: ['pr_public_1'],
    summary: '本次处理的判断依据\n当前工作区经验: 本次处理未使用经审阅原则。\n公共记忆: 本次处理包含经审阅的公共指导 (1)',
  }
  const expected = { snapshotId: 'ms_public_v1', revision: 2, principleId: 'pr_public_1', workspacePaths: ['/repo/cross-w4'], foreignRecordIds: ['dc_w1'] }
  assert.deepEqual(publicRecordDetailProblems(capture, expected), [])
  assert.ok(publicRecordDetailProblems(null, expected).some(problem => /never read/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, publicTitle: '公共' }, expected).some(problem => /title the public partition/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, privateTitle: '经验' }, expected).some(problem => /title the current workspace partition/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, advancedOpen: false }, expected).some(problem => /must be opened/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, privateText: '' }, expected).some(problem => /rendered nothing/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, publicPin: null }, expected).some(problem => /shows no Snapshot pin/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, publicPin: { snapshotId: 'ms_other', snapshotRevision: 2 } }, expected).some(problem => /real published public pin/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, publicPin: { snapshotId: 'ms_public_v1', snapshotRevision: 1 } }, expected).some(problem => /not the published revision/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, publicPrincipleIds: ['pr_other'] }, expected).some(problem => /does not list the published principle/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, publicMapping: [{ principleId: 'pr_public_1', evidenceIds: ['ev_1'] }] }, expected).some(problem => /maps evidence ids/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, publicMapping: [] }, expected).some(problem => /does not map every listed principle/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, summary: '本次处理的判断依据' }, expected).some(problem => /included as guidance/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, publicText: `${capture.publicText} /repo/cross-w4` }, expected).some(problem => /workspace path/.test(problem)))
  assert.ok(publicRecordDetailProblems({ ...capture, publicText: `${capture.publicText} dc_w1` }, expected).some(problem => /foreign record id/.test(problem)))
})

test('the matrix binds every public gesture to its workspace before acting', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const phase = driver.match(/async function runCrossWorkspaceMemoryMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(phase, 'the sharing phase exists')
  // M4: the page is re-opened and its own read proves the binding before a gesture.
  const binding = driver.match(/async function openDecisionPageForSession\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(binding, 'openDecisionPageForSession exists')
  assert.ok(binding.includes("item.method === 'agents' || item.method === 'inbox'"), 'the binding is read from the page-issued RPC')
  assert.ok(binding.includes('observed.sessionId === sessionId'), 'the page must be bound to the intended workspace session')
  assert.ok(binding.includes('for (let attempt = 1; attempt <= 3; attempt += 1)'), 'a stale capture is re-opened, not accepted')
  // The product keeps its captured session per renderer lifetime: a repeated
  // switch cannot re-bind it, so a stale capture is corrected by a reload.
  assert.ok(binding.includes('if (attempt > 1) await reloadDecisionShell('), 'a stale capture is corrected by reloading the renderer')
  const reload = driver.match(/async function reloadDecisionShell\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(reload, 'reloadDecisionShell exists')
  assert.ok(reload.includes("instance.cdp.request('Page.reload'"), 'the reload is a real renderer reload')
  assert.ok(reload.includes('cross-page-shell-reloads.json'), 'every reload is durable evidence')
  assert.ok(reload.includes('instance.network.completed = new Set()'), 'a reload cannot hide a fresh RPC behind a reused request id')
  assert.ok(binding.includes('pageBindings.push(receipt)'), 'every binding is durable evidence')
  for (const session of ['w1', 'w2', 'w3', 'w4']) {
    assert.ok(phase.includes(`openDecisionPageForSession(${session}.sessionId`), `${session}: the page is re-opened per workspace`)
  }
  // Every public gesture asserts its exact args, including the workspace session.
  for (const [method, session] of [['snapshotPublish', 'w1'], ['snapshotReject', 'w4'], ['snapshotRollback', 'w1']]) {
    assert.ok(phase.includes(`method: '${method}', args: { sessionId: ${session}.sessionId`), `${method} carries the ${session} session on the wire`)
  }
  assert.ok(phase.includes("method: 'publicMemoryRefresh', args: { sessionId: w1.sessionId, agentId: shared.agentId, acknowledgedDisclosure: true }"), 'the first acknowledged refresh is attributed')
  assert.ok(phase.includes('publicWireAttributionProblems({ bindings: pageBindings, actions: publicWires })'), 'the M4 guard judges every gesture and binding')
  assert.ok(phase.includes("check('publicUiActionsCarryTheIntendedWorkspaceSession'"), 'the attribution is its own falsifiable check')
  // B1 runs with the public version live and B2 precedes the rollback-to-empty leg.
  const b1 = phase.indexOf("const w4Case = await waitCase(w4.sessionId, 'CROSS_W1_Q'")
  const b2 = phase.indexOf("await keyboardActivate('Discard public candidate'")
  const rollback = phase.indexOf("await keyboardActivate('Restore previous public version'")
  const rollbackRpc = phase.indexOf("method: 'snapshotRollback'")
  assert.ok(b1 > 0 && b2 > b1 && rollback > b2 && rollbackRpc > rollback, 'order: public guidance Attempt -> second candidate -> rejection -> rollback')
  assert.ok(phase.includes("check('publicGuidanceAttemptPinsPublishedSnapshotWithoutEvidence'"), 'the pinned-guidance Attempt is a real check')
  assert.ok(phase.includes("check('publicGuidanceRecordDetailShowsBothPartitionsWithRealPin'"), 'the dual-partition record detail is a real check')
  assert.ok(phase.includes("check('publicCandidateRejectionKeepsPublishedVersion'"), 'the rejection is a real check')
  assert.ok(phase.includes('publicAuditLines(workspaceFour)'), 'the rejection audit is read from the rejecting workspace')
  assert.ok(phase.includes("const w4Guidance = await waitFor(async () => { const value = await record(w4.sessionId, 'w4-public-attempt', w4Case.caseId)"), 'the Attempt is read from the record detail of the evidence-free workspace')
})

// The driver builds its page expressions as template literals; a raw newline
// inside an injected single-quoted string is a page-level SyntaxError that only
// surfaces mid-run, so every new probe is compiled here first.
test('the injected page probes compile before the real run reaches them', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const templateAfter = marker => {
    const from = driver.indexOf('instance.cdp.evaluate(`', driver.indexOf(marker))
    assert.ok(from > 0, `${marker}: an injected expression exists`)
    const to = driver.indexOf('`)', from)
    assert.ok(to > from, `${marker}: the injected expression closes`)
    return driver.slice(from + 'instance.cdp.evaluate(`'.length, to)
  }
  const memoryZone = templateAfter('async function crossWorkspaceMemoryDom(')
  const memoryExpression = new Function('agentId', `return \`${memoryZone}\``)('ag_compile_check')
  assert.ok(memoryExpression.includes('ag_compile_check'), 'the zone probe interpolates its agent id')
  assert.doesNotThrow(() => new Function('document', `return (${memoryExpression})`), 'the zone probe is valid page source')
  const recordProbe = templateAfter('const recordCapture = await waitFor(')
  const recordExpression = new Function('w4Case', 'w4Attempt', `return \`${recordProbe}\``)({ caseId: 'dc_compile_check' }, { attemptId: 'at_compile_check' })
  assert.ok(recordExpression.includes('dc_compile_check') && recordExpression.includes('at_compile_check'), 'the record probe interpolates its case and attempt ids')
  assert.doesNotThrow(() => new Function('document', `return (${recordExpression})`), 'the record probe is valid page source')
})

// decision-pending-overview 5.1: the bubble and the grouped inbox are judged by
// pure guards, and the driver probes that feed them must stay compilable and
// structurally honest about what they prove.
test('pending bubble guard accepts a real count and rejects a fake one', () => {
  const state = (patch = {}) => ({
    present: true, text: '2', title: '2 项待你决定', svg: true,
    entry: { left: 0, top: 0, width: 16, height: 16, right: 16, bottom: 16 },
    bubble: { left: 10, top: -5, width: 14, height: 14, right: 24, bottom: 9 },
    background: 'rgb(255, 149, 0)', color: 'rgb(0, 0, 0)',
    live: { role: 'status', ariaLive: 'polite', text: '决策助手：2 项待你决定', rect: { width: 1, height: 1 } },
    ...patch,
  })
  assert.deepEqual(pendingBubbleProblems(state(), { count: 2 }), [])
  assert.deepEqual(pendingBubbleProblems(state({ present: false, text: null }), { count: 0 }), [])
  assert.ok(pendingBubbleProblems(state(), { count: 0 }).length > 0, 'a stale bubble cannot claim an empty inbox')
  assert.ok(pendingBubbleProblems(state({ present: false }), { count: 2 }).length > 0, 'a missing bubble fails a non-zero count')
  assert.ok(pendingBubbleProblems(state({ text: '9' }), { count: 12 }).some(problem => problem.includes('9+')), 'above nine truncates')
  assert.deepEqual(pendingBubbleProblems(state({ text: '9+', title: '12 项待你决定' }), { count: 12 }), [])
  assert.ok(pendingBubbleProblems(state({ title: '' }), { count: 2 }).some(problem => problem.includes('title')))
  assert.ok(pendingBubbleProblems(state({ title: 'Needs review' }), { count: 2, language: 'en' }).length > 0, 'the title must be the localized sentence')
  assert.deepEqual(pendingBubbleProblems(state({ text: '2', title: '2 need your decision' }), { count: 2, language: 'en' }), [])
  assert.ok(pendingBubbleProblems(state({ bubble: { left: -2, top: 12, width: 14, height: 14, right: 12, bottom: 26 } }), { count: 2 }).length > 0, 'a bottom-left or clipped badge fails')
  assert.ok(pendingBubbleProblems(state({ live: null }), { count: 2 }).some(problem => problem.includes('live region')))
  assert.ok(pendingBubbleProblems(state({ live: { role: 'alert', ariaLive: 'assertive', text: 'x', rect: { width: 1, height: 1 } } }), { count: 2 }).length > 0)
  assert.ok(pendingBubbleProblems(state({ live: { role: 'status', ariaLive: 'polite', text: 'x', rect: { width: 120, height: 20 } } }), { count: 2 }).length > 0, 'the live region must be visually hidden')
  assert.ok(pendingBubbleProblems(state({ svg: false }), { count: 2 }).length > 0)
})

test('pending overview guard requires one group per source and a switch only across workspaces', () => {
  const groups = [
    { key: 'workspace:w1', label: 'Orrery', count: 1, caseIds: ['dc-1'], heading: 'H2' },
    { key: 'workspace:w2', label: 'Atlas', count: 2, caseIds: ['dc-2', 'dc-3'], heading: 'H2' },
  ]
  const state = (patch = {}) => ({
    groups, switchButtons: [{ by: 'workspace', pressed: 'true', label: '按工作区' }, { by: 'agent', pressed: 'false', label: '按助手' }],
    switchAria: '分组方式', navCount: 3, total: 3, sourceLabels: ['工作区：Orrery', '工作区：Atlas'], horizontalScroll: 0,
    ...patch,
  })
  assert.deepEqual(pendingOverviewProblems(state()), [])
  assert.ok(pendingOverviewProblems(state({ groups: [] })).some(problem => problem.includes('no group')))
  assert.ok(pendingOverviewProblems(state({ switchButtons: [] })).length > 0, 'two workspaces need the switch')
  assert.ok(pendingOverviewProblems({ groups: [groups[0]], switchButtons: [{ by: 'workspace', pressed: 'true', label: '按工作区' }], total: 1, navCount: 1, switchAria: '分组方式' }).some(problem => problem.includes('must not offer')), 'one workspace must not offer the switch')
  assert.deepEqual(pendingOverviewProblems({ groups: [groups[0]], switchButtons: [], total: 1, navCount: 1, sourceLabels: ['工作区：Orrery'], horizontalScroll: 0 }), [])
  assert.ok(pendingOverviewProblems(state({ total: 2 })).some(problem => problem.includes('sum to 3')))
  assert.ok(pendingOverviewProblems(state({ navCount: 5 })).some(problem => problem.includes('navigation count')))
  assert.ok(pendingOverviewProblems(state({ groups: [groups[0], groups[0].key === 'workspace:w1' ? { ...groups[0], caseIds: ['dc-9'] } : groups[0]], switchButtons: [], total: 2, navCount: 2 })).some(problem => problem.includes('share one key')))
  assert.ok(pendingOverviewProblems(state({ groups: [{ ...groups[0], count: 2 }] })).length > 0, 'a count must match its cards')
  assert.ok(pendingOverviewProblems(state({ horizontalScroll: 24 })).some(problem => problem.includes('horizontal scroll')))
  assert.ok(pendingOverviewProblems(state({ sourceLabels: ['工作区：/Users/young/project'] })).some(problem => problem.includes('path')))
  assert.ok(pendingOverviewProblems(state({ switchButtons: [{ by: 'workspace', pressed: 'true', label: '按工作区' }] })).length > 0, 'both dimensions must render')
  assert.ok(pendingOverviewProblems(state({ switchButtons: [{ by: 'workspace', pressed: 'false', label: '按工作区' }, { by: 'agent', pressed: 'false', label: '按助手' }] })).some(problem => problem.includes('pressed')))
})

test('the pending-overview driver probes exist, stay compiled, and pin the real surfaces', () => {
  const driver = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  for (const token of [
    'async function runPendingOverviewMatrix(', 'async function pendingBubbleDom(',
    'data-weir-decision-bubble', 'data-decision-entry', 'data-weir-decision-live', 'data-inbox-group',
    'data-inbox-group-count', 'data-group-by', 'data-inbox-workspace', 'data-delivery-notice',
    "controlDecision(${JSON.stringify({ method: 'decide', action: 'delivery-unavailable' })}",
    "message.source === 'weir-decision'", 'pendingBubbleProblems(twoPending', 'pendingOverviewProblems(twoGroups)',
    'pendingOverviewCrossWorkspaceNeedsNoConfirmation', 'pendingOverviewCrossWorkspaceRulingDelivered',
    'pendingOverviewConclusionReachesSourceSession', 'pendingBubbleDisappearsWhenNothingIsPending',
  ]) assert.ok(driver.includes(token), token)
  assert.ok(driver.includes('await runPendingOverviewMatrix(primary)'), 'the probe runs inside the product matrix')
  // The injected page probes are compiled here: a stray backtick or an
  // unescaped quote only surfaces mid-run otherwise.
  const templateAfter = marker => {
    const from = driver.indexOf('instance.cdp.evaluate(`', driver.indexOf(marker))
    assert.ok(from > 0, `${marker}: an injected expression exists`)
    const to = driver.indexOf('`)', from)
    assert.ok(to > from, `${marker}: the injected expression closes`)
    return driver.slice(from + 'instance.cdp.evaluate(`'.length, to)
  }
  const bubbleProbe = templateAfter('async function pendingBubbleDom(')
  const bubbleExpression = new Function(`return \`${bubbleProbe}\``)()
  assert.ok(bubbleExpression.includes('data-weir-decision-bubble'))
  assert.doesNotThrow(() => new Function('document', `return (${bubbleExpression})`), 'the bubble probe is valid page source')
  const inboxProbe = templateAfter('async function pendingInboxDom(')
  const inboxExpression = new Function(`return \`${inboxProbe}\``)()
  assert.ok(inboxExpression.includes('data-inbox-group-count'))
  assert.doesNotThrow(() => new Function('document', `return (${inboxExpression})`), 'the inbox probe is valid page source')
  const noticeProbe = driver.match(/const notice = await waitFor\(\(\) => instance\.cdp\.evaluate\(`([\s\S]*?)`\), 30_000\)/)?.[1]
  assert.ok(noticeProbe, 'the undelivered-notice probe exists')
  assert.doesNotThrow(() => new Function('document', `return (${noticeProbe.replace(/\\`/g, '`')})`), 'the notice probe is valid page source')
  // The stub is honest: the fixture rewrites only the reported delivery, and the
  // run records it as a stub rather than as the Host's own unavailable branch.
  const fixture = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-fixture/client.js'), 'utf8')
  assert.ok(fixture.includes("'delivery-unavailable'"), 'the fixture owns the delivery stub')
  assert.ok(fixture.includes("closed.delivery = { state: 'unavailable' }"), 'the stub rewrites only the reported delivery')
  assert.ok(driver.includes('stub: true'), 'the evidence names the delivery stub')
  const fixtureHost = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-fixture/index.js'), 'utf8')
  assert.ok(fixtureHost.includes('userMessages'), 'the session scan exposes bounded user messages')
  assert.ok(fixtureHost.includes("event.type === 'user/message'"), 'the scan reads the real user-message event type')
  const guiB = readFileSync(join(REPO_ROOT, 'plugins/weir-test-harness/spikes/decision/gui-b.mjs'), 'utf8')
  assert.ok(guiB.includes('finalInbox.every(item => !scenarioCaseIds.includes(item.caseId))'), 'gui-b scopes its clean-end assertion to its own Cases')
})

// The Decision assistant settings page, as the real isolated Desktop rendered it on
// 2025-11-26 (run probe-1794775355709): the shapes below are captured DOM, so these
// guards are tested against the product's own structure rather than a mock.
const SETTINGS_NAV_ZH = ['通用设置', '模型', '内置插件', 'Agent 预设', 'Weir', 'Weir 模型路由', '决策助手']
const SETTINGS_NAV_EN = ['General', 'Models', 'Built-in plugins', 'Agent presets', 'Weir', 'Weir model routing', 'Decision assistant']
const masterSwitchControl = { tag: 'button', id: null, role: 'switch', label: '决策 Agent', checked: 'true', pressed: null, value: '', disabled: false }
const chipControl = (value, pressed) => ({ tag: 'button', id: null, role: null, label: null, checked: null, pressed, value: '', disabled: false })
const tabControl = value => ({ tag: 'button', id: `plugin-config-weir-settings-decisionAgentSelectorDefault-${value}`, role: 'tab', label: null, checked: null, pressed: null, value: '', disabled: false })
const advancedRow = (tag, control) => ({ tag: 'div', text: 'row', controls: [control] })
const settingsOpenSnapshot = (overrides = {}) => ({
  nav: SETTINGS_NAV_ZH,
  activeNav: '决策助手',
  groups: ['decisionBasics', 'decisionAdvanced'],
  basics: {
    rows: [
      { tag: 'div', text: '决策 Agent\nOff 时不拦截、不咨询、不采样，也不创建数据库（默认关闭）。', controls: [masterSwitchControl, { tag: 'button', id: null, role: null, label: null, checked: null, pressed: null, value: '', disabled: false }] },
      { tag: 'div', text: '新根会话的默认选择\n默认 Off。\nOff\nAuto', controls: [tabControl('off'), tabControl('auto')] },
      { tag: 'div', text: '允许自动回答\n打开后，Auto 的结论只有通过全部证据与授权闸门才会被采纳。', controls: [{ tag: 'button', id: null, role: 'switch', label: '允许自动回答', checked: 'false', pressed: null, value: '', disabled: false }] },
    ],
  },
  advanced: { expanded: 'false', hasToggle: true, body: false, rows: [] },
  answerSwitch: { checked: 'false' },
  saveBar: false,
  ...overrides,
})
const settingsExpandedSnapshot = (overrides = {}) => ({
  ...settingsOpenSnapshot(),
  advanced: {
    expanded: 'true',
    hasToggle: true,
    body: true,
    rows: [
      advancedRow('input', { tag: 'input', id: 'plugin-config-weir-settings-decisionAgentAnswerTimeoutMs', role: null, label: null, checked: 'false', pressed: null, value: '150', disabled: false }),
      advancedRow('input', { tag: 'input', id: 'plugin-config-weir-settings-decisionAgentMaxAttemptsPerCase', role: null, label: null, checked: 'false', pressed: null, value: '3', disabled: false }),
      advancedRow('input', { tag: 'input', id: 'plugin-config-weir-settings-decisionAgentContextBudgetTokens', role: null, label: null, checked: 'false', pressed: null, value: '24000', disabled: false }),
      advancedRow('input', { tag: 'input', id: 'plugin-config-weir-settings-decisionAgentMaxOutputTokens', role: null, label: null, checked: 'false', pressed: null, value: '4096', disabled: false }),
      advancedRow('input', { tag: 'input', id: 'plugin-config-weir-settings-decisionAgentMaxConcurrentAttempts', role: null, label: null, checked: 'false', pressed: null, value: '4', disabled: false }),
      advancedRow('input', { tag: 'input', id: 'plugin-config-weir-settings-decisionAgentRetentionDays', role: null, label: null, checked: 'false', pressed: null, value: '0', disabled: false }),
      advancedRow('button', { tag: 'button', id: null, role: 'switch', label: 'Auto Shadow 诊断', checked: 'false', pressed: null, value: '', disabled: false }),
    ],
  },
  ...overrides,
})

test('decision settings navigation guard requires the third Weir page in order', () => {
  assert.deepEqual(decisionSettingsNavProblems(SETTINGS_NAV_ZH), [])
  assert.deepEqual(decisionSettingsNavProblems(SETTINGS_NAV_EN), [])
  const missing = decisionSettingsNavProblems(['通用设置', 'Weir'])
  assert.equal(missing.length, 2, 'a missing routing page and a missing decision page are both reported')
  assert.ok(missing.some(text => /model-routing/.test(text)) && missing.some(text => /Decision assistant page/.test(text)))
  const swapped = decisionSettingsNavProblems(['Weir', '决策助手', 'Weir 模型路由'])
  assert.ok(swapped.some(text => /before the model-routing page/.test(text)), 'order 42 must follow order 41')
  assert.deepEqual(decisionSettingsNavProblems([]).length, 3)
})

test('decision settings page guard proves three basic rows and a folded advanced group', () => {
  assert.deepEqual(decisionSettingsPageProblems(settingsOpenSnapshot(), { masterEnabled: true }), [])
  const twoRows = settingsOpenSnapshot()
  twoRows.basics.rows = twoRows.basics.rows.slice(0, 2)
  assert.ok(decisionSettingsPageProblems(twoRows, { masterEnabled: true }).some(text => /instead of three/.test(text)))
  const expanded = settingsOpenSnapshot()
  expanded.advanced = { expanded: 'true', hasToggle: true, body: true, rows: [] }
  const problems = decisionSettingsPageProblems(expanded, { masterEnabled: true })
  assert.ok(problems.some(text => /aria-expanded=true/.test(text)) && problems.some(text => /mounts its body/.test(text)), 'the default fold must stay closed')
  const foreignGroup = settingsOpenSnapshot({ groups: ['decisionBasics', 'decisionAdvanced', 'todo'] })
  assert.ok(decisionSettingsPageProblems(foreignGroup, { masterEnabled: true }).some(text => /foreign group/.test(text)))
  // The third basic row is the answer switch: class chips are a regression now.
  const chips = settingsOpenSnapshot()
  chips.basics.rows[2].controls = [{ tag: 'button', pressed: 'true', disabled: false }, { tag: 'button', pressed: 'false', disabled: false }, { tag: 'button', pressed: 'false', disabled: false }]
  assert.ok(decisionSettingsPageProblems(chips, { masterEnabled: true }).some(text => /class chips/.test(text)))
  // master switch off: only its own row survives and the advanced group is gone
  const off = settingsOpenSnapshot({ groups: ['decisionBasics'], basics: { rows: [settingsOpenSnapshot().basics.rows[0]] }, advanced: null })
  assert.deepEqual(decisionSettingsPageProblems(off, { masterEnabled: false }), [])
  const offButAdvanced = settingsOpenSnapshot({ groups: ['decisionBasics', 'decisionAdvanced'], basics: { rows: [settingsOpenSnapshot().basics.rows[0]] } })
  assert.ok(decisionSettingsPageProblems(offButAdvanced, { masterEnabled: false }).some(text => /advanced group still renders/.test(text)))
  const offButTwoRows = settingsOpenSnapshot({ groups: ['decisionBasics'], basics: { rows: settingsOpenSnapshot().basics.rows.slice(0, 2) }, advanced: null })
  assert.ok(decisionSettingsPageProblems(offButTwoRows, { masterEnabled: false }).some(text => /keeps 2 rows/.test(text)))
  const wrongPage = settingsOpenSnapshot({ activeNav: 'Weir' })
  assert.ok(decisionSettingsPageProblems(wrongPage, { masterEnabled: true }).some(text => /mounted settings page is Weir/.test(text)))
})


test('decision settings advanced guard reads the runtime rows against authority', () => {
  assert.deepEqual(decisionSettingsAdvancedProblems(settingsExpandedSnapshot(), { timeoutMs: 150, shadow: false }), [])
  assert.ok(decisionSettingsAdvancedProblems(settingsExpandedSnapshot({ advanced: { expanded: 'false', hasToggle: true, body: false, rows: [] } }), {}).some(text => /aria-expanded=false/.test(text)))
  const wrongTimeout = settingsExpandedSnapshot()
  wrongTimeout.advanced.rows[0].controls[0].value = '60000'
  assert.ok(decisionSettingsAdvancedProblems(wrongTimeout, { timeoutMs: 150 }).some(text => /instead of the authoritative 150/.test(text)))
  const disabled = settingsExpandedSnapshot()
  disabled.advanced.rows[0].controls[0].disabled = true
  assert.ok(decisionSettingsAdvancedProblems(disabled, { timeoutMs: 150 }).some(text => /is disabled/.test(text)))
  const renamed = settingsExpandedSnapshot()
  renamed.advanced.rows[6].controls[0].label = 'Shadow'
  assert.ok(decisionSettingsAdvancedProblems(renamed, {}).some(text => /accessible name Shadow/.test(text)))
  const sixRows = settingsExpandedSnapshot()
  sixRows.advanced.rows = sixRows.advanced.rows.slice(0, 6)
  assert.ok(decisionSettingsAdvancedProblems(sixRows, {}).some(text => /instead of seven/.test(text)))
})

test('decision settings answer-switch guard reads the stored boolean, never a class list', () => {
  assert.deepEqual(decisionSettingsAnswerSwitchProblems({ checked: 'true' }, true), [])
  assert.deepEqual(decisionSettingsAnswerSwitchProblems({ checked: 'false' }, false), [])
  assert.ok(decisionSettingsAnswerSwitchProblems({ checked: 'false' }, true).some(text => /reads false instead of true/.test(text)))
  assert.ok(decisionSettingsAnswerSwitchProblems({ checked: 'true' }, false).some(text => /reads true instead of false/.test(text)))
  assert.ok(decisionSettingsAnswerSwitchProblems({ checked: null }, true).some(text => /carries no checked state/.test(text)))
  assert.ok(decisionSettingsAnswerSwitchProblems(null, true).length === 1)
})


test('decision settings close guard is structural, not a body-text probe', () => {
  assert.deepEqual(decisionSettingsClosedProblems({ dialog: false, groups: [], answerSwitches: 0, advancedToggles: 0, agentEditors: 0 }), [])
  assert.ok(decisionSettingsClosedProblems({ dialog: true, groups: [], answerSwitches: 0, advancedToggles: 0, agentEditors: 0 }).some(text => /dialog is still open/.test(text)))
  assert.ok(decisionSettingsClosedProblems({ dialog: false, groups: ['decisionBasics'], answerSwitches: 1, advancedToggles: 1, agentEditors: 0 }).length === 3, 'a mounted page, its switch and its fold are each reported')
  assert.ok(decisionSettingsClosedProblems({ dialog: false, groups: [], answerSwitches: 0, advancedToggles: 0, agentEditors: 1 }).some(text => /assistant editor/.test(text)))
})


test('assistant editor guard replaces the scope and route JSON boxes with visual controls', () => {
  const staged = {
    textareas: [{ id: 'weir-da-agent-preference-create', agentField: 'preference' }],
    scopeEditors: 1,
    scopePaths: [],
    scopeTags: [],
    scopeClasses: 0,
    scopeAdd: { path: 1, tag: 1 },
    routeEditors: 1,
    routeAdd: 1,
    routeEmpty: 1,
    routeIncomplete: 0,
    rungs: [],
  }
  assert.deepEqual(assistantVisualEditorProblems(staged), [])
  const withJson = { ...staged, textareas: [{ id: 'weir-da-agent-scope-create', agentField: 'scope' }, { id: 'weir-da-agent-preference-create', agentField: 'preference' }] }
  assert.ok(assistantVisualEditorProblems(withJson).some(text => /scope JSON textarea still renders/.test(text)))
  const withRouteJson = { ...staged, textareas: [{ id: 'weir-da-agent-route-create', agentField: 'modelRoute' }, { id: 'weir-da-agent-preference-create', agentField: 'preference' }] }
  assert.ok(assistantVisualEditorProblems(withRouteJson).some(text => /modelRoute JSON textarea still renders/.test(text)))
  const twoBoxes = { ...staged, textareas: [{ id: 'a', agentField: 'preference' }, { id: 'b', agentField: 'name' }] }
  assert.ok(assistantVisualEditorProblems(twoBoxes).some(text => /free-text boxes/.test(text)))
  // A surviving authorization-class chip is the regression this guard catches.
  assert.ok(assistantVisualEditorProblems({ ...staged, scopeClasses: 3 }).some(text => /authorization-class chips/.test(text)))
  const rungPicker = { ...staged, routeEmpty: 0, rungs: [{ index: 0, mode: 'picker', trigger: 'Mock One', remove: true }] }
  assert.deepEqual(assistantVisualEditorProblems(rungPicker), [])
})


test('assistant route picker guard rejects raw dictionary keys', () => {
  // The real isolated Desktop rendered exactly these rows before the decision
  // namespace owned the picker strings: the failure this guard exists for.
  assert.ok(assistantRoutePickerProblems({ trigger: 'modelEmpty', rows: ['pickerModel›', 'pickerEffort›'] }).length === 3)
  assert.deepEqual(assistantRoutePickerProblems({ trigger: '选择模型', rows: ['模型›', '推理›'] }), [])
  assert.deepEqual(assistantRoutePickerProblems({ trigger: 'Select a model', rows: ['Model›', 'Reasoning›'] }), [])
  assert.deepEqual(assistantRoutePickerProblems({ trigger: 'Mock One', rows: ['模型›', '推理›'] }), [])
  assert.ok(assistantRoutePickerProblems({ trigger: '', rows: ['模型›', '推理›'] }).some(text => /no trigger/.test(text)))
  assert.ok(assistantRoutePickerProblems({ trigger: '选择模型', rows: ['模型›'] }).some(text => /instead of the model and reasoning rows/.test(text)))
  // every key the shared picker resolves through `t` is rejected as a raw string
  for (const key of MODEL_PICKER_KEYS) {
    assert.ok(assistantRoutePickerProblems({ trigger: '选择模型', rows: [key, '推理›'] }).some(text => text.includes(`raw key ${key}`)), `${key} must be rejected as a rendered key`)
    assert.ok(assistantRoutePickerProblems({ trigger: key, rows: ['模型›', '推理›'] }).some(text => text.includes(`trigger renders the raw key ${key}`)), `${key} must be rejected as a trigger`)
  }
})

test('assistant visual readback guard compares the saved profile to the staged controls', () => {
  const profile = { scope: { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'] }, modelRoute: { chain: [{ provider: 'mock', model: 'mock-1' }] } }
  assert.deepEqual(assistantVisualReadbackProblems(profile, { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'], chain: [{ provider: 'mock', model: '*' }] }), [])
  assert.deepEqual(assistantVisualReadbackProblems(profile, { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'], chain: [{ provider: 'mock', model: 'mock-1' }] }), [])
  // the catalog row's default reasoning effort is only visible as a localized
  // trigger suffix, so the driver wildcards it while the ids stay exact
  assert.deepEqual(assistantVisualReadbackProblems({ scope: profile.scope, modelRoute: { chain: [{ provider: 'mock', model: 'mock-1', reasoningEffort: 'standard' }] } }, { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'], chain: [{ provider: 'mock', model: '*', reasoningEffort: '*' }] }), [])
  assert.ok(assistantVisualReadbackProblems(profile, { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'], chain: [{ provider: 'mock', model: '*', reasoningEffort: 'standard' }] }).some(text => /saved reasoning effort none instead of standard/.test(text)))
  assert.ok(assistantVisualReadbackProblems(profile, { paths: [], tags: [], chain: [] }).length >= 2)
  const leaked = { scope: { ...profile.scope, workspaces: ['weir-harness'] }, modelRoute: profile.modelRoute }
  assert.ok(assistantVisualReadbackProblems(leaked, { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'], chain: [{ provider: 'mock', model: '*' }] }).some(text => /workspaces key/.test(text)))
  // A retired class field in the saved scope is a regression, not an edit.
  const legacyClass = { scope: { ...profile.scope, authorizationClasses: ['A'] }, modelRoute: profile.modelRoute }
  assert.ok(assistantVisualReadbackProblems(legacyClass, { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'], chain: [{ provider: 'mock', model: '*' }] }).some(text => /retired authorizationClasses key/.test(text)))
  const wrongProvider = { scope: profile.scope, modelRoute: { chain: [{ provider: 'other', model: 'mock-1' }] } }
  assert.ok(assistantVisualReadbackProblems(wrongProvider, { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'], chain: [{ provider: 'mock', model: '*' }] }).some(text => /saved provider other instead of mock/.test(text)))
  const emptyModel = { scope: profile.scope, modelRoute: { chain: [{ provider: 'mock', model: '' }] } }
  assert.ok(assistantVisualReadbackProblems(emptyModel, { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'], chain: [{ provider: 'mock', model: '*' }] }).some(text => /saved no model id/.test(text)))
  assert.ok(assistantVisualReadbackProblems(profile, { paths: ['plugins/weir-harness/lib'], tags: ['decision-settings'], chain: [{ provider: 'mock', model: '*' }, { provider: 'mock', model: 'mock-2' }] }).some(text => /holds 1 rungs instead of 2/.test(text)))
})

