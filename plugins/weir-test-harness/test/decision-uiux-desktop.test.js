import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { viewportMeasurementProblems } from '../spikes/decision/gui-product-lib.mjs'
import { createUiuxFixture } from '../spikes/decision/gui-fixture/uiux.js'
import { connectCdp } from '../spikes/decision/cdp.mjs'

function rect(left = 16, top = 20, width = 64, height = 32) {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }
}

function fakeViewportCdp(t) {
  const requests = []
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  t.after(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalWebSocket })
  globalThis.fetch = async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://isolated-uiux.test' }] })
  const document = { querySelector: selector => selector === '#reference' ? { getBoundingClientRect: () => rect() } : null }
  globalThis.WebSocket = class FakeWebSocket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.emit('open', {})) }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    emit(type, event) { this.listeners.get(type)?.(event) }
    send(text) {
      const request = JSON.parse(text)
      requests.push(request)
      queueMicrotask(() => {
        const result = request.method === 'Runtime.evaluate' ? { result: { value: new Function('document', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'visualViewport', `return (${request.params.expression})`)(document, 360, 900, 1, { width: 180, height: 450, scale: 2, offsetLeft: 0, offsetTop: 0 }) } } : {}
        this.emit('message', { data: JSON.stringify({ id: request.id, result }) })
      })
    }
    close() {}
  }
  return requests
}

