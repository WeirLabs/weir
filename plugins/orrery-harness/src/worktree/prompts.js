// Model- and user-facing text for worktree lanes: the standing prompt
// contract, the live lane board, the child lane contract, settlement
// notifications, and the decision-card copy. Templates are English (text
// discipline); instance content (titles, commit subjects) passes through
// verbatim. Pure module.
import { nextFor } from './state.js'
import { watchFacts } from './watches.js'

export const LANES_SECTION_NAME = 'orchestrator:worktree-lanes'
export const LANES_CONTEXT_NAME = 'orrery:worktree-board'
export const LANES_CONTEXT_ORDER = 130

export const LANES_SECTION_TEXT = `# Worktree lanes

Lanes are isolated git worktrees the host owns (state, checks, merge). You supply intent; the host decides every step.
- worktree_open({ title, scope? }) opens a lane on its own branch inside the repository. Declare scope (path globs) when parallel lanes must not touch the same files.
- delegate({ ..., worktree: <lane> }) binds the worker to the lane. Write the brief as usual; the host adds the lane contract.
- When a bound worker settles, the host checks the lane itself and notifies you with the next step. Do not re-check by hand.
- worktree_land({ lane }) asks the user to approve the merge. Only the user approves; never claim a lane is merged before the result says so.
- worktree_watch({ lane, states }) subscribes YOU to conclusion states of any lane in this repository — including lanes another session opened. You get exactly one notification when the lane reaches a watched state (or when the watch times out); do not poll worktree_check while a watch is pending.
- Every worktree result and notice carries "next". Do exactly that next step; when it is waitFor, end your turn.
- Cleanup and abandoning are the user's decision (worktree_cleanup / worktree_abandon ask them).`

/** @param {{ tool?: string, args?: object, waitFor?: string, hint?: string } | null} next */
export function renderNext(next) {
  if (!next) return 'none'
  if ('waitFor' in next && next.waitFor) return `wait for ${next.waitFor}${next.hint ? ` (${next.hint})` : ''}`
  return `${next.tool}(${JSON.stringify(next.args ?? {})})${next.hint ? ` — ${next.hint}` : ''}`
}

/**
 * Runtime-context board: one line per lane of this session's repository.
 * Lanes with active watches append `· N watching` (watches come from the
 * ledger's top-level array; absent/empty means no suffix, byte-identical to
 * the pre-watch board).
 * @param {{ lanes: any[], mode: boolean, watches?: any[] }} input
 */
export function renderBoard({ lanes, mode, watches }) {
  const active = lanes.filter((lane) => !['kept', 'cleaned', 'abandoned'].includes(lane.state))
  if (active.length === 0 && !mode) return ''
  const lines = [`Worktree lanes${mode ? ' (Worktree mode ON: the main agent does not edit files; writing delegations need worktree=<lane>)' : ''}:`]
  if (active.length === 0) lines.push('- (no active lanes)')
  for (const lane of active) {
    const facts = watchFacts(watches, lane.id)
    lines.push(`- ${lane.id} · ${lane.state}${lane.baseMoved ? ' · base-moved' : ''}${facts.watchCount > 0 ? ` · ${facts.watchCount} watching` : ''} · next: ${renderNext(nextFor(lane))}`)
  }
  return lines.join('\n')
}

/**
 * The lane contract appended to a bound child's prompt.
 * @param {any} lane
 * @param {{ readOnly: boolean }} options
 */
export function renderChildContract(lane, { readOnly }) {
  const scope = lane.scope?.length ? `\n- Scope: write only paths matching ${lane.scope.join(', ')} (relative to the lane).` : ''
  if (readOnly) {
    return `<lane id="${lane.id}">
You are investigating lane ${lane.id} at ${lane.path} (branch ${lane.branch}).
- Pass workdir="${lane.path}" (or a directory inside it) on every shell call; use absolute paths under it for reads.
</lane>`
  }
  return `<lane id="${lane.id}">
You work in lane ${lane.id}: an isolated git worktree at ${lane.path} on branch ${lane.branch} (base ${lane.base.branch}).
- Every shell call MUST pass workdir="${lane.path}" (or a directory inside it). Calls without it are refused.
- Write files only with absolute paths under ${lane.path}.${scope}
- Stay on ${lane.branch}: do not checkout, switch, push, or rename/delete branches. Merging ${lane.base.branch} into the lane to resolve conflicts is allowed.
- Commit your finished work on ${lane.branch} before you end (git add + git commit). The host checks the lane when you finish: uncommitted changes or no commits send the lane back to you.
- You are a delegated worker: do not call create_goal/update_goal; goal tools reject non-top-level agents.
- Report blockers and outcomes in your final report; do not send_message to the parent (its id is not available to you).
- Run every command, tests included, with workdir at the lane root; the integration-test root resolves lane-locally by default.
</lane>`
}

/**
 * Settlement / transition notification for the owning main agent.
 * @param {any} lane
 * @param {string} [detail]
 */
export function renderNotice(lane, detail) {
  const tree = lane.state === 'landable' && lane.landableTree ? `@${lane.landableTree.slice(0, 7)}` : ''
  return `[worktree] lane ${lane.id} ${lane.state}${tree}${detail ? ` (${detail})` : ''} → next: ${renderNext(nextFor(lane))}`
}

/**
 * Watch-hit notification for the SUBSCRIBING session (cross-session capable):
 * the lane reached one of the watched states; the watch is consumed.
 * @param {any} lane - the lane AFTER the hitting transition
 */
export function renderWatchHit(lane) {
  return `[worktree] watch hit: lane ${lane.id} reached ${lane.state} → next: ${renderNext(nextFor(lane))}`
}

/**
 * Watch-expiry notification: the watch's single delivery when no target state
 * was reached in time; the watch is removed.
 * @param {any} watch - the expired watch record
 */
export function renderWatchExpired(watch) {
  return `[worktree] watch expired: lane ${watch.laneId} did not reach ${watch.states.join(', ')} within the watch timeout; the subscription is removed`
}
