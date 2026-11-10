import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decorateDecisionText, uniqueToolCall } from '../spikes/decision/gui-fixture/adapter.js'
import { answerFormExpression, correctionPreviewProblems, exactArgs, exactMutation, immutableChanges, layoutProblems, parseDecisionRequest, recordProjectionProblems } from '../spikes/decision/gui-product-lib.mjs'
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
  const patch = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-fixture/cordis.patch.yml'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(driver.includes('answerFormExpression(caseId)'))
  assert.ok(!driver.includes('JSON.stringify(article)} form.weir-da-answers'))
})

test('cold reveal waits execute one fully quoted descendant selector', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const matrix = driver.match(/async function runColdRevealMatrix\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(matrix, 'runColdRevealMatrix exists')
  for (const token of ['routeRefreshBaseline', 'evidenceRefreshBaseline', "keyboardFill('Exercise cold refresh draft'", "keyboardFill('Restore cold refresh draft'", 'cold-refresh-draft.json', 'refreshBaseline', "holdDecision('record', { sessionId, caseId }, 'hold-fail')", 'await releaseDecision(routeControl)']) assert.ok(matrix.includes(token), token)
  assert.ok(!matrix.includes("openPage('records')"), 'Records → Inbox unmounts the open disclosures and is not a refresh')
  assert.ok(!matrix.includes('refreshDecisions'), 'panel toggling is not substituted for a same-mount parent render')
  const fixture = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-fixture/client.js'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  assert.ok(driver.includes('correctionPreviewProblems(preview)'))
  assert.ok(!driver.includes('/scope|适用范围/i.test(preview)'))
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
  const fixtureClient = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-fixture/client.js'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const cdp = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/cdp.mjs'), 'utf8')
  const choose = cdp.match(/async chooseDefaultWorkspace\([^)]*\) \{[\s\S]*?\n    \}/)?.[0] ?? ''
  assert.ok(choose.includes('onCredit') && choose.includes('creditDismissed'), 'the real CDP welcome flow observes and settles a mid-flow credit transition')
  assert.ok(focus.includes('step < 500'), 'the existing focus traversal bound is not expanded to conceal a trap')
  assert.ok(!/\.click\(|\.focus\(/.test(focus), 'product targeting remains native-keyboard only')
  assert.ok((driver.match(/result\.artifacts\.hostOnboarding = join\(out, 'host-onboarding\.json'\)/g) ?? []).length === 2, 'final and blocked result indexes include the dismissal evidence')
})

