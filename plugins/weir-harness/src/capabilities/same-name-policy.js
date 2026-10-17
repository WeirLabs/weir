// Task 10.3 of the session-capability-manager change: the "no silent
// overwrite" rule. Installing into an occupied name writes ONLY after an
// explicit replace / coexist-distinct / cancel decision.

/**
 * The install-into-occupied-name decision (10.3): the default is CANCEL —
 * nothing is written unless the caller explicitly chooses 'replace' (the
 * named entry is overwritten after confirmation) or 'coexist' (the install
 * must target a distinct name).
 * @param {{ name: string, occupied: boolean, decision?: 'replace'|'coexist'|'cancel', targetName?: string }} input
 * @returns {{ write: boolean, target: string|null, status: string }}
 */
export function installTargetFor({ name, occupied, decision = 'cancel', targetName }) {
  if (!occupied) return { write: true, target: name, status: 'write' }
  if (decision === 'replace') return { write: true, target: name, status: 'replace-confirmed' }
  if (decision === 'coexist') {
    if (typeof targetName !== 'string' || targetName.length === 0 || targetName === name) {
      return { write: false, target: null, status: 'coexist-needs-distinct-name' }
    }
    return { write: true, target: targetName, status: 'coexist-distinct' }
  }
  return { write: false, target: null, status: 'cancelled' }
}
