// Real installed registry mounts both preset revisions in one Host. The
// direct-call read is deliberately NOT reported as HTTP acceptance.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'

export const id = 'capability-remote-dual-preset'
export const prompt = 'Run dual preset capability owner probe.'
export const env = { WEIR_IT_CAPABILITY_DUAL: '1' }
export function decide(options) {
  return lastOfRole(options, 'tool') ? textChunks('dual preset probe done') : toolCallChunks('capability_dual_preset_probe', {})
}
export function observe(obs) { return { probeServed: obs.toolNames.includes('capability_dual_preset_probe') } }
export function assert(run) {
  let report
  try { report = JSON.parse(readFileSync(join(run.ws, 'capability-dual-preset.json'), 'utf8')) } catch {}
  run.check('installed Host created both real preset mount orders', report?.orders?.length === 2 && report.orders.every(order => order.owners.length === 2 && !order.error), JSON.stringify(report?.orders?.map(order => ({ order: order.order, error: order.error, owners: order.owners.length }))))
  for (const order of report?.orders ?? []) {
    for (const owner of order.owners ?? []) {
      const label = `${order.order.join('>')}/${owner.id}`
      run.check(`${label} owning command selected its unique fixture`, owner.commandAfterBoth?.effective?.skills?.includes(`only-${owner.id}`) === true && owner.commandAfterBoth?.revision > 0, JSON.stringify(owner.commandAfterBoth))
      run.check(`${label} remote matches owning command (old code RED)`, JSON.stringify(owner.remoteAfterBoth) === JSON.stringify(owner.commandAfterBoth), JSON.stringify({ remote: owner.remoteAfterBoth?.effective?.skills, command: owner.commandAfterBoth?.effective?.skills, remoteWarnings: owner.remoteAfterBoth?.warnings }))
      run.check(`${label} remote did not append command lifecycle events`, owner.commandEventsFinal?.length === owner.commandEventsAfter?.length + 2, JSON.stringify({ before: owner.commandEventsAfter, after: owner.commandEventsFinal }))
      run.check(`${label} live projection observes preset identity`, owner.projectionLive?.source === 'live' && owner.projectionLive?.headerPreset === owner.id && owner.projectionLive?.projectedPreset != null, JSON.stringify(owner.projectionLive))
    }
  }
  run.check('committed selection supersedes stale header live and cold', report?.projection?.beforeSelect?.projectedPreset === 'weir' && report?.projection?.afterSelect?.headerPreset === 'weir' && report?.projection?.afterSelect?.projectedPreset === 'weir-creative' && report?.projection?.coldLong?.headerPreset === 'weir' && report?.projection?.coldLong?.projectedPreset === 'weir-creative', JSON.stringify(report?.projection))
  run.check('2000-event live and cold session observations complete', report?.projection?.liveLong?.eventCount >= 2000 && report?.projection?.coldLong?.eventCount >= 2000 && report.projection.coldLong.source === 'prepared' && report.projection.coldRepeat.source === 'prepared', JSON.stringify(report?.projection))
  run.check('each of nine observation leases is released', report?.leasesReleased === 9, JSON.stringify(report?.leasesReleased))
  run.check('headless installed CLI exits cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}
export default { id, prompt, env, decide, observe, assert }
