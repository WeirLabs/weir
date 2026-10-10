// Dev-only headless adapter: select the production preset before the first
// user turn, as the Web session creator does. No tool registration or filtering.
import { appendFileSync } from 'node:fs'

export const name = 'weir-it-preset-delegation-surface-probe'
export const inject = ['agentPresets', 'tools']
export function apply(ctx) {
  const preset = process.env.WEIR_IT_DELEGATION_PRESET
  if (!preset) return
  ctx.on('agent/created', async ({ agent }) => {
    if ((agent.session.header.delegationDepth ?? 0) > 0) return
    const hostTools = ctx.tools.schemas().map(tool => tool.name)
    await ctx.agentPresets.select(agent, preset)
    appendFileSync(process.env.WEIR_IT_TRACE, JSON.stringify({
      kind: 'production-preset-selected', preset: ctx.agentPresets.composedPreset(agent.ctx), session: agent.id,
      hostTools,
    }) + '\n')
  })
}
