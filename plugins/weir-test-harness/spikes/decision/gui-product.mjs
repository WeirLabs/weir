// Real isolated Desktop acceptance for decision-agent-product-ux tasks 8.1–8.2.
// All product mutations are performed on the rendered NEW UI. Direct RPC is read-only.
// Only exact owned main/Host PIDs are signalled; the current App is never addressed.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LANE, writeJson, prepareProfile, startInstance, stopInstance,
  createSession, openSession, submitMarker,
} from './gui-qa.mjs'
import { waitFor } from './cdp.mjs'
import { answerFormExpression, correctionPreviewProblems, exactArgs, immutableChanges, layoutProblems, parseDecisionRequest, recordProjectionProblems, routeHistoryProblems, selectorEnvelope, selectorMatches } from './gui-product-lib.mjs'

process.env.WEIR_DECISION_PRODUCT_UX = '1'
const BASE_HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: LANE, encoding: 'utf8' }).stdout.trim()
const PORT = Number(process.env.WEIR_DECISION_PRODUCT_PORT ?? 9468)
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('WEIR_DECISION_PRODUCT_PORT must be a valid TCP port')
const GUI = join(LANE, '.weir', 'decision-product-ux')
mkdirSync(GUI, { recursive: true })
const root = mkdtempSync(join(GUI, 'desktop-'))
const runId = basename(root).replace('desktop-', '')
const out = join(GUI, `run-${runId}`)
mkdirSync(out)
const databasePath = join(root, 'home', 'weir', 'profiles', 'desktop', 'decisions', 'decision.db')
const checks = {}
const checkDetails = {}
const screenshots = []
const authoritativeRpc = []
const networkRpc = []
const runtimeEvents = []
const cleanups = []
const sqlitePhases = []
const comparisons = []
const visualAudits = []
const accessibility = {}
const accessibilityRequirements = {
  selectorTrigger: { role: 'button', name: /决策助手|Decision/i },
  selectorPanel: { role: 'dialog', name: /选择决策助手|Select.*assistant/i, autoChecked: true },
  longRecord: { role: 'article', name: '' },
  snapshotPublishDialog: { role: 'dialog', name: /采用这些原则变化|Apply these principle changes/i },
  snapshotRejectDialog: { role: 'dialog', name: /放弃这个候选|Discard this candidate/i },
  snapshotRollbackDialog: { role: 'dialog', name: /恢复前序原则版本|Restore a previous principle version/i },
  nativeDecision: { role: 'group', name: '' },
  unownedDecision: { role: 'article', name: '' },
  routingReview: { role: 'region', name: /路由复盘|Routing review/i },
  routingStatus: { role: 'status', name: '', properties: { live: 'polite' } },
  cancelDecisionDialog: { role: 'dialog', name: /取消这次判断|Cancel this decision/i },
}
const keyboardAudits = []
const mutationCounts = new Map()
const knownSessionIds = new Set()
const processProvenance = []
const p4Evidence = {}
let instance = null
let instanceNumber = 0
let failure = null
let result = null

function check(name, value, details = undefined) {
  checks[name] = Boolean(value)
  if (details !== undefined) checkDetails[name] = details
  writeJson(join(out, 'checks.json'), { checks, checkDetails })
  if (!value) throw new Error(`Product Desktop check failed: ${name}`)
}

function requireEvidence(value, message) {
  if (!value) throw new Error(`Product Desktop evidence mismatch: ${message}`)
}

function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat=,lstart=,args='], { encoding: 'utf8' })
  const stdout = ps.stdout?.trim() ?? ''
  return {
    pid, alive: ps.status === 0 && Boolean(stdout) && !/^\s*\d+\s+\d+\s+\S*Z/i.test(stdout),
    status: ps.status, stdout, stderr: ps.stderr?.trim() ?? '',
    signature: stdout.replace(/^\s*\d+\s+\d+\s+\S+\s+/, ''),
  }
}

function portListeners() {
  return spawnSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout?.trim() ?? ''
}

async function portFree() {
  try { await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) }); return false } catch { return true }
}

async function shot(name) {
  const path = join(out, `${name}.png`)
  await instance.cdp.screenshot(path)
  const bytes = readFileSync(path)
  requireEvidence(bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${name} is a real non-empty PNG`)
  screenshots.push({ name, path, bytes: bytes.length })
  writeJson(join(out, 'screenshots.json'), screenshots)
}

async function captureAccessibility(name, selector) {
  accessibility[name] = await instance.cdp.accessibility(selector)
  writeJson(join(out, 'accessibility.json'), accessibility)
  return accessibility[name]
}

function validateAccessibility() {
  const accessibilityProblems = Object.entries(accessibilityRequirements).flatMap(([name, expected]) => {
    const nodes = accessibility[name]
    if (!Array.isArray(nodes) || nodes.length === 0) return [`${name}: missing or empty AX tree`]
    const root = nodes.find(node => !node.ignored && node.role === expected.role)
    if (!root) return [`${name}: expected role ${expected.role}`]
    const problems = nameMatches ? [] : [`${name}: unexpected accessible name ${JSON.stringify(root.name)}`]
    for (const [key, value] of Object.entries(expected.properties ?? {})) {
      if (root.properties?.[key] !== value) problems.push(`${name}: expected ${key}=${value}`)
    }
    if (expected.autoChecked && !nodes.some(node => !node.ignored && node.role === 'radio' && /Auto/i.test(node.name ?? '') && (node.properties?.checked === true || node.properties?.checked === 'true' || node.properties?.checked === 'checked'))) problems.push(`${name}: checked Auto radio is missing`)
    return problems
  })
  const requiredGroups = Object.keys(accessibilityRequirements)
  const actualGroups = Object.keys(accessibility)
  const missingGroups = requiredGroups.filter(name => !actualGroups.includes(name))
  const unexpectedGroups = actualGroups.filter(name => !requiredGroups.includes(name))
  check('completeAccessibilityEvidence', accessibilityProblems.length === 0 && missingGroups.length === 0 && unexpectedGroups.length === 0, { problems: accessibilityProblems, requiredGroups, actualGroups, missingGroups, unexpectedGroups })
}

function collectRuntime(value, phase) {
  if (!value?.cdp) return
  for (const event of value.cdp.events) runtimeEvents.push({ phase, mainPid: value.app.pid, event })
  writeJson(join(out, 'runtime-events.json'), runtimeEvents)
}

async function startDesktop(enabled = true) {
  instanceNumber += 1
  const value = await startInstance({ root, out, port: PORT, enabled })
  await value.cdp.request('Network.enable')
  await value.cdp.request('Log.enable')
  await value.cdp.request('Accessibility.enable')
  value.network = { requests: new Map(), responses: new Map(), completed: new Set() }
  value.instanceNumber = instanceNumber
  const host = await value.cdp.evaluate('window.__decisionQA.fixture("hostState", {})')
  for (const name of ['preflight.json', 'instance.json', 'host.json', 'workspace-selection.json']) {
    if (existsSync(join(out, name))) copyFileSync(join(out, name), join(out, `process-${instanceNumber}-${name}`))
  }
  const provenance = JSON.parse(readFileSync(join(out, `process-${instanceNumber}-preflight.json`), 'utf8'))
  processProvenance.push(provenance)
  check(`process${instanceNumber}StartupProvenance`, provenance.pass && provenance.root === root && provenance.owner?.root === root && provenance.portProbe?.freeBeforeSpawn === true && provenance.processArgs.includes(`--remote-debugging-port=${PORT}`), { mainPid: value.app.pid, hostPid: host.pid, databaseExists: provenance.databaseExists })
  writeJson(join(out, `process-${instanceNumber}.json`), { mainPid: value.app.pid, host, root, port: PORT, enabled })
  check(`process${instanceNumber}Isolated`, host.profile?.home === join(root, 'home') && host.profile?.name === 'desktop' && (host.pid === value.app.pid || host.parentPid === value.app.pid), { mainPid: value.app.pid, hostPid: host.pid })
  return value
}

async function collectNetwork(value = instance) {
  if (!value?.cdp || !value.network) return []
  for (const event of value.cdp.events) {
    if (event.method === 'Network.requestWillBeSent') {
      const { requestId, request } = event.params
      if (String(request?.url).includes('/api/weirDecision/')) value.network.requests.set(requestId, request)
    }
    if (event.method === 'Network.responseReceived') value.network.responses.set(event.params.requestId, event.params.response)
  }
  for (const event of value.cdp.events) {
    if (event.method !== 'Network.loadingFinished') continue
    const requestId = event.params.requestId
    if (value.network.completed.has(requestId) || !value.network.requests.has(requestId)) continue
    value.network.completed.add(requestId)
    const request = value.network.requests.get(requestId)
    let postData = request.postData
    if (!postData) postData = (await value.cdp.request('Network.getRequestPostData', { requestId }).catch(() => null))?.postData ?? null
    const parsed = parseDecisionRequest(request.url, postData)
    const body = await value.cdp.request('Network.getResponseBody', { requestId }).catch(() => null)
    let response = null
    if (body?.body) {
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
      try { response = JSON.parse(text) } catch { response = text }
    }
    networkRpc.push({
      sequence: networkRpc.length + 1, instance: value.instanceNumber, requestId,
      method: parsed?.method ?? null, args: parsed?.args ?? null, rpcId: parsed?.rpcId ?? null,
      request: parsed?.request ?? postData, response, status: value.network.responses.get(requestId)?.status ?? null,
    })
  }
  writeJson(join(out, 'network-rpc.json'), networkRpc)
  return networkRpc
}

async function rpc(sessionId, phase, method, args = {}) {
  if (!['overview', 'agents', 'agent', 'records', 'record', 'inbox', 'metrics', 'routingReview', 'learningRun', 'memorySnapshot', 'caseForCall', 'caseForToolCall'].includes(method)) {
    throw new Error(`Direct Decision RPC is read-only; refused ${method}`)
  }
  const transport = await instance.cdp.evaluate(`window.__decisionQA.decision(${JSON.stringify(method)}, ${JSON.stringify({ sessionId, ...args })})`)
  requireEvidence(knownSessionIds.has(sessionId), `Decision read ${method} targets only a session created by this isolated run`)
  authoritativeRpc.push({ phase, method, args: { sessionId, ...args }, transport })
  writeJson(join(out, 'authoritative-rpc.json'), authoritativeRpc)
  const service = transport?.value
  if (!transport || transport.ok !== true || service?.ok === false) throw new Error(`Decision read ${method} failed at ${phase}: ${JSON.stringify(service?.error ?? transport?.error ?? transport)}`)
  return service?.ok === true ? service.value : service
}

async function expectMutation(method, args) {
  await collectNetwork()
  const matches = networkRpc.filter(entry => entry.method === method && exactArgs(entry.args, args))
  const key = `${method}:${JSON.stringify(args)}`
  const occurrence = mutationCounts.get(key) ?? 0
  requireEvidence(matches.length === occurrence + 1, `${method} occurrence ${occurrence + 1} has exact args and no duplicate`)
  const entry = matches[occurrence]
  mutationCounts.set(key, occurrence + 1)
  requireEvidence(entry.rpcId && entry.response, `${method} raw rpcId and response captured`)
  return entry
}

async function stopOwned(label, { crash = false } = {}) {
  const value = instance
  if (!value) return null
  await collectNetwork(value).catch(() => {})
  collectRuntime(value, label)
  const mainPid = value.app.pid
  const host = await value.cdp?.evaluate('window.__decisionQA?.fixture("hostState", {})').catch(() => null)
    ?? (existsSync(join(out, 'host.json')) ? JSON.parse(readFileSync(join(out, 'host.json'), 'utf8')) : null)
  const hostPid = host?.pid
  const before = { main: processInfo(mainPid), host: processInfo(hostPid) }
  let base
  let hostSignal = hostPid === mainPid ? 'covered-by-main' : 'not-needed'
  if (crash) {
    const expectedData = join(root, 'electron-data')
    if (!before.main?.alive || !before.main.stdout.includes(`--user-data-dir=${expectedData}`) || !before.main.stdout.includes(`--remote-debugging-port=${PORT}`)) throw new Error(`Refusing to crash changed or unowned main PID ${mainPid}`)
    process.kill(mainPid, 'SIGKILL')
    if (hostPid && hostPid !== mainPid && before.host?.alive) {
      const current = processInfo(hostPid)
      if (current?.alive && current.signature === before.host.signature && host.parentPid === mainPid && host.profile?.home === join(root, 'home')) {
        process.kill(hostPid, 'SIGKILL')
        hostSignal = 'SIGKILL'
      }
    }
    value.cdp?.close()
    value.log.end()
    base = { spawnedPid: mainPid, hostPid, hostParentPid: host?.parentPid, expectedHome: join(root, 'home'), hostHome: host?.profile?.home, hostProfile: host?.profile?.name, port: PORT, signalCode: 'SIGKILL', stopped: true, crash: true }
    writeJson(join(out, `${label}-cleanup-base.json`), base)
  } else {
    base = await stopInstance(value, join(out, `${label}-cleanup-base.json`))
    if (hostPid && hostPid !== mainPid && processInfo(hostPid)?.alive) {
      const current = processInfo(hostPid)
      if (!before.host?.alive || current.signature !== before.host.signature || host.parentPid !== mainPid || host.profile?.home !== join(root, 'home')) throw new Error(`Refusing to signal changed or unowned Host PID ${hostPid}`)
      process.kill(hostPid, 'SIGTERM')
      hostSignal = 'SIGTERM'
      try { await waitFor(() => !processInfo(hostPid)?.alive, 5000) } catch {
        const stillOwned = processInfo(hostPid)
        if (stillOwned?.alive && stillOwned.signature === before.host.signature) {
          process.kill(hostPid, 'SIGKILL')
          hostSignal = 'SIGTERM,SIGKILL'
          await waitFor(() => !processInfo(hostPid)?.alive, 5000)
        }
      }
    }
  }
  await waitFor(async () => await portFree() && !portListeners() && !processInfo(mainPid)?.alive && !processInfo(hostPid)?.alive, 10_000)
  const after = { main: processInfo(mainPid), host: processInfo(hostPid) }
  const receipt = { ...base, label, port: PORT, root, mainPid, hostPid, hostSignal, before, after, mainStopped: !after.main?.alive, hostStopped: !after.host?.alive, portReleased: await portFree() && !portListeners() }
  receipt.pass = receipt.mainStopped && receipt.hostStopped && receipt.portReleased
  cleanups.push(receipt)
  writeJson(join(out, `${label}-exact-pid-cleanup.json`), receipt)
  instance = null
  check(`${label}ExactOwnedCleanup`, receipt.pass, { mainPid, hostPid, hostSignal, portReleased: receipt.portReleased, crash })
  return receipt
}

function saveKeyboardAudits() {
  writeJson(join(out, 'keyboard-interactions.json'), keyboardAudits)
}

async function keyboardSnapshot(selector, options = {}) {
  return instance.cdp.evaluate(`(() => {
    const scope=${JSON.stringify(options.scope ?? null)}
    const labels=${JSON.stringify(options.labels ?? null)}
    const namePattern=${JSON.stringify(options.namePattern ?? null)}
    const describe=el=>{
      if(!el)return null
      const labelled=(el.getAttribute?.('aria-labelledby')??'').split(/\\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent??'').join(' ')
      const labelText=[...(el.labels??[])].map(label=>label.textContent).join(' ')
      const text=el===document.body||el===document.documentElement?'':el.innerText??''
      return {tag:el.tagName?.toLowerCase()??null,id:el.id||null,role:el.getAttribute?.('role')??null,accessibleName:String(el.getAttribute?.('aria-label')||labelled||labelText||text||el.value||'').trim().slice(0,500),value:typeof el.value==='string'?el.value:null}
    }
    const active=describe(document.activeElement)
    const root=scope?document.querySelector(scope):document
    if(!root)return {ready:false,reached:false,active,direction:'Tab'}
    const candidates=[...root.querySelectorAll(${JSON.stringify(selector)})]
    const target=candidates.find(el=>{
      const named=describe(el)?.accessibleName??''
      return el.offsetParent!==null&&!el.disabled&&(!labels||labels.includes(el.textContent.trim())||labels.includes(named))&&(!namePattern||new RegExp(namePattern,'i').test(named))
    })
    if(!target)return {ready:false,reached:false,active,direction:'Tab'}
    const items=[...document.querySelectorAll('button,input,textarea,select,a[href],[tabindex],[role="button"],[role="radio"]')].filter(el=>el.offsetParent!==null&&!el.disabled&&el.tabIndex>=0)
    const activeIndex=items.indexOf(document.activeElement)
    const targetIndex=items.indexOf(target)
    let direction='Tab'
    if(activeIndex>=0&&targetIndex>=0){
      const forward=(targetIndex-activeIndex+items.length)%items.length
      const backward=(activeIndex-targetIndex+items.length)%items.length
      if(backward<forward)direction='Shift+Tab'
    }
    return {ready:true,reached:target===document.activeElement,active,target:describe(target),direction,activeIndex,targetIndex}
  })()`)
}

async function keyboardFocus(action, selector, options = {}) {
  const audit = { action: `Focus: ${action}`, selector, options, steps: [], reached: false }
  keyboardAudits.push(audit)
  saveKeyboardAudits()
  const deadline = Date.now() + 30_000
  await waitFor(async () => (await keyboardSnapshot(selector, options)).ready, 30_000)
  for (let step = 0; step < 500 && Date.now() < deadline; step += 1) {
    const before = await keyboardSnapshot(selector, options)
    if (before.reached) {
      audit.reached = true
      audit.activeElement = before.active
      audit.target = before.target
      saveKeyboardAudits()
      return audit
    }
    await instance.cdp.key('Tab', before.direction === 'Shift+Tab' ? 8 : 0)
    const after = await keyboardSnapshot(selector, options)
    audit.steps.push({ step, key: before.direction, from: before.active, activeElement: after.active, target: before.target })
    saveKeyboardAudits()
  }
  throw new Error(`Keyboard target unreachable: ${action} ${selector} ${JSON.stringify(audit.steps.at(-1))}`)
}

async function keyboardActivate(action, selector, options = {}) {
  const audit = await keyboardFocus(action, selector, options)
  await instance.cdp.key(options.key ?? 'Enter')
  audit.activation = { key: options.key ?? 'Enter', activeElement: (await keyboardSnapshot(selector, options)).active }
  saveKeyboardAudits()
  return audit
}

async function keyboardFill(action, selector, value) {
  const audit = await keyboardFocus(action, selector)
  await instance.cdp.key('a', 4)
  await instance.cdp.request('Input.insertText', { text: value })
  await waitFor(() => instance.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`), 30_000)
  audit.input = { method: 'Input.insertText', selectAll: 'Meta+A', value, activeElement: (await keyboardSnapshot(selector)).active }
  saveKeyboardAudits()
}
async function keyboardSelect(action, selector, value, options = {}) {
  const audit = await keyboardFocus(action, selector, options)
  audit.selection = { value, steps: [] }
  for (let step = 0; step < 20; step += 1) {
    const current = await instance.cdp.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); return el?{value:el.value,values:[...el.options].map(option=>option.value)}:null })()`)
    requireEvidence(current?.values.includes(value), `${action} exposes the authoritative target option`)
    if (current.value === value) { saveKeyboardAudits(); return audit }
    const from = current.values.indexOf(current.value)
    const to = current.values.indexOf(value)
    const key = to > from ? 'ArrowDown' : 'ArrowUp'
    await instance.cdp.key(key)
    await waitFor(() => instance.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value!==${JSON.stringify(current.value)}`), 10_000)
    audit.selection.steps.push({ from: current.value, key })
    saveKeyboardAudits()
  }
  throw new Error(`Keyboard select did not reach ${value}: ${action}`)
}

