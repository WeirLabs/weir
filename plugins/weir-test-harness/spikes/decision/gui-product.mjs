// Real isolated Desktop acceptance for decision-agent-auto-router tasks 9.2–9.3.
// All product mutations are performed on the rendered NEW UI. Direct RPC is read-only.
// Only exact owned main/Host PIDs are signalled; the current App is never addressed.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LANE, writeJson, prepareProfile, startInstance, stopInstance,
  createSession, openSession, submitMarker as submitMarkerRaw,
} from './gui-qa.mjs'
import { waitFor } from './cdp.mjs'
import { answerFormExpression, browserZoomProblems, coldRevealProblems, confirmationFocusProblems, correctionPreviewProblems, crossWorkspaceShareProblems, exactArgs, immutableChanges, layoutProblems, legacyLiveSurfaceProblems, legacyMigratedProfileProblems, mainRegionProblems, masterDetailProblems, memoryZoneProblems, nativeModalProblems, parseDecisionRequest, recordProjectionProblems, routeHistoryProblems, scrollLockProblems, selectorCopyProblems, selectorEnvelope, selectorLayoutProblems, selectorMatches, sessionScrollerProblems, shutdownSocketClosureEntries, stageMigratedLegacyProfile, viewportMeasurementProblems, publicCandidateBodyProblems, publicCandidateRejectionProblems, publicCandidateWordingProblems, exportConfirmationProblems, exportFailureSurfaceProblems, exportSuccessSurfaceProblems, publicGuidancePinProblems, publicPublishedPrinciplesProblems, publicRecordDetailProblems, publicRefinedWordingProblems, publicWireAttributionProblems } from './gui-product-lib.mjs'
import { createUiuxFixture } from './gui-fixture/uiux.js'

process.env.WEIR_DECISION_PRODUCT_UX = '1'
// Task 6.7 cross-workspace memory matrix. It is implemented here and pinned by
// unit tests, but only the full acceptance run (7.3) executes it.
const CROSS_WORKSPACE_MEMORY = process.env.WEIR_DECISION_PRODUCT_CROSS_WORKSPACE === '1'
const BASE_HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: LANE, encoding: 'utf8' }).stdout.trim()
const PORT = Number(process.env.WEIR_DECISION_PRODUCT_PORT ?? 9468)
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('WEIR_DECISION_PRODUCT_PORT must be a valid TCP port')
const GUI = resolve(LANE, process.env.WEIR_DECISION_PRODUCT_EVIDENCE_ROOT ?? join(LANE, '.weir', 'decision-product-ux'))
const SCRATCH = join(LANE, '.weir')
if (!GUI.startsWith(`${SCRATCH}${sep}`)) throw new Error(`Decision Desktop evidence must stay below ${SCRATCH}: ${GUI}`)
mkdirSync(GUI, { recursive: true })
const root = mkdtempSync(join(GUI, 'desktop-'))
const runId = basename(root).replace('desktop-', '')
const out = join(GUI, `run-${runId}`)
mkdirSync(out)
mkdirSync(join(out, 'it-root'), { recursive: true })
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
const uiuxEvidence = { modalAudits: [], selectorLayouts: [], selectorStates: [], confirmations: [], coldReveals: [], masterDetail: [], zoom: [], languages: [] }
const uiuxFixture = createUiuxFixture()
const accessibility = {}
const accessibilityRequirements = {
  selectorTrigger: { role: 'button', name: /决策助手|Decision/i },
  selectorPanel: { role: 'dialog', name: /选择决策助手|Choose.*assistant|Select.*assistant/i, autoChecked: true },
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
const nativeKeyPackets = []
const hostOnboardingDismissals = []
const publicWires = []
const pageBindings = []
const shellReloads = []
const pageReadWitnesses = []
writeJson(join(out, 'host-onboarding.json'), hostOnboardingDismissals)
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

async function shot(name, details = undefined) {
  const path = join(out, `${name}.png`)
  await instance.cdp.screenshot(path)
  const bytes = readFileSync(path)
  requireEvidence(bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${name} is a real non-empty PNG`)
  screenshots.push({ name, path, bytes: bytes.length, ...(details ?? {}) })
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
    const nameMatches = expected.name instanceof RegExp ? expected.name.test(root.name ?? '') : root.name === expected.name
    const problems = nameMatches ? [] : [`${name}: unexpected accessible name ${JSON.stringify(root.name)}`]
    for (const [key, value] of Object.entries(expected.properties ?? {})) {
      if (root.properties?.[key] !== value) problems.push(`${name}: expected ${key}=${value}`)
    }
    if (expected.autoChecked && !nodes.some(node => !node.ignored && node.role === 'radio' && /自动选择助手|Automatically choose an assistant/i.test(node.name ?? '') && (node.properties?.checked === true || node.properties?.checked === 'true' || node.properties?.checked === 'checked'))) problems.push(`${name}: checked automatic-assistant radio with ordinary-language name is missing`)
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
  for (const packet of value.cdp.inputPackets ?? []) nativeKeyPackets.push({ phase, instance: value.instanceNumber, mainPid: value.app.pid, ...packet })
  writeJson(join(out, 'native-key-packets.json'), nativeKeyPackets)
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
  const mainPid = value.app.pid
  const host = JSON.parse(readFileSync(join(out, `process-${value.instanceNumber}.json`), 'utf8')).host
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
    collectRuntime(value, label)
    value.cdp?.close()
    value.log.end()
    base = { spawnedPid: mainPid, hostPid, hostParentPid: host?.parentPid, expectedHome: join(root, 'home'), hostHome: host?.profile?.home, hostProfile: host?.profile?.name, port: PORT, signalCode: 'SIGKILL', stopped: true, crash: true }
    writeJson(join(out, `${label}-cleanup-base.json`), base)
  } else {
    await collectNetwork(value).catch(() => {})
    collectRuntime(value, label)
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
    const items=[...document.querySelectorAll('button,input,textarea,select,a[href],[tabindex],[role="button"],[role="radio"],[role="textbox"],[contenteditable="true"]')].filter(el=>el.offsetParent!==null&&!el.disabled&&el.tabIndex>=0)
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

async function measureFocus(selector) {
  return instance.cdp.evaluate(`(() => {
    const selector=${JSON.stringify(selector)}
    const candidates=[...document.querySelectorAll(selector)]
    const visible=el=>Boolean(el&&el.isConnected&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none')
    const active=document.activeElement
    const target=candidates.find(el=>el===active)??candidates.find(visible)??null
    return {selector,connected:target?.isConnected===true,visible:visible(target),active:Boolean(target&&target===active&&visible(target)),activeTag:active?.tagName?.toLowerCase()??null,activeId:active?.id||null,activeAction:active?.getAttribute?.('data-action')??null,activeAgentId:active?.getAttribute?.('data-agent-id')??null,targetTag:target?.tagName?.toLowerCase()??null,targetId:target?.id||null}
  })()`)
}

async function settleDelayedHostOnboarding(action) {
  const detected = await instance.cdp.evaluate(`(() => {
    const host=document.querySelector('[data-desktop-onboarding="welcome"],[data-desktop-onboarding="credit"]')
    if(!host||host.getClientRects().length===0)return null
    const decisionDialog=[...document.querySelectorAll('#weir-da-selector-panel,dialog.weir-da-dialog')].find(dialog=>dialog.open&&dialog.matches(':modal'))
    if(decisionDialog)return null
    const page=host.getAttribute('data-desktop-onboarding')
    const title=host.querySelector('h1')?.textContent?.trim()??null
    if(page==='credit')return {page,title,activeInside:host.contains(document.activeElement)}
    const start=[...host.querySelectorAll('button')].find(button=>button.offsetParent!==null&&['开始设置','Start setup','Get started'].includes(button.textContent.trim()))
    if(!start)throw new Error('Delayed host welcome onboarding has no visible native start action')
    return {page,title,start:start.textContent.trim(),activeInside:host.contains(document.activeElement)}
  })()`)
  if (!detected) return null
  const resolution = detected.page === 'credit' ? { dismissed: await dismissCreditOnboarding(instance) } : await instance.cdp.chooseDefaultWorkspace(() => dismissCreditOnboarding(instance))
  requireEvidence(resolution?.dismissed === true && (detected.page === 'credit' || (resolution?.onboarding === true && resolution.start && (resolution.selection || resolution.creditDismissed))), `delayed host onboarding is dismissed through the real host UI before ${action}`)
  const receipt = { sequence: hostOnboardingDismissals.length + 1, action, detected, resolution }
  hostOnboardingDismissals.push(receipt)
  writeJson(join(out, 'host-onboarding.json'), hostOnboardingDismissals)
  return receipt
}

async function keyboardFocus(action, selector, options = {}) {
  const audit = { action: `Focus: ${action}`, selector, options, hostOnboardingDismissals: [], steps: [], reached: false }
  keyboardAudits.push(audit)
  saveKeyboardAudits()
  const deadline = Date.now() + 30_000
  const settleHost = async () => {
    if (options.skipDelayedHostOnboarding) return
    const receipt = await settleDelayedHostOnboarding(action)
    if (!receipt) return
    audit.hostOnboardingDismissals.push(receipt.sequence)
    saveKeyboardAudits()
  }
  await waitFor(async () => {
    await settleHost()
    return (await keyboardSnapshot(selector, options)).ready
  }, 30_000)
  const direction = (await keyboardSnapshot(selector, options)).direction
  for (let step = 0; step < 500 && Date.now() < deadline; step += 1) {
    await settleHost()
    const before = await keyboardSnapshot(selector, options)
    if (before.reached) {
      audit.reached = true
      audit.activeElement = before.active
      audit.target = before.target
      saveKeyboardAudits()
      return audit
    }
    await instance.cdp.key('Tab', direction === 'Shift+Tab' ? 8 : 0)
    const after = await keyboardSnapshot(selector, options)
    audit.steps.push({ step, key: direction, from: before.active, activeElement: after.active, target: before.target })
    saveKeyboardAudits()
  }
  throw new Error(`Keyboard target unreachable: ${action} ${selector} ${JSON.stringify(audit.steps.at(-1))}`)
}

async function keyboardActivate(action, selector, options = {}) {
  const audit = await keyboardFocus(action, selector, options)
  if (options.scrollBaseline) {
    requireEvidence(['immediate', 'stable'].includes(options.scrollBaseline), `${action} has a supported pre-activation scroll baseline`)
    const measure = options.scrollBaseline === 'stable' ? measureStableScrollContainers : measureScrollContainers
    audit.scrollBefore = await measure({ root: 'html', body: 'body' }, selector)
    saveKeyboardAudits()
  }
  await instance.cdp.key(options.key ?? 'Enter')
  if (options.expectFocus) {
    audit.focus = await waitFor(async () => { const focus = await measureFocus(options.expectFocus); return focus.active && focus.connected && focus.visible ? focus : null }, 10_000).catch(() => measureFocus(options.expectFocus))
    saveKeyboardAudits()
    requireEvidence(audit.focus.active && audit.focus.connected && audit.focus.visible && !['body', 'html'].includes(audit.focus.activeTag), `${action} hands off to its intended visible connected activeElement ${options.expectFocus}`)
  }
  audit.activation = { key: options.key ?? 'Enter', activeElement: (await keyboardSnapshot(selector, options)).active, expectedFocus: audit.focus ?? null }
  saveKeyboardAudits()
  return audit
}

async function keyboardMenuActivate(action, selector, options = {}) {
  const audit = { action: `Focus: ${action}`, selector, options, steps: [], reached: false }
  keyboardAudits.push(audit)
  saveKeyboardAudits()
  const read = () => instance.cdp.evaluate(`(() => {
    const scope=${JSON.stringify(options.scope ?? '[role="menu"]')}
    const selector=${JSON.stringify(selector)}
    const labels=${JSON.stringify(options.labels ?? null)}
    const namePattern=${JSON.stringify(options.namePattern ?? null)}
    const describe=el=>{
      if(!el)return null
      const labelled=(el.getAttribute?.('aria-labelledby')??'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent??'').join(' ')
      const labelText=[...(el.labels??[])].map(label=>label.textContent).join(' ')
      return {tag:el.tagName?.toLowerCase()??null,id:el.id||null,role:el.getAttribute?.('role')??null,accessibleName:String(el.getAttribute?.('aria-label')||labelled||labelText||el.innerText||el.textContent||el.value||'').trim().slice(0,500),value:typeof el.value==='string'?el.value:null}
    }
    const root=document.querySelector(scope)
    const items=root?[...root.querySelectorAll(selector)].filter(el=>el.offsetParent!==null&&!el.disabled):[]
    const target=items.find(el=>{
      const named=describe(el)?.accessibleName??''
      return (!labels||labels.includes(el.textContent.trim())||labels.includes(named))&&(!namePattern||new RegExp(namePattern,'i').test(named))
    })??null
    const active=document.activeElement
    return {ready:Boolean(target),reached:target===active,activeIndex:items.indexOf(active),targetIndex:items.indexOf(target),items:items.map(describe),active:describe(active),target:describe(target)}
  })()`)
  let current = await waitFor(async () => { const state = await read(); return state.ready ? state : null }, 30_000)
  const move = async key => {
    const before = current
    await instance.cdp.key(key)
    current = await read()
    audit.steps.push({ step: audit.steps.length, key, from: before.active, activeElement: current.active, target: current.target })
    saveKeyboardAudits()
  }
  if (!current.reached && current.activeIndex < 0) await move('Tab')
  requireEvidence(current.reached || current.activeIndex >= 0, `${action} enters the open menu through one native Tab`)
  for (let step = 0; !current.reached && step < current.items.length; step += 1) {
    const direction = current.targetIndex > current.activeIndex ? 'ArrowDown' : 'ArrowUp'
    const expectedIndex = current.activeIndex + (direction === 'ArrowDown' ? 1 : -1)
    requireEvidence(expectedIndex >= 0 && expectedIndex < current.items.length, `${action} reaches the exact item without cycling away`)
    await move(direction)
    requireEvidence(current.activeIndex === expectedIndex, `${action} native ${direction} moves to the predicted menu item`)
  }
  requireEvidence(current.reached, `${action} reaches the exact rendered menu item`)
  audit.reached = true
  audit.activeElement = current.active
  audit.target = current.target
  saveKeyboardAudits()
  await instance.cdp.key('Enter')
  audit.activation = { key: 'Enter', activeElement: (await read()).active }
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
  const current = await instance.cdp.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); return el?{value:el.value,options:[...el.options].map(option=>({value:option.value,label:option.label}))}:null })()`)
  const target = current.options.find(option => option.value === value)
  requireEvidence(target, `${action} exposes the authoritative target option`)
  if (current.value === value) { saveKeyboardAudits(); return audit }
  let prefix = ''
  for (const char of target.label) {
    prefix += char
    if (current.options.filter(option => option.label.startsWith(prefix)).length === 1) break
  }
  const matches = current.options.filter(option => option.label.startsWith(prefix))
  requireEvidence(matches.length === 1 && matches[0].value === value, `${action} has a unique typeahead prefix`)
  for (const char of prefix) {
    await instance.cdp.request('Input.dispatchKeyEvent', { type: 'char', key: char, code: /^[a-z]$/i.test(char) ? `Key${char.toUpperCase()}` : '', text: char, unmodifiedText: char })
  }
  audit.selection.steps.push({ from: current.value, typeahead: prefix })
  audit.input = { method: 'Input.dispatchKeyEvent', type: 'char', text: prefix }
  saveKeyboardAudits()
  await waitFor(() => instance.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`), 10_000)
  return audit
}
async function dismissCreditOnboarding(instance) {
  const scope = '[data-desktop-onboarding="credit"]'
  const present = await instance.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(scope)}))`)
  if (!present) return false
  await keyboardActivate('Skip host credit onboarding', 'button', { scope, labels: ['跳过', 'Skip'], skipDelayedHostOnboarding: true })
  await waitFor(() => instance.cdp.evaluate('document.body.innerText.includes("暂时跳过充值？") || document.body.innerText.includes("Skip adding credits?")'), 30_000)
  await keyboardActivate('Confirm host credit onboarding skip', 'button', { labels: ['我知道了', 'Got it'], skipDelayedHostOnboarding: true })
  await waitFor(() => instance.cdp.evaluate('!document.querySelector("[data-desktop-onboarding]")'), 30_000)
  return true
}

async function submitMarker(instance, marker) {
  await dismissCreditOnboarding(instance)
  await submitMarkerRaw(instance, marker)
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
  return waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')) && window.__decisionQA.getState().activeSessionId===${JSON.stringify(sessionId)}`), 60_000)
}

async function keyboardKey(action, key, details = {}) {
  const before = await keyboardSnapshot('body')
  await instance.cdp.key(key)
  const after = await keyboardSnapshot('body')
  keyboardAudits.push({ action, key, ...details, from: before.active, activeElement: after.active })
  saveKeyboardAudits()
}

async function selectorOpen(options = {}) {
  const activation = await keyboardActivate('Open decision assistant selector', '[data-weir-decision-trigger="weir-decision-selector"]', options)
  await waitFor(() => instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); return Boolean(panel&&!/正在加载判断记录|Loading decision/i.test(panel.innerText)) })()`), 30_000)
  return activation
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
  await keyboardActivate('Save assistant', 'form[data-agent-editor] button[type="submit"]', { expectFocus: '.weir-da-agent-back,[data-agent-detail]' })
}

async function createAgent(sessionId, name, preference) {
  await openPage('agents')
  await keyboardActivate('Open assistant editor', '[data-action="create-agent"]', { expectFocus: '[data-agent-field="name"]' })
  await fillAgent(name, preference)
  const agents = await waitFor(async () => { const value = await rpc(sessionId, 'agent-create', 'agents'); return value.some(agent => agent.name === name) ? value : null }, 30_000)
  const agent = agents.find(item => item.name === name)
  await expectMutation('profileUpsert', { sessionId, name, userDescription: preference })
  return agent
}

async function openAgent(sessionId, agentId) {
  await openPage('agents')
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-agent-summary=${JSON.stringify(agentId)}] [data-action="open-agent"]'))`), 30_000)
  await keyboardActivate('Open assistant details', `[data-agent-summary="${agentId}"] [data-action="open-agent"]`, { expectFocus: `.weir-da-agent-back,[data-agent-detail="${agentId}"]` })
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-agent-detail=${JSON.stringify(agentId)}]'))`), 30_000)
  return rpc(sessionId, 'agent-open', 'agent', { agentId })
}

async function agentState(sessionId, agentId, state) {
  await openIsolatedSession(sessionId, true)
  await openAgent(sessionId, agentId)
  const originSelector = `[data-agent-detail="${agentId}"] [data-agent-state="${state}"]`
  const scrollBefore = (await keyboardActivate(`Request assistant ${state}`, originSelector, { scrollBaseline: 'immediate' })).scrollBefore
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-agent-state"))'), 30_000)
  const audit = await beginModalAudit(`assistant-${state}-${agentId}`, '#weir-da-agent-state', originSelector, { before: scrollBefore })
  const controlId = await holdDecision('profileSetState', { sessionId, agentId, state })
  await keyboardActivate(`Confirm assistant ${state}`, `#weir-da-agent-state .weir-da-actions button${state === 'enabled' ? '[data-variant="primary"]' : ':last-child'}`)
  await waitFor(async () => (await decisionControl(controlId)).started, 30_000)
  const beforeFocus = await measureConfirmationFocus(originSelector, controlId)
  await startScrollTimeline(`assistant-${state}-${agentId}`)
  await releaseDecision(controlId)
  const agent = await waitFor(async () => { const value = await rpc(sessionId, 'agent-state', 'agent', { agentId }); return value.state === state ? value : null }, 30_000)
  const mutation = await expectMutation('profileSetState', { sessionId, agentId, state })
  const afterFocus = await waitFor(async () => { const focus = await measureConfirmationFocus(originSelector, controlId); return focus.control.settled && (focus.targetFocused || focus.fallbackFocused) ? focus : null }, 30_000).catch(() => measureConfirmationFocus(originSelector, controlId))
  const focus = { beforeSettle: { ...beforeFocus, promiseSettled: beforeFocus.control.settled }, afterSettle: { ...afterFocus, promiseSettled: afterFocus.control.settled } }
  const focusProblems = confirmationFocusProblems(focus)
  // Turning an assistant on or off really does shrink the page, so the clamp
  // path needs the same settled authoritative mutation receipt as a publish.
  const contentMutation = {
    method: 'profileSetState', args: { sessionId, agentId, state }, rpcId: mutation.rpcId, response: mutation.response,
    settled: afterFocus.control.settled,
    authoritative: { confirmed: agent.agentId === agentId && agent.state === state, agentId, state: agent.state },
  }
  uiuxEvidence.confirmations.push({ kind: `assistant-${state}`, agentId, controlId, focus, problems: focusProblems })
  await finishModalAudit(audit, { focus, focusProblems, contentMutation })
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

async function setAutoSettings(phase, { shadow, answerClasses, answerTimeoutMs }) {
  await openDecisionSettings()
  if (shadow !== undefined) {
    const selector = '[aria-label="Auto Shadow 诊断"],[aria-label="Auto Shadow diagnostics"]'
    const current = await instance.cdp.evaluate(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item=>item.offsetParent!==null); return el?{checked:el.getAttribute('aria-checked')==='true'||el.checked===true}:null })()`)
    requireEvidence(current, 'the real Auto Shadow settings control is visible')
    if (current.checked !== shadow) await keyboardActivate(`Set Shadow ${shadow ? 'on' : 'off'}`, selector, { key: 'Space' })
  }
  if (answerClasses !== undefined) {
    const value = JSON.stringify(answerClasses)
    await keyboardFill('Edit Auto answer-class whitelist', 'input#plugin-config-weir-settings-decisionAgentAutoAnswerClasses', value)
  }
  if (answerTimeoutMs !== undefined) {
    await keyboardFill('Edit Auto answer timeout', 'input#plugin-config-weir-settings-decisionAgentAnswerTimeoutMs', String(answerTimeoutMs))
  }
  await keyboardActivate('Save Decision Auto settings', '[data-save-bar] button', { namePattern: '^(保存|Save)' })
  const expected = value => (shadow === undefined || value.effective?.decisionAgentAutoShadow === shadow) && (answerClasses === undefined || JSON.stringify(value.effective?.decisionAgentAutoAnswerClasses) === JSON.stringify(answerClasses)) && (answerTimeoutMs === undefined || value.effective?.decisionAgentAnswerTimeoutMs === answerTimeoutMs)
  const config = await waitFor(async () => { const value = await decisionConfig(phase); return expected(value) ? value : null }, 30_000)
  await shot(`settings-${phase}`)
  await keyboardKey('Close settings after authority reread', 'Escape', { phase })
  await waitFor(() => instance.cdp.evaluate('!document.body.innerText.includes("Auto Shadow 诊断") && !document.body.innerText.includes("Auto Shadow diagnostics")'), 30_000)
  // Settings are external volatile input to an already mounted selector. Leave the
  // conversation once so the next real session open remounts and rereads overview.auto.
  await openPage('inbox')
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
    if (item.questionSummary && !rendered?.text.includes(item.questionSummary)) problems.push(`routing title ${item.caseId} is missing`)
    const expectedRecord = item.record?.caseId === item.caseId ? item.caseId : null
    if ((rendered?.recordCaseId ?? null) !== expectedRecord) problems.push(`record link ${item.caseId} differs`)
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
    // The store is schema v2 (zone/namespace columns); every row envelope it
    // writes stays schema_version 1, so both facts are required together.
    const envelopeVersions = [...new Set(ENVELOPE_TABLES.flatMap(table => (raw.rows[table] ?? []).map(row => row.schema_version)))]
    raw.envelopeVersions = envelopeVersions
    requireEvidence(raw.schemaVersion === 2 && raw.integrity === 'ok' && envelopeVersions.every(version => version === 1), `${phase} SQLite v2 store with v1 row envelopes`)
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
  const originSelector = `[data-action="${action}"]`
  const scrollBefore = (await keyboardActivate(`Request ${kind}`, originSelector, { scrollBaseline: 'immediate' })).scrollBefore
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('#${dialog}'))`), 30_000)
  const confirmation = await instance.cdp.evaluate(`document.querySelector('#${dialog}').innerText`)
  requireEvidence(/只影响|历史|future|history/i.test(confirmation), `${kind} consequence confirmation`)
  await captureAccessibility(`${kind}Dialog`, `#${dialog}`)
  await shot(`${kind}-v${candidate.snapshot.version}-confirm`)
  const audit = await beginModalAudit(`${kind}-v${candidate.snapshot.version}`, `#${dialog}`, originSelector, { before: scrollBefore })
  const controlId = await holdDecision(kind, { sessionId, snapshotId, expectedRevision })
  await keyboardActivate(`Confirm ${kind}`, `#${dialog} .weir-da-actions button:last-child`)
  await waitFor(async () => (await decisionControl(controlId)).started, 30_000)
  const beforeFocus = await measureConfirmationFocus(originSelector, controlId)
  await startScrollTimeline(kind)
  await releaseDecision(controlId)
  const agent = await waitAgent(sessionId, candidate.agent.agentId, value => {
    if (kind === 'snapshotPublish') return value.currentSnapshotId === snapshotId
    if (kind === 'snapshotReject') return value.learningRuns.some(run => run.learningRunId === candidate.run.learningRunId && run.outcome === 'rejected')
    return value.snapshots.some(snapshot => snapshot.snapshotId === snapshotId && snapshot.state === 'rolled_back') && (value.currentSnapshotId ?? null) === expectedCurrentId
  })
  const mutation = await expectMutation(kind, { sessionId, snapshotId, expectedRevision })
  const afterFocus = await waitFor(async () => { const focus = await measureConfirmationFocus(originSelector, controlId); return focus.control.settled && (focus.targetFocused || focus.fallbackFocused) ? focus : null }, 30_000).catch(() => measureConfirmationFocus(originSelector, controlId))
  const focus = { beforeSettle: { ...beforeFocus, promiseSettled: beforeFocus.control.settled }, afterSettle: { ...afterFocus, promiseSettled: afterFocus.control.settled } }
  const focusProblems = confirmationFocusProblems(focus)
  const currentSnapshotId = agent.currentSnapshotId ?? null
  const snapshotState = agent.snapshots.find(snapshot => snapshot.snapshotId === snapshotId)?.state ?? null
  const runOutcome = candidate.run?.learningRunId ? agent.learningRuns.find(run => run.learningRunId === candidate.run.learningRunId)?.outcome ?? null : null
  const confirmed = kind === 'snapshotPublish'
    ? currentSnapshotId === snapshotId && snapshotState === 'published'
    : kind === 'snapshotReject'
      ? runOutcome === 'rejected' && snapshotState === 'draft' && currentSnapshotId === expectedCurrentId
      : snapshotState === 'rolled_back' && currentSnapshotId === expectedCurrentId
  const contentMutation = {
    method: kind, args: { sessionId, snapshotId, expectedRevision }, rpcId: mutation.rpcId, response: mutation.response, settled: afterFocus.control.settled,
    authoritative: { confirmed, currentSnapshotId, snapshotState, runOutcome },
  }
  uiuxEvidence.confirmations.push({ kind, snapshotId, controlId, focus, problems: focusProblems })
  await finishModalAudit(audit, { focus, focusProblems, contentMutation })
  const snapshot = await rpc(sessionId, `${kind}-snapshot`, 'memorySnapshot', { snapshotId })
  const run = candidate.run?.learningRunId ? await rpc(sessionId, `${kind}-run`, 'learningRun', { learningRunId: candidate.run.learningRunId }) : null
  comparisons.push({ phase: kind, kind: 'learning', snapshotId, expectedRevision, rpcId: mutation.rpcId, response: mutation.response, authoritative: { currentSnapshotId: agent.currentSnapshotId ?? null, snapshotState: snapshot.state, snapshotRevision: snapshot.revision, runOutcome: run?.outcome ?? null } })
  writeJson(join(out, 'rpc-ui-comparisons.json'), comparisons)
  sqliteSnapshot(kind)
  await shot(`${kind}-v${candidate.snapshot.version}-done`)
  return { agent, snapshot, run, mutation }
}

async function normalizeDecisionHostChrome(zoom) {
  let action = 'not-needed'
  if (zoom === 1 && await instance.cdp.evaluate('innerWidth') <= 400) {
    await instance.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const labels = ['收起侧边栏', '折叠侧边栏', 'Close sidebar', 'Collapse sidebar']
    const close = await instance.cdp.evaluate(`(() => {
      const labels=${JSON.stringify(labels)}
      return [...document.querySelectorAll('button[aria-label]')].some(button=>{
        const rect=button.getBoundingClientRect()
        return button.offsetParent!==null&&labels.includes(button.getAttribute('aria-label'))&&rect.right>0&&rect.left<innerWidth&&rect.bottom>0&&rect.top<innerHeight
      })
    })()`)
    if (close) await keyboardActivate('Close host sidebar for Decision visual audit', 'button[aria-label]', { labels })
    action = close ? 'native-close' : 'already-closed-or-settling'
  }
  await keyboardFocus('Focus Decision navigation for visual audit', 'main.weir-da-page [data-decision-primary-nav] [data-view]')
  await keyboardKey('Restore Decision page top for visual audit', 'Home')
  return { action: `${action}+native-home` }
}

