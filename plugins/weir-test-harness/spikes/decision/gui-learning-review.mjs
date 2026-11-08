// Focused GUI-P3 review: >20 history plus cross-root Case/correction sources.
// Launches a NEW isolated Desktop and signals only exact owned main/Host PIDs.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LANE, writeJson, prepareProfile, startInstance, stopInstance, cdpScreenshot,
  createSession, openSession, selectDecisionTab, createAgent, setSelector, setInput,
  submitMarker, waitCase, clickButton,
} from './gui-qa.mjs'
import { waitFor } from './cdp.mjs'

const PORT = 9467
const GUI = join(LANE, '.weir', 'decision-p3', 'gui')
mkdirSync(GUI, { recursive: true })
const root = mkdtempSync(join(GUI, 'desktop-learning-review-'))
const runId = basename(root).replace('desktop-learning-review-', '')
const out = join(GUI, `review-${runId}`)
mkdirSync(out)
const databasePath = join(root, 'home', 'weir', 'profiles', 'desktop', 'decisions', 'decision.db')
const direction = 'GUI correction: use the reviewed cross-root answer.'
const checks = {}
const rpcEvidence = []
const sqlitePhases = []
const screenshots = []
let instance = null
let failure = null
let result = null
let cleanup = null
let runtimeEvents = []

function check(name, value) {
  checks[name] = Boolean(value)
  if (!value) throw new Error(`GUI-P3 review check failed: ${name}`)
}

function requireEvidence(value, message) {
  if (!value) throw new Error(`GUI-P3 review evidence mismatch: ${message}`)
}

async function screenshot(name) {
  const path = join(out, `${name}.png`)
  await cdpScreenshot(instance, path)
  requireEvidence(statSync(path).size > 0, `${name} screenshot is non-empty`)
  screenshots.push(path)
}

async function scrollSource(sourceId) {
  await instance.cdp.evaluate(`document.querySelector('[data-learning-source-record=${JSON.stringify(sourceId)}]')?.scrollIntoView({block:'center'})`)
}

function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat=,lstart,args='], { encoding: 'utf8' })
  const stdout = ps.stdout?.trim() ?? ''
  const zombie = /^\s*\d+\s+\d+\s+\S*Z/i.test(stdout)
  return {
    pid,
    alive: ps.status === 0 && Boolean(stdout) && !zombie,
    status: ps.status,
    stdout,
    signature: stdout.replace(/^\s*\d+\s+\d+\s+\S+\s+/, ''),
  }
}

function portListeners() {
  return spawnSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout?.trim() ?? ''
}

async function portFree() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
    return false
  } catch {
    return true
  }
}

async function rpc(sessionId, phase, method, args = {}) {
  const transport = await instance.cdp.evaluate(`window.__decisionQA.decision(${JSON.stringify(method)}, ${JSON.stringify({ sessionId, ...args })})`)
  rpcEvidence.push({ phase, method, args: { sessionId, ...args }, transport })
  const service = transport?.value
  if (!transport || transport.ok !== true || service?.ok === false) {
    throw new Error(`Decision ${method} failed at ${phase}: ${JSON.stringify(service?.error ?? transport?.error ?? transport)}`)
  }
  return service?.ok === true ? service.value : service
}

function sqliteSnapshot(phase) {
  requireEvidence(databasePath.startsWith(`${root}/`) && existsSync(databasePath), 'isolated Decision database exists')
  const db = new DatabaseSync(databasePath, { readOnly: true })
  let value
  try {
    value = {
      phase,
      path: databasePath,
      schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      cases: db.prepare('SELECT * FROM cases ORDER BY rowid').all(),
      feedback: db.prepare('SELECT * FROM feedback ORDER BY rowid').all(),
      corrections: db.prepare('SELECT * FROM corrections ORDER BY rowid').all(),
      learningRuns: db.prepare('SELECT * FROM learning_runs ORDER BY rowid').all(),
      snapshots: db.prepare('SELECT * FROM memory_snapshots ORDER BY rowid').all(),
    }
  } finally {
    db.close()
  }
  requireEvidence(value.schemaVersion === 1 && value.integrity === 'ok', `${phase} SQLite v1 integrity`)
  sqlitePhases.push(value)
  writeJson(join(out, `sqlite-${phase}.json`), value)
  return value
}

