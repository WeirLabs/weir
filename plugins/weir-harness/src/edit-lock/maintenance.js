// Settings-plane maintenance remains reachable while enforcement is disabled.
// Inspection is read-only; explicit offline ADMIN OVERRIDE uses its own durable
// ledger and publisher reservation. No model tools or automatic repair.
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { AUTHORITY_DIR } from './domains.js'
import { reservationPathFor } from './reservation.js'
import { parseSnapshot } from './snapshot.js'
import { maintenanceState, summarizeAuthorityImage } from './inspect.js'
import { readSnapshotBytes, checkedPath, verifyPins, missing, errorMessage, MAX_SNAPSHOT_BYTES } from './read-authority.js'
import { recoverAuthority } from './admin-recovery.js'
import { createAudit, AUDIT_TYPES } from '../shared/audit.js'

const STATUS_PATH = '/api/weir-edit-lock/maintenance/status'
const INSPECT_PATH = '/api/weir-edit-lock/maintenance/inspect'

/** @param {unknown} payload @param {number} [status] */
function reply(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}
/** @param {string} message @param {number} [status] @param {string} [code] */
function failure(message, status = 400, code) {
  return reply({ ok: false, error: { code: code ?? `weir-edit-lock/${status === 400 ? 'invalid' : 'internal'}`, message } }, status)
}

/**
 * Host-lifetime mount evidence exposed by the settings row. Each preset mount
 * owns one generation and reports installation, domain opens and failures.
 * Reporting only: nothing here gates authority, admission, tools or settings.
 * No generations, mixed decisions or incomplete lifecycles mean 'unknown'.
 */
export function createEditLockEvidence() {
  const mounts = new Map()
  let next = 0
  return {
    // Each handle owns exactly one generation. Late callbacks cannot resurrect it.
    recordMount(info) {
      const id = ++next
      const row = { id, enabled: info.enabled === true, pinned: info.pinned === true,
        fixed: info.fixed === true, phase: info.phase ?? 'installed', at: Date.now(),
        domains: new Map(), failures: new Map(), error: /** @type {string | null} */ (null) }
      mounts.set(id, row)
      return {
        installed() { if (mounts.has(id) && row.phase === 'installing') row.phase = 'installed' },
        disposing() { if (mounts.has(id)) row.phase = 'disposing' },
        failed(error) { if (mounts.has(id)) { row.phase = 'failed'; row.error = String(error) } },
        dispose() { mounts.delete(id) },
        recordDomain(root, info) {
          if (mounts.has(id) && row.phase !== 'disposing') row.domains.set(root, { root, mode: info.mode ?? null, error: info.error ?? null, mountId: id })
        },
        recordSessionFailure(sessionId, reason) {
          if (!mounts.has(id) || row.phase === 'disposing') return
          if (row.failures.size >= 50) row.failures.delete(row.failures.keys().next().value)
          row.failures.set(sessionId, { sessionId, reason: String(reason), at: Date.now(), mountId: id })
        },
      }
    },
    snapshot() {
      const rows = [...mounts.values()]
      return {
        mounts: rows.map(({ domains, failures, ...row }) => ({ ...row })),
        domains: rows.flatMap(row => [...row.domains.values()]),
        sessionFailures: rows.flatMap(row => [...row.failures.values()]),
      }
    },
  }
}

// The bounded, pinned, identity-checked snapshot read is shared with the cold
// status view: read-authority.js. Only the inspection-specific facts stay here.
function domainFacts(root) {
  const authorityDir = join(root, AUTHORITY_DIR)
  try {
    const pins = checkedPath(authorityDir)
    if (!pins.at(-1).stat.isDirectory()) throw new Error('authority is not a directory')
    let reservation = false
    try {
      const stat = lstatSync(reservationPathFor(authorityDir))
      reservation = !stat.isSymbolicLink() && stat.isDirectory()
    } catch (error) { if (!missing(error)) throw error }
    verifyPins(pins)
    return { root, authorityDir, hasAuthority: true, reservation, error: null }
  } catch (error) {
    return { root, authorityDir, hasAuthority: missing(error) ? false : null, reservation: null,
      error: missing(error) ? null : errorMessage(error) }
  }
}

/**
 * The trusted domain-root set: only roots the SERVER derived (live sessions'
 * management roots + mount-evidence roots). The client may send a root back,
 * but it is accepted only when it canonically matches a derived entry — an
 * arbitrary client filesystem path is never read.
 * @param {() => string[]} candidateRoots @param {string[]} evidenceRoots
 * @returns {Set<string>}
 */
export function trustedRoots(candidateRoots, evidenceRoots) {
  const trusted = new Set()
  for (const root of [...candidateRoots(), ...evidenceRoots]) {
    if (typeof root !== 'string' || root.length === 0) continue
    try { trusted.add(realpathSync.native(root)) } catch { /* an unresolvable candidate is not trusted */ }
  }
  return trusted
}

