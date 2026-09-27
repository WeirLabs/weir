// Event tap for the integration profile: appends interesting session events
// (orrery/*, compaction/*, todo/write, turn boundaries) to the same JSONL
// trace the mock LLM writes (ORRERY_IT_TRACE). Dev-only.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const name = 'orrery-it-event-tap'
const inject = []

const TRACE = process.env.ORRERY_IT_TRACE ?? '/tmp/orrery-it/trace.jsonl'

function tap(record) {
  try {
    mkdirSync(dirname(TRACE), { recursive: true })
    appendFileSync(TRACE, JSON.stringify(record) + '\n')
  } catch {
    // best-effort tap
  }
}

function summarizeMessage(message) {
  const content = message?.content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .slice(0, 160)
  }
  // followup/steer inputs are raw ContentBlock arrays before admission
  if (Array.isArray(message)) {
    return message
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .slice(0, 160)
  }
  return ''
}

function apply(ctx) {
  ctx.on('agent/created', (payload) => {
    tap({ kind: 'agent-created', session: payload?.agent?.id, origin: payload?.agent?.session?.header?.origin, depth: payload?.agent?.session?.header?.delegationDepth })
  })
  ctx.on('agent/inbox/inserted', (payload) => {
    tap({ kind: 'inbox-inserted', session: payload?.agent?.id, text: summarizeMessage(payload?.message) })
  })
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (typeof type !== 'string') return
    if (type.startsWith('orrery/') || type.startsWith('compaction/') || type === 'todo/write') {
      tap({ kind: 'session-event', session: session.id, type })
      return
    }
    if (type === 'turn/end') {
      tap({ kind: 'session-event', session: session.id, type, reason: event.data?.reason?.kind })
      return
    }
    if (type === 'user/message') {
      tap({
        kind: 'session-event',
        session: session.id,
        type,
        source: event.data?.source?.kind,
        text: summarizeMessage(event.data),
      })
    }
  })
}

export { name, inject, apply }
