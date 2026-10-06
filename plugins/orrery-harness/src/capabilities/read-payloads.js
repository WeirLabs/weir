// Read payload builders for the Orrery capability surface (silent-capability-
// reads task 2.1): the receipt / list / conditions JSON payloads, sunk out of
// the /capabilities command handler so BOTH the command verbs (CLI + apply
// surfaces) and the plugin-owned typert read remote build byte-identical
// payloads from one implementation. Plain functions with explicit deps — no
// ctx, no singletons.
import { skillIdentityKey } from './skill-identity.js'
import { workspaceKeyOf } from './preset-library.js'
import { createDefaultsTransaction } from './defaults-transaction.js'
import { enumeratePresetUnits } from './store/enumerate.js'
import { isSegment } from './store/paths.js'

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
      /** @type {string | null} */
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

/**
 * The presets payload: the presets of the global namespace plus this
 * session's workspace namespace (read-only store scan). Domain failures are
 * VALUES, not thrown errors — `{ status, reason? }` mirrors exactly what the
 * command verb serializes into its error text, so the remote resolves it and
 * the CLI keeps its byte-identical output from one implementation.
 *
 * @param {{ store: any }} deps store: an opened capability store.
 * @param {{ cwd?: string, scope: { session: { id: string } } }} options
 * @returns {Promise<object>} `{ presets, workspaceKey }` or `{ status, reason? }`
 */
export async function buildPresetsPayload(deps, options) {
  const workspaceKey = workspaceKeyOf(options)
  const listed = await enumeratePresetUnits(deps.store, { workspaceKey: isSegment(workspaceKey) ? workspaceKey : undefined })
  if (listed.kind !== 'ok') {
    const failure = { status: listed.kind }
    if (listed.reason !== undefined) failure.reason = listed.reason
    return failure
  }
  const countOf = value => (Array.isArray(value) ? value.length : 0)
  const presets = listed.presets.map(preset => {
    const document = /** @type {Record<string, unknown>} */ (preset.document ?? {})
    const selection = /** @type {Record<string, unknown>} */ (document.selection ?? {})
    return {
      scope: preset.scope,
      presetId: preset.presetId,
      name: typeof document.name === 'string' ? document.name : '',
      revision: preset.revision,
      counts: {
        skills: countOf(selection.skills),
        mcpServers: countOf(selection.mcpServers),
        unresolvedRefs: countOf(selection.unresolvedRefs),
      },
    }
  })
  return { presets, workspaceKey }
}

/**
 * The workspace-default payload: this workspace's new-session default. A
 * cleared marker is reported distinctly — clearing is never an explicit
 * empty set, which stays a savable choice. Domain statuses are VALUES:
 * `{ status: 'no-workspace' }` when the session has no workspace key, and
 * `{ status: <record.kind>, workspaceKey }` for a non-ok record (the command
 * verb serializes the no-workspace case as an error and the rest as success —
 * that mapping stays in the command shell; the remote resolves the value).
 *
 * @param {{ store: any }} deps store: an opened capability store.
 * @param {{ cwd?: string, scope: { session: { id: string } } }} options
 * @returns {Promise<object>} `{ status: 'no-workspace' }` | `{ status: string, workspaceKey }` | `{ status: 'ok', revision, cleared, snapshot, workspaceKey }`
 */
export async function buildDefaultGetPayload(deps, options) {
  const workspaceKey = workspaceKeyOf(options)
  if (!isSegment(workspaceKey)) return { status: 'no-workspace' }
  const transaction = createDefaultsTransaction({ store: deps.store })
  const record = await transaction.read(workspaceKey)
  if (record.kind !== 'ok') return { status: record.kind, workspaceKey }
  const snapshot = record.snapshot
  const cleared = snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && /** @type {Record<string, unknown>} */ (snapshot).cleared === true
  return { status: 'ok', revision: record.revision, cleared, snapshot, workspaceKey }
}
