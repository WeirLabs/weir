// Identity is independent of content versions, discovery ranks, and authorization.
export const SKILL_SCOPES = Object.freeze(['project', 'user', 'custom', 'orrery-builtin'])

/** Construct a local identity. Roots must already be canonicalized by the caller.
 * @param {{scope: string, root: string, name: string, provenance?: Record<string, string> | null, opaqueId?: string}} input
 */
export function createSkillIdentity(input) {
  const { scope, root, name, provenance, opaqueId } = input
  if (!SKILL_SCOPES.includes(scope)) throw new TypeError('Invalid skill scope')
  if (typeof root !== 'string' || !root.length) throw new TypeError('A canonical root is required')
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new TypeError('Invalid skill name')
  if (provenance == null) {
    if (typeof opaqueId !== 'string' || !opaqueId.length) throw new TypeError('A machine-local opaque id is required')
    return Object.freeze({ scope, root, name, provenance: null, opaqueId, portable: false })
  }
  if (typeof provenance !== 'object' || Array.isArray(provenance) || !Object.keys(provenance).length) throw new TypeError('Invalid provenance')
  const entries = Object.keys(provenance).sort().map(key => {
    const value = provenance[key]
    if (typeof value !== 'string' || !value.length) throw new TypeError('Provenance fields must be nonempty strings')
    return [key, value]
  })
  return Object.freeze({ scope, root, name, provenance: Object.freeze(Object.fromEntries(entries)), portable: true })
}

/** A collision-free local comparison key, never a portable reference or a grant. */
export function skillIdentityKey(identity) {
  const value = createSkillIdentity(identity)
  return JSON.stringify([value.scope, value.root, value.name, value.provenance, value.opaqueId ?? null])
}

/** Compare identities, deliberately ignoring content digest and discovery labels. */
export function sameSkillIdentity(left, right) {
  return skillIdentityKey(left) === skillIdentityKey(right)
}
