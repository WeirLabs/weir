// GUI-B: escalation, authoritative reuse, feedback and inbox actions on real Desktop.
import {
  QA, PHASES, writeJson, guardedRemove, prepareProfile, startInstance, stopInstance,
  cdpScreenshot, decision, createSession, openSession, setInput, selectDecisionTab,
  createAgent, setSelector, submitMarker, waitCase, exportRecord, cardState,
} from './gui-qa.mjs'
import { waitFor } from './cdp.mjs'

function check(checks, name, value) {
  checks[name] = Boolean(value)
  if (!value) throw new Error(`GUI-B check failed: ${name}`)
}

async function nativeState(instance) {
  return instance.cdp.evaluate(`(() => {
    const visible=el=>Boolean(el&&el.offsetParent!==null)
    const pending=[...document.querySelectorAll('[data-question-key]')].find(visible)
    return {pending:Boolean(pending),text:pending?.innerText??'',radios:pending?[...pending.querySelectorAll('[role="radio"]')].map(el=>({label:el.getAttribute('aria-label'),checked:el.getAttribute('aria-checked'),disabled:el.disabled})):[]}
  })()`)
}

async function answerNative(instance, label) {
  await waitFor(() => instance.cdp.evaluate(`(() => { const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null); const option=pending?.querySelector('[role="radio"][aria-label=${JSON.stringify(label)}]'); if(!option||option.disabled)return false; option.click(); return true })()`), 30_000)
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null)
    if(!pending)return false
    const button=[...pending.querySelectorAll('button')].find(el=>/^(提交|Submit|Next|下一题|继续)$/i.test(el.textContent.trim())&&!el.disabled)
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
}

async function openRecordDetail(instance, caseId) {
  await selectDecisionTab(instance, 1)
  const found = await waitFor(() => instance.cdp.evaluate(`(() => { const button=[...document.querySelectorAll('main button')].find(el=>el.offsetParent!==null&&el.textContent.startsWith(${JSON.stringify(caseId)})); if(!button)return false; button.click(); return true })()`), 30_000)
  if (!found) throw new Error(`Record button not found: ${caseId}`)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-readonly-record=${JSON.stringify(caseId)}]'))`), 30_000)
}

async function recordAction(instance, caseId, labels) {
  const clicked = await instance.cdp.evaluate(`(() => { const detail=document.querySelector('[data-readonly-record=${JSON.stringify(caseId)}]'); const button=[...detail.querySelectorAll('button')].find(el=>${JSON.stringify(labels)}.includes(el.textContent.trim())&&!el.disabled); if(!button)return false; button.click(); return button.textContent.trim() })()`)
  if (!clicked) throw new Error(`Record action ${labels.join('/')} not found on ${caseId}`)
}

async function recordComment(instance, caseId, text, labels) {
  await setInput(instance, `[data-readonly-record="${caseId}"] input`, text)
  await recordAction(instance, caseId, labels)
}

