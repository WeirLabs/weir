// Spawn adapter: the single site where a delegation becomes a started, guarded
// child (design D1-D5). Request assembly, the maxDepth: 1 topology guarantee,
// guard-attach order, and fail-closed teardown each live exactly once here;
// the lanes differ only through the strategy knobs of the lane object
// (start shape, toolFilter/persona transforms, guard handle path, teardown,
// register ordering). Orchestration — escalation, job wrapping, group
// two-phase/rollback/seal — stays in tool.js; this module only spawns.
//
// Invariant: spawnGuardedChild returns only a started child whose read-only
// guard is attached (or whose disabled-snapshot skip applies); a guard failure
// always tears the child down and throws. Callers can never receive a
// read-only child running unguarded.
import { SUPERVISION_CONTRACT } from './group-coordinator.js'
import { attachReadOnlyBashGuard } from './robash-guard.js'
import { attachLaneGuard } from '../worktree/guard.js'
import { CONTINUABLE_CONTRACT, WORKER_CONTRACT, childToolFilter } from '../shared/child-scope.js'

/**
 * @typedef {object} SpawnAssignment
 * @property {{ persona: string, label: string, agentOptions?: object, toolFilter?: { allow?: string[], deny?: string[] }, readOnly?: boolean }} target - resolved target
 * @property {Array<object>} prompt - child prompt blocks
 * @property {object} parent - parent agent handle
 * @property {object} signal - abort signal for the spawn
 * @property {string} [label] - child label; defaults to target.label
 * @property {import('../worktree/guard.js').LaneGuardSpec} [laneGuard] - worktree lane guard for a lane-bound child
 */

/**
 * Lane strategy: every genuine per-lane difference as an injected knob.
 * @typedef {object} SpawnLane
 * @property {(deps: object, request: object) => Promise<object>} start - provider start call (lane-native shape)
 * @property {(toolFilter: object | undefined) => object | undefined} toolFilterFor - toolFilter transform
 * @property {(target: object) => string} personaFor - persona decoration
 * @property {(started: object, target: object) => void} [beforeGuardAttach] - runs before any guard code (supervised: registerMember)
 * @property {(started: object, deps: object) => object} guardHandleFor - live agent handle for the guard
 * @property {(error: unknown, started: object) => never} onGuardFailure - fail-closed teardown (lane-native mechanism)
 */

/**
 * Spawn one child and attach its read-only guard before returning.
 * @param {SpawnAssignment} assignment
 * @param {SpawnLane} lane
 * @param {object} deps - DelegateDeps subset { subagents, robash, agents, restrictableNames? }
 * @returns {Promise<object>} the lane-native started handle (one-shot →
 *   SubagentRun { id, localAgent, result, dispose }; supervised → { childId, messageId })
 */
export async function spawnGuardedChild(assignment, lane, deps) {
  const { target } = assignment
  // Single request-assembly point (D3): the four near-verbatim literals of the
  // pre-refactor lanes converge here; lane hooks absorb the per-lane
  // transforms; maxDepth: 1 (children never delegate further) has this one site.
  // The child tool catalog restriction applies AFTER the lane transform:
  // allow-list filters (curated read-only targets) pass through unchanged;
  // every other filter gets CHILD_DENY_TOOLS merged in (intersected with the
  // composition's restrictable names — tools.restrict() rejects unknown deny
  // names), so no spawned child can see orchestrator-only tools.
  const toolFilter = childToolFilter(lane.toolFilterFor(target.toolFilter), deps.restrictableNames?.())
  const request = {
    label: assignment.label ?? target.label,
    prompt: assignment.prompt,
    parent: assignment.parent,
    signal: assignment.signal,
    ...(target.agentOptions ? { agentOptions: target.agentOptions } : {}),
    ...(toolFilter ? { toolFilter } : {}),
    maxDepth: 1,
    persona: lane.personaFor(target),
  }
  const started = await lane.start(deps, request)

  // Unified guard core (D5), in contract order: the lane's pre-guard hook runs
  // BEFORE any guard code (the supervised register-before-guard ordering, once
  // a comment-level contract, is now structural); the handle is resolved
  // BEFORE the disabled check, so a supervised member with a missing handle
  // throws even when the guard is disabled in this snapshot; a disabled
  // snapshot skips BOTH lanes silently (resolveTarget already withheld the
  // shell tool in that snapshot, so there is no shell surface left to guard).
  lane.beforeGuardAttach?.(started, target)
  if (!target.readOnly && !assignment.laneGuard) return started
  const handle = lane.guardHandleFor(started, deps)
  if (target.readOnly) {
    // deps.robash is a live resolver (the settings overlay can change between
    // delegations), so resolve it once here: the enabled check and the lists
    // handed to the guard must describe the same committed snapshot.
    const robash = deps.robash?.()
    // robash.lists carries both list sets ({ bash, pwsh }); the guard
    // dispatches on execution.name.
    if (robash?.enabled) {
      try {
        attachReadOnlyBashGuard(handle, robash.lists)
      } catch (error) {
        lane.onGuardFailure(error, started)
      }
    }
  }
  // A lane-bound child additionally gets the lane guard (workdir, write
  // paths/scope, branch-moving git) — same fail-closed teardown: a bound
  // child never runs without it.
  if (assignment.laneGuard) {
    try {
      attachLaneGuard(handle, assignment.laneGuard)
    } catch (error) {
      lane.onGuardFailure(error, started)
    }
  }
  return started
}