async function newIsolatedSession(label, cwd = LANE) {
  const created = await createSession(instance, cwd)
  knownSessionIds.add(created.sessionId)
  writeJson(join(out, `${label}-session.json`), created)
  return created
}

async function openIsolatedSession(sessionId, allowNative = false) {
  requireEvidence(knownSessionIds.has(sessionId), 'only a session created by this run can be opened')
  if (!allowNative) return openSession(instance, sessionId)
  await instance.cdp.evaluate(`window.__decisionQA.openSession(${JSON.stringify(sessionId)})`)
  return waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]'))`), 60_000)
}

async function keyboardKey(action, key, details = {}) {
  const before = await keyboardSnapshot('body')
  await instance.cdp.key(key)
  const after = await keyboardSnapshot('body')
  keyboardAudits.push({ action, key, ...details, from: before.active, activeElement: after.active })
  saveKeyboardAudits()
}

async function selectorOpen() {
  await keyboardActivate('Open decision assistant selector', '[data-weir-decision-trigger="weir-decision-selector"]')
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-selector-panel"))'), 30_000)
}

async function selectorChoose(sessionId, mode, agentId = null) {
  const value = mode === 'agent' ? agentId : mode
  selectorEnvelope(sessionId, mode, agentId)
  for (let step = 0; step < 8; step += 1) {
    await selectorOpen()
    const target = await waitFor(() => instance.cdp.evaluate(`(() => { const input=document.querySelector('#weir-da-selector-panel input[type="radio"][value=${JSON.stringify(value)}]'); return input&&!input.disabled?{checked:input.checked}:null })()`), 30_000)
    if (target.checked) {
      await keyboardKey('Close unchanged decision assistant selector', 'Escape', { value })
      await waitFor(() => instance.cdp.evaluate('!document.querySelector("#weir-da-selector-panel")'), 30_000)
      const current = await rpc(sessionId, 'selector-unchanged', 'overview')
      requireEvidence(selectorMatches(current.selector, mode, agentId), 'unchanged selector still matches authority')
      return current.selector
    }
    await keyboardFocus('Current decision assistant radio', '#weir-da-selector-panel [role="radiogroup"] input[type="radio"]:checked')
    const navigation = await instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); const radios=panel?[...panel.querySelectorAll('[role="radiogroup"] input[type="radio"]')].filter(radio=>!radio.disabled):[]; return {values:radios.map(radio=>radio.value),activeValue:document.activeElement?.value??null,activeIndex:radios.indexOf(document.activeElement),targetIndex:radios.findIndex(radio=>radio.value===${JSON.stringify(value)})} })()`)
    requireEvidence(navigation.activeIndex >= 0 && navigation.targetIndex >= 0 && navigation.activeIndex !== navigation.targetIndex, 'selector radio keyboard navigation is available')
    const direction = navigation.targetIndex > navigation.activeIndex ? 'ArrowDown' : 'ArrowUp'
    const expectedValue = navigation.values[navigation.activeIndex + (direction === 'ArrowDown' ? 1 : -1)]
    const expectedMode = expectedValue === 'off' || expectedValue === 'auto' ? expectedValue : 'agent'
    const expectedAgentId = expectedMode === 'agent' ? expectedValue : null
    await keyboardKey('Select decision assistant with native radio navigation', direction, { fromValue: navigation.activeValue, expectedValue })
    await waitFor(() => instance.cdp.evaluate('!document.querySelector("#weir-da-selector-panel")'), 30_000)
    const overview = await waitFor(async () => { const current = await rpc(sessionId, 'selector', 'overview'); return selectorMatches(current.selector, expectedMode, expectedAgentId) ? current : null }, 30_000)
    await expectMutation('setSelector', selectorEnvelope(sessionId, expectedMode, expectedAgentId))
    if (expectedValue === value) return overview.selector
  }
  throw new Error(`Keyboard selector did not reach ${value}`)
}

async function openPage(tab = 'inbox') {
  await instance.cdp.evaluate('window.__decisionQA.selectDecisions()')
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("main.weir-da-page"))'), 60_000)
  const current = await instance.cdp.evaluate(`document.querySelector('main.weir-da-page [data-decision-primary-nav] [data-view=${JSON.stringify(tab)}]')?.getAttribute('aria-pressed')`)
  if (current !== 'true') await keyboardActivate(`Open ${tab} page`, `main.weir-da-page [data-view="${tab}"]`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('main.weir-da-page section[data-view=${JSON.stringify(tab)}]'))`), 30_000)
}

async function fillAgent(name, preference) {
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("form[data-agent-editor]"))'), 30_000)
  await keyboardFill('Edit assistant name', '[data-agent-field="name"]', name)
  await keyboardFill('Edit assistant preference', '[data-agent-field="preference"]', preference)
  await keyboardActivate('Save assistant', 'form[data-agent-editor] button[type="submit"]')
}

async function createAgent(sessionId, name, preference) {
  await openPage('agents')
  await keyboardActivate('Open assistant editor', '[data-action="create-agent"]')
  await fillAgent(name, preference)
  const agents = await waitFor(async () => { const value = await rpc(sessionId, 'agent-create', 'agents'); return value.some(agent => agent.name === name) ? value : null }, 30_000)
  const agent = agents.find(item => item.name === name)
  await expectMutation('profileUpsert', { sessionId, name, userDescription: preference })
  return agent
}

async function openAgent(sessionId, agentId) {
  await openPage('agents')
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-agent-summary=${JSON.stringify(agentId)}] [data-action="open-agent"]'))`), 30_000)
  await keyboardActivate('Open assistant details', `[data-agent-summary="${agentId}"] [data-action="open-agent"]`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-agent-detail=${JSON.stringify(agentId)}]'))`), 30_000)
  return rpc(sessionId, 'agent-open', 'agent', { agentId })
}

async function agentState(sessionId, agentId, state) {
  await openAgent(sessionId, agentId)
  await keyboardActivate(`Request assistant ${state}`, `[data-agent-detail="${agentId}"] [data-agent-state="${state}"]`)
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-agent-state"))'), 30_000)
  await keyboardActivate(`Confirm assistant ${state}`, `#weir-da-agent-state .weir-da-actions button${state === 'enabled' ? '[data-variant="primary"]' : ':last-child'}`)
  const agent = await waitFor(async () => { const value = await rpc(sessionId, 'agent-state', 'agent', { agentId }); return value.state === state ? value : null }, 30_000)
  await expectMutation('profileSetState', { sessionId, agentId, state })
  return agent
}

async function nativeState() {
  return instance.cdp.evaluate(`(() => { const visible=el=>Boolean(el&&el.offsetParent!==null); const pending=[...document.querySelectorAll('[data-question-key]')].find(visible); return {pending:Boolean(pending),key:pending?.getAttribute('data-question-key')??null,text:pending?.innerText??'',radios:pending?[...pending.querySelectorAll('[role="radio"]')].map(el=>({label:el.getAttribute('aria-label'),checked:el.getAttribute('aria-checked'),disabled:el.disabled})):[] } })()`)
}

async function answerNative(label) {
  const native = await waitFor(async () => { const state=await nativeState(); return state.pending&&state.key&&state.radios.some(radio=>radio.label===label&&!radio.disabled)?state:null }, 30_000)
  const card = `[data-question-key=${JSON.stringify(native.key)}]`
  await keyboardActivate(`Choose native answer ${label}`, `[role="radio"][aria-label=${JSON.stringify(label)}]`, { scope: card, key: 'Space' })
  await keyboardActivate('Submit native answer', 'button', { scope: card, labels: ['提交', 'Submit', 'Next', '下一题', '继续'] })
}

async function records(sessionId) { return rpc(sessionId, 'records', 'records') }
async function waitCase(sessionId, marker, predicate = () => true) {
  return waitFor(async () => { const page = await records(sessionId); const item = page.records.find(value => value.request?.questions?.some(question => question.id === marker || String(question.question).includes(marker))); return item && predicate(item) ? item : null }, 90_000)
}
async function record(sessionId, phase, caseId) { return rpc(sessionId, phase, 'record', { caseId }) }

async function routingReview(sessionId, phase, window = 'all', cursor = undefined) {
  return rpc(sessionId, phase, 'routingReview', { window, ...(cursor === undefined ? {} : { cursor }) })
}

async function decisionConfig(phase) {
  const value = await instance.cdp.evaluate('window.__decisionQA.fixture("decisionConfig", {})')
  writeJson(join(out, `decision-config-${phase}.json`), value)
  return value
}
async function openDecisionSettings() {
  await instance.cdp.setViewport(1440)
  await keyboardActivate('Open account menu', 'button[aria-label="账号菜单"],button[aria-label="Account menu"]')
  await keyboardActivate('Open Settings', '[role="menuitem"],button', { namePattern: '^(设置|Settings)(?:\\s|⌘|$)' })
  await waitFor(() => instance.cdp.evaluate('document.body.innerText.includes("当前版本") || document.body.innerText.includes("Current version")'), 30_000)
  await keyboardActivate('Open Weir settings', 'button', { scope: '[role="dialog"]', labels: ['Weir'] })
  await waitFor(() => instance.cdp.evaluate('document.body.innerText.includes("Auto Shadow")'), 60_000)
}

async function setAutoSettings(phase, { shadow, answerClasses }) {
  await openDecisionSettings()
  if (shadow !== undefined) {
    const selector = '[aria-label="Auto Shadow 诊断"],[aria-label="Auto Shadow diagnostics"]'
    const current = await instance.cdp.evaluate(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item=>item.offsetParent!==null); return el?{checked:el.getAttribute('aria-checked')==='true'||el.checked===true}:null })()`)
    requireEvidence(current, 'the real Auto Shadow settings control is visible')
    if (current.checked !== shadow) await keyboardActivate(`Set Shadow ${shadow ? 'on' : 'off'}`, selector, { key: 'Space' })
  }
  if (answerClasses !== undefined) {
    const value = JSON.stringify(answerClasses)
    await keyboardFill('Edit Auto answer-class whitelist', 'input[aria-label="Auto 可回答类别（JSON）"],textarea[aria-label="Auto 可回答类别（JSON）"],input[aria-label="Auto answer classes (JSON)"],textarea[aria-label="Auto answer classes (JSON)"]', value)
  }
  await keyboardActivate('Save Decision Auto settings', '[data-save-bar] button', { namePattern: '^(保存|Save)' })
  const expected = value => (shadow === undefined || value.effective?.decisionAgentAutoShadow === shadow) && (answerClasses === undefined || JSON.stringify(value.effective?.decisionAgentAutoAnswerClasses) === JSON.stringify(answerClasses))
  const config = await waitFor(async () => { const value = await decisionConfig(phase); return expected(value) ? value : null }, 30_000)
  await shot(`settings-${phase}`)
  await keyboardKey('Close settings after authority reread', 'Escape', { phase })
  await waitFor(() => instance.cdp.evaluate('!document.body.innerText.includes("Auto Shadow 诊断") && !document.body.innerText.includes("Auto Shadow diagnostics")'), 30_000)
  return config
}

async function routingReviewDom() {
  return instance.cdp.evaluate(`(() => {
    const root=document.querySelector('section[data-routing-review]')
    if(!root)return null
    const more=root.querySelector('[data-routing-load-more]')
    return {
      window:root.querySelector('select[data-routing-window]')?.value??null,
      status:root.querySelector('[data-routing-status]')?.textContent??'',
      text:root.innerText,
      summary:Object.fromEntries([...root.querySelectorAll('[data-metric-key]')].map(row=>[row.getAttribute('data-metric-key'),row.querySelector('dd')?.textContent??''])),
      items:[...root.querySelectorAll('article[data-routing-case]')].map(article=>({caseId:article.getAttribute('data-routing-case'),text:article.innerText,recordCaseId:article.querySelector('[data-routing-record]')?.getAttribute('data-routing-record')??null})),
      loadMore:more?{disabled:more.disabled,busy:more.getAttribute('aria-busy')}:null,
    }
  })()`)
}

async function compareRoutingReview(sessionId, phase, authority) {
  const dom = await waitFor(async () => { const value=await routingReviewDom(); return value?.items.length===authority.items.length?value:null }, 30_000)
  const problems = []
  if (dom.window !== authority.window) problems.push(`window ${dom.window} != ${authority.window}`)
  if (!dom.status.includes(String(authority.items.length))) problems.push('routing status omits the authoritative shown count')
  for (const [key, value] of Object.entries(authority.summary ?? {})) {
    if (dom.summary?.[key] !== String(value)) problems.push(`routing summary ${key} ${dom.summary?.[key]} != ${value}`)
  }
  authority.items.forEach((item, index) => {
    const rendered = dom.items[index]
    if (rendered?.caseId !== item.caseId) problems.push(`routing case ${index} differs`)
    if (item.title && !rendered?.text.includes(item.title)) problems.push(`routing title ${item.caseId} is missing`)
    if ((rendered?.recordCaseId ?? null) !== (item.recordCaseId ?? null)) problems.push(`record link ${item.caseId} differs`)
  })
  comparisons.push({ phase, kind: 'routing', authority, dom, problems })
  writeJson(join(out, 'rpc-ui-comparisons.json'), comparisons)
  check(`${phase}RoutingReviewMatchesRpc`, problems.length === 0, { items: authority.items.length, nextCursor: authority.nextCursor, problems })
  return dom
}

async function openRoutingRecord(sessionId, caseId) {
  await keyboardActivate('Open routing decision record', '[data-routing-record]', { scope: `article[data-routing-case="${caseId}"]` })
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-record-detail=${JSON.stringify(caseId)}]'))`), 30_000)
  return record(sessionId, 'routing-record-open', caseId)
}

async function routingLoadMore(sessionId, authority) {
  requireEvidence(authority.nextCursor, 'routing pagination requires an authoritative next cursor')
  await keyboardActivate('Load more routing history', '[data-routing-load-more]', { scope: 'section[data-routing-review]' })
  const next = await routingReview(sessionId, 'routing-load-more', authority.window, authority.nextCursor)
  const combined = { ...next, items: [...authority.items, ...next.items] }
  await compareRoutingReview(sessionId, 'routing-paginated', combined)
  return combined
}

async function cardState(caseId) {
  return instance.cdp.evaluate(`(() => {
    const cards=[...document.querySelectorAll('[data-weir-decision-card=${JSON.stringify(caseId)}]')].filter(el=>el.offsetParent!==null)
    const forms=cards.reduce((sum,card)=>sum+card.querySelectorAll('form.weir-da-answers').length,0)
    const formImmediatelyAfterHeader=cards.length===1&&cards.every(card=>card.querySelector(':scope > .weir-da-card-header')?.nextElementSibling===card.querySelector(':scope > form.weir-da-answers'))
    const formBeforeSecondary=cards.length===1&&cards.every(card=>{
      const form=card.querySelector(':scope > form.weir-da-answers')
      if(!form)return false
      const content=[...card.children]
      const formIndex=content.indexOf(form)
      const secondary=content.filter(el=>el.classList.contains('weir-da-disclosure')||el.classList.contains('weir-da-feedback-editor')||el.matches('button.weir-da-button'))
      return secondary.length===7&&secondary.every(el=>content.indexOf(el)>formIndex)
    })
    return {cards:cards.length,forms,formImmediatelyAfterHeader,formBeforeSecondary,recordAnswerSummaries:cards.reduce((sum,card)=>sum+card.querySelectorAll('.weir-da-record-answers').length,0),suggestionReviews:cards.reduce((sum,card)=>sum+card.querySelectorAll('.weir-da-suggestion-review').length,0),nativeHints:cards.reduce((sum,card)=>sum+card.querySelectorAll('[data-native-answer]').length,0),text:cards.map(card=>card.innerText).join('\\n---\\n')}
  })()`)
}

async function revealCard(caseId) {
  const selector = `[data-weir-decision-card=${JSON.stringify(caseId)}]`
  const initial = await cardState(caseId)
  if (!initial.text.trim()) {
    const target = await instance.cdp.evaluate(`(() => {
      const card=document.querySelector(${JSON.stringify(selector)})
      const question=card?.querySelector('.weir-da-card-header h2')?.textContent?.trim()
      if(!question)return null
      const trigger=[...document.querySelectorAll('button[data-process-activity="tools"]')].find(el=>el.offsetParent!==null&&el.getAttribute('aria-expanded')==='false'&&el.textContent.includes(question))
      if(!trigger)return null
      const rect=trigger.getBoundingClientRect()
      return {label:trigger.textContent.trim(),x:rect.left+rect.width/2,y:rect.top+rect.height/2}
    })()`)
    requireEvidence(target, 'the held consult native process group can be opened')
    await instance.cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
    await instance.cdp.request('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 })
    await instance.cdp.request('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 })
    writeJson(join(out, 'consult-reveal.json'), { caseId, method: 'CDP Input.dispatchMouseEvent', target })
  }
  await instance.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start',inline:'nearest'})`)
  return waitFor(async () => {
    const value = await cardState(caseId)
    return value.text.trim() ? value : null
  }, 30_000)
}

async function scanSession(sessionId, path) {
  requireEvidence(knownSessionIds.has(sessionId), 'session scans are limited to run-created sessions')
  const scan = await instance.cdp.evaluate(`window.__decisionQA.fixture('scanSession', ${JSON.stringify({ sessionId })})`)
  writeJson(join(out, path), scan)
  return scan
}

async function openRecord(sessionId, caseId) {
  await openPage('records')
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('.weir-da-record-list [data-case-id=${JSON.stringify(caseId)}]'))`), 30_000)
  await keyboardActivate('Open decision record', `.weir-da-record-list [data-case-id="${caseId}"]`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-record-detail=${JSON.stringify(caseId)}]'))`), 30_000)
  return record(sessionId, 'record-open', caseId)
}

