// Real-Host same-preset retained-revision proof for mcp-management-deepening 1.5.
// The primary phase uses different managed identities. Separate real regressions
// require same-identity old/new discovery, RPC and owner-safe cleanup in both orders.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpRegistry } from '../../weir-harness/src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../../weir-harness/src/capabilities/store/store.js'
import { lifecycleFeedRegistry } from '../../weir-harness/src/capabilities/lifecycle-feed.js'
import { mcpFacadeBridgeFor } from '../../weir-harness/src/capabilities/mcp-facade-plugin.js'
import { scopedPresetTreeCaptures } from './scoped-preset-tree-capture.js'
import { beginOrder, setPhase, snapshotSummary } from './capability-lifecycle-dual-state.js'

export const name = 'capability-lifecycle-retained-revision-probe'
export const inject = ['tools', 'skills', 'agents', 'agentPresets']

const ROOT = process.env.WEIR_IT_ROOT
const MOCK_SERVER = fileURLToPath(new URL('./mock-mcp-server.mjs', import.meta.url))
const SLOTS = ['old', 'new']
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const errorText = error => String(error?.stack ?? error?.message ?? error)
const toolFor = identity => `mcp__${identity}__echo`

async function serverEntries(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  } catch { return [] }
}

async function rpcCount(path) {
  return (await serverEntries(path)).filter(entry => entry.kind === 'mcp-server-rpc' && entry.method === 'tools/call').length
}

function lifecycleTags(events, sessionId) {
  return [...new Set(events.filter(event => event.kind === 'lifecycle-resolve' && event.sessionId === sessionId).map(event => event.lifecycleTag))]
}

function snapshotFacts(snapshot) {
  return {
    ...snapshotSummary(snapshot),
    skillNames: Array.isArray(snapshot?.skills) ? snapshot.skills.map(identity => identity?.name ?? null) : null,
  }
}

async function durableFacts(store, sessionId) {
  const compact = record => ({
    kind: record.kind,
    revision: record.revision ?? 0,
    ...(record.kind === 'ok' ? {
      skillNames: Array.isArray(record.payload?.skills) ? record.payload.skills.map(identity => identity?.name ?? null) : null,
      mcpServers: Array.isArray(record.payload?.mcpServers) ? [...record.payload.mcpServers] : null,
      mcpIncarnations: record.payload?.mcpIncarnations ? { ...record.payload.mcpIncarnations } : null,
    } : {}),
  })
  return {
    selection: compact(await store.read({ kind: 'selection', sessionId })),
    inherited: compact(await store.read({ kind: 'inherited', sessionId })),
  }
}

function isExpectedStartupHistory(error) {
  return error?.identity === null && error.reason === 'registry-absent' && error.swept === 0 && Object.keys(error).length === 3
}

async function validateInitialEmptyRegistry(manager, registry, runId, slot) {
  const deadline = Date.now() + 15_000
  let emptySince = null
  let current = null
  while (Date.now() < deadline) {
    if (manager.startErrors.length > 0) {
      if (manager.startErrors.length === 1 && isExpectedStartupHistory(manager.startErrors[0])) return
      throw new Error(`unexpected initial startup history for ${runId}/${slot}: ${JSON.stringify(manager.startErrors)}`)
    }
    current = await registry.read()
    const empty = manager.mounted.size === 0 && current.kind === 'ok' && Object.keys(current.servers ?? {}).length === 0
    if (empty && emptySince !== null && Date.now() - emptySince >= 10) return
    emptySince = empty ? emptySince ?? Date.now() : null
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`manager ${runId}/${slot} did not settle at an isolated empty registry: ${JSON.stringify({ startErrors: manager.startErrors, mounted: [...manager.mounted.keys()], registry: current })}`)
}

function serverEntry(identity, serverLog) {
  return {
    identity,
    label: `Retained lifecycle ${identity} stdio fixture`,
    owner: { kind: 'workspace', key: 'ws' },
    generation: 0,
    configuredAt: 0,
    transport: { kind: 'stdio', ref: `mock://${identity}` },
    client: {
      transport: 'stdio',
      serverName: identity,
      command: process.execPath,
      args: [MOCK_SERVER, identity],
      env: { WEIR_IT_MCP_LOG: serverLog, WEIR_IT_MCP_ORIGIN: 'managed' },
      reconnect: { enabled: true },
    },
  }
}

