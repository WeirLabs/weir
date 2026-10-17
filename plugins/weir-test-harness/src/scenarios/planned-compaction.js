import { blockText, textChunks, toolCallChunks } from '../mock-kit.js'

export function plannedCase(mode = 'success') {
  return {
    id: mode === 'success' ? 'planned-compaction' : `planned-compaction-${mode}`,
    prompt: 'planned-compaction-parent',
    env: { WEIR_IT_PLANNED_COMPACTION: '1', WEIR_IT_COMPACTION_MODE: mode, WEIR_IT_WINDOW: mode === 'hard' ? '2000' : '1000000' },
    decide(_options, obs) {
      const history = obs.transcript
      if (obs.messages.some((m) => m.role === 'user' && m.source?.kind === 'user' && blockText(m) === 'planned-compaction-parent')) {
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
        sessionId: obs.sessionId,
        plannedSummaryRead: obs.messages.some((m) => m.source?.kind === 'compact-checkpoint' && (m.content ?? []).some((b) => b.text?.includes('<compacted-summary>'))),
        plannedCheckpointIds: obs.messages.filter((m) => m.source?.kind === 'compact-checkpoint' && blockText(m).includes('<compacted-summary>')).map((m) => m.id),
        plannedResumeRead: obs.messages.some((m) => m.role === 'user' && m.source?.kind === 'weir-context-guard' && blockText(m).includes('Resume the task from the compaction summary')),
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
        const chain = [end, start, summary, checkpoint, close].map((i) => events[i])
        const ordered = end >= 0 && end < start && start < summary && summary < checkpoint && checkpoint < close
          && chain.every((e, i) => Number.isInteger(e?.eventSeq) && (i === 0 || chain[i - 1].eventSeq < e.eventSeq))
        const nativeId = events[start]?.data?.compactionId
        const replacement = events[checkpoint]
        const span = events[summary]?.data?.shadowedRange
        const nativeCommit = ordered && typeof nativeId === 'string' && nativeId.length > 0
          && events[summary]?.data?.compactionId === nativeId && events[close]?.data?.compactionId === nativeId
          && replacement?.compactionId === nativeId
          && replacement?.surfaceOp?.op === 'replace'
          && Number.isInteger(span?.start) && Number.isInteger(span?.end) && span.start <= span.end
          && replacement.surfaceOp.startSeq === span.start && replacement.surfaceOp.endSeq === span.end
          && [events[start].eventSeq, events[summary].eventSeq].every((seq) => replacement.sourceEventSeqs?.includes(seq))
        run.check('turn end precedes native commit chain', nativeCommit, JSON.stringify({ queued, end, start, summary, checkpoint, close }))
        // JSONL record order links the post-commit feed to adapter dispatch; the
        // adapter's call counter is not comparable to native session event seqs.
        run.check('subsequent main model request actually reads native summary and resume', nativeCommit && requests.some((r) =>
          r.sessionId === subject && r.purpose === 'main' && r.plannedSummaryRead && r.plannedResumeRead
          && typeof replacement.messageId === 'string' && r.plannedCheckpointIds?.includes(replacement.messageId)
          && run.records.indexOf(r) > run.records.indexOf(events[close])))
        run.check('exactly one native compaction', events.filter((e) => e.type === 'compaction/start').length === 1)
      } else {
        const expected = mode === 'cancel' ? 'cancelled' : mode === 'noop' ? 'noop' : 'blocked'
        run.check('distinct native outcome observed', run.records.some((r) => r.kind === 'planned-outcome' && r.outcome === expected), JSON.stringify(run.records.filter((r) => r.kind === 'planned-outcome' || r.kind === 'planned-probe-error')))
        run.check('no fictional summary or success wake', summary < 0 && !run.inboxInserted.some((r) => r.session === subject && r.text.includes('Compaction completed')))
        run.check('no todo steer after blocked outcome', !run.inboxInserted.some((r) => r.session === subject && r.text.includes('<todo_continuation>') && events.some((e) => e.type === 'weir/compaction' && e.data.kind === 'blocked') && run.records.indexOf(r) > run.records.findIndex((e) => e.type === 'weir/compaction' && e.session === subject && e.data.kind === 'blocked')))
      }
      // DSH 0.2.1 headless joins the session until quiescence instead of
      // exiting at the parent's FIRST idle, so in the hard-window mode the
      // parent also compacts and its post-compaction continuation produces the
      // final message. Both terminal texts prove the same property — the
      // subject settled while the parent's live interval was open, with no
      // probe error — so the assertion accepts either (0.2.0 recorded
      // 'planned-parent-finished'; 0.2.1 may end on the resumed turn).
      const finished = run.stdout.includes('planned-parent-finished') || run.stdout.includes('planned-subject-finished')
      run.check('subject completed through live parent interval', run.code === 0 && finished && !run.records.some((r) => r.kind === 'planned-probe-error'), run.stdout.slice(-300))
    },
  }
}
export default plannedCase()
