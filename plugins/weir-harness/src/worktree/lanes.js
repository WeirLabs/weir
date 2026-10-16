// Worktree lane service: the single entry point for every lane change in the
// product. Every lane mutation — tools, /worktree commands, child settlement —
// still goes through this module, which is now a thin facade assembling the
// three lane modules: lane-core.js owns the ledger + check engine (the one
// apply() every state change goes through), lane-workflows.js the decision
// workflows (cards, auto-approve, removal semantics), lane-views.js the
// read-only views. ctx-free by construction: git, shell, questions,
// notifications, audit and the session-mode reader are injected
// (src/worktree/index.js wires them).
import { createLaneCore } from './lane-core.js'
import { createLaneWorkflows } from './lane-workflows.js'
import { createLaneViews } from './lane-views.js'

export { CONFIG_FILE, pathKey } from './lane-core.js'

/** @param {import('./lane-core.js').LaneServiceDeps} deps */
export function createLaneService(deps) {
  const core = createLaneCore(deps)
  const { repoFor, refresh, childSettled, check } = core
  const {
    open, setup, prepareBind, land, askCleanup, cleanup, abandon, watch,
    initSuggestions, writeConfig, reconcile: reconcileCommand, resolveArgPath,
    approveGlobal: approveGlobalSafe,
  } = createLaneWorkflows(core)
  const { view, diffOf, board, summaryOf, actionsFor } = createLaneViews(core)
  return {
    repoFor, refresh, open, setup, prepareBind, childSettled, check, land, askCleanup, cleanup, abandon, watch,
    view, diffOf, board, summaryOf, initSuggestions, writeConfig, reconcile: reconcileCommand, resolveArgPath, actionsFor,
    approveGlobal: approveGlobalSafe,
  }
}
