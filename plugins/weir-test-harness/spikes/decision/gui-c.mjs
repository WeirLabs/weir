// GUI-C: management views/filters, native authority bypass, fresh Off and settings activation.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  LANE, QA, PHASES, writeJson, guardedRemove, prepareProfile, startInstance, stopInstance,
  cdpScreenshot, decision, createSession, openSession, setInput, clickButton,
  selectDecisionTab, createAgent, setSelector, submitMarker, records, waitCase,
  exportRecord,
} from './gui-qa.mjs'
import { waitFor } from './cdp.mjs'

function check(checks, name, value) {
  checks[name] = Boolean(value)
  if (!value) throw new Error(`GUI-C check failed: ${name}`)
}

async function nativeState(instance) {
  return instance.cdp.evaluate(`(() => {
    const visible=el=>Boolean(el&&el.offsetParent!==null)
    const pending=[...document.querySelectorAll('[data-question-key]')].find(visible)
    return {pending:Boolean(pending),text:pending?.innerText??'',radios:pending?[...pending.querySelectorAll('[role="radio"]')].map(el=>el.getAttribute('aria-label')):[]}
  })()`)
}

async function answerNative(instance, label) {
  await waitFor(() => instance.cdp.evaluate(`(() => { const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null); const option=pending?.querySelector('[role="radio"][aria-label=${JSON.stringify(label)}]'); if(!option||option.disabled)return false; option.click(); return true })()`), 30_000)
  await waitFor(() => instance.cdp.evaluate(`(() => { const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null); if(!pending)return false; const button=[...pending.querySelectorAll('button')].find(el=>/^(提交|Submit|Next|下一题|继续)$/i.test(el.textContent.trim())&&!el.disabled); if(!button)return false; button.click(); return true })()`), 30_000)
}
async function planReviewState(instance) {
  return instance.cdp.evaluate(`(() => { const pending=[...document.querySelectorAll('[data-plan-review-key]')].find(el=>el.offsetParent!==null); return {pending:Boolean(pending),text:pending?.innerText??'',title:pending?.querySelector('section')?.getAttribute('aria-label')??'',actions:pending?[...pending.querySelectorAll('button')].map(el=>el.textContent.trim()).filter(Boolean):[]} })()`)
}

async function answerPlanReview(instance) {
  await waitFor(() => instance.cdp.evaluate(`(() => { const pending=[...document.querySelectorAll('[data-plan-review-key]')].find(el=>el.offsetParent!==null); const button=[...pending.querySelectorAll('button')].find(el=>['同意执行','Accept','Approve'].includes(el.textContent.trim())&&!el.disabled); if(!button)return false; button.click(); return true })()`), 30_000)
}
const NATIVE_AUTHORITY_QUESTIONS = {
  GUI_C_APPROVAL: { id: 'gui-c-approval', question: 'Approve the GUI operation?', detail: 'Isolated GUI acceptance scope: approve or reject this native test operation.', options: [{ label: 'Approve' }, { label: 'Reject' }], intent: { kind: 'approval', approve: 'Approve', reject: 'Reject' } },
  GUI_C_PLAN: { id: 'gui-c-plan', question: 'Review the GUI plan?', detail: 'Isolated GUI acceptance scope: accept or revise this native test plan.', options: [{ label: 'Accept' }, { label: 'Revise' }], intent: { kind: 'plan-review', approve: 'Accept' } },
}

async function submitNativeAuthority(instance, sessionId, marker) {
  const question = NATIVE_AUTHORITY_QUESTIONS[marker]
  if (!question) throw new Error(`Unknown native authority marker: ${marker}`)
  await instance.cdp.evaluate(`(() => { const state={settled:false,value:null,error:null}; window.__decisionQaNativeAuthority=state; window.__decisionQA.fixture('askNative', {sessionId:${JSON.stringify(sessionId)},questions:[${JSON.stringify(question)}]}).then(value=>{state.value=value;state.settled=true},error=>{state.error=error?.message??String(error);state.settled=true}); return true })()`)
}

