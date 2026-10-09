/** Same-bundle-instance bridge. Tokens identify channel runtime objects, never
 * confer authority. An absent registration is UNKNOWN, not evidence of death. */
/** @type {Map<string, {agent: object, sessionId: string}>} */
const registrations = new Map()

/** @param {string} nonce @param {object} agent @param {string} sessionId */
export function registerBindingRuntime(nonce, agent, sessionId) {
  if (registrations.has(nonce)) throw new Error('duplicate binding nonce')
  const entry = Object.freeze({ agent, sessionId })
  registrations.set(nonce, entry)
  return () => { if (registrations.get(nonce) === entry) registrations.delete(nonce) }
}

/** @param {string} nonce */
export function bindingRuntime(nonce) { return registrations.get(nonce) }

/** Undefined is a verified absence ONLY after a successful registry lookup.
 * Missing services and lookup failures must throw (and become unknown).
 * @param {(sessionId: string) => object | undefined} servingRuntime */
export function createBindingAttester(servingRuntime) {
  /** @param {string} sessionId @param {string} nonce
   * @returns {'serving'|'stale'|'unknown'} */
  return (sessionId, nonce) => {
    const holder = bindingRuntime(nonce)
    if (!holder || holder.sessionId !== sessionId) return 'unknown'
    try { return servingRuntime(sessionId) === holder.agent ? 'serving' : 'stale' }
    catch { return 'unknown' }
  }
}
