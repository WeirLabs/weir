// Blackboard-remote integration probe (design D8, slice 2): drives the
// plugin-owned typert remote service DIRECTLY against the live kernel + the
// bridge the mounted blackboard plugin feeds — the headless composition has
// no typert gateway (same seam as the capability-remote probe), so this pins
// the pinned wire contract end-to-end at the service layer: list/read shapes,
// apply/write/remove arbitration on the shared board, the revision counter.
// Enabled only when ORRERY_IT_BLACKBOARD=1. Dev-only.
import { createBlackboardRemoteService } from '../../orrery-harness/src/blackboard/remote.js'

const compact = report => JSON.stringify(report).slice(0, 720)

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.tools.register({
    name: 'blackboard_remote_probe',
    description: 'Integration probe: drive the blackboard remote service (direct-call mirror of the host-layer typert row) against the live board.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['remote'] },
        _marker: { type: 'string' },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `BB_PROBE ${value.completed ? `done ${args?._marker ?? value.op}:${compact(value)}` : `error:${String(value.error ?? 'unknown').slice(0, 200)}`}` }],
    },
    async execute(args, exec) {
      const report = { completed: false, op: args?.op ?? null }
      try {
        const agent = exec.agent
        if (!agent?.id) throw new Error('probe agent unavailable')
        const service = createBlackboardRemoteService()
        // The board at probe time holds writer.key and contend.key (scenario state).
        const listed = service.list(agent, {})
        const read = service.read(agent, { keys: ['writer.key'] })
        report.listEntries = listed.entries.length
        report.rowShape = listed.entries[0] ? Object.keys(listed.entries[0]).sort() : []
        report.readContent = read.entries[0]?.content ?? null
        report.updatedAtNumber = typeof read.entries[0]?.updatedAt === 'number'
        // Full panel write path: apply → write → (one-shot consumed) → apply → remove.
        const applied = service.apply(agent, { key: 'panel.key' })
        report.acquired = applied.acquired
        report.tokenString = typeof applied.token === 'string'
        report.expiresAtNumber = typeof applied.expiresAt === 'number'
        const written = service.write(agent, { key: 'panel.key', entryType: 'map', summary: { fact: 'panel probe', cost: 'one probe', reVerify: 'blackboard_list panel.key' }, content: 'panel payload' })
        report.writeRevision = written?.revision ?? null
        // Arbitration parity: the write consumed the one-shot token, so the
        // next write on the EXISTING entry must fail without a fresh apply.
        const blocked = service.write(agent, { key: 'panel.key', entryType: 'map', summary: { fact: 'x', cost: 'y', reVerify: 'z' }, content: 'no token' })
        report.blockedWithoutAuthority = blocked?.ok === false
        const reapplied = service.apply(agent, { key: 'panel.key' })
        const removed = service.remove(agent, { key: 'panel.key' })
        report.removeOk = removed?.ok === true
        report.reapplyOk = reapplied?.acquired === true
        report.entriesAfter = service.list(agent, {}).entries.length
        report.completed = true
        return report
      } catch (cause) {
        report.error = cause instanceof Error ? cause.message : String(cause)
        return report
      }
    },
  })
}

export const name = 'orrery-it-blackboard-remote-probe'
export const inject = ['tools']
export { apply }
