import { textChunks, toolCallChunks } from '../mock-kit.js'

export function plannedCase(mode = 'success') {
  return {
    id: mode === 'success' ? 'planned-compaction' : `planned-compaction-${mode}`,
    prompt: 'planned-compaction-parent',
    env: { WEIR_IT_PLANNED_COMPACTION: '1', WEIR_IT_COMPACTION_MODE: mode, WEIR_IT_WINDOW: mode === 'hard' ? '2000' : '1000000' },
    decide(_options, obs) {
      const history = obs.transcript
      if (history.includes('planned-compaction-parent')) {
        return history.includes('planned-probe-finished') ? textChunks('planned-parent-finished') : toolCallChunks('planned_compaction_probe', {})
      }
      if (history.includes('planned-background-notice')) return textChunks('planned-background-observed')
      const calls = obs.messages.flatMap((m) => m.content ?? []).filter((b) => b.type === 'tool-call')
      if (history.includes('<compacted-summary>') && history.includes('Resume the task')) {
        if (calls.some((b) => b.name === 'todo_write' && b.arguments.includes('completed'))) return textChunks('planned-subject-finished')
        return toolCallChunks('todo_write', { todos: [{ content: 'planned work', status: 'completed' }] })
      }
      if (mode === 'noop') return toolCallChunks('compact_context', {})
      if (!calls.some((b) => b.name === 'todo_write')) return toolCallChunks('todo_write', { todos: [{ content: 'planned work', status: 'pending' }] })
      if (!history.includes('planned durable filler')) return textChunks('planned durable filler '.repeat(600))
      return toolCallChunks('compact_context', {})
    },
    observe(obs) {
      return {
        plannedSummaryRead: obs.messages.some((m) => m.source?.kind === 'compact-checkpoint' && (m.content ?? []).some((b) => b.text?.includes('<compacted-summary>'))),
        plannedResumeRead: obs.transcript.includes('Resume the task from the compaction summary'),
      }
    },
    assert(run) {
      const subject = run.records.find((r) => r.kind === 'planned-subject')?.session
      const events = run.events.filter((e) => e.session === subject)
      const requests = run.requests
      const queued = events.findIndex((e) => e.type === 'tool/result' && e.plannedCompaction)
      const end = events.findIndex((e, i) => i > queued && e.type === 'turn/end')
      const start = events.findIndex((e) => e.type === 'compaction/start')
      const summary = events.findIndex((e) => e.type === 'compaction/summary')
      const checkpoint = events.findIndex((e) => e.type === 'user/message' && e.source === 'compact-checkpoint')
      const close = events.findIndex((e) => e.type === 'compaction/end')
      if (mode !== 'hard') run.check('model dispatched compact_context', queued >= 0 && requests.some((r) => r.emittedNames?.includes('compact_context')))
      if (['success', 'hard'].includes(mode)) {
        run.check('turn end precedes native commit chain', end >= 0 && end < start && start < summary && summary < checkpoint && checkpoint < close, JSON.stringify({ queued, end, start, summary, checkpoint, close }))
        run.check('subsequent main model request actually reads native summary and resume', requests.some((r) => r.purpose === 'main' && r.plannedSummaryRead && r.plannedResumeRead))
        run.check('exactly one native compaction', events.filter((e) => e.type === 'compaction/start').length === 1)
      } else {
        const expected = mode === 'cancel' ? 'cancelled' : mode === 'noop' ? 'noop' : 'blocked'
        run.check('distinct native outcome observed', run.records.some((r) => r.kind === 'planned-outcome' && r.outcome === expected), JSON.stringify(run.records.filter((r) => r.kind === 'planned-outcome' || r.kind === 'planned-probe-error')))
        run.check('no fictional summary or success wake', summary < 0 && !run.inboxInserted.some((r) => r.session === subject && r.text.includes('Compaction completed')))
        run.check('no todo steer after blocked outcome', !run.inboxInserted.some((r) => r.session === subject && r.text.includes('<todo_continuation>') && events.some((e) => e.type === 'weir/compaction' && e.data.kind === 'blocked') && run.records.indexOf(r) > run.records.findIndex((e) => e.type === 'weir/compaction' && e.session === subject && e.data.kind === 'blocked')))
      }
      run.check('subject completed through live parent interval', run.stdout.includes('planned-parent-finished') && !run.records.some((r) => r.kind === 'planned-probe-error'))
    },
  }
}
export default plannedCase()