async function layoutAudit(name, theme = 'light', zoom = 1) {
  const expectedColors = {
    light: { background: 'rgb(255, 255, 255)', color: 'rgb(15, 17, 21)' },
    dark: { background: 'rgb(21, 21, 23)', color: 'rgb(249, 250, 251)' },
  }[theme]
  if (!expectedColors) throw new Error(`unsupported visual audit theme: ${theme}`)
  const hostNormalization = await normalizeDecisionHostChrome(zoom)
  await waitFor(async () => {
    const colors = await instance.cdp.evaluate(`(() => { const page=document.querySelector('.weir-da-page'); return page?{background:getComputedStyle(page).backgroundColor,color:getComputedStyle(page).color}:null })()`)
    return colors?.background === expectedColors.background && colors?.color === expectedColors.color ? colors : null
  }, 10_000)
  let audit = null
  await waitFor(async () => {
    const candidate = await instance.cdp.evaluate(`(() => {
    const visible=el=>Boolean(el&&el.offsetParent!==null)
    const nameOf=el=>el.getAttribute('aria-label')||el.innerText?.trim()||[...(el.labels??[])].map(label=>label.innerText).join(' ')||el.closest('label')?.innerText||''
    const controls=[...document.querySelectorAll('.weir-da-page button,.weir-da-page input,.weir-da-page textarea,.weir-da-page select,.weir-da-selector-panel button,.weir-da-selector-panel input')].filter(visible)
    const primaries=[...document.querySelectorAll('.weir-da-page .weir-da-button[data-variant="primary"],.weir-da-conversation-card .weir-da-button[data-variant="primary"]')].filter(visible)
    const surfaces=[...document.querySelectorAll('.weir-da-page,.weir-da-selector-panel')].filter(visible)
    const page=document.querySelector('.weir-da-page')
    const visual=visualViewport??{width:innerWidth,height:innerHeight,offsetLeft:0,offsetTop:0,scale:1}
    const rect=el=>{if(!el)return null;const value=el.getBoundingClientRect();return {x:value.x,y:value.y,left:value.left,top:value.top,width:value.width,height:value.height,right:value.right,bottom:value.bottom}}
    const inVisual=el=>{const value=rect(el);if(!value)return false;const left=visual.offsetLeft??0;const top=visual.offsetTop??0;return value.right>left&&value.left<left+visual.width&&value.bottom>top&&value.top<top+visual.height}
    const probe=el=>{
      if(!el)return null
      const value=rect(el);const points=[]
      const left=Math.max(value.left+8,(visual.offsetLeft??0)+1);const right=Math.min(value.right-8,(visual.offsetLeft??0)+visual.width-1)
      const top=Math.max(value.top+8,(visual.offsetTop??0)+1);const bottom=Math.min(value.bottom-8,(visual.offsetTop??0)+visual.height-1)
      if(right<left||bottom<top)return {rect:value,hitTestSamples:0,occlusions:[]}
      const middleX=(left+right)/2;const middleY=(top+bottom)/2
      for(let x=left;x<=right;x+=8)points.push([x,middleY])
      for(let y=top;y<=bottom;y+=32)points.push([middleX,y])
      const unique=[...new Map(points.filter(([x,y])=>Number.isFinite(x)&&Number.isFinite(y)).map(point=>[point.map(value=>value.toFixed(3)).join(','),point])).values()]
      const hits=unique.map(([x,y])=>{const owned=el.contains(document.elementFromPoint(x,y));return {x,y,owned,...(!owned?{stack:document.elementsFromPoint(x,y).slice(0,4).map(item=>({tag:item.tagName,id:item.id||null,class:typeof item.className==='string'?item.className.slice(0,160):'',ariaLabel:item.getAttribute('aria-label')}))}:{})}})
      return {rect:value,hitTestSamples:hits.length,occlusions:hits.filter(hit=>!hit.owned)}
    }
    const nav=page?.querySelector('[data-decision-primary-nav]')
    const hostOpen=[...document.querySelectorAll('button[aria-label]')].find(button=>!page?.contains(button)&&/打开侧边栏|展开侧边栏|open sidebar|expand sidebar/i.test(button.getAttribute('aria-label'))&&inVisual(button))
    const defaultText=page?.innerText??''
    return {
      viewport:{width:innerWidth,height:innerHeight,visualWidth:visual.width??null,scale:visual.scale??1},
      mainRegion:{
        regions:{page:probe(page),inner:probe(page?.querySelector('.weir-da-page-inner')),header:probe(page?.querySelector('.weir-da-page-header')),title:probe(page?.querySelector('h1')),nav:probe(nav),view:probe(page?.querySelector('.weir-da-view')),cards:[...page?.querySelectorAll('.weir-da-card')??[]].filter(inVisual).map(probe)},
        navigationActions:[...nav?.querySelectorAll('button[data-view]')??[]].filter(button=>!button.disabled).map(button=>({name:nameOf(button),...probe(button)})),
        primaryActions:primaries.filter(inVisual).map(button=>({name:nameOf(button),...probe(button)})),
        hostNavigation:hostOpen?{name:nameOf(hostOpen),...probe(hostOpen)}:null,
      },
      document:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1},
      surfaceOverflow:surfaces.filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.className),
      clippedPrimary:primaries.filter(el=>{const rect=el.getBoundingClientRect();return el.scrollWidth>el.clientWidth+1||rect.left<visual.offsetLeft-1||rect.right>visual.offsetLeft+visual.width+1}).map(el=>el.innerText||el.getAttribute('aria-label')),
      unnamedControls:controls.filter(el=>!String(nameOf(el)).trim()).map(el=>el.outerHTML.slice(0,200)),
      internalVocabulary:[...new Set((defaultText.match(/\b(?:Case|Attempt|L2|L3|L5|Learning Run|Snapshot|generatedDescription)\b/g)??[]))],
      colors:page?{background:getComputedStyle(page).backgroundColor,color:getComputedStyle(page).color}:null,
    }
  })()`)
    audit = candidate
    const settled = layoutProblems(candidate).length===0 && mainRegionProblems(candidate).length===0 && candidate.colors?.background===expectedColors.background && candidate.colors?.color===expectedColors.color && Math.abs((candidate.viewport.scale ?? 1) - zoom) < 0.01
    return settled ? candidate : null
  }, 10_000).catch(() => {})
  requireEvidence(audit, `${name} produced a real layout measurement`)
  const problems = [...layoutProblems(audit), ...mainRegionProblems(audit)]
  const row = { name, theme, zoom, hostNormalization, audit, problems, ax: await instance.cdp.accessibility('.weir-da-page') }
  visualAudits.push(row)
  writeJson(join(out, 'visual-audits.json'), visualAudits)
  check(`visual-${name}`, problems.length === 0 && audit.colors?.background===expectedColors.background && audit.colors?.color===expectedColors.color && Math.abs((audit.viewport.scale ?? 1) - zoom) < 0.01, { problems, viewport: audit.viewport, colors: audit.colors })
  await shot(`visual-${name}`, { kind: 'layout-ax', viewport: audit.viewport, axNodes: row.ax.length })
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
  // A real unresolved stock call supplies the current no-wait authority binding.
  await submitMarker(instance, 'GUI_LONG_NATIVE')
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
  let native = await waitFor(async () => {
    const state = await nativeState()
    return state.pending && state.text.includes('长中文题面') ? state : null
  }, 30_000)
  if (!accessibility.nativeDecision) await captureAccessibility('nativeDecision', `[data-question-key=${JSON.stringify(native.key)}]`)
  while (native.pending) {
    requireEvidence(steps.length < 4, 'the visible native card exposes a bounded number of Skip steps')
    const previous = native.text
    const outcome = await waitFor(async () => { const value = await skipLongNativeStep(); return value === 'skipped' || value === 'gone' ? value : null }, 30_000)
    if (outcome === 'gone') break
    await waitFor(async () => { const next = await nativeState(); return !next.pending || next.text !== previous }, 30_000)
    steps.push(previous)
    native = await nativeState()
  }
  const settled = await waitFor(async () => {
    const sessionScan = await scanSession(sessionId, 'long-native-skip-session.json')
    const stockCall = sessionScan.stockAskCalls.find(event => event.data?.arguments?.includes('"product-long-choice"'))
    if (!stockCall || !sessionScan.events.some(event => event.type === 'tool/result' && event.callId === stockCall.callId)) return null
    return { settled: true, callId: stockCall.callId, error: null }
  }, 30_000)
  const after = await record(sessionId, 'long-native-skip-after', caseId)
  writeJson(join(out, 'long-native-skip.json'), { caseId, steps, native: settled, before: before.case, after: after.case })
  await shot('18b-long-native-skip-closed')
  check('longNativeSkipKeepsClosedRecord', settled.settled && after.case.state === 'closed' && after.case.revision === before.case.revision && JSON.stringify(after) === JSON.stringify(before), { caseId, revision: after.case.revision, skipSteps: steps.length, nativeSettled: settled.settled, nativeError: settled.error ?? null })
}
async function planReviewState() {
  return instance.cdp.evaluate(`(() => { const pending=[...document.querySelectorAll('[data-plan-review-key]')].find(el=>el.offsetParent!==null); return {pending:Boolean(pending),key:pending?.getAttribute('data-plan-review-key')??null,text:pending?.innerText??'',actions:pending?[...pending.querySelectorAll('button')].filter(el=>el.offsetParent!==null).map(el=>el.textContent.trim()):[]} })()`)
}

async function answerPlanReview() {
  const state = await waitFor(async () => {
    const plan=await planReviewState()
    if(plan.pending)return {kind:'plan',value:plan}
    const native=await nativeState()
    return native.pending?{kind:'native',value:native}:null
  }, 30_000)
  await shot('p4-native-gui_c_plan')
  if (state.kind === 'plan') await keyboardActivate('Accept native plan review', 'button', { scope: `[data-plan-review-key=${JSON.stringify(state.value.key)}]`, labels: ['同意执行', 'Accept', 'Approve'] })
  else await answerNative('Accept')
}

