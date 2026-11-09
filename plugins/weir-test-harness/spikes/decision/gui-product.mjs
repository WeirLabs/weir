// Real isolated Desktop acceptance for decision-agent-product-ux tasks 8.1–8.2.
// All product mutations are performed on the rendered NEW UI. Direct RPC is read-only.
// Only exact owned main/Host PIDs are signalled; the current App is never addressed.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LANE, writeJson, prepareProfile, startInstance, stopInstance,
  createSession, openSession, setInput, submitMarker,
} from './gui-qa.mjs'
import { waitFor } from './cdp.mjs'
import { answerFormExpression, correctionPreviewProblems, exactArgs, immutableChanges, layoutProblems, parseDecisionRequest, recordProjectionProblems } from './gui-product-lib.mjs'

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
const mutationCounts = new Map()
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
  if (!['overview', 'agents', 'agent', 'records', 'record', 'inbox', 'metrics', 'learningRun', 'memorySnapshot', 'caseForCall', 'caseForToolCall'].includes(method)) {
    throw new Error(`Direct Decision RPC is read-only; refused ${method}`)
  }
  const transport = await instance.cdp.evaluate(`window.__decisionQA.decision(${JSON.stringify(method)}, ${JSON.stringify({ sessionId, ...args })})`)
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

async function stopOwned(label) {
  const value = instance
  if (!value) return null
  await collectNetwork(value).catch(() => {})
  collectRuntime(value, label)
  const mainPid = value.app.pid
  const host = await value.cdp?.evaluate('window.__decisionQA?.fixture("hostState", {})').catch(() => null)
    ?? (existsSync(join(out, 'host.json')) ? JSON.parse(readFileSync(join(out, 'host.json'), 'utf8')) : null)
  const hostPid = host?.pid
  const before = { main: processInfo(mainPid), host: processInfo(hostPid) }
  const base = await stopInstance(value, join(out, `${label}-cleanup-base.json`))
  let hostSignal = hostPid === mainPid ? 'covered-by-main' : 'not-needed'
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
  await waitFor(async () => await portFree() && !portListeners(), 10_000)
  const after = { main: processInfo(mainPid), host: processInfo(hostPid) }
  const receipt = { ...base, label, port: PORT, root, mainPid, hostPid, hostSignal, before, after, mainStopped: !after.main?.alive, hostStopped: !after.host?.alive, portReleased: await portFree() && !portListeners() }
  receipt.pass = receipt.mainStopped && receipt.hostStopped && receipt.portReleased
  cleanups.push(receipt)
  writeJson(join(out, `${label}-exact-pid-cleanup.json`), receipt)
  instance = null
  check(`${label}ExactOwnedCleanup`, receipt.pass, { mainPid, hostPid, hostSignal, portReleased: receipt.portReleased })
  return receipt
}

