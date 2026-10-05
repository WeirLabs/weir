// Lane state machine: the single authority over which lane state may follow
// which. Pure functions over plain lane records — the ledger persists the
// result, the tools/commands/host settlement only ever reach a new state
// through `transition`. Pure module (no ctx, no node: imports).
import { WORKTREE_CODES, WorktreeError } from './errors.js'

export const STATES = Object.freeze([
  'preparing',
  'setup-failed',
  'ready',
  'working',
  'dirty',
  'no-commits',
  'branch-moved',
  'checking',
  'check-failed',
  'landable',
  'conflicted',
  'awaiting-approval',
  'declined',
  'landed',
  'kept',
  'cleaned',
  'abandoned',
])

/** States that no longer count against worktreeMaxActive. */
export const FINISHED = Object.freeze(['landed', 'kept', 'cleaned', 'abandoned'])

/** States a writing child may be bound in. */
export const DISPATCHABLE = Object.freeze(['ready', 'dirty', 'no-commits', 'branch-moved', 'check-failed', 'declined', 'conflicted'])

/** States whose recorded conclusion may still be landed (tree permitting). */
export const LANDABLE_FROM = Object.freeze(['landable', 'declined', 'conflicted'])

/** States in which the host may (re)run the precondition check. */
export const CHECKABLE = Object.freeze(['ready', 'working', 'dirty', 'no-commits', 'branch-moved', 'check-failed', 'landable', 'declined', 'conflicted'])

/** States whose UI refresh should poll (a host-side transition is expected). */
export const TRANSIENT = Object.freeze(['preparing', 'working', 'checking', 'awaiting-approval'])

/** States a lane watch (worktree_watch) may target: every conclusion state,
 * i.e. STATES minus the transient ones the host is actively driving. Watching
 * a transient state would mean subscribing to a transition the host is already
 * performing, which is noise, not information. Shared by the tool's argument
 * validation and the spec, so the set has exactly one source. */
export const WATCHABLE = Object.freeze(STATES.filter((state) => !TRANSIENT.includes(state)))

const NOT_FINISHED = STATES.filter((state) => !FINISHED.includes(state))

/**
 * Transition table: event → { from: allowed source states, to: target state }.
 * `to: null` means the event's own payload names the target (precondition
 * outcomes), constrained to `targets`.
 * @type {Record<string, { from: readonly string[], to: string | null, targets?: readonly string[] }>}
 */
export const TRANSITIONS = Object.freeze({
  'setup-ok': { from: ['preparing', 'setup-failed'], to: 'ready' },
  'setup-fail': { from: ['preparing'], to: 'setup-failed' },
  'setup-retry': { from: ['setup-failed'], to: 'preparing' },
  bind: { from: DISPATCHABLE, to: 'working' },
  // Precondition outcome (host settlement or explicit check): the payload's
  // `to` is one of the targets.
  checked: { from: CHECKABLE, to: null, targets: ['dirty', 'no-commits', 'branch-moved', 'landable', 'checking'] },
  'check-pass': { from: ['checking'], to: 'landable' },
  'check-fail': { from: ['checking'], to: 'check-failed' },
  // A landable conclusion whose tree no longer matches the lane is void.
  invalidate: { from: LANDABLE_FROM, to: 'working' },
  ask: { from: LANDABLE_FROM, to: 'awaiting-approval' },
  decline: { from: ['awaiting-approval'], to: 'declined' },
  conflict: { from: [...LANDABLE_FROM, 'awaiting-approval'], to: 'conflicted' },
  land: { from: [...LANDABLE_FROM, 'awaiting-approval'], to: 'landed' },
  keep: { from: ['landed'], to: 'kept' },
  clean: { from: ['landed', 'kept'], to: 'cleaned' },
  abandon: { from: NOT_FINISHED, to: 'abandoned' },
  missing: { from: NOT_FINISHED, to: 'abandoned' },
})

/**
 * @param {{ state: string }} lane
 * @returns {boolean} whether the lane counts against worktreeMaxActive
 */
export function isActive(lane) {
  return !FINISHED.includes(lane.state)
}