async function nativeAnswer(label) {
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null)
    const option=pending?.querySelector('[role="radio"][aria-label=${JSON.stringify(label)}]')
    if(!option||option.disabled)return false
    option.click()
    return true
  })()`), 30_000)
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const pending=[...document.querySelectorAll('[data-question-key]')].find(el=>el.offsetParent!==null)
    if(!pending)return false
    const button=[...pending.querySelectorAll('button')].find(el=>/^(提交|Submit|Next|下一题|继续)$/i.test(el.textContent.trim())&&!el.disabled)
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
}

async function pinAgent(sessionId, agentId) {
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const el=document.querySelector('select[data-weir-decision-selector]')
    return Boolean(el&&[...el.options].some(option=>option.value===${JSON.stringify(agentId)}))
  })()`), 30_000)
  await setSelector(instance, sessionId, 'agent', agentId)
}

async function openAgent(agent) {
  await selectDecisionTab(instance, 0)
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const button=[...document.querySelectorAll('main button')].find(el=>el.offsetParent!==null&&el.textContent.startsWith(${JSON.stringify(`${agent.name} · `)}))
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const section=[...document.querySelectorAll('main section[aria-label]')].find(el=>/Learning and Snapshots|学习与 Snapshot/.test(el.getAttribute('aria-label')||''))
    return Boolean(section&&section.closest('article')?.innerText.includes(${JSON.stringify(agent.agentId)}))
  })()`), 30_000)
}

async function governanceState() {
  return instance.cdp.evaluate(`(() => {
    const section=[...document.querySelectorAll('main section[aria-label]')].find(el=>/Learning and Snapshots|学习与 Snapshot/.test(el.getAttribute('aria-label')||''))
    if(!section)return null
    const detail=section.querySelector('[data-learning-run-detail]')
    const visible=el=>Boolean(el&&el.offsetParent!==null)
    return {
      text:section.innerText,
      runIds:[...section.querySelectorAll('[data-learning-run-id]')].map(el=>el.getAttribute('data-learning-run-id')),
      snapshotIds:[...section.querySelectorAll('[data-snapshot-id]')].map(el=>el.getAttribute('data-snapshot-id')),
      detailRunId:detail?.getAttribute('data-learning-run-detail')??null,
      detailText:detail?.innerText??'',
      sources:[...section.querySelectorAll('[data-learning-source-record]')].map(el=>({
        sourceId:el.getAttribute('data-learning-source-record'),
        text:el.innerText,
        readOnly:!el.isContentEditable&&el.querySelectorAll('button,input,textarea,select,[contenteditable="true"]').length===0,
      })),
      controls:[...section.querySelectorAll('button')].filter(visible).map(el=>({text:el.textContent.trim(),disabled:el.disabled===true})),
    }
  })()`)
}

async function waitAgent(sessionId, agentId, phase, predicate) {
  return waitFor(async () => {
    const agent = await rpc(sessionId, phase, 'agent', { agentId })
    return predicate(agent) ? agent : null
  }, 90_000)
}

async function clickLifecycle(labels) {
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const labels=${JSON.stringify(labels)}
    const button=[...document.querySelectorAll('main button')].find(el=>el.offsetParent!==null&&labels.includes(el.textContent.trim())&&!el.disabled)
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
}

async function startCandidate(agent, sessionId, expectedVersion) {
  await openAgent(agent)
  const before = await rpc(sessionId, `start-v${expectedVersion}`, 'agent', { agentId: agent.agentId })
  const known = new Set(before.learningRuns.map(run => run.learningRunId))
  await clickLifecycle(['Consolidate', '手动整合'])
  const current = await waitAgent(sessionId, agent.agentId, `wait-v${expectedVersion}`, value => value.learningRuns.some(run => run.outcome === 'candidate' && !known.has(run.learningRunId)))
  const summary = current.learningRuns.find(run => run.outcome === 'candidate' && !known.has(run.learningRunId))
  const snapshotSummary = current.snapshots.find(snapshot => snapshot.learningRunId === summary.learningRunId && snapshot.state === 'draft')
  requireEvidence(snapshotSummary?.version === expectedVersion, `v${expectedVersion} draft summary`)
  const [run, snapshot] = await Promise.all([
    rpc(sessionId, `detail-v${expectedVersion}`, 'learningRun', { learningRunId: summary.learningRunId }),
    rpc(sessionId, `detail-v${expectedVersion}`, 'memorySnapshot', { snapshotId: snapshotSummary.snapshotId }),
  ])
  requireEvidence(run.replay?.passed === true && snapshot.state === 'draft', `v${expectedVersion} valid candidate`)
  const dom = await waitFor(async () => {
    const value = await governanceState()
    return value?.detailRunId === run.learningRunId ? value : null
  }, 30_000)
  return { agent: current, run, snapshot, dom }
}

async function rejectCandidate(agent, sessionId, candidate) {
  await openAgent(agent)
  await clickLifecycle(['Reject', '拒绝'])
  const agentValue = await waitAgent(sessionId, agent.agentId, `reject-${candidate.snapshot.version}`, value => value.learningRuns.find(run => run.learningRunId === candidate.run.learningRunId)?.outcome === 'rejected')
  const run = await rpc(sessionId, `rejected-${candidate.snapshot.version}`, 'learningRun', { learningRunId: candidate.run.learningRunId })
  requireEvidence(run.outcome === 'rejected', `v${candidate.snapshot.version} rejected`)
  return agentValue
}

async function openRecord(caseId) {
  await selectDecisionTab(instance, 1)
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const button=[...document.querySelectorAll('main button')].find(el=>el.offsetParent!==null&&el.textContent.startsWith(${JSON.stringify(caseId)}))
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-readonly-record=${JSON.stringify(caseId)}]'))`), 30_000)
}