test('CDP viewport and keyboard probes retain real zoom fields CSS rect and PageDown packets', async t => {
  const requests = fakeViewportCdp(t)
  const cdp = await connectCdp(9496)
  const measurement = await cdp.measureViewport({ reference: '#reference' })
  assert.equal(measurement.innerWidth, 360)
  assert.equal(measurement.devicePixelRatio, 1)
  assert.equal(measurement.visualViewport.scale, 2)
  assert.deepEqual(measurement.rects.reference, rect())
  assert.deepEqual(viewportMeasurementProblems(measurement, { innerWidth: 360, scale: 2, withinVisualViewport: ['reference'] }), [])
  await cdp.key('PageDown')
  const events = requests.filter(request => request.method === 'Input.dispatchKeyEvent').map(request => request.params)
  assert.deepEqual(events, [
    { type: 'rawKeyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34, modifiers: 0 },
    { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34, modifiers: 0 },
  ])
  cdp.close()
})

test('Desktop UIUX preflight uses native dialog capabilities without running the product matrix', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const probe = driver.match(/async function runUiuxCapabilityPreflight\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(probe, 'the isolated UIUX capability preflight exists')
  for (const token of ["document.createElement('dialog')", '.showModal()', "matches(':modal')", 'nativeModalProblems', 'measureNativeModal', 'measureScrollContainers', 'browserZoomProblems', 'measureViewport', 'setPageZoom(2)', 'devicePixelRatio', '100dvh', "cdp.key('PageDown')", "cdp.key('Escape')", 'uiux-preflight.json']) assert.ok(probe.includes(token), token)
  const setupSource = probe.match(/evidence\.setup = await instance\.cdp\.evaluate\(`([\s\S]*?)`\)/)?.[1]
  assert.ok(setupSource, 'the generated browser setup source is available')
  const evaluatedSource = new Function('fixtureJson', `return \`${setupSource}\``)(JSON.stringify(createUiuxFixture()))
  assert.doesNotThrow(() => new Function(`return (${evaluatedSource})`), 'the generated browser setup remains syntactically valid after Node template evaluation')
  assert.ok(!/submitMarker\(|runProductMatrix\(|selectorChoose\(|confirmLearning\(|openAgent\(|openDisclosure\(/.test(probe), 'preflight cannot masquerade as 5.2–5.3 product acceptance')
  assert.ok(!/position\s*=\s*['"](?:absolute|fixed)['"]/.test(probe), 'no absolute/fixed fake modal fallback is introduced')
  const startup = driver.match(/async function runStartupPreflight\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(startup.includes('await runUiuxCapabilityPreflight()'))
  assert.ok(startup.includes('logErrorCount'), 'preflight retains every runtime error channel')
  assert.ok(driver.includes('WEIR_DECISION_PRODUCT_EVIDENCE_ROOT'), 'the run can use the lane UIUX evidence root without rewriting earlier roots')
  for (const helper of ['measureNativeModal', 'measureScrollContainers', 'measureColdReveal', 'measureMasterDetail']) assert.ok(driver.includes(`async function ${helper}(`), `${helper} is available to the later merged Client candidate`)
  assert.match(driver, /screenshots\.push\(\{ name, path, bytes: bytes\.length, \.\.\.\(details \?\? \{\}\) \}\)/, 'the screenshot index retains structured zoom and rect evidence')
})

test('isolated UIUX fixture controls real Decision RPC settlement without product changes', () => {
  const fixture = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-fixture/client.js'), 'utf8')
  for (const token of ['controlDecision', 'releaseDecisionControl', 'decisionControlState', "action==='fail'", "action==='hold'", "action==='unknown-auto'", "action==='delivery-unavailable'", 'originalRpcCall', 'JSON.stringify(control.args)']) assert.ok(fixture.includes(token), token)
  assert.ok(fixture.includes('connection.rpc.call=controlledCall'), 'the isolated client wraps the live RPC method')
  assert.match(fixture, /controlledConnection\.rpc\.call=originalRpcCall/, 'fixture disposal restores the exact original RPC method')
  assert.ok(!fixture.includes('weir-harness/lib'), 'the fixture does not patch product chunks')
})

test('held cold failure stays pending until release and then fails exactly once', async () => {
  const source = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-fixture/client.js'), 'utf8')
  let registration = null
  const window = { __ModuleLoader__: { load(value) { registration = value } } }
  new Function('window', source)(window)
  let originalCalls = 0
  const originalRpcCall = async () => { originalCalls += 1; return { ok: true, value: { case: { caseId: 'dc_cold' } } } }
  const connection = { rpc: { call: originalRpcCall } }
  const disposers = []
  const ctx = { get: () => connection, on: (event, dispose) => { if (event === 'dispose') disposers.push(dispose) } }
  registration.factory().apply(ctx)
  const args = { sessionId: 'root', caseId: 'dc_cold' }
  const id = window.__decisionQA.controlDecision({ method: 'record', args, action: 'hold-fail' })
  const pending = window.__decisionQA.decision('record', args)
  const before = window.__decisionQA.decisionControlState().find(control => control.id === id)
  assert.equal(before.started, true)
  assert.equal(before.released, false)
  assert.equal(before.settled, false)
  window.__decisionQA.releaseDecisionControl(id)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'WEIR_UIUX_INJECTED_FAILURE')
  assert.equal(originalCalls, 1)
  const after = window.__decisionQA.decisionControlState().find(control => control.id === id)
  assert.equal(after.released, true)
  assert.equal(after.settled, true)
  for (const dispose of disposers) dispose()
  assert.equal(connection.rpc.call, originalRpcCall)
})

test('5.2 product matrix wires raw modal scroll and settled-focus audits into every confirmation family', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const matrix = driver.match(/async function runProductMatrix\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(matrix.includes('installUiuxInstrumentation'), 'product dialogs are instrumented before the first selector opens')
  for (const helper of ['agentState', 'confirmLearning', 'cancelUnownedInbox']) {
    const body = driver.match(new RegExp(`async function ${helper}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''
    assert.ok(body.includes('beginModalAudit'), `${helper} measures native modal and all background scrollers`)
    assert.ok(body.includes('finishModalAudit'), `${helper} verifies restoration after closing`)
    assert.ok(body.includes('holdDecision'), `${helper} controls action Promise settlement`)
    assert.ok(body.includes('confirmationFocusProblems'), `${helper} rejects premature focus restoration`)
  }
  for (const token of ['beginModalAudit', 'runSelectorFailureMatrix', 'runColdRevealMatrix', 'runAgentResumeMatrix', 'browserZoomProblems', 'uiux-acceptance.json']) assert.ok(matrix.includes(token), token)
  const failure = driver.slice(driver.indexOf('} catch (error)', driver.indexOf('async function runProductMatrix()')))
  for (const token of ['logErrorCount', 'importFailures', 'desktop-enabled.log', 'desktop-disabled.log']) assert.ok(failure.includes(token), `failure runtime scan retains ${token}`)
})

test('Desktop focus oracle requires save success and non-dirty close without dropping prior transitions', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const source = driver.match(/const requiredFocusTransitions = (\[[^\n]+\])/)?.[1]
  assert.ok(source, 'the required assistant focus transition list exists')
  const required = Function(`return (${source})`)()
  const prior = ['Create assistant from selector', 'Open assistant editor', 'Open assistant details', 'Edit assistant', 'Back to narrow assistant list', 'Open narrow create draft', 'Back with preserved create draft', 'Resume same create draft', 'Back before real create target change', 'Open narrow edit draft', 'Back with preserved edit draft', 'Resume same assistant edit draft', 'Back before real edit target change', 'Back with selected learning context', 'Resume same assistant learning context']
  for (const action of [...prior, 'Save assistant', 'Close non-dirty assistant editor']) assert.ok(required.includes(action), `required focus transition: ${action}`)

  const fill = driver.match(/async function fillAgent\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const save = fill.match(/await keyboardActivate\('Save assistant',[^\n]+/)?.[0] ?? ''
  assert.match(save, /expectFocus: ['"]\.weir-da-agent-back,\[data-agent-detail\]['"]/, 'every successful save measures the resulting detail or its navigation')
  const close = driver.match(/await keyboardActivate\('Close non-dirty assistant editor',[^\n]+/)?.[0] ?? ''
  assert.match(close, /labels: \['取消', 'Cancel'\]/, 'non-dirty close uses the real localized Cancel action')
  assert.match(close, /expectFocus: `\.weir-da-agent-back,\[data-agent-detail="\$\{primary\.agentId\}"\]`/, 'non-dirty close measures the resulting assistant detail or its navigation')
})

test('raw modal inline snapshots include paddingBottom alongside scrollbar compensation', () => {
  const driver = readFileSync(join(process.cwd(), 'plugins/weir-test-harness/spikes/decision/gui-product.mjs'), 'utf8')
  const measure = driver.match(/async function measureScrollContainers\([^)]*\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(measure)
  const inline = measure.match(/const computed=getComputedStyle\(el\);return \[name,\{[\s\S]*?inline:Object\.fromEntries\((\[[\s\S]*?\])\.map/ )?.[1] ?? ''
  assert.ok(inline.includes("'paddingRight'"))
  assert.ok(inline.includes("'paddingBottom'"), 'raw before/during/after inline evidence retains paddingBottom')
})
