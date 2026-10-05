// Scripted user-questions answerer for the `notify-worktree` integration
// scenario. The headless composition mounts dsh-base's userQuestions service
// but has no UI answerer, so its `user-questions/request` waterfall would
// reject NO_PROVIDER and worktree_land could never reach its approval card.
// This probe answers the lane decision cards headlessly — picking each card's
// FIRST option ("Merge into <base> (--no-ff)" on the merge card, "Keep
// worktree" on the cleanup card) — so a real worktree_land runs end to end.
// Anything it does not recognise falls through (next()), preserving the stock
// NO_PROVIDER behavior. Dev-only; never install into a real profile.
const name = 'orrery-it-user-questions-stub'
const inject = []

/** The lane service's decision-card ids (src/worktree/lanes.js). */
const ANSWERED = new Set(['merge', 'abandon', 'cleanup'])

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.on('user-questions/request', (request, next) => {
    const question = request?.questions?.[0]
    const label = question?.options?.[0]?.label
    if (!ANSWERED.has(question?.id) || typeof label !== 'string') return next()
    return { answers: [{ id: question.id, selected: [label] }] }
  })
}

export { name, inject, apply }
