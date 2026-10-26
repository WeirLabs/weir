// Managed MCP Loader lifecycle. Registry configuration is the authority; the
// stock client is named by string and never statically imported.
import { randomUUID } from 'node:crypto'
import { isSegment } from './store/paths.js'
import { McpLifecycleError, mcpDiagnostic } from './mcp-diagnostics.js'

export const MCP_GROUP_PREFIX = 'weir-mcp-'
const DEFAULT_STARTUP_TIMEOUT = 15_000
const DEFAULT_CLEANUP_TIMEOUT = 15_000
const message = error => (error instanceof Error ? error.message : String(error))

export function detectMcpNameAmbiguity(entries) {
  const conflicts = []
  const identities = entries.map(entry => entry.identity)
  for (let i = 0; i < identities.length; i += 1) {
    for (let j = 0; j < identities.length; j += 1) {
      if (i !== j && identities[j].startsWith(`${identities[i]}__`)) {
        conflicts.push({ kind: 'prefix', a: identities[i], b: identities[j], reason: `configured name "${identities[i]}" is a "__" prefix of "${identities[j]}"; tool-name attribution would be ambiguous` })
      }
    }
  }
  const declared = new Map()
  for (const entry of entries) {
    for (const name of entry.publicNames ?? []) {
      if (declared.has(name)) conflicts.push({ kind: 'duplicate-public-name', a: declared.get(name), b: entry.identity, reason: `public tool name "${name}" is declared by both "${declared.get(name)}" and "${entry.identity}"` })
      else declared.set(name, entry.identity)
    }
  }
  return conflicts.length === 0 ? { kind: 'ok' } : { kind: 'conflict', conflicts }
}

export function mcpGroupOptions({ identity, generation, client }) {
  if (!isSegment(identity)) throw new TypeError(`invalid MCP server identity: ${JSON.stringify(identity)}`)
  const group = `${MCP_GROUP_PREFIX}${identity}`
  return {
    id: group,
    name: 'cordis:group',
    group: true,
    isolate: { tools: true, systemPrompt: true, mcpResources: true },
    config: [
      { id: `${group}-facade`, name: 'weir-harness/mcp-facade-plugin', config: { identity, generation, group } },
      { id: `${group}-client`, name: '@deepseek-ai/dsh-mcp-client', config: client },
    ],
  }
}

export const isMcpResidueId = id => typeof id === 'string' && id.startsWith(MCP_GROUP_PREFIX) && !id.endsWith('-facade') && !id.endsWith('-client')

/**
 * The stock EntryTree methods write through their tree. Its root EntryGroup
 * methods only mutate the runtime store, which is the non-profile-writing seam
 * used for materialized secrets. Any other shape is unsupported, never a
 * fallback to the write-through tree.
 */
export function resolveEphemeralMcpTree(loader) {
  const root = loader?.root
  const tree = root?.tree
  if (tree?.root !== root || typeof root?.create !== 'function' || typeof root?.remove !== 'function'
    || typeof tree?.await !== 'function' || typeof tree?.resolve !== 'function') {
    return { kind: 'unsupported', reason: 'ephemeral-loader-unavailable' }
  }
  return {
    kind: 'ok',
    tree: {
      ephemeral: true,
      create: options => root.create(options),
      remove: id => root.remove(id),
    },
  }
}

export function strictMcpClientConfig(client, { probe = false } = {}) {
  const reconnect = probe
    ? { enabled: false, initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 }
    : client?.reconnect
  return { ...client, failOnStartupError: true, ...(reconnect ? { reconnect } : {}) }
}