async function click(selector) {
  const clicked = await instance.cdp.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el||el.offsetParent===null||el.disabled)return false; el.click(); return true })()`)
  if (!clicked) throw new Error(`Rendered click target unavailable: ${selector}`)
}

async function clickText(scope, labels) {
  const clicked = await instance.cdp.evaluate(`(() => { const root=document.querySelector(${JSON.stringify(scope)}); if(!root)return false; const labels=${JSON.stringify(labels)}; const el=[...root.querySelectorAll('button')].find(button=>button.offsetParent!==null&&labels.includes(button.textContent.trim())&&!button.disabled); if(!el)return false; el.click(); return true })()`)
  if (!clicked) throw new Error(`Rendered button not found in ${scope}: ${labels.join('/')}`)
}

async function selectorOpen() {
  await click('[data-weir-decision-trigger="weir-decision-selector"]')
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-selector-panel"))'), 30_000)
}

async function selectorChoose(sessionId, mode, agentId = null) {
  await selectorOpen()
  const value = mode === 'off' ? 'off' : agentId
  const target = await waitFor(() => instance.cdp.evaluate(`(() => { const input=document.querySelector('#weir-da-selector-panel input[type="radio"][value=${JSON.stringify(value)}]'); return input&&!input.disabled?{checked:input.checked}:null })()`), 30_000)
  if (target.checked) {
    await instance.cdp.key('Escape')
    await waitFor(() => instance.cdp.evaluate('!document.querySelector("#weir-da-selector-panel")'), 30_000)
    const current = await rpc(sessionId, 'selector-unchanged', 'overview')
    return current.selector
  }
  await waitFor(() => instance.cdp.evaluate(`(() => { const input=document.querySelector('#weir-da-selector-panel input[type="radio"][value=${JSON.stringify(value)}]'); if(!input||input.disabled)return false; input.click(); return true })()`), 30_000)
  await waitFor(() => instance.cdp.evaluate('!document.querySelector("#weir-da-selector-panel")'), 30_000)
  const overview = await waitFor(async () => { const current = await rpc(sessionId, 'selector', 'overview'); return current.selector?.mode === mode && (mode === 'off' || current.selector?.agentId === agentId) ? current : null }, 30_000)
  await expectMutation('setSelector', mode === 'off' ? { sessionId, mode: 'off' } : { sessionId, mode: 'agent', agentId })
  return overview.selector
}

async function openPage(tab = 'inbox') {
  await instance.cdp.evaluate('window.__decisionQA.selectDecisions()')
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("main.weir-da-page"))'), 60_000)
  const current = await instance.cdp.evaluate(`document.querySelector('main.weir-da-page [data-decision-primary-nav] [data-view=${JSON.stringify(tab)}]')?.getAttribute('aria-pressed')`)
  if (current !== 'true') await click(`main.weir-da-page [data-view="${tab}"]`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('main.weir-da-page section[data-view=${JSON.stringify(tab)}]'))`), 30_000)
}

async function fillAgent(name, preference) {
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("form[data-agent-editor]"))'), 30_000)
  await setInput(instance, '[data-agent-field="name"]', name)
  await setInput(instance, '[data-agent-field="preference"]', preference)
  await click('form[data-agent-editor] button[type="submit"]')
}

async function createAgent(sessionId, name, preference) {
  await openPage('agents')
  await click('[data-action="create-agent"]')
  await fillAgent(name, preference)
  const agents = await waitFor(async () => { const value = await rpc(sessionId, 'agent-create', 'agents'); return value.some(agent => agent.name === name) ? value : null }, 30_000)
  const agent = agents.find(item => item.name === name)
  await expectMutation('profileUpsert', { sessionId, name, userDescription: preference })
  return agent
}

async function openAgent(sessionId, agentId) {
  await openPage('agents')
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-agent-summary=${JSON.stringify(agentId)}] [data-action="open-agent"]'))`), 30_000)
  await click(`[data-agent-summary="${agentId}"] [data-action="open-agent"]`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-agent-detail=${JSON.stringify(agentId)}]'))`), 30_000)
  return rpc(sessionId, 'agent-open', 'agent', { agentId })
}

async function agentState(sessionId, agentId, state) {
  await openAgent(sessionId, agentId)
  await click(`[data-agent-detail="${agentId}"] [data-agent-state="${state}"]`)
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-agent-state"))'), 30_000)
  await click(`#weir-da-agent-state .weir-da-actions button${state === 'enabled' ? '[data-variant="primary"]' : ':last-child'}`)
  const agent = await waitFor(async () => { const value = await rpc(sessionId, 'agent-state', 'agent', { agentId }); return value.state === state ? value : null }, 30_000)
  await expectMutation('profileSetState', { sessionId, agentId, state })
  return agent
}

