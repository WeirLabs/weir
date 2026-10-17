// Spawn adapter: the single site where a delegation becomes a started, guarded
// child (design D1-D5). Activation assembly, the maxDepth: 1 topology
// guarantee, guard-attach order, and fail-closed teardown each live exactly
// once here; the lanes differ only through the strategy knobs of the lane
// object (delivery policy, toolFilter/persona transforms, guard handle path,
// teardown, register ordering). Orchestration — escalation, job wrapping,
// group two-phase/rollback/seal — stays in tool.js; this module only spawns.
//
// DSH 0.2.1 single start entry: subagents.startActivation(spec) with
// { provider, label, childId?, request, signal, delivery }. The request no
// longer carries label/signal/persona/toolFilter: the caller reserves the
// childId, and the persona + tool filter ride the creation-window composition
// shim (child-composition.js) registered synchronously before the start.
//
// Invariant: spawnGuardedChild returns only a started child whose composition
// was applied and whose read-only guard is attached (or whose disabled-snapshot
// skip applies); a failure at either step always tears the child down and
// throws. Callers can never receive an uncomposed or unguarded child.
import { randomUUID } from 'node:crypto'
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
 * @property {string} laneName - 'one-shot' | 'supervised' | 'continuable' (spawn fact + diagnostics)
 * @property {'parent' | 'caller'} delivery - runtime settlement policy: 'parent' notifies the model, 'caller' only returns the result
 * @property {(toolFilter: object | undefined) => object | undefined} toolFilterFor - toolFilter transform
 * @property {(target: object) => string} personaFor - persona decoration
 * @property {(started: object, target: object) => void} [beforeGuardAttach] - runs before any guard code (supervised: registerMember)
 * @property {(started: object, deps: object) => object} guardHandleFor - live agent handle for the guard
 * @property {(error: unknown, started: object) => never | Promise<never>} onGuardFailure - fail-closed teardown (lane-native mechanism)
 * @property {boolean} [cancelOnAbort] - tear the published child down when the spawn signal aborts (one-shot lanes)
 */

/**
 * Spawn one child, apply its composition, and attach its read-only guard before
 * returning.
 * @param {SpawnAssignment} assignment
 * @param {SpawnLane} lane
 * @param {object} deps - DelegateDeps subset { subagents, robash, agents, restrictableNames?, composition?, reserveChildId? }
 * @returns {Promise<{ id: string, childId: string, agent?: object, result: Promise<object>, dispose: () => Promise<void> | void, messageId?: string }>}
 *   the normalized handle: `id` aliases the durable child id, `agent` is the
 *   live child agent captured at spawn (0.2.1 resolves `result` only after
 *   teardown, so the handle must be captured now).
 */