async function openDisclosure(id) {
  const selector = `button[aria-controls="${id}-content"]`
  const expanded = await instance.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded')`)
  if (expanded !== 'true') await keyboardActivate('Open disclosure', selector)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('#${id}-content'))`), 30_000)
}

async function recordDom(caseId) {
  return instance.cdp.evaluate(`(() => {
    const detail=document.querySelector('[data-record-detail=${JSON.stringify(caseId)}]')
    if(!detail)return null
    const advanced=detail.querySelector('.weir-da-advanced-record')
    const routeHistory=[...detail.querySelectorAll('.weir-da-route-history li')].map(item=>({text:item.innerText,createdAt:item.querySelector('time')?.getAttribute('dateTime')??null}))
    return {caseId:detail.getAttribute('data-record-detail'),defaultText:[...detail.childNodes].filter(node=>!(node instanceof HTMLElement&&node.classList.contains('weir-da-disclosure'))).map(node=>node.textContent).join('\\n'),text:detail.innerText,currentEvidence:detail.querySelector('[data-current-evidence]')?.innerText??'',advancedText:advanced?.innerText??'',routeHistory,editableHistory:detail.querySelector('.weir-da-record-answers')?.querySelectorAll('input,textarea,[contenteditable="true"]').length??-1}
  })()`)
}

async function compareRecord(sessionId, phase, caseId, advanced = false) {
  const authority = await record(sessionId, phase, caseId)
  let dom = await recordDom(caseId)
  if (authority.routeDecisions?.length) {
    await openDisclosure(`weir-da-record-routes-${caseId}`)
    dom = await recordDom(caseId)
  }
  if (advanced) await openDisclosure(`weir-da-record-advanced-${caseId}`)
  const withAdvanced = advanced ? await recordDom(caseId) : { ...dom, advancedText: JSON.stringify(authority) }
  const problems = [...recordProjectionProblems(authority, withAdvanced), ...routeHistoryProblems(authority, withAdvanced)]
  comparisons.push({ phase, kind: 'record', caseId, revision: authority.case.revision, state: authority.case.state, closing: authority.case.closing, answers: authority.case.decision?.answers ?? null, routeDecisions: authority.routeDecisions ?? [], dom: withAdvanced, advanced, problems })
  writeJson(join(out, 'rpc-ui-comparisons.json'), comparisons)
  check(`${phase}RecordMatchesRpc`, problems.length === 0 && withAdvanced.editableHistory === 0, { caseId, revision: authority.case.revision, problems })
  return { authority, dom: withAdvanced }
}

async function feedback(sessionId, caseId, verb) {
  await keyboardActivate(`Apply feedback ${verb}`, `[data-record-detail="${caseId}"] [data-feedback="${verb}"]`)
  const expected = { rating_up: 'validated', rating_down: 'disputed', undo_rating_up: 'none', undo_rating_down: 'none' }[verb]
  const detail = await waitFor(async () => { const value = await record(sessionId, `feedback-${verb}`, caseId); return value.case.feedbackState === expected ? value : null }, 30_000)
  await expectMutation('feedback', { sessionId, caseId, verb })
  const nextControl = verb.startsWith('undo') ? 'rating_up' : `undo_${verb}`
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-record-detail=${JSON.stringify(caseId)}] [data-feedback=${JSON.stringify(nextControl)}]'))`), 30_000)
  return detail
}

function sqliteSnapshot(phase) {
  requireEvidence(databasePath.startsWith(`${root}/`) && existsSync(databasePath), 'isolated Decision DB exists')
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const tables = ['agent_profiles', 'agent_profile_revisions', 'cases', 'attempts', 'evidence', 'attempt_evidence', 'feedback', 'corrections', 'learning_runs', 'memory_snapshots', 'selectors', 'route_decisions']
    const raw = { phase, path: databasePath, schemaVersion: db.prepare('PRAGMA user_version').get().user_version, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check, rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) }
    requireEvidence(raw.schemaVersion === 1 && raw.integrity === 'ok', `${phase} SQLite v1 integrity`)
    sqlitePhases.push(raw)
    writeJson(join(out, `sqlite-${phase}.json`), raw)
    return raw
  } finally { db.close() }
}

async function governanceState(agentId) {
  return instance.cdp.evaluate(`(() => { const detail=document.querySelector('[data-agent-detail=${JSON.stringify(agentId)}]'); const section=detail?.querySelector('.weir-da-learning'); if(!section)return null; const visible=el=>el.offsetParent!==null; return {text:section.innerText,controls:[...section.querySelectorAll('button')].filter(visible).map(el=>({text:el.textContent.trim(),action:el.getAttribute('data-action'),disabled:el.disabled})),candidate:section.querySelector('[data-candidate-review]')?.innerText??'',sources:[...section.querySelectorAll('[data-learning-source-record]')].map(el=>({id:el.getAttribute('data-learning-source-record'),text:el.innerText})),advanced:section.querySelector('.weir-da-learning-diagnostics')?.innerText??''} })()`)
}

async function waitAgent(sessionId, agentId, predicate) {
  return waitFor(async () => { const agent = await rpc(sessionId, 'agent-wait', 'agent', { agentId }); return predicate(agent) ? agent : null }, 90_000)
}

async function startCandidate(sessionId, agent, expectedVersion) {
  await openAgent(sessionId, agent.agentId)
  const before = await rpc(sessionId, 'learning-before', 'agent', { agentId: agent.agentId })
  const known = new Set(before.learningRuns.map(run => run.learningRunId))
  await collectNetwork()
  const beforeCalls = networkRpc.filter(entry => entry.method === 'learningStart').length
  await keyboardActivate('Start principle review', `[data-agent-detail="${agent.agentId}"] [data-action="learning-start"]`)
  const current = await waitAgent(sessionId, agent.agentId, value => value.learningRuns.some(run => run.outcome === 'candidate' && !known.has(run.learningRunId)))
  const runSummary = current.learningRuns.find(run => run.outcome === 'candidate' && !known.has(run.learningRunId))
  const snapshotSummary = current.snapshots.find(snapshot => snapshot.learningRunId === runSummary.learningRunId && snapshot.state === 'draft')
  requireEvidence(snapshotSummary?.version === expectedVersion, `candidate v${expectedVersion}`)
  const [run, snapshot] = await Promise.all([rpc(sessionId, 'candidate-run', 'learningRun', { learningRunId: runSummary.learningRunId }), rpc(sessionId, 'candidate-snapshot', 'memorySnapshot', { snapshotId: snapshotSummary.snapshotId })])
  const dom = await waitFor(async () => { const value = await governanceState(agent.agentId); return value?.controls.some(control => control.action === 'learning-publish' && !control.disabled) && value.candidate.includes(snapshot.principles.at(-1)?.text ?? 'missing') ? value : null }, 30_000)
  requireEvidence(run.trigger === 'manual' && run.replay?.passed === true && snapshot.state === 'draft' && snapshot.revision === 1, 'valid manual candidate')
  requireEvidence(dom.candidate.includes('结构校验通过不代表内容质量') || dom.candidate.includes('Structural checks'), 'structural-quality warning remains visible')
  await collectNetwork()
  const starts = networkRpc.filter(entry => entry.method === 'learningStart')
  requireEvidence(starts.length === beforeCalls + 1, 'one learningStart per explicit keyboard activation')
  const start = starts.at(-1)
  requireEvidence(start.args?.sessionId === sessionId && start.args?.agentId === agent.agentId && typeof start.args?.requestId === 'string' && start.args.requestId && start.rpcId && start.response, 'learningStart exact session/agent/requestId envelope')
  await shot(`learning-v${expectedVersion}-candidate`)
  sqliteSnapshot(`candidate-v${expectedVersion}`)
  return { agent: current, run, snapshot, dom, start }
}

async function confirmLearning(kind, sessionId, candidate, expectedCurrentId) {
  const action = { snapshotPublish: 'learning-publish', snapshotReject: 'learning-reject', snapshotRollback: 'learning-rollback' }[kind]
  const dialog = { snapshotPublish: 'weir-da-learning-publish', snapshotReject: 'weir-da-learning-reject', snapshotRollback: 'weir-da-learning-rollback' }[kind]
  const snapshotId = candidate.snapshot.snapshotId
  const expectedRevision = candidate.snapshot.revision
  await keyboardActivate(`Request ${kind}`, `[data-action="${action}"]`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('#${dialog}'))`), 30_000)
  const confirmation = await instance.cdp.evaluate(`document.querySelector('#${dialog}').innerText`)
  requireEvidence(/只影响|历史|future|history/i.test(confirmation), `${kind} consequence confirmation`)
  await captureAccessibility(`${kind}Dialog`, `#${dialog}`)
  await shot(`${kind}-v${candidate.snapshot.version}-confirm`)
  await keyboardActivate(`Confirm ${kind}`, `#${dialog} .weir-da-actions button:last-child`)
  const agent = await waitAgent(sessionId, candidate.agent.agentId, value => {
    if (kind === 'snapshotPublish') return value.currentSnapshotId === snapshotId
    if (kind === 'snapshotReject') return value.learningRuns.some(run => run.learningRunId === candidate.run.learningRunId && run.outcome === 'rejected')
    return value.snapshots.some(snapshot => snapshot.snapshotId === snapshotId && snapshot.state === 'rolled_back') && (value.currentSnapshotId ?? null) === expectedCurrentId
  })
  const mutation = await expectMutation(kind, { sessionId, snapshotId, expectedRevision })
  const snapshot = await rpc(sessionId, `${kind}-snapshot`, 'memorySnapshot', { snapshotId })
  const run = candidate.run?.learningRunId ? await rpc(sessionId, `${kind}-run`, 'learningRun', { learningRunId: candidate.run.learningRunId }) : null
  comparisons.push({ phase: kind, kind: 'learning', snapshotId, expectedRevision, rpcId: mutation.rpcId, response: mutation.response, authoritative: { currentSnapshotId: agent.currentSnapshotId ?? null, snapshotState: snapshot.state, snapshotRevision: snapshot.revision, runOutcome: run?.outcome ?? null } })
  writeJson(join(out, 'rpc-ui-comparisons.json'), comparisons)
  sqliteSnapshot(kind)
  await shot(`${kind}-v${candidate.snapshot.version}-done`)
  return { agent, snapshot, run, mutation }
}

async function layoutAudit(name, theme = 'light', zoom = 1) {
  const expectedColors = {
    light: { background: 'rgb(255, 255, 255)', color: 'rgb(15, 17, 21)' },
    dark: { background: 'rgb(21, 21, 23)', color: 'rgb(249, 250, 251)' },
  }[theme]
  if (!expectedColors) throw new Error(`unsupported visual audit theme: ${theme}`)
  await waitFor(async () => {
    const colors = await instance.cdp.evaluate(`(() => { const page=document.querySelector('.weir-da-page'); return page?{background:getComputedStyle(page).backgroundColor,color:getComputedStyle(page).color}:null })()`)
    return colors?.background === expectedColors.background && colors?.color === expectedColors.color ? colors : null
  }, 10_000)
  const audit = await instance.cdp.evaluate(`(() => {
    const visible=el=>Boolean(el&&el.offsetParent!==null)
    const nameOf=el=>el.getAttribute('aria-label')||el.innerText?.trim()||[...(el.labels??[])].map(label=>label.innerText).join(' ')||el.closest('label')?.innerText||''
    const controls=[...document.querySelectorAll('.weir-da-page button,.weir-da-page input,.weir-da-page textarea,.weir-da-page select,.weir-da-selector-panel button,.weir-da-selector-panel input')].filter(visible)
    const primaries=[...document.querySelectorAll('.weir-da-page .weir-da-button[data-variant="primary"],.weir-da-conversation-card .weir-da-button[data-variant="primary"]')].filter(visible)
    const surfaces=[...document.querySelectorAll('.weir-da-page,.weir-da-selector-panel')].filter(visible)
    const page=document.querySelector('.weir-da-page')
    return {
      viewport:{width:innerWidth,height:innerHeight,visualWidth:visualViewport?.width??null,scale:visualViewport?.scale??1},
      document:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1},
      surfaceOverflow:surfaces.filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.className),
      clippedPrimary:primaries.filter(el=>el.scrollWidth>el.clientWidth+1||el.getBoundingClientRect().left < -1||el.getBoundingClientRect().right>innerWidth+1).map(el=>el.innerText||el.getAttribute('aria-label')),
      unnamedControls:controls.filter(el=>!String(nameOf(el)).trim()).map(el=>el.outerHTML.slice(0,200)),
      internalVocabulary:[],
      colors:page?{background:getComputedStyle(page).backgroundColor,color:getComputedStyle(page).color}:null,
    }
  })()`)
  const problems = layoutProblems(audit)
  const row = { name, theme, zoom, audit, problems }
  visualAudits.push(row)
  writeJson(join(out, 'visual-audits.json'), visualAudits)
  check(`visual-${name}`, problems.length === 0 && audit.colors?.background===expectedColors.background && audit.colors?.color===expectedColors.color && Math.abs((audit.viewport.scale ?? 1) - zoom) < 0.01, { problems, viewport: audit.viewport, colors: audit.colors })
  await shot(`visual-${name}`)
  return row
}

