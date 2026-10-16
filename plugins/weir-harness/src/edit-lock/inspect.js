// Read-only maintenance inspection over a validated authority image, and the
// profile-wide switch-state decision. Pure: no IO, no clock, no ctx, and no
// cross-module type imports (jsconfig pure-module curation) — the caller
// supplies the parsed snapshot and the mount evidence. Nothing here opens a
// runtime, grants authority, or changes what admission would decide; an
// unresolved operation is reported, never settled.
import { dispositionFor } from './derived-facts.js'
import { recoveryConfirmation } from './admin-recovery.js'
import { LATE_WRITER_RISK } from './admin-ledger.js'

/**
 * The switch state the maintenance panel renders. Detection is evidence-based:
 * 'unknown' whenever the mount evidence this decision needs is unavailable —
 * never a guess from the saved setting alone.
 * @typedef {'enforced'|'disable-requested'|'enable-requested'|'disabled'|'unknown'} MaintenanceState
 * @typedef {{ kind: 'file'|'subtree'|'domain'|'none', path: string|null }} FenceScope
 */

/** The scope one recorded fence covers, in user terms.
 * @param {any} fence @returns {FenceScope} */
export function fenceScope(fence) {
  if (!fence || typeof fence !== 'object') return { kind: 'none', path: null }
  if (fence.kind === 'resource') return { kind: 'file', path: typeof fence.resourceId === 'string' ? fence.resourceId : null }
  if (fence.kind === 'subtree') return { kind: 'subtree', path: typeof fence.ancestor === 'string' ? fence.ancestor : null }
  if (fence.kind === 'domain') return { kind: 'domain', path: null }
  return { kind: 'none', path: null }
}

/** One unresolved (publishing/unknown) operation's diagnostic row. The phase,
 * outcome and fence are historical facts; `closeouts` counts inert recorded
 * assertions (they discharge nothing). @param {any} op */
function unresolvedRow(op) {
  return {
    phase: op?.phase ?? null,
    outcome: op?.outcome?.kind ?? null,
    scope: fenceScope(op?.fence),
    fence: op?.fence ? structuredClone(op.fence) : null,
    target: { tool: op?.binding?.tool ?? null, filePath: op?.binding?.filePath ?? null },
    origin: { executionEpoch: op?.origin?.executionEpoch ?? null, managerIncarnation: op?.origin?.managerIncarnation ?? null },
    closeouts: Array.isArray(op?.closeouts) ? op.closeouts.length : 0,
    key: { sessionId: op?.sessionId ?? null, operationId: op?.operationId ?? null },
  }
}

/**
 * Summarize a validated snapshot for the maintenance inspector. The primary
 * facts are the unresolved operations and the scope each one fences off;
 * identifiers stay available because this is the administrator's surface.
 * Reading changes nothing: this is a pure projection of the parsed image.
 * @param {{ revision: number, state: any }} snapshot
 */