async function waitNativeAuthority(instance) {
  const state = await waitFor(() => instance.cdp.evaluate('window.__decisionQaNativeAuthority?.settled ? window.__decisionQaNativeAuthority : null'), 30_000)
  if (state.error) throw new Error(`Native authority request failed: ${state.error}`)
  return state.value
}

async function openRecordDetail(instance, caseId) {
  await selectDecisionTab(instance, 1)
  const found = await waitFor(() => instance.cdp.evaluate(`(() => { const button=[...document.querySelectorAll('main button')].find(el=>el.offsetParent!==null&&el.textContent.startsWith(${JSON.stringify(caseId)})); if(!button)return false; button.click(); return true })()`), 30_000)
  if (!found) throw new Error(`Record button not found: ${caseId}`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-readonly-record=${JSON.stringify(caseId)}]'))`), 30_000)
}

async function recordAction(instance, caseId, labels) {
  const clicked = await instance.cdp.evaluate(`(() => { const detail=document.querySelector('[data-readonly-record=${JSON.stringify(caseId)}]'); const button=[...detail.querySelectorAll('button')].find(el=>${JSON.stringify(labels)}.includes(el.textContent.trim())&&!el.disabled); if(!button)return false; button.click(); return button.textContent.trim() })()`)
  if (!clicked) throw new Error(`Record action ${labels.join('/')} not found`)
}

async function visibleRecordIds(instance) {
  return instance.cdp.evaluate(`[...document.querySelectorAll('main section button')].filter(el=>el.offsetParent!==null&&el.textContent.startsWith('dc_')).map(el=>el.textContent.split(' ')[0]).sort()`)
}

async function clearFilters(instance) {
  for (const key of ['agentId', 'state', 'outcome', 'reasonCode', 'scope', 'feedbackState']) {
    await setInput(instance, `input[aria-label="Filter ${key}"]`, '')
  }
  await clickButton(instance, ['Records', '决策记录'], 'main section')
  await waitFor(async () => { const ids = await visibleRecordIds(instance); return ids.length >= 5 ? ids : null }, 30_000)
}

async function applyFilter(instance, key, value) {
  await clearFilters(instance)
  await setInput(instance, `input[aria-label="Filter ${key}"]`, value)
  await clickButton(instance, ['Records', '决策记录'], 'main section')
  return waitFor(async () => {
    const ids = await visibleRecordIds(instance)
    if (!value) return ids
    if (key === 'scope' && value === 'not-a-real-scope') return ids.length === 0 ? ids : null
    if (key === 'scope') return ids.length >= 5 ? ids : null
    if (key === 'agentId') return ids.length === 4 ? ids : null
    if (key === 'state') return ids.length === 2 ? ids : null
    if (key === 'outcome' || key === 'reasonCode' || key === 'feedbackState') return ids.length === 1 ? ids : null
    return null
  }, 30_000)
}

async function rawDecision(instance, sessionId, method, args = {}) {
  return instance.cdp.evaluate(`window.__decisionQA.decision(${JSON.stringify(method)}, ${JSON.stringify({ sessionId, ...args })})`)
}

