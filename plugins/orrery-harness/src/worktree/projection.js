// `orreryWorktree` session projection: whether the session is in Worktree
// mode and which lanes it opened, folded ONLY from events the runtime already
// writes (`command/run` + `command/done` for /worktree on|off, `tool/result`
// meta for lane tools) — cold-read safe, no custom session event type (S13).
// Pure module.

export const WORKTREE_PROJECTION_KEY = 'orreryWorktree'

/** @returns {{ mode: boolean, lanes: string[], pending: Record<string, boolean> }} */
export function initialWorktreeState() {
  return { mode: false, lanes: [], pending: {} }
}

export const worktreeStateSchema = {
  /** @param {any} value */
  parse(value) {
    if (!value || typeof value !== 'object' || typeof value.mode !== 'boolean' || !Array.isArray(value.lanes) || !value.pending || typeof value.pending !== 'object') {
      throw new Error('orreryWorktree: bad projection state')
    }
    return value
  },
}

export const worktreeViewSchema = {
  /** @param {any} value */
  parse(value) {
    if (!value || typeof value !== 'object' || typeof value.mode !== 'boolean' || !Array.isArray(value.lanes)) throw new Error('orreryWorktree: bad projection view')
    return value
  },
}

/**
 * Fold one session event. Unrelated events return the SAME state reference.
 * A mode switch takes effect only when its command settled successfully
 * (`/worktree on` in a non-repository fails and must not flip the marker).
 * @param {{ mode: boolean, lanes: string[], pending: Record<string, boolean> }} state
 * @param {any} event
 */
export function foldWorktreeState(state, event) {
  const data = event?.data
  if (event?.type === 'command/run' && data?.name === 'worktree') {
    const verb = String(data.args ?? '').trim().toLowerCase()
    if ((verb === 'on' || verb === 'off') && typeof data.commandId === 'string') {
      return { ...state, pending: { ...state.pending, [data.commandId]: verb === 'on' } }
    }
    return state
  }
  if (event?.type === 'command/done' && typeof data?.commandId === 'string' && data.commandId in state.pending) {
    const { [data.commandId]: target, ...rest } = state.pending
    return { ...state, mode: data.kind === 'success' ? target : state.mode, pending: rest }
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
/** @param {{ mode: boolean, lanes: string[] }} state */
export function worktreeView(state) {
  // Reuse the view object across internal-only changes (pending map).
  const cached = viewCache.get(state.lanes)
  if (cached && cached.mode === state.mode) return cached
  const view = { mode: state.mode, lanes: state.lanes }
  viewCache.set(state.lanes, view)
  return view
}