export async function spawnGuardedChild(assignment, lane, deps) {
  const { target } = assignment
  // Single activation-assembly point (D3): the four near-verbatim literals of
  // the pre-refactor lanes converge here; lane hooks absorb the per-lane
  // transforms; maxDepth: 1 (children never delegate further) has this one site.
  // The child tool catalog restriction applies AFTER the lane transform:
  // allow-list filters (curated read-only targets) pass through unchanged;
  // every other filter gets CHILD_DENY_TOOLS merged in (intersected with the
  // composition's restrictable names — tools.restrict() rejects unknown deny
  // names), so no spawned child can see orchestrator-only tools.
  const label = assignment.label ?? target.label
  const toolFilter = childToolFilter(lane.toolFilterFor(target.toolFilter), deps.restrictableNames?.())
  const persona = lane.personaFor(target)
  // Every spawn reserves its child id (0.2.1 lets the caller do this): the
  // composition registration is keyed by it, the continuable/supervised lanes
  // get their messageId back through it, and handle normalization is exact.
  const childId = deps.reserveChildId?.() ?? randomUUID()
  // Register the pending composition BEFORE the start call: the child's
  // creation window (agent/created) runs inside startActivation, so this entry
  // is always present when the listener fires (no race).
  const registration = deps.composition?.beginSpawn({
    session: assignment.parent?.session ?? null,
    childId,
    lane: lane.laneName,
    label,
    persona,
    ...(toolFilter ? { toolFilter } : {}),
  })
  let raw
  try {
    raw = await deps.subagents.startActivation({
      provider: 'spawn',
      label,
      childId,
      request: {
        prompt: assignment.prompt,
        parent: assignment.parent,
        ...(target.agentOptions ? { agentOptions: target.agentOptions } : {}),
        maxDepth: 1,
      },
      signal: assignment.signal,
      delivery: lane.delivery,
    })
  } catch (error) {
    registration?.forget()
    throw error
  }
  const started = normalizeStarted(raw, childId, deps)
  // Fail-closed composition gate: a child whose persona/deny list did not land
  // inside its creation window is torn down instead of running uncomposed or
  // with the orchestrator-tool deny list missing.
  const outcome = registration?.outcome()
  if (outcome && !outcome.ok) {
    registration.forget()
    try {
      await started.dispose?.()
    } catch {
      // best-effort teardown of the uncomposed child
    }
    throw outcome.error
  }
  // Unified guard core (D5), in contract order: the lane's pre-guard hook runs
  // BEFORE any guard code (the supervised register-before-guard ordering, once
  // a comment-level contract, is now structural); the handle is resolved
  // BEFORE the disabled check, so a supervised member with a missing handle
  // throws even when the guard is disabled in this snapshot; a disabled
  // snapshot skips BOTH lanes silently (resolveTarget already withheld the
  // shell tool in that snapshot, so there is no shell surface left to guard).
  lane.beforeGuardAttach?.(started, target)
  if (target.readOnly || assignment.laneGuard) {
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
          await lane.onGuardFailure(error, started)
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
        await lane.onGuardFailure(error, started)
      }
    }
  }
  // 0.2.1's activation signal is PRE-PUBLICATION cancellation only ("callers
  // own later cancellation through dispose"); 0.2.0's in-process driver used
  // to cancel a published child when its request signal aborted. The one-shot
  // lanes keep that contract explicitly: aborting the tool call tears the
  // child down (and its turn ends aborted, kind 'parent'), so a stopped
  // parent never leaves a child running. Continuable/supervised lanes are
  // deliberately NOT wired: their children outlive the call that started them.
  // Wired last so a signal already aborted at spawn still leaves a fully
  // guarded, fully composed child to tear down (never an unwired one).
  if (lane.cancelOnAbort) wireAbortCancellation(assignment.signal, started)
  return started
}

/**
 * Cancel a published child when its spawn signal aborts (the 0.2.0 in-process
 * driver contract, now caller-owned). `dispose()` is the 0.2.1 teardown that
 * synchronously cancels the child agent (turn end: aborted, kind 'parent'), so
 * a stopped parent never leaves a running child behind.
 * @param {AbortSignal | undefined} signal
 * @param {{ dispose?: () => Promise<void> | void }} started
 */
function wireAbortCancellation(signal, started) {
  if (!signal || typeof started?.dispose !== 'function') return
  let fired = false
  const cancel = () => {
    if (fired) return
    fired = true
    try {
      void Promise.resolve(started.dispose()).catch(() => {})
    } catch {
      // best-effort teardown of the cancelled child
    }
  }
  if (signal.aborted) {
    cancel()
    return
  }
  signal.addEventListener('abort', cancel, { once: true })
}

/**
 * Normalize a SubagentActivation into the handle the lanes and tool.js use:
 * `{ id, childId, agent, result, dispose }`. The live child agent must be
 * captured here — 0.2.1 resolves `result` only after the activation is
 * disposed, so no post-settlement lookup can reach it.
 * @param {object} raw - SubagentActivation ({ childId, messageId?, result, dispose() })
 * @param {string} reservedChildId - the caller-reserved child id
 * @param {object} deps
 */
function normalizeStarted(raw, reservedChildId, deps) {
  const childId = typeof raw?.childId === 'string' ? raw.childId : reservedChildId
  let agent
  try {
    agent = deps.agents?.get?.(childId)
  } catch {
    agent = undefined
  }
  return {
    id: childId,
    childId,
    agent: agent ?? raw?.agent,
    result: raw?.result,
    dispose: () => (typeof raw?.dispose === 'function' ? raw.dispose() : Promise.resolve()),
    ...(raw?.messageId !== undefined ? { messageId: raw.messageId } : {}),
  }
}

