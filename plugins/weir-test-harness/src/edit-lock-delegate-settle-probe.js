// Dev-only, scenario-gated lifecycle probe. The child itself performs the
// managed write; this trusted listener only extends its existing ownership at
// the awaited stopping boundary, never acquiring or releasing on its behalf.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IT_ROOT } from './mock-kit.js'
import { textOf } from './message-text.js'
import { childPrompt, content } from './scenarios/editlock-delegate-settle.js'

const scenario = 'editlock-delegate-settle'
const target = join(IT_ROOT, 'ws', 'fixture.txt')
const trace = process.env.WEIR_IT_TRACE ?? join(IT_ROOT, 'trace.jsonl')

function apply(ctx, config = {}) {
  if (config.enabled !== true || process.env.WEIR_IT_SCENARIO !== scenario) return
  const lockService = ctx.weirEditLock
  let designated = null
  let fired = false
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (designated || agent?.session?.header?.origin !== 'subagent' || agent.session.header.delegationDepth !== 1) return
    if (message?.source?.kind === 'user' && textOf(message).includes(`TASK: ${childPrompt}:`)) designated = agent
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (fired || agent !== designated || !existsSync(target) || readFileSync(target, 'utf8') !== content) return
    // describe is observation only. Do not extend a missing, interrupted, or
    // someone else's lock, even if the fixture happens to contain our text.
    const before = await lockService.describe(agent)
    const lockBefore = before.status?.locks?.find(lock => lock.resourceId === target)
    if (before.status?.state !== 'active' || before.status?.interrupted !== false || lockBefore?.owner !== agent.id || lockBefore.status !== 'active') return
    fired = true
    const record = { kind: 'editlock-delegate-settle-boundary', session: agent.id, target, lockBefore, holdAck: null, lockAfter: null, stateAfter: null, interruptedAfter: null, retention: null, observedAt: null, error: null }
    try {
      record.holdAck = await lockService.hold({ agent }, 600_000)
      const after = await lockService.describe(agent)
      record.lockAfter = after.status?.locks?.find(lock => lock.resourceId === target) ?? null
      record.stateAfter = after.status?.state ?? null
      record.interruptedAfter = after.status?.interrupted ?? null
      record.retention = after.status?.retention ?? null
    } catch (error) {
      record.error = String(error?.message ?? error)
    }
    record.observedAt = Date.now()
    mkdirSync(dirname(trace), { recursive: true })
    appendFileSync(trace, JSON.stringify(record) + '\n')
  })
}

export const name = 'weir-it-edit-lock-delegate-settle-probe'
export const inject = ['weirEditLock']
export { apply }