async function settleNativeSkip(sessionId, caseId, label) {
  const before = await record(sessionId, `${label}-skip-before`, caseId)
  requireEvidence(before.case.state === 'closed', `${label} native Skip follows an already closed record`)
  await openIsolatedSession(sessionId, true)
  const steps = []
  let native = await nativeState()
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
  if (routeRequired) await openDisclosure(`weir-da-card-routes-${caseId}`)
  const card = await instance.cdp.evaluate(`(() => { const root=document.querySelector('[data-weir-decision-card=${JSON.stringify(caseId)}]'); return {text:root.innerText,routeText:root.querySelector('.weir-da-route-history')?.innerText??'',retry:root.querySelectorAll('[data-action="retry"]').length,feedback:root.querySelectorAll('[data-feedback]').length,nativeHint:root.querySelectorAll('[data-native-answer]').length} })()`)
  check(`${label}UnownedConversationRouteHistory`, card.retry === 0 && card.feedback === 0 && card.nativeHint === 1 && (!routeRequired || card.routeText.trim().length > 0) && (routeRequired || authority.routeDecisions.length === 0), { caseId, card })
  await openPage('inbox')
  const article = `article[data-case-id=${JSON.stringify(caseId)}]`
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(article)}))`), 30_000)
  if (routeRequired) await openDisclosure(`weir-da-inbox-routes-${caseId}`)
  const routeReady = await waitFor(() => instance.cdp.evaluate(`(() => { const root=document.querySelector(${JSON.stringify(article)}); return Boolean(root&&root.querySelectorAll('form.weir-da-answers').length===1&&(${JSON.stringify(routeRequired)}?(root.querySelector('.weir-da-route-history')?.innerText??'').trim().length>0:true)) })()`), 30_000)
  await openDisclosure(`weir-da-recovery-${caseId}`)
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
  const originSelector = `${article} .weir-da-disclosure .weir-da-button[data-variant="danger"]`
  const scrollBefore = (await keyboardActivate(`Request cancel ${label}`, 'button', { scope: article, labels: ['取消', 'Cancel'], scrollBaseline: 'immediate' })).scrollBefore
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-cancel-decision"))'), 30_000)
  if (!accessibility.cancelDecisionDialog) await captureAccessibility('cancelDecisionDialog', '#weir-da-cancel-decision')
  const audit = await beginModalAudit(`cancel-decision-${label}`, '#weir-da-cancel-decision', originSelector, { before: scrollBefore })
  const controlId = await holdDecision('cancel', { sessionId, caseId })
  await keyboardActivate(`Confirm cancel ${label}`, '#weir-da-cancel-decision .weir-da-actions button:last-child')
  await waitFor(async () => (await decisionControl(controlId)).started, 30_000)
  const beforeFocus = await measureConfirmationFocus(originSelector, controlId)
  await releaseDecision(controlId)
  const closed = await waitFor(async () => { const value=await record(sessionId, `${label}-cancelled`, caseId); return value.case.state==='closed'?value:null }, 30_000)
  await expectMutation('cancel', { sessionId, caseId })
  const afterFocus = await waitFor(async () => { const focus = await measureConfirmationFocus(originSelector, controlId); return focus.control.settled && (focus.targetFocused || focus.fallbackFocused) ? focus : null }, 30_000).catch(() => measureConfirmationFocus(originSelector, controlId))
  const focus = { beforeSettle: { ...beforeFocus, promiseSettled: beforeFocus.control.settled }, afterSettle: { ...afterFocus, promiseSettled: afterFocus.control.settled } }
  const focusProblems = confirmationFocusProblems(focus)
  uiuxEvidence.confirmations.push({ kind: 'cancel-decision', caseId, controlId, focus, problems: focusProblems })
  await finishModalAudit(audit, { focus, focusProblems })
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
  // Assistant identity is profile-global now, so a foreign-workspace assistant is
  // an eligible Auto candidate instead of being filtered out by workspace. The P4
  // fixtures below count eligible candidates, so this one is switched off through
  // the rendered confirmation and stays an identity + private-record fixture.
  await agentState(foreignSession, foreign.agentId, 'disabled')
  await openIsolatedSession(autoSession)

  await submitMarker(instance, 'GUI_AUTO_EMPTY')
  const emptyPending = await waitCase(autoSession, 'gui-auto-empty', value => value.state === 'awaiting_user')
  const emptyWaiting = await record(autoSession, 'p4-empty-waiting', emptyPending.caseId)
  check('emptyWhitelistAuthorityWithoutClassificationOrAttempt', emptyWaiting.case.agentId === null && emptyWaiting.case.awaitingReason === 'authority' && emptyWaiting.attempts.length === 0 && emptyWaiting.routeDecisions.length === 1 && emptyWaiting.routeDecisions[0].reason === 'admission:authority', { caseId: emptyPending.caseId, route: emptyWaiting.routeDecisions[0] })
  await shot('p4-empty-whitelist-native')
  await answerNative('Native empty')
  p4Evidence.empty = await waitCase(autoSession, 'gui-auto-empty', value => value.state === 'closed')
  await setAutoSettings('p4-allow-two', { answerClasses: ['A', 'C'] })
  await openIsolatedSession(autoSession)
  await selectorOpen()
  const autoCopy = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  const autoCopyProblems = selectorCopyProblems(autoCopy, { language: 'zh', allowedCount: 2, shadow: false })
  check('autoSelectorShowsRealAllowedTwoAndComparisonCopy', autoCopyProblems.length === 0, { text: autoCopy, problems: autoCopyProblems })
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
  await waitFor(async () => !(await planReviewState()).pending && !(await nativeState()).pending, 30_000)
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
  const shadowCopyProblems = selectorCopyProblems(shadowOnCopy, { language: 'zh', allowedCount: 2, shadow: true })
  check('selectorShowsRealShadowOnCopy', shadowCopyProblems.length === 0, { text: shadowOnCopy, problems: shadowCopyProblems })
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

  await openIsolatedSession(autoSession)
  await selectorChoose(autoSession, 'auto')
  const pageCases = []
  for (let index = 1; index <= 21; index += 1) {
    const suffix = String(index).padStart(2, '0')
    await submitMarker(instance, `GUI_AUTO_PAGE_${suffix}`)
    const page = await waitCase(autoSession, `gui-auto-page-${suffix}`, value => value.state === 'closed')
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
  p4Evidence.pending = pending
  await scanSession(autoSession, 'p4-auto-session-before-restart.json')

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
  const interruptedRestart = await record(state.autoSession, 'p4-interrupted-after-restart', p4Evidence.interrupted.case.caseId)
  check('restartPreservesPendingAndReturnedExactly', pendingRestart.case.state === 'awaiting_user' && pendingRestart.case.revision === p4Evidence.pending.case.revision && pendingRestart.case.agentId === null && pendingRestart.attempts.length === 0 && pendingRestart.routeDecisions.length === 1 && JSON.stringify(returnedRestart) === JSON.stringify(p4Evidence.returned), { pending: pendingRestart.case, returned: returnedRestart.case })
  check('interruptedReceivedIntakeRecoversWaitingWithoutRouteOrAttempt', interruptedRestart.case.state === 'awaiting_user' && interruptedRestart.case.awaitingReason === 'interrupted' && interruptedRestart.case.agentId === null && interruptedRestart.attempts.length === 0 && interruptedRestart.routeDecisions.length === 0, { before: p4Evidence.interrupted.case, after: interruptedRestart.case })
  await openIsolatedSession(state.pendingSession, true)
  await shot('p4-pending-after-restart')
  p4Evidence.pendingAfterRestart = await answerUnownedInbox(state.pendingSession, pendingRestart.case.caseId, 'p4-restart-pending', 'Pending user answer')
  await openIsolatedSession(state.autoSession, true)
  p4Evidence.interruptedAfterRestart = await cancelUnownedInbox(state.autoSession, interruptedRestart.case.caseId, 'p4-restart-interrupted', false)
  check('interruptedCancelAddsNoRetroactiveAutoRoute', p4Evidence.interruptedAfterRestart.routeDecisions.length === 0 && p4Evidence.interruptedAfterRestart.attempts.length === 0 && p4Evidence.interruptedAfterRestart.case.closing === 'cancelled', { caseId: interruptedRestart.case.caseId })

  const reviewSession = state.autoSession
  await openIsolatedSession(reviewSession, true)
  await openPage('metrics')
  const first = await routingReview(reviewSession, 'p4-routing-first', 'all')
  check('routingReviewFirstPageHasExactlyTwentyRealItems', first.items.length === 20 && typeof first.nextCursor === 'string' && first.nextCursor.length > 0 && first.summary.manualReassign >= 1 && first.summary.autoFailure >= 2 && first.summary.autoAmbiguous >= 1, { items: first.items.length, nextCursor: first.nextCursor, summary: first.summary })
  await compareRoutingReview(reviewSession, 'p4-routing-first', first)
  await captureAccessibility('routingReview', 'section[data-routing-review]')
  await captureAccessibility('routingStatus', '[data-routing-status]')
  await shot('p4-routing-review-first-20')
  await keyboardSelect('Change routing review window', 'select[data-routing-window]', '24h')
  const oneDay = await routingReview(reviewSession, 'p4-routing-24-hours', '24h')
  await compareRoutingReview(reviewSession, 'p4-routing-24-hours', oneDay)
  await keyboardSelect('Restore routing review all window', 'select[data-routing-window]', 'all')
  const allAgain = await routingReview(reviewSession, 'p4-routing-all-again', 'all')
  await compareRoutingReview(reviewSession, 'p4-routing-all-again', allAgain)
  const combined = await routingLoadMore(reviewSession, allAgain)
  const combinedRouteIds = combined.items.map(item => item.routeDecisionId)
  const combinedCaseIds = combined.items.map(item => item.caseId)
  check('routingPaginationAppendsRealRecordsWithoutDuplicates', allAgain.items.length === 20 && combined.items.length > 20 && new Set(combinedRouteIds).size === combinedRouteIds.length && combinedRouteIds.slice(0, 20).join(',') === allAgain.items.map(item => item.routeDecisionId).join(',') && new Set(combinedCaseIds).size < combinedCaseIds.length, { first: allAgain.items.length, combined: combined.items.length, distinctSameCaseFacts: combinedCaseIds.length - new Set(combinedCaseIds).size })
  const routingDom = await routingReviewDom()
  const forbiddenRoutingActions = await instance.cdp.evaluate(`[...document.querySelectorAll('section[data-routing-review] button')].map(button=>button.textContent.trim()).filter(text=>/采纳|忽略|晋升|adopt|ignore|promot/i.test(text))`)
  check('routingReviewHasNoAdoptIgnoreOrPromotion', forbiddenRoutingActions.length === 0 && /诊断|diagnostic/i.test(routingDom.text), { forbiddenRoutingActions })
  const linked = await openRoutingRecord(reviewSession, combined.items[0].caseId)
  check('routingRecordLinkUsesAuthorizedAuthority', linked.case.caseId === combined.items[0].caseId && linked.case.rootSessionId === reviewSession, { caseId: linked.case.caseId })
  await compareRecord(reviewSession, 'p4-routing-linked-record', linked.case.caseId, true)

  await openIsolatedSession(state.shadowObservedSession, true)
  await openPage('metrics')
  const shadowReview = await routingReview(state.shadowObservedSession, 'p4-shadow-routing-review', 'all')
  check('shadowReviewShowsDisagreementOnlyOnOwningRoot', shadowReview.summary.disagreement === 1 && shadowReview.items.some(item => item.caseId === p4Evidence.shadow.observed.case.caseId && item.outcome === 'disagreement'), { summary: shadowReview.summary, caseId: p4Evidence.shadow.observed.case.caseId })
  await compareRoutingReview(state.shadowObservedSession, 'p4-shadow-routing-review', shadowReview)
  await openIsolatedSession(reviewSession, true)
  await openPage('metrics')
  await compareRoutingReview(reviewSession, 'p4-routing-before-visuals', allAgain)
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

  const restoredConfig = await setAutoSettings('p4-restored', { shadow: false, answerClasses: [], answerTimeoutMs: 150 })
  const restoreAutoSessions = [state.sessionId, state.autoSession, state.explicitOffSession, state.shadowControlSession, state.shadowObservedSession, state.pendingSession, state.foreignSession]
  const restoredSelectors = {}
  for (const id of restoreAutoSessions) {
    await openIsolatedSession(id, true)
    restoredSelectors[id] = await selectorChoose(id, 'auto')
  }
  check('testOwnedSelectorsAndSettingsRestored', Object.values(restoredSelectors).every(selector => selectorMatches(selector, 'auto')) && restoredConfig.effective?.decisionAgentAutoShadow === false && JSON.stringify(restoredConfig.effective?.decisionAgentAutoAnswerClasses) === '[]' && restoredConfig.effective?.decisionAgentSelectorDefault === 'auto' && restoredConfig.effective?.decisionAgentAnswerTimeoutMs === 150, { selectors: restoredSelectors, config: restoredConfig.effective })

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
  const sessionStock = session.stockAskCalls.map(event => ({ event, arguments: typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data?.arguments })).filter(entry => entry.arguments?.questions?.some(question => question.id === 'gui-auto-selected'))
  const forbiddenWire = /generatedDescription|memorySnapshot|snapshotId|principles|feedback|attempts|history|FOREIGN WORKSPACE PRIVATE PROFILE/
  const cleanWire = entry => entry.autoRouter.tools.length === 0 && entry.autoRouter.hasTemperature === false && entry.autoRouter.provider === 'mock' && entry.autoRouter.model === 'mock-1' && !forbiddenWire.test(JSON.stringify(entry.autoRouter.pack))
  const classless = value => value?.questions?.every(question => !Object.hasOwn(question, 'authorizationClass') && !Object.hasOwn(question, 'authorizationClassSource') && !Object.hasOwn(question, 'authorization_class'))
  const nativeWireCount = ['GUI_C_APPROVAL', 'GUI_C_PLAN', 'GUI_AUTO_HIGH_RISK', 'GUI_AUTO_EXECUTION'].reduce((sum, marker) => sum + wiresFor(marker, 'classification').length + wiresFor(marker, 'route').length, 0)
  const pass = nativeWireCount === 0 && selectedClassification.length === 1 && selectedRoute.length === 1 && classless(selectedClassification[0].autoRouter.pack) && selectedClassification[0].autoRouter.pack.candidates === undefined && selectedRoute[0].autoRouter.pack.candidates.map(candidate => candidate.agentId).sort().join(',') === [primary.agentId, secondary.agentId].sort().join(',') && !JSON.stringify(selectedRoute[0]).includes(state.foreign.agentId) && selectedStock.length === 1 && classless(selectedStock[0].arguments) && sessionStock.length === 1 && classless(sessionStock[0].arguments) && trace.filter(entry => entry.autoRouter).every(cleanWire) && wiresFor('GUI_AUTO_EMPTY', 'classification').length === 0 && wiresFor('GUI_AUTO_EMPTY', 'route').length === 0 && wiresFor('GUI_AUTO_ZERO', 'classification').length === 1 && wiresFor('GUI_AUTO_ZERO', 'route').length === 0 && wiresFor('GUI_AUTO_ONE', 'classification').length === 1 && wiresFor('GUI_AUTO_ONE', 'route').length === 0 && wiresFor('GUI_AUTO_EXPLICIT', 'classification').length === 0 && wiresFor('GUI_AUTO_EXPLICIT', 'route').length === 0 && wiresFor('GUI_AUTO_TIMEOUT', 'route')[0]?.emitted?.length === 0
  const proof = { pass, nativeWireCount, selectedClassification, selectedRoute, selectedStock, sessionStock, emptyWires: wiresFor('GUI_AUTO_EMPTY', 'classification').length, zeroRouteWires: wiresFor('GUI_AUTO_ZERO', 'route').length, oneRouteWires: wiresFor('GUI_AUTO_ONE', 'route').length, explicitWires: wiresFor('GUI_AUTO_EXPLICIT', 'classification').length + wiresFor('GUI_AUTO_EXPLICIT', 'route').length, foreignAgentId: state.foreign.agentId, timeout: wiresFor('GUI_AUTO_TIMEOUT', 'route') }
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
      if (!raw || raw.mode !== route.mode || (raw.chosen ?? null) !== (route.chosen ?? null) || raw.reason !== route.reason || raw.root_session_id !== detail.case.rootSessionId) problems.push(`${name}: RouteDecision ${route.routeDecisionId} differs`)
    }
    const attempts = final.rows.attempts.filter(attempt => attempt.case_id === detail.case.caseId)
    if (attempts.length !== detail.attempts.length) problems.push(`${name}: Attempt count differs`)
  }
  const unownedCaseIds = new Set([p4Evidence.none, p4Evidence.invalid, p4Evidence.timeout, p4Evidence.pendingAfterRestart, p4Evidence.interruptedAfterRestart].filter(Boolean).map(detail => detail.case.caseId))
  for (const evidence of final.rows.evidence) {
    const locator = evidence.locator_json ? JSON.parse(evidence.locator_json) : null
    if (unownedCaseIds.has(locator?.caseId)) problems.push(`unowned Case ${locator.caseId} created Evidence ${evidence.evidence_id}`)
  }
  const expectedAgentIds = [primary.agentId, secondary.agentId, state.foreign.agentId].sort()
  if (final.rows.agent_profiles.map(profile => profile.agent_id).sort().join(',') !== expectedAgentIds.join(',')) problems.push('generic or unexpected fallback Agent exists')
  const finalCases = new Map(final.rows.cases.map(item => [item.case_id, item]))
  for (const attempt of final.rows.attempts) {
    if (finalCases.get(attempt.case_id)?.agent_id !== attempt.agent_id) problems.push(`Attempt ${attempt.attempt_id} crosses Case Agent ownership`)
  }
  const rawRequirements = [
    { method: 'decide', args: { sessionId: state.autoSession, caseId: p4Evidence.none.case.caseId, answers: p4Evidence.none.case.decision.answers } },
    { method: 'reassign', args: { sessionId: state.autoSession, caseId: p4Evidence.ambiguous.case.caseId, agentId: secondary.agentId } },
    { method: 'cancel', args: { sessionId: state.autoSession, caseId: p4Evidence.invalid.case.caseId } },
    { method: 'cancel', args: { sessionId: state.autoSession, caseId: p4Evidence.timeout.case.caseId } },
    { method: 'setSelector', args: { sessionId: state.explicitOffSession, mode: 'off' } },
  ]
  const rawRpc = rawRequirements.map(requirement => ({ requirement, entry: networkRpc.find(entry => entry.method === requirement.method && exactArgs(entry.args, requirement.args)) ?? null }))
  for (const item of rawRpc) if (!item.entry?.rpcId || !item.entry.response) problems.push(`missing raw ${item.requirement.method} RPC/response`)
  const archivedRaw = networkRpc.filter(entry => entry.method === 'profileSetState' && entry.args?.state === 'archived' && expectedAgentIds.includes(entry.args?.agentId) && entry.rpcId && entry.response)
  if (archivedRaw.length !== 3) problems.push(`expected three raw archival RPCs, got ${archivedRaw.length}`)
  const comparison = { pass: problems.length === 0, problems, cases: Object.fromEntries(Object.entries(named).map(([name, detail]) => [name, detail.case.caseId])), unownedCaseIds: [...unownedCaseIds], expectedAgentIds, rawRpc, archivedRaw, finalPhase: final.phase }
  writeJson(join(out, 'sqlite-read-model-comparison.json'), comparison)
  check('sqliteReadModelAndRouteJoinAgreeWithoutExtraAttempts', comparison.pass, comparison)
  return { proof, comparison }
}


// ---------------------------------------------------------------------------
// Tasks 6.7 / 7.3: cross-workspace memory on the real Desktop surface.
//
// Order is enforced by the caller and matters:
//   1. every pre-migration assertion runs on the original isolated store;
//   2. `runMigratedLegacyProfileSurface` replaces that store with a genuine v1
//      database migrated by production code, boots it, restarts it, and reads
//      the legacy identity, the private Snapshot ownership and the empty public
//      zone from the rendered page and raw RPC;
//   3. `runCrossWorkspaceMemoryMatrix` creates W1/W2/W3 on the same live
//      profile and proves shared identity, the public zone and private
//      isolation.
// Nothing below reads a component tree or a fabricated projection: DOM facts
// come from the real Electron window and reads come from the real RPC.
// ---------------------------------------------------------------------------

const FAIL_CLOSED_CODES = new Set(['OUT_OF_SCOPE', 'FORBIDDEN', 'PERMISSION_DENIED'])
const DENIAL_AUDIT_TYPES = Object.freeze({ learningRun: 'weir/decision/learning-run', memorySnapshot: 'weir/decision/snapshot' })
// The Decision audit projection may only carry ids, enums, counts and digests.
const DENIAL_AUDIT_FIELDS = new Set([
  'caseId', 'attemptId', 'feedbackId', 'agentId', 'routeDecisionId', 'rootSessionId', 'originSessionId', 'learningRunId', 'snapshotId',
  'kind', 'action', 'state', 'closing', 'outcome', 'awaitingReason', 'failureKind', 'reason', 'code', 'from', 'target', 'mode', 'entry', 'rejected',
  'revision', 'version', 'attemptCount', 'answerCount', 'interruptedAttempts', 'interruptedLearningRuns', 'recoveredCases', 'durationMs', 'at', 'operationCount', 'sourceCount', 'activePrincipleCount', 'retiredPrincipleCount',
  'available', 'enabled', 'needsReview', 'ok', 'explicit',
  'contentHash', 'inputHash', 'feedbackDigest', 'finalHash',
])
const LEGACY_HISTORY_TABLES = ['agent_profiles', 'agent_profile_revisions', 'cases', 'attempts', 'evidence', 'feedback', 'route_decisions', 'learning_runs', 'memory_snapshots']
// Tables that carry the schema-versioned row envelope.
const ENVELOPE_TABLES = ['agent_profiles', 'cases', 'attempts', 'evidence', 'feedback', 'route_decisions', 'learning_runs', 'memory_snapshots']

function legacyDatabasePath() {
  return join(root, 'home', 'weir', 'profiles', 'desktop', 'decisions', 'decision.db')
}

function readAuditLines(cwd) {
  const file = join(cwd, '.weir', 'audit.jsonl')
  if (!existsSync(file)) return []
  return String(readFileSync(file, 'utf8')).split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

/** Row digests of the migrated history: a live boot must not rewrite or add rows. */
function legacyHistoryDigest() {
  const handle = new DatabaseSync(legacyDatabasePath(), { readOnly: true })
  try {
    const row = sql => handle.prepare(sql).get() ?? null
    const tables = Object.fromEntries(LEGACY_HISTORY_TABLES.map(table => {
      const rows = handle.prepare(`SELECT * FROM ${table}`).all()
      const canonical = rows.map(value => JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]))).sort()
      return [table, { rows: rows.length, digest: createHash('sha256').update(canonical.join('\n')).digest('hex') }]
    }))
    const pins = row('SELECT pins_json FROM attempts ORDER BY created_at,rowid LIMIT 1')?.pins_json ?? null
    return {
      version: row('PRAGMA user_version')?.user_version ?? null,
      integrityCheck: row('PRAGMA integrity_check')?.integrity_check ?? null,
      tables,
      snapshot: row("SELECT snapshot_id,agent_id,zone,namespace_workspace_key,state,version,revision FROM memory_snapshots WHERE zone='workspace' ORDER BY created_at,rowid LIMIT 1"),
      run: row("SELECT learning_run_id,agent_id,zone,namespace_workspace_key,outcome,revision FROM learning_runs WHERE zone='workspace' ORDER BY created_at,rowid LIMIT 1"),
      attemptPin: pins ? JSON.parse(pins) : null,
      publicRows: {
        snapshots: row("SELECT COUNT(*) AS n FROM memory_snapshots WHERE zone='public'")?.n ?? -1,
        runs: row("SELECT COUNT(*) AS n FROM learning_runs WHERE zone='public'")?.n ?? -1,
      },
    }
  } finally { handle.close() }
}

/** The audit receipt of one denied cross-namespace read, if the product wrote it. */
function denialAuditReceipt(cwd, method, target) {
  const type = DENIAL_AUDIT_TYPES[method]
  if (!type) return null
  const line = readAuditLines(cwd)
    .filter(item => item?.type === type && item?.data?.action === 'boundary-reject')
    .findLast(item => target == null || item.data.learningRunId === target || item.data.snapshotId === target)
  if (!line) return { recorded: false, type, action: null, code: null, learningRunId: null, snapshotId: null, agentId: null, idsOnly: false }
  const data = line.data ?? {}
  return {
    recorded: true, type, action: data.action ?? null, code: data.code ?? null,
    learningRunId: data.learningRunId ?? null, snapshotId: data.snapshotId ?? null, agentId: data.agentId ?? null,
    idsOnly: Object.keys(data).every(key => DENIAL_AUDIT_FIELDS.has(key)),
  }
}

/** One raw RPC transport, kept unjudged so the probe can record its real shape. */
async function rawDecision(method, args) {
  const transport = await instance.cdp.evaluate(`window.__decisionQA.decision(${JSON.stringify(method)}, ${JSON.stringify(args)})`)
  const envelope = transport?.value
  const ok = transport?.ok === true && envelope?.ok === true
  const error = ok ? null : (envelope?.error ?? transport?.error ?? null)
  return { ok, value: ok ? (envelope.value ?? null) : null, errorCode: typeof error?.code === 'string' ? error.code : null, serialized: JSON.stringify(transport ?? null) }
}

/**
 * Every foreign private read must fail closed. `record` answers with an empty
 * body; `learningRun`/`memorySnapshot` deny with an explicit code and one audit
 * record that carries ids and state only.
 */
async function crossWorkspaceDenial(sessionId, reads, auditCwd) {
  const denials = []
  for (const read of reads) {
    const raw = await rawDecision(read.method, { sessionId, ...(read.args ?? {}) })
    const target = read.args?.learningRunId ?? read.args?.snapshotId ?? read.args?.caseId ?? null
    denials.push({
      method: read.method,
      target,
      shape: !raw.ok ? 'error' : raw.value === null ? 'null' : 'value',
      code: raw.errorCode,
      returnedNull: raw.ok && raw.value === null,
      valueKeys: raw.ok && raw.value && typeof raw.value === 'object' ? Object.keys(raw.value) : [],
      bodyLeaked: /"(?:excerpt|question|operations|principles|answers|decision|attempts|feedback)"/.test(raw.serialized),
      audit: denialAuditReceipt(auditCwd, read.method, target),
    })
  }
  return denials
}

async function crossWorkspaceMemoryDom(agentId) {
  return instance.cdp.evaluate(`(() => {
    const detail=document.querySelector('[data-agent-detail=${JSON.stringify(agentId)}]')
    if(!detail)return null
    const visible=el=>el.offsetParent!==null
    const zone=name=>detail.querySelector('[data-memory-zone="'+name+'"]')
    const controls=[...detail.querySelectorAll('button')].filter(visible).map(button=>({text:button.textContent.trim(),action:button.getAttribute('data-action'),disabled:button.disabled===true}))
    const publicZone=zone('public')
    const privateZone=zone('workspace')
    const status=publicZone?.querySelector('[data-public-status]')
    const disclosure=publicZone?.querySelector('[data-public-disclosure]')
    const candidate=publicZone?.querySelector('[data-public-candidate]')
    const current=publicZone?.querySelector('[data-public-current]')
    const publishedSection=publicZone?.querySelector('[data-public-published-principles]')
    const changesSection=publicZone?.querySelector('[data-public-changes]')
    const frozenInput=publicZone?.querySelector('[data-public-frozen-input]')
    return {
      zones:{public:Boolean(publicZone),workspace:Boolean(privateZone)},
      headings:[...detail.querySelectorAll('h3')].map(el=>el.textContent.trim()),
      guidance:publicZone?.querySelector('[data-public-guidance-only]')?.textContent??'',
      privateIsolation:privateZone?.querySelector('[data-private-isolation]')?.textContent??'',
      text:detail.innerText,
      publicStatus:status?.getAttribute('data-public-status')??null,
      navigation:[...document.querySelectorAll('main.weir-da-page [data-decision-primary-nav] [data-view]')].map(el=>el.getAttribute('data-view')),
      controls,
      status:status?{present:true,role:status.getAttribute('role')??'',live:status.getAttribute('aria-live')??''}:{present:false},
      disclosure:{required:Boolean(disclosure),acknowledge:Boolean(disclosure?.querySelector('[data-action="public-acknowledge"]'))},
      candidate:candidate?{
        present:true,
        aliases:[...candidate.querySelectorAll('[data-public-source]')].map(el=>el.getAttribute('data-public-source')),
        replay:candidate.querySelector('[data-public-replay]')?.getAttribute('data-public-replay')??'',
        adopt:Boolean(candidate.querySelector('[data-action="public-publish"]')),
        discard:Boolean(candidate.querySelector('[data-action="public-reject"]')),
        readableLinks:candidate.querySelectorAll('[data-action="open-learning-record"],[data-learning-source-record] button').length,
        adoptOnRender:false,
        text:candidate.innerText,
        aliasesText:[...candidate.querySelectorAll('[data-public-source]')].map(el=>el.innerText).join('\\n'),
      }:{present:false},
      published:publishedSection?{present:true,text:publishedSection.innerText,principles:[...publishedSection.querySelectorAll('[data-public-published-principle]')].map(item=>({principleId:item.getAttribute('data-public-published-principle'),text:item.querySelector('[data-public-published-text]')?.textContent??'',scope:item.querySelector('p:not([data-public-published-text])')?.textContent??''})),controls:[...publishedSection.querySelectorAll('button,input,textarea,select,[contenteditable="true"]')].filter(visible).map(item=>({tag:item.tagName,text:(item.textContent??'').trim(),action:item.getAttribute('data-action'),editable:item.isContentEditable===true}))}:{present:false},
      changes:changesSection?[...changesSection.querySelectorAll('[data-public-change]')].map(item=>({op:item.getAttribute('data-public-change'),label:item.querySelector('strong')?.textContent?.trim()??'',text:item.querySelector('[data-public-change-text]')?.textContent?.trim()??'',scope:item.querySelector('[data-public-change-scope]')?.textContent?.trim()??''})):[],
      frozenInput:frozenInput?.textContent?.trim()??'',
      current:current?{version:current.getAttribute('data-public-current'),rollback:Boolean(publicZone.querySelector('[data-action="public-rollback"]'))}:null,
    }
  })()`)
}

/** What the migration report says the live profile must still own. */
function legacyExpectations(report) {
  const profiles = report?.profilesAfterMigration ?? []
  const snapshots = report?.privateMemory?.snapshots ?? []
  return {
    agentIds: profiles.map(profile => profile.agentId),
    names: Object.fromEntries(profiles.map(profile => [profile.agentId, profile.name])),
    privateWorkspaceKey: snapshots[0]?.namespaceWorkspaceKey ?? null,
    privateSnapshotId: snapshots[0]?.snapshotId ?? null,
    privateLearningRunId: report?.privateMemory?.run?.learningRunId ?? null,
    attemptPinSnapshotId: report?.attemptPins?.memorySnapshotId ?? null,
  }
}

function legacySurfaceView(capture, digest) {
  return {
    ...capture,
    snapshot: digest.snapshot,
    attemptPin: digest.attemptPin,
    integrityCheck: digest.integrityCheck,
    public: { ...capture.public, publishedSnapshots: digest.publicRows.snapshots, learningRuns: digest.publicRows.runs },
  }
}

/** One rendered read of the migrated legacy profile from a real current workspace. */
async function legacySurfaceCapture(label, expected) {
  const cwd = join(root, 'legacy-current-workspace')
  mkdirSync(cwd, { recursive: true })
  const session = await newIsolatedSession(`cross-legacy-${label}`, cwd)
  await openIsolatedSession(session.sessionId)
  await openPage('agents')
  const renderedIds = await instance.cdp.evaluate(`[...document.querySelectorAll('main.weir-da-page [data-agent-summary]')].map(el => el.getAttribute('data-agent-summary'))`)
  const agents = (await rpc(session.sessionId, `legacy-${label}-agents`, 'agents')).map(agent => ({
    agentId: agent.agentId, name: agent.name, state: agent.state, revision: agent.revision,
    legacyOriginAlias: agent.legacyOriginAlias ?? null,
    scope: { paths: [...(agent.scope?.paths ?? [])], tags: [...(agent.scope?.tags ?? [])], authorizationClasses: [...(agent.scope?.authorizationClasses ?? [])] },
    hasWorkspaces: Object.hasOwn(agent.scope ?? {}, 'workspaces'),
  }))
  const ownerAgentId = expected.ownerAgentId ?? agents[0]?.agentId ?? null
  const agent = await openAgent(session.sessionId, ownerAgentId)
  const dom = await crossWorkspaceMemoryDom(ownerAgentId)
  const pageText = await instance.cdp.evaluate(`document.querySelector('main.weir-da-page')?.innerText ?? ''`)
  const denialCwd = cwd
  const denials = await crossWorkspaceDenial(session.sessionId, [
    { method: 'memorySnapshot', args: { snapshotId: expected.privateSnapshotId } },
    { method: 'learningRun', args: { learningRunId: expected.privateLearningRunId } },
  ], denialCwd)
  const capture = {
    label, sessionId: session.sessionId, workspaceKey: cwd, renderedIds, agents, ownerAgentId,
    agentRevision: agent.revision ?? null,
    currentSnapshotId: agent.currentSnapshotId ?? null,
    public: { currentVersion: dom.current?.version ?? null, candidate: dom.candidate?.present === true },
    detail: { zones: dom.zones, headings: dom.headings, guidance: dom.guidance, privateIsolation: dom.privateIsolation, navigation: dom.navigation },
    pageText,
    denials,
    audit: readAuditLines(cwd)
      .filter(line => typeof line?.type === 'string' && line.type.startsWith('weir/decision/'))
      .map(line => ({ type: line.type, action: line.data?.action ?? null, code: line.data?.code ?? null })),
  }
  writeJson(join(out, `cross-workspace-legacy-${label}.json`), capture)
  return capture
}

/**
 * Stage the real v1→v2 migrated database into the live isolated store, boot it,
 * restart it, and prove identity, private ownership and the empty public zone.
 * The caller must have stopped the previous owned instance first.
 */
async function runMigratedLegacyProfileSurface() {
  const phase = 'GUI-cross-workspace-legacy'
  const legacy = stageMigratedLegacyProfile({ root, lane: LANE })
  const reportProblems = legacy.report
    ? legacyMigratedProfileProblems({ ...legacy.report, walSidecarsLeft: existsSync(`${legacy.target}-wal`) || existsSync(`${legacy.target}-shm`), currentAppTouched: false })
    : ['the migration fixture produced no report']
  const staged = legacyHistoryDigest()
  const expected = { ...legacyExpectations(legacy.report), ownerAgentId: staged.run?.agent_id ?? null }
  writeJson(join(out, 'cross-workspace-legacy-profile.json'), { phase, exitCode: legacy.exitCode, reportPath: legacy.reportPath, target: legacy.target, report: legacy.report, problems: reportProblems, expected, staged })
  check('crossWorkspaceLegacyProfileMigratesConservatively', legacy.exitCode === 0 && reportProblems.length === 0, { exitCode: legacy.exitCode, problems: reportProblems, stderr: legacy.stderr })

  instance = await startDesktop(true)
  await installUiuxInstrumentation()
  const boot = await legacySurfaceCapture('boot', expected)
  await shot('cross-legacy-profile-boot')
  await stopOwned('cross-legacy-boot')
  const afterBoot = legacyHistoryDigest()

  instance = await startDesktop(true)
  await installUiuxInstrumentation()
  const restart = await legacySurfaceCapture('restart', expected)
  await shot('cross-legacy-profile-restart')
  await stopOwned('cross-legacy-restart')
  const afterRestart = legacyHistoryDigest()

  const bootView = legacySurfaceView(boot, afterBoot)
  const restartView = legacySurfaceView(restart, afterRestart)
  const problems = legacyLiveSurfaceProblems({
    expected,
    boot: bootView,
    restart: restartView,
    history: { before: staged, afterBoot, afterRestart },
    legacyWorkspacePaths: [expected.privateWorkspaceKey],
  })
  writeJson(join(out, 'cross-workspace-legacy-surface.json'), { phase, expected, boot: bootView, restart: restartView, history: { before: staged, afterBoot, afterRestart }, problems })
  check('crossWorkspaceLegacyProfileBootsAndRestartsOnTheRealSurface', problems.length === 0, problems)
  return { sessions: { boot: boot.sessionId, restart: restart.sessionId }, expected, problems }
}

/**
 * The Decision page captures the workspace session it saw when its region was
 * first rendered: the product keeps that capture per renderer lifetime, so a
 * plain session switch (or five of them) never re-binds it. A public gesture is
 * only attributable when the wire proves the page is bound to the intended
 * workspace, so the first attempt is a plain re-open and a stale capture is
 * corrected by reloading the renderer, which restores the session from scratch.
 */
async function openDecisionPageForSession(sessionId, label, tab = 'agents') {
  requireEvidence(knownSessionIds.has(sessionId), 'only a session created by this run can own the Decision page')
  const attempts = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) await reloadDecisionShell(`${label}#${attempt}`)
    const mark = networkRpc.length
    await openIsolatedSession(sessionId)
    await openPage(tab)
    let observed = null
    try {
      observed = await waitFor(async () => {
        await collectNetwork()
        const reads = networkRpc.slice(mark).filter(item => item.method === 'agents' || item.method === 'inbox')
        const last = reads.at(-1)
        return last ? { sessionId: last.args?.sessionId ?? null, method: last.method, rpcId: last.rpcId ?? null } : null
      }, 20_000)
    } catch { observed = null }
    attempts.push({ attempt, reloaded: attempt > 1, bound: observed?.sessionId ?? null, method: observed?.method ?? null, rpcId: observed?.rpcId ?? null })
    if (observed && observed.sessionId === sessionId) {
      const receipt = { label, sessionId, method: observed.method, rpcId: observed.rpcId, attempts }
      pageBindings.push(receipt)
      writeJson(join(out, 'cross-page-session-bindings.json'), pageBindings)
      return receipt
    }
  }
  pageBindings.push({ label, sessionId, method: null, rpcId: null, attempts })
  writeJson(join(out, 'cross-page-session-bindings.json'), pageBindings)
  throw new Error(`The Decision page never bound to the intended workspace session for ${label}: ${JSON.stringify(attempts)}`)
}

/** Reload the renderer so the restored workspace session renders from scratch. */
async function reloadDecisionShell(label) {
  await instance.cdp.request('Page.reload', { ignoreCache: false })
  await waitFor(() => instance.cdp.evaluate('Boolean(window.__decisionQA)'), 90_000)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]'))`), 90_000)
  // A reload renumbers CDP request ids; drop the previous per-load maps so a
  // reused id can never hide a fresh RPC from the evidence.
  if (instance.network) {
    instance.network.requests = new Map()
    instance.network.responses = new Map()
    instance.network.completed = new Set()
  }
  shellReloads.push({ label })
  writeJson(join(out, 'cross-page-shell-reloads.json'), shellReloads)
}

/** The raw service payload of one captured Decision RPC response. */
function publicRpcPayload(entry) {
  const envelope = entry?.response?.result ?? null
  if (envelope?.ok !== true) return null
  return envelope.value?.ok === true ? envelope.value.value : null
}

/** The audit lines a workspace wrote for its own decisions. */
function publicAuditLines(cwd) {
  return readAuditLines(cwd)
    .filter(line => typeof line?.type === 'string' && line.type.startsWith('weir/decision/'))
    .map(line => ({ kind: line.type.slice('weir/decision/'.length), ...line.data }))
}

/**
 * One UI gesture's wire receipt. The exact args include the intended workspace
 * session, so a public action issued from another workspace's page cannot pass.
 * `exactly: null` accepts one read repeated by a reload; a gesture passes 1.
 */
async function assertUiRpc({ label, method, args, mark, exactly = null }) {
  const match = () => networkRpc.slice(mark).filter(item => item.method === method && exactArgs(item.args, args))
  try {
    await waitFor(async () => {
      await collectNetwork()
      const found = match()
      return exactly === null ? (found.length ? found : null) : (found.length >= exactly ? found : null)
    }, 30_000)
  } catch {
    throw new Error(`${label}: no ${method} carried the intended workspace session: ${JSON.stringify(args)}`)
  }
  // Let the reload the gesture triggers settle before counting occurrences.
  await new Promise(resolve => setTimeout(resolve, 400))
  await collectNetwork()
  const entries = match()
  if (exactly !== null) requireEvidence(entries.length === exactly, `${label}: ${method} ran ${entries.length} times, expected exactly ${exactly}`)
  const entry = entries.at(-1)
  // The product payload is the evidence; a reloaded renderer may not report the
  // transport status for every response, so only the raw body must be captured.
  requireEvidence(Boolean(entry?.rpcId) && entry?.response != null, `${label}: ${method} raw rpcId and response captured`)
  requireEvidence(entry.args?.sessionId === args.sessionId, `${label}: ${method} did not carry the intended workspace session`)
  const payload = publicRpcPayload(entry)
  const receipt = {
    label, method, expectedSessionId: args.sessionId, sessionId: entry.args?.sessionId ?? null,
    args: entry.args, rpcId: entry.rpcId, status: entry.status ?? null, responded: entry.response != null, occurrences: entries.length,
    payloadStatus: payload?.status ?? null,
  }
  publicWires.push(receipt)
  writeJson(join(out, 'cross-public-wire.json'), publicWires)
  return { entry, payload, receipt }
}

/**
 * A page that is reused across tabs keeps its captured session: record this
 * page's own next read so the record view is attributed, not assumed.
 */
async function assertPageSession(mark, sessionId, label, methods = ['records', 'record']) {
  const read = await waitFor(async () => {
    await collectNetwork()
    const reads = networkRpc.slice(mark).filter(item => methods.includes(item.method))
    return reads.length ? reads.at(-1) : null
  }, 30_000)
  requireEvidence(read.args?.sessionId === sessionId, `${label}: the page read ${read.method} under another workspace session`)
  const receipt = { label, method: read.method, expectedSessionId: sessionId, sessionId: read.args?.sessionId ?? null, rpcId: read.rpcId ?? null, args: read.args, responded: read.response != null }
  pageReadWitnesses.push(receipt)
  writeJson(join(out, 'cross-page-workspace-reads.json'), pageReadWitnesses)
  return receipt
}

/**
 * Explicit public adoption, rejection, rollback and the two per-workspace
 * observations all reuse one gesture path: open the page bound to the intended
 * workspace, act, and prove the exact args (including the session) on the wire.
 */