/**
 * Read-only inspection of one trusted domain root's authority. Presence is a
 * fact pattern, never inferred: 'none' (no authority directory), 'empty'
 * (directory currently empty; history indeterminate), 'no-committed-snapshot' (contents
 * the store would refuse), 'not-a-file', 'valid', 'corrupt' (validation
 * refusal, message preserved), 'unreadable' (IO failure). The bytes are
 * validated in memory only — the file, the reservation and every history are
 * left byte-identical.
 * @param {string} root - canonical (realpath) trusted root
 */
export const MAX_INSPECTION_BYTES = MAX_SNAPSHOT_BYTES
export function inspectAuthority(root) {
  const facts = domainFacts(root)
  const { authorityDir, reservation } = facts
  const base = { root, authorityDir, reservation, endpoint: null }
  if (facts.error) return { ...base, presence: 'unreadable', message: facts.error }
  if (!facts.hasAuthority) return { ...base, presence: 'none' }
  const read = readSnapshotBytes(authorityDir)
  // The authority directory vanished between the facts and the read: the same
  // race the inline read reported as unreadable.
  if (read.presence === 'no-authority') return { ...base, presence: 'unreadable', message: 'authority path changed during inspection' }
  if (read.presence === 'no-snapshot') {
    try {
      const entries = readdirSync(authorityDir)
      return { ...base, presence: entries.length ? 'no-committed-snapshot' : 'empty' }
    } catch (error) {
      return { ...base, presence: 'unreadable', message: errorMessage(error) }
    }
  }
  if (read.presence === 'not-a-file') return { ...base, presence: 'not-a-file' }
  if (read.presence !== 'valid') return { ...base, presence: 'unreadable', message: read.message }
  try {
    return { ...base, presence: 'valid', snapshot: summarizeAuthorityImage(parseSnapshot(read.bytes, root)) }
  } catch (error) {
    return { ...base, presence: 'corrupt', message: errorMessage(error) }
  }
}

/**
 * The profile-wide switch status. `saved` comes from the live settings config;
 * `enabledAtMount` from mount evidence (undefined → the state is honestly
 * 'unknown', never inferred from the saved value). Restart semantics: a saved
 * value that differs from the mounted one is a pending request.
 * @param {{ savedEnabled: () => boolean, evidence: ReturnType<typeof createEditLockEvidence>, candidateRoots: () => string[] }} deps
 */
export function maintenanceStatus(deps) {
  const saved = deps.savedEnabled() === true
  const evidence = deps.evidence.snapshot()
  const installed = evidence.mounts.filter(row => row.phase === 'installed')
  const enabledAtMount = installed.length > 0 && installed.length === evidence.mounts.length
    && installed.every(row => row.enabled === installed[0].enabled) ? installed[0].enabled : undefined
  const state = maintenanceState({ saved, enabledAtMount })
  const evidenceRoots = evidence.domains.map(entry => entry.root)
  // Status lists every server-derived root: canonical candidates plus the
  // row-reported evidence roots. An evidence root that no longer resolves
  // (unmounted volume, deleted workspace) stays listed — it is still the
  // row's own report, and vanishing it would hide a blocked domain.
  const rootSet = trustedRoots(deps.candidateRoots, evidenceRoots)
  for (const root of evidenceRoots) if (typeof root === 'string' && root.length > 0) rootSet.add(root)
  const roots = [...rootSet].sort()
  const evidenceByRoot = new Map()
  for (const entry of evidence.domains) {
    try { evidenceByRoot.set(realpathSync.native(entry.root), entry) } catch { evidenceByRoot.set(entry.root, entry) }
  }
  const domains = roots.map(root => {
    const facts = domainFacts(root)
    const seen = evidenceByRoot.get(root)
    return { root, hasAuthority: facts.hasAuthority, reservation: facts.reservation, mode: seen?.mode ?? null, error: seen?.error ?? facts.error }
  })
  const blocked = [
    ...evidence.mounts.filter(row => row.phase !== 'installed').map(row => ({ kind: 'mount', mountId: row.id, reason: row.error ?? row.phase })),
    ...evidence.domains.filter(entry => entry.error).map(entry => ({ kind: 'domain', root: entry.root, reason: entry.error })),
    ...evidence.sessionFailures.map(row => ({ kind: 'session', sessionId: row.sessionId, reason: row.reason })),
  ]
  return {
    saved,
    mounted: enabledAtMount === undefined ? null : enabledAtMount,
    mounts: evidence.mounts,
    pinned: evidence.mounts.some(row => row.pinned),
    state,
    scope: 'profile',
    restartRequired: state === 'enable-requested' || state === 'disable-requested',
    blocked,
    domains,
  }
}

