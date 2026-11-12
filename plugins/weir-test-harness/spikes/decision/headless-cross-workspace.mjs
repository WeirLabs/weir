// Real isolated headless two-workspace Decision memory matrix (OpenSpec
// decision-agent-cross-workspace-memory, task 7.2).
//
// One isolated DSH profile, three real workspace cwds (W1/W2 plus a source-free
// W3), eleven real headless boots and a process restart. Every boot runs the
// gated `decision-cross-workspace` scenario for one phase; the driver records
// each boot's exit code/PID, the SQLite dump after it, its wire payloads, model
// traces and logs, then proves the ten required behaviors with labeled PASS
// checks plus a machine-readable report.
//
//   node plugins/weir-test-harness/spikes/decision/headless-cross-workspace.mjs
//
// Evidence (untracked, outside the lane worktree) defaults to
// /Users/young/Documents/Orrery/.weir/decision-cross-workspace-memory-7/headless
// and is overridable with WEIR_XWS_EVIDENCE. Everything the run creates - the
// DSH home, the profile, the three workspaces, the Decision database, traces and
// wire files - lives under that root. It never reads or writes the user's
// current App data and never binds the current GUI/Desktop ports.
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshLauncher } from '../../src/launcher.js'
import { canonicalJson } from '../../../weir-harness/src/decision/contracts.js'
import { parseJsonlLines } from '../../src/jsonl.js'
import {
  PHASES, MARKERS, AGENT_NAME, CROSS_WIRE, LEARNING_WIRE, PUBLIC_ALIAS,
  attemptDualPinProblems, entryErrorCode, entryValue, leakFindings,
  publicCandidateProblems, publicRefreshProblems, publicZoneProblems,
  selectorRowProblems, wireAuthorizationProblems, wireLeakProblems, wireRecord,
} from '../../src/scenarios/decision-cross-workspace.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../..')
const NODE = process.env.WEIR_IT_NODE ?? '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
const PNPM = process.env.WEIR_IT_PNPM ?? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
// Evidence is untracked and deliberately lives OUTSIDE the lane worktree; the
// default is the absolute path named by the task, never a lane-local copy.
const EVIDENCE = process.env.WEIR_XWS_EVIDENCE ?? '/Users/young/Documents/Orrery/.weir/decision-cross-workspace-memory-7/headless'
const ROOT = join(EVIDENCE, 'root')
const HOME = join(ROOT, 'home')
const PROFILE_NAME = 'weir-it'
const PROFILE = join(HOME, 'profiles', PROFILE_NAME)
const WS = { W1: join(ROOT, 'ws', 'w1'), W2: join(ROOT, 'ws', 'w2'), W3: join(ROOT, 'ws', 'w3') }
const DB_PATH = join(HOME, 'weir', 'profiles', PROFILE_NAME, 'decisions', 'decision.db')
const CURRENT_APP = join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness')
const FORBIDDEN_PORTS = [9442, 9451, 53413]
const PROMPT = 'decision-cross-workspace-probe'
const startedAt = new Date().toISOString()
const runId = `xws-${startedAt.replaceAll(/[:.]/g, '-')}`

const checks = []
const problems = []
function check(label, ok, detail) {
  checks.push({ label, status: ok ? 'PASS' : 'FAIL', detail: detail === undefined ? null : detail })
  if (!ok) problems.push({ label, detail })
  const shown = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 360)}`
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${shown}`)
  return ok
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function ensureDirs() {
  for (const dir of [EVIDENCE, ROOT, HOME, PROFILE, join(ROOT, 'ws'), join(ROOT, 'traces'), join(EVIDENCE, 'logs'), join(EVIDENCE, 'db'), join(EVIDENCE, 'wire'), join(EVIDENCE, 'traces'), ...Object.values(WS)]) mkdirSync(dir, { recursive: true })
}

// ---------------------------------------------------------------------------
// Isolation setup: one profile, real workspaces, nothing outside the root
// ---------------------------------------------------------------------------

function setup() {
  rmSync(ROOT, { recursive: true, force: true })
  ensureDirs()
  writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-weir-xws',
    private: true,
    dependencies: {
      'weir-harness': `link:${join(REPO, 'plugins/weir-harness')}`,
      'weir-test-harness': `link:${join(REPO, 'plugins/weir-test-harness')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'weir-test-harness'] } },
  }, null, 2)}\n`)
  writeFileSync(join(PROFILE, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(PROFILE, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\n')
  for (const [label, path] of Object.entries(WS)) writeFileSync(join(path, 'README.md'), `# ${label}\n\nA real isolated workspace for the cross-workspace Decision memory matrix.\n`)
  writeFileSync(join(ROOT, 'ws', 'fixture.txt'), 'line one\nline two\n')
  return String(execFileSync(NODE, [PNPM, 'install', '--reporter', 'silent'], { cwd: PROFILE, encoding: 'utf8', stdio: 'pipe' }) ?? '').trim().split('\n').slice(-3).join('\n')
}

/** A stable inventory of the user's current App data (read-only stats). */
function currentAppInventory() {
  const inventory = {}
  const walk = (dir, depth) => {
    if (depth > 2 || !existsSync(dir)) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of entries) {
      const path = join(dir, item.name)
      try {
        const stat = statSync(path)
        inventory[path] = `${stat.size}:${stat.mtimeMs}`
      } catch { continue }
      if (item.isDirectory()) walk(path, depth + 1)
    }
  }
  walk(CURRENT_APP, 0)
  return inventory
}

function runQuiet(command, args) {
  try {
    return String(execFileSync(command, args, { encoding: 'utf8' }))
  } catch (error) {
    return String(error?.stdout ?? '')
  }
}

function listenerSnapshot() {
  return runQuiet('lsof', ['-nP', '-iTCP:9442', '-iTCP:9451', '-iTCP:53413', '-sTCP:LISTEN'])
}

function processSnapshot() {
  return runQuiet('ps', ['-ax', '-o', 'pid=,command='])
}

// ---------------------------------------------------------------------------
// One boot
// ---------------------------------------------------------------------------

const SESSIONS = {}
const crossEnv = {}

function bootEnv(phase, spec, trace) {
  const base = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('WEIR_IT_') && !key.startsWith('WEIR_PREFLIGHT_')) base[key] = value
  return {
    ...base,
    DSH_HOME: HOME,
    WEIR_IT_ROOT: ROOT,
    WEIR_IT_SCENARIO: 'decision-cross-workspace',
    WEIR_IT_TRACE: trace,
    WEIR_IT_FIXTURE: join(ROOT, 'ws', 'fixture.txt'),
    // One profile-global Decision configuration for every workspace.
    WEIR_IT_DECISION: '1',
    WEIR_IT_DECISION_REMOTE: '1',
    WEIR_IT_DECISION_CROSS_WORKSPACE: '1',
    WEIR_IT_DECISION_SELECTOR_DEFAULT: 'auto',
    WEIR_IT_DECISION_AUTO_CLASSES: '["A","B","C"]',
    WEIR_IT_DECISION_EVENTS: join(ROOT, 'decision-integration-events.jsonl'),
    WEIR_IT_XWS_PHASE: phase,
    WEIR_IT_XWS_LABEL: spec.workspace,
    ...crossEnv,
  }
}

function spawnBoot(phase) {
  const spec = PHASES.find(item => item.phase === phase)
  const cwd = WS[spec.workspace]
  const trace = join(ROOT, 'traces', `${phase}.jsonl`)
  const resumeFrom = spec.session === 'new' ? null : spec.session
  const sessionId = resumeFrom ? SESSIONS[resumeFrom] : null
  if (resumeFrom && !sessionId) return Promise.resolve({ phase, workspace: spec.workspace, cwd, code: 1, stderr: `no recorded session for ${resumeFrom}`, pid: null, trace, sessionId: null, resumed: true, stdout: '' })
  const args = resumeFrom ? [PROFILE_NAME, '--session-id', sessionId, PROMPT] : [PROFILE_NAME, '--json', PROMPT]
  const [command, argv] = launcher.kind === 'exec' ? [launcher.path, args] : [NODE, [launcher.path, ...args]]
  const env = bootEnv(phase, spec, trace)
  return new Promise(resolveBoot => {
    const child = execFile(command, argv, { cwd, env, timeout: 240_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolveBoot({
        phase, workspace: spec.workspace, cwd, trace, pid: child.pid,
        code: error?.code ?? 0, signal: error?.signal ?? null,
        stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
        resumed: Boolean(resumeFrom),
        sessionId: sessionId ?? parseJsonlLines(String(stdout ?? '')).find(row => row?.type === 'session')?.sessionId ?? null,
      })
    })
    child.on('error', error => resolveBoot({ phase, workspace: spec.workspace, cwd, trace, pid: child.pid ?? null, code: 1, signal: null, stdout: '', stderr: String(error?.message ?? error), resumed: Boolean(resumeFrom), sessionId }))
  })
}

/** Sessions on disk encode the workspace path; the inner directory is the id. */
function sessionsFor(workspace) {
  const sessionsRoot = join(HOME, 'sessions')
  if (!existsSync(sessionsRoot)) return []
  const encoded = realpathSync(workspace).replaceAll('/', '-')
  return readdirSync(sessionsRoot)
    .filter(name => name.startsWith('--') && name.replaceAll('-', '').includes(encoded.replaceAll('-', '')))
    .flatMap(name => readdirSync(join(sessionsRoot, name)).map(id => ({ id, dir: join(sessionsRoot, name), mtime: statSync(join(sessionsRoot, name, id)).mtimeMs })))
    .sort((left, right) => right.mtime - left.mtime)
}

// ---------------------------------------------------------------------------
// Evidence capture per boot
// ---------------------------------------------------------------------------

const TABLES = ['agent_profiles', 'agent_profile_revisions', 'selectors', 'cases', 'attempts', 'attempt_evidence', 'evidence', 'feedback', 'corrections', 'route_decisions', 'learning_runs', 'memory_snapshots']

function dbSnapshot(phase) {
  if (!existsSync(DB_PATH)) return null
  const db = new DatabaseSync(DB_PATH)
  const dump = { phase, at: new Date().toISOString(), path: DB_PATH, userVersion: null, tables: {} }
  try {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* a clean database has nothing to checkpoint */ }
    dump.userVersion = db.prepare('PRAGMA user_version').get().user_version
    const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name))
    for (const table of TABLES) if (existing.has(table)) dump.tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  } finally { db.close() }
  writeJson(join(EVIDENCE, 'db', `${phase}.json`), dump)
  copyFileSync(DB_PATH, join(EVIDENCE, 'db', `${phase}.db`))
  return dump
}