async function runCrossWorkspaceMemoryMatrix(state, privateMemory) {
  if (!CROSS_WORKSPACE_MEMORY) return null
  const phase = 'GUI-cross-workspace-memory'
  const workspaceOne = join(root, 'cross-w1')
  const workspaceTwo = join(root, 'cross-w2')
  const workspaceThree = join(root, 'cross-w3')
  const workspaceFour = join(root, 'cross-w4')
  const workspacePaths = [workspaceOne, workspaceTwo, workspaceThree, workspaceFour, root]
  for (const path of [workspaceOne, workspaceTwo, workspaceThree, workspaceFour]) mkdirSync(path, { recursive: true })

  const w1 = await newIsolatedSession('cross-w1', workspaceOne)
  const w2 = await newIsolatedSession('cross-w2', workspaceTwo)
  const w3 = await newIsolatedSession('cross-w3', workspaceThree)
  const w4 = await newIsolatedSession('cross-w4', workspaceFour)
  await openIsolatedSession(w1.sessionId)
  const shared = await createAgent(w1.sessionId, 'Shared memory assistant', 'Prefer the documented option')
  // The assistant page owns the main region, so the composer (and its selector
  // trigger) only comes back after the session is opened again.
  await openIsolatedSession(w1.sessionId)
  await selectorChoose(w1.sessionId, 'agent', shared.agentId)
  await openIsolatedSession(w2.sessionId)
  await selectorChoose(w2.sessionId, 'agent', shared.agentId)
  await openIsolatedSession(w3.sessionId)
  await selectorChoose(w3.sessionId, 'auto')
  // B1 needs a workspace with no private experience of its own, so the published
  // public L2 can be exercised with no eligible private L5 at all.
  await openIsolatedSession(w4.sessionId)
  await selectorChoose(w4.sessionId, 'agent', shared.agentId)

  // One real user decision per source workspace: the only eligible public sources.
  await openIsolatedSession(w1.sessionId)
  await submitMarker(instance, 'CROSS_W1_Q')
  const w1Case = await waitCase(w1.sessionId, 'CROSS_W1_Q', current => current.state === 'awaiting_user')
  await answerInboxWithSuggestions(w1.sessionId, w1Case.caseId, 'cross-w1-source')
  await openIsolatedSession(w2.sessionId)
  await submitMarker(instance, 'CROSS_W2_Q')
  const w2Case = await waitCase(w2.sessionId, 'CROSS_W2_Q', current => current.state === 'awaiting_user')
  await answerInboxWithSuggestions(w2.sessionId, w2Case.caseId, 'cross-w2-source')
  const sharedPrivateIds = [privateMemory.learningRunId, privateMemory.snapshotId]
  const foreignForW1 = [w2Case.caseId, ...sharedPrivateIds]
  const foreignForW2 = [w1Case.caseId, ...sharedPrivateIds]
  const foreignForW3 = [w1Case.caseId, w2Case.caseId, ...sharedPrivateIds]

  // W1 opens the public zone: disclosure first, then exactly one automatic candidate.
  await openDecisionPageForSession(w1.sessionId, 'w1-public-zone')
  await openAgent(w1.sessionId, shared.agentId)
  // Evaluate may only return plain data: a DOM node cannot cross the CDP boundary.
  const gated = await waitFor(() => instance.cdp.evaluate(`(() => {
    const zone=document.querySelector('[data-agent-detail="${shared.agentId}"] [data-memory-zone="public"]')
    return Boolean(zone?.querySelector('[data-public-disclosure]'))
  })()`), 30_000)
  requireEvidence(gated, 'the first public review is disclosure-gated')
  const gatedDom = await crossWorkspaceMemoryDom(shared.agentId)
  await shot('cross-public-disclosure')
  const gatedProblems = memoryZoneProblems({ ...gatedDom, workspacePaths, foreignRecordIds: foreignForW1 })
  check('publicFirstReviewRequiresDisclosure', gatedProblems.length === 0 && gatedDom.disclosure.required === true && gatedDom.candidate.present === false, { problems: gatedProblems, disclosure: gatedDom.disclosure })
  const publicMark = networkRpc.length
  await keyboardActivate('Acknowledge public memory disclosure', `[data-agent-detail="${shared.agentId}"] [data-action="public-acknowledge"]`)
  const acknowledgement = await assertUiRpc({ label: 'W1 acknowledgement', method: 'publicMemoryRefresh', args: { sessionId: w1.sessionId, agentId: shared.agentId, acknowledgedDisclosure: true }, mark: publicMark, exactly: 1 })
  requireEvidence(acknowledgement.payload?.status === 'candidate', 'the acknowledged refresh produced the one automatic public candidate')
  const review = await waitFor(() => instance.cdp.evaluate(`(() => {
    const zone=document.querySelector('[data-agent-detail="${shared.agentId}"] [data-memory-zone="public"]')
    const candidate=zone?.querySelector('[data-public-candidate]')
    return Boolean(candidate&&candidate.querySelector('[data-public-source]'))
  })()`), 60_000)
  requireEvidence(review, 'the acknowledged refresh produced a reviewable candidate')
  const candidateReview = await assertUiRpc({ label: 'W1 candidate review', method: 'publicCandidate', args: { sessionId: w1.sessionId, agentId: shared.agentId }, mark: publicMark })
  const candidateAuthority = candidateReview.payload
  requireEvidence(candidateAuthority?.candidate?.snapshotId && candidateAuthority?.candidate?.revision === 1, 'the review returned the real draft Snapshot')
  await collectNetwork()
  const candidateDom = await crossWorkspaceMemoryDom(shared.agentId)
  await shot('cross-public-candidate')
  const refreshRpc = networkRpc.filter(entry => entry.method === 'publicMemoryRefresh')
  const reviewRpc = networkRpc.filter(entry => entry.method === 'publicCandidate')
  check('publicCandidateAutomaticallyExtractedOnceFromTwoWorkspaces',
    refreshRpc.filter(entry => entry.args?.acknowledgedDisclosure === true).length === 1 &&
    reviewRpc.length >= 1 &&
    acknowledgement.payload?.workspaceCount === 2 &&
    candidateDom.candidate.aliases.length >= 1 &&
    candidateDom.candidate.aliases.every(alias => /^origin_[0-9a-f]+$/.test(alias)),
    { refresh: refreshRpc.map(entry => entry.args), review: reviewRpc.map(entry => entry.args), aliases: candidateDom.candidate.aliases, workspaceCount: acknowledgement.payload?.workspaceCount })
  const candidateProblems = memoryZoneProblems({ ...candidateDom, workspacePaths, foreignRecordIds: foreignForW1 })
  check('publicCandidateReviewMatchesMemoryZoneGuards', candidateProblems.length === 0, candidateProblems)
  // Minor 1: the rendered candidate body itself must carry no path and no foreign id.
  const candidateBodyProblems = publicCandidateBodyProblems({ present: candidateDom.candidate.present, text: candidateDom.candidate.text, workspacePaths, foreignRecordIds: foreignForW1, aliases: candidateDom.candidate.aliases })
  check('publicCandidateBodyHidesPathsAndForeignRecordIds', candidateBodyProblems.length === 0, candidateBodyProblems)
  // B3: the review must let a user read the reviewed wording, in ordinary language,
  // before adopting or discarding it — never an operation/id pair.
  const candidateWording = {
    rpc: { changes: candidateAuthority.changes ?? [], principles: candidateAuthority.principles ?? [], current: candidateAuthority.currentPublished?.principles ?? [] },
    dom: { present: candidateDom.candidate.present, text: candidateDom.candidate.text, changes: candidateDom.changes, frozenInput: candidateDom.frozenInput },
    expectedOps: ['add'], workspacePaths, foreignRecordIds: foreignForW1, aliases: candidateDom.candidate.aliases,
  }
  const candidateWordingProblems = publicCandidateWordingProblems(candidateWording)
  writeJson(join(out, 'cross-public-candidate-wording.json'), { rpc: candidateWording.rpc, dom: { changes: candidateDom.changes, frozenInput: candidateDom.frozenInput }, problems: candidateWordingProblems })
  check('publicCandidateReviewRendersProposedWording', candidateWordingProblems.length === 0, { problems: candidateWordingProblems, rendered: candidateDom.changes, reviewed: candidateWording.rpc.changes, frozenInput: candidateDom.frozenInput })

  // Explicit adoption, proved on the wire under the workspace that adopted it.
  const candidateSnapshotId = candidateAuthority.candidate.snapshotId
  const candidateRevision = candidateAuthority.candidate.revision
  const publishMark = networkRpc.length
  await keyboardActivate('Adopt public principles', `[data-agent-detail="${shared.agentId}"] [data-action="public-publish"]`)
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-learning-public-publish"))'), 30_000)
  const adoptionConfirmation = await instance.cdp.evaluate('document.querySelector("#weir-da-learning-public-publish").innerText')
  requireEvidence(/指导|guidance/i.test(adoptionConfirmation), 'the public adoption confirmation restates that the version is guidance only')
  await shot('cross-public-publish-confirm')
  await keyboardActivate('Confirm public adoption', '#weir-da-learning-public-publish .weir-da-actions button[data-variant="primary"]')
  const adoption = await assertUiRpc({ label: 'W1 public adoption', method: 'snapshotPublish', args: { sessionId: w1.sessionId, snapshotId: candidateSnapshotId, expectedRevision: candidateRevision }, mark: publishMark, exactly: 1 })
  const published = adoption.payload
  requireEvidence(published?.state === 'published' && published?.zone === 'public' && published?.snapshotId === candidateSnapshotId && published?.version === 1, 'the public adoption published exactly the reviewed draft')
  const publishedPrincipleId = (published.principles ?? []).find(principle => principle.state === 'active')?.principleId ?? null
  requireEvidence(Boolean(publishedPrincipleId), 'the published public version carries an active principle')
  const publishedDom = await waitFor(async () => { const value = await crossWorkspaceMemoryDom(shared.agentId); return value?.current?.version != null ? value : null }, 30_000)
  await shot('cross-public-published')
  const publishedProblems = memoryZoneProblems({ ...publishedDom, workspacePaths, foreignRecordIds: foreignForW1 })
  check('publicAdoptionIsExplicitAndPublishesOnce', publishedDom.current != null && publishedDom.current.rollback === true && publishedProblems.length === 0, { current: publishedDom.current, problems: publishedProblems })
  // B3: the adopted wording must stay readable afterwards, read-only, and match
  // the `current.principles` the product's own agent read reports.
  const publishedAuthority = await rpc(w1.sessionId, 'w1-published-principles', 'agent', { agentId: shared.agentId })
  const publishedPrinciples = publishedAuthority.publicMemory?.current?.principles ?? []
  const publishedWordingProblems = publicPublishedPrinciplesProblems({ expected: publishedPrinciples, dom: publishedDom, workspacePaths, foreignRecordIds: foreignForW1 })
  writeJson(join(out, 'cross-public-published-principles.json'), { expected: publishedPrinciples, dom: { published: publishedDom.published, current: publishedDom.current }, problems: publishedWordingProblems })
  check('publicPublishedPrinciplesRenderReadOnlyWording', publishedPrinciples.length > 0 && publishedPrinciples.every(principle => typeof principle.text === 'string' && principle.text.trim()) && publishedWordingProblems.length === 0, { problems: publishedWordingProblems, expected: publishedPrinciples, rendered: publishedDom.published })

  // The published version is profile-global: each workspace session must read the
  // same Snapshot on the wire and render that same version from its own page.
  const publicObservations = {}
  for (const [label, session, foreignRecordIds] of [['w1', w1, foreignForW1], ['w2', w2, foreignForW2], ['w3', w3, foreignForW3], ['w4', w4, foreignForW3]]) {
    const binding = await openDecisionPageForSession(session.sessionId, `${label}-public-version`)
    const mark = networkRpc.length
    await openAgent(session.sessionId, shared.agentId)
    const refresh = await assertUiRpc({ label: `${label} public zone read`, method: 'publicMemoryRefresh', args: { sessionId: session.sessionId, agentId: shared.agentId }, mark })
    const dom = await waitFor(async () => { const value = await crossWorkspaceMemoryDom(shared.agentId); return value?.current?.version != null ? value : null }, 30_000)
    const authority = await rpc(session.sessionId, `${label}-public-version`, 'agent', { agentId: shared.agentId })
    publicObservations[label] = {
      sessionId: session.sessionId, binding,
      pageRefresh: { rpcId: refresh.entry.rpcId, sessionId: refresh.receipt.sessionId, status: refresh.payload?.status ?? null },
      dom,
      wire: authority.publicMemory?.current ?? null,
      privateSnapshotId: authority.currentSnapshotId ?? null,
      problems: memoryZoneProblems({ ...dom, workspacePaths, foreignRecordIds }),
      publishedProblems: publicPublishedPrinciplesProblems({ expected: authority.publicMemory?.current?.principles ?? [], dom, workspacePaths, foreignRecordIds }),
    }
    await shot(`cross-${label}-shared-public-memory`)
  }
  // The same read-only published wording must render from every workspace page.
  const sharedPublishedProblems = Object.entries(publicObservations).flatMap(([label, value]) => value.publishedProblems.map(problem => `${label}: ${problem}`))
  check('publicPublishedPrinciplesShareAcrossWorkspaces', sharedPublishedProblems.length === 0, { problems: sharedPublishedProblems, principles: Object.fromEntries(Object.entries(publicObservations).map(([label, value]) => [label, (value.wire?.principles ?? []).map(principle => principle.principleId)])) })
  const publicVersions = { w1: Number(publishedDom.current?.version), w2: Number(publicObservations.w2.dom.current?.version), w3: Number(publicObservations.w3.dom.current?.version), w4: Number(publicObservations.w4.dom.current?.version) }
  const wireSnapshots = Object.fromEntries(Object.entries(publicObservations).map(([label, value]) => [label, value.wire?.snapshotId ?? null]))
  const versionProblems = [
    ...Object.entries(publicObservations).flatMap(([label, value]) => {
      const problems = []
      if (value.pageRefresh.sessionId !== value.sessionId) problems.push(`${label}: the rendered public zone read another workspace session`)
      if (value.wire?.snapshotId !== published.snapshotId) problems.push(`${label}: the wire did not return the published public Snapshot`)
      if (Number(value.wire?.version) !== publicVersions.w1) problems.push(`${label}: the wire returned public version ${value.wire?.version}`)
      if (Number(value.dom.current?.version) !== Number(value.wire?.version)) problems.push(`${label}: the rendered zone drifted from the wire`)
      // The zone status follows the last refresh (`up-to-date` after publication);
      // what must hold is the rendered current version, compared below.
      if (!Number.isInteger(Number(value.dom.current?.version))) problems.push(`${label}: the rendered public zone shows no current version`)
      if (value.privateSnapshotId !== null) problems.push(`${label}: the workspace rendered a private Snapshot it does not own`)
      return problems.concat(value.problems)
    }),
    ...(new Set(Object.values(publicVersions)).size === 1 ? [] : ['the workspaces rendered different public versions']),
    ...(new Set(Object.values(wireSnapshots)).size === 1 ? [] : ['the workspaces read different public Snapshots']),
  ]
  check('publicMemoryVersionIsSharedAcrossWorkspaces', versionProblems.length === 0, { publicVersions, wireSnapshots, wireRevisions: Object.fromEntries(Object.entries(publicObservations).map(([label, value]) => [label, value.wire?.revision ?? null])), problems: versionProblems })

  // B1: with the public version live, an evidence-free workspace still receives
  // the published public L2 as pinned, non-authoritative guidance.
  const w4Before = await rpc(w4.sessionId, 'w4-before-public-attempt', 'agent', { agentId: shared.agentId })
  requireEvidence((w4Before.currentSnapshotId ?? null) === null && (w4Before.learningRuns ?? []).length === 0 && (w4Before.snapshots ?? []).length === 0, 'W4 owns no private experience before the public-guidance Attempt')
  await openIsolatedSession(w4.sessionId)
  // The same real user judgment is submitted from a second workspace; the
  // question id names the fixture, not the workspace, so no scenario edit is needed.
  await submitMarker(instance, 'CROSS_W1_Q')
  const w4Case = await waitCase(w4.sessionId, 'CROSS_W1_Q', current => current.state === 'awaiting_user')
  const w4Guidance = await waitFor(async () => { const value = await record(w4.sessionId, 'w4-public-attempt', w4Case.caseId); return value.attempts.length > 0 ? value : null }, 90_000)
  const w4Attempt = w4Guidance.attempts.at(-1)
  const guidanceProblems = publicGuidancePinProblems({ published, attempt: w4Attempt })
  writeJson(join(out, 'cross-public-guidance-attempt.json'), { published, case: w4Guidance.case, attempt: w4Attempt, problems: guidanceProblems })
  check('publicGuidanceAttemptPinsPublishedSnapshotWithoutEvidence', guidanceProblems.length === 0 && w4Guidance.case.agentId === shared.agentId && w4Guidance.case.state === 'awaiting_user', { problems: guidanceProblems, outcome: w4Attempt.outcome, citedEvidenceIds: w4Attempt.citedEvidenceIds, pins: w4Attempt.pins, publicL2: { zone: w4Attempt.packManifest?.memory?.publicL2?.zone, status: w4Attempt.packManifest?.memory?.publicL2?.status, principleIds: w4Attempt.packManifest?.memory?.publicL2?.principleIds, items: w4Attempt.packManifest?.memory?.publicL2?.items }, privateL2: w4Attempt.packManifest?.memory?.L2?.principleIds ?? null, case: { caseId: w4Case.caseId, agentId: w4Guidance.case.agentId, state: w4Guidance.case.state } })
  const foreignForW4 = [w1Case.caseId, w2Case.caseId, ...sharedPrivateIds]

  // The rendered record detail must show both partitions with the real public pin.
  await openDecisionPageForSession(w4.sessionId, 'w4-public-record')
  const recordMark = networkRpc.length
  await openRecord(w4.sessionId, w4Case.caseId)
  await assertPageSession(recordMark, w4.sessionId, 'W4 record list')
  await openDisclosure(`weir-da-record-advanced-${w4Case.caseId}`)
  // The attempt context pack is one native <details>; reveal it with a real
  // pointer click on its summary (the same gesture a user makes), never by
  // forcing the open property.
  const packTarget = await instance.cdp.evaluate(`(() => {
    const summary=document.querySelector('[data-record-detail=${JSON.stringify(w4Case.caseId)}] details[data-attempt-context-pack=${JSON.stringify(w4Attempt.attemptId)}] > summary')
    if(!summary)return null
    summary.scrollIntoView({block:'center',inline:'nearest'})
    const rect=summary.getBoundingClientRect()
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,text:summary.textContent.trim()}
  })()`)
  requireEvidence(packTarget && packTarget.text, 'the attempt context pack disclosure is rendered')
  for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
    await instance.cdp.request('Input.dispatchMouseEvent', { type, x: packTarget.x, y: packTarget.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
  }
  writeJson(join(out, 'cross-public-record-reveal.json'), { caseId: w4Case.caseId, attemptId: w4Attempt.attemptId, method: 'CDP Input.dispatchMouseEvent', target: packTarget })
  const recordCapture = await waitFor(() => instance.cdp.evaluate(`(() => {
    const detail=document.querySelector('[data-record-detail=${JSON.stringify(w4Case.caseId)}]')
    if(!detail)return null
    const pack=detail.querySelector('details[data-attempt-context-pack=${JSON.stringify(w4Attempt.attemptId)}]')
    if(!pack||pack.open!==true)return null
    const publicSection=detail.querySelector('[data-partition-section="public"]')
    const privateSection=detail.querySelector('[data-partition-section="workspace"]')
    const readMapping=zone=>[...(zone?.querySelectorAll('[data-partition="public"] li')??[])].map(item=>{
      let parsed={}
      try { parsed=JSON.parse(item.querySelector('pre')?.textContent??'{}') } catch { parsed={ evidenceIds:['unparseable'] } }
      return { principleId:item.querySelector('code')?.textContent??'', evidenceIds:Array.isArray(parsed.evidenceIds)?parsed.evidenceIds:['missing'] }
    })
    let pin=null
    try { pin=JSON.parse(publicSection?.querySelector('[data-partition="public"] pre')?.textContent??'null') } catch { pin=null }
    return {
      caseId: detail.getAttribute('data-record-detail'),
      advancedOpen: true,
      publicTitle: publicSection?.querySelector('strong')?.textContent??'',
      privateTitle: privateSection?.querySelector('strong')?.textContent??'',
      publicText: publicSection?.innerText??'',
      privateText: privateSection?.innerText??'',
      publicPin: pin,
      publicMapping: readMapping(publicSection),
      publicPrincipleIds: [...(publicSection?.querySelectorAll('[data-partition="public"] li code')??[])].map(el=>el.textContent),
      summary: detail.querySelector('[data-current-evidence]')?.innerText??'',
      text: detail.innerText,
    }
  })()`), 30_000)
  requireEvidence(recordCapture?.advancedOpen === true, 'the attempt context pack opened through its rendered disclosure')
  await shot('cross-w4-public-pin-record')
  const recordProblems = publicRecordDetailProblems(recordCapture, { snapshotId: published.snapshotId, revision: published.revision, principleId: publishedPrincipleId, workspacePaths, foreignRecordIds: foreignForW4 })
  writeJson(join(out, 'cross-public-record-detail.json'), { capture: recordCapture, problems: recordProblems })
  check('publicGuidanceRecordDetailShowsBothPartitionsWithRealPin', recordProblems.length === 0, { problems: recordProblems, publicPin: recordCapture.publicPin, publicPrincipleIds: recordCapture.publicPrincipleIds, publicMapping: recordCapture.publicMapping, summary: recordCapture.summary })

  // B2: a new eligible source raises the public high-water mark, and the second
  // candidate is rejected through the rendered confirmation.
  await openDecisionPageForSession(w4.sessionId, 'w4-source', 'inbox')
  const w4Closed = await answerInboxWithSuggestions(w4.sessionId, w4Case.caseId, 'cross-w4-source')
  requireEvidence(w4Closed.case.state === 'closed' && w4Closed.case.closing === 'escalated', 'the W4 judgment closed as a real user decision')
  await openDecisionPageForSession(w4.sessionId, 'w4-second-candidate')
  const secondMark = networkRpc.length
  await openAgent(w4.sessionId, shared.agentId)
  const secondRefresh = await assertUiRpc({ label: 'W4 second public draft', method: 'publicMemoryRefresh', args: { sessionId: w4.sessionId, agentId: shared.agentId }, mark: secondMark })
  const secondReview = await assertUiRpc({ label: 'W4 second candidate review', method: 'publicCandidate', args: { sessionId: w4.sessionId, agentId: shared.agentId }, mark: secondMark })
  const secondCandidate = secondReview.payload?.candidate ?? null
  requireEvidence(Boolean(secondCandidate?.snapshotId) && secondCandidate.snapshotId !== published.snapshotId && secondCandidate.version === 2, 'the new high-water mark produced a second, distinct public candidate')
  requireEvidence(secondRefresh.payload?.workspaceCount === 3 && secondRefresh.payload?.sourceCount === 3, 'the second candidate froze eligible sources from three workspaces')
  const secondCandidateDom = await waitFor(async () => {
    const value = await crossWorkspaceMemoryDom(shared.agentId)
    return value?.candidate?.present === true && value.candidate.aliases.length >= 3 ? value : null
  }, 60_000)
  await shot('cross-public-second-candidate')
  const secondCandidateProblems = memoryZoneProblems({ ...secondCandidateDom, workspacePaths, foreignRecordIds: foreignForW4 })
  const secondBodyProblems = publicCandidateBodyProblems({ present: secondCandidateDom.candidate.present, text: secondCandidateDom.candidate.text, workspacePaths, foreignRecordIds: foreignForW4, aliases: secondCandidateDom.candidate.aliases })
  check('publicSecondCandidateStaysOpaqueAndGuarded', secondCandidateProblems.length === 0 && secondBodyProblems.length === 0, { zone: secondCandidateProblems, body: secondBodyProblems, aliases: secondCandidateDom.candidate.aliases })
  // B3: the refine candidate must render the refined wording, not `refine · id`.
  const secondWording = {
    rpc: { changes: secondReview.payload?.changes ?? [], principles: secondReview.payload?.principles ?? [], current: secondRefresh.payload?.current?.principles ?? [] },
    dom: { present: secondCandidateDom.candidate.present, text: secondCandidateDom.candidate.text, changes: secondCandidateDom.changes, frozenInput: secondCandidateDom.frozenInput },
    expectedOps: ['refine'], workspacePaths, foreignRecordIds: foreignForW4, aliases: secondCandidateDom.candidate.aliases,
  }
  const secondWordingProblems = publicCandidateWordingProblems(secondWording)
  writeJson(join(out, 'cross-public-second-candidate-wording.json'), { rpc: secondWording.rpc, dom: { changes: secondCandidateDom.changes, frozenInput: secondCandidateDom.frozenInput }, problems: secondWordingProblems })
  check('publicSecondCandidateRendersRefinedWording', secondWordingProblems.length === 0, { problems: secondWordingProblems, rendered: secondCandidateDom.changes, reviewed: secondWording.rpc.changes, frozenInput: secondCandidateDom.frozenInput })
  // B3: the refined wording must differ from the wording that is still published,
  // otherwise a stale render and a refined render would look the same.
  const refinedWordingProblems = publicRefinedWordingProblems({ rpc: secondWording.rpc, dom: secondWording.dom, published: publishedPrinciples })
  writeJson(join(out, 'cross-public-refined-wording.json'), { published: publishedPrinciples.map(principle => ({ principleId: principle.principleId, text: principle.text })), reviewed: secondWording.rpc.changes, rendered: secondCandidateDom.changes, problems: refinedWordingProblems })
  check('publicSecondCandidateRefinesDistinctWording', refinedWordingProblems.length === 0, { problems: refinedWordingProblems, published: publishedPrinciples.map(principle => principle.text), reviewed: secondWording.rpc.changes, rendered: secondCandidateDom.changes })

  const beforeReject = await rpc(w4.sessionId, 'w4-before-public-reject', 'agent', { agentId: shared.agentId })
  const beforeCurrent = beforeReject.publicMemory?.current ?? null
  const rejectMark = networkRpc.length
  await keyboardActivate('Discard public candidate', `[data-agent-detail="${shared.agentId}"] [data-action="public-reject"]`)
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-learning-public-reject"))'), 30_000)
  const rejectionConfirmation = await instance.cdp.evaluate('document.querySelector("#weir-da-learning-public-reject").innerText')
  requireEvidence(/不会影响之后的判断|history|历史/i.test(rejectionConfirmation), 'the public rejection confirmation states its future-only consequence and retained history')
  await shot('cross-public-reject-confirm')
  await keyboardActivate('Confirm public rejection', '#weir-da-learning-public-reject .weir-da-actions button:last-child')
  const rejection = await assertUiRpc({ label: 'W4 public candidate rejection', method: 'snapshotReject', args: { sessionId: w4.sessionId, snapshotId: secondCandidate.snapshotId, expectedRevision: secondCandidate.revision }, mark: rejectMark, exactly: 1 })
  const rejectionReload = await assertUiRpc({ label: 'W4 public zone after rejection', method: 'publicMemoryRefresh', args: { sessionId: w4.sessionId, agentId: shared.agentId }, mark: rejectMark })
  const afterRejectDom = await waitFor(async () => { const value = await crossWorkspaceMemoryDom(shared.agentId); return value && value.candidate.present === false && value.current?.version != null ? value : null }, 30_000)
  await shot('cross-public-rejected')
  const afterReject = await rpc(w4.sessionId, 'w4-after-public-reject', 'agent', { agentId: shared.agentId })
  const rejectionAudit = publicAuditLines(workspaceFour)
  const rejectionAuditLine = rejectionAudit.find(line => line.kind === 'snapshot' && line.action === 'reject' && line.snapshotId === secondCandidate.snapshotId) ?? null
  const rejectionProblems = publicCandidateRejectionProblems({
    sessionId: w4.sessionId,
    wireSessionId: rejection.receipt.sessionId,
    candidate: { snapshotId: secondCandidate.snapshotId, learningRunId: secondReview.payload?.learningRunId ?? null },
    beforeCurrent,
    afterCurrent: afterReject.publicMemory?.current ?? null,
    runOutcome: rejectionReload.payload?.run?.outcome ?? null,
    runId: rejectionReload.payload?.run?.learningRunId ?? null,
    snapshotState: rejection.payload?.state ?? null,
    domVersion: Number(afterRejectDom.current?.version),
    domCandidatePresent: afterRejectDom.candidate.present,
    auditSessionId: rejectionAuditLine?.rootSessionId ?? null,
    audit: rejectionAudit,
  })
  writeJson(join(out, 'cross-public-rejection.json'), { candidate: secondCandidate, beforeCurrent, afterCurrent: afterReject.publicMemory?.current ?? null, wire: rejection.receipt, reload: { status: rejectionReload.payload?.status ?? null, run: rejectionReload.payload?.run ?? null }, excluded: rejection.payload?.state ?? null, audit: rejectionAudit, problems: rejectionProblems })
  check('publicCandidateRejectionKeepsPublishedVersion', rejectionProblems.length === 0, { problems: rejectionProblems, current: afterReject.publicMemory?.current ?? null, run: rejectionReload.payload?.run ?? null, audit: rejectionAudit.filter(line => line.kind === 'learning-run' || line.kind === 'snapshot').slice(-4) })

  // Rollback restores the empty public L2 in every workspace and touches no private row.
  await openDecisionPageForSession(w1.sessionId, 'w1-rollback')
  await openAgent(w1.sessionId, shared.agentId)
  await waitFor(async () => { const value = await crossWorkspaceMemoryDom(shared.agentId); return value?.current?.version != null ? value : null }, 30_000)
  const rollbackMark = networkRpc.length
  await keyboardActivate('Restore previous public version', `[data-agent-detail="${shared.agentId}"] [data-action="public-rollback"]`)
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-learning-public-rollback"))'), 30_000)
  await keyboardActivate('Confirm public rollback', '#weir-da-learning-public-rollback .weir-da-actions button:last-child')
  const rollback = await assertUiRpc({ label: 'W1 public rollback', method: 'snapshotRollback', args: { sessionId: w1.sessionId, snapshotId: published.snapshotId, expectedRevision: published.revision }, mark: rollbackMark, exactly: 1 })
  requireEvidence(rollback.payload?.state === 'rolled_back', 'the public rollback retired the published Snapshot')
  const w1RolledBack = await waitFor(async () => { const value = await crossWorkspaceMemoryDom(shared.agentId); return value && value.current === null ? value : null }, 30_000)
  await shot('cross-public-rolled-back')
  await openDecisionPageForSession(w2.sessionId, 'w2-rollback')
  await openAgent(w2.sessionId, shared.agentId)
  const w2Dom = await waitFor(async () => { const value = await crossWorkspaceMemoryDom(shared.agentId); return value && value.current === null ? value : null }, 30_000)
  const rolledBackProblems = [
    ...memoryZoneProblems({ ...w1RolledBack, workspacePaths, foreignRecordIds: [w2Case.caseId, w4Case.caseId, ...sharedPrivateIds] }),
    ...memoryZoneProblems({ ...w2Dom, workspacePaths, foreignRecordIds: [w1Case.caseId, w4Case.caseId, ...sharedPrivateIds] }),
  ]
  check('publicRollbackRestoresEmptyPublicZone', w1RolledBack.current === null && w2Dom.current === null && rolledBackProblems.length === 0, { w1: w1RolledBack.current, w2: w2Dom.current, problems: rolledBackProblems })

  // W3 has no private experience at all: Auto may select the shared assistant,
  // but it can never answer from public memory alone. The P4 restore leaves the
  // answer-class whitelist empty, so Auto admits nothing until it is opened again.
  await setAutoSettings(`${phase}-auto`, { shadow: false, answerClasses: ['A'], answerTimeoutMs: 150 })
  await openIsolatedSession(w3.sessionId)
  await submitMarker(instance, 'CROSS_AUTO_Q')
  const autoCase = await waitCase(w3.sessionId, 'CROSS_AUTO_Q')
  const autoRecord = await record(w3.sessionId, `${phase}-auto`, autoCase.caseId)
  const autoShare = {
    selectorAccepted: autoRecord.case.agentId === shared.agentId,
    answered: autoRecord.case.state === 'closed' && autoRecord.case.closing === 'answered',
    attemptCount: autoRecord.attempts.length,
    citedEvidenceCount: autoRecord.attempts.reduce((sum, attempt) => sum + (attempt.citedEvidenceIds?.length ?? 0), 0),
    attemptOutcomes: autoRecord.attempts.map(attempt => attempt.outcome),
    lastAttemptOutcome: autoRecord.attempts.at(-1)?.outcome ?? null,
    citedSources: [...new Set(autoRecord.attempts.flatMap(attempt => (attempt.evidence ?? []).map(ref => ref.source)))],
    awaitingReason: autoRecord.case.awaitingReason ?? null,
    caseState: autoRecord.case.state,
    publicPin: autoRecord.attempts.at(-1)?.pins?.publicMemorySnapshotId ?? null,
  }
  await shot('cross-w3-auto-shared-assistant')
  await openDecisionPageForSession(w3.sessionId, 'w3-final')
  await openAgent(w3.sessionId, shared.agentId)
  const w3Dom = await crossWorkspaceMemoryDom(shared.agentId)
  await openDecisionPageForSession(w4.sessionId, 'w4-final')
  await openAgent(w4.sessionId, shared.agentId)
  const w4Dom = await crossWorkspaceMemoryDom(shared.agentId)

  // Private records never cross workspaces: both directions plus both learning
  // read paths, each with the fail-closed shape its own product path produces.
  const denials = [
    ...(await crossWorkspaceDenial(w2.sessionId, [{ method: 'record', args: { caseId: w1Case.caseId } }], workspaceTwo)),
    ...(await crossWorkspaceDenial(w1.sessionId, [{ method: 'record', args: { caseId: w2Case.caseId } }], workspaceOne)),
    ...(await crossWorkspaceDenial(w2.sessionId, [
      { method: 'learningRun', args: { learningRunId: privateMemory.learningRunId } },
      { method: 'memorySnapshot', args: { snapshotId: privateMemory.snapshotId } },
    ], workspaceTwo)),
  ]
  const w1Agents = await rpc(w1.sessionId, `${phase}-w1-agents`, 'agents')
  const w2Agents = await rpc(w2.sessionId, `${phase}-w2-agents`, 'agents')
  const w3Agents = await rpc(w3.sessionId, `${phase}-w3-agents`, 'agents')
  const w4Agents = await rpc(w4.sessionId, `${phase}-w4-agents`, 'agents')
  const w1Records = await records(w1.sessionId)
  const w2Records = await records(w2.sessionId)
  const w3Records = await records(w3.sessionId)
  const w4Records = await records(w4.sessionId)
  await shot('cross-w2-shared-identity')
  const identity = agents => agents.map(agent => `${agent.agentId}:${agent.name}`)
  const sharedProblems = crossWorkspaceShareProblems({
    workspaces: [
      { label: 'W1', assistantNames: identity(w1Agents), publicVersion: publicVersions.w1, privateRecordIds: w1Records.records.map(item => item.caseId), navigation: w1RolledBack.navigation, text: w1RolledBack.text },
      { label: 'W2', assistantNames: identity(w2Agents), publicVersion: publicVersions.w2, privateRecordIds: w2Records.records.map(item => item.caseId), navigation: w2Dom.navigation, text: w2Dom.text },
      { label: 'W3', assistantNames: identity(w3Agents), publicVersion: publicVersions.w3, privateRecordIds: w3Records.records.map(item => item.caseId), navigation: w3Dom.navigation, text: w3Dom.text },
      { label: 'W4', assistantNames: identity(w4Agents), publicVersion: publicVersions.w4, privateRecordIds: w4Records.records.map(item => item.caseId), navigation: w4Dom.navigation, text: w4Dom.text },
    ],
    workspacePaths,
    denials,
    autoShare,
  })
  // M4: every UI-triggered public action and every page binding is wire-backed.
  const wireProblems = publicWireAttributionProblems({ bindings: pageBindings, actions: publicWires })
  check('publicUiActionsCarryTheIntendedWorkspaceSession', wireProblems.length === 0, { problems: wireProblems, actions: publicWires, bindings: pageBindings })
  writeJson(join(out, 'cross-workspace-matrix.json'), { phase, sessions: { w1: w1.sessionId, w2: w2.sessionId, w3: w3.sessionId, w4: w4.sessionId }, assistant: shared.agentId, cases: { w1: w1Case.caseId, w2: w2Case.caseId, w4: w4Case.caseId, auto: autoCase.caseId }, publicVersions, published: { snapshotId: published.snapshotId, version: published.version, revision: published.revision, contentHash: published.contentHash, principleId: publishedPrincipleId }, publicObservations, publicWires, pageBindings, publicGuidance: { case: { caseId: w4Case.caseId, state: w4Guidance.case.state, agentId: w4Guidance.case.agentId }, attempt: { attemptId: w4Attempt.attemptId, outcome: w4Attempt.outcome, citedEvidenceIds: w4Attempt.citedEvidenceIds, pins: w4Attempt.pins, publicL2: w4Attempt.packManifest?.memory?.publicL2 ?? null, evidenceIds: w4Attempt.packManifest?.evidenceIds ?? [] }, problems: guidanceProblems }, publicRecordDetail: { capture: recordCapture, problems: recordProblems }, publicRejection: { candidate: secondCandidate, problems: rejectionProblems, audit: rejectionAudit }, denials, gatedDom, candidateDom, secondCandidateDom, publishedDom, rolledBack: { w1: w1RolledBack, w2: w2Dom }, w3Dom, w4Dom, autoShare, refreshRpc, reviewRpc, privateMemory, problems: sharedProblems })
  check('crossWorkspaceSharedIdentityAndPrivateIsolation', sharedProblems.length === 0, sharedProblems)
  // Gated real-Desktop export leg: W4 owns live cases in this profile, so its own
  // session is the export scope.
  const exportSurface = await runExportSurfaceAcceptance(w4.sessionId)
  return { sessions: { w1: w1.sessionId, w2: w2.sessionId, w3: w3.sessionId, w4: w4.sessionId }, agentId: shared.agentId, denials, problems: [...sharedProblems, ...wireProblems, ...guidanceProblems, ...recordProblems, ...rejectionProblems], exportSurface }
}

function writeReport(verdict, error = null) {
  const exceptionCount = runtimeEvents.filter(item => item.event.method === 'Runtime.exceptionThrown').length
  const slotCrashCount = runtimeEvents.filter(item => /slot entry crashed|Slot.*crash/i.test(JSON.stringify(item.event))).length
  const consultDefectPath = join(out, 'product-defect-consult-before-result.json')
  const consultDefect = existsSync(consultDefectPath) ? JSON.parse(readFileSync(consultDefectPath, 'utf8')) : null
  const lines = [
    '# Decision Agent Auto Router：真实隔离 Desktop 验收报告', '',
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
    `- 延迟宿主欢迎页处理：${hostOnboardingDismissals.length} 次；host-onboarding.json 记录触发动作、真实宿主开始设置与默认工作区完成证据。`,
    '## 验收矩阵', '',
    '| 检查 | 结果 |', '|---|---|',
    ...Object.entries(checks).map(([name, pass]) => `| \`${name}\` | ${pass ? 'PASS' : 'BLOCKED'} |`), '',
    '## RPC ↔ UI 与历史约束', '',
    '- `network-rpc.json` 保存 CDP Network 原始请求/响应、rpcId、method、完整 args。',
    '- `authoritative-rpc.json` 保存只读权威 RPC；驱动拒绝直接调用任何写方法。',
    '- `rpc-ui-comparisons.json` 对照记录 ID/revision/state/answers、Snapshot expectedRevision 与 UI。',
    '- `immutable-history.json` 检查 Attempt、Snapshot 原则内容与 RouteDecision 未改写或消失。',
    '- 所有 selector、助手、决定、反馈、纠正、整理、采用、放弃、恢复写操作均由真实 UI 的原生 CDP 键盘事件触发；Auto 只使用测试显式配置的 A 白名单，Shadow 仅追加诊断，不做自动整理或发布。', '',
    '## 视觉、主题、缩放、键盘与可访问性', '',
    `- 已执行 ${visualAudits.length} 项视觉审计；目标为 360/768/1440 CSS px、light/dark、200% page scale，记录横向溢出、主操作裁切、控件名称与主题计算色。`,
    `- 已保存 ${Object.keys(accessibility).length} 组 CDP Accessibility 证据；keyboard-interactions.json 逐步记录 ${keyboardAudits.length} 组原生 Tab/Shift+Tab/Arrow/Enter/Space/Input.insertText 轨迹、activeElement、accessible name 与结果。`,
    '- `runtime-events.json` 与 `runtime-scan.json` 保存异常、console、Slot crash 和加载失败扫描。', '',
    '## 真实截图', '',
    ...screenshots.map(item => `- [${item.name}](${basename(item.path)}) — ${item.bytes} bytes`), '',
    '## 精确进程与端口清理', '',
    ...cleanups.map(item => `- ${item.label}: main PID ${item.mainPid} / Host PID ${item.hostPid}，mainStopped=${item.mainStopped}，hostStopped=${item.hostStopped}，hostSignal=${item.hostSignal}，portReleased=${item.portReleased}`), '',
    `当前 App、当前 profile/store、产品源码和 OpenSpec 复选框未被本驱动修改；除 lane 内合并固定 main 外，未 deploy 或 release。隔离 scratch 为证据保留，不属于用户真实数据。`, '',
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

async function measureNativeModal(selector, originSelector = '[data-weir-decision-trigger="weir-decision-selector"]') {
  return instance.cdp.evaluate(`(() => {
    const dialog=document.querySelector(${JSON.stringify(selector)})
    if(!dialog)return null
    const origin=document.querySelector(${JSON.stringify(originSelector)})
    const value=dialog.getBoundingClientRect()
    const visual=visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop}:{width:innerWidth,height:innerHeight,scale:1,offsetLeft:0,offsetTop:0}
    const points=[[visual.offsetLeft+2,visual.offsetTop+2],[visual.offsetLeft+visual.width-2,visual.offsetTop+2],[visual.offsetLeft+2,visual.offsetTop+visual.height-2],[visual.offsetLeft+visual.width-2,visual.offsetTop+visual.height-2]]
    if(origin){const rect=origin.getBoundingClientRect();points.push([rect.left+rect.width/2,rect.top+rect.height/2])}
    const hitTests=points.filter(([x,y])=>x>=0&&y>=0&&x<innerWidth&&y<innerHeight).map(([x,y])=>{const hits=document.elementsFromPoint(x,y);return {x,y,hitsDialog:hits.includes(dialog),hitsOrigin:Boolean(origin&&hits.includes(origin)),stack:hits.slice(0,4).map(el=>({tag:el.tagName,id:el.id||null,class:typeof el.className==='string'?el.className.slice(0,160):''}))}})
    const backdrop=getComputedStyle(dialog,'::backdrop')
    const inset=['top','right','bottom','left'].every(name=>Math.abs(Number.parseFloat(backdrop[name])||0)<0.01)
    const backdropCoversVisualViewport=dialog.matches(':modal')&&backdrop.position==='fixed'&&inset&&hitTests.length>=4&&hitTests.every(hit=>hit.hitsDialog)
    const backgroundInert=dialog.matches(':modal')&&hitTests.every(hit=>hit.hitsDialog&&!hit.hitsOrigin)
    return {
      implementation:'native-dialog',tagName:dialog.tagName,open:dialog.open,modal:dialog.matches(':modal'),ariaModal:dialog.getAttribute('aria-modal'),
      showModalCalls:dialog.__uiuxShowModalCalls??0,showModalError:dialog.__uiuxShowModalError??null,
      composerContainsDialog:Boolean(origin?.parentElement?.contains(dialog)),focusInside:dialog.contains(document.activeElement),
      backdropCoversVisualViewport,backgroundInert,visualViewport:visual,hitTests,
      backdrop:{position:backdrop.position,top:backdrop.top,right:backdrop.right,bottom:backdrop.bottom,left:backdrop.left,backgroundColor:backdrop.backgroundColor},
      rect:{x:value.x,y:value.y,left:value.left,top:value.top,width:value.width,height:value.height,right:value.right,bottom:value.bottom},
    }
  })()`)
}

async function measureScrollContainers(selectors = {}, originSelector = null) {
  return instance.cdp.evaluate(`(() => {
    const definitions=${JSON.stringify(selectors)}
    const origin=${JSON.stringify(originSelector)}
    const seen=new Set()
    const entries=[]
    const add=(name,el)=>{if(!el||seen.has(el))return;seen.add(el);entries.push([name,el])}
    for(const [name,selector] of Object.entries(definitions))add(name,name==='root'?document.documentElement:name==='body'?document.body:document.querySelector(selector))
    for(const el of document.querySelectorAll('[data-weir-uiux-scroll]'))add(el.getAttribute('data-weir-uiux-scroll'),el)
    add('decisionPage',document.querySelector('main.weir-da-page'))
    const originElement=origin?document.querySelector(origin):null
    const markedComposer=document.querySelector('[data-weir-uiux-scroll="composer"]')
    const markedSession=document.querySelector('[data-weir-uiux-scroll="session"]')
    const chain=[]
    for(let current=originElement;current;current=current.parentElement){if(current===document.documentElement||current===document.body||current.matches?.('main.weir-da-page'))continue;const overflow=getComputedStyle(current).overflowY;if(current===markedComposer||current===markedSession||['auto','scroll','overlay'].includes(overflow))chain.push(current)}
    const decisionOrigin=Boolean(originElement&&(originElement.matches('[data-weir-decision-trigger="weir-decision-selector"]')||document.querySelector('main.weir-da-page')?.contains(originElement)))
    if(decisionOrigin){add('composer',chain[0]);add('session',chain[1])}
    for(let index=0;index<chain.length;index+=1)add('ancestor-'+index,chain[index])
    const result=Object.fromEntries(entries.map(([name,el])=>{el.setAttribute('data-weir-uiux-scroll',name);const rect=el.getBoundingClientRect();const computed=getComputedStyle(el);return [name,{
      identity:{tag:el.tagName,id:el.id||null,class:typeof el.className==='string'?el.className.slice(0,240):''},
      scrollTop:el.scrollTop,scrollLeft:el.scrollLeft,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,
      inline:Object.fromEntries(['overflow','overflowX','overflowY','overscrollBehavior','overscrollBehaviorX','overscrollBehaviorY','paddingRight','paddingBottom','overflowAnchor'].map(key=>[key,el.style[key]??''])),
      computed:{overflowY:computed.overflowY,overscrollBehavior:computed.overscrollBehavior},
      rect:{x:rect.x,y:rect.y,left:rect.left,top:rect.top,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom},
    }]}))
    if(result.composer&&!result.session&&(markedComposer||(decisionOrigin&&chain[0]&&!chain[1])))result.session={...result.composer,identity:{...result.composer.identity},aliasOf:'composer',sameElement:true}
    if(result.session&&(markedSession||(decisionOrigin&&chain[1]))){result.session.aliasOf=null;result.session.sameElement=false}
    return result
  })()`)
}

async function measureSessionScrollerIdentity(originSelector) {
  return instance.cdp.evaluate(`(() => {
    const origin=document.querySelector(${JSON.stringify(originSelector)})
    const identity=el=>{if(!el)return null;const rect=el.getBoundingClientRect();return {tag:el.tagName,id:el.id||null,class:typeof el.className==='string'?el.className.slice(0,240):'',overflowY:getComputedStyle(el).overflowY,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}}
    const chain=[]
    const markedComposer=document.querySelector('[data-weir-uiux-scroll="composer"]')
    const markedSession=document.querySelector('[data-weir-uiux-scroll="session"]')
    for(let current=origin;current;current=current.parentElement){if(current===document.documentElement||current===document.body||current.matches?.('main.weir-da-page'))continue;const overflow=getComputedStyle(current).overflowY;if(current===markedComposer||current===markedSession||['auto','scroll','overlay'].includes(overflow))chain.push(current)}
    const composer=chain[0]??null
    const distinctSession=chain[1]??null
    const required=Boolean(composer)
    const relation=!required?'not-present':distinctSession?'distinct-element':'same-element'
    return {originSelector:${JSON.stringify(originSelector)},originConnected:origin?.isConnected===true,originContained:Boolean(composer&&composer.contains(origin)),required,relation,sameElement:!required?null:distinctSession?false:true,aliasOf:required&&!distinctSession?'composer':null,onlyOneOverflowAncestor:required&&chain.length===1,composer:identity(composer),session:identity(distinctSession??composer),ancestorChain:chain.map(identity),proof:'computed overflow ancestors of the connected real product origin'}
  })()`)
}

async function measureStableScrollContainers(selectors = {}, originSelector = null) {
  let previous = null
  return waitFor(async () => {
    const current = await measureScrollContainers(selectors, originSelector)
    const signature = JSON.stringify(current)
    const settled = signature === previous
    previous = signature
    return settled ? current : null
  }, 10_000)
}

async function measureColdReveal(targetSelector, scrollerSelector, state = {}) {
  return instance.cdp.evaluate(`(() => {
    const options=${JSON.stringify(state)}
    const target=document.querySelector(${JSON.stringify(targetSelector)})
    const scroller=document.querySelector(${JSON.stringify(scrollerSelector)})
    const draft=options.draftSelector?document.querySelector(options.draftSelector):null
    const active=document.activeElement
    const calls=(window.__weirUiuxRevealCalls??[]).filter(call=>call.id===target?.id)
    const latest=calls.at(-1)?.options??{}
    const draftValue=draft?draft.matches?.('form')?JSON.stringify([...draft.querySelectorAll('input,textarea')].map(el=>({name:el.name||el.getAttribute('aria-label'),value:el.value,checked:el.checked}))):draft.value??draft.textContent:null
    return {
      ...options,targetBottom:target?.getBoundingClientRect().bottom??null,scrollerBottom:scroller?.getBoundingClientRect().bottom??null,
      scrollTop:scroller?.scrollTop??null,active:[active?.id,active?.tagName?.toLowerCase(),active?.getAttribute?.('aria-label'),active?.value].filter(Boolean).join(':')||null,draft:draftValue,
      revealCount:calls.length,behavior:latest.behavior??null,block:latest.block??null,revealCalls:calls,
    }
  })()`)
}

async function measureMasterDetail(selectors = {}) {
  return instance.cdp.evaluate(`(() => {
    const list=document.querySelector(${JSON.stringify(selectors.list ?? '[data-agent-summary]')})
    const detail=document.querySelector(${JSON.stringify(selectors.detail ?? '[data-agent-detail],[data-agent-editor]')})
    const visible=el=>Boolean(el&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden')
    const rect=el=>{if(!el)return null;const value=el.getBoundingClientRect();return {x:value.x,y:value.y,left:value.left,top:value.top,width:value.width,height:value.height,right:value.right,bottom:value.bottom}}
    return {
      listVisible:visible(list),detailVisible:visible(detail),independentRegions:Boolean(list&&detail&&list!==detail&&!list.contains(detail)&&!detail.contains(list)),
      horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,listRect:rect(list),detailRect:rect(detail),
    }
  })()`)
}

function saveUiuxEvidence() {
  writeJson(join(out, 'uiux-acceptance.json'), uiuxEvidence)
}

async function installUiuxInstrumentation() {
  const installed = await instance.cdp.evaluate(`(() => {
    if(window.__weirUiuxDriverInstalled)return true
    const dialog=window.HTMLDialogElement?.prototype
    if(!dialog?.showModal||!window.Element?.prototype?.scrollIntoView)return false
    const showModal=dialog.showModal
    dialog.showModal=function(...args){
      this.__uiuxShowModalCalls=(this.__uiuxShowModalCalls??0)+1
      this.__uiuxShowModalError=null
      try{return showModal.apply(this,args)}catch(error){this.__uiuxShowModalError=error?.message??String(error);throw error}
    }
    const scrollIntoView=window.Element.prototype.scrollIntoView
    window.__weirUiuxRevealCalls=[]
    window.Element.prototype.scrollIntoView=function(...args){
      window.__weirUiuxRevealCalls.push({id:this.id||null,at:Date.now(),options:args[0]??null})
      return scrollIntoView.apply(this,args)
    }
    window.__weirUiuxDriverInstalled=true
    return true
  })()`)
  requireEvidence(installed, 'real Desktop accepts UIUX showModal and reveal instrumentation')
}

async function holdDecision(method, args, action = 'hold') {
  const id = await instance.cdp.evaluate(`window.__decisionQA.controlDecision(${JSON.stringify({ method, args, action })})`)
  requireEvidence(typeof id === 'string', `hold control created for ${method}`)
  return id
}

async function releaseDecision(id) {
  return instance.cdp.evaluate(`window.__decisionQA.releaseDecisionControl(${JSON.stringify(id)})`)
}

async function decisionControl(id) {
  const states = await instance.cdp.evaluate('window.__decisionQA.decisionControlState()')
  const control = states.find(item => item.id === id)
  requireEvidence(control, `known UIUX RPC control ${id}`)
  return control
}

async function measureConfirmationFocus(originSelector, controlId = null) {
  return instance.cdp.evaluate(`(() => {
    const origin=${JSON.stringify(originSelector)}
    const describe=el=>el?{connected:el.isConnected,enabled:!el.disabled&&el.getAttribute('aria-disabled')!=='true',visible:el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden',focused:document.activeElement===el}:null
    const key=${JSON.stringify(controlId)}
    const origins=window.__weirUiuxConfirmationOrigins??=new Map()
    let target=key?origins.get(key):document.querySelector(origin)
    if(key&&!origins.has(key)){target=document.querySelector(origin);origins.set(key,target)}
    const fallback=document.querySelector('[data-decision-primary-nav]')||document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')
    return {target:describe(target),fallback:{...describe(fallback),logical:true},targetFocused:document.activeElement===target,fallbackFocused:document.activeElement===fallback,active:{tag:document.activeElement?.tagName??null,id:document.activeElement?.id??null,class:typeof document.activeElement?.className==='string'?document.activeElement.className.slice(0,160):''}}
  })()`).then(async focus => ({ ...focus, control: controlId ? await decisionControl(controlId) : null }))
}

async function auditSelectorLayout(name, { scale = 1, scrollable = false, longStatus = null } = {}) {
  const panel = '#weir-da-selector-panel'
  const body = '.weir-da-selector-body'
  const native = await measureNativeModal(panel)
  const viewport = await instance.cdp.measureViewport({ dialog: panel, header: '.weir-da-selector-header', body, footer: '.weir-da-selector-footer' })
  const read = () => instance.cdp.evaluate(`(() => {
    const panel=document.querySelector('#weir-da-selector-panel')
    const body=document.querySelector('.weir-da-selector-body')
    const rect=el=>{const value=el.getBoundingClientRect();return {x:value.x,y:value.y,left:value.left,top:value.top,width:value.width,height:value.height,right:value.right,bottom:value.bottom}}
    return {panelOverflow:getComputedStyle(panel).overflow,bodyOverflow:getComputedStyle(body).overflowY,bodyOverscroll:getComputedStyle(body).overscrollBehavior,bodyScrollHeight:body.scrollHeight,bodyClientHeight:body.clientHeight,bodyScrollTop:body.scrollTop,header:rect(document.querySelector('.weir-da-selector-header')),footer:rect(document.querySelector('.weir-da-selector-footer')),horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1}
  })()`)
  const before = await read()
  const point = await instance.cdp.evaluate(`(() => {const rect=document.querySelector('.weir-da-selector-body').getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+Math.min(rect.height/2,80)}})()`)
  await instance.cdp.request('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 180 })
  if (scrollable) await waitFor(() => instance.cdp.evaluate(`document.querySelector('.weir-da-selector-body').scrollTop>${before.bodyScrollTop}`), 10_000).catch(() => {})
  else await new Promise(resolve => setTimeout(resolve, 120))
  const after = await read()
  let longStatusEvidence = null
  if (longStatus) {
    const primaryActionFocus = await keyboardFocus(`Reach ${name} primary action with keyboard`, '#weir-da-selector-panel [role="alert"] button')
    longStatusEvidence = await instance.cdp.evaluate(`(() => {
      const status=document.querySelector('#weir-da-selector-panel [role="alert"]')
      const action=status?.querySelector('button')??null
      const style=status?getComputedStyle(status):null
      const rect=status?.getBoundingClientRect()
      const actionRect=action?.getBoundingClientRect()
      const bodyRect=document.querySelector('.weir-da-selector-body')?.getBoundingClientRect()
      const visual=visualViewport??{width:innerWidth,height:innerHeight,offsetLeft:0,offsetTop:0}
      const x=actionRect?actionRect.left+actionRect.width/2:null
      const y=actionRect?actionRect.top+actionRect.height/2:null
      const hitTest=Boolean(action&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&document.elementsFromPoint(x,y).includes(action))
      const visible=Boolean(action&&action.getClientRects().length&&actionRect.left>=visual.offsetLeft-1&&actionRect.right<=visual.offsetLeft+visual.width+1&&actionRect.top>=Math.max(visual.offsetTop,bodyRect?.top??0)-1&&actionRect.bottom<=Math.min(visual.offsetTop+visual.height,bodyRect?.bottom??visual.height)+1)
      return {expected:${JSON.stringify(longStatus.text)},actual:status?.querySelector('span')?.textContent??null,role:status?.getAttribute('role')??null,whiteSpace:style?.whiteSpace??null,overflowWrap:style?.overflowWrap??null,clientWidth:status?.clientWidth??null,scrollWidth:status?.scrollWidth??null,rectHeight:rect?.height??null,lineHeight:Number.parseFloat(style?.lineHeight??''),primaryAction:{accessibleName:action?.getAttribute('aria-label')||action?.innerText||null,visible,hitTest,rect:actionRect?{left:actionRect.left,top:actionRect.top,right:actionRect.right,bottom:actionRect.bottom}:null}}
    })()`)
    longStatusEvidence.primaryAction.keyboard = { reached: primaryActionFocus.reached, action: primaryActionFocus.action, activeElement: primaryActionFocus.activeElement }
    longStatusEvidence.ax = await instance.cdp.accessibility('#weir-da-selector-panel [role="alert"]')
  }
  const evidence = { name, native, viewport, panelOverflow: before.panelOverflow, bodyOverflow: before.bodyOverflow, bodyOverscroll: before.bodyOverscroll, bodyScrollHeight: before.bodyScrollHeight, bodyClientHeight: before.bodyClientHeight, bodyScrollTopBefore: before.bodyScrollTop, bodyScrollTopAfter: after.bodyScrollTop, headerBefore: before.header, headerAfter: after.header, footerBefore: before.footer, footerAfter: after.footer, horizontalOverflow: after.horizontalOverflow, longStatus: longStatusEvidence }
  evidence.problems = selectorLayoutProblems(evidence, { scale, scrollable, longStatus })
  uiuxEvidence.selectorLayouts.push(evidence)
  saveUiuxEvidence()
  await shot(`uiux-${name}`, { kind: longStatus ? 'selector-long-status' : 'selector-layout', scale, scrollable, viewport, native, longStatus: longStatusEvidence, problems: evidence.problems })
  check(`selectorLayout:${name}`, evidence.problems.length === 0, { problems: evidence.problems, viewport, longStatus: longStatusEvidence, body: { before: before.bodyScrollTop, after: after.bodyScrollTop, scrollHeight: before.bodyScrollHeight, clientHeight: before.bodyClientHeight } })
  return evidence
}

/**
 * Sample the Decision page scroller on every frame around a confirmed mutation.
 * It records the page height, the live `overflow-anchor` value and whether the
 * stamped audit node survived, so a post-mutation jump can be attributed to the
 * real cause instead of being guessed.
 */
async function startScrollTimeline(kind) {
  return instance.cdp.evaluate(`(() => {
    const samples = []
    const started = performance.now()
    window.__weirUiuxScrollSamples = samples
    const tick = () => {
      const el = document.querySelector('main.weir-da-page')
      samples.push({
        t: Math.round(performance.now() - started),
        top: el ? Math.round(el.scrollTop * 100) / 100 : null,
        height: el ? el.scrollHeight : null,
        anchor: el ? getComputedStyle(el).overflowAnchor : null,
        stamped: Boolean(el && el.getAttribute('data-weir-uiux-audit') === ${JSON.stringify(kind)}),
      })
      if (performance.now() - started < 4000) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return true
  })()`)
}

async function readScrollTimeline() {
  return instance.cdp.evaluate('window.__weirUiuxScrollSamples ?? []')
}

async function beginModalAudit(kind, selector, originSelector, options = {}) {
  const before = options.before
  requireEvidence(before?.root && before?.body, `${kind} has root and body scroll measurements captured after native focus and before activation`)
  let selectorLayout = null
  if (options.selector) selectorLayout = await auditSelectorLayout(kind, options.selector)
  const native = await measureNativeModal(selector, originSelector)
  const sessionIdentity = await measureSessionScrollerIdentity(originSelector)
  requireEvidence(native, `${kind} native dialog exists`)
  // Best effort: a selector or composer modal can open with no Decision page on
  // screen, so a missing page is recorded, never fatal.
  await instance.cdp.evaluate(`(() => { const page=document.querySelector('main.weir-da-page'); if(!page) return false; page.setAttribute('data-weir-uiux-audit', ${JSON.stringify(kind)}); return true })()`).catch(() => false)
  const point = await instance.cdp.evaluate(`(() => {const origin=document.querySelector(${JSON.stringify(originSelector)});const visual=visualViewport??{width:innerWidth,height:innerHeight,offsetLeft:0,offsetTop:0};const rect=origin?.getBoundingClientRect();return {x:Math.max(visual.offsetLeft+4,Math.min(visual.offsetLeft+visual.width-4,rect?rect.left+rect.width/2:visual.offsetLeft+visual.width/2)),y:Math.max(visual.offsetTop+4,Math.min(visual.offsetTop+visual.height-4,rect?rect.top+rect.height/2:visual.offsetTop+visual.height/2))}})()`)
  const attempts = []
  await instance.cdp.request('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 240 })
  attempts.push({ type: 'wheel', observed: true, point, deltaY: 240 })
  await instance.cdp.request('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] })
  await instance.cdp.request('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: Math.max(4, point.y - 80) }] })
  await instance.cdp.request('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  attempts.push({ type: 'touch', observed: true, point, deltaY: -80 })
  await instance.cdp.key('PageDown')
  attempts.push({ type: 'PageDown', observed: true })
  const during = await measureScrollContainers({}, originSelector)
  const audit = { kind, selector, originSelector, before, during, after: null, native, sessionIdentity, selectorLayout, attempts, problems: [] }
  uiuxEvidence.modalAudits.push(audit)
  saveUiuxEvidence()
  await shot(`uiux-${kind}-modal`, { kind: 'native-product-modal', native, scroll: { before, during }, attempts })
  return audit
}

async function finishModalAudit(audit, { focus = null, focusProblems = [], contentMutation = null } = {}) {
  audit.contentMutation = contentMutation
  audit.after = await measureScrollContainers({}, audit.originSelector)
  const timeline = await readScrollTimeline().catch(() => [])
  audit.scrollTimeline = timeline
  audit.stampSurvived = await instance.cdp.evaluate(`(() => { const page=document.querySelector('main.weir-da-page'); return Boolean(page && page.getAttribute('data-weir-uiux-audit') === ${JSON.stringify(audit.kind)}) })()`).catch(() => null)
  audit.scrollTrace = timeline.filter((sample, index) => index === 0 || index === timeline.length - 1 || sample.top !== timeline[index - 1]?.top || sample.height !== timeline[index - 1]?.height || sample.anchor !== timeline[index - 1]?.anchor).slice(0, 60)
  const nativeProblems = nativeModalProblems(audit.native, { requireComposer: Boolean(audit.selectorLayout) })
  audit.problems = [...nativeProblems, ...scrollLockProblems(audit, Object.keys(audit.before), ['wheel', 'touch', 'PageDown']), ...sessionScrollerProblems(audit), ...focusProblems]
  if (focus) audit.focus = focus
  saveUiuxEvidence()
  await instance.cdp.evaluate(`(() => {for(const el of document.querySelectorAll('[data-weir-uiux-scroll]'))el.removeAttribute('data-weir-uiux-scroll');return true})()`)
  check(`uiuxModal:${audit.kind}`, audit.problems.length === 0, { problems: audit.problems, containers: Object.keys(audit.before), sessionIdentity: audit.sessionIdentity, focus: focus ?? null, stampSurvived: audit.stampSurvived, scrollTrace: audit.scrollTrace })
  return audit
}

async function runUiuxCapabilityPreflight() {
  const evidence = { scope: 'Baseline browser capability preflight only; tasks 5.2–5.3 product acceptance not run', fixture: createUiuxFixture(), zoom: [] }
  const save = () => writeJson(join(out, 'uiux-preflight.json'), evidence)
  save()
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  await newIsolatedSession('uiux-preflight', workspace)
  await instance.cdp.setViewport(360, 900, false)
  await waitFor(() => instance.cdp.evaluate('innerWidth===360&&innerHeight===900'), 10_000)
  const fixtureJson = JSON.stringify(evidence.fixture)
  evidence.setup = await instance.cdp.evaluate(`(() => {
    const fixture=${fixtureJson}
    const origin=document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')
    if(!origin)throw new Error('UIUX preflight requires the real composer Decision trigger')
    origin.focus()
    const composer=origin.parentElement
    const background=document.createElement('div')
    background.id='weir-uiux-background-scroll';background.style.height='72px';background.style.width='180px';background.style.overflow='auto'
    const nested=document.createElement('div')
    nested.id='weir-uiux-nested-scroll';nested.style.height='48px';nested.style.overflow='auto';nested.textContent=fixture.coldContent.zh.join('\\n')
    const filler=document.createElement('div');filler.style.height='240px';filler.textContent='背景与嵌套滚动容器 / background and nested scroll containers'
    background.append(nested,filler);composer.appendChild(background)
    const reference=document.createElement('div')
    reference.id='weir-uiux-zoom-reference';reference.textContent='200%';reference.style.width='64px';reference.style.height='32px';reference.style.margin='0';reference.setAttribute('aria-hidden','true')
    document.body.prepend(reference)
    const dialog=document.createElement('dialog')
    dialog.id='weir-uiux-native-preflight';dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','原生模态预检 / Native modal preflight')
    dialog.style.width='min(320px, calc(100vw - 32px))';dialog.style.maxHeight='calc(100dvh - 32px)';dialog.style.overflow='hidden'
    const header=document.createElement('header')
    const title=document.createElement('h2');title.textContent=fixture.agents[0].name.zh+' / '+fixture.agents[0].name.en
    const status=document.createElement('p');status.id='weir-uiux-long-status';status.textContent=fixture.agents[0].status.zh+' '+fixture.agents[0].status.en
    const dynamic=document.createElement('div');dynamic.id='weir-uiux-dynamic-viewport';dynamic.style.height='20dvh';dynamic.style.visibility='hidden'
    header.append(title,status,dynamic)
    const input=document.createElement('input');input.id='weir-uiux-keyboard-input';input.autofocus=true;input.setAttribute('aria-label','键盘输入 / Keyboard input')
    const scroller=document.createElement('div');scroller.id='weir-uiux-dialog-scroll';scroller.tabIndex=0;scroller.style.height='96px';scroller.style.overflow='auto';scroller.style.overscrollBehavior='contain'
    for(const text of [...fixture.coldContent.zh,...fixture.coldContent.en]){const paragraph=document.createElement('p');paragraph.textContent=text;scroller.appendChild(paragraph)}
    const footer=document.createElement('footer');const close=document.createElement('button');close.type='button';close.textContent='关闭 / Close';close.addEventListener('click',()=>dialog.close('button'));footer.appendChild(close)
    dialog.append(header,input,scroller,footer);composer.appendChild(dialog)
    dialog.__uiuxShowModalCalls=0;dialog.__uiuxShowModalError=null;dialog.__uiuxEvents=[]
    for(const type of ['cancel','close','input','keydown'])dialog.addEventListener(type,event=>dialog.__uiuxEvents.push({type,key:event.key??null,inputType:event.inputType??null,isTrusted:event.isTrusted}))
    try{dialog.__uiuxShowModalCalls+=1;dialog.showModal();dialog.__uiuxShowModalError=null}catch(error){dialog.__uiuxShowModalError=error?.message??String(error);throw error}
    if(!dialog.matches(':modal'))throw new Error('Native showModal did not produce :modal top-layer state')
    return {dialogId:dialog.id,modal:dialog.matches(':modal'),title:title.textContent,status:status.textContent,scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight}
  })()`)
  save()
  check('uiuxBilingualLongStatusFixture', evidence.setup.status.includes(evidence.fixture.agents[0].status.zh) && evidence.setup.status.includes(evidence.fixture.agents[0].status.en) && evidence.setup.scrollHeight > evidence.setup.clientHeight, evidence.setup)
  await waitFor(() => instance.cdp.evaluate("document.activeElement?.id==='weir-uiux-keyboard-input'"), 10_000)
  evidence.native = await measureNativeModal('#weir-uiux-native-preflight')
  const nativeProblems = nativeModalProblems(evidence.native)
  check('nativeDialogShowModalTopLayerInComposer', nativeProblems.length === 0, { problems: nativeProblems, native: evidence.native })
  save()
  const typed = '键盘输入 / native keyboard input'
  await instance.cdp.request('Input.insertText', { text: typed })
  await waitFor(() => instance.cdp.evaluate(`document.querySelector('#weir-uiux-keyboard-input')?.value===${JSON.stringify(typed)}`), 10_000)
  await instance.cdp.key('Tab')
  await waitFor(() => instance.cdp.evaluate("document.activeElement?.id==='weir-uiux-dialog-scroll'"), 10_000)
  const scrollSelectors = { root: 'html', body: 'body', composer: '#weir-uiux-background-scroll', session: '#weir-uiux-dialog-scroll', nested: '#weir-uiux-nested-scroll' }
  const scrollBefore = await measureScrollContainers(scrollSelectors, '#weir-uiux-background-scroll')
  await instance.cdp.key('PageDown')
  await waitFor(() => instance.cdp.evaluate("document.querySelector('#weir-uiux-dialog-scroll')?.scrollTop>0"), 10_000)
  const scrollAfter = await measureScrollContainers(scrollSelectors, '#weir-uiux-background-scroll')
  evidence.scrollContainers = { before: scrollBefore, after: scrollAfter, note: 'Capability measurement only; baseline native dialog is not expected to implement the future product scroll lock' }
  check('rootAndNestedScrollerPreflight', ['root','body','composer','session','nested'].every(name => scrollBefore[name] && scrollAfter[name]) && scrollAfter.session.scrollTop > scrollBefore.session.scrollTop, { before: Object.keys(scrollBefore), after: Object.keys(scrollAfter), sessionTop: [scrollBefore.session?.scrollTop,scrollAfter.session?.scrollTop] })
  const dynamicBefore = await instance.cdp.measureViewport({ dialog: '#weir-uiux-native-preflight', dynamic: '#weir-uiux-dynamic-viewport' })
  await instance.cdp.setViewport(360, 640, false)
  await waitFor(() => instance.cdp.evaluate('innerWidth===360&&innerHeight===640'), 10_000)
  const dynamicAfter = await instance.cdp.measureViewport({ dialog: '#weir-uiux-native-preflight', dynamic: '#weir-uiux-dynamic-viewport' })
  const expectedDelta = (dynamicAfter.innerHeight - dynamicBefore.innerHeight) * 0.2
  const actualDelta = dynamicAfter.rects.dynamic.height - dynamicBefore.rects.dynamic.height
  const dynamicProblems = [...viewportMeasurementProblems(dynamicBefore, { innerWidth: 360, scale: 1 }), ...viewportMeasurementProblems(dynamicAfter, { innerWidth: 360, scale: 1 })]
  evidence.dynamicViewport = { before: dynamicBefore, after: dynamicAfter, expectedDelta, actualDelta, problems: dynamicProblems }
  save()
  check('dynamicViewportUnitsTrackRealViewport', dynamicProblems.length === 0 && Math.abs(actualDelta - expectedDelta) <= 1.5 && (await measureNativeModal('#weir-uiux-native-preflight'))?.modal === true, evidence.dynamicViewport)
  evidence.keyboard = await instance.cdp.evaluate(`(() => {const dialog=document.querySelector('#weir-uiux-native-preflight');return {events:dialog.__uiuxEvents,activeElement:document.activeElement?.id??null,inputValue:document.querySelector('#weir-uiux-keyboard-input').value}})()`)
  save()
  check('nativeKeyboardInputTabAndPageDown', evidence.keyboard.inputValue === typed && evidence.keyboard.events.some(event => event.type === 'input' && event.isTrusted) && evidence.keyboard.events.some(event => event.type === 'keydown' && event.key === 'Tab' && event.isTrusted) && evidence.keyboard.events.some(event => event.type === 'keydown' && event.key === 'PageDown' && event.isTrusted), evidence.keyboard)
  await shot('uiux-native-dialog', { kind: 'native-dialog-preflight', native: evidence.native, viewport: dynamicAfter })
  save()
  await instance.cdp.key('Escape')
  await waitFor(() => instance.cdp.evaluate(`(() => {const dialog=document.querySelector('#weir-uiux-native-preflight');return dialog&&!dialog.open&&document.activeElement===document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')&&dialog.__uiuxEvents.some(event=>event.type==='cancel'&&event.isTrusted)})()`), 10_000)
  evidence.keyboard.close = await instance.cdp.evaluate(`(() => {const dialog=document.querySelector('#weir-uiux-native-preflight');return {open:dialog.open,activeElement:document.activeElement?.getAttribute('data-weir-decision-trigger')??null,events:dialog.__uiuxEvents}})()`)
  check('nativeEscapeClosesAndReturnsFocus', evidence.keyboard.close.open === false && evidence.keyboard.close.activeElement === 'weir-decision-selector', evidence.keyboard.close)
  save()
  for (const width of evidence.fixture.viewports) {
    await instance.cdp.setPageZoom(1)
    const metricsOperation = await instance.cdp.setViewport(width, 900, true)
    await waitFor(() => instance.cdp.evaluate(`innerWidth===${width}&&innerHeight===900`), 10_000)
    const before = await instance.cdp.measureViewport({ reference: '#weir-uiux-zoom-reference', root: 'html' })
    const operation = await instance.cdp.setPageZoom(2)
    const after = await instance.cdp.measureViewport({ reference: '#weir-uiux-zoom-reference', root: 'html' })
    const row = { width, metricsOperation, operation, before, after, devicePixelRatio: after.devicePixelRatio }
    const problems = [...browserZoomProblems(row, 2), ...viewportMeasurementProblems(after, { innerWidth: width, scale: 2, withinVisualViewport: ['reference'] })]
    row.problems = problems
    evidence.zoom.push(row)
    save()
    check(`realBrowserZoom200At${width}`, problems.length === 0, { problems, innerWidth: after.innerWidth, devicePixelRatio: after.devicePixelRatio, visualViewport: after.visualViewport, referenceRect: after.rects.reference })
    await shot(`uiux-zoom200-${width}`, { kind: 'real-browser-zoom', ...row })
  }
  await instance.cdp.setPageZoom(1)
  await instance.cdp.setViewport(1440, 900, false)
  evidence.domProbeRemoved = await instance.cdp.evaluate(`(() => {for(const id of ['weir-uiux-native-preflight','weir-uiux-background-scroll','weir-uiux-zoom-reference'])document.getElementById(id)?.remove();return !document.querySelector('#weir-uiux-native-preflight,#weir-uiux-background-scroll,#weir-uiux-zoom-reference')})()`)
  check('uiuxPreflightFixtureRemoved', evidence.domProbeRemoved === true)
  save()
  return evidence
}

async function runStartupPreflight() {
  const phase = 'GUI-decision-uiux-1.2-5.1-preflight'
  try {
    check('portInitiallyFree', await portFree() && !portListeners())
    writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'running', scope: '1.2-5.1-preflight' })
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
    await runUiuxCapabilityPreflight()
    await stopOwned('preflight')
    const exceptions = runtimeEvents.filter(item => item.event.method === 'Runtime.exceptionThrown')
    const consoleErrors = runtimeEvents.filter(item => item.event.method === 'Runtime.consoleAPICalled' && item.event.params?.type === 'error')
    const slotCrashes = runtimeEvents.filter(item => /slot entry crashed|Slot.*crash/i.test(JSON.stringify(item.event)))
    const logErrors = runtimeEvents.filter(item => item.event.method === 'Log.entryAdded' && item.event.params?.entry?.level === 'error')
    const desktopLog = readFileSync(join(out, 'desktop-enabled.log'), 'utf8')
    const importFailures = desktopLog.split('\n').filter(line => /failed to import weir-harness|SessionFormatUnsupportedError|slot entry crashed/i.test(line))
    writeJson(join(out, 'runtime-scan.json'), { exceptionCount: exceptions.length, exceptions, consoleErrorCount: consoleErrors.length, consoleErrors, slotCrashCount: slotCrashes.length, slotCrashes, logErrorCount: logErrors.length, logErrors, importFailures, scannedLogs: ['desktop-enabled.log'] })
    check('noRuntimeExceptionsConsoleErrorsOrSlotCrashes', exceptions.length === 0 && consoleErrors.length === 0 && slotCrashes.length === 0 && logErrors.length === 0 && importFailures.length === 0, { exceptions: exceptions.length, consoleErrors: consoleErrors.length, slotCrashes: slotCrashes.length, logErrors: logErrors.length, importFailures })
    result = {
      phase, verdict: 'PASS', pass: true, scope: 'Tasks 1.2 and driver-only 5.1 browser preflight; tasks 5.2–5.3 product acceptance were not run',
      runId, root, out, port: PORT, checks, checkDetails,
      cleanupReceipts: cleanups.map(item => join(out, `${item.label}-exact-pid-cleanup.json`)),
      artifacts: { host: join(out, 'host.json'), instance: join(out, 'instance.json'), preflight: join(out, 'preflight.json'), config: join(out, 'decision-config-preflight.json'), slots: join(out, 'slots.json'), uiux: join(out, 'uiux-preflight.json'), screenshots: join(out, 'screenshots.json'), runtime: join(out, 'runtime-scan.json'), cleanup: join(out, 'preflight-exact-pid-cleanup.json'), screenshot: join(out, 'preflight-isolated-desktop.png') },
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
      result = { phase, verdict: 'BLOCKED', pass: false, scope: 'Tasks 1.2 and driver-only 5.1 browser preflight; tasks 5.2–5.3 product acceptance were not run', runId, root, out, port: PORT, checks, checkDetails, error: failure?.message ?? String(failure), cleanup: cleanups }
      writeJson(join(out, 'result.json'), result)
      writeJson(join(GUI, 'result.json'), result)
      writeJson(join(out, 'driver-error.json'), { message: failure?.message ?? String(failure), stack: failure?.stack ?? null, checks, checkDetails, cleanups })
    }
    writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: failure ? 'blocked' : 'passed', scope: '1.2-5.1-preflight', result: join(out, 'result.json') })
  }
}

async function runSelectorFailureMatrix(sessionId, primary, secondary) {
  const trigger = '[data-weir-decision-trigger="weir-decision-selector"]'
  await openIsolatedSession(sessionId, true)
  await instance.cdp.setViewport(360, 420, false)
  await waitFor(() => instance.cdp.evaluate('innerWidth===360&&innerHeight===420'), 10_000)
  await instance.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const manyBefore = (await selectorOpen({ scrollBaseline: 'immediate' })).scrollBefore
  const manyText = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  const manyCopyProblems = selectorCopyProblems(manyText, { language: 'zh', emptyScope: true, shadow: false })
  const manyCount = await instance.cdp.evaluate(`document.querySelectorAll('#weir-da-selector-panel input[type="radio"]').length`)
  check('selectorManyLongNamesUseOrdinaryCopy', manyCount === 4 && manyCopyProblems.length === 0 && manyText.includes(primary.name) && manyText.includes(secondary.name), { manyCount, problems: manyCopyProblems, text: manyText })
  const manyModal = await beginModalAudit('selector-many-compact-height', '#weir-da-selector-panel', trigger, { before: manyBefore, selector: { scale: 1, scrollable: true } })
  await keyboardKey('Close measured many-option selector', 'Escape')
  await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel')&&document.activeElement===document.querySelector(${JSON.stringify(trigger)})`), 30_000)
  await finishModalAudit(manyModal)

  const otherSession = (await newIsolatedSession('uiux-selector-load-other')).sessionId
  const loadControl = await instance.cdp.evaluate(`window.__decisionQA.controlDecision(${JSON.stringify({ method: 'overview', args: { sessionId }, action: 'fail' })})`)
  await openIsolatedSession(sessionId, true)
  await instance.cdp.setViewport(360, 320, false)
  await waitFor(() => instance.cdp.evaluate('innerWidth===360&&innerHeight===320'), 10_000)
  const loadBefore = (await selectorOpen({ scrollBaseline: 'immediate' })).scrollBefore
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('#weir-da-selector-panel [role="alert"]'))`), 30_000)
  const loadText = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  const loadState = { kind: 'load-failure', control: await decisionControl(loadControl), text: loadText, ax: await instance.cdp.accessibility('#weir-da-selector-panel') }
  uiuxEvidence.selectorStates.push(loadState)
  saveUiuxEvidence()
  await shot('uiux-selector-load-failure', { kind: 'selector-load-failure', controlId: loadControl })
  const loadModal = await beginModalAudit('selector-load-failure-long', '#weir-da-selector-panel', trigger, { before: loadBefore, selector: { scale: 1, scrollable: true, longStatus: { text: uiuxFixture.agents[0].status.zh, language: 'zh' } } })
  check('selectorLoadFailureIsVisibleAndRetryable', loadState.control.used && loadText.includes(uiuxFixture.agents[0].status.zh) && /重试|Retry/i.test(loadText), { control: loadState.control, text: loadText, exactLongStatus: uiuxFixture.agents[0].status.zh })
  await keyboardKey('Close long selector load failure', 'Escape')
  await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel')&&document.activeElement===document.querySelector(${JSON.stringify(trigger)})`), 30_000)
  await finishModalAudit(loadModal)

  const unknownControl = await instance.cdp.evaluate(`window.__decisionQA.controlDecision(${JSON.stringify({ method: 'overview', args: { sessionId }, action: 'unknown-auto' })})`)
  await selectorOpen()
  await keyboardActivate('Retry selector read with unknown status', 'button', { scope: '#weir-da-selector-panel', labels: ['重试', 'Retry'] })
  await waitFor(() => instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel')?.innerText.includes('自动回答状态未知')`), 30_000)
  const unknownText = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  const unknownProblems = selectorCopyProblems(unknownText, { language: 'zh', unknown: true })
  const unknownState = { kind: 'unknown', control: await decisionControl(unknownControl), text: unknownText, problems: unknownProblems, ax: await instance.cdp.accessibility('#weir-da-selector-panel') }
  uiuxEvidence.selectorStates.push(unknownState)
  saveUiuxEvidence()
  await shot('uiux-selector-unknown', { kind: 'selector-unknown', controlId: unknownControl, problems: unknownProblems })
  check('selectorUnknownStateUsesOrdinaryCopy', unknownProblems.length === 0, { text: unknownText, problems: unknownProblems })
  await keyboardKey('Close unknown selector state', 'Escape')
  await openIsolatedSession(otherSession, true)
  await openIsolatedSession(sessionId, true)

  const saveBefore = (await selectorOpen({ scrollBaseline: 'immediate' })).scrollBefore
  const saveControl = await instance.cdp.evaluate(`window.__decisionQA.controlDecision(${JSON.stringify({ method: 'setSelector', args: { sessionId, mode: 'agent', agentId: primary.agentId }, action: 'fail' })})`)
  await keyboardFocus('Current automatic selection before failed save', '#weir-da-selector-panel [role="radiogroup"] input[type="radio"]:checked')
  await keyboardKey('Attempt assistant selection with injected save failure', 'ArrowDown', { target: primary.agentId })
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('#weir-da-selector-panel [role="alert"]'))`), 30_000)
  const failedAuthority = await rpc(sessionId, 'selector-save-failure', 'overview')
  const saveText = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  const saveState = { kind: 'save-failure', control: await decisionControl(saveControl), text: saveText, authority: failedAuthority.selector, ax: await instance.cdp.accessibility('#weir-da-selector-panel') }
  uiuxEvidence.selectorStates.push(saveState)
  saveUiuxEvidence()
  await shot('uiux-selector-save-failure', { kind: 'selector-save-failure', controlId: saveControl })
  const saveModal = await beginModalAudit('selector-save-failure-long', '#weir-da-selector-panel', trigger, { before: saveBefore, selector: { scale: 1, scrollable: true, longStatus: { text: uiuxFixture.agents[0].status.zh, language: 'zh' } } })
  check('selectorSaveFailurePreservesAuthorityAndAllowsRetry', saveState.control.used && selectorMatches(failedAuthority.selector, 'auto') && saveText.includes(uiuxFixture.agents[0].status.zh) && /重试|Retry/i.test(saveText), { control: saveState.control, authority: failedAuthority.selector, text: saveText, exactLongStatus: uiuxFixture.agents[0].status.zh })
  await keyboardKey('Close failed selector save before real retry', 'Escape')
  await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel')&&document.activeElement===document.querySelector(${JSON.stringify(trigger)})`), 30_000)
  await finishModalAudit(saveModal)
  const retryControl = await holdDecision('setSelector', { sessionId, mode: 'agent', agentId: primary.agentId })
  await selectorOpen()
  await keyboardFocus('Current automatic selection before held retry', '#weir-da-selector-panel [role="radiogroup"] input[type="radio"]:checked')
  await keyboardKey('Retry assistant selection with controlled settlement', 'ArrowDown', { target: primary.agentId })
  await waitFor(async () => (await decisionControl(retryControl)).started, 30_000)
  const pending = await instance.cdp.evaluate(`(() => {const panel=document.querySelector('#weir-da-selector-panel');const status=panel?.querySelector('[role="status"][aria-live="polite"]');return {modal:panel?.matches(':modal'),busy:panel?.getAttribute('aria-busy'),status:status?.textContent??'',open:Boolean(panel)}})()`)
  const pendingAx = await instance.cdp.accessibility('#weir-da-selector-panel')
  await shot('uiux-selector-save-pending-live-status', { kind: 'selector-pending', pending })
  await keyboardKey('Pending selector must not close on Escape', 'Escape')
  const pendingAfterEscape = await instance.cdp.evaluate(`Boolean(document.querySelector('#weir-da-selector-panel')?.matches(':modal'))`)
  uiuxEvidence.selectorStates.push({ kind: 'save-pending', control: await decisionControl(retryControl), pending, pendingAfterEscape, ax: pendingAx })
  saveUiuxEvidence()
  check('selectorPendingHasLiveStatusAndCannotEscape', pending.modal && pending.busy === 'true' && /保存中|Saving/i.test(pending.status) && pendingAfterEscape, { pending, pendingAfterEscape })
  await releaseDecision(retryControl)
  await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel')&&document.activeElement===document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')`), 30_000)
  const retried = await rpc(sessionId, 'selector-save-retry', 'overview')
  requireEvidence(selectorMatches(retried.selector, 'agent', primary.agentId), 'held selector retry returns the exact authoritative assistant')
  await expectMutation('setSelector', selectorEnvelope(sessionId, 'agent', primary.agentId))
  await instance.cdp.setViewport(1440, 900, false)
}

async function authorityReadCount() {
  await collectNetwork()
  return networkRpc.filter(entry => ['agent', 'agents', 'learningRun', 'memorySnapshot'].includes(entry.method)).length
}

async function measureAgentStage(selectedAgentId = null, learning = {}, focusSelector) {
  requireEvidence(typeof focusSelector === 'string' && focusSelector, 'every assistant stage names its intended activeElement')
  const focus = await waitFor(async () => { const value = await measureFocus(focusSelector); return value.active && value.connected && value.visible ? value : null }, 10_000).catch(() => measureFocus(focusSelector))
  const measurement = await measureMasterDetail({ list: '.weir-da-agent-list', detail: '[data-agent-detail],form[data-agent-editor]' })
  const dom = await instance.cdp.evaluate(`(() => {
    const form=document.querySelector('form[data-agent-editor]')
    const detail=document.querySelector('[data-agent-detail]')
    const run=${JSON.stringify(learning.run ?? null)}
    const snapshot=${JSON.stringify(learning.snapshot ?? null)}
    const runDetail=run?document.querySelector('[data-learning-run-detail="'+run+'"]'):null
    const diagnostics=runDetail?.textContent??''
    return {draft:form?Object.fromEntries([...form.querySelectorAll('[data-agent-field]')].map(el=>[el.getAttribute('data-agent-field'),el.value])):{},detailAgentId:detail?.getAttribute('data-agent-detail')??null,formMode:form?.getAttribute('data-agent-editor')??null,learning:{run:runDetail?.getAttribute('data-learning-run-detail')??null,snapshot:run&&snapshot&&diagnostics.includes(snapshot)?snapshot:null}}
  })()`)
  return { ...measurement, selectedAgentId: dom.detailAgentId ?? (dom.formMode === 'create' ? null : selectedAgentId), draft: dom.draft, learning: learning.run ? dom.learning : {}, focus, readCount: await authorityReadCount() }
}

async function confirmDiscardEditor(sessionId, targetAgentId, originSelector, scrollBefore) {
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-discard-editor"))'), 30_000)
  const audit = await beginModalAudit(`discard-editor-to-${targetAgentId}`, '#weir-da-discard-editor', originSelector, { before: scrollBefore })
  const controlId = await holdDecision('agent', { sessionId, agentId: targetAgentId })
  await keyboardActivate('Confirm discard editor and change target', '#weir-da-discard-editor .weir-da-actions button:last-child')
  await waitFor(async () => (await decisionControl(controlId)).started, 30_000)
  const beforeFocus = await measureConfirmationFocus(originSelector, controlId)
  await releaseDecision(controlId)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-agent-detail=${JSON.stringify(targetAgentId)}]'))`), 30_000)
  const afterFocus = await waitFor(async () => { const focus = await measureConfirmationFocus(originSelector, controlId); return focus.control.settled && (focus.targetFocused || focus.fallbackFocused) ? focus : null }, 30_000).catch(() => measureConfirmationFocus(originSelector, controlId))
  const focus = { beforeSettle: { ...beforeFocus, promiseSettled: beforeFocus.control.settled }, afterSettle: { ...afterFocus, promiseSettled: afterFocus.control.settled } }
  const focusProblems = confirmationFocusProblems(focus)
  uiuxEvidence.confirmations.push({ kind: 'discard-editor', targetAgentId, controlId, focus, problems: focusProblems })
  await finishModalAudit(audit, { focus, focusProblems })
}

