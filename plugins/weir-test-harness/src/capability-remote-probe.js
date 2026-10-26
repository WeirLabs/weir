// Single-preset counterpart to the dual-owner probe. Registry.register mounts
// the actual selection plugin in a preset revision; the probe addresses its
// exact child session, not the host-level CLI session.
//
// Most ops remain direct mirrors of the read service. The `registration` op is
// the exact production lifecycle proof instead: it drives the SHIPPED host row
// (weir-harness/capability-remote) through a real Cordis fiber restart against
// the real Typert registry, then dispatches one read and one mutation through
// the real `typertGateway` service — including the withdrawn case, where the
// gateway must reject with `gateway/definition-unavailable` BEFORE any service
// or bridge face is reached. dsh-base mounts `typert`, `typert-loader` and
// `typert-gateway` in the headless profile too; only the authenticated HTTP
// carrier is absent, so `dispatchRpc` is called in-process.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IT_ROOT } from './mock-kit.js'
import {
  CAPABILITY_ENDPOINTS,
  CAPABILITY_MUTATION_NAMESPACE,
  CAPABILITY_MUTATION_SERVICE_KEY,
  CAPABILITY_READ_NAMESPACE,
  CAPABILITY_READ_SERVICE_KEY,
  apply as capabilityRemoteApply,
  createCapabilityReadService,
  feedCapabilityReadBridge,
} from '../../weir-harness/src/capabilities/capability-remote.js'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const compact = report => JSON.stringify(report).slice(0, 560)

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  let owned
  const ownedAgent = async exec => {
    if (owned) return owned.handle.agent
    const registry = ctx.get('agentPresets')
    if (!registry) throw new Error('real preset registry unavailable')
    const id = 'weir'
    const unregister = await registry.register({ id, plugins: [
      { id: 'weir-selection', name: fileURLToPath(new URL('./skill-composition-probe.js', import.meta.url)), config: { selection: id } },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    ] })
    try {
      const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: exec.agent.session.header.cwd, agentPreset: id },
        setup: agentCtx => registry.mount(agentCtx, id).then(() => undefined) })
      owned = { handle, unregister }
      return handle.agent
    } catch (error) { await unregister(); throw error }
  }
  ctx.on('dispose', async () => { await owned?.handle.dispose(); await owned?.unregister() })
  // In-band session-log observation: command lifecycle events per session.
  // Reads over the remote must never move these counters; only the deliberate
  // parity command may.
  const commandEvents = new Map()
  const countsFor = sessionId => {
    if (!commandEvents.has(sessionId)) commandEvents.set(sessionId, { run: 0, done: 0 })
    return commandEvents.get(sessionId)
  }
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (type !== 'command/run' && type !== 'command/done') return
    const counts = countsFor(session?.id)
    if (type === 'command/run') counts.run += 1
    else counts.done += 1
  })
  ctx.tools.register({
    name: 'capability_remote_probe',
    description: 'Integration probe: drive the capability read remote (direct-call mirror) with session-log silence evidence, and (op registration) prove the shipped host row registration lifecycle against the real Typert registry and gateway.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['reads', 'presetReads', 'unknownSession', 'logCounts', 'parity', 'registration'] },
        _marker: { type: 'string' },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `CAPABILITY_PROBE ${value.completed ? `done ${args?._marker ?? value.op}:${compact(value)}` : `error:${String(value.error ?? 'unknown').slice(0, 200)}`}` }],
    },
    async execute(args, exec) {
      const report = { completed: false, op: args?.op ?? null }
      try {
        const agent = await ownedAgent(exec)
        const sessionId = agent.session.id
        const service = createCapabilityReadService({ sessionQuery: () => ctx.get('sessionQuery') })

        if (args.op === 'reads') {
          const receipt = await service.receipt(sessionId)
          const listing = await service.list(sessionId)
          const conditions = await service.conditions(sessionId)
          // Identity objects make the full receipt exceed compact()'s budget.
          // Summarize here, as for listing; parity below compares full payloads.
          report.receipt = {
            status: receipt.status,
            revision: receipt.revision,
            skills: receipt.effective?.skills?.length ?? -1,
            skillIdentities: receipt.effective?.skillIdentities?.length ?? -1,
          }
          report.listing = {
            skills: Array.isArray(listing.skills) ? listing.skills.length : -1,
            selected: Array.isArray(listing.skills) ? listing.skills.filter(row => row.selected === true).length : -1,
            mcpServers: Array.isArray(listing.mcpServers) ? listing.mcpServers.length : -1,
          }
          report.conditions = conditions
          const observation = await ctx.get('sessionQuery').observeSession(sessionId)
          try {
            report.owner = { headerPreset: observation.header.agentPreset, projectedPreset: observation.projections?.values?.agentPreset }
          } finally { observation[Symbol.dispose]() }
          report.completed = true
          return report
        }
        if (args.op === 'presetReads') {
          // silent-preset-reads: the Presets view's two automatic reads over
          // the remote — payload parity with the deliberate commands is
          // asserted by the parity op pattern (receipt covers the mechanism);
          // here the payloads must be shaped and the reads log-silent (the
          // counts ops bracket them).
          const presets = await service.presets(sessionId)
          const defaultGet = await service.defaultGet(sessionId)
          report.presetReads = {
            presetsIsList: Array.isArray(presets?.presets) || typeof presets?.status === 'string',
            defaultStatus: typeof defaultGet?.status === 'string' ? defaultGet.status : null,
          }
          report.completed = true
          return report
        }
        if (args.op === 'unknownSession') {
          const cause = await service.receipt('it-unknown-session').then(() => null, error => error)
          report.error = { name: cause?.name ?? null, code: cause?.code ?? null, message: String(cause?.message ?? '').slice(0, 120) }
          report.completed = true
          return report
        }
        if (args.op === 'logCounts') {
          report.counts = { ...countsFor(sessionId) }
          report.completed = true
          return report
        }
        if (args.op === 'parity') {
          // The deliberate user-visible invocation: exactly this one may
          // record command/run + command/done in the session log.
          const commands = ctx.get('commands')
          if (!commands) throw new Error('commands service unavailable from the probe ctx')
          const remoteReceipt = await service.receipt(sessionId)
          const settled = await commands.execute(agent, '/capabilities receipt', [], new AbortController().signal)
          const value = settled?.result !== undefined ? settled.result : settled
          let commandPayload = null
          if (typeof value?.text === 'string') { try { commandPayload = JSON.parse(value.text) } catch { commandPayload = null } }
          report.parity = {
            commandKind: value?.kind ?? null,
            equal: commandPayload !== null && JSON.stringify(remoteReceipt) === JSON.stringify(commandPayload),
            revision: remoteReceipt?.revision ?? null,
            skills: Array.isArray(remoteReceipt?.effective?.skills) ? remoteReceipt.effective.skills.length : -1,
          }
          // silent-preset-reads: the other two deliberate user-visible
          // invocations (these two may also log lifecycle events).
          const remotePresets = await service.presets(sessionId)
          const presetsSettled = await commands.execute(agent, '/capabilities presets', [], new AbortController().signal)
          const presetsValue = presetsSettled?.result !== undefined ? presetsSettled.result : presetsSettled
          let presetsCommandPayload = null
          if (typeof presetsValue?.text === 'string') { try { presetsCommandPayload = JSON.parse(presetsValue.text) } catch { presetsCommandPayload = null } }
          const remoteDefaultGet = await service.defaultGet(sessionId)
          const defaultSettled = await commands.execute(agent, '/capabilities default-get', [], new AbortController().signal)
          const defaultValue = defaultSettled?.result !== undefined ? defaultSettled.result : defaultSettled
          let defaultCommandPayload = null
          if (typeof defaultValue?.text === 'string') { try { defaultCommandPayload = JSON.parse(defaultValue.text) } catch { defaultCommandPayload = null } }
          report.presetParity = {
            presetsEqual: presetsCommandPayload !== null && JSON.stringify(remotePresets) === JSON.stringify(presetsCommandPayload),
            defaultEqual: defaultCommandPayload !== null && JSON.stringify(remoteDefaultGet) === JSON.stringify(defaultCommandPayload),
          }
          report.completed = true
          return report
        }
        if (args.op === 'registration') {
          Object.assign(report, await runRegistrationLifecycle(ctx))
          report.completed = true
          return report
        }
        throw new Error(`unknown op: ${String(args.op)}`)
      } catch (cause) {
        report.error = cause instanceof Error ? cause.message : String(cause)
        return report
      }
    },
  })
}

