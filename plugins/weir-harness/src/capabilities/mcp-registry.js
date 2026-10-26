// Weir-managed MCP registry: the sole configuration authority. Incarnation binds
// session authorization to one registration lifetime; enabled is independent of
// every session's draft/accepted selection and workspace-default records.
import { randomUUID } from 'node:crypto'
import { isSegment } from './store/paths.js'

export const MCP_REGISTRY_SCHEMA = 1
const message = error => (error instanceof Error ? error.message : String(error))
const clone = value => value == null ? value : structuredClone(value)

export class McpRegistryError extends Error {
  constructor(code, text) {
    super(text)
    this.name = 'McpRegistryError'
    this.code = code
  }
}

export function createMcpRegistry({ store, now = Date.now, newIncarnation = () => randomUUID() }) {
  const unit = { kind: 'mcp-registry' }
  const normalize = payload => {
    const servers = payload && typeof payload === 'object' && !Array.isArray(payload) && payload.servers && typeof payload.servers === 'object' && !Array.isArray(payload.servers)
      ? clone(payload.servers)
      : {}
    const enabled = [...new Set((Array.isArray(payload?.enabled) ? payload.enabled : []).filter(identity => typeof identity === 'string' && isSegment(identity)))]
    return { servers, enabled }
  }

  async function read() {
    const record = await store.read(unit)
    if (record.kind === 'absent') return { kind: 'absent', enabled: [], warnings: [] }
    if (record.kind !== 'ok') return { kind: record.kind }
    const { servers, enabled } = normalize(record.payload)
    const warnings = enabled.filter(identity => !servers[identity]).map(identity => ({ code: 'default-missing', identity }))
    return { kind: 'ok', revision: record.revision, servers, enabled, warnings }
  }

  const validateIdentity = identity => {
    if (!isSegment(identity)) throw new TypeError(`invalid MCP server identity: ${JSON.stringify(identity)}`)
  }
  const validateEntry = entry => {
    validateIdentity(entry?.identity)
    if (typeof entry.label !== 'string' || entry.label.length === 0) throw new TypeError(`invalid MCP server label for "${entry.identity}"`)
    if (entry.owner?.kind !== 'workspace' && entry.owner?.kind !== 'global') throw new TypeError(`invalid MCP server owner for "${entry.identity}"`)
    if (!isSegment(entry.owner.key)) throw new TypeError(`invalid MCP server owner key for "${entry.identity}"`)
    if (!['stdio', 'streamable-http'].includes(entry.transport?.kind)) throw new TypeError(`invalid MCP server transport for "${entry.identity}"`)
    if (typeof entry.transport.ref !== 'string' || entry.transport.ref.length === 0) throw new TypeError(`invalid MCP server transport ref for "${entry.identity}"`)
    if (entry.incarnation !== undefined && entry.incarnation !== null && (typeof entry.incarnation !== 'string' || entry.incarnation.length === 0)) throw new TypeError(`invalid MCP server incarnation for "${entry.identity}"`)
  }
  const committed = (result, extra = {}) => ({ ...result, ...extra })

  async function register(entry, expectedRevision) {
    validateEntry(entry)
    const result = await store.commit(unit, expectedRevision, payload => {
      const { servers, enabled } = normalize(payload)
      const existing = servers[entry.identity]
      servers[entry.identity] = {
        ...clone(entry),
        // A legacy registration remains legacy across edit/restart so legacy
        // selections keep working. Creation/re-add gets a fresh incarnation.
        incarnation: existing ? (existing.incarnation ?? null) : newIncarnation(),
        generation: (existing?.generation ?? 0) + 1,
        configuredAt: existing?.configuredAt ?? now(),
      }
      return { servers, enabled }
    })
    return committed(result, { incarnation: result.status === 'committed' && result.payload?.servers?.[entry.identity]?.incarnation !== undefined ? result.payload.servers[entry.identity].incarnation : undefined })
  }

  async function remove(identity, expectedRevision) {
    validateIdentity(identity)
    let defaultRemoved = false
    const result = await store.commit(unit, expectedRevision, payload => {
      const { servers, enabled } = normalize(payload)
      delete servers[identity]
      const nextEnabled = enabled.filter(item => item !== identity)
      defaultRemoved = nextEnabled.length !== enabled.length
      return { servers, enabled: nextEnabled }
    })
    return committed(result, { defaultRemoved: result.status === 'committed' && defaultRemoved })
  }

  async function rename(from, to, entry, expectedRevision) {
    validateIdentity(from)
    validateIdentity(to)
    validateEntry({ ...entry, identity: to })
    const result = await store.commit(unit, expectedRevision, payload => {
      const { servers, enabled } = normalize(payload)
      delete servers[from]
      servers[to] = { ...clone(entry), identity: to, incarnation: newIncarnation(), generation: 1, configuredAt: now() }
      const wasDefault = enabled.includes(from)
      return { servers, enabled: [...new Set([...enabled.filter(identity => identity !== from), ...(wasDefault ? [to] : [])])] }
    })
    return committed(result)
  }

  async function setDefaults(identities, expectedRevision) {
    const requested = [...new Set(identities)]
    for (const identity of requested) validateIdentity(identity)
    const result = await store.commit(unit, expectedRevision, payload => {
      const { servers } = normalize(payload)
      for (const identity of requested) if (!servers[identity]) throw new McpRegistryError('identity-unregistered', `cannot enable unregistered MCP default "${identity}"`)
      return { servers, enabled: requested }
    })
    return committed(result, { enabled: result.status === 'committed' ? requested : undefined })
  }

  async function setDefault(identity, enabled, expectedRevision) {
    validateIdentity(identity)
    const result = await store.commit(unit, expectedRevision, payload => {
      const current = normalize(payload)
      if (!current.servers[identity]) throw new McpRegistryError('identity-unregistered', `cannot change unregistered MCP default "${identity}"`)
      const defaults = new Set(current.enabled)
      if (enabled) defaults.add(identity)
      else defaults.delete(identity)
      return { servers: current.servers, enabled: [...defaults] }
    })
    return committed(result, { defaultEnabled: result.status === 'committed' ? Boolean(enabled) : undefined })
  }

  return { read, register, remove, rename, setDefault, setDefaults, unit }
}

/** Legacy admission helper: identity + generation only, never public names. */
export function createMcpAdmission(registry) {
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

export const __message = message