async function nativeState() {
  return instance.cdp.evaluate(`(() => { const visible=el=>Boolean(el&&el.offsetParent!==null); const pending=[...document.querySelectorAll('[data-question-key]')].find(visible); return {pending:Boolean(pending),text:pending?.innerText??'',radios:pending?[...pending.querySelectorAll('[role="radio"]')].map(el=>({label:el.getAttribute('aria-label'),checked:el.getAttribute('aria-checked'),disabled:el.disabled})):[] } })()`)
}

async function answerNative(label) {
  await waitFor(() => instance.cdp.evaluate(`(() => { const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null); const option=pending?.querySelector('[role="radio"][aria-label=${JSON.stringify(label)}]'); if(!option||option.disabled)return false; option.click(); return true })()`), 30_000)
  await waitFor(() => instance.cdp.evaluate(`(() => { const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null); if(!pending)return false; const button=[...pending.querySelectorAll('button')].find(el=>/^(提交|Submit|Next|下一题|继续)$/i.test(el.textContent.trim())&&!el.disabled); if(!button)return false; button.click(); return true })()`), 30_000)
}

async function records(sessionId) { return rpc(sessionId, 'records', 'records') }
async function waitCase(sessionId, marker, predicate = () => true) {
  return waitFor(async () => { const page = await records(sessionId); const item = page.records.find(value => value.request?.questions?.some(question => question.id === marker || String(question.question).includes(marker))); return item && predicate(item) ? item : null }, 90_000)
}
async function record(sessionId, phase, caseId) { return rpc(sessionId, phase, 'record', { caseId }) }

async function cardState(caseId) {
  return instance.cdp.evaluate(`(() => { const cards=[...document.querySelectorAll('[data-weir-decision-card=${JSON.stringify(caseId)}]')].filter(el=>el.offsetParent!==null); return {cards:cards.length,forms:cards.reduce((sum,card)=>sum+card.querySelectorAll('form.weir-da-answers').length,0),nativeHints:cards.reduce((sum,card)=>sum+card.querySelectorAll('[data-native-answer]').length,0),text:cards.map(card=>card.innerText).join('\\n---\\n')} })()`)
}

async function scanSession(sessionId, path) {
  const scan = await instance.cdp.evaluate(`window.__decisionQA.fixture('scanSession', ${JSON.stringify({ sessionId })})`)
  writeJson(join(out, path), scan)
  return scan
}

async function openRecord(sessionId, caseId) {
  await openPage('records')
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('.weir-da-record-list [data-case-id=${JSON.stringify(caseId)}]'))`), 30_000)
  await click(`.weir-da-record-list [data-case-id="${caseId}"]`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-record-detail=${JSON.stringify(caseId)}]'))`), 30_000)
  return record(sessionId, 'record-open', caseId)
}