async function keyboardSelector(sessionId, modeOrAgent, agentId = null) {
  const mode = modeOrAgent === 'off' || modeOrAgent === 'auto' ? modeOrAgent : 'agent'
  const targetAgentId = mode === 'agent' ? agentId ?? modeOrAgent : null
  const value = mode === 'agent' ? targetAgentId : mode
  selectorEnvelope(sessionId, mode, targetAgentId)
  const audit = { mode, agentId: targetAgentId, value, steps: [] }
  keyboardAudits.push(audit)
  const saveAudit = saveKeyboardAudits
  await openSession(instance, sessionId)
  const triggerReached = await waitFor(async () => {
    const active = await instance.cdp.evaluate(`document.activeElement?.matches('[data-weir-decision-trigger="weir-decision-selector"]')`)
    if (active) return true
    await instance.cdp.key('Tab')
    return null
  }, 30_000).catch(() => false)
  audit.triggerReached = triggerReached
  saveAudit()
  check('keyboardReachesSelectorTrigger', triggerReached, { mode, agentId: targetAgentId })
  await captureAccessibility('selectorTrigger', '[data-weir-decision-trigger="weir-decision-selector"]')
  await instance.cdp.key('Enter')
  await waitFor(() => instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); return Boolean(panel&&document.activeElement===panel) })()`), 30_000)
  audit.enterPanel = true
  saveAudit()
  await captureAccessibility('selectorPanel', '#weir-da-selector-panel')
  await shot(`keyboard-selector-open-${value}`)
  await instance.cdp.key('Escape')
  await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel') && document.activeElement===document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')`), 30_000)
  audit.escapeReturnsTrigger = true
  saveAudit()
  await instance.cdp.key('Enter')
  await waitFor(() => instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); return Boolean(panel&&document.activeElement===panel) })()`), 30_000)
  audit.reopened = true
  saveAudit()
  for (let step = 0; step < 8; step += 1) {
    const groupReached = await waitFor(async () => {
      const active = await instance.cdp.evaluate(`document.activeElement?.matches('#weir-da-selector-panel [role="radiogroup"] input[type="radio"]') && document.activeElement?.checked === true`)
      if (active) return true
      await instance.cdp.key('Tab')
      return null
    }, 15_000).catch(() => false)
    check('keyboardReachesCheckedRadio', groupReached, { mode, agentId: targetAgentId, step })
    const navigation = await instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); const radios=panel?[...panel.querySelectorAll('[role="radiogroup"] input[type="radio"]')].filter(radio=>!radio.disabled):[]; return {values:radios.map(radio=>radio.value),activeValue:document.activeElement?.value??null,activeIndex:radios.indexOf(document.activeElement),targetIndex:radios.findIndex(radio=>radio.value===${JSON.stringify(value)})} })()`)
    if (navigation.values.length < 2 || navigation.activeIndex < 0 || navigation.targetIndex < 0) {
      check('keyboardNavigationOrderAvailable', false, { mode, agentId: targetAgentId, step, navigation })
    }
    const setup = navigation.activeValue === value
    let direction
    if (setup) {
      const destinationIndex = navigation.activeIndex > 0 ? navigation.activeIndex - 1 : 1
      direction = destinationIndex > navigation.activeIndex ? 'ArrowDown' : 'ArrowUp'
    } else {
      direction = navigation.targetIndex > navigation.activeIndex ? 'ArrowDown' : 'ArrowUp'
    }
    const expectedIndex = navigation.activeIndex + (direction === 'ArrowDown' ? 1 : -1)
    const expectedValue = navigation.values[expectedIndex]
    const expectedMode = expectedValue === 'off' || expectedValue === 'auto' ? expectedValue : 'agent'
    const expectedAgentId = expectedMode === 'agent' ? expectedValue : null
    await shot(`keyboard-selector-before-arrow-${value}-${step}`)
    await instance.cdp.key(direction)
    await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel') && document.activeElement===document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')`), 30_000)
    const selected = await waitFor(async () => {
      const current = await rpc(sessionId, 'keyboard', 'overview')
      return selectorMatches(current.selector, expectedMode, expectedAgentId) ? current : null
    }, 30_000)
    await expectMutation('setSelector', selectorEnvelope(sessionId, expectedMode, expectedAgentId))
    const focusReturned = await instance.cdp.evaluate(`document.activeElement===document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')`)
    const stepEvidence = { step, setup, fromValue: navigation.activeValue, direction, expectedValue, selected: selected.selector, focusReturned }
    audit.steps.push(stepEvidence)
    saveAudit()
    check(`keyboardNativeArrowStep:${value}:${step}`, selectorMatches(selected.selector, expectedMode, expectedAgentId) && focusReturned, stepEvidence)
    if (expectedValue === value) {
      const targetSteps = audit.steps.filter(item => !item.setup && item.expectedValue === value)
      audit.reached = !setup && targetSteps.length === 1
      audit.focusReturned = focusReturned
      saveAudit()
      const reachedCheck = mode === 'agent' ? 'keyboardReachesAgentRadio' : mode === 'auto' ? 'keyboardReachesAutoRadio' : 'keyboardReachesOffRadio'
      const focusCheck = mode === 'agent' ? 'keyboardSelectionAndFocusReturn' : `${mode}KeyboardSelectionAndFocusReturn`
      check(reachedCheck, audit.reached, { mode, agentId: targetAgentId, direction, fromValue: navigation.activeValue })
      check(focusCheck, selectorMatches(selected.selector, mode, targetAgentId) && focusReturned && targetSteps.length === 1, { mode, agentId: targetAgentId, direction, mutation: 'setSelector', targetSteps: targetSteps.length })
      await shot(`keyboard-selector-return-${value}`)
      return
    }
    await instance.cdp.key('Enter')
    await waitFor(() => instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); return Boolean(panel&&document.activeElement===panel) })()`), 30_000)
  }
  check(mode === 'agent' ? 'keyboardReachesAgentRadio' : mode === 'auto' ? 'keyboardReachesAutoRadio' : 'keyboardReachesOffRadio', false, { mode, agentId: targetAgentId, steps: audit.steps })
}

async function askLongNative(sessionId) {
  const questions = [
    { id: 'product-long-choice', question: '长中文题面：请在保留既有证据、权限与人工审批边界的前提下选择后续判断方式；English continuation with an intentionally long question that must wrap naturally without pushing the primary action outside the reachable viewport.', multiSelect: true, options: [
      { label: '采用这个同时包含中文与 English and deliberately extended wording 的长选项，以验证换行、复选状态与读屏名称。', description: '长选项说明 / Long option description remains readable at every viewport.' },
      { label: '另一个长选项 / Another intentionally long option' },
    ] },
    { id: 'product-long-text', question: '请补充一段中英文混合的自由文本判断理由 / Provide a multilingual free-text rationale that must remain editable before submission.' },
  ]
  await instance.cdp.evaluate(`(() => { const state={settled:false,value:null,error:null}; window.__decisionProductLong=state; window.__decisionQA.fixture('askNative',{sessionId:${JSON.stringify(sessionId)},questions:${JSON.stringify(questions)}}).then(value=>{state.value=value;state.settled=true},error=>{state.error=error?.message??String(error);state.settled=true}); return true })()`)
  return waitCase(sessionId, 'product-long-choice', current => current.state === 'awaiting_user')
}

async function answerInboxWithSuggestions(sessionId, caseId, shotName) {
  await openPage('inbox')
  const article = `article[data-case-id="${caseId}"]`
  await waitFor(() => instance.cdp.evaluate(answerFormExpression(caseId)), 30_000)
  await keyboardActivate('Use inbox suggestions', 'button', { scope: article, labels: ['使用建议', 'Use suggestions'] })
  const filled = await instance.cdp.evaluate(`(() => { const article=document.querySelector(${JSON.stringify(article)}); return {checked:[...article.querySelectorAll('input[type="radio"],input[type="checkbox"]')].filter(el=>el.checked).map(el=>el.value),texts:[...article.querySelectorAll('textarea')].map(el=>el.value),busy:article.querySelector('form')?.getAttribute('aria-busy')} })()`)
  const stillPending = await record(sessionId, 'suggestion-fill', caseId)
  check(`${shotName}SuggestionOnlyFills`, stillPending.case.state === 'awaiting_user' && filled.checked.length > 0 && filled.busy !== 'true', filled)
  await shot(`${shotName}-suggestion-filled`)
  await keyboardActivate('Submit inbox decision', 'button', { scope: article, labels: ['提交决定', 'Submit decision'] })
  const closed = await waitFor(async () => { const value = await record(sessionId, 'inbox-decide', caseId); return value.case.state === 'closed' ? value : null }, 30_000)
  await expectMutation('decide', { sessionId, caseId, answers: closed.case.decision.answers })
  check(`${shotName}InboxDecisionMatchesAuthority`, closed.case.closing === 'escalated' && closed.case.decision.kind === 'user_decision', { caseId, answers: closed.case.decision.answers })
  await shot(`${shotName}-answered`)
  return closed
}

// Run JxliG6 regression anchor: the long native question outlives the inbox decision that
// closed its Case, so the composer stays occupied and the next marker never lands. The
// rendered Skip control is the only finish left; the Hook answers the settled native ask
// through hookUserAborted, which returns the already closed Case unchanged.
async function skipLongNativeStep() {
  const native = await nativeState()
  if (!native.pending) return 'gone'
  const card = `[data-question-key=${JSON.stringify(native.key)}]`
  const ready = await instance.cdp.evaluate(`(() => { const root=document.querySelector(${JSON.stringify(card)}); return Boolean(root&&[...root.querySelectorAll('button')].find(el=>el.offsetParent!==null&&!el.disabled&&/^(跳过|Skip)$/i.test(el.textContent.trim()))) })()`)
  if (!ready) return 'busy'
  await keyboardActivate('Skip native question', 'button', { scope: card, labels: ['跳过', 'Skip'] })
  return 'skipped'
}

async function finishLongNativeWithSkip(sessionId, caseId) {
  const before = await record(sessionId, 'long-native-skip-before', caseId)
  requireEvidence(before.case.state === 'closed', 'the long inbox decision closed the Case before the native Skip')
  await shot('18a-long-native-skip-before')
  // The inbox step leaves a management page behind; the pending native card only
  // exists inside the owning session, so returning to it precedes the Skip.
  await openSession(instance, sessionId)
  const steps = []
  let native = await nativeState()
  while (native.pending) {
    requireEvidence(steps.length < 4, 'the visible native card exposes a bounded number of Skip steps')
    const previous = native.text
    const outcome = await waitFor(async () => { const value = await skipLongNativeStep(); return value === 'skipped' || value === 'gone' ? value : null }, 30_000)
    if (outcome === 'gone') break
    await waitFor(async () => { const next = await nativeState(); return !next.pending || next.text !== previous }, 30_000)
    steps.push(previous)
    native = await nativeState()
  }
  const settled = await waitFor(() => instance.cdp.evaluate(`(() => { const state=window.__decisionProductLong; return state?.settled===true?state:null })()`), 30_000)
  const after = await record(sessionId, 'long-native-skip-after', caseId)
  writeJson(join(out, 'long-native-skip.json'), { caseId, steps, native: settled, before: before.case, after: after.case })
  await shot('18b-long-native-skip-closed')
  check('longNativeSkipKeepsClosedRecord', after.case.state === 'closed' && after.case.revision === before.case.revision && JSON.stringify(after) === JSON.stringify(before), { caseId, revision: after.case.revision, skipSteps: steps.length, nativeSettled: settled.settled, nativeError: settled.error ?? null })
}
async function planReviewState() {
  return instance.cdp.evaluate(`(() => { const pending=[...document.querySelectorAll('[data-plan-review-key]')].find(el=>el.offsetParent!==null); return {pending:Boolean(pending),key:pending?.getAttribute('data-plan-review-key')??null,text:pending?.innerText??'',actions:pending?[...pending.querySelectorAll('button')].filter(el=>el.offsetParent!==null).map(el=>el.textContent.trim()):[]} })()`)
}

async function answerPlanReview() {
  const state = await waitFor(async () => { const value=await planReviewState(); return value.pending?value:null }, 30_000)
  await keyboardActivate('Accept native plan review', 'button', { scope: `[data-plan-review-key=${JSON.stringify(state.key)}]`, labels: ['同意执行', 'Accept', 'Approve'] })
}

async function settleNativeSkip(sessionId, caseId, label) {
  const before = await record(sessionId, `${label}-skip-before`, caseId)
  requireEvidence(before.case.state === 'closed', `${label} native Skip follows an already closed record`)
  await openIsolatedSession(sessionId, true)
  const steps = []
  let native = await nativeState()
  if (native.pending && !accessibility.nativeDecision) await captureAccessibility('nativeDecision', `[data-question-key=${JSON.stringify(native.key)}]`)
  while (native.pending) {
    requireEvidence(steps.length < 4, `${label} native Skip stays bounded`)
    const previous = native.text
    const outcome = await waitFor(async () => { const value=await skipLongNativeStep(); return value==='skipped'||value==='gone'?value:null }, 30_000)
    if (outcome === 'gone') break
    await waitFor(async () => { const next=await nativeState(); return !next.pending||next.text!==previous }, 30_000)
    steps.push(previous)
    native = await nativeState()
  }
  const after = await record(sessionId, `${label}-skip-after`, caseId)
  writeJson(join(out, `${label}-native-skip.json`), { caseId, steps, before: before.case, after: after.case })
  check(`${label}NativeSkipIsNoOp`, JSON.stringify(after) === JSON.stringify(before), { caseId, skipSteps: steps.length })
}

async function unownedInbox(sessionId, caseId, label, routeRequired = true) {
  await openIsolatedSession(sessionId, true)
  const authority = await record(sessionId, `${label}-unowned`, caseId)
  await waitFor(async () => { const value=await cardState(caseId); return value.cards===1?value:null }, 30_000)
  await openDisclosure(`weir-da-card-routes-${caseId}`)
  await openDisclosure(`weir-da-card-recovery-${caseId}`)
  const card = await instance.cdp.evaluate(`(() => { const root=document.querySelector('[data-weir-decision-card=${JSON.stringify(caseId)}]'); return {text:root.innerText,routeText:root.querySelector('.weir-da-route-history')?.innerText??'',retry:root.querySelectorAll('[data-action="retry"]').length,feedback:root.querySelectorAll('[data-feedback]').length,nativeHint:root.querySelectorAll('[data-native-answer]').length} })()`)
  check(`${label}UnownedConversationRouteHistory`, card.retry === 0 && card.feedback === 0 && card.nativeHint === 1 && (!routeRequired || card.routeText.trim().length > 0) && (routeRequired || authority.routeDecisions.length === 0), { caseId, card })
  await openPage('inbox')
  const article = `article[data-case-id=${JSON.stringify(caseId)}]`
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(article)}))`), 30_000)
  await openDisclosure(`weir-da-inbox-routes-${caseId}`)
  const dom = await instance.cdp.evaluate(`(() => { const root=document.querySelector(${JSON.stringify(article)}); return {text:root.innerText,retry:root.querySelectorAll('[data-action="retry"]').length,feedback:root.querySelectorAll('[data-feedback]').length,routeText:root.querySelector('.weir-da-route-history')?.innerText??'',forms:root.querySelectorAll('form.weir-da-answers').length} })()`)
  if (!accessibility.unownedDecision) await captureAccessibility('unownedDecision', article)
  check(`${label}UnownedTruthfulUi`, authority.case.agentId === null && authority.case.state === 'awaiting_user' && authority.attempts.length === 0 && dom.retry === 0 && dom.feedback === 0 && dom.forms === 1 && (!routeRequired || dom.routeText.trim().length > 0) && (routeRequired || authority.routeDecisions.length === 0) && /尚未选择助手|No assistant selected/i.test(dom.text), { caseId, dom, awaitingReason: authority.case.awaitingReason, routeRequired })
  return { authority, dom, card }
}

async function answerUnownedInbox(sessionId, caseId, label, answer) {
  await unownedInbox(sessionId, caseId, label)
  const article = `article[data-case-id=${JSON.stringify(caseId)}]`
  await keyboardActivate(`Answer unowned ${label}`, 'input[type="radio"]', { scope: article, key: 'Space', labels: [answer] })
  await keyboardActivate(`Submit unowned ${label}`, 'button[type="submit"]', { scope: article })
  const closed = await waitFor(async () => { const value=await record(sessionId, `${label}-answered`, caseId); return value.case.state==='closed'?value:null }, 30_000)
  await expectMutation('decide', { sessionId, caseId, answers: closed.case.decision.answers })
  check(`${label}DirectAnswerHasNoAgentEvidence`, closed.case.agentId === null && closed.case.closing === 'escalated' && closed.case.decision?.kind === 'user_decision' && closed.attempts.length === 0 && closed.feedback.length === 0, { caseId, answers: closed.case.decision.answers })
  await openRecord(sessionId, caseId)
  await compareRecord(sessionId, `${label}-unowned-record`, caseId, true)
  const forbidden = await instance.cdp.evaluate(`(() => { const root=document.querySelector('[data-record-detail=${JSON.stringify(caseId)}]'); return {retry:root.querySelectorAll('[data-action="retry"]').length,feedback:root.querySelectorAll('[data-feedback]').length} })()`)
  check(`${label}ClosedUnownedHasNoRetryOrFeedback`, forbidden.retry === 0 && forbidden.feedback === 0, forbidden)
  await settleNativeSkip(sessionId, caseId, label)
  return closed
}

async function cancelUnownedInbox(sessionId, caseId, label, routeRequired = true) {
  await unownedInbox(sessionId, caseId, label, routeRequired)
  const article = `article[data-case-id=${JSON.stringify(caseId)}]`
  await openDisclosure(`weir-da-recovery-${caseId}`)
  await keyboardActivate(`Request cancel ${label}`, 'button', { scope: article, labels: ['取消', 'Cancel'] })
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-cancel-decision"))'), 30_000)
  if (!accessibility.cancelDecisionDialog) await captureAccessibility('cancelDecisionDialog', '#weir-da-cancel-decision')
  await keyboardActivate(`Confirm cancel ${label}`, '#weir-da-cancel-decision .weir-da-actions button:last-child')
  const closed = await waitFor(async () => { const value=await record(sessionId, `${label}-cancelled`, caseId); return value.case.state==='closed'?value:null }, 30_000)
  await expectMutation('cancel', { sessionId, caseId })
  check(`${label}ExplicitCancelHasNoAttemptOrEvidence`, closed.case.agentId === null && closed.case.closing === 'cancelled' && closed.attempts.length === 0 && closed.feedback.length === 0, { caseId })
  await settleNativeSkip(sessionId, caseId, label)
  return closed
}

