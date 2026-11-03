// Internal, module-realm Mount Attempt Ownership. Logical identity, the actual
// Loader group and the opaque owner are deliberately separate facts. Nothing in
// this module is part of a public receipt or persisted selection payload.
import { randomUUID } from 'node:crypto'

export const MCP_GROUP_PREFIX = 'weir-mcp-'
const ACTUAL_OWNER_SEPARATOR = '~'

export function isMcpResidueId(id) {
  return typeof id === 'string' && id.startsWith(MCP_GROUP_PREFIX) && !id.endsWith('-facade') && !id.endsWith('-client')
}

export function isSuffixedMcpGroupId(id) {
  return typeof id === 'string' && id.startsWith(MCP_GROUP_PREFIX) && id.includes(ACTUAL_OWNER_SEPARATOR, MCP_GROUP_PREFIX.length)
}

/** Resolve only the explicit facade child config carried by a real group row. */
export function mcpFacadeIdentity(row, groupId = row?.options?.id ?? row?.id) {
  const options = row?.options ?? row
  const config = Array.isArray(options?.config) ? options.config : []
  for (const child of config) {
    if (child?.name !== 'weir-harness/mcp-facade-plugin') continue
    const facade = child.config
    if (typeof facade?.identity !== 'string' || facade.identity.length === 0) continue
    if (facade.group !== groupId) continue
    return facade.identity
  }
  return null
}

/**
 * Resolve one actual group without reverse-parsing generated suffixes. The
 * precedence is part of the inventory/recovery contract: own exact mount, live
 * module-realm allocation, explicit facade config, then a true legacy ID only.
 * @param {{ groupId: string, mounted?: Map<string, any>, ownership?: any, row?: any }} input
 */
export function resolveMcpGroupIdentity({ groupId, mounted = new Map(), ownership = null, row = null }) {
  for (const [identity, mount] of mounted) {
    if (mount?.groupId === groupId) return { identity, source: 'own-mounted', mount, allocation: ownership?.forGroup(groupId) ?? null }
  }
  const allocation = ownership?.forGroup(groupId) ?? null
  if (allocation) return { identity: allocation.identity, source: 'live-allocation', mount: null, allocation }
  const configured = mcpFacadeIdentity(row, groupId)
  if (configured !== null) return { identity: configured, source: 'facade-config', mount: null, allocation: null }
  if (!isMcpResidueId(groupId) || isSuffixedMcpGroupId(groupId)) return null
  return { identity: groupId.slice(MCP_GROUP_PREFIX.length), source: 'legacy', mount: null, allocation: null }
}

/**
 * A fresh registry is useful for isolated component tests. Production managers
 * share mcpMountOwnership below, which is necessarily scoped to this loaded
 * bundle module instance; another module realm is never guessed to be owned.
 */
export function createMcpMountOwnership() {
  const byGroup = new Map()
  let sequence = 0

  /** @param {string} identity @param {{ holder?: any, tree?: any, available?: (groupId: string) => boolean }} options */
  function claim(identity, { holder, tree = null, available = () => true } = {}) {
    const legacy = `${MCP_GROUP_PREFIX}${identity}`
    let groupId = legacy
    while (byGroup.has(groupId) || available(groupId) !== true) {
      sequence += 1
      groupId = `${legacy}${ACTUAL_OWNER_SEPARATOR}${sequence.toString(36)}-${randomUUID().replaceAll('-', '')}`
    }
    const record = {
      identity, groupId, owner: randomUUID(), holder, tree,
      state: 'claimed', pending: new Set(),
    }
    // Check-and-claim are synchronous: no other mount attempt can interleave
    // between the availability checks and this exact group becoming occupied.
    byGroup.set(groupId, record)
    return record
  }

  /** Claim only known residue for disposal; this never authorizes group reuse. */
  function claimResidue({ identity, groupId, holder, tree = null }) {
    const current = byGroup.get(groupId)
    if (current) return current.holder === holder && current.identity === identity ? current : null
    if (!isMcpResidueId(groupId)) return null
    const record = {
      identity, groupId, owner: randomUUID(), holder, tree,
      state: 'residue', pending: new Set(),
    }
    byGroup.set(groupId, record)
    return record
  }

  function transition(record, state) {
    if (!record || byGroup.get(record.groupId) !== record) return false
    record.state = state
    return true
  }

  /** Release is compare-exact, idempotent, and impossible while work is pending. */
  function release(record, { provenAbsent = false, owner = record?.owner } = {}) {
    if (!record || provenAbsent !== true || record.pending.size > 0) return false
    if (record.owner !== owner || byGroup.get(record.groupId) !== record) return false
    byGroup.delete(record.groupId)
    record.state = 'released'
    return true
  }

  return {
    claim,
    claimResidue,
    transition,
    release,
    forGroup: groupId => byGroup.get(groupId) ?? null,
    records: () => [...byGroup.values()],
  }
}

export const mcpMountOwnership = createMcpMountOwnership()