async function runAgentResumeMatrix(sessionId, primary, secondary) {
  await openAgent(sessionId, primary.agentId)
  await instance.cdp.setViewport(1440, 900, false)
  const desktop = await measureAgentStage(primary.agentId, {}, `[data-agent-detail="${primary.agentId}"]`)
  await shot('uiux-assistant-desktop-master-detail', { kind: 'master-detail', measurement: desktop })
  await instance.cdp.setViewport(360, 900, false)
  await keyboardActivate('Back to narrow assistant list', '.weir-da-agent-back', { expectFocus: `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]` })
  const narrowList = await measureAgentStage(primary.agentId, {}, `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]`)

  await keyboardActivate('Open narrow create draft', '[data-action="create-agent"]', { expectFocus: '[data-agent-field="name"]' })
  const createDraft = { name: '未保存创建草稿 · Exact create draft with a long bilingual name', preference: '保留这个创建草稿的每一个字符； Back → same create must not reread or confirm.' }
  await keyboardFill('Enter exact create draft name', '[data-agent-field="name"]', createDraft.name)
  await keyboardFill('Enter exact create draft preference', '[data-agent-field="preference"]', createDraft.preference)
  const createDrill = await measureAgentStage(null, {}, '[data-agent-field="preference"]')
  await shot('uiux-create-draft-drill-in', { kind: 'master-detail', measurement: createDrill })
  await keyboardActivate('Back with preserved create draft', '.weir-da-agent-back', { expectFocus: '[data-action="create-agent"]' })
  const createReturned = await measureAgentStage(null, {}, '[data-action="create-agent"]')
  await keyboardActivate('Resume same create draft', '[data-action="create-agent"]', { expectFocus: '[data-agent-field="name"]' })
  const createRestored = await measureAgentStage(null, {}, '[data-agent-field="name"]')
  const createEvidence = { kind: 'create', desktop, narrowList, drillIn: createDrill, returned: createReturned, restored: createRestored }
  createEvidence.problems = masterDetailProblems(createEvidence)
  uiuxEvidence.masterDetail.push(createEvidence)
  saveUiuxEvidence()
  await shot('uiux-create-draft-restored', { kind: 'master-detail', measurement: createRestored, problems: createEvidence.problems })
  check('narrowCreateBackSameTargetPreservesExactDraftWithoutReread', createEvidence.problems.length === 0, { problems: createEvidence.problems, readCount: [createDrill.readCount, createReturned.readCount, createRestored.readCount] })
  await keyboardActivate('Back before real create target change', '.weir-da-agent-back', { expectFocus: '[data-action="create-agent"]' })
  const createTargetOrigin = `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]`
  const createTargetScrollBefore = (await keyboardActivate('Change from dirty create to assistant', createTargetOrigin, { scrollBaseline: 'immediate' })).scrollBefore
  await confirmDiscardEditor(sessionId, primary.agentId, createTargetOrigin, createTargetScrollBefore)

  await keyboardActivate('Open narrow edit draft', `[data-agent-detail="${primary.agentId}"] [data-action="edit-agent"]`, { expectFocus: '[data-agent-field="name"]' })
  const editDraft = { name: `${primary.name} · 未保存编辑 / exact unsaved edit`, preference: 'Exact edit draft survives Back and same-assistant re-entry without confirmation or authority rereads.' }
  await keyboardFill('Enter exact edit draft name', '[data-agent-field="name"]', editDraft.name)
  await keyboardFill('Enter exact edit draft preference', '[data-agent-field="preference"]', editDraft.preference)
  const editDrill = await measureAgentStage(primary.agentId, {}, '[data-agent-field="preference"]')
  await shot('uiux-edit-draft-drill-in', { kind: 'master-detail', measurement: editDrill })
  await keyboardActivate('Back with preserved edit draft', '.weir-da-agent-back', { expectFocus: `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]` })
  const editReturned = await measureAgentStage(primary.agentId, {}, `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]`)
  const editSameOrigin = `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]`
  await keyboardActivate('Resume same assistant edit draft', editSameOrigin, { expectFocus: '[data-agent-field="name"]' })
  const editRestored = await measureAgentStage(primary.agentId, {}, '[data-agent-field="name"]')
  const editEvidence = { kind: 'edit', desktop, narrowList, drillIn: editDrill, returned: editReturned, restored: editRestored }
  editEvidence.problems = masterDetailProblems(editEvidence)
  uiuxEvidence.masterDetail.push(editEvidence)
  saveUiuxEvidence()
  await shot('uiux-edit-draft-restored', { kind: 'master-detail', measurement: editRestored, problems: editEvidence.problems })
  check('narrowEditBackSameTargetPreservesExactDraftWithoutReread', editEvidence.problems.length === 0, { problems: editEvidence.problems, readCount: [editDrill.readCount, editReturned.readCount, editRestored.readCount] })
  await keyboardActivate('Back before real edit target change', '.weir-da-agent-back', { expectFocus: `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]` })
  const editTargetOrigin = `[data-agent-summary="${secondary.agentId}"] [data-action="open-agent"]`
  const editTargetScrollBefore = (await keyboardActivate('Change from dirty edit to another assistant', editTargetOrigin, { scrollBaseline: 'immediate' })).scrollBefore
  await confirmDiscardEditor(sessionId, secondary.agentId, editTargetOrigin, editTargetScrollBefore)
  await instance.cdp.setViewport(1440, 900, false)
}

