// Pure scope-containment predicate shared by evidence gates and Auto planning.

/** @param {any} evidenceScope @param {any} requestedScope @param {string} workspaceKey */
export function scopeCovers(evidenceScope, requestedScope, workspaceKey) {
  if (!evidenceScope || !requestedScope || !evidenceScope.workspaces?.includes(workspaceKey)) return false
  if (!requestedScope.workspaces?.includes(workspaceKey)) return false
  const paths = evidenceScope.paths ?? []
  const requestedPaths = requestedScope.paths ?? []
  if (paths.length && (!requestedPaths.length || requestedPaths.some(path => !paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))))) return false
  const tags = evidenceScope.tags ?? []
  const requestedTags = requestedScope.tags ?? []
  if (tags.length && (!requestedTags.length || requestedTags.some(tag => !tags.includes(tag)))) return false
  return true
}
