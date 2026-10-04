// Skill-side session-level admission of the session capability manager
// (design D2, tasks 4.6). ONE core check against the SERVER-SIDE current
// selection — the accepted authority snapshot, never a client-filtered list —
// backs three blocking paths:
//   1. `skill` tool calls (admit/loadBody): an unselected skill gets an
//      explicit 'unavailable' result and its body is NEVER loaded.
//   2. Slash submissions (validateSlash): the server-side revalidation mount
//      point for the slash pipeline — a client-side filtered list can never
//      smuggle an unselected skill through.
//   3. Subagent prompt publication (admitPromptPublication): a skill prompt
//      may only be published into a child session while the skill is still
//      selected at publication time.
// While the session's admission fence is held (an Apply is committing),
// not-yet-handed-off calls are refused; handed-off reads may complete, but a
// read whose authority changed before completion is revoked BEFORE any content
// is returned: read is not authorization. Admission writes nothing and audits
// nothing — durable policy events stay with the Apply and refresh engines.
import { isSegment } from './store/paths.js'
import { createSkillIdentity, skillIdentityKey } from './skill-identity.js'

const message = error => error instanceof Error ? error.message : String(error)

/** English user-facing denial messages (template layer). */
const MESSAGES = {
  'invalid-session': () => 'The session is unavailable.',
  'invalid-identity': name => `Skill "${name}" has an invalid identity.`,
  'admission-fence-held': name => `Skill "${name}" is temporarily unavailable: the session selection is being updated.`,
  'selection-authority-unavailable': name => `Skill "${name}" is unavailable: the session selection is not loaded.`,
  'skill-not-selected': name => `Skill "${name}" is not selected for this session.`,
}

/**
 * @typedef {{ status: 'admitted', revision: number, identityKey: string }
 *   | { status: 'unavailable', reason: string, revision: number|null, message: string }} Admission
 * @typedef {{ status: 'loaded', revision: number, content: unknown }
 *   | { status: 'revoked', reason: 'selection-revoked', revision: number|null, message: string }
 *   | { status: 'unavailable', reason: string, revision: number|null, message: string }} LoadResult
 */

/**
 * @param {{
 *   authority: (sessionId: string) => unknown | Promise<unknown>,
 *   fence: { admit(scope: string): boolean, isHeld?(scope: string): boolean },
 *   trace?: (event: string, data?: unknown) => void,
 * }} options
 * `authority` returns the current in-memory authority snapshot
 * ({ revision, selection: { skills } }) or null when not loaded; the Apply
 * engine's authority() is the canonical source.
 */
