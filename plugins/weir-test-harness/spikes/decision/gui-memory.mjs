// GUI-P2: neutral L3 memory and read-only Context Packs on a NEW isolated Desktop.
// Only the exact spawned main/Host PIDs are signalled. Never targets the current App.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LANE, writeJson, prepareProfile, startInstance, stopInstance, cdpScreenshot,
  createSession, openSession, selectDecisionTab, createAgent, setSelector,
  submitMarker, waitCase, exportRecord,
} from './gui-qa.mjs'
import { waitFor } from './cdp.mjs'

const PORT = 9465
const GUI = join(LANE, '.weir', 'decision-p2', 'gui')
mkdirSync(GUI, { recursive: true })
const root = mkdtempSync(join(GUI, 'desktop-memory-'))
const runId = basename(root).replace('desktop-memory-', '')
const out = join(GUI, `memory-${runId}`)
mkdirSync(out)
writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'running' })

const checks = {}
const events = []
const cleanups = []
let instance = null
let failure = null
let result = null

function check(name, value) {
  checks[name] = Boolean(value)
  if (!value) throw new Error(`GUI-P2 check failed: ${name}`)
}

function requireEvidence(value, message) {
  if (!value) throw new Error(`GUI-P2 evidence mismatch: ${message}`)
}

async function cdpPortFree() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
    return false
  } catch {
    return true
  }
}

function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat=,lstart=,args='], { encoding: 'utf8' })
  const stdout = ps.stdout?.trim() ?? ''
  const zombie = /^\s*\d+\s+\d+\s+\S*Z/i.test(stdout)
  return {
    pid,
    alive: ps.status === 0 && Boolean(stdout) && !zombie,
    status: ps.status,
    stdout,
    stderr: ps.stderr?.trim() ?? '',
    // Exclude pid/ppid/stat: a stopped main can reparent its Host child.
    signature: stdout.replace(/^\s*\d+\s+\d+\s+\S+\s+/, ''),
  }
}

function collectEvents(value, phase) {
  if (!value?.cdp) return
  const mainPid = value.app.pid
  for (const event of value.cdp.events) events.push({ phase, mainPid, event })
}

async function stopOwnedInstance(value, label) {
  const mainPid = value.app.pid
  const host = await value.cdp?.evaluate('window.__decisionQA?.fixture("hostState", {})').catch(() => null)
    ?? (existsSync(join(out, 'host.json')) ? JSON.parse(readFileSync(join(out, 'host.json'), 'utf8')) : null)
  const hostPid = host?.pid
  writeJson(join(out, `${label}-host.json`), host)
  const before = { main: processInfo(mainPid), host: processInfo(hostPid) }
  const base = await stopInstance(value, join(out, `${label}-cleanup-base.json`))
  let hostSignal = hostPid === mainPid ? 'covered-by-main' : 'not-needed'
  if (hostPid && hostPid !== mainPid && processInfo(hostPid)?.alive) {
    const current = processInfo(hostPid)
    if (!before.host?.alive || current.signature !== before.host.signature || host.parentPid !== mainPid || host.profile?.home !== join(root, 'home')) {
      throw new Error(`Refusing to signal changed or unowned Host PID ${hostPid}`)
    }
    process.kill(hostPid, 'SIGTERM')
    hostSignal = 'SIGTERM'
    try {
      await waitFor(() => !processInfo(hostPid)?.alive, 5000)
    } catch {
      const stillOwned = processInfo(hostPid)
      if (stillOwned?.alive && stillOwned.signature === before.host.signature) {
        process.kill(hostPid, 'SIGKILL')
        hostSignal = 'SIGTERM,SIGKILL'
        await waitFor(() => !processInfo(hostPid)?.alive, 5000)
      }
    }
  }
  const after = { main: processInfo(mainPid), host: processInfo(hostPid) }
  const receipt = {
    ...base,
    label,
    port: PORT,
    root,
    mainPid,
    hostPid,
    hostSignal,
    before,
    after,
    mainStopped: !after.main?.alive,
    hostStopped: !after.host?.alive,
    portReleased: await cdpPortFree(),
  }
  receipt.pass = receipt.mainStopped && receipt.hostStopped && receipt.portReleased
  writeJson(join(out, `${label}-exact-pid-cleanup.json`), receipt)
  cleanups.push(receipt)
  requireEvidence(receipt.pass, `${label} exact-PID cleanup`)
  return receipt
}

