// Edit Lock maintenance plane: profile-wide switch status and read-only
// authority inspection, served from the SETTINGS row (wired like
// src/lsp/admin.js, S19/S20) so the controls stay reachable when the edit-lock
// manager is disabled, unavailable or poisoned. This module never opens a
// runtime, never takes a reservation, registers no tools, and writes nothing:
// the only mutation in the whole feature is the ordinary settings save of
// `editLockEnabled` (existing persistence, applies after restart). Inspection
// reads the committed snapshot bytes and validates them with the exact checks
// a real recover runs (./snapshot.js); corruption is reported, never repaired.
import { lstatSync, readdirSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs'
import { join, resolve, parse, relative, sep } from 'node:path'
import { AUTHORITY_DIR } from './domains.js'
import { reservationPathFor } from './reservation.js'
import { parseSnapshot } from './snapshot.js'
import { maintenanceState, summarizeAuthorityImage } from './inspect.js'

const STATUS_PATH = '/api/orrery-edit-lock/maintenance/status'
const INSPECT_PATH = '/api/orrery-edit-lock/maintenance/inspect'

/** @param {unknown} payload @param {number} [status] */
function reply(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}
/** @param {string} message @param {number} [status] @param {string} [code] */
function failure(message, status = 400, code) {
  return reply({ ok: false, error: { code: code ?? `orrery-edit-lock/${status === 400 ? 'invalid' : 'internal'}`, message } }, status)
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

// Pin every component, including the trusted root's ancestors. Node exposes no
// portable openat: compare identities before/after opening and before/after read.
// NOFOLLOW protects the leaf; NONBLOCK prevents swapped FIFO/device hangs.
// These checks fail closed on observed races, not an atomic hostile-rename proof.
function checkedPath(path) {
  const absolute = resolve(path)
  let current = parse(absolute).root
  const pins = []
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('symlink authority component refused')
    pins.push({ path: current, stat })
  }
  return pins
}
function sameNode(a, b) { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode }
function verifyPins(pins) {
  for (const pin of pins) if (!sameNode(pin.stat, lstatSync(pin.path))) throw new Error('authority path changed during inspection')
}
/** @param {unknown} error */
function missing(error) { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }
/** @param {unknown} error */
function errorMessage(error) { return error instanceof Error ? error.message : String(error) }
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
export const MAX_INSPECTION_BYTES = 16 * 1024 * 1024
export function inspectAuthority(root) {
  const facts = domainFacts(root)
  const { authorityDir, reservation } = facts
  const base = { root, authorityDir, reservation, endpoint: null }
  if (facts.error) return { ...base, presence: 'unreadable', message: facts.error }
  if (!facts.hasAuthority) return { ...base, presence: 'none' }
  let fd
  let bytes
  try {
    const parents = checkedPath(authorityDir)
    const path = join(authorityDir, 'snapshot.json')
    let leaf
    try { leaf = lstatSync(path) } catch (error) { if (!missing(error)) throw error }
    if (!leaf) {
      const entries = readdirSync(authorityDir)
      verifyPins(parents)
      return { ...base, presence: entries.length ? 'no-committed-snapshot' : 'empty' }
    }
    if (!leaf.isFile() || leaf.isSymbolicLink()) return { ...base, presence: 'not-a-file' }
    if (!constants.O_NOFOLLOW) throw new Error('safe inspection unsupported on this platform')
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (!opened.isFile() || !sameNode(leaf, opened)) throw new Error('opened snapshot identity changed')
    verifyPins(parents)
    if (!sameNode(opened, lstatSync(path))) throw new Error('snapshot replaced before read')
    if (opened.size > MAX_INSPECTION_BYTES) throw new Error('snapshot exceeds inspection byte limit')
    const buffer = Buffer.alloc(Math.min(opened.size + 1, MAX_INSPECTION_BYTES + 1))
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    verifyPins(parents)
    if (!sameNode(opened, lstatSync(path)) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || length !== opened.size) {
      throw new Error('snapshot changed during bounded read')
    }
    bytes = buffer.subarray(0, length)
  } catch (error) {
    return { ...base, presence: 'unreadable', message: errorMessage(error) }
  } finally { if (fd !== undefined) closeSync(fd) }
  try {
    return { ...base, presence: 'valid', snapshot: summarizeAuthorityImage(parseSnapshot(bytes, root)) }
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
 * @typedef {{ connection?: MaintenanceConnection, get?: (name: 'connection') => MaintenanceConnection | undefined }} MaintenanceScope
 */
/**
 * Register the read-only maintenance endpoints on an injected scope carrying
 * `connection` (S20). Both handlers are total: a status or inspection error
 * becomes a structured payload, never an exception into the settings row.
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
          return failure('not an Edit Lock domain root this server derived', 403, 'orrery-edit-lock/untrusted-root')
        }
        return reply({ ok: true, value: inspectAuthority(requested) })
      } catch (error) {
        return failure(errorMessage(error), 500)
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
