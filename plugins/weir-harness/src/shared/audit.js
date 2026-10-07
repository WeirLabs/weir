// Shared cold-safe audit channel for weir plugins.
//
// HARD CONTRACT (DSH 0.1.7-rc.2): custom-typed session events break cold
// session reads — the persistence layer refuses logs containing types outside
// the build-time KNOWN set unless marked `ignorable`, and session.append
// offers no ignorable channel. So weir audit NEVER touches session.append:
// it emits a runtime cordis event (observable in-process) and mirrors a
// JSONL line to <session cwd>/.weir/audit.jsonl (best-effort durability).
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The single authoritative audit-type vocabulary (design D4). Emit sites
 * reference these constants instead of string literals; subscribers iterate
 * `Object.values(AUDIT_TYPES)` so a new type is picked up without edits.
 * Values are the event types WITHOUT the 'weir/' prefix.
 */
export const AUDIT_TYPES = Object.freeze({
  intentHit: 'intent-hit',
  intentClassify: 'intent-classify',
  continuationBlocked: 'continuation-blocked',
  continuationStop: 'continuation-stop',
  supervision: 'supervision',
  worktree: 'worktree',
  editLockMaintenance: 'edit-lock-maintenance',
  // Session capability manager (tasks 4.2+): one record per durable Apply
  // acceptance or receipt-query recovery; never commit evidence by itself.
  capabilityApply: 'capability-apply',
  // capability-manager-ux (D6): one record per confirmed v2 package import
  // (install outcome + collision decisions); never commit evidence by itself.
  capabilityPresetImport: 'capability-preset-import',
  // Session blackboard release facts (design D3): one record per key release
  // that had waiting subscribers; the emission lives in the blackboard plugin
  // and never touches a session log.
  blackboard: 'blackboard',
})
/**
 * Known dynamic sub-event kinds: `<type>/<kind>` events emitted beside a base
 * AUDIT_TYPES entry. cordis event dispatch is an exact-name lookup (no
 * prefix/wildcard subscription), so subscribers must enumerate sub-events
 * explicitly; this registry is the single source for that enumeration. Keys
 * are AUDIT_TYPES member names; values are the emitted kind suffixes.
 */
export const AUDIT_SUBTYPES = Object.freeze({
  supervision: Object.freeze(['spawn', 'seal', 'settle', 'group-settled', 'resume', 'terminate', 'group-released']),
  // Lane transitions (git-worktree-lanes): one kind per state-machine event
  // family, plus reconciliation reports.
  worktree: Object.freeze(['open', 'setup', 'bind', 'checked', 'check', 'invalidate', 'ask', 'decline', 'conflict', 'land', 'cleanup', 'abandon', 'reconcile', 'watch']),
  blackboard: Object.freeze(['released']),
})

/**
 * @param {{ emit: (type: string, record: object) => unknown }} ctx - plugin context
 * @returns {(session: { id?: string, header?: { cwd?: string } } | null, type: string, data?: unknown, options?: { root?: string }) => void} audit emitter bound to ctx
 */
export function createAudit(ctx) {
  /**
   * Emit one audit record. Never throws: audit is log-only and must never
   * break a turn.
   * @param {{ id?: string, header?: { cwd?: string } } | null} session - optional session
   * @param {string} type - event type WITHOUT the 'weir/' prefix
   * @param {unknown} [data] - JSON-serializable payload
   * @param {{ root?: string }} [options] - `root` anchors the JSONL mirror at a
   *   directory other than the session cwd (worktree lanes audit at the main
   *   repository root so one file holds every lane's history)
   */
  return function audit(session, type, data, options = {}) {
    const fullType = `weir/${type}`
    const record = {
      time: Date.now(),
      session: session?.id ?? null,
      type: fullType,
      data: jsonSafe(data),
    }
    try {
      ctx.emit(fullType, record)
    } catch {
      // in-process observation must never break a turn
    }
    try {
      const cwd = options.root ?? session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return
      const file = join(cwd, '.weir', 'audit.jsonl')
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(record)}\n`)
    } catch {
      // best-effort durability must never break a turn
    }
  }
}

function jsonSafe(value) {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}
