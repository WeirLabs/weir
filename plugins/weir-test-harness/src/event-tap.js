// Event tap for the integration profile: appends interesting session events
// (compaction/*, todo/write, turn boundaries) to the same JSONL trace the mock
// LLM writes (WEIR_IT_TRACE), and taps the cordis weir/* audit channel
// (session logs no longer carry custom-typed events — see
// weir-harness/src/shared/audit.js). Dev-only.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { textOf } from './message-text.js'
import { defaultItRoot } from './it-root.js'
// Single-sourced audit vocabulary (design D4): relative cross-package import,
// proven resolvable under the link-installed headless profile by every IT run.
import { AUDIT_TYPES, AUDIT_SUBTYPES } from '../../weir-harness/src/shared/audit.js'
import { installStopProbe } from './edit-lock-stop-probe.js'
import { installAutoResumeProbe } from './edit-lock-auto-resume-probe.js'
import { installStaleSweepProbe } from './edit-lock-stale-sweep-probe.js'
import { installColdViewProbe } from './edit-lock-cold-view-probe.js'

const name = 'weir-it-event-tap'
const inject = ['fs']

// The driver passes WEIR_IT_TRACE explicitly; standalone mounts share its root.
const TRACE = process.env.WEIR_IT_TRACE ??
  join(process.env.WEIR_IT_ROOT ?? defaultItRoot(), 'trace.jsonl')

/**
 * Audit event names the tap subscribes to: every registered type plus each
 * registered sub-event kind (cordis dispatch is exact-name only, so
 * `supervision/<kind>` sub-events must be enumerated — design D4/task 2.4).
 */
const AUDIT_SUBSCRIPTIONS = [
  ...Object.values(AUDIT_TYPES),
  ...Object.entries(AUDIT_SUBTYPES).flatMap(([name, kinds]) => kinds.map((kind) => `${AUDIT_TYPES[name]}/${kind}`)),
]

function tap(record) {
  try {
    mkdirSync(dirname(TRACE), { recursive: true })
    appendFileSync(TRACE, JSON.stringify(record) + '\n')
  } catch {
    // best-effort tap
  }
}


function apply(ctx) {
  installStopProbe(ctx, tap)
  installAutoResumeProbe(ctx, tap)
  installStaleSweepProbe(ctx, tap)
  installColdViewProbe(ctx, tap)
  // Cordis audit channel (cold-safe; session logs stay clean).
  for (const type of AUDIT_SUBSCRIPTIONS) {
    ctx.on(`weir/${type}`, (record) => {
      tap({ kind: 'session-event', session: record?.session ?? null, type: record?.type ?? `weir/${type}`, data: record?.data ?? null })
    })
  }
  ctx.on('agent/created', (payload) => {
    tap({ kind: 'agent-created', session: payload?.agent?.id, origin: payload?.agent?.session?.header?.origin, depth: payload?.agent?.session?.header?.delegationDepth })
  })
  ctx.on('agent/inbox/inserted', (payload) => {
    tap({ kind: 'inbox-inserted', session: payload?.agent?.id, text: textOf(payload?.message, { limit: 600 }) })
  })
  // The worktree ask funnel's notification side-emit (notify-worktree
  // scenario): a pure cordis event, never a session-log entry.
  ctx.on('worktree/question', (session, payload) => {
    tap({ kind: 'worktree-question', session: session?.id ?? null, question: typeof payload?.question === 'string' ? payload.question : null })
  })
  // Session blackboard release events ride the enumerated AUDIT_SUBSCRIPTIONS
  // above ('blackboard/released' sub-event), so no extra subscription here —
  // the blackboard scenario asserts the arbitration release carried the
  // subscribed waiters through that channel.
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
      const text = textOf(message, { limit: 600 })
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
        text: textOf(event.data, { limit: 600 }),
      })
    }
  })
}

export { name, inject, apply }