/**
 * One-shot lane: startActivation with delivery 'caller' — the caller awaits
 * the result itself and no runtime parent notice is sent (the jobs wrapper /
 * the tool result is the report channel). The persona carries
 * WORKER_CONTRACT. Serves the foreground, background (inside the job wrapper),
 * and escalation respawn sites — identical spawn semantics, only the
 * assignment fields (parent/signal/label) differ.
 * @returns {SpawnLane}
 */
export function oneShotLane() {
  return {
    laneName: 'one-shot',
    delivery: 'caller',
    // Aborting the tool call tears the child down (0.2.0 driver contract, see
    // wireAbortCancellation): only the one-shot lanes own the call window.
    cancelOnAbort: true,
    toolFilterFor: (toolFilter) => toolFilter,
    personaFor: (target) => target.persona + WORKER_CONTRACT,
    // The composition shim captures the live agent at spawn; no post-hoc lookup.
    guardHandleFor: (started) => started.agent,
    async onGuardFailure(error, started) {
      // A read-only child must never run unguarded: tear it down and fail loud.
      try {
        await started.dispose?.()
      } catch {
        // best-effort teardown of the unguarded child
      }
      throw new Error(`delegate: failed to attach the read-only bash guard — ${String(error?.message ?? error)}`)
    },
  }
}

/**
 * Supervised lane: startActivation with delivery 'parent' (the built-in
 * settlement notice is the supervising parent's report channel and the
 * ordering-gate input), the worker + status contracts appended to the persona
 * (SUPERVISION_CONTRACT stays last) and send_message denied, plus
 * register-before-guard ordering.
 * Teardown: a guard failure annotates the exact child id and rethrows, so the
 * lane-level rollback in tool.js terminates the member through the coordinator
 * (which keeps the registry bookkeeping in sync).
 * @param {{ coordinator: object, groupName: string, members: Array<object> }} group
 * @returns {SpawnLane}
 */
export function supervisedLane({ coordinator, groupName, members }) {
  return {
    laneName: 'supervised',
    delivery: 'parent',
    toolFilterFor: supervisedToolFilter,
    personaFor: (target) => target.persona + WORKER_CONTRACT + SUPERVISION_CONTRACT,
    beforeGuardAttach(started, target) {
      // Register BEFORE the guard attach: a guard failure must leave the member
      // in the rollback list so it is terminated, never left running unguarded.
      const member = coordinator.registerMember({ id: started.childId, name: target.label, group: groupName })
      members.push({ id: started.childId, name: target.label, member })
    },
    // The live agent captured at spawn is the guard handle (same guard, same
    // fail-closed semantics as the one-shot lane).
    guardHandleFor(started) {
      const childAgent = started.agent
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
 * that starts through startActivation (delivery 'parent') and returns
 * immediately; its results arrive through the runtime's built-in settlement
 * notices. The persona carries WORKER_CONTRACT + CONTINUABLE_CONTRACT — NEVER
 * SUPERVISION_CONTRACT: no binary terminal-status contract, no coordinator
 * registration, no supervision bookkeeping (an untracked entry in
 * supervised_status is the normal state, not an anomaly). The child→parent
 * channel stays closed the same way as every lane: send_message is already in
 * CHILD_DENY_TOOLS, which the single assembly point merges, so toolFilterFor is
 * the identity.
 *
 * Teardown: a guard failure rethrows the original error with the child id
 * attached; the catch side in tool.js then best-effort interrupts the residual
 * child before propagating (the error names the child id, so the parent can
 * dispose of it explicitly).
 * @returns {SpawnLane}
 */
export function continuableLane() {
  return {
    laneName: 'continuable',
    delivery: 'parent',
    toolFilterFor: (toolFilter) => toolFilter,
    personaFor: (target) => target.persona + WORKER_CONTRACT + CONTINUABLE_CONTRACT,
    // No beforeGuardAttach: nothing registers anywhere on this lane.
    // The live agent captured at spawn is the guard handle (same guard, same
    // fail-closed semantics as the other lanes).
    guardHandleFor(started) {
      const childAgent = started.agent
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
