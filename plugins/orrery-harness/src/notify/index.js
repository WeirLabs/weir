// Orrery notify: system-level notifications for session state changes — the
// agent needs the user (tool approval, a question, plan review), a turn
// failed or stopped, or a long turn finished. Mounted at PROFILE level (like
// orrery-settings) so it covers every session, not only Orrery-preset ones.
//
// Pure observer: it listens to the post-commit `session/event` feed and
// `agent/status`, never appends to a session (cold-read red line) and never
// steers/follows up. Delivery goes through the platform's stock notification
// command (./notifier.js); a delivery failure can never reach a turn.
// Plain ESM, ctx-only.
import { basename } from 'node:path'
import { overlayConfig } from '../shared/runtime-messages.js'
import { attentionOfToolCall, classifyTurnEnd, createCoalescer, DEFAULTS, isChildSession } from './policy.js'
import { compose } from './messages.js'
import { createNotifier } from './notifier.js'
import { RENOTIFY, tagFor } from './tags.js'
import { createWebChannel } from './web-channel.js'
import { wireNotifyPermissions } from './permissions-admin.js'
import { TEST_NOTE } from './permissions.js'

const name = 'orrery-notify'
const inject = []

/** The `notify` settings section: every key that is a switch must stay a real boolean. */
const SWITCHES = ['enabled', 'onComplete', 'onAttention', 'sound']
/** Allowed values of the foreground policy. */
const FOREGROUND_VALUES = ['skip', 'always']
/** Events older than this are replay, not news (a resumed session re-feeds history). */
const STALE_EVENT_MS = 60_000
/** Longest parent chain walked to find the session the user actually sees. */
const MAX_ANCESTORS = 8

/**
 * Resolve the effective options NOW (the settings service is live: a
 * volatile commit takes effect on the next event, no remount). Unusable
 * values fall back to the module defaults rather than throwing inside an
 * event listener.
 *
 * @param {any} ctx
 * @param {object} config
 */
function resolveOptions(ctx, config) {
  const merged = /** @type {Record<string, any>} */ (overlayConfig(ctx, 'notify', config, { defaults: DEFAULTS }))
  for (const key of SWITCHES) if (typeof merged[key] !== 'boolean') merged[key] = /** @type {Record<string, any>} */ (DEFAULTS)[key]
  for (const key of ['minTurnSeconds', 'settleMs', 'coalesceMs']) {
    const value = merged[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) merged[key] = /** @type {Record<string, any>} */ (DEFAULTS)[key]
  }
  if (!FOREGROUND_VALUES.includes(merged.foreground)) merged.foreground = DEFAULTS.foreground
  return /** @type {typeof DEFAULTS} */ (merged)
}

/**
 * Wire the listeners. Split from `apply` so tests drive the logic with an
 * injected notifier, clock and timers.
 *
 * @param {any} ctx
 * @param {object} config
 * @param {object} deps
 * @param {{ send(note: { title: string, body: string, urgent: boolean }, options: { sound: boolean }): boolean }} deps.notifier
 * @param {{ send(note: any): unknown } | undefined} [deps.channel] - web delivery channel; absent = system command only
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 * @returns {() => void} disposer
 */