async function reassignUnownedInbox(sessionId, caseId, label, agentId) {
  await unownedInbox(sessionId, caseId, label)
  const article = `article[data-case-id=${JSON.stringify(caseId)}]`
  await openDisclosure(`weir-da-recovery-${caseId}`)
  await keyboardSelect(`Choose reassign target ${label}`, `${article} select[aria-label="改派"],${article} select[aria-label="Reassign"]`, agentId)
  await keyboardActivate(`Confirm reassign ${label}`, 'button', { scope: article, labels: ['改派', 'Reassign'] })
  const closed = await waitFor(async () => { const value=await record(sessionId, `${label}-reassigned`, caseId); return value.case.state==='closed'?value:null }, 60_000)
  await expectMutation('reassign', { sessionId, caseId, agentId })
  const modes = closed.routeDecisions.map(route => route.mode)
  check(`${label}ExplicitReassignAppendsAndEvaluatesOnce`, closed.case.agentId === agentId && closed.case.closing === 'answered' && closed.attempts.length === 1 && modes.includes('manual_reassign') && modes.filter(mode => mode === 'manual_reassign').length === 1, { caseId, modes, attempts: closed.attempts.length })
  await openRecord(sessionId, caseId)
  await compareRecord(sessionId, `${label}-reassigned-record`, caseId, true)
  await settleNativeSkip(sessionId, caseId, label)
  return closed
}
async function runP4BeforeRestart(sessionId, primary, secondary) {
  const initialConfig = await decisionConfig('p4-initial')
  check('p4InitialConfigFreshAutoShadowOffEmptyWhitelist', initialConfig.effective?.decisionAgentSelectorDefault === 'auto' && initialConfig.effective?.decisionAgentAutoShadow === false && JSON.stringify(initialConfig.effective?.decisionAgentAutoAnswerClasses) === '[]' && initialConfig.effective?.decisionAgentAnswerTimeoutMs === 150, initialConfig.effective)
  const autoSession = (await newIsolatedSession('p4-auto')).sessionId
  const explicitOffSession = (await newIsolatedSession('p4-explicit-off')).sessionId
  const shadowControlSession = (await newIsolatedSession('p4-shadow-control')).sessionId
  const shadowObservedSession = (await newIsolatedSession('p4-shadow-observed')).sessionId
  const pendingSession = (await newIsolatedSession('p4-pending')).sessionId
  const foreignWorkspace = join(root, 'foreign-workspace')
  mkdirSync(foreignWorkspace, { recursive: true })
  const foreignSession = (await newIsolatedSession('p4-foreign', foreignWorkspace)).sessionId
  const freshSessions = [autoSession, explicitOffSession, shadowControlSession, shadowObservedSession, pendingSession, foreignSession]
  const freshOverviews = {}
  for (const id of freshSessions) {
    const overview = await rpc(id, 'p4-fresh-default', 'overview')
    freshOverviews[id] = overview.selector
  }
  check('freshRootsDefaultToPersistedAuto', Object.values(freshOverviews).every(selector => selectorMatches(selector, 'auto')), freshOverviews)
  await openIsolatedSession(explicitOffSession)
  await selectorChoose(explicitOffSession, 'off')
  const explicitOff = sqliteSnapshot('p4-explicit-off')
  check('explicitOffPersistsRowDespiteAutoDefault', explicitOff.rows.selectors.some(row => row.root_session_id === explicitOffSession && row.mode === 'off' && row.agent_id === null), explicitOff.rows.selectors)
  await openIsolatedSession(foreignSession)
  const foreign = await createAgent(foreignSession, 'FOREIGN WORKSPACE PRIVATE PROFILE · never route', 'FOREIGN WORKSPACE PRIVATE PROFILE BODY must never enter the main Router pack.')
  await openIsolatedSession(autoSession)

  await submitMarker(instance, 'GUI_AUTO_EMPTY')
  const emptyPending = await waitCase(autoSession, 'gui-auto-empty', value => value.state === 'awaiting_user')
  const emptyWaiting = await record(autoSession, 'p4-empty-waiting', emptyPending.caseId)
  check('emptyWhitelistAuthorityWithoutClassificationOrAttempt', emptyWaiting.case.agentId === null && emptyWaiting.case.awaitingReason === 'authority' && emptyWaiting.attempts.length === 0 && emptyWaiting.routeDecisions.length === 1 && emptyWaiting.routeDecisions[0].reason === 'admission:authority', { caseId: emptyPending.caseId, route: emptyWaiting.routeDecisions[0] })
  await shot('p4-empty-whitelist-native')
  await answerNative('Native empty')
  p4Evidence.empty = await waitCase(autoSession, 'gui-auto-empty', value => value.state === 'closed')
  await setAutoSettings('p4-allow-a', { answerClasses: ['A'] })
  await openIsolatedSession(autoSession)
  await selectorOpen()
  const autoCopy = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  check('autoSelectorShowsRealAllowedAAndShadowCopy', /Auto/.test(autoCopy) && /A/.test(autoCopy) && /Shadow/.test(autoCopy) && !/白名单为空|whitelist is empty/i.test(autoCopy), autoCopy)
  await captureAccessibility('selectorPanel', '#weir-da-selector-panel')
  await keyboardKey('Close Auto settings proof selector', 'Escape')

  const beforeNativeAuthority = await records(autoSession)
  for (const [marker, answer] of [['GUI_C_APPROVAL', 'Approve'], ['GUI_AUTO_HIGH_RISK', 'Approve high risk'], ['GUI_AUTO_EXECUTION', 'Grant execution']]) {
    await submitMarker(instance, marker)
    await waitFor(async () => (await nativeState()).pending, 30_000)
    await shot(`p4-native-${marker.toLowerCase()}`)
    await answerNative(answer)
    await waitFor(async () => !(await nativeState()).pending, 30_000)
  }
  await submitMarker(instance, 'GUI_C_PLAN')
  await answerPlanReview()
  await waitFor(async () => !(await planReviewState()).pending, 30_000)
  const afterNativeAuthority = await records(autoSession)
  check('approvalPlanHighRiskExecutionStayNativeWithoutCases', afterNativeAuthority.records.length === beforeNativeAuthority.records.length, { before: beforeNativeAuthority.records.length, after: afterNativeAuthority.records.length })

  await agentState(autoSession, primary.agentId, 'disabled')
  await agentState(autoSession, secondary.agentId, 'disabled')
  await openIsolatedSession(autoSession)
  await submitMarker(instance, 'GUI_AUTO_ZERO')
  const zeroPending = await waitCase(autoSession, 'gui-auto-zero', value => value.state === 'awaiting_user')
  const zeroWaiting = await record(autoSession, 'p4-zero-waiting', zeroPending.caseId)
  check('zeroCandidatesNoRouteOrAttempt', zeroWaiting.case.agentId === null && zeroWaiting.case.awaitingReason === 'no_route' && zeroWaiting.attempts.length === 0 && zeroWaiting.routeDecisions[0]?.reason === 'none:no_candidates', { caseId: zeroPending.caseId })
  await answerNative('Native zero')
  p4Evidence.zero = await waitCase(autoSession, 'gui-auto-zero', value => value.state === 'closed')
  await agentState(autoSession, primary.agentId, 'enabled')
  await agentState(autoSession, secondary.agentId, 'enabled')

  await agentState(autoSession, secondary.agentId, 'disabled')
  await openIsolatedSession(autoSession)
  await submitMarker(instance, 'GUI_AUTO_ONE')
  const oneSummary = await waitCase(autoSession, 'gui-auto-one', value => value.state === 'closed')
  const one = await record(autoSession, 'p4-one', oneSummary.caseId)
  check('oneCandidateDeterministicAllGates', one.case.agentId === primary.agentId && one.case.closing === 'answered' && one.routeDecisions[0]?.reason === 'deterministic:single_candidate' && one.attempts.length === 1 && ['g1','g2','g3','g4','g5','g6','g7'].every(gate => one.attempts[0].gates[gate] === true), { caseId: one.case.caseId, route: one.routeDecisions[0] })
  p4Evidence.one = one
  await agentState(autoSession, secondary.agentId, 'enabled')

  await openIsolatedSession(autoSession)
  await submitMarker(instance, 'GUI_AUTO_SELECTED')
  const selectedSummary = await waitCase(autoSession, 'gui-auto-selected', value => value.state === 'closed')
  const selected = await record(autoSession, 'p4-selected', selectedSummary.caseId)
  check('stockClasslessSelectedRouteHasDerivedAAndAllGates', selected.case.agentId === primary.agentId && selected.case.closing === 'answered' && selected.case.request.questions[0].authorizationClass === 'A' && selected.case.request.questions[0].authorizationClassSource === 'auto_classifier' && selected.routeDecisions[0]?.mode === 'auto' && selected.routeDecisions[0]?.chosen === primary.agentId && selected.attempts.length === 1 && ['g1','g2','g3','g4','g5','g6','g7'].every(gate => selected.attempts[0].gates[gate] === true), { caseId: selected.case.caseId, route: selected.routeDecisions[0] })
  p4Evidence.selected = selected
  await shot('p4-stock-classless-selected')
  await openRecord(autoSession, selected.case.caseId)
  await compareRecord(autoSession, 'p4-selected-record', selected.case.caseId, true)

  await openIsolatedSession(autoSession)
  await submitMarker(instance, 'GUI_AUTO_NONE')
  const nonePending = await waitCase(autoSession, 'gui-auto-none', value => value.state === 'awaiting_user')
  p4Evidence.none = await answerUnownedInbox(autoSession, nonePending.caseId, 'p4-none', 'Native none')
  await openIsolatedSession(autoSession)
  await submitMarker(instance, 'GUI_AUTO_AMBIGUOUS')
  const ambiguousPending = await waitCase(autoSession, 'gui-auto-ambiguous', value => value.state === 'awaiting_user')
  const ambiguousWaiting = await record(autoSession, 'p4-ambiguous-waiting', ambiguousPending.caseId)
  check('ambiguityHasCandidatesConflictAndNoAttempt', ambiguousWaiting.case.agentId === null && ambiguousWaiting.case.awaitingReason === 'route_ambiguous' && ambiguousWaiting.attempts.length === 0 && ambiguousWaiting.routeDecisions[0]?.ambiguity?.candidates?.length === 2 && ambiguousWaiting.routeDecisions[0]?.ambiguity?.conflict?.length > 0, { caseId: ambiguousPending.caseId, route: ambiguousWaiting.routeDecisions[0] })
  p4Evidence.ambiguous = await reassignUnownedInbox(autoSession, ambiguousPending.caseId, 'p4-ambiguous', secondary.agentId)
  await openIsolatedSession(autoSession)
  await submitMarker(instance, 'GUI_AUTO_INVALID')
  const invalidPending = await waitCase(autoSession, 'gui-auto-invalid', value => value.state === 'awaiting_user')
  const invalidWaiting = await record(autoSession, 'p4-invalid-waiting', invalidPending.caseId)
  check('invalidOutputFailureHasNoOwnerOrAttempt', invalidWaiting.case.agentId === null && invalidWaiting.case.awaitingReason === 'no_route' && invalidWaiting.attempts.length === 0 && invalidWaiting.routeDecisions[0]?.reason === 'failure:invalid_output', { caseId: invalidPending.caseId })
  p4Evidence.invalid = await cancelUnownedInbox(autoSession, invalidPending.caseId, 'p4-invalid')
  await openIsolatedSession(autoSession)
  await submitMarker(instance, 'GUI_AUTO_TIMEOUT')
  const timeoutPending = await waitCase(autoSession, 'gui-auto-timeout', value => value.state === 'awaiting_user')
  const timeoutWaiting = await record(autoSession, 'p4-timeout-waiting', timeoutPending.caseId)
  check('timeoutFailureHasNoOwnerOrAttempt', timeoutWaiting.case.agentId === null && timeoutWaiting.case.awaitingReason === 'no_route' && timeoutWaiting.attempts.length === 0 && timeoutWaiting.routeDecisions[0]?.reason === 'failure:timeout', { caseId: timeoutPending.caseId })
  p4Evidence.timeout = await cancelUnownedInbox(autoSession, timeoutPending.caseId, 'p4-timeout')

  writeJson(join(out, 'auto-control.json'), { explicitAgentId: secondary.agentId })
  await openIsolatedSession(autoSession)
  await submitMarker(instance, 'GUI_AUTO_EXPLICIT')
  const explicitSummary = await waitCase(autoSession, 'GUI_AUTO_EXPLICIT', value => value.state === 'closed')
  const explicit = await record(autoSession, 'p4-explicit', explicitSummary.caseId)
  const selectorAfterExplicit = await rpc(autoSession, 'p4-explicit-selector', 'overview')
  check('explicitConsultPrioritizesSecondaryWithoutChangingAuto', explicit.case.agentId === secondary.agentId && explicit.case.closing === 'answered' && explicit.routeDecisions[0]?.mode === 'explicit' && explicit.routeDecisions[0]?.chosen === secondary.agentId && explicit.attempts.length === 1 && selectorMatches(selectorAfterExplicit.selector, 'auto'), { caseId: explicit.case.caseId, selector: selectorAfterExplicit.selector })
  p4Evidence.explicit = explicit
  await openIsolatedSession(autoSession)
  await submitMarker(instance, 'GUI_C_RETURN')
  const returnedSummary = await waitCase(autoSession, 'GUI_C_RETURN', value => value.state === 'closed')
  const returned = await record(autoSession, 'p4-returned', returnedSummary.caseId)
  check('returnedConsultReadyForRestartComparison', returned.case.closing === 'returned' && returned.case.decision?.code === 'MISSING_CONTEXT' && returned.routeDecisions[0]?.mode === 'auto' && returned.attempts.length === 1, { caseId: returned.case.caseId })
  p4Evidence.returned = returned

  const shadowControlConfig = await decisionConfig('p4-shadow-control-off')
  check('shadowControlStartsWithRealSettingOff', shadowControlConfig.effective?.decisionAgentAutoShadow === false, shadowControlConfig.effective)
  await openIsolatedSession(shadowControlSession)
  await selectorChoose(shadowControlSession, 'agent', primary.agentId)
  await submitMarker(instance, 'GUI_SHADOW_PARITY')
  const controlSummary = await waitCase(shadowControlSession, 'gui-shadow-parity', value => value.state === 'closed')
  const control = await record(shadowControlSession, 'p4-shadow-control', controlSummary.caseId)
  sqliteSnapshot('p4-shadow-control')
  await setAutoSettings('p4-shadow-observed-on', { shadow: true })
  await openIsolatedSession(shadowObservedSession)
  await selectorOpen()
  const shadowOnCopy = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  check('selectorShowsRealShadowOnCopy', /Shadow/.test(shadowOnCopy) && /已开启|are on/i.test(shadowOnCopy), shadowOnCopy)
  await captureAccessibility('selectorPanel', '#weir-da-selector-panel')
  await keyboardKey('Close Shadow-on selector proof', 'Escape')
  await selectorChoose(shadowObservedSession, 'agent', primary.agentId)
  await submitMarker(instance, 'GUI_SHADOW_PARITY')
  const observedSummary = await waitCase(shadowObservedSession, 'gui-shadow-parity', value => value.state === 'closed')
  const observed = await record(shadowObservedSession, 'p4-shadow-observed', observedSummary.caseId)
  sqliteSnapshot('p4-shadow-observed')
  const actual = detail => ({
    agentId: detail.case.agentId, state: detail.case.state, closing: detail.case.closing,
    request: detail.case.request, scope: detail.case.scope, decision: { kind: detail.case.decision?.kind, answers: detail.case.decision?.answers },
    attempts: detail.attempts.map(attempt => ({ attemptNo: attempt.attemptNo, outcome: attempt.outcome, reasonCode: attempt.reasonCode ?? null, claims: attempt.claims, gates: attempt.gates, citedEvidenceIds: attempt.citedEvidenceIds, evidence: attempt.evidence?.map(ref => ({ source: ref.source, excerpt: ref.excerpt, scope: ref.scope })) })),
    feedback: detail.feedback, corrections: detail.corrections,
  })
  const pinned = detail => detail.routeDecisions.filter(route => route.mode === 'pinned').map(route => ({ mode: route.mode, chosen: route.chosen, reason: route.reason, candidates: route.candidates }))
  const shadow = observed.routeDecisions.filter(route => route.mode === 'auto_shadow')
  check('shadowOnOffIdenticalActualOutcomeAndHistoryExceptAppendOnlyDiagnostic', JSON.stringify(actual(control)) === JSON.stringify(actual(observed)) && JSON.stringify(pinned(control)) === JSON.stringify(pinned(observed)) && control.routeDecisions.length === 1 && observed.routeDecisions.length === 2 && shadow.length === 1 && shadow[0].chosen === secondary.agentId && control.case.agentId === primary.agentId && observed.case.agentId === primary.agentId, { control: actual(control), observed: actual(observed), controlRoutes: control.routeDecisions, observedRoutes: observed.routeDecisions })
  p4Evidence.shadow = { control, observed }
  await setAutoSettings('p4-shadow-off-again', { shadow: false })

  await openIsolatedSession(sessionId)
  await selectorChoose(sessionId, 'auto')
  const pageCases = []
  for (let index = 1; index <= 21; index += 1) {
    const suffix = String(index).padStart(2, '0')
    await submitMarker(instance, `GUI_AUTO_PAGE_${suffix}`)
    const page = await waitCase(sessionId, `gui-auto-page-${suffix}`, value => value.state === 'closed')
    pageCases.push(page)
  }
  check('realTwentyOneAutoRoutesForPagination', pageCases.length === 21 && new Set(pageCases.map(value => value.caseId)).size === 21 && pageCases.every(value => value.closing === 'answered' && value.agentId === primary.agentId && value.attemptCount === 1), { count: pageCases.length, caseIds: pageCases.map(value => value.caseId) })
  p4Evidence.pageCases = pageCases

  await openIsolatedSession(pendingSession)
  await submitMarker(instance, 'GUI_AUTO_PENDING')
  const pendingSummary = await waitCase(pendingSession, 'gui-auto-pending', value => value.state === 'awaiting_user')
  const pending = await record(pendingSession, 'p4-pending-before-restart', pendingSummary.caseId)
  check('pendingStateReadyForRealRestart', pending.case.agentId === null && pending.case.awaitingReason === 'no_route' && pending.attempts.length === 0 && pending.routeDecisions.length === 1, { caseId: pending.case.caseId })
  await shot('p4-pending-before-restart')
  const pendingNative = await nativeState()
  if (pendingNative.pending && !accessibility.nativeDecision) await captureAccessibility('nativeDecision', `[data-question-key=${JSON.stringify(pendingNative.key)}]`)
  p4Evidence.pending = pending
  await scanSession(autoSession, 'p4-auto-session-before-restart.json')

  await openIsolatedSession(sessionId)
  await selectorChoose(sessionId, 'agent', primary.agentId)
  await submitMarker(instance, 'GUI_AUTO_INTERRUPT')
  const interruptedSummary = await waitCase(sessionId, 'gui-auto-interrupt', value => value.state === 'received')
  await waitFor(() => existsSync(join(out, 'it-root', 'decision-auto-interruption.ready')), 30_000)
  const interrupted = await record(sessionId, 'p4-interrupted-before-crash', interruptedSummary.caseId)
  check('interruptedIntakeIsReceivedWithoutRouteOrAttemptBeforeCrash', interrupted.case.agentId === null && interrupted.case.state === 'received' && interrupted.attempts.length === 0 && interrupted.routeDecisions.length === 0, { caseId: interrupted.case.caseId })
  sqliteSnapshot('p4-interrupted-before-crash')
  p4Evidence.interrupted = interrupted
  const state = { sessionId, autoSession, explicitOffSession, shadowControlSession, shadowObservedSession, pendingSession, foreignSession, foreignWorkspace, foreign, freshOverviews, pageCases }
  writeJson(join(out, 'p4-before-restart.json'), state)
  return state
}
async function runP4AfterRestart(state, legacySession, primary, secondary) {
  const autoOverview = await rpc(state.autoSession, 'p4-restart-auto-selector', 'overview')
  const offOverview = await rpc(state.explicitOffSession, 'p4-restart-explicit-off', 'overview')
  const legacyOverview = await rpc(legacySession, 'p4-restart-legacy', 'overview')
  const selectorSnapshot = sqliteSnapshot('p4-restart-selectors')
  check('restartPreservesAutoExplicitOffAndLegacyNoRowOff', selectorMatches(autoOverview.selector, 'auto') && selectorMatches(offOverview.selector, 'off') && selectorMatches(legacyOverview.selector, 'off') && selectorSnapshot.rows.selectors.some(row => row.root_session_id === state.autoSession && row.mode === 'auto') && selectorSnapshot.rows.selectors.some(row => row.root_session_id === state.explicitOffSession && row.mode === 'off') && !selectorSnapshot.rows.selectors.some(row => row.root_session_id === legacySession), { auto: autoOverview.selector, explicitOff: offOverview.selector, legacy: legacyOverview.selector, rows: selectorSnapshot.rows.selectors })

  const pendingRestart = await record(state.pendingSession, 'p4-pending-after-restart', p4Evidence.pending.case.caseId)
  const returnedRestart = await record(state.autoSession, 'p4-returned-after-restart', p4Evidence.returned.case.caseId)
  const interruptedRestart = await record(state.sessionId, 'p4-interrupted-after-restart', p4Evidence.interrupted.case.caseId)
  check('restartPreservesPendingAndReturnedExactly', pendingRestart.case.state === 'awaiting_user' && pendingRestart.case.revision === p4Evidence.pending.case.revision && pendingRestart.case.agentId === null && pendingRestart.attempts.length === 0 && pendingRestart.routeDecisions.length === 1 && JSON.stringify(returnedRestart) === JSON.stringify(p4Evidence.returned), { pending: pendingRestart.case, returned: returnedRestart.case })
  check('interruptedReceivedIntakeRecoversWaitingWithoutRouteOrAttempt', interruptedRestart.case.state === 'awaiting_user' && interruptedRestart.case.awaitingReason === 'interrupted' && interruptedRestart.case.agentId === null && interruptedRestart.attempts.length === 0 && interruptedRestart.routeDecisions.length === 0, { before: p4Evidence.interrupted.case, after: interruptedRestart.case })
  await openIsolatedSession(state.pendingSession, true)
  await shot('p4-pending-after-restart')
  p4Evidence.pendingAfterRestart = await answerUnownedInbox(state.pendingSession, pendingRestart.case.caseId, 'p4-restart-pending', 'Pending user answer')
  await openIsolatedSession(state.sessionId, true)
  p4Evidence.interruptedAfterRestart = await cancelUnownedInbox(state.sessionId, interruptedRestart.case.caseId, 'p4-restart-interrupted', false)
  check('interruptedCancelAddsNoRetroactiveAutoRoute', p4Evidence.interruptedAfterRestart.routeDecisions.length === 0 && p4Evidence.interruptedAfterRestart.attempts.length === 0 && p4Evidence.interruptedAfterRestart.case.closing === 'cancelled', { caseId: interruptedRestart.case.caseId })

  await openIsolatedSession(state.sessionId, true)
  await openPage('metrics')
  const first = await routingReview(state.sessionId, 'p4-routing-first', 'all')
  check('routingReviewFirstPageHasExactlyTwentyRealItems', first.items.length === 20 && typeof first.nextCursor === 'string' && first.nextCursor.length > 0 && first.summary.manualReassign >= 1 && first.summary.autoFailure >= 2 && first.summary.autoAmbiguous >= 1 && first.summary.disagreement >= 1, { items: first.items.length, nextCursor: first.nextCursor, summary: first.summary })
  await compareRoutingReview(state.sessionId, 'p4-routing-first', first)
  await captureAccessibility('routingReview', 'section[data-routing-review]')
  await captureAccessibility('routingStatus', '[data-routing-status]')
  await shot('p4-routing-review-first-20')
  await keyboardSelect('Change routing review window', 'select[data-routing-window]', '7d')
  const sevenDays = await routingReview(state.sessionId, 'p4-routing-seven-days', '7d')
  await compareRoutingReview(state.sessionId, 'p4-routing-seven-days', sevenDays)
  await keyboardSelect('Restore routing review all window', 'select[data-routing-window]', 'all')
  const allAgain = await routingReview(state.sessionId, 'p4-routing-all-again', 'all')
  await compareRoutingReview(state.sessionId, 'p4-routing-all-again', allAgain)
  const combined = await routingLoadMore(state.sessionId, allAgain)
  const combinedIds = combined.items.map(item => item.caseId)
  check('routingPaginationAppendsRealRecordsWithoutDuplicates', allAgain.items.length === 20 && combined.items.length > 20 && new Set(combinedIds).size === combinedIds.length && combinedIds.slice(0, 20).join(',') === allAgain.items.map(item => item.caseId).join(','), { first: allAgain.items.length, combined: combined.items.length })
  const routingDom = await routingReviewDom()
  const forbiddenRoutingActions = await instance.cdp.evaluate(`[...document.querySelectorAll('section[data-routing-review] button')].map(button=>button.textContent.trim()).filter(text=>/采纳|忽略|晋升|adopt|ignore|promot/i.test(text))`)
  check('routingReviewHasNoAdoptIgnoreOrPromotion', forbiddenRoutingActions.length === 0 && /诊断|diagnostic/i.test(routingDom.text), { forbiddenRoutingActions })
  const linked = await openRoutingRecord(state.sessionId, combined.items[0].caseId)
  check('routingRecordLinkUsesAuthorizedAuthority', linked.case.caseId === combined.items[0].caseId && linked.case.rootSessionId === state.sessionId, { caseId: linked.case.caseId })
  await compareRecord(state.sessionId, 'p4-routing-linked-record', linked.case.caseId, true)

  await openPage('metrics')
  await compareRoutingReview(state.sessionId, 'p4-routing-before-visuals', combined)
  await instance.cdp.setPageZoom(1)
  for (const theme of ['light', 'dark']) {
    await instance.cdp.setColorScheme(theme)
    for (const width of [360, 768, 1440]) {
      await instance.cdp.setViewport(width)
      await waitFor(async () => (await instance.cdp.evaluate('innerWidth')) === width, 10_000)
      await layoutAudit(`routing-${theme}-${width}`, theme, 1)
    }
  }
  await instance.cdp.setColorScheme('light')
  for (const width of [360, 768, 1440]) {
    await instance.cdp.setViewport(width, 900, true)
    await instance.cdp.setPageZoom(2)
    await layoutAudit(`routing-zoom200-${width}`, 'light', 2)
  }
  await instance.cdp.setPageZoom(1)
  await instance.cdp.setViewport(1440)

  const restoredConfig = await setAutoSettings('p4-restored', { shadow: false, answerClasses: [] })
  const restoreAutoSessions = [state.sessionId, state.autoSession, state.explicitOffSession, state.shadowControlSession, state.shadowObservedSession, state.pendingSession, state.foreignSession]
  const restoredSelectors = {}
  for (const id of restoreAutoSessions) {
    await openIsolatedSession(id, true)
    restoredSelectors[id] = await selectorChoose(id, 'auto')
  }
  check('testOwnedSelectorsAndSettingsRestored', Object.values(restoredSelectors).every(selector => selectorMatches(selector, 'auto')) && restoredConfig.effective?.decisionAgentAutoShadow === false && JSON.stringify(restoredConfig.effective?.decisionAgentAutoAnswerClasses) === '[]' && restoredConfig.effective?.decisionAgentSelectorDefault === 'auto', { selectors: restoredSelectors, config: restoredConfig.effective })

  const archivedPrimary = await agentState(state.sessionId, primary.agentId, 'archived')
  const archivedSecondary = await agentState(state.sessionId, secondary.agentId, 'archived')
  const archivedForeign = await agentState(state.foreignSession, state.foreign.agentId, 'archived')
  check('everyTemporaryAgentArchivedThroughRealProfileSetState', [archivedPrimary, archivedSecondary, archivedForeign].every(agent => agent.state === 'archived'), { primary: archivedPrimary.state, secondary: archivedSecondary.state, foreign: archivedForeign.state })
  await shot('p4-temporary-agents-archived')
  const finalScan = await scanSession(state.sessionId, 'p4-final-session-scan.json')
  check('p4FinalSessionHasNoForbiddenEvents', finalScan.commandEvents.length === 0 && finalScan.customDecisionEvents.length === 0, { eventCount: finalScan.eventCount })
  const restoration = { restoredConfig, restoredSelectors, archived: [archivedPrimary.agentId, archivedSecondary.agentId, archivedForeign.agentId], legacySession }
  writeJson(join(out, 'p4-restoration.json'), restoration)
  sqliteSnapshot('p4-final-live')
  return restoration
}

