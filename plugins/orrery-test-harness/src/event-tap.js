// Event tap for the integration profile: appends interesting session events
// (compaction/*, todo/write, turn boundaries) to the same JSONL trace the mock
// LLM writes (ORRERY_IT_TRACE), and taps the cordis orrery/* audit channel
// (session logs no longer carry custom-typed events — see
// orrery-harness/src/shared/audit.js). Dev-only.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const name = 'orrery-it-event-tap'
const inject = []

const TRACE = process.env.ORRERY_IT_TRACE ?? '/Users/young/.orrery-it/trace.jsonl'

/** The orrery audit vocabulary emitted on the cordis bus (keep in sync). */
const ORRERY_AUDIT_TYPES = ['intent-hit', 'intent-classify', 'continuation-blocked', 'continuation-stop', 'supervision']

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
      .slice(0, 600)
  }
  // followup/steer inputs are raw ContentBlock arrays before admission
  if (Array.isArray(message)) {
    return message
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .slice(0, 600)
  }
  return ''
}

function apply(ctx) {
  // Cordis audit channel (cold-safe; session logs stay clean).
  for (const type of ORRERY_AUDIT_TYPES) {
    ctx.on(`orrery/${type}`, (record) => {
      tap({ kind: 'session-event', session: record?.session ?? null, type: record?.type ?? `orrery/${type}`, data: record?.data ?? null })
    })
  }
  ctx.on('agent/created', (payload) => {
    tap({ kind: 'agent-created', session: payload?.agent?.id, origin: payload?.agent?.session?.header?.origin, depth: payload?.agent?.session?.header?.delegationDepth })
  })
  ctx.on('agent/inbox/inserted', (payload) => {
    tap({ kind: 'inbox-inserted', session: payload?.agent?.id, text: summarizeMessage(payload?.message) })
  })
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (typeof type !== 'string') return
    if (type.startsWith('compaction/') || type === 'todo/write') {
      tap({ kind: 'session-event', session: session.id, type, data: event.data ?? null })
      return
    }
    if (type === 'turn/end') {
      tap({ kind: 'session-event', session: session.id, type, reason: event.data?.reason?.kind })
      return
    }
    if (type === 'tool/result') {
      const message = event.data?.message
      const text = summarizeMessage(message)
      if (text.startsWith('hash_edit applied') || text.startsWith('>>> mismatch')) {
        tap({ kind: 'session-event', session: session.id, type, hashEdit: true, isError: message?.isError === true, meta: event.data?.meta ?? null })
      }
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
