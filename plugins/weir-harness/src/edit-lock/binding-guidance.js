/** Publisher-only classification; pid is compared with the publisher, never the client.
 * @param {number | undefined} pid @param {string} attestation */
export function bindingRefusalReason(pid, attestation) {
  const holder = attestation === 'serving' ? 'serving'
    : pid === process.pid ? 'same-process-unattestable'
      : pid !== undefined ? 'cross-process-pid' : 'unknown'
  return `session already bound: holder=${holder}${pid !== undefined ? `; pid=${pid}` : ''}`
}

/** Render only publisher-classified facts. Unrecognized/legacy reasons are unknown.
 * @param {string} sessionId @param {string} reason */
export function bindingGuidance(sessionId, reason) {
  const facts = /^session already bound: holder=(serving|same-process-unattestable|cross-process-pid|unknown)(?:; pid=([1-9]\d*))?$/.exec(reason)
  const classification = facts?.[1]
  const pid = facts?.[2]
  let holder
  if (classification === 'serving') {
    holder = `session ${sessionId} is already active in the DeepSeek Harness window that publishes this project. Use the session in that window, close it there, or quit that Harness process.`
  } else if (classification === 'same-process-unattestable' && pid !== undefined) {
    holder = `session ${sessionId} has a binding in this same process (pid ${pid}) that cannot be safely reclaimed. A stale runtime incarnation may still hold its channel. Restart DeepSeek Harness to recover.`
  } else if (classification === 'cross-process-pid' && pid !== undefined) {
    holder = `session ${sessionId} has a binding held by process pid ${pid}. Quit that holder process, or restart DeepSeek Harness to recover.`
  } else {
    holder = `session ${sessionId} has a binding whose holder cannot be attested. Restart DeepSeek Harness to recover.`
  }
  return `${holder} Do NOT remove the publisher reservation (.weir/.edit-lock.publisher-reservation) while its process is alive — removing it would split the edit authority.`
}