async function openDisclosure(id) {
  const selector = `button[aria-controls="${id}-content"]`
  const expanded = await instance.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded')`)
  if (expanded !== 'true') await click(selector)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('#${id}-content'))`), 30_000)
}

async function recordDom(caseId) {
  return instance.cdp.evaluate(`(() => { const detail=document.querySelector('[data-record-detail=${JSON.stringify(caseId)}]'); if(!detail)return null; const advanced=detail.querySelector('.weir-da-advanced-record'); return {caseId:detail.getAttribute('data-record-detail'),defaultText:[...detail.childNodes].filter(node=>!(node instanceof HTMLElement&&node.classList.contains('weir-da-disclosure'))).map(node=>node.textContent).join('\\n'),text:detail.innerText,currentEvidence:detail.querySelector('[data-current-evidence]')?.innerText??'',advancedText:advanced?.innerText??'',editableHistory:detail.querySelector('.weir-da-record-answers')?.querySelectorAll('input,textarea,[contenteditable="true"]').length??-1} })()`)
}

async function compareRecord(sessionId, phase, caseId, advanced = false) {
  const authority = await record(sessionId, phase, caseId)
  const dom = await recordDom(caseId)
  if (advanced) await openDisclosure(`weir-da-record-advanced-${caseId}`)
  const withAdvanced = advanced ? await recordDom(caseId) : { ...dom, advancedText: JSON.stringify(authority) }
  const problems = recordProjectionProblems(authority, withAdvanced)
  comparisons.push({ phase, kind: 'record', caseId, revision: authority.case.revision, state: authority.case.state, closing: authority.case.closing, answers: authority.case.decision?.answers ?? null, dom, advanced, problems })
  writeJson(join(out, 'rpc-ui-comparisons.json'), comparisons)
  check(`${phase}RecordMatchesRpc`, problems.length === 0 && withAdvanced.editableHistory === 0, { caseId, revision: authority.case.revision, problems })
  return { authority, dom: withAdvanced }
}

async function feedback(sessionId, caseId, verb) {
  await click(`[data-record-detail="${caseId}"] [data-feedback="${verb}"]`)
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
    const tables = ['agent_profiles', 'agent_profile_revisions', 'cases', 'attempts', 'evidence', 'attempt_evidence', 'feedback', 'corrections', 'learning_runs', 'memory_snapshots', 'selectors']
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
  await click(`[data-agent-detail="${agent.agentId}"] [data-action="learning-start"]`)
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
  requireEvidence(starts.length === beforeCalls + 1, 'one learningStart per explicit click')
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
  await click(`[data-action="${action}"]`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('#${dialog}'))`), 30_000)
  const confirmation = await instance.cdp.evaluate(`document.querySelector('#${dialog}').innerText`)
  requireEvidence(/只影响|历史|future|history/i.test(confirmation), `${kind} consequence confirmation`)
  accessibility[`${kind}Dialog`] = await instance.cdp.accessibility(`#${dialog}`)
  await shot(`${kind}-v${candidate.snapshot.version}-confirm`)
  await click(`#${dialog} .weir-da-actions button:last-child`)
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
  check(`visual-${name}`, problems.length === 0 && Math.abs((audit.viewport.scale ?? 1) - zoom) < 0.01, { problems, viewport: audit.viewport, colors: audit.colors })
  await shot(`visual-${name}`)
  return row
}

