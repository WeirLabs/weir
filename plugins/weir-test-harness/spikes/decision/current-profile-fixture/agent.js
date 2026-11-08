// Disposable preset-scoped Hook + consult tool for the current-profile P0 spike.
export const name = 'weir-decision-p0-agent'
export const inject = ['tools']

export function apply(ctx) {
  const broker = () => {
    const service = ctx.get('weirDecisionP0R2')
    if (!service) throw new Error('P0 spike broker unavailable')
    return service
  }
  ctx.on('user-questions/request', async (request, next) => {
    if (!request.agent) return next()
    return broker().hook({ agent: request.agent, request, next })
  }, { prepend: true })
  ctx.tools.register({
    name: 'decision_consult',
    description: 'Disposable P0 consult through the lane-local Broker.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        request_id: { type: 'string' },
        options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } },
      },
      required: ['question'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `${JSON.stringify(value)}\nDecision consult ${value.outcome}` }],
    },
    async execute(args, exec) { return broker().consult(exec.agent, args) },
  })
}
