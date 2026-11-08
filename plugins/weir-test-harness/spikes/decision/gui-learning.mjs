// GUI-P3: manual learning and Snapshot lifecycle on a NEW isolated Desktop.
// Only exact spawned main/Host PIDs are signalled. Never targets the current App.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson } from '../../../weir-harness/src/decision/contracts.js'
import {
  LANE, writeJson, prepareProfile, startInstance, stopInstance, cdpScreenshot,
  createSession, openSession, selectDecisionTab, createAgent, setSelector,
  submitMarker, waitCase, clickButton,
} from './gui-qa.mjs'
import { waitFor } from './cdp.mjs'

const PORT = 9466
const GUI = join(LANE, '.weir', 'decision-p3', 'gui')
mkdirSync(GUI, { recursive: true })
const root = mkdtempSync(join(GUI, 'desktop-learning-'))
const runId = basename(root).replace('desktop-learning-', '')
const out = join(GUI, `learning-${runId}`)
mkdirSync(out)
const databasePath = join(root, 'home', 'weir', 'profiles', 'desktop', 'decisions', 'decision.db')
const questionIds = {
  afterV1: 'gui-learning-after-v1',
  afterV2: 'gui-learning-after-v2',
  predecessor: 'gui-learning-after-rollback',
  empty: 'gui-learning-after-empty',
}
const tables = [
  'agent_profiles', 'agent_profile_revisions', 'cases', 'attempts', 'evidence',
  'attempt_evidence', 'feedback', 'corrections', 'learning_runs', 'memory_snapshots', 'selectors',
]
const checks = {}
const events = []
const cleanups = []
const rpcEvidence = []
const authorityPhases = []
const comparisons = []
const screenshots = []
let instance = null
let failure = null
let result = null

function check(name, value) {
  checks[name] = Boolean(value)
  if (!value) throw new Error(`GUI-P3 check failed: ${name}`)
}

function requireEvidence(value, message) {
  if (!value) throw new Error(`GUI-P3 evidence mismatch: ${message}`)
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')
}

function layerLength(value) {
  return typeof value === 'string' ? value.length : JSON.stringify(value).length
}

function readTrace() {
  const path = join(out, 'mock-trace.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function screenshot(value, name) {
  const path = join(out, `${name}.png`)
  await cdpScreenshot(value, path)
  requireEvidence(statSync(path).size > 0, `${name} screenshot is non-empty`)
  screenshots.push(path)
}

async function cdpPortFree() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
    return false
  } catch {
    return true
  }
}

function portListeners() {
  const probe = spawnSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return probe.stdout?.trim() ?? ''
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
  await waitFor(async () => await cdpPortFree() && !portListeners(), 10_000)
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
    portReleased: await cdpPortFree() && !portListeners(),
    scratch: { root, disposition: 'retained', reason: 'lane-local isolated replay evidence' },
  }
  receipt.pass = receipt.mainStopped && receipt.hostStopped && receipt.portReleased
  writeJson(join(out, `${label}-exact-pid-cleanup.json`), receipt)
  cleanups.push(receipt)
  requireEvidence(receipt.pass, `${label} exact-PID cleanup`)
  return receipt
}

async function rpc(value, sessionId, phase, method, args = {}) {
  const transport = await value.cdp.evaluate(`window.__decisionQA.decision(${JSON.stringify(method)}, ${JSON.stringify({ sessionId, ...args })})`)
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
  let raw
  try {
    raw = {
      phase,
      path: databasePath,
      schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      schema: db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    }
  } finally {
    db.close()
  }
  requireEvidence(raw.schemaVersion === 1 && raw.integrity === 'ok', `${phase} SQLite v1 integrity`)
  writeJson(join(out, `sqlite-${phase}.json`), raw)
  authorityPhases.push(raw)
  return raw
}

