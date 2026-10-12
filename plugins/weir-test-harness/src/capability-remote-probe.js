// Single-preset counterpart to the dual-owner probe. Registry.register mounts
// the actual selection plugin in a preset revision; the probe addresses its
// exact child session, not the host-level CLI session. Calls remain direct
// mirrors: headless has no authenticated Typert Web gateway.
import { createCapabilityReadService } from '../../weir-harness/src/capabilities/capability-remote.js'
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
    const id = 'weir-it-selection'
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
    description: 'Integration probe: drive the capability read remote (direct-call mirror) with session-log silence evidence.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['reads', 'presetReads', 'unknownSession', 'logCounts', 'parity'] },
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
        const service = createCapabilityReadService({ sessionQuery: ctx.get('sessionQuery') })

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
        throw new Error(`unknown op: ${String(args.op)}`)
      } catch (cause) {
        report.error = cause instanceof Error ? cause.message : String(cause)
        return report
      }
    },
  })
}

export const name = 'weir-it-capability-remote-probe'
export const inject = ['tools', 'skills', 'agents']
export { apply }