export function summarizeAuthorityImage(snapshot) {
  const state = snapshot.state
  const operations = Array.isArray(state?.operations) ? state.operations : []
  const unresolved = operations
    .filter(op => op?.phase === 'publishing' || op?.phase === 'unknown')
    .map(op => {
      const disposition = dispositionFor(state, op)
      return { ...unresolvedRow(op), admissionBlocked: !disposition, administrativeRecoveryId: disposition?.recoveryId ?? null }
    })
  // Prepared operations never fence anything, but the online administrative
  // recovery refuses an owner that still has one (manager requires every
  // unresolved operation to be unknown). The panel needs them visible to keep
  // impossible one-click actions off the screen. Read-only and additive.
  const prepared = operations
    .filter(op => op?.phase === 'prepared')
    .map(op => ({ target: { tool: op?.binding?.tool ?? null, filePath: op?.binding?.filePath ?? null }, key: { sessionId: op?.sessionId ?? null, operationId: op?.operationId ?? null } }))
  const retainedLocks = (Array.isArray(state?.locks) ? state.locks : [])
    .filter(lock => lock?.status !== 'active')
    .map(lock => ({ resourceId: lock.resourceId, owner: lock.owner, generation: lock.generation, status: lock.status, reason: lock.reason ?? null }))
  const recovery = Array.isArray(state?.recovery) ? state.recovery : []
  return {
    version: state?.version ?? null,
    revision: snapshot.revision,
    counts: {
      sessions: (Array.isArray(state?.sessions) ? state.sessions : []).length,
      locks: (Array.isArray(state?.locks) ? state.locks : []).length,
      operations: operations.length,
      unresolved: unresolved.length,
      retainedLocks: retainedLocks.length,
    },
    unresolved,
    prepared,
    adminRecoveries: structuredClone(state?.adminRecoveries ?? []),
    retainedLocks,
    sessions: (Array.isArray(state?.sessions) ? state.sessions : []).map(session => ({
      sessionId: session.sessionId,
      executionEpoch: session.executionEpoch,
      interrupted: session.interrupted,
      recovery: recovery.find(row => row?.sessionId === session?.sessionId) ?? null,
    })),
  }
}

/**
 * Server-computed online-recovery proposals over the SAME parsed image the
 * summary above projects (change edit-lock-recovery-proposals, D1/D2). The
 * client renders these verbatim and never re-derives eligibility or the
 * confirmation: eligibility uses the host's own disposition rule, and the
 * confirmation is produced by the very function the manager re-verifies at
 * commit time — the proposal is a read-time suggestion, never an
 * authorization. `unmet` entries carry stable reason CODES in the manager's
 * refusal order (disposition recorded → owner unknown → not interrupted →
 * prepared outstanding → publishing outstanding → no unresolved operations);
 * the prose is the client's localization job. Pure: reading changes nothing.
 * @param {string} root @param {{ revision: number, state: any }} snapshot
 */
