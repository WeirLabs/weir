// Memory namespace identity shared by the private and public zones.
//
// A private namespace is `(agentId, 'workspace', workspaceKey)`: exactly one
// workspace owns it. A public namespace is `(agentId, 'public', null)`: no
// workspace owns it, so SQLite NULL semantics need the partial unique indexes
// declared in schema v2 rather than a sentinel value.
import { createHash } from 'node:crypto'
import { canonicalJson, DecisionContractError } from '../contracts.js'
import { legacyOriginAlias } from '../store/schema.js'

export const PRIVATE_ZONE = 'workspace'
export const PUBLIC_ZONE = 'public'
export const MEMORY_ZONES = Object.freeze([PRIVATE_ZONE, PUBLIC_ZONE])

/**
 * @param {unknown} zone
 * @param {unknown} [workspaceKey]
 * @returns {{zone:'workspace'|'public', namespaceWorkspaceKey:string|null}}
 */
export function memoryNamespace(zone, workspaceKey = null) {
  if (!MEMORY_ZONES.includes(/** @type {string} */ (zone))) {
    throw new DecisionContractError('INVALID_NAMESPACE', `memory zone ${String(zone)} is not supported`)
  }
  if (zone === PRIVATE_ZONE) {
    if (typeof workspaceKey !== 'string' || !workspaceKey) {
      throw new DecisionContractError('INVALID_NAMESPACE', 'a workspace namespace requires a workspace key')
    }
    return { zone: PRIVATE_ZONE, namespaceWorkspaceKey: workspaceKey }
  }
  if (workspaceKey !== null && workspaceKey !== undefined) {
    throw new DecisionContractError('INVALID_NAMESPACE', 'a public namespace must not name a workspace')
  }
  return { zone: PUBLIC_ZONE, namespaceWorkspaceKey: null }
}

/** Stable in-process key for coalescing one namespace's jobs. */
export function namespaceKey(namespace) {
  return namespace.zone === PUBLIC_ZONE ? 'public' : `workspace:${namespace.namespaceWorkspaceKey}`
}

/**
 * Opaque, stable origin token. This is the only workspace identity a public
 * payload may carry: never the raw workspace key or a realpath.
 * @param {unknown} workspaceKey
 */
export function workspaceAlias(workspaceKey) {
  if (typeof workspaceKey !== 'string' || !workspaceKey) {
    throw new DecisionContractError('INVALID_NAMESPACE', 'a workspace alias requires a workspace key')
  }
  return /** @type {string} */ (legacyOriginAlias(workspaceKey))
}

/**
 * Deterministic high-water mark over the eligible public source set. A refresh
 * compares this value with the last frozen public input: equal means the model
 * must not be called again.
 * @param {{sourceId:string,kind:string,revision:number}[]} sources
 */
export function publicSourceHighWater(sources) {
  const entries = [...sources]
    .map(source => ({ sourceId: source.sourceId, kind: source.kind, revision: source.revision }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.kind.localeCompare(right.kind))
  return createHash('sha256').update(canonicalJson(entries)).digest('hex')
}

/**
 * A public principle has no workspace membership; to revalidate one of its
 * sources, the principle scope is projected onto the source's origin workspace.
 * @param {{paths?:string[],tags?:string[]}} principleScope
 * @param {string} workspaceKey
 */
export function publicPrincipleScopeForWorkspace(principleScope, workspaceKey) {
  return {
    workspaces: [workspaceKey],
    ...(principleScope?.paths?.length ? { paths: [...principleScope.paths] } : {}),
    ...(principleScope?.tags?.length ? { tags: [...principleScope.tags] } : {}),
  }
}
