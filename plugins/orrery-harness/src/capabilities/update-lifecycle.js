// Tasks 11.3/11.4/11.5 of the session-capability-manager change: the check
// cadence, the verified manual update, and the opt-in automatic update.
//
// 11.3 — checks are read-only: a 24h cadence with a single make-up check for
// an overdue startup, a manual "Check now" that either triggers immediately
// or joins the one in-flight check (at most one at any time), and a failure
// backoff of 48h / 96h capped at 7d. offline / unknown / private-source are
// reported separately from up-to-date. A check NEVER runs check/update/
// upgrade against a real install directory.
//
// 11.4 — a manual update runs only after explicit user confirmation (source
// and ref named), then verifies BEFORE the atomic swap: requested
// source/ref satisfied, expected identity at the expected location, content
// identity recorded, lock schema recognized. A tool reporting success while
// the post-conditions fail is recorded as a failure — nothing publishes and
// last-good stays.
//
// 11.5 — automatic updates are OFF by default. opt-in is an explicit grant
// per source/scope, never implied by a preset load, a check or one manual
// update. Before running: tool baseline, target layout, lock schema,
// provenance unchanged, no local edits — any failure pauses THAT entry with
// a report and no retry loop. A running session never auto-adopts published
// content.

export const CHECK_CADENCE_MS = 86_400_000
export const CHECK_BACKOFF_MS = Object.freeze([172_800_000, 345_600_000, 604_800_000])

/**
 * The check scheduler (11.3): at most one check in flight; manual joins the
 * in-flight one; overdue startup makes up exactly once; failures back off.
 */
export function createCheckScheduler({ now = Date.now } = {}) {
  let inFlight = false
  let lastCheckAt = null
  let failures = 0
  return {
    /** When the next scheduled check may run. */
    nextAt() {
      // No completed check yet: overdue since epoch, made up exactly once.
      if (lastCheckAt === null) return 0
      const interval = failures === 0 ? CHECK_CADENCE_MS : CHECK_BACKOFF_MS[Math.min(failures - 1, CHECK_BACKOFF_MS.length - 1)]
      return lastCheckAt + interval
    },
    /**
     * Whether a check should start; when one starts the caller must settle it.
     * @param {'scheduled'|'manual'} reason
     * @returns {{ start: boolean, joinedInFlight: boolean, reason: string|null }}
     */
    requestCheck(reason) {
      if (inFlight) return { start: false, joinedInFlight: true, reason: null }
      if (reason === 'scheduled' && now() < this.nextAt()) return { start: false, joinedInFlight: false, reason: 'not-due' }
      inFlight = true
      return { start: true, joinedInFlight: false, reason: null }
    },
    settle(ok) {
      inFlight = false
      failures = ok ? 0 : failures + 1
      lastCheckAt = now()
    },
    get inFlight() { return inFlight },
  }
}

/**
 * The classified check outcome (11.3): offline / unknown / private-source
 * are reported separately from up-to-date and from real changes.
 * @param {'up-to-date'|'changed'|'offline'|'unknown'|'private-source'} outcome
 */
export function checkOutcomeOf(outcome) {
  const known = ['up-to-date', 'changed', 'offline', 'unknown', 'private-source']
  return known.includes(outcome) ? outcome : 'unknown'
}

/**
 * The manual-update post-conditions (11.4): every one must hold before the
 * atomic swap; any failure records a failure and publishes nothing.
 * @param {{ requestedSatisfied: boolean, identityAtLocation: boolean, contentIdentityRecorded: boolean, lockRecognized: boolean }} input
 */
export function manualUpdatePostconditions(input) {
  const failures = []
  if (!input.requestedSatisfied) failures.push('requested source/ref not satisfied by staging')
  if (!input.identityAtLocation) failures.push('expected identity not at the expected location')
  if (!input.contentIdentityRecorded) failures.push('content identity was not recorded')
  if (!input.lockRecognized) failures.push('install-lock schema not recognized')
  return failures.length === 0 ? { ok: true } : { ok: false, failures }
}

/**
 * The automatic-update gates (11.5): opt-in is a per source/scope grant and
 * every precondition must hold; any failure pauses the entry (no retry loop).
 * @param {{ optedIn: boolean, toolBaselineOk: boolean, layoutOk: boolean, lockRecognized: boolean, provenanceUnchanged: boolean, noLocalEdits: boolean }} input
 */
export function autoUpdateVerdict(input) {
  if (!input.optedIn) return { run: false, reason: 'automatic updates are off for this source/scope (no explicit opt-in)' }
  const gates = [
    ['toolBaselineOk', input.toolBaselineOk, 'executor baseline check failed'],
    ['layoutOk', input.layoutOk, 'target layout check failed'],
    ['lockRecognized', input.lockRecognized, 'install-lock schema not recognized'],
    ['provenanceUnchanged', input.provenanceUnchanged, 'provenance changed'],
    ['noLocalEdits', input.noLocalEdits, 'local edits present'],
  ]
  for (const [, ok, reason] of gates) {
    if (!ok) return { run: false, reason: `${reason} — this entry is paused and reported, no retry loop` }
  }
  return { run: true }
}
