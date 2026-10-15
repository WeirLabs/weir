/** Publisher-only classification; pid is compared with the publisher, never the client.
 * @param {number | undefined} pid @param {string} attestation */
export function bindingRefusalReason(pid, attestation) {
  const holder = attestation === 'serving' ? 'serving'
    : attestation === 'serving-idle' ? 'serving-idle'
    : pid === process.pid ? 'same-process-unattestable'
      : pid !== undefined ? 'cross-process-pid' : 'unknown'
  return `session already bound: holder=${holder}${pid !== undefined ? `; pid=${pid}` : ''}`
}

/** The wire/minted holder classes. */
const HOLDER_KINDS = Object.freeze(['revocation-failed', 'serving', 'transferable', 'cross-process', 'unknown'])

/** Validate a structured binding refusal — exactly the minted four-field
 * shape crosses the wire or reaches a classifier; anything else degrades to
 * the text channel (display only, never a decision input).
 * @param {unknown} value @returns {{code: 'binding-duplicate', retryable: true, holderKind: string, holderPid: number | null} | undefined} */
export function asBindingFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (Object.keys(value).sort().join(',') !== 'code,holderKind,holderPid,retryable') return undefined
  const { code, retryable, holderKind, holderPid } = /** @type {any} */ (value)
  if (code !== 'binding-duplicate' || retryable !== true || !HOLDER_KINDS.includes(holderKind)) return undefined
  if (holderPid !== null && !(Number.isSafeInteger(holderPid) && holderPid > 0)) return undefined
  return { code, retryable, holderKind, holderPid }
}

/** Render only publisher-classified facts — the STRUCTURED bindingFailure,
 * never a re-parse of the display text (spec: presentation must not infer
 * state by matching human-readable text; change edit-lock-deepening D2).
 * Unrecognized or missing structure renders as unknown.
 * @param {string} sessionId @param {any} failure */
export function bindingGuidance(sessionId, failure) {
  const classification = failure?.code === 'binding-duplicate' ? failure?.holderKind : undefined
  const pid = typeof failure?.holderPid === 'number' ? failure.holderPid : undefined
  let holder
  if (classification === 'transferable') {
    // Transferable (change edit-lock-binding-transfer): an idle same-process
    // holder is taken over by the next driving ingress — calm copy, no pid,
    // no window hunt, and NEVER the publisher-reservation warning.
    holder = `session ${sessionId} is held by an inactive attachment of this same session. Editing attaches here automatically when you next send a message; /edit-lock retry also takes it over now. Retry does not Continue editing.`
  } else if (classification === 'serving') {
    // The holder is provably live and not transferable (mid-turn or a live
    // channel proxy): name what is happening and when to retry. No window
    // hunt (single-instance hosts exist) and no process management.
    holder = `session ${sessionId} is being edited in another attachment right now. Wait for that turn to finish, then use /edit-lock retry in this session; retry does not Continue editing.`
  } else if (classification === 'unknown' && pid !== undefined) {
    holder = `session ${sessionId} has a binding in this same process (pid ${pid}) that cannot be safely reclaimed. A stale runtime incarnation may still hold its channel. Wait for the original holder to disconnect or for confirmed process shutdown.`
  } else if (classification === 'cross-process' && pid !== undefined) {
    holder = `session ${sessionId} has a binding held by process pid ${pid}. Quit that holder process or disconnect the original holder, and wait for confirmation.`
  } else {
    holder = `session ${sessionId} has a binding whose holder cannot be attested. Wait for the original holder to disconnect or for confirmed process shutdown.`
  }
  if (classification === 'transferable' || classification === 'serving') return holder
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
