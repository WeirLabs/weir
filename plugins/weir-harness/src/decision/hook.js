// Agent-scoped prepend Hook adapter and turn-boundary cleanup.

/** @param {any} ctx */
export function applyDecisionHooks(ctx) {
  ctx.on('user-questions/request', async (request, next) => {
    const agent = request.agent
    if (!agent || (agent.session?.header?.delegationDepth ?? 0) >= 1) return next()
    const broker = ctx.get('weirDecisionBroker')
    if (!broker || broker.status().available !== true) return next()
    let verdict
    try {
      verdict = await broker.hook({ agent, request, signal: request.signal })
    } catch (error) {
      if (request.signal?.aborted) throw new Error('Decision Hook aborted', { cause: request.signal.reason ?? error })
      return next()
    }
    if (verdict.kind === 'answer') return verdict.answer
    if (verdict.why === 'cancelled' || request.signal?.aborted) {
      throw new Error('Decision Hook aborted', { cause: request.signal?.reason })
    }
    try {
      const answer = await next()
      if (verdict.caseId && verdict.why === 'awaiting_user') await broker.hookUserAnswer({ caseId: verdict.caseId, answer })
      return answer
    } catch (error) {
      if (verdict.caseId) await broker.hookUserAborted({ caseId: verdict.caseId }).catch(() => {})
      throw error
    }
  }, { prepend: true })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const broker = ctx.get('weirDecisionBroker')
    if (broker?.status().available === true) await broker.turnStopping({ agent })
  })
}
