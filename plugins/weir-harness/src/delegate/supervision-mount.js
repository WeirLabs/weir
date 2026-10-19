// Supervision mount: one group coordinator per parent session, the six
// effectors binding the coordinator to ctx.subagents/audit, the session/event
// feed with the settlement-notice ordering gate, and the settings-commit push
// into live coordinators. This module is a ctx adapter — per the jsconfig
// purity curation it stays out of include (same precedent as index.js and
// group-coordinator.js).
import { createGroupCoordinator } from './group-coordinator.js'
import { rehydrateSupervision, applyChildLogRecovery } from './rehydrate.js'
import { auditFilePathOf, isTerminalStatus, readAuditTail, readChildFinalText } from '../shared/terminal-evidence.js'
import { AUDIT_TYPES } from '../shared/audit.js'
import { userTextMessage } from '../shared/user-message.js'
import { contentText } from '../shared/content-text.js'

/**
 * Mount the supervision subsystem on the plugin ctx.
 * @param {object} deps
 * @param {any} deps.ctx - plugin context (on / subagents / get / logger)
 * @param {any} deps.audit - createAudit(ctx) sink: (session, type, payload) => void
 * @param {any} deps.settings - weirSettings service handle (absent = no commit push)
 * @param {() => object} deps.supervisionNow - overlay getter for supervision tuning
 * @param {(childId: string, parent: object) => void} [deps.onChildSettled] - a member reached a terminal fact (worktree lane settlement)
 * @returns {{ coordinatorFor: (parent: object) => Promise<object>, noteSpawnFact: (fact: { session?: object | null, childId: string, lane?: string }) => void, dispose: () => void }}
 */