export function recoveryProposals(root, snapshot) {
  const state = snapshot.state
  const revision = snapshot.revision
  const operations = Array.isArray(state?.operations) ? state.operations : []
  const sessionByOwner = new Map()
  const interruptedByOwner = new Map()
  for (const session of Array.isArray(state?.sessions) ? state.sessions : []) {
    if (typeof session?.sessionId !== 'string') continue
    sessionByOwner.set(session.sessionId, session)
    interruptedByOwner.set(session.sessionId, session.interrupted === true)
  }
  /** Unresolved (publishing/unknown) operations by owner, in image order. */
  const unresolvedByOwner = new Map()
  const preparedOwners = new Set()
  for (const op of operations) {
    if (typeof op?.sessionId !== 'string') continue
    if (op.phase === 'prepared') { preparedOwners.add(op.sessionId); continue }
    if (op.phase !== 'publishing' && op.phase !== 'unknown') continue
    const list = unresolvedByOwner.get(op.sessionId) ?? []
    list.push(op)
    unresolvedByOwner.set(op.sessionId, list)
  }
  // The panel's merged display rows: retained locks plus still-blocking file
  // fences (one row per resource); wide fences and cross-owner file fences
  // become named scope paths instead of rows.
  const rowsByResource = new Map()
  const scopePathsByOwner = new Map()
  const blockedOwners = new Set()
  /** @param {string} owner @param {unknown} path */
  const addScopePath = (owner, path) => {
    if (typeof path !== 'string') return
    const paths = scopePathsByOwner.get(owner) ?? []
    if (!paths.includes(path)) paths.push(path)
    scopePathsByOwner.set(owner, paths)
  }
  for (const lock of Array.isArray(state?.locks) ? state.locks : []) {
    if (lock?.status === 'active') continue
    if (typeof lock?.resourceId !== 'string' || typeof lock?.owner !== 'string') continue
    blockedOwners.add(lock.owner)
    const row = rowsByResource.get(lock.resourceId) ?? { resourceId: lock.resourceId, owner: lock.owner, lockStatus: null, fence: false, interrupted: interruptedByOwner.get(lock.owner) ?? false }
    row.lockStatus = row.lockStatus ?? (typeof lock.status === 'string' ? lock.status : null)
    rowsByResource.set(lock.resourceId, row)
  }
  for (const [owner, ops] of unresolvedByOwner) {
    for (const op of ops) {
      if (dispositionFor(state, op)) continue // disposed: no longer blocks admission
      blockedOwners.add(owner)
      const scope = fenceScope(op?.fence)
      if (scope.kind === 'file' && typeof scope.path === 'string') {
        const existing = rowsByResource.get(scope.path)
        if (existing) {
          // Same owner locks AND fences the file (the incident shape): one row.
          if (existing.owner === owner) existing.fence = true
          else addScopePath(owner, scope.path)
        } else {
          rowsByResource.set(scope.path, { resourceId: scope.path, owner, lockStatus: null, fence: true, interrupted: interruptedByOwner.get(owner) ?? false })
        }
      } else {
        addScopePath(owner, scope.path)
      }
    }
  }
  const rows = [...rowsByResource.values()]
  // Eligibility: an interrupted owner whose every unresolved operation is a
  // still-blocking unknown, with no prepared operation outstanding — exactly
  // the preconditions the manager re-verifies at the FIFO execution point.
  const eligible = []
  for (const [owner, ops] of unresolvedByOwner) {
    if (interruptedByOwner.get(owner) !== true) continue
    if (preparedOwners.has(owner)) continue
    if (!(ops.length > 0 && ops.every(op => op.phase === 'unknown' && !dispositionFor(state, op)))) continue
    eligible.push({ owner, ops })
  }
  const candidateOwners = new Set(eligible.map(entry => entry.owner))
  const blocked = rows.filter(row => candidateOwners.has(row.owner))
  blocked.sort((a, b) => a.resourceId.localeCompare(b.resourceId))
  const candidates = eligible.map(({ owner, ops }) => {
    const scope = { root, owner, expectedRevision: revision, operationIds: ops.map(op => op.operationId).sort() }
    return { owner, scope, confirmation: recoveryConfirmation(scope), risk: LATE_WRITER_RISK, rows: blocked.filter(row => row.owner === owner) }
  })
  const unmet = []
  for (const owner of [...blockedOwners].sort()) {
    if (candidateOwners.has(owner)) continue
    const ops = unresolvedByOwner.get(owner) ?? []
    const session = sessionByOwner.get(owner)
    const reason = ops.some(op => dispositionFor(state, op)) ? 'disposition-recorded'
      : !session ? 'owner-unknown'
      : session.interrupted !== true ? 'not-interrupted'
      : preparedOwners.has(owner) ? 'prepared-outstanding'
      : ops.some(op => op.phase === 'publishing') ? 'publishing-outstanding'
      : 'no-unresolved'
    unmet.push({ owner, reason, rows: rows.filter(row => row.owner === owner), scopePaths: scopePathsByOwner.get(owner) ?? [] })
  }
  return { schemaVersion: 1, revision, candidates, blocked, unmet }
}

/**
 * The profile-wide switch decision. `saved` is the value currently persisted
 * in settings; `enabledAtMount` is what the edit-lock row actually did when it
 * last mounted (undefined when no mount evidence exists in this process).
 * A change applies after restart, so a saved value different from the mounted
 * one is a pending request, never the current enforcement state.
 * @param {{ saved: boolean, enabledAtMount: boolean|undefined }} input
 * @returns {MaintenanceState}
 */
export function maintenanceState({ saved, enabledAtMount }) {
  if (enabledAtMount === undefined) return 'unknown'
  if (saved && enabledAtMount) return 'enforced'
  if (saved && !enabledAtMount) return 'enable-requested'
  if (!saved && enabledAtMount) return 'disable-requested'
  return 'disabled'
}
