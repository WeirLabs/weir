/** Turn-end settling of still-held locks (design D2/D3).
 *
 * A finished turn that leaves locks unreleased is not an error, it is unfinished
 * business: the model decides whether each file is really done with. So the
 * session is continued once with a notice that asks for exactly one of two
 * things — release the lock, or ask explicitly to keep it for a bounded period.
 *
 * Only the durable `completed` reason enters this path. A provider error keeps its
 * cleanup-only recovery and a user stop keeps its latch: neither is nudged, and
 * classification still reads nothing but the turn/end reason (AGENTS §3.5).
 *
 * The notice count is bounded and configurable, and the disposition after it runs
 * out is configurable too (`release` or `abnormal`). Both are policy supplied by
 * the caller, so this module holds no configuration and no clock.
 */

/** @param {{reason?: {kind?: string}}[]} locks @param {number} attempt @param {number} maxAttempts @param {{defaultMinutes: number, singleMaxMinutes: number, cumulativeMaxMinutes: number, remainingMinutes: number, unavailable?: boolean}} budget */
export function settlementPrompt(locks, attempt, maxAttempts, budget) {
  const lines = locks.map(lock => `- ${lock.resourceId}`)
  // With the batch budget gone there is only one honest instruction left, so the
  // hold option is not mentioned at all rather than offered and then refused.
  const option = budget.unavailable
    ? 'Retention is unavailable because its settings conflict, so no reservation can be made: release each file (edit_lock_release).'
    : budget.remainingMinutes <= 0
    ? `This batch has used its whole retention budget (${budget.cumulativeMaxMinutes} minutes), so no new reservation is available: release each file (edit_lock_release).`
    : `For each file, either release it because you are done with it (edit_lock_release), or ask to keep ownership for a bounded time (edit_lock_hold, at most ${budget.singleMaxMinutes} minutes per request and ${budget.remainingMinutes} minutes left in this batch).`
  return [
    `Edit Lock: the turn ended while this session still held ${locks.length} file(s):`,
    ...lines,
    option,
    `Do not edit other files to work around this. A file you leave unresolved after ${maxAttempts} notice(s) is handled for you.`,
    `This is notice ${attempt} of ${maxAttempts}.`,
  ].join('\n')
}

/** @param {{
 *   domainFor: (agent: object) => Promise<any> | undefined,
 *   followup: (agent: object, text: string) => void,
 *   notify: (agent: object, text: string) => void,
 *   limits: () => {holdDefaultMinutes: number, holdSingleMaxMinutes: number, holdCumulativeMaxMinutes: number, nudgeAttempts: number, nudgeFallback: 'release'|'abnormal'},
 *   now?: () => number,
 *   onSettled?: (agent: object) => void,
 *   warn?: (message: string) => void,
 * }} options */
export function createSettlementDriver(options) {
  const now = options.now ?? Date.now
  let closed = false
  /** Notices already sent for the current batch of one agent. In-memory on
   * purpose: a restart restores the session as interrupted and takes the
   * cleanup route instead, so a lost counter cannot loop. @type {WeakMap<object, number>} */
  const notices = new WeakMap()
  /** @type {Set<Promise<unknown>>} */
  const running = new Set()
  /** Agents whose next turn is the settle follow-up itself. @type {WeakSet<object>} */
  const nudged = new WeakSet()

  /** The notice counter is keyed by the live agent object, so a non-object key can
   * never be remembered. Making that explicit turns a caller mistake into a clear
   * failure instead of a silent "nothing happened". @param {unknown} agent */
  function remember(agent) {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) {
      throw new Error('settlement requires a live agent object')
    }
  }
  /** @param {object} agent */
  function forget(agent) {
    if (!agent || typeof agent !== 'object') return
    notices.delete(agent)
    nudged.delete(agent)
  }

  /** @param {object} agent @param {any} domain @param {any[]} locks */
  async function dispose(agent, domain, locks) {
    const limits = options.limits()
    if (limits.nudgeFallback === 'abnormal') {
      // The team asked for human handling: keep the locks, never silently free them.
      const marked = await domain.classifyAbnormal(agent, 'unsettled-after-notices')
      options.notify(agent, `Edit Lock: ${marked.length} file(s) stayed locked and are now flagged for the user to sort out in the Edit Lock panel.`)
    } else {
      const { released } = await domain.releaseHeld(agent)
      options.notify(agent, released.length
        ? `Edit Lock: ${released.length} file(s) stayed locked after ${limits.nudgeAttempts} notice(s), so they were released for other sessions.`
        : 'Edit Lock: no file is held any more.')
    }
    forget(agent)
  }

  /** @param {object} agent @param {any} domain */
  async function settle(agent, domain) {
    remember(agent)
    const status = await domain.status(agent)
    // Only ordinary ownership counts. Abnormal and interrupted locks have their
    // own paths, and a pending confirmation already requires a human.
    const held = status.locks.filter(lock => lock.status === 'active')
    if (held.length === 0) { forget(agent); return }
    const limits = options.limits()
    const retention = status.retention ?? { held: false, remainingMs: 0, holdCumulativeMs: 0 }
    // Already reserved and still inside its period: nothing to ask, and the
    // expiry timer owns what happens next.
    if (retention.held && retention.remainingMs > 0) return
    const attempts = notices.get(agent) ?? 0
    if (attempts >= limits.nudgeAttempts) { await dispose(agent, domain, held); return }
    notices.set(agent, attempts + 1)
    // The follow-up starts a turn of its own; that turn must not count as the
    // holder getting back to work, or the count would reset forever.
    nudged.add(agent)
    const remainingMinutes = Math.max(0, Math.floor((limits.holdCumulativeMaxMinutes * 60_000 - retention.holdCumulativeMs) / 60_000))
    options.followup(agent, settlementPrompt(held, attempts + 1, limits.nudgeAttempts, {
      defaultMinutes: limits.holdDefaultMinutes,
      singleMaxMinutes: limits.holdSingleMaxMinutes,
      cumulativeMaxMinutes: limits.holdCumulativeMaxMinutes,
      remainingMinutes,
      unavailable: limits.holdUnavailable === true,
    }))
  }

  return Object.freeze({
    /** Durable turn/end feed for one agent. @param {object} agent @param {any} reason */
    onTurnEnd(agent, reason) {
      if (closed || reason?.kind !== 'completed') return
      const domain = options.domainFor(agent)
      if (!domain) return
      const job = Promise.resolve(domain)
        .then(resolved => (resolved ? settle(agent, resolved) : undefined))
        .catch(error => options.warn?.(`edit lock settlement failed: ${error?.message ?? error}`))
        .finally(() => running.delete(job))
      running.add(job)
    },
    /** The holder started a new turn, so the batch is in use again: the notice
     * budget restarts. Without this a long session would run out of notices over
     * unrelated turns. @param {object} agent */
    turnStarted(agent) {
      if (agent && typeof agent === 'object' && nudged.delete(agent)) return
      forget(agent)
    },
    /** The expiry timer released the batch: nothing left to settle. @param {object} agent */
    settled(agent) { forget(agent) },
    /** @param {object} agent */
    noticeCount(agent) { return notices.get(agent) ?? 0 },
    /** Host shutdown waits for in-flight settlement instead of dropping it. */
    async drain() { await Promise.allSettled([...running]) },
    close() { closed = true },
  })
}
