/** Cleanup-only automatic recovery for Edit Lock (design D4).
 *
 * Classification uses only the durable turn/end reason. A provider error that
 * ends a turn while the session holds locks marks them abnormal; the session
 * may then only release, answer transfer requests or pause. Attempts, elapsed
 * recovery time and pause time are charged durably and never refunded by a
 * restart. Expiry re-evaluates; it never releases or extends. Exhaustion hands
 * the locks to a human. Business authority returns only via /edit-lock resume.
 */
export const RECOVERY_LIMITS = Object.freeze({
  attempts: 3,
  elapsedMs: 5 * 60_000,
  backoffMs: Object.freeze([15_000, 30_000, 60_000]),
  singlePauseMs: 15 * 60_000,
  cumulativePauseMs: 30 * 60_000,
})

/** @param {{attempts: number, elapsedMs: number}} usage @param {number} pendingElapsedMs */
export function recoveryBudgetLeft(usage, pendingElapsedMs = 0) {
  return usage.attempts < RECOVERY_LIMITS.attempts && usage.elapsedMs + pendingElapsedMs < RECOVERY_LIMITS.elapsedMs
}

/** @param {{resourceId: string, status: string, reason?: string}[]} locks @param {number} attempt */
export function cleanupPrompt(locks, attempt) {
  const lines = locks.filter(lock => lock.status === 'abnormal').map(lock => `- ${lock.resourceId} (${lock.reason ?? 'abnormal'})`)
  return [
    `Edit Lock cleanup-only recovery (attempt ${attempt} of ${RECOVERY_LIMITS.attempts}). The previous turn failed while this session held file ownership, so these locks are now abnormal:`,
    ...lines,
    'Business edits and new ownership are denied in this state. You may only: release a lock you no longer need (edit_lock_release), answer a pending ownership request (edit_lock_reply), or request a bounded pause while an external problem clears (edit_lock_pause). Do not attempt other file changes.',
    'When cleanup is done, stop. The user resumes normal editing from the Edit Lock panel.',
  ].join('\n')
}

/** @param {{
 *   domainFor: (agent: object) => Promise<any> | undefined,
 *   followup: (agent: object, text: string) => void,
 *   notify: (agent: object, text: string) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (handle: any) => void,
 *   warn?: (message: string) => void,
 * }} options */
export function createRecoveryDriver(options) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle })
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle))
  /** @typedef {{since: number, timer?: any, pausedUntil?: number, done?: boolean}} Recovery */
  /** @type {WeakMap<object, Recovery>} */
  const active = new WeakMap()
  let closed = false

  /** Charge time spent recovering since the last mark (pauses excluded).
   * @param {any} domain @param {object} agent @param {Recovery} recovery @param {{attempts?: number}} [extra] */
  async function chargeElapsed(domain, agent, recovery, extra = {}) {
    const elapsedMs = Math.max(0, now() - recovery.since)
    recovery.since = now()
    return domain.chargeRecovery(agent, { ...extra, elapsedMs })
  }
  /** @param {object} agent @param {Recovery} recovery */
  function cancel(agent, recovery) {
    if (recovery.timer) clearTimer(recovery.timer)
    recovery.timer = undefined
    recovery.done = true
    active.delete(agent)
  }
  /** @param {object} agent @param {Recovery} recovery @param {number} delayMs */
  function schedule(agent, recovery, delayMs) {
    if (recovery.timer) clearTimer(recovery.timer)
    recovery.timer = setTimer(() => { recovery.timer = undefined; void attempt(agent, recovery) }, delayMs)
  }
  /** @param {object} agent @param {Recovery} recovery */
  async function attempt(agent, recovery) {
    if (closed || recovery.done || active.get(agent) !== recovery) return
    try {
      const domain = await options.domainFor(agent)
      const status = await domain.status(agent)
      if (status.state !== 'recovering') { cancel(agent, recovery); return }
      if (!status.locks.some(/** @param {any} lock */ lock => lock.status === 'abnormal')) {
        cancel(agent, recovery)
        options.notify(agent, 'Edit Lock cleanup complete: no abnormal locks remain. Editing stays paused until the user chooses Continue editing.')
        return
      }
      const usage = await domain.recoveryUsage(agent)
      if (!recoveryBudgetLeft(usage, now() - recovery.since)) {
        await chargeElapsed(domain, agent, recovery)
        cancel(agent, recovery)
        options.notify(agent, `Edit Lock automatic cleanup stopped after ${RECOVERY_LIMITS.attempts} attempts or ${RECOVERY_LIMITS.elapsedMs / 60_000} minutes. The remaining files stay locked for the user to release or unlock from the Edit Lock panel.`)
        return
      }
      const charged = await chargeElapsed(domain, agent, recovery, { attempts: 1 })
      options.followup(agent, cleanupPrompt(status.locks, charged.attempts))
    } catch (error) {
      options.warn?.(`edit lock recovery attempt failed: ${/** @type {any} */ (error)?.message ?? error}`)
    }
  }

  return Object.freeze({
    /** Durable turn/end feed for one agent. @param {object} agent @param {any} reason */
    async onTurnEnd(agent, reason) {
      if (closed) return
      const domain = await options.domainFor(agent)
      if (!domain) return
      let recovery = active.get(agent)
      if (reason?.kind === 'aborted') { if (recovery) cancel(agent, recovery); return }
      if (!recovery) {
        if (reason?.kind !== 'error') return
        const marked = await domain.classifyAbnormal(agent, 'provider-error')
        if (!marked.length) return
        recovery = { since: now() }
        active.set(agent, recovery)
        options.notify(agent, `Edit Lock: the turn failed while this session held files; ${marked.length} lock(s) are now abnormal and editing is limited to cleanup.`)
      }
      if (recovery.pausedUntil && recovery.pausedUntil > now()) return
      const usage = await domain.recoveryUsage(agent)
      schedule(agent, recovery, RECOVERY_LIMITS.backoffMs[Math.min(usage.attempts, RECOVERY_LIMITS.backoffMs.length - 1)])
    },
    /** Pause request from the cleanup turn; expiry re-evaluates.
     * @param {object} agent @param {number} minutes */
    async pause(agent, minutes) {
      const recovery = active.get(agent)
      if (!recovery) throw new Error('no automatic recovery is in progress for this session')
      const domain = await options.domainFor(agent)
      const result = await domain.pause(agent, minutes)
      await chargeElapsed(domain, agent, recovery)
      recovery.pausedUntil = now() + result.pausedMs
      if (recovery.timer) clearTimer(recovery.timer)
      // Elapsed recovery time restarts after the pause, not during it.
      recovery.timer = setTimer(() => {
        recovery.timer = undefined
        recovery.since = now()
        recovery.pausedUntil = undefined
        void attempt(agent, recovery)
      }, result.pausedMs)
      return result
    },
    /** @param {object} agent */
    state(agent) { const recovery = active.get(agent); return recovery ? { pausedUntil: recovery.pausedUntil ?? null } : null },
    close() { closed = true },
  })
}
