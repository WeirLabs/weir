// Web delivery channel: the host half of "send as DeepSeek Harness".
//
// The host decides WHAT to notify (classification, settle window, merging all
// live in ./index.js and ./policy.js) but cannot show a web Notification; the
// DSH page can. So the host queues the note here, the page PULLS it over a long
// poll, shows it, and ACKs what the browser did. The system command stays as
// the fallback so no notification is lost when no page is open or the page
// cannot show it.
//
// Safety contract (spec "待发通知通道对失败与异常页面安全"):
//   - a note is handed to exactly ONE puller;
//   - a note is delivered at most once: a page that showed it, or suppressed it
//     on purpose (window in the foreground), is final — no fallback;
//   - a note is never lost: no puller, a failed page, or a missing ack all fall
//     back to the system command;
//   - nothing here touches a session. Plain ESM, ctx-free; clock and timers are
//     injected.

/** A puller that has not polled within this window is considered gone. */
export const PULLER_FRESH_MS = 30_000
/** How long a pull is held open before it answers "nothing yet". */
export const PULL_HOLD_MS = 20_000
/** How long the host waits for a page to ACK a note it has taken. */
export const ACK_TIMEOUT_MS = 4_000

/**
 * What the page may report. `shown`/`pending`/`suppressed` are final (no
 * fallback); everything else falls back.
 */
export const FINAL_RESULTS = Object.freeze(['shown', 'pending', 'suppressed'])
export const FALLBACK_RESULTS = Object.freeze(['blocked', 'error', 'threw', 'unsupported'])

/**
 * @typedef {{ title: string, body: string, urgent: boolean }} Note
 * @typedef {Note & { tag: string, renotify: boolean, sound: boolean, foreground: 'skip' | 'always' }} WebNote
 * @typedef {{ id: string, note: WebNote }} Pulled
 */

/**
 * @param {object} deps
 * @param {(note: Note, options: { sound: boolean }) => unknown} deps.fallback - the system-command sender
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 * @param {{ warn?: (message: string) => void }} [deps.logger]
 */
export function createWebChannel({ fallback, now = Date.now, setTimer, clearTimer, logger }) {
  const start = setTimer ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => {
    const handle = globalThis.setTimeout(fn, ms)
    // A pending delivery must never keep the host process alive.
    ;/** @type {any} */ (handle)?.unref?.()
    return handle
  })
  const stop = clearTimer ?? ((/** @type {any} */ handle) => globalThis.clearTimeout(handle))

  /** @type {{ id: string, note: WebNote }[]} notes waiting for a puller */
  const queue = []
  /** @type {Map<string, { note: WebNote, timer: unknown }>} notes a page took, awaiting its ack */
  const inFlight = new Map()
  /** @type {{ resolve: (value: Pulled | null) => void, timer: unknown }[]} parked pulls */
  const waiters = []
  let lastPullAt = 0
  let nextId = 1
  let closed = false

  const hasPuller = () => waiters.length > 0 || now() - lastPullAt < PULLER_FRESH_MS

  /** @param {WebNote} note */
  function useFallback(note) {
    try {
      fallback({ title: note.title, body: note.body, urgent: note.urgent }, { sound: note.sound })
    } catch (/** @type {any} */ error) {
      logger?.warn?.(`notify: fallback delivery failed: ${error?.message ?? error}`)
    }
  }

  /** Hand a queued note to a taker and start the ack clock. @param {{ id: string, note: WebNote }} item */
  function take(item) {
    const timer = start(() => {
      // The page took it and went quiet: never lose the notification.
      if (inFlight.delete(item.id)) useFallback(item.note)
    }, ACK_TIMEOUT_MS)
    inFlight.set(item.id, { note: item.note, timer })
    return { id: item.id, note: item.note }
  }

  return {
    /**
     * Queue a note for the page. Falls back at once when no page is polling.
     * @param {WebNote} note
     * @returns {'queued' | 'fallback'}
     */
    send(note) {
      if (closed) return 'fallback'
      if (!hasPuller()) {
        useFallback(note)
        return 'fallback'
      }
      const item = { id: String(nextId++), note }
      const waiter = waiters.shift()
      if (waiter) {
        stop(waiter.timer)
        waiter.resolve(take(item))
      } else {
        queue.push(item)
        // No page may actually come back for it: bound the wait for a puller too.
        const timer = start(() => {
          const at = queue.indexOf(item)
          if (at >= 0) {
            queue.splice(at, 1)
            useFallback(item.note)
          }
        }, PULLER_FRESH_MS)
        ;/** @type {any} */ (item).timer = timer
      }
      return 'queued'
    },

    /**
     * The page's long poll. Resolves a note, or null after the hold time.
     * @param {number} [holdMs]
     * @param {AbortSignal} [signal] - the page's request signal; an abort frees the parked pull
     * @returns {Promise<Pulled | null>}
     */
    pull(holdMs = PULL_HOLD_MS, signal) {
      lastPullAt = now()
      if (closed) return Promise.resolve(null)
      const item = /** @type {any} */ (queue.shift())
      if (item) {
        if (item.timer !== undefined) stop(item.timer)
        return Promise.resolve(take(item))
      }
      return new Promise((resolve) => {
        const waiter = {
          resolve,
          timer: start(() => {
            const at = waiters.indexOf(waiter)
            if (at >= 0) waiters.splice(at, 1)
            // Still counts as a live puller: it polled just now.
            lastPullAt = now()
            resolve(null)
          }, holdMs),
        }
        waiters.push(waiter)
        // A page that went away must not be handed a note it can never show.
        signal?.addEventListener?.('abort', () => {
          const at = waiters.indexOf(waiter)
          if (at < 0) return
          waiters.splice(at, 1)
          stop(waiter.timer)
          resolve(null)
        }, { once: true })
      })
    },

    /**
     * The page reports what the browser did.
     * @param {string} id
     * @param {string} result
     * @returns {boolean} whether the ack matched a note in flight
     */
    ack(id, result) {
      const entry = inFlight.get(id)
      if (!entry) return false
      inFlight.delete(id)
      stop(entry.timer)
      if (!FINAL_RESULTS.includes(result)) useFallback(entry.note)
      return true
    },

    /** Whether any page is currently polling (for tests and status). */
    hasPuller,

    /** Drop everything; nothing is delivered after this. */
    close() {
      closed = true
      for (const waiter of waiters.splice(0)) {
        stop(waiter.timer)
        waiter.resolve(null)
      }
      for (const entry of inFlight.values()) stop(entry.timer)
      inFlight.clear()
      for (const item of queue.splice(0)) if (/** @type {any} */ (item).timer !== undefined) stop(/** @type {any} */ (item).timer)
    },
  }
}