function createFixture(ctx, report, { runId, presetId, identityFor }) {
  const cwd = join(ROOT, 'ws')
  const serverLog = join(cwd, `${runId}.jsonl`)
  const state = beginOrder(runId, SLOTS)
  const presetRegistry = ctx.get('agentPresets')
  const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
  const registry = createMcpRegistry({ store })
  const agents = new Map()
  const managers = new Map()
  const trees = new Map()
  const handles = new Map()
  const unregister = new Map()
  const disposed = new Set()
  const unregistered = new Set()
  const runtimeAttempted = new Set()
  const runtimeRemoved = new Set()
  const registryRemoved = new Set()
  const placeholders = new Map()
  const generations = new Map()
  const groupIds = new Map()
  report.runId = runId
  report.presetId = presetId
  report.serverLog = serverLog
  report.registrations = []
  report.sessions = {}
  report.cleanup = { errors: [], removals: {}, registryRemovals: {} }

  if (!presetRegistry) throw new Error('real agent preset registry is unavailable')

  function definition(slot, root) {
    const selectionRow = fileURLToPath(new URL('./capability-lifecycle-selection-fixture.js', import.meta.url))
    const observerRow = fileURLToPath(new URL('./capability-lifecycle-manager-observer.js', import.meta.url))
    const treeCaptureRow = fileURLToPath(new URL('./scoped-preset-tree-capture.js', import.meta.url))
    return {
      id: presetId,
      name: `Retained ${presetId} ${slot}`,
      plugins: [{
        id: `capabilities-${slot}`,
        name: 'cordis:group',
        group: true,
        isolate: { weirMcpGate: true, weirMcpManager: true },
        config: [
          { id: `selection-${slot}`, name: selectionRow, config: { orderId: runId, presetId: slot, root, baselineScopes: ['weir-builtin', 'custom'] } },
          { id: `manager-${slot}`, name: 'weir-harness/mcp-manager', config: { startupTimeoutMs: 15000 } },
          { id: `observer-${slot}`, name: observerRow, config: { orderId: runId, presetId: slot } },
        ],
      }, {
        id: `tree-capture-${slot}`,
        name: treeCaptureRow,
        config: { key: `${runId}:${slot}` },
      }, {
        id: `skill-tool-${slot}`,
        name: '@deepseek-ai/dsh-tool-skill',
      }],
    }
  }

  async function prepareRoots() {
    for (const slot of SLOTS) {
      const root = join(cwd, `${runId}-skills-${slot}`)
      await mkdir(join(root, `only-${runId}-${slot}`), { recursive: true })
      await writeFile(join(root, `only-${runId}-${slot}`, 'SKILL.md'), `---\nname: only-${runId}-${slot}\ndescription: ${runId} ${slot} lifecycle fixture\n---\nOWNER_${runId}_${slot}\n`)
    }
    for (const slot of SLOTS) {
      const identity = identityFor(slot)
      if (placeholders.has(identity)) continue
      placeholders.set(identity, ctx.tools.register({
        name: toolFor(identity),
        description: `UNMANAGED_PLACEHOLDER ${identity}`,
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: [] },
        output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: `UNMANAGED_PLACEHOLDER ${identity}` }] },
        async execute() { throw new Error(`UNMANAGED_PLACEHOLDER ${identity}`) },
      }))
    }
  }

  async function mountRevision(slot) {
    setPhase(runId, `mount:${slot}`)
    const root = join(cwd, `${runId}-skills-${slot}`)
    unregister.set(slot, await presetRegistry.register(definition(slot, root)))
    const resolved = await presetRegistry.resolve(presetId)
    const manager = state.managers.get(slot)
    report.registrations.push({
      slot,
      presetId: resolved.id,
      broken: resolved.broken ?? null,
      managerObserved: Boolean(manager),
      selectionObserved: state.selections.has(slot),
      retainedCompositions: presetRegistry.inspectCompositions().map(entry => entry.id),
    })
    if (resolved.broken) throw new Error(`preset ${presetId}/${slot} failed to mount: ${resolved.broken}`)
    if (!manager) throw new Error(`observer found no manager for ${runId}/${slot}`)
    const tree = scopedPresetTreeCaptures.get(`${runId}:${slot}`)?.tree
    if (!tree) throw new Error(`scoped PresetTree capture found no owning tree for ${runId}/${slot}`)
    trees.set(slot, tree)
    const pending = state.managerStarts.get(slot) ?? manager.start()
    await pending
    await validateInitialEmptyRegistry(manager, registry, runId, slot)
  }

  async function createAgent(slot) {
    setPhase(runId, `create:${slot}`)
    const sessionId = randomUUID()
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd, agentPreset: presetId },
      setup: agentCtx => presetRegistry.mount(agentCtx, presetId).then(() => undefined),
    })
    handles.set(slot, handle)
    const agent = handle.agent
    const manager = presetRegistry.serviceFor(agent, 'weirMcpManager')
    if (!manager) throw new Error(`serviceFor found no manager for ${runId}/${slot}`)
    agents.set(slot, agent)
    managers.set(slot, manager)
    report.sessions[slot] = {
      slot,
      sessionId,
      composedPreset: presetRegistry.composedPreset(agent.ctx),
      serviceForMatchesObserver: manager === state.managers.get(slot),
      exactAgentCompositions: presetRegistry.inspectCompositions(agent.ctx).map(entry => entry.id),
    }
  }

  async function resolveInitial(slot) {
    const agent = agents.get(slot)
    setPhase(runId, `initial-selection:${slot}`)
    const skills = await ctx.skills.list({ cwd, scope: agent })
    managers.get(slot).syncSession(agent.id)
    return { skillNames: skills.map(skill => skill.name), ...(await measure(slot)) }
  }

  async function measure(slot) {
    const agent = agents.get(slot)
    const manager = managers.get(slot)
    const ownLifecycle = state.selections.get(slot)?.lifecycle
    const marker = state.events.length
    const feedLifecycle = lifecycleFeedRegistry.lifecycleFor(manager)
    const resolved = feedLifecycle?.snapshotFor?.(agent.id)
    const feedEvents = state.events.slice(marker)
    return {
      memory: snapshotFacts(ownLifecycle?.peek(agent.id)),
      durable: await durableFacts(store, agent.id),
      feed: {
        present: Boolean(feedLifecycle),
        matchesOwn: feedLifecycle === ownLifecycle,
        resolved: snapshotFacts(resolved),
        lifecycleTags: lifecycleTags(feedEvents, agent.id),
      },
    }
  }

  async function gateEvidence(slot) {
    const agent = agents.get(slot)
    const manager = managers.get(slot)
    const identity = identityFor(slot)
    const generation = generations.get(slot)
    setPhase(runId, `gate:${slot}`)
    let marker = state.events.length
    const enabledFor = manager.gate.enabledFor(agent, identity)
    const enabledEvents = state.events.slice(marker)
    marker = state.events.length
    const permit = await manager.gate.permit(agent, identity, generation)
    const permitEvents = state.events.slice(marker)
    return {
      identity,
      generation,
      enabledFor,
      permit: clone(permit),
      admitted: permit !== null,
      assertPermit: permit === null ? false : manager.gate.assertPermit(permit),
      lifecycle: {
        enabledFor: lifecycleTags(enabledEvents, agent.id),
        permit: lifecycleTags(permitEvents, agent.id),
      },
    }
  }

  function visibility(slot) {
    const identity = identityFor(slot)
    const schema = ctx.tools.schemas(agents.get(slot)).find(tool => tool.name === toolFor(identity))
    return {
      toolName: toolFor(identity),
      visible: typeof schema?.description === 'string' && schema.description.includes(`echo from ${identity} (managed)`),
      placeholderVisible: typeof schema?.description === 'string' && schema.description.includes(`UNMANAGED_PLACEHOLDER ${identity}`),
      managedSchema: clone(schema),
    }
  }

  async function call(slot, marker, phase = `call:${slot}`) {
    const agent = agents.get(slot)
    const identity = identityFor(slot)
    const before = await rpcCount(serverLog)
    const eventMarker = state.events.length
    setPhase(runId, phase)
    let outcome
    let thrown = null
    try {
      outcome = await ctx.tools.execute({
        callId: randomUUID(),
        name: toolFor(identity),
        arguments: { text: marker },
        agent,
        signal: new AbortController().signal,
      })
    } catch (error) { thrown = errorText(error) }
    const after = await rpcCount(serverLog)
    const matchingRpc = (await serverEntries(serverLog)).filter(entry => entry.method === 'tools/call' && JSON.stringify(entry.params ?? {}).includes(marker))
    return {
      identity,
      marker,
      outcome: clone(outcome) ?? null,
      thrown,
      rpcBefore: before,
      rpcAfter: after,
      rpcDelta: after - before,
      matchingRpc: clone(matchingRpc),
      resultObserved: JSON.stringify(outcome ?? thrown ?? {}).includes(`RESULT server=${identity}`),
      lifecycleTags: lifecycleTags(state.events.slice(eventMarker), agent.id),
    }
  }

  async function siblingFacts(slot) {
    return {
      memory: snapshotFacts(state.selections.get(slot)?.lifecycle.peek(agents.get(slot)?.id)),
      durable: await durableFacts(store, agents.get(slot).id),
      gate: await gateEvidence(slot),
    }
  }

  async function adopt(slot) {
    const identity = identityFor(slot)
    setPhase(runId, `adopt:${slot}`)
    runtimeAttempted.add(slot)
    const outcome = await managers.get(slot).adopt(serverEntry(identity, serverLog))
    groupIds.set(slot, managers.get(slot).mounted.get(identity)?.groupId ?? `weir-mcp-${identity}`)
    const current = await registry.read()
    const entry = current.kind === 'ok' ? current.servers?.[identity] : null
    generations.set(slot, entry?.generation ?? null)
    return { outcome: clone(outcome), registryEntry: clone(entry) }
  }

  async function reconcileSame(slot, entry) {
    setPhase(runId, `same-identity-reconcile:${slot}`)
    runtimeAttempted.add(slot)
    const outcome = await managers.get(slot).reconcileOne(identityFor(slot), entry)
    groupIds.set(slot, managers.get(slot).mounted.get(identityFor(slot))?.groupId ?? `weir-mcp-${identityFor(slot)}`)
    generations.set(slot, entry.generation)
    return clone(outcome)
  }

  async function apply(slot) {
    const agent = agents.get(slot)
    const selection = state.selections.get(slot)
    const identity = identityFor(slot)
    const siblingSlot = slot === 'old' ? 'new' : 'old'
    const before = snapshotFacts(selection.lifecycle.peek(agent.id))
    const siblingBefore = await siblingFacts(siblingSlot)
    const eventMarker = state.events.length
    setPhase(runId, `apply:${slot}`)
    const outcome = await selection.applySelection(
      { sessionId: agent.id, cwd, presetId },
      {
        requestId: `${runId}-${slot}-apply`,
        expectedRevision: before.revision ?? 0,
        selection: { skills: clone(before.skillNames ? selection.lifecycle.peek(agent.id).skills : []), mcpServers: [identity] },
        unresolved: [],
      },
    )
    const events = state.events.slice(eventMarker)
    const publishes = events.filter(event => event.kind === 'lifecycle-publish' && event.presetId === slot && event.sessionId === agent.id)
    const syncs = events.filter(event => event.kind === 'manager-sync' && event.presetId === slot && event.sessionId === agent.id)
    return {
      outcome: clone(outcome),
      memory: snapshotFacts(selection.lifecycle.peek(agent.id)),
      durable: await durableFacts(store, agent.id),
      publication: {
        publishCount: publishes.length,
        publishSeq: publishes[0]?.seq ?? null,
        syncCount: syncs.length,
        syncSeq: syncs[0]?.seq ?? null,
        syncSnapshot: syncs[0]?.snapshot ?? null,
      },
      sibling: { slot: siblingSlot, before: siblingBefore, after: await siblingFacts(siblingSlot) },
      gate: await gateEvidence(slot),
      visibility: visibility(slot),
    }
  }

  function bridgeEvidence(slot, agentSlot = slot) {
    const identity = identityFor(slot)
    const groupId = groupIds.get(slot) ?? managers.get(slot)?.mounted.get(identity)?.groupId ?? `weir-mcp-${identity}`
    const payload = mcpFacadeBridgeFor(groupId)
    const agent = agents.get(agentSlot)
    if (!payload || !agent) return { groupId, present: Boolean(payload), identity: payload?.identity ?? null, generation: payload?.generation ?? null, ownerLifecycleTags: [] }
    const marker = state.events.length
    const enabledForOldSession = payload.isEnabledFor(agent)
    return {
      groupId,
      present: true,
      identity: payload.identity ?? null,
      generation: payload.generation ?? null,
      observedThroughSession: agent.id,
      enabledForObservedSession: enabledForOldSession,
      ownerLifecycleTags: lifecycleTags(state.events.slice(marker), agent.id),
    }
  }

  function feedEvidence() {
    return Object.fromEntries(SLOTS.map(slot => {
      const manager = managers.get(slot)
      const lifecycle = state.selections.get(slot)?.lifecycle
      const owner = manager ? lifecycleFeedRegistry.lifecycleFor(manager) : null
      return [slot, { present: Boolean(owner), matchesOwn: Boolean(owner && owner === lifecycle) }]
    }))
  }

  async function releaseRegistration(slot) {
    if (!unregistered.has(slot) && unregister.has(slot)) {
      await unregister.get(slot)()
      unregistered.add(slot)
    }
    return {
      unregistered: unregistered.has(slot),
      retainedCompositions: presetRegistry.inspectCompositions().map(entry => entry.id),
      feed: feedEvidence(),
    }
  }
  async function disposeRevision(slot) {
    if (!disposed.has(slot) && handles.has(slot)) {
      await handles.get(slot).dispose()
      disposed.add(slot)
    }
    await releaseRegistration(slot)
    return {
      disposed: disposed.has(slot),
      unregistered: unregistered.has(slot),
      retainedCompositions: presetRegistry.inspectCompositions().map(entry => entry.id),
      feed: feedEvidence(),
    }
  }

  async function removeRuntime(slot) {
    if (runtimeRemoved.has(slot) || !runtimeAttempted.has(slot) || !managers.has(slot)) return null
    runtimeRemoved.add(slot)
    const outcome = await managers.get(slot).remove(identityFor(slot))
    report.cleanup.removals[slot] = clone(outcome)
    return clone(outcome)
  }

  async function repeatRuntimeRelease(slot) {
    if (!runtimeAttempted.has(slot) || !managers.has(slot)) return null
    const outcome = await managers.get(slot).remove(identityFor(slot))
    report.cleanup.repeatedRemovals ??= {}
    report.cleanup.repeatedRemovals[slot] = clone(outcome)
    return clone(outcome)
  }

  function groupFacts() {
    const identity = identityFor('old')
    const sources = [['host', ctx.get('loader')], ...SLOTS.map(slot => [slot, trees.get(slot)])]
    const groups = []
    for (const [scope, tree] of sources) {
      if (typeof tree?.entries !== 'function') continue
      for (const entry of tree.entries()) {
        const options = entry?.options
        if (options?.group !== true) continue
        const facade = Array.isArray(options.config) ? options.config.find(row => row?.name === 'weir-harness/mcp-facade-plugin' && row.config?.identity === identity) : null
        if (!facade && !(typeof options.id === 'string' && options.id.startsWith(`weir-mcp-${identity}`))) continue
        groups.push({ scope, groupId: facade?.config?.group ?? options.id, entryId: entry.id, state: entry.fiber?.state ?? null })
      }
    }
    return { count: groups.length, groups }
  }

  function claimFacts() {
    const bySlot = Object.fromEntries(SLOTS.map(slot => {
      const manager = managers.get(slot)
      const identity = identityFor(slot)
      const publicNames = [...(manager?.publicNames ?? [])].filter(([, owner]) => owner?.identity === identity).map(([name]) => name)
      const mounted = manager?.mounted?.has(identity) === true
      return [slot, { mounted, publicNames, claimCount: Number(mounted) + publicNames.length }]
    }))
    return { bySlot, claimCount: SLOTS.reduce((sum, slot) => sum + bySlot[slot].claimCount, 0) }
  }

  async function removeRegistry(slot) {
    if (registryRemoved.has(slot)) return null
    registryRemoved.add(slot)
    const current = await registry.read()
    const identity = identityFor(slot)
    if (current.kind !== 'ok' || !current.servers?.[identity]) {
      const outcome = { status: 'absent', identity }
      report.cleanup.registryRemovals[slot] = outcome
      return outcome
    }
    const outcome = await registry.remove(identity, current.revision)
    report.cleanup.registryRemovals[slot] = clone(outcome)
    return clone(outcome)
  }

  function processFacts(entries) {
    const starts = entries.filter(entry => entry.kind === 'mcp-server-start')
    return {
      servers: [...new Set(starts.map(entry => entry.server))],
      byServer: Object.fromEntries([...new Set(starts.map(entry => entry.server))].map(server => [server, [...new Set(starts.filter(entry => entry.server === server).map(entry => entry.pid))]])),
    }
  }
  async function waitForProcesses() {
    const deadline = Date.now() + 15_000
    let started = []
    let exited = []
    while (true) {
      const entries = await serverEntries(serverLog)
      started = [...new Set(entries.filter(entry => entry.kind === 'mcp-server-start').map(entry => entry.pid))]
      exited = [...new Set(entries.filter(entry => entry.kind === 'mcp-server-exit').map(entry => entry.pid))]
      if (started.every(pid => exited.includes(pid)) || Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    report.cleanup.serverProcesses = { started, exited, ...processFacts(await serverEntries(serverLog)), allExited: started.every(pid => exited.includes(pid)) }
    return report.cleanup.serverProcesses
  }

  async function finish() {
    for (const slot of SLOTS) {
      try { await disposeRevision(slot) } catch (error) { report.cleanup.errors.push(`${slot} dispose: ${errorText(error)}`) }
    }
    for (const slot of SLOTS) {
      try { await removeRuntime(slot) } catch (error) { report.cleanup.errors.push(`${slot} runtime: ${errorText(error)}`) }
      try { await removeRegistry(slot) } catch (error) { report.cleanup.errors.push(`${slot} registry: ${errorText(error)}`) }
    }
    for (const [identity, dispose] of placeholders) {
      try { dispose() } catch (error) { report.cleanup.errors.push(`${identity} placeholder: ${errorText(error)}`) }
    }
    placeholders.clear()
    await waitForProcesses()
    report.cleanup.finalFeed = feedEvidence()
    report.cleanup.finalRetainedCompositions = presetRegistry.inspectCompositions().map(entry => entry.id)
    report.cleanup.finalGroups = groupFacts()
    report.cleanup.finalBridges = Object.fromEntries(SLOTS.map(slot => [slot, bridgeEvidence(slot)]))
    report.cleanup.finalClaims = claimFacts()
    report.cleanup.finalRegistry = clone(await registry.read())
  }

  function inspections() {
    return presetRegistry.inspectCompositions().map(entry => entry.id)
  }
  return {
    state, registry, agents, managers, generations, serverLog,
    prepareRoots, mountRevision, createAgent, resolveInitial, measure,
    gateEvidence, visibility, call, siblingFacts, adopt, reconcileSame, apply,
    bridgeEvidence, feedEvidence, releaseRegistration, disposeRevision, removeRuntime, removeRegistry,
    repeatRuntimeRelease, groupFacts, claimFacts,
    waitForProcesses, finish, inspections,
  }
}

async function mountPair(fixture, report) {
  await fixture.prepareRoots()
  await fixture.mountRevision('old')
  await fixture.createAgent('old')
  report.oldBeforeReplacement = await fixture.resolveInitial('old')
  report.oldDeclarationRelease = await fixture.releaseRegistration('old')
  await fixture.mountRevision('new')
  await fixture.createAgent('new')
  report.oldAfterReplacement = await fixture.measure('old')
  report.newAfterReplacement = await fixture.resolveInitial('new')
  report.retained = {
    managersDistinct: fixture.managers.get('old') !== fixture.managers.get('new'),
    lifecyclesDistinct: fixture.state.selections.get('old')?.lifecycle !== fixture.state.selections.get('new')?.lifecycle,
    feed: fixture.feedEvidence(),
    inspectAll: fixture.inspections(),
  }
}

async function runPrimary(ctx) {
  const runId = 'capability-lifecycle-retained-primary'
  const presetId = 'weir-it-lifecycle-retained-primary'
  const identities = { old: 'retained-old', new: 'retained-new' }
  const report = { fixtureBlocker: null }
  const fixture = createFixture(ctx, report, { runId, presetId, identityFor: slot => identities[slot] })
  try {
    await mountPair(fixture, report)
    report.adoptions = {
      old: await fixture.adopt('old'),
      new: await fixture.adopt('new'),
    }
    const current = await fixture.registry.read()
    report.registry = {
      kind: current.kind,
      revision: current.revision ?? null,
      enabled: clone(current.enabled),
      servers: Object.fromEntries(Object.entries(current.servers ?? {}).map(([identity, entry]) => [identity, { generation: entry.generation, incarnation: entry.incarnation ?? null }])),
    }
    report.afterAdopt = { old: await fixture.measure('old'), new: await fixture.measure('new') }
    report.bridgesAfterMount = { old: fixture.bridgeEvidence('old'), new: fixture.bridgeEvidence('new') }
    report.apply = {}
    for (const slot of SLOTS) {
      const transition = await fixture.apply(slot)
      transition.call = await fixture.call(slot, `RETAINED_APPLY_${slot.toUpperCase()}`, `apply-rpc:${slot}`)
      report.apply[slot] = transition
    }
    report.oldAfterNewApply = {
      measurement: await fixture.measure('old'),
      gate: await fixture.gateEvidence('old'),
      call: await fixture.call('old', 'RETAINED_OLD_AFTER_NEW_APPLY', 'after-new-apply:old-rpc'),
    }
    report.beforeOldDispose = { new: await fixture.siblingFacts('new'), feed: fixture.feedEvidence() }
    report.oldDisposal = await fixture.disposeRevision('old')
    report.oldDisposal.gate = await fixture.gateEvidence('old')
    report.oldDisposal.runtimeRemoval = await fixture.removeRuntime('old')
    report.oldDisposal.registryRemoval = await fixture.removeRegistry('old')
    report.afterOldDispose = {
      new: await fixture.siblingFacts('new'),
      bridges: { old: fixture.bridgeEvidence('old'), new: fixture.bridgeEvidence('new') },
      newCall: await fixture.call('new', 'RETAINED_NEW_AFTER_OLD_DISPOSE', 'after-old-dispose:new-rpc'),
    }
    report.newDisposal = await fixture.disposeRevision('new')
    report.newDisposal.gate = await fixture.gateEvidence('new')
    report.newDisposal.runtimeRemoval = await fixture.removeRuntime('new')
    report.newDisposal.registryRemoval = await fixture.removeRegistry('new')
    report.final = {
      feed: fixture.feedEvidence(),
      bridges: { old: fixture.bridgeEvidence('old'), new: fixture.bridgeEvidence('new') },
      registry: clone(await fixture.registry.read()),
    }
  } catch (error) {
    report.fixtureBlocker = errorText(error)
  } finally {
    await fixture.finish()
  }
  return report
}

function callOk(call, tag) {
  return call?.resultObserved === true && call.rpcDelta === 1 && call.matchingRpc?.length === 1
    && JSON.stringify(call.lifecycleTags) === JSON.stringify([tag])
}

async function runFacadeRegression(ctx, order) {
  const runId = `capability-lifecycle-retained-facade-${order}`
  const presetId = `weir-it-lifecycle-facade-${order}`
  const identity = 'retained-shared'
  const first = order === 'old-first' ? 'old' : 'new'
  const survivor = first === 'old' ? 'new' : 'old'
  const report = { fixtureBlocker: null, order, first, survivor, identity }
  const fixture = createFixture(ctx, report, { runId, presetId, identityFor: () => identity })
  const oldTag = `${runId}:old`
  const newTag = `${runId}:new`
  try {
    await mountPair(fixture, report)
    report.oldAdoption = await fixture.adopt('old')
    report.oldApply = await fixture.apply('old')
    const current = await fixture.registry.read()
    const entry = current.kind === 'ok' ? current.servers?.[identity] : null
    if (!entry) throw new Error('same-identity regression lost its registered identity before the new mount')
    report.newSameIdentityMount = await fixture.reconcileSame('new', entry)
    report.newApply = await fixture.apply('new')
    report.sameIdentity = {
      generation: entry.generation,
      incarnation: entry.incarnation ?? null,
      serverName: entry.client?.serverName ?? null,
      oldGeneration: fixture.generations.get('old'),
      newGeneration: fixture.generations.get('new'),
      oldMountGeneration: report.oldAdoption.outcome?.generation ?? null,
      newMountGeneration: report.newSameIdentityMount?.generation ?? null,
      oldMountIncarnation: report.oldAdoption.outcome?.incarnation ?? null,
      newMountIncarnation: report.newSameIdentityMount?.incarnation ?? null,
    }
    report.groupsAfterBoth = fixture.groupFacts()
    report.bridgesAfterBoth = { old: fixture.bridgeEvidence('old', 'old'), new: fixture.bridgeEvidence('new', 'new') }
    report.directGatesAfterBoth = { old: await fixture.gateEvidence('old'), new: await fixture.gateEvidence('new') }
    report.visibilityAfterBoth = { old: fixture.visibility('old'), new: fixture.visibility('new') }
    report.oldAfterNewMount = await fixture.call('old', `FACADE_${order}_OLD_AFTER_NEW`, `facade:${order}:after-new:old-rpc`)
    report.newAfterNewMount = await fixture.call('new', `FACADE_${order}_NEW_AFTER_NEW`, `facade:${order}:after-new:new-rpc`)
    report.realRpc = {
      old: callOk(report.oldAfterNewMount, oldTag),
      new: callOk(report.newAfterNewMount, newTag),
      distinctServerProcesses: report.oldAfterNewMount.matchingRpc?.[0]?.pid != null
        && report.newAfterNewMount.matchingRpc?.[0]?.pid != null
        && report.oldAfterNewMount.matchingRpc[0].pid !== report.newAfterNewMount.matchingRpc[0].pid,
    }

    report.beforeFirstCleanup = await fixture.siblingFacts(survivor)
    report.firstDisposal = await fixture.disposeRevision(first)
    report.firstDisposal.gate = await fixture.gateEvidence(first)
    report.firstDisposal.runtimeRemoval = await fixture.removeRuntime(first)
    report.bridgeAfterFirstCleanup = fixture.bridgeEvidence(survivor, survivor)
    report.survivorAfterFirstCleanup = {
      facts: await fixture.siblingFacts(survivor),
      visibility: fixture.visibility(survivor),
      call: await fixture.call(survivor, `FACADE_${order}_SURVIVOR_AFTER_CLEANUP`, `facade:${order}:after-cleanup:${survivor}-rpc`),
    }
    report.repeatedFirstRelease = await fixture.repeatRuntimeRelease(first)
    report.bridgeAfterRepeatedRelease = fixture.bridgeEvidence(survivor, survivor)
    report.survivorAfterRepeatedRelease = {
      visibility: fixture.visibility(survivor),
      call: await fixture.call(survivor, `FACADE_${order}_SURVIVOR_AFTER_REPEATED_RELEASE`, `facade:${order}:after-repeated-release:${survivor}-rpc`),
    }

    report.survivorDisposal = await fixture.disposeRevision(survivor)
    report.survivorDisposal.gate = await fixture.gateEvidence(survivor)
    report.survivorDisposal.runtimeRemoval = await fixture.removeRuntime(survivor)
    report.survivorDisposal.registryRemoval = await fixture.removeRegistry(survivor)
    report.final = {
      groups: fixture.groupFacts(),
      bridges: { old: fixture.bridgeEvidence('old'), new: fixture.bridgeEvidence('new') },
      claims: fixture.claimFacts(),
      registry: clone(await fixture.registry.read()),
    }
  } catch (error) {
    report.fixtureBlocker = errorText(error)
  } finally {
    await fixture.finish()
  }
  return report
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'capability_lifecycle_retained_revision_probe',
    description: 'Prove retained lifecycle ownership and same-identity old/new discovery, RPC and cleanup in both orders.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `LIFECYCLE_RETAINED ${value.completed ? 'COMPLETE' : 'BLOCKED'} ${value.primaryBlocker ?? ''}` }],
    },
    async execute() {
      const cwd = join(ROOT, 'ws')
      const reportPath = join(cwd, 'capability-lifecycle-retained-revision.json')
      const report = { schemaVersion: 2, primary: null, facade: null }
      await mkdir(cwd, { recursive: true })
      report.primary = await runPrimary(ctx)
      if (report.primary.fixtureBlocker) {
        report.facade = { expectedOrders: [], orders: {}, fixtureBlocker: 'primary retained lifecycle proof did not complete' }
      } else {
        const requested = process.env.WEIR_IT_MCP_FACADE_ORDER
        const expectedOrders = requested ? [requested] : ['old-first', 'new-first']
        if (expectedOrders.some(order => !['old-first', 'new-first'].includes(order))) throw new Error(`unknown facade cleanup order: ${requested}`)
        report.facade = { expectedOrders, orders: {} }
        for (const order of expectedOrders) report.facade.orders[order] = await runFacadeRegression(ctx, order)
      }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
      return {
        completed: !report.primary.fixtureBlocker && !report.facade.fixtureBlocker && report.facade.expectedOrders.every(order => !report.facade.orders[order]?.fixtureBlocker),
        primaryBlocker: report.primary.fixtureBlocker,
        facadeOrders: report.facade.expectedOrders,
        report: reportPath,
      }
    },
  })
}
