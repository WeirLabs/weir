// User-controlled Decision data export (OpenSpec decision-data-export D3/D4/D8).
//
// One export is a self-contained, checkable file: it reuses the reviewed read
// projections (`DecisionQuery.record()`, the private learning read faces and the
// published-principle rows) and only adds collection, redaction, a canonical
// checksum and an atomic write. Nothing here authorizes anything: the caller's
// root session and workspace are derived by the Broker, never named by a caller.
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { canonicalJson, DecisionContractError } from '../contracts.js'
import { redactPublicText } from '../learning/public.js'
import { PRIVATE_ZONE, memoryNamespace, workspaceAlias } from '../learning/namespace.js'

export const EXPORT_KIND = 'weir-decision-export'
export const EXPORT_FORMAT_VERSION = 1
export const EXPORT_DIR_NAME = 'exports'
export const EXPORT_MAX_BYTES = 32 * 1024 * 1024
/** Closed failure surface: an export never fails with a raw filesystem error. */
export const EXPORT_ERROR_CODES = Object.freeze(['EXPORT_UNAVAILABLE', 'EXPORT_WRITE_FAILED', 'EXPORT_TOO_LARGE'])
const EXPORT_RECORD_PAGE = 100
const OTHER_WORKSPACE = '<other-workspace>'

/**
 * Collect every Case of the caller's root session inside the caller's workspace
 * through the reviewed record read model, then redact and checksum the envelope.
 * @param {{rootSessionId:string,workspaceKey:string,exportedAt:number,query:any,learning:any,profiles:any,publicPrinciples?:any[]}} input
 */
export function assembleExportEnvelope(input) {
  const alias = workspaceAlias(input.workspaceKey)
  const cases = collectCaseRecords(input.query, input.rootSessionId, input.workspaceKey)
  const learning = collectPrivateLearning(input.learning, input.workspaceKey)
  const agentIds = sortedUnique([
    ...cases.map(entry => entry.case?.agentId),
    ...learning.runs.map(run => run.agentId),
    ...learning.snapshots.map(snapshot => snapshot.agentId),
  ])
  const body = {
    kind: EXPORT_KIND,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: input.exportedAt,
    generator: { name: 'weir-harness', version: `decision-export/${EXPORT_FORMAT_VERSION}` },
    scope: { workspaceAlias: alias },
    agents: agentIds.map(agentId => userVisibleAgent(input.profiles.getProfile(agentId))),
    cases,
    learning,
    public: {
      kind: 'published-principles-only',
      principles: (input.publicPrinciples ?? []).map(row => ({
        principleId: String(row?.principleId ?? ''),
        text: String(row?.text ?? ''),
        scope: row?.scope && typeof row.scope === 'object' && !Array.isArray(row.scope) ? row.scope : {},
      })),
    },
  }
  const redacted = sanitize(body, input.workspaceKey, alias)
  const envelope = { ...redacted, counts: countEntries(redacted) }
  return { ...envelope, integrity: { algorithm: 'sha256', value: exportChecksum(envelope) } }
}

/**
 * Recompute the checksum any reader can verify: sha256 over the canonical JSON
 * of the whole envelope except the `integrity` field itself.
 * @param {any} envelope
 */
export function exportChecksum(envelope) {
  const rest = { ...envelope }
  delete rest.integrity
  return createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

/**
 * Atomic, bounded write into `<store dir>/exports`. A 0700 directory and a 0600
 * file, a unique name per export, a temp file tightened then renamed into place,
 * and no residue on failure: a user-visible export is either complete or absent.
 * @param {string} exportsDir
 * @param {any} envelope
 * @param {{fs?: {mkdirSync?:Function,chmodSync?:Function,writeFileSync?:Function,renameSync?:Function,unlinkSync?:Function,existsSync?:Function}}} [options]
 * @returns {{file:string,name:string,bytes:number,sha256:string}}
 */
export function writeExportFile(exportsDir, envelope, options = {}) {
  const fs = { mkdirSync, chmodSync, writeFileSync, renameSync, unlinkSync, existsSync, ...(options.fs ?? {}) }
  const text = `${JSON.stringify(envelope, null, 2)}\n`
  const bytes = Buffer.byteLength(text)
  if (bytes > EXPORT_MAX_BYTES) throw new DecisionContractError('EXPORT_TOO_LARGE', `${bytes} bytes exceeds ${EXPORT_MAX_BYTES}`)
  const name = exportFileName(envelope)
  const file = join(exportsDir, name)
  const temporary = join(exportsDir, `.tmp-${randomUUID()}`)
  let wrote = false
  try {
    const created = !fs.existsSync(exportsDir)
    fs.mkdirSync(exportsDir, { recursive: true, mode: 0o700 })
    // Only a directory this export created is tightened: an existing directory
    // keeps the permissions its operator gave it, so a read-only directory fails
    // closed instead of being silently widened.
    if (created) fs.chmodSync(exportsDir, 0o700)
    fs.writeFileSync(temporary, text, { mode: 0o600 })
    wrote = true
    // The file is tightened while it still carries a temp name, so a failing
    // chmod leaves nothing behind: the rename is the last step, and a visible
    // export is always a complete, owner-only file.
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, file)
  } catch (error) {
    if (wrote || fs.existsSync(temporary)) {
      try { fs.unlinkSync(temporary) } catch { /* The temp file is already gone. */ }
    }
    if (error instanceof DecisionContractError) throw error
    throw new DecisionContractError('EXPORT_WRITE_FAILED', basename(exportsDir))
  }
  return { file, name, bytes, sha256: String(envelope?.integrity?.value ?? '') }
}