export function wire(ctx, config, { notifier, channel, now = Date.now, setTimer, clearTimer }) {
  const startTimer =
    setTimer ??
    ((/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      const handle = globalThis.setTimeout(fn, ms)
      // A pending notification must never keep the host process alive.
      ;/** @type {any} */ (handle)?.unref?.()
      return handle
    })
  const stopTimer = clearTimer ?? ((/** @type {any} */ handle) => globalThis.clearTimeout(handle))

  /** @type {Map<string, number>} sessionId → turn start time */
  const turnStart = new Map()
  /** @type {Map<string, unknown>} sessionId → pending settle timer */
  const pending = new Map()
  // The coalescing window is read once: it is a code-level knob, not a setting.
  const coalescer = createCoalescer(resolveOptions(ctx, config).coalesceMs, now)

  /** @param {string} sessionId */
  function cancelPending(sessionId) {
    const handle = pending.get(sessionId)
    if (handle === undefined) return
    stopTimer(handle)
    pending.delete(sessionId)
  }

  /**
   * The session the user actually sees: a delegated child's approval prompt
   * surfaces under its top-level ancestor.
   *
   * @param {any} session
   * @returns {any}
   */
  function rootOf(session) {
    const sessions = ctx.get?.('sessions')
    let current = session
    for (let hop = 0; hop < MAX_ANCESTORS && isChildSession(current); hop++) {
      const parentId = current?.header?.parentSession
      const parent = typeof parentId === 'string' ? sessions?.get?.(parentId) : undefined
      if (!parent) break
      current = parent
    }
    return current
  }

  /** The session's title, else its workspace folder name. @param {any} session */
  function labelOf(session) {
    try {
      const title = ctx.get?.('sessionProjections')?.stateOf?.(session, 'title')
      if (typeof title === 'string' && title.trim().length > 0) return title
    } catch {
      // a title is decoration; fall through to the workspace name
    }
    const cwd = session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? basename(cwd) : ''
  }

  /** @param {any} session @param {import('./messages.js').NoteSpec} spec */
  function deliver(session, spec) {
    const options = resolveOptions(ctx, config)
    if (!options.enabled) return
    const root = rootOf(session)
    if (!coalescer.accept(`${root?.id ?? session?.id}:${spec.type}`)) return
    try {
      const note = compose(spec, labelOf(root))
      if (channel) {
        // Page first (DSH's own name); the channel falls back to the system command itself.
        channel.send({ ...note, tag: tagFor(root?.id ?? session?.id, spec.type), renotify: RENOTIFY, sound: options.sound, foreground: options.foreground })
      } else {
        notifier.send(note, { sound: options.sound })
      }
    } catch (/** @type {any} */ error) {
      ctx.logger?.warn?.(`notify: delivery failed: ${error?.message ?? error}`)
    }
  }

  /** Hold a finished turn briefly: the agent running again retracts it. @param {any} session @param {import('./messages.js').NoteSpec} spec */
  function settle(session, spec) {
    cancelPending(session.id)
    const { settleMs } = resolveOptions(ctx, config)
    pending.set(
      session.id,
      startTimer(() => {
        pending.delete(session.id)
        deliver(session, spec)
      }, settleMs),
    )
  }

  /** @param {any} session @param {any} event */
  function onTurnEnd(session, event) {
    const started = turnStart.get(session.id)
    turnStart.delete(session.id)
    const outcome = classifyTurnEnd(event.data?.reason)
    if (outcome.kind === 'none' || isChildSession(session)) return
    const options = resolveOptions(ctx, config)
    if (!options.enabled) return
    if (outcome.kind === 'completed') {
      if (!options.onComplete) return
      const durationMs = started === undefined ? undefined : (event.time ?? now()) - started
      if (durationMs !== undefined && durationMs < options.minTurnSeconds * 1000) return
      settle(session, { type: 'completed', ...(durationMs === undefined ? {} : { durationMs }) })
      return
    }
    if (!options.onAttention) return
    settle(session, { type: outcome.kind, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) })
  }

  const offEvent = ctx.on('session/event', (/** @type {any} */ session, /** @type {any} */ event) => {
    try {
      if (typeof event?.time === 'number' && now() - event.time > STALE_EVENT_MS) return
      switch (event?.type) {
        case 'turn/start':
          turnStart.set(session.id, event.time ?? now())
          cancelPending(session.id)
          return
        case 'turn/end':
          onTurnEnd(session, event)
          return
        case 'approval/asked': {
          if (!resolveOptions(ctx, config).onAttention) return
          deliver(session, { type: 'approval', ...(typeof event.data?.toolName === 'string' ? { toolName: event.data.toolName } : {}) })
          return
        }
        case 'tool/call': {
          const attention = attentionOfToolCall(String(event.data?.name ?? ''), String(event.data?.arguments ?? ''))
          // A delegated child cannot open a human interaction; only the top-level session asks.
          if (!attention || isChildSession(session) || !resolveOptions(ctx, config).onAttention) return
          deliver(session, attention.kind === 'plan' ? { type: 'plan' } : { type: 'question', ...(attention.question === undefined ? {} : { question: attention.question }) })
          return
        }
      }
    } catch (/** @type {any} */ error) {
      // A listener must never throw into the session's event dispatch.
      ctx.logger?.warn?.(`notify: event handling failed: ${error?.message ?? error}`)
    }
  })

  // Auto-continuation (a woken job, a todo steer, a goal round) starts the
  // agent again right after a turn ended: the held "finished" note is stale.
  const offStatus = ctx.on('agent/status', (/** @type {any} */ payload) => {
    if (payload?.status === 'running' && payload.agent?.id) cancelPending(payload.agent.id)
  })
  const offDisposed = ctx.on('session/disposed', (/** @type {any} */ session) => {
    if (!session?.id) return
    cancelPending(session.id)
    turnStart.delete(session.id)
  })

  // Worktree decision cards bypass the tool layer: the lane service calls the
  // userQuestions service directly, so no whitelisted tool/call event ever
  // fires for them. The worktree plugin side-emits this cordis event instead
  // (merge-approval and abandon-confirmation cards only; the cleanup card is
  // deliberately silent — it follows the approval the user just answered).
  const offWorktreeQuestion = ctx.on('worktree/question', (/** @type {any} */ session, /** @type {any} */ payload) => {
    try {
      if (!resolveOptions(ctx, config).onAttention) return
      deliver(session, { type: 'question', ...(typeof payload?.question === 'string' && payload.question.trim() ? { question: payload.question.trim() } : {}) })
    } catch (/** @type {any} */ error) {
      // Same discipline as the session/event listener: never throw into the
      // event dispatch.
      ctx.logger?.warn?.(`notify: worktree question handling failed: ${error?.message ?? error}`)
    }
  })

  return () => {
    for (const off of [offEvent, offStatus, offDisposed, offWorktreeQuestion]) if (typeof off === 'function') off()
    for (const handle of pending.values()) stopTimer(handle)
    pending.clear()
    turnStart.clear()
    coalescer.clear()
  }
}

/** @param {any} ctx @param {object} [config] */
function apply(ctx, config = {}) {
  const notifier = createNotifier({ logger: ctx.logger })
  if (!notifier.supported) ctx.logger?.warn?.(`notify: system notifications are not supported on platform "${process.platform}"`)
  // The page delivers (as DeepSeek Harness); the system command is the fallback.
  const channel = createWebChannel({ fallback: (note, options) => notifier.send(note, options), logger: ctx.logger })
  const offWire = wire(ctx, config, { notifier, channel })
  // Page endpoints (pull/ack) and the macOS permission panel's endpoints. They
  // register from this row, whose `./notify` subpath already exists, so no new
  // package subpath is needed (S19); services come through ctx.inject (S20).
  const offEndpoints = wireNotifyPermissions(ctx, {
    channel,
    // The permission panel's test goes through the real path, and shows even
    // with the window in front (the user is looking at the settings page).
    sendTest: () => channel.send({ ...TEST_NOTE, tag: tagFor('test', 'test'), renotify: RENOTIFY, sound: true, foreground: 'always' }),
  })
  return () => {
    offWire()
    offEndpoints()
    channel.close()
  }
}

export { name, inject, apply }