/**
 * Find the running fiber of the shipped capability remote row.
 * @param {*} ctx - probe context (host level)
 * @returns {{ fiber: *, runtimes: string[] }} the row fiber (or null) plus every runtime name for diagnosis
 */
function findShippedRowFiber(ctx) {
  const registry = ctx.registry ?? ctx.root?.registry
  const runtimes = []
  let fiber = null
  for (const runtime of registry?.values?.() ?? []) {
    const label = `${runtime.name ?? runtime.callback?.name ?? 'anonymous'}:${runtime.fibers.length}`
    runtimes.push(label)
    if (runtime.callback !== capabilityRemoteApply) continue
    fiber = [...runtime.fibers][0] ?? null
  }
  return { fiber, runtimes }
}

/** One in-process Remote call through the real gateway service (owner peer). */
async function gatewayDispatch(gateway, endpoint, args) {
  const peer = { principal: { kind: 'owner' }, interactions: 'none', signal: new AbortController().signal }
  try {
    const result = await gateway.dispatchRpc(endpoint, { args }, peer.signal, peer)
    if (result?.ok === true) return { ok: true, value: result.value }
    return { ok: false, code: result?.error?.code ?? null, message: String(result?.error?.message ?? '').slice(0, 200) }
  } catch (cause) {
    return { ok: false, code: cause?.code ?? null, message: String(cause?.message ?? cause).slice(0, 200) }
  }
}