test('confirmation focus measurement retains original element identity across a state-dependent selector change', async () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const state = driver.match(/async function cardState\(caseId\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(state, 'cardState exists')
  for (const token of ['form.weir-da-answers', 'formImmediatelyAfterHeader', 'formBeforeSecondary', '.weir-da-record-answers', '.weir-da-suggestion-review', 'secondary.length===7']) assert.ok(state.includes(token), token)
  const revealBody = driver.match(/async function revealCard\(caseId\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(revealBody, 'revealCard exists')
  assert.match(revealBody, /Input\.dispatchMouseEvent/, 'a collapsed native process group opens through real CDP pointer input')
  assert.match(revealBody, /button\[data-process-activity="tools"\]/)
  assert.ok(!/\.click\(|\.focus\(/.test(revealBody), 'the reveal never uses DOM click or focus')
  const held = driver.indexOf("check('consultSingleWritableCardBeforeToolResult'")
  const reveal = driver.indexOf('beforeCard = await revealCard(consult.caseId)', held)
  const focused = driver.indexOf("check('consultWaitingCardPutsDecisionFirst'")
  const release = driver.indexOf("writeFileSync(join(out, 'consult-result.release')")
  assert.ok(held >= 0 && reveal > held && focused > reveal && release > focused, 'the held card is revealed and asserted before tool result release')
  const acceptance = driver.slice(reveal, release)
  for (const condition of ['beforeCard.cards === 1', 'beforeCard.forms === 1', 'beforeCard.formImmediatelyAfterHeader', 'beforeCard.formBeforeSecondary', 'beforeCard.recordAnswerSummaries === 0', 'beforeCard.suggestionReviews === 0', "beforeCard.text.includes('GUI_B_DECIDE')"]) assert.ok(acceptance.includes(condition), condition)
  assert.ok(acceptance.includes('beforeCard = await revealCard(consult.caseId)'), 'the held card is scrolled into view and must expose non-empty rendered text before its screenshot')
})

test('Host language matrix activates General settings through native keyboard before General-only controls', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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

// Keyboard acceptance must observe real focus traversal; querying a target is read-only and
// may never be followed by programmatic focus, DOM clicks or value setters.
test('product driver keyboard helpers record native focus traversal and text entry', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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

test('keyboard selector audits precede native pending and retain long-case visual coverage', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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

// Run 47hAKq regression anchor: global-off UI evidence passed, then the disabled process
// issued learningRun and correctly received DECISION_UNAVAILABLE. Persistence authority
// belongs to a fresh enabled process, never to the disabled-bypass phase.
test('global off bypass and enabled restart persistence run in separate owned processes', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const advanced = enabled.indexOf('await openDisclosure(`weir-da-learning-advanced-${primary.agentId}`)', openedAgent)
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
  assert.ok(enabled.includes('restartedAgent.currentSnapshotId === candidateV1.snapshot.snapshotId'), 'the original current-snapshot assertion remains')
  assert.ok(enabled.includes('JSON.stringify(restartedRecord) === JSON.stringify(learnedDetail)'), 'the original whole-record persistence assertion remains')

  const matrix = driver.match(/async function runProductMatrix\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(matrix, 'the original matrix is separate from preflight-only startup')
  assert.deepEqual([...matrix.matchAll(/instance = await startDesktop\((true|false)\)/g)].map(match => match[1]), ['true', 'false', 'true'], 'the successful path owns enabled, disabled, then fresh enabled instances')
  assert.deepEqual([...matrix.matchAll(/await stopOwned\('process-(\d)'(?:, \{ crash: true \})?\)/g)].map(match => match[1]), ['1', '2', '3'], 'all three instances have exact owned cleanup receipts')
  assert.match(driver, /check\(`\$\{label\}ExactOwnedCleanup`, receipt\.pass/, 'each owned cleanup retains its named acceptance check')
  for (const log of ['desktop-enabled.log', 'desktop-disabled.log']) assert.ok(driver.includes(`'${log}'`), `${log} is included in the import scan`)
  assert.match(driver, /const importFailures = desktopLogs\.flatMap\(/, 'runtime import failures are scanned across both log modes')
})

test('product driver preserves all legacy AX groups and derives the expanded P4 requirements', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const scenario = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/src/scenarios/decision-gui.js'), 'utf8')
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  for (const token of [
    'runP4BeforeRestart', 'runP4AfterRestart', 'auditP4RawEvidence',
    'freshRootsDefaultToPersistedAuto', 'restartPreservesAutoExplicitOffAndLegacyNoRowOff',
    'emptyWhitelistAuthorityWithoutClassificationOrAttempt', 'zeroCandidatesNoRouteOrAttempt',
    'oneCandidateDeterministicAllGates', 'stockClasslessSelectedRouteHasDerivedAAndAllGates',
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
  assert.ok(!heldWindow.includes('waitCase') && !heldWindow.includes('record('), 'no authority RPC can race the 150ms classification timeout before the crash')
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
  assert.ok(driver.includes('input#plugin-config-weir-settings-decisionAgentAutoAnswerClasses'), 'settings text entry targets the actual host-namespaced input')
  assert.match(driver, /keyboardSelect\('Change routing review window', 'select\[data-routing-window\]', '24h'\)/, 'Desktop changes to the first real non-default window before its controlled select starts loading')
  assert.ok(!driver.includes("keyboardSelect('Change routing review window', 'select[data-routing-window]', '7d')"), 'the known intermediate-onChange 7d prefix path is not retained')
  assert.ok(driver.includes('input#plugin-config-weir-settings-decisionAgentAnswerTimeoutMs'), 'the held interruption uses the real timeout setting input')
  assert.match(driver, /setAutoSettings\('p4-interruption-window', \{ answerTimeoutMs: 30000 \}\)/, 'only the held interruption receives an explicit bounded longer window')
  assert.match(driver, /setAutoSettings\('p4-restored', \{ shadow: false, answerClasses: \[\], answerTimeoutMs: 150 \}\)/, 'final real-UI restoration includes the original 150ms timeout')
  assert.match(driver, /compareRoutingReview\(reviewSession, 'p4-routing-before-visuals', allAgain\)/, 'a fresh session mount compares to its authoritative first page')
  assert.ok(!driver.includes("compareRoutingReview(reviewSession, 'p4-routing-before-visuals', combined)"), 'the prior expanded page is not expected after a fresh mount')
  const agentStateBody = driver.match(/async function agentState\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const owningSession = agentStateBody.indexOf('await openIsolatedSession(sessionId, true)')
  const agentPage = agentStateBody.indexOf('await openAgent(sessionId, agentId)')
  assert.ok(owningSession >= 0 && agentPage > owningSession, 'Agent state actions restore their owning session before opening the management page')
})

test('P4 Desktop settings default closed and forward only explicit isolated overrides', t => {
  const keys = ['WEIR_DECISION_GUI_SELECTOR_DEFAULT', 'WEIR_DECISION_GUI_SHADOW', 'WEIR_DECISION_GUI_AUTO_CLASSES']
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] } })
  const paths = { home: '/isolated/root/home', profile: '/isolated/root/home/profiles/desktop', electronData: '/isolated/root/electron-data' }
  for (const key of keys) delete process.env[key]
  const conservative = appEnvironment(paths, '/isolated/root/out', true)
  assert.equal(conservative.WEIR_DECISION_GUI_SELECTOR_DEFAULT, 'off')
  assert.equal(conservative.WEIR_DECISION_GUI_SHADOW, '0')
  assert.equal(conservative.WEIR_DECISION_GUI_AUTO_CLASSES, '[]')
  process.env.WEIR_DECISION_GUI_SELECTOR_DEFAULT = 'auto'
  process.env.WEIR_DECISION_GUI_SHADOW = '1'
  process.env.WEIR_DECISION_GUI_AUTO_CLASSES = '["A","C"]'
  const enabled = appEnvironment(paths, '/isolated/root/out', true)
  assert.equal(enabled.WEIR_DECISION_GUI_SELECTOR_DEFAULT, 'auto')
  assert.equal(enabled.WEIR_DECISION_GUI_SHADOW, '1')
  assert.equal(enabled.WEIR_DECISION_GUI_AUTO_CLASSES, '["A","C"]')
  const patch = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-fixture/cordis.patch.yml'), 'utf8')
  for (const token of ['decisionAgentSelectorDefault', 'decisionAgentAutoShadow', 'decisionAgentAutoAnswerClasses', 'WEIR_DECISION_GUI_SELECTOR_DEFAULT', 'WEIR_DECISION_GUI_SHADOW', 'WEIR_DECISION_GUI_AUTO_CLASSES']) assert.ok(patch.includes(token), token)
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const fixture = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-fixture/index.js'), 'utf8')
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
  for (const surface of ['card', 'inbox']) assert.ok(unowned.includes(`if (routeRequired) await openDisclosure(\`weir-da-${surface}-routes-\${caseId}\`)`), `${surface} does not require keyboard expansion of a contractually empty route history`)
  assert.ok(!unowned.includes('weir-da-card-recovery-'), 'the redundant conversation recovery expansion is gone')
  const recovery = unowned.indexOf('await openDisclosure(`weir-da-recovery-${caseId}`)')
  assert.ok(recovery > routeReady && domRead > recovery, 'the actual inbox recovery controls render before no-retry is asserted')
  const selectorOpenBody = driver.match(/async function selectorOpen\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
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
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
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