async function runLearningResumeMatrix(sessionId, primary, candidate) {
  await openAgent(sessionId, primary.agentId)
  await openDisclosure(`weir-da-learning-advanced-${primary.agentId}`)
  await keyboardActivate('Select exact learning run for narrow resume', `[data-learning-run-id="${candidate.run.learningRunId}"]`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-learning-run-detail=${JSON.stringify(candidate.run.learningRunId)}]'))`), 30_000)
  await keyboardActivate('Select exact learning snapshot for narrow resume', `[data-snapshot-id="${candidate.snapshot.snapshotId}"]`)
  await waitFor(() => instance.cdp.evaluate(`document.querySelector('[data-learning-run-detail=${JSON.stringify(candidate.run.learningRunId)}]')?.textContent.includes(${JSON.stringify(candidate.snapshot.snapshotId)})`), 30_000)
  const learning = { run: candidate.run.learningRunId, snapshot: candidate.snapshot.snapshotId }
  const desktop = await measureAgentStage(primary.agentId, learning, `[data-snapshot-id="${candidate.snapshot.snapshotId}"]`)
  await instance.cdp.setViewport(360, 900, false)
  const drillIn = await measureAgentStage(primary.agentId, learning, `[data-snapshot-id="${candidate.snapshot.snapshotId}"]`)
  await shot('uiux-learning-context-drill-in', { kind: 'learning-resume', measurement: drillIn })
  await keyboardActivate('Back with selected learning context', '.weir-da-agent-back', { expectFocus: `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]` })
  const returned = await measureAgentStage(primary.agentId, learning, `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]`)
  const sameOrigin = `[data-agent-summary="${primary.agentId}"] [data-action="open-agent"]`
  await keyboardActivate('Resume same assistant learning context', sameOrigin, { expectFocus: '.weir-da-agent-back' })
  const restored = await measureAgentStage(primary.agentId, learning, '.weir-da-agent-back')
  const evidence = { kind: 'learning', desktop, narrowList: returned, drillIn, returned, restored }
  evidence.problems = masterDetailProblems(evidence)
  uiuxEvidence.masterDetail.push(evidence)
  saveUiuxEvidence()
  await shot('uiux-learning-context-restored', { kind: 'learning-resume', measurement: restored, problems: evidence.problems })
  check('narrowLearningBackSameTargetPreservesRunSnapshotWithoutReread', evidence.problems.length === 0, { problems: evidence.problems, learning, readCount: [drillIn.readCount, returned.readCount, restored.readCount] })
  await instance.cdp.setViewport(1440, 900, false)
}

