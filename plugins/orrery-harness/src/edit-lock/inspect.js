// Read-only maintenance inspection over a validated authority image, and the
// profile-wide switch-state decision. Pure: no IO, no clock, no ctx, and no
// cross-module type imports (jsconfig pure-module curation) — the caller
// supplies the parsed snapshot and the mount evidence. Nothing here opens a
// runtime, grants authority, or changes what admission would decide; an
// unresolved operation is reported, never settled.

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
      const disposition = state.adminRecoveries?.find(row => row.owner === op.sessionId && row.operations.some(item => item.operationId === op.operationId))
      return { ...unresolvedRow(op), admissionBlocked: !disposition, administrativeRecoveryId: disposition?.recoveryId ?? null }
    })
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
