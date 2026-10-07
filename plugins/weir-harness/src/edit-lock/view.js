/** Structured status view for the Edit Lock panel (design D6).
 *
 * The panel derives colour and controls from THIS shape, never from the
 * human-readable command text, so wording can change without silently breaking
 * the panel. Pure: no IO, no clock (the caller supplies `now`), no ctx.
 *
 * The primary view speaks the user's language: what state the session is in,
 * which files it holds (short names), and the one thing to do next. Technical
 * identifiers (session id, execution epoch, generation, absolute paths) are kept
 * in `technical` and per-lock `detail`, for the expandable detail only.
 */
import { isAbsolute, relative, sep } from 'node:path'

/** Session states the panel renders, in precedence order. */
export const VIEW_STATES = Object.freeze(['revoked', 'unavailable', 'stopped', 'attention', 'confirm', 'holding', 'editing', 'idle'])

/** Short, stable name for a file: relative to the work directory when inside it.
 * @param {string} path @param {string | undefined} cwd */
export function shortName(path, cwd) {
  if (typeof cwd === 'string' && isAbsolute(path) && isAbsolute(cwd)) {
    const rel = relative(cwd, path)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  }
  return path
}

/** The single next action for one row, or null. Own active locks can be released
 * by the human; another session's lock only needs a human when that session can
 * no longer act on it (stopped or abnormal). An actively edited foreign file has
 * no action: the right move is to wait or let the assistant ask for it.
 * @param {any} lock @param {boolean} mine */
function rowAction(lock, mine) {
  if (mine) {
    if (lock.status === 'pending-confirmation') return 'confirm'
    return 'release'
  }
  if (lock.status === 'abnormal' || lock.status === 'user-interrupted') return 'unlock'
  return null
}

/**
 * @param {{
 *   status: { sessionId: string, state: string, interrupted: boolean|null, revoked?: boolean|null, executionEpoch: number|null, locks: any[], recovery?: any, retention?: any },
 *   locks: any[],
 *   cwd?: string,
 *   root?: string,
 *   mode?: string,
 *   now: number,
 * }} input
 */
export function buildView({ status, locks, cwd, root, mode, now }) {
  const own = status.locks ?? []
  const retention = status.retention ?? null
  const recovery = status.recovery ?? null
  const held = Boolean(retention?.held && retention.remainingMs > 0)
  /** @type {typeof VIEW_STATES[number]} */
  let state
  // Revoked wins over everything: administrative revocation is terminal and
  // no action (resume, confirm, release) can ever apply to this session again.
  if (status.revoked === true) state = 'revoked'
  else if (status.state === 'stopped' || status.state === 'resuming') state = 'stopped'
  else if (status.state === 'recovering' || own.some(lock => lock.status === 'abnormal')) state = 'attention'
  else if (own.some(lock => lock.status === 'pending-confirmation')) state = 'confirm'
  else if (held) state = 'holding'
  else if (own.length > 0) state = 'editing'
  else state = 'idle'

  const rows = (locks ?? []).map(lock => {
    const mine = lock.owner === status.sessionId
    return {
      name: shortName(lock.resourceId, cwd),
      mine,
      status: lock.status,
      reason: lock.reason ?? null,
      action: rowAction(lock, mine),
      detail: { path: lock.resourceId, owner: lock.owner, generation: lock.generation },
    }
  })
  // Own files first, then files that need a human, then everything else.
  const rank = (/** @type {any} */ row) => (row.mine ? 0 : row.action ? 1 : 2)
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

  return {
    state,
    files: rows,
    ownCount: own.length,
    pendingCount: own.filter(lock => lock.status === 'pending-confirmation').length,
    hold: held ? { until: retention.holdUntil, remainingMinutes: Math.ceil(retention.remainingMs / 60_000), usedMinutes: Math.round(retention.holdCumulativeMs / 60_000) } : null,
    recovery: recovery && (recovery.attempts || recovery.elapsedMs || recovery.pauseMs)
      ? { attempts: recovery.attempts, elapsedSeconds: Math.round(recovery.elapsedMs / 1000), pauseMinutes: Math.round(recovery.pauseMs / 60_000) }
      : null,
    technical: { sessionId: status.sessionId, executionEpoch: status.executionEpoch, root: root ?? null, mode: mode ?? null, at: now },
  }
}

/** View for a session the host cannot resolve right now. Without a reason it is
 * still starting; with one, registration failed and the reason is shown, because
 * a permanent "starting" hides a fail-closed workspace. Action-free either way.
 * @param {string | null} [reason] */
export function unavailableView(reason = null) {
  return { state: 'unavailable', reason: reason ?? null, files: [], ownCount: 0, pendingCount: 0, hold: null, recovery: null, technical: null }
}

/**
 * Cold-session view (design D2): map one validated authority image into the
 * same buildView input a live status read would produce, so a restored session
 * shows its TRUE recorded state — interrupted as stopped, an ADMIN OVERRIDE as
 * terminal revoked, its own locks and the domain's locks, retention settled
 * against the read instant — never a reasonless "starting". The `cold` marker
 * tells the panel to replace live-only actions with activation guidance, and
 * the auto-resume gate travels with the view so the guidance matches the
 * committed setting. Pure like buildView: no IO, no clock, no ctx — the caller
 * supplies the parsed image and `now`.
 * @param {{
 *   image: any,
 *   sessionId: string,
 *   cwd?: string,
 *   root?: string,
 *   autoResume?: boolean,
 *   now: number,
 * }} input
 */
export function buildColdView({ image, sessionId, cwd, root, autoResume = true, now }) {
  const sessions = Array.isArray(image?.sessions) ? image.sessions : []
  const locks = (Array.isArray(image?.locks) ? image.locks : []).filter(lock => lock !== null && typeof lock === 'object')
  const holds = Array.isArray(image?.holds) ? image.holds : []
  const recoveries = Array.isArray(image?.recovery) ? image.recovery : []
  const adminRecoveries = Array.isArray(image?.adminRecoveries) ? image.adminRecoveries : []
  const session = sessions.find(row => row?.sessionId === sessionId) ?? null
  // The manager derives the revoked flag from the administrative ledger at
  // status time (revokedOwner); the cold read applies the same rule to the image.
  const revoked = adminRecoveries.some(row => row?.owner === sessionId)
  // Read-time retention settlement, byte-equivalent to the kernel's settleHold:
  // a hold counts only while the session owns a lock, and the remaining budget
  // is computed against the read instant, so a missed expiry timer can never
  // leave stale ownership behind a status read.
  const held = holds.find(row => row?.sessionId === sessionId) ?? null
  const owns = locks.some(lock => lock.owner === sessionId)
  const remainingMs = held?.holdUntil == null ? 0 : Math.max(0, held.holdUntil - now)
  const holding = held?.holding === true && owns
  const retention = held ? { sessionId, held: holding, expired: holding && held.holdUntil !== null && remainingMs === 0,
    holdUntil: held.holdUntil, remainingMs, holdCumulativeMs: held.holdCumulativeMs } : null
  const status = {
    sessionId,
    // Interrupted records a stopped session (a restarted host interrupts every
    // known session durably). Otherwise the state derives from locks/retention.
    state: session?.interrupted === true ? 'stopped' : 'active',
    interrupted: session?.interrupted ?? null,
    revoked,
    executionEpoch: session?.executionEpoch ?? null,
    locks: locks.filter(lock => lock.owner === sessionId),
    recovery: recoveries.find(row => row?.sessionId === sessionId) ?? null,
    retention,
  }
  return { ...buildView({ status, locks, cwd, root, now }), cold: true, autoResume: autoResume !== false }
}