const DECISION_SETTINGS_LABELS = ['决策 Agent', 'Attempt 超时（毫秒）', 'Attempt 次数上限', '上下文预算（token）', '输出 token 上限', '并发 Attempt 上限', 'Agent 模型链（JSON）', '保留天数', '决策库目录']
async function openSettings(instance) {
  const opened = await instance.cdp.evaluate(`(() => { const button=[...document.querySelectorAll('button[aria-label="账号菜单"],button[aria-label="Account menu"]')].find(el=>el.offsetParent!==null); if(!button)return false; button.click(); return true })()`)
  if (!opened) throw new Error('Account menu launcher was not found')
  await waitFor(() => instance.cdp.evaluate(`(() => { const item=[...document.querySelectorAll('[role="menuitem"],button')].find(el=>el.offsetParent!==null&&/^(设置|Settings)(?:\\s|⌘|$)/.test(el.textContent.trim())); if(!item)return false; item.click(); return true })()`), 30_000)
  await waitFor(() => instance.cdp.evaluate('document.body.innerText.includes("当前版本") || document.body.innerText.includes("Current version")'), 30_000)
  const clicked = await instance.cdp.evaluate(`(() => { const root=document.querySelector('[role="dialog"]')??document; const button=[...root.querySelectorAll('button')].find(el=>el.offsetParent!==null&&el.textContent.trim()==='Weir'); if(!button)return false; button.click(); return true })()`)
  if (!clicked) throw new Error('Weir settings section was not reachable')
  await waitFor(() => instance.cdp.evaluate(`${JSON.stringify(DECISION_SETTINGS_LABELS)}.every(label=>document.body.innerText.includes(label))`), 60_000)
}

