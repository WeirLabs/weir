// Pure scope predicates shared by evidence gates and Auto planning.
//
// Two different scope shapes exist on purpose:
//   - a record/request scope is bound to exactly one workspace (`workspaces`);
//   - a profile scope has no workspace membership at all — only optional
//     paths/tags expertise hints plus authorization classes.

/** @param {any} evidenceScope @param {any} requestedScope @param {string} workspaceKey */
export function scopeCovers(evidenceScope, requestedScope, workspaceKey) {
  if (!evidenceScope || !requestedScope || !evidenceScope.workspaces?.includes(workspaceKey)) return false
  if (!requestedScope.workspaces?.includes(workspaceKey)) return false
  return hintsCover(evidenceScope, requestedScope)
}

/**
 * Profile expertise hints must admit the request. A hint list that is empty (or
 * absent) means "no extra restriction", never a wildcard workspace.
 * @param {any} profileScope @param {any} requestedScope
 */
export function profileScopeCovers(profileScope, requestedScope) {
  if (!profileScope || !requestedScope) return false
  return hintsCover(profileScope, requestedScope)
}

/** @param {any} evidenceScope @param {any} requestedScope */
function hintsCover(evidenceScope, requestedScope) {
  const paths = evidenceScope.paths ?? []
  const requestedPaths = requestedScope.paths ?? []
  if (paths.length && (!requestedPaths.length || requestedPaths.some(path => !paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))))) return false
  const tags = evidenceScope.tags ?? []
  const requestedTags = requestedScope.tags ?? []
  if (tags.length && (!requestedTags.length || requestedTags.some(tag => !tags.includes(tag)))) return false
  return true
}