async function stopOwnedInstance() {
  const mainPid = instance.app.pid
  const host = await instance.cdp.evaluate('window.__decisionQA.fixture("hostState", {})').catch(() => null)
    ?? JSON.parse(readFileSync(join(out, 'host.json'), 'utf8'))
  const hostPid = host?.pid
  const before = { main: processInfo(mainPid), host: processInfo(hostPid) }
  const base = await stopInstance(instance, join(out, 'cleanup-base.json'))
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
      if (processInfo(hostPid)?.alive && processInfo(hostPid).signature === before.host.signature) {
        process.kill(hostPid, 'SIGKILL')
        hostSignal = 'SIGTERM,SIGKILL'
        await waitFor(() => !processInfo(hostPid)?.alive, 5000)
      }
    }
  }
  await waitFor(async () => await portFree() && !portListeners(), 10_000)
  const after = { main: processInfo(mainPid), host: processInfo(hostPid) }
  cleanup = {
    ...base, port: PORT, root, mainPid, hostPid, hostSignal, before, after,
    mainStopped: !after.main?.alive,
    hostStopped: !after.host?.alive,
    portReleased: await portFree() && !portListeners(),
    scratch: { root, disposition: 'retained', reason: 'lane-local isolated replay evidence' },
  }
  cleanup.pass = cleanup.mainStopped && cleanup.hostStopped && cleanup.portReleased
  writeJson(join(out, 'exact-pid-cleanup.json'), cleanup)
  requireEvidence(cleanup.pass, 'exact owned PID and port cleanup')
}