/**
 * A file name carries only the opaque workspace alias, the export timestamp and
 * a random suffix, so two concurrent exports can never overwrite each other.
 * @param {any} envelope
 */
export function exportFileName(envelope) {
  const alias = String(envelope?.scope?.workspaceAlias ?? 'workspace').replace(/[^A-Za-z0-9_-]/g, '-')
  const stamp = String(envelope?.exportedAt ?? '').replace(/[^0-9]/g, '') || '0'
  return `decision-export-${alias}-${stamp}-${randomUUID().slice(0, 8)}.json`
}

/**
 * Page through the root session's records and assemble each one through the
 * reviewed `record()` read model. Cases from another workspace never enter: the
 * root session is the read boundary, the workspace is the export boundary.
 * @param {any} query @param {string} rootSessionId @param {string} workspaceKey
 */
function collectCaseRecords(query, rootSessionId, workspaceKey) {
  const caseIds = []
  let cursor = { limit: EXPORT_RECORD_PAGE }
  for (;;) {
    const page = query.records({ sessionId: rootSessionId, cursor })
    for (const record of page.records) caseIds.push(record.caseId)
    if (!page.nextCursor) break
    cursor = { after: page.nextCursor, limit: EXPORT_RECORD_PAGE }
  }
  const entries = []
  for (const caseId of caseIds) {
    const record = query.record({ caseId, sessionId: rootSessionId })
    if (!record || record.case.workspaceKey !== workspaceKey) continue
    entries.push(record)
  }
  return entries
}

/**
 * Private LearningRun/MemorySnapshot rows of exactly one workspace namespace.
 * The public zone is never read here: its only exportable form is the published
 * principle text the caller passed in.
 * @param {any} learning @param {string} workspaceKey
 */
function collectPrivateLearning(learning, workspaceKey) {
  const namespace = memoryNamespace(PRIVATE_ZONE, workspaceKey)
  const agentIds = learning.listNamespaceAgentIds(namespace)
  return {
    runs: agentIds.flatMap(agentId => learning.listRuns(agentId, namespace)),
    snapshots: agentIds.flatMap(agentId => learning.listSnapshots(agentId, namespace)),
  }
}

/** Agent fields a user may already see; internal revisions and revision rows stay home. */
function userVisibleAgent(profile) {
  return {
    agentId: profile.agentId,
    name: profile.name,
    state: profile.state,
    userDescription: profile.userDescription,
    scope: profile.scope,
    modelRoute: profile.modelRoute,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

/**
 * Deep redaction of one assembled envelope: the caller's workspace key becomes
 * its opaque alias, every other absolute path shape becomes `<path>`, and no
 * field named `workspaceKey`/`namespaceWorkspaceKey` survives at all.
 * @param {unknown} value @param {string} workspaceKey @param {string} alias
 */
function sanitize(value, workspaceKey, alias) {
  if (typeof value === 'string') {
    const substituted = workspaceKey ? value.split(workspaceKey).join(alias) : value
    return redactPublicText(substituted)
  }
  if (Array.isArray(value)) return value.map(entry => sanitize(entry, workspaceKey, alias))
  if (!value || typeof value !== 'object') return value
  /** @type {Record<string, unknown>} */
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'workspaceKey' || key === 'namespaceWorkspaceKey') continue
    if (entry === undefined) continue
    if (key === 'sourceWorkspaces' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      result[key] = Object.fromEntries(Object.entries(entry).map(([sourceId, workspace]) => [
        sourceId, typeof workspace === 'string' && workspace === workspaceKey ? alias : OTHER_WORKSPACE,
      ]))
      continue
    }
    result[key] = sanitize(entry, workspaceKey, alias)
  }
  return result
}

/** Counts are of the redacted envelope, so a reader can verify them from the file. */
function countEntries(envelope) {
  const cases = Array.isArray(envelope?.cases) ? envelope.cases : []
  const runs = Array.isArray(envelope?.learning?.runs) ? envelope.learning.runs : []
  const snapshots = Array.isArray(envelope?.learning?.snapshots) ? envelope.learning.snapshots : []
  const principles = Array.isArray(envelope?.public?.principles) ? envelope.public.principles : []
  return {
    agents: Array.isArray(envelope?.agents) ? envelope.agents.length : 0,
    cases: cases.length,
    attempts: cases.reduce((sum, entry) => sum + (Array.isArray(entry?.attempts) ? entry.attempts.length : 0), 0),
    evidence: cases.reduce((sum, entry) => sum + (Array.isArray(entry?.attempts)
      ? entry.attempts.reduce((inner, attempt) => inner + (Array.isArray(attempt?.evidence) ? attempt.evidence.length : 0), 0) : 0), 0),
    feedback: cases.reduce((sum, entry) => sum + (Array.isArray(entry?.feedback) ? entry.feedback.length : 0), 0),
    routeDecisions: cases.reduce((sum, entry) => sum + (Array.isArray(entry?.routeDecisions) ? entry.routeDecisions.length : 0), 0),
    learningRuns: runs.length,
    memorySnapshots: snapshots.length,
    publishedPrinciples: principles.length,
  }
}

/** @param {unknown[]} values @returns {string[]} */
function sortedUnique(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))].sort()
}
