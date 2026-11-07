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
import mcpManagement from './mcp-management.js'
import presetDefaults from './preset-defaults.js'
import capabilityPresetsSurface from './capability-presets-surface.js'
import resumeIncarnation from './resume-incarnation.js'
import capabilityRemote from './capability-remote.js'
import capabilityRemoteDualPreset from './capability-remote-dual-preset.js'
import capabilityLifecycleRevisionZeroWeirFirst from './capability-lifecycle-revision-zero-weir-first.js'
import capabilityLifecycleRevisionZeroCreativeFirst from './capability-lifecycle-revision-zero-creative-first.js'
import capabilityLifecycleRetainedRevision from './capability-lifecycle-retained-revision.js'
import scopedPresetTreeCanary from './scoped-preset-tree-canary.js'
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
import customSkillPaths from './custom-skill-paths.js'
import delegateParallel from './delegate-parallel.js'

import editlockLspRename from './editlock-lsp-rename.js'
import editlockLspUncertain from './editlock-lsp-uncertain.js'
import editlockHashlineNegatives from './editlock-hashline-negatives.js'
import fileleaseTurnRelease from './filelease-turn-release.js'
import fileleaseHold from './filelease-hold.js'
import fileleaseDegrade from './filelease-degrade.js'
import fileleaseNegotiation from './filelease-negotiation.js'
import fileleaseFaultInjection from './filelease-fault-injection.js'
import fileleaseLineage from './filelease-lineage.js'
import fileleaseWake from './filelease-wake.js'
import fileleaseHolderDeath from './filelease-holder-death.js'
import fileleaseReleaseWatch from './filelease-release-watch.js'
import fileleaseWatchReset from './filelease-watch-reset.js'
const SCENARIOS = [deepwork, delegate, hashline, pressure, robash, semantic, grouped, escalate, background, terminate, rehydrate, lsp, targets, editlock, worktree, capstore, jobsAwareTodo]
SCENARIOS.push(...skillComposition)
SCENARIOS.push(applyTransaction)
SCENARIOS.push(coldSession)
SCENARIOS.push(lifecycleInheritance)
SCENARIOS.push(delegatePreflight)
SCENARIOS.push(mcpGateway)
SCENARIOS.push(mcpManagement)
SCENARIOS.push(presetDefaults)
SCENARIOS.push(capabilityPresetsSurface)
SCENARIOS.push(resumeIncarnation)
SCENARIOS.push(worktreeWatch)
SCENARIOS.push(notifyWorktree)
SCENARIOS.push(worktreeAutoApprove)
SCENARIOS.push(childPrompt)
SCENARIOS.push(capabilityRemote)
// Opt-in real-Host remote-owner routing control; runs in both mount orders.
if (process.env.WEIR_IT_CAPABILITY_DUAL === '1') SCENARIOS.push(capabilityRemoteDualPreset)
// Opt-in real-Host lifecycle admission regression; runs in both mount orders.
if (process.env.WEIR_IT_CAPABILITY_LIFECYCLE_DUAL === '1') SCENARIOS.push(capabilityLifecycleRevisionZeroWeirFirst, capabilityLifecycleRevisionZeroCreativeFirst)
// Opt-in same-preset retained-revision proof and separate facade diagnostic.
if (process.env.WEIR_IT_CAPABILITY_LIFECYCLE_RETAINED === '1') SCENARIOS.push(capabilityLifecycleRetainedRevision)
// Opt-in real scoped, non-writing PresetTree / stock MCP namespace canary.
if (process.env.WEIR_IT_MCP_SCOPED_CANARY === '1') SCENARIOS.push(scopedPresetTreeCanary)
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
SCENARIOS.push(fileleaseTurnRelease)
SCENARIOS.push(fileleaseHold)
SCENARIOS.push(fileleaseDegrade)
SCENARIOS.push(fileleaseNegotiation)
SCENARIOS.push(fileleaseFaultInjection)
// Edit-lock-rebuild 3.3 / 3.5 / 5.6 (the last three integration gaps): lineage
// sharing across a delegation, in-turn wake delivery, and a held lease that
// dies with its holder process.
SCENARIOS.push(fileleaseLineage)
SCENARIOS.push(fileleaseWake)
SCENARIOS.push(fileleaseHolderDeath)
// Edit-lock-release-watch 3.1 / 3.2: the release-subscription feature end to
// end — one real broadcast consumed by two waiters that then compete, and a
// broker reset that ends a subscription without pretending it was a release.
SCENARIOS.push(fileleaseReleaseWatch)
SCENARIOS.push(fileleaseWatchReset)
// Custom Skill scan paths: real gateway + selection/Apply + durable-log proof.
SCENARIOS.push(customSkillPaths)
// Parallel foreground delegation: real two-child overlap by causal handshake.
SCENARIOS.push(delegateParallel)

/**
 * Find a scenario entry by id.
 * @param {string} id - scenario id (same as its module filename)
 * @returns {object|undefined} the registry entry, or undefined when unknown
 */
function byId(id) {
  return SCENARIOS.find((scenario) => scenario.id === id)
}

export { SCENARIOS, byId }
