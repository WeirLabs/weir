// Failure classification for the selection status face (task 5.3). Every
// failure the capability menu can surface carries a stable machine `reason`
// and an actionable English `hint`. On any failure the menu stays EMPTY —
// it never falls back to a guessed non-empty list (G2c fail-closed rule).
//
// The writer-held marker is matched as a bare `writer-held` substring (the
// host RemoteError code's suffix) so this file carries NO session-event-type
// literal — the capabilities static red line bans those outright.

const message = input => input instanceof Error ? input.message : typeof input === 'string' ? input : String(input?.message ?? input ?? '')
const code = input => typeof input?.code === 'string' ? input.code : typeof input?.reason === 'string' ? input.reason : ''

/**
 * Classify a selection/availability failure into { reason, hint }.
 * Unknown failures classify as 'selection-unavailable' — still fail closed.
 * @param {unknown} input - Error, { code, message } or plain message string
 * @returns {{ reason: string, hint: string }}
 */
export function classifySelectionFailure(input) {
  const text = message(input)
  const marker = code(input)
  if (marker.includes('writer-held') || text.includes('writer-held') || text.includes('SessionAlreadyOwned')) {
    return {
      reason: 'session-writer-held',
      hint: 'Another process holds this session log. Close the session in that process (or continue it there), then resume it here.',
    }
  }
  if (text.includes('Inherited skill snapshot is')) {
    return {
      reason: 'inherited-snapshot-unavailable',
      hint: 'This session has no readable inherited skill snapshot — the typical shape of a host-resumed or forked session. Open the Capabilities panel, select the skills this session needs, and Apply: the accepted selection frees the session from the inheritance dependency. A genuine subagent is instead respawned from its parent session, so the snapshot is recaptured at creation.',
    }
  }
  if (text.includes('Workspace default selection is')) {
    return {
      reason: 'workspace-default-unavailable',
      hint: 'The saved workspace default selection cannot be used. Inspect or clear it in the Weir capabilities store; the session stays empty rather than guessing.',
    }
  }
  if (text.includes('policy is unreadable')) {
    return {
      reason: 'policy-unreadable:unreadable',
      hint: 'The persisted selection record exists but cannot be read (permissions or a filesystem error). Restore read access to the Weir capabilities store, then retry.',
    }
  }
  if (text.includes('policy is corrupt')) {
    return {
      reason: 'policy-unreadable:corrupt',
      hint: 'The persisted selection record failed its integrity check. Inspect the Weir capabilities store and repair or remove the record manually, then retry.',
    }
  }
  if (text.includes('policy is torn')) {
    return {
      reason: 'policy-unreadable:torn',
      hint: 'The persisted selection record is a leftover of an interrupted write. Inspect the Weir capabilities store and settle the record manually, then retry.',
    }
  }
  if (text.includes('policy is unknown-schema')) {
    return {
      reason: 'policy-unreadable:unknown-schema',
      hint: 'The selection record uses a schema this Weir version does not know. Use the version that wrote it, or migrate the record deliberately.',
    }
  }
  if (text.includes('policy is unsupported')) {
    return {
      reason: 'policy-unsupported',
      hint: 'Selections cannot persist on this platform or profile, so capability menus stay read-only and empty.',
    }
  }
  if (text.includes('session is unavailable')) {
    return {
      reason: 'session-unavailable',
      hint: 'No live agent is attached to this session. Resume the session, then retry.',
    }
  }
  return {
    reason: 'selection-unavailable',
    hint: 'The skill inventory or selection could not be read. The menu stays empty rather than guessing; retry once the cause is resolved.',
  }
}
