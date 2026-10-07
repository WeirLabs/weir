// Capability-remote integration probe (silent-capability-reads task 2.4):
// mirrors the plugin-owned read remote as a DIRECT call (the headless
// composition has no typert gateway — design doc risk table). The IT
// composition's own weir-skill-selection row already mounts the real plugin
// (which feeds the module-level read bridge) — exactly like production, where
// the preset row mounts it and the host-layer remote row never does. The
// probe drives createCapabilityReadService against a live session: receipt /
// list / conditions, the unknown-session typed error, payload parity with the
// deliberate `/capabilities receipt` command, and the in-band command/run +
// command/done counts proving the reads never touched the session log.
// Enabled only when WEIR_IT_CAPABILITY_REMOTE=1. Dev-only.
import { createCapabilityReadService } from '../../weir-harness/src/capabilities/capability-remote.js'

const compact = report => JSON.stringify(report).slice(0, 560)

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
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
        const sessionId = exec.agent?.session?.id
        if (typeof sessionId !== 'string') throw new Error('probe session unavailable')
        const service = createCapabilityReadService()

        if (args.op === 'reads') {
          const receipt = await service.receipt(sessionId)
          const listing = await service.list(sessionId)
          const conditions = await service.conditions(sessionId)
          report.receipt = receipt
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
          const settled = await commands.execute(exec.agent, '/capabilities receipt', [], new AbortController().signal)
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
          const presetsSettled = await commands.execute(exec.agent, '/capabilities presets', [], new AbortController().signal)
          const presetsValue = presetsSettled?.result !== undefined ? presetsSettled.result : presetsSettled
          let presetsCommandPayload = null
          if (typeof presetsValue?.text === 'string') { try { presetsCommandPayload = JSON.parse(presetsValue.text) } catch { presetsCommandPayload = null } }
          const remoteDefaultGet = await service.defaultGet(sessionId)
          const defaultSettled = await commands.execute(exec.agent, '/capabilities default-get', [], new AbortController().signal)
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
export const inject = ['tools', 'skills']
export { apply }
