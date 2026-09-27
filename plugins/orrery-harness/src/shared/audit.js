// Shared cold-safe audit channel for orrery plugins.
//
// HARD CONTRACT (DSH 0.1.7-rc.2): custom-typed session events break cold
// session reads — the persistence layer refuses logs containing types outside
// the build-time KNOWN set unless marked `ignorable`, and session.append
// offers no ignorable channel. So orrery audit NEVER touches session.append:
// it emits a runtime cordis event (observable in-process) and mirrors a
// JSONL line to <session cwd>/.orrery/audit.jsonl (best-effort durability).
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * @param {object} ctx - plugin context (used for ctx.emit)
 * @returns {(session: object, type: string, data?: unknown) => void} audit emitter bound to ctx
 */
export function createAudit(ctx) {
  /**
   * Emit one audit record. Never throws: audit is log-only and must never
   * break a turn.
   * @param {object} session - the session this record belongs to
   * @param {string} type - event type WITHOUT the 'orrery/' prefix
   * @param {unknown} [data] - JSON-serializable payload
   */
  return function audit(session, type, data) {
    const fullType = `orrery/${type}`
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
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return
      const file = join(cwd, '.orrery', 'audit.jsonl')
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
