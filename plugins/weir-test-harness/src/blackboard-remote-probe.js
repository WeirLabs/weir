// Blackboard-remote integration probe (design D8, slice 2): drives the
// plugin-owned typert remote service DIRECTLY against the live kernel + the
// bridge the mounted blackboard plugin feeds — the headless composition has
// no typert gateway (same seam as the capability-remote probe), so this pins
// the pinned wire contract end-to-end at the service layer: list/read shapes,
// apply/write/remove arbitration on the shared board, the revision counter.
// Enabled only when WEIR_IT_BLACKBOARD=1. Dev-only.
import { createBlackboardRemoteService } from '../../weir-harness/src/blackboard/remote.js'

const compact = report => JSON.stringify(report).slice(0, 720)

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.tools.register({
    name: 'blackboard_remote_probe',
    description: 'Integration probe: drive the blackboard remote service (direct-call mirror of the host-layer typert row) against the live board.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['remote', 'promotion', 'promotion-verify'] },
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
        if (args?.op === 'promotion') {
          // Slice 3: the panel button's request over the SAME pinned remote
          // service — the delivery of the evaluation brief into the main
          // agent happens timer-deferred, so the agent's next request sees it.
          const result = service.requestPromotion(agent, {})
          report.requested = result.ok === true
          report.promotionError = result.ok === false ? result.error : null
          report.completed = true
          return report
        }
        if (args?.op === 'promotion-verify') {
          // Post-marking read-only verification: the promoted marker rides
          // list/read rows, every authority-bearing mutation refuses, and a
          // second mark reports the existing marker.
          const marked = service.list(agent, {}).entries.find((entry) => entry.key === 'promote.key')
          report.promotedMarker = marked?.promoted?.destination ?? null
          const promotedWrite = service.write(agent, { key: 'promote.key', entryType: 'map', summary: 'x', content: 'no token anyway' })
          report.writeRefused = promotedWrite?.ok === false && /promoted/.test(promotedWrite.error)
          const promotedRemove = service.remove(agent, { key: 'promote.key' })
          report.removeRefused = promotedRemove?.ok === false && /promoted/.test(promotedRemove.error)
          const promotedApply = service.apply(agent, { key: 'promote.key' })
          report.applyRefused = promotedApply?.acquired === false && promotedApply?.promoted === true
          const remarked = service.markPromoted(agent, { key: 'promote.key', destination: 'runtime-map' })
          report.alreadyMarked = remarked?.ok === true && remarked?.alreadyPromoted === true
          report.listCount = service.list(agent, {}).entries.length
          report.completed = true
          return report
        }
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
        const written = service.write(agent, { key: 'panel.key', entryType: 'map', summary: 'panel probe (one probe; re-verify: blackboard_list panel.key)', content: 'panel payload' })
        report.writeRevision = written?.revision ?? null
        // Arbitration parity: the write consumed the one-shot token, so the
        // next write on the EXISTING entry must fail without a fresh apply.
        const blocked = service.write(agent, { key: 'panel.key', entryType: 'map', summary: 'x', content: 'no token' })
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

export const name = 'weir-it-blackboard-remote-probe'
export const inject = ['tools']
export { apply }