async function captureAuthority(phase, { agentId, sessionId, runId = null, snapshotId = null, caseId = null }) {
  const agent = await rpc(instance, sessionId, phase, 'agent', { agentId })
  const run = runId ? await rpc(instance, sessionId, phase, 'learningRun', { learningRunId: runId }) : null
  const snapshot = snapshotId ? await rpc(instance, sessionId, phase, 'memorySnapshot', { snapshotId }) : null
  const parentSnapshotId = run?.inputFrozen?.parentSnapshotId ?? null
  const parentSnapshot = parentSnapshotId && parentSnapshotId !== snapshotId
    ? await rpc(instance, sessionId, phase, 'memorySnapshot', { snapshotId: parentSnapshotId })
    : null
  const record = caseId ? await rpc(instance, sessionId, phase, 'record', { caseId }) : null
  const raw = sqliteSnapshot(phase)
  const runRow = runId ? raw.rows.learning_runs.find(row => row.learning_run_id === runId) : null
  const snapshotRow = snapshotId ? raw.rows.memory_snapshots.find(row => row.snapshot_id === snapshotId) : null
  const currentRow = [...raw.rows.memory_snapshots].filter(row => row.agent_id === agentId && row.state === 'published')
    .sort((left, right) => right.version - left.version || right.snapshot_id.localeCompare(left.snapshot_id))[0] ?? null
  requireEvidence((agent.currentSnapshotId ?? null) === (currentRow?.snapshot_id ?? null), `${phase} RPC current Snapshot equals highest published SQLite row`)
  requireEvidence(agent.generatedDescription?.revision === 0 && agent.generatedDescription?.text === '', `${phase} generatedDescription remains empty`)
  requireEvidence(raw.rows.agent_profiles.find(row => row.agent_id === agentId)?.generated_desc_rev === 0, `${phase} SQLite generated description revision remains zero`)
  if (run) {
    requireEvidence(runRow && runRow.outcome === run.outcome && runRow.revision === run.revision, `${phase} LearningRun outcome/revision RPC=SQLite`)
    requireEvidence(JSON.stringify(JSON.parse(runRow.input_frozen_json)) === JSON.stringify(run.inputFrozen), `${phase} frozen input RPC=SQLite`)
    requireEvidence(JSON.stringify(JSON.parse(runRow.operations_json)) === JSON.stringify(run.operations), `${phase} operations RPC=SQLite`)
    requireEvidence(JSON.stringify(runRow.replay_json ? JSON.parse(runRow.replay_json) : undefined) === JSON.stringify(run.replay), `${phase} replay RPC=SQLite`)
  }
  if (snapshot) {
    requireEvidence(snapshotRow && snapshotRow.state === snapshot.state && snapshotRow.revision === snapshot.revision, `${phase} Snapshot state/revision RPC=SQLite`)
    requireEvidence(snapshotRow.version === snapshot.version && (snapshotRow.parent_snapshot_id ?? null) === snapshot.parentSnapshotId && snapshotRow.learning_run_id === snapshot.learningRunId, `${phase} Snapshot lineage RPC=SQLite`)
    requireEvidence(JSON.stringify(JSON.parse(snapshotRow.principles_json)) === JSON.stringify(snapshot.principles), `${phase} principles RPC=SQLite`)
    requireEvidence(JSON.stringify(JSON.parse(snapshotRow.generated_description_json)) === JSON.stringify({ revision: 0, text: '' }), `${phase} Snapshot generatedDescription empty`)
    requireEvidence(snapshot.generatedDescription?.revision === 0 && snapshot.generatedDescription?.text === '', `${phase} RPC Snapshot generatedDescription empty`)
    const contentHash = digest({
      version: snapshot.version, parentSnapshotId: snapshot.parentSnapshotId, principles: snapshot.principles,
      generatedDescription: snapshot.generatedDescription, learningRunId: snapshot.learningRunId,
    })
    requireEvidence(contentHash === snapshot.contentHash, `${phase} Snapshot contentHash matches immutable content`)
  }
  if (record) {
    for (const attempt of record.attempts) {
      const row = raw.rows.attempts.find(item => item.attempt_id === attempt.attemptId)
      requireEvidence(row && row.outcome === attempt.outcome && row.revision === attempt.revision, `${phase} Attempt ${attempt.attemptId} outcome/revision RPC=SQLite`)
      requireEvidence(JSON.stringify(JSON.parse(row.pins_json)) === JSON.stringify(attempt.pins), `${phase} Attempt pins RPC=SQLite`)
      requireEvidence(JSON.stringify(JSON.parse(row.pack_manifest_json)) === JSON.stringify(attempt.packManifest), `${phase} Attempt manifest RPC=SQLite`)
      requireEvidence(row.context_pack_hash === attempt.contextPackHash, `${phase} Attempt hash RPC=SQLite`)
    }
  }
  const authority = { phase, agent, run, snapshot, parentSnapshot, record, sqlite: join(out, `sqlite-${phase}.json`) }
  writeJson(join(out, `authority-${phase}.json`), authority)
  writeJson(join(out, `rpc-${phase}.json`), rpcEvidence.filter(item => item.phase === phase))
  comparisons.push({
    phase,
    pass: true,
    agentId,
    currentSnapshotId: agent.currentSnapshotId ?? null,
    run: run ? { learningRunId: run.learningRunId, outcome: run.outcome, revision: run.revision } : null,
    snapshot: snapshot ? { snapshotId: snapshot.snapshotId, state: snapshot.state, version: snapshot.version, revision: snapshot.revision, contentHash: snapshot.contentHash } : null,
    caseId,
    attemptIds: record?.attempts?.map(attempt => attempt.attemptId) ?? [],
  })
  writeJson(join(out, 'rpc-sqlite-comparisons.json'), comparisons)
  return authority
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

async function openAgent(value, agent) {
  await selectDecisionTab(value, 0)
  await waitFor(() => value.cdp.evaluate(`(() => {
    const button=[...document.querySelectorAll('main button')].find(el=>el.offsetParent!==null&&el.textContent.startsWith(${JSON.stringify(`${agent.name} · `)}))
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
  await waitFor(() => value.cdp.evaluate(`(() => {
    const section=[...document.querySelectorAll('main section[aria-label]')].find(el=>/Learning and Snapshots|学习与 Snapshot/.test(el.getAttribute('aria-label')||''))
    return Boolean(section&&section.closest('article')?.innerText.includes(${JSON.stringify(agent.agentId)}))
  })()`), 30_000)
}

async function governanceState(value) {
  return value.cdp.evaluate(`(() => {
    const visible=el=>Boolean(el&&el.offsetParent!==null)
    const section=[...document.querySelectorAll('main section[aria-label]')].find(el=>/Learning and Snapshots|学习与 Snapshot/.test(el.getAttribute('aria-label')||''))
    if(!section)return null
    const detail=section.querySelector('[data-learning-run-detail]')
    return {
      text:section.innerText,
      articleText:section.closest('article')?.innerText??'',
      nav:[...document.querySelectorAll('main nav button')].map(el=>el.textContent.trim()),
      controls:[...section.querySelectorAll('button,a,input,textarea,select,[role="button"]')].filter(visible).map(el=>({tag:el.tagName,text:el.textContent?.trim()??'',aria:el.getAttribute('aria-label')??'',disabled:el.disabled===true})),
      runIds:[...section.querySelectorAll('[data-learning-run-id]')].map(el=>el.getAttribute('data-learning-run-id')),
      snapshotIds:[...section.querySelectorAll('[data-snapshot-id]')].map(el=>el.getAttribute('data-snapshot-id')),
      detailRunId:detail?.getAttribute('data-learning-run-detail')??null,
      detailText:detail?.innerText??'',
      detailReadOnly:Boolean(detail&&!detail.isContentEditable&&detail.querySelectorAll('input,textarea,select,[contenteditable="true"]').length===0),
    }
  })()`)
}

async function contextPackState(value, caseId) {
  return value.cdp.evaluate(`(() => {
    const detail=document.querySelector('[data-readonly-record=${JSON.stringify(caseId)}]')
    if(!detail)return null
    const label=(pack,pattern)=>[...pack.querySelectorAll('strong')].find(el=>pattern.test(el.textContent))?.parentElement
    return [...detail.querySelectorAll('[data-attempt-context-pack]')].map(pack=>{
      pack.open=true
      const layerSizes={}
      for(const row of pack.querySelectorAll('dl > div')){
        const layer=row.querySelector('dt')?.textContent.trim()
        const size=row.querySelector('dd')?.textContent.trim()
        if(layer)layerSizes[layer]=Number(size)
      }
      const pinText=label(pack,/Snapshot pinned|固定的 Snapshot/)?.querySelector('pre')?.textContent
      const principles=label(pack,/Reviewed L2 principles|经审阅的 L2 原则/)
      const omissions=label(pack,/Omissions|省略项/)
      return {
        attemptId:pack.getAttribute('data-attempt-context-pack'),
        ariaLabel:pack.getAttribute('aria-label'),
        text:pack.innerText,
        pin:pinText?JSON.parse(pinText):null,
        principleIds:principles?[...principles.querySelectorAll('li > code')].map(el=>el.textContent.trim()):[],
        mappings:principles?[...principles.querySelectorAll('pre')].map(el=>JSON.parse(el.textContent)):[],
        layerSizes,
        omissions:omissions?[...omissions.querySelectorAll('ul code')].map(el=>el.textContent.trim()):[],
        readOnly:!pack.isContentEditable&&pack.querySelectorAll('input,textarea,button,select,[contenteditable="true"]').length===0,
      }
    })
  })()`)
}

function verifyContextPack(dom, attempt, sourceCaseId) {
  requireEvidence(dom?.length === 1 && dom[0].attemptId === attempt.attemptId, `${attempt.attemptId} has one rendered Context Pack`)
  const pack = dom[0]
  const l2 = attempt.packManifest?.memory?.L2
  requireEvidence(pack.readOnly === true, `${attempt.attemptId} Context Pack is read-only`)
  requireEvidence(/non-authoritative|非权威/.test(pack.text) && /L5 evidence remains authoritative|L5 证据仍为权威来源/.test(pack.text), `${attempt.attemptId} L2 non-authoritative label`)
  requireEvidence(JSON.stringify(pack.principleIds) === JSON.stringify(l2?.principleIds ?? []), `${attempt.attemptId} actual principle ids DOM=RPC`)
  requireEvidence(JSON.stringify(pack.layerSizes) === JSON.stringify(attempt.packManifest.layerSizes), `${attempt.attemptId} layer sizes DOM=RPC`)
  requireEvidence(JSON.stringify(pack.omissions) === JSON.stringify(attempt.packManifest.omissions), `${attempt.attemptId} omissions DOM=RPC`)
  const expectedPin = {
    snapshotId: attempt.pins?.memorySnapshotId ?? null,
    snapshotRevision: attempt.pins?.memorySnapshotRevision ?? null,
    snapshotHash: attempt.pins?.memorySnapshotHash ?? null,
  }
  if (expectedPin.snapshotId) requireEvidence(JSON.stringify(pack.pin) === JSON.stringify(expectedPin), `${attempt.attemptId} Snapshot pin DOM=RPC`)
  else requireEvidence(pack.pin === null && /No Snapshot was pinned|未固定 Snapshot/.test(pack.text), `${attempt.attemptId} empty pin shown truthfully`)
  const expectedMappings = (l2?.items ?? []).map(item => ({ sources: item.sources, evidenceIds: item.evidenceIds }))
  requireEvidence(JSON.stringify(pack.mappings) === JSON.stringify(expectedMappings), `${attempt.attemptId} L5 mappings DOM=RPC`)
  if (expectedMappings.length) requireEvidence(pack.text.includes(sourceCaseId), `${attempt.attemptId} source Case visible`)
  return true
}

async function waitAgent(sessionId, agentId, phase, predicate) {
  return waitFor(async () => {
    const agent = await rpc(instance, sessionId, phase, 'agent', { agentId })
    return predicate(agent) ? agent : null
  }, 90_000)
}

async function consolidateCandidate(agent, sessionId, label, expectedText) {
  await openAgent(instance, agent)
  const before = readTrace().filter(request => request.decisionGuiLearning?.kind === 'consolidation').length
  await clickButton(instance, ['Consolidate', '手动整合'])
  const agentValue = await waitAgent(sessionId, agent.agentId, `wait-${label}`, value => value.learningRuns.some(run => run.outcome === 'candidate'))
  const candidateRun = agentValue.learningRuns.find(run => run.outcome === 'candidate')
  const candidateSnapshot = agentValue.snapshots.find(snapshot => snapshot.learningRunId === candidateRun.learningRunId && snapshot.state === 'draft')
  requireEvidence(candidateRun && candidateSnapshot, `${label} candidate run/draft exist after explicit click`)
  const authority = await captureAuthority(label, { agentId: agent.agentId, sessionId, runId: candidateRun.learningRunId, snapshotId: candidateSnapshot.snapshotId })
  const run = authority.run
  const snapshot = authority.snapshot
  requireEvidence(run.trigger === 'manual' && run.outcome === 'candidate' && run.replay?.passed === true, `${label} manual candidate with passing structural replay`)
  requireEvidence(run.operations.length === 1 && run.operations[0].op === 'add' && run.operations[0].text === expectedText, `${label} normalized operation`)
  requireEvidence(run.operations[0].principleId === snapshot.principles.at(-1)?.principleId, `${label} final principle id is Host allocated`)
  requireEvidence(snapshot.state === 'draft' && snapshot.revision === 1 && snapshot.principles.at(-1)?.text === expectedText, `${label} immutable draft content`)
  requireEvidence(agentValue.currentSnapshotId === null || agentValue.currentSnapshotId === run.inputFrozen.parentSnapshotId, `${label} candidate does not auto-publish`)
  const after = readTrace().filter(request => request.decisionGuiLearning?.kind === 'consolidation').length
  requireEvidence(after === before + 1, `${label} exactly one consolidation wire per click`)
  const dom = await waitFor(async () => {
    const value = await governanceState(instance)
    return value?.detailRunId === run.learningRunId && value.detailText.includes(snapshot.snapshotId) ? value : null
  }, 30_000)
  writeJson(join(out, `dom-${label}.json`), dom)
  for (const text of [
    run.learningRunId, snapshot.snapshotId, snapshot.principles.at(-1).principleId, expectedText,
    run.inputFrozen.promptVersion, run.inputFrozen.inputHash, run.inputFrozen.feedbackDigest,
    run.replay.finalHash, run.inputFrozen.caseIds[0],
  ]) requireEvidence(dom.detailText.includes(text), `${label} rendered review includes ${text}`)
  for (const pattern of [
    /Candidate operations|候选操作/, /Principle diff|原则差异/, /Frozen input summary|冻结输入摘要/,
    /Structural replay passed|结构重放通过/,
    /Structural checks only; reviewing and publishing remain manual|仅表示结构校验；审阅与发布仍由用户手动完成/,
  ]) requireEvidence(pattern.test(dom.detailText), `${label} rendered review matches ${pattern}`)
  requireEvidence(dom.detailReadOnly && dom.nav.length === 4 && dom.runIds.includes(run.learningRunId) && dom.snapshotIds.includes(snapshot.snapshotId), `${label} read-only detail in four-view governance`)
  const forbidden = dom.controls.filter(control => /auto(?:matic)?[ -]?(?:consolidat|publish|route)|schedule|profile learning|generatedDescription.*(?:learn|edit)|cross[ -]workspace|export|import/i.test(`${control.text} ${control.aria}`))
  requireEvidence(forbidden.length === 0, `${label} no automatic/future-capability controls`)
  await instance.cdp.evaluate(`document.querySelector('[data-learning-run-detail=${JSON.stringify(run.learningRunId)}]')?.scrollIntoView({block:'start'})`)
  await screenshot(instance, label)
  return authority
}

async function reviewCandidateSource(agent, sessionId, authority, sourceCaseId) {
  await waitFor(() => instance.cdp.evaluate(`(() => {
    const button=[...document.querySelectorAll('[data-learning-run-detail] button')].find(el=>el.textContent.trim()===${JSON.stringify(sourceCaseId)})
    if(!button)return false
    button.click()
    return true
  })()`), 30_000)
  await waitFor(() => instance.cdp.evaluate(`Boolean(document.querySelector('[data-readonly-record=${JSON.stringify(sourceCaseId)}]'))`), 30_000)
  const text = await instance.cdp.evaluate(`document.querySelector('[data-readonly-record=${JSON.stringify(sourceCaseId)}]').innerText`)
  requireEvidence(text.includes(sourceCaseId) && text.includes('User backed GUI answer'), 'candidate source link opens the actual authoritative record')
  await screenshot(instance, '03-candidate-v1-source')
  await openAgent(instance, agent)
  const restored = await waitFor(async () => {
    const value = await governanceState(instance)
    return value?.detailRunId === authority.run.learningRunId ? value : null
  }, 30_000)
  writeJson(join(out, 'dom-03-candidate-v1-restored.json'), restored)
}

async function publishCandidate(agent, sessionId, authority, label) {
  await openAgent(instance, agent)
  await clickButton(instance, ['Publish', '发布'])
  const snapshotId = authority.snapshot.snapshotId
  const agentValue = await waitAgent(sessionId, agent.agentId, `wait-${label}`, value => value.currentSnapshotId === snapshotId && value.learningRuns.find(run => run.learningRunId === authority.run.learningRunId)?.outcome === 'published')
  const published = await captureAuthority(label, { agentId: agent.agentId, sessionId, runId: authority.run.learningRunId, snapshotId })
  requireEvidence(published.run.outcome === 'published' && published.snapshot.state === 'published' && published.snapshot.revision === 2, `${label} explicit publish revisions`)
  requireEvidence(published.snapshot.contentHash === authority.snapshot.contentHash && JSON.stringify(published.snapshot.principles) === JSON.stringify(authority.snapshot.principles), `${label} publish preserves immutable content`)
  requireEvidence(agentValue.currentSnapshotId === snapshotId, `${label} current Snapshot changed only after Publish`)
  const dom = await waitFor(async () => {
    const value = await governanceState(instance)
    return value?.text.includes(snapshotId) && /Published|已发布/.test(value.text) ? value : null
  }, 30_000)
  writeJson(join(out, `dom-${label}.json`), dom)
  await screenshot(instance, label)
  return published
}

async function rollbackCurrent(agent, sessionId, authority, expectedCurrentId, label) {
  await openAgent(instance, agent)
  await clickButton(instance, ['Rollback', '回滚'])
  const snapshotId = authority.snapshot.snapshotId
  await waitAgent(sessionId, agent.agentId, `wait-${label}`, value => (value.currentSnapshotId ?? null) === expectedCurrentId && value.snapshots.find(snapshot => snapshot.snapshotId === snapshotId)?.state === 'rolled_back')
  const rolled = await captureAuthority(label, { agentId: agent.agentId, sessionId, runId: authority.run.learningRunId, snapshotId })
  requireEvidence(rolled.run.outcome === 'rolled_back' && rolled.snapshot.state === 'rolled_back' && rolled.snapshot.revision === 3, `${label} rollback revisions`)
  requireEvidence(rolled.snapshot.contentHash === authority.snapshot.contentHash && JSON.stringify(rolled.snapshot.principles) === JSON.stringify(authority.snapshot.principles), `${label} rollback preserves immutable content`)
  requireEvidence((rolled.agent.currentSnapshotId ?? null) === expectedCurrentId, `${label} correct predecessor/empty current`)
  const dom = await waitFor(async () => {
    const value = await governanceState(instance)
    return value?.text.includes(snapshotId) && /Rolled back|已回滚/.test(value.text) ? value : null
  }, 30_000)
  if (!expectedCurrentId) requireEvidence(/No current published Snapshot|当前没有已发布的 Snapshot/.test(dom.text), `${label} DOM shows true empty current`)
  else requireEvidence(dom.text.includes(expectedCurrentId), `${label} DOM shows restored predecessor`)
  writeJson(join(out, `dom-${label}.json`), dom)
  await screenshot(instance, label)
  return rolled
}

async function attemptWithL2(agent, sessionId, marker, questionId, expected, label) {
  await openSession(instance, sessionId)
  await submitMarker(instance, marker)
  const item = await waitCase(instance, sessionId, questionId, current => current.state === 'closed')
  requireEvidence(item.closing === 'answered' && item.decision?.kind === 'answer', `${label} closes with an evidence-bound answer`)
  const authority = await captureAuthority(label, {
    agentId: agent.agentId, sessionId, caseId: item.caseId,
    runId: expected.run?.learningRunId ?? null, snapshotId: expected.snapshot?.snapshotId ?? null,
  })
  requireEvidence(authority.record.attempts.length === 1, `${label} one Attempt`)
  const attempt = authority.record.attempts[0]
  const l2 = attempt.packManifest?.memory?.L2
  requireEvidence(attempt.outcome === 'answer' && attempt.pins.promptVersion === 'evaluator-contract/3', `${label} evaluator v3 answer`)
  requireEvidence((attempt.pins.memorySnapshotId ?? null) === (expected.snapshot?.snapshotId ?? null), `${label} Snapshot id pin`)
  requireEvidence((attempt.pins.memorySnapshotRevision ?? null) === (expected.snapshot?.revision ?? null), `${label} Snapshot revision pin`)
  requireEvidence((attempt.pins.memorySnapshotHash ?? null) === (expected.snapshot?.contentHash ?? null), `${label} Snapshot hash pin`)
  requireEvidence(l2?.snapshotId === (expected.snapshot?.snapshotId ?? null) && l2.snapshotRevision === (expected.snapshot?.revision ?? null) && l2.snapshotHash === (expected.snapshot?.contentHash ?? null), `${label} manifest pin`)
  requireEvidence(JSON.stringify(l2.principleIds) === JSON.stringify(expected.principleIds), `${label} actual L2 principles`)
  requireEvidence(attempt.packManifest.layerSizes.L2 > 0 === expected.principleIds.length > 0, `${label} L2 layer size reflects actual use`)
  requireEvidence(attempt.citedEvidenceIds.length > 0 && attempt.citedEvidenceIds.every(id => attempt.packManifest.evidenceIds.includes(id) && !expected.principleIds.includes(id)), `${label} answer cites actual L5 only`)
  await openRecordDetail(instance, item.caseId)
  const dom = await contextPackState(instance, item.caseId)
  writeJson(join(out, `dom-${label}-context-pack.json`), dom)
  check(`${label}ReadonlyL2ProvenanceDom`, verifyContextPack(dom, attempt, expected.sourceCaseId))
  await instance.cdp.evaluate(`document.querySelector('[data-attempt-context-pack=${JSON.stringify(attempt.attemptId)}]')?.scrollIntoView({block:'start'})`)
  await screenshot(instance, label)
  return { caseId: item.caseId, questionId, detail: authority.record, attempt, dom, authority }
}

function immutableHistoryReport() {
  const tracked = {
    cases: 'case_id', attempts: 'attempt_id', feedback: 'feedback_id', evidence: 'evidence_id',
    attempt_evidence: null, agent_profile_revisions: null,
  }
  const seen = Object.fromEntries(Object.keys(tracked).map(table => [table, new Map()]))
  const snapshotContent = new Map()
  const mutations = []
  const schema = []
  for (const phase of authorityPhases) {
    if (phase.schemaVersion !== 1 || phase.integrity !== 'ok') mutations.push({ phase: phase.phase, kind: 'schema/integrity' })
    schema.push({ phase: phase.phase, digest: digest(phase.schema) })
    for (const [table, keyField] of Object.entries(tracked)) {
      for (const row of phase.rows[table]) {
        const key = keyField ? row[keyField] : table === 'attempt_evidence' ? `${row.attempt_id}:${row.ordinal}` : `${row.agent_id}:${row.kind}:${row.revision}`
        const value = JSON.stringify(row)
        if (seen[table].has(key) && seen[table].get(key).value !== value) mutations.push({ phase: phase.phase, table, key, before: seen[table].get(key).phase })
        else seen[table].set(key, { phase: phase.phase, value })
      }
    }
    for (const row of phase.rows.memory_snapshots) {
      const content = JSON.stringify({
        version: row.version, parent_snapshot_id: row.parent_snapshot_id, principles_json: row.principles_json,
        generated_description_json: row.generated_description_json, learning_run_id: row.learning_run_id,
        created_at: row.created_at, schema_version: row.schema_version,
      })
      if (snapshotContent.has(row.snapshot_id) && snapshotContent.get(row.snapshot_id).value !== content) mutations.push({ phase: phase.phase, table: 'memory_snapshots.content', key: row.snapshot_id })
      else snapshotContent.set(row.snapshot_id, { phase: phase.phase, value: content })
      if (row.generated_description_json !== JSON.stringify({ revision: 0, text: '' })) mutations.push({ phase: phase.phase, table: 'memory_snapshots.generatedDescription', key: row.snapshot_id })
    }
  }
  const report = {
    pass: mutations.length === 0 && schema.every(item => item.digest === schema[0]?.digest),
    phases: authorityPhases.map(phase => phase.phase),
    mutations,
    schema,
    historicalRows: Object.fromEntries(Object.entries(seen).map(([table, rows]) => [table, rows.size])),
    immutableSnapshotContentCount: snapshotContent.size,
    answerPayloadsCoveredBy: ['cases.decision_json', 'attempts.claims_json'],
  }
  writeJson(join(out, 'immutable-history.json'), report)
  return report
}

function verifyModelWire(attempts, runs) {
  const trace = readTrace()
  const wires = trace.filter(request => request.decisionGuiLearning)
  writeJson(join(out, 'model-wire.json'), wires)
  const consolidation = wires.filter(request => request.decisionGuiLearning.kind === 'consolidation')
  requireEvidence(consolidation.length === runs.length && runs.length === 3, 'exactly three manual consolidation wires')
  for (const run of runs) {
    const matches = consolidation.filter(request => digest(request.decisionGuiLearning.content) === run.inputFrozen.inputHash)
    requireEvidence(matches.length === 1, `${run.learningRunId} inputHash identifies exactly one actual wire`)
    const wire = matches[0].decisionGuiLearning
    requireEvidence(wire.system.split('\n', 1)[0] === 'Decision consolidation contract v1', `${run.learningRunId} consolidation contract`)
    const projection = JSON.parse(wire.content)
    requireEvidence(JSON.stringify(projection.cases.map(item => item.caseId)) === JSON.stringify(run.inputFrozen.caseIds), `${run.learningRunId} frozen cases equal wire`)
    requireEvidence(JSON.stringify(projection.feedback.map(item => item.feedbackId)) === JSON.stringify(run.inputFrozen.feedbackIds), `${run.learningRunId} frozen feedback equals wire`)
    requireEvidence(!Object.hasOwn(projection, 'generatedDescription') && !wire.content.includes('temporary-gui-learning'), `${run.learningRunId} no generatedDescription/raw temporary id in input`)
  }
  const proofs = []
  for (const [key, item] of Object.entries(attempts)) {
    const matches = wires.filter(request => request.decisionGuiLearning.kind === 'evaluator' && request.decisionGuiLearning.pack?.L4?.request?.questions?.[0]?.id === item.questionId)
    requireEvidence(matches.length === 1, `${key} exactly one evaluator wire`)
    const wire = matches[0].decisionGuiLearning
    const pack = wire.pack
    const attempt = item.attempt
    const principles = Array.isArray(pack.L2) ? pack.L2 : []
    requireEvidence(wire.system.split('\n', 1)[0] === 'Decision evaluator contract v3', `${key} evaluator v3 wire`)
    requireEvidence(JSON.stringify(principles.map(principle => principle.principleId)) === JSON.stringify(attempt.packManifest.memory.L2.principleIds), `${key} wire principles equal actual manifest`)
    requireEvidence(JSON.stringify(attempt.packManifest.evidenceIds) === JSON.stringify(pack.L5.map(ref => ref.evidenceId)), `${key} wire/manifest evidence ids match`)
    requireEvidence(attempt.citedEvidenceIds.every(id => pack.L5.some(ref => ref.evidenceId === id) && !principles.some(principle => principle.principleId === id)), `${key} cited ids are actual L5, never L2`)
    for (const principle of principles) requireEvidence(principle.evidenceIds.every(id => pack.L5.some(ref => ref.evidenceId === id)), `${key} every L2 source expands to actual L5`)
    const expectedHash = digest({
      pins: attempt.pins, request: pack.L4.request,
      evidenceIds: attempt.packManifest.evidenceIds, correctionIds: attempt.packManifest.correctionIds,
      L2: pack.L2, L3: pack.L3, omissions: attempt.packManifest.omissions,
    })
    requireEvidence(expectedHash === attempt.contextPackHash, `${key} contextPackHash matches actual wire`)
    requireEvidence(attempt.packManifest.layerSizes.L0 === wire.system.length, `${key} exact L0 size`)
    for (const layer of ['L1', 'L2', 'L3', 'L4', 'L5']) requireEvidence(attempt.packManifest.layerSizes[layer] === layerLength(pack[layer]), `${key} exact ${layer} size`)
    proofs.push({ key, questionId: item.questionId, attemptId: attempt.attemptId, contextPackHash: attempt.contextPackHash, snapshotId: attempt.pins.memorySnapshotId ?? null, principleIds: principles.map(principle => principle.principleId), citedEvidenceIds: attempt.citedEvidenceIds })
  }
  requireEvidence(wires.every(request => {
    const wire = request.decisionGuiLearning
    return wire.tools.length === 0 && wire.hasTemperature === false && wire.provider === 'mock' && wire.model === 'mock-1' && wire.maxTokens > 0 && wire.content.length > 0
  }), 'all Decision model wires are tool-free, temperature-free, bounded mock calls')
  requireEvidence(!JSON.stringify(authorityPhases.map(phase => phase.rows)).includes('temporary-gui-learning'), 'raw model temporary id/text envelope is not persisted')
  const report = { pass: true, consolidationCount: consolidation.length, evaluatorProofs: proofs, totalDecisionWires: wires.length }
  writeJson(join(out, 'model-wire-evidence.json'), report)
  return report
}

try {
  check('port9466InitiallyFree', await cdpPortFree() && !portListeners())
  writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'running' })
  prepareProfile(root, PORT)
  instance = await startInstance({ root, out, port: PORT, enabled: true })
  const firstMainPid = instance.app.pid
  const firstHost = await instance.cdp.evaluate('window.__decisionQA.fixture("hostState", {})')
  writeJson(join(out, 'process-1.json'), { mainPid: firstMainPid, host: firstHost, root, port: PORT })
  check('firstProcessUsesDistinctIsolatedRoot', firstHost.profile?.home === join(root, 'home') && firstHost.profile?.name === 'desktop' && (firstHost.pid === firstMainPid || firstHost.parentPid === firstMainPid))

  const session = await createSession(instance)
  const sessionId = session.sessionId
  writeJson(join(out, 'session.json'), session)
  const agent = await createAgent(instance, sessionId, 'GUI-P3 Manual Learning', 'This isolated GUI profile is user-authored configuration, never generatedDescription learning.')
  writeJson(join(out, 'agent.json'), agent)
  await openSession(instance, sessionId)
  await setSelector(instance, sessionId, 'agent', agent.agentId)
  check('agentCreatedAndPinnedThroughDom', agent.state === 'enabled' && (await instance.cdp.evaluate('document.querySelector("select[data-weir-decision-selector]").value')) === agent.agentId)

  await submitMarker(instance, 'GUI_LEARNING_SOURCE')
  const pendingSource = await waitCase(instance, sessionId, 'gui-learning-source', current => current.state === 'awaiting_user')
  const native = await waitFor(async () => {
    const value = await nativeState(instance)
    return value.pending && value.radios.length === 2 ? value : null
  }, 30_000)
  requireEvidence(native.text.includes('Choose the authoritative GUI learning source'), 'source requires genuine native user judgment')
  await answerNative(instance, 'User backed GUI answer')
  const source = await waitCase(instance, sessionId, 'gui-learning-source', current => current.state === 'closed')
  requireEvidence(source.caseId === pendingSource.caseId && source.closing === 'escalated' && source.decision?.kind === 'user_decision' && source.decision.answers[0].selected[0] === 'User backed GUI answer', 'authoritative source is a real user_decision')
  const sourceAuthority = await captureAuthority('01-source-no-auto', { agentId: agent.agentId, sessionId, caseId: source.caseId })
  requireEvidence(sourceAuthority.agent.learningRuns.length === 0 && sourceAuthority.agent.snapshots.length === 0 && sourceAuthority.agent.currentSnapshotId === null, 'source/Attempt activity never auto-starts learning')
  await openAgent(instance, agent)
  const initialDom = await governanceState(instance)
  writeJson(join(out, 'dom-01-source-no-auto.json'), initialDom)
  requireEvidence(initialDom.nav.length === 4 && /No Learning Runs|暂无 Learning Run/.test(initialDom.text) && initialDom.articleText.includes('generatedDescription: {"revision":0,"text":""}'), 'four views, no auto run, empty generatedDescription')
  await screenshot(instance, '01-source-no-auto')

  const candidateV1 = await consolidateCandidate(agent, sessionId, '02-candidate-v1', 'Reviewed GUI principle: prefer the source-backed answer.')
  requireEvidence(candidateV1.snapshot.version === 1 && candidateV1.snapshot.parentSnapshotId === null && candidateV1.snapshot.principles.length === 1 && candidateV1.run.inputFrozen.parentSnapshotId === null, 'v1 candidate has empty parent and one principle')
  await reviewCandidateSource(agent, sessionId, candidateV1, source.caseId)
  const publishedV1 = await publishCandidate(agent, sessionId, candidateV1, '04-published-v1')
  const afterV1 = await attemptWithL2(agent, sessionId, 'GUI_LEARNING_AFTER_V1', questionIds.afterV1, {
    run: publishedV1.run, snapshot: publishedV1.snapshot, sourceCaseId: source.caseId,
    principleIds: publishedV1.snapshot.principles.map(principle => principle.principleId),
  }, '05-attempt-v1')

  const candidateV2 = await consolidateCandidate(agent, sessionId, '06-candidate-v2', 'Reviewed GUI successor principle: prefer the second source-backed answer.')
  requireEvidence(candidateV2.snapshot.version === 2 && candidateV2.snapshot.parentSnapshotId === publishedV1.snapshot.snapshotId && candidateV2.run.inputFrozen.parentSnapshotId === publishedV1.snapshot.snapshotId && candidateV2.run.inputFrozen.parentSnapshotRevision === publishedV1.snapshot.revision, 'v2 candidate freezes published v1 parent')
  requireEvidence(candidateV2.snapshot.principles.length === 2 && candidateV2.run.replay.metrics.activePrincipleCount === 2, 'v2 structural replay retains v1 and adds successor')
  const publishedV2 = await publishCandidate(agent, sessionId, candidateV2, '07-published-v2')
  requireEvidence(publishedV2.parentSnapshot?.snapshotId === publishedV1.snapshot.snapshotId, 'v2 publish RPC includes actual parent diff basis')
  const afterV2 = await attemptWithL2(agent, sessionId, 'GUI_LEARNING_AFTER_V2', questionIds.afterV2, {
    run: publishedV2.run, snapshot: publishedV2.snapshot, sourceCaseId: source.caseId,
    principleIds: publishedV2.snapshot.principles.map(principle => principle.principleId),
  }, '08-attempt-v2')

  const rolledV2 = await rollbackCurrent(agent, sessionId, publishedV2, publishedV1.snapshot.snapshotId, '09-rollback-v2-to-v1')
  const predecessor = await attemptWithL2(agent, sessionId, 'GUI_LEARNING_AFTER_ROLLBACK', questionIds.predecessor, {
    run: rolledV2.run, snapshot: publishedV1.snapshot, sourceCaseId: source.caseId,
    principleIds: publishedV1.snapshot.principles.map(principle => principle.principleId),
  }, '10-attempt-predecessor-v1')
  const rolledV1Authority = await captureAuthority('10b-v1-before-rollback', { agentId: agent.agentId, sessionId, runId: publishedV1.run.learningRunId, snapshotId: publishedV1.snapshot.snapshotId })
  const rolledV1 = await rollbackCurrent(agent, sessionId, rolledV1Authority, null, '11-rollback-v1-to-empty')
  const empty = await attemptWithL2(agent, sessionId, 'GUI_LEARNING_AFTER_EMPTY', questionIds.empty, {
    run: rolledV1.run, snapshot: null, sourceCaseId: source.caseId, principleIds: [],
  }, '12-attempt-empty')

  const candidateReject = await consolidateCandidate(agent, sessionId, '13-candidate-reject', 'Rejected GUI candidate: this principle must never become current.')
  requireEvidence(candidateReject.snapshot.version === 3 && candidateReject.snapshot.parentSnapshotId === null && candidateReject.agent.currentSnapshotId === null, 'reject candidate is unpublished v3 with empty parent')
  await openAgent(instance, agent)
  await clickButton(instance, ['Reject', '拒绝'])
  await waitAgent(sessionId, agent.agentId, 'wait-14-rejected', value => value.learningRuns.find(run => run.learningRunId === candidateReject.run.learningRunId)?.outcome === 'rejected')
  const rejected = await captureAuthority('14-rejected', { agentId: agent.agentId, sessionId, runId: candidateReject.run.learningRunId, snapshotId: candidateReject.snapshot.snapshotId })
  requireEvidence(rejected.run.outcome === 'rejected' && rejected.run.revision === 3 && rejected.snapshot.state === 'draft' && rejected.snapshot.revision === 1 && rejected.agent.currentSnapshotId === null, 'Reject retains immutable unpublished draft and empty current')
  requireEvidence(rejected.snapshot.contentHash === candidateReject.snapshot.contentHash && JSON.stringify(rejected.snapshot.principles) === JSON.stringify(candidateReject.snapshot.principles), 'Reject preserves candidate content')
  const rejectedDom = await waitFor(async () => {
    const value = await governanceState(instance)
    return value?.detailRunId === rejected.run.learningRunId && /已拒绝|· rejected ·/.test(value.detailText) ? value : null
  }, 30_000)
  writeJson(join(out, 'dom-14-rejected.json'), rejectedDom)
  await screenshot(instance, '14-rejected')

  const attempts = { afterV1, afterV2, predecessor, empty }
  const runs = [publishedV1.run, publishedV2.run, rejected.run]
  const beforeRestart = {
    attempts: Object.fromEntries(Object.entries(attempts).map(([key, value]) => [key, value.detail])),
    agent: rejected.agent,
    runCount: rejected.agent.learningRuns.length,
    snapshotCount: rejected.agent.snapshots.length,
    decisionWireCount: readTrace().filter(request => request.decisionGuiLearning).length,
  }
  writeJson(join(out, 'before-restart.json'), beforeRestart)
  const scanBefore = await instance.cdp.evaluate(`window.__decisionQA.fixture('scanSession', ${JSON.stringify({ sessionId })})`)
  writeJson(join(out, 'session-scan-before-restart.json'), scanBefore)
  check('noCommandOrCustomDecisionEventsBeforeRestart', scanBefore.commandEvents.length === 0 && scanBefore.customDecisionEvents.length === 0)

  await stopOwnedInstance(instance, 'process-1')
  collectEvents(instance, 'process-1')
  instance = null
  check('firstExactMainHostAndPortCleanup', cleanups[0].mainStopped && cleanups[0].hostStopped && cleanups[0].portReleased)

  instance = await startInstance({ root, out, port: PORT, enabled: true })
  const secondMainPid = instance.app.pid
  const secondHost = await instance.cdp.evaluate('window.__decisionQA.fixture("hostState", {})')
  writeJson(join(out, 'process-2.json'), { mainPid: secondMainPid, host: secondHost, root, port: PORT })
  check('restartUsesNewOwnedMainAndHostPids', secondMainPid !== firstMainPid && secondHost.pid !== firstHost.pid && secondHost.profile?.home === join(root, 'home') && (secondHost.pid === secondMainPid || secondHost.parentPid === secondMainPid))
  await openSession(instance, sessionId)
  await openAgent(instance, agent)
  const restarted = await captureAuthority('15-restart-rejected', { agentId: agent.agentId, sessionId, runId: rejected.run.learningRunId, snapshotId: rejected.snapshot.snapshotId, caseId: afterV1.caseId })
  requireEvidence(restarted.agent.currentSnapshotId === null && restarted.agent.learningRuns.length === beforeRestart.runCount && restarted.agent.snapshots.length === beforeRestart.snapshotCount, 'restart does not auto-run/publish or create versions')
  requireEvidence(restarted.run.outcome === 'rejected' && restarted.run.revision === rejected.run.revision && restarted.snapshot.state === 'draft' && restarted.snapshot.revision === rejected.snapshot.revision, 'rejected candidate survives restart identically')
  for (const prior of [rolledV1, rolledV2]) {
    const run = await rpc(instance, sessionId, '15-restart-rejected', 'learningRun', { learningRunId: prior.run.learningRunId })
    const snapshot = await rpc(instance, sessionId, '15-restart-rejected', 'memorySnapshot', { snapshotId: prior.snapshot.snapshotId })
    requireEvidence(run.outcome === 'rolled_back' && run.revision === prior.run.revision && snapshot.state === 'rolled_back' && snapshot.revision === prior.snapshot.revision, `${prior.snapshot.snapshotId} rollback survives restart`)
  }
  const restartedAttempt = restarted.record.attempts[0]
  requireEvidence(JSON.stringify(restartedAttempt) === JSON.stringify(afterV1.attempt), 'historical published-v1 Attempt is byte-semantically unchanged after rollback/reject/restart')
  await openRecordDetail(instance, afterV1.caseId)
  const restartedPack = await contextPackState(instance, afterV1.caseId)
  writeJson(join(out, 'dom-15-restart-attempt-v1.json'), restartedPack)
  requireEvidence(JSON.stringify(restartedPack) === JSON.stringify(afterV1.dom), 'historical L2 provenance DOM survives restart unchanged')
  await instance.cdp.evaluate(`document.querySelector('[data-attempt-context-pack=${JSON.stringify(restartedAttempt.attemptId)}]')?.scrollIntoView({block:'start'})`)
  await screenshot(instance, '15-restart-attempt-v1')
  await openAgent(instance, agent)
  const restartedDom = await waitFor(async () => {
    const value = await governanceState(instance)
    return value?.detailRunId === rejected.run.learningRunId ? value : null
  }, 30_000)
  writeJson(join(out, 'dom-15-restart-rejected.json'), restartedDom)
  requireEvidence(restartedDom.nav.length === 4 && /Rejected|已拒绝/.test(restartedDom.text) && /Rolled back|已回滚/.test(restartedDom.text), 'restart renders rejected and rolled-back history in four views')
  await screenshot(instance, '16-restart-rejected')
  const scanAfter = await instance.cdp.evaluate(`window.__decisionQA.fixture('scanSession', ${JSON.stringify({ sessionId })})`)
  writeJson(join(out, 'session-scan-after-restart.json'), scanAfter)
  check('noCommandOrCustomDecisionEventsAfterRestart', scanAfter.commandEvents.length === 0 && scanAfter.customDecisionEvents.length === 0)
  check('restartAddsNoDecisionModelCalls', readTrace().filter(request => request.decisionGuiLearning).length === beforeRestart.decisionWireCount)

  await stopOwnedInstance(instance, 'process-2')
  collectEvents(instance, 'process-2')
  instance = null
  check('secondExactMainHostAndPortCleanup', cleanups[1].mainStopped && cleanups[1].hostStopped && cleanups[1].portReleased)
  sqliteSnapshot('17-stopped')
  copyFileSync(databasePath, join(out, 'decision.db'))
  const wire = verifyModelWire(attempts, runs)
  check('modelWireMatchesFrozenRunsAttemptsAndHashes', wire.pass)
  const immutable = immutableHistoryReport()
  check('historicalCaseAttemptAnswerFeedbackAndSnapshotContentImmutable', immutable.pass)
  check('rollbackRestoresPredecessorThenTrueEmpty', predecessor.attempt.pins.memorySnapshotId === publishedV1.snapshot.snapshotId && empty.attempt.pins.memorySnapshotId === null && empty.attempt.packManifest.memory.L2.principleIds.length === 0)
  check('allLifecycleScreenshotsCaptured', screenshots.length >= 15 && screenshots.every(path => existsSync(path) && statSync(path).size > 0))

  writeJson(join(out, 'runtime-events.json'), events)
  const exceptions = events.filter(item => item.event.method === 'Runtime.exceptionThrown')
  const desktopLog = readFileSync(join(out, 'desktop-enabled.log'), 'utf8')
  const importFailures = desktopLog.split('\n').filter(line => /failed to import weir-harness\/decision|SessionFormatUnsupportedError/.test(line))
  writeJson(join(out, 'runtime-scan.json'), { runtimeExceptionCount: exceptions.length, exceptions, importFailures })
  check('noRuntimeExceptionsOrDecisionLoadFailures', exceptions.length === 0 && importFailures.length === 0)

  result = {
    phase: 'GUI-P3',
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
    learningRunIds: runs.map(run => run.learningRunId),
    snapshotIds: [publishedV1.snapshot.snapshotId, publishedV2.snapshot.snapshotId, rejected.snapshot.snapshotId],
    attemptCaseIds: Object.fromEntries(Object.entries(attempts).map(([key, value]) => [key, value.caseId])),
    processPids: [{ mainPid: firstMainPid, hostPid: firstHost.pid }, { mainPid: secondMainPid, hostPid: secondHost.pid }],
    cleanupReceipts: cleanups.map(receipt => join(out, `${receipt.label}-exact-pid-cleanup.json`)),
    artifacts: {
      result: join(out, 'result.json'),
      rpcSqlite: join(out, 'rpc-sqlite-comparisons.json'),
      rpcEvidence: join(out, 'rpc-evidence.json'),
      immutableHistory: join(out, 'immutable-history.json'),
      modelWire: join(out, 'model-wire.json'),
      modelWireEvidence: join(out, 'model-wire-evidence.json'),
      sqliteDatabase: join(out, 'decision.db'),
      runtimeEvents: join(out, 'runtime-events.json'),
      screenshots,
    },
    scratch: { root, disposition: 'retained', realProfileTouched: false },
  }
  requireEvidence(result.pass, 'aggregate GUI-P3 checks')
  writeJson(join(out, 'result.json'), result)
  writeJson(join(GUI, 'result.json'), result)
  writeJson(join(out, 'cleanup-receipt.json'), { pass: cleanups.length === 2 && cleanups.every(receipt => receipt.pass), port: PORT, portReleased: !portListeners(), cleanups, scratch: result.scratch })
  const report = `# GUI-P3 real Desktop evidence\n\nPASS: ${result.checkCount} checks on isolated port ${PORT}.\n\n- Run: ${runId}\n- Evidence: ${out}\n- Candidate review, source/diff/frozen-input/replay, v1/v2 publish, Attempt L2/L5 provenance, predecessor/empty rollback, Reject and restart all exercised through the rendered UI.\n- RPC/SQLite comparisons: rpc-sqlite-comparisons.json\n- Model wire: model-wire-evidence.json and model-wire.json\n- Immutable history: immutable-history.json\n- Exact-PID cleanup: process-1/process-2 exact-pid-cleanup.json; port ${PORT} free.\n- Scratch retained deliberately at ${root}; current App and real profiles/stores were not used.\n`
  writeFileSync(join(out, 'evidence.md'), report)
  writeFileSync(join(GUI, 'evidence.md'), report)
} catch (error) {
  failure = error
  if (instance?.cdp) {
    await screenshot(instance, 'failure').catch(() => {})
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
  writeJson(join(out, 'rpc-evidence.json'), rpcEvidence)
}

if (failure) {
  const failedResult = { phase: 'GUI-P3', pass: false, runId, root, out, port: PORT, checks, cleanups, error: failure?.message ?? String(failure) }
  writeJson(join(out, 'driver-error.json'), { message: failure?.message ?? String(failure), stack: failure?.stack ?? null, checks, cleanups })
  writeJson(join(out, 'result.json'), failedResult)
  writeJson(join(GUI, 'result.json'), failedResult)
  writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'failed', error: failure?.message ?? String(failure) })
  console.error(failure)
  process.exitCode = 1
} else {
  writeJson(join(GUI, 'latest.json'), { runId, root, out, port: PORT, status: 'passed', result: join(out, 'result.json') })
  console.log(JSON.stringify({ phase: 'GUI-P3', pass: result.pass, checkCount: result.checkCount, checks, out }, null, 2))
}
