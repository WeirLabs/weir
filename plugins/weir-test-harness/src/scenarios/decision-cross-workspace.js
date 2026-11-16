// Cross-workspace Decision memory: the real two-workspace headless matrix brain.
//
// This scenario is registered ONLY under WEIR_IT_DECISION_CROSS_WORKSPACE=1
// (src/scenarios/index.js). It is not a single-boot scenario: the phases below
// are booted one real headless DSH process at a time by
// spikes/decision/headless-cross-workspace.mjs, each with its own workspace cwd
// and WEIR_IT_XWS_PHASE. One boot runs one root-session turn and performs the
// phase's ordered gestures through the real Decision remote/probe tools.
//
// The scenario also owns the pure guards the driver (and
// test/decision-cross-workspace.test.js) use to judge the collected wire: leak
// scanning, public refresh/review shape guards, namespace invariants, dual-pin
// invariants and wire-to-database authorization. Guards are pure functions over
// recorded data so a failing guard can be proven to fail.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { decisionPack } from '../decision-test-kit.js'

const id = 'decision-cross-workspace'
const prompt = 'decision-cross-workspace-probe'

// Phase table shared with the matrix driver: a `new` phase creates a fresh root
// session in its workspace; a string names the earlier phase whose root session
// is resumed (so W1 can own two independent root sessions in one profile).
const PHASES = [
  { phase: 'w1-seed', workspace: 'W1', session: 'new' },
  { phase: 'w2-identity', workspace: 'W2', session: 'new' },
  { phase: 'w1-public', workspace: 'W1', session: 'w1-seed' },
  { phase: 'w1-publish', workspace: 'W1', session: 'w1-seed' },
  { phase: 'w1-auto', workspace: 'W1', session: 'new' },
  { phase: 'w3-guidance', workspace: 'W3', session: 'new' },
  { phase: 'w2-auto', workspace: 'W2', session: 'new' },
  { phase: 'w1-v2', workspace: 'W1', session: 'w1-seed' },
  { phase: 'w2-source3', workspace: 'W2', session: 'w2-identity' },
  { phase: 'w1-stale', workspace: 'W1', session: 'w1-seed' },
  { phase: 'w1-restart', workspace: 'W1', session: 'w1-seed' },
]

const AGENT_NAME = 'Shared memory assistant'
const AGENT_DESCRIPTION = 'Prefer the documented option when the current workspace supports it.'
const PRINCIPLE_TEXT = 'Prefer the documented option both workspaces agreed on.'
const LOCAL_PRINCIPLE_TEXT = 'Prefer the documented option reviewed in this workspace.'

const CROSS_WIRE = 'decision-cross-workspace-wire.json'
const LEARNING_WIRE = 'decision-learning-rpc.json'

// Marker texts the evaluator/router/classifier brains key on. They are unique
// across the whole matrix so a resumed transcript can never be mistaken for a
// fresh gesture.
const MARKERS = Object.freeze({
  w1Source: 'XWS_W1_SOURCE',
  w2SourceOne: 'XWS_W2_SOURCE_ONE',
  w2SourceTwo: 'XWS_W2_SOURCE_TWO',
  w2SourceThree: 'XWS_W2_SOURCE_THREE',
  w1Local: 'XWS_W1_LOCAL',
  w1LocalPublished: 'XWS_W1_LOCAL_AFTER_PUBLISH',
  w1LocalRestart: 'XWS_W1_LOCAL_AFTER_RESTART',
  w3PublicOnly: 'XWS_W3_PUBLIC_ONLY',
  w2AutoPublic: 'XWS_AUTO_W2_PUBLIC',
  w1AutoLocal: 'XWS_AUTO_W1_LOCAL',
})

// ---------------------------------------------------------------------------
// Pure guards (exported for the matrix driver and the focused unit tests)
// ---------------------------------------------------------------------------

export const PUBLIC_ALIAS = /^origin_[0-9a-f]{12}$/
export const CONTENT_HASH = /^[0-9a-f]{64}$/