/**
 * Real-Cordis lifecycle proof for the capability remote registration.
 *
 * 1. the shipped row owns all seven endpoints and both services;
 * 2. one read and one mutation dispatch through the real gateway reach the
 *    bridge spy faces (a real list payload, a real mutation preview result);
 * 3. a real fiber restart (the Cordis path a bundle reapply takes) leaves the
 *    seven endpoints and the package face live and dispatch still working —
 *    the pre-fix code left them withdrawn and the gateway rejected with
 *    `gateway/definition-unavailable` until an app restart;
 * 4. disposing the row (no survivor) leaves every endpoint and the package face
 *    absent, and both dispatches reject with `gateway/definition-unavailable`
 *    without touching the spy faces again.
 *
 * @param {*} ctx - probe context
 * @returns {Promise<object>} the recorded report
 */
async function runRegistrationLifecycle(ctx) {
  const typert = ctx.get('typert')
  const gateway = ctx.get('typertGateway')
  const registry = ctx.get('agentPresets')
  if (!typert || !gateway || !registry) throw new Error(`real typert/typertGateway/agentPresets services required (typert=${Boolean(typert)} gateway=${Boolean(gateway)} presets=${Boolean(registry)})`)
  const { fiber, runtimes } = findShippedRowFiber(ctx)
  const report = {
    gateway: { service: Boolean(gateway), dispatch: typeof gateway.dispatchRpc === 'function' },
    rowFiber: { found: Boolean(fiber), state: fiber?.state ?? null, name: fiber?.name ?? null },
    endpoints: {},
    package: {},
    hasSeen: {},
    dispatch: {},
    spies: { reads: 0, mutations: 0 },
  }
  const endpointState = () => CAPABILITY_ENDPOINTS.map(endpoint => (typert.local.get(endpoint) ? 1 : 0)).join('')
  const seenState = () => CAPABILITY_ENDPOINTS.map(endpoint => (typert.local.hasSeen(endpoint) ? 1 : 0)).join('')
  const packageLive = () => Boolean(typert.getPackage('weir-harness', 'host'))

  // The bridge spy: a real preset revision and a real child session, with the
  // probe's own faces on the module bridge so a dispatched read/mutation has a
  // countable landing point.
  const sessionId = randomUUID()
  const presetId = 'weir-creative'
  const cwd = join(IT_ROOT, 'ws')
  const unregisterPreset = await registry.register({ id: presetId, plugins: [{ id: 'weir-it-registration-tool', name: '@deepseek-ai/dsh-tool-skill' }] })
  let handle, unfeed
  try {
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd, agentPreset: presetId },
      setup: agentCtx => registry.mount(agentCtx, presetId).then(() => undefined),
    })
    unfeed = feedCapabilityReadBridge({
      readPresetId: presetId,
      profileContext: () => ctx.get('profileContext'),
      provider: { status: () => ({}), list: async () => ({ candidates: [], complete: true }) },
      inventory: async () => { report.spies.reads += 1; return { candidates: [], complete: true } },
      mcpOperations: () => ({
        preview: async () => { report.spies.mutations += 1; return { status: 'preview', plan: [], saved: false } },
        execute: async () => { report.spies.mutations += 1; return { status: 'mounted', saved: true, registryRevision: 1 } },
        executeBatch: async () => { report.spies.mutations += 1; return { status: 'mounted', items: [] } },
      }),
    })

    report.endpoints.before = endpointState()
    report.package.before = packageLive()
    report.dispatch.readBefore = await gatewayDispatch(gateway, `${CAPABILITY_READ_NAMESPACE}/list`, { sessionId })
    report.dispatch.mutationBefore = await gatewayDispatch(gateway, `${CAPABILITY_MUTATION_NAMESPACE}/mutate`, { sessionId, request: { action: 'preview' } })
    report.spies.before = { reads: report.spies.reads, mutations: report.spies.mutations }
    // A non-owner peer would be denied by remote access; the owner peer is the
    // real panel's shape, so no permissive mock is involved in reaching the row.
    report.receiver = {
      readProvided: Boolean(ctx.get(CAPABILITY_READ_SERVICE_KEY)),
      mutationProvided: Boolean(ctx.get(CAPABILITY_MUTATION_SERVICE_KEY)),
    }

    if (fiber) {
      // EXACTLY the production remount: the same fiber unloads and applies again
      // while the previous registration is still unwinding.
      await fiber.restart()
      await fiber.await()
      report.endpoints.afterRestart = endpointState()
      report.package.afterRestart = packageLive()
      report.hasSeen.afterRestart = seenState()
      report.dispatch.readAfterRestart = await gatewayDispatch(gateway, `${CAPABILITY_READ_NAMESPACE}/list`, { sessionId })
      report.dispatch.mutationAfterRestart = await gatewayDispatch(gateway, `${CAPABILITY_MUTATION_NAMESPACE}/mutate`, { sessionId, request: { action: 'preview' } })
      report.spies.afterRestart = { reads: report.spies.reads, mutations: report.spies.mutations }

      // Withdrawal without a survivor: the row is the only generation, so its
      // disposal must leave package + endpoints absent and the gateway must
      // reject before any service or bridge face is reached.
      fiber.dispose()
      await fiber.await()
      report.endpoints.afterDisposal = endpointState()
      report.package.afterDisposal = packageLive()
      report.hasSeen.afterDisposal = seenState()
      report.receiver.afterDisposal = {
        readProvided: Boolean(ctx.get(CAPABILITY_READ_SERVICE_KEY)),
        mutationProvided: Boolean(ctx.get(CAPABILITY_MUTATION_SERVICE_KEY)),
      }
      report.dispatch.readAfterDisposal = await gatewayDispatch(gateway, `${CAPABILITY_READ_NAMESPACE}/list`, { sessionId })
      report.dispatch.mutationAfterDisposal = await gatewayDispatch(gateway, `${CAPABILITY_MUTATION_NAMESPACE}/mutate`, { sessionId, request: { action: 'preview' } })
      report.spies.afterDisposal = { reads: report.spies.reads, mutations: report.spies.mutations }
    }
  } finally {
    unfeed?.()
    await handle?.dispose?.()
    await unregisterPreset?.()
  }
  // The runtime census only matters when the row could not be identified.
  if (!fiber) report.runtimes = runtimes
  await writeFile(join(IT_ROOT, 'ws', 'capability-remote-registration.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}

export const name = 'weir-it-capability-remote-probe'
export const inject = ['tools', 'skills', 'agents']
export { apply }