/**
 * @typedef {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: { json(): Promise<unknown> }) => Promise<Response> }} MaintenanceRoute
 * @typedef {{ fetch: { register(route: MaintenanceRoute): () => void } }} MaintenanceConnection
 * @typedef {{ connection?: MaintenanceConnection, get?: (name: 'connection') => MaintenanceConnection | undefined, emit?: (type: string, record: object) => unknown }} MaintenanceScope
 */
/**
 * Register inspection and explicit administrator recovery on the authenticated
 * settings-plane connection (S20). Handler errors become structured payloads;
 * recovery errors never expose filesystem paths or claim rollback.
 * @param {MaintenanceScope} scope @param {{ savedEnabled: () => boolean, evidence: ReturnType<typeof createEditLockEvidence>, candidateRoots: () => string[] }} deps
 * @returns {() => void} disposer
 */
export function registerEditLockMaintenanceEndpoints(scope, deps) {
  const connection = scope?.connection ?? scope?.get?.('connection')
  if (!connection?.fetch?.register) return () => {}
  const disposers = []
  disposers.push(connection.fetch.register({
    path: STATUS_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return reply({ ok: true, value: maintenanceStatus(deps) })
      } catch (error) {
        return failure(errorMessage(error), 500)
      }
    },
  }))
  disposers.push(connection.fetch.register({
    path: INSPECT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { body = null }
      const requested = body !== null && typeof body === 'object' && 'root' in body && typeof body.root === 'string' ? body.root : ''
      if (!requested) return failure('body needs { root } from the status domain list')
      try {
        const evidenceRoots = deps.evidence.snapshot().domains.map(entry => entry.root)
        // Exact membership BEFORE any operation on client data. No realpath oracle.
        if (!trustedRoots(deps.candidateRoots, evidenceRoots).has(requested)) {
          return failure('not an Edit Lock domain root this server derived', 403, 'weir-edit-lock/untrusted-root')
        }
        return reply({ ok: true, value: inspectAuthority(requested) })
      } catch (error) {
        return failure(errorMessage(error), 500)
      }
    },
  }))
  // Host Connection authenticates browser cookies and checks Host/Origin before
  // dispatching exact /api routes. Never register this through a raw web server.
  const audit = createAudit({ emit: (type, record) => scope.emit?.(type, record) })
  disposers.push(connection.fetch.register({
    path: '/api/weir-edit-lock/maintenance/recover',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      let body
      try { body = await request.json() } catch { return failure('Invalid recovery JSON') }
      const root = body !== null && typeof body === 'object' && 'root' in body && typeof body.root === 'string' ? body.root : ''
      try {
        const evidenceRoots = deps.evidence.snapshot().domains.map(row => row.root)
        if (!trustedRoots(deps.candidateRoots, evidenceRoots).has(root)) return failure('not an Edit Lock domain root this server derived', 403, 'weir-edit-lock/untrusted-root')
        const value = await recoverAuthority(body)
        audit(null, AUDIT_TYPES.editLockMaintenance, { kind: 'admin-override', recoveryId: value.record.recoveryId, revision: value.revision, idempotent: value.idempotent }, { root })
        return reply({ ok: true, value })
      } catch (error) {
        // Do not return raw filesystem paths, credentials, causes or old content.
        const e = /** @type {{code?: string, commitStatus?: string}} */ (error)
        const code = e.code?.startsWith('weir-edit-lock/') ? e.code : 'weir-edit-lock/recovery-refused'
        return reply({ ok: false, error: { code, message: 'Recovery not acknowledged. Inspect authority and retry the same recovery ID after resolving the cause.', commitStatus: e.commitStatus ?? 'not-acknowledged' } }, 409)
      }
    },
  }))
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) dispose?.()
  }
}

/**
 * Wire the maintenance endpoints from the profile-level settings row (the row
 * cannot add package subpaths, S19). Service resolution goes through
 * ctx.inject (S20); nothing registers when the connection service is absent.
 * @param {any} ctx @param {{ savedEnabled: () => boolean, evidence: ReturnType<typeof createEditLockEvidence>, candidateRoots: () => string[] }} deps
 * @returns {() => void} idempotent disposer
 */
export function wireEditLockMaintenance(ctx, deps) {
  let closed = false
  let off = () => {}
  const injection = ctx.inject?.(['connection'], (/** @type {any} */ scope) => {
    if (closed) return () => {}
    off()
    off = registerEditLockMaintenanceEndpoints(scope, deps)
    return off
  })
  return () => {
    if (closed) return
    closed = true
    off()
    if (typeof injection === 'function') injection()
    else injection?.dispose?.()
  }
}
