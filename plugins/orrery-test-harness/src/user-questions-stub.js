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
/** The blackboard promotion adjudication question id (the injected brief's ask, slice 3). */
const PROMOTION_QUESTION_ID = 'blackboard-promotion'

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.on('user-questions/request', (request, next) => {
    const questions = request?.questions
    if (!Array.isArray(questions)) return next()
    const answers = []
    for (const question of questions) {
      // The promotion brief asks one question per candidate (stable id); the
      // scripted headless user picks the FIRST option — the recommended
      // destination the scripted agent put first.
      if (question?.id === PROMOTION_QUESTION_ID) {
        const label = question?.options?.[0]?.label
        if (typeof label === 'string') answers.push({ id: question.id, selected: [label] })
        continue
      }
      if (!ANSWERED.has(question?.id)) return next()
      const label = question?.options?.[0]?.label
      if (typeof label !== 'string') return next()
      answers.push({ id: question.id, selected: [label] })
    }
    return { answers }
  })
}

export { name, inject, apply }