try {
  check('portInitiallyFree', await portFree() && !portListeners())
  writeJson(join(GUI, 'review-latest.json'), { runId, root, out, port: PORT, status: 'running' })
  prepareProfile(root, PORT)
  instance = await startInstance({ root, out, port: PORT, enabled: true })
  const mainPid = instance.app.pid
  const host = await instance.cdp.evaluate('window.__decisionQA.fixture("hostState", {})')
  writeJson(join(out, 'process.json'), { mainPid, host, root, port: PORT })
  check('freshIsolatedDesktop', host.profile?.home === join(root, 'home') && host.profile?.name === 'desktop' && (host.pid === mainPid || host.parentPid === mainPid))

  const firstSession = await createSession(instance)
  const reviewSessionId = firstSession.sessionId
  const agent = await createAgent(instance, reviewSessionId, 'GUI-P3 Review Sources', 'User-authored isolated profile for source review.')
  writeJson(join(out, 'agent.json'), agent)
  const readable = await rpc(reviewSessionId, 'setup', 'agent', { agentId: agent.agentId })
  requireEvidence(readable.agentId === agent.agentId, 'new Agent is readable before selector setup')
  await openSession(instance, reviewSessionId)
  await pinAgent(reviewSessionId, agent.agentId)

  const otherSession = await createSession(instance)
  const sourceSessionId = otherSession.sessionId
  await pinAgent(sourceSessionId, agent.agentId)
  await submitMarker(instance, 'GUI_LEARNING_SOURCE')
  await waitCase(instance, sourceSessionId, 'gui-learning-source', current => current.state === 'awaiting_user')
  await nativeAnswer('User backed GUI answer')
  const source = await waitCase(instance, sourceSessionId, 'gui-learning-source', current => current.state === 'closed')
  requireEvidence(source.decision?.kind === 'user_decision', 'cross-root user_decision source')
  const sourceRecord = await rpc(sourceSessionId, 'source', 'record', { caseId: source.caseId })
  requireEvidence(sourceRecord.case.rootSessionId === sourceSessionId && sourceRecord.case.workspaceKey === LANE, 'source belongs to other root in same workspace')
  check('generalReaderKeepsCrossRootCaseHidden', await rpc(reviewSessionId, 'source', 'record', { caseId: source.caseId }) === null)
  sqliteSnapshot('01-source')
  writeJson(join(out, 'sessions.json'), { reviewSessionId, sourceSessionId })

  await openSession(instance, reviewSessionId)
  const v1 = await startCandidate(agent, reviewSessionId, 1)
  requireEvidence(v1.run.operations[0]?.sources?.[0] === source.caseId, 'v1 uses cross-root Case source')
  const caseSources = v1.dom.sources.filter(item => item.sourceId === source.caseId)
  requireEvidence(caseSources.length === 1 && caseSources[0].readOnly, 'cross-root Case disclosure is rendered read-only')
  requireEvidence(/Answer gui-learning-source: User backed GUI answer/.test(caseSources[0].text), 'Case disclosure is answer-first')
  requireEvidence(caseSources[0].text.includes('Question gui-learning-source: Choose the authoritative GUI learning source'), 'Case disclosure includes bounded question excerpt')
  check('crossRootCaseSourceDisclosure', caseSources[0].text.includes('case ·'))
  writeJson(join(out, 'dom-02-case-candidate.json'), v1.dom)
  await scrollSource(source.caseId)
  await screenshot('02-case-candidate')

  await openAgent(agent)
  await clickLifecycle(['Publish', '发布'])
  const publishedAgent = await waitAgent(reviewSessionId, agent.agentId, 'publish-v1', value => value.currentSnapshotId === v1.snapshot.snapshotId)
  const published = await rpc(reviewSessionId, 'publish-v1', 'memorySnapshot', { snapshotId: v1.snapshot.snapshotId })
  requireEvidence(published.state === 'published' && published.revision === 2 && publishedAgent.currentSnapshotId === published.snapshotId, 'v1 published with authoritative revision')
  sqliteSnapshot('03-published-v1')

  await openSession(instance, sourceSessionId)
  await openRecord(source.caseId)
  await setInput(instance, 'input[aria-label="Comment"],input[aria-label="评论"]', direction)
  await clickButton(instance, ['Correct', '纠正'])
  const correctedRecord = await waitFor(async () => {
    const record = await rpc(sourceSessionId, 'correction', 'record', { caseId: source.caseId })
    return record.feedback.some(item => item.kind === 'correction') ? record : null
  }, 30_000)
  const correction = correctedRecord.feedback.find(item => item.kind === 'correction')
  requireEvidence(correction.payload.direction === direction && correction.payload.supersedes.includes(source.caseId), 'real correction Feedback written through UI')
  sqliteSnapshot('04-correction')

  await openSession(instance, reviewSessionId)
  const v2 = await startCandidate(agent, reviewSessionId, 2)
  requireEvidence(v2.run.operations[0]?.sources?.[0] === correction.feedbackId, 'v2 uses correction Feedback source')
  const correctionSources = v2.dom.sources.filter(item => item.sourceId === correction.feedbackId)
  requireEvidence(correctionSources.length === 1 && correctionSources[0].readOnly, 'correction disclosure is rendered read-only')
  requireEvidence(correctionSources[0].text.includes(direction), 'correction direction is visible')
  requireEvidence(correctionSources[0].text.includes('scope') && correctionSources[0].text.includes('supersedes') && correctionSources[0].text.includes(source.caseId), 'correction scope and supersedes are visible')
  check('correctionFeedbackSourceDisclosure', correctionSources[0].text.includes('correction ·'))
  writeJson(join(out, 'dom-05-correction-candidate.json'), v2.dom)
  await scrollSource(correction.feedbackId)
  await screenshot('05-correction-candidate')
  await rejectCandidate(agent, reviewSessionId, v2)

  for (let version = 3; version <= 22; version++) {
    const candidate = await startCandidate(agent, reviewSessionId, version)
    await rejectCandidate(agent, reviewSessionId, candidate)
  }
  const overflow = await rpc(reviewSessionId, 'overflow', 'agent', { agentId: agent.agentId })
  const currentSummary = overflow.snapshots.find(snapshot => snapshot.snapshotId === published.snapshotId)
  const rawOverflow = sqliteSnapshot('06-overflow')
  requireEvidence(rawOverflow.snapshots.length === 22 && rawOverflow.learningRuns.filter(run => run.outcome === 'rejected').length === 21, 'SQLite has current plus 21 newer rejected drafts')
  requireEvidence(overflow.learningRuns.length === 20 && overflow.snapshots.length === 21, 'Agent history remains capped at 20 plus current')
  requireEvidence(!overflow.learningRuns.some(run => run.learningRunId === published.learningRunId), 'current run is beyond recent-run cap')
  requireEvidence(currentSummary?.revision === published.revision && currentSummary.state === 'published', 'authoritative current summary survives overflow')
  check('currentSummaryBeyondTwentyNewerRejected', currentSummary.learningRunId === published.learningRunId)

  await openAgent(agent)
  await waitFor(async () => {
    const value = await governanceState()
    return value?.detailRunId === overflow.learningRuns[0]?.learningRunId ? value : null
  }, 30_000)
  const overflowDom = await governanceState()
  const rollbackControl = overflowDom.controls.find(control => /^(Rollback|回滚)$/.test(control.text))
  requireEvidence(rollbackControl?.disabled === false, 'current Rollback remains enabled')
  requireEvidence(overflowDom.text.includes(`${published.snapshotId} · v1`) && overflowDom.text.includes(`r${published.revision}`), 'current DOM shows authoritative revision')
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const section=[...document.querySelectorAll('main section[aria-label]')].find(el=>/Learning and Snapshots|学习与 Snapshot/.test(el.getAttribute('aria-label')||''))
    const button=[...section.querySelectorAll('button')].find(el=>el.textContent.includes(${JSON.stringify(published.snapshotId)})&&el.textContent.includes(${JSON.stringify(`r${published.revision}`)}))
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
  const currentDom = await waitFor(async () => {
    const value = await governanceState()
    return value?.detailRunId === published.learningRunId && value.sources.some(item => item.sourceId === source.caseId) ? value : null
  }, 30_000)
  requireEvidence(currentDom.sources.find(item => item.sourceId === source.caseId)?.readOnly, 'overflow current detail exposes cross-root Case read-only')
  check('currentDetailActionBeyondTwenty', currentDom.detailText.includes('Answer gui-learning-source: User backed GUI answer'))
  writeJson(join(out, 'dom-07-overflow-current.json'), { overflowDom, currentDom })
  await scrollSource(source.caseId)
  await screenshot('07-overflow-current')

  await clickLifecycle(['Rollback', '回滚'])
  const rolledAgent = await waitAgent(reviewSessionId, agent.agentId, 'rollback-current', value => value.currentSnapshotId === null)
  const rolled = await rpc(reviewSessionId, 'rollback-current', 'memorySnapshot', { snapshotId: published.snapshotId })
  requireEvidence(rolled.state === 'rolled_back' && rolled.revision === published.revision + 1 && rolledAgent.currentSnapshotId === null, 'real Rollback click changes authoritative state')
  writeJson(join(out, 'rollback-authority.json'), { before: published, after: rolled })
  check('currentRollbackActionBeyondTwenty', true)
  sqliteSnapshot('08-rolled-back')
  const rolledDom = await waitFor(async () => {
    const value = await governanceState()
    const noCurrent=/No current published Snapshot|当前没有已发布的 Snapshot/.test(value?.text??'')
    const rollback=value?.controls.find(control=>/^(Rollback|回滚)$/.test(control.text))
    return noCurrent&&rollback?.disabled===true ? value : null
  }, 30_000)
  writeJson(join(out, 'dom-08-rolled-back.json'), rolledDom)
  await screenshot('08-rolled-back')

  runtimeEvents = [...instance.cdp.events]
  await stopOwnedInstance()
  instance = null
  check('exactOwnedPidAndPortCleanup', cleanup.pass)
  sqliteSnapshot('09-stopped')
  copyFileSync(databasePath, join(out, 'decision.db'))
  const exceptions = runtimeEvents.filter(event => event.method === 'Runtime.exceptionThrown')
  writeJson(join(out, 'rpc-evidence.json'), rpcEvidence)
  writeJson(join(out, 'runtime-events.json'), exceptions)
  check('noRuntimeExceptions', exceptions.length === 0)

  result = {
    phase: 'GUI-P3-review', pass: Object.values(checks).every(Boolean), checkCount: Object.keys(checks).length,
    checks, runId, root, out, port: PORT, reviewSessionId, sourceSessionId,
    agentId: agent.agentId, sourceCaseId: source.caseId, correctionFeedbackId: correction.feedbackId,
    currentSnapshotId: published.snapshotId, currentLearningRunId: published.learningRunId,
    rejectedDraftCount: 21, processPids: { mainPid, hostPid: host.pid },
    artifacts: {
      rpcEvidence: join(out, 'rpc-evidence.json'), sqliteDatabase: join(out, 'decision.db'),
      cleanup: join(out, 'exact-pid-cleanup.json'), screenshots,
    },
    scratch: { root, disposition: 'retained', realProfileTouched: false },
  }
  requireEvidence(result.pass, 'aggregate GUI-P3 review checks')
  writeJson(join(out, 'result.json'), result)
  writeJson(join(GUI, 'review-result.json'), result)
  writeJson(join(out, 'cleanup-receipt.json'), cleanup)
  const report = `# GUI-P3 focused review evidence\n\nPASS: ${result.checkCount} checks in a fresh isolated Desktop on port ${PORT}.\n\n- Cross-root Case source reviewed read-only while the general root-scoped record reader returned null.\n- Correction Feedback direction/scope/supersedes reviewed read-only.\n- Current published Snapshot retained authoritative revision and working detail/Rollback after 21 newer rejected drafts.\n- Real Rollback click changed SQLite from published revision ${published.revision} to rolled_back revision ${rolled.revision}.\n- Raw RPC reads: rpc-evidence.json; SQLite phases: sqlite-*.json and decision.db; DOM: dom-*.json; screenshots: ${screenshots.length}.\n- Exact owned main/Host PIDs ${mainPid}/${host.pid} stopped; port ${PORT} free.\n- Scratch retained at ${root}; current App and real stores were not used.\n`
  writeJson(join(GUI, 'review-latest.json'), { runId, root, out, port: PORT, status: 'passed', result: join(out, 'result.json') })
  writeFileSync(join(out, 'evidence.md'), report)
  writeFileSync(join(GUI, 'review-evidence.md'), report)
} catch (error) {
  failure = error
  if (instance?.cdp) {
    await screenshot('failure').catch(() => {})
    writeJson(join(out, 'failure-dom.json'), await instance.cdp.evaluate('({text:document.body.innerText,html:document.body.innerHTML})').catch(() => null))
  }
} finally {
  if (instance) {
    try {
      await stopOwnedInstance()
    } catch (cleanupError) {
      failure ??= cleanupError
      writeJson(join(out, 'cleanup-error.json'), { message: cleanupError?.message ?? String(cleanupError), stack: cleanupError?.stack ?? null })
    }
    instance = null
  }
  writeJson(join(out, 'rpc-evidence.json'), rpcEvidence)
}

if (failure) {
  const failed = { phase: 'GUI-P3-review', pass: false, runId, root, out, port: PORT, checks, cleanup, error: failure?.message ?? String(failure) }
  writeJson(join(out, 'driver-error.json'), { message: failure?.message ?? String(failure), stack: failure?.stack ?? null, checks, cleanup })
  writeJson(join(out, 'result.json'), failed)
  writeJson(join(GUI, 'review-result.json'), failed)
  writeJson(join(GUI, 'review-latest.json'), { runId, root, out, port: PORT, status: 'failed', error: failed.error })
  console.error(failure)
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ phase: result.phase, pass: result.pass, checkCount: result.checkCount, checks, out }, null, 2))
}
