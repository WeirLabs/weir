// Scenario registry (design D1): one module per integration scenario, this
// index is the single registration point. SCENARIOS order is the historical
// driver order (former run.mjs SCENARIOS list); byId is the lookup used by
// both the mock LLM entry (WEIR_IT_SCENARIO) and the driver (argv filter).
import deepwork from './deepwork.js'
import delegate from './delegate.js'
import hashline from './hashline.js'
import pressure from './pressure.js'
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
import stopPredispatch from './editlock-stop-predispatch.js'
import stopStaged from './editlock-stop-staged.js'
import stopPublication from './editlock-stop-publication.js'
import stopUpdate from './editlock-stop-update.js'
import autoResume from './editlock-auto-resume.js'
import autoResumeOff from './editlock-auto-resume-off.js'
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
import worktreeWatch from './worktree-watch.js'
import notifyWorktree from './notify-worktree.js'
import worktreeAutoApprove from './worktree-auto-approve.js'
import childPrompt from './child-prompt.js'
import staleSweep from './editlock-stale-sweep.js'
import staleSweepOff from './editlock-stale-sweep-off.js'
import laneResumable from './lane-resumable.js'
import continuable from './continuable.js'
import crashRecovery from './editlock-crash-recovery.js'
import coldView from './editlock-cold-view.js'
import zombieLane from './zombie-lane.js'
import blackboard from './blackboard.js'
import blackboardPromotion from './blackboard-promotion.js'
import recoveryUx from './editlock-recovery-ux.js'

const SCENARIOS = [deepwork, delegate, hashline, pressure, robash, semantic, grouped, escalate, background, terminate, rehydrate, lsp, targets, editlock, worktree, capstore, stopPredispatch, stopStaged, stopPublication, stopUpdate, jobsAwareTodo, autoResume, autoResumeOff]
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
SCENARIOS.push(staleSweep)
SCENARIOS.push(staleSweepOff)
SCENARIOS.push(capabilityRemote)
SCENARIOS.push(continuable)
SCENARIOS.push(crashRecovery)
SCENARIOS.push(coldView)
SCENARIOS.push(zombieLane)
SCENARIOS.push(laneResumable)
SCENARIOS.push(blackboard)
SCENARIOS.push(blackboardPromotion)
SCENARIOS.push(recoveryUx)

/**
 * Find a scenario entry by id.
 * @param {string} id - scenario id (same as its module filename)
 * @returns {object|undefined} the registry entry, or undefined when unknown
 */
function byId(id) {
  return SCENARIOS.find((scenario) => scenario.id === id)
}

export { SCENARIOS, byId }