async function runC() {
  const root = `${QA}/desktop-c`
  const offRoot = `${QA}/desktop-c-off`
  const out = `${QA}/gui-c`
  for (const target of [root, offRoot, out]) guardedRemove(target, target)
  prepareProfile(root, PHASES.c)
  let instance = await startInstance({ root, out, port: PHASES.c, enabled: true })
  const checks = {}
  const events = []
  let sessionId
  const nativeEvidence = {}
  try {
    const session = await createSession(instance)
    sessionId = session.sessionId
    writeJson(`${out}/session.json`, session)
    const agentA = await createAgent(instance, sessionId, 'GUI-C Primary', 'For GUI title questions in this workspace, choose Concise when it is offered.')
    const agentB = await createAgent(instance, sessionId, 'GUI-C Secondary', '')
    writeJson(`${out}/agents.json`, [agentA, agentB])
    await openSession(instance, sessionId)
    const directPin = await decision(instance, sessionId, 'setSelector', { mode: 'agent', agentId: agentA.agentId })
    writeJson(`${out}/direct-pin-preflight.json`, directPin)
    await setSelector(instance, sessionId, 'off')
    await setSelector(instance, sessionId, 'agent', agentA.agentId)

    await submitMarker(instance, 'GUI_A_ANSWER')
    const answered = await waitCase(instance, sessionId, 'gui-a-answer', current => current.state === 'closed')
    check(checks, 'answeredFixture', answered.closing === 'answered')
    await openSession(instance, sessionId)
    await submitMarker(instance, 'GUI_B_NEW')
    const escalated = await waitCase(instance, sessionId, 'gui-b-new', current => current.state === 'awaiting_user')
    await answerNative(instance, 'Use Short')
    await waitCase(instance, sessionId, 'gui-b-new', current => current.state === 'closed')
    await openRecordDetail(instance, escalated.caseId)
    await recordAction(instance, escalated.caseId, ['Downvote', '踩'])
    await waitFor(async () => { const value = await decision(instance, sessionId, 'record', { caseId: escalated.caseId }); return value.case.feedbackState === 'disputed' ? value : null }, 30_000)

    await openSession(instance, sessionId)
    await submitMarker(instance, 'GUI_B_DECIDE')
    const waitingA = await waitCase(instance, sessionId, 'GUI_B_DECIDE', current => current.state === 'awaiting_user')
    await openSession(instance, sessionId)
    await submitMarker(instance, 'GUI_C_RETURN')
    const returned = await waitCase(instance, sessionId, 'GUI_C_RETURN', current => current.state === 'closed')
    check(checks, 'returnedFixture', returned.closing === 'returned' && returned.decision?.code === 'MISSING_CONTEXT')
    await openSession(instance, sessionId)
    await submitMarker(instance, 'GUI_B_REASSIGN')
    const waitingB = await waitCase(instance, sessionId, 'GUI_B_REASSIGN', current => current.state === 'awaiting_user')
    await decision(instance, sessionId, 'reassign', { caseId: waitingB.caseId, agentId: agentB.agentId })
    await waitFor(async () => { const value = await decision(instance, sessionId, 'record', { caseId: waitingB.caseId }); return value.case.agentId === agentB.agentId && value.case.state === 'awaiting_user' ? value : null }, 60_000)
    const allRecords = await records(instance, sessionId)
    const expectedIds = allRecords.records.map(item => item.caseId).sort()
    check(checks, 'fiveDistinctFilterFixtures', expectedIds.length === 5)

    await selectDecisionTab(instance, 0)
    const agentDetailClicked = await waitFor(() => instance.cdp.evaluate(`(() => { const button=[...document.querySelectorAll('main button')].find(el=>el.textContent.startsWith(${JSON.stringify(agentA.name)})); if(!button)return false; button.click(); return true })()`), 30_000)
    check(checks, 'agentProfileDetailOpens', agentDetailClicked)
    const agentText = await waitFor(async () => { const text = await instance.cdp.evaluate('document.querySelector("main").innerText'); return text.includes('generatedDescription') ? text : null }, 30_000)
    check(checks, 'generatedDescriptionEmptyReadonly', agentText.includes('generatedDescription') && /"revision":\s*0/.test(agentText) && /"text":\s*""/.test(agentText) && !agentText.includes('Edit generatedDescription'))
    await cdpScreenshot(instance, `${out}/page-agents.png`)

    await openRecordDetail(instance, answered.caseId)
    const readonly = await instance.cdp.evaluate(`(() => { const detail=document.querySelector('[data-readonly-record=${JSON.stringify(answered.caseId)}]'); return {json:detail.querySelector('pre')?.textContent??'',editable:detail.querySelector('pre')?.isContentEditable??true,textareas:detail.querySelectorAll('textarea').length,inputs:detail.querySelectorAll('input').length} })()`)
    check(checks, 'recordDetailReadonly', readonly.json.includes('"attempts"') && readonly.json.includes('"evidence"') && readonly.json.includes('"feedback"') && !readonly.editable && readonly.textareas === 0 && readonly.inputs === 1)
    await cdpScreenshot(instance, `${out}/page-records.png`)

    const filterResults = {}
    filterResults.agentId = await applyFilter(instance, 'agentId', agentA.agentId)
    check(checks, 'filterAgent', filterResults.agentId.length === 4 && !filterResults.agentId.includes(waitingB.caseId))
    filterResults.state = await applyFilter(instance, 'state', 'awaiting_user')
    check(checks, 'filterState', filterResults.state.sort().join(',') === [waitingA.caseId, waitingB.caseId].sort().join(','))
    filterResults.outcome = await applyFilter(instance, 'outcome', 'answer')
    check(checks, 'filterOutcome', filterResults.outcome.join(',') === answered.caseId)
    filterResults.reasonCode = await applyFilter(instance, 'reasonCode', 'MISSING_CONTEXT')
    check(checks, 'filterReason', filterResults.reasonCode.join(',') === returned.caseId)
    filterResults.scope = await applyFilter(instance, 'scope', LANE)
    check(checks, 'filterScope', filterResults.scope.sort().join(',') === expectedIds.join(','))
    filterResults.scopeNegative = await applyFilter(instance, 'scope', 'not-a-real-scope')
    check(checks, 'filterScopeNegative', filterResults.scopeNegative.length === 0)
    filterResults.feedbackState = await applyFilter(instance, 'feedbackState', 'disputed')
    check(checks, 'filterFeedback', filterResults.feedbackState.join(',') === escalated.caseId)
    writeJson(`${out}/filters.json`, filterResults)
    await cdpScreenshot(instance, `${out}/records-filtered.png`)
    await clearFilters(instance)

    await selectDecisionTab(instance, 2)
    const inboxText = await instance.cdp.evaluate('document.querySelector("main").innerText')
    check(checks, 'inboxViewUsable', inboxText.includes(waitingA.caseId) && inboxText.includes(waitingB.caseId) && /Decide|裁决/.test(inboxText) && /Reassign|改派/.test(inboxText) && /Retry|重试/.test(inboxText) && /Cancel|取消/.test(inboxText))
    await cdpScreenshot(instance, `${out}/page-inbox.png`)
    await selectDecisionTab(instance, 3)
    const metricsText = await instance.cdp.evaluate('document.querySelector("main").innerText')
    check(checks, 'metricsViewUsable', metricsText.includes('"casesOpened": 5') && metricsText.includes('Auto answer rate is diagnostic, not a quality metric.'))
    await cdpScreenshot(instance, `${out}/page-metrics.png`)
    const forbiddenButtons = await instance.cdp.evaluate(`[...document.querySelectorAll('main button')].map(el=>el.textContent.trim()).filter(text=>/consolidat|memory snapshot|auto route|整合|记忆快照|自动路由/i.test(text))`)
    check(checks, 'noP2P5ClickableFeatures', forbiddenButtons.length === 0)
    check(checks, 'exactlyThreePrimaryDestinations', await instance.cdp.evaluate('document.querySelectorAll("main nav button").length === 3'))

    await openSettings(instance)
    const settingsText = await instance.cdp.evaluate('document.body.innerText')
    writeJson(`${out}/settings-decision-group.json`, { text: settingsText })
    check(checks, 'settingsDecisionGroupVisible', DECISION_SETTINGS_LABELS.every(label => settingsText.includes(label)))
    await waitFor(() => instance.cdp.evaluate(`(() => { const root=document.querySelector('[role="dialog"]')??document; const el=[...root.querySelectorAll('*')].find(el=>el.offsetParent!==null&&el.children.length===0&&el.textContent.trim()==='决策 Agent'); if(!el)return false; el.scrollIntoView({block:'center'}); return true })()`), 30_000)
    await cdpScreenshot(instance, `${out}/settings-decision-group.png`)
    await instance.cdp.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await instance.cdp.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })

    await openSession(instance, sessionId)
    await submitNativeAuthority(instance, sessionId, 'GUI_C_APPROVAL')
    nativeEvidence.enabledApproval = await waitFor(async () => { const value = await nativeState(instance); return value.pending ? value : null }, 30_000)
    check(checks, 'enabledApprovalNative', nativeEvidence.enabledApproval.radios.join(',') === 'Approve,Reject')
    await cdpScreenshot(instance, `${out}/enabled-approval.png`)
    await answerNative(instance, 'Approve')
    await waitNativeAuthority(instance)
    await openSession(instance, sessionId)
    await submitNativeAuthority(instance, sessionId, 'GUI_C_PLAN')
    nativeEvidence.enabledPlan = await waitFor(async () => { const value = await planReviewState(instance); return value.pending ? value : null }, 30_000)
    check(checks, 'enabledPlanNative', nativeEvidence.enabledPlan.title === 'Review the GUI plan?' && nativeEvidence.enabledPlan.actions.includes('要求修改') && nativeEvidence.enabledPlan.actions.includes('同意执行'))
    await cdpScreenshot(instance, `${out}/enabled-plan.png`)
    await answerPlanReview(instance)
    await waitNativeAuthority(instance)
    const afterAuthority = await records(instance, sessionId)
    check(checks, 'authorityBypassCreatesNoCases', afterAuthority.records.length === 5)

    events.push(...instance.cdp.events)
    await stopInstance(instance, `${out}/enabled-cleanup.json`)
    instance = null
    prepareProfile(offRoot, PHASES.c)
    instance = await startInstance({ root: offRoot, out, port: PHASES.c, enabled: false })
    const offSession = await createSession(instance)
    writeJson(`${out}/off-session.json`, offSession)
    await submitMarker(instance, 'GUI_C_OFF')
    nativeEvidence.offOrdinary = await waitFor(async () => { const value = await nativeState(instance); return value.pending ? value : null }, 30_000)
    await cdpScreenshot(instance, `${out}/off-ordinary.png`)
    await answerNative(instance, 'Native Off')
    await openSession(instance, offSession.sessionId)
    await submitNativeAuthority(instance, offSession.sessionId, 'GUI_C_APPROVAL')
    nativeEvidence.disabledApproval = await waitFor(async () => { const value = await nativeState(instance); return value.pending ? value : null }, 30_000)
    await cdpScreenshot(instance, `${out}/disabled-approval.png`)
    await answerNative(instance, 'Approve')
    await waitNativeAuthority(instance)
    await openSession(instance, offSession.sessionId)
    await submitNativeAuthority(instance, offSession.sessionId, 'GUI_C_PLAN')
    nativeEvidence.disabledPlan = await waitFor(async () => { const value = await planReviewState(instance); return value.pending ? value : null }, 30_000)
    await cdpScreenshot(instance, `${out}/disabled-plan.png`)
    await answerPlanReview(instance)
    await waitNativeAuthority(instance)
    writeJson(`${out}/native-authority.json`, nativeEvidence)
    check(checks, 'approvalTextIdenticalEnabledDisabled', nativeEvidence.enabledApproval.text === nativeEvidence.disabledApproval.text)
    check(checks, 'planTextIdenticalEnabledDisabled', nativeEvidence.enabledPlan.text === nativeEvidence.disabledPlan.text)

    const decisionsDir = `${offRoot}/home/weir/profiles/desktop/decisions`
    const profileDir = `${offRoot}/home/profiles/desktop`
    const ls = spawnSync('ls', ['-la', profileDir], { encoding: 'utf8' })
    writeJson(`${out}/off-ls.json`, { command: `ls -la ${profileDir}`, status: ls.status, stdout: ls.stdout, stderr: ls.stderr, decisionsDirectory: decisionsDir, decisionsExists: existsSync(decisionsDir) })
    check(checks, 'freshOffCreatesNoDatabase', !existsSync(decisionsDir))
    const offInbox = await rawDecision(instance, offSession.sessionId, 'inbox')
    writeJson(`${out}/off-inbox.json`, offInbox)
    check(checks, 'freshOffInboxUnavailableWithoutCases', offInbox?.value?.ok === false && offInbox.value.error.code === 'DECISION_UNAVAILABLE')
    const offRecords = await rawDecision(instance, offSession.sessionId, 'records')
    writeJson(`${out}/off-records.json`, offRecords)
    check(checks, 'freshOffRecordsUnavailableWithoutCases', offRecords?.value?.ok === false)
    check(checks, 'freshOffNativeFlowsComplete', nativeEvidence.offOrdinary.radios.join(',') === 'Native Off,Automatic' && nativeEvidence.disabledApproval.pending && nativeEvidence.disabledPlan.pending)
    events.push(...instance.cdp.events)
    check(checks, 'noRuntimeExceptions', !events.some(event => event.method === 'Runtime.exceptionThrown'))
    writeJson(`${out}/runtime-events.json`, events)
    const pass = Object.values(checks).every(Boolean)
    writeJson(`${out}/result.json`, { phase: 'GUI-C', pass, checks, sessionId, offSessionId: offSession.sessionId })
    console.log(JSON.stringify({ phase: 'GUI-C', pass, checks }, null, 2))
    if (!pass) process.exitCode = 1
  } catch (error) {
    writeJson(`${out}/driver-error.json`, { message: error?.message ?? String(error), stack: error?.stack ?? null, checks })
    if (instance?.cdp) {
      await cdpScreenshot(instance, `${out}/failure.png`).catch(() => {})
      writeJson(`${out}/failure-dom.json`, await instance.cdp.evaluate('({text:document.body.innerText,html:document.body.innerHTML})').catch(() => null))
      writeJson(`${out}/runtime-events.json`, [...events, ...instance.cdp.events])
    }
    console.error(error)
    process.exitCode = 1
  } finally {
    if (instance) await stopInstance(instance, `${out}/final-cleanup.json`)
  }
}

await runC()