function auditP4RawEvidence(state, primary, secondary) {
  const tracePath = join(out, 'mock-trace.jsonl')
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const stockPath = join(out, 'stock-tool-calls.jsonl')
  const stock = readFileSync(stockPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const session = JSON.parse(readFileSync(join(out, 'p4-auto-session-before-restart.json'), 'utf8'))
  const wiresFor = (marker, kind) => trace.filter(entry => entry.autoRouter?.kind === kind && entry.autoRouter.pack?.questions?.some(question => String(question.question).includes(marker)))
  const selectedClassification = wiresFor('GUI_AUTO_SELECTED', 'classification')
  const selectedRoute = wiresFor('GUI_AUTO_SELECTED', 'route')
  const selectedStock = stock.filter(entry => entry.phase === 'before-decision-hook' && entry.arguments?.questions?.some(question => question.id === 'gui-auto-selected'))
  const sessionStock = session.stockAskCalls.filter(event => event.data?.arguments?.questions?.some(question => question.id === 'gui-auto-selected'))
  const forbiddenWire = /generatedDescription|memorySnapshot|snapshotId|principles|feedback|attempts|history|FOREIGN WORKSPACE PRIVATE PROFILE/
  const cleanWire = entry => entry.autoRouter.tools.length === 0 && entry.autoRouter.hasTemperature === false && entry.autoRouter.provider === 'mock' && entry.autoRouter.model === 'mock-1' && !forbiddenWire.test(JSON.stringify(entry.autoRouter.pack))
  const classless = value => value?.questions?.every(question => !Object.hasOwn(question, 'authorizationClass') && !Object.hasOwn(question, 'authorizationClassSource') && !Object.hasOwn(question, 'authorization_class'))
  const pass = selectedClassification.length === 1 && selectedRoute.length === 1 && classless(selectedClassification[0].autoRouter.pack) && selectedClassification[0].autoRouter.pack.candidates === undefined && selectedRoute[0].autoRouter.pack.candidates.map(candidate => candidate.agentId).sort().join(',') === [primary.agentId, secondary.agentId].sort().join(',') && !JSON.stringify(selectedRoute[0]).includes(state.foreign.agentId) && selectedStock.length === 1 && classless(selectedStock[0].arguments) && sessionStock.length === 1 && classless(sessionStock[0].data.arguments) && trace.filter(entry => entry.autoRouter).every(cleanWire) && wiresFor('GUI_AUTO_EMPTY', 'classification').length === 0 && wiresFor('GUI_AUTO_EMPTY', 'route').length === 0 && wiresFor('GUI_AUTO_ZERO', 'classification').length === 1 && wiresFor('GUI_AUTO_ZERO', 'route').length === 0 && wiresFor('GUI_AUTO_ONE', 'classification').length === 1 && wiresFor('GUI_AUTO_ONE', 'route').length === 0 && wiresFor('GUI_AUTO_EXPLICIT', 'classification').length === 0 && wiresFor('GUI_AUTO_EXPLICIT', 'route').length === 0 && wiresFor('GUI_AUTO_TIMEOUT', 'route')[0]?.emitted?.length === 0
  const proof = { pass, selectedClassification, selectedRoute, selectedStock, sessionStock, emptyWires: wiresFor('GUI_AUTO_EMPTY', 'classification').length, zeroRouteWires: wiresFor('GUI_AUTO_ZERO', 'route').length, oneRouteWires: wiresFor('GUI_AUTO_ONE', 'route').length, explicitWires: wiresFor('GUI_AUTO_EXPLICIT', 'classification').length + wiresFor('GUI_AUTO_EXPLICIT', 'route').length, foreignAgentId: state.foreign.agentId, timeout: wiresFor('GUI_AUTO_TIMEOUT', 'route') }
  writeJson(join(out, 'stock-classification-proof.json'), proof)
  check('stockSessionAndWireProveRealClasslessClassificationWithoutInjectionOrLeakage', pass, { selectedClassification: selectedClassification.length, selectedRoute: selectedRoute.length, stock: selectedStock.length, sessionStock: sessionStock.length, foreignExcluded: !JSON.stringify(selectedRoute).includes(state.foreign.agentId) })

  const final = sqliteSnapshot('p4-final-audit')
  const named = { selected: p4Evidence.selected, one: p4Evidence.one, none: p4Evidence.none, ambiguous: p4Evidence.ambiguous, invalid: p4Evidence.invalid, timeout: p4Evidence.timeout, explicit: p4Evidence.explicit, returned: p4Evidence.returned }
  const problems = []
  for (const [name, detail] of Object.entries(named)) {
    const row = final.rows.cases.find(item => item.case_id === detail.case.caseId)
    if (!row || row.agent_id !== detail.case.agentId || row.state !== detail.case.state || row.closing !== detail.case.closing) problems.push(`${name}: Case differs`)
    const actualRoutes = final.rows.route_decisions.filter(route => route.case_id === detail.case.caseId)
    if (actualRoutes.length !== detail.routeDecisions.length) problems.push(`${name}: RouteDecision count differs`)
    for (const route of detail.routeDecisions) {
      const raw = actualRoutes.find(item => item.route_decision_id === route.routeDecisionId)
      if (!raw || raw.mode !== route.mode || raw.chosen !== route.chosen || raw.reason !== route.reason || raw.root_session_id !== detail.case.rootSessionId) problems.push(`${name}: RouteDecision ${route.routeDecisionId} differs`)
    }
    const attempts = final.rows.attempts.filter(attempt => attempt.case_id === detail.case.caseId)
    if (attempts.length !== detail.attempts.length) problems.push(`${name}: Attempt count differs`)
  }
  const comparison = { pass: problems.length === 0, problems, cases: Object.fromEntries(Object.entries(named).map(([name, detail]) => [name, detail.case.caseId])), finalPhase: final.phase }
  writeJson(join(out, 'sqlite-read-model-comparison.json'), comparison)
  check('sqliteReadModelAndRouteJoinAgreeWithoutExtraAttempts', comparison.pass, comparison)
  return { proof, comparison }
}

function writeReport(verdict, error = null) {
  const exceptionCount = runtimeEvents.filter(item => item.event.method === 'Runtime.exceptionThrown').length
  const slotCrashCount = runtimeEvents.filter(item => /slot entry crashed|Slot.*crash/i.test(JSON.stringify(item.event))).length
  const consultDefectPath = join(out, 'product-defect-consult-before-result.json')
  const consultDefect = existsSync(consultDefectPath) ? JSON.parse(readFileSync(consultDefectPath, 'utf8')) : null
  const lines = [
    '# Decision Agent 产品 UX：真实隔离 Desktop 验收报告', '',
    `**结论：${verdict}**`, '',
    `- 基线：\`${BASE_HEAD}\`（current main 车道基线）；运行 ID：\`${runId}\``,
    `- 真实 Electron/CDP：是；未使用组件测试或 mock DOM 代替 Desktop。`,
    `- 隔离根：\`${root}\``,
    `- 证据目录：\`${out}\``,
    `- CDP 端口：\`${PORT}\``,
    `- 检查：${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} PASS`,
    `- 真实 PNG：${screenshots.length} 张（均校验 PNG 签名与非空字节）`,
    `- 原始网络 RPC：${networkRpc.length} 条；权威直读：${authoritativeRpc.length} 条`,
    `- Runtime.exceptionThrown：${exceptionCount}；Slot crash 事件：${slotCrashCount}`, '',
    '## 验收矩阵', '',
    '| 检查 | 结果 |', '|---|---|',
    ...Object.entries(checks).map(([name, pass]) => `| \`${name}\` | ${pass ? 'PASS' : 'BLOCKED'} |`), '',
    '## RPC ↔ UI 与历史约束', '',
    '- `network-rpc.json` 保存 CDP Network 原始请求/响应、rpcId、method、完整 args。',
    '- `authoritative-rpc.json` 保存只读权威 RPC；驱动拒绝直接调用任何写方法。',
    '- `rpc-ui-comparisons.json` 对照记录 ID/revision/state/answers、Snapshot expectedRevision 与 UI。',
    '- `immutable-history.json` 检查 Attempt 与 Snapshot 原则内容未改写。',
    '- 所有 selector、助手、决定、反馈、纠正、整理、采用、放弃、恢复写操作均由真实 UI 的原生 CDP 键盘事件触发；无 Auto、自动整理或自动发布。', '',
    '## 视觉、主题、缩放、键盘与可访问性', '',
    `- 已执行 ${visualAudits.length} 项视觉审计；目标为 360/768/1440 CSS px、light/dark、200% page scale，记录横向溢出、主操作裁切、控件名称与主题计算色。`,
    `- 已保存 ${Object.keys(accessibility).length} 组 CDP Accessibility 证据；keyboard-interactions.json 逐步记录 ${keyboardAudits.length} 组原生 Tab/Shift+Tab/Arrow/Enter/Space/Input.insertText 轨迹、activeElement、accessible name 与结果。`,
    '- `runtime-events.json` 与 `runtime-scan.json` 保存异常、console、Slot crash 和加载失败扫描。', '',
    '## 真实截图', '',
    ...screenshots.map(item => `- [${item.name}](${basename(item.path)}) — ${item.bytes} bytes`), '',
    '## 精确进程与端口清理', '',
    ...cleanups.map(item => `- ${item.label}: main PID ${item.mainPid} / Host PID ${item.hostPid}，mainStopped=${item.mainStopped}，hostStopped=${item.hostStopped}，hostSignal=${item.hostSignal}，portReleased=${item.portReleased}`), '',
    `当前 App、当前 profile/store、生产代码、docs/OpenSpec 复选框均未修改；未 merge、deploy 或 release。隔离 scratch 为证据保留，不属于用户真实数据。`, '',
  ]
  if (error) lines.push('## BLOCKED 原因', '', '```text', error.stack ?? error.message ?? String(error), '```', '')
  if (consultDefect) {
    lines.push('## 产品缺陷：tool result 前咨询卡未收敛', '',
      `- Case \`${consultDefect.caseId}\` 在工具结果持有期间已为 \`${consultDefect.authoritativeDuringHold?.case?.state}\`，revision \`${consultDefect.authoritativeDuringHold?.case?.revision}\`。`,
      `- callId：\`${consultDefect.held.callId}\`；目标 tool result 尚未产生。`,
      `- 实际 DOM：Decision 卡 ${consultDefect.card.cards} 张，可写表单 ${consultDefect.card.forms} 个。`,
      ...consultDefect.lookups.map(entry => `- RPC \`${entry.rpcId}\`：同参数 \`caseForToolCall\` 返回 \`${entry.response?.result?.value?.value?.case?.caseId ?? null}\`。`),
      '- 结论：首个过早 null 读取后，真实 UI 在权威 Case 已可读取时仍未显示单一可写卡，违反任务 8.1 的 tool result 前验收要求。', '')
  }
  if (verdict === 'BLOCKED') lines.push('## 因阻断未完成的范围', '', '首个真实产品缺陷出现后已按要求停止；未执行的后续 UI、视觉、学习或重启步骤不得视为 PASS。详见上方失败检查与 `product-defect-*.json`。', '')
  writeFileSync(join(out, 'evidence-zh.md'), `${lines.join('\n')}\n`)
  writeFileSync(join(GUI, 'evidence-zh.md'), `${lines.join('\n')}\n`)
}

async function runStartupPreflight() {
  const phase = 'GUI-product-P4-9.1-preflight'
  try {
    check('portInitiallyFree', await portFree() && !portListeners())
    writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'running', scope: '9.1-preflight' })
    prepareProfile(root, PORT)
    instance = await startDesktop(true)
    const preflight = JSON.parse(readFileSync(join(out, 'preflight.json'), 'utf8'))
    check('startupPreflightIsolated', preflight.pass && preflight.root === root && preflight.owner?.root === root && preflight.portProbe?.freeBeforeSpawn === true && preflight.databasePath === databasePath && preflight.databaseExists === false, preflight)
    check('startupProvenanceArtifacts', ['host.json', 'instance.json', 'preflight.json'].every(path => existsSync(join(out, path))))
    const expectedClasses = process.env.WEIR_DECISION_GUI_AUTO_CLASSES ?? '[]'
    const expectedConfig = value => value.effective?.decisionAgentsEnabled === true && value.effective?.decisionAgentSelectorDefault === (process.env.WEIR_DECISION_GUI_SELECTOR_DEFAULT === 'auto' ? 'auto' : 'off') && value.effective?.decisionAgentAutoShadow === (process.env.WEIR_DECISION_GUI_SHADOW === '1') && JSON.stringify(value.effective?.decisionAgentAutoAnswerClasses) === JSON.stringify(JSON.parse(expectedClasses))
    const config = await waitFor(async () => { const value = await decisionConfig('preflight'); return expectedConfig(value) ? value : null }, 30_000)
    check('startupEffectiveDecisionConfig', expectedConfig(config), config)
    const slots = await instance.cdp.evaluate('window.__decisionQA.getState()')
    writeJson(join(out, 'slots.json'), slots)
    check('newSlotsActive', slots.sidebar.includes('weir-decisions') && slots.main.includes('weir-decisions') && slots.composer.includes('weir-decision-selector') && slots.toolviews.includes('ask_user_question') && slots.toolviews.includes('decision_consult'), slots)
    await shot('preflight-isolated-desktop')
    await stopOwned('preflight')
    const exceptions = runtimeEvents.filter(item => item.event.method === 'Runtime.exceptionThrown')
    const consoleErrors = runtimeEvents.filter(item => item.event.method === 'Runtime.consoleAPICalled' && item.event.params?.type === 'error')
    const slotCrashes = runtimeEvents.filter(item => /slot entry crashed|Slot.*crash/i.test(JSON.stringify(item.event)))
    const desktopLog = readFileSync(join(out, 'desktop-enabled.log'), 'utf8')
    const importFailures = desktopLog.split('\n').filter(line => /failed to import weir-harness|SessionFormatUnsupportedError|slot entry crashed/i.test(line))
    writeJson(join(out, 'runtime-scan.json'), { exceptionCount: exceptions.length, exceptions, consoleErrorCount: consoleErrors.length, consoleErrors, slotCrashCount: slotCrashes.length, slotCrashes, importFailures, scannedLogs: ['desktop-enabled.log'] })
    check('noRuntimeExceptionsConsoleErrorsOrSlotCrashes', exceptions.length === 0 && consoleErrors.length === 0 && slotCrashes.length === 0 && importFailures.length === 0, { exceptions: exceptions.length, consoleErrors: consoleErrors.length, slotCrashes: slotCrashes.length, importFailures })
    result = {
      phase, verdict: 'PASS', pass: true, scope: 'Task 9.1 startup preflight only; tasks 9.2–9.3 were not run',
      runId, root, out, port: PORT, checks, checkDetails,
      cleanupReceipts: cleanups.map(item => join(out, `${item.label}-exact-pid-cleanup.json`)),
      artifacts: { host: join(out, 'host.json'), instance: join(out, 'instance.json'), preflight: join(out, 'preflight.json'), config: join(out, 'decision-config-preflight.json'), slots: join(out, 'slots.json'), runtime: join(out, 'runtime-scan.json'), cleanup: join(out, 'preflight-exact-pid-cleanup.json'), screenshot: join(out, 'preflight-isolated-desktop.png') },
    }
    writeJson(join(out, 'result.json'), result)
    writeJson(join(GUI, 'result.json'), result)
  } catch (error) {
    failure = error
    if (instance?.cdp) {
      await shot('failure').catch(() => {})
      writeJson(join(out, 'failure-dom.json'), await instance.cdp.evaluate('({text:document.body.innerText,html:document.body.innerHTML})').catch(() => null))
      collectRuntime(instance, 'failure')
    }
  } finally {
    if (instance) {
      try { await stopOwned('failure-cleanup') } catch (cleanupError) { failure ??= cleanupError }
    }
    writeJson(join(out, 'runtime-events.json'), runtimeEvents)
    if (failure) {
      result = { phase, verdict: 'BLOCKED', pass: false, scope: 'Task 9.1 startup preflight only; tasks 9.2–9.3 were not run', runId, root, out, port: PORT, checks, checkDetails, error: failure?.message ?? String(failure), cleanup: cleanups }
      writeJson(join(out, 'result.json'), result)
      writeJson(join(GUI, 'result.json'), result)
      writeJson(join(out, 'driver-error.json'), { message: failure?.message ?? String(failure), stack: failure?.stack ?? null, checks, checkDetails, cleanups })
    }
    writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: failure ? 'blocked' : 'passed', scope: '9.1-preflight', result: join(out, 'result.json') })
  }
}