async function runColdRevealMatrix(sessionId, caseId) {
  await openPage('inbox')
  const article = `article[data-case-id="${caseId}"]`
  const form = `${article} form.weir-da-answers`
  await waitFor(() => instance.cdp.evaluate(answerFormExpression(caseId)), 30_000)
  const scroller = 'main.weir-da-page'
  const routeTarget = `#weir-da-inbox-routes-${caseId}-content`
  const routeControl = await holdDecision('record', { sessionId, caseId }, 'hold-fail')
  await openDisclosure(`weir-da-inbox-routes-${caseId}`)
  const routeLoading = await measureColdReveal(routeTarget, scroller, { status: 'loading', draftSelector: form })
  await shot('uiux-cold-error-loading', { kind: 'cold-reveal', measurement: routeLoading })
  await releaseDecision(routeControl)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(routeTarget + ' [role="alert"]')}))`), 30_000)
  await instance.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const routeReady = await measureColdReveal(routeTarget, scroller, { status: 'error', draftSelector: form })
  routeReady.ax = await instance.cdp.accessibility(routeTarget)
  await shot('uiux-cold-error-end', { kind: 'cold-reveal', measurement: routeReady })

  const evidenceTarget = `#weir-da-evidence-${caseId}-content`
  const successControl = await holdDecision('record', { sessionId, caseId })
  await openDisclosure(`weir-da-evidence-${caseId}`)
  let evidenceLoading = await measureColdReveal(evidenceTarget, scroller, { status: 'loading', draftSelector: form })
  await keyboardFocus('Retain inbox input focus during cold success', `${form} input[type="radio"],${form} textarea`)
  evidenceLoading = await measureColdReveal(evidenceTarget, scroller, { status: 'loading', draftSelector: form })
  await shot('uiux-cold-success-loading', { kind: 'cold-reveal', measurement: evidenceLoading })
  await releaseDecision(successControl)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(evidenceTarget + ' .weir-da-evidence-list')}))`), 30_000)
  await waitFor(async () => (await measureColdReveal(evidenceTarget, scroller, { status: 'ready', draftSelector: form })).revealCount === 1, 30_000)
  await instance.cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const evidenceReady = await measureColdReveal(evidenceTarget, scroller, { status: 'ready', draftSelector: form })
  evidenceReady.ax = await instance.cdp.accessibility(evidenceTarget)
  await shot('uiux-cold-success-end', { kind: 'cold-reveal', measurement: evidenceReady })

  // A same-mount draft round-trip forces real parent renders without navigation
  // or authority writes. Compare against the post-reveal baseline after restoration.
  const draftSelector = `${form} textarea`
  const draftBefore = await instance.cdp.evaluate(`document.querySelector(${JSON.stringify(draftSelector)})?.value`)
  requireEvidence(typeof draftBefore === 'string', 'the cold refresh draft is a real textarea value')
  const routeRefreshBaseline = await measureColdReveal(routeTarget, scroller, { status: 'ready', draftSelector: form })
  const evidenceRefreshBaseline = await measureColdReveal(evidenceTarget, scroller, { status: 'ready', draftSelector: form })
  const transientDraft = 'Transient cold refresh draft'
  await keyboardFill('Exercise cold refresh draft', draftSelector, transientDraft)
  await keyboardFill('Restore cold refresh draft', draftSelector, draftBefore)
  const restoredDraft = await instance.cdp.evaluate(`document.querySelector(${JSON.stringify(draftSelector)})?.value`)
  writeJson(join(out, 'cold-refresh-draft.json'), { selector: draftSelector, before: draftBefore, transient: transientDraft, restored: restoredDraft })
  requireEvidence(restoredDraft === draftBefore, 'the cold refresh draft round-trip restored the exact input')
  const routeRefreshed = await measureColdReveal(routeTarget, scroller, { status: 'ready', draftSelector: form })
  const evidenceRefreshed = await measureColdReveal(evidenceTarget, scroller, { status: 'ready', draftSelector: form })
  const errorEvidence = { kind: 'error', loading: routeLoading, ready: routeReady, refreshBaseline: routeRefreshBaseline, refreshed: routeRefreshed, control: await decisionControl(routeControl) }
  const successEvidence = { kind: 'success', loading: evidenceLoading, ready: evidenceReady, refreshBaseline: evidenceRefreshBaseline, refreshed: evidenceRefreshed, control: await decisionControl(successControl) }
  errorEvidence.problems = coldRevealProblems(errorEvidence)
  successEvidence.problems = coldRevealProblems(successEvidence)
  uiuxEvidence.coldReveals.push(errorEvidence, successEvidence)
  saveUiuxEvidence()
  await shot('uiux-cold-refresh-stable', { kind: 'cold-reveal-refresh', error: routeRefreshed, success: evidenceRefreshed })
  check('coldErrorRevealsActualEndOnceWithoutFocusDraftTheft', errorEvidence.problems.length === 0, { problems: errorEvidence.problems, loading: routeLoading, ready: routeReady, refreshBaseline: routeRefreshBaseline, refreshed: routeRefreshed, control: errorEvidence.control })
  check('coldSuccessRevealsActualEndOnceAndRefreshDoesNotJump', successEvidence.problems.length === 0, { problems: successEvidence.problems, loading: evidenceLoading, ready: evidenceReady, refreshBaseline: evidenceRefreshBaseline, refreshed: evidenceRefreshed })
}

async function setGuiLanguage(language) {
  const before = await instance.cdp.evaluate('document.documentElement.lang||null')
  await instance.cdp.setViewport(1440, 900, false)
  await keyboardActivate('Open account menu for language', 'button[aria-label="账号菜单"],button[aria-label="Account menu"]')
  await keyboardActivate('Open Settings for language', '[role="menuitem"],button', { namePattern: '^(设置|Settings)(?:\\s|⌘|$)' })
  await keyboardActivate('Open General settings for language', '[role="dialog"] button', { labels: ['通用设置', 'General', 'General settings'] })
  await waitFor(() => instance.cdp.evaluate('document.body.innerText.includes("当前版本") || document.body.innerText.includes("Current version")'), 30_000)
  await keyboardActivate('Open real Language preference', '[role="dialog"] button[aria-haspopup="menu"]', { namePattern: '^(?:中文|简体中文|English|Chinese)$' })
  const labels = language === 'en' ? ['English'] : ['中文', '简体中文', 'Chinese']
  await keyboardMenuActivate(`Select ${labels[0]} GUI language`, '[role="menuitemradio"],[role="menuitem"],button', { scope: '[role="menu"]', labels })
  await waitFor(() => instance.cdp.evaluate(`document.documentElement.lang.toLowerCase().startsWith(${JSON.stringify(language)})`), 30_000)
  const after = await instance.cdp.evaluate('document.documentElement.lang')
  await shot(`uiux-language-${language}-settings`, { kind: 'language-settings', before, after })
  await keyboardKey('Close Settings after language change', 'Escape')
  await waitFor(() => instance.cdp.evaluate('!document.body.innerText.includes("当前版本") && !document.body.innerText.includes("Current version")'), 30_000)
  return { before, after }
}

async function runEnglishVisualMatrix(sessionId) {
  const original = await instance.cdp.evaluate('document.documentElement.lang||"zh"')
  const change = await setGuiLanguage('en')
  await openPage('inbox')
  for (const theme of ['light', 'dark']) {
    await instance.cdp.setColorScheme(theme)
    for (const width of [360, 768, 1440]) {
      await instance.cdp.setViewport(width, 900, false)
      await layoutAudit(`en-${theme}-${width}`, theme, 1)
    }
  }
  await instance.cdp.setColorScheme('light')
  await openPage('agents')
  for (const width of [360, 1440]) {
    await instance.cdp.setViewport(width, 900, false)
    await layoutAudit(`en-agents-${width}`, 'light', 1)
  }
  await openIsolatedSession(sessionId, true)
  await instance.cdp.setViewport(360, 900, false)
  const trigger = '[data-weir-decision-trigger="weir-decision-selector"]'
  const scrollBefore = (await selectorOpen({ scrollBaseline: 'stable' })).scrollBefore
  const text = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  const copyProblems = selectorCopyProblems(text, { language: 'en', emptyScope: true, shadow: false })
  const scrollable = await instance.cdp.evaluate(`(() => {const body=document.querySelector('.weir-da-selector-body');return body.scrollHeight>body.clientHeight+1})()`)
  const audit = await beginModalAudit('selector-english', '#weir-da-selector-panel', trigger, { before: scrollBefore, selector: { scale: 1, scrollable } })
  const ax = await instance.cdp.accessibility('#weir-da-selector-panel')
  uiuxEvidence.languages.push({ language: 'en', surface: 'selector', text, copyProblems, ax, change })
  saveUiuxEvidence()
  check('englishSelectorUsesNaturalCopyAndAccessibleNames', copyProblems.length === 0 && ax.some(node => !node.ignored && node.role === 'radio' && /Automatically choose an assistant/i.test(node.name ?? '')), { text, copyProblems })
  await keyboardKey('Close English selector', 'Escape')
  await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel')&&document.activeElement===document.querySelector(${JSON.stringify(trigger)})`), 30_000)
  await finishModalAudit(audit)
  await newIsolatedSession('uiux-selector-long-en-other')
  const englishControl = await instance.cdp.evaluate(`window.__decisionQA.controlDecision(${JSON.stringify({ method: 'overview', args: { sessionId }, action: 'fail' })})`)
  await openIsolatedSession(sessionId, true)
  await instance.cdp.setViewport(360, 320, false)
  const englishBefore = (await selectorOpen({ scrollBaseline: 'immediate' })).scrollBefore
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('#weir-da-selector-panel [role=alert]'))`), 30_000)
  const englishText = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  const englishState = { kind: 'load-failure-en', language: 'en', control: await decisionControl(englishControl), text: englishText, ax: await instance.cdp.accessibility('#weir-da-selector-panel') }
  uiuxEvidence.selectorStates.push(englishState)
  saveUiuxEvidence()
  await shot('uiux-selector-english-long-failure-before', { kind: 'selector-long-status', controlId: englishControl, text: englishText })
  const englishFailure = await beginModalAudit('selector-english-long-failure', '#weir-da-selector-panel', trigger, { before: englishBefore, selector: { scale: 1, scrollable: true, longStatus: { text: uiuxFixture.agents[0].status.en, language: 'en' } } })
  check('englishLongFailureIsVisibleWrappedAndRetryable', englishState.control.used && englishText.includes(uiuxFixture.agents[0].status.en) && /Retry/i.test(englishText), { text: englishText, exactLongStatus: uiuxFixture.agents[0].status.en })
  await keyboardKey('Close English long failure after measurement', 'Escape')
  await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel')&&document.activeElement===document.querySelector(${JSON.stringify(trigger)})`), 30_000)
  await finishModalAudit(englishFailure)
  await selectorOpen()
  await keyboardActivate('Retry English long selector read', 'button', { scope: '#weir-da-selector-panel', labels: ['Retry'] })
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('#weir-da-selector-panel [role="radiogroup"]'))`), 30_000)
  await keyboardKey('Close recovered English selector', 'Escape')
  await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel')`), 30_000)
  const restore = await setGuiLanguage(original.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  const restored = await instance.cdp.evaluate('document.documentElement.lang')
  uiuxEvidence.languages.push({ language: 'restored', restore, restored })
  saveUiuxEvidence()
  check('testOwnedGuiLanguageRestored', restored.toLowerCase().startsWith(original.toLowerCase().startsWith('zh') ? 'zh' : 'en'), { original, restored })
}

async function runSelectorZoomMatrix(sessionId) {
  const trigger = '[data-weir-decision-trigger="weir-decision-selector"]'
  for (const width of [360, 768, 1440]) {
    await openIsolatedSession(sessionId, true)
    await instance.cdp.setPageZoom(1)
    const metricsOperation = await instance.cdp.setViewport(width, 900, true)
    await waitFor(() => instance.cdp.evaluate(`innerWidth===${width}&&innerHeight===900`), 10_000)
    const before = await instance.cdp.measureViewport({ reference: trigger })
    const operation = await instance.cdp.setPageZoom(2)
    const after = await instance.cdp.measureViewport({ reference: trigger })
    const row = { surface: 'selector', width, metricsOperation, operation, before, after, devicePixelRatio: after.devicePixelRatio }
    row.zoomProblems = [...browserZoomProblems(row, 2), ...viewportMeasurementProblems(after, { innerWidth: width, scale: 2 })]
    uiuxEvidence.zoom.push(row)
    saveUiuxEvidence()
    check(`selectorRealBrowserZoom200At${width}`, row.zoomProblems.length === 0, { width, problems: row.zoomProblems, before: before.visualViewport, after: after.visualViewport, innerWidth: after.innerWidth, devicePixelRatio: after.devicePixelRatio, rect: after.rects.reference })
    const scrollBefore = (await selectorOpen({ scrollBaseline: 'immediate' })).scrollBefore
    const scrollable = await instance.cdp.evaluate(`(() => {const body=document.querySelector('.weir-da-selector-body');return body.scrollHeight>body.clientHeight+1})()`)
    const audit = await beginModalAudit(`selector-zoom200-${width}`, '#weir-da-selector-panel', trigger, { before: scrollBefore, selector: { scale: 2, scrollable } })
    await keyboardKey(`Close 200 percent selector ${width}`, 'Escape')
    await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel')&&document.activeElement===document.querySelector(${JSON.stringify(trigger)})`), 30_000)
    await finishModalAudit(audit)
    await instance.cdp.setPageZoom(1)
  }
  await instance.cdp.setViewport(1440, 900, false)
}

// Gated real-Desktop export leg (WEIR_DECISION_PRODUCT_EXPORT=1). The action is
// only reachable through the records advanced area, the confirmation restates
// scope and destination, a real success shows the path/bytes/checksum of a real
// file (verified from the file itself), a read-only destination must show an
// actionable failure with no success surface, and both paths return focus.
async function runExportSurfaceAcceptance(sessionId, phase = 'GUI-decision-export') {
  if (process.env.WEIR_DECISION_PRODUCT_EXPORT !== '1') return null
  const evidence = { phase, sessionId }
  // The export is scoped to one workspace, so bind the page to that workspace's
  // own session first; a page without a session renders no records at all.
  await openDecisionPageForSession(sessionId, 'export-surface', 'records')
  await openDisclosure('weir-da-records-advanced')
  const action = await waitFor(() => instance.cdp.evaluate(`(() => {
    const button=document.querySelector('[data-record-export] [data-action="export"]')
    if(!button||button.disabled||button.offsetParent===null)return null
    button.scrollIntoView({block:'center',inline:'nearest'})
    const rect=button.getBoundingClientRect()
    return {present:true,width:rect.width,height:rect.height,text:button.innerText.trim(),enabled:!button.disabled,hint:document.querySelector('[data-record-export] p')?.innerText??''}
  })()`), 30_000)
  await shot('export-action')
  evidence.action = action
  check('exportActionVisibleInRecordsAdvancedArea', action.present === true && action.width > 0 && action.height > 0 && action.enabled === true && /导出决策数据|Export decision data/i.test(action.text), action)
  check('exportActionExplainsItsScope', /导出|export/i.test(action.text) && /JSON|exports|导入|import/i.test(action.hint), action)

  // Confirmation: the existing dialog, restated scope, nothing written yet.
  const confirmMark = networkRpc.length
  await keyboardActivate('Request data export', '[data-record-export] [data-action="export"]')
  const dialog = await waitFor(() => instance.cdp.evaluate(`(() => {
    const modal=document.querySelector('#weir-da-export')
    if(!modal)return null
    return {
      present:true,
      title:document.querySelector('#weir-da-export-title')?.innerText??'',
      body:document.querySelector('#weir-da-export-body')?.innerText??'',
      buttons:[...modal.querySelectorAll('.weir-da-actions button')].map(item=>({text:item.innerText.trim()})),
    }
  })()`), 30_000)
  const dialogAx = await instance.cdp.accessibility('#weir-da-export')
  const confirmationFocusInside = await instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-export")?.contains(document.activeElement))')
  check('exportConfirmationTakesFocus', confirmationFocusInside === true, { confirmationFocusInside })
  const confirmationProblems = exportConfirmationProblems({ dialog, ax: dialogAx })
  writeJson(join(out, 'export-confirmation.json'), { dialog, ax: dialogAx, problems: confirmationProblems })
  await shot('export-confirmation')
  check('exportConfirmationStatesScopeAndDestination', confirmationProblems.length === 0, { problems: confirmationProblems, dialog })
  await collectNetwork()
  evidence.confirmationWroteNothing = networkRpc.slice(confirmMark).filter(entry => entry.method === 'exportData').length === 0
  check('exportConfirmationWritesNothingBeforeConfirming', evidence.confirmationWroteNothing, { calls: networkRpc.slice(confirmMark).filter(entry => entry.method === 'exportData').length })

  // The real success path.
  const successMark = networkRpc.length
  await keyboardActivate('Confirm data export', '#weir-da-export .weir-da-actions button:last-child', { expectFocus: '[data-record-export] [data-action="export"]' })
  const successDom = await waitFor(() => instance.cdp.evaluate(`(() => {
    const section=document.querySelector('[data-export-result="success"]')
    if(!section)return null
    return {
      present:true,
      errorPresent:Boolean(document.querySelector('[data-export-result="error"]')),
      file:section.querySelector('[data-export-file]')?.innerText??'',
      bytesText:section.querySelector('[data-export-bytes]')?.innerText??'',
      sha256:section.querySelector('[data-export-sha256]')?.innerText??'',
      text:section.innerText,
      copy:Boolean(section.querySelector('[data-action="export-copy"]')),
    }
  })()`), 60_000)
  await collectNetwork()
  const successWire = networkRpc.slice(successMark).filter(entry => entry.method === 'exportData')
  requireEvidence(successWire.length === 1, `the export gesture ran exportData ${successWire.length} times instead of once`)
  const successPayload = publicRpcPayload(successWire[0])
  const successFocus = await measureFocus('[data-record-export] [data-action="export"]')
  const successFile = inspectExportFile(successPayload)
  const successProblems = exportSuccessSurfaceProblems({
    dom: successDom, wire: successPayload ?? {}, wireArgs: successWire[0].args ?? {}, file: successFile, focus: successFocus,
  })
  writeJson(join(out, 'export-success.json'), { dom: successDom, wire: successPayload, wireArgs: successWire[0].args, file: successFile, focus: successFocus, problems: successProblems })
  await shot('export-success')
  check('exportSuccessShowsRealFileBytesAndChecksum', successProblems.length === 0, { problems: successProblems, dom: successDom, wire: successPayload, file: successFile, focus: successFocus })
  // The shipped copy promises no public-memory provenance: the real file may only
  // carry the exporting workspace's own opaque alias.
  check('exportFileCarriesNoForeignWorkspaceAlias', (successFile.aliases?.foreign ?? null) !== null
    && successFile.aliases.foreign.length === 0
    && successFile.aliases.caller === successFile.envelope?.scope?.workspaceAlias
    && (successFile.aliases.tokens ?? []).includes(successFile.aliases.caller), successFile.aliases ?? null)

  // A read-only destination must fail closed on the real surface.
  const exportsDir = dirname(String(successPayload?.file ?? ''))
  requireEvidence(exportsDir && existsSync(exportsDir), `the exported file has a real directory: ${exportsDir}`)
  const filesBefore = readdirSync(exportsDir).length
  chmodSync(exportsDir, 0o500)
  let failureDom = null
  let failureWire = null
  let failureFocus = null
  try {
    const failureMark = networkRpc.length
    await keyboardActivate('Request data export again', '[data-record-export] [data-action="export"]')
    await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-export"))'), 30_000)
    await keyboardActivate('Confirm the failing data export', '#weir-da-export .weir-da-actions button:last-child', { expectFocus: '[data-record-export] [data-action="export"]' })
    failureDom = await waitFor(() => instance.cdp.evaluate(`(() => {
      const section=document.querySelector('[data-export-result="error"]')
      if(!section)return null
      return {
        present:true,
        successPresent:Boolean(document.querySelector('[data-export-result="success"]')),
        reason:section.querySelector('[data-export-error]')?.innerText??'',
        retry:Boolean(section.querySelector('[data-action="export-retry"]')),
        text:section.innerText,
      }
    })()`), 60_000)
    await collectNetwork()
    const failureWireEntries = networkRpc.slice(failureMark).filter(entry => entry.method === 'exportData')
    failureWire = failureWireEntries.at(-1) ? publicRpcPayload(failureWireEntries.at(-1)) : null
    failureFocus = await measureFocus('[data-record-export] [data-action="export"]')
  } finally {
    chmodSync(exportsDir, 0o700)
  }
  const failureFilesAfter = readdirSync(exportsDir).length
  const failureProblems = exportFailureSurfaceProblems({ dom: failureDom, filesBefore, filesAfter: failureFilesAfter, focus: failureFocus })
  writeJson(join(out, 'export-failure.json'), { dom: failureDom, wire: failureWire, filesBefore, filesAfter: failureFilesAfter, focus: failureFocus, problems: failureProblems })
  await shot('export-failure')
  check('exportFailureShowsActionableReasonWithoutSuccess', failureProblems.length === 0, { problems: failureProblems, dom: failureDom, filesBefore, filesAfter: failureFilesAfter, focus: failureFocus })

  // The retry recovers on the real surface once the directory is writable again.
  const retryMark = networkRpc.length
  await keyboardActivate('Retry the data export', '[data-export-result="error"] [data-action="export-retry"]', { expectFocus: '[data-export-result="success"] [data-action="export-copy"]' })
  const retriedDom = await waitFor(() => instance.cdp.evaluate(`(() => {
    const section=document.querySelector('[data-export-result="success"]')
    if(!section)return null
    return {present:true,file:section.querySelector('[data-export-file]')?.innerText??'',errorPresent:Boolean(document.querySelector('[data-export-result="error"]'))}
  })()`), 60_000)
  await collectNetwork()
  const retryWire = networkRpc.slice(retryMark).filter(entry => entry.method === 'exportData')
  const retryPayload = retryWire.at(-1) ? publicRpcPayload(retryWire.at(-1)) : null
  const retryFile = inspectExportFile(retryPayload)
  const retryProblems = [
    ...exportSuccessSurfaceProblems({
      dom: { ...retriedDom, bytesText: '', sha256: '' }, wire: retryPayload ?? {}, wireArgs: retryWire.at(-1)?.args ?? {},
      file: retryFile, focus: await measureFocus('[data-export-result="success"] [data-action="export-copy"]'),
    }).filter(problem => !/does not show the real (size|checksum)/.test(problem)),
  ]
  writeJson(join(out, 'export-retry.json'), { dom: retriedDom, wire: retryPayload, file: retryFile, problems: retryProblems })
  await shot('export-retry')
  check('exportRetryRecoversOnTheRealSurface', retryProblems.length === 0 && retriedDom.present === true, { problems: retryProblems, dom: retriedDom })
  evidence.success = { dom: successDom, wire: successPayload, file: successFile, focus: successFocus, problems: successProblems }
  evidence.failure = { dom: failureDom, filesBefore, filesAfter: failureFilesAfter, focus: failureFocus, problems: failureProblems }
  writeJson(join(out, 'export-surface.json'), evidence)
  return evidence
}