async function inboxAction(instance, caseId, action, option) {
  await selectDecisionTab(instance, 2)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('article[data-case-id=${JSON.stringify(caseId)}]'))`), 30_000)
  if (option) {
    const selected = await instance.cdp.evaluate(`(() => {
      const article=document.querySelector('article[data-case-id=${JSON.stringify(caseId)}]')
      const select=${JSON.stringify(action)}==='decide'?article.querySelector('select'):[...article.querySelectorAll('select')].at(-1)
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(option)})
      select.dispatchEvent(new Event('change',{bubbles:true}))
      return select.value
    })()`)
    if (selected !== option) throw new Error(`Inbox select failed for ${caseId}: ${selected}`)
  }
  const labels = {
    decide: ['Decide', '裁决'], reassign: ['Reassign', '改派'],
    cancel: ['Cancel', '取消'], retry: ['Retry', '重试'],
  }[action]
  const clicked = await waitFor(() => instance.cdp.evaluate(`(() => { const article=document.querySelector('article[data-case-id=${JSON.stringify(caseId)}]'); const button=[...article.querySelectorAll('button')].find(el=>${JSON.stringify(labels)}.includes(el.textContent.trim())&&!el.disabled); if(!button)return false; button.click(); return true })()`), 30_000)
  if (!clicked) throw new Error(`Inbox action ${action} not found for ${caseId}`)
}

async function createConsult(instance, sessionId, marker) {
  await openSession(instance, sessionId)
  await submitMarker(instance, marker)
  return waitCase(instance, sessionId, marker, current => current.state === 'awaiting_user')
}

async function exportInbox(instance, sessionId, path) {
  const value = await decision(instance, sessionId, 'inbox')
  writeJson(path, value)
  return value
}

async function runB() {
  const root = `${QA}/desktop-b`
  const out = `${QA}/gui-b`
  guardedRemove(root, `${QA}/desktop-b`)
  guardedRemove(out, `${QA}/gui-b`)
  prepareProfile(root, PHASES.b)
  let instance = await startInstance({ root, out, port: PHASES.b, enabled: true })
  const checks = {}
  const events = []
  let sessionId
  try {
    const session = await createSession(instance)
    sessionId = session.sessionId
    writeJson(`${out}/session.json`, session)
    const agentA = await createAgent(instance, sessionId, 'GUI-B Direction', '')
    const agentB = await createAgent(instance, sessionId, 'GUI-B Alternate', '')
    writeJson(`${out}/agents.json`, [agentA, agentB])
    await openSession(instance, sessionId)
    const agentRead = await decision(instance, sessionId, 'agent', { agentId: agentA.agentId })
    writeJson(`${out}/agent-read-before-pin.json`, agentRead)
    const directPin = await decision(instance, sessionId, 'setSelector', { mode: 'agent', agentId: agentA.agentId })
    writeJson(`${out}/direct-pin-preflight.json`, directPin)
    await setSelector(instance, sessionId, 'off')
    await setSelector(instance, sessionId, 'agent', agentA.agentId)

    await submitMarker(instance, 'GUI_B_NEW')
    const first = await waitCase(instance, sessionId, 'gui-b-new', current => current.state === 'awaiting_user')
    const firstVisible = await waitFor(async () => {
      const native = await nativeState(instance)
      const card = await cardState(instance, first.caseId)
      return native.pending && native.radios.length === 2 && card.visible && card.text.includes(agentA.name) ? { native, card } : null
    }, 30_000)
    const firstNative = firstVisible.native
    const firstCard = firstVisible.card
    writeJson(`${out}/new-native-and-card.json`, firstVisible)
    check(checks, 'newHasNativeAndDecisionCards', firstNative.radios.length === 2 && firstCard.text.includes(agentA.name))
    await cdpScreenshot(instance, `${out}/new-native-and-card.png`)
    await answerNative(instance, 'Use Short')
    const firstClosed = await waitCase(instance, sessionId, 'gui-b-new', current => current.state === 'closed')
    check(checks, 'nativeDecisionClosedEscalated', firstClosed.closing === 'escalated' && firstClosed.decision?.kind === 'user_decision')
    await exportRecord(instance, sessionId, first.caseId, `${out}/record-new.json`)
    await cdpScreenshot(instance, `${out}/new-after-native-answer.png`)

    await openSession(instance, sessionId)
    await submitMarker(instance, 'GUI_B_REUSE')
    const reuse = await waitCase(instance, sessionId, 'gui-b-reuse', current => current.state === 'closed')
    check(checks, 'reuseAnswered', reuse.closing === 'answered' && reuse.decision?.answers?.[0]?.selected?.[0] === 'Use Short')
    const reuseDetail = await exportRecord(instance, sessionId, reuse.caseId, `${out}/record-reuse.json`)
    check(checks, 'reuseCitesOriginalUserDecision', reuseDetail.attempts.at(-1).evidence.some(ref => ref.source === 'user_decision' && ref.locator.kind === 'case' && ref.locator.caseId === first.caseId))
    check(checks, 'reuseHasNoConsolidation', reuseDetail.attempts.at(-1).pins.memorySnapshotId === null && reuseDetail.attempts.at(-1).packManifest.layerSizes.L2 === 0 && reuseDetail.attempts.at(-1).packManifest.layerSizes.L3 === 0)
    await cdpScreenshot(instance, `${out}/reuse-answer-card.png`)

    await openRecordDetail(instance, first.caseId)
    await cdpScreenshot(instance, `${out}/record-before-down.png`)
    await recordAction(instance, first.caseId, ['Downvote', '踩'])
    const downOriginal = await waitFor(async () => { const value = await decision(instance, sessionId, 'record', { caseId: first.caseId }); return value.case.feedbackState === 'disputed' && value.case.needsReview ? value : null }, 30_000)
    writeJson(`${out}/record-original-after-down.json`, downOriginal)
    check(checks, 'downImmediateDisputed', downOriginal.case.feedbackState === 'disputed' && downOriginal.case.needsReview)
    await cdpScreenshot(instance, `${out}/record-after-down.png`)

    await openSession(instance, sessionId)
    await submitMarker(instance, 'GUI_B_AFTER_DOWN')
    const afterDown = await waitCase(instance, sessionId, 'gui-b-after-down', current => current.state === 'awaiting_user')
    check(checks, 'afterDownEscalatesRatherThanAnswers', afterDown.state === 'awaiting_user' && !afterDown.decision)
    const afterDownNative = await waitFor(async () => { const value = await nativeState(instance); return value.pending ? value : null }, 30_000)
    check(checks, 'afterDownNativeVisible', afterDownNative.pending)
    await exportRecord(instance, sessionId, afterDown.caseId, `${out}/record-after-down.json`)
    await cdpScreenshot(instance, `${out}/after-down-native.png`)
    await answerNative(instance, 'Use Short')
    const afterDownClosed = await waitCase(instance, sessionId, 'gui-b-after-down', current => current.state === 'closed')
    check(checks, 'afterDownNativeAnswerIsNotOppositeInference', afterDownClosed.decision?.answers?.[0]?.selected?.[0] === 'Use Short')
    await openRecordDetail(instance, afterDown.caseId)
    await recordAction(instance, afterDown.caseId, ['Downvote', '踩'])
    await waitFor(async () => { const value = await decision(instance, sessionId, 'record', { caseId: afterDown.caseId }); return value.case.feedbackState === 'disputed' ? value : null }, 30_000)

    const retry = await createConsult(instance, sessionId, 'GUI_B_RETRY')
    const inboxBefore = await exportInbox(instance, sessionId, `${out}/inbox-before-restart.json`)
    check(checks, 'inboxBeforeRestartContainsRetry', inboxBefore.some(item => item.caseId === retry.caseId && item.state === 'awaiting_user'))
    await selectDecisionTab(instance, 2)
    await cdpScreenshot(instance, `${out}/inbox-before-restart.png`)

    events.push(...instance.cdp.events)
    const firstPid = instance.app.pid
    await stopInstance(instance, `${out}/restart-cleanup.json`)
    instance = null
    instance = await startInstance({ root, out, port: PHASES.b, enabled: true })
    check(checks, 'restartUsesNewProcess', instance.app.pid !== firstPid)
    await openSession(instance, sessionId)
    const selectedAfterRestart = await decision(instance, sessionId, 'overview')
    check(checks, 'selectorRestoredAfterFeedbackRestart', selectedAfterRestart.selector?.agentId === agentA.agentId)
    const downAfterRestart = await exportRecord(instance, sessionId, first.caseId, `${out}/record-original-after-restart.json`)
    check(checks, 'downPersistsRestart', downAfterRestart.case.feedbackState === 'disputed' && downAfterRestart.case.needsReview)
    const inboxAfter = await exportInbox(instance, sessionId, `${out}/inbox-after-restart.json`)
    check(checks, 'inboxPersistsRestart', inboxAfter.some(item => item.caseId === retry.caseId && item.state === 'awaiting_user'))
    await selectDecisionTab(instance, 2)
    await cdpScreenshot(instance, `${out}/inbox-after-restart.png`)

    await openRecordDetail(instance, first.caseId)
    await recordAction(instance, first.caseId, ['Undo rating', '撤销评分'])
    const undone = await waitFor(async () => { const value = await decision(instance, sessionId, 'record', { caseId: first.caseId }); return value.case.feedbackState === 'none' && !value.case.needsReview ? value : null }, 30_000)
    writeJson(`${out}/record-original-after-undo.json`, undone)
    check(checks, 'undoRestoresEligibility', undone.case.feedbackState === 'none' && undone.feedback.some(item => item.kind === 'rating_down') && undone.feedback.some(item => item.kind === 'undo_rating_down'))
    await cdpScreenshot(instance, `${out}/record-after-undo.png`)

    await openSession(instance, sessionId)
    await submitMarker(instance, 'GUI_B_AFTER_UNDO')
    const afterUndo = await waitCase(instance, sessionId, 'gui-b-after-undo', current => current.state === 'closed')
    check(checks, 'afterUndoAnswersOriginalDirection', afterUndo.closing === 'answered' && afterUndo.decision?.answers?.[0]?.selected?.[0] === 'Use Short')
    await exportRecord(instance, sessionId, afterUndo.caseId, `${out}/record-after-undo.json`)
    await cdpScreenshot(instance, `${out}/after-undo-answer.png`)

    await openRecordDetail(instance, first.caseId)
    await recordComment(instance, first.caseId, 'Neutral GUI audit comment only', ['Comment', '评论'])
    const commented = await exportRecord(instance, sessionId, first.caseId, `${out}/record-original-after-comment.json`)
    check(checks, 'commentDoesNotChangeState', commented.case.feedbackState === 'none' && !commented.case.needsReview && commented.feedback.some(item => item.kind === 'comment'))
    await cdpScreenshot(instance, `${out}/record-after-comment.png`)
    await openSession(instance, sessionId)
    await submitMarker(instance, 'GUI_B_AFTER_COMMENT')
    const afterComment = await waitCase(instance, sessionId, 'gui-b-after-comment', current => current.state === 'closed')
    check(checks, 'commentDoesNotChangeNextAnswer', afterComment.closing === 'answered' && afterComment.decision?.answers?.[0]?.selected?.[0] === 'Use Short')
    await exportRecord(instance, sessionId, afterComment.caseId, `${out}/record-after-comment.json`)

    await openRecordDetail(instance, first.caseId)
    await recordComment(instance, first.caseId, 'Use Long', ['Correct', '纠正'])
    const correctedOriginal = await exportRecord(instance, sessionId, first.caseId, `${out}/record-original-after-correction.json`)
    check(checks, 'correctionAppended', correctedOriginal.feedback.some(item => item.kind === 'correction'))
    await cdpScreenshot(instance, `${out}/record-after-correction.png`)
    await openSession(instance, sessionId)
    await submitMarker(instance, 'GUI_B_CORRECTED')
    const corrected = await waitCase(instance, sessionId, 'gui-b-corrected', current => current.state === 'closed')
    check(checks, 'correctionChangesNextAnswer', corrected.closing === 'answered' && corrected.decision?.answers?.[0]?.selected?.[0] === 'Use Long')
    const correctedDetail = await exportRecord(instance, sessionId, corrected.caseId, `${out}/record-corrected.json`)
    check(checks, 'correctionIsCited', correctedDetail.attempts.at(-1).evidence.some(ref => ref.source === 'user_correction' && ref.locator.kind === 'feedback'))
    await cdpScreenshot(instance, `${out}/corrected-answer.png`)

    const decide = await createConsult(instance, sessionId, 'GUI_B_DECIDE')
    await cdpScreenshot(instance, `${out}/decide-before.png`)
    await inboxAction(instance, decide.caseId, 'decide', 'User choice')
    const decided = await waitCase(instance, sessionId, 'GUI_B_DECIDE', current => current.state === 'closed')
    check(checks, 'inboxDecideWorks', decided.closing === 'escalated' && decided.decision?.kind === 'user_decision')
    await exportRecord(instance, sessionId, decide.caseId, `${out}/record-decide.json`)
    await cdpScreenshot(instance, `${out}/decide-after.png`)

    const reassign = await createConsult(instance, sessionId, 'GUI_B_REASSIGN')
    await inboxAction(instance, reassign.caseId, 'reassign', agentB.agentId)
    const reassigned = await waitFor(async () => { const value = await decision(instance, sessionId, 'record', { caseId: reassign.caseId }); return value.case.agentId === agentB.agentId && value.routeDecisions.some(route => route.mode === 'manual_reassign') ? value : null }, 60_000)
    writeJson(`${out}/record-reassign.json`, reassigned)
    check(checks, 'inboxReassignWorks', reassigned.case.agentId === agentB.agentId && reassigned.routeDecisions.some(route => route.mode === 'manual_reassign'))
    await cdpScreenshot(instance, `${out}/reassign-after.png`)
    await inboxAction(instance, reassign.caseId, 'decide', 'User choice')
    await waitCase(instance, sessionId, 'GUI_B_REASSIGN', current => current.state === 'closed')

    const cancel = await createConsult(instance, sessionId, 'GUI_B_CANCEL')
    await inboxAction(instance, cancel.caseId, 'cancel')
    const cancelled = await waitCase(instance, sessionId, 'GUI_B_CANCEL', current => current.state === 'closed')
    check(checks, 'inboxCancelWorks', cancelled.closing === 'cancelled' && cancelled.decision?.kind === 'cancelled')
    await exportRecord(instance, sessionId, cancel.caseId, `${out}/record-cancel.json`)
    await cdpScreenshot(instance, `${out}/cancel-after.png`)

    await inboxAction(instance, retry.caseId, 'retry')
    const retried = await waitFor(async () => { const value = await decision(instance, sessionId, 'record', { caseId: retry.caseId }); return value.case.attemptCount >= 2 ? value : null }, 60_000)
    writeJson(`${out}/record-retry.json`, retried)
    check(checks, 'inboxRetryAddsAttempt', retried.case.state === 'awaiting_user' && retried.case.attemptCount >= 2 && retried.attempts.length >= 2)
    await cdpScreenshot(instance, `${out}/retry-after.png`)
    await inboxAction(instance, retry.caseId, 'decide', 'User choice')
    await waitCase(instance, sessionId, 'GUI_B_RETRY', current => current.state === 'closed')

    const finalInbox = await exportInbox(instance, sessionId, `${out}/inbox-final.json`)
    // The inbox is profile-wide now: a clean end state means this scenario's own
    // Cases are gone, not that the profile carries no pending work elsewhere.
    const scenarioCaseIds = [first.caseId, afterDown.caseId, retry.caseId, decide.caseId, reassign.caseId, cancel.caseId]
    check(checks, 'inboxActionsLeaveNoPendingFixtures', finalInbox.every(item => !scenarioCaseIds.includes(item.caseId)), { pending: finalInbox.map(item => item.caseId), scenarioCaseIds })
    const scan = await instance.cdp.evaluate(`window.__decisionQA.fixture('scanSession', ${JSON.stringify({ sessionId })})`)
    writeJson(`${out}/session-scan.json`, scan)
    check(checks, 'noCommandOrCustomEvents', scan.commandEvents.length === 0 && scan.customDecisionEvents.length === 0)
    events.push(...instance.cdp.events)
    check(checks, 'noRuntimeExceptions', !events.some(event => event.method === 'Runtime.exceptionThrown'))
    writeJson(`${out}/runtime-events.json`, events)
    const pass = Object.values(checks).every(Boolean)
    writeJson(`${out}/result.json`, { phase: 'GUI-B', pass, checks, sessionId, firstCaseId: first.caseId, reuseCaseId: reuse.caseId })
    console.log(JSON.stringify({ phase: 'GUI-B', pass, checks }, null, 2))
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

await runB()
