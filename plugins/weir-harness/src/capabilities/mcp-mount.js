// Managed MCP Loader lifecycle. Registry configuration is the authority; the
// stock client is named by string and never statically imported.
import { randomUUID } from 'node:crypto'
import { isSegment } from './store/paths.js'
import { McpLifecycleError, mcpDiagnostic } from './mcp-diagnostics.js'
import {
  MCP_GROUP_PREFIX,
  createMcpMountOwnership,
  isMcpResidueId,
  isSuffixedMcpGroupId,
  resolveMcpGroupIdentity,
} from './mcp-mount-ownership.js'

export { MCP_GROUP_PREFIX, isMcpResidueId } from './mcp-mount-ownership.js'

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

export function mcpGroupOptions({ identity, generation, client, groupId = null }) {
  if (!isSegment(identity)) throw new TypeError(`invalid MCP server identity: ${JSON.stringify(identity)}`)
  const group = groupId ?? `${MCP_GROUP_PREFIX}${identity}`
  if (!isMcpResidueId(group)) throw new TypeError(`invalid actual MCP groupId: ${JSON.stringify(group)}`)
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

function nonWritingTree(tree, { scoped = false } = {}) {
  const root = tree?.root
  if (tree?.root?.tree !== tree || typeof root?.create !== 'function' || typeof root?.remove !== 'function'
    || typeof tree?.await !== 'function' || typeof tree?.resolve !== 'function'
    || typeof tree?.entries !== 'function' || !tree?.store || typeof tree.store !== 'object') {
    return { kind: 'unsupported', reason: 'ephemeral-loader-unavailable' }
  }
  return {
    kind: 'ok',
    tree: {
      ephemeral: true,
      scoped,
      source: tree,
      store: tree.store,
      create: options => root.create(options),
      remove: id => root.remove(id),
      entries: () => [...tree.entries()],
      resolve: id => tree.resolve(id),
      await: () => tree.await(),
    },
  }
}

/** The exact retained-revision seam proven by the real scoped-tree canary. */
export function resolveScopedMcpTree(tree) {
  return nonWritingTree(tree, { scoped: true })
}

/**
 * The stock EntryTree methods write through their tree. Its root EntryGroup
 * methods only mutate the runtime store, which is the non-profile-writing seam
 * used for materialized secrets. Any other shape is unsupported, never a
 * fallback to the write-through tree.
 */
export function resolveEphemeralMcpTree(loader) {
  return nonWritingTree(loader?.root?.tree)
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

export function createMcpMount({
  loader,
  onError = () => {},
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT,
  ephemeralTree,
  ownership = createMcpMountOwnership(),
} = {}) {
  /** @type {Map<string, { groupId: string, generation: number, state?: string }>} */
  const mounted = new Map()
  const holder = {}
  const scopedTrees = new Set()

  const legacyTree = () => {
    if (typeof loader?.create !== 'function' || typeof loader?.remove !== 'function') {
      throw new McpLifecycleError('unsupported', new Error('MCP Loader lifecycle is unavailable'), { status: 'unsupported' })
    }
    return {
      ephemeral: false,
      scoped: false,
      source: loader,
      store: loader.store,
      create: options => loader.create(options),
      remove: id => loader.remove(id),
      entries: typeof loader.entries === 'function' ? () => [...loader.entries()] : null,
      resolve: typeof loader.resolve === 'function' ? id => loader.resolve(id) : null,
      await: typeof loader.await === 'function' ? () => loader.await() : async () => {},
    }
  }

  const hostTree = () => {
    const resolved = resolveEphemeralMcpTree(loader)
    return resolved.kind === 'ok' ? resolved.tree : legacyTree()
  }

  const treeFor = secretBearing => {
    // An explicitly retained/revision-scoped tree is mandatory. If its proven
    // non-writing shape is unavailable, fail closed rather than silently
    // reintroducing a shared-root same-identity collision.
    if (ephemeralTree !== undefined && ephemeralTree?.kind !== 'ok') {
      throw new McpLifecycleError('unsupported', new Error('revision-scoped MCP mount requires its proven non-profile-writing PresetTree'), { status: 'unsupported', action: 'recover-residue' })
    }
    const resolved = ephemeralTree === undefined ? resolveEphemeralMcpTree(loader) : ephemeralTree
    if (resolved?.kind === 'ok' && resolved.tree) {
      if (resolved.tree.scoped) scopedTrees.add(resolved.tree)
      return resolved.tree
    }
    if (secretBearing) throw new McpLifecycleError('unsupported', new Error('secret-bearing MCP mount requires a proven non-profile-writing Loader root group'), { status: 'unsupported', action: 'use-secret-free-config' })
    // Compatibility for secret-free legacy records only.
    return legacyTree()
  }

  function entriesWithTree(tree, groupId) {
    const localId = entry => entry?.options?.id ?? entry?.id
    if (typeof tree?.entries === 'function') {
      return [...tree.entries()].filter(entry => {
        const id = localId(entry)
        return id === groupId || String(id ?? '').startsWith(`${groupId}:`)
          || id === `${groupId}-facade` || id === `${groupId}-client`
      })
    }
    if (tree?.store && typeof tree.store === 'object') {
      return Object.values(tree.store).filter(entry => {
        const id = localId(entry)
        return id === groupId || id === `${groupId}-facade` || id === `${groupId}-client`
      })
    }
    return null
  }

  function treeForGroup(groupId) {
    return ownership.forGroup(groupId)?.tree ?? null
  }

  function residueTree(groupId) {
    const owned = treeForGroup(groupId)
    if (owned) return owned
    if (!loader) return treeFor(false)
    const host = hostTree()
    const hostEntries = entriesWithTree(host, groupId)
    if (hostEntries?.some(entry => (entry?.options?.id ?? entry?.id) === groupId)) return host
    return treeFor(false)
  }

  function entriesFor(groupId, tree = null) {
    return entriesWithTree(tree ?? residueTree(groupId), groupId)
  }

  function forgetGroup(groupId, generation) {
    for (const [identity, entry] of mounted) {
      if (entry.groupId === groupId && (!generation || entry.generation === generation)) mounted.delete(identity)
    }
  }

  function track(record, promise) {
    const pending = Promise.resolve(promise)
    if (!record) return pending
    record.pending.add(pending)
    pending.then(() => record.pending.delete(pending), () => record.pending.delete(pending))
    return pending
  }

  function failedCleanup(groupId, status, cause, record = null) {
    if (record) ownership.transition(record, status)
    return {
      status, removed: false, groupId,
      diagnostic: mcpDiagnostic(cause, { code: status, action: 'recover-residue' }),
    }
  }

  async function finishCleaned(groupId, context, record, removed) {
    forgetGroup(groupId, context.generation)
    try {
      if (typeof context.afterCleanup === 'function') {
        await context.afterCleanup({
          groupId, identity: context.identity, generation: context.generation,
          probe: context.probe === true, owner: record?.owner,
        })
      }
    } catch (cause) {
      return failedCleanup(groupId, 'cleanup-failed', cause, record)
    }
    if (record && !ownership.release(record, { provenAbsent: true })) {
      return failedCleanup(groupId, 'cleanup-unknown', new Error('MCP mount ownership still has unresolved create/disposal work'), record)
    }
    return { status: 'cleaned', removed, groupId }
  }

  /**
   * Capture and settle group/client/descendant fibers BEFORE removing rows.
   * remove() is not the barrier: its return does not await async plugin
   * disposal. A rejected disposal or an unconfirmed close blocks same-name
   * replacement and leaves enough state for residue recovery.
   */
  async function disposeGroup(groupId, context = {}) {
    const record = ownership.forGroup(groupId)
    if (record && record.holder !== holder) {
      return failedCleanup(groupId, 'cleanup-unknown', new Error('cannot dispose a foreign active MCP mount owner'))
    }
    const tree = context.tree ?? record?.tree ?? residueTree(groupId)
    if (record?.pending.size) {
      try {
        await bounded(Promise.allSettled([...record.pending]), cleanupTimeoutMs, 'cleanup-timeout', `MCP pending create/disposal ${groupId}`)
      } catch (cause) {
        return failedCleanup(groupId, 'cleanup-unknown', cause, record)
      }
      if (record.pending.size > 0) return failedCleanup(groupId, 'cleanup-unknown', new Error('MCP create/disposal has not settled'), record)
    }
    const captured = entriesWithTree(tree, groupId)
    if (captured?.length === 0) {
      if (context.requireCapture === true && context.createTimedOut === true && record?.pending.size) {
        return failedCleanup(groupId, 'cleanup-unknown', new Error('MCP create settlement is not proven'), record)
      }
      return finishCleaned(groupId, context, record, false)
    }
    if (captured === null && (context.requireCapture === true || context.createTimedOut === true)) {
      return failedCleanup(groupId, 'cleanup-unknown', new Error('cannot capture Loader fibers for disposal'), record)
    }
    const fibers = (captured ?? []).map(entry => entry?.fiber).filter(Boolean)
    const disposals = fibers.map((fiber, index) => {
      try {
        const disposal = track(record, fiber.dispose?.())
        return bounded(disposal, cleanupTimeoutMs, 'cleanup-timeout', `MCP disposal ${groupId}[${index}]`)
      } catch (cause) {
        return Promise.reject(cause)
      }
    })
    const settled = await Promise.allSettled(disposals)
    const rejected = settled.find(result => result.status === 'rejected')
    if (rejected) {
      const status = rejected.reason?.code === 'cleanup-timeout' ? 'cleanup-unknown' : 'cleanup-failed'
      return failedCleanup(groupId, status, rejected.reason, record)
    }
    try {
      const removing = track(record, tree.remove(groupId))
      await bounded(removing, cleanupTimeoutMs, 'cleanup-timeout', `MCP Loader remove ${groupId}`)
    } catch (cause) {
      const status = cause?.code === 'cleanup-timeout' ? 'cleanup-unknown' : 'cleanup-failed'
      return failedCleanup(groupId, status, cause, record)
    }
    const remaining = entriesWithTree(tree, groupId)
    let closeConfirmed = remaining === null ? true : remaining.length === 0
    if (typeof context.confirmClosed === 'function') {
      try {
        closeConfirmed = closeConfirmed && await bounded(context.confirmClosed({ groupId, entries: captured, fibers }), cleanupTimeoutMs, 'cleanup-timeout', `MCP close confirmation ${groupId}`) === true
      } catch (cause) {
        return failedCleanup(groupId, 'cleanup-unknown', cause, record)
      }
    } else if (captured !== null) {
      closeConfirmed = closeConfirmed && fibers.every(fiber => fiber.uid === null || fiber.state === 4 || fiber.state === 5)
    }
    if (!closeConfirmed || remaining === null && context.requireCapture === true) {
      return failedCleanup(groupId, 'cleanup-unknown', new Error('MCP transport closure or Loader row removal could not be confirmed'), record)
    }
    return finishCleaned(groupId, context, record, true)
  }

  function identityForGroup(groupId) {
    const entries = entriesFor(groupId)
    const exact = entries?.find(entry => (entry?.options?.id ?? entry?.id) === groupId)
    // The manager's own plugin ID is residue-shaped but is not a Loader group.
    // Never claim/dispose a standalone row merely because its ID has the prefix.
    if (exact && exact.options?.group !== true) return null
    const row = exact ?? { id: groupId }
    return resolveMcpGroupIdentity({ groupId, mounted, ownership, row })
  }

  async function sweepResidueDetailed(candidateIds, context = {}) {
    const swept = []
    const blocked = []
    const foreign = []
    const unresolved = []
    for (const id of candidateIds.filter(isMcpResidueId)) {
      let record = ownership.forGroup(id)
      if (record && record.holder !== holder) {
        foreign.push(id)
        continue
      }
      const resolved = identityForGroup(id)
      if (!resolved) {
        unresolved.push(id)
        continue
      }
      const tree = record?.tree ?? residueTree(id)
      if (!record) {
        const captured = entriesWithTree(tree, id)
        const activeUnknown = captured?.some(entry => {
          const entryId = entry?.options?.id ?? entry?.id
          if (entryId === id) return false // the container may be active while every child is disabled residue
          const fiber = entry?.fiber
          return fiber && fiber.uid !== null && fiber.state !== 4 && fiber.state !== 5
        })
        // A facade/config row without a module-realm owner may belong to another
        // loaded bundle instance. Active cross-module ownership is unprovable:
        // retain it instead of sweeping a foreign live client.
        if (activeUnknown) {
          foreign.push(id)
          continue
        }
        record = ownership.claimResidue({ identity: resolved.identity, groupId: id, holder, tree })
      }
      if (!record) {
        foreign.push(id)
        continue
      }
      const cleanup = await disposeGroup(id, {
        tree, identity: resolved.identity, secretBearing: false,
        afterCleanup: context.afterCleanup,
        requireCapture: isSuffixedMcpGroupId(id) || tree.scoped === true,
      })
      if (cleanup.status === 'cleaned') swept.push(id)
      else {
        blocked.push(id)
        onError(`residue-sweep-${cleanup.status}:${id}`, cleanup.diagnostic)
      }
    }
    return { swept, blocked, foreign, unresolved }
  }

  async function sweepResidue(candidateIds, context = {}) {
    return (await sweepResidueDetailed(candidateIds, context)).swept
  }

  async function mountOne(input) {
    const { identity, generation, fiberOf, probe = false, secretBearing = false } = input
    if (!isSegment(identity)) throw new TypeError(`invalid MCP server identity: ${JSON.stringify(identity)}`)
    const previous = mounted.get(identity)
    if (!probe && (previous?.state === 'cleanup-failed' || previous?.state === 'cleanup-unknown')) {
      throw new McpLifecycleError(previous.state, new Error(`same-name MCP replacement is blocked while ${identity} is ${previous.state}`), { status: previous.state, action: 'recover-residue' })
    }
    const tree = treeFor(secretBearing)
    let record = null
    let options = null
    let bridgeReady = false
    let createStarted = false
    let cleanup = null
    let succeeded = false
    try {
      record = ownership.claim(identity, {
        holder, tree,
        available: groupId => {
          const existing = entriesWithTree(tree, groupId)
          if (existing?.length) return false
          if (tree.scoped && loader) {
            const hostEntries = entriesWithTree(hostTree(), groupId)
            if (hostEntries?.length) return false
          }
          return true
        },
      })
      options = mcpGroupOptions({ identity, generation, groupId: record.groupId, client: strictMcpClientConfig(input.client, { probe }) })
      const attempt = () => ({ groupId: options.id, identity, generation, probe, ephemeral: tree.ephemeral === true, owner: record.owner })
      if (typeof input.beforeCreate === 'function') await input.beforeCreate(attempt())
      bridgeReady = true
      // A foreign module realm may have claimed the group while an async
      // beforeCreate callback yielded. Never dispose that row as our residue.
      const collision = entriesWithTree(tree, options.id)
      if (collision?.length) throw Object.assign(new Error(`MCP Loader group ${options.id} was claimed by another owner`), { code: 'duplicate-mcp-group-owner' })
      createStarted = true
      // The claim above occupies the actual ID synchronously before this call;
      // its original promise remains tracked even if the bounded wait times out.
      const creating = track(record, tree.create(options))
      await bounded(creating, startupTimeoutMs, 'startup-timeout', `MCP Loader create ${identity}`)
      await bounded(tree.await(), startupTimeoutMs, 'startup-timeout', `MCP Loader await ${identity}`)
      const fiber = typeof fiberOf === 'function'
        ? await bounded(fiberOf(options.id, { tree, owner: record.owner }), startupTimeoutMs, 'startup-timeout', `MCP client readiness ${identity}`)
        : { state: 'running' }
      if (fiber === null || fiber === undefined) throw new Error('mcp-mount-error: client entry has no fiber after loader.await()')
      if (fiber.state !== undefined && !['running', 'active', 2].includes(fiber.state)) throw new Error(`mcp-mount-error: client fiber is not ready (state ${String(fiber.state)})`)
      const clientEntry = tree.store?.[`${options.id}-client`]
      if (clientEntry?.error) throw clientEntry.error
      if (typeof input.readback === 'function') await input.readback(attempt())
      const discovery = typeof input.discovery === 'function' ? await input.discovery(attempt()) : { toolCount: null, toolNamesPreview: [], truncated: false }
      const result = { status: 'mounted', groupId: options.id, identity, generation, probe, discovery, execution: input.execution ?? null }
      if (!probe) mounted.set(identity, { groupId: options.id, generation, state: 'mounted' })
      ownership.transition(record, 'mounted')
      succeeded = true
      return result
    } catch (cause) {
      if (!createStarted && record) {
        cleanup = await finishCleaned(options.id, {
          identity, generation, probe,
          afterCleanup: bridgeReady ? input.afterCleanup : null,
        }, record, false)
      } else if (options) {
        cleanup = await disposeGroup(options.id, {
          tree, identity, generation, probe, secretBearing,
          confirmClosed: input.confirmClosed,
          createTimedOut: cause?.code === 'startup-timeout' && createStarted,
          requireCapture: cause?.code === 'startup-timeout' && createStarted,
          afterCleanup: bridgeReady ? input.afterCleanup : null,
        })
      }
      if (!probe && cleanup && cleanup.status !== 'cleaned') mounted.set(identity, { groupId: options.id, generation, state: cleanup.status })
      const diagnostic = mcpDiagnostic(cause, { secrets: input.secrets, action: cleanup?.status === 'cleaned' ? 'retry' : 'recover-residue' })
      throw new McpLifecycleError(cleanup?.status === 'cleaned' ? diagnostic.code : cleanup?.status ?? 'mount-failed', cause, {
        status: cleanup?.status === 'cleaned' ? (probe ? 'probe-failed' : 'mount-failed') : cleanup?.status ?? 'mount-failed',
        secrets: input.secrets,
        cleanup,
        action: cleanup?.status === 'cleaned' ? 'retry' : 'recover-residue',
      })
    } finally {
      if (succeeded && probe && typeof input.afterProbeReady === 'function') await input.afterProbeReady({ groupId: options.id, identity, generation, owner: record.owner })
    }
  }

  async function unmountOne(identity, guards = {}, context = {}) {
    const entry = mounted.get(identity)
    if (!entry) {
      if (context.required === true) return { status: 'cleanup-unknown', removed: false, reason: 'mount-record-missing' }
      // Ordinary cleanup is not residue recovery: without our exact mount record
      // there is no authority to infer and delete a possibly reused legacy ID.
      return { status: 'cleaned', removed: false, groupId: null }
    }
    const groupId = entry.groupId
    const cleanup = await disposeGroup(groupId, {
      ...context, identity, generation: entry.generation,
      tree: context.tree ?? treeForGroup(groupId) ?? treeFor(Boolean(context.secretBearing)),
    })
    if (cleanup.status !== 'cleaned') {
      entry.state = cleanup.status
      return cleanup
    }
    if (typeof guards.alive === 'function' && typeof guards.remount === 'function') {
      for (const [other, sibling] of mounted) {
        if (!guards.alive().includes(sibling.groupId)) {
          onError(`sibling-vanished-after-unmount:${other}`)
          await guards.remount(other)
        }
      }
    }
    return { status: 'cleaned', removed: true, groupId }
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
    const record = ownership.forGroup(ready.groupId)
    const cleanup = await disposeGroup(ready.groupId, {
      tree: record?.tree ?? treeFor(Boolean(input.secretBearing)), identity, generation: ready.generation,
      probe: true, secretBearing: Boolean(input.secretBearing), confirmClosed: input.confirmClosed,
      requireCapture: true, afterCleanup: input.afterCleanup,
    })
    if (cleanup.status !== 'cleaned') return { status: cleanup.status, identity, generation: ready.generation, cleanup, diagnostic: cleanup.diagnostic }
    return { ...ready, status: 'mounted', cleanup }
  }

  function listRows() {
    const rows = []
    for (const tree of scopedTrees) {
      for (const entry of tree.entries()) {
        const options = entry?.options ?? {}
        const id = options.id ?? entry?.id
        if (!isMcpResidueId(id) || options.group !== true) continue
        rows.push({ id, name: options.name ?? null, config: options.config ?? {} })
      }
    }
    return rows
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

  return {
    mount, unmount, probe, sweepResidue, sweepResidueDetailed, disposeGroup,
    mounted, entriesFor, identityForGroup, listRows, treeForGroup, ownership, message,
  }
}