export function mountSupervision({ ctx, audit, settings, supervisionNow, onChildSettled }) {
  // Supervised group coordinators, one per parent session.
  /** @type {Map<string, { coordinator: object, parent: object }>} */
  const coordinators = new Map()
  // Durable delegate/spawn facts per parent session (childId → { lane }): the
  // catalog cross-check consults them because DSH 0.2.1 reports every local
  // child as mode 'continuable' (see untrackedCatalogEntries). Live spawns
  // register through noteSpawnFact; a restart rebuild fills the same map from
  // the rehydrated state.
  /** @type {Map<string, Map<string, { childId: string, lane?: string }>>} */
  const spawnFacts = new Map()
  function spawnFactsFor(parentId) {
    let facts = spawnFacts.get(parentId)
    if (!facts) {
      facts = new Map()
      spawnFacts.set(parentId, facts)
    }
    return facts
  }
  /** Record one child-composition spawn fact (live spawn or rehydrated). */
  function noteSpawnFact(fact) {
    const parentId = fact?.session?.id
    if (typeof parentId !== 'string' || parentId.length === 0) return
    if (typeof fact.childId !== 'string' || fact.childId.length === 0) return
    spawnFactsFor(parentId).set(fact.childId, { childId: fact.childId, lane: typeof fact.lane === 'string' ? fact.lane : undefined })
  }
  // STATUS/turn-end is a bookkeeping fact, never proof the driver stopped.
  // This gate exists even when Edit Lock is disabled in the composition.
  const quiescence = new Map()
  const handoffs = new Set()
  const endedRuns = new Set()
  function runtimeFor(id, agent = ctx.get?.('agents')?.get?.(id)) {
    let record = quiescence.get(id)
    if (!record || (agent && record.agent && agent !== record.agent)) {
      record = { ...Promise.withResolvers(), agent }
      quiescence.set(id, record)
    }
    if (!record.agent) record.agent = agent
    return record
  }
  ctx.on('agent/created', ({ agent }) => { runtimeFor(agent.id, agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const record = quiescence.get(agent.id)
    if (record?.agent && record.agent !== agent) return
    runtimeFor(agent.id, agent).resolve()
  })
  ctx.on('subagent/end', ({ id, runId }) => {
    if (runId && endedRuns.has(runId)) return
    if (runId) endedRuns.add(runId)
    runtimeFor(id).resolve()
  })
  async function coordinatorFor(parent) {
    let entry = coordinators.get(parent.id)
    if (!entry) {
      const coordinator = createGroupCoordinator(
        {
          sendTo: async (childId, text) => {
            await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal: new AbortController().signal })
          },
          resumeTo: (childId, text) =>
            ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal: new AbortController().signal }),
          interruptChild: (childId) => {
            ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
          },
          schedule: (delayMs, fn) => {
            const timer = setTimeout(fn, delayMs)
            timer.unref?.()
          },
          onAudit: (note) => {
            audit(parent.session, AUDIT_TYPES.supervision, { note })
          },
          onFact: (fact) => {
            audit(parent.session, `${AUDIT_TYPES.supervision}/${fact.kind}`, fact)
            // A settled or terminated member frees its worktree lane (the host
            // checks the lane) — TERMINAL outcomes only (resumable-lane-workers
            // D1), with terminality defined by the shared isTerminalStatus
            // predicate: a blocked member's binding must survive a possible
            // resume; the blocked fact still rides the audit channel.
            // Deferred: never run lane work inside the fact.
            const settlesLane = fact.kind === 'terminate' || (fact.kind === 'settle' && isTerminalStatus(fact.status))
            if (settlesLane && !handoffs.has(fact.childId)) {
              handoffs.add(fact.childId)
              const runtime = runtimeFor(fact.childId)
              // No observed quiescence means no automatic handoff, including
              // a cold bookkeeping fact. Lane reconciliation owns that case.
              // Runtime quiescence is the ONLY gate: the retired Edit Lock
              // disposition acknowledgement used to join here as well.
              void runtime.promise
                .then(() => onChildSettled?.(fact.childId, parent))
                .catch(error => {
                  const note = `child ${fact.childId}: terminal handoff failed; lane remains bound: ${error?.message ?? error}`
                  ctx.logger?.warn?.(note)
                  audit(parent.session, AUDIT_TYPES.supervision, { note })
                })
            }
          },
          notifyParent: (text) => {
            // Reliable parent-facing delivery: timer-deferred, mirroring the
            // built-in settlement channel (sendWaking): steer into the current
            // turn when the parent is busy so the signal lands right after the
            // last member's settlement notice; followup wake when idle. Bounded
            // retry; the final failure is audited.
            const message = userTextMessage(text, 'weir-delegate')
            const deliver = (attempt) => {
              const delay = attempt === 1 ? 0 : 200 * (attempt - 1)
              const timer = setTimeout(() => {
                let outcome
                try {
                  outcome = parent.status === 'idle' ? parent.followup(message) : parent.steer(message)
                } catch (error) {
                  outcome = Promise.reject(error)
                }
                Promise.resolve(outcome).catch((error) => {
                  ctx.logger?.warn?.(`weir-delegate: group-settled signal delivery (attempt ${attempt}) failed: ${error?.message ?? error}`)
                  if (attempt < 3) deliver(attempt + 1)
                  else audit(parent.session, AUDIT_TYPES.supervision, { note: `group-settled signal delivery failed after ${attempt} attempts: ${String(error?.message ?? error)}` })
                })
              }, delay)
              timer.unref?.() // never hold the process for a pending signal delivery
            }
            deliver(1)
          },
          // Lane decisions for the catalog cross-check come from the durable
          // delegate/spawn facts (live-registered + rehydrated below).
          spawnFactOf: (childId) => spawnFacts.get(parent.id)?.get(childId),
        },
        supervisionNow(),
      )
      // Restart rebuild: replay durable facts, cross-check the DSH catalog.
      const state = await rehydrateForParent(parent)
      coordinator.hydrate(state)
      // Spawn facts ride the same tail: they decide which catalog children are
      // orphans (one-shot/continuable children are never resurrected).
      for (const fact of state.spawnFacts ?? []) noteSpawnFact({ session: parent.session, childId: fact.childId, lane: fact.lane })
      entry = { coordinator, parent }
      coordinators.set(parent.id, entry)
    }
    return entry.coordinator
  }

  /** Best-effort rehydration inputs for one parent: audit tail + catalog. */
  async function rehydrateForParent(parent) {
    const records = readAuditTail(auditFilePathOf(parent.session))
    let catalogChildren = []
    try {
      catalogChildren = await ctx.subagents.listChildren(parent.id) ?? []
    } catch {
      // catalog unavailable: partial-confidence rebuild still proceeds
    }
    const state = rehydrateSupervision({ parentId: parent.id, records, catalogChildren })
    const sessionQuery = ctx.get?.('sessionQuery')
    if (sessionQuery?.readSession) {
      return applyChildLogRecovery(state, (childId) => readChildFinalText(sessionQuery, childId))
    }
    return state
  }

  /** Find the entry owning a given child session id (event filter). */
  function entryOfChild(sessionId) {
    for (const entry of coordinators.values()) {
      if (entry.coordinator.ownsChild(sessionId)) return entry
    }
    return undefined
  }

  // Supervision feed: child assistant text + turn ends drive the state machine;
  // the parent's own log feeds the settlement-notice ordering gate. Parent-facing
  // signals are delivered through the coordinator's notifyParent effector
  // (timer-deferred dispatch), never synchronously from inside event dispatch.
  ctx.on('session/event', (session, event) => {
    const parentEntry = coordinators.get(session.id)
    if (parentEntry) {
      // Strict ordering: the group-settled signal must follow every member's
      // built-in settlement notice, so observe them as they land in the parent log.
      if (event?.type === 'user/message' && event.data?.source?.kind === 'subagent-settled') {
        const senderId = event.data?.source?.senderSessionId
        if (typeof senderId === 'string' && senderId.length > 0) {
          parentEntry.coordinator.noteSettlementNotice(senderId)
        }
      }
      return
    }
    const entry = entryOfChild(session.id)
    if (!entry) return
    if (event?.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content)
      entry.coordinator.noteAssistantText(session.id, text)
      return
    }
    if (event?.type === 'turn/end') {
      void driveTurnEnd(entry, session.id, event.data?.reason)
    }
  })

  async function driveTurnEnd(entry, childId, reason) {
    try {
      await entry.coordinator.onTurnEnd(childId, reason)
    } catch (error) {
      audit(entry.parent.session, AUDIT_TYPES.supervision, { note: `turn-end processing failed for child ${childId}: ${String(error?.message ?? error)}` })
    }
  }

  // Volatile settings commits: read-time resolution already covers every new
  // delegation, but a coordinator is long-lived (one per parent session), so its
  // supervision parameters must be pushed into the live instances too. Mirrors
  // src/lsp/index.js: the same broadcast that re-registers the LSP surface
  // refreshes the supervision tuning here.
  const offSettings = settings?.onChange?.(() => {
    const supervision = supervisionNow()
    for (const entry of coordinators.values()) entry.coordinator.setSupervision?.(supervision)
  })

  const dispose = () => {
    offSettings?.()
  }

  return { coordinatorFor, noteSpawnFact, dispose }
}
