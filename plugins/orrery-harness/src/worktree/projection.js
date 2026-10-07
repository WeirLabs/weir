// `orreryWorktree` session projection: whether the session is in Worktree
// mode, which lanes it opened, and the session's auto-approve override —
// folded ONLY from events the runtime already writes (`command/run` +
// `command/done` for /worktree on|off and /worktree approve <mode>,
// `tool/result` meta for lane tools) — cold-read safe, no custom session
// event type (S13). Pure module.

export const WORKTREE_PROJECTION_KEY = 'orreryWorktree'

export const APPROVE_MODES = Object.freeze(['manual', 'auto-keep', 'auto-clean'])
/** @returns {{ mode: boolean, lanes: string[], pending: Record<string, { mode?: boolean, approve?: string }>, approve: string | null }} */
export function initialWorktreeState() {
  return { mode: false, lanes: [], pending: {}, approve: null }
}

export const worktreeStateSchema = {
  /** @param {any} value */
  parse(value) {
    if (!value || typeof value !== 'object' || typeof value.mode !== 'boolean' || !Array.isArray(value.lanes) || !value.pending || typeof value.pending !== 'object') {
      throw new Error('orreryWorktree: bad projection state')
    }
    // `approve` is additive: legacy logs and snapshots folded before it
    // existed simply lack the field (null = no session override).
    if (value.approve !== undefined && value.approve !== null && !APPROVE_MODES.includes(value.approve)) {
      throw new Error('orreryWorktree: bad projection state (approve)')
    }
    return value
  },
}

export const worktreeViewSchema = {
  /** @param {any} value */
  parse(value) {
    if (!value || typeof value !== 'object' || typeof value.mode !== 'boolean' || !Array.isArray(value.lanes)) throw new Error('orreryWorktree: bad projection view')
    if (value.approve !== undefined && value.approve !== null && !APPROVE_MODES.includes(value.approve)) throw new Error('orreryWorktree: bad projection view (approve)')
    return value
  },
}

/**
 * Fold one session event. Unrelated events return the SAME state reference.
 * A mode switch takes effect only when its command settled successfully
 * (`/worktree on` in a non-repository fails and must not flip the marker);
 * the same pairing discipline gates `/worktree approve <mode>`, and an
 * invalid mode value never even enters the pending slot, so no settlement
 * can flip it (S13 cold-read safety).
 * @param {{ mode: boolean, lanes: string[], pending: Record<string, { mode?: boolean, approve?: string }>, approve: string | null }} state
 * @param {any} event
 */
export function foldWorktreeState(state, event) {
  const data = event?.data
  if (event?.type === 'command/run' && data?.name === 'worktree') {
    const words = String(data.args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const verb = words[0] ?? ''
    if ((verb === 'on' || verb === 'off') && typeof data.commandId === 'string') {
      return { ...state, pending: { ...state.pending, [data.commandId]: { mode: verb === 'on' } } }
    }
    if (verb === 'approve' && typeof data.commandId === 'string' && APPROVE_MODES.includes(words[1] ?? '')) {
      return { ...state, pending: { ...state.pending, [data.commandId]: { approve: words[1] } } }
    }
    return state
  }
  if (event?.type === 'command/done' && typeof data?.commandId === 'string' && data.commandId in state.pending) {
    const { [data.commandId]: target, ...rest } = state.pending
    if (data.kind !== 'success') return { ...state, pending: rest }
    return {
      ...state,
      pending: rest,
      ...(typeof target?.mode === 'boolean' ? { mode: target.mode } : {}),
      ...(typeof target?.approve === 'string' ? { approve: target.approve } : {}),
    }
  }
  if (event?.type === 'tool/result') {
    const lane = data?.meta?.worktree?.lane
    if (typeof lane === 'string' && data.meta.worktree.tool === 'worktree_open' && !state.lanes.includes(lane)) {
      return { ...state, lanes: [...state.lanes, lane] }
    }
  }
  return state
}

/** Client view: the pending map stays host-side. */
const viewCache = new WeakMap()
/** @param {{ mode: boolean, lanes: string[], approve: string | null }} state */
export function worktreeView(state) {
  // Reuse the view object across internal-only changes (pending map).
  const cached = viewCache.get(state.lanes)
  if (cached && cached.mode === state.mode && cached.approve === state.approve) return cached
  const view = { mode: state.mode, lanes: state.lanes, approve: state.approve }
  viewCache.set(state.lanes, view)
  return view
}
