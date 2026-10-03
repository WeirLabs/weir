import { posix } from 'node:path'

/** Candidates describe effects, not merely explicit API arguments. Session-wide
 * operations must enumerate affected ownership at their FIFO position.
 * @typedef {{kind: 'resources', resourceIds: string[]} | {kind: 'scope', ancestor: string} | {kind: 'none'}} Candidate
 * @typedef {'normal'|'release'|'revocation'} Mode
 */

/** Shape check only, NOT filesystem proof. The trusted manager ingress already
 * requires canonical, single-link resource identity and exclusive topology control.
 * Opaque kernel test IDs remain valid without fences but cannot prove non-overlap.
 * @param {string} resourceId */
function canonicalResource(resourceId) {
  return typeof resourceId === 'string' && resourceId.startsWith('/') &&
    !resourceId.includes('\0') && resourceId !== '/' &&
    !resourceId.endsWith('/') && posix.normalize(resourceId) === resourceId
}

/** Pure denial check. Historical closeout assertions grant no authority.
 * v3 stores no ancestor continuity witness. Neither relative() nor resolving an
 * ancestor again proves its historical topology: scope relations stay undecidable.
 * @param {import('./operation-history.js').Operation[]} operations
 * @param {Candidate} candidate
 * @param {Mode} [mode]
 */
export function admitMutation(operations, candidate, mode = 'normal') {
  if (mode === 'revocation') return
  for (const operation of operations) {
    if (operation.phase !== 'publishing' && operation.phase !== 'unknown') continue
    const fence = operation.fence
    const deny = (/** @type {string} */ reason) => { throw new Error(`unresolved publication fence: ${reason}`) }
    if (!candidate || !fence) deny('scope-unproved')
    // Pure removal cannot publish or grant authority, but MUST retain the exact
    // ownership required by unresolved updates, even under historical fences.
    if (mode === 'release') {
      if (candidate.kind !== 'resources' || !candidate.resourceIds.every(canonicalResource)) deny('identity-unproved')
      const target = operation.binding.target
      if (target.kind === 'update' && candidate.kind === 'resources' && candidate.resourceIds.includes(target.resourceId)) deny('retained-ownership')
      continue
    }
    if (fence?.kind === 'domain') deny('domain')
    if (candidate.kind === 'none') continue
    if (candidate.kind !== 'resources') deny('scope-continuity-unproved')
    if (candidate.kind === 'resources') {
      for (const resourceId of candidate.resourceIds) {
        if (!canonicalResource(resourceId)) deny('identity-unproved')
        if (fence?.kind !== 'resource') deny('scope-continuity-unproved')
        if (fence?.kind === 'resource' && (!canonicalResource(fence.resourceId) || fence.resourceId === resourceId)) deny('resource-conflict')
      }
    }
  }
}

/** @param {import('./operation-history.js').Target} target @returns {Candidate} */
export function publicationCandidate(target) {
  return target.kind === 'update' ? { kind: 'resources', resourceIds: [target.resourceId] }
    : { kind: 'scope', ancestor: target.ancestor }
}
