// Preset-row entry: scoped Hook, consult tool, and turn-stopping adapter.
import { applyDecisionHooks } from './hook.js'
import { registerDecisionConsultTool } from './tool.js'

export function apply(ctx) {
  applyDecisionHooks(ctx)
  ctx.effect(() => registerDecisionConsultTool(ctx))
}

export const name = 'decision'
export const inject = ['tools']
