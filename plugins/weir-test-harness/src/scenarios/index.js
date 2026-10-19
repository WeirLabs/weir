// Scenario registry (design D1): one module per integration scenario, this
// index is the single registration point. SCENARIOS order is the historical
// driver order (former run.mjs SCENARIOS list); byId is the lookup used by
// both the mock LLM entry (WEIR_IT_SCENARIO) and the driver (argv filter).
//
// Edit-lock scope after the rebuild switch (edit-lock-rebuild 3.8 / 5.2): the
// nineteen scenarios that encoded the retired mechanism (election, fencing,
// unknown outcomes, recovery, auto-resume, stale sweep, binding transfer,
// preset-switch rebinding, cold view, negotiation) are removed with it. The
// four survivors assert only behaviour that still exists — the managed tool
// surface and lease semantics (claim / retain / release / status), anchors and
// version CAS, whole-batch rename preflight, and the honest three-list failure
// report without rollback. The delegate/preset-switch acceptance those deleted
// probes encoded is rebuilt as NEW scenarios in phase 5.
import deepwork from './deepwork.js'
import delegate from './delegate.js'
import hashline from './hashline.js'
import pressure from './pressure.js'
import plannedCompaction, { plannedCase } from './planned-compaction.js'
import robash from './robash.js'
import semantic from './semantic.js'
import grouped from './grouped.js'
import escalate from './escalate.js'
import background from './background.js'
import jobsAwareTodo from './jobs-aware-todo.js'
import terminate from './terminate.js'
import rehydrate from './rehydrate.js'
import lsp from './lsp.js'
import targets from './targets.js'
import editlock from './editlock.js'
import worktree from './worktree.js'
import capstore from './capstore.js'
import skillComposition from './skill-composition.js'
import applyTransaction from './apply-transaction.js'
import coldSession from './cold-session.js'
import lifecycleInheritance from './lifecycle-inheritance.js'
import delegatePreflight from './delegate-preflight.js'
import mcpGateway from './mcp-gateway.js'
import presetDefaults from './preset-defaults.js'
import capabilityPresetsSurface from './capability-presets-surface.js'
import resumeIncarnation from './resume-incarnation.js'
import capabilityRemote from './capability-remote.js'
import capabilityRemoteDualPreset from './capability-remote-dual-preset.js'
import worktreeWatch from './worktree-watch.js'
import notifyWorktree from './notify-worktree.js'
import worktreeAutoApprove from './worktree-auto-approve.js'
import childPrompt from './child-prompt.js'
import laneResumable from './lane-resumable.js'
import continuable from './continuable.js'
import zombieLane from './zombie-lane.js'
import blackboard from './blackboard.js'
import blackboardPromotion from './blackboard-promotion.js'
import blackboardPersistence from './blackboard-persistence.js'
import blackboardFork from './blackboard-fork.js'
import presetDelegationSurface from './preset-delegation-surface.js'

import editlockLspRename from './editlock-lsp-rename.js'
import editlockLspUncertain from './editlock-lsp-uncertain.js'
import editlockHashlineNegatives from './editlock-hashline-negatives.js'
const SCENARIOS = [deepwork, delegate, hashline, pressure, robash, semantic, grouped, escalate, background, terminate, rehydrate, lsp, targets, editlock, worktree, capstore, jobsAwareTodo]
SCENARIOS.push(...skillComposition)
SCENARIOS.push(applyTransaction)
SCENARIOS.push(coldSession)
SCENARIOS.push(lifecycleInheritance)
SCENARIOS.push(delegatePreflight)
SCENARIOS.push(mcpGateway)
SCENARIOS.push(presetDefaults)
SCENARIOS.push(capabilityPresetsSurface)
SCENARIOS.push(resumeIncarnation)
SCENARIOS.push(worktreeWatch)
SCENARIOS.push(notifyWorktree)
SCENARIOS.push(worktreeAutoApprove)
SCENARIOS.push(childPrompt)
SCENARIOS.push(capabilityRemote)
// Opt-in until the production routing fix lands: this fixture is intentionally RED.
if (process.env.WEIR_IT_CAPABILITY_DUAL === '1') SCENARIOS.push(capabilityRemoteDualPreset)
SCENARIOS.push(continuable)
SCENARIOS.push(zombieLane)
SCENARIOS.push(laneResumable)
SCENARIOS.push(blackboard)
SCENARIOS.push(blackboardPromotion)
SCENARIOS.push(blackboardPersistence)
SCENARIOS.push(blackboardFork)
SCENARIOS.push(presetDelegationSurface)
SCENARIOS.push(plannedCompaction)
SCENARIOS.push(plannedCase('busy'), plannedCase('wake'), plannedCase('cancel'), plannedCase('noop'), plannedCase('hard'))
SCENARIOS.push(editlockLspRename)
SCENARIOS.push(editlockLspUncertain)
SCENARIOS.push(editlockHashlineNegatives)

/**
 * Find a scenario entry by id.
 * @param {string} id - scenario id (same as its module filename)
 * @returns {object|undefined} the registry entry, or undefined when unknown
 */
function byId(id) {
  return SCENARIOS.find((scenario) => scenario.id === id)
}

export { SCENARIOS, byId }
