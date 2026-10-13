/** Publisher-only classification; pid is compared with the publisher, never the client.
 * @param {number | undefined} pid @param {string} attestation */
export function bindingRefusalReason(pid, attestation) {
  const holder = attestation === 'serving' ? 'serving'
    : attestation === 'serving-idle' ? 'serving-idle'
    : pid === process.pid ? 'same-process-unattestable'
      : pid !== undefined ? 'cross-process-pid' : 'unknown'
  return `session already bound: holder=${holder}${pid !== undefined ? `; pid=${pid}` : ''}`
}

/** Render only publisher-classified facts. Unrecognized/legacy reasons are unknown.
 * @param {string} sessionId @param {string} reason */
export function bindingGuidance(sessionId, reason) {
  const facts = /^session already bound: holder=(serving-idle|serving|same-process-unattestable|cross-process-pid|unknown)(?:; pid=([1-9]\d*))?$/.exec(reason)
  const classification = facts?.[1]
  const pid = facts?.[2]
  let holder
  if (classification === 'serving-idle') {
    // Transferable (change edit-lock-binding-transfer): an idle same-process
    // holder is taken over by the next driving ingress — calm copy, no pid,
    // no window hunt, and NEVER the publisher-reservation warning.
    holder = `session ${sessionId} is held by an inactive attachment of this same session. Editing attaches here automatically when you next send a message; /edit-lock retry also takes it over now. Retry does not Continue editing.`
  } else if (classification === 'serving') {
    // The holder is provably live and not transferable (mid-turn or a live
    // channel proxy): name what is happening and when to retry. No window
    // hunt (single-instance hosts exist) and no process management.
    holder = `session ${sessionId} is being edited in another attachment right now. Wait for that turn to finish, then use /edit-lock retry in this session; retry does not Continue editing.`
  } else if (classification === 'same-process-unattestable' && pid !== undefined) {
    holder = `session ${sessionId} has a binding in this same process (pid ${pid}) that cannot be safely reclaimed. A stale runtime incarnation may still hold its channel. Wait for the original holder to disconnect or for confirmed process shutdown.`
  } else if (classification === 'cross-process-pid' && pid !== undefined) {
    holder = `session ${sessionId} has a binding held by process pid ${pid}. Quit that holder process or disconnect the original holder, and wait for confirmation.`
  } else {
    holder = `session ${sessionId} has a binding whose holder cannot be attested. Wait for the original holder to disconnect or for confirmed process shutdown.`
  }
  if (classification === 'serving-idle' || classification === 'serving') return holder
  return `${holder} Then use /edit-lock retry in the original session when available; retry does not Continue editing. Do NOT remove the publisher reservation (.weir/.edit-lock.publisher-reservation) while its process is alive — removing it would split the edit authority.`
}

/** Structured publisher fact; never classify a retry from prose.
 * @param {number | undefined} pid @param {string} attestation
 * @param {boolean} [revocationFailed] */
export function bindingFailure(pid, attestation, revocationFailed = false) {
  return { code: 'binding-duplicate', retryable: true,
    holderKind: revocationFailed ? 'revocation-failed' : attestation === 'serving' ? 'serving'
      : attestation === 'serving-idle' ? 'transferable'
        : pid !== undefined && pid !== process.pid ? 'cross-process' : 'unknown',
    holderPid: pid ?? null }
}
/** @param {number | undefined} pid @param {string} attestation @param {boolean} [revocationFailed] */
export function bindingRefusal(pid, attestation, revocationFailed = false) {
  const reason = bindingRefusalReason(pid, attestation)
  return Object.assign(new Error(revocationFailed ? `${reason}; durable revocation was not acknowledged. Inspect authority; no replacement was admitted.` : reason),
    { bindingFailure: bindingFailure(pid, attestation, revocationFailed) })
}
