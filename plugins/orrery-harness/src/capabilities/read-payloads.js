// Read payload builders for the Orrery capability surface (silent-capability-
// reads task 2.1): the receipt / list / conditions JSON payloads, sunk out of
// the /capabilities command handler so BOTH the command verbs (CLI + apply
// surfaces) and the plugin-owned typert read remote build byte-identical
// payloads from one implementation. Plain functions with explicit deps — no
// ctx, no singletons.
import { skillIdentityKey } from './skill-identity.js'

/**
 * The receipt payload: provider status + the provider's selected candidates
 * + the lifecycle snapshot's MCP set + the persisted selection revision.
 * Field order is part of the wire contract (the command verb serializes this
 * object verbatim).
 *
 * @param {{ provider: any, lifecycle: any, store: any }} deps
 *   store: an opened capability store (openCapabilityStore result).
 * @param {{ cwd?: string, scope: { session: { id: string } } }} options
 * @returns {Promise<object>} the JSON-serializable receipt payload
 */
export async function buildReceiptPayload(deps, options) {
  const sessionId = options?.scope?.session?.id
  const status = deps.provider.status(options)
  // provider.list returns { candidates, complete } — never a bare array.
  const result = await deps.provider.list(options)
  const candidates = Array.isArray(result?.candidates) ? result.candidates : []
  const selected = candidates.filter(candidate => candidate.selected)
  const snapshot = deps.lifecycle?.snapshotFor?.(sessionId)
  const record = await deps.store.read({ kind: 'selection', scope: 'session', sessionId })
  return {
    status: 'applied',
    revision: record.kind === 'ok' ? record.revision : 0,
    effective: {
      skills: selected.map(candidate => candidate.name),
      mcpServers: Array.isArray(snapshot?.mcpServers) ? [...snapshot.mcpServers] : [],
    },
    warnings: (status?.error ?? null) ? [String(status.reason ?? 'selection-unavailable')] : [],
  }
}

/**
 * The listing payload: the FULL inventory joined with the session's EFFECTIVE
 * selection (provider.list stamps it — including the initial-selection
 * baseline for record-less sessions) plus the MCP manager listing. Every
 * discovered candidate (user-global, workspace, custom — selected or not)
 * lists with its selection mark.
 *
 * @param {{ inventory: Function, provider: any, mcpManager: any }} deps
 *   mcpManager may be undefined — the listing then reports zero servers.
 * @param {{ cwd?: string, scope: { session: { id: string } } }} options
 * @returns {Promise<object>} the JSON-serializable listing payload
 */
export async function buildListPayload(deps, options) {
  const inventoryResult = await deps.inventory(options)
  const candidates = Array.isArray(inventoryResult?.candidates) ? inventoryResult.candidates : []
  const effectiveResult = await deps.provider.list(options)
  const selectedKeys = new Set()
  for (const candidate of Array.isArray(effectiveResult?.candidates) ? effectiveResult.candidates : []) {
    if (!candidate.selected || !candidate.identity) continue
    try { selectedKeys.add(skillIdentityKey(candidate.identity)) } catch { /* an unstamped shape carries no mark */ }
  }
  const listing = deps.mcpManager?.list?.() ?? { managed: [], unmanaged: [] }
  return {
    skills: candidates.map(candidate => {
      let key = null
      try { key = candidate.identity ? skillIdentityKey(candidate.identity) : null } catch { key = null }
      return {
        name: candidate.name,
        description: candidate.description ?? '',
        scope: candidate.source?.scope ?? candidate.scope ?? 'unknown',
        status: candidate.status ?? 'unknown',
        selected: key !== null && selectedKeys.has(key),
        conflict: Boolean(candidate.conflict),
      }
    }),
    mcpServers: [
      ...(listing.managed ?? []).map(server => ({ identity: server.identity, state: server.state })),
      ...(listing.unmanaged ?? []).map(server => ({ serverName: server.serverName, state: 'unmanaged' })),
    ],
  }
}

/**
 * The conditions payload: the 1.12 consistency conditions; empty = supported.
 *
 * @returns {{ conditions: any[] }}
 */
export function buildConditionsPayload() {
  return { conditions: [] }
}
