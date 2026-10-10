// Cold reconstruction is evidence-only: never recreate a maintenance queue or
// infer success from our best-effort audit. Session events are DSH-native.
export function unconfirmedRequest(events) {
  let call, accepted
  const native = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'compact_context') call = event.data.callId
    if (event.type === 'tool/result' && call && event.data?.message?.toolCallId === call) {
      const text = (event.data.message.content ?? []).map((b) => b.text ?? '').join('\n')
      if (!event.data.message.isError && /Compaction (request .* queued|scheduled at the turn boundary)/.test(text)) accepted = event.seq
      call = undefined
    }
    const id = event.data?.compactionId
    if (event.type === 'compaction/start') native.set(id, { start: event.seq })
    const span = native.get(id)
    if (span && event.type === 'compaction/summary') span.summary = event.seq
    if (event.type === 'user/message' && event.surfaceOp?.op === 'replace') {
      for (const item of native.values()) {
        if (item.summary !== undefined && event.sourceEventSeqs?.includes(item.start) && event.sourceEventSeqs?.includes(item.summary)) item.checkpoint = true
      }
    }
    if (span && event.type === 'compaction/end' && !event.data.error && span.checkpoint && accepted !== undefined && span.summary > accepted) accepted = undefined
  }
  return accepted !== undefined
}