export function createSkillAdmission(options) {
  const { authority, fence, trace = () => {} } = options
  if (typeof authority !== 'function') throw new TypeError('An authority accessor is required')
  if (!fence || typeof fence.admit !== 'function') throw new TypeError('An admission fence is required')

  /** Selected identity keys of an authority snapshot. @param {unknown} snapshot @returns {Set<string>|null} */
  function selectedKeys(snapshot) {
    const skills = snapshot !== null && typeof snapshot === 'object'
      ? /** @type {{ selection?: { skills?: unknown } }} */ (snapshot).selection?.skills
      : null
    if (!Array.isArray(skills)) return null
    const keys = new Set()
    for (const raw of skills) {
      try { keys.add(skillIdentityKey(raw)) } catch { /* stray entries stay unauthorized */ }
    }
    return keys
  }

  /** @param {unknown} snapshot @returns {number|null} */
  function revisionOf(snapshot) {
    return snapshot !== null && typeof snapshot === 'object' && Number.isSafeInteger(/** @type {{ revision?: unknown }} */ (snapshot).revision)
      ? /** @type {number} */ (/** @type {{ revision: number }} */ (snapshot).revision)
      : null
  }

  /** @param {string} reason @param {number|null} revision @param {string} name */
  const denial = (reason, revision, name) => ({
    status: /** @type {const} */ ('unavailable'), reason, revision,
    message: (MESSAGES[reason] ?? MESSAGES['skill-not-selected'])(name),
  })

  /**
   * The single admission core: fence first (an Apply is committing), then the
   * current authority snapshot, then exact identity membership. Exact
   * identities only — the host still resolves skills by name; precision lives
   * in the Orrery manifest, never in a host-side identity lookup.
   * @param {string} sessionId @param {unknown} identity
   * @returns {Promise<Admission>}
   */
  async function check(sessionId, identity) {
    if (!isSegment(sessionId)) return denial('invalid-session', null, 'unknown')
    /** @type {string} */ let key
    /** @type {string} */ let name
    try {
      const value = createSkillIdentity(identity)
      key = skillIdentityKey(value)
      name = value.name
    } catch (error) {
      trace('admission-denied', { sessionId, reason: 'invalid-identity', error: message(error) })
      return denial('invalid-identity', null, 'unknown')
    }
    if (!fence.admit(sessionId)) {
      // The fence is held: not-yet-handed-off calls are refused while the
      // session's Apply commits.
      trace('admission-denied', { sessionId, reason: 'admission-fence-held', name })
      return denial('admission-fence-held', null, name)
    }
    const snapshot = await authority(sessionId)
    const revision = revisionOf(snapshot)
    if (revision === null) {
      // Fail closed: no loaded authority means nothing is authorized.
      trace('admission-denied', { sessionId, reason: 'selection-authority-unavailable', name })
      return denial('selection-authority-unavailable', null, name)
    }
    const selected = selectedKeys(snapshot) ?? new Set()
    if (!selected.has(key)) {
      trace('admission-denied', { sessionId, reason: 'skill-not-selected', name })
      return denial('skill-not-selected', revision, name)
    }
    return { status: 'admitted', revision, identityKey: key }
  }

  return {
    /** Path 1: `skill` tool call admission. */
    admit: check,

    /**
     * Path 2: slash submission revalidation. The server-side mount point for
     * the slash pipeline: the submission is re-checked against the CURRENT
     * selection even when the client already filtered its list.
     * @param {string} sessionId @param {unknown} identity
     * @returns {Promise<Admission>}
     */
    async validateSlash(sessionId, identity) {
      const result = await check(sessionId, identity)
      trace('slash-revalidation', { sessionId, status: result.status, ...(result.status === 'unavailable' ? { reason: result.reason } : {}) })
      return result
    },

    /**
     * Path 3: subagent prompt publication. A skill prompt may only be
     * published into a child session under the current selection; a
     * publication attempted after the skill's removal is refused.
     * @param {string} sessionId @param {unknown} identity
     * @returns {Promise<Admission>}
     */
    async admitPromptPublication(sessionId, identity) {
      const result = await check(sessionId, identity)
      trace('prompt-publication', { sessionId, status: result.status, ...(result.status === 'unavailable' ? { reason: result.reason } : {}) })
      return result
    },

    /**
     * Load a skill body under admission. The loader is invoked ONLY after
     * admission (an unselected skill's body is never read); when the
     * handed-off read completes, the authority is re-checked BEFORE any
     * content is returned — a superseded revision or a removed identity
     * revokes the publication. Read is not authorization.
     * @param {string} sessionId @param {unknown} identity
     * @param {() => Promise<unknown>} loader
     * @returns {Promise<LoadResult>}
     */
    async loadBody(sessionId, identity, loader) {
      const admitted = await check(sessionId, identity)
      if (admitted.status !== 'admitted') return admitted
      // Handed-off read: it may finish even while a later Apply holds the
      // fence; the publication check below is the gate that matters.
      const content = await loader()
      const snapshot = await authority(sessionId)
      const revision = revisionOf(snapshot)
      const selected = revision === null ? null : selectedKeys(snapshot)
      if (revision !== admitted.revision || !selected?.has(admitted.identityKey)) {
        trace('publication-revoked', { sessionId, from: admitted.revision, to: revision })
        return {
          status: 'revoked', reason: /** @type {const} */ ('selection-revoked'), revision,
          message: 'The skill content was read under a superseded selection and will not be published.',
        }
      }
      return { status: 'loaded', revision: admitted.revision, content }
    },
  }
}