function captureWire(phase) {
  const cross = join(ROOT, 'ws', CROSS_WIRE)
  const learning = join(ROOT, 'ws', LEARNING_WIRE)
  const snapshot = { phase, cross: existsSync(cross) ? readJson(cross) ?? {} : {}, learning: existsSync(learning) ? readJson(learning) ?? {} : {} }
  writeJson(join(EVIDENCE, 'wire', `${phase}.json`), snapshot)
  return snapshot
}

function captureTrace(phase, trace) {
  if (existsSync(trace)) copyFileSync(trace, join(EVIDENCE, 'traces', `${phase}.jsonl`))
  return existsSync(trace) ? parseJsonlLines(readFileSync(trace, 'utf8')) : []
}

function parse(value) {
  try { return value === null || value === undefined ? null : JSON.parse(value) } catch { return undefined }
}

function casesOf(dump) { return (dump?.tables?.cases ?? []).map(row => ({ ...row, request: parse(row.request_json), decision: parse(row.decision_json), scope: parse(row.scope_json) })) }
function runsOf(dump) { return (dump?.tables?.learning_runs ?? []).map(row => ({ ...row, inputFrozen: parse(row.input_frozen_json) ?? {}, replay: parse(row.replay_json) ?? {}, operations: parse(row.operations_json) ?? [] })) }
function snapshotsOf(dump) {
  return (dump?.tables?.memory_snapshots ?? []).map(row => {
    const generatedDescription = parse(row.generated_description_json)
    const principles = parse(row.principles_json) ?? []
    // The store keeps no content_hash column: recompute the canonical hash the
    // product's memorySnapshotOf derives, so wire and database are comparable.
    const contentHash = createHash('sha256').update(canonicalJson({
      version: row.version, parentSnapshotId: row.parent_snapshot_id,
      principles, generatedDescription, learningRunId: row.learning_run_id,
    })).digest('hex')
    return { ...row, principles, generatedDescription, contentHash }
  })
}
function attemptsOf(dump) { return (dump?.tables?.attempts ?? []).map(row => ({ ...row, pins: parse(row.pins_json) ?? {}, packManifest: parse(row.pack_manifest_json) ?? {}, citedEvidenceIds: parse(row.cited_evidence_ids_json) ?? [], error: parse(row.error_json) })) }
function evidenceOf(dump) { return (dump?.tables?.evidence ?? []).map(row => ({ ...row, locator: parse(row.locator_json) ?? {}, scope: parse(row.scope_json) ?? {} })) }
function selectorsOf(dump) { return dump?.tables?.selectors ?? [] }

function caseByPhase(dump, phase) {
  const marker = `"decision-xws-${phase}-`
  return casesOf(dump).find(row => row.request_json?.includes(marker)) ?? null
}

function workspaceIds(dump, label) {
  const workspaceKey = realpathSync(WS[label])
  return {
    workspaceKey,
    caseIds: casesOf(dump).filter(row => row.workspace_key === workspaceKey).map(row => row.case_id),
    runIds: runsOf(dump).filter(row => row.zone === 'workspace' && row.namespace_workspace_key === workspaceKey).map(row => row.learning_run_id),
    snapshotIds: snapshotsOf(dump).filter(row => row.zone === 'workspace' && row.namespace_workspace_key === workspaceKey).map(row => row.snapshot_id),
  }
}

