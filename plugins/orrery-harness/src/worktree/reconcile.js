// Ledger ↔ git reconciliation: pure decisions over facts the service gathered
// (worktree list, per-lane trees, main HEAD branch). The service applies the
// returned events through the state machine. Pure module.
import { FINISHED, LANDABLE_FROM } from './state.js'

/**
 * @param {object} facts
 * @param {any[]} facts.lanes - ledger lanes
 * @param {Array<{ path: string }>} facts.worktrees - parsed `git worktree list` (paths normalized by the caller)
 * @param {string} facts.rootPath - normalized absolute lane root
 * @param {string | null} facts.mainBranch - the main worktree's current branch (null = detached)
 * @param {Map<string, string | null>} facts.trees - lane id → current HEAD^{tree} (null when unreadable)
 * @param {(path: string) => string} [facts.normalize] - path normalizer shared with the caller
 * @returns {{ events: Array<{ id: string, type: string, reason?: string }>, unmanaged: string[], baseMoved: Map<string, boolean> }}
 */
export function reconcile({ lanes, worktrees, rootPath, mainBranch, trees, normalize = (path) => path }) {
  const present = new Set(worktrees.map((entry) => normalize(entry.path)))
  const known = new Set(lanes.map((lane) => normalize(lane.path)))
  /** @type {Array<{ id: string, type: string, reason?: string }>} */
  const events = []
  /** @type {Map<string, boolean>} */
  const baseMoved = new Map()
  for (const lane of lanes) {
    if (FINISHED.includes(lane.state)) continue
    if (!present.has(normalize(lane.path))) {
      events.push({ id: lane.id, type: 'missing', reason: 'missing' })
      continue
    }
    baseMoved.set(lane.id, mainBranch !== lane.base?.branch)
    if (LANDABLE_FROM.includes(lane.state) && lane.landableTree) {
      const tree = trees.get(lane.id)
      if (tree && tree !== lane.landableTree) events.push({ id: lane.id, type: 'invalidate', reason: 'lane content changed after its conclusion' })
    }
  }
  const prefix = `${normalize(rootPath)}/`
  const unmanaged = [...present].filter((path) => path.startsWith(prefix) && !known.has(path))
  return { events, unmanaged, baseMoved }
}
