// Worktree lane errors: one class, one stable code vocabulary. Every refusal a
// lane tool, command, or guard produces carries a code from WORKTREE_CODES and
// a `next` naming the recovery step, so the model never has to infer one.
// Pure module (no ctx, no node: imports).

/** Stable error codes (spec git-worktree-lanes). */
export const WORKTREE_CODES = Object.freeze({
  NOT_A_REPO: 'NOT_A_REPO',
  GIT_TOO_OLD: 'GIT_TOO_OLD',
  DETACHED_HEAD: 'DETACHED_HEAD',
  MAX_ACTIVE: 'MAX_ACTIVE',
  SCOPE_OVERLAP: 'SCOPE_OVERLAP',
  BRANCH_EXISTS: 'BRANCH_EXISTS',
  ROOT_OUTSIDE_REPO: 'ROOT_OUTSIDE_REPO',
  WORKTREE_DISABLED: 'WORKTREE_DISABLED',
  LEDGER_CORRUPT: 'LEDGER_CORRUPT',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  UNKNOWN_LANE: 'UNKNOWN_LANE',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  LANE_NOT_DISPATCHABLE: 'LANE_NOT_DISPATCHABLE',
  LANE_BUSY: 'LANE_BUSY',
  NOT_LANDABLE: 'NOT_LANDABLE',
  STALE_LANDABLE: 'STALE_LANDABLE',
  BASE_MOVED: 'BASE_MOVED',
  MAIN_STAGED: 'MAIN_STAGED',
  MAIN_DIRTY_OVERLAP: 'MAIN_DIRTY_OVERLAP',
  VERIFICATION_DISABLED: 'VERIFICATION_DISABLED',
  WORKTREE_REQUIRED: 'WORKTREE_REQUIRED',
  SHELL_UNAVAILABLE: 'SHELL_UNAVAILABLE',
  REMOVE_BLOCKED: 'REMOVE_BLOCKED',
  MAIN_AGENT_ONLY: 'MAIN_AGENT_ONLY',
  UNWATCHABLE_STATE: 'UNWATCHABLE_STATE',
  GIT_FAILED: 'GIT_FAILED',
})

export class WorktreeError extends Error {
  /**
   * @param {string} code - one of WORKTREE_CODES
   * @param {string} message - human/model-facing explanation
   * @param {object} [details]
   * @param {object | null} [details.next] - recovery step ({ tool, args } | { waitFor, hint })
   * @param {string} [details.lane] - lane id the error concerns
   * @param {object} [details.data] - extra structured facts (conflict paths, ...)
   */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`)
    this.name = 'WorktreeError'
    this.code = code
    this.reason = message
    this.next = details.next ?? null
    this.lane = details.lane ?? null
    this.data = details.data ?? null
  }

  /** Structured, JSON-safe form for tool results and the view endpoint. */
  toJSON() {
    return {
      code: this.code,
      message: this.reason,
      ...(this.lane ? { lane: this.lane } : {}),
      ...(this.next ? { next: this.next } : {}),
      ...(this.data ? { data: this.data } : {}),
    }
  }
}

/**
 * @param {unknown} error
 * @returns {error is WorktreeError}
 */
export function isWorktreeError(error) {
  return error instanceof WorktreeError
}