async function bounded(promise, timeoutMs, code, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), { code })), timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve(promise), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function createMcpMount({ loader, onError = () => {}, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT, cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT, ephemeralTree } = {}) {
  /** @type {Map<string, { groupId: string, generation: number, state?: string }>} */
  const mounted = new Map()

  const treeFor = secretBearing => {
    const resolved = ephemeralTree === undefined ? resolveEphemeralMcpTree(loader) : ephemeralTree
    if (resolved?.kind === 'ok' && resolved.tree) return resolved.tree
    if (secretBearing) throw new McpLifecycleError('unsupported', new Error('secret-bearing MCP mount requires a proven non-profile-writing Loader root group'), { status: 'unsupported', action: 'use-secret-free-config' })
    if (typeof loader?.create !== 'function' || typeof loader?.remove !== 'function') {
      throw new McpLifecycleError('unsupported', new Error('MCP Loader lifecycle is unavailable'), { status: 'unsupported' })
    }
    // Compatibility for secret-free legacy records only. New secret-bearing
    // paths can never reach this write-through branch.
    return { ephemeral: false, create: options => loader.create(options), remove: id => loader.remove(id) }
  }

  function entriesFor(groupId) {
    if (typeof loader?.entries === 'function') {
      return [...loader.entries()].filter(entry => entry?.id === groupId || String(entry?.id ?? '').startsWith(`${groupId}:`))
    }
    if (loader?.store && typeof loader.store === 'object') {
      return Object.values(loader.store).filter(entry => entry?.id === groupId || entry?.options?.id === groupId || String(entry?.options?.id ?? '').startsWith(`${groupId}-`))
    }
    return null
  }

  function forgetGroup(groupId, generation) {
    for (const [identity, entry] of mounted) {
      if (entry.groupId === groupId && (!generation || entry.generation === generation)) mounted.delete(identity)
    }
  }

  /**
   * Capture and settle group/client/descendant fibers BEFORE removing rows.
   * remove() is not the barrier: its return does not await async plugin
   * disposal. A rejected disposal or an unconfirmed close blocks same-name
   * replacement and leaves enough state for residue recovery.
   */
  async function disposeGroup(groupId, context = {}) {
    const tree = context.tree ?? treeFor(Boolean(context.secretBearing))
    const captured = entriesFor(groupId)
    if (captured?.length === 0) {
      forgetGroup(groupId, context.generation)
      return { status: 'cleaned', removed: false, groupId }
    }
    if (captured === null && context.requireCapture === true) {
      return { status: 'cleanup-unknown', removed: false, groupId, diagnostic: mcpDiagnostic(new Error('cannot capture Loader fibers for disposal'), { code: 'cleanup-unknown', action: 'recover-residue' }) }
    }
    const fibers = (captured ?? []).map(entry => entry?.fiber).filter(Boolean)
    const disposals = fibers.map((fiber, index) => {
      try {
        return bounded(fiber.dispose?.(), cleanupTimeoutMs, 'cleanup-timeout', `MCP disposal ${groupId}[${index}]`)
      } catch (cause) {
        return Promise.reject(cause)
      }
    })
    const settled = await Promise.allSettled(disposals)
    const rejected = settled.find(result => result.status === 'rejected')
    if (rejected) {
      return { status: rejected.reason?.code === 'cleanup-timeout' ? 'cleanup-unknown' : 'cleanup-failed', removed: false, groupId, diagnostic: mcpDiagnostic(rejected.reason, { code: rejected.reason?.code === 'cleanup-timeout' ? 'cleanup-unknown' : 'cleanup-failed', action: 'recover-residue' }) }
    }
    try {
      await bounded(tree.remove(groupId), cleanupTimeoutMs, 'cleanup-timeout', `MCP Loader remove ${groupId}`)
    } catch (cause) {
      return { status: cause?.code === 'cleanup-timeout' ? 'cleanup-unknown' : 'cleanup-failed', removed: false, groupId, diagnostic: mcpDiagnostic(cause, { code: cause?.code === 'cleanup-timeout' ? 'cleanup-unknown' : 'cleanup-failed', action: 'recover-residue' }) }
    }
    const remaining = entriesFor(groupId)
    let closeConfirmed = remaining === null ? true : remaining.length === 0
    if (typeof context.confirmClosed === 'function') {
      try {
        closeConfirmed = closeConfirmed && await bounded(context.confirmClosed({ groupId, entries: captured, fibers }), cleanupTimeoutMs, 'cleanup-timeout', `MCP close confirmation ${groupId}`) === true
      } catch (cause) {
        return { status: 'cleanup-unknown', removed: false, groupId, diagnostic: mcpDiagnostic(cause, { code: 'cleanup-unknown', action: 'recover-residue' }) }
      }
    } else if (captured !== null) {
      closeConfirmed = closeConfirmed && fibers.every(fiber => fiber.uid === null || fiber.state === 4 || fiber.state === 5)
    }
    if (!closeConfirmed || remaining === null && context.requireCapture === true) {
      return { status: 'cleanup-unknown', removed: false, groupId, diagnostic: mcpDiagnostic(new Error('MCP transport closure or Loader row removal could not be confirmed'), { code: 'cleanup-unknown', action: 'recover-residue' }) }
    }
    forgetGroup(groupId, context.generation)
    return { status: 'cleaned', removed: true, groupId }
  }

  async function sweepResidue(candidateIds) {
    const removed = []
    for (const id of candidateIds.filter(isMcpResidueId)) {
      const cleanup = await disposeGroup(id, { tree: treeFor(false), identity: id.slice(MCP_GROUP_PREFIX.length) })
      if (cleanup.status === 'cleaned') removed.push(id)
      else onError(`residue-sweep-${cleanup.status}:${id}`, cleanup.diagnostic)
    }
    return removed
  }

  async function mountOne(input) {
    const { identity, generation, fiberOf, probe = false, secretBearing = false } = input
    const previous = mounted.get(identity)
    if (!probe && (previous?.state === 'cleanup-failed' || previous?.state === 'cleanup-unknown')) {
      throw new McpLifecycleError(previous.state, new Error(`same-name MCP replacement is blocked while ${identity} is ${previous.state}`), { status: previous.state, action: 'recover-residue' })
    }
    const options = mcpGroupOptions({ identity, generation, client: strictMcpClientConfig(input.client, { probe }) })
    const tree = treeFor(secretBearing)
    let bridgeReady = false
    let succeeded = false
    try {
      if (typeof input.beforeCreate === 'function') await input.beforeCreate({ groupId: options.id, identity, generation, probe, ephemeral: tree.ephemeral === true })
      bridgeReady = true
      await bounded(tree.create(options), startupTimeoutMs, 'startup-timeout', `MCP Loader create ${identity}`)
      await bounded(loader.await(), startupTimeoutMs, 'startup-timeout', `MCP Loader await ${identity}`)
      const fiber = typeof fiberOf === 'function'
        ? await bounded(fiberOf(options.id), startupTimeoutMs, 'startup-timeout', `MCP client readiness ${identity}`)
        : { state: 'running' }
      if (fiber === null || fiber === undefined) throw new Error('mcp-mount-error: client entry has no fiber after loader.await()')
      if (fiber.state !== undefined && !['running', 'active', 2].includes(fiber.state)) throw new Error(`mcp-mount-error: client fiber is not ready (state ${String(fiber.state)})`)
      const clientEntry = loader?.store?.[`${options.id}-client`]
      if (clientEntry?.error) throw clientEntry.error
      if (typeof input.readback === 'function') await input.readback({ groupId: options.id, identity, generation, probe })
      const discovery = typeof input.discovery === 'function' ? await input.discovery({ groupId: options.id, identity, generation, probe }) : { toolCount: null, toolNamesPreview: [], truncated: false }
      const result = { status: 'mounted', groupId: options.id, identity, generation, probe, discovery, execution: input.execution ?? null }
      if (!probe) mounted.set(identity, { groupId: options.id, generation, state: 'mounted' })
      succeeded = true
      return result
    } catch (cause) {
      const cleanup = await disposeGroup(options.id, { tree, identity, generation, secretBearing, confirmClosed: input.confirmClosed })
      if (!probe && cleanup.status !== 'cleaned') mounted.set(identity, { groupId: options.id, generation, state: cleanup.status })
      const diagnostic = mcpDiagnostic(cause, { secrets: input.secrets, action: cleanup.status === 'cleaned' ? 'retry' : 'recover-residue' })
      throw new McpLifecycleError(cleanup.status === 'cleaned' ? diagnostic.code : cleanup.status, cause, {
        status: cleanup.status === 'cleaned' ? (probe ? 'probe-failed' : 'mount-failed') : cleanup.status,
        secrets: input.secrets,
        cleanup,
        action: cleanup.status === 'cleaned' ? 'retry' : 'recover-residue',
      })
    } finally {
      if (!succeeded && bridgeReady && typeof input.afterCleanup === 'function') await input.afterCleanup({ groupId: options.id, identity, generation, probe })
      if (succeeded && probe && typeof input.afterProbeReady === 'function') await input.afterProbeReady({ groupId: options.id, identity, generation })
    }
  }

  async function unmountOne(identity, guards = {}, context = {}) {
    const entry = mounted.get(identity)
    if (!entry && context.required === true) return { status: 'cleanup-unknown', removed: false, reason: 'mount-record-missing' }
    const groupId = entry?.groupId ?? `${MCP_GROUP_PREFIX}${identity}`
    const cleanup = await disposeGroup(groupId, { ...context, identity, generation: entry?.generation, tree: context.tree ?? treeFor(Boolean(context.secretBearing)) })
    if (cleanup.status !== 'cleaned') {
      if (entry) entry.state = cleanup.status
      return cleanup
    }
    if (typeof guards.alive === 'function' && typeof guards.remount === 'function') {
      for (const [other] of mounted) {
        const siblingGroup = `${MCP_GROUP_PREFIX}${other}`
        if (!guards.alive().includes(siblingGroup)) {
          onError(`sibling-vanished-after-unmount:${other}`)
          await guards.remount(other)
        }
      }
    }
    return { status: 'cleaned', removed: Boolean(entry) || cleanup.removed, groupId }
  }

  async function probe(input) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
    const identity = input.identity ?? `probe-${suffix}`
    const serverName = input.serverName ?? `probe${suffix}`
    const client = { ...input.client, serverName }
    let ready
    try {
      ready = await mountOne({ ...input, identity, client, generation: input.generation ?? 0, probe: true })
    } catch (cause) {
      if (cause instanceof McpLifecycleError) throw cause
      throw new McpLifecycleError('probe-failed', cause, { status: 'probe-failed', secrets: input.secrets })
    }
    try {
      const cleanup = await disposeGroup(ready.groupId, { tree: treeFor(Boolean(input.secretBearing)), identity, generation: ready.generation, secretBearing: Boolean(input.secretBearing), confirmClosed: input.confirmClosed, requireCapture: true })
      if (cleanup.status !== 'cleaned') return { status: cleanup.status, identity, generation: ready.generation, cleanup, diagnostic: cleanup.diagnostic }
      if (typeof input.afterCleanup === 'function') await input.afterCleanup({ groupId: ready.groupId, identity, generation: ready.generation, probe: true, cleanup })
      return { ...ready, status: 'mounted', cleanup }
    } catch (cause) {
      throw new McpLifecycleError('cleanup-failed', cause, { status: 'cleanup-failed', secrets: input.secrets, action: 'recover-residue' })
    }
  }

  const queues = new Map()
  function serialize(identity, task) {
    const previous = queues.get(identity) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => {})
    queues.set(identity, tail)
    tail.then(() => { if (queues.get(identity) === tail) queues.delete(identity) })
    return run
  }
  const mount = input => input?.probe ? mountOne(input) : serialize(input.identity, () => mountOne(input))
  const unmount = (identity, guards = {}, context = {}) => serialize(identity, () => unmountOne(identity, guards, context))

  return { mount, unmount, probe, sweepResidue, disposeGroup, mounted, entriesFor, message }
}
