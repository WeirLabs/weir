// Real-Host dual-manager lifecycle regression. Each preset owns a distinct
// selection lifecycle and manager in its own isolated group. Revision-0 is
// measured before a phase-separated enable/disable/re-enable Apply sequence.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpRegistry } from '../../weir-harness/src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../../weir-harness/src/capabilities/store/store.js'
import { beginOrder, setPhase, snapshotSummary } from './capability-lifecycle-dual-state.js'

export const name = 'capability-lifecycle-dual-manager-probe'
export const inject = ['tools', 'skills', 'agents', 'agentPresets']

const NAMES = ['weir', 'weir-creative']
const ROOT = process.env.WEIR_IT_ROOT
const MOCK_SERVER = fileURLToPath(new URL('./mock-mcp-server.mjs', import.meta.url))
const identityFor = id => id === 'weir' ? 'docs-weir' : 'docs-creative'
const toolFor = id => `mcp__${identityFor(id)}__echo`
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const errorText = error => String(error?.stack ?? error?.message ?? error)

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


function snapshotForManager(manager, identity) {
  return {
    runtime: clone(manager.runtime.snapshot(identity)),
    mounted: manager.mounted.has(identity) ? clone(manager.mounted.get(identity)) : null,
    publicNames: [...manager.publicNames.entries()].map(([name, owner]) => ({ name, owner: clone(owner) })),
    startErrors: clone(manager.startErrors ?? []),
  }
}

function isExpectedStartupHistory(error) {
  return error?.identity === null && error.reason === 'registry-absent' && error.swept === 0 && Object.keys(error).length === 3
}

