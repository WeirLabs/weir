// Task 8.1 of the session-capability-manager change: the Orrery-managed MCP
// server registry. The configured identity, scope owner and registration
// generation of every Orrery-managed server live here, persisted through the
// group-2 store as the independent { kind: 'mcp-registry' } unit. Admission
// decisions read ONLY these fields — never a public `mcp__...` tool name
// (name strings can collide, G3b `collide` EXECUTED) and never an
// authorization inherited from a display label.
import { isSegment } from './store/paths.js'

export const MCP_REGISTRY_SCHEMA = 1

/**
 * @typedef {{ identity: string, label: string, owner: { kind: 'workspace'|'global', key: string },
 *   generation: number, configuredAt: number, transport: { kind: string, ref: string } }} McpServerEntry
 * @typedef {{ servers: Record<string, McpServerEntry> }} McpRegistryPayload
 */

const message = error => (error instanceof Error ? error.message : String(error))

/**
 * @param {{ store: { read(unit: unknown): Promise<any>, commit(unit: unknown, expectedRevision: number, mutate: (payload: unknown) => unknown, request?: unknown): Promise<any> },
 *   now?: () => number }} options
 */
export function createMcpRegistry({ store, now = Date.now }) {
  const unit = { kind: 'mcp-registry' }

  const normalize = payload => {
    const servers = payload && typeof payload === 'object' && !Array.isArray(payload) && payload.servers && typeof payload.servers === 'object'
      ? payload.servers
      : {}
    return { servers: { ...servers } }
  }

  /** @returns {Promise<{ kind: 'absent' } | { kind: 'ok', revision: number, servers: Record<string, McpServerEntry> } | { kind: string }>} */
  async function read() {
    const record = await store.read(unit)
    if (record.kind === 'absent') return { kind: 'absent' }
    if (record.kind !== 'ok') return { kind: record.kind }
    return { kind: 'ok', revision: record.revision, ...normalize(record.payload) }
  }

  const validateIdentity = identity => {
    if (!isSegment(identity)) throw new TypeError(`invalid MCP server identity: ${JSON.stringify(identity)}`)
  }
  const validateEntry = entry => {
    validateIdentity(entry?.identity)
    if (typeof entry.label !== 'string' || entry.label.length === 0) throw new TypeError(`invalid MCP server label for "${entry.identity}"`)
    if (entry.owner?.kind !== 'workspace' && entry.owner?.kind !== 'global') throw new TypeError(`invalid MCP server owner for "${entry.identity}"`)
    if (!isSegment(entry.owner.key)) throw new TypeError(`invalid MCP server owner key for "${entry.identity}"`)
    if (entry.transport?.kind !== 'stdio') throw new TypeError(`invalid MCP server transport for "${entry.identity}": only stdio is supported`)
    if (typeof entry.transport.ref !== 'string' || entry.transport.ref.length === 0) throw new TypeError(`invalid MCP server transport ref for "${entry.identity}"`)
  }

  /**
   * Register a new managed server (fresh generation 1) or re-register the
   * same configured identity under a NEW registration generation (reconnect).
   * A display-name change of the SAME identity keeps the identity and bumps
   * the generation — authorization never inherits across identities.
   * @param {McpServerEntry} entry @param {number} expectedRevision
   */
  async function register(entry, expectedRevision) {
    validateEntry(entry)
    return store.commit(unit, expectedRevision, payload => {
      const { servers } = normalize(payload)
      const existing = servers[entry.identity]
      servers[entry.identity] = {
        ...entry,
        generation: (existing?.generation ?? 0) + 1,
        configuredAt: existing?.configuredAt ?? now(),
      }
      return { servers }
    })
  }

  /** @param {string} identity @param {number} expectedRevision */
  async function remove(identity, expectedRevision) {
    validateIdentity(identity)
    return store.commit(unit, expectedRevision, payload => {
      const { servers } = normalize(payload)
      delete servers[identity]
      return { servers }
    })
  }

  /** Rename = a NEW identity (generation 1) plus removal of the old one, in ONE atomic commit. */
  async function rename(from, to, entry, expectedRevision) {
    validateIdentity(from)
    validateEntry({ ...entry, identity: to })
    return store.commit(unit, expectedRevision, payload => {
      const { servers } = normalize(payload)
      delete servers[from]
      servers[to] = { ...entry, identity: to, generation: 1, configuredAt: now() }
      return { servers }
    })
  }

  return { read, register, remove, rename, unit }
}

/**
 * The admission predicate (8.1): derives its verdict from registry fields
 * ONLY — configured identity + registration generation. It never receives,
 * parses or compares a public tool name.
 * @param {{ read(): Promise<any> }} registry
 */
export function createMcpAdmission(registry) {
  /**
   * @param {string} identity - configured identity established at facade registration time
   * @param {number} generation - the registration generation that facade instance was mounted with
   * @returns {Promise<{ admitted: boolean, reason: string|null }>}
   */
  async function admit(identity, generation) {
    const current = await registry.read()
    if (current.kind !== 'ok') return { admitted: false, reason: current.kind === 'absent' ? 'registry-absent' : `registry-${current.kind}` }
    const entry = current.servers[identity]
    if (!entry) return { admitted: false, reason: 'identity-unregistered' }
    if (entry.generation !== generation) return { admitted: false, reason: 'generation-stale' }
    return { admitted: true, reason: null }
  }
  return { admit }
}

export const __message = message // test seam