async function keyboardSelector(sessionId, agentId) {
  await openSession(instance, sessionId)
  await instance.cdp.evaluate(`document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]').focus()`)
  accessibility.selectorTrigger = await instance.cdp.accessibility('[data-weir-decision-trigger="weir-decision-selector"]')
  await instance.cdp.key('Enter')
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-selector-panel"))'), 30_000)
  accessibility.selectorPanel = await instance.cdp.accessibility('#weir-da-selector-panel')
  await shot('keyboard-selector-open')
  await instance.cdp.key('Escape')
  await waitFor(() => instance.cdp.evaluate(`!document.querySelector('#weir-da-selector-panel') && document.activeElement===document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')`), 30_000)
  await instance.cdp.key('Enter')
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("#weir-da-selector-panel"))'), 30_000)
  const reached = await waitFor(async () => {
    const active = await instance.cdp.evaluate(`document.activeElement?.matches('input[type="radio"][value=${JSON.stringify(agentId)}]')`)
    if (active) return true
    await instance.cdp.key('Tab')
    return null
  }, 15_000).catch(() => false)
  check('keyboardReachesAgentRadio', reached)
  await instance.cdp.key('Space')
  await waitFor(() => instance.cdp.evaluate('!document.querySelector("#weir-da-selector-panel")'), 30_000)
  const selected = await waitFor(async () => { const value = await rpc(sessionId, 'keyboard', 'overview'); return value.selector?.agentId === agentId ? value : null }, 30_000)
  await expectMutation('setSelector', { sessionId, mode: 'agent', agentId })
  check('keyboardSelectionAndFocusReturn', selected.selector.agentId === agentId && await instance.cdp.evaluate(`document.activeElement===document.querySelector('[data-weir-decision-trigger="weir-decision-selector"]')`))
  writeJson(join(out, 'accessibility.json'), accessibility)
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
  await clickText(article, ['使用建议', 'Use suggestions'])
  const filled = await instance.cdp.evaluate(`(() => { const article=document.querySelector(${JSON.stringify(article)}); return {checked:[...article.querySelectorAll('input[type="radio"],input[type="checkbox"]')].filter(el=>el.checked).map(el=>el.value),texts:[...article.querySelectorAll('textarea')].map(el=>el.value),busy:article.querySelector('form')?.getAttribute('aria-busy')} })()`)
  const stillPending = await record(sessionId, 'suggestion-fill', caseId)
  check(`${shotName}SuggestionOnlyFills`, stillPending.case.state === 'awaiting_user' && filled.checked.length > 0 && filled.busy !== 'true', filled)
  await shot(`${shotName}-suggestion-filled`)
  await clickText(article, ['提交决定', 'Submit decision'])
  const closed = await waitFor(async () => { const value = await record(sessionId, 'inbox-decide', caseId); return value.case.state === 'closed' ? value : null }, 30_000)
  await expectMutation('decide', { sessionId, caseId, answers: closed.case.decision.answers })
  check(`${shotName}InboxDecisionMatchesAuthority`, closed.case.closing === 'escalated' && closed.case.decision.kind === 'user_decision', { caseId, answers: closed.case.decision.answers })
  await shot(`${shotName}-answered`)
  return closed
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
    '- 所有 selector、助手、决定、反馈、纠正、整理、采用、放弃、恢复写操作均由真实 UI 触发；无 Auto、自动整理或自动发布。', '',
    '## 视觉、主题、缩放、键盘与可访问性', '',
    `- 已执行 ${visualAudits.length} 项视觉审计；目标为 360/768/1440 CSS px、light/dark、200% page scale，记录横向溢出、主操作裁切、控件名称与主题计算色。`,
    `- 已保存 ${Object.keys(accessibility).length} 组 CDP Accessibility 证据；键盘流包含 Enter/Tab/Space/Escape 和焦点返回。`,
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