/**
 * One-shot lane: subagents.start('spawn', request) with the caller's
 * toolFilter untouched (the child deny-list merge happens once in
 * spawnGuardedChild) and the persona extended by WORKER_CONTRACT. Serves the
 * foreground, background (inside the job wrapper), and escalation respawn
 * sites — identical spawn semantics, only the assignment fields
 * (parent/signal/label) differ.
 * @returns {SpawnLane}
 */
export function oneShotLane() {
  return {
    start: (deps, request) => deps.subagents.start('spawn', request),
    toolFilterFor: (toolFilter) => toolFilter,
    personaFor: (target) => target.persona + WORKER_CONTRACT,
    // S7 SubagentRun shape: the live agent handle rides the started run.
    guardHandleFor: (started) => started.localAgent,
    onGuardFailure(error, started) {
      // A read-only child must never run unguarded: tear it down and fail loud.
      started.dispose()
      throw new Error(`delegate: failed to attach the read-only bash guard — ${String(error?.message ?? error)}`)
    },
  }
}

/**
 * Supervised lane: startContinuable with the worker + status contracts
 * appended to the persona (SUPERVISION_CONTRACT stays last) and send_message
 * denied, plus register-before-guard ordering.
 * Teardown deliberately differs from the one-shot lane: continuable handles
 * have no dispose, so a guard failure rethrows as-is and the lane-level
 * rollback in tool.js terminates the member through the coordinator (which
 * keeps the registry bookkeeping in sync).
 * @param {{ coordinator: object, groupName: string, members: Array<object> }} group
 * @returns {SpawnLane}
 */
export function supervisedLane({ coordinator, groupName, members }) {
  return {
    // startContinuable takes label/signal beside the request, not inside it
    // (provider API shape).
    start: (deps, request) => {
      const { label, signal, ...rest } = request
      return deps.subagents.startContinuable({ provider: 'spawn', label, request: rest, signal })
    },
    toolFilterFor: supervisedToolFilter,
    personaFor: (target) => target.persona + WORKER_CONTRACT + SUPERVISION_CONTRACT,
    beforeGuardAttach(started, target) {
      // Register BEFORE the guard attach: a guard failure must leave the member
      // in the rollback list so it is terminated, never left running unguarded.
      const member = coordinator.registerMember({ id: started.childId, name: target.label, group: groupName })
      members.push({ id: started.childId, name: target.label, member })
    },
    // startContinuable returns { childId, messageId } (no localAgent), so the
    // read-only shell guard attaches through the live agent handle — same
    // guard, same fail-closed semantics as the one-shot lane.
    guardHandleFor(started, deps) {
      const childAgent = deps.agents?.get(started.childId)
      if (!childAgent) throw new Error(`delegate: read-only supervised member spawned but no live agent handle is available for "${started.childId}"`)
      return childAgent
    },
    onGuardFailure(error) {
      throw error
    },
  }
}

/**
 * Continuable lane (design D2/D3/D7): an opt-in `mode: 'continuable'` child
 * that starts via startContinuable and returns immediately; its results
 * arrive through the runtime's built-in settlement notices. The persona
 * carries WORKER_CONTRACT + CONTINUABLE_CONTRACT — NEVER SUPERVISION_CONTRACT:
 * no binary terminal-status contract, no coordinator registration, no
 * supervision bookkeeping (an untracked entry in supervised_status is the
 * normal state, not an anomaly). The child→parent channel stays closed the
 * same way as every lane: send_message is already in CHILD_DENY_TOOLS, which
 * the single assembly point merges, so toolFilterFor is the identity.
 *
 * Teardown matches the supervised lane: continuable handles have no dispose,
 * so a guard failure rethrows the original error with the child id attached;
 * the catch side in tool.js then best-effort interrupts the residual child
 * before propagating (the error names the child id, so the parent can
 * dispose of it explicitly).
 * @returns {SpawnLane}
 */
export function continuableLane() {
  return {
    // startContinuable takes label/signal beside the request, not inside it
    // (provider API shape) — same start shape as the supervised lane.
    start: (deps, request) => {
      const { label, signal, ...rest } = request
      return deps.subagents.startContinuable({ provider: 'spawn', label, request: rest, signal })
    },
    toolFilterFor: (toolFilter) => toolFilter,
    personaFor: (target) => target.persona + WORKER_CONTRACT + CONTINUABLE_CONTRACT,
    // No beforeGuardAttach: nothing registers anywhere on this lane.
    // startContinuable returns { childId, messageId } (no localAgent), so the
    // read-only shell guard attaches through the live agent handle — same
    // guard, same fail-closed semantics as the other lanes.
    guardHandleFor(started, deps) {
      const childAgent = deps.agents?.get(started.childId)
      if (!childAgent) {
        const error = new Error(`delegate: read-only continuable child spawned but no live agent handle is available for "${started.childId}"`)
        error.childId = started.childId
        throw error
      }
      return childAgent
    },
    onGuardFailure(error, started) {
      if (error && typeof error === 'object') error.childId = started.childId
      throw error
    },
  }
}

/**
 * Supervised members must report through the terminal-status channel only:
 * deny the DSH send_message tool. Allow-list filters (read-only targets) already
 * exclude it and stay unchanged; deny-list filters get send_message merged in.
 * @param {object | undefined} toolFilter
 * @returns {object} a tool filter that always denies send_message
 */
export function supervisedToolFilter(toolFilter) {
  if (!toolFilter) return { deny: ['send_message'] }
  if (toolFilter.allow !== undefined) return toolFilter
  return { ...toolFilter, deny: [...new Set([...(toolFilter.deny ?? []), 'send_message'])] }
}