async function nativeState(value) {
  return value.cdp.evaluate(`(() => {
    const visible=el=>Boolean(el&&el.offsetParent!==null)
    const pending=[...document.querySelectorAll('[data-question-key]')].find(visible)
    return {pending:Boolean(pending),text:pending?.innerText??'',radios:pending?[...pending.querySelectorAll('[role="radio"]')].map(el=>({label:el.getAttribute('aria-label'),checked:el.getAttribute('aria-checked'),disabled:el.disabled})):[]}
  })()`)
}

async function answerNative(value, label) {
  await waitFor(() => value.cdp.evaluate(`(() => {
    const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null)
    const option=pending?.querySelector('[role="radio"][aria-label=${JSON.stringify(label)}]')
    if(!option||option.disabled)return false
    option.click()
    return true
  })()`), 30_000)
  await waitFor(() => value.cdp.evaluate(`(() => {
    const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null)
    if(!pending)return false
    const button=[...pending.querySelectorAll('button')].find(el=>/^(提交|Submit|Next|下一题|继续)$/i.test(el.textContent.trim())&&!el.disabled)
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
}

async function openRecordDetail(value, caseId) {
  await selectDecisionTab(value, 1)
  await waitFor(() => value.cdp.evaluate(`(() => {
    const button=[...document.querySelectorAll('main button')].find(el=>el.offsetParent!==null&&el.textContent.startsWith(${JSON.stringify(caseId)}))
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
  await waitFor(() => value.cdp.evaluate(`Boolean(document.querySelector('[data-readonly-record=${JSON.stringify(caseId)}]'))`), 30_000)
}

async function contextPackState(value, caseId) {
  return value.cdp.evaluate(`(() => {
    const detail=document.querySelector('[data-readonly-record=${JSON.stringify(caseId)}]')
    if(!detail)return null
    return [...detail.querySelectorAll('[data-attempt-context-pack]')].map(pack=>{
      pack.open=true
      const layerSizes={}
      for(const row of pack.querySelectorAll('dl > div')){
        const layer=row.querySelector('dt')?.textContent.trim()
        const size=row.querySelector('dd')?.textContent.trim()
        if(layer)layerSizes[layer]=Number(size)
      }
      return {
        attemptId:pack.getAttribute('data-attempt-context-pack'),
        ariaLabel:pack.getAttribute('aria-label'),
        text:pack.innerText,
        sourceCaseIds:[...pack.querySelectorAll('ol code')].map(el=>el.textContent.trim()),
        layerSizes,
        omissions:[...pack.querySelectorAll('ul code')].map(el=>el.textContent.trim()),
        readOnly:!pack.isContentEditable&&pack.querySelectorAll('input,textarea,button,[contenteditable="true"]').length===0,
      }
    })
  })()`)
}

function verifyContextPacks(dom, detail, sourceCaseId) {
  requireEvidence(Array.isArray(dom) && dom.length === detail.attempts.length, 'one Context Pack per Attempt')
  requireEvidence(new Set(dom.map(pack => pack.attemptId)).size === detail.attempts.length, 'unique Attempt disclosures')
  for (const attempt of detail.attempts) {
    const pack = dom.find(item => item.attemptId === attempt.attemptId)
    const manifest = attempt.packManifest
    const expectedSources = manifest?.memory?.L3?.sourceCaseIds ?? []
    const expectedOmissions = manifest?.omissions ?? []
    requireEvidence(pack?.readOnly === true, `${attempt.attemptId} is read-only`)
    requireEvidence(/Context Pack|上下文包/.test(pack?.ariaLabel ?? ''), `${attempt.attemptId} accessible label`)
    requireEvidence(/L2/.test(pack?.text ?? '') && /empty|空/.test(pack.text), `${attempt.attemptId} L2 empty`)
    requireEvidence(/non-authoritative|非权威/.test(pack?.text ?? '') && /not evidence|不是证据/.test(pack.text), `${attempt.attemptId} neutral non-authoritative label`)
    requireEvidence(JSON.stringify(pack.sourceCaseIds) === JSON.stringify(expectedSources), `${attempt.attemptId} actual source Case ids`)
    requireEvidence(JSON.stringify(pack.layerSizes) === JSON.stringify(manifest.layerSizes), `${attempt.attemptId} exact layer sizes`)
    requireEvidence(JSON.stringify(pack.omissions) === JSON.stringify(expectedOmissions), `${attempt.attemptId} exact omissions`)
    if (expectedOmissions.length === 0) requireEvidence(pack.text.includes('[]'), `${attempt.attemptId} empty omissions shown truthfully`)
    if (expectedSources.length) requireEvidence(expectedSources.includes(sourceCaseId) && pack.text.includes(sourceCaseId), `${attempt.attemptId} actual source visible`)
  }
  return true
}

function memoryProvenance(detail) {
  return detail.attempts.map(attempt => ({
    attemptId: attempt.attemptId,
    contextPackHash: attempt.contextPackHash,
    memorySnapshotId: attempt.pins?.memorySnapshotId,
    memory: attempt.packManifest?.memory,
    layerSizes: attempt.packManifest?.layerSizes,
    omissions: attempt.packManifest?.omissions,
    evidenceIds: attempt.packManifest?.evidenceIds,
  }))
}

function readTrace() {
  const path = join(out, 'mock-trace.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function layerLength(value) {
  return typeof value === 'string' ? value.length : JSON.stringify(value).length
}

function verifyEvaluatorWire(sourceDetail, pendingDetail) {
  const wire = readTrace().filter(request => request.decisionGuiMemoryPack)
  writeJson(join(out, 'evaluator-memory-wire.json'), wire)
  const sourceWire = wire.filter(request => request.decisionQuestionIds?.includes('gui-memory-source'))
  const reuseWire = wire.filter(request => request.decisionQuestionIds?.includes('gui-memory-reuse'))
  requireEvidence(sourceWire.length === 1, 'one source evaluator call')
  requireEvidence(reuseWire.length === pendingDetail.attempts.length && reuseWire.length > 0, 'one reuse evaluator call per failed Attempt')
  const sourcePack = sourceWire[0].decisionGuiMemoryPack
  requireEvidence(sourcePack.L3 === '', 'source has no historical L3')
  requireEvidence(sourcePack.L5.some(ref => ref.source === 'user_profile'), 'source answer has genuine L5')
  for (const [index, request] of reuseWire.entries()) {
    const pack = request.decisionGuiMemoryPack
    const attempt = pendingDetail.attempts[index]
    const manifest = attempt.packManifest
    const episodes = Array.isArray(pack.L3) ? pack.L3 : []
    requireEvidence(request.decisionGuiMemorySystem.includes('Decision evaluator contract v2'), 'evaluator contract v2')
    requireEvidence(/L3 contains neutral, non-authoritative historical episodes/.test(request.decisionGuiMemorySystem), 'wire marks L3 neutral and non-authoritative')
    requireEvidence(pack.L2 === '' && episodes.some(episode => episode.sourceCaseId === sourceDetail.case.caseId && episode.kind === 'neutral_agent_answer'), 'actual source reaches evaluator only as neutral L3')
    requireEvidence(!pack.L5.some(ref => ref.evidenceId === sourceDetail.case.caseId || ref.locator?.caseId === sourceDetail.case.caseId), 'source is not promoted to L5')
    requireEvidence(attempt.outcome === 'failed' && attempt.error?.kind === 'invalid_output' && attempt.error?.detail === 'UNKNOWN_EVIDENCE: claims may cite only evidenceIds in this pack', 'attempted L3 citation rejected')
    requireEvidence(manifest.memory?.L2?.status === 'empty' && manifest.memory.L2.snapshotId === null && manifest.layerSizes.L2 === 0, 'manifest L2 empty')
    requireEvidence(JSON.stringify(manifest.memory.L3.sourceCaseIds) === JSON.stringify(episodes.map(episode => episode.sourceCaseId)), 'manifest matches actual L3 sources')
    requireEvidence(JSON.stringify(manifest.evidenceIds) === JSON.stringify(pack.L5.map(ref => ref.evidenceId)) && !manifest.evidenceIds.includes(sourceDetail.case.caseId), 'manifest evidence is L5 only')
    requireEvidence(manifest.layerSizes.L0 === request.decisionGuiMemorySystem.length, 'exact L0 size')
    for (const layer of ['L1', 'L2', 'L3', 'L4', 'L5']) requireEvidence(manifest.layerSizes[layer] === layerLength(pack[layer]), `exact ${layer} size`)
    requireEvidence(Array.isArray(manifest.omissions), 'omissions manifest present')
  }
  return true
}

async function auditManagementViews(value, caseId, agentName) {
  const views = []
  for (const [index, name] of ['agents', 'records', 'inbox', 'metrics'].entries()) {
    if (name === 'records') await openRecordDetail(value, caseId)
    else await selectDecisionTab(value, index)
    const state = await value.cdp.evaluate(`(() => {
      const main=document.querySelector('main')
      const visible=el=>Boolean(el&&el.offsetParent!==null)
      return {
        nav:[...main.querySelectorAll('nav button')].map(el=>({text:el.textContent.trim(),pressed:el.getAttribute('aria-pressed')})),
        text:main.innerText,
        controls:[...main.querySelectorAll('button,a,[role="button"],input,textarea,select')].filter(visible).map(el=>({tag:el.tagName,text:el.textContent?.trim()??'',aria:el.getAttribute('aria-label')??'',value:el.value??''})),
      }
    })()`)
    views.push({ name, ...state })
    await cdpScreenshot(value, join(out, `management-${name}.png`))
  }
  writeJson(join(out, 'management-views.json'), views)
  const forbidden = views.flatMap(view => view.controls.filter(control => /consolidat|memory snapshot|snapshot|publish|rollback|profile learning|auto(?:matic)?[ -]?route|export|memory edit|cross[ -]workspace/i.test(`${control.text} ${control.aria}`)).map(control => ({ view: view.name, ...control })))
  writeJson(join(out, 'future-capability-controls.json'), forbidden)
  requireEvidence(views.length === 3 && views.every(view => view.nav.length === 3), 'exactly three primary management destinations')
  requireEvidence(forbidden.length === 0, 'no future-capability controls')
  requireEvidence(views[0].text.includes(agentName) && views[3].text.includes('Auto answer rate is diagnostic, not a quality metric.'), 'existing Agent and Metrics views remain usable')
  return true
}

function exportAuthoritativeDatabase(sourceCaseId, reuseCaseId, afterDetail) {
  const dbPath = join(root, 'home', 'weir', 'profiles', 'desktop', 'decisions', 'decision.db')
  requireEvidence(dbPath.startsWith(`${root}/`) && existsSync(dbPath), 'isolated Decision database exists')
  copyFileSync(dbPath, join(out, 'decision.db'))
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let raw
  try {
    raw = {
      path: dbPath,
      cases: db.prepare('SELECT * FROM cases WHERE case_id IN (?,?) ORDER BY created_at,case_id').all(sourceCaseId, reuseCaseId),
      attempts: db.prepare('SELECT * FROM attempts WHERE case_id IN (?,?) ORDER BY case_id,attempt_no').all(sourceCaseId, reuseCaseId),
      attemptEvidence: db.prepare('SELECT ae.* FROM attempt_evidence ae JOIN attempts a ON a.attempt_id=ae.attempt_id WHERE a.case_id IN (?,?) ORDER BY ae.attempt_id,ae.ordinal').all(sourceCaseId, reuseCaseId),
    }
  } finally {
    db.close()
  }
  writeJson(join(out, 'authoritative-sqlite.json'), raw)
  const rawReuse = raw.attempts.filter(attempt => attempt.case_id === reuseCaseId)
  requireEvidence(rawReuse.length === afterDetail.attempts.length, 'SQLite Attempt count matches RPC export')
  for (const attempt of afterDetail.attempts) {
    const row = rawReuse.find(item => item.attempt_id === attempt.attemptId)
    requireEvidence(row && JSON.stringify(JSON.parse(row.pack_manifest_json)) === JSON.stringify(attempt.packManifest), `SQLite manifest matches RPC for ${attempt.attemptId}`)
  }
  return true
}

try {
  check('port9465InitiallyFree', await cdpPortFree())
  prepareProfile(root, PORT)
  instance = await startInstance({ root, out, port: PORT, enabled: true })
  const firstMainPid = instance.app.pid
  const firstHost = await instance.cdp.evaluate('window.__decisionQA.fixture("hostState", {})')
  writeJson(join(out, 'process-1.json'), { mainPid: firstMainPid, host: firstHost, root, port: PORT })
  check('firstProcessUsesDistinctIsolatedRoot', firstHost.profile?.home === join(root, 'home') && firstHost.profile?.name === 'desktop' && (firstHost.pid === firstMainPid || firstHost.parentPid === firstMainPid))

  const session = await createSession(instance)
  const sessionId = session.sessionId
  writeJson(join(out, 'session.json'), session)
  const agent = await createAgent(instance, sessionId, 'GUI-P2 Neutral Memory', 'For isolated GUI memory source questions, choose Neutral GUI answer. This user description is source evidence, not generated memory.')
  writeJson(join(out, 'agent.json'), agent)
  await openSession(instance, sessionId)
  await setSelector(instance, sessionId, 'agent', agent.agentId)
  check('agentCreatedAndPinnedThroughDom', agent.state === 'enabled' && (await instance.cdp.evaluate('document.querySelector("select[data-weir-decision-selector]").value')) === agent.agentId)
  await cdpScreenshot(instance, join(out, '01-agent-pinned.png'))

  await submitMarker(instance, 'GUI_MEMORY_SOURCE')
  const source = await waitCase(instance, sessionId, 'gui-memory-source', current => current.state === 'closed')
  const sourceDetail = await exportRecord(instance, sessionId, source.caseId, join(out, 'record-source.json'))
  check('sourceIsUnratedClosedAnswered', source.closing === 'answered' && source.feedbackState === 'none' && !source.needsReview && sourceDetail.feedback.length === 0 && sourceDetail.attempts.length === 1 && sourceDetail.attempts[0].outcome === 'answer' && sourceDetail.attempts[0].pins.memorySnapshotId === null)
  await cdpScreenshot(instance, join(out, '02-source-answered.png'))
  await openRecordDetail(instance, source.caseId)
  const sourcePacks = await contextPackState(instance, source.caseId)
  writeJson(join(out, 'source-context-packs-dom.json'), sourcePacks)
  check('sourceContextPackHasNoFabricatedMemory', verifyContextPacks(sourcePacks, sourceDetail, source.caseId) && sourcePacks[0].sourceCaseIds.length === 0)
  await cdpScreenshot(instance, join(out, '03-source-context-pack.png'))

  await openSession(instance, sessionId)
  await submitMarker(instance, 'GUI_MEMORY_REUSE')
  const reuse = await waitCase(instance, sessionId, 'gui-memory-reuse', current => current.state === 'awaiting_user')
  const pendingDetail = await exportRecord(instance, sessionId, reuse.caseId, join(out, 'record-reuse-pending.json'))
  check('reuseCitationRejectedBeforeNativeAnswer', pendingDetail.attempts.length > 0 && pendingDetail.attempts.every(attempt => attempt.outcome === 'failed' && attempt.error?.kind === 'invalid_output' && attempt.error?.detail.startsWith('UNKNOWN_EVIDENCE:')) && !pendingDetail.case.decision)
  check('evaluatorReceivedActualSourceAsNeutralL3Only', verifyEvaluatorWire(sourceDetail, pendingDetail))
  const nativeBefore = await waitFor(async () => {
    const value = await nativeState(instance)
    return value.pending && value.radios.length === 2 ? value : null
  }, 30_000)
  writeJson(join(out, 'native-before.json'), nativeBefore)
  check('nativePendingQuestionAppears', nativeBefore.text.includes('Reuse neutral GUI memory without decisive evidence') && nativeBefore.radios.some(radio => radio.label === 'User resolves GUI memory'))
  await cdpScreenshot(instance, join(out, '04-reuse-native-pending.png'))

  await openRecordDetail(instance, reuse.caseId)
  const pendingPacks = await contextPackState(instance, reuse.caseId)
  writeJson(join(out, 'reuse-context-packs-before-native.json'), pendingPacks)
  check('recordShowsOneTruthfulReadonlyContextPackPerAttempt', verifyContextPacks(pendingPacks, pendingDetail, source.caseId))
  await cdpScreenshot(instance, join(out, '05-context-packs-before-native.png'))

  await openSession(instance, sessionId)
  await answerNative(instance, 'User resolves GUI memory')
  const resolved = await waitCase(instance, sessionId, 'gui-memory-reuse', current => current.state === 'closed')
  const resolvedDetail = await exportRecord(instance, sessionId, resolved.caseId, join(out, 'record-reuse-resolved.json'))
  check('nativeUserResolvesWithoutBrokerAnswerSubstitution', resolved.closing === 'escalated' && resolved.decision?.kind === 'user_decision' && resolved.decision.answers?.[0]?.selected?.[0] === 'User resolves GUI memory' && resolvedDetail.attempts.length === pendingDetail.attempts.length && resolvedDetail.attempts.every(attempt => attempt.outcome === 'failed'))
  await waitFor(async () => !(await nativeState(instance)).pending, 30_000)
  await cdpScreenshot(instance, join(out, '06-native-resolved.png'))

  check('threePrimaryDestinationsAndNoFutureControls', await auditManagementViews(instance, reuse.caseId, agent.name))
  const beforeRestart = await exportRecord(instance, sessionId, reuse.caseId, join(out, 'record-reuse-before-restart.json'))
  await openRecordDetail(instance, reuse.caseId)
  const beforeRestartPacks = await contextPackState(instance, reuse.caseId)
  writeJson(join(out, 'context-packs-before-restart.json'), beforeRestartPacks)
  check('contextPacksStableAfterNativeResolution', JSON.stringify(beforeRestartPacks) === JSON.stringify(pendingPacks) && verifyContextPacks(beforeRestartPacks, beforeRestart, source.caseId))
  await cdpScreenshot(instance, join(out, '07-record-before-restart.png'))
  const scanBefore = await instance.cdp.evaluate(`window.__decisionQA.fixture('scanSession', ${JSON.stringify({ sessionId })})`)
  writeJson(join(out, 'session-scan-before-restart.json'), scanBefore)
  check('noCommandOrCustomDecisionEventsBeforeRestart', scanBefore.commandEvents.length === 0 && scanBefore.customDecisionEvents.length === 0)

  await stopOwnedInstance(instance, 'process-1')
  collectEvents(instance, 'process-1')
  instance = null
  check('firstExactMainAndHostStopped', cleanups[0].mainStopped && cleanups[0].hostStopped && cleanups[0].portReleased)

  instance = await startInstance({ root, out, port: PORT, enabled: true })
  const secondMainPid = instance.app.pid
  const secondHost = await instance.cdp.evaluate('window.__decisionQA.fixture("hostState", {})')
  writeJson(join(out, 'process-2.json'), { mainPid: secondMainPid, host: secondHost, root, port: PORT })
  check('restartUsesNewOwnedMainAndHostPids', secondMainPid !== firstMainPid && secondHost.pid !== firstHost.pid && secondHost.profile?.home === join(root, 'home') && (secondHost.pid === secondMainPid || secondHost.parentPid === secondMainPid))
  await openSession(instance, sessionId)
  await openRecordDetail(instance, reuse.caseId)
  const afterRestart = await exportRecord(instance, sessionId, reuse.caseId, join(out, 'record-reuse-after-restart.json'))
  const afterRestartPacks = await contextPackState(instance, reuse.caseId)
  writeJson(join(out, 'context-packs-after-restart.json'), afterRestartPacks)
  const provenance = { before: memoryProvenance(beforeRestart), after: memoryProvenance(afterRestart) }
  provenance.identical = JSON.stringify(provenance.before) === JSON.stringify(provenance.after)
  writeJson(join(out, 'restart-memory-provenance.json'), provenance)
  check('restartPersistsIdenticalMemoryProvenance', provenance.identical && beforeRestart.case.decision?.kind === 'user_decision' && afterRestart.case.decision?.kind === 'user_decision')
  check('restartReopensIdenticalReadonlyContextPacksThroughDom', JSON.stringify(afterRestartPacks) === JSON.stringify(beforeRestartPacks) && verifyContextPacks(afterRestartPacks, afterRestart, source.caseId))
  await cdpScreenshot(instance, join(out, '08-record-after-restart.png'))
  const scanAfter = await instance.cdp.evaluate(`window.__decisionQA.fixture('scanSession', ${JSON.stringify({ sessionId })})`)
  writeJson(join(out, 'session-scan-after-restart.json'), scanAfter)
  check('noCommandOrCustomDecisionEventsAfterRestart', scanAfter.commandEvents.length === 0 && scanAfter.customDecisionEvents.length === 0)

  await stopOwnedInstance(instance, 'process-2')
  collectEvents(instance, 'process-2')
  instance = null
  check('secondExactMainAndHostStopped', cleanups[1].mainStopped && cleanups[1].hostStopped && cleanups[1].portReleased)
  check('authoritativeSqliteMatchesRecordExports', exportAuthoritativeDatabase(source.caseId, reuse.caseId, afterRestart))

  writeJson(join(out, 'runtime-events.json'), events)
  const exceptions = events.filter(item => item.event.method === 'Runtime.exceptionThrown')
  const desktopLog = readFileSync(join(out, 'desktop-enabled.log'), 'utf8')
  const importFailures = desktopLog.split('\n').filter(line => /failed to import weir-harness\/decision|SessionFormatUnsupportedError/.test(line))
  writeJson(join(out, 'runtime-scan.json'), { runtimeExceptionCount: exceptions.length, exceptions, importFailures })
  check('noRuntimeExceptionsOrDecisionLoadFailures', exceptions.length === 0 && importFailures.length === 0)

  result = {
    phase: 'GUI-P2',
    pass: Object.values(checks).every(Boolean),
    checkCount: Object.keys(checks).length,
    checks,
    runId,
    root,
    out,
    port: PORT,
    sessionId,
    agentId: agent.agentId,
    sourceCaseId: source.caseId,
    reuseCaseId: reuse.caseId,
    processPids: [
      { mainPid: firstMainPid, hostPid: firstHost.pid },
      { mainPid: secondMainPid, hostPid: secondHost.pid },
    ],
    cleanupReceipts: cleanups.map(receipt => join(out, `${receipt.label}-exact-pid-cleanup.json`)),
    artifacts: {
      sourceRecord: join(out, 'record-source.json'),
      pendingRecord: join(out, 'record-reuse-pending.json'),
      beforeRestart: join(out, 'record-reuse-before-restart.json'),
      afterRestart: join(out, 'record-reuse-after-restart.json'),
      provenance: join(out, 'restart-memory-provenance.json'),
      evaluatorWire: join(out, 'evaluator-memory-wire.json'),
      runtimeEvents: join(out, 'runtime-events.json'),
      sessionScans: [join(out, 'session-scan-before-restart.json'), join(out, 'session-scan-after-restart.json')],
      sqlite: join(out, 'authoritative-sqlite.json'),
    },
  }
  writeJson(join(out, 'result.json'), result)
} catch (error) {
  failure = error
  if (instance?.cdp) {
    await cdpScreenshot(instance, join(out, 'failure.png')).catch(() => {})
    writeJson(join(out, 'failure-dom.json'), await instance.cdp.evaluate('({text:document.body.innerText,html:document.body.innerHTML})').catch(() => null))
  }
} finally {
  if (instance) {
    try {
      await stopOwnedInstance(instance, 'failure-cleanup')
      collectEvents(instance, 'failure-cleanup')
    } catch (cleanupError) {
      failure ??= cleanupError
      writeJson(join(out, 'cleanup-error.json'), { message: cleanupError?.message ?? String(cleanupError), stack: cleanupError?.stack ?? null })
    }
    instance = null
  }
  writeJson(join(out, 'runtime-events.json'), events)
}

if (failure) {
  writeJson(join(out, 'driver-error.json'), { message: failure?.message ?? String(failure), stack: failure?.stack ?? null, checks, cleanups })
  writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'failed', error: failure?.message ?? String(failure) })
  console.error(failure)
  process.exitCode = 1
} else {
  writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'passed', result: join(out, 'result.json') })
  console.log(JSON.stringify({ phase: 'GUI-P2', pass: result.pass, checkCount: result.checkCount, checks, out }, null, 2))
}