/** Row identity per table (for byte-unchanged comparisons). */
const PRIMARY_KEY = {
  cases: 'case_id', attempts: 'attempt_id', attempt_evidence: 'rowid', evidence: 'evidence_id',
  feedback: 'feedback_id', corrections: 'feedback_id', route_decisions: 'route_decision_id',
  learning_runs: 'learning_run_id', memory_snapshots: 'snapshot_id',
}
/** Attempt/Evidence links have a composite identity (no rowid in SELECT *). */
function rowKey(table, row) {
  if (table === 'attempt_evidence') return `${row.attempt_id}:${row.ordinal}`
  return String(row[PRIMARY_KEY[table]])
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let launcher
try {
  launcher = resolveDshLauncher()
} catch (error) {
  console.error(error?.message ?? String(error))
  process.exit(1)
}
console.log(`[setup] dsh launcher: ${launcher.source} -> ${launcher.path} (${launcher.kind})`)
console.log(`[setup] evidence root: ${EVIDENCE}`)

const appBefore = currentAppInventory()
const listenersBefore = listenerSnapshot()
try {
  setup()
} catch (error) {
  console.error(`[setup] profile install failed: ${error?.message ?? error}`)
  process.exit(1)
}

const bootChecks = []
const dumps = {}
const wires = {}
const traces = {}

for (const spec of PHASES) {
  const phase = spec.phase
  console.log(`[boot] ${phase} (${spec.workspace}${spec.session === 'new' ? ', new root' : `, resume ${spec.session}`})`)
  const outcome = await spawnBoot(phase)
  writeFileSync(join(EVIDENCE, 'logs', `${phase}.out`), outcome.stdout)
  writeFileSync(join(EVIDENCE, 'logs', `${phase}.err`), outcome.stderr)
  if (spec.session === 'new' && !outcome.sessionId) {
    const newest = sessionsFor(WS[spec.workspace])[0]
    if (newest) outcome.sessionId = newest.id
  }
  if (spec.session === 'new' && outcome.sessionId) SESSIONS[phase] = outcome.sessionId
  dumps[phase] = dbSnapshot(phase)
  wires[phase] = captureWire(phase)
  traces[phase] = captureTrace(phase, outcome.trace)
  const onDisk = sessionsFor(WS[spec.workspace])
  bootChecks.push({
    phase, workspace: spec.workspace, cwd: outcome.cwd, resumed: outcome.resumed,
    pid: outcome.pid, exitCode: outcome.code, signal: outcome.signal,
    sessionId: outcome.sessionId,
    sessionPersistedOnDisk: Boolean(onDisk.some(session => session.id === outcome.sessionId)),
    trace: outcome.trace, stdoutLog: join(EVIDENCE, 'logs', `${phase}.out`), stderrLog: join(EVIDENCE, 'logs', `${phase}.err`),
    dbDump: join(EVIDENCE, 'db', `${phase}.json`), wire: join(EVIDENCE, 'wire', `${phase}.json`),
    stderrTail: outcome.stderr.trim().split('\n').slice(-3),
  })
  if (outcome.code !== 0) console.log(`[boot] ${phase} exits ${outcome.code}: ${outcome.stderr.trim().split('\n').slice(-3).join(' | ')}`)
  // Hand the ids of already-existing private records to later boots so the
  // cross-workspace denial probes name real foreign records.
  const after = dumps[phase]
  if (after) {
    const w1 = workspaceIds(after, 'W1')
    const w2 = workspaceIds(after, 'W2')
    const w1Source = caseByPhase(after, 'w1-seed')
    const w2Source = caseByPhase(after, 'w2-identity')
    if (w1Source) crossEnv.WEIR_IT_XWS_W1_CASE = w1Source.case_id
    if (w1.runIds.length) crossEnv.WEIR_IT_XWS_W1_RUN = w1.runIds[0]
    if (w1.snapshotIds.length) crossEnv.WEIR_IT_XWS_W1_SNAPSHOT = w1.snapshotIds[0]
    if (w2Source) crossEnv.WEIR_IT_XWS_W2_CASE = w2Source.case_id
    if (w2.runIds.length) crossEnv.WEIR_IT_XWS_W2_RUN = w2.runIds[0]
    if (w2.snapshotIds.length) crossEnv.WEIR_IT_XWS_W2_SNAPSHOT = w2.snapshotIds[0]
  }
}

const final = dbSnapshot('final')
captureWire('final')
const allTraces = Object.values(traces).flat()
const wireOf = phase => wires[phase]?.cross ?? {}
const learningOf = phase => wires[phase]?.learning ?? {}
const entry = (phase, name) => wireOf(phase)[`${phase}:${name}`]
const learningEntry = (phase, name) => learningOf(phase)[`${phase}:${name}`]
const valueOf = (phase, name) => entryValue(entry(phase, name))
const recordsOf = phase => traces[phase] ?? []
const sessionsOf = phase => bootChecks.find(item => item.phase === phase)?.sessionId ?? null
const agentId = (final?.tables?.agent_profiles ?? [])[0]?.agent_id ?? null
const detailOf = (phase, name) => entry(phase, name)?.detail ?? {}
const okOf = (phase, name) => entry(phase, name)?.result?.ok === true
/** Find the Case a phase's gesture created by its unique question marker. */
function caseByMarker(dump, marker) {
  return casesOf(dump).find(row => (row.request?.questions ?? []).some(question => String(question?.question ?? '').startsWith(marker))) ?? null
}
/** The product's own decision_consult tool result recorded for one Case. */
function consultFor(recordList, caseId) {
  return (recordList ?? []).map(record => record.xwsConsult).find(value => value && value.caseId === caseId) ?? null
}

function publicRuns() { return runsOf(final).filter(row => row.zone === 'public') }
function publicSnapshots() { return snapshotsOf(final).filter(row => row.zone === 'public') }
function runById(id) { return runsOf(final).find(row => row.learning_run_id === id) ?? null }
function snapshotByRun(id) { return snapshotsOf(final).find(row => row.learning_run_id === id) ?? null }

const W1 = realpathSync(WS.W1)
const W2 = realpathSync(WS.W2)
const W3 = realpathSync(WS.W3)
const workspacePaths = [W1, W2, W3]
const w1Source = caseByPhase(dumps['w1-seed'] ?? final, 'w1-seed')
const w2Source = caseByPhase(dumps['w2-identity'] ?? final, 'w2-identity')
const foreignIds = [w1Source?.case_id, w2Source?.case_id].filter(Boolean)
const foreignTexts = [w1Source, w2Source].flatMap(row => (row?.request?.questions ?? []).map(question => ({ label: row.case_id, text: question.question })))

// ---------------------------------------------------------------------------
// 1. Isolation
// ---------------------------------------------------------------------------
{
  const realRoot = resolve(ROOT)
  const realApp = resolve(CURRENT_APP)
  check('isolation-fresh-isolated-roots', realRoot.startsWith(resolve(EVIDENCE)) && existsSync(PROFILE) && existsSync(DB_PATH)
    && Object.values(WS).every(path => existsSync(path)) && final?.userVersion === 2,
    { root: ROOT, profile: PROFILE, database: DB_PATH, workspaces: WS, userVersion: final?.userVersion })
  check('isolation-root-outside-current-app-data', !realRoot.startsWith(realApp) && !realRoot.startsWith(`${realApp}/`), { root: ROOT, currentApp: CURRENT_APP })
  const appAfter = currentAppInventory()
  const changed = Object.keys({ ...appBefore, ...appAfter }).filter(path => appBefore[path] !== appAfter[path])
  check('isolation-current-app-data-unchanged', changed.length === 0, { tracked: Object.keys(appBefore).length, changed })
  const owned = bootChecks.map(item => String(item.pid)).filter(Boolean)
  const listenersAfter = listenerSnapshot()
  const forbidden = listenersAfter.split('\n').filter(line => line.trim().length > 0 && (owned.some(pid => line.trim().startsWith(`${pid} `)) || line.includes(ROOT) || line.includes(PROFILE)))
  check('isolation-no-forbidden-port-or-current-gui', forbidden.length === 0,
    { forbiddenPorts: FORBIDDEN_PORTS, listenersBefore: listenersBefore.trim().split('\n'), listenersAfter: listenersAfter.trim().split('\n'), forbidden })
  const processes = processSnapshot()
  const leftovers = processes.split('\n').filter(line => line.includes(ROOT) || owned.some(pid => line.trim().startsWith(`${pid} `)))
  check('isolation-no-stray-owned-process', leftovers.length === 0, { ownedPids: owned, leftovers })
}

// ---------------------------------------------------------------------------
// Boot health
// ---------------------------------------------------------------------------
{
  const failed = bootChecks.filter(item => item.exitCode !== 0 || item.signal !== null)
  check('boots-every-phase-exits-clean', failed.length === 0 && bootChecks.length === PHASES.length,
    { boots: bootChecks.map(item => ({ phase: item.phase, pid: item.pid, exitCode: item.exitCode, signal: item.signal })) })
  check('boots-every-root-session-persisted', bootChecks.every(item => item.sessionId && item.sessionPersistedOnDisk),
    bootChecks.map(item => ({ phase: item.phase, sessionId: item.sessionId, onDisk: item.sessionPersistedOnDisk })))
  const finished = bootChecks.map(item => {
    // The trace also carries session-event rows; only request rows have `emitted`.
    const requests = recordsOf(item.phase).filter(record => Array.isArray(record.emitted))
    const last = requests.at(-1) ?? null
    const probeErrors = requests.filter(record => String(record.lastTool ?? '').includes('DECISION_REMOTE error')).length
    return { phase: item.phase, requests: requests.length, lastEmitted: last?.emittedNames ?? null, probeErrors }
  })
  check('boots-every-phase-finishes-its-gesture-script', finished.every(item => item.requests > 0 && Array.isArray(item.lastEmitted) && item.lastEmitted.join(',') === 'text' && item.probeErrors === 0),
    finished)
}

// ---------------------------------------------------------------------------
// 2. Shared identity
// ---------------------------------------------------------------------------
{
  const w1Agents = valueOf('w1-seed', 'identity-list') ?? []
  const w2Agents = valueOf('w2-identity', 'identity-list') ?? []
  const profileRows = final?.tables?.agent_profiles ?? []
  check('identity-one-profile-global-list', w1Agents.length === 1 && w2Agents.length === 1
    && w1Agents[0].agentId === w2Agents[0].agentId && w1Agents[0].name === AGENT_NAME
    && profileRows.length === 1 && profileRows[0].agent_id === w1Agents[0].agentId,
    { w1: w1Agents, w2: w2Agents, db: profileRows.map(row => ({ agentId: row.agent_id, name: row.name })) })
  const duplicate = entry('w2-identity', 'identity-duplicate')
  const duplicateDetail = detailOf('w2-identity', 'identity-duplicate')
  check('identity-duplicate-name-rejected-case-insensitively', entryErrorCode(duplicate) === 'PROFILE_NAME_TAKEN'
    && String(duplicateDetail?.name ?? '').startsWith('SHARED MEMORY ASSISTANT')
    && duplicateDetail?.name !== AGENT_NAME
    && profileRows.length === 1,
    { errorCode: entryErrorCode(duplicate), name: duplicateDetail?.name, variant: duplicateDetail?.variant, profiles: profileRows.length })
  // A profile payload must carry no workspace-ownership field at all.
  const profileFieldProblems = [w1Agents[0], w2Agents[0]].filter(agent => Object.keys(agent ?? {}).some(key => /workspace/i.test(key)))
  const columns = profileRows[0] ? Object.keys(profileRows[0]) : []
  const identityLeaks = ['w1-seed', 'w2-identity']
    .flatMap(phase => wireLeakProblems(wireOf(phase), { paths: workspacePaths }, label => wireOf(phase)[label]?.op === 'identity'))
  check('identity-no-workspace-ownership-field', profileFieldProblems.length === 0
    && !columns.includes('workspace_key') && identityLeaks.length === 0
    && profileRows.every(row => row.legacy_origin_alias === null)
    && (w2Agents[0]?.scope ?? {}).workspaces === undefined,
    { profileFieldProblems, columns, identityLeaks, scope: w2Agents[0]?.scope, legacy: profileRows.map(row => row.legacy_origin_alias) })
}

// ---------------------------------------------------------------------------
// 3. Private isolation
// ---------------------------------------------------------------------------
{
  const w2Records = valueOf('w2-auto', 'records')?.records?.map(row => row.caseId) ?? []
  const w1Records = valueOf('w1-stale', 'records')?.records?.map(row => row.caseId) ?? []
  const w1CaseIds = casesOf(final).filter(row => row.workspace_key === W1).map(row => row.case_id)
  const w2CaseIds = casesOf(final).filter(row => row.workspace_key === W2).map(row => row.case_id)
  check('private-records-not-listable-across-workspaces', Boolean(w1Source && w2Source)
    && w2Records.length > 0 && w1Records.length > 0
    // Each workspace's record list stays inside that workspace (records are also
    // root-session scoped, so the list is a subset of the workspace's Cases).
    && w2Records.every(id => w2CaseIds.includes(id)) && w1Records.every(id => w1CaseIds.includes(id))
    && w2Records.every(id => !w1CaseIds.includes(id)) && w1Records.every(id => !w2CaseIds.includes(id))
    && !w2Records.includes(w1Source.case_id) && !w1Records.includes(w2Source.case_id)
    && w1Records.includes(w1Source.case_id),
    { w1Case: w1Source?.case_id, w2Case: w2Source?.case_id, w1SourceListed: w1Records.includes(w1Source.case_id), w2SourceListed: w2Records.includes(w2Source.case_id), w2Records, w1Records })
  const denyW1Case = entry('w2-identity', 'deny-w1-case')
  const denyW2Case = entry('w1-publish', 'deny-w2-case')
  const codeOf = item => item?.result?.error?.code ?? null
  const denyW1Run = learningEntry('w2-identity', 'deny-w1-run')
  const denyW1Snapshot = learningEntry('w2-identity', 'deny-w1-snapshot')
  const denyW2Run = learningEntry('w1-publish', 'deny-w2-run')
  const denyW2Snapshot = learningEntry('w1-publish', 'deny-w2-snapshot')
  const deniedRecord = item => item?.result?.ok === true && entryValue(item) === null
  check('private-cross-workspace-reads-fail-closed', deniedRecord(denyW1Case) && deniedRecord(denyW2Case)
    && codeOf(denyW1Run) === 'OUT_OF_SCOPE' && codeOf(denyW1Snapshot) === 'OUT_OF_SCOPE'
    && codeOf(denyW2Run) === 'OUT_OF_SCOPE' && codeOf(denyW2Snapshot) === 'OUT_OF_SCOPE',
    {
      w2ReadsW1Case: { record: entryValue(denyW1Case), code: entryErrorCode(denyW1Case) },
      w1ReadsW2Case: { record: entryValue(denyW2Case), code: entryErrorCode(denyW2Case) },
      w2ReadsW1Run: codeOf(denyW1Run), w2ReadsW1Snapshot: codeOf(denyW1Snapshot),
      w1ReadsW2Run: codeOf(denyW2Run), w1ReadsW2Snapshot: codeOf(denyW2Snapshot),
    })
  const known = new Set(workspacePaths)
  const badCustody = casesOf(final).filter(row => !known.has(row.workspace_key)).map(row => row.case_id)
  const badEvidence = evidenceOf(final).filter(row => !known.has(row.scope?.workspaces?.[0])).map(row => row.evidence_id)
  const badSnapshots = snapshotsOf(final).filter(row => row.zone === 'workspace' && !known.has(row.namespace_workspace_key)).map(row => row.snapshot_id)
  const caseWorkspace = new Set(casesOf(final).map(row => row.case_id))
  const badAttempts = attemptsOf(final).filter(row => !caseWorkspace.has(row.case_id)).map(row => row.attempt_id)
  const crossWorkspaceEvidence = evidenceOf(final).filter(row => {
    const sourceCase = casesOf(final).find(item => item.case_id === row.locator?.caseId)
    return sourceCase && sourceCase.workspace_key !== row.scope?.workspaces?.[0]
  }).map(row => row.evidence_id)
  check('private-sqlite-workspace-custody', badCustody.length === 0 && badEvidence.length === 0 && badSnapshots.length === 0 && badAttempts.length === 0 && crossWorkspaceEvidence.length === 0,
    { badCustody, badEvidence, badSnapshots, badAttempts, crossWorkspaceEvidence, knownWorkspaces: [...known] })
}

// ---------------------------------------------------------------------------
// 4. Public extraction
// ---------------------------------------------------------------------------
{
  const noAck = valueOf('w1-public', 'refresh-noack')
  const ackValue = valueOf('w1-public', 'refresh-ack')
  const consolidationRequests = recordsOf('w1-public').filter(record => record.xwsWire?.kind === 'public-consolidation')
  const publishedAtDisclosure = snapshotsOf(dumps['w1-public']).filter(row => row.zone === 'public' && row.state === 'published')
  check('public-first-open-requires-disclosure', noAck?.status === 'disclosure-required'
    && entry('w1-public', 'refresh-noack')?.result?.ok === true && ackValue?.status === 'candidate'
    && consolidationRequests.length === 1 && publishedAtDisclosure.length === 0,
    { noAck, ack: ackValue, consolidationRequests: consolidationRequests.length, publishedAtDisclosure: publishedAtDisclosure.length })

  const run = publicRuns()[0] ?? null
  const aliasValues = [...new Set(Object.values(run?.inputFrozen?.sourceWorkspaces ?? {}))]
  check('public-candidate-aggregates-both-workspaces', ackValue?.status === 'candidate' && ackValue?.workspaceCount === 2
    && ackValue?.sourceCount === 2 && run?.inputFrozen?.workspaceAliases?.length === 2
    && aliasValues.length === 2 && [W1, W2].every(path => aliasValues.includes(path))
    && [w1Source?.case_id, w2Source?.case_id].every(id => (run?.inputFrozen?.caseIds ?? []).includes(id)),
    { workspaceCount: ackValue?.workspaceCount, sourceCount: ackValue?.sourceCount, aliases: run?.inputFrozen?.workspaceAliases, sourceWorkspaces: run?.inputFrozen?.sourceWorkspaces, caseIds: run?.inputFrozen?.caseIds })

  const candidateProblems = publicCandidateProblems(entry('w1-public', 'candidate'), { paths: workspacePaths, recordIds: foreignIds, texts: foreignTexts })
  const candidateValue = valueOf('w1-public', 'candidate')
  check('public-candidate-opaque-aliases-and-redaction', candidateProblems.length === 0
    && (candidateValue?.sources ?? []).length === 2
    && (candidateValue?.sources ?? []).every(group => PUBLIC_ALIAS.test(group.alias))
    && (candidateValue?.sources ?? []).every(group => group.preview.length <= 240)
    && (candidateValue?.sources ?? []).filter(group => group.readableInCurrentWorkspace).length === 1,
    { problems: candidateProblems, sources: candidateValue?.sources })

  const wire = wireRecord(recordsOf('w1-public'), 'public-consolidation')
  const sourceFields = new Set(['sourceId', 'kind', 'alias', 'createdAt', 'closing', 'feedbackState', 'revision', 'scope', 'excerpt'])
  const allowedTop = new Set(['schemaVersion', 'zone', 'agentId', 'workspaceAliases', 'sources', 'parentSnapshot'])
  const topFields = wire?.pack ? Object.keys(wire.pack) : []
  const sourceFieldProblems = (wire?.pack?.sources ?? []).flatMap(source => Object.keys(source).filter(key => !sourceFields.has(key)))
  const frozenSourceIds = new Set((publicRuns()[0]?.inputFrozen?.caseIds ?? []).concat(publicRuns()[0]?.inputFrozen?.feedbackIds ?? []))
  const packRecordIds = [...JSON.stringify(wire?.pack ?? {}).matchAll(/\b(?:dc|ev|fb|lr|ms)_[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g)].map(match => match[0])
  // The internal extraction port deliberately names the frozen source ids (design
  // D5); any other record id, and every path or raw body, is a leak.
  const unauthorizedIds = [...new Set(packRecordIds.filter(id => !frozenSourceIds.has(id)))]
  const wireLeaks = leakFindings(wire?.pack ?? {},
    { paths: workspacePaths, texts: foreignTexts.filter(entry => !frozenSourceIds.has(entry.label)) })
  check('public-consolidation-wire-is-whitelisted', Boolean(wire) && topFields.every(key => allowedTop.has(key))
    && sourceFieldProblems.length === 0 && wireLeaks.length === 0 && unauthorizedIds.length === 0
    && wire.pack.zone === 'public' && /^ag_/.test(String(wire.pack.agentId))
    && (wire.pack.sources ?? []).length === 2 && wire.tools?.length === 0 && wire.hasTemperature === false,
    { topFields, sourceFieldProblems, wireLeaks, unauthorizedIds, frozenSourceIds: [...frozenSourceIds], sources: wire?.pack?.sources?.map(source => ({ alias: source.alias, kind: source.kind, excerpt: String(source.excerpt).slice(0, 80) })), tools: wire?.tools })

  const stable = valueOf('w1-public', 'refresh-stable')
  const publishStable = valueOf('w1-publish', 'refresh-stable')
  const bootConsolidations = phase => recordsOf(phase).filter(record => record.xwsWire?.kind === 'public-consolidation').length
  // One extraction per genuine source freeze or explicit user retry; a repeated
  // refresh at an unchanged high-water mark must never call the model again.
  const expectedConsolidations = publicRuns().length
  const totalConsolidations = allTraces.filter(record => record.xwsWire?.kind === 'public-consolidation').length
  check('public-no-model-call-without-new-sources', ['candidate', 'up-to-date'].includes(stable?.status) && publishStable?.status === 'up-to-date'
    // A refresh at an unchanged high-water mark never re-runs the model: the boot
    // that created the candidate makes exactly one call, the publish boot makes
    // none, and the restart boot makes none. New eligible sources (and one
    // explicit retry) do freeze and extract exactly once more.
    && bootConsolidations('w1-public') === 1 && bootConsolidations('w1-publish') === 0
    && bootConsolidations('w1-restart') === 0
    && bootConsolidations('w1-v2') === 1 && bootConsolidations('w1-stale') === 2
    && totalConsolidations === expectedConsolidations,
    { w1PublicStable: stable?.status, w1PublishStable: publishStable?.status, consolidationsInBoot: bootConsolidations('w1-public'), consolidationsAfterPublish: bootConsolidations('w1-publish'), consolidationsInV2: bootConsolidations('w1-v2'), consolidationsInStale: bootConsolidations('w1-stale'), consolidationsInRestart: bootConsolidations('w1-restart'), consolidationsTotal: totalConsolidations, publicRuns: expectedConsolidations })
}

// ---------------------------------------------------------------------------
// 5. Explicit publish, stale/rejected sources, rollback
// ---------------------------------------------------------------------------
{
  const draft = valueOf('w1-public', 'candidate')
  const preCase = caseByMarker(dumps['w1-public'], MARKERS.w1Local)
  const consult = consultFor(recordsOf('w1-public'), preCase?.case_id)
  const consultAttempt = preCase ? attemptsOf(dumps['w1-public']).filter(row => row.case_id === preCase.case_id).at(-1) ?? null : null
  const draftAttempts = attemptsOf(dumps['w1-public']).filter(row => JSON.stringify(row.pins).includes(draft?.candidate?.snapshotId ?? 'missing-snapshot'))
  check('public-draft-not-used-before-explicit-publish', Boolean(draft?.candidate && preCase && consult && consultAttempt)
    && consultAttempt.pins.publicMemorySnapshotId === null
    && (consultAttempt.packManifest?.memory?.publicL2?.snapshotId ?? null) === null
    && draftAttempts.length === 0 && entry('w1-public', 'publish') === undefined,
    { draftSnapshotId: draft?.candidate?.snapshotId, consult, pins: consultAttempt?.pins, publicL2: consultAttempt?.packManifest?.memory?.publicL2, draftAttempts: draftAttempts.length })

  const published = valueOf('w1-publish', 'publish')
  const publishedRows = snapshotsOf(dumps['w1-publish']).filter(row => row.zone === 'public' && row.state === 'published')
  const publishedRow = publishedRows[0] ?? null
  check('public-explicit-publish-becomes-current', okOf('w1-publish', 'publish') && published?.state === 'published'
    && publishedRows.length === 1 && publishedRow?.version === 1 && publishedRow?.revision === 2
    && published?.snapshotId === publishedRow?.snapshot_id && published?.contentHash === publishedRow?.contentHash,
    { published, publishedRows: publishedRows.map(row => ({ snapshotId: row.snapshot_id, version: row.version, revision: row.revision, state: row.state, contentHash: row.contentHash })) })

  const postCase = caseByMarker(dumps['w1-publish'], MARKERS.w1LocalPublished)
  const postConsult = consultFor(recordsOf('w1-publish'), postCase?.case_id)
  const postAttempt = postCase ? attemptsOf(dumps['w1-publish']).filter(row => row.case_id === postCase.case_id).at(-1) ?? null : null
  const pinProblems = postAttempt ? attemptDualPinProblems({ pins: postAttempt.pins, packManifest: postAttempt.packManifest }) : ['no post-publish Attempt']
  const publicL2 = postAttempt?.packManifest?.memory?.publicL2 ?? null
  const aliases = (publicL2?.items ?? []).flatMap(item => item.sources ?? [])
  const attemptEvidence = (dumps['w1-publish']?.tables?.attempt_evidence ?? []).filter(row => row.attempt_id === postAttempt?.attempt_id).map(row => row.evidence_id)
  check('public-attempt-pins-guidance-without-evidence', pinProblems.length === 0
    && postConsult?.outcome === 'answered'
    && postAttempt?.pins?.publicMemorySnapshotId === publishedRow?.snapshot_id
    && postAttempt?.pins?.publicMemorySnapshotRevision === publishedRow?.revision
    && postAttempt?.pins?.publicMemorySnapshotHash === publishedRow?.contentHash
    && (publicL2?.principleIds ?? []).length >= 1
    && (publicL2?.items ?? []).every(item => (item.evidenceIds ?? []).length === 0)
    && publicL2?.zone === 'public'
    && aliases.every(alias => !attemptEvidence.includes(alias))
    && aliases.every(alias => !(postAttempt?.citedEvidenceIds ?? []).includes(alias))
    && (publicL2?.principleIds ?? []).every(id => !(postAttempt?.citedEvidenceIds ?? []).includes(id)),
    { pinProblems, postConsult, pins: postAttempt?.pins, publicL2, aliases, attemptEvidence })

  const comment = detailOf('w1-stale', 'comment')
  const staleRefresh = valueOf('w1-stale', 'refresh-candidate')
  const stalePublish = entry('w1-stale', 'publish-stale')
  const staleRun = runById(staleRefresh?.run?.learningRunId)
  const staleSnapshot = snapshotByRun(staleRefresh?.run?.learningRunId)
  check('public-stale-source-publish-fails-closed', Boolean(comment?.revisionBefore) && comment.revisionAfter === comment.revisionBefore + 1
    && entryErrorCode(stalePublish) === 'STALE_SOURCE'
    && staleRun?.outcome === 'failed' && staleSnapshot?.state === 'draft'
    && snapshotsOf(dumps['w1-stale']).filter(row => row.zone === 'public' && row.state === 'published').length === 1,
    { comment, stalePublishCode: entryErrorCode(stalePublish), staleRun: staleRun ? { id: staleRun.learning_run_id, outcome: staleRun.outcome, detail: staleRun.replay?.detail } : null, staleSnapshot: staleSnapshot ? { id: staleSnapshot.snapshot_id, state: staleSnapshot.state } : null })

  const rejected = valueOf('w1-stale', 'reject')
  const retryCandidate = valueOf('w1-stale', 'retry-candidate')
  const rejectedRun = runById(retryCandidate?.learningRunId)
  const rejectedSnapshot = snapshotByRun(retryCandidate?.learningRunId)
  check('public-rejected-candidate-never-current', okOf('w1-stale', 'reject') && rejected?.state === 'draft'
    && rejectedRun?.outcome === 'rejected' && rejectedSnapshot?.state === 'draft'
    && snapshotsOf(dumps['w1-stale']).filter(row => row.zone === 'public' && row.state === 'published').length === 1,
    { rejected, rejectedRun: rejectedRun ? { id: rejectedRun.learning_run_id, outcome: rejectedRun.outcome } : null, rejectedSnapshot: rejectedSnapshot ? { id: rejectedSnapshot.snapshot_id, state: rejectedSnapshot.state } : null })

  const rollback = valueOf('w1-v2', 'rollback')
  const v2 = publicSnapshots().find(row => row.version === 2) ?? null
  const currentAfterRollback = snapshotsOf(dumps['w1-v2']).find(row => row.zone === 'public' && row.state === 'published') ?? null
  check('public-rollback-restores-previous-version', okOf('w1-v2', 'rollback') && v2?.state === 'rolled_back'
    && currentAfterRollback?.version === 1 && currentAfterRollback?.snapshot_id === publishedRow?.snapshot_id,
    { rollback, v2: v2 ? { id: v2.snapshot_id, version: v2.version, state: v2.state } : null, current: currentAfterRollback ? { id: currentAfterRollback.snapshot_id, version: currentAfterRollback.version } : null })

  const emptyRollback = valueOf('w1-restart', 'rollback-current')
  const stateAfter = valueOf('w1-restart', 'state-after')
  const publishedAfterRestart = snapshotsOf(final).filter(row => row.zone === 'public' && row.state === 'published')
  check('public-rollback-restores-empty-public-zone', okOf('w1-restart', 'rollback-current') && emptyRollback?.state === 'rolled_back'
    && publishedAfterRestart.length === 0 && (stateAfter?.publicMemory?.current ?? null) === null,
    { emptyRollback, publishedAfterRestart: publishedAfterRestart.map(row => row.snapshot_id), stateAfterPublic: stateAfter?.publicMemory?.current?.snapshotId ?? null })

  const tables = ['cases', 'attempts', 'attempt_evidence', 'evidence', 'feedback', 'corrections']
  const changedRows = []
  for (const table of tables) {
    const afterRows = new Map((dumps['w1-v2']?.tables?.[table] ?? []).map(row => [rowKey(table, row), JSON.stringify(row)]))
    for (const row of dumps['w1-publish']?.tables?.[table] ?? []) {
      if (afterRows.get(rowKey(table, row)) !== JSON.stringify(row)) changedRows.push(`${table}:${rowKey(table, row)}`)
    }
  }
  const privateSnapshotsBefore = snapshotsOf(dumps['w1-publish']).filter(row => row.zone === 'workspace')
  const privateAfter = new Map(snapshotsOf(dumps['w1-v2']).map(row => [row.snapshot_id, JSON.stringify(row)]))
  for (const row of privateSnapshotsBefore) if (privateAfter.get(row.snapshot_id) !== JSON.stringify(row)) changedRows.push(`memory_snapshots:${row.snapshot_id}`)
  check('public-rollback-preserves-private-history-bytes', changedRows.length === 0,
    { observedTables: tables.length, privateSnapshots: privateSnapshotsBefore.length, changedRows })
}

// ---------------------------------------------------------------------------
// 6. Public memory is guidance only
// ---------------------------------------------------------------------------
{
  const w3Case = caseByMarker(dumps['w3-guidance'], MARKERS.w3PublicOnly)
  const consult = consultFor(recordsOf('w3-guidance'), w3Case?.case_id)
  const w3Attempts = w3Case ? attemptsOf(dumps['w3-guidance']).filter(row => row.case_id === w3Case.case_id) : []
  const evaluator = recordsOf('w3-guidance')
    .filter(record => record.xwsWire?.kind === 'evaluator' && JSON.stringify(record.xwsWire.pack?.L4 ?? {}).includes(MARKERS.w3PublicOnly))
    .at(-1)?.xwsWire ?? null
  const publicItems = (evaluator?.pack?.L2 ?? []).filter(item => item?.zone === 'public')
  const l5 = evaluator?.pack?.L5 ?? []
  check('public-guidance-alone-returns-never-answers', Boolean(consult && w3Case)
    && consult.outcome !== 'answered' && ['returned', 'awaiting_user'].includes(consult.outcome)
    && w3Case.closing !== 'answered' && ['closed', 'awaiting_revision'].includes(w3Case.state)
    && w3Attempts.length > 0 && w3Attempts.every(row => row.outcome !== 'answer')
    && publicItems.length >= 1 && l5.length > 0 && l5.every(ref => ref.source === 'user_profile'),
    { consult, case: w3Case ? { state: w3Case.state, closing: w3Case.closing } : null, attempts: w3Attempts.map(row => ({ outcome: row.outcome, error: row.error })), publicItems: publicItems.map(item => item.principleId), l5Sources: l5.map(ref => ref.source) })
  const publicIds = new Set(publicItems.map(item => item.principleId))
  const aliases = new Set(publicItems.flatMap(item => item.sources ?? []))
  const cited = w3Attempts.flatMap(row => row.citedEvidenceIds)
  const linked = (dumps['w3-guidance']?.tables?.attempt_evidence ?? []).filter(row => w3Attempts.some(attempt => attempt.attempt_id === row.attempt_id)).map(row => row.evidence_id)
  check('public-guidance-never-becomes-an-evidence-ref', w3Attempts.every(row => (row.packManifest?.memory?.publicL2?.items ?? []).every(item => (item.evidenceIds ?? []).length === 0))
    && cited.every(id => !publicIds.has(id) && !aliases.has(id))
    && linked.every(id => !aliases.has(id) && !publicIds.has(id))
    && (w3Attempts.at(-1)?.pins?.publicMemorySnapshotId ?? null) === (publicSnapshots().find(row => row.version === 1)?.snapshot_id ?? null),
    { cited, linked, publicIds: [...publicIds], aliases: [...aliases], pin: w3Attempts.at(-1)?.pins?.publicMemorySnapshotId })
}

// ---------------------------------------------------------------------------
// 7. Auto
// ---------------------------------------------------------------------------
{
  const w1Selector = valueOf('w1-auto', 'selector-get')
  const w2Selector = valueOf('w2-auto', 'selector-get')
  const selectorRowsFinal = selectorsOf(final)
  const rowFor = sessionId => selectorRowsFinal.find(row => row.root_session_id === sessionId) ?? null
  const w1Row = rowFor(sessionsOf('w1-auto'))
  const w2Row = rowFor(sessionsOf('w2-auto'))
  check('auto-new-root-session-defaults-to-persistent-auto', w1Selector?.selector?.mode === 'auto' && w2Selector?.selector?.mode === 'auto'
    && w1Row?.mode === 'auto' && w2Row?.mode === 'auto'
    && selectorRowProblems(w1Row).length === 0 && selectorRowProblems(w2Row).length === 0,
    { w1: w1Selector?.selector, w2: w2Selector?.selector, w1Row, w2Row })

  const w1AutoCase = caseByMarker(dumps['w1-auto'] ?? final, MARKERS.w1AutoLocal)
  const w1Auto = w1AutoCase ? attemptsOf(dumps['w1-auto']).filter(row => row.case_id === w1AutoCase.case_id) : []
  const w1Routes = (dumps['w1-auto']?.tables?.route_decisions ?? []).filter(row => row.case_id === w1AutoCase?.case_id)
  const w1Evidence = new Map(evidenceOf(dumps['w1-auto']).map(row => [row.evidence_id, row]))
  const w1Cited = w1Auto.flatMap(attempt => attempt.citedEvidenceIds)
  const localOnly = w1Cited.length > 0 && w1Cited.every(id => {
    const ref = w1Evidence.get(id)
    if (!ref) return false
    const sourceCase = casesOf(dumps['w1-auto']).find(row => row.case_id === ref.locator?.caseId)
    return sourceCase?.workspace_key === W1 && ['user_decision', 'agent_record'].includes(ref.source)
  })
  const publicPrincipleIds = new Set(snapshotsOf(final).filter(row => row.zone === 'public').flatMap(row => (row.principles ?? []).map(principle => principle.principleId)))
  check('auto-w1-candidate-answers-from-local-evidence', Boolean(w1AutoCase)
    && w1Routes.some(row => row.mode === 'auto' && row.chosen === agentId)
    && w1Auto.length === 1 && w1Auto[0].outcome === 'answer'
    && localOnly && w1Cited.every(id => !publicPrincipleIds.has(id))
    && (w1Auto[0].packManifest?.evidenceIds ?? []).every(id => !id.startsWith('origin_')),
    { caseId: w1AutoCase?.case_id, routes: w1Routes.map(row => ({ mode: row.mode, chosen: row.chosen })), attempts: w1Auto.map(row => ({ outcome: row.outcome, cited: row.citedEvidenceIds })), cited: w1Cited, localOnly, publicPrincipleIds: [...publicPrincipleIds] })

  const w2AutoCase = caseByMarker(dumps['w2-auto'] ?? final, MARKERS.w2AutoPublic)
  const w2Auto = w2AutoCase ? attemptsOf(dumps['w2-auto']).filter(row => row.case_id === w2AutoCase.case_id) : []
  const w2Routes = (dumps['w2-auto']?.tables?.route_decisions ?? []).filter(row => row.case_id === w2AutoCase?.case_id)
  const w2Evaluator = recordsOf('w2-auto')
    .filter(record => record.xwsWire?.kind === 'evaluator' && JSON.stringify(record.xwsWire.pack?.L4 ?? {}).includes(MARKERS.w2AutoPublic))
    .at(-1)?.xwsWire ?? null
  const w2PublicItems = (w2Evaluator?.pack?.L2 ?? []).filter(item => item?.zone === 'public')
  check('auto-w2-public-only-is-not-answered', Boolean(w2AutoCase)
    && w2Routes.some(row => row.mode === 'auto' && row.chosen === agentId)
    && w2Auto.length === 3
    && w2Auto.every(row => row.outcome !== 'answer' && row.error?.kind === 'invalid_output' && String(row.error?.detail ?? '').startsWith('UNKNOWN_EVIDENCE'))
    && w2AutoCase.closing === 'escalated' && w2AutoCase.decision?.kind === 'user_decision'
    && w2Auto.every(row => (row.citedEvidenceIds ?? []).length === 0)
    && w2PublicItems.length >= 1,
    { case: w2AutoCase ? { state: w2AutoCase.state, closing: w2AutoCase.closing, decisionKind: w2AutoCase.decision?.kind } : null, routes: w2Routes.map(row => ({ mode: row.mode, chosen: row.chosen })), attempts: w2Auto.map(row => ({ outcome: row.outcome, error: row.error })), publicItems: w2PublicItems.map(item => item.principleId) })

  const restartSelector = valueOf('w1-restart', 'selector-get')
  const autoRowsBefore = selectorsOf(dumps['w2-auto']).filter(row => row.mode === 'auto')
  const autoRowsAfter = selectorsOf(final).filter(row => row.mode === 'auto')
  check('auto-selector-survives-process-restart', restartSelector?.selector?.mode === 'agent'
    && autoRowsBefore.length === 3 && autoRowsAfter.length === 3
    && autoRowsBefore.every(row => autoRowsAfter.some(after => after.root_session_id === row.root_session_id && after.mode === 'auto' && after.agent_id === row.agent_id)),
    { restartSelector: restartSelector?.selector, autoRowsBefore: autoRowsBefore.map(row => row.root_session_id), autoRowsAfter: autoRowsAfter.map(row => row.root_session_id) })
}

// ---------------------------------------------------------------------------
// 8. Restart persistence and no resurrection
// ---------------------------------------------------------------------------
{
  const before = dumps['w1-stale'] ?? {}
  const stateBefore = valueOf('w1-restart', 'state-before')
  const currentBefore = snapshotsOf(before).filter(row => row.zone === 'public' && row.state === 'published').map(row => row.snapshot_id)
  const privateBefore = snapshotsOf(before).filter(row => row.zone === 'workspace').map(row => `${row.snapshot_id}:${row.revision}:${row.contentHash}:${row.state}`)
  const privateAfter = snapshotsOf(final).filter(row => row.zone === 'workspace').map(row => `${row.snapshot_id}:${row.revision}:${row.contentHash}:${row.state}`)
  const rejectedBefore = runsOf(before).filter(row => row.zone === 'public' && row.outcome === 'rejected').map(row => row.learning_run_id)
  const rejectedAfter = runsOf(final).filter(row => row.zone === 'public' && row.outcome === 'rejected').map(row => row.learning_run_id)
  const restartCase = caseByMarker(final, MARKERS.w1LocalRestart)
  const restartConsult = consultFor(recordsOf('w1-restart'), restartCase?.case_id)
  const persistedPublic = stateBefore?.publicMemory?.current ?? null
  check('restart-persists-public-state-draft-and-selectors', persistedPublic?.snapshotId === currentBefore[0]
    && currentBefore.length === 1
    && rejectedBefore.length === 1 && JSON.stringify(rejectedAfter) === JSON.stringify(rejectedBefore)
    && JSON.stringify(privateAfter) === JSON.stringify(privateBefore)
    && (stateBefore?.publicMemory?.run ?? null) === null
    && valueOf('w1-restart', 'selector-get')?.selector?.mode === 'agent'
    && restartConsult?.outcome === 'answered',
    { persistedPublic, currentBefore, rejectedBefore, rejectedAfter, privateUnchanged: JSON.stringify(privateAfter) === JSON.stringify(privateBefore), publicRun: stateBefore?.publicMemory?.run ?? null, restartConsult })

  const stable = valueOf('w1-restart', 'refresh-stable')
  const restartConsolidations = recordsOf('w1-restart').filter(record => record.xwsWire?.kind === 'public-consolidation').length
  const runsBefore = runsOf(dumps['w1-stale']).length
  const runsAfter = runsOf(final).length
  check('restart-does-not-resurrect-or-repeat-memory', stable?.status === 'up-to-date' && restartConsolidations === 0
    && runsAfter === runsBefore
    && snapshotsOf(final).filter(row => row.zone === 'public').length === snapshotsOf(dumps['w1-stale']).filter(row => row.zone === 'public').length,
    { stable: stable?.status, restartConsolidations, runsBefore, runsAfter, publicSnapshotsBefore: snapshotsOf(dumps['w1-stale']).filter(row => row.zone === 'public').length, publicSnapshotsAfter: snapshotsOf(final).filter(row => row.zone === 'public').length })

  const restartAttempt = restartCase ? attemptsOf(final).filter(row => row.case_id === restartCase.case_id).at(-1) ?? null : null
  const privateSnapshot = snapshotsOf(final).find(row => row.zone === 'workspace' && row.namespace_workspace_key === W1)
  check('restart-consult-uses-persisted-private-and-public-pins', restartConsult?.outcome === 'answered'
    && restartAttempt?.pins?.publicMemorySnapshotId === currentBefore[0]
    && restartAttempt?.pins?.memorySnapshotId === privateSnapshot?.snapshot_id,
    { consult: restartConsult, pins: restartAttempt?.pins, publicPin: currentBefore[0], privatePin: privateSnapshot?.snapshot_id })
}

// ---------------------------------------------------------------------------
// 9. Database <-> wire parity
// ---------------------------------------------------------------------------
{
  const agents = (final?.tables?.agent_profiles ?? []).map(row => ({ agentId: row.agent_id, name: row.name, revision: row.revision }))
  const wireAgents = [valueOf('w1-seed', 'identity-list') ?? [], valueOf('w2-identity', 'identity-list') ?? []].flat()
  const agentParity = wireAgents.every(agent => agents.some(row => row.agentId === agent.agentId && row.name === agent.name))
  const selectorChecks = []
  for (const spec of PHASES) {
    const wire = valueOf(spec.phase, 'selector-get')
    if (!wire) continue
    const sessionId = sessionsOf(spec.phase)
    const dbRow = selectorsOf(final).find(row => row.root_session_id === sessionId) ?? null
    const wireRow = detailOf(spec.phase, 'selector-get').row ?? null
    selectorChecks.push({
      phase: spec.phase,
      ok: Boolean(dbRow) && wire.selector?.mode === dbRow.mode && (wire.selector?.agentId ?? null) === (dbRow.agent_id ?? null)
        && selectorRowProblems(dbRow).length === 0
        && wireRow?.root_session_id === dbRow.root_session_id && wireRow?.mode === dbRow.mode,
      wire: wire.selector, wireRow, db: dbRow,
    })
  }
  check('parity-agents-and-selector-rows', agentParity && selectorChecks.length >= 5 && selectorChecks.every(item => item.ok),
    { agents, wireAgents, selectorChecks })

  const zoneProblems = publicZoneProblems({ learning_runs: runsOf(final), memory_snapshots: snapshotsOf(final) })
  const privateNamespaces = [...new Set(snapshotsOf(final).filter(row => row.zone === 'workspace').map(row => row.namespace_workspace_key))].sort()
  const versionPairs = snapshotsOf(final).filter(row => row.zone === 'workspace').map(row => `${row.namespace_workspace_key}:${row.version}`)
  check('parity-namespace-zones-and-versions', zoneProblems.length === 0
    && privateNamespaces.length === 2 && privateNamespaces.every(key => [W1, W2].includes(key))
    && new Set(versionPairs).size === versionPairs.length
    && publicSnapshots().every(row => row.namespace_workspace_key === null),
    { zoneProblems, privateNamespaces, versionPairs, publicNamespaces: publicSnapshots().map(row => row.namespace_workspace_key) })

  const snapshotProblems = []
  let snapshotComparisons = 0
  for (const phase of PHASES.map(item => item.phase)) {
    const rows = new Map(snapshotsOf(dumps[phase]).map(row => [row.snapshot_id, row]))
    const candidates = []
    for (const [label, item] of Object.entries(wireOf(phase))) candidates.push({ label, value: entryValue(item) })
    for (const [label, item] of Object.entries(learningOf(phase))) candidates.push({ label, value: item?.result?.value })
    for (const candidate of candidates) {
      const value = candidate.value?.candidate ?? candidate.value
      const snapshotId = value?.snapshotId
      if (typeof snapshotId !== 'string' || !snapshotId.startsWith('ms_')) continue
      const row = rows.get(snapshotId)
      if (!row) { snapshotProblems.push(`${candidate.label}: ${snapshotId} missing from SQLite after ${phase}`); continue }
      snapshotComparisons += 1
      if (value.version !== undefined && value.version !== row.version) snapshotProblems.push(`${candidate.label}: version ${value.version} != ${row.version}`)
      // A gesture may read the same Snapshot before a later lifecycle step in the
      // same boot bumped its revision; the wire must never claim a revision the
      // database cannot reach, and the immutable content hash must agree.
      if (value.revision !== undefined && value.revision > row.revision) snapshotProblems.push(`${candidate.label}: revision ${value.revision} exceeds ${row.revision}`)
      if (value.contentHash !== undefined && value.contentHash !== row.contentHash) snapshotProblems.push(`${candidate.label}: contentHash differs`)
    }
  }
  check('parity-snapshot-ids-revisions-and-hashes', snapshotProblems.length === 0 && snapshotComparisons >= 6,
    { comparisons: snapshotComparisons, problems: snapshotProblems })

  const pinProblems = []
  let attemptComparisons = 0
  for (const phase of PHASES.map(item => item.phase)) {
    const rows = new Map(attemptsOf(dumps[phase]).map(row => [row.attempt_id, row]))
    for (const [label, item] of Object.entries(wireOf(phase))) {
      for (const attempt of entryValue(item)?.attempts ?? []) {
        const row = rows.get(attempt.attemptId)
        if (!row) { pinProblems.push(`${label}: Attempt ${attempt.attemptId} missing from SQLite after ${phase}`); continue }
        attemptComparisons += 1
        pinProblems.push(...attemptDualPinProblems({ pins: attempt.pins, packManifest: row.packManifest }).map(problem => `${label}: ${problem}`))
        if (canonicalJson(attempt.pins) !== canonicalJson(row.pins)) pinProblems.push(`${label}: wire pins differ from SQLite for ${attempt.attemptId}`)
        if (JSON.stringify(attempt.packManifest?.memory?.publicL2?.principleIds ?? []) !== JSON.stringify(row.packManifest?.memory?.publicL2?.principleIds ?? [])) pinProblems.push(`${label}: publicL2 principleIds differ for ${attempt.attemptId}`)
      }
    }
  }
  check('parity-attempt-dual-pins-and-manifests', pinProblems.length === 0 && attemptComparisons >= 3,
    { comparisons: attemptComparisons, problems: pinProblems })

  const recordProblems = []
  for (const phase of PHASES.map(item => item.phase)) {
    const records = valueOf(phase, 'records')
    if (!records || !Array.isArray(records.records)) continue
    const sessionId = sessionsOf(phase)
    const dbCases = casesOf(dumps[phase]).filter(row => row.root_session_id === sessionId)
    if (records.records.length !== dbCases.length) recordProblems.push(`${phase}: wire claims ${records.records.length} records but SQLite holds ${dbCases.length} for the session`)
    const foreign = records.records.map(row => row.caseId).filter(id => !dbCases.some(row => row.case_id === id))
    if (foreign.length) recordProblems.push(`${phase}: wire listed records outside the session: ${foreign.join(',')}`)
  }
  check('parity-record-counts-and-ownership', recordProblems.length === 0, { problems: recordProblems })

  const authProblems = []
  const leakProblems = []
  for (const phase of PHASES.map(item => item.phase)) {
    const include = label => label.startsWith(`${phase}:`)
    authProblems.push(...wireAuthorizationProblems(wireOf(phase), dumps[phase]?.tables ?? {}, include))
    // A workspace's own record read legitimately carries its own workspaceKey and
    // its own question text; another workspace's path/body may never appear, and a
    // public-zone payload may carry no workspace path at all.
    const ownWorkspace = realpathSync(WS[PHASES.find(spec => spec.phase === phase).workspace])
    const ownAllowed = finding => typeof finding.match === 'string'
      && (finding.code === 'ABSOLUTE_PATH' || finding.code === 'WORKSPACE_PATH')
      && (finding.match === ownWorkspace || finding.match.startsWith(ownWorkspace) || ownWorkspace.startsWith(finding.match))
    const bootTexts = foreignTexts.filter(entry => {
      const row = casesOf(final).find(item => item.case_id === entry.label)
      return row && row.workspace_key !== ownWorkspace
    })
    const foreignPaths = workspacePaths.filter(path => path !== ownWorkspace)
    for (const [label, item] of Object.entries(wireOf(phase))) {
      if (!include(label)) continue
      const publicEntry = item?.op === 'public'
      const findings = leakFindings(item, { paths: publicEntry ? workspacePaths : foreignPaths, texts: bootTexts })
        .filter(finding => publicEntry || !ownAllowed(finding))
      for (const finding of findings) leakProblems.push(`${label}: ${finding.code}:${finding.match}`)
    }
  }
  check('parity-wire-only-contains-database-authorized-records', authProblems.length === 0, { problems: authProblems })
  check('parity-wire-carries-no-paths-or-foreign-bodies', leakProblems.length === 0, { problems: leakProblems })

  const shapeGuards = [
    publicRefreshProblems(entry('w1-public', 'refresh-noack')),
    publicRefreshProblems(entry('w1-public', 'refresh-ack')),
    publicRefreshProblems(entry('w1-stale', 'refresh-retry')),
  ]
  check('parity-public-wire-shape-guards', shapeGuards.every(list => list.length === 0) && entryErrorCode(entry('w1-stale', 'publish-stale')) === 'STALE_SOURCE',
    { guards: shapeGuards, staleCode: entryErrorCode(entry('w1-stale', 'publish-stale')) })
}

// ---------------------------------------------------------------------------
// 10. Runtime hygiene
// ---------------------------------------------------------------------------
{
  const pids = bootChecks.map(item => item.pid).filter(Boolean)
  const alive = pids.filter(pid => {
    try { process.kill(pid, 0); return true } catch { return false }
  })
  const rootLines = processSnapshot().split('\n').filter(line => line.includes(ROOT))
  const listeners = listenerSnapshot()
  const ownedListeners = listeners.split('\n').filter(line => line.trim().length > 0 && (pids.some(pid => line.trim().startsWith(String(pid))) || line.includes(ROOT) || line.includes(PROFILE)))
  check('hygiene-owned-processes-terminated', alive.length === 0 && rootLines.length === 0,
    { pids, alive, rootLines: rootLines.slice(0, 3), exitCodes: bootChecks.map(item => ({ phase: item.phase, pid: item.pid, exitCode: item.exitCode, signal: item.signal })) })
  check('hygiene-no-leftover-listener', ownedListeners.length === 0,
    { forbiddenPorts: FORBIDDEN_PORTS, listeners: listeners.trim().split('\n') })
  const appAfter = currentAppInventory()
  const changed = Object.keys({ ...appBefore, ...appAfter }).filter(path => appBefore[path] !== appAfter[path])
  const integrity = (() => {
    try {
      const db = new DatabaseSync(DB_PATH)
      try { return { ok: db.prepare('PRAGMA integrity_check').get().integrity_check, userVersion: db.prepare('PRAGMA user_version').get().user_version } } finally { db.close() }
    } catch (error) { return { ok: String(error?.message ?? error), userVersion: null } }
  })()
  check('hygiene-current-app-untouched-and-database-integrity', changed.length === 0 && integrity.ok === 'ok' && integrity.userVersion === 2,
    { changed, integrity, currentApp: CURRENT_APP })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
writeJson(join(EVIDENCE, 'report.json'), {
  runId, generatedAt: new Date().toISOString(), startedAt,
  isolatedRoot: ROOT, dshHome: HOME, profile: PROFILE, profileName: PROFILE_NAME,
  currentAppData: CURRENT_APP, forbiddenPorts: FORBIDDEN_PORTS,
  dshLauncher: { kind: launcher.kind, path: launcher.path, source: launcher.source },
  workspaces: Object.fromEntries(Object.entries(WS).map(([label, path]) => [label, { path, realpath: realpathSync(path) }])),
  decisionDatabase: { path: DB_PATH, userVersion: final?.userVersion ?? null },
  boots: bootChecks,
  sessions: SESSIONS,
  checks,
  summary: { total: checks.length, pass: checks.filter(item => item.status === 'PASS').length, fail: checks.filter(item => item.status === 'FAIL').length },
  evidence: {
    databaseDumps: PHASES.map(item => join(EVIDENCE, 'db', `${item.phase}.json`)).concat([join(EVIDENCE, 'db', 'final.json')]),
    wirePayloads: PHASES.map(item => join(EVIDENCE, 'wire', `${item.phase}.json`)).concat([join(EVIDENCE, 'wire', 'final.json')]),
    traces: PHASES.map(item => join(EVIDENCE, 'traces', `${item.phase}.jsonl`)),
    logs: PHASES.map(item => join(EVIDENCE, 'logs', `${item.phase}.out`)),
  },
  problems,
})

const reportText = readFileSync(join(EVIDENCE, 'report.json'), 'utf8')
const pass = problems.length === 0
const sha256 = createHash('sha256').update(reportText).digest('hex')

writeFileSync(join(EVIDENCE, 'COMMANDS.md'), `# Commands — real headless cross-workspace matrix (task 7.2)

Every command below was executed for this evidence set from the lane worktree
root (paths are repository-relative).

\`\`\`bash
# 1. The matrix itself: real headless DSH boots in one isolated profile,
#    W1/W2/W3 workspace cwds, and one real process restart.
NODE=/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
"$NODE" plugins/weir-test-harness/spikes/decision/headless-cross-workspace.mjs

# The driver installs the isolated profile once with the bundled toolchain,
# exactly like spikes/decision/preflight-dual-workspace.mjs:
#   "$NODE" /Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs install --reporter silent
#   (cwd: ${PROFILE})
# It then boots the resolved dsh launcher once per phase with:
#   DSH_HOME=${HOME}
#   WEIR_IT_ROOT=${ROOT}
#   WEIR_IT_SCENARIO=decision-cross-workspace
#   WEIR_IT_DECISION=1 WEIR_IT_DECISION_REMOTE=1
#   WEIR_IT_DECISION_CROSS_WORKSPACE=1
#   WEIR_IT_DECISION_SELECTOR_DEFAULT=auto
#   WEIR_IT_DECISION_AUTO_CLASSES=["A","B","C"]
#   WEIR_IT_XWS_PHASE=<phase> WEIR_IT_XWS_LABEL=<W1|W2|W3> WEIR_IT_TRACE=<phase trace>
#   cwd=<W1|W2|W3>
# New root sessions boot "weir-it --json <prompt>"; resumed phases boot
# "weir-it --session-id <id> <prompt>", so the restart phase is a genuinely new
# process on the same session id.

# 2. Harness unit suites, from the repository root (never the package dir).
"$NODE" --test 'plugins/weir-test-harness/test/**/*.test.js'

# 3. The focused pure-guard unit tests for this matrix.
"$NODE" --test plugins/weir-test-harness/test/decision-cross-workspace.test.js

# 4. Default registry/order conformance (gate unset): the default run list is unchanged.
"$NODE" --test plugins/weir-test-harness/test/scenario-registry.test.js
\`\`\`

Result: ${checks.filter(item => item.status === 'PASS').length}/${checks.length} checks PASS; \`report.json\` sha256 \`${sha256}\`.
`)

writeFileSync(join(EVIDENCE, 'report.md'), markdownReport())

function markdownReport() {
  const lines = []
  lines.push('# Real headless two-workspace Decision memory matrix (task 7.2)', '')
  lines.push(`**Verdict: ${pass ? 'PASS' : `FAIL (${problems.length} failing checks)`}** — ${checks.filter(item => item.status === 'PASS').length}/${checks.length} labeled checks PASS.`, '')
  lines.push(`- Run id: \`${runId}\`; isolated root: \`${ROOT}\``)
  lines.push(`- Profile: \`${PROFILE_NAME}\` (one profile); database: \`${DB_PATH}\` (user_version ${final?.userVersion})`)
  lines.push(`- Workspaces: W1 \`${W1}\`, W2 \`${W2}\`, W3 \`${W3}\``)
  lines.push(`- Launcher: \`${launcher.source} -> ${launcher.path}\` (${launcher.kind})`)
  lines.push(`- Current App data at \`${CURRENT_APP}\` is outside the isolated root and untouched; ports ${FORBIDDEN_PORTS.join('/')} are not bound by any owned process.`)
  lines.push('')
  lines.push('## Required behaviors -> evidence')
  const groups = [
    ['1. Isolation', ['isolation-', 'boots-']],
    ['2. Shared identity', ['identity-']],
    ['3. Private isolation', ['private-']],
    ['4. Public extraction', ['public-first-open', 'public-candidate-', 'public-consolidation-wire', 'public-no-model']],
    ['5. Explicit publish / stale / rejected / rollback', ['public-draft-', 'public-explicit-', 'public-attempt-pins', 'public-stale-', 'public-rejected-', 'public-rollback-']],
    ['6. Public memory is guidance only', ['public-guidance-']],
    ['7. Auto', ['auto-']],
    ['8. Restart', ['restart-']],
    ['9. Database <-> wire parity', ['parity-']],
    ['10. Runtime hygiene', ['hygiene-']],
  ]
  for (const [title, prefixes] of groups) {
    lines.push(`### ${title}`, '')
    const rows = checks.filter(item => prefixes.some(prefix => item.label.startsWith(prefix)))
    for (const row of rows) lines.push(`- **${row.status}** \`${row.label}\``)
    if (rows.length === 0) lines.push('- (no check registered)')
    lines.push('')
  }
  lines.push('## Boot ledger (real processes)', '')
  lines.push('| # | phase | workspace | session | resumed | pid | exit | DB dump | wire | logs |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  bootChecks.forEach((item, index) => {
    lines.push(`| ${index + 1} | ${item.phase} | ${item.workspace} | \`${item.sessionId}\` | ${item.resumed} | ${item.pid} | ${item.exitCode}/${item.signal ?? 'null'} | \`db/${item.phase}.json\` | \`wire/${item.phase}.json\` | \`logs/${item.phase}.out\` |`)
  })
  lines.push('')
  lines.push('## Database facts after the run', '')
  lines.push(`- Tables captured per boot: agent_profiles, selectors, cases, attempts, attempt_evidence, evidence, feedback, corrections, route_decisions, learning_runs, memory_snapshots (+ raw \`.db\` copies).`)
  lines.push(`- Agent profiles: ${(final?.tables?.agent_profiles ?? []).length}; selectors: ${(final?.tables?.selectors ?? []).length}; cases: ${(final?.tables?.cases ?? []).length}; attempts: ${(final?.tables?.attempts ?? []).length}.`)
  lines.push(`- Private zone snapshots: ${snapshotsOf(final).filter(row => row.zone === 'workspace').map(row => `${row.snapshot_id}@v${row.version}/${row.state}`).join(', ') || '(none)'}`)
  lines.push(`- Public zone snapshots: ${publicSnapshots().map(row => `${row.snapshot_id}@v${row.version}/${row.state}`).join(', ') || '(none)'}`)
  lines.push(`- Public learning runs: ${publicRuns().map(row => `${row.learning_run_id}/${row.outcome}`).join(', ') || '(none)'}`)
  lines.push('')
  lines.push('## Assumptions recorded for this run', '')
  lines.push('- W3 is a third real workspace used only for the strict "no current-workspace eligible source" leg of requirement 6; W1/W2 remain the primary matrix.')
  lines.push('- Every phase boots the gated `decision-cross-workspace` scenario; the gate is what keeps the default `run.mjs` list byte-for-byte unchanged.')
  lines.push('- "Wire" means the recorded Decision remote payloads (`wire/<phase>.json`) plus the model-side evaluator/router/consolidation packets in `traces/<phase>.jsonl`. The internal public extraction packet legitimately carries frozen `sourceId`s per design D5; it is scanned for paths, foreign ids and raw bodies.')
  return `${lines.join('\n')}\n`
}

console.log(`\n[evidence] ${EVIDENCE}`)
console.log(`[report] ${join(EVIDENCE, 'report.json')}`)
console.log(pass ? `MATRIX PASS (${checks.length}/${checks.length} checks)` : `MATRIX FAIL (${problems.length} problems)`)
process.exit(pass ? 0 : 1)
