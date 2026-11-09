// Preset-row entry: scoped Hook, consult tool, selector defaults, and turn-stopping adapter.
import { applyDecisionHooks } from './hook.js'
import { registerDecisionConsultTool } from './tool.js'

export function apply(ctx) {
  applyDecisionHooks(ctx)
  ctx.on('agent/created', async ({ agent, source }) => {
    try {
      const broker = ctx.get('weirDecisionBroker')
      await broker?.initializeSelectorDefault({ agent, source })
    } catch {
      ctx.logger?.warn?.('Decision selector default initialization failed')
    }
  })
  ctx.effect(() => registerDecisionConsultTool(ctx))
}

export const name = 'decision'
export const inject = ['tools']