try {
  check('portInitiallyFree', await portFree() && !portListeners())
  writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'running' })
  prepareProfile(root, PORT)
  instance = await startDesktop(true)
  const created = await createSession(instance)
  const sessionId = created.sessionId
  writeJson(join(out, 'session.json'), created)
  const slots = await instance.cdp.evaluate('window.__decisionQA.getState()')
  writeJson(join(out, 'slots.json'), slots)
  check('newSlotsActive', slots.sidebar.includes('weir-decisions') && slots.main.includes('weir-decisions') && slots.composer.includes('weir-decision-selector') && slots.toolviews.includes('ask_user_question') && slots.toolviews.includes('decision_consult'), slots)
  await selectorOpen()
  const initialSelector = await instance.cdp.evaluate(`(() => { const panel=document.querySelector('#weir-da-selector-panel'); return {text:panel.innerText,radios:[...panel.querySelectorAll('input[type="radio"]')].map(el=>({value:el.value,name:el.getAttribute('aria-label')})),legacy:Boolean(document.querySelector('select[data-weir-decision-selector]')),auto:/\\bAuto\\b|自动路由/.test(panel.innerText)} })()`)
  check('dedicatedEmptySelectorOnlyOff', !initialSelector.legacy && !initialSelector.auto && initialSelector.radios.length === 1 && initialSelector.radios[0].value === 'off', initialSelector)
  await shot('01-selector-empty')
  await clickText('#weir-da-selector-panel', ['新建助手', 'New assistant'])
  const longName = '桌面验收助手 · Decision Product QA with an intentionally long English assistant name'
  const preference = '只依据可核验证据；高风险操作仍由用户决定。Prefer source-backed concise answers and preserve the existing approval boundary. 这是用于长文本与编辑验收的用户原创判断偏好。'
  await fillAgent(longName, preference)
  let agents = await waitFor(async () => { const value = await rpc(sessionId, 'initial-create', 'agents'); return value.some(agent => agent.name === longName) ? value : null }, 30_000)
  const primary = agents.find(agent => agent.name === longName)
  await expectMutation('profileUpsert', { sessionId, name: longName, userDescription: preference })
  check('selectorCreateUsesNewPage', primary.state === 'enabled' && primary.scope?.workspaces?.includes(LANE), { agentId: primary.agentId })
  const secondary = await createAgent(sessionId, '空候选与键盘备用助手 · Empty review assistant', 'No existing decisions: the isolated fixture returns no candidate operations for this assistant only.')
  await openAgent(sessionId, primary.agentId)
  await click(`[data-agent-detail="${primary.agentId}"] [data-action="edit-agent"]`)
  const editedName = `${longName} · 已编辑 / edited`
  const editedPreference = `${preference} 编辑后仍保持相同 scope 与模型继承。`
  await fillAgent(editedName, editedPreference)
  const edited = await waitAgent(sessionId, primary.agentId, value => value.name === editedName && value.userDescription?.text === editedPreference)
  await expectMutation('profileUpsert', { sessionId, agentId: primary.agentId, name: editedName, userDescription: editedPreference, scope: primary.scope, modelRoute: primary.modelRoute })
  check('assistantEditPreservesIdentity', edited.agentId === primary.agentId && edited.revision > primary.revision, { agentId: edited.agentId, before: primary.revision, after: edited.revision })
  await shot('02-assistant-edited')
  await openSession(instance, sessionId)
  await selectorOpen()
  await clickText('#weir-da-selector-panel', ['管理助手', 'Manage assistants'])
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
  await instance.cdp.key('Escape')
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
  await setInput(instance, `[data-record-detail="${first.caseId}"] [data-draft="comment"]`, note)
  await setInput(instance, `[data-record-detail="${first.caseId}"] [data-draft="correction"]`, correction)
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
  await click(`[data-record-detail="${first.caseId}"] [data-action="comment"]`)
  const commented = await waitFor(async () => { const value = await record(sessionId, 'comment', first.caseId); return value.feedback.some(item => item.kind === 'comment' && item.payload?.text === note) ? value : null }, 30_000)
  await expectMutation('feedback', { sessionId, caseId: first.caseId, verb: 'comment', payload: { text: note } })
  const correctionKept = await instance.cdp.evaluate(`document.querySelector('[data-record-detail=${JSON.stringify(first.caseId)}] [data-draft="correction"]').value`)
  check('noteDoesNotConsumeCorrectionDraft', commented.case.feedbackState === 'none' && correctionKept === correction)
  await click(`[data-record-detail="${first.caseId}"] [data-action="correction"]`)
  const corrected = await waitFor(async () => { const value = await record(sessionId, 'correction', first.caseId); return value.feedback.some(item => item.kind === 'correction' && item.payload?.direction === correction) ? value : null }, 30_000)
  await expectMutation('correction', { sessionId, caseId: first.caseId, direction: correction, scope: firstRecord.authority.case.scope, supersedes: [first.caseId] })
  check('correctionAppendsWithoutHistoryRewrite', corrected.case.decision.answers[0].selected[0] === 'Use Short' && corrected.feedback.some(item => item.kind === 'correction'))
  await shot('17-note-and-correction-authority')
  await openSession(instance, sessionId)
  await submitMarker(instance, 'GUI_B_CORRECTED')
  const correctedAnswer = await waitCase(sessionId, 'gui-b-corrected', current => current.state === 'closed')
  const correctedDetail = await record(sessionId, 'corrected-answer', correctedAnswer.caseId)
  check('correctionAffectsOnlyFutureAnswer', correctedAnswer.decision?.answers?.[0]?.selected?.[0] === 'Use Long' && correctedDetail.attempts.at(-1).evidence.some(ref => ref.source === 'user_correction'))

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
    await instance.cdp.setViewport(width)
    await instance.cdp.setPageZoom(2)
    await layoutAudit(`zoom200-${width}`, 'light', 2)
  }
  await instance.cdp.setPageZoom(1)
  await instance.cdp.setViewport(360)
  await keyboardSelector(sessionId, secondary.agentId)
  await keyboardSelector(sessionId, primary.agentId)
  await instance.cdp.setViewport(1440)
  await answerInboxWithSuggestions(sessionId, longCase.caseId, '18-long-inbox')
  accessibility.longRecord = await instance.cdp.accessibility(`article[data-case-id="${longCase.caseId}"]`).catch(() => null)
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
  await click(`[data-agent-detail="${secondary.agentId}"] [data-action="learning-start"]`)
  const noChangeAgent = await waitAgent(sessionId, secondary.agentId, value => value.learningRuns.length > 0)
  const noChangeRun = await rpc(sessionId, 'no-change', 'learningRun', { learningRunId: noChangeAgent.learningRuns[0].learningRunId })
  const noChangeDom = await waitFor(async () => { const value = await governanceState(secondary.agentId); return value && /没有可整理的新原则|No new principles/.test(value.text) ? value : null }, 30_000)
  check('learningNoChangeTruthfulAndNoSnapshotActions', noChangeRun.outcome === 'failed' && noChangeRun.replay?.detail === 'NO_CANDIDATE_CHANGES' && noChangeRun.operations.length === 0 && noChangeAgent.snapshots.length === 0 && !noChangeDom.controls.some(control => ['learning-publish', 'learning-reject'].includes(control.action)), { runId: noChangeRun.learningRunId, outcome: noChangeRun.outcome })
  await shot('20-learning-no-change')
  writeJson(join(out, 'no-change-agent.json'), { enabled: false, agentId: secondary.agentId })

  const candidateV1 = await startCandidate(sessionId, primary, 1)
  requireEvidence(candidateV1.run.operations[0]?.sources?.[0] === learningSource.caseId, 'v1 source is the actual GUI learning Case')
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
  const publishedV2 = await confirmLearning('snapshotPublish', sessionId, candidateV2, candidateV1.snapshot.snapshotId)
  check('applyPublishesV2WithParent', publishedV2.snapshot.state === 'published' && publishedV2.snapshot.parentSnapshotId === candidateV1.snapshot.snapshotId)
  const rolledV2 = await confirmLearning('snapshotRollback', sessionId, { agent: publishedV2.agent, run: publishedV2.run, snapshot: publishedV2.snapshot }, candidateV1.snapshot.snapshotId)
  check('restoreReturnsToV1WithoutRewritingV2', rolledV2.snapshot.state === 'rolled_back' && rolledV2.snapshot.revision === 3 && rolledV2.agent.currentSnapshotId === candidateV1.snapshot.snapshotId)
  const candidateV3 = await startCandidate(sessionId, primary, 3)
  const rejectedV3 = await confirmLearning('snapshotReject', sessionId, candidateV3, candidateV1.snapshot.snapshotId)
  check('discardRetainsUnpublishedCandidateAndCurrentV1', rejectedV3.run.outcome === 'rejected' && rejectedV3.snapshot.state === 'draft' && rejectedV3.snapshot.revision === 1 && rejectedV3.agent.currentSnapshotId === candidateV1.snapshot.snapshotId)
  const beforeRestart = { agent: rejectedV3.agent, run: rejectedV3.run, snapshot: rejectedV3.snapshot, learned: learnedDetail, selector: await rpc(sessionId, 'before-restart', 'overview') }
  writeJson(join(out, 'before-restart.json'), beforeRestart)
  const scanBefore = await scanSession(sessionId, 'session-before-restart.json')
  check('noCommandOrCustomDecisionSessionEvents', scanBefore.commandEvents.length === 0 && scanBefore.customDecisionEvents.length === 0)

  await stopOwned('process-1')
  instance = await startDesktop(false)
  await openSession(instance, sessionId)
  await selectorOpen()
  const globalOff = await instance.cdp.evaluate(`document.querySelector('#weir-da-selector-panel').innerText`)
  check('globalOffExplainsBypassAndRetainsPinnedSelection', /全局关闭|off globally/i.test(globalOff) && beforeRestart.selector.selector?.agentId === primary.agentId, globalOff)
  await shot('23-restart-global-off')
  await instance.cdp.key('Escape')
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
  const beforeGlobalOff = await records(sessionId)
  await openSession(instance, sessionId)
  await submitMarker(instance, 'GUI_C_OFF')
  await waitFor(async () => (await nativeState()).pending, 30_000)
  await answerNative('Native Off')
  const afterGlobalOff = await records(sessionId)
  check('globalOffCreatesNoNewCase', afterGlobalOff.records.length === beforeGlobalOff.records.length)
  const scanAfter = await scanSession(sessionId, 'session-after-restart.json')
  check('restartAddsNoForbiddenSessionEvents', scanAfter.commandEvents.length === 0 && scanAfter.customDecisionEvents.length === 0)
  await stopOwned('process-2')
  sqliteSnapshot('final-stopped')
  copyFileSync(databasePath, join(out, 'decision.db'))
  const immutable = immutableChanges(sqlitePhases)
  writeJson(join(out, 'immutable-history.json'), { pass: immutable.length === 0, changes: immutable, phases: sqlitePhases.map(item => item.phase) })
  check('noAttemptOrSnapshotContentHistoryRewrite', immutable.length === 0, immutable)
  const exceptions = runtimeEvents.filter(item => item.event.method === 'Runtime.exceptionThrown')
  const consoleErrors = runtimeEvents.filter(item => item.event.method === 'Runtime.consoleAPICalled' && item.event.params?.type === 'error')
  const desktopLog = readFileSync(join(out, 'desktop-enabled.log'), 'utf8')
  const importFailures = desktopLog.split('\n').filter(line => /failed to import weir-harness|SessionFormatUnsupportedError|slot entry crashed/i.test(line))
  writeJson(join(out, 'runtime-scan.json'), { exceptionCount: exceptions.length, exceptions, consoleErrorCount: consoleErrors.length, consoleErrors, importFailures })
  check('noRuntimeExceptionsConsoleErrorsOrSlotCrashes', exceptions.length === 0 && consoleErrors.length === 0 && importFailures.length === 0, { exceptions: exceptions.length, consoleErrors: consoleErrors.length, importFailures })
  await collectNetwork()
  check('completeLifecyclePngEvidence', screenshots.length >= 30 && screenshots.every(item => statSync(item.path).size > 8), { count: screenshots.length })
  result = { phase: 'GUI-product-UX-8.1-8.2', verdict: 'PASS', pass: true, runId, root, out, port: PORT, sessionId, primaryAgentId: primary.agentId, secondaryAgentId: secondary.agentId, caseIds: { first: first.caseId, reuse: reuse.caseId, consult: consult.caseId, long: longCase.caseId, learned: learned.caseId }, checks, checkDetails, screenshots, comparisons, cleanupReceipts: cleanups.map(item => join(out, `${item.label}-exact-pid-cleanup.json`)), artifacts: { networkRpc: join(out, 'network-rpc.json'), authoritativeRpc: join(out, 'authoritative-rpc.json'), runtime: join(out, 'runtime-scan.json'), visual: join(out, 'visual-audits.json'), accessibility: join(out, 'accessibility.json'), immutable: join(out, 'immutable-history.json'), database: join(out, 'decision.db'), report: join(out, 'evidence-zh.md') } }
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

if (failure) {
  console.error(failure)
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ phase: result.phase, verdict: result.verdict, checks: Object.keys(checks).length, screenshots: screenshots.length, rpc: networkRpc.length, out }, null, 2))
}