/**
 * Read the exported file the driver was told about and re-derive every fact the
 * success surface claims: existence, byte count, mode, checksum, envelope and
 * the origin aliases the file may carry.
 */
function inspectExportFile(payload) {
  const path = String(payload?.file ?? '')
  if (!path || !existsSync(path)) return { exists: false }
  const content = readFileSync(path, 'utf8')
  let envelope = null
  try { envelope = JSON.parse(content) } catch { envelope = null }
  const stat = statSync(path)
  const directory = dirname(path)
  // The product checksum is canonical-JSON integrity over the envelope, not a
  // hash of the pretty file bytes: recompute exactly what the product promised.
  const canonicalChecksum = envelope ? createHash('sha256').update(JSON.stringify(canonicalFileJson(withoutIntegrity(envelope)))).digest('hex') : ''
  // Public-memory provenance and other workspaces' identifiers never enter: the
  // only origin token the file may carry is the exporting workspace's own alias.
  const caller = String(envelope?.scope?.workspaceAlias ?? '')
  const tokens = [...new Set(content.match(/origin_[0-9a-f]{12}/g) ?? [])].sort()
  return {
    exists: true,
    bytes: stat.size,
    mode: (stat.mode & 0o777).toString(8),
    directoryMode: (statSync(directory).mode & 0o777).toString(8),
    sha256: canonicalChecksum,
    contentSha256: createHash('sha256').update(content).digest('hex'),
    envelope: envelope ? { ...envelope, checksumValid: canonicalChecksum === envelope?.integrity?.value } : null,
    aliases: { caller, tokens, foreign: tokens.filter(token => token !== caller) },
    containsWorkspaceKey: content.includes('workspaceKey'),
    containsAbsolutePath: /(?:^|["'\s])(?:\/Users\/|\/home\/|\/private\/|\/var\/|[A-Za-z]:\\)/.test(content),
  }
}

/** The envelope without its own integrity field, for checksum recomputation. */
function withoutIntegrity(envelope) {
  const rest = { ...envelope }
  delete rest.integrity
  return rest
}

/** Canonical JSON over the file envelope, to verify the checksum independently. */
function canonicalFileJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(canonicalFileJson)
  if (value && typeof value === 'object') {
    const result = {}
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) result[key] = canonicalFileJson(value[key])
    return result
  }
  return value
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
  await installUiuxInstrumentation()
  const initialPreflight = JSON.parse(readFileSync(join(out, 'process-1-preflight.json'), 'utf8'))
  check('freshRunStartsWithoutDecisionStore', initialPreflight.databaseExists === false && initialPreflight.databasePath === databasePath, { databasePath, databaseExists: initialPreflight.databaseExists })
  const created = await createSession(instance)
  const sessionId = created.sessionId
  writeJson(join(out, 'session.json'), created)
  knownSessionIds.add(sessionId)
  const slots = await instance.cdp.evaluate('window.__decisionQA.getState()')
  writeJson(join(out, 'slots.json'), slots)
  check('newSlotsActive', slots.sidebar.includes('weir-decisions') && slots.main.includes('weir-decisions') && slots.composer.includes('weir-decision-selector') && slots.toolviews.includes('ask_user_question') && slots.toolviews.includes('decision_consult'), slots)
  const initialScrollBefore = (await selectorOpen({ scrollBaseline: 'immediate' })).scrollBefore
  const initialSelector = await instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); return {text:panel.innerText,radios:[...panel.querySelectorAll('input[type="radio"]')].map(el=>({value:el.value,name:el.getAttribute('aria-label'),checked:el.checked})),legacy:Boolean(document.querySelector('select[data-weir-decision-selector]'))} })()`)
  const initialAuthority = await rpc(sessionId, 'initial-fresh-auto', 'overview')
  const initialCopyProblems = selectorCopyProblems(initialSelector.text, { language: 'zh', emptyScope: true, shadow: false })
  check('dedicatedFreshSelectorOffAutoAndPersistedDefaultAuto', !initialSelector.legacy && initialCopyProblems.length === 0 && initialSelector.radios.map(radio => radio.value).join(',') === 'off,auto' && initialSelector.radios.find(radio => radio.value === 'auto')?.checked === true && initialSelector.radios.every(radio => radio.name === (radio.value === 'off' ? '不启用助手' : '自动选择助手')) && selectorMatches(initialAuthority.selector, 'auto'), { initialSelector, authority: initialAuthority.selector, copyProblems: initialCopyProblems })
  await shot('01-selector-empty')
  const initialModal = await beginModalAudit('selector-empty-few', '#weir-da-selector-panel', '[data-weir-decision-trigger="weir-decision-selector"]', { before: initialScrollBefore, selector: { scale: 1, scrollable: false } })
  await keyboardKey('Close measured empty selector', 'Escape')
  await waitFor(() => instance.cdp.evaluate('!document.querySelector("#weir-da-selector-panel") && document.activeElement===document.querySelector(\'[data-weir-decision-trigger="weir-decision-selector"]\')'), 30_000)
  await finishModalAudit(initialModal)
  await selectorOpen()
  await keyboardActivate('Create assistant from selector', 'button', { scope: '#weir-da-selector-panel', labels: ['新建助手', 'New assistant'], expectFocus: '[data-agent-field="name"]' })
  const longName = '桌面验收助手 · Decision Product QA with an intentionally long English assistant name'
  const preference = '只依据可核验证据；高风险操作仍由用户决定。Prefer source-backed concise answers and preserve the existing approval boundary. 这是用于长文本与编辑验收的用户原创判断偏好。'
  await fillAgent(longName, preference)
  let agents = await waitFor(async () => { const value = await rpc(sessionId, 'initial-create', 'agents'); return value.some(agent => agent.name === longName) ? value : null }, 30_000)
  const primary = agents.find(agent => agent.name === longName)
  await expectMutation('profileUpsert', { sessionId, name: longName, userDescription: preference })
  const createdScope = primary.scope ?? {}
  check('selectorCreateUsesProfileGlobalIdentity', primary.state === 'enabled' && primary.name === longName && !Object.hasOwn(createdScope, 'workspaces') && (createdScope.authorizationClasses ?? []).length > 0, { agentId: primary.agentId, scope: createdScope })
  const secondary = await createAgent(sessionId, '空候选与键盘备用助手 · Empty review assistant', 'No existing decisions: the isolated fixture returns no candidate operations for this assistant only.')
  await runSelectorFailureMatrix(sessionId, primary, secondary)
  await runAgentResumeMatrix(sessionId, primary, secondary)
  await openAgent(sessionId, primary.agentId)
  await keyboardActivate('Edit assistant', `[data-agent-detail="${primary.agentId}"] [data-action="edit-agent"]`, { expectFocus: '[data-agent-field="name"]' })
  const editedName = `${longName} · 已编辑 / edited`
  const editedPreference = `${preference} 编辑后仍保持相同 scope 与模型继承。`
  await fillAgent(editedName, editedPreference)
  await keyboardActivate('Open non-dirty assistant editor', `[data-agent-detail="${primary.agentId}"] [data-action="edit-agent"]`, { expectFocus: '[data-agent-field="name"]' })
  await keyboardActivate('Close non-dirty assistant editor', 'button', { scope: 'form[data-agent-editor] .weir-da-actions', labels: ['取消', 'Cancel'], expectFocus: `.weir-da-agent-back,[data-agent-detail="${primary.agentId}"]` })
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
  await runSelectorZoomMatrix(sessionId)

  const longCase = await askLongNative(sessionId)
  await openPage('inbox')
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('article[data-case-id=${JSON.stringify(longCase.caseId)}]'))`), 30_000)
  await runColdRevealMatrix(sessionId, longCase.caseId)
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
    await instance.cdp.setPageZoom(1)
    const metricsOperation = await instance.cdp.setViewport(width, 900, true)
    await waitFor(() => instance.cdp.evaluate(`innerWidth===${width}&&innerHeight===900`), 10_000)
    const before = await instance.cdp.measureViewport({ page: '.weir-da-page' })
    const operation = await instance.cdp.setPageZoom(2)
    const after = await instance.cdp.measureViewport({ page: '.weir-da-page' })
    const zoomEvidence = { surface: 'inbox', width, metricsOperation, operation, before, after, devicePixelRatio: after.devicePixelRatio }
    zoomEvidence.problems = [...browserZoomProblems(zoomEvidence, 2), ...viewportMeasurementProblems(after, { innerWidth: width, scale: 2 })]
    uiuxEvidence.zoom.push(zoomEvidence)
    saveUiuxEvidence()
    check(`inboxRealBrowserZoom200At${width}`, zoomEvidence.problems.length === 0, { width, problems: zoomEvidence.problems, before: before.visualViewport, after: after.visualViewport, innerWidth: after.innerWidth, devicePixelRatio: after.devicePixelRatio, cssRect: after.rects.page })
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
  await runEnglishVisualMatrix(sessionId)
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
  await runLearningResumeMatrix(sessionId, primary, rejectedV3)
  const p4State = await runP4BeforeRestart(sessionId, primary, secondary)
  const beforeRestart = { agent: rejectedV3.agent, run: rejectedV3.run, snapshot: rejectedV3.snapshot, learned: learnedDetail, selector: await rpc(sessionId, 'before-restart', 'overview') }
  writeJson(join(out, 'before-restart.json'), beforeRestart)
  const scanBefore = await scanSession(sessionId, 'session-before-restart.json')
  check('noCommandOrCustomDecisionSessionEvents', scanBefore.commandEvents.length === 0 && scanBefore.customDecisionEvents.length === 0)

  const beforeGlobalOff = await records(sessionId)
  const interruptionConfig = await setAutoSettings('p4-interruption-window', { answerTimeoutMs: 30000 })
  check('interruptionUsesExplicitBoundedHoldWindow', interruptionConfig.effective?.decisionAgentAnswerTimeoutMs === 30000, interruptionConfig.effective)
  await openIsolatedSession(p4State.autoSession)
  await submitMarker(instance, 'GUI_AUTO_INTERRUPT')
  await waitFor(() => existsSync(join(out, 'it-root', 'decision-auto-interruption.ready')), 30_000)
  await stopOwned('process-1', { crash: true })
  const interruptedSnapshot = sqliteSnapshot('p4-interrupted-before-crash')
  const interruptedRows = interruptedSnapshot.rows.cases.filter(row => row.root_session_id === p4State.autoSession && JSON.parse(row.request_json).questions?.some(question => question.id === 'gui-auto-interrupt'))
  requireEvidence(interruptedRows.length === 1, 'exactly one persisted interrupted Auto intake exists')
  const interruptedRow = interruptedRows[0]
  const interruptedAttempts = interruptedSnapshot.rows.attempts.filter(row => row.case_id === interruptedRow.case_id)
  const interruptedRoutes = interruptedSnapshot.rows.route_decisions.filter(row => row.case_id === interruptedRow.case_id)
  check('interruptedIntakeIsReceivedWithoutRouteOrAttemptBeforeCrash', interruptedRow.agent_id === null && interruptedRow.state === 'received' && interruptedAttempts.length === 0 && interruptedRoutes.length === 0, { caseId: interruptedRow.case_id, state: interruptedRow.state, attempts: interruptedAttempts.length, routes: interruptedRoutes.length })
  p4Evidence.interrupted = { case: { caseId: interruptedRow.case_id, agentId: interruptedRow.agent_id, state: interruptedRow.state }, attempts: interruptedAttempts, routeDecisions: interruptedRoutes }
  instance = await startDesktop(false)
  await installUiuxInstrumentation()
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
  await installUiuxInstrumentation()
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
  auditP4RawEvidence(p4State, primary, secondary)
  // Only after every pre-migration assertion: the isolated profile store is
  // replaced by a genuine migrated v1 database, and the cross-workspace matrix
  // then runs on that same live profile.
  p4State.crossWorkspaceLegacy = await runMigratedLegacyProfileSurface()
  instance = await startDesktop(true)
  await installUiuxInstrumentation()
  // The denial probe must use private rows that exist in the live (migrated)
  // store, not ids from the store this run replaced.
  p4State.crossWorkspace = await runCrossWorkspaceMemoryMatrix(p4State, {
    learningRunId: p4State.crossWorkspaceLegacy.expected.privateLearningRunId,
    snapshotId: p4State.crossWorkspaceLegacy.expected.privateSnapshotId,
  })
  await stopOwned('cross-workspace-final')
  copyFileSync(legacyDatabasePath(), join(out, 'decision-migrated.db'))
  const exceptions = runtimeEvents.filter(item => item.event.method === 'Runtime.exceptionThrown')
  const consoleErrors = runtimeEvents.filter(item => item.event.method === 'Runtime.consoleAPICalled' && item.event.params?.type === 'error')
  const slotCrashes = runtimeEvents.filter(item => /slot entry crashed|Slot.*crash/i.test(JSON.stringify(item.event)))
  const logErrors = runtimeEvents.filter(item => item.event.method === 'Log.entryAdded' && item.event.params?.entry?.level === 'error')
  const desktopLogPaths = ['desktop-enabled.log', 'desktop-disabled.log']
  const desktopLogs = desktopLogPaths.map(path => readFileSync(join(out, path), 'utf8'))
  const importFailures = desktopLogs.flatMap(log => log.split('\n').filter(line => /failed to import weir-harness|SessionFormatUnsupportedError|slot entry crashed/i.test(line)))
  const socketClosures = shutdownSocketClosureEntries(Object.fromEntries(desktopLogPaths.map((path, index) => [path, desktopLogs[index]])))
  writeJson(join(out, 'runtime-scan.json'), { exceptionCount: exceptions.length, exceptions, consoleErrorCount: consoleErrors.length, consoleErrors, slotCrashCount: slotCrashes.length, slotCrashes, logErrorCount: logErrors.length, logErrors, importFailures, shutdownSocketClosureStderrCount: socketClosures.length, shutdownSocketClosureStderr: socketClosures, scannedLogs: desktopLogPaths })
  check('noRuntimeExceptionsConsoleErrorsOrSlotCrashes', exceptions.length === 0 && consoleErrors.length === 0 && slotCrashes.length === 0 && logErrors.length === 0 && importFailures.length === 0, { exceptions: exceptions.length, consoleErrors: consoleErrors.length, slotCrashes: slotCrashes.length, logErrors: logErrors.length, importFailures })
  check('shutdownSocketClosureStderrScopedSeparately', socketClosures.every(entry => entry.scope === 'desktop-shutdown-socket-closure-stderr' && entry.countsAsRuntimeError === false && entry.countsAsImportFailure === false), { count: socketClosures.length, scope: 'desktop-shutdown-socket-closure-stderr', excludedFrom: ['Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Log.entryAdded', 'importFailures'] })
  await collectNetwork()
  check('completeLifecyclePngEvidence', screenshots.length >= 30 && screenshots.every(item => statSync(item.path).size > 8), { count: screenshots.length })
  validateAccessibility()
  const requiredKeyboardActions = ['Open assistant editor', 'Edit assistant', 'Request assistant disabled', 'Confirm assistant disabled', 'Request assistant enabled', 'Confirm assistant enabled', 'Choose native answer Native Off', 'Choose native answer Use Short', 'Choose native answer User backed GUI answer', 'Use inbox suggestions', 'Submit inbox decision', 'Apply feedback rating_up', 'Apply feedback undo_rating_up', 'Apply feedback rating_down', 'Apply feedback undo_rating_down', 'Enter independent note', 'Enter correction', 'Submit note', 'Submit correction', 'Start principle review', 'Request snapshotPublish', 'Confirm snapshotPublish', 'Request snapshotReject', 'Confirm snapshotReject', 'Request snapshotRollback', 'Confirm snapshotRollback']
  const keyboardProblems = requiredKeyboardActions.filter(action => !keyboardAudits.some(audit => audit.action === `Focus: ${action}` && audit.reached && (audit.activation || audit.input)))
  check('completeKeyboardInteractionEvidence', keyboardProblems.length === 0, { missing: keyboardProblems, interactions: keyboardAudits.length })
  const requiredFocusTransitions = ['Create assistant from selector', 'Open assistant editor', 'Open assistant details', 'Edit assistant', 'Back to narrow assistant list', 'Open narrow create draft', 'Back with preserved create draft', 'Resume same create draft', 'Back before real create target change', 'Open narrow edit draft', 'Back with preserved edit draft', 'Resume same assistant edit draft', 'Back before real edit target change', 'Back with selected learning context', 'Resume same assistant learning context', 'Save assistant', 'Close non-dirty assistant editor']
  const focusProblems = requiredFocusTransitions.filter(action => !keyboardAudits.some(audit => audit.action === `Focus: ${action}` && audit.reached && audit.activation && audit.options?.expectFocus === audit.focus?.selector && audit.focus?.connected === true && audit.focus?.visible === true && audit.focus?.active === true && !['body', 'html'].includes(audit.focus?.activeTag)))
  check('completeAssistantTransitionFocusEvidence', focusProblems.length === 0, { missing: focusProblems, required: requiredFocusTransitions })
  check('nativeKeyPacketsPersisted', nativeKeyPackets.some(packet => packet.method === 'Input.dispatchKeyEvent' && packet.params?.text === '\r') && nativeKeyPackets.some(packet => packet.method === 'Input.dispatchKeyEvent' && packet.params?.text === ' ') && nativeKeyPackets.some(packet => packet.method === 'Input.dispatchKeyEvent' && packet.params?.key === 'Tab') && nativeKeyPackets.some(packet => packet.method === 'Input.insertText'), { packets: nativeKeyPackets.length })
  check('allOwnedProcessesAndPortFinallyReleased', cleanups.length === 6 && cleanups.every(item => item.pass) && new Set(processProvenance.map(item => item.mainPid)).size === 6 && await portFree() && !portListeners(), { cleanups: cleanups.map(item => ({ label: item.label, mainPid: item.mainPid, hostPid: item.hostPid, pass: item.pass })), port: PORT })
  const confirmationKinds = new Set(uiuxEvidence.confirmations.map(item => item.kind))
  const requiredConfirmations = ['cancel-decision', 'discard-editor', 'assistant-disabled', 'assistant-enabled', 'assistant-archived', 'snapshotPublish', 'snapshotReject', 'snapshotRollback']
  const selectorStateKinds = new Set(uiuxEvidence.selectorStates.map(item => item.kind))
  const masterDetailKinds = new Set(uiuxEvidence.masterDetail.map(item => item.kind))
  const zoomComplete = [360, 768, 1440].every(width => ['selector', 'inbox'].every(surface => uiuxEvidence.zoom.some(item => item.width === width && item.surface === surface && item.operation?.method === 'Emulation.setPageScaleFactor' && item.operation?.pageScaleFactor === 2 && item.after?.visualViewport?.scale === 2)))
  const requiredLongStatuses = [
    { name: 'selector-load-failure-long', stateKind: 'load-failure', language: 'zh', text: uiuxFixture.agents[0].status.zh },
    { name: 'selector-save-failure-long', stateKind: 'save-failure', language: 'zh', text: uiuxFixture.agents[0].status.zh },
    { name: 'selector-english-long-failure', stateKind: 'load-failure-en', language: 'en', text: uiuxFixture.agents[0].status.en },
  ]
  const longStatusProblems = requiredLongStatuses.filter(expected => {
    const layout = uiuxEvidence.selectorLayouts.find(item => item.name === expected.name && item.problems.length === 0 && item.longStatus?.expected === expected.text && item.longStatus?.actual === expected.text && item.longStatus?.role === 'alert' && item.longStatus?.ax?.some(node => !node.ignored && String(node.name ?? '').includes(expected.text)))
    const state = uiuxEvidence.selectorStates.find(item => item.kind === expected.stateKind && item.control?.used === true && item.text?.includes(expected.text))
    return !layout || !state
  })
  check('completeLongBilingualProductStatusEvidence', longStatusProblems.length === 0, { missing: longStatusProblems, required: requiredLongStatuses })
  const sessionProblems = uiuxEvidence.modalAudits.flatMap(audit => sessionScrollerProblems(audit).map(problem => ({ kind: audit.kind, problem })))
  const sessionAuditCount = uiuxEvidence.modalAudits.filter(audit => audit.sessionIdentity?.required === true && audit.before?.session && audit.during?.session && audit.after?.session).length
  check('completeSessionScrollerEvidence', sessionProblems.length === 0 && sessionAuditCount > 0, { problems: sessionProblems, sessionAuditCount, modalAudits: uiuxEvidence.modalAudits.length })
  const uiuxCoverage = {
    confirmations: requiredConfirmations.filter(kind => !confirmationKinds.has(kind)),
    selectorStates: ['load-failure', 'unknown', 'save-failure', 'save-pending'].filter(kind => !selectorStateKinds.has(kind)),
    masterDetail: ['create', 'edit', 'learning'].filter(kind => !masterDetailKinds.has(kind)),
    focusTransitions: focusProblems,
    longStatus: longStatusProblems,
    session: sessionProblems,
    sessionAudits: sessionAuditCount,
    coldReveals: ['success', 'error'].filter(kind => !uiuxEvidence.coldReveals.some(item => item.kind === kind && item.problems.length === 0)),
    zoomComplete,
    english: uiuxEvidence.languages.some(item => item.language === 'en' && item.copyProblems?.length === 0),
    languageRestored: uiuxEvidence.languages.some(item => item.language === 'restored'),
    modalAudits: uiuxEvidence.modalAudits.length,
  }
  check('completeUiux52And53AcceptanceCoverage', Object.values(uiuxCoverage).every(value => Array.isArray(value) ? value.length === 0 : value === true || typeof value === 'number' && value > 0), uiuxCoverage)
  saveUiuxEvidence()
  result = { phase: 'GUI-decision-uiux-5.2-5.3', verdict: 'PASS', pass: true, runId, root, out, port: PORT, sessionId, primaryAgentId: primary.agentId, secondaryAgentId: secondary.agentId, uiux: { coverage: uiuxCoverage, modalAudits: uiuxEvidence.modalAudits.length, selectorLayouts: uiuxEvidence.selectorLayouts.length, confirmations: uiuxEvidence.confirmations.length, coldReveals: uiuxEvidence.coldReveals.length, masterDetail: uiuxEvidence.masterDetail.length, zoomMeasurements: uiuxEvidence.zoom.length }, p4: { sessions: p4State, caseIds: { selected: p4Evidence.selected.case.caseId, one: p4Evidence.one.case.caseId, none: p4Evidence.none.case.caseId, ambiguous: p4Evidence.ambiguous.case.caseId, invalid: p4Evidence.invalid.case.caseId, timeout: p4Evidence.timeout.case.caseId, explicit: p4Evidence.explicit.case.caseId, returned: p4Evidence.returned.case.caseId, pending: p4Evidence.pending.case.caseId, interrupted: p4Evidence.interrupted.case.caseId }, processProvenance }, caseIds: { first: first.caseId, reuse: reuse.caseId, consult: consult.caseId, long: longCase.caseId, learned: learned.caseId }, checks, checkDetails, screenshots, comparisons, cleanupReceipts: cleanups.map(item => join(out, `${item.label}-exact-pid-cleanup.json`)), artifacts: { uiux: join(out, 'uiux-acceptance.json'), networkRpc: join(out, 'network-rpc.json'), authoritativeRpc: join(out, 'authoritative-rpc.json'), runtime: join(out, 'runtime-scan.json'), visual: join(out, 'visual-audits.json'), accessibility: join(out, 'accessibility.json'), keyboard: join(out, 'keyboard-interactions.json'), immutable: join(out, 'immutable-history.json'), stockClassification: join(out, 'stock-classification-proof.json'), sqliteReadModel: join(out, 'sqlite-read-model-comparison.json'), p4Restoration: join(out, 'p4-restoration.json'), database: join(out, 'decision.db'), report: join(out, 'evidence-zh.md') } }
  result.artifacts.hostOnboarding = join(out, 'host-onboarding.json')
  result.artifacts.nativeKeyPackets = join(out, 'native-key-packets.json')
  result.artifacts.crossWorkspaceMatrix = join(out, 'cross-workspace-matrix.json')
  result.artifacts.crossWorkspaceLegacyProfile = join(out, 'cross-workspace-legacy-profile.json')
  result.artifacts.crossWorkspaceLegacySurface = join(out, 'cross-workspace-legacy-surface.json')
  result.artifacts.exportSurface = join(out, 'export-surface.json')
  result.artifacts.decisionMigrated = join(out, 'decision-migrated.db')
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
    const exceptions = runtimeEvents.filter(item => item.event.method === 'Runtime.exceptionThrown')
    const consoleErrors = runtimeEvents.filter(item => item.event.method === 'Runtime.consoleAPICalled' && item.event.params?.type === 'error')
    const slotCrashes = runtimeEvents.filter(item => /slot entry crashed|Slot.*crash/i.test(JSON.stringify(item.event)))
    const logErrors = runtimeEvents.filter(item => item.event.method === 'Log.entryAdded' && item.event.params?.entry?.level === 'error')
    const scannedLogs = ['desktop-enabled.log', 'desktop-disabled.log'].filter(path => existsSync(join(out, path)))
    const importFailures = scannedLogs.flatMap(path => readFileSync(join(out, path), 'utf8').split('\n').filter(line => /failed to import weir-harness|SessionFormatUnsupportedError|slot entry crashed/i.test(line)))
    const socketClosures = shutdownSocketClosureEntries(Object.fromEntries(scannedLogs.map(path => [path, readFileSync(join(out, path), 'utf8')])))
    writeJson(join(out, 'runtime-scan.json'), {
      exceptionCount: exceptions.length, exceptions,
      consoleErrorCount: consoleErrors.length, consoleErrors,
      slotCrashCount: slotCrashes.length, slotCrashes,
      logErrorCount: logErrors.length, logErrors, importFailures, scannedLogs,
      shutdownSocketClosureStderrCount: socketClosures.length, shutdownSocketClosureStderr: socketClosures,
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
    result = { phase: 'GUI-decision-uiux-5.2-5.3', verdict: 'BLOCKED', pass: false, runId, root, out, port: PORT, checks, checkDetails, error: failure?.message ?? String(failure), cleanup: cleanups, artifacts: { uiux: join(out, 'uiux-acceptance.json'), runtime: join(out, 'runtime-scan.json'), screenshots: join(out, 'screenshots.json') } }
    result.artifacts.hostOnboarding = join(out, 'host-onboarding.json')
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