async function runProductMatrix() {
try {
  process.env.WEIR_DECISION_GUI_SELECTOR_DEFAULT = 'auto'
  process.env.WEIR_DECISION_GUI_SHADOW = '0'
  process.env.WEIR_DECISION_GUI_AUTO_CLASSES = '[]'
  process.env.WEIR_DECISION_GUI_TIMEOUT_MS = '150'
  check('portInitiallyFree', await portFree() && !portListeners())
  writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'running' })
  prepareProfile(root, PORT)
  instance = await startDesktop(true)
  const initialPreflight = JSON.parse(readFileSync(join(out, 'process-1-preflight.json'), 'utf8'))
  check('freshRunStartsWithoutDecisionStore', initialPreflight.databaseExists === false && initialPreflight.databasePath === databasePath, { databasePath, databaseExists: initialPreflight.databaseExists })
  const created = await createSession(instance)
  const sessionId = created.sessionId
  writeJson(join(out, 'session.json'), created)
  knownSessionIds.add(sessionId)
  const slots = await instance.cdp.evaluate('window.__decisionQA.getState()')
  writeJson(join(out, 'slots.json'), slots)
  check('newSlotsActive', slots.sidebar.includes('weir-decisions') && slots.main.includes('weir-decisions') && slots.composer.includes('weir-decision-selector') && slots.toolviews.includes('ask_user_question') && slots.toolviews.includes('decision_consult'), slots)
  await selectorOpen()
  const initialSelector = await instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); return {text:panel.innerText,radios:[...panel.querySelectorAll('input[type="radio"]')].map(el=>({value:el.value,name:el.getAttribute('aria-label'),checked:el.checked})),legacy:Boolean(document.querySelector('select[data-weir-decision-selector]')),auto:/\\bAuto\\b|自动路由/.test(panel.innerText)} })()`)
  const initialAuthority = await rpc(sessionId, 'initial-fresh-auto', 'overview')
  check('dedicatedFreshSelectorOffAutoAndPersistedDefaultAuto', !initialSelector.legacy && initialSelector.auto && initialSelector.radios.map(radio => radio.value).join(',') === 'off,auto' && initialSelector.radios.find(radio => radio.value === 'auto')?.checked === true && selectorMatches(initialAuthority.selector, 'auto') && /白名单为空|whitelist is empty/i.test(initialSelector.text) && /Shadow/.test(initialSelector.text), { initialSelector, authority: initialAuthority.selector })
  await shot('01-selector-empty')
  await keyboardActivate('Create assistant from selector', 'button', { scope: '#weir-da-selector-panel', labels: ['新建助手', 'New assistant'] })
  const longName = '桌面验收助手 · Decision Product QA with an intentionally long English assistant name'
  const preference = '只依据可核验证据；高风险操作仍由用户决定。Prefer source-backed concise answers and preserve the existing approval boundary. 这是用于长文本与编辑验收的用户原创判断偏好。'
  await fillAgent(longName, preference)
  let agents = await waitFor(async () => { const value = await rpc(sessionId, 'initial-create', 'agents'); return value.some(agent => agent.name === longName) ? value : null }, 30_000)
  const primary = agents.find(agent => agent.name === longName)
  await expectMutation('profileUpsert', { sessionId, name: longName, userDescription: preference })
  check('selectorCreateUsesNewPage', primary.state === 'enabled' && primary.scope?.workspaces?.includes(LANE), { agentId: primary.agentId })
  const secondary = await createAgent(sessionId, '空候选与键盘备用助手 · Empty review assistant', 'No existing decisions: the isolated fixture returns no candidate operations for this assistant only.')
  await openAgent(sessionId, primary.agentId)
  await keyboardActivate('Edit assistant', `[data-agent-detail="${primary.agentId}"] [data-action="edit-agent"]`)
  const editedName = `${longName} · 已编辑 / edited`
  const editedPreference = `${preference} 编辑后仍保持相同 scope 与模型继承。`
  await fillAgent(editedName, editedPreference)
  const edited = await waitAgent(sessionId, primary.agentId, value => value.name === editedName && value.userDescription?.text === editedPreference)
  await expectMutation('profileUpsert', { sessionId, agentId: primary.agentId, name: editedName, userDescription: editedPreference, scope: primary.scope, modelRoute: primary.modelRoute })
  check('assistantEditPreservesIdentity', edited.agentId === primary.agentId && edited.revision > primary.revision, { agentId: edited.agentId, before: primary.revision, after: edited.revision })
  await shot('02-assistant-edited')
  await openSession(instance, sessionId)
  await selectorOpen()
  await keyboardActivate('Manage assistants from selector', 'button', { scope: '#weir-da-selector-panel', labels: ['管理助手', 'Manage assistants'] })
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify('main.weir-da-page section[data-view="agents"]')}))`), 30_000)
  check('selectorManageOpensThreeDestinationProductPage', await instance.cdp.evaluate('document.querySelectorAll("main.weir-da-page [data-decision-primary-nav] [data-view]").length === 3'))
  await openSession(instance, sessionId)
  await selectorChoose(sessionId, 'agent', primary.agentId)
  await selectorChoose(sessionId, 'off')
  await shot('03-selector-off')
  const beforeOff = await records(sessionId)
  await submitMarker(instance, 'GUI_C_OFF')
  await waitFor(async () => (await nativeState()).pending, 30_000)
  await shot('04-off-native-bypass')
  await answerNative('Native Off')
  const afterOff = await records(sessionId)
  check('offBypassCreatesNoCase', afterOff.records.length === beforeOff.records.length, { before: beforeOff.records.length, after: afterOff.records.length })
  await selectorChoose(sessionId, 'agent', primary.agentId)
  await shot('05-selector-primary')
  await agentState(sessionId, primary.agentId, 'disabled')
  await openSession(instance, sessionId)
  await waitFor(() => instance.cdp.evaluate(`document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')?.getAttribute('data-unavailable')==='true'`), 30_000)
  await selectorOpen()
  const unavailable = await instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); return {text:panel.innerText,disabledOptionAbsent:!panel.querySelector('input[value=${JSON.stringify(primary.agentId)}]'),trigger:document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]').getAttribute('aria-label')} })()`)
  check('selectedDisabledAssistantTruthfulUnavailable', unavailable.disabledOptionAbsent && /不可用|unavailable/i.test(`${unavailable.text} ${unavailable.trigger}`), unavailable)
  await shot('06-selector-unavailable')
  await keyboardKey('Close unavailable assistant selector', 'Escape')
  await agentState(sessionId, primary.agentId, 'enabled')
  await openSession(instance, sessionId)

  await submitMarker(instance, 'GUI_B_NEW')
  const first = await waitCase(sessionId, 'gui-b-new', current => current.state === 'awaiting_user')
  await waitFor(async () => (await nativeState()).pending, 30_000)
  let firstCard
  try {
    firstCard = await waitFor(async () => { const value = await cardState(first.caseId); return value.cards === 1 ? value : null }, 30_000)
  } catch {
    await collectNetwork()
    const evidence = {
      caseId: first.caseId,
      authority: await record(sessionId, 'missing-native-card', first.caseId),
      native: await nativeState(),
      card: await cardState(first.caseId),
      cardLookupMethods: networkRpc.filter(entry => ['caseForCall', 'caseForToolCall'].includes(entry.method)).map(entry => ({ rpcId: entry.rpcId, method: entry.method, questionIds: entry.args?.questions?.map(question => question.id) ?? [], caseId: entry.response?.result?.value?.value?.case?.caseId ?? null })),
      session: await scanSession(sessionId, 'first-judgment-missing-card-session.json'),
    }
    writeJson(join(out, 'product-defect-native-card.json'), evidence)
    check('firstJudgmentNativeOnlyWritableSurface', false, { caseId: first.caseId, nativePending: evidence.native.pending, cardCount: evidence.card.cards, lookupSawTarget: evidence.cardLookupMethods.some(entry => entry.questionIds.includes('gui-b-new')) })
  }
  check('firstJudgmentNativeOnlyWritableSurface', firstCard.forms === 0 && firstCard.nativeHints === 1, firstCard)
  await shot('07-first-judgment-native')
  await answerNative('Use Short')
  const firstClosed = await waitCase(sessionId, 'gui-b-new', current => current.state === 'closed')
  check('firstJudgmentClosedEscalated', firstClosed.closing === 'escalated' && firstClosed.decision?.kind === 'user_decision' && firstClosed.decision.answers[0].selected[0] === 'Use Short')
  await shot('08-first-judgment-answered')
  await submitMarker(instance, 'GUI_B_REUSE')
  const reuse = await waitCase(sessionId, 'gui-b-reuse', current => current.state === 'closed')
  const reuseDetail = await record(sessionId, 'evidence-reuse', reuse.caseId)
  check('evidenceBasedReuseCitesOriginal', reuse.closing === 'answered' && reuse.decision?.answers?.[0]?.selected?.[0] === 'Use Short' && reuseDetail.attempts.at(-1).evidence.some(ref => ref.source === 'user_decision' && ref.locator.caseId === first.caseId), { caseId: reuse.caseId, sourceCaseId: first.caseId })
  await shot('09-evidence-based-reuse')

  await submitMarker(instance, 'GUI_B_DECIDE')
  const consult = await waitCase(sessionId, 'GUI_B_DECIDE', current => current.state === 'awaiting_user')
  await waitFor(() => existsSync(join(out, 'consult-result-held.json')), 30_000)
  const held = JSON.parse(readFileSync(join(out, 'consult-result-held.json'), 'utf8'))
  const beforeResult = await scanSession(sessionId, 'consult-before-result-session.json')
  let beforeCard
  try {
    beforeCard = await waitFor(async () => { const value = await cardState(consult.caseId); return value.cards === 1 && value.forms === 1 ? value : null }, 30_000)
  } catch {
    await collectNetwork()
    const authoritativeDuringHold = await rpc(sessionId, 'consult-held-read', 'caseForToolCall', { toolCallId: held.callId })
    await collectNetwork()
    const evidence = {
      caseId: consult.caseId, held, beforeResult,
      authoritativeDuringHold,
      card: await cardState(consult.caseId),
      lookups: networkRpc.filter(entry => entry.method === 'caseForToolCall' && entry.args?.toolCallId === held.callId),
    }
    writeJson(join(out, 'product-defect-consult-before-result.json'), evidence)
    check('consultSingleWritableCardBeforeToolResult', false, { caseId: consult.caseId, callId: held.callId, authoritativeCaseId: authoritativeDuringHold?.case?.caseId ?? null, cardCount: evidence.card.cards, forms: evidence.card.forms, lookupCount: evidence.lookups.length })
  }
  check('consultSingleWritableCardBeforeToolResult', !beforeResult.events.some(event => event.type === 'tool/result' && event.callId === held.callId) && beforeCard.cards === 1 && beforeCard.forms === 1, { held, card: beforeCard })
  beforeCard = await revealCard(consult.caseId)
  check('consultWaitingCardPutsDecisionFirst', beforeCard.cards === 1 && beforeCard.forms === 1 && beforeCard.formImmediatelyAfterHeader && beforeCard.formBeforeSecondary && beforeCard.recordAnswerSummaries === 0 && beforeCard.suggestionReviews === 0 && beforeCard.text.includes('GUI_B_DECIDE'), beforeCard)
  await shot('10-consult-before-tool-result')
  writeFileSync(join(out, 'consult-result.release'), `${JSON.stringify({ at: Date.now() })}\n`)
  const afterResult = await waitFor(async () => { const scan = await scanSession(sessionId, 'consult-after-result-session.json'); return scan.events.some(event => event.type === 'tool/result' && event.callId === held.callId) ? scan : null }, 30_000)
  const afterCard = await waitFor(async () => { const value = await cardState(consult.caseId); return value.cards === 1 && value.forms === 1 ? value : null }, 30_000)
  check('consultSingleWritableCardAfterToolResult', afterResult.events.some(event => event.type === 'tool/result' && event.callId === held.callId) && afterCard.cards === 1 && afterCard.forms === 1, { card: afterCard })
  await shot('11-consult-after-tool-result')
  const consulted = await answerInboxWithSuggestions(sessionId, consult.caseId, '12-consult-inbox')
  comparisons.push({ phase: 'consult', caseId: consult.caseId, authority: consulted.case })

  await openRecord(sessionId, first.caseId)
  const firstRecord = await compareRecord(sessionId, 'first-record', first.caseId, true)
  await shot('13-record-advanced-diagnostics')
  const note = '独立备注草稿：只补充审计上下文，不影响后续判断。'
  const correction = 'Use Long — 纠正只影响之后的新判断，原回答保留。'
  await keyboardFill('Enter independent note', `[data-record-detail="${first.caseId}"] [data-draft="comment"]`, note)
  await keyboardFill('Enter correction', `[data-record-detail="${first.caseId}"] [data-draft="correction"]`, correction)
  const preview = await instance.cdp.evaluate(`document.querySelector('[data-record-detail=${JSON.stringify(first.caseId)}] .weir-da-correction-preview')?.innerText`)
  const previewProblems = correctionPreviewProblems(preview)
  check('independentNoteCorrectionPreview', previewProblems.length === 0, previewProblems.length ? { preview, problems: previewProblems } : preview)
  await openRecord(sessionId, reuse.caseId)
  const otherDrafts = await instance.cdp.evaluate(`[...document.querySelectorAll('[data-record-detail=${JSON.stringify(reuse.caseId)}] [data-draft]')].map(el=>({field:el.getAttribute('data-draft'),value:el.value}))`)
  check('caseSwitchDoesNotShareDrafts', otherDrafts.filter(item => ['comment', 'correction'].includes(item.field)).every(item => item.value === ''), otherDrafts)
  await openRecord(sessionId, first.caseId)
  const restoredDrafts = await instance.cdp.evaluate(`[...document.querySelectorAll('[data-record-detail=${JSON.stringify(first.caseId)}] [data-draft]')].map(el=>({field:el.getAttribute('data-draft'),value:el.value}))`)
  check('caseDraftsRestoreIndependently', restoredDrafts.find(item => item.field === 'comment')?.value === note && restoredDrafts.find(item => item.field === 'correction')?.value === correction, restoredDrafts)
  await shot('14-independent-drafts')
  const initialRatings = await instance.cdp.evaluate(`[...document.querySelectorAll('[data-record-detail=${JSON.stringify(first.caseId)}] [data-feedback]')].map(el=>el.getAttribute('data-feedback')).sort()`)
  check('noneStateHasNoUndo', initialRatings.join(',') === 'rating_down,rating_up', initialRatings)
  const ratedUp = await feedback(sessionId, first.caseId, 'rating_up')
  check('ratingUpStateAwareUndo', ratedUp.case.feedbackState === 'validated' && await instance.cdp.evaluate(`Boolean(document.querySelector('[data-record-detail=${JSON.stringify(first.caseId)}] [data-feedback="undo_rating_up"]'))`))
  await shot('15-rating-up')
  await feedback(sessionId, first.caseId, 'undo_rating_up')
  const ratedDown = await feedback(sessionId, first.caseId, 'rating_down')
  check('ratingDownStateAwareUndo', ratedDown.case.feedbackState === 'disputed' && ratedDown.case.needsReview === true)
  await shot('16-rating-down')
  await feedback(sessionId, first.caseId, 'undo_rating_down')
  await keyboardActivate('Submit note', `[data-record-detail="${first.caseId}"] [data-action="comment"]`)
  const commented = await waitFor(async () => { const value = await record(sessionId, 'comment', first.caseId); return value.feedback.some(item => item.kind === 'comment' && item.payload?.text === note) ? value : null }, 30_000)
  await expectMutation('feedback', { sessionId, caseId: first.caseId, verb: 'comment', payload: { text: note } })
  const correctionKept = await instance.cdp.evaluate(`document.querySelector('[data-record-detail=${JSON.stringify(first.caseId)}] [data-draft="correction"]').value`)
  check('noteDoesNotConsumeCorrectionDraft', commented.case.feedbackState === 'none' && correctionKept === correction)
  await keyboardActivate('Submit correction', `[data-record-detail="${first.caseId}"] [data-action="correction"]`)
  const corrected = await waitFor(async () => { const value = await record(sessionId, 'correction', first.caseId); return value.feedback.some(item => item.kind === 'correction' && item.payload?.direction === correction) ? value : null }, 30_000)
  await expectMutation('correction', { sessionId, caseId: first.caseId, direction: correction, scope: firstRecord.authority.case.scope, supersedes: [first.caseId] })
  check('correctionAppendsWithoutHistoryRewrite', corrected.case.decision.answers[0].selected[0] === 'Use Short' && corrected.feedback.some(item => item.kind === 'correction'))
  const learningCorrection = corrected.feedback.find(item => item.kind === 'correction')
  requireEvidence(learningCorrection?.feedbackId, 'actual GUI correction Feedback id')
  await shot('17-note-and-correction-authority')
  await openSession(instance, sessionId)
  await submitMarker(instance, 'GUI_B_CORRECTED')
  const correctedAnswer = await waitCase(sessionId, 'gui-b-corrected', current => current.state === 'closed')
  const correctedDetail = await record(sessionId, 'corrected-answer', correctedAnswer.caseId)
  check('correctionAffectsOnlyFutureAnswer', correctedAnswer.decision?.answers?.[0]?.selected?.[0] === 'Use Long' && correctedDetail.attempts.at(-1).evidence.some(ref => ref.source === 'user_correction'))

  // A pending native question hides the composer, so finish keyboard-only selector
  // coverage at 360px before creating the long native Case.
  await instance.cdp.setViewport(360)
  await keyboardSelector(sessionId, secondary.agentId)
  await keyboardSelector(sessionId, 'auto')
  await keyboardSelector(sessionId, primary.agentId)

  const longCase = await askLongNative(sessionId)
  await openPage('inbox')
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('article[data-case-id=${JSON.stringify(longCase.caseId)}]'))`), 30_000)
  await instance.cdp.setPageZoom(1)
  for (const theme of ['light', 'dark']) {
    await instance.cdp.setColorScheme(theme)
    for (const width of [360, 768, 1440]) {
      await instance.cdp.setViewport(width)
      await waitFor(async () => (await instance.cdp.evaluate('innerWidth')) === width, 10_000)
      await layoutAudit(`${theme}-${width}`, theme, 1)
    }
  }
  check('lightDarkProduceDifferentComputedSurfaces', visualAudits.find(item => item.name === 'light-1440')?.audit.colors?.background !== visualAudits.find(item => item.name === 'dark-1440')?.audit.colors?.background, { light: visualAudits.find(item => item.name === 'light-1440')?.audit.colors, dark: visualAudits.find(item => item.name === 'dark-1440')?.audit.colors })
  await instance.cdp.setColorScheme('light')
  for (const width of [360, 768, 1440]) {
    await instance.cdp.setViewport(width, 900, true)
    await instance.cdp.setPageZoom(2)
    await layoutAudit(`zoom200-${width}`, 'light', 2)
  }
  await instance.cdp.setPageZoom(1)
  await instance.cdp.setViewport(1440)
  await answerInboxWithSuggestions(sessionId, longCase.caseId, '18-long-inbox')
  await openRecord(sessionId, longCase.caseId)
  await captureAccessibility('longRecord', `[data-record-detail="${longCase.caseId}"]`)
  // The decided long Case leaves its native question pending, and a pending native question
  // occupies the composer; finish it with the rendered Skip before any later marker.
  await finishLongNativeWithSkip(sessionId, longCase.caseId)
  await openPage('metrics')
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("[data-metrics-view]"))'), 30_000)
  const metrics = await rpc(sessionId, 'metrics', 'metrics', { window: 'all' })
  const metricsText = await instance.cdp.evaluate('document.querySelector("[data-metrics-view]").innerText')
  check('advancedMetricsRealAndNotQualityScore', metrics.casesOpened >= 5 && /不是质量指标|not a quality metric/i.test(metricsText) && await instance.cdp.evaluate('document.querySelectorAll("main.weir-da-page [data-decision-primary-nav] [data-view]").length === 3'))
  await shot('19-advanced-metrics')

  await openSession(instance, sessionId)
  await submitMarker(instance, 'GUI_LEARNING_SOURCE')
  const learningSourcePending = await waitCase(sessionId, 'gui-learning-source', current => current.state === 'awaiting_user')
  await answerNative('User backed GUI answer')
  const learningSource = await waitCase(sessionId, 'gui-learning-source', current => current.state === 'closed')
  requireEvidence(learningSource.caseId === learningSourcePending.caseId && learningSource.decision?.kind === 'user_decision', 'learning source is a native user decision')
  sqliteSnapshot('learning-source')

  writeJson(join(out, 'no-change-agent.json'), { enabled: true, agentId: secondary.agentId })
  await openAgent(sessionId, secondary.agentId)
  await keyboardActivate('Start empty principle review', `[data-agent-detail="${secondary.agentId}"] [data-action="learning-start"]`)
  const noChangeAgent = await waitAgent(sessionId, secondary.agentId, value => value.learningRuns.length > 0)
  const noChangeRun = await rpc(sessionId, 'no-change', 'learningRun', { learningRunId: noChangeAgent.learningRuns[0].learningRunId })
  const noChangeDom = await waitFor(async () => { const value = await governanceState(secondary.agentId); return value && /没有可整理的新原则|No new principles/.test(value.text) ? value : null }, 30_000)
  check('learningNoChangeTruthfulAndNoSnapshotActions', noChangeRun.outcome === 'failed' && noChangeRun.replay?.detail === 'NO_CANDIDATE_CHANGES' && noChangeRun.operations.length === 0 && noChangeAgent.snapshots.length === 0 && !noChangeDom.controls.some(control => ['learning-publish', 'learning-reject'].includes(control.action)), { runId: noChangeRun.learningRunId, outcome: noChangeRun.outcome })
  await shot('20-learning-no-change')
  writeJson(join(out, 'no-change-agent.json'), { enabled: false, agentId: secondary.agentId })

  const candidateV1 = await startCandidate(sessionId, primary, 1)
  requireEvidence(candidateV1.run.operations[0]?.sources?.[0] === learningCorrection.feedbackId && candidateV1.run.operations[0]?.text === 'Reviewed GUI correction principle: prefer the corrected cross-root answer.', 'v1 uses the actual correction Feedback and correction principle')
  await openDisclosure(`weir-da-learning-advanced-${primary.agentId}`)
  const advancedLearning = await governanceState(primary.agentId)
  check('learningAdvancedDiagnosticsRetainIdsAndReplay', advancedLearning.advanced.includes(candidateV1.run.learningRunId) && advancedLearning.advanced.includes(candidateV1.snapshot.snapshotId) && advancedLearning.advanced.includes(candidateV1.run.inputFrozen.inputHash), { runId: candidateV1.run.learningRunId, snapshotId: candidateV1.snapshot.snapshotId })
  await shot('21-learning-v1-diagnostics')
  const publishedV1 = await confirmLearning('snapshotPublish', sessionId, candidateV1, null)
  check('applyPublishesV1WithExactRevision', publishedV1.snapshot.state === 'published' && publishedV1.snapshot.revision === 2 && publishedV1.agent.currentSnapshotId === candidateV1.snapshot.snapshotId)
  await openSession(instance, sessionId)
  await submitMarker(instance, 'GUI_LEARNING_AFTER_V1')
  const learned = await waitCase(sessionId, 'gui-learning-after-v1', current => current.state === 'closed')
  const learnedDetail = await record(sessionId, 'learned-v1', learned.caseId)
  check('publishedV1UsedWithL5EvidenceOnly', learnedDetail.attempts[0].pins.memorySnapshotId === candidateV1.snapshot.snapshotId && learnedDetail.attempts[0].citedEvidenceIds.length > 0 && learnedDetail.attempts[0].citedEvidenceIds.every(id => learnedDetail.attempts[0].packManifest.evidenceIds.includes(id)))
  await openRecord(sessionId, learned.caseId)
  await compareRecord(sessionId, 'learned-v1-record', learned.caseId, true)
  await shot('22-learned-record-current-evidence')
  const candidateV2 = await startCandidate(sessionId, primary, 2)
  requireEvidence(candidateV2.run.operations[0]?.sources?.[0] === learningCorrection.feedbackId && candidateV2.run.operations[0]?.text === 'Reviewed GUI successor principle: prefer the second source-backed answer.', 'v2 keeps the actual correction source and advances beyond v1')
  const publishedV2 = await confirmLearning('snapshotPublish', sessionId, candidateV2, candidateV1.snapshot.snapshotId)
  check('applyPublishesV2WithParent', publishedV2.snapshot.state === 'published' && publishedV2.snapshot.parentSnapshotId === candidateV1.snapshot.snapshotId)
  const rolledV2 = await confirmLearning('snapshotRollback', sessionId, { agent: publishedV2.agent, run: publishedV2.run, snapshot: publishedV2.snapshot }, candidateV1.snapshot.snapshotId)
  check('restoreReturnsToV1WithoutRewritingV2', rolledV2.snapshot.state === 'rolled_back' && rolledV2.snapshot.revision === 3 && rolledV2.agent.currentSnapshotId === candidateV1.snapshot.snapshotId)
  const candidateV3 = await startCandidate(sessionId, primary, 3)
  requireEvidence(candidateV3.run.operations[0]?.sources?.[0] === learningCorrection.feedbackId && candidateV3.run.operations[0]?.text === 'Reviewed GUI successor principle: prefer the second source-backed answer.', 'v3 keeps the actual correction source and advances beyond restored v1')
  const rejectedV3 = await confirmLearning('snapshotReject', sessionId, candidateV3, candidateV1.snapshot.snapshotId)
  check('discardRetainsUnpublishedCandidateAndCurrentV1', rejectedV3.run.outcome === 'rejected' && rejectedV3.snapshot.state === 'draft' && rejectedV3.snapshot.revision === 1 && rejectedV3.agent.currentSnapshotId === candidateV1.snapshot.snapshotId)
  const p4State = await runP4BeforeRestart(sessionId, primary, secondary)
  const beforeRestart = { agent: rejectedV3.agent, run: rejectedV3.run, snapshot: rejectedV3.snapshot, learned: learnedDetail, selector: await rpc(sessionId, 'before-restart', 'overview') }
  writeJson(join(out, 'before-restart.json'), beforeRestart)
  const scanBefore = await scanSession(sessionId, 'session-before-restart.json')
  check('noCommandOrCustomDecisionSessionEvents', scanBefore.commandEvents.length === 0 && scanBefore.customDecisionEvents.length === 0)

  const beforeGlobalOff = await records(sessionId)
  await stopOwned('process-1', { crash: true })
  instance = await startDesktop(false)
  await openSession(instance, sessionId)
  await selectorOpen()
  const globalOff = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  check('globalOffExplainsBypassAndRetainsPinnedSelection', /全局关闭|off globally/i.test(globalOff) && beforeRestart.selector.selector?.agentId === primary.agentId, globalOff)
  await shot('23-restart-global-off')
  await instance.cdp.key('Escape')
  await openSession(instance, sessionId)
  await submitMarker(instance, 'GUI_C_OFF')
  await waitFor(async () => (await nativeState()).pending, 30_000)
  await answerNative('Native Off')
  const scanAfter = await scanSession(sessionId, 'session-after-restart.json')
  check('restartAddsNoForbiddenSessionEvents', scanAfter.commandEvents.length === 0 && scanAfter.customDecisionEvents.length === 0)
  const legacySession = (await newIsolatedSession('p4-legacy')).sessionId
  await selectorOpen()
  const legacyOffText = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  check('globalOffLegacyRootRemainsOffWithoutDefaultAuto', /全局关闭|off globally/i.test(legacyOffText), legacyOffText)
  await keyboardKey('Close legacy global-off selector', 'Escape')
  await stopOwned('process-2')
  instance = await startDesktop(true)
  await openSession(instance, sessionId)
  const restartedRun = await rpc(sessionId, 'restart', 'learningRun', { learningRunId: rejectedV3.run.learningRunId })
  const restartedSnapshot = await rpc(sessionId, 'restart', 'memorySnapshot', { snapshotId: rejectedV3.snapshot.snapshotId })
  const restartedAgent = await rpc(sessionId, 'restart', 'agent', { agentId: primary.agentId })
  const restartedRecord = await record(sessionId, 'restart', learned.caseId)
  check('restartPersistsLearningFeedbackSelectorAndRecords', restartedRun.outcome === 'rejected' && restartedRun.revision === rejectedV3.run.revision && restartedSnapshot.state === 'draft' && restartedSnapshot.revision === rejectedV3.snapshot.revision && restartedAgent.currentSnapshotId === candidateV1.snapshot.snapshotId && JSON.stringify(restartedRecord) === JSON.stringify(learnedDetail))
  await openAgent(sessionId, primary.agentId)
  await openDisclosure(`weir-da-learning-advanced-${primary.agentId}`)
  await shot('24-restart-learning-persisted')
  await openRecord(sessionId, learned.caseId)
  await compareRecord(sessionId, 'restart-record', learned.caseId, true)
  const afterGlobalOff = await records(sessionId)
  check('globalOffCreatesNoNewCase', afterGlobalOff.records.length === beforeGlobalOff.records.length)
  const scanAfterEnabledRestart = await scanSession(sessionId, 'session-after-enabled-restart.json')
  check('enabledRestartAddsNoForbiddenSessionEvents', scanAfterEnabledRestart.commandEvents.length === 0 && scanAfterEnabledRestart.customDecisionEvents.length === 0)
  await runP4AfterRestart(p4State, legacySession, primary, secondary)
  await stopOwned('process-3')
  sqliteSnapshot('final-stopped')
  copyFileSync(databasePath, join(out, 'decision.db'))
  const immutable = immutableChanges(sqlitePhases)
  writeJson(join(out, 'immutable-history.json'), { pass: immutable.length === 0, changes: immutable, phases: sqlitePhases.map(item => item.phase) })
  check('noAttemptSnapshotOrRouteHistoryRewrite', immutable.length === 0, immutable)
  const exceptions = runtimeEvents.filter(item => item.event.method === 'Runtime.exceptionThrown')
  const consoleErrors = runtimeEvents.filter(item => item.event.method === 'Runtime.consoleAPICalled' && item.event.params?.type === 'error')
  const slotCrashes = runtimeEvents.filter(item => /slot entry crashed|Slot.*crash/i.test(JSON.stringify(item.event)))
  const logErrors = runtimeEvents.filter(item => item.event.method === 'Log.entryAdded' && item.event.params?.entry?.level === 'error')
  auditP4RawEvidence(p4State, primary, secondary)
  const desktopLogs = ['desktop-enabled.log', 'desktop-disabled.log'].map(path => readFileSync(join(out, path), 'utf8'))
  const importFailures = desktopLogs.flatMap(log => log.split('\n').filter(line => /failed to import weir-harness|SessionFormatUnsupportedError|slot entry crashed/i.test(line)))
  writeJson(join(out, 'runtime-scan.json'), { exceptionCount: exceptions.length, exceptions, consoleErrorCount: consoleErrors.length, consoleErrors, slotCrashCount: slotCrashes.length, slotCrashes, logErrorCount: logErrors.length, logErrors, importFailures, scannedLogs: ['desktop-enabled.log', 'desktop-disabled.log'] })
  check('noRuntimeExceptionsConsoleErrorsOrSlotCrashes', exceptions.length === 0 && consoleErrors.length === 0 && slotCrashes.length === 0 && logErrors.length === 0 && importFailures.length === 0, { exceptions: exceptions.length, consoleErrors: consoleErrors.length, slotCrashes: slotCrashes.length, logErrors: logErrors.length, importFailures })
  await collectNetwork()
  check('completeLifecyclePngEvidence', screenshots.length >= 30 && screenshots.every(item => statSync(item.path).size > 8), { count: screenshots.length })
  validateAccessibility()
  const requiredKeyboardActions = ['Open assistant editor', 'Edit assistant', 'Request assistant disabled', 'Confirm assistant disabled', 'Request assistant enabled', 'Confirm assistant enabled', 'Choose native answer Native Off', 'Choose native answer Use Short', 'Choose native answer User backed GUI answer', 'Use inbox suggestions', 'Submit inbox decision', 'Apply feedback rating_up', 'Apply feedback undo_rating_up', 'Apply feedback rating_down', 'Apply feedback undo_rating_down', 'Enter independent note', 'Enter correction', 'Submit note', 'Submit correction', 'Start principle review', 'Request snapshotPublish', 'Confirm snapshotPublish', 'Request snapshotReject', 'Confirm snapshotReject', 'Request snapshotRollback', 'Confirm snapshotRollback']
  const keyboardProblems = requiredKeyboardActions.filter(action => !keyboardAudits.some(audit => audit.action === `Focus: ${action}` && audit.reached && (audit.activation || audit.input)))
  check('completeKeyboardInteractionEvidence', keyboardProblems.length === 0, { missing: keyboardProblems, interactions: keyboardAudits.length })
  check('allOwnedProcessesAndPortFinallyReleased', cleanups.length === 3 && cleanups.every(item => item.pass) && new Set(processProvenance.map(item => item.mainPid)).size === 3 && await portFree() && !portListeners(), { cleanups: cleanups.map(item => ({ label: item.label, mainPid: item.mainPid, hostPid: item.hostPid, pass: item.pass })), port: PORT })
  result = { phase: 'GUI-product-P4-9.2-9.3', verdict: 'PASS', pass: true, runId, root, out, port: PORT, sessionId, primaryAgentId: primary.agentId, secondaryAgentId: secondary.agentId, p4: { sessions: p4State, caseIds: { selected: p4Evidence.selected.case.caseId, one: p4Evidence.one.case.caseId, none: p4Evidence.none.case.caseId, ambiguous: p4Evidence.ambiguous.case.caseId, invalid: p4Evidence.invalid.case.caseId, timeout: p4Evidence.timeout.case.caseId, explicit: p4Evidence.explicit.case.caseId, returned: p4Evidence.returned.case.caseId, pending: p4Evidence.pending.case.caseId, interrupted: p4Evidence.interrupted.case.caseId }, processProvenance }, caseIds: { first: first.caseId, reuse: reuse.caseId, consult: consult.caseId, long: longCase.caseId, learned: learned.caseId }, checks, checkDetails, screenshots, comparisons, cleanupReceipts: cleanups.map(item => join(out, `${item.label}-exact-pid-cleanup.json`)), artifacts: { networkRpc: join(out, 'network-rpc.json'), authoritativeRpc: join(out, 'authoritative-rpc.json'), runtime: join(out, 'runtime-scan.json'), visual: join(out, 'visual-audits.json'), accessibility: join(out, 'accessibility.json'), keyboard: join(out, 'keyboard-interactions.json'), immutable: join(out, 'immutable-history.json'), stockClassification: join(out, 'stock-classification-proof.json'), sqliteReadModel: join(out, 'sqlite-read-model-comparison.json'), p4Restoration: join(out, 'p4-restoration.json'), database: join(out, 'decision.db'), report: join(out, 'evidence-zh.md') } }
  writeJson(join(out, 'result.json'), result)
  writeJson(join(GUI, 'result.json'), result)
  writeReport('PASS')
} catch (error) {
  failure = error
  if (instance?.cdp) {
    await shot('failure').catch(() => {})
    writeJson(join(out, 'failure-dom.json'), await instance.cdp.evaluate('({text:document.body.innerText,html:document.body.innerHTML})').catch(() => null))
    await collectNetwork().catch(() => {})
    collectRuntime(instance, 'failure')
    writeJson(join(out, 'runtime-scan.json'), {
      exceptionCount: runtimeEvents.filter(item => item.event.method === 'Runtime.exceptionThrown').length,
      consoleErrorCount: runtimeEvents.filter(item => item.event.method === 'Runtime.consoleAPICalled' && item.event.params?.type === 'error').length,
      slotCrashCount: runtimeEvents.filter(item => /slot entry crashed|Slot.*crash/i.test(JSON.stringify(item.event))).length,
    })
  }
} finally {
  if (instance) {
    try { await stopOwned(failure ? 'failure-cleanup' : 'final-cleanup') } catch (cleanupError) { failure ??= cleanupError; writeJson(join(out, 'cleanup-error.json'), { message: cleanupError?.message ?? String(cleanupError), stack: cleanupError?.stack ?? null }) }
  }
  writeJson(join(out, 'network-rpc.json'), networkRpc)
  writeJson(join(out, 'authoritative-rpc.json'), authoritativeRpc)
  writeJson(join(out, 'runtime-events.json'), runtimeEvents)
  if (failure) {
    result = { phase: 'GUI-product-UX-8.1-8.2', verdict: 'BLOCKED', pass: false, runId, root, out, port: PORT, checks, checkDetails, error: failure?.message ?? String(failure), cleanup: cleanups }
    writeJson(join(out, 'result.json'), result)
    writeJson(join(GUI, 'result.json'), result)
    writeJson(join(out, 'driver-error.json'), { message: failure?.message ?? String(failure), stack: failure?.stack ?? null, checks, checkDetails, cleanups })
    writeReport('BLOCKED', failure)
  }
  writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: failure ? 'blocked' : 'passed', result: join(out, 'result.json'), report: join(out, 'evidence-zh.md') })
}
}

if (process.env.WEIR_DECISION_PRODUCT_PREFLIGHT_ONLY === '1') await runStartupPreflight()
else await runProductMatrix()
if (failure) {
  console.error(failure)
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ phase: result.phase, verdict: result.verdict, checks: Object.keys(checks).length, screenshots: screenshots.length, rpc: networkRpc.length, out }, null, 2))
}