/**
 * Apply one event to a lane record, returning a NEW record (the input is not
 * mutated). An event that is not legal from the lane's state throws
 * ILLEGAL_TRANSITION (or a more specific code supplied by the caller).
 * @param {any} lane
 * @param {{ type: string, to?: string, at?: number, by?: string, reason?: string, patch?: object, code?: string }} event
 * @returns {any}
 */
export function transition(lane, event) {
  const rule = TRANSITIONS[event.type]
  if (!rule) throw new WorktreeError(WORKTREE_CODES.ILLEGAL_TRANSITION, `unknown lane event "${event.type}"`, { lane: lane.id })
  if (!rule.from.includes(lane.state)) {
    throw new WorktreeError(
      event.code ?? WORKTREE_CODES.ILLEGAL_TRANSITION,
      `lane ${lane.id} is ${lane.state}; "${event.type}" is only valid from ${rule.from.join(', ')}`,
      { lane: lane.id, next: nextFor(lane) },
    )
  }
  const to = rule.to ?? event.to
  if (typeof to !== 'string' || (rule.to === null && !rule.targets?.includes(to))) {
    throw new WorktreeError(WORKTREE_CODES.ILLEGAL_TRANSITION, `"${event.type}" needs a target among ${rule.targets?.join(', ')}`, { lane: lane.id })
  }
  const at = event.at ?? Date.now()
  const entry = { from: lane.state, to, event: event.type, at, by: event.by ?? 'host', ...(event.reason ? { reason: event.reason } : {}) }
  const next = { ...lane, ...(event.patch ?? {}), state: to, reason: event.reason ?? null, updatedAt: at, history: [...(lane.history ?? []), entry] }
  // A conclusion only survives into states that keep it.
  if (!['landable', 'awaiting-approval', 'declined', 'conflicted', 'landed', 'kept', 'cleaned'].includes(to)) next.landableTree = null
  return next
}

/**
 * The single next action for a lane: `{ tool, args, hint? }` the main agent
 * calls, `{ waitFor, hint? }` it waits for, or null for a finished lane.
 * @param {any} lane
 * @returns {{ tool: string, args: object, hint?: string } | { waitFor: string, hint?: string } | null}
 */
export function nextFor(lane) {
  const id = lane.id
  const delegateAgain = (hint) => ({ tool: 'delegate', args: { worktree: id }, hint })
  switch (lane.state) {
    case 'preparing':
      return { waitFor: 'lane-ready', hint: 'dependency setup is running in the lane' }
    case 'setup-failed':
      return { waitFor: 'user', hint: `setup failed; the user retries with /worktree setup ${id} or skips with /worktree setup ${id} --skip` }
    case 'ready':
      return delegateAgain('delegate the lane work with worktree set to this lane')
    case 'working':
      return lane.boundChild
        ? { waitFor: 'child-settle', hint: 'the bound worker is running; the host checks the lane when it settles' }
        : { tool: 'worktree_check', args: { lane: id }, hint: 'no worker is bound; check the lane' }
    case 'dirty':
      return delegateAgain('the lane has uncommitted changes: have a worker commit them')
    case 'no-commits':
      return delegateAgain('the lane has no commits ahead of its base: have a worker commit the work')
    case 'branch-moved':
      return delegateAgain(`the lane HEAD left ${lane.branch}: have a worker return to it`)
    case 'checking':
      return { waitFor: 'check-complete', hint: 'verification commands are running' }
    case 'check-failed':
      return delegateAgain('verification failed: have a worker fix the failure')
    case 'landable':
      return { tool: 'worktree_land', args: { lane: id } }
    case 'conflicted':
      return delegateAgain(`the lane conflicts with ${lane.base?.branch ?? 'its base'}: have a worker merge the base into the lane and resolve the conflicts`)
    case 'awaiting-approval':
      return { waitFor: 'user', hint: 'the merge approval card is waiting for the user' }
    case 'declined':
      return { waitFor: 'user', hint: 'the user declined the merge; land again only when the user asks' }
    case 'landed':
      return { waitFor: 'user', hint: `merged; the user chooses the cleanup (worktree_cleanup with mode keep, worktree, or all once they decide)` }
    default:
      return null
  }
}