// The product's own deterministic absolute-path shapes (learning/public.js).
const ABSOLUTE_PATH_PATTERNS = Object.freeze([
  /file:\/\/[^\s"'`<>]+/g,
  /\\\\[^\s"'`<>\\]+(?:\\[^\s"'`<>\\]+)+/g,
  /[A-Za-z]:\\[^\s"'`<>]+/g,
  /~\/[^\s"'`<>]*/g,
  /(?<![\w.:])\/(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]*/g,
])

/**
 * Scan one recorded value for leaked workspaces, record ids or raw bodies.
 * @param {unknown} value @param {{paths?:string[],recordIds?:string[],texts?:{label:string,text:string}[]}} [forbidden]
 * @returns {{code:string,match:string}[]}
 */
export function leakFindings(value, forbidden = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const findings = []
  for (const path of forbidden.paths ?? []) {
    if (typeof path === 'string' && path.length > 0 && text.includes(path)) findings.push({ code: 'WORKSPACE_PATH', match: path })
  }
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    for (const match of text.matchAll(pattern)) findings.push({ code: 'ABSOLUTE_PATH', match: match[0] })
  }
  for (const recordId of forbidden.recordIds ?? []) {
    if (typeof recordId === 'string' && recordId.length > 0 && text.includes(recordId)) findings.push({ code: 'FOREIGN_RECORD_ID', match: recordId })
  }
  for (const entry of forbidden.texts ?? []) {
    if (entry?.text && text.includes(entry.text)) findings.push({ code: 'RAW_BODY', match: entry.label })
  }
  const seen = new Set()
  return findings.filter(finding => {
    const key = `${finding.code}\u0000${finding.match}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The remote result payload, whether the entry wraps `{ok,value}` or a value. */
export function entryValue(entry) {
  if (entry && typeof entry === 'object' && 'result' in entry) {
    const result = entry.result
    if (result && typeof result === 'object' && 'ok' in result) return result.ok === true ? result.value : undefined
    return result
  }
  return entry
}

/** The remote result error code, or null when the call succeeded. */
export function entryErrorCode(entry) {
  return entry?.result && typeof entry.result === 'object' ? entry.result.error?.code ?? null : null
}

/**
 * Public refresh shape guard: extraction is disclosure-gated, a candidate is a
 * draft summary, and no refresh response ever claims a published current version.
 * @param {any} entry @returns {string[]}
 */
export function publicRefreshProblems(entry) {
  const problems = []
  const value = entryValue(entry)
  if (!value) return [`the public refresh call failed: ${entryErrorCode(entry) ?? 'no value'}`]
  if (value.zone !== 'public') problems.push('zone must be public')
  if (!['disclosure-required', 'candidate', 'up-to-date', 'empty-sources', 'failed', 'running'].includes(value.status)) problems.push(`unexpected status ${value.status}`)
  if (!value.disclosure || typeof value.disclosure.key !== 'string') problems.push('the disclosure descriptor is required')
  if (value.status === 'disclosure-required') {
    if (value.candidate !== null) problems.push('disclosure-required must not carry a candidate')
    if (value.current !== null) problems.push('disclosure-required must not carry a published current version')
    if (value.disclosure?.required !== true) problems.push('disclosure-required must report disclosure.required=true')
  }
  if (value.status === 'candidate') {
    const candidate = value.candidate
    if (!candidate) problems.push('a candidate status requires a candidate summary')
    else {
      if (!/^ms_/.test(String(candidate.snapshotId))) problems.push('candidate snapshotId')
      if (!/^lr_/.test(String(candidate.learningRunId))) problems.push('candidate learningRunId')
      if (candidate.state !== 'draft') problems.push('an unpublishable candidate must still be a draft')
      if (!Number.isInteger(candidate.revision) || candidate.revision < 1) problems.push('candidate revision')
      if (!CONTENT_HASH.test(String(candidate.contentHash))) problems.push('candidate contentHash')
      if (!Number.isInteger(candidate.workspaceCount) || candidate.workspaceCount < 1) problems.push('candidate workspaceCount')
    }
  }
  if (value.current !== null && value.current !== undefined) {
    if (!/^ms_/.test(String(value.current.snapshotId))) problems.push('current snapshotId')
    if (!Number.isInteger(value.current.version)) problems.push('current version')
  }
  return problems
}

/**
 * Public candidate review guard: opaque aliases with bounded previews, no
 * Evidence mapping, no forbidden path/id/body anywhere in the projection.
 * @param {any} entry @param {{paths?:string[],recordIds?:string[],texts?:{label:string,text:string}[]}} [forbidden]
 * @returns {string[]}
 */
export function publicCandidateProblems(entry, forbidden = {}) {
  const problems = []
  const value = entryValue(entry)
  if (!value) return [`the public candidate call failed: ${entryErrorCode(entry) ?? 'no value'}`]
  if (value.zone !== 'public') problems.push('zone must be public')
  if (!Array.isArray(value.sources) || value.sources.length === 0) problems.push('source groups are required')
  for (const group of value.sources ?? []) {
    if (!PUBLIC_ALIAS.test(String(group.alias))) problems.push(`alias ${group.alias}`)
    if (!Number.isInteger(group.count) || group.count < 1) problems.push(`count for ${group.alias}`)
    if (typeof group.preview !== 'string' || group.preview.length > 240) problems.push(`preview bound for ${group.alias}`)
    if (group.kinds && group.kinds.case + group.kinds.correction !== group.count) problems.push(`kinds for ${group.alias}`)
  }
  if (!Array.isArray(value.principles)) problems.push('principles are required')
  for (const principle of value.principles ?? []) {
    if (Object.hasOwn(principle, 'evidenceIds')) problems.push('a public principle must not carry Evidence Refs')
    if (principle.zone !== undefined && principle.zone !== 'public') problems.push('principle zone')
  }
  if (!Array.isArray(value.changes)) problems.push('changes are required')
  if (value.candidate?.state !== 'draft') problems.push('the review candidate must be a draft')
  if (value.replay?.passed !== true) problems.push('the structural replay must pass before review')
  for (const finding of leakFindings(value, forbidden)) problems.push(`${finding.code}:${finding.match}`)
  return problems
}

/**
 * Memory namespace invariants over raw DB rows: the public zone has no
 * workspace namespace, the private zone always has one, and versions are
 * unique inside one namespace.
 * @param {{learning_runs?:any[],memory_snapshots?:any[]}} rows
 * @returns {string[]}
 */
export function publicZoneProblems(rows) {
  const problems = []
  for (const table of ['learning_runs', 'memory_snapshots']) {
    const entries = rows?.[table] ?? []
    if (!Array.isArray(entries)) { problems.push(`${table} rows are required`); continue }
    const versions = new Set()
    for (const row of entries) {
      if (!['workspace', 'public'].includes(row.zone)) problems.push(`${table} ${row[`${table === 'learning_runs' ? 'learning_run_id' : 'snapshot_id'}`]} has zone ${row.zone}`)
      const namespace = row.namespace_workspace_key
      if (row.zone === 'public' && namespace !== null) problems.push(`${table} public row carries a workspace namespace`)
      if (row.zone === 'workspace' && (typeof namespace !== 'string' || namespace.length === 0)) problems.push(`${table} private row has no workspace namespace`)
      // Only Snapshots carry a version; a Learning Run has no version column.
      if (table !== 'memory_snapshots') continue
      const key = `${row.zone}\u0000${namespace ?? ''}\u0000${row.version}`
      if (versions.has(key)) problems.push(`${table} version ${row.version} duplicated in ${row.zone}/${namespace ?? ''}`)
      versions.add(key)
    }
  }
  return problems
}

/**
 * Attempt dual-pin invariants: both pins are present (null is explicit) and the
 * manifest keeps the two zones separate with no public Evidence mapping.
 * @param {any} attempt
 * @returns {string[]}
 */
export function attemptDualPinProblems(attempt) {
  const problems = []
  const pins = attempt?.pins
  if (!pins || typeof pins !== 'object') return ['an Attempt must carry pins']
  if (!Object.hasOwn(pins, 'memorySnapshotId')) problems.push('memorySnapshotId pin is missing')
  if (!Object.hasOwn(pins, 'publicMemorySnapshotId')) problems.push('publicMemorySnapshotId pin is missing')
  const memory = attempt?.packManifest?.memory
  if (!memory || typeof memory !== 'object') return [...problems, 'the Attempt manifest must carry both memory zones']
  if (memory.L2?.zone !== 'workspace') problems.push('manifest memory.L2 must be the workspace zone')
  if (memory.publicL2?.zone !== 'public') problems.push('manifest memory.publicL2 must be the public zone')
  const publicItems = memory.publicL2?.items ?? []
  for (const item of publicItems) {
    // The manifest carries the zone on the partition, not on each item.
    if (Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0) problems.push('a publicL2 item carries Evidence Refs')
    for (const source of item.sources ?? []) if (!PUBLIC_ALIAS.test(String(source))) problems.push(`publicL2 source ${source} is not an opaque alias`)
  }
  const evidenceIds = attempt?.packManifest?.evidenceIds ?? []
  for (const source of publicItems.flatMap(item => item.sources ?? [])) {
    if (evidenceIds.includes(source)) problems.push('a public source alias entered the evidence mapping')
  }
  return problems
}

/** @param {any} row @returns {string[]} */
export function selectorRowProblems(row) {
  const problems = []
  if (!row || typeof row !== 'object') return ['a selector row is required']
  if (typeof row.root_session_id !== 'string' || !row.root_session_id) problems.push('root_session_id')
  if (!['off', 'auto', 'agent'].includes(row.mode)) problems.push(`mode ${row.mode}`)
  if (row.mode === 'agent' && (typeof row.agent_id !== 'string' || !row.agent_id)) problems.push('an agent selector needs agent_id')
  if (row.mode !== 'agent' && row.agent_id !== null && row.agent_id !== undefined) problems.push('auto/off selectors carry no agent_id')
  return problems
}

const ID_KEYS = new Set(['agentId', 'agent_id', 'caseId', 'case_id', 'snapshotId', 'snapshot_id', 'learningRunId', 'learning_run_id', 'evidenceId', 'evidence_id', 'feedbackId', 'feedback_id', 'rootSessionId', 'root_session_id', 'attemptId', 'attempt_id'])

/** @param {unknown} value @param {Set<string>} out */
function collectIds(value, out) {
  if (Array.isArray(value)) { for (const item of value) collectIds(item, out); return out }
  if (!value || typeof value !== 'object') return out
  for (const [key, child] of Object.entries(value)) {
    if (ID_KEYS.has(key) && typeof child === 'string' && child.length > 0) out.add(`${key}\u0000${child}`)
    else collectIds(child, out)
  }
  return out
}

/**
 * Every id a boot's wire payloads mention must be authorized by that boot's
 * database: agents, Cases, attempts, Snapshots, Runs and selector rows exist,
 * and nothing else is invented by the wire.
 * @param {object} wire - label -> probe entry
 * @param {{agent_profiles?:any[],cases?:any[],attempts?:any[],memory_snapshots?:any[],learning_runs?:any[],selectors?:any[],evidence?:any[],feedback?:any[]}} db
 * @param {(label:string)=>boolean} include - which labels belong to this boot
 * @returns {string[]}
 */
export function wireAuthorizationProblems(wire, db, include = () => true) {
  const problems = []
  const known = {
    agent: new Set((db.agent_profiles ?? []).map(row => row.agent_id)),
    case: new Set((db.cases ?? []).map(row => row.case_id)),
    attempt: new Set((db.attempts ?? []).map(row => row.attempt_id)),
    snapshot: new Set((db.memory_snapshots ?? []).map(row => row.snapshot_id)),
    run: new Set((db.learning_runs ?? []).map(row => row.learning_run_id)),
    session: new Set((db.selectors ?? []).map(row => row.root_session_id)),
    evidence: new Set((db.evidence ?? []).map(row => row.evidence_id)),
    feedback: new Set((db.feedback ?? []).map(row => row.feedback_id)),
  }
  const table = value => {
    if (/^(ag_)/.test(value)) return 'agent'
    if (/^(dc_)/.test(value)) return 'case'
    if (/^(da_)/.test(value)) return 'attempt'
    if (/^(ms_)/.test(value)) return 'snapshot'
    if (/^(lr_)/.test(value)) return 'run'
    if (/^(ev_)/.test(value)) return 'evidence'
    if (/^(fb_)/.test(value)) return 'feedback'
    return 'session'
  }
  const reported = new Set()
  for (const [label, entry] of Object.entries(wire ?? {})) {
    if (!include(label)) continue
    for (const packed of collectIds(entry, new Set())) {
      const [key, value] = packed.split('\u0000')
      const kind = table(value)
      if (!known[kind].has(value)) {
        const key2 = `${label}\u0000${kind}\u0000${value}`
        if (reported.has(key2)) continue
        reported.add(key2)
        problems.push(`${label}: ${key} ${value} is not authorized by the database`)
      }
    }
  }
  return problems
}

/**
 * A wire payload must not carry a filesystem path or raw foreign body text.
 * @param {object} wire @param {{paths?:string[],texts?:{label:string,text:string}[]}} [forbidden]
 * @param {(label:string)=>boolean} [include]
 * @returns {string[]}
 */
export function wireLeakProblems(wire, forbidden = {}, include = () => true) {
  const problems = []
  for (const [label, entry] of Object.entries(wire ?? {})) {
    if (!include(label)) continue
    for (const finding of leakFindings(entry, forbidden)) problems.push(`${label}: ${finding.code}:${finding.match}`)
  }
  return problems
}

/** The one Evaluator/Router/consolidation wire record a label produced, if any. */
export function wireRecord(records, kind) {
  return (records ?? []).find(record => record?.xwsWire?.kind === kind)?.xwsWire ?? null
}

// ---------------------------------------------------------------------------
// Scenario-local report readers (the gestures' own wire files)
// ---------------------------------------------------------------------------

function readWire(name) {
  const root = process.env.WEIR_IT_ROOT
  if (!root) return {}
  try {
    return JSON.parse(readFileSync(join(root, 'ws', name), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

function crossWire() { return readWire(CROSS_WIRE) }
function learningWire() { return readWire(LEARNING_WIRE) }
function crossEntry(label) { return crossWire()[label] }
function learningEntry(label) { return learningWire()[label] }

function sharedAgentId() {
  for (const entry of Object.values(crossWire())) {
    const value = entryValue(entry)
    if (value && typeof value.agentId === 'string' && /^ag_/.test(value.agentId)) return value.agentId
  }
  return undefined
}

function stated(label) {
  const entry = learningEntry(label)
  return entry?.result?.value
}

// ---------------------------------------------------------------------------
// Gesture table: one ordered step list per phase
// ---------------------------------------------------------------------------

const LABEL_PREFIX = phase => `${phase}:`

/** @param {object} context */
function stepsFor(phase) {
  const L = name => `${LABEL_PREFIX(phase)}${name}`
  const probe = (name, op, args) => ({ label: L(name), kind: 'probe', op, args: { ...args, name: AGENT_NAME } })
  const ask = (name, marker, options, key) => ({ label: L(name), kind: 'ask', question: { id: `decision-xws-${phase}-${key}`, question: `${marker}: choose one option`, options: options.map(label => ({ label })) } })
  const consult = (name, marker, key) => ({ label: L(name), kind: 'consult', args: { question: `${marker}: choose the option the workspace supports`, options: [{ label: 'Documented option' }, { label: 'Other' }], request_id: `xws-${phase}-${key}` } })
  const note = (name, args) => ({ label: L(name), kind: 'probe', op: 'caseQuery', args: { ...args } })

  switch (phase) {
    case 'w1-seed':
      return [
        probe('identity-create', 'identity', { action: 'create', userDescription: AGENT_DESCRIPTION }),
        probe('identity-list', 'identity', { action: 'list' }),
        probe('identity-duplicate', 'identity', { action: 'create', variant: 'upper', userDescription: 'A second identity must be rejected.' }),
        probe('selector-set', 'identity', { action: 'selector-set', mode: 'agent' }),
        probe('selector-get', 'identity', { action: 'selector-get' }),
        ask('source-ask', MARKERS.w1Source, ['W1 documented option', 'Other'], 'source'),
        note('candidate-case', { action: 'by-question', questionId: `decision-xws-${phase}-source` }),
        // A real private Learning Run in W1: the private zone keeps its own
        // workspace namespace and its own published Snapshot.
        { label: L('private-start'), kind: 'learning', args: { action: 'learningStart', requestId: `${phase}-private` } },
        { label: L('private-run'), kind: 'learning', args: { action: 'learningRun', requestId: `${phase}-private` } },
        { label: L('private-draft'), kind: 'learning', args: { action: 'memorySnapshot', snapshotOf: L('private-run') } },
        { label: L('private-publish'), kind: 'learning', args: { action: 'snapshotPublish', snapshotOf: L('private-run'), revisionOf: L('private-draft') } },
        probe('records', 'caseQuery', { action: 'records' }),
      ]
    case 'w2-identity':
      return [
        probe('identity-list', 'identity', { action: 'list' }),
        probe('identity-duplicate', 'identity', { action: 'create', variant: 'upper', userDescription: 'A second identity must be rejected.' }),
        probe('selector-set', 'identity', { action: 'selector-set', mode: 'agent' }),
        probe('selector-get', 'identity', { action: 'selector-get' }),
        ask('source-ask', MARKERS.w2SourceOne, ['W2 documented option', 'Other'], 'source'),
        note('candidate-case', { action: 'by-question', questionId: `decision-xws-${phase}-source` }),
        { label: L('private-start'), kind: 'learning', args: { action: 'learningStart', requestId: `${phase}-private` } },
        { label: L('private-run'), kind: 'learning', args: { action: 'learningRun', requestId: `${phase}-private` } },
        { label: L('private-draft'), kind: 'learning', args: { action: 'memorySnapshot', snapshotOf: L('private-run') } },
        { label: L('private-publish'), kind: 'learning', args: { action: 'snapshotPublish', snapshotOf: L('private-run'), revisionOf: L('private-draft') } },
        note('deny-w1-case', { action: 'read', caseIdFrom: 'WEIR_IT_XWS_W1_CASE' }),
        { label: L('deny-w1-run'), kind: 'learning', args: { action: 'learningRun', learningRunIdFrom: 'WEIR_IT_XWS_W1_RUN' } },
        { label: L('deny-w1-snapshot'), kind: 'learning', args: { action: 'memorySnapshot', snapshotIdFrom: 'WEIR_IT_XWS_W1_SNAPSHOT' } },
        probe('records', 'caseQuery', { action: 'records' }),
      ]
    case 'w1-public':
      return [
        probe('refresh-noack', 'public', { action: 'refresh', acknowledgedDisclosure: false }),
        probe('refresh-ack', 'public', { action: 'refresh', acknowledgedDisclosure: true }),
        probe('candidate', 'public', { action: 'candidate' }),
        probe('refresh-stable', 'public', { action: 'refresh' }),
        consult('local-consult', MARKERS.w1Local, 'local'),
      ]
    case 'w1-publish':
      return [
        probe('candidate', 'public', { action: 'candidate' }),
        probe('publish', 'public', { action: 'publish', snapshotOf: L('candidate'), revisionOf: L('candidate') }),
        probe('refresh-stable', 'public', { action: 'refresh' }),
        consult('published-consult', MARKERS.w1LocalPublished, 'published'),
        note('deny-w2-case', { action: 'read', caseIdFrom: 'WEIR_IT_XWS_W2_CASE' }),
        { label: L('deny-w2-run'), kind: 'learning', args: { action: 'learningRun', learningRunIdFrom: 'WEIR_IT_XWS_W2_RUN' } },
        { label: L('deny-w2-snapshot'), kind: 'learning', args: { action: 'memorySnapshot', snapshotIdFrom: 'WEIR_IT_XWS_W2_SNAPSHOT' } },
        probe('state', 'public', { action: 'state' }),
      ]
    case 'w1-auto':
      return [
        probe('selector-get', 'identity', { action: 'selector-get' }),
        ask('auto-ask', MARKERS.w1AutoLocal, ['Auto local option', 'Other'], 'auto'),
      ]
    case 'w3-guidance':
      return [
        probe('selector-get', 'identity', { action: 'selector-get' }),
        consult('public-only-consult', MARKERS.w3PublicOnly, 'public-only'),
      ]
    case 'w2-auto':
      return [
        probe('selector-get', 'identity', { action: 'selector-get' }),
        ask('auto-public-ask', MARKERS.w2AutoPublic, ['Public guidance option', 'Other'], 'auto-public'),
        note('candidate-case', { action: 'by-question', questionId: `decision-xws-${phase}-auto-public` }),
        probe('records', 'caseQuery', { action: 'records' }),
      ]
    case 'w1-v2':
      return [
        probe('refresh-candidate', 'public', { action: 'refresh', acknowledgedDisclosure: true }),
        probe('candidate', 'public', { action: 'candidate' }),
        probe('publish', 'public', { action: 'publish', snapshotOf: L('candidate'), revisionOf: L('candidate') }),
        probe('rollback', 'public', { action: 'rollback', snapshotOf: L('candidate'), revisionOf: L('publish') }),
        probe('state', 'public', { action: 'state' }),
      ]
    case 'w2-source3':
      return [
        ask('source-ask', MARKERS.w2SourceThree, ['W2 third option', 'Other'], 'source-three'),
        note('candidate-case', { action: 'by-question', questionId: `decision-xws-${phase}-source-three` }),
        probe('records', 'caseQuery', { action: 'records' }),
      ]
    case 'w1-stale':
      return [
        probe('refresh-candidate', 'public', { action: 'refresh', acknowledgedDisclosure: true }),
        probe('candidate', 'public', { action: 'candidate' }),
        note('comment', { action: 'comment', caseIdFrom: 'WEIR_IT_XWS_W1_CASE', text: 'A later review note changes the frozen source revision.' }),
        probe('publish-stale', 'public', { action: 'publish', snapshotOf: L('candidate'), revisionOf: L('candidate') }),
        probe('refresh-retry', 'public', { action: 'refresh', retryFailedExtraction: true }),
        probe('retry-candidate', 'public', { action: 'candidate' }),
        probe('reject', 'public', { action: 'reject', snapshotOf: L('retry-candidate'), revisionOf: L('retry-candidate') }),
        probe('state', 'public', { action: 'state' }),
        probe('records', 'caseQuery', { action: 'records' }),
      ]
    case 'w1-restart':
      return [
        probe('selector-get', 'identity', { action: 'selector-get' }),
        probe('state-before', 'public', { action: 'state' }),
        probe('refresh-stable', 'public', { action: 'refresh' }),
        consult('restart-consult', MARKERS.w1LocalRestart, 'restart'),
        probe('rollback-current', 'public', { action: 'rollback', currentOf: L('state-before') }),
        probe('state-after', 'public', { action: 'state' }),
      ]
    default:
      return []
  }
}

/** Resolve a step's final probe/learning arguments from earlier wire results. */
function resolveArgs(step) {
  const args = { ...(step.args ?? {}) }
  for (const [key, source] of Object.entries(args)) {
    if (!key.endsWith('Of') && !key.endsWith('From')) continue
    if (key.endsWith('From')) { args[key.slice(0, -4)] = process.env[source]; delete args[key]; continue }
    const label = source
    if (key === 'snapshotOf') {
      const learning = learningEntry(label)
      args.snapshotId = learning?.snapshotId ?? crossEntry(label)?.result?.value?.snapshotId ?? crossEntry(label)?.result?.value?.candidate?.snapshotId
    } else if (key === 'revisionOf') {
      const learning = learningEntry(label)
      args.expectedRevision = learning?.result?.value?.revision ?? crossEntry(label)?.result?.value?.revision ?? crossEntry(label)?.result?.value?.candidate?.revision
    } else if (key === 'currentOf') {
      const value = entryValue(crossEntry(label))
      const current = value?.current ?? value?.publicMemory?.current ?? null
      args.snapshotId = current?.snapshotId
      args.expectedRevision = current?.revision
    }
    delete args[key]
  }
  if (args.name === undefined) delete args.name
  for (const key of Object.keys(args)) if (args[key] === undefined) delete args[key]
  return args
}

// ---------------------------------------------------------------------------
// Brains
// ---------------------------------------------------------------------------

/** @param {any} obs */
function countOccurrences(text, marker) {
  return String(text ?? '').split(marker).length - 1
}

/**
 * Public consolidation reaches this module through the generic brain: the mock
 * dispatcher switches on the private contract's first line only. Emit one
 * workspace-agnostic operation whose sources are exactly the frozen set.
 */
function publicConsolidation(obs) {
  const projection = decisionPack(obs)
  const sources = (projection?.sources ?? []).map(source => source.sourceId)
  if (sources.length === 0) return textChunks(JSON.stringify({ operations: [] }))
  const parent = projection?.parentSnapshot?.principles?.[0]
  if (parent) {
    return textChunks(JSON.stringify({ operations: [{ op: 'refine', principleId: parent.principleId, text: PRINCIPLE_TEXT, scope: {}, sources }] }))
  }
  return textChunks(JSON.stringify({ operations: [{ op: 'add', principleId: 'public-principle', text: PRINCIPLE_TEXT, scope: {}, sources }] }))
}

function decide(options, obs) {
  if (obs.system.startsWith('Decision public consolidation contract v1')) return publicConsolidation(obs)
  const history = obs.transcript
  if (history.includes('DECISION_REMOTE error') || history.includes('DECISION_TEST error')) return textChunks('XWS_PROBE_FAILED')
  const phase = process.env.WEIR_IT_XWS_PHASE ?? ''
  if (!phase) return textChunks('XWS_PHASE_MISSING')
  if (!history.includes(prompt)) return textChunks('XWS_PROMPT_MISSING')
  for (const step of stepsFor(phase)) {
    if (history.includes(`"label":"${step.label}"`)) continue
    if (step.kind === 'probe') {
      const args = resolveArgs(step)
      return toolCallChunks('decision_remote_probe', { op: step.op, label: step.label, ...args })
    }
    if (step.kind === 'learning') {
      return toolCallChunks('decision_remote_probe', { op: 'learning', label: step.label, agentId: sharedAgentId(), ...resolveArgs(step) })
    }
    if (step.kind === 'ask') {
      if (history.includes(step.question.id)) continue
      return toolCallChunks('ask_user_question', { questions: [step.question] })
    }
    if (step.kind === 'consult') {
      if (history.includes(`"request_id":"${step.args.request_id}"`)) continue
      return toolCallChunks('decision_consult', step.args)
    }
  }
  return textChunks(`XWS_${phase.toUpperCase().replaceAll('-', '_')}_DONE`)
}

function answer(question, evidenceId) {
  return textChunks(JSON.stringify({
    outcome: 'answer',
    claims: [{ text: 'The cited evidence decides this question.', evidenceIds: [evidenceId] }],
    answers: [{ id: question.id, selected: [question.options?.[0]?.label ?? 'Documented option'] }],
  }))
}

function missing(hint) {
  return textChunks(JSON.stringify({ outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint }))
}

function escalate(missingList) {
  return textChunks(JSON.stringify({ outcome: 'escalate', missing: missingList }))
}

/** Evaluator brain: only the public/L5 distinction is exercised deliberately. */
function decideDecision(options, obs) {
  const pack = decisionPack(obs)
  const question = pack?.L4?.request?.questions?.[0]
  if (!question) return escalate(['Missing Decision fixture request'])
  const text = String(question.question ?? '')
  const L2 = Array.isArray(pack.L2) ? pack.L2 : []
  const publicItems = L2.filter(item => item?.zone === 'public')
  const localCase = (pack.L5 ?? []).find(ref => ['user_decision', 'agent_record'].includes(ref.source) && ref.locator?.kind === 'case')
  if (text.startsWith(MARKERS.w1Source) || text.startsWith(MARKERS.w2SourceOne) || text.startsWith(MARKERS.w2SourceThree)) {
    return escalate(['The user must decide this source question; no current evidence authorizes it.'])
  }
  if (text.startsWith(MARKERS.w1Local) || text.startsWith(MARKERS.w1LocalPublished) || text.startsWith(MARKERS.w1LocalRestart) || text.startsWith(MARKERS.w1AutoLocal)) {
    if (!localCase) return missing('The current workspace has no eligible evidence.')
    return answer(question, localCase.evidenceId)
  }
  if (text.startsWith(MARKERS.w3PublicOnly)) {
    return missing('The current workspace has no eligible evidence; cross-workspace guidance cannot authorize an answer.')
  }
  if (text.startsWith(MARKERS.w2AutoPublic)) {
    const principle = publicItems[0]
    if (!principle) return missing('Cross-workspace guidance is unavailable for this workspace.')
    // The adversarial probe: try to make reviewed guidance the decisive basis.
    return textChunks(JSON.stringify({
      outcome: 'answer',
      claims: [{ text: 'Trust the reviewed cross-workspace principle.', evidenceIds: [principle.principleId] }],
      answers: [{ id: question.id, selected: [question.options?.[0]?.label ?? 'Public guidance option'] }],
    }))
  }
  return missing('A mapped current-workspace evidence source is required.')
}

function decideConsolidation(options, obs) {
  const projection = decisionPack(obs)
  const sources = (projection?.cases ?? []).map(item => item.caseId)
  if (!projection?.workspaceKey || sources.length === 0) return textChunks(JSON.stringify({ operations: [] }))
  const parent = projection?.parentSnapshot?.principles?.[0]
  if (parent) {
    return textChunks(JSON.stringify({ operations: [{ op: 'refine', principleId: parent.principleId, text: LOCAL_PRINCIPLE_TEXT, scope: { workspaces: [projection.workspaceKey] }, sources }] }))
  }
  return textChunks(JSON.stringify({ operations: [{ op: 'add', principleId: 'local-principle', text: LOCAL_PRINCIPLE_TEXT, scope: { workspaces: [projection.workspaceKey] }, sources }] }))
}

function decideRouterRoute(options, obs) {
  const pack = decisionPack(obs)
  const candidates = pack?.candidates ?? []
  const chosen = candidates.find(candidate => candidate.name === AGENT_NAME) ?? candidates[0]
  if (!chosen) return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'none', reason: 'No eligible shared identity for this request' }))
  return textChunks(JSON.stringify({ contract: 'router-contract/1', outcome: 'selected', agentId: chosen.agentId, reason: 'The profile-global shared identity owns this fixture' }))
}

/** Parse a decision_consult tool result out of the last tool message. */
function parseConsult(text) {
  const first = String(text ?? '').split('\n', 1)[0]
  try {
    const value = JSON.parse(first)
    if (typeof value?.outcome !== 'string' || typeof value?.caseId !== 'string') return null
    return {
      outcome: value.outcome, caseId: value.caseId,
      code: value.code ?? null, hint: value.hint ?? null, userDecided: value.userDecided === true,
      evidenceCount: Array.isArray(value.evidence) ? value.evidence.length : 0,
      pinsPublic: value.pins?.publicMemorySnapshotId ?? null,
      pinsPrivate: value.pins?.memorySnapshotId ?? null,
    }
  } catch { return null }
}

function observe(obs) {
  const contract = obs.system.split('\n', 1)[0]
  const kind = contract === 'Decision evaluator contract v3' ? 'evaluator'
    : contract === 'Decision consolidation contract v1' ? 'private-consolidation'
      : contract === 'Decision public consolidation contract v1' ? 'public-consolidation'
        : contract === 'Auto candidate router contract: router-contract/1' ? 'router-route'
          : null
  const pack = decisionPack(obs)
  return {
    xwsPhase: process.env.WEIR_IT_XWS_PHASE ?? null,
    xwsConsult: parseConsult(obs.lastTool),
    xwsWire: kind ? {
      kind, system: obs.system, content: obs.lastUser, tools: obs.toolNames,
      hasTemperature: obs.hasTemperature, provider: obs.provider, model: obs.model, pack,
    } : null,
    decisionQuestionIds: pack?.L4?.request?.questions?.map(question => question.id) ?? [],
    decisionEvidenceIds: pack?.L5?.map(evidence => evidence.evidenceId) ?? [],
  }
}

// The matrix is booted by spikes/decision/headless-cross-workspace.mjs; a
// single generic run.mjs boot cannot establish the multi-boot contract, so the
// generic driver path reports an explicit skip instead of a false verdict.
function assert(view) {
  const message = 'the isolated two-workspace matrix is booted by plugins/weir-test-harness/spikes/decision/headless-cross-workspace.mjs'
  if (typeof view.skip === 'function') view.skip('cross-workspace matrix driver', message)
  else view.check('cross-workspace matrix driver', true, message)
}

export { id, prompt, PHASES, MARKERS, AGENT_NAME, CROSS_WIRE, LEARNING_WIRE, stepsFor, observe, decide, decideDecision, decideConsolidation, decideRouterRoute, assert }

export default {
  id, prompt, PHASES, decide, decideDecision, decideConsolidation,
  decideRouterRoute, observe, assert,
}
