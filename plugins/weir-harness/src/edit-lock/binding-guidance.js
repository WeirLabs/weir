/** Publisher facts only. No missing evidence implies a second window.
 * @param {string} sessionId @param {number | undefined} pid
 * @param {string} attestation */
export function bindingGuidance(sessionId, pid, attestation) {
  let holder
  if (attestation === 'serving') {
    holder = `session ${sessionId} is already active in the DeepSeek Harness window that publishes this project. Use the session in that window, close it there, or quit that Harness process.`
  } else if (pid === process.pid) {
    holder = `session ${sessionId} has a binding in this same process (pid ${pid}) that cannot be safely reclaimed. A stale runtime incarnation may still hold its channel. Restart DeepSeek Harness to recover.`
  } else if (pid !== undefined) {
    holder = `session ${sessionId} has a binding held by process pid ${pid}. Quit that holder process, or restart DeepSeek Harness to recover.`
  } else {
    holder = `session ${sessionId} has a binding whose holder cannot be attested. Restart DeepSeek Harness to recover.`
  }
  return `${holder} Do NOT remove the publisher reservation (.weir/.edit-lock.publisher-reservation) while its process is alive — removing it would split the edit authority.`
}