async function awaitInitialRegistryAbsent(manager, presetId) {
  const deadline = Date.now() + 15_000
  while (!manager.startErrors?.some(error => error?.reason === 'registry-absent')) {
    if (manager.startErrors?.length) throw new Error(`unexpected initial startup history for ${presetId}: ${JSON.stringify(manager.startErrors)}`)
    if (Date.now() >= deadline) throw new Error(`timed out waiting for initial registry-absent startup for ${presetId}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (manager.startErrors.length !== 1 || !isExpectedStartupHistory(manager.startErrors[0])) {
    throw new Error(`invalid initial startup history for ${presetId}: ${JSON.stringify(manager.startErrors)}`)
  }
}

function lifecycleTags(events, sessionId) {
  return [...new Set(events.filter(event => event.kind === 'lifecycle-resolve' && event.sessionId === sessionId).map(event => event.lifecycleTag))]
}

async function gateEvidence(state, manager, agent, identity, generation, phase) {
  setPhase(state.orderId, phase)
  let marker = state.events.length
  const enabledFor = manager.gate.enabledFor(agent, identity)
  const enabledEvents = state.events.slice(marker)
  marker = state.events.length
  const pendingPermit = manager.gate.permit(agent, identity, generation)
  const permitEvents = state.events.slice(marker)
  const permit = await pendingPermit
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

async function durableFacts(store, sessionId) {
  const selection = await store.read({ kind: 'selection', sessionId })
  const inherited = await store.read({ kind: 'inherited', sessionId })
  const compact = record => ({
    kind: record.kind,
    revision: record.revision ?? 0,
    accepted: record.kind === 'ok',
    ...(record.kind === 'ok' ? {
      mcpServers: Array.isArray(record.payload?.mcpServers) ? [...record.payload.mcpServers] : null,
      mcpIncarnations: record.payload?.mcpIncarnations ? { ...record.payload.mcpIncarnations } : null,
    } : {}),
  })
  return { selection: compact(selection), inherited: compact(inherited) }
}

function memoryFacts(state, presetId, sessionId) {
  const own = state.selections.get(presetId).lifecycle.peek(sessionId)
  const otherId = NAMES.find(id => id !== presetId)
  const other = state.selections.get(otherId).lifecycle.peek(sessionId)
  return {
    ownLifecycleTag: state.lifecycleTags.get(presetId),
    own: snapshotSummary(own),
    otherLifecycleTag: state.lifecycleTags.get(otherId),
    other: snapshotSummary(other),
    ownRevision0: own?.state === 'ready' && own.revision === 0,
  }
}

function visibility(ctx, agent, presetId) {
  const toolName = toolFor(presetId)
  const identity = identityFor(presetId)
  const schemas = ctx.tools.schemas(agent)
  const schema = schemas.find(tool => tool.name === toolName)
  const managed = typeof schema?.description === 'string' && schema.description.includes(`echo from ${identity} (managed)`)
  const placeholder = typeof schema?.description === 'string' && schema.description.includes(`UNMANAGED_PLACEHOLDER ${identity}`)
  return {
    toolName,
    visible: managed,
    namePresent: Boolean(schema),
    placeholderVisible: placeholder,
    schemaCount: schemas.length,
    managedSchema: managed ? clone(schema) : null,
    presentedSchema: schema ? clone(schema) : null,
  }
}

async function transitionCall(ctx, state, { agent, presetId, phase, marker, serverLog }) {
  const toolName = toolFor(presetId)
  const before = await rpcCount(serverLog)
  const eventMarker = state.events.length
  setPhase(state.orderId, phase)
  let outcome
  let thrown = null
  try {
    outcome = await ctx.tools.execute({
      callId: randomUUID(),
      name: toolName,
      arguments: { text: marker },
      agent,
      signal: new AbortController().signal,
    })
  } catch (error) { thrown = errorText(error) }
  const after = await rpcCount(serverLog)
  const matchingRpc = (await serverEntries(serverLog)).filter(entry => entry.method === 'tools/call' && JSON.stringify(entry.params ?? {}).includes(marker))
  return {
    toolName,
    marker,
    outcome: clone(outcome) ?? null,
    thrown,
    rpcBefore: before,
    rpcAfter: after,
    rpcDelta: after - before,
    matchingRpc: clone(matchingRpc),
    resultObserved: JSON.stringify(outcome ?? thrown ?? {}).includes(`RESULT server=${identityFor(presetId)}`),
    lifecycleTags: lifecycleTags(state.events.slice(eventMarker), agent.id),
  }
}

function presetDefinition(orderId, presetId, root) {
  const selectionRow = fileURLToPath(new URL('./capability-lifecycle-selection-fixture.js', import.meta.url))
  const observerRow = fileURLToPath(new URL('./capability-lifecycle-manager-observer.js', import.meta.url))
  return {
    id: presetId,
    plugins: [{
      id: `capabilities-${presetId}`,
      name: 'cordis:group',
      group: true,
      isolate: { weirMcpGate: true, weirMcpManager: true },
      config: [
        { id: `selection-${presetId}`, name: selectionRow, config: { orderId, presetId, root } },
        { id: `manager-${presetId}`, name: 'weir-harness/mcp-manager', config: { startupTimeoutMs: 15000 } },
        { id: `observer-${presetId}`, name: observerRow, config: { orderId, presetId } },
      ],
    }, {
      id: `skill-tool-${presetId}`,
      name: '@deepseek-ai/dsh-tool-skill',
    }],
  }
}

function serverEntry(presetId, serverLog) {
  const identity = identityFor(presetId)
  return {
    identity,
    label: `Lifecycle ${presetId} stdio fixture`,
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

export function apply(ctx) {
  ctx.tools.register({
    name: 'capability_lifecycle_revision_zero_probe',
    description: 'Measure owning revision-0 admission, then real Apply enable/disable/re-enable transitions.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `LIFECYCLE_REVISION_ZERO ${value.completed ? 'COMPLETE' : 'BLOCKED'} ${value.fixtureBlocker ?? ''}` }],
    },
    async execute() {
      const order = (process.env.WEIR_LIFECYCLE_ORDER ?? NAMES.join(',')).split(',').filter(Boolean)
      const orderId = process.env.WEIR_LIFECYCLE_ORDER_ID ?? order.join('-')
      const state = beginOrder(orderId, order)
      const cwd = join(ROOT, 'ws')
      const serverLog = join(cwd, `capability-lifecycle-revision-zero-${orderId}.jsonl`)
      const reportPath = join(cwd, `capability-lifecycle-revision-zero-${orderId}.json`)
      const report = {
        schemaVersion: 1,
        orderId,
        order,
        fixtureBlocker: null,
        mounts: [],
        managerIdentity: null,
        registry: null,
        baseline: null,
        sessions: [],
        apply: null,
        cleanup: { errors: [] },
      }
      const unregister = []
      const handles = []
      const managers = new Map()
      const placeholderDisposers = []
      const writeReport = async () => {
        report.events = state.events
        await mkdir(cwd, { recursive: true })
        await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
      }
      try {
        if (!['weir-first', 'creative-first'].includes(orderId)) throw new Error(`invalid lifecycle order id: ${orderId}`)
        if (order.length !== 2 || new Set(order).size !== 2 || order.some(id => !NAMES.includes(id))) throw new Error(`invalid mount order: ${order.join(',')}`)
        await mkdir(cwd, { recursive: true })
        const roots = Object.fromEntries(NAMES.map(id => [id, join(cwd, `lifecycle-skills-${id}`)]))
        for (const id of NAMES) {
          await mkdir(join(roots[id], `only-${id}`), { recursive: true })
          await writeFile(join(roots[id], `only-${id}`, 'SKILL.md'), `---\nname: only-${id}\ndescription: ${id} lifecycle fixture\n---\nOWNER_${id}\n`)
        }
        const profileContext = ctx.get('profileContext')
        const store = openCapabilityStore({ profileContext })
        const registry = createMcpRegistry({ store })
        const presetRegistry = ctx.get('agentPresets')
        if (!presetRegistry) throw new Error('real agent preset registry is unavailable')

        for (const presetId of NAMES) {
          const identity = identityFor(presetId)
          placeholderDisposers.push(ctx.tools.register({
            name: toolFor(presetId),
            description: `UNMANAGED_PLACEHOLDER ${identity}`,
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: [] },
            output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: `UNMANAGED_PLACEHOLDER ${identity}` }] },
            async execute() { throw new Error(`UNMANAGED_PLACEHOLDER ${identity}`) },
          }))
        }

        for (const presetId of order) {
          setPhase(orderId, `mount:${presetId}`)
          unregister.push(await presetRegistry.register(presetDefinition(orderId, presetId, roots[presetId])))
          const resolved = await presetRegistry.resolve(presetId)
          report.mounts.push({ presetId, broken: resolved.broken ?? null, managerObserved: state.managers.has(presetId), selectionObserved: state.selections.has(presetId) })
          if (resolved.broken) throw new Error(`preset ${presetId} failed to mount: ${resolved.broken}`)
        }

        // Both real managers finish their initial absent-registry sweep before
        // either adoption can create registry/residue state for the other.
        for (const presetId of NAMES) {
          setPhase(orderId, `manager-start:${presetId}`)
          const manager = state.managers.get(presetId)
          const pending = state.managerStarts.get(presetId) ?? manager.start()
          await pending
          await awaitInitialRegistryAbsent(manager, presetId)
        }
        report.initialStartup = Object.fromEntries(NAMES.map(presetId => [presetId, clone(state.managers.get(presetId).startErrors)]))

        const agents = new Map()
        const sessionReports = new Map()
        for (const presetId of NAMES) {
          setPhase(orderId, `create:${presetId}`)
          const sessionId = randomUUID()
          const handle = await ctx.agents.create({
            sessionId,
            meta: { cwd, agentPreset: presetId },
            setup: agentCtx => presetRegistry.mount(agentCtx, presetId).then(() => undefined),
          })
          handles.push(handle)
          const agent = handle.agent
          const manager = presetRegistry.serviceFor(agent, 'weirMcpManager')
          if (!manager) throw new Error(`serviceFor found no manager for ${presetId}`)
          agents.set(presetId, agent)
          managers.set(presetId, manager)
          const sessionReport = { presetId, sessionId, composedPreset: presetRegistry.composedPreset(agent.ctx) }
          sessionReports.set(presetId, sessionReport)
          report.sessions.push(sessionReport)
        }
        report.managerIdentity = {
          distinct: managers.get('weir') !== managers.get('weir-creative'),
          lifecyclesDistinct: state.selections.get('weir')?.lifecycle !== state.selections.get('weir-creative')?.lifecycle,
          serviceForMatchesObserver: Object.fromEntries(NAMES.map(id => [id, managers.get(id) === state.managers.get(id)])),
          managerTags: Object.fromEntries(NAMES.map(id => [id, `${orderId}:${id}`])),
          lifecycleTags: Object.fromEntries(NAMES.map(id => [id, state.lifecycleTags.get(id)])),
        }
        if (!report.managerIdentity.distinct || !report.managerIdentity.lifecyclesDistinct) throw new Error('the two presets did not retain distinct real managers and lifecycles')

        const adopted = {}
        for (const presetId of order) {
          setPhase(orderId, `managed-adopt:${presetId}`)
          const outcome = await managers.get(presetId).adopt(serverEntry(presetId, serverLog))
          adopted[presetId] = clone(outcome)
          if (outcome.status !== 'mounted') throw new Error(`managed adopt ${presetId} did not mount: ${JSON.stringify(outcome)}`)
        }
        const beforeDefaults = await registry.read()
        const defaultOutcome = await registry.setDefaults(NAMES.map(identityFor), beforeDefaults.kind === 'ok' ? beforeDefaults.revision : 0)
        if (defaultOutcome.status !== 'committed') throw new Error(`default enable failed: ${JSON.stringify(defaultOutcome)}`)
        const registryAfter = await registry.read()
        report.registry = {
          kind: registryAfter.kind,
          revision: registryAfter.revision ?? null,
          enabled: clone(registryAfter.enabled),
          servers: Object.fromEntries(Object.entries(registryAfter.servers ?? {}).map(([id, entry]) => [id, { generation: entry.generation, incarnation: entry.incarnation ?? null, serverName: entry.client?.serverName ?? null }])),
          adopted,
          defaultOutcome: clone(defaultOutcome),
        }

        const baselineManagers = {}
        for (const presetId of NAMES) {
          const identity = identityFor(presetId)
          const otherIdentity = identityFor(NAMES.find(id => id !== presetId))
          const manager = managers.get(presetId)
          const listing = await manager.list()
          const row = listing.managed.find(entry => entry.identity === identity)
          const snapshot = snapshotForManager(manager, identity)
          baselineManagers[presetId] = {
            identity,
            toolName: toolFor(presetId),
            listingRow: clone(row),
            otherIdentityMounted: manager.mounted.has(otherIdentity),
            ownPublicNameRegistered: manager.publicNames.has(toolFor(presetId)),
            otherPublicNameRegistered: manager.publicNames.has(toolFor(NAMES.find(id => id !== presetId))),
            ...snapshot,
            unexpectedStartErrors: (snapshot.startErrors ?? []).filter(error => !isExpectedStartupHistory(error)),
          }
        }
        const serverLogEntries = await serverEntries(serverLog)
        const serverFacts = {
          starts: serverLogEntries.filter(entry => entry.kind === 'mcp-server-start').map(entry => ({ server: entry.server, pid: entry.pid })),
          uniquePids: [...new Set(serverLogEntries.filter(entry => entry.kind === 'mcp-server-start').map(entry => entry.pid))],
          initializeByServer: Object.fromEntries(NAMES.map(id => [identityFor(id), serverLogEntries.filter(entry => entry.server === identityFor(id) && entry.method === 'initialize').length])),
          toolsListByServer: Object.fromEntries(NAMES.map(id => [identityFor(id), serverLogEntries.filter(entry => entry.server === identityFor(id) && entry.method === 'tools/list').length])),
          toolsCallCount: serverLogEntries.filter(entry => entry.method === 'tools/call').length,
        }
        report.baseline = {
          managers: baselineManagers,
          server: serverFacts,
          valid: NAMES.every(id => {
            const row = baselineManagers[id].listingRow
            return row?.state === 'mounted' && row.defaultEnabled === true && row.discovery?.toolCount === 1
              && baselineManagers[id].runtime.phase === 'mounted'
              && baselineManagers[id].ownPublicNameRegistered
              && !baselineManagers[id].otherIdentityMounted
              && !baselineManagers[id].otherPublicNameRegistered
              && baselineManagers[id].unexpectedStartErrors.length === 0
              && serverFacts.initializeByServer[identityFor(id)] >= 1
              && serverFacts.toolsListByServer[identityFor(id)] >= 1
          }) && serverFacts.uniquePids.length >= 2 && report.managerIdentity.distinct,
        }
        if (!report.baseline.valid) throw new Error(`managed mounted baseline is invalid: ${JSON.stringify(report.baseline)}`)

        for (const presetId of NAMES) {
          const agent = agents.get(presetId)
          const manager = managers.get(presetId)
          const identity = identityFor(presetId)
          const generation = report.registry.servers[identity].generation
          const session = sessionReports.get(presetId)
          setPhase(orderId, `initial-selection:${presetId}`)
          const skills = await ctx.skills.list({ cwd, scope: agent })
          session.initialSelection = {
            skillCount: skills.length,
            report: clone(state.selections.get(presetId).initialReport(agent.id)),
          }
          manager.syncSession(agent.id)
          session.steadyState = {
            memory: memoryFacts(state, presetId, agent.id),
            durable: await durableFacts(store, agent.id),
            gate: await gateEvidence(state, manager, agent, identity, generation, `steady-state:gate:${presetId}`),
            visibility: visibility(ctx, agent, presetId),
          }
        }

        for (const presetId of NAMES) {
          const agent = agents.get(presetId)
          const toolName = toolFor(presetId)
          const marker = `REVISION_ZERO_${orderId}_${presetId}`
          const before = await rpcCount(serverLog)
          const eventMarker = state.events.length
          setPhase(orderId, `steady-state:tool:${presetId}`)
          let outcome
          let thrown = null
          try {
            outcome = await ctx.tools.execute({
              callId: randomUUID(),
              name: toolName,
              arguments: { text: marker },
              agent,
              signal: new AbortController().signal,
            })
          } catch (error) { thrown = errorText(error) }
          const after = await rpcCount(serverLog)
          const matchingRpc = (await serverEntries(serverLog)).filter(entry => entry.method === 'tools/call' && JSON.stringify(entry.params ?? {}).includes(marker))
          sessionReports.get(presetId).toolCall = {
            toolName,
            marker,
            outcome: clone(outcome) ?? null,
            thrown,
            rpcBefore: before,
            rpcAfter: after,
            rpcDelta: after - before,
            matchingRpc: clone(matchingRpc),
            resultObserved: JSON.stringify(outcome ?? thrown ?? {}).includes(`RESULT server=${identityFor(presetId)}`),
            lifecycleTags: lifecycleTags(state.events.slice(eventMarker), agent.id),
          }
        }

        report.apply = {
          applySelectionCalls: state.applySelectionCalls,
          applyCommandEvents: Object.fromEntries(NAMES.map(id => [id, agents.get(id).session.snapshotEvents().filter(event => event.type === 'command/run' && JSON.stringify(event.data ?? {}).includes('/capabilities apply')).length])),
          allDurableSelectionsAbsent: report.sessions.every(session => session.steadyState.durable.selection.kind === 'absent'),
          allDurableInheritedAbsent: report.sessions.every(session => session.steadyState.durable.inherited.kind === 'absent'),
          allMemorySnapshotsRevision0: report.sessions.every(session => session.steadyState.memory.ownRevision0),
        }

        // The report.apply object above is the intact revision-0/no-Apply phase.
        // Only now drive the real Apply public seam, with each transition and
        // its events labeled by a later apply:* phase.
        for (const presetId of NAMES) {
          const agent = agents.get(presetId)
          const manager = managers.get(presetId)
          const selection = state.selections.get(presetId)
          const identity = identityFor(presetId)
          const generation = report.registry.servers[identity].generation
          const session = sessionReports.get(presetId)
          const siblingId = NAMES.find(id => id !== presetId)
          const siblingAgent = agents.get(siblingId)
          const siblingManager = managers.get(siblingId)
          const siblingIdentity = identityFor(siblingId)
          const skills = clone(selection.lifecycle.peek(agent.id)?.skills ?? [])
          const siblingFacts = async () => ({
            memory: memoryFacts(state, siblingId, siblingAgent.id).own,
            durable: await durableFacts(store, siblingAgent.id),
            enabledFor: siblingManager.gate.enabledFor(siblingAgent, siblingIdentity),
          })
          session.applyTransitions = []
          const steps = [
            { name: 'enable', expectedRevision: 0, mcpServers: [identity], admitted: true },
            { name: 'disable', expectedRevision: 1, mcpServers: [], admitted: false },
            { name: 're-enable', expectedRevision: 2, mcpServers: [identity], admitted: true },
          ]
          for (const step of steps) {
            setPhase(orderId, `apply:${step.name}:${presetId}`)
            const siblingBefore = await siblingFacts()
            const eventMarker = state.events.length
            const outcome = await selection.applySelection(
              { sessionId: agent.id, cwd, presetId },
              {
                requestId: `${orderId}-${presetId}-${step.name}`,
                expectedRevision: step.expectedRevision,
                selection: { skills, mcpServers: step.mcpServers },
                unresolved: [],
              },
            )
            const applyEvents = state.events.slice(eventMarker)
            const publishes = applyEvents.filter(event => event.kind === 'lifecycle-publish' && event.presetId === presetId && event.sessionId === agent.id)
            const syncs = applyEvents.filter(event => event.kind === 'manager-sync' && event.presetId === presetId && event.sessionId === agent.id)
            const transition = {
              name: step.name,
              outcome: clone(outcome),
              memory: snapshotSummary(selection.lifecycle.peek(agent.id)),
              durable: await durableFacts(store, agent.id),
              publication: {
                publishCount: publishes.length,
                publishSeq: publishes[0]?.seq ?? null,
                syncCount: syncs.length,
                syncSeq: syncs[0]?.seq ?? null,
                syncSnapshot: syncs[0]?.snapshot ?? null,
              },
              sibling: { before: siblingBefore, after: await siblingFacts() },
              gate: await gateEvidence(state, manager, agent, identity, generation, `apply:${step.name}:gate:${presetId}`),
              visibility: visibility(ctx, agent, presetId),
            }
            transition.call = await transitionCall(ctx, state, {
              agent, presetId, serverLog,
              phase: `apply:${step.name}:tool:${presetId}`,
              marker: `APPLY_${step.name.toUpperCase()}_${orderId}_${presetId}`,
            })
            session.applyTransitions.push(transition)
          }
        }
      } catch (error) {
        report.fixtureBlocker = errorText(error)
      } finally {
        await writeReport()
        report.cleanup.removals = {}
        for (const presetId of NAMES) {
          const manager = managers.get(presetId)
          const identity = identityFor(presetId)
          if (!manager?.mounted?.has(identity)) continue
          try {
            const outcome = await manager.remove(identity)
            report.cleanup.removals[presetId] = clone(outcome)
            if (outcome?.status !== 'removed') report.cleanup.errors.push(`cleanup ${presetId}: ${JSON.stringify(outcome)}`)
          } catch (error) { report.cleanup.errors.push(errorText(error)) }
        }
        for (const handle of handles.reverse()) {
          try { await handle.dispose() } catch (error) { report.cleanup.errors.push(errorText(error)) }
        }
        for (const dispose of unregister.reverse()) {
          try { await dispose() } catch (error) { report.cleanup.errors.push(errorText(error)) }
        }
        for (const dispose of placeholderDisposers.reverse()) {
          try { dispose() } catch (error) { report.cleanup.errors.push(errorText(error)) }
        }
        const waitStarted = Date.now()
        const deadline = waitStarted + 15_000
        let started = []
        let exited = []
        while (true) {
          const entries = await serverEntries(serverLog)
          started = [...new Set(entries.filter(entry => entry.kind === 'mcp-server-start').map(entry => entry.pid))]
          exited = [...new Set(entries.filter(entry => entry.kind === 'mcp-server-exit').map(entry => entry.pid))]
          if (started.every(pid => exited.includes(pid)) || Date.now() >= deadline) break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        report.cleanup.serverProcesses = { started, exited, allExited: started.every(pid => exited.includes(pid)), exitWaitMs: Date.now() - waitStarted }
        await writeReport()
      }
      return { completed: !report.fixtureBlocker, fixtureBlocker: report.fixtureBlocker, report: reportPath }
    },
  })
}
